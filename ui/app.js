// MD Viewer front end. Talks to the Rust side through window.__TAURI__ (withGlobalTauri).
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: openDialog } = window.__TAURI__.dialog;
const { openUrl } = window.__TAURI__.opener;

const $ = (id) => document.getElementById(id);
const body = document.body;
const content = $('content');
const scroller = $('scroller');
const treeEl = $('tree');
const filterEl = $('filter');

const state = {
  root: null,
  file: null,
  tree: null,
  expanded: new Set(),
};

// ---------- small helpers ----------
const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const isInside = (p, root) => !!root && (p === root || p.startsWith(root.endsWith('/') ? root : root + '/'));
const relPath = (p) => (isInside(p, state.root) ? p.slice(state.root.length).replace(/^\//, '') : p);

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function slugify(text) {
  return text.trim().toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '');
}

// ---------- opening ----------
async function openPath(path) {
  let target;
  try {
    target = await invoke('resolve_open', { path });
  } catch (e) {
    toast(`開けませんでした: ${e}`);
    return;
  }
  // A file inside the folder that's already open keeps the current sidebar.
  const keepRoot = target.file && isInside(target.file, state.root);
  if (!keepRoot) await setRoot(target.root);
  if (target.file) await openFile(target.file);
  else showEmpty();
}

async function setRoot(root) {
  state.root = root;
  state.expanded = new Set(store.get(`expanded:${root}`, []));
  $('root-name').textContent = basename(root);
  $('root-name').title = root;
  filterEl.value = '';
  await loadTree();
  invoke('watch_root', { root }).catch((e) => console.warn('watch failed', e));
  store.set('lastRoot', root);
}

async function loadTree() {
  try {
    state.tree = await invoke('list_tree', { root: state.root });
  } catch (e) {
    state.tree = null;
    treeEl.innerHTML = `<div class="tree-note">${escapeHtml(String(e))}</div>`;
    return;
  }
  renderTree();
}

async function openFile(path, { keepScroll = false, anchor = null } = {}) {
  const prevScroll = scroller.scrollTop;
  let rendered;
  try {
    rendered = await invoke('render_file', { path });
  } catch (e) {
    if (keepScroll) return; // transient during a save; keep showing the old content
    content.innerHTML = `<p class="error">${escapeHtml(String(e))}</p>`;
    body.classList.remove('is-empty');
    return;
  }
  state.file = path;
  content.innerHTML = rendered.html;
  decorate();
  body.classList.remove('is-empty');
  $('pathbar').textContent = relPath(path);
  document.title = `${basename(path)} — MD Viewer`;

  revealInTree(path);
  store.set('lastFile', path);

  if (anchor) scrollToAnchor(anchor);
  else scroller.scrollTop = keepScroll ? prevScroll : 0;
}

function showEmpty() {
  state.file = null;
  content.innerHTML = '';
  $('pathbar').textContent = '';
  document.title = 'MD Viewer';
  body.classList.add('is-empty');
  renderTree();
}

async function pickFolder() {
  const dir = await openDialog({ directory: true, multiple: false, defaultPath: state.root || undefined });
  if (dir) openPath(dir);
}

// ---------- rendered content ----------
function decorate() {
  const used = new Map();
  for (const h of content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (h.id) continue;
    let id = slugify(h.textContent) || 'section';
    const n = used.get(id) || 0;
    used.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    h.id = id;
  }
  for (const box of content.querySelectorAll('input[type="checkbox"]')) box.disabled = true;
}

function scrollToAnchor(anchor) {
  const id = decodeURIComponent(anchor);
  const el = document.getElementById(id) || document.getElementById(slugify(id));
  if (el) el.scrollIntoView({ block: 'start' });
}

content.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  e.preventDefault();

  if (href.startsWith('#')) {
    scrollToAnchor(href.slice(1));
  } else if (href.startsWith('mdv-open:')) {
    const [enc, frag] = href.slice('mdv-open:'.length).split('#');
    const path = decodeURIComponent(enc);
    if (/\.(md|markdown|mdown|mkd)$/i.test(path)) {
      if (path === state.file) { if (frag) scrollToAnchor(frag); }
      else openFile(path, { anchor: frag || null });
    } else {
      openPath(path); // a folder, or another kind of file → let resolve_open decide
    }
  } else {
    openUrl(href).catch(() => toast('リンクを開けませんでした'));
  }
});

// ---------- tree ----------
const CHEVRON = '<svg class="chev" viewBox="0 0 10 10"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderTree() {
  treeEl.innerHTML = '';
  if (!state.tree) return;
  const q = filterEl.value.trim().toLowerCase();

  if (q) {
    const matches = [];
    (function collect(n) {
      for (const c of n.children) {
        if (c.dir) collect(c);
        else if (relPath(c.path).toLowerCase().includes(q)) matches.push(c);
      }
    })(state.tree);
    const ul = document.createElement('ul');
    for (const f of matches.slice(0, 300)) ul.append(fileItem(f, true));
    treeEl.append(ul);
    if (!matches.length) treeEl.innerHTML = '<div class="tree-note">一致するファイルはありません</div>';
    return;
  }

  if (!state.tree.children.length) {
    treeEl.innerHTML = '<div class="tree-note">このフォルダにはMarkdownファイルがありません</div>';
    return;
  }
  treeEl.append(buildList(state.tree.children));
}

function buildList(nodes) {
  const ul = document.createElement('ul');
  for (const n of nodes) ul.append(n.dir ? dirItem(n) : fileItem(n, false));
  return ul;
}

