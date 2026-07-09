/* Claude Dashboard frontend: collapsible session sidebar + one or two session
   panes (desktop split view). Runs same-origin from the PC server, or from
   Netlify with window.ENV providing BACKEND_URL and CLERK_PUBLISHABLE_KEY. */

const $ = (sel) => document.querySelector(sel);

const ENV = window.ENV || {};
// '' = same origin (served by the PC server); otherwise e.g. https://pc.tail1234.ts.net
const API_BASE = (ENV.BACKEND_URL || '').replace(/\/$/, '');

function wsBase() {
  if (API_BASE) return API_BASE.replace(/^http/, 'ws');
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

const state = {
  data: null,
  pollTimer: null,
  usageTimer: null,
  panes: [],          // open Pane instances (desktop: up to 2, mobile: 1)
  focused: null,      // last-touched pane
  newKind: 'claude',  // what the new-session dialog will launch
  explorerPath: null,
  editorPath: null,
  projectFilter: '',  // '' = all projects; otherwise a cwd to filter the lists by
  _projectFilterSig: undefined,
};

// ------------------------------------------------------------------ icons ----
// One minimalist stroke set for the whole UI (folders, files, attach, key bar).
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  folder: `<svg ${ICON_ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  file: `<svg ${ICON_ATTRS}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`,
  image: `<svg ${ICON_ATTRS}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M3 17l6-5 4 3 5-4 3 3"/></svg>`,
  clip: `<svg ${ICON_ATTRS}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
  terminal: `<svg ${ICON_ATTRS}><path d="M4 17l6-5-6-5"/><path d="M12 19h8"/></svg>`,
  columns: `<svg ${ICON_ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>`,
  chevronUp: `<svg ${ICON_ATTRS}><path d="M6 15l6-6 6 6"/></svg>`,
  chevronDown: `<svg ${ICON_ATTRS}><path d="M6 9l6 6 6-6"/></svg>`,
  chevronLeft: `<svg ${ICON_ATTRS}><path d="M15 6l-6 6 6 6"/></svg>`,
  chevronRight: `<svg ${ICON_ATTRS}><path d="M9 6l6 6-6 6"/></svg>`,
  enter: `<svg ${ICON_ATTRS}><path d="M20 5v6a4 4 0 0 1-4 4H5"/><path d="M9 10l-5 5 5 5"/></svg>`,
  mic: `<svg ${ICON_ATTRS}><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v4"/></svg>`,
  refresh: `<svg ${ICON_ATTRS}><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 5v6h-6"/></svg>`,
  plus: `<svg ${ICON_ATTRS}><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  search: `<svg ${ICON_ATTRS}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
  logout: `<svg ${ICON_ATTRS}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>`,
  back: `<svg ${ICON_ATTRS}><path d="M15 6l-6 6 6 6"/></svg>`,
  sun: `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg ${ICON_ATTRS}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
};

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;

// ------------------------------------------------------------------ theme ----
// Light/dark palette lives in CSS custom properties keyed off data-theme; the
// xterm canvas has its own theme object, switched to match.
const XTERM_THEMES = {
  light: {
    background: '#ffffff', foreground: '#3d4b55', cursor: '#4a7585', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(95,141,161,0.30)',
    black: '#3d4b55', red: '#c62828', green: '#1e7e34', yellow: '#a05a00', blue: '#3a6ea5',
    magenta: '#8e44ad', cyan: '#0e7490', white: '#9aa2a8',
    brightBlack: '#69747c', brightRed: '#c62828', brightGreen: '#1e7e34', brightYellow: '#a05a00',
    brightBlue: '#3a6ea5', brightMagenta: '#8e44ad', brightCyan: '#0e7490', brightWhite: '#3d4b55',
  },
  dark: {
    background: '#10171b', foreground: '#e6edf3', cursor: '#5f8da1', cursorAccent: '#10171b',
    selectionBackground: 'rgba(95,141,161,0.40)',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff',
    magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
    brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  },
};
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
function xtermTheme() {
  return XTERM_THEMES[currentTheme()];
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0f1519' : '#fdfcff';
  const icon = theme === 'dark' ? ICONS.sun : ICONS.moon;
  const tb = $('#themeBtn'), ft = $('#fabTheme');
  if (tb) tb.innerHTML = icon;
  if (ft) ft.innerHTML = icon;
  // Repaint every open terminal.
  for (const p of state.panes) {
    if (p.term) { try { p.term.options.theme = xtermTheme(); } catch {} }
  }
}
function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// ------------------------------------------------------------- utilities ----
function timeAgo(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// Chat-bubble timestamp: time only for today, else a short date + time.
function fmtChatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

function fmtTokens(n) {
  if (n == null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
  return String(n);
}

function shortModel(model) {
  if (!model) return null;
  const m = model.match(/claude-([a-z]+)-?([\d-]*)/i);
  return m ? m[1] : model;
}

async function authToken() {
  // Clerk session tokens are short-lived; getToken() returns a cached-or-fresh one.
  if (window.Clerk && window.Clerk.session) {
    try { return await window.Clerk.session.getToken(); } catch { return null; }
  }
  return null;
}

const VIEWS = ['authView', 'workspace'];
function showView(id) {
  for (const v of VIEWS) $('#' + v).classList.toggle('hidden', v !== id);
}

// Files browser lives inside the workspace: it swaps in for the pane area so
// the session sidebar (desktop) and footer bar (mobile) stay put.
function showFiles(show) {
  state.filesOpen = show;
  $('#filesView').classList.toggle('hidden', !show);
  $('#paneArea').classList.toggle('hidden', show);
  if (!show) {
    $('#filesView').classList.remove('file-open');
    state.panes.forEach(p => p.fit());
  }
  updateFabBar();
}

async function api(path, opts) {
  const headers = { 'Content-Type': 'application/json' };
  const token = await authToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { ...opts, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// Authenticated fetch that returns the raw Response (for image blobs).
async function apiRaw(path) {
  const headers = {};
  const token = await authToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { headers });
  if (!res.ok) throw new Error(res.statusText);
  return res;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;

// Turn escaped text into clickable things: markdown links and bare URLs open
// in a new tab; Windows paths become .file-link spans that the pane's chat
// log routes into the built-in viewer/editor.
function linkify(s) {
  return s
    // [label](https://…) and [label](C:\…)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]\n]+)\]\(([A-Za-z]:\\[^)\n]+)\)/g,
      '<span class="file-link" data-path="$2">$1</span>')
    // a backticked path is the whole path, spaces included ("C:\Users\you\
    // Claude Dashboard\…" would otherwise truncate at the space)
    .replace(/<code>([A-Za-z]:\\[^<]+?)[.,;:]?<\/code>/g,
      '<code><span class="file-link" data-path="$1">$1</span></code>')
    // bare URLs (the "= or quote before it" guard skips hrefs we just made)
    .replace(/(^|[^"=\w])(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:])/g,
      '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    // bare Windows paths (space-free by necessity — backtick paths with spaces)
    .replace(/(^|[\s(])([A-Za-z]:\\[^\s<>"'`)\]]+[^\s<>"'`)\].,;:])/g,
      '$1<span class="file-link" data-path="$2">$2</span>');
}

// Minimal markdown: code fences, inline code, bold, headings, clickable
// links/paths. Everything is HTML-escaped first, so transcript content can't
// inject markup.
function renderMarkdown(text) {
  const parts = text.split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      html += `<pre>${escapeHtml(parts[i].replace(/^[\w-]*\n/, ''))}</pre>`;
    } else {
      html += linkify(escapeHtml(parts[i])
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,4} (.+)$/gm, '<strong>$1</strong>'))
        .replace(/\n/g, '<br>');
    }
  }
  return html;
}

