// Claude Dashboard — self-hosted session orchestrator.
// Serves a mobile-friendly web UI that lists Claude Code sessions (live and
// historical), spawns new Opus-locked sessions in persistent PTYs, and streams
// terminals to any device over WebSockets.
//
// The frontend can be served from this server directly OR from Netlify (static
// hosting + Clerk sign-in) pointing back at this server via BACKEND_URL.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');

const { listRecentSessions, listProjects } = require('./lib/discovery');
const { searchSessions } = require('./lib/search');
const { SessionManager } = require('./lib/sessions');
const { Auth } = require('./lib/auth');
const { Files } = require('./lib/files');
const { readNewMessages } = require('./lib/transcript');

// ---------------------------------------------------------------- config ----
const CONFIG_PATH = path.join(__dirname, 'config.json');

function detectClaudePath() {
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' });
    const exe = out.split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('.exe'));
    if (exe) return exe.trim();
  } catch { /* fall through */ }
  return path.join(os.homedir(), '.local', 'bin', 'claude.exe');
}

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      // Tolerate a UTF-8 BOM (Windows editors and PowerShell add one).
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      // Never silently regenerate over a file the user hand-edited — that
      // would destroy their keys. Make them fix it instead.
      console.error(`FATAL: ${CONFIG_PATH} exists but is not valid JSON (${err.message}).`);
      console.error('Fix the syntax (or delete the file to start fresh), then restart.');
      process.exit(1);
    }
  }
  let dirty = false;
  if (!cfg.port) { cfg.port = 4310; dirty = true; }
  if (!cfg.host) { cfg.host = '0.0.0.0'; dirty = true; }
  if (!cfg.token) { cfg.token = crypto.randomBytes(24).toString('base64url'); dirty = true; }
  if (!cfg.model) { cfg.model = 'opus'; dirty = true; }
  // Auto mode: every Claude session launches in full-auto (bypassPermissions)
  // so the dashboard isn't a permission-prompt treadmill — matches desktop
  // "bypass" mode. Set to 'acceptEdits' (edits only) or '' (prompt for all).
  if (cfg.permissionMode === undefined) { cfg.permissionMode = 'bypassPermissions'; dirty = true; }
  if (!cfg.contextWindow) { cfg.contextWindow = 1000000; dirty = true; }
  if (!cfg.claudePath || !fs.existsSync(cfg.claudePath)) {
    cfg.claudePath = detectClaudePath();
    dirty = true;
  }
  if (dirty) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

const config = loadConfig();
if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.HOST) config.host = process.env.HOST;
const sessions = new SessionManager(config);
const auth = new Auth(config);

const files = new Files(config);

// Dashboard-owned data (uploaded images, hidden-session list) lives outside
// the repo and outside ~/.claude.
const DATA_DIR = path.join(os.homedir(), '.claude-dashboard');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const HIDDEN_PATH = path.join(DATA_DIR, 'hidden.json');

function loadHidden() {
  try { return new Set(JSON.parse(fs.readFileSync(HIDDEN_PATH, 'utf8'))); } catch { return new Set(); }
}
function saveHidden(hidden) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HIDDEN_PATH, JSON.stringify([...hidden], null, 2));
}

// Custom session titles, keyed by Claude session id (survives restarts and
// applies to both live cards and history).
const TITLES_PATH = path.join(DATA_DIR, 'titles.json');
function loadTitles() {
  try { return JSON.parse(fs.readFileSync(TITLES_PATH, 'utf8')); } catch { return {}; }
}
function saveTitles(titles) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TITLES_PATH, JSON.stringify(titles, null, 2));
}

const app = express();
app.use(express.json({ limit: '30mb' })); // room for base64 image uploads

