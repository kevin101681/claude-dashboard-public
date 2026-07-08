// Live session manager: this is the "tmux" of the dashboard. Each session is a
// persistent ConPTY running claude.exe that survives client disconnects. A ring
// buffer of recent output is replayed to any client that (re)attaches.

const pty = require('@lydell/node-pty');
const crypto = require('crypto');
const path = require('path');
const { findTranscriptFor } = require('./discovery');

const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // per-session scrollback replay

// Markers we read out of the raw PTY stream to tell what Claude is doing right
// now. None of this reaches the transcript, so the chat view is otherwise blind
// to "still working" and "waiting for you to approve something".
// Claude Code's working status line animates a spinner glyph (the dingbat
// "flower" set ✢–✽, plus dim ·/* frames) before a "Verbing…" word and an
// "(esc to interrupt)" hint. ConPTY repaints the animated glyph on every frame
// but writes the static hint text only once, so keying off "esc to interrupt"
// alone goes stale within a couple seconds even while work continues. We match
// the glyph instead — against ANSI-stripped output, since ConPTY interleaves
// cursor-move escapes through the line.
const SPINNER_RE = /esc to interrupt|[✢-✽]|[·*]\s?[A-Z][a-z]+…/i;
const SPINNER_FRESH_MS = 4000; // spinner frame seen this recently => working
// Awaiting-input gate: the named permission prompts, plus any active selection
// menu — the ❯ pointer sits on a numbered option (covers AskUserQuestion menus
// with arbitrary labels, not just Yes/Allow). parseApprovalPrompt still
// validates that >=2 options are actually present.
const APPROVAL_RE = /(Do you want to proceed|Do you want to make this edit|Would you like to proceed|Do you trust the files|❯\s*\d+\.\s+\S)/i;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB0]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[=>]/g;

class SessionManager {
  constructor(config) {
    this.config = config;
    this.live = new Map(); // id -> session record
  }

  create({ cwd, resumeId = null, name = null, kind = 'claude', model = null }) {
    const id = crypto.randomUUID().slice(0, 8);
    const shell = kind === 'shell';
    const args = shell ? ['-NoLogo'] : (resumeId ? ['--resume', resumeId] : []);
    if (!shell && this.config.permissionMode) {
      // Auto mode: sessions accept edits without prompting (config `permissionMode`).
      args.push('--permission-mode', this.config.permissionMode);
    }
    const env = { ...process.env };
    // Model lock with per-session override from the new-session dialog.
    if (!shell && (model || this.config.model)) env.ANTHROPIC_MODEL = model || this.config.model;
    const exe = shell ? (this.config.shellPath || 'powershell.exe') : this.config.claudePath;

    const proc = pty.spawn(exe, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env,
    });

    const session = {
      id,
      kind,
      pid: proc.pid,
      name: name || (shell ? `PowerShell — ${path.basename(cwd)}` : path.basename(cwd)),
      cwd,
      resumeId,
      claudeSessionId: resumeId, // for fresh sessions, resolved lazily from transcript dir
      startedAt: Date.now(),
      lastActivity: Date.now(),
      lastSpinnerAt: 0, // last time Claude's "esc to interrupt" frame was seen
      exited: false,
      exitCode: null,
      proc,
      chunks: [],
      bufferBytes: 0,
      clients: new Set(), // attached WebSockets
    };

    proc.onData((data) => {
      session.lastActivity = Date.now();
      // Claude Code redraws a working spinner (~10x/sec); seeing one of its
      // animated frames means work is actively in flight. Strip ANSI first so
      // ConPTY's interleaved cursor moves don't break the match.
      if (SPINNER_RE.test(data.replace(ANSI_RE, ''))) session.lastSpinnerAt = Date.now();
      session.chunks.push(data);
      session.bufferBytes += Buffer.byteLength(data);
      while (session.bufferBytes > MAX_BUFFER_BYTES && session.chunks.length > 1) {
        session.bufferBytes -= Buffer.byteLength(session.chunks.shift());
      }
      this._broadcast(session, { t: 'o', d: data });
    });

