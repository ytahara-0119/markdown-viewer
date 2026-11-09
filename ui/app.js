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
const searchScopeBtn = $('search-scope');
const tocPanel = $('toc-panel');
const tocNav = $('toc-nav');
const btnToc = $('btn-toc');
const ftsResults = $('fts-results');
const quickopen = $('quickopen');
const qoInput = $('quickopen-input');
const qoList = $('quickopen-list');

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
  renderMermaid();
  body.classList.remove('is-empty');
  $('pathbar-text').textContent = relPath(path);
  document.title = `${basename(path)} — MD Viewer`;

  revealInTree(path);
  store.set('lastFile', path);
  addRecent(path);

  if (anchor) scrollToAnchor(anchor);
  else scroller.scrollTop = keepScroll ? prevScroll : 0;

  buildToc();

  if (searchSt.open && searchInput.value) {
    searchSt.marks = [];
    searchSt.current = -1;
    if (searchSt.global) runFts();
    else runSearch();
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

  for (const pre of content.querySelectorAll('pre')) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'コピー';
    btn.setAttribute('aria-label', 'コードをコピー');
    btn.addEventListener('click', async () => {
      const text = (pre.querySelector('code') ?? pre).textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✓ コピー済み';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'コピー'; btn.classList.remove('copied'); }, 1800);
      } catch {
        toast('クリップボードへのコピーに失敗しました');
      }
    });
    pre.append(btn);
  }
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

// ---------- search (unified: ファイル内 / 全体) ----------
const searchSt = { open: false, marks: [], current: -1, regex: false, global: false };

function openSearch() {
  searchSt.open = true;
  searchBar.classList.add('visible');
  searchInput.focus();
  searchInput.select();
  if (searchInput.value) {
    if (searchSt.global) runFts();
    else runSearch();
  }
}

function closeSearch() {
  searchSt.open = false;
  searchBar.classList.remove('visible');
  clearSearchHighlights();
  if (searchSt.global) {
    searchSt.global = false;
    searchScopeBtn.textContent = 'ファイル内';
    searchScopeBtn.classList.remove('global');
    body.classList.remove('fts-mode');
    ftsResults.innerHTML = '';
  }
  scroller.focus();
}

function setSearchScope(isGlobal) {
  searchSt.global = isGlobal;
  searchScopeBtn.textContent = isGlobal ? '全体' : 'ファイル内';
  searchScopeBtn.classList.toggle('global', isGlobal);
  if (isGlobal) {
    clearSearchHighlights();
    body.classList.add('fts-mode');
    body.classList.remove('no-sidebar');
    if (searchInput.value) runFts();
  } else {
    body.classList.remove('fts-mode');
    ftsResults.innerHTML = '';
    if (searchInput.value) runSearch();
  }
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
  searchTimer = setTimeout(() => {
    if (searchSt.global) runFts();
    else runSearch();
  }, searchSt.global ? 250 : 120);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (!searchSt.global) navigateMatch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') closeSearch();
});
searchRegexBtn.addEventListener('click', () => {
  searchSt.regex = !searchSt.regex;
  searchRegexBtn.setAttribute('aria-pressed', String(searchSt.regex));
  if (searchInput.value) {
    if (searchSt.global) runFts();
    else runSearch();
  }
});
searchScopeBtn.addEventListener('click', () => setSearchScope(!searchSt.global));
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

// ---------- settings ----------
const settingsSt = {
  panel: false,
  width: store.get('contentWidth', 'standard'),
  theme: store.get('colorTheme', 'rose'),
  imgShadow: store.get('imgShadow', false),
};

function applyContentWidth(w) {
  body.classList.remove('width-narrow', 'width-wide');
  if (w === 'narrow') body.classList.add('width-narrow');
  else if (w === 'wide') body.classList.add('width-wide');
}

function applyColorTheme(t) {
  document.documentElement.classList.remove('theme-ocean', 'theme-mono');
  if (t === 'ocean') document.documentElement.classList.add('theme-ocean');
  else if (t === 'mono') document.documentElement.classList.add('theme-mono');
}

function applyImgShadow(on) {
  body.classList.toggle('img-shadow', on);
}

