// Incremental transcript reader for the chat-style session view. Claude Code
// appends every conversation event to the session's .jsonl as it happens, so
// tailing that file gives a clean message stream without parsing ANSI output.

const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR } = require('./discovery');

const INITIAL_TAIL_BYTES = 8 * 1024 * 1024; // on first open, load most sessions in full

function transcriptPath(cwd, sessionId) {
  const munged = cwd.replace(/[\\/:._ ]/g, '-');
  return path.join(PROJECTS_DIR, munged, sessionId + '.jsonl');
}

function userText(message) {
  const content = message.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
  }
  if (!text) return null;
  const t = text.trim();
  // Harness noise: system reminders, command wrappers, caveats, interrupts.
  if (!t || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return null;
  return t;
}

// Interactive tools carry the content the user most wants to see (the plan,
// the question + choices). Render them as a full message instead of a tiny
// truncated tool row. Returns markdown text, or null for ordinary tools.
function renderSpecialTool(block) {
  const input = block.input || {};
  if (block.name === 'ExitPlanMode' && typeof input.plan === 'string' && input.plan.trim()) {
    return input.plan.trim();
  }
  if (block.name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    return input.questions.map((q) => {
      const opts = (q.options || []).map((o, i) => `${i + 1}. ${o.label}`).join('\n');
      const head = q.question || (q.header ? q.header : 'Question');
      return `**${head}**\n${opts}${q.multiSelect ? '\n_(select all that apply)_' : ''}`;
    }).join('\n\n');
  }
  return null;
}

function summarizeToolUse(block) {
  const input = block.input || {};
  let detail = input.command || input.file_path || input.pattern || input.path ||
    input.url || input.description || input.prompt || '';
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  detail = detail.replace(/\s+/g, ' ').trim();
  if (detail.length > 110) detail = detail.slice(0, 109) + '…';
  // Untruncated file path (Write/Edit/Artifact/Read…) so the chat view can
  // open the file in its viewer — `detail` above may be cut off for display.
  const file = typeof input.file_path === 'string' ? input.file_path
    : (typeof input.path === 'string' ? input.path : null);
  return { role: 'tool', name: block.name, detail, file };
}

// Read messages appended after `offset` bytes. Returns { offset, messages }.
// Only whole lines are consumed; a partially-written trailing line stays
// unconsumed until the next poll.
function readNewMessages(cwd, sessionId, offset = 0) {
  const fp = transcriptPath(cwd, sessionId);
  let stat;
  try { stat = fs.statSync(fp); } catch { return { offset, messages: [] }; }

  let skipFirstLine = false;
  if (offset === 0 && stat.size > INITIAL_TAIL_BYTES) {
    offset = stat.size - INITIAL_TAIL_BYTES;
    skipFirstLine = true; // we landed mid-line
  }
  if (stat.size <= offset) return { offset, messages: [] };

  const fd = fs.openSync(fp, 'r');
  let chunk;
  try {
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, offset);
    chunk = buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }

  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline === -1) return { offset, messages: [] };
  const consumed = lastNewline + 1;
  let text = chunk.subarray(0, consumed).toString('utf8');
  if (skipFirstLine) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  }

  const messages = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj.isSidechain) continue;
    if (obj.type === 'user' && obj.message) {
      const t = userText(obj.message);
      if (t) messages.push({ role: 'user', text: t, ts: obj.timestamp });
    } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          messages.push({ role: 'assistant', text: block.text, ts: obj.timestamp });
        } else if (block.type === 'tool_use') {
          const special = renderSpecialTool(block);
          if (special) messages.push({ role: 'assistant', text: special, ts: obj.timestamp });
          else messages.push({ ...summarizeToolUse(block), ts: obj.timestamp });
        }
      }
    }
  }
  return { offset: offset + consumed, messages };
}

module.exports = { readNewMessages, transcriptPath };
