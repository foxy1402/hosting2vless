// Lightweight site service for shared hosting.
//
// Serves three things on one internal port:
//   GET /       - status page (a short plain-text line; also a keep-alive
//                 probe so the host does not sleep the app)
//   GET /feed   - feed endpoint, base64-encoded (a single entry)
//   WS  /       - live channel (binary; each connection is routed to one
//                 destination chosen by the client)
//
// Configuration (environment variables, all optional):
//   UUID     - client ID. If unset, a random one is generated and stored in
//              config.txt next to this file, so it survives restarts.
//   DOMAIN   - this site's public domain (e.g. vn.example.com), no scheme.
//              If the site is fronted by a CDN/edge, put the front domain here.
//   NAME     - label shown in the client's list.
//   PORT     - internal TCP port to listen on. Avoid low ports (3000, 8080...)
//              that shared hosts often occupy; any value in 20000-40000 works.
//   SUB_PATH - feed URL path (default /feed).

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Buffer } = require('buffer');
const { WebSocket, createWebSocketStream } = require('ws');

// --- Configuration -----------------------------------------------------------

const ID_FILE = path.join(__dirname, 'config.txt');

// Client-ID priority: env var > persisted file > freshly generated
// (then persisted, so it survives restarts).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadOrCreateId() {
  const fromEnv = (process.env.UUID || '').trim();
  if (fromEnv) {
    // An invalid env UUID would silently reject every client — fail loudly.
    if (!UUID_RE.test(fromEnv)) {
      console.error('UUID env is not a valid UUID: ' + fromEnv);
      process.exit(1);
    }
    return fromEnv;
  }
  try {
    const existing = fs.readFileSync(ID_FILE, 'utf8').trim();
    if (UUID_RE.test(existing)) return existing;
  } catch (e) { /* no file yet, fall through */ }
  const fresh = crypto.randomUUID();
  try {
    // Temp file + rename: a crash mid-write cannot leave a truncated ID file.
    fs.writeFileSync(ID_FILE + '.tmp', fresh, 'utf8');
    fs.renameSync(ID_FILE + '.tmp', ID_FILE);
  } catch (e) { /* read-only dir: use a per-boot ID instead */ }
  return fresh;
}

const UUID = loadOrCreateId();
const idHex = UUID.replace(/-/g, ''); // hex form, compared byte-by-byte below
const DOMAIN = process.env.DOMAIN || '';
const NAME = process.env.NAME || 'VN-DataOnline';
const SUB_PATH = process.env.SUB_PATH || '/feed';

// A bad PORT would otherwise make the server listen somewhere unexpected.
const rawPort = process.env.PORT || '28741';
const port = parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be a number between 1 and 65535 (got: ' + rawPort + ')');
  process.exit(1);
}

// --- HTTP: status page + feed --------------------------------------------------

