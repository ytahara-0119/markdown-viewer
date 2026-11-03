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
const searchBar = $('search-bar');
const searchInput = $('search-input');
const searchCount = $('search-count');
const searchRegexBtn = $('search-regex');
const tocPanel = $('toc-panel');
const tocNav = $('toc-nav');
const btnToc = $('btn-toc');
const ftsInput = $('fts-input');
const ftsResults = $('fts-results');
const ftsRegexBtn = $('fts-regex');

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
  $('pathbar-text').textContent = relPath(path);
  document.title = `${basename(path)} — MD Viewer`;

  revealInTree(path);
  store.set('lastFile', path);

  if (anchor) scrollToAnchor(anchor);
  else scroller.scrollTop = keepScroll ? prevScroll : 0;

  buildToc();

  if (searchSt.open && searchInput.value) {
    searchSt.marks = [];
    searchSt.current = -1;
    runSearch();
  }
}

function showEmpty() {
  state.file = null;
  content.innerHTML = '';
  $('pathbar-text').textContent = '';
  document.title = 'MD Viewer';
  body.classList.add('is-empty');
  renderTree();
  tocNav.innerHTML = '';
  tocPanel.classList.remove('visible');
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

// ---------- search ----------
const searchSt = { open: false, marks: [], current: -1, regex: false };

function openSearch() {
  searchSt.open = true;
  searchBar.classList.add('visible');
  searchInput.focus();
  searchInput.select();
  if (searchInput.value) runSearch();
}

function closeSearch() {
  searchSt.open = false;
  searchBar.classList.remove('visible');
  clearSearchHighlights();
  scroller.focus();
}

function clearSearchHighlights() {
  for (const mark of searchSt.marks) {
    if (!mark.isConnected) continue;
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  searchSt.marks = [];
  searchSt.current = -1;
  searchCount.textContent = '';
}

function runSearch() {
  clearSearchHighlights();
  const query = searchInput.value;
  if (!query) return;

  let pattern;
  try {
    pattern = searchSt.regex
      ? new RegExp(query, 'gi')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch {
    searchCount.textContent = '無効な正規表現';
    return;
  }

  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || p.tagName === 'SCRIPT' || p.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.textContent;
    pattern.lastIndex = 0;
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) continue;
    const parent = node.parentNode;
    if (!parent) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'search-mark';
      mark.textContent = m[0];
      frag.append(mark);
      searchSt.marks.push(mark);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
  }

  if (searchSt.marks.length) {
    searchSt.current = 0;
    searchSt.marks[0].classList.add('current');
    searchSt.marks[0].scrollIntoView({ block: 'center' });
  }
  updateSearchCount();
}

function updateSearchCount() {
  const total = searchSt.marks.length;
  if (!total) searchCount.textContent = searchInput.value ? '一致なし' : '';
  else searchCount.textContent = `${searchSt.current + 1} / ${total}`;
}

function navigateMatch(dir) {
  if (!searchSt.marks.length) return;
  searchSt.marks[searchSt.current].classList.remove('current');
  searchSt.current = (searchSt.current + dir + searchSt.marks.length) % searchSt.marks.length;
  const mark = searchSt.marks[searchSt.current];
  mark.classList.add('current');
  mark.scrollIntoView({ block: 'center' });
  updateSearchCount();
}

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); navigateMatch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') closeSearch();
});
searchRegexBtn.addEventListener('click', () => {
  searchSt.regex = !searchSt.regex;
  searchRegexBtn.setAttribute('aria-pressed', String(searchSt.regex));
  if (searchInput.value) runSearch();
});
$('search-prev').addEventListener('click', () => navigateMatch(-1));
$('search-next').addEventListener('click', () => navigateMatch(1));
$('search-close').addEventListener('click', closeSearch);

// ---------- TOC ----------
let tocVisible = store.get('tocVisible', false);

function buildToc() {
  tocNav.innerHTML = '';
  const headings = [...content.querySelectorAll('h1, h2, h3')];
  if (!headings.length) {
    const empty = document.createElement('div');
    empty.className = 'toc-empty';
    empty.textContent = '見出しなし';
    tocNav.append(empty);
    return;
  }
  for (const h of headings) {
    const btn = document.createElement('button');
    btn.className = 'toc-item';
    btn.dataset.level = h.tagName[1];
    btn.dataset.id = h.id;
    btn.textContent = h.textContent;
    btn.title = h.textContent;
    btn.addEventListener('click', () => scrollToAnchor(h.id));
    tocNav.append(btn);
  }
  applyTocVisible();
  updateTocActive();
}

function applyTocVisible() {
  tocPanel.classList.toggle('visible', tocVisible);
  btnToc.setAttribute('aria-pressed', String(tocVisible));
}

function toggleToc() {
  tocVisible = !tocVisible;
  applyTocVisible();
  store.set('tocVisible', tocVisible);
  if (tocVisible) updateTocActive();
}

function updateTocActive() {
  if (!tocVisible) return;
  const items = [...tocNav.querySelectorAll('.toc-item[data-id]')];
  if (!items.length) return;
  const headings = [...content.querySelectorAll('h1, h2, h3')];
  const scrollerTop = scroller.getBoundingClientRect().top;
  const threshold = 80;
  let activeId = headings[0]?.id ?? null;
  for (const h of headings) {
    if (h.getBoundingClientRect().top - scrollerTop <= threshold) activeId = h.id;
    else break;
  }
  let activeItem = null;
  for (const item of items) {
    const isActive = item.dataset.id === activeId;
    item.classList.toggle('active', isActive);
    if (isActive) activeItem = item;
  }
  if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
}