// Turn a card title into an inline text field. Enter/blur saves, Esc cancels.
function inlineRename(titleEl, current, save) {
  if (!titleEl || titleEl.parentNode.querySelector('.inline-rename')) return;
  const input = document.createElement('input');
  input.className = 'inline-rename';
  input.value = current;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    input.replaceWith(titleEl);
    if (commit && val && val !== current) {
      try { await save(val); } catch (err) { alert('Rename failed: ' + err.message); }
      refresh();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}

// ---------------------------------------------------------- server health ----
// Tracks whether the dashboard server is reachable. Driven by the list poll
// (every 5s) and by explicit checks. Turns the restart buttons red when down
// and flashes a green "back up" banner once it recovers after a restart.
const health = { reachable: true, startedAt: null, upTimer: null };

// Hit the cheap liveness probe. Resolves to the health payload, or throws.
async function pingHealth() {
  return api('/api/health');
}

function setServerReachable(ok, info) {
  const restartBtns = [$('#restartBtn'), $('#fabRestart')].filter(Boolean);
  restartBtns.forEach(b => b.classList.toggle('server-down', !ok));

  if (ok) {
    // A changed startedAt (or a down→up transition) means the server rebooted.
    const restarted = health.startedAt && info && info.startedAt
      && info.startedAt !== health.startedAt;
    if ((!health.reachable || restarted) && health.startedAt !== null) {
      flashServerUp();
    }
    if (info && info.startedAt) health.startedAt = info.startedAt;
  }
  health.reachable = ok;
}

// Green confirmation banner that the server is up and ready, auto-hiding.
function flashServerUp() {
  const banner = $('#connBanner');
  clearTimeout(health.upTimer);
  banner.textContent = 'Dashboard server is back up and ready ✓';
  banner.classList.remove('hidden');
  banner.classList.add('up');
  health.upTimer = setTimeout(() => {
    banner.classList.add('hidden');
    banner.classList.remove('up');
  }, 4000);
}

// -------------------------------------------------------------- side list ----
async function refresh() {
  let data;
  try {
    data = await api('/api/state');
  } catch (err) {
    console.error('state fetch failed', err);
    setServerReachable(false);
    const banner = $('#connBanner');
    banner.classList.remove('up');
    banner.textContent = API_BASE
      ? `Can't reach your PC at ${API_BASE} — if you're on a phone or away from home, make sure the Tailscale app is installed and connected on this device.`
      : `Can't reach the dashboard server: ${err.message}`;
    banner.classList.remove('hidden');
    return;
  }
  state.data = data;
  // Hide any error banner now; setServerReachable may re-show it in green if
  // it detects the server just came back from a restart (startedAt changed).
  if (!$('#connBanner').classList.contains('up')) $('#connBanner').classList.add('hidden');
  setServerReachable(true, { startedAt: data.startedAt });
  renderList();
}

// Populate the project filter dropdown from the current project list, keeping
// the selection stable and only rebuilding when the set of projects changes.
function renderProjectFilter() {
  const wrap = $('#projectFilterWrap');
  const sel = $('#projectFilter');
  const projects = (state.data && state.data.projects) || [];
  // Drop a selection whose project has aged out of the list.
  if (state.projectFilter && !projects.some(p => p.cwd === state.projectFilter)) {
    state.projectFilter = '';
  }
  // Hide unless there's a real choice, and never over search results.
  const searching = !$('#searchSection').classList.contains('hidden');
  wrap.classList.toggle('hidden', projects.length < 2 || searching);

  const sig = projects.map(p => p.cwd).join('|');
  if (sig === state._projectFilterSig) return; // no change; leave the (maybe open) dropdown alone
  state._projectFilterSig = sig;

  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All projects';
  sel.appendChild(all);
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.cwd;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = state.projectFilter;
  if (!sel._wired) {
    sel.onchange = () => { state.projectFilter = sel.value; renderList(); };
    sel._wired = true;
  }
  enhanceSelect(wrap.querySelector('.select-wrap'));
}

function renderList() {
  // Don't rebuild the list while a title is being edited inline — it would rip
  // the <input> out of the DOM mid-edit and dismiss the mobile keyboard. The
  // poll keeps state.data fresh; finish() re-renders once the edit is done.
  if (document.querySelector('.inline-rename')) return;
  const { live, recent } = state.data;
  renderProjectFilter();
  const pf = state.projectFilter;

  // Live sessions
  const liveList = $('#liveList');
  liveList.innerHTML = '';
  const liveShown = pf ? live.filter(s => s.cwd === pf) : live;
  $('#liveEmpty').classList.toggle('hidden', liveShown.length > 0);
  for (const s of liveShown) {
    const isShell = s.kind === 'shell';
    const isOpenNow = state.panes.some(p => p.sid === s.id);
    const card = document.createElement('div');
    card.className = 'card live-card' + (isOpenNow ? ' open-now' : '');
    const badge = s.exited ? `exited (${s.exitCode})` : (isShell ? 'shell' : 'live');
    card.innerHTML = `
      <div class="card-top">
        <div class="card-title"></div>
        <span class="badge ${s.exited ? 'exited' : (isShell ? 'shell' : 'live')}">${badge}</span>
      </div>
      <div class="card-meta">
        <span class="cwd"></span>
        <span class="dot">${timeAgo(s.lastActivity)}</span>
      </div>
      <div class="card-actions">
        <button class="btn small primary open-btn">${s.exited ? 'View output' : (isShell ? 'Open' : 'Resume')}</button>
        ${(isOpenNow || s.exited) ? '' : `<button class="btn small icon-btn split-btn desktop-only" title="Open beside current">${ICONS.columns}</button>`}
        <button class="btn small rename-btn">Rename</button>
        <button class="btn small remove-btn">${s.exited ? 'Remove' : 'Kill'}</button>
      </div>`;
    card.querySelector('.card-title').textContent = s.name;
    card.querySelector('.cwd').textContent = s.cwd ? s.cwd.split(/[\\/]/).pop() : '';
    card.querySelector('.open-btn').onclick = (e) => { e.stopPropagation(); openSession(s); };
    const splitBtn = card.querySelector('.split-btn');
    if (splitBtn) splitBtn.onclick = (e) => { e.stopPropagation(); openSession(s, { split: true }); };
    card.querySelector('.rename-btn').onclick = (e) => {
      e.stopPropagation();
      inlineRename(card.querySelector('.card-title'), s.name, (name) =>
        api(`/api/sessions/${s.id}/rename`, { method: 'POST', body: JSON.stringify({ name }) }));
    };
    card.querySelector('.remove-btn').onclick = async (e) => {
      e.stopPropagation();
      const openPane = state.panes.find(p => p.sid === s.id);
      if (openPane) closePane(openPane, { silent: true });
      // Kill + drop from the live list in one step -> Claude sessions reappear
      // under Recents immediately, no confirm needed.
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {});
      refresh();
    };
    card.onclick = () => openSession(s);
    liveList.appendChild(card);
  }

  // Recent transcripts
  const recentList = $('#recentList');
  recentList.innerHTML = '';
  for (const r of recent) {
    if (r.isLive) continue; // shown in the Live section; don't duplicate here
    if (pf && r.cwd !== pf) continue; // project filter active
    const card = document.createElement('div');
    card.className = 'card';
    const tokens = fmtTokens(r.contextTokens);
    const windowMax = state.data.contextWindow || 1000000;
    const pct = r.contextTokens ? Math.min(100, (r.contextTokens / windowMax) * 100) : 0;
    const gaugeClass = ''; // gauges stay blue regardless of level
    card.innerHTML = `
      <div class="card-top">
        <div class="card-title"></div>
        ${r.isLive ? '<span class="badge live">live</span>' : ''}
      </div>
      <div class="card-meta">
        <span class="proj"></span>
        ${r.gitBranch ? `<span class="dot branch"></span>` : ''}
        <span class="dot">${timeAgo(r.lastTimestamp)}</span>
        ${shortModel(r.model) ? `<span class="dot">${shortModel(r.model)}</span>` : ''}
        ${tokens ? `<span class="dot">${tokens} ctx</span>` : ''}
      </div>
      ${r.contextTokens ? `<div class="gauge"><div class="${gaugeClass}" style="width:${pct}%"></div></div>` : ''}
      ${r.isLive ? '' : `<div class="card-actions"><button class="btn small resume-btn">Resume</button><button class="btn small icon-btn split-recent-btn desktop-only" title="Resume beside current">${ICONS.columns}</button><button class="btn small rename-recent-btn">Rename</button><button class="btn small hide-btn">Hide</button></div>`}`;
    card.querySelector('.card-title').textContent = r.customTitle || r.summary || r.title;
    const renameRecentBtn = card.querySelector('.rename-recent-btn');
    if (renameRecentBtn) {
      renameRecentBtn.onclick = (e) => {
        e.stopPropagation();
        inlineRename(card.querySelector('.card-title'), r.customTitle || r.summary || r.title, (title) =>
          api(`/api/recent/${r.sessionId}/title`, { method: 'POST', body: JSON.stringify({ title }) }));
      };
    }
    card.querySelector('.proj').textContent = r.cwd ? r.cwd.split(/[\\/]/).pop() : '?';
    if (r.gitBranch) card.querySelector('.branch').textContent = r.gitBranch;
    const hideBtn = card.querySelector('.hide-btn');
    if (hideBtn) {
      hideBtn.onclick = async (e) => {
        e.stopPropagation();
        await api(`/api/recent/${r.sessionId}/hide`, { method: 'POST' });
        refresh();
      };
    }
    const resumeBtn = card.querySelector('.resume-btn');
    if (resumeBtn) {
      resumeBtn.onclick = (e) => { e.stopPropagation(); resumeRecent(r, resumeBtn); };
    }
    const splitRecentBtn = card.querySelector('.split-recent-btn');
    if (splitRecentBtn) {
      splitRecentBtn.onclick = (e) => { e.stopPropagation(); resumeRecent(r, splitRecentBtn, { split: true }); };
    }
    // Tapping the card body (not its buttons) previews the conversation
    // read-only; Resume from there to take it live.
    card.style.cursor = 'pointer';
    card.onclick = () => openTranscript(r);
    recentList.appendChild(card);
  }
}

