# hosting2vless

Turn a **free web host** into a personal **VLESS node** that you connect to
with your phone or laptop proxy client (v2rayTun, Mihomo / Clash Meta,
Clash Verge, V2RayNG, Shadowrocket, sing-box, OpenClash — any of them).

One small program (`app.js`) does everything:

| URL on your domain | What it is |
|---|---|
| `https://your-domain/` | a one-line status page (also keeps the host from sleeping the app) |
| `https://your-domain/feed` | **your subscription link** (base64 text) — paste this URL into your client |
| `wss://your-domain/` | the VLESS WebSocket channel the client actually tunnels through |

The files you upload are deliberately **camouflaged** — named and worded like
an ordinary small website; nothing in them says "vless", "proxy" or
"node". See [Camouflage](#camouflage) at the end.

No coding is required: every step below is clicking and pasting. If you get
stuck, that section's numbered step is where to look.

---

## What you need before you start

1. **A free web host.** This guide covers two flavors:
   - the panel has a **Node.js application manager** (example: Webhostmost)
     → follow **[Path A](#path-a--panel-with-a-nodejs-application-manager-example-webhostmost)**
   - the panel has **no Node.js manager and no terminal**, but it has
     **cron jobs + `.htaccess`** (example: DataOnline free hosting,
     DirectAdmin panel) → follow **[Path B](#path-b--panel-without-a-nodejs-manager-example-dataonline)**
   Both flavors must also give you: a file manager, an SSL certificate
   section, and (Path B) a cron job section.
2. **A domain or subdomain of your own** — you must be able to add an
   **A record** to its DNS (Cloudflare, your registrar, ...). A subdomain
   like `vn.yourdomain.com` is all that's needed.
3. **A proxy client** installed on the device that will use the node.

> **Privacy:** the URL `https://your-domain/feed` is your node's address —
> and the link inside it contains your client ID (the node's password).
> Share neither with anyone. If someone has your feed URL, they can use
> your free host's traffic.

---

## Configuration (both paths)

Open `app.js` in any text editor (the panel's file manager can open it).
The settings are at the very top of the file:

| Setting | What to put | Notes |
|---|---|---|
| `DOMAIN` | your domain or subdomain, **without** `https://` (e.g. `vn.example.com`) | required — it is used in the link your clients receive |
| `NAME` | anything, e.g. `VN-backup` | this is the label shown in your client's node list |
| `PORT` | leave the default **`28741`** | an *internal* port. Low ports (3000, 8080, ...) are usually already taken on shared hosts; 20000–40000 is a safe range. If you change it, the change must be mirrored where it's referenced (panel UI in Path A; `.htaccess` **and** the `PORT` line in `health.sh` in Path B) |
| `UUID` | **leave empty** | on first start the program generates a random one and saves it to `config.txt` next to `app.js`. It survives restarts, so your links keep working. (Advanced: you can also set any UUID you like here.) |
| `SUB_PATH` | leave the default **`/feed`** | the URL where your subscription lives |

Save the file after editing. That's the only code you ever have to touch.

---

## Path A — panel with a Node.js application manager (example: Webhostmost)

The panel runs the program for you; you only upload two files.

1. **Register** at the host (e.g.
   [Webhostmost](https://client.webhostmost.com/register.php)), verify your
   email, then *Buy New Hosting Plan* → **Free Plan** (top left) → *Order
   Now*.

   ![](https://images.2024921.xyz/images/202502081754083.png)
   ![](https://images.2024921.xyz/images/202502081755841.png)

2. **Choose the domain option.** Pick *Use Subdomain* (third option) and
   enter a prefix, e.g. `hezi.freewebhostmost.com`, then *Check*.
   (Note: hosts of this type now usually expect **your own domain** — see
   the host's own FAQ if the free subdomain option is gone.)

   ![](https://images.2024921.xyz/images/202502081755392.png)

3. **Pick a server location** (disk space ~125 MB is plenty for this), then
   *Checkout*. You should see your new service on the home page.

   ![](https://images.2024921.xyz/images/202502081756515.png)

4. **Upload the files.** Control panel → **Files Management → File
   Manager** → your domain → `public_html`. Upload **`app.js`** and
   **`package.json`** there — and *only* those two (`.htaccess` and the
   `.sh` scripts are for Path B).

   ![](https://images.2024921.xyz/images/202502081756696.png)

5. **Configure `app.js`** as described in [Configuration](#configuration-both-paths).

   ![](https://images.2024921.xyz/images/202502081757775.png)

6. **Create the application.** *Website Management → Node.js Application →
   Create Application → CREATE*. Pick the newest Node.js version offered
   (e.g. v22), set:
   - **Application root:** `domains/your-domain/public_html` (the folder you
     uploaded to)
   - **Startup file:** `app.js`
   - **Port:** the same value as `PORT` in `app.js` (default `28741`)

   ![](https://images.2024921.xyz/images/202502081757659.png)
   ![](https://images.2024921.xyz/images/202502121229848.png)

7. **Install the one dependency.** *Development Tools → Terminal*. The
   application page showed you a line of text — copy it into the terminal
   and press Enter (it switches the terminal into the app's environment).
   Then type:

   ```
   npm i
   ```

   and press Enter. Wait until it finishes.

   ![](https://images.2024921.xyz/images/202502121427797.png)

8. **Start it.** Back on the Node.js application screen, press
   **Run JS script** (or the equivalent *Start* button).

9. **Check it works:** open `https://your-domain/feed` in a browser. You
   should see one line of base64 text. Then do the
   [verification checklist](#verification-checklist) and
   [use the node](#using-the-node).

*Optional — hide the node behind a Cloudflare Worker reverse proxy:*
deploy a Worker on Cloudflare pointed at a domain you control, with this
code (replace the list with your node domain):

```js
export default {
  async fetch(request, env) {
    let url = new URL(request.url);
    if (url.pathname.startsWith('/')) {
      var arrStr = [
        'your-node-domain.com', // your node's domain
      ];
      url.protocol = 'https:';
      url.hostname = arrStr[Math.floor(Math.random() * arrStr.length)];
      return fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  },
};
```

Then point your clients at the Worker's domain instead, and set `DOMAIN` in
`app.js` to the Worker domain (SNI/Host must match what the client sees).

---

## Path B — panel without a Node.js manager (example: DataOnline)

The panel won't let you manage Node.js apps or give you a terminal, but the
host's operating system **still has Node.js installed underneath** — cron
jobs *can* execute it. So this path uses three tricks:

- a **one-time cron job** installs the single dependency
- a **per-minute cron job** (`health.sh`) restarts the program within a
  minute whenever it dies
- a **`.htaccess`** file makes Apache (the public web server) forward
  everything — plain HTTP *and* WebSocket upgrades — to the program's
  internal port

### Where each file goes

| File | Goes to | Purpose |
|---|---|---|
| `app.js`, `package.json`, `.htaccess` | `public_html` | the program + the web-server rules that reach it |
| `setup.sh` | your **home directory** (one level above `public_html`) | one-time dependency install; its cron is deleted afterwards |
| `health.sh` | your **home directory** | the per-minute liveness check that keeps the program alive forever |

### Steps

1. **Upload** `app.js`, `package.json` and `.htaccess` into `public_html`
   (file manager → your domain → public_html).

2. **Configure `app.js`** as described in [Configuration](#configuration-both-paths).
   Keep `PORT` at the default `28741` so it matches `.htaccess`.

3. **Find the host's hidden node path.** You have no terminal, so borrow
   cron: create a cron job that runs **every minute** with exactly this
   command:

   ```
   which node; node -v
   ```

   The panel **emails you the output** (cron output is mailed on these
   hosts). On CloudLinux hosts the path looks like
   `/opt/cpanel/ea-node20/root/usr/bin/node` — that's your `NODE_BIN`.
   **Delete this temporary cron job** when you have it.

4. **Create `setup.sh` in your home directory.** File manager → home
   directory → *create file* `setup.sh` → paste the contents of
   `setup.sh` from this repo. Edit **only these two lines**:

   ```bash
   NODE_BIN="/opt/cpanel/ea-node20/root/usr/bin/node"   # from step 3
   APP_DIR="/home/your-user/domains/your-domain/public_html"  # your real path
   ```

   (The file manager shows your real home directory and public_html path.)

5. **Run the one-time installer.** Create a cron job (every minute is fine)
   with:

   ```
   bash /home/your-user/setup.sh
   ```

   Wait for the panel's email. On success it says `setup finished` and
   `node_modules` now exists inside `public_html`. If it reports a failure,
   just run the job once more — it repairs half-finished installs on its
   own. **Delete this temporary cron job** when it succeeded.

6. **Create `health.sh` in your home directory** the same way (paste the
   contents from this repo, edit the `NODE_BIN` and `APP_DIR` lines — and
   the `PORT` line only if you changed it in `app.js`). No file
   permissions needed.

7. **Add the permanent cron job** (every minute) — this is the only cron
   that stays on the host:

   ```
   bash /home/your-user/health.sh
   ```

   Within a minute, `public_html/site.log` gets a startup line and
   `public_html/site.pid` appears.

8. **Self-heal test** (prove it really restarts): create a temporary cron
   with:

   ```
   kill $(cat /home/your-user/domains/your-domain/public_html/site.pid)
   ```

   wait one minute, then look at `public_html/site.log` — it must contain a
   new `service starting` line. Delete the temporary cron job.

9. **DNS + certificate** — see below — then the
   [verification checklist](#verification-checklist) and
   [using the node](#using-the-node).

> **Line endings:** if you edit the `.sh` files in the panel's web editor,
> keep them on **Unix (LF)** line endings — Windows-style (CRLF) breaks
> bash. (Files downloaded from this repo are already LF.)

### DNS + certificate (both paths, if you haven't done this yet)

1. In your DNS manager (Cloudflare, registrar, ...), add an **A record**
   for your subdomain pointing at the host's IP (the panel's service page
   shows it). If you use Cloudflare: set the record to **DNS only — gray
   cloud**. Do *not* enable the orange proxy; Cloudflare's free tier
   limits WebSocket long connections, which is exactly what this node is.
   Wait until a public DNS lookup (e.g. dnschecker.org) returns the host IP.

2. In the panel's **SSL Certificates** section, request the free
   **Let's Encrypt** certificate for your domain. Until this exists, port
   443 shows the host's default certificate (for *another* domain) and
   strict TLS checks in your client will fail.

---

## Verification checklist

Work through all five — if one fails, jump to
[Troubleshooting](#troubleshooting).

- [ ] `https://your-domain/feed` opens in a browser and shows **one
      base64 line**
- [ ] Pasted into any base64 decoder, it is a
      `vless://<id>@your-domain:443?...` link containing **your** domain
      only
- [ ] `https://your-domain/` passes a **strict** TLS check (certificate is
      valid for your domain — no "certificate mismatch")
- [ ] Import the feed URL into your client (next section) and a web page
      loads through the proxy
- [ ] An "what is my IP" site, opened **through the proxy**, shows the
      host's location (e.g. Hanoi for DataOnline)

---

## Using the node

**Subscription (recommended).** In your client, add a **subscription** with
the URL:

```
https://your-domain/feed
```

v2rayTun: *add → subscription → paste the URL → done*. Subscriptions
re-read the link when you refresh them, so the node stays correct after a
client-ID rotation (see below).

**Manual entry.** Decode the base64 line (or build it yourself) — the link
looks like:

```
vless://<uuid>@your-domain:443?encryption=none&security=tls&sni=your-domain&type=ws&host=your-domain&path=%2F#NAME
```

Notes for manual configuration:

- **UDP: off** (or "fake UDP") — this node carries TCP only.
- TLS: on; server name (SNI) = your domain; WS path = `/`.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `https://your-domain/feed` → connection error (Path B) | Is the `health.sh` cron still there? Does `public_html/site.log` show a startup line in the last minute? Open `site.log` in the file manager — the last lines say what's wrong (e.g. a port conflict). |
| `https://your-domain/feed` → 503 (Path B) | The web server can't reach the internal port: the program is down (see above) **or** `PORT` in `app.js` no longer matches the port in `.htaccess` / `health.sh`. (An empty `DOMAIN` in `app.js` also makes the feed answer 503 on purpose.) |
| `https://your-domain/feed` → 404 | You're hitting the wrong path (the feed is at `/feed`, not `/sub`). Or `DOMAIN` was typed with a typo — the endpoint itself is fine, but double-check the URL you opened. |
| Feed opens, client can't connect | Certificate not issued yet (gray-cloud DNS + Let's Encrypt done?), `DOMAIN` in `app.js` doesn't exactly match the URL you're using, or your client has UDP on. |
| Client works, then stops after a host reboot (Path B) | Normal — the `health.sh` cron brings it back within a minute. Check `site.log` for the new `service starting` line. |
| I edited `app.js` but nothing changed | The running program still has the old code. Path A: use the panel's stop/start buttons. Path B: run the self-heal `kill` step once — it restarts within a minute with the new code. |

**Traffic is the hard limit.** Free hosts of this kind cap traffic
(DataOnline free: 20 GB/month). Watch your client's per-node traffic
statistics and treat this as a light backup node — fine for browsing and
chat, not for heavy downloading or sharing.

**Rotate the client ID (UUID).** Delete `public_html/config.txt` in the
file manager, then restart (Path A: stop/start; Path B: the self-heal
`kill` step). The program generates a fresh ID on next start; refresh the
subscription in your client afterwards.

---

## Camouflage

Everything that lands on the host is named and worded like an ordinary
small website:

| What it really is | How it looks |
|---|---|
| the VLESS subscription endpoint | `/feed` — a normal "feed" URL |
| the client ID (the node's password) | `config.txt` (also `chmod 600` by `health.sh`) |
| the program's log / process ID | `site.log` / `site.pid` — boring ops files |
| the per-minute cron script | `health.sh` — a *health check* is the most normal thing to cron every minute |
| the one-time installer | `setup.sh` |
| the program itself | `app.js` — a standard name in any web project |

`app.js`'s comments and log lines say "site service", "live channel" and
"route" — no "vless", no "proxy", no "xray/socks". The only "node" visible
on the host is the Node.js runtime binary itself, which appears the same on
every Node.js host. `.htaccess` additionally blocks direct access to
`app.js`, the two `.sh` scripts, `package.json`, `config.txt` and the
log/PID files in case the routing rules are ever disabled.

One honest tell: the `node_modules/` folder inside `public_html` (required
by the runtime). While the program is up, every request is answered by the
program itself, so the folder is never reached; if the routing rules are
ever disabled, `.htaccess` still answers 403 for it instead of serving
files.

---

## Files

| File | Purpose |
|---|---|
| `app.js` | the whole node — single file |
| `package.json` | one dependency: `ws` |
| `.htaccess` | Path B: web-server rules (routing + file hiding) |
| `health.sh` | Path B: per-minute liveness cron |
| `setup.sh` | Path B: one-time dependency install |
| `LICENSE` | GPL-3.0 |

---

## License

GPL-3.0 (see `LICENSE`). The upstream project adds: keep the original
author credit, modified versions must stay GPL, and no commercial use
without permission (contact: admin@eooce.com).