const progressBar = $('progress-bar');
function updateProgressBar() {
  const { scrollTop, scrollHeight, clientHeight } = scroller;
  const pct = scrollHeight <= clientHeight ? 0 : (scrollTop / (scrollHeight - clientHeight)) * 100;
  progressBar.style.setProperty('--scroll-pct', `${pct.toFixed(2)}%`);
}

scroller.addEventListener('scroll', () => { updateTocActive(); updateProgressBar(); }, { passive: true });
btnToc.addEventListener('click', toggleToc);

// ---------- full-text search ----------
const ftsSt = { regex: false };

function openFts() {
  body.classList.add('fts-mode');
  body.classList.remove('no-sidebar');
  ftsInput.focus();
  ftsInput.select();
}

function closeFts() {
  body.classList.remove('fts-mode');
  ftsResults.innerHTML = '';
  ftsInput.value = '';
}

function highlightFts(text, query) {
  if (!query) return escapeHtml(text);
  try {
    const pattern = ftsSt.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(pattern, 'gi');
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      parts.push(escapeHtml(text.slice(last, m.index)));
      parts.push(`<mark class="fts-mark">${escapeHtml(m[0])}</mark>`);
      last = m.index + m[0].length;
    }
    parts.push(escapeHtml(text.slice(last)));
    return parts.join('');
  } catch {
    return escapeHtml(text);
  }
}

function renderFtsResults(hits, query) {
  ftsResults.innerHTML = '';
  if (!hits.length) {
    ftsResults.innerHTML = '<div class="fts-empty">一致なし</div>';
    return;
  }
  const groups = new Map();
  for (const hit of hits) {
    if (!groups.has(hit.path)) groups.set(hit.path, []);
    groups.get(hit.path).push(hit);
  }
  const capped = hits.length >= 300;
  const summary = document.createElement('div');
  summary.className = 'fts-summary';
  summary.textContent = capped
    ? `300件以上 — ${groups.size}ファイル`
    : `${hits.length}件 — ${groups.size}ファイル`;
  ftsResults.append(summary);

  for (const [path, pathHits] of groups) {
    const group = document.createElement('div');
    group.className = 'fts-group';
    const rel = relPath(path);
    const namePart = rel.split('/').pop();
    const dirPart = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

    const fileBtn = document.createElement('button');
    fileBtn.className = 'fts-file-btn';
    fileBtn.innerHTML = '<span class="fts-fname"></span><span class="fts-badge"></span>';
    fileBtn.querySelector('.fts-fname').textContent = namePart;
    if (dirPart) {
      const dir = document.createElement('span');
      dir.className = 'fts-fdir';
      dir.textContent = dirPart;
      fileBtn.insertBefore(dir, fileBtn.querySelector('.fts-badge'));
    }
    fileBtn.querySelector('.fts-badge').textContent = pathHits.length;
    fileBtn.addEventListener('click', () => openFtsFile(path, query));
    group.append(fileBtn);

    for (const hit of pathHits) {
      const btn = document.createElement('button');
      btn.className = 'fts-hit';
      btn.innerHTML = `<span class="fts-lnum">${hit.line}</span><span class="fts-text"></span>`;
      btn.querySelector('.fts-text').innerHTML = highlightFts(hit.text.trim(), query);
      btn.title = hit.text.trim();
      btn.addEventListener('click', () => openFtsFile(path, query));
      group.append(btn);
    }
    ftsResults.append(group);
  }
  if (capped) {
    const note = document.createElement('div');
    note.className = 'fts-empty';
    note.textContent = '上位300件を表示。検索語を絞り込んでください。';
    ftsResults.append(note);
  }
}

async function openFtsFile(path, query) {
  await openFile(path);
  if (query) {
    searchInput.value = query;
    searchSt.regex = ftsSt.regex;
    searchRegexBtn.setAttribute('aria-pressed', String(ftsSt.regex));
    openSearch();
  }
}

let ftsTimer;
ftsInput.addEventListener('input', () => {
  clearTimeout(ftsTimer);
  const q = ftsInput.value.trim();
  if (!q) { ftsResults.innerHTML = ''; return; }
  ftsResults.innerHTML = '<div class="fts-loading">検索中...</div>';
  ftsTimer = setTimeout(async () => {
    try {
      const hits = await invoke('search_files', { root: state.root, query: q, isRegex: ftsSt.regex });
      renderFtsResults(hits, q);
    } catch (e) {
      ftsResults.innerHTML = `<div class="fts-empty">${escapeHtml(String(e))}</div>`;
    }
  }, 250);
});
ftsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFts();
});
ftsRegexBtn.addEventListener('click', () => {
  ftsSt.regex = !ftsSt.regex;
  ftsRegexBtn.setAttribute('aria-pressed', String(ftsSt.regex));
  if (ftsInput.value.trim()) ftsInput.dispatchEvent(new Event('input'));
});
$('fts-close').addEventListener('click', closeFts);

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
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); if (state.root) openFts(); }
  else if (k === 'f') { e.preventDefault(); openSearch(); }
  else if (k === 't') { e.preventDefault(); if (state.file) toggleToc(); }
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
