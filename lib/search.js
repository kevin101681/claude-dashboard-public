// Full-text search across every session transcript. Files can be huge, so
// each one is streamed line-by-line with a cheap substring pre-filter before
// any JSON parsing. Only human-visible text (user prompts + assistant
// replies) is matched — tool payloads and harness noise would drown results.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PROJECTS_DIR, parseSessionFile } = require('./discovery');

const MAX_SESSIONS = 30;        // sessions with matches to return
const MAX_SNIPPETS = 3;         // snippets kept per session
const MAX_MATCHES_PER_FILE = 25; // stop scanning a file beyond this
const TIME_BUDGET_MS = 12000;   // whole-search ceiling
const MIN_FILE_BYTES = 512;

function candidateFiles() {
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(PROJECTS_DIR, d.name));
  } catch {
    return [];
  }
  const out = [];
  for (const dir of projectDirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const fp = path.join(dir, e.name);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      if (stat.size >= MIN_FILE_BYTES) out.push({ fp, stat });
    }
  }
  return out.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); // newest first
}

// Human-visible text blocks of one transcript line.
function extractTexts(obj) {
  if (obj.isSidechain) return [];
  const blocks = [];
  if (obj.type === 'user' && obj.message) {
    const c = obj.message.content;
    if (typeof c === 'string') blocks.push({ role: 'user', text: c });
    else if (Array.isArray(c)) {
      for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') blocks.push({ role: 'user', text: b.text });
    }
  } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const b of obj.message.content) {
      if (b && b.type === 'text' && typeof b.text === 'string') blocks.push({ role: 'assistant', text: b.text });
    }
  }
  // Harness noise (system reminders, caveats, interrupts) isn't conversation.
  return blocks.filter(({ text }) => {
    const t = text.trim();
    return t && !t.startsWith('<') && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted');
  });
}

function snippetAround(text, idx, qlen) {
  const start = Math.max(0, idx - 55);
  const end = Math.min(text.length, idx + qlen + 95);
  return (start > 0 ? '…' : '') +
    text.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < text.length ? '…' : '');
}

async function searchFile(fp, query) {
  const lower = query.toLowerCase();
  let matches = 0;
  const snippets = [];
  const stream = fs.createReadStream(fp, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (matches >= MAX_MATCHES_PER_FILE) break;
      if (!line.toLowerCase().includes(lower)) continue; // pre-filter, no parse
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      for (const { role, text } of extractTexts(obj)) {
        const idx = text.toLowerCase().indexOf(lower);
        if (idx === -1) continue;
        matches++;
        if (snippets.length < MAX_SNIPPETS) snippets.push({ role, text: snippetAround(text, idx, query.length) });
        if (matches >= MAX_MATCHES_PER_FILE) break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return matches ? { matches, snippets } : null;
}

async function searchSessions(query) {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const results = [];
  let truncated = false;
  for (const { fp, stat } of candidateFiles()) {
    if (results.length >= MAX_SESSIONS || Date.now() > deadline) { truncated = true; break; }
    let hit;
    try { hit = await searchFile(fp, query); } catch { continue; }
    if (!hit) continue;
    const meta = parseSessionFile(fp, stat);
    if (!meta) continue;
    results.push({
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      title: meta.summary || meta.title,
      lastTimestamp: meta.lastTimestamp,
      matches: hit.matches,
      snippets: hit.snippets,
    });
  }
  return { results, truncated };
}

module.exports = { searchSessions };