// ------------------------------------------------------------------ cors ----
// Needed when the frontend is hosted elsewhere (e.g. Netlify). Comma-separated
// list of allowed origins via FRONTEND_ORIGIN env or config.frontendOrigin.
const frontendOrigins = (process.env.FRONTEND_ORIGIN || config.frontendOrigin || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && frontendOrigins.includes(origin.replace(/\/$/, ''))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ------------------------------------------------------------------ auth ----
// Runtime env for the frontend. Public: contains only the publishable key.
// Served before auth so the sign-in shell can boot. When the frontend is
// served by this server, BACKEND_URL stays '' (same origin).
app.get('/env.js', (req, res) => {
  const env = { CLERK_PUBLISHABLE_KEY: auth.publishableKey, BACKEND_URL: '' };
  res.type('application/javascript').send(`window.ENV=${JSON.stringify(env)};\n`);
});

if (auth.clerkEnabled) {
  // Clerk mode: static app shell is public, API requires a verified JWT.
  app.use('/api', async (req, res, next) => {
    if (await auth.authorize(req)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });
} else {
  // Token mode: everything is gated behind the shared token + cookie.
  app.use(async (req, res, next) => {
    if (!auth.tokenAuthorized(req)) {
      res.status(401).send(
        '<body style="background:#fdfcff;color:#152d35;font-family:Roboto,sans-serif;display:grid;place-items:center;height:100vh;margin:0">' +
        '<div style="text-align:center"><h2>Claude Dashboard</h2><p style="color:#536065">Unauthorized. Open the dashboard using the tokenized link printed in the server console.</p></div></body>'
      );
      return;
    }
    res.setHeader('Set-Cookie',
      `cd_token=${encodeURIComponent(config.token)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    next();
  });
}

// ---------------------------------------------------------------- static ----
app.use(express.static(path.join(__dirname, 'public')));
// Fallback vendor mounts in case scripts/build-static.js hasn't populated
// public/vendor yet (it runs on npm install).
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));

// ------------------------------------------------------------------- api ----
// Cheap liveness probe. `startedAt` changes whenever the process restarts, so
// the client can tell a fresh boot apart from an unbroken connection.
const SERVER_STARTED_AT = Date.now();
app.get('/api/health', (req, res) => {
  res.json({ ok: true, startedAt: SERVER_STARTED_AT, uptime: process.uptime(), pid: process.pid });
});

app.get('/api/state', (req, res) => {
  const hidden = loadHidden();
  const titles = loadTitles();
  const recent = listRecentSessions({ limit: 40 }).filter(r => !hidden.has(r.sessionId));
  const liveList = sessions.list().map(s => ({
    ...s,
    name: (s.claudeSessionId && titles[s.claudeSessionId]) || s.name,
  }));
  const liveClaudeIds = new Set(liveList.map(s => s.claudeSessionId).filter(Boolean));
  res.json({
    model: config.model,
    contextWindow: config.contextWindow,
    startedAt: SERVER_STARTED_AT,
    live: liveList,
    recent: recent.map(r => ({
      ...r,
      customTitle: titles[r.sessionId] || null,
      isLive: liveClaudeIds.has(r.sessionId),
    })),
    projects: listProjects(recent),
  });
});

// Rename: stored against the Claude session id so it sticks across restarts
// and shows on the history card too. Falls back to the live PTY name when the
// transcript hasn't been created yet.
app.post('/api/sessions/:id/rename', (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  const desc = sessions.describe(session);
  session.name = String(name).trim().slice(0, 120);
  if (desc.claudeSessionId) {
    const titles = loadTitles();
    titles[desc.claudeSessionId] = session.name;
    saveTitles(titles);
  }
  res.json({ ok: true });
});

app.post('/api/recent/:sessionId/title', (req, res) => {
  const { title } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
  const titles = loadTitles();
  titles[req.params.sessionId] = String(title).trim().slice(0, 120);
  saveTitles(titles);
  res.json({ ok: true });
});

// Chat view: incrementally read parsed messages from the session's transcript.
app.get('/api/sessions/:id/messages', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  if (session.kind === 'shell') return res.json({ offset: 0, messages: [], pending: false, status: sessions.computeStatus(session), prompt: null });
  const desc = sessions.describe(session); // resolves claudeSessionId lazily
  const status = sessions.computeStatus(session);
  // When a permission/trust menu is on screen, surface its options so the chat
  // view can offer them as buttons (null when unparseable -> client falls back).
  const prompt = status === 'awaiting_input' ? sessions.parseApprovalPrompt(session) : null;
  if (!desc.claudeSessionId) return res.json({ offset: 0, messages: [], pending: true, status, prompt });
  const offset = Number(req.query.offset) || 0;
  try {
    const out = readNewMessages(session.cwd, desc.claudeSessionId, offset);
    out.status = status;
    out.prompt = prompt;
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Read-only chat view of a past (non-live) transcript: reads the .jsonl
// straight off disk by cwd + session id, so a recent card can be previewed
// without spawning a PTY to resume it.
app.get('/api/transcript/:sessionId/messages', (req, res) => {
  const sessionId = String(req.params.sessionId);
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return res.status(400).json({ error: 'bad session id' });
  const cwd = String(req.query.cwd || '');
  if (!cwd) return res.status(400).json({ error: 'cwd required' });
  const offset = Number(req.query.offset) || 0;
  try {
    res.json(readNewMessages(cwd, sessionId, offset));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Full-text search across all session transcripts.
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [], truncated: false });
  try {
    const out = await searchSessions(q);
    const titles = loadTitles();
    for (const r of out.results) r.customTitle = titles[r.sessionId] || null;
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Plan usage (5-hour + weekly windows) via Claude Code's own OAuth token.
// The token lives in ~/.claude/.credentials.json and Claude Code refreshes it
// itself; we only ever read the file. Cached so sidebar polling stays cheap.
const usageCache = { at: 0, data: null };
app.get('/api/usage', async (req, res) => {
  if (usageCache.data && Date.now() - usageCache.at < 60_000) return res.json(usageCache.data);
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const token = creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
    if (!token) throw new Error('no Claude Code OAuth token in ~/.claude/.credentials.json');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!r.ok) throw new Error(`usage API returned ${r.status}`);
    const raw = await r.json();
    const window_ = (w) => (w && typeof w.utilization === 'number')
      ? { pct: w.utilization, resetsAt: w.resets_at || null }
      : null;
    const data = {
      fiveHour: window_(raw.five_hour),
      weekly: window_(raw.seven_day),
      fetchedAt: Date.now(),
    };
    usageCache.at = Date.now();
    usageCache.data = data;
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Soft-hide a transcript from the recents list (the .jsonl itself is untouched).
app.post('/api/recent/:sessionId/hide', (req, res) => {
  const hidden = loadHidden();
  hidden.add(req.params.sessionId);
  saveHidden(hidden);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ files ----
app.get('/api/fs/list', (req, res) => {
  try { res.json(files.list(req.query.path)); }
  catch (err) { res.status(400).json({ error: String(err.message || err) }); }
});

app.get('/api/fs/read', (req, res) => {
  try { res.json(files.read(req.query.path)); }
  catch (err) { res.status(400).json({ error: String(err.message || err) }); }
});

app.post('/api/fs/write', (req, res) => {
  const { path: p, content } = req.body || {};
  try { res.json(files.write(p, content)); }
  catch (err) { res.status(400).json({ error: String(err.message || err) }); }
});

app.get('/api/fs/raw', (req, res) => {
  try {
    const { buffer, mime } = files.raw(req.query.path);
    res.type(mime).send(buffer);
  } catch (err) { res.status(400).json({ error: String(err.message || err) }); }
});

// Image upload from the composer: saved on the PC, path returned so it can be
// referenced in a prompt (Claude Code reads images by file path).
app.post('/api/uploads', (req, res) => {
  const { name, dataBase64 } = req.body || {};
  if (!name || !dataBase64) return res.status(400).json({ error: 'name and dataBase64 required' });
  const safeName = String(name).replace(/[^\w.\- ]/g, '_').slice(-80);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const dest = path.join(UPLOADS_DIR, `${stamp}-${safeName}`);
    fs.writeFileSync(dest, Buffer.from(dataBase64, 'base64'));
    res.json({ path: dest });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/sessions', (req, res) => {
  const { cwd, resumeId, name, kind, model } = req.body || {};
  if (!cwd || typeof cwd !== 'string') return res.status(400).json({ error: 'cwd is required' });
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: `Directory does not exist: ${cwd}` });
  // Don't attach two PTYs to the same underlying Claude conversation.
  if (resumeId) {
    const existing = sessions.list().find(s => s.claudeSessionId === resumeId && !s.exited);
    if (existing) return res.json(existing);
  }
  try {
    const session = sessions.create({
      cwd,
      resumeId,
      name,
      kind: kind === 'shell' ? 'shell' : 'claude',
      model: (typeof model === 'string' && /^[a-z0-9.-]{2,50}$/i.test(model)) ? model : null,
    });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Restart the server itself, transparently: a dashboard-owned PowerShell
// session runs restart-server.ps1 (which detaches the actual kill/start, so
// it survives this process dying). The client opens the pane to watch.
app.post('/api/server/restart', (req, res) => {
  try {
    const session = sessions.create({ cwd: __dirname, kind: 'shell', name: 'Server restart' });
    const script = path.join(__dirname, 'restart-server.ps1');
    // Give the PowerShell prompt a moment; ConPTY buffers early keystrokes anyway.
    setTimeout(() => {
      sessions.input(session.id, `& '${script}'`);
      setTimeout(() => sessions.input(session.id, '\r'), 300);
    }, 2000);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/sessions/:id/kill', (req, res) => {
  sessions.kill(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  res.json({ ok: sessions.remove(req.params.id) });
});

// ------------------------------------------------------------- websocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  let ok = false;
  try { ok = await auth.authorize(req); } catch { ok = false; }
  if (!ok) { socket.destroy(); return; }
  const m = req.url.match(/^\/ws\/([a-z0-9-]+)/i);
  if (!m) { socket.destroy(); return; }
  const id = m[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!sessions.attach(id, ws)) { ws.close(4004, 'no such session'); return; }
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'i') sessions.input(id, msg.d);
      else if (msg.t === 'r') sessions.resize(id, msg.c, msg.r);
      else if (msg.t === 'k') sessions.kill(id);
    });
  });
});

// ----------------------------------------------------------------- start ----
function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('  Claude Dashboard is running');
  console.log(`  Model lock: ${config.model}   Claude: ${config.claudePath}`);
  console.log(`  Auth: ${auth.clerkEnabled ? `Clerk${auth.allowedEmails.length ? ` (allowlist: ${auth.allowedEmails.join(', ')})` : ' (any signed-in user!)'}${auth.allowTokenAuth ? ' + token fallback' : ''}` : 'shared token'}`);
  if (frontendOrigins.length) console.log(`  CORS allowed origins: ${frontendOrigins.join(', ')}`);
  console.log('');
  console.log('  Open on this PC:');
  console.log(`    http://localhost:${config.port}/${auth.clerkEnabled ? '' : `?token=${config.token}`}`);
  console.log('');
  console.log('  Open on your phone / Chromebook (same network or tailnet):');
  for (const addr of lanAddresses()) {
    console.log(`    http://${addr}:${config.port}/${auth.clerkEnabled ? '' : `?token=${config.token}`}`);
  }
  console.log('');
});