function openSettings() {
  settingsSt.panel = true;
  $('settings-panel').classList.add('visible');
  $('settings-panel').removeAttribute('aria-hidden');
  $('btn-settings').setAttribute('aria-expanded', 'true');
  updateSettingsUI();
}

function closeSettings() {
  settingsSt.panel = false;
  $('settings-panel').classList.remove('visible');
  $('settings-panel').setAttribute('aria-hidden', 'true');
  $('btn-settings').setAttribute('aria-expanded', 'false');
}

function updateSettingsUI() {
  for (const btn of $('width-choices').querySelectorAll('.settings-choice')) {
    btn.classList.toggle('active', btn.dataset.value === settingsSt.width);
  }
  for (const btn of $('theme-choices').querySelectorAll('.settings-choice')) {
    btn.classList.toggle('active', btn.dataset.value === settingsSt.theme);
  }
  $('toggle-img-shadow').setAttribute('aria-checked', String(settingsSt.imgShadow));
}

$('btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  if (settingsSt.panel) closeSettings();
  else openSettings();
});

$('width-choices').addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-choice');
  if (!btn) return;
  settingsSt.width = btn.dataset.value;
  store.set('contentWidth', settingsSt.width);
  applyContentWidth(settingsSt.width);
  updateSettingsUI();
});

$('theme-choices').addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-choice');
  if (!btn) return;
  settingsSt.theme = btn.dataset.value;
  store.set('colorTheme', settingsSt.theme);
  applyColorTheme(settingsSt.theme);
  if (state.file) openFile(state.file, { keepScroll: true });
  updateSettingsUI();
});

$('toggle-img-shadow').addEventListener('click', () => {
  settingsSt.imgShadow = !settingsSt.imgShadow;
  store.set('imgShadow', settingsSt.imgShadow);
  applyImgShadow(settingsSt.imgShadow);
  updateSettingsUI();
});

document.addEventListener('click', (e) => {
  if (settingsSt.panel && !$('settings-panel').contains(e.target)) closeSettings();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsSt.panel) closeSettings();
}, true);

