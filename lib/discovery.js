// Read layer: scans ~/.claude/projects/**/*.jsonl and extracts session metadata
// without ever loading whole transcript files (they can be hundreds of MB).
// Strategy: read a chunk from the head (title, cwd) and a chunk from the tail
// (last activity, git branch, model, context token usage).

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 128 * 1024;

function readChunk(fd, position, length) {
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, position);
  return buf.toString('utf8', 0, bytesRead);
}

function parseLines(text, { dropFirstPartial = false } = {}) {
  let lines = text.split('\n');
  if (dropFirstPartial) lines = lines.slice(1); // first line of a tail chunk is usually cut off
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* partial line at chunk edge */ }
  }
  return out;
}

function textOfMessage(msg) {
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
    }
  }
  return null;
}

function isRealUserText(text) {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  // Skip harness noise: system reminders, command invocations, caveats, hook output
  if (t.startsWith('<')) return false;
  if (t.startsWith('Caveat:')) return false;
  if (t.startsWith('[Request interrupted')) return false;
  return true;
}

function cleanTitle(text, max = 90) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

// Parse a single session .jsonl file into a metadata record.
function parseSessionFile(filePath, stat) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = stat.size;
    const headText = readChunk(fd, 0, Math.min(HEAD_BYTES, size));
    const head = parseLines(headText);

    let tail = head;
    if (size > HEAD_BYTES) {
      const tailStart = Math.max(0, size - TAIL_BYTES);
      const tailText = readChunk(fd, tailStart, Math.min(TAIL_BYTES, size));
      tail = parseLines(tailText, { dropFirstPartial: true });
    }

    const meta = {
      sessionId: path.basename(filePath, '.jsonl'),
      file: filePath,
      sizeBytes: size,
      title: null,
      summary: null,
      cwd: null,
      gitBranch: null,
      model: null,
      version: null,
      firstTimestamp: null,
      lastTimestamp: null,
      contextTokens: null, // approx current context size from last assistant usage
      messageCount: null,
    };

    // Head pass: title (summary line or first real user message), cwd, first timestamp
    for (const line of head) {
      if (!meta.summary && line.type === 'summary' && typeof line.summary === 'string') {
        meta.summary = line.summary;
      }
      if (!meta.firstTimestamp && line.timestamp) meta.firstTimestamp = line.timestamp;
      if (!meta.cwd && line.cwd) meta.cwd = line.cwd;
      if (!meta.title && line.type === 'user' && !line.isSidechain) {
        const text = textOfMessage(line.message);
        if (isRealUserText(text)) meta.title = cleanTitle(text);
      }
      if (meta.title && meta.cwd && meta.firstTimestamp && meta.summary) break;
    }

    // Tail pass (reverse): last activity, branch, model, context usage
    for (let i = tail.length - 1; i >= 0; i--) {
      const line = tail[i];
      if (!meta.lastTimestamp && line.timestamp) meta.lastTimestamp = line.timestamp;
      if (!meta.gitBranch && line.gitBranch) meta.gitBranch = line.gitBranch;
      if (!meta.cwd && line.cwd) meta.cwd = line.cwd;
      if (!meta.version && line.version) meta.version = line.version;
      if (!meta.summary && line.type === 'summary' && typeof line.summary === 'string') {
        meta.summary = line.summary;
      }
      if (!meta.model && line.type === 'assistant' && line.message) {
        if (line.message.model) meta.model = line.message.model;
        const u = line.message.usage;
        if (u && meta.contextTokens === null) {
          meta.contextTokens =
            (u.input_tokens || 0) +
            (u.cache_read_input_tokens || 0) +
            (u.cache_creation_input_tokens || 0);
        }
      }
      if (meta.lastTimestamp && meta.gitBranch && meta.model && meta.contextTokens !== null) break;
    }

    if (!meta.title) meta.title = meta.summary || '(no user message yet)';
    if (!meta.lastTimestamp) meta.lastTimestamp = stat.mtime.toISOString();
    return meta;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// List recent sessions across all projects, newest first.
function listRecentSessions({ limit = 40, minSizeBytes = 512 } = {}) {
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(PROJECTS_DIR, d.name));
  } catch {
    return [];
  }

  // Gather candidate files with mtimes first, parse only the newest `limit`.
  const candidates = [];
  for (const dir of projectDirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const fp = path.join(dir, e.name);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      if (stat.size < minSizeBytes) continue; // skip empty/aborted sessions
      candidates.push({ fp, stat });
    }
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const sessions = [];
  for (const { fp, stat } of candidates.slice(0, limit)) {
    const meta = parseSessionFile(fp, stat);
    if (meta) sessions.push(meta);
  }
  return sessions;
}

// Distinct project working directories seen in recent sessions.
function listProjects(sessions) {
  const seen = new Map();
  for (const s of sessions) {
    if (s.cwd && !seen.has(s.cwd)) {
      seen.set(s.cwd, { cwd: s.cwd, name: path.basename(s.cwd), lastUsed: s.lastTimestamp });
    }
  }
  return [...seen.values()];
}

// Find the transcript created by a live PTY session: newest .jsonl in the
// project dir whose mtime is after the PTY start time.
function findTranscriptFor(cwd, startedAtMs) {
  if (!cwd) return null;
  const munged = cwd.replace(/[\\/:._ ]/g, '-');
  const dir = path.join(PROJECTS_DIR, munged);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const fp = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    if (stat.birthtimeMs >= startedAtMs - 5000 && (!best || stat.birthtimeMs > best.birthtimeMs)) {
      best = { sessionId: path.basename(name, '.jsonl'), birthtimeMs: stat.birthtimeMs };
    }
  }
  return best ? best.sessionId : null;
}

module.exports = { listRecentSessions, listProjects, findTranscriptFor, parseSessionFile, PROJECTS_DIR };