function dirItem(n) {
  const li = document.createElement('li');
  li.className = 'dir';
  if (state.expanded.has(n.path)) li.classList.add('open');
  const btn = document.createElement('button');
  btn.className = 'row';
  btn.innerHTML = `${CHEVRON}<span class="label"></span>`;
  btn.querySelector('.label').textContent = n.name;
  btn.addEventListener('click', () => {
    const open = li.classList.toggle('open');
    if (open) {
      state.expanded.add(n.path);
      if (!li.querySelector('ul')) li.append(buildList(n.children));
    } else {
      state.expanded.delete(n.path);
    }
    store.set(`expanded:${state.root}`, [...state.expanded]);
  });
  li.append(btn);
  if (li.classList.contains('open')) li.append(buildList(n.children));
  return li;
}

function fileItem(n, showDir) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = 'row';
  btn.dataset.path = n.path;
  if (n.path === state.file) btn.classList.add('active');
  btn.innerHTML = '<span class="file-dot"></span><span class="label"></span>';
  btn.querySelector('.label').textContent = n.name;
  if (showDir) {
    const dir = relPath(n.path).split('/').slice(0, -1).join('/');
    if (dir) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = dir;
      btn.append(sub);
    }
  }
  btn.addEventListener('click', () => openFile(n.path));
  li.append(btn);
  return li;
}

function revealInTree(path) {
  // Expand every folder between the root and this file, then mark it active.
  if (isInside(path, state.root)) {
    const parts = relPath(path).split('/').slice(0, -1);
    let cur = state.root.replace(/\/$/, '');
    let changed = false;
    for (const p of parts) {
      cur += '/' + p;
      if (!state.expanded.has(cur)) { state.expanded.add(cur); changed = true; }
    }
    if (changed) {
      store.set(`expanded:${state.root}`, [...state.expanded]);
      renderTree();
    }
  }
  for (const el of treeEl.querySelectorAll('.row.active')) el.classList.remove('active');
  const row = [...treeEl.querySelectorAll('.row[data-path]')].find((r) => r.dataset.path === path);
  if (row) {
    row.classList.add('active');
    row.scrollIntoView({ block: 'nearest' });
  }
}

let filterTimer;
filterEl.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderTree, 80);
});
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = treeEl.querySelector('.row[data-path]');
    if (first) first.click();
  } else if (e.key === 'Escape') {
    filterEl.value = '';
    renderTree();
    filterEl.blur();
  }
});

// ---------- live reload ----------
let fsTimer;
let pendingStructural = false;
let pendingCurrent = false;
listen('fs-changed', ({ payload }) => {
  if (payload.structural) pendingStructural = true;
  if (state.file && (payload.structural || payload.paths.includes(state.file))) pendingCurrent = true;
  clearTimeout(fsTimer);
  fsTimer = setTimeout(async () => {
    const structural = pendingStructural;
    const current = pendingCurrent;
    pendingStructural = pendingCurrent = false;
    if (structural && state.root) await loadTree();
    if (current && state.file) await openFile(state.file, { keepScroll: true });
  }, 180);
});

// ---------- OS hand-offs (Finder double-click, drag & drop) ----------
async function takePending() {
  const p = await invoke('take_pending');
  if (p) await openPath(p);
  return !!p;
}
listen('open-requested', () => takePending());

window.addEventListener('dragover', (e) => { e.preventDefault(); body.classList.add('drag-over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) body.classList.remove('drag-over'); });
window.addEventListener('drop', (e) => { e.preventDefault(); body.classList.remove('drag-over'); });

// ---------- appearance ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', darkQuery.matches);
darkQuery.addEventListener('change', applyTheme);
applyTheme();

let fontSize = store.get('fontSize', 16);
const applyFont = () => body.style.setProperty('--font-size', `${fontSize}px`);
applyFont();

let sideW = store.get('sideWidth', 270);
body.style.setProperty('--side-w', `${sideW}px`);
if (store.get('sidebarHidden', false)) body.classList.add('no-sidebar');

$('resizer').addEventListener('mousedown', (e) => {
  e.preventDefault();
  body.classList.add('resizing');
  const move = (ev) => {
    sideW = Math.min(560, Math.max(180, ev.clientX));
    body.style.setProperty('--side-w', `${sideW}px`);
  };
  const up = () => {
    body.classList.remove('resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    store.set('sideWidth', sideW);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'o') { e.preventDefault(); pickFolder(); }
  else if (k === 'b' || k === '\\') {
    e.preventDefault();
    store.set('sidebarHidden', body.classList.toggle('no-sidebar'));
  }
  else if (k === 'r') {
    e.preventDefault();
    if (state.root) loadTree();
    if (state.file) openFile(state.file, { keepScroll: true });
  }
  else if (k === 'p' || k === 'k') { e.preventDefault(); body.classList.remove('no-sidebar'); filterEl.focus(); filterEl.select(); }
  else if (k === '=' || k === '+' || k === ';') { e.preventDefault(); fontSize = Math.min(28, fontSize + 1); applyFont(); store.set('fontSize', fontSize); }
  else if (k === '-') { e.preventDefault(); fontSize = Math.max(11, fontSize - 1); applyFont(); store.set('fontSize', fontSize); }
  else if (k === '0') { e.preventDefault(); fontSize = 16; applyFont(); store.set('fontSize', fontSize); }
});

$('btn-open').addEventListener('click', pickFolder);
$('btn-open-empty').addEventListener('click', pickFolder);

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- start ----------
(async function init() {
  body.classList.add('is-empty');
  if (await takePending()) return;

  const lastRoot = store.get('lastRoot');
  const lastFile = store.get('lastFile');
  if (!lastRoot) return;
  try {
    await setRoot((await invoke('resolve_open', { path: lastRoot })).root);
    if (lastFile && isInside(lastFile, state.root)) await openFile(lastFile);
  } catch {
    store.set('lastRoot', null);
  }
})();