const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello, World\n');
  } else if (req.url === SUB_PATH) {
    if (!DOMAIN) { // an unset domain would produce a broken client link
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Feed not ready\n');
      return;
    }
    const entry =
      `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}` +
      `&type=ws&host=${DOMAIN}&path=%2F#${NAME}`;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(Buffer.from(entry).toString('base64') + '\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

httpServer.on('error', err => {
  // EADDRINUSE (stale instance, cron race) must exit cleanly; cron restarts.
  console.error('cannot listen on port ' + port + ': ' + err.message);
  process.exit(1);
});
httpServer.listen(port, () => {
  console.log('HTTP server is running on port ' + port);
});
if (!DOMAIN) {
  console.log('warning: DOMAIN is empty; ' + SUB_PATH + ' answers 503 until it is set');
}

// --- Live channel (binary WebSocket endpoint) ----------------------------------
//
// First binary frame from the client (fixed wire format):
//   [0]           protocol revision, must be 0
//   [1..16]       client ID (16 raw bytes)
//   [17]          options length (0 in plain mode; >0 for encrypted flows,
//                 which this service does not decrypt)
//   [18+options]  mode (0 = stream, 1 = datagrams; only streams are served)
//   [19+options]  target port (2 bytes, big endian)
//   [21+options]  address type (1 = IPv4, 2 = name, 3 = IPv6)
//   [22+options]  address, then the first payload bytes
// On success we answer [0, 0] (revision + options length) and pipe the
// channel to the TCP connection. On failure the reference implementation
// closes without a response header, so we do the same. All later frames flow
// through the pipe and must not be re-parsed here.

// Cap each message at 1 MiB (the 100 MiB default is far more than a channel
// frame ever needs; a few of them would exhaust a small host's memory).
const wss = new WebSocket.Server({ server: httpServer, maxPayload: 1024 * 1024 });

// Close without sending anything (matches the reference implementation).
function reject(ws) {
  try {
    ws.terminate();
  } catch (e) { /* socket already gone */ }
}

wss.on('connection', ws => {
  let socket = null;
  let opened = false;

  // A connection that never sends its first frame carries no data — release
  // it so a public port cannot fill up with idle sockets.
  const firstFrameTimer = setTimeout(() => {
    if (!opened) reject(ws);
  }, 10000);

  ws.on('message', msg => {
    if (opened) return; // first frame handled; later frames go via the pipe
    clearTimeout(firstFrameTimer);

    if (!Buffer.isBuffer(msg) || msg.length < 19) {
      console.error('bad first frame (expected binary, >= 19 bytes)');
      reject(ws);
      return;
    }

    const version = msg.readUInt8(0);
    const id = msg.slice(1, 17);
    const idOk = id.every((b, k) => b === parseInt(idHex.slice(k * 2, k * 2 + 2), 16));
    const optionsLen = msg.readUInt8(17);
    if (version !== 0 || !idOk || msg.length < 19 + optionsLen) {
      console.error('handshake rejected (unknown id or bad version)');
      reject(ws);
      return;
    }

    // Parse the destination (fixed order: mode, port, address type, address).
    // Everything is read inside a guard: malformed frames must close the
    // channel, never crash the service.
    let host;
    let targetPort;
    let payload;
    try {
      let i = 18 + optionsLen;
      const mode = msg.readUInt8(i);
      i += 1;
      if (mode !== 0) { // 0 = stream, 1 = datagrams (not served by this site)
        throw new Error('unsupported mode ' + mode);
      }
      targetPort = msg.readUInt16BE(i);
      i += 2;
      const atyp = msg.readUInt8(i);
      i += 1;

      if (atyp === 1) { // IPv4
        if (msg.length < i + 4) throw new Error('truncated address');
        host = msg.slice(i, i + 4).join('.');
        i += 4;
      } else if (atyp === 2) { // name
        if (msg.length < i + 1) throw new Error('truncated address');
        const len = msg.readUInt8(i);
        if (len === 0) throw new Error('empty address name');
        if (msg.length < i + 1 + len) throw new Error('truncated address');
        host = new TextDecoder().decode(msg.slice(i + 1, i + 1 + len));
        i += 1 + len;
      } else if (atyp === 3) { // IPv6
        if (msg.length < i + 16) throw new Error('truncated address');
        const groups = [];
        for (let g = 0; g < 8; g++) {
          groups.push(msg.readUInt16BE(i + g * 2).toString(16).padStart(4, '0'));
        }
        host = groups.join(':');
        i += 16;
      } else {
        throw new Error('unsupported address type ' + atyp);
      }
      payload = msg.slice(i);
    } catch (err) {
      console.error('bad frame: ' + err.message + ', closing');
      reject(ws);
      return;
    }

    console.log('route to ' + host + ':' + targetPort);
    try {
      ws.send(new Uint8Array([version, 0])); // success ack
    } catch (e) {
      reject(ws);
      return;
    }

    const duplex = createWebSocketStream(ws);
    opened = true;
    socket = net.connect({ host, port: targetPort });
    // Error handlers must exist BEFORE 'connect' can fail: a pre-connect
    // error (refused port, unknown name, client gone mid-DNS-lookup) must
    // close this channel, never crash the service.
    duplex.on('error', err => console.error('client stream error: ' + err.message));
    socket.on('error', err => {
      console.error('route error: ' + err.message);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    });
    socket.once('connect', () => {
      socket.write(payload); // forward the first payload bytes
      duplex.pipe(socket).pipe(duplex);
    });
    socket.on('close', () => {
      // Upstream ended: close the channel so the client sees the drop.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    });
  });

  // Client went away: tear down the TCP socket so it cannot linger.
  ws.on('close', () => {
    clearTimeout(firstFrameTimer);
    if (socket) socket.destroy();
  });
  ws.on('error', err => console.error('channel error: ' + err.message));
});
