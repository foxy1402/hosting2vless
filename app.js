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
const dgram = require('dgram');
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
//   [18+options]  command (1 = TCP stream, 2 = UDP, 3 = Mux, 4 = reverse;
//                   0 is also accepted as TCP for the old dialect)
//   [19+options]  target port (2 bytes, big endian)
//   [21+options]  address type (1 = IPv4, 2 = name, 3 = IPv6)
//   [22+options]  address, then the first payload bytes
// On success we answer [0, 0] (revision + options length). For TCP the
// channel is then piped to the TCP connection. For UDP, later frames are
// length-prefixed UDP packets ([2B length][payload]) and answers come back
// the same way. On failure the reference implementation closes without a
// response header, so we do the same.


// --- UDP relay (standard VLESS command 2) ------------------------------------
// One WebSocket connection carries one UDP destination (host:port from the
// header). Each UDP packet in the stream is [2B length BE][payload]; the
// first payload may also arrive as a bare packet, which we accept as well.
// Answers go back as [version, 0] (first answer only) + [2B length][payload].
function createUdpRelay(ws, version, host, targetPort) {
  const udp = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
  let headerSent = false;
  let closed = false;
  let buf = Buffer.alloc(0);
  let idle = setTimeout(close, 30000);
  function refresh() { clearTimeout(idle); idle = setTimeout(close, 30000); }
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    try { udp.close(); } catch (e) { /* already closed */ }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(); } catch (e) { /* gone */ }
    }
  }
  function sendPacket(packet) {
    if (closed || packet.length === 0) return;
    refresh();
    udp.send(packet, targetPort, host, err => {
      if (err) console.error('udp send error: ' + err.message);
    });
  }
  function feed(chunk, isFirst) {
    if (closed || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
    refresh();
    if (isFirst && chunk.length >= 2) {
      const len = chunk.readUInt16BE(0);
      if (2 + len > chunk.length) { sendPacket(chunk); return; } // bare packet
    }
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const len = buf.readUInt16BE(0);
      if (len === 0) { buf = buf.slice(2); continue; }
      if (buf.length < 2 + len) break; // wait for the rest of this packet
      sendPacket(buf.slice(2, 2 + len));
      buf = buf.slice(2 + len);
    }
  }
  udp.on('message', data => {
    if (closed) return;
    refresh();
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(data.length, 0);
    const prefix = headerSent ? Buffer.alloc(0) : Buffer.from([version, 0]);
    headerSent = true;
    try { ws.send(Buffer.concat([prefix, lenBuf, data])); } catch (e) { close(); }
  });
  udp.on('error', err => {
    console.error('udp error: ' + err.message);
    close();
  });
  ws.on('close', close);
  ws.on('error', close);
  return { feed, close };
}

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
  let udpRelay = null;

  // A connection that never sends its first frame carries no data — release
  // it so a public port cannot fill up with idle sockets.
  const firstFrameTimer = setTimeout(() => {
    if (!opened) reject(ws);
  }, 10000);

  ws.on('message', msg => {
    if (opened) { // TCP: later frames go via the pipe; UDP: length-prefixed packets
      if (udpRelay) udpRelay.feed(msg, false);
      return;
    }
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

    // Parse the destination (fixed order: command, port, address type, address).
    // Everything is read inside a guard: malformed frames must close the
    // channel, never crash the service.
    let host;
    let targetPort;
    let payload;
    let command;
    try {
      let i = 18 + optionsLen;
      command = msg.readUInt8(i);
      i += 1;
      // Standard VLESS: 1 = TCP, 2 = UDP. 0 is the old dialect's TCP.
      // 3 = Mux and 4 = reverse are not served; a client using Mux must
      // turn it off. Anything else is a malformed frame.
      if (command !== 0 && command !== 1 && command !== 2) {
        throw new Error('unsupported command ' + command);
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

    console.log('route to ' + host + ':' + targetPort + (command === 2 ? ' (udp)' : ''));
    if (command === 2) {
      opened = true;
      udpRelay = createUdpRelay(ws, version, host, targetPort);
      udpRelay.feed(payload, true);
      return;
    }
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
