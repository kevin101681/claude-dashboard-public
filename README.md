# Claude Dashboard

Self-hosted web dashboard for **persistent, roamable Claude Code sessions**. The
session engine runs on your Windows PC; the UI opens from your phone, Chromebook,
or any browser. Sessions keep running when a device disconnects — reattach from
anywhere and the terminal replays where things stand.

## Architecture

- **The PC server is the "tmux".** Each session is a persistent Windows ConPTY
  running `claude.exe`, owned by `server.js` — not by any browser tab. It also
  scans `~/.claude/projects/**/*.jsonl` (Claude Code's native transcript store)
  to list recent sessions with title, project, git branch, model, and a
  context-token gauge, and injects `ANTHROPIC_MODEL` (default `opus`) into every
  session it spawns.
- **The frontend is static** and can be served two ways:
  1. Directly by the PC server (works out of the box, shared-token auth).
  2. From **Netlify** with **Clerk** sign-in, pointing back at the PC server via
     `BACKEND_URL`. This is the roaming setup: one stable HTTPS URL, real login,
     no token links.
- **Resume anything.** Sessions from the history list (or from before a server
  restart) are reattached via `claude --resume <session-id>`.

## Run the session engine (Windows PC)

```powershell
npm install
node server.js        # or: .\start-dashboard.ps1
```

Auto-start on login:

```powershell
schtasks /create /tn "Claude Dashboard" /sc onlogon /rl limited /tr "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File 'C:\path\to\Claude Dashboard\start-dashboard.ps1'"
```

## Environment variables

### Netlify (Site settings → Environment variables) — frontend only

| var | example | notes |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | `pk_live_…` | public; baked into `env.js` at build |
| `BACKEND_URL` | `https://mypc.tail1234.ts.net` | HTTPS address of the PC server |

**Never put `CLERK_SECRET_KEY` on Netlify** — the frontend doesn't need it.

### Windows PC (`server.js`) — set as env vars or camelCase keys in `config.json`

| var | config.json key | example | notes |
|---|---|---|---|
| `CLERK_SECRET_KEY` | `clerkSecretKey` | `sk_live_…` | enables Clerk mode; verifies JWTs |
| `CLERK_PUBLISHABLE_KEY` | `clerkPublishableKey` | `pk_live_…` | must match the Netlify one |
| `ALLOWED_EMAILS` | `allowedEmails` | `you@example.com` | comma-separated allowlist; **set this** or any signed-up Clerk user gets in |
| `FRONTEND_ORIGIN` | `frontendOrigin` | `https://yoursite.netlify.app` | CORS allowlist, comma-separated |
| `ALLOW_TOKEN_AUTH` | `allowTokenAuth` | `false` | default `true`; keeps the legacy `?token=` links working alongside Clerk |

`config.json` (gitignored, created on first run) also holds: `port` (4310),
`host`, `token`, `model` (`opus`), `claudePath`.

## Exposing the PC server over HTTPS

The Netlify page is HTTPS, so browsers refuse to open plain `ws://` connections
to the PC. Pick one:

- **Tailscale (recommended, private):** `tailscale serve --bg 4310` — proxies
  `https://<pc-hostname>.<tailnet>.ts.net` → `localhost:4310` with automatic
  certificates (WebSockets included). Devices must be on your tailnet.
- **cloudflared (public URL):** `cloudflared tunnel --url http://localhost:4310`
  — then Clerk auth is the only thing between the internet and your terminal,
  so set `ALLOWED_EMAILS` and `ALLOW_TOKEN_AUTH=false`.

Do **not** port-forward 4310 on your router.

## Clerk setup

1. Create an application at dashboard.clerk.com → copy the publishable + secret keys.
2. Add your Netlify domain (and any other origins you'll browse from) under
   **Domains / allowed origins** in the Clerk dashboard.
3. Disable public sign-ups (Restrictions → Sign-up mode) or rely on `ALLOWED_EMAILS`.

## Files

- `server.js` — Express + WebSocket server, CORS, auth wiring, API
- `lib/auth.js` — Clerk JWT verification (+ email allowlist) and legacy token auth
- `lib/discovery.js` — transcript scanner (head/tail chunk parsing, never loads whole files)
- `lib/sessions.js` — live PTY manager with scrollback replay
- `public/` — xterm.js frontend with mobile key bar (Esc, Tab, ⇧Tab, Ctrl-C, arrows)
- `scripts/build-static.js` — copies xterm vendor files + writes `env.js` (postinstall & Netlify build)
- `netlify.toml` — Netlify build config (publishes `public/`)