// ---------- full-text search ----------
function highlightFts(text, query) {
  if (!query) return escapeHtml(text);
  try {
    const pattern = searchSt.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function runFts() {
  const q = searchInput.value.trim();
  if (!q || !state.root) { ftsResults.innerHTML = ''; return; }
  ftsResults.innerHTML = '<div class="fts-loading">検索中...</div>';
  try {
    const hits = await invoke('search_files', { root: state.root, query: q, isRegex: searchSt.regex });
    renderFtsResults(hits, q);
  } catch (e) {
    ftsResults.innerHTML = `<div class="fts-empty">${escapeHtml(String(e))}</div>`;
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
    fileBtn.addEventListener('click', () => openFtsFile(path));
    group.append(fileBtn);

    for (const hit of pathHits) {
      const btn = document.createElement('button');
      btn.className = 'fts-hit';
      btn.innerHTML = `<span class="fts-lnum">${hit.line}</span><span class="fts-text"></span>`;
      btn.querySelector('.fts-text').innerHTML = highlightFts(hit.text.trim(), query);
      btn.title = hit.text.trim();
      btn.addEventListener('click', () => openFtsFile(path));
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

async function openFtsFile(path) {
  // Switch to file-level scope first, then open — openFile will run doc search
  searchSt.global = false;
  searchScopeBtn.textContent = 'ファイル内';
  searchScopeBtn.classList.remove('global');
  body.classList.remove('fts-mode');
  ftsResults.innerHTML = '';
  await openFile(path);
}

// ---------- recent files / quick open ----------
const MAX_RECENTS = 30;

function addRecent(path) {
  const list = [path, ...store.get('recents', []).filter((p) => p !== path)].slice(0, MAX_RECENTS);
  store.set('recents', list);
}

function getRecents() {
  return store.get('recents', []);
}

let qoActiveIdx = -1;

function openQuickOpen() {
  quickopen.classList.add('visible');
  qoInput.value = '';
  qoActiveIdx = 0;
  renderQoList('');
  qoInput.focus();
}

function closeQuickOpen() {
  quickopen.classList.remove('visible');
  qoActiveIdx = -1;
}

function renderQoList(query) {
  const q = query.trim().toLowerCase();
  const all = getRecents();
  const items = q ? all.filter((p) => relPath(p).toLowerCase().includes(q) || basename(p).toLowerCase().includes(q)) : all;

  qoList.innerHTML = '';
  if (!items.length) {
    qoList.innerHTML = '<div class="qo-empty">一致するファイルがありません</div>';
    qoActiveIdx = -1;
    return;
  }
  qoActiveIdx = Math.max(0, Math.min(qoActiveIdx, items.length - 1));

  for (let i = 0; i < items.length; i++) {
    const path = items[i];
    const name = basename(path);
    const dir = isInside(path, state.root) ? relPath(path).split('/').slice(0, -1).join('/') : path.split('/').slice(0, -1).join('/');

    const btn = document.createElement('button');
    btn.className = 'qo-item' + (i === qoActiveIdx ? ' active' : '');
    btn.dataset.path = path;
    btn.innerHTML = '<span class="file-dot"></span><span class="qo-name"></span><span class="qo-dir"></span>';
    btn.querySelector('.qo-name').textContent = name;
    btn.querySelector('.qo-dir').textContent = dir;
    btn.addEventListener('click', () => openRecentFile(path));
    btn.addEventListener('mouseenter', () => {
      qoList.querySelectorAll('.qo-item.active').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      qoActiveIdx = i;
    });
    qoList.append(btn);
  }
}

function qoNavigate(dir) {
  const items = [...qoList.querySelectorAll('.qo-item')];
  if (!items.length) return;
  if (qoActiveIdx >= 0) items[qoActiveIdx]?.classList.remove('active');
  qoActiveIdx = Math.max(0, Math.min(items.length - 1, qoActiveIdx + dir));
  items[qoActiveIdx].classList.add('active');
  items[qoActiveIdx].scrollIntoView({ block: 'nearest' });
}

async function openRecentFile(path) {
  closeQuickOpen();
  if (state.root && isInside(path, state.root)) await openFile(path);
  else await openPath(path);
}

qoInput.addEventListener('input', () => {
  qoActiveIdx = 0;
  renderQoList(qoInput.value);
});
qoInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); qoNavigate(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qoNavigate(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const active = qoList.querySelector('.qo-item.active') ?? qoList.querySelector('.qo-item');
    if (active) openRecentFile(active.dataset.path);
  }
  else if (e.key === 'Escape') closeQuickOpen();
});
quickopen.addEventListener('click', (e) => { if (e.target === quickopen) closeQuickOpen(); });

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

// ---------- mermaid ----------
let mermaidSeq = 0;

function initMermaid() {
  const isDark = document.documentElement.classList.contains('dark');
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif',
  });
}

async function renderMermaid() {
  const blocks = [...content.querySelectorAll('pre code.language-mermaid')];
  if (!blocks.length) return;
  for (const code of blocks) {
    const pre = code.closest('pre');
    if (!pre || !pre.isConnected) continue;
    const text = code.textContent;
    const id = `mermaid-${++mermaidSeq}`;
    try {
      const { svg } = await mermaid.render(id, text);
      if (!pre.isConnected) continue;
      const div = document.createElement('div');
      div.className = 'mermaid-diagram';
      div.innerHTML = svg;
      pre.replaceWith(div);
    } catch {
      pre.classList.add('mermaid-error');
    }
  }
}

// ---------- appearance ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  document.documentElement.classList.toggle('dark', darkQuery.matches);
  initMermaid();
  if (state.file) openFile(state.file, { keepScroll: true });
};
darkQuery.addEventListener('change', applyTheme);
initMermaid();

applyContentWidth(settingsSt.width);
applyColorTheme(settingsSt.theme);
applyImgShadow(settingsSt.imgShadow);

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
  else if (k === 'p') { e.preventDefault(); openQuickOpen(); }
  else if (k === ',') { e.preventDefault(); if (settingsSt.panel) closeSettings(); else openSettings(); }
  else if (k === 'k') { e.preventDefault(); body.classList.remove('no-sidebar'); filterEl.focus(); filterEl.select(); }
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