async function resumeRecent(r, btn, { split = false } = {}) {
  const label = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; if (!split) btn.textContent = 'Starting…'; }
  try {
    const s = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: r.cwd, resumeId: r.sessionId, name: r.customTitle || r.summary || r.title }),
    });
    openSession(s, { split });
  } catch (err) {
    alert('Failed to resume: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; if (label !== null) btn.innerHTML = label; }
  }
}

// ----------------------------------------------------------------- search ----
// One search box over every transcript's conversation text. Results replace
// the live/recent sections until cleared; tapping a result resumes there.
let searchSeq = 0;

function exitSearch() {
  searchSeq++; // invalidate any in-flight request
  $('#searchSection').classList.add('hidden');
  $('#liveSection').classList.remove('hidden');
  $('#recentSection').classList.remove('hidden');
  $('#searchClear').classList.add('hidden');
}

async function runSearch(q) {
  if (q.length < 2) return;
  const seq = ++searchSeq;
  $('#searchSection').classList.remove('hidden');
  $('#liveSection').classList.add('hidden');
  $('#recentSection').classList.add('hidden');
  $('#searchList').innerHTML = '';
  const status = $('#searchStatus');
  status.textContent = 'Searching…';
  status.classList.remove('hidden');
  let data;
  try {
    data = await api('/api/search?q=' + encodeURIComponent(q));
  } catch (err) {
    if (seq === searchSeq) status.textContent = 'Search failed: ' + err.message;
    return;
  }
  if (seq !== searchSeq) return; // a newer search (or clear) superseded this one
  renderSearchResults(q, data);
}

function highlightMatches(text, q) {
  const escaped = escapeHtml(text);
  const needle = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(needle, 'gi'), '<mark>$&</mark>');
}