    proc.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      this._broadcast(session, { t: 'exit', code: exitCode });
    });

    this.live.set(id, session);
    return this.describe(session);
  }

  get(id) {
    return this.live.get(id) || null;
  }

  attach(id, ws) {
    const session = this.live.get(id);
    if (!session) return false;
    session.clients.add(ws);
    // Replay scrollback so a reattaching device sees where things stand.
    if (session.chunks.length) {
      ws.send(JSON.stringify({ t: 'o', d: session.chunks.join('') }));
    }
    if (session.exited) {
      ws.send(JSON.stringify({ t: 'exit', code: session.exitCode }));
    }
    ws.on('close', () => session.clients.delete(ws));
    return true;
  }

  input(id, data) {
    const session = this.live.get(id);
    if (session && !session.exited) session.proc.write(data);
  }

  resize(id, cols, rows) {
    const session = this.live.get(id);
    if (session && !session.exited && cols > 0 && rows > 0) {
      try { session.proc.resize(cols, rows); } catch { /* race with exit */ }
    }
  }

  kill(id) {
    const session = this.live.get(id);
    if (session && !session.exited) {
      try { session.proc.kill(); } catch { /* already gone */ }
    }
  }

  remove(id) {
    const session = this.live.get(id);
    if (!session) return false;
    if (!session.exited) {
      try { session.proc.kill(); } catch { /* already gone */ }
    }
    for (const ws of session.clients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.live.delete(id);
    return true;
  }

  describe(session) {
    // Lazily resolve which Claude transcript this PTY produced, so the session
    // can be resumed even after a server restart. (Shell sessions have none.)
    if (!session.claudeSessionId && !session.exited && session.kind !== 'shell') {
      session.claudeSessionId = findTranscriptFor(session.cwd, session.startedAt);
    }
    return {
      id: session.id,
      kind: session.kind || 'claude',
      pid: session.pid,
      name: session.name,
      cwd: session.cwd,
      claudeSessionId: session.claudeSessionId,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      exited: session.exited,
      exitCode: session.exitCode,
      attachedClients: session.clients.size,
      status: this.computeStatus(session),
    };
  }

  // Best-effort read of what Claude is doing *right now*, derived from the raw
  // PTY stream (the transcript never carries the spinner or permission prompts):
  //   'working'         -> spinner frame seen within the last few seconds
  //   'awaiting_input'  -> a permission/trust prompt is the latest thing on screen
  //   'idle'            -> at the prompt, waiting for the user
  computeStatus(session) {
    if (session.exited) return 'exited';
    // Shell PTYs have no Claude spinner/permission semantics; anything the
    // spinner regex happens to match in shell output would be a false positive.
    if (session.kind === 'shell') return 'idle';
    if (Date.now() - session.lastSpinnerAt < SPINNER_FRESH_MS) return 'working';
    // The permission box is drawn once and stays until answered, so it lives in
    // the tail of the stream. Scanning only the tail avoids matching old prompts
    // that scrolled away — once answered, later frames push them out of range.
    if (APPROVAL_RE.test(this._tailText(session, 4000))) return 'awaiting_input';
    return 'idle';
  }

  _tailText(session, n) {
    let s = '';
    for (let i = session.chunks.length - 1; i >= 0 && s.length < n * 3; i--) {
      s = session.chunks[i] + s;
    }
    return s.replace(ANSI_RE, '').slice(-n);
  }

  // Like _tailText, but reconstructs *spacing* so word boundaries survive.
  // ConPTY positions text with cursor-move escapes rather than literal spaces
  // (e.g. "Yes,\e[1CI\e[1Ctrust" for "Yes, I trust"), so a plain ANSI strip
  // jams words together. We turn cursor-forward into spaces and line-positioning
  // into newlines before stripping the rest — enough to parse a menu, not a full
  // terminal emulator.
  _renderTail(session, n) {
    let raw = '';
    for (let i = session.chunks.length - 1; i >= 0 && raw.length < n * 4; i--) {
      raw = session.chunks[i] + raw;
    }
    return raw
      .replace(/\x1b\[(\d{1,3})C/g, (_, c) => ' '.repeat(Math.min(+c, 200))) // cursor forward -> spaces
      .replace(/\x1b\[(?:\d{1,3})?(?:;\d{1,3})?[Hf]/g, '\n')                 // cursor position -> newline
      .replace(/\x1b\[\d{0,3}[ABEF]/g, '\n')                                 // vertical cursor moves -> newline
      .replace(ANSI_RE, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .slice(-n);
  }

  // Parse the numbered option menu of a permission/trust prompt from the tail,
  // so the chat view can offer the choices as buttons instead of only pointing
  // the user to the Console. Returns { question, options:[{n,label}] } or null
  // when nothing parseable is on screen (the caller falls back to a plain
  // "open Console" affordance). Options are selected by sending the bare digit.
  parseApprovalPrompt(session) {
    const text = this._renderTail(session, 4000);
    const lines = text.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
    // Take the last coherent 1., 2., (3.)… run — the current menu, not a stale
    // one still lingering earlier in the buffer.
    let group = [];
    for (const line of lines) {
      const m = line.match(/^❯?\s*(\d+)\.\s+(\S.*)$/);
      if (!m) continue;
      const num = +m[1];
      if (num === 1) group = [];               // a fresh menu begins
      if (num === group.length + 1) group.push({ n: num, label: this._cleanOptionLabel(m[2]) });
    }
    if (group.length < 2) return null;
    // Question: the shortest recent line ending in '?' (skips the trust prompt's
    // long blurb, which the client renders as a generic heading instead).
    const qs = lines.filter(l => /\?$/.test(l) && l.length <= 90);
    const question = qs.length ? qs[qs.length - 1] : null;
    return { question, options: group };
  }

  _cleanOptionLabel(s) {
    return s.replace(/\s+/g, ' ').trim().slice(0, 72);
  }

  list() {
    // Order by creation time so cards don't reshuffle as sessions produce
    // output (lastActivity changes constantly and made them jump around).
    return [...this.live.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(s => this.describe(s));
  }

  _broadcast(session, msg) {
    const payload = JSON.stringify(msg);
    for (const ws of session.clients) {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch { /* client vanished */ }
      }
    }
  }
}

module.exports = { SessionManager };
