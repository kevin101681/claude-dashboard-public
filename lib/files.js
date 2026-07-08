// File explorer / editor backend. All paths are confined to a root directory
// (default: the user's home) — anything outside is rejected.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_EDIT_BYTES = 2 * 1024 * 1024;   // refuse to open bigger text files
const MAX_RAW_BYTES = 25 * 1024 * 1024;   // image preview cap

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};

class Files {
  constructor(config) {
    this.root = config.fsRoot || os.homedir();
  }

  // Resolve a path and ensure it stays inside the root (case-insensitive,
  // since this is Windows).
  resolve(p) {
    if (!p || typeof p !== 'string') throw new Error('path required');
    const abs = path.resolve(p);
    const rel = path.relative(this.root.toLowerCase(), abs.toLowerCase());
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path is outside the allowed root (${this.root})`);
    }
    return abs;
  }

  list(p) {
    const abs = this.resolve(p || this.root);
    const entries = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      let stat = null;
      try { stat = fs.statSync(path.join(abs, e.name)); } catch { continue; }
      entries.push({
        name: e.name,
        dir: e.isDirectory(),
        size: e.isDirectory() ? null : stat.size,
        mtime: stat.mtimeMs,
        image: !e.isDirectory() && !!IMAGE_MIME[path.extname(e.name).toLowerCase()],
      });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    const parentAbs = path.dirname(abs);
    let parent = null;
    try { parent = this.resolve(parentAbs) === abs ? null : parentAbs; } catch { parent = null; }
    return { path: abs, parent, root: this.root, entries };
  }

  read(p) {
    const abs = this.resolve(p);
    const stat = fs.statSync(abs);
    if (stat.size > MAX_EDIT_BYTES) {
      throw new Error(`file too large to edit (${Math.round(stat.size / 1024)} KB, limit ${MAX_EDIT_BYTES / 1024} KB)`);
    }
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) throw new Error('binary file — not editable as text');
    return { path: abs, content: buf.toString('utf8') };
  }

  write(p, content) {
    const abs = this.resolve(p);
    if (typeof content !== 'string') throw new Error('content must be a string');
    fs.writeFileSync(abs, content, 'utf8');
    return { path: abs, size: Buffer.byteLength(content) };
  }

  raw(p) {
    const abs = this.resolve(p);
    const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
    if (!mime) throw new Error('raw preview is only supported for images');
    const stat = fs.statSync(abs);
    if (stat.size > MAX_RAW_BYTES) throw new Error('image too large to preview');
    return { buffer: fs.readFileSync(abs), mime };
  }
}

module.exports = { Files };