function renderSearchResults(q, { results, truncated }) {
  const list = $('#searchList');
  const status = $('#searchStatus');
  list.innerHTML = '';
  if (!results.length) {
    status.textContent = 'No matches.';
    return;
  }
  status.classList.toggle('hidden', !truncated);
  if (truncated) status.textContent = 'Showing the most recent matches — narrow the search to see older sessions.';
  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-top"><div class="card-title"></div></div>
      <div class="card-meta">
        <span class="proj"></span>
        <span class="dot">${timeAgo(r.lastTimestamp)}</span>
        <span class="dot">${r.matches} match${r.matches === 1 ? '' : 'es'}</span>
      </div>
      <div class="search-snips"></div>`;
    card.querySelector('.card-title').textContent = r.customTitle || r.title;
    card.querySelector('.proj').textContent = r.cwd ? r.cwd.split(/[\\/]/).pop() : '?';
    const snips = card.querySelector('.search-snips');
    for (const s of r.snippets) {
      const row = document.createElement('div');
      row.className = 'search-snip';
      row.innerHTML = `<span class="snip-role">${s.role === 'user' ? 'You' : 'Claude'}</span> ${highlightMatches(s.text, q)}`;
      snips.appendChild(row);
    }
    card.onclick = () => resumeRecent({ cwd: r.cwd, sessionId: r.sessionId, customTitle: r.customTitle, title: r.title }, null);
    list.appendChild(card);
  }
}

// ------------------------------------------------------------- usage card ----
async function refreshUsage() {
  const card = $('#usageCard');
  let u;
  try { u = await api('/api/usage'); }
  catch { card.classList.add('hidden'); return; }
  const rows = [usageRow('5-hour limit', u.fiveHour), usageRow('Weekly limit', u.weekly)].filter(Boolean);
  if (!rows.length) { card.classList.add('hidden'); return; }
  card.innerHTML = rows.join('');
  card.classList.remove('hidden');
}

function usageRow(label, d) {
  if (!d) return '';
  const pct = Math.round(d.pct);
  const cls = ''; // usage bars stay blue regardless of level
  return `
    <div class="usage-row">
      <div class="usage-top">
        <span class="usage-label">${label}</span>
        <span class="usage-pct">${pct}%</span>
      </div>
      <div class="gauge"><div class="${cls}" style="width:${Math.min(100, pct)}%"></div></div>
      ${d.resetsAt ? `<div class="usage-reset">resets ${fmtReset(d.resetsAt)}</div>` : ''}
    </div>`;
}

function fmtReset(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
}

// ------------------------------------------------------------------ panes ----
// A Pane is one open session: header, chat log, console (xterm), composer and
// key bar, each with its own WebSocket. Desktop fits two side by side.
class Pane {
  constructor(session, opts = {}) {
    this.session = session;
    this.sid = session.id;
    // Read-only preview of a past transcript (a Recent card): no PTY, no
    // WebSocket — just the chat log, with a Resume button to go live.
    this.transcript = opts.transcript || null;
    this.readonly = !!this.transcript;
    this.isShell = session.kind === 'shell';
    this.closed = false;
    this.chatMode = !this.isShell;
    this.chatOffset = 0;
    this.chatEmpty = true;
    this.chatPolling = false;
    this.lastStatus = null;
    this.lastPrompt = null;
    this.ws = null;
    this.term = null;
    this.fitAddon = null;
    this.chatTimer = null;

    this.el = $('#paneTpl').content.firstElementChild.cloneNode(true);
    this.el.querySelectorAll('[data-icon]').forEach(b => { b.innerHTML = ICONS[b.dataset.icon]; });
    this.wire();
  }

  q(sel) { return this.el.querySelector(sel); }

  wire() {
    this.q('.term-name').textContent = this.session.name;
    this.q('.term-cwd').textContent = this.session.cwd ? this.session.cwd.split(/[\\/]/).pop() : '';
    this.q('.attach-btn').innerHTML = ICONS.clip;
    this.setStatusBadge(this.session.exited ? 'exited' : (this.isShell ? 'shell' : 'live'));

    this.q('.back-btn').onclick = () => closeAllPanes();
    this.q('.pane-close-btn').onclick = () => closePane(this);
    this.q('.mode-toggle').onclick = () => this.setMode(!this.chatMode);
    this.q('.kill-btn').onclick = () => this.readonly ? this.resumeTranscript() : this.killOrClose();
    if (!this.readonly) this.q('.term-name').onclick = () => this.rename();

    this.q('.send-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); this.sendComposer(); });
    const input = this.q('.composer-input');
    input.addEventListener('input', () => this.autoGrow());
    input.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter inserts a newline (composer expands to fit).
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendComposer(); }
    });

    // Voice input (Web Speech API) — the button disappears where the browser
    // has no support (e.g. some webviews).
    const micBtn = this.q('.mic-btn');
    if (SpeechRec) {
      micBtn.innerHTML = ICONS.mic;
      micBtn.onclick = () => this.toggleDictation();
    } else {
      micBtn.remove();
    }

    this.q('.attach-btn').onclick = () => this.q('.file-input').click();
    this.q('.file-input').addEventListener('change', (e) => {
      if (e.target.files[0]) this.upload(e.target.files[0]);
      e.target.value = '';
    });

    // Key bar: send escape sequences without stealing focus (which would pop
    // the soft keyboard on mobile).
    this.el.querySelectorAll('.key-circles button').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.send({ t: 'i', d: btn.dataset.seq });
      });
    });

    // Whichever pane was touched last is where the next sidebar pick lands.
    this.el.addEventListener('pointerdown', () => { state.focused = this; }, true);

    // File paths in chat bubbles open in the built-in viewer (web links are
    // real anchors and need no help).
    this.q('.chat-log').addEventListener('click', (e) => {
      const link = e.target.closest('.file-link');
      if (!link) return;
      openEditor(link.dataset.path, IMAGE_EXT_RE.test(link.dataset.path), 'workspace');
    });

    if (this.isShell) {
      // Shell sessions are console-only: no transcript, no chat mode.
      this.q('.mode-toggle').classList.add('hidden');
      this.q('.attach-btn').classList.add('hidden');
      // Handy on the "Server restart" shell: check the server came back up.
      const statusBtn = this.q('.status-btn');
      statusBtn.classList.remove('hidden');
      statusBtn.onclick = () => this.checkServerStatus();
    }

    if (this.readonly) {
      // History preview: no console, no composer — just the transcript and a
      // Resume button (repurposed Kill) to take it live.
      this.el.classList.add('readonly');
      this.q('.mode-toggle').classList.add('hidden');
      const badge = this.q('.term-status');
      badge.textContent = 'history';
      badge.className = 'term-status badge';
      const killBtn = this.q('.kill-btn');
      killBtn.textContent = 'Resume';
      killBtn.classList.add('primary');
    }
  }

  // From a read-only preview, actually resume the session (spawns the PTY).
  resumeTranscript() {
    const t = this.transcript;
    closePane(this, { silent: true });
    resumeRecent({ cwd: t.cwd, sessionId: t.sessionId, title: t.title }, null);
  }

  // Load a past transcript once (no polling — it's historical).
  async loadTranscript() {
    const log = this.q('.chat-log');
    let data;
    try {
      const t = this.transcript;
      data = await api(`/api/transcript/${encodeURIComponent(t.sessionId)}/messages?cwd=${encodeURIComponent(t.cwd)}`);
    } catch {
      log.innerHTML = '<div class="chat-empty">Could not load this conversation.</div>';
      return;
    }
    if (this.closed) return;
    log.innerHTML = data.messages.length
      ? ''
      : '<div class="chat-empty">This conversation has no displayable messages.</div>';
    this.appendChatMessages(data.messages);
  }

  // Ping the dashboard server and flash the button green (up) or red (down).
  async checkServerStatus() {
    const btn = this.q('.status-btn');
    btn.classList.remove('ok', 'down');
    btn.textContent = 'Checking…';
    try {
      const info = await pingHealth();
      setServerReachable(true, info);
      const secs = Math.round(info.uptime || 0);
      btn.classList.add('ok');
      btn.textContent = secs < 60 ? `Up ✓ (${secs}s)` : 'Up ✓';
    } catch {
      setServerReachable(false);
      btn.classList.add('down');
      btn.textContent = 'Down ✗';
    }
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      btn.classList.remove('ok', 'down');
      btn.textContent = 'Status';
    }, 4000);
  }

  mount(container, before = null) {
    container.insertBefore(this.el, before);
    if (this.readonly) {
      this.setMode(true); // transcript is chat-only
      this.q('.chat-log').innerHTML = '<div class="chat-empty">Loading conversation…</div>';
      this.loadTranscript();
      return;
    }
    this.term = new Terminal({
      fontSize: window.innerWidth < 600 ? 12 : 14,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, monospace',
      theme: xtermTheme(), // follows the app's light/dark theme
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
    });
    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.q('.term-host'));
    this.term.onData((d) => this.send({ t: 'i', d }));
    // No auto-focus: focusing xterm pops the soft keyboard on mobile.

    this.connect();
    this.setMode(this.chatMode);
    if (!this.isShell) {
      this.q('.chat-log').innerHTML = '<div class="chat-empty">Loading conversation…</div>';
      this.chatTimer = setInterval(() => this.pollChat(), 2000);
      this.pollChat();
    }
  }

  setMode(chat) {
    this.chatMode = chat && !this.isShell;
    this.q('.chat-log').classList.toggle('hidden', !this.chatMode);
    this.q('.term-frame').classList.toggle('hidden', this.chatMode);
    // The key circles are a console affordance; chat mode stays clean.
    this.q('.key-circles').classList.toggle('hidden', this.chatMode);
    this.q('.mode-toggle').textContent = this.chatMode ? 'Console' : 'Chat';
    this.setChatStatus();
    if (!this.chatMode) setTimeout(() => this.fit(), 50);
  }

  async connect() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    // Browsers can't set headers on WebSockets, so the (short-lived) Clerk JWT
    // rides in the query string and is verified once at upgrade time.
    const token = await authToken();
    if (this.closed) return;
    const q = token ? `?clerk_token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${wsBase()}/ws/${this.sid}${q}`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'o') this.term.write(msg.d);
      else if (msg.t === 'exit') this.setStatusBadge('exited');
    };
    ws.onclose = (ev) => {
      // The server says this session no longer exists (e.g. after a server
      // restart): stop reconnecting instead of hammering forever.
      if (ev && ev.code === 4004) { this.setStatusBadge('exited'); return; }
      // Auto-reconnect while this pane is open (roaming between networks).
      if (!this.closed) setTimeout(() => { if (!this.closed) this.connect(); }, 1500);
    };
    ws.onopen = () => this.fit();
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  fit() {
    if (this.closed || !this.el.isConnected || !this.fitAddon) return;
    if (this.q('.term-frame').classList.contains('hidden')) return;
    try { this.fitAddon.fit(); } catch { return; }
    this.send({ t: 'r', c: this.term.cols, r: this.term.rows });
  }

  sendComposer() {
    const input = this.q('.composer-input');
    const text = input.value;
    if (!text.trim()) return;
    // Send the text and the Enter as separate writes: Claude Code's paste
    // detection treats a trailing \r inside one chunk as a pasted newline
    // rather than a submit. Collapse the composer's own newlines into carriage
    // returns so a multi-line prompt arrives intact.
    this.send({ t: 'i', d: text.replace(/\n/g, '\r') });
    setTimeout(() => this.send({ t: 'i', d: '\r' }), 200);
    input.value = '';
    this.autoGrow();
  }

  // Tap the mic to dictate into the composer; tap again (or pause) to stop.
  // Recognized speech is appended to whatever was already typed.
  toggleDictation() {
    if (this.recActive) { try { this.rec.stop(); } catch {} return; }
    if (!this.rec) {
      this.rec = new SpeechRec();
      this.rec.lang = navigator.language || 'en-US';
      this.rec.interimResults = true;
      this.rec.continuous = false;
      this.rec.onresult = (e) => {
        let heard = '';
        for (const r of e.results) heard += r[0].transcript;
        const input = this.q('.composer-input');
        input.value = this.dictBase + (this.dictBase && heard ? ' ' : '') + heard.trimStart();
        this.autoGrow();
      };
      this.rec.onend = () => {
        this.recActive = false;
        this.q('.mic-btn').classList.remove('recording');
      };
      this.rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          alert('Microphone access is blocked for this site — allow it in your browser settings to dictate.');
        }
      };
    }
    this.dictBase = this.q('.composer-input').value.trim();
    this.recActive = true;
    this.q('.mic-btn').classList.add('recording');
    try { this.rec.start(); } catch { /* already started */ }
  }

  // The composer grows with its content (up to a cap) instead of scrolling a
  // single line off to the left.
  autoGrow() {
    const input = this.q('.composer-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  async pollChat() {
    if (this.closed || this.isShell) return;
    // A poll can outlive the 2s interval on a slow link. Without this guard the
    // next tick re-requests the same offset and appends the messages twice.
    if (this.chatPolling) return;
    this.chatPolling = true;
    let data;
    try {
      data = await api(`/api/sessions/${this.sid}/messages?offset=${this.chatOffset}`);
    } catch {
      return;
    } finally {
      this.chatPolling = false;
    }
    if (this.closed) return;
    this.chatOffset = data.offset;
    if (this.chatEmpty && (data.messages.length || !data.pending)) {
      this.q('.chat-log').innerHTML = data.messages.length
        ? ''
        : '<div class="chat-empty">No messages yet — send a prompt below, or switch to Console if Claude is showing a startup prompt.</div>';
      this.chatEmpty = !data.messages.length;
    }
    if (data.messages.length) this.appendChatMessages(data.messages);
    this.setChatStatus(data.status, data.prompt);
  }

  appendChatMessages(messages) {
    const log = this.q('.chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 150;
    for (const m of messages) {
      // Chat view is conversation-only: tool activity (Read/Grep/Edit/Bash…)
      // belongs in the Console. Plans and questions arrive as assistant text.
      if (m.role === 'tool') continue;
      const el = document.createElement('div');
      el.className = 'chat-bubble ' + m.role;
      el.innerHTML = renderMarkdown(m.text);
      if (m.ts) {
        const stamp = document.createElement('div');
        stamp.className = 'chat-ts';
        stamp.textContent = fmtChatTime(m.ts);
        el.appendChild(stamp);
      }
      log.appendChild(el);
    }
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  // Live activity indicator below the transcript: is Claude thinking, waiting
  // on the user to approve something, or idle? Derived server-side from the
  // PTY. When awaiting, `prompt` (if the server could parse the menu) carries
  // the options so we can offer them as buttons right here in chat.
  setChatStatus(status, prompt) {
    if (status !== undefined) { this.lastStatus = status; this.lastPrompt = prompt || null; }
    status = this.lastStatus;
    const el = this.q('.chat-status');
    // Only a chat-view affordance; the Console shows Claude's own spinner/prompts.
    if (!this.chatMode || !status || status === 'idle' || status === 'exited') {
      el.className = 'chat-status hidden';
      el.innerHTML = '';
      return;
    }
    if (status === 'working') {
      el.className = 'chat-status working';
      el.innerHTML = '<span class="typing"><i></i><i></i><i></i></span><span>Claude is working…</span>';
      return;
    }
    // awaiting_input
    const p = this.lastPrompt;
    if (p && p.options && p.options.length) {
      el.className = 'chat-status awaiting has-opts';
      const q = p.question || 'Claude needs your approval to continue.';
      el.innerHTML =
        '<div class="await-head"><span class="awaiting-icon">⚠</span><span>' + escapeHtml(q) + '</span></div>' +
        '<div class="await-opts">' +
        p.options.map((o) =>
          '<button class="btn await-opt" data-digit="' + o.n + '">' +
          '<span class="await-num">' + o.n + '</span><span>' + escapeHtml(o.label) + '</span></button>'
        ).join('') +
        '</div>' +
        '<button class="btn small await-console">Open Console instead</button>';
      el.querySelectorAll('.await-opt').forEach((b) => {
        b.onclick = () => {
          this.send({ t: 'i', d: b.dataset.digit }); // a bare digit selects & confirms
          this.setChatStatus('working', null);       // optimistic; next poll reconciles
        };
      });
      el.querySelector('.await-console').onclick = () => this.setMode(false);
    } else {
      // Couldn't parse the menu — point the user at the Console.
      el.className = 'chat-status awaiting';
      el.innerHTML = '<span class="awaiting-icon">⚠</span>' +
        '<span>Claude is waiting for your response — a prompt needs an answer.</span>' +
        '<button class="btn small await-console">Open Console</button>';
      el.querySelector('.await-console').onclick = () => this.setMode(false);
    }
  }

  setStatusBadge(status) {
    const el = this.q('.term-status');
    el.textContent = status;
    el.className = 'term-status badge ' + (status === 'exited' ? 'exited' : 'live');
    this.q('.kill-btn').textContent = status === 'exited' ? 'Close' : 'Kill';
  }

  async killOrClose() {
    // DELETE kills the process and drops the PTY from the live list, so a
    // Claude session falls straight back into Recents (resumable). No confirm.
    closePane(this);
    await api(`/api/sessions/${this.sid}`, { method: 'DELETE' }).catch(() => {});
  }

  rename() {
    const el = this.q('.term-name');
    inlineRename(el, el.textContent, async (name) => {
      await api(`/api/sessions/${this.sid}/rename`, { method: 'POST', body: JSON.stringify({ name }) });
      el.textContent = name;
    });
  }

  async upload(file) {
    if (file.size > 25 * 1024 * 1024) { alert('Image too large (25 MB max).'); return; }
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('could not read file'));
      reader.readAsDataURL(file);
    });
    const attachBtn = this.q('.attach-btn');
    attachBtn.disabled = true;
    attachBtn.textContent = '…';
    try {
      const { path } = await api('/api/uploads', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, dataBase64 }),
      });
      // Drop the PC-side path into the prompt; Claude Code reads images by path.
      const input = this.q('.composer-input');
      input.value = (input.value ? input.value + ' ' : '') + path + ' ';
      input.focus();
      this.autoGrow();
    } catch (err) {
      alert('Upload failed: ' + err.message);
    } finally {
      attachBtn.disabled = false;
      attachBtn.innerHTML = ICONS.clip;
    }
  }

  destroy() {
    this.closed = true;
    if (this.rec) { try { this.rec.abort(); } catch {} this.rec = null; }
    if (this.chatTimer) clearInterval(this.chatTimer);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch {} this.ws = null; }
    if (this.term) { try { this.term.dispose(); } catch {} this.term = null; }
    this.el.remove();
  }
}

// -------------------------------------------------------- pane management ----
function updatePaneArea() {
  const area = $('#paneArea');
  area.classList.toggle('no-panes', state.panes.length === 0);
  area.classList.toggle('split', state.panes.length > 1);
  updateFabBar();
}

// Mobile footer: Back only means something inside a session or the files
// browser, and it swaps in for Sign out so five buttons never squeeze onto
// a phone row.
function updateFabBar() {
  const showBack = state.filesOpen || state.panes.length > 0;
  $('#fabBack').classList.toggle('hidden', !showBack);
  $('#fabSignOut').classList.toggle('hidden', !state.canSignOut || showBack);
}

// Open a session in the main area. Default: it takes over, replacing whatever
// was open. `split:true` (desktop only, via a card's split button) keeps the
// current session and opens this one beside it.
function openSession(session, { split = false, transcript = null } = {}) {
  if (state.filesOpen) showFiles(false); // sessions and files share the main area
  const existing = state.panes.find(p => p.sid === session.id);
  if (existing) { state.focused = existing; return; }

  const canSplit = split && isDesktop();
  if (canSplit) {
    // Make room for a second pane (cap at two), keeping the newest.
    while (state.panes.length >= 2) closePane(state.panes[0], { silent: true });
  } else {
    [...state.panes].forEach(p => closePane(p, { silent: true }));
  }
  const pane = new Pane(session, transcript ? { transcript } : {});
  state.panes.push(pane);
  pane.mount($('#paneArea'), null);
  state.focused = pane;
  updatePaneArea();
  state.panes.forEach(p => p.fit());
  renderList0();
}

// Open a past (non-live) transcript as a read-only chat preview, no resume.
function openTranscript(r) {
  const title = r.customTitle || r.summary || r.title || 'Conversation';
  const session = { id: 'transcript:' + r.sessionId, kind: 'claude', name: title, cwd: r.cwd, exited: false };
  openSession(session, { transcript: { sessionId: r.sessionId, cwd: r.cwd, title } });
}

// Re-render list highlights without refetching.
function renderList0() { if (state.data) renderList(); }

function closePane(pane, { silent = false } = {}) {
  pane.destroy();
  state.panes = state.panes.filter(p => p !== pane);
  if (state.focused === pane) state.focused = state.panes[0] || null;
  updatePaneArea();
  state.panes.forEach(p => p.fit());
  if (!silent) refresh();
}

function closeAllPanes() {
  [...state.panes].forEach(p => closePane(p, { silent: true }));
  refresh();
}

// ---------------------------------------------------------- file explorer ----
function fmtSize(n) {
  if (n == null) return '';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

async function openExplorer(dirPath) {
  let data;
  try {
    data = await api('/api/fs/list' + (dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''));
  } catch (err) {
    alert('Cannot open folder: ' + err.message);
    return;
  }
  state.explorerPath = data.path;
  showFiles(true);

  // Breadcrumbs, clickable back to the root.
  const crumbs = $('#crumbs');
  crumbs.innerHTML = '';
  const rootParts = data.root.split('\\').filter(Boolean);
  const parts = data.path.split('\\').filter(Boolean);
  for (let i = rootParts.length - 1; i < parts.length; i++) {
    if (i > rootParts.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      crumbs.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.textContent = parts[i];
    const target = parts.slice(0, i + 1).join('\\');
    btn.onclick = () => openExplorer(target);
    crumbs.appendChild(btn);
  }

  const list = $('#fileList');
  list.innerHTML = '';
  for (const e of data.entries) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `
      <span class="ficon">${e.dir ? ICONS.folder : e.image ? ICONS.image : ICONS.file}</span>
      <span class="fname"></span>
      <span class="fmeta">${e.dir ? '' : fmtSize(e.size)}</span>`;
    row.querySelector('.fname').textContent = e.name;
    const full = data.path.replace(/\\$/, '') + '\\' + e.name;
    row.onclick = () => e.dir ? openExplorer(full) : openEditor(full, e.image);
    list.appendChild(row);
  }
  if (!data.entries.length) {
    list.innerHTML = '<div class="file-row"><span class="fmeta">empty folder</span></div>';
  }
}

// ------------------------------------------------------------------ editor ----
// Doubles as the artifact viewer: .html opens rendered in a sandboxed iframe
// and .md as rich text, with a Code/Preview toggle for editing. Everything
// else keeps the plain notepad behavior.
function editorKindFor(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'text';
}

async function openEditor(filePath, isImage, returnTo = 'explorer') {
  state.editorReturnTo = returnTo; // where Back goes: the file tree or the open session
  showFiles(true);
  $('#filesView').classList.add('file-open');
  // Opened from chat before the tree was ever loaded (desktop shows both):
  // bring the tree up at the file's own folder.
  if (!state.explorerPath) openExplorer(filePath.replace(/\\[^\\]+$/, ''));
  $('#editorName').textContent = filePath.split('\\').pop();
  const text = $('#editorText');
  const imageWrap = $('#editorImageWrap');
  const saveBtn = $('#editorSaveBtn');
  text.classList.add('hidden');
  imageWrap.classList.add('hidden');
  $('#editorFrame').classList.add('hidden');
  $('#editorMd').classList.add('hidden');
  $('#editorModeBtn').classList.add('hidden');
  saveBtn.classList.toggle('hidden', !!isImage);
  state.editorPath = filePath;
  state.editorKind = isImage ? 'image' : editorKindFor(filePath);

  try {
    if (isImage) {
      const res = await apiRaw(`/api/fs/raw?path=${encodeURIComponent(filePath)}`);
      const blob = await res.blob();
      $('#editorImage').src = URL.createObjectURL(blob);
      imageWrap.classList.remove('hidden');
    } else {
      const data = await api(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
      text.value = data.content;
      if (state.editorKind === 'text') {
        text.classList.remove('hidden');
      } else {
        // Artifacts open rendered; the toggle flips to the source for edits.
        $('#editorModeBtn').classList.remove('hidden');
        setEditorMode('preview');
      }
    }
  } catch (err) {
    alert('Cannot open file: ' + err.message);
    $('#filesView').classList.remove('file-open');
    if (state.editorReturnTo === 'workspace') showFiles(false);
  }
}

function setEditorMode(mode) {
  state.editorMode = mode;
  const preview = mode === 'preview';
  $('#editorText').classList.toggle('hidden', preview);
  $('#editorFrame').classList.toggle('hidden', !(preview && state.editorKind === 'html'));
  $('#editorMd').classList.toggle('hidden', !(preview && state.editorKind === 'md'));
  $('#editorSaveBtn').classList.toggle('hidden', preview);
  $('#editorModeBtn').textContent = preview ? 'Code' : 'Preview';
  if (preview) {
    const src = $('#editorText').value;
    if (state.editorKind === 'html') $('#editorFrame').srcdoc = src;
    else $('#editorMd').innerHTML = mdToHtml(src);
  }
}

// Markdown for the artifact viewer — richer than the chat bubbles' minimal
// renderer (headings, lists, links, quotes), still escape-first so file
// content can't inject markup.
function mdToHtml(src) {
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const blocks = src.split('```');
  let html = '';
  for (let i = 0; i < blocks.length; i++) {
    if (i % 2 === 1) {
      html += `<pre>${escapeHtml(blocks[i].replace(/^[\w-]*\n/, ''))}</pre>`;
      continue;
    }
    const lines = escapeHtml(blocks[i]).split(/\r?\n/);
    let list = null; // 'ul' | 'ol'
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
      if (h) { closeList(); html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`; }
      else if (li) {
        const kind = /^\d+\.$/.test(li[1]) ? 'ol' : 'ul';
        if (list !== kind) { closeList(); html += `<${kind}>`; list = kind; }
        html += `<li>${inline(li[2])}</li>`;
      }
      else if (/^(-{3,}|\*{3,})$/.test(line)) { closeList(); html += '<hr>'; }
      else if (/^&gt;\s?/.test(line)) { closeList(); html += `<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`; }
      else if (line.trim() === '') { closeList(); }
      else { closeList(); html += `<p>${inline(line)}</p>`; }
    }
    closeList();
  }
  return html;
}

async function saveEditor() {
  const btn = $('#editorSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await api('/api/fs/write', {
      method: 'POST',
      body: JSON.stringify({ path: state.editorPath, content: $('#editorText').value }),
    });
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
  } catch (err) {
    alert('Save failed: ' + err.message);
    btn.textContent = 'Save';
    btn.disabled = false;
  }
}

// ------------------------------------------------------------ new session ----
function openNewDialog(kind, trigger) {
  state.newKind = kind === 'shell' ? 'shell' : 'claude';
  state.popoverTrigger = trigger || null;
  $('#newDialogTitle').textContent = state.newKind === 'shell' ? 'New PowerShell Session' : 'New Claude Session';
  $('#launchBtn').textContent = state.newKind === 'shell' ? 'Open terminal' : 'Launch';
  // Model choice only applies to Claude sessions; default to the server lock.
  $('#modelLabel').classList.toggle('hidden', state.newKind === 'shell');
  const modelSel = $('#modelSelect');
  const lock = (state.data && state.data.model) || 'opus';
  modelSel.value = [...modelSel.options].some(o => o.value === lock) ? lock : 'opus';
  const sel = $('#projectSelect');
  sel.innerHTML = '';
  const projects = (state.data && state.data.projects) || [];
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.cwd;
    opt.textContent = p.name; // directory name only, no full path
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Other directory…';
  sel.appendChild(custom);
  sel.onchange = () => {
    const isCustom = sel.value === '__custom__';
    $('#customDirLabel').classList.toggle('hidden', !isCustom);
    if (isCustom) populateCustomDirs();
    positionPopover();
  };
  $('#customDirLabel').classList.add('hidden');
  $('#sessionName').value = '';

  $('#popoverBackdrop').classList.remove('hidden');
  $('#newPopover').classList.remove('hidden');
  // Build the rounded custom dropdowns off the freshly-populated selects.
  $('#newPopover').querySelectorAll('.select-wrap').forEach(enhanceSelect);
  positionPopover();
}

// ---- custom rounded dropdowns (the native <select> stays the data model) ----
// Native option lists can't be rounded, so we hide the <select> and drive a
// styled trigger + list off it; reads/writes still go through <select>.value.
function enhanceSelect(wrap) {
  const select = wrap.querySelector('select');
  if (!select) return;
  select.classList.add('cs-native');
  if (!wrap.querySelector('.cs-trigger')) {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    trigger.innerHTML = '<span class="cs-label"></span>';
    const list = document.createElement('div');
    list.className = 'cs-list hidden';
    wrap.append(trigger, list);
    trigger.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleCsList(wrap); };
  }
  renderCsOptions(wrap);
}
function renderCsOptions(wrap) {
  const select = wrap.querySelector('select');
  const list = wrap.querySelector('.cs-list');
  wrap.querySelector('.cs-label').textContent =
    select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
  list.innerHTML = '';
  [...select.options].forEach((opt, i) => {
    const item = document.createElement('div');
    item.className = 'cs-option' + (i === select.selectedIndex ? ' selected' : '');
    item.textContent = opt.textContent;
    item.onclick = () => {
      select.selectedIndex = i;
      renderCsOptions(wrap);
      closeCsList(wrap);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    list.appendChild(item);
  });
}
function closeAllCsLists() {
  document.querySelectorAll('.cs-list').forEach(l => l.classList.add('hidden'));
  document.querySelectorAll('.cs-trigger').forEach(t => t.classList.remove('open'));
}
function toggleCsList(wrap) {
  const willOpen = wrap.querySelector('.cs-list').classList.contains('hidden');
  closeAllCsLists();
  if (willOpen) {
    wrap.querySelector('.cs-list').classList.remove('hidden');
    wrap.querySelector('.cs-trigger').classList.add('open');
  }
}
function closeCsList(wrap) {
  wrap.querySelector('.cs-list').classList.add('hidden');
  wrap.querySelector('.cs-trigger').classList.remove('open');
}

// Folders under the home directory — where new projects always live — so
// "Other directory" is a pick list, not a path to type.
async function populateCustomDirs() {
  const sel = $('#customDirSelect');
  sel.innerHTML = '<option>Loading…</option>';
  try {
    const data = await api('/api/fs/list'); // no path => home dir (the server's user profile)
    const dirs = data.entries.filter(e => e.dir);
    sel.innerHTML = '';
    if (!dirs.length) { sel.innerHTML = '<option value="">(no folders)</option>'; return; }
    for (const e of dirs) {
      const opt = document.createElement('option');
      opt.value = data.path.replace(/\\$/, '') + '\\' + e.name;
      opt.textContent = e.name;
      sel.appendChild(opt);
    }
  } catch (err) {
    sel.innerHTML = '<option value="">(couldn\'t load folders)</option>';
  }
  enhanceSelect(sel.closest('.select-wrap')); // rebuild the custom list
  positionPopover();
}

// Anchor the popover just below its trigger (or above, if it'd overflow the
// bottom — e.g. the mobile footer buttons).
function positionPopover() {
  const pop = $('#newPopover');
  const trigger = state.popoverTrigger;
  if (pop.classList.contains('hidden') || !trigger) return;
  const r = trigger.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.min(Math.max(8, r.left), vw - pw - 8);
  const top = (r.bottom + ph + 8 <= vh) ? r.bottom + 6 : Math.max(8, r.top - ph - 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function closeNewDialog() {
  closeAllCsLists();
  $('#newPopover').classList.add('hidden');
  $('#popoverBackdrop').classList.add('hidden');
  state.popoverTrigger = null;
}

async function submitNewSession(e) {
  e.preventDefault();
  const sel = $('#projectSelect');
  const cwd = sel.value === '__custom__' ? $('#customDirSelect').value : sel.value;
  if (!cwd) return;
  const name = $('#sessionName').value.trim() || undefined;
  const model = state.newKind === 'claude' ? $('#modelSelect').value : undefined;
  try {
    const s = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd, name, kind: state.newKind, model }),
    });
    closeNewDialog();
    openSession(s);
  } catch (err) {
    alert('Failed to launch: ' + err.message);
  }
}

// ---------------------------------------------------------------- wiring ----
$('#newSessionBtn').onclick = () => openNewDialog('claude', $('#newSessionBtn'));
$('#shellBtn').onclick = () => openNewDialog('shell', $('#shellBtn'));
$('#cancelNewBtn').onclick = closeNewDialog;
$('#popoverBackdrop').onclick = closeNewDialog;
// Clicking elsewhere in the popover closes an open dropdown list.
$('#newPopover').addEventListener('click', (e) => {
  if (!e.target.closest('.select-wrap')) closeAllCsLists();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#newPopover').classList.contains('hidden')) closeNewDialog();
});
window.addEventListener('resize', positionPopover);
$('#newForm').onsubmit = submitNewSession;
// Desktop sidebar is an icon-only rail; labels live in each button's title.
$('#newSessionBtn').innerHTML = ICONS.plus;
$('#shellBtn').innerHTML = ICONS.terminal;
$('#filesBtn').innerHTML = ICONS.folder;
$('.search-ico').innerHTML = ICONS.search;
// Mobile footer is icon-only too.
$('#fabNew').innerHTML = ICONS.plus;
$('#fabShell').innerHTML = ICONS.terminal;
$('#fabFiles').innerHTML = ICONS.folder;
$('#fabRestart').innerHTML = ICONS.refresh;
$('#fabSignOut').innerHTML = ICONS.logout;
$('#railSignOut').innerHTML = ICONS.logout;
$('#fabBack').innerHTML = ICONS.back;
$('#themeBtn').onclick = toggleTheme;
$('#fabTheme').onclick = toggleTheme;
applyTheme(currentTheme()); // sets the toggle icons to match the pre-painted theme

// Restart the dashboard server through a visible PowerShell session.
async function restartServer() {
  if (!confirm('Restart the dashboard server? Live sessions will close (Claude ones can be resumed) and the dashboard drops for a few seconds.')) return;
  try {
    const s = await api('/api/server/restart', { method: 'POST' });
    openSession(s); // watch the restart script run until the server goes down
  } catch (err) {
    alert('Restart failed: ' + err.message);
  }
}
$('#restartBtn').innerHTML = ICONS.refresh;
$('#fabRestart').innerHTML = ICONS.refresh;
$('#restartBtn').onclick = restartServer;
$('#fabRestart').onclick = restartServer;

// Search box: debounced live search, Enter for immediate, × or empty to clear.
$('#searchInput').addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  const q = $('#searchInput').value.trim();
  $('#searchClear').classList.toggle('hidden', !q);
  if (!q) { exitSearch(); return; }
  state.searchTimer = setTimeout(() => runSearch(q), 500);
});
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(state.searchTimer);
    runSearch($('#searchInput').value.trim());
  }
});
$('#searchClear').onclick = () => { $('#searchInput').value = ''; exitSearch(); };

// Sidebar collapse (desktop). Remembered across visits.
function setCollapsed(c) {
  $('#workspace').classList.toggle('side-collapsed', c);
  $('#expandBtn').classList.toggle('hidden', !c);
  try { localStorage.setItem('sideCollapsed', c ? '1' : ''); } catch {}
  state.panes.forEach(p => setTimeout(() => p.fit(), 60));
}
$('#collapseBtn').onclick = () => setCollapsed(true);
$('#expandBtn').onclick = () => setCollapsed(false);
try { if (localStorage.getItem('sideCollapsed') === '1') setCollapsed(true); } catch {}

// Mobile footer bar (replaces the sidebar header on phones).
$('#fabNew').onclick = () => openNewDialog('claude', $('#fabNew'));
$('#fabShell').onclick = () => openNewDialog('shell', $('#fabShell'));
$('#fabFiles').onclick = () => openExplorer(state.explorerPath);
async function signOut() {
  if (window.Clerk) { await window.Clerk.signOut(); location.reload(); }
}
$('#fabSignOut').onclick = signOut;
$('#railSignOut').onclick = signOut;
// Footer Back walks the stack: open file -> file tree -> session list (or
// back into the session a chat-opened file came from).
$('#fabBack').onclick = () => {
  if (state.filesOpen) {
    const fv = $('#filesView');
    if (fv.classList.contains('file-open')) {
      fv.classList.remove('file-open');
      if (state.editorReturnTo === 'workspace') showFiles(false);
    } else {
      showFiles(false);
    }
  } else {
    closeAllPanes();
  }
};

// File explorer / editor wiring.
$('#filesBtn').onclick = () => openExplorer(state.explorerPath);
$('#editorBackBtn').onclick = () => {
  $('#filesView').classList.remove('file-open');
  if (state.editorReturnTo === 'workspace') showFiles(false);
};
$('#editorSaveBtn').onclick = saveEditor;
$('#editorModeBtn').onclick = () => setEditorMode(state.editorMode === 'preview' ? 'code' : 'preview');

// Dropping below the desktop breakpoint (resize, browser zoom, rotation)
// can't keep two panes on screen. Keep a reference to the MediaQueryList —
// an unreferenced one may never fire — and double-check on plain resizes too.
const desktopMq = window.matchMedia('(min-width: 1024px)');
function enforceLayout() {
  if (!desktopMq.matches) {
    while (state.panes.length > 1) closePane(state.panes[state.panes.length - 1], { silent: true });
  }
}
desktopMq.addEventListener('change', enforceLayout);
window.addEventListener('resize', () => {
  enforceLayout();
  state.panes.forEach(p => p.fit());
});

// Poll list state; on mobile pause while a session pane covers the screen.
function startPolling() {
  refresh();
  refreshUsage();
  state.pollTimer = setInterval(() => {
    if (isDesktop() || state.panes.length === 0) refresh();
  }, 5000);
  state.usageTimer = setInterval(refreshUsage, 5 * 60 * 1000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refresh();
    refreshUsage();
    for (const p of state.panes) {
      if (p.ws && p.ws.readyState > 1) p.connect();
    }
  }
});

// ------------------------------------------------------------------- boot ----
function loadClerkJs(publishableKey) {
  return new Promise((resolve, reject) => {
    // The frontend API domain is base64-encoded inside the publishable key.
    let frontendApi;
    try {
      frontendApi = atob(publishableKey.split('_')[2]).replace(/\$$/, '');
    } catch {
      return reject(new Error('Invalid Clerk publishable key'));
    }
    const s = document.createElement('script');
    s.src = `https://${frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.setAttribute('data-clerk-publishable-key', publishableKey);
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load Clerk script'));
    document.head.appendChild(s);
  });
}

(async function boot() {
  if (ENV.CLERK_PUBLISHABLE_KEY) {
    try {
      await loadClerkJs(ENV.CLERK_PUBLISHABLE_KEY);
      await window.Clerk.load();
    } catch (err) {
      showView('authView');
      const e = $('#authError');
      e.textContent = 'Auth failed to load: ' + err.message;
      e.classList.remove('hidden');
      return;
    }
    if (!window.Clerk.user) {
      showView('authView');
      window.Clerk.mountSignIn($('#clerkSignIn'));
      window.Clerk.addListener(({ user }) => { if (user) location.reload(); });
      return;
    }
    state.canSignOut = true;
    $('#fabSignOut').classList.remove('hidden');
    $('#railSignOut').classList.remove('hidden');
  }
  showView('workspace');
  startPolling();
})();
