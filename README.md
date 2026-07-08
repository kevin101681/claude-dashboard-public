<img width="1920" height="1020" alt="Screenshot 2026-07-08 11 27 35 AM" src="https://github.com/user-attachments/assets/53b27933-7828-4716-bd34-339ac0c9296b" />
<img width="1920" height="1020" alt="Screenshot 2026-07-08 11 28 10 AM" src="https://github.com/user-attachments/assets/ae0d3bb6-439a-423d-9983-d4f6fc5e7ba2" />
<img width="1920" height="1020" alt="Screenshot 2026-07-08 11 30 06 AM" src="https://github.com/user-attachments/assets/1dfdd266-792a-4fb1-aa63-e39df7eba152" />
<img width="1280" height="2856" alt="Screenshot_20260708-113131" src="https://github.com/user-attachments/assets/47a05f9b-f271-472f-a097-abe5a6bada9e" />
<img width="1280" height="2856" alt="Screenshot_20260708-113122" src="https://github.com/user-attachments/assets/5f7073d9-eced-416a-baf7-1e47c693765b" />



# Claude Dashboard

Self-hosted web dashboard for **persistent, roamable Claude Code sessions**. The
session engine runs on your Windows PC; the UI opens from your phone, Chromebook,
or any browser. Sessions keep running when a device disconnects — reattach from
anywhere and the terminal replays where things stand.

## Features

**Persistent, roamable sessions**
- Every session is a persistent Windows ConPTY running `claude.exe`, owned by the
  server — not by any browser tab. Close the tab, lose Wi-Fi, or switch devices
  and it keeps running.
- Reattaching from any device replays the recent terminal buffer, and WebSockets
  auto-reconnect as you roam between networks.
- Resume historical sessions — even from before a server restart — via
  `claude --resume`.

**Two ways to view a session**
- **Chat view** — a clean user/assistant conversation parsed live from Claude
  Code's own transcript, with timestamps and lightweight markdown.
- **Console view** — the full raw xterm.js terminal with scrollback.
- A live status pill shows whether Claude is *working*, *waiting on you*, or
  *idle* — derived from the PTY, which the transcript alone can't reveal.
- **Inline approvals**: permission/trust prompts are parsed and offered as
  tappable buttons right in the chat — no need to drop to the console.

**Session management**
- Live sessions and history in one sidebar; recent transcripts show project, git
  branch, model, relative time, and a context-window usage gauge.
- Tap any past conversation to preview it read-only, then Resume to take it live.
- Rename (persists across restarts), hide, kill/remove, and filter by project.

**Launching work**
- New Claude session into any project or an arbitrary folder, with a per-session
  model override on top of the server's model lock.
- New PowerShell (console-only) shell sessions.
- Auto (bypass) permission mode by default, configurable.

**Search, files & input**
- Full-text search across every transcript, with highlighted snippets.
- Home-sandboxed file explorer + editor, plus an artifact viewer (`.html` renders
  in a sandboxed iframe, `.md` as rich text, each with a Code/Preview toggle).
  File paths in chat are clickable.
- Image upload from the composer, voice dictation (Web Speech API), a growing
  multi-line composer, and a mobile key bar (Esc, Tab, ⇧Tab, Ctrl-C, arrows).

**Access & operations**
- Two auth modes — shared token for local/LAN use, or Clerk sign-in with an email
  allowlist for public roaming (see [Authentication](#authentication)).
- Plan usage meters (5-hour + weekly), server health awareness (restart buttons
  go red when unreachable, green banner on recovery), and one-click server
  restart you can watch run.

**Interface**
- Light/dark theme (terminal palette follows), responsive layout with an optional
  desktop two-pane split view, and an installable PWA.

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

## Authentication

**Do I need Clerk? No.** The dashboard has two independent auth modes and picks
based on whether you've configured Clerk:

- **Token mode (default, zero setup).** With no Clerk keys, the server generates a
  random token on first run and gates everything behind it — you open the
  dashboard with the `?token=…` link printed in the console (it's then stored in a
  cookie). No account, no third-party service. This is all you need to run it on
  your own PC, LAN, or a private Tailscale network.
- **Clerk mode (opt-in, for public hosting).** Only when both `clerkSecretKey` and
  `clerkPublishableKey` are set. This adds real sign-in with an email allowlist —
  the safe way to expose the UI on the public internet (e.g. a Netlify-hosted
  frontend), since a token in a URL isn't. Clerk has a free tier; see
  [Clerk setup](#clerk-setup).

In short: **local or private network → nothing to configure. Public internet →
turn on Clerk.**

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
