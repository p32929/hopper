(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Tiny helpers
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  /** h('div', {class: 'x', onclick: fn}, 'text', childNode) — builds DOM without innerHTML. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'data') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls ? `ic ${cls}` : 'ic');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function setIcon(button, name) {
    button.querySelector('use').setAttribute('href', `#i-${name}`);
  }

  function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let n = bytes / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
  }

  function formatDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString(undefined, sameYear
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    if (sec < 60) return `${Math.ceil(sec)}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(`fm.${k}`)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`fm.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  function toast(message, type = 'info') {
    const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
    $('toasts').append(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }

  async function api(url, options = {}) {
    const init = { ...options };
    if (init.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(init.json);
      delete init.json;
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      throw Object.assign(new Error('Cannot reach the server'), { network: true });
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || data.blocked) { location.reload(); throw Object.assign(new Error('Signing in again…'), { status: res.status }); }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
    return data;
  }

  const qs = (obj) => new URLSearchParams(obj).toString();
  const downloadUrl = (p, inline) => `/api/download?${qs(inline ? { path: p, inline: 1 } : { path: p })}`;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const S = {
    info: null,
    path: null,
    parent: null,
    sep: '/',
    entries: [],
    selected: new Set(),
    lastChecked: null,
    view: store.get('view', 'list'),
    sort: store.get('sort', { key: 'name', dir: 1 }),
    showHidden: store.get('hidden', false),
    filter: '',
    error: null,
    loading: false,
  };

  const join = (dir, name) => (dir.endsWith(S.sep) ? dir + name : dir + S.sep + name);
  const isHidden = (e) => e.name.startsWith('.');

  function visibleEntries() {
    const f = S.filter.trim().toLowerCase();
    const { key, dir } = S.sort;
    return S.entries
      .filter((e) => (S.showHidden || !isHidden(e)) && (!f || e.name.toLowerCase().includes(f)))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        let r;
        if (key === 'size') r = (a.size ?? -1) - (b.size ?? -1);
        else if (key === 'modified') r = (a.modified ?? 0) - (b.modified ?? 0);
        else r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        return (r || a.name.localeCompare(b.name)) * dir;
      });
  }

  const selectedEntries = () => S.entries.filter((e) => S.selected.has(e.name));

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------
  const hashFor = (p) => `#${encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  const pathFromHash = () => (location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null);

  async function navigate(target, { push = true } = {}) {
    S.loading = true;
    try {
      const data = await api(`/api/list?${qs({ path: target })}`);
      S.path = data.path;
      S.parent = data.parent;
      S.sep = data.sep;
      S.entries = data.entries;
      S.error = null;
      S.selected.clear();
      S.lastChecked = null;
      S.filter = '';
      $('search').value = '';
      store.set('path', S.path);
      if (push && pathFromHash() !== S.path) location.hash = hashFor(S.path);
      document.title = `${S.path.split(/[\\/]/).filter(Boolean).pop() || S.path} · Hopper`;
    } catch (err) {
      S.error = { message: err.message, path: target };
      if (!S.path) S.path = target;
    } finally {
      S.loading = false;
    }
    render();
  }

  const refresh = () => navigate(S.path, { push: false });

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function render() {
    renderPlaces();
    renderCrumbs();
    renderHead();
    renderList();
    renderActions();
    renderStatus();
    $('btn-up').disabled = !S.parent;
    $('content').classList.toggle('is-grid', S.view === 'grid');
    setIcon($('btn-view'), S.view === 'grid' ? 'list' : 'grid');
    $('btn-hidden').classList.toggle('on', S.showHidden);
    $('side-hidden').classList.toggle('on', S.showHidden);
    $('side-theme').querySelector('span').textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
    setIcon($('btn-theme'), document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
  }

  function renderPlaces() {
    const nav = $('places');
    nav.replaceChildren();
    for (const p of S.info.places) {
      const active = S.path === p.path;
      nav.append(h('button', {
        class: `place${active ? ' active' : ''}`,
        data: { path: p.path },
        'aria-current': active ? 'page' : undefined,
        onclick: () => { closeMenu(); navigate(p.path); },
      }, icon(p.icon), h('span', {}, p.name)));
    }
  }

  function crumbParts() {
    if (!S.path) return [];
    const win = S.sep === '\\';
    const raw = S.path.split(/[\\/]/).filter(Boolean);
    const parts = [];
    let acc = '';
    if (win) {
      acc = `${raw.shift()}\\`;
      parts.push({ label: acc.slice(0, 2), path: acc });
    } else {
      parts.push({ label: '/', path: '/' });
      acc = '';
    }
    for (const seg of raw) {
      acc = win ? join(acc, seg) : `${acc}/${seg}`;
      parts.push({ label: seg, path: acc });
    }
    const root = S.info.root;
    if (root) {
      const i = parts.findIndex((p) => p.path === root);
      if (i > 0) return parts.slice(i);
    }
    return parts;
  }

  function renderCrumbs() {
    const box = $('crumbs');
    box.classList.remove('editing');
    box.replaceChildren();
    const parts = crumbParts();
    parts.forEach((p, i) => {
      if (i > 0) box.append(h('span', { class: 'crumb-sep' }, icon('chevron-right')));
      box.append(h('button', {
        class: 'crumb',
        data: { path: p.path },
        onclick: (e) => { e.stopPropagation(); navigate(p.path); },
      }, p.label));
    });
    box.scrollLeft = box.scrollWidth;
  }

  function editPath() {
    const box = $('crumbs');
    if (box.classList.contains('editing')) return;
    box.classList.add('editing');
    box.replaceChildren();
    const input = h('input', { type: 'text', 'aria-label': 'Folder path', spellcheck: 'false', value: S.path });
    input.value = S.path;
    box.append(input);
    input.focus();
    input.select();
    const done = (go) => {
      const v = input.value.trim();
      if (go && v && v !== S.path) navigate(v);
      else renderCrumbs();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.dataset.done = '1'; done(true); }
      if (e.key === 'Escape') { input.dataset.done = '1'; done(false); }
    });
    input.addEventListener('blur', () => { if (!input.dataset.done) done(false); });
  }

  function sortButton(key, label, cls) {
    const active = S.sort.key === key;
    return h('button', {
      class: cls,
      data: { sort: key },
      'aria-label': `Sort by ${label.toLowerCase()}`,
      onclick: () => {
        S.sort = { key, dir: active ? -S.sort.dir : 1 };
        store.set('sort', S.sort);
        renderHead();
        renderList();
      },
    }, label, active ? icon(S.sort.dir === 1 ? 'chevron-up' : 'chevron-down') : null);
  }

  function renderHead() {
    const head = $('list-head');
    head.replaceChildren();
    const all = h('input', {
      type: 'checkbox', class: 'check', id: 'check-all', 'aria-label': 'Select all',
      onchange: (e) => {
        const vis = visibleEntries();
        S.selected = e.target.checked ? new Set(vis.map((x) => x.name)) : new Set();
        renderList();
        renderActions();
      },
    });
    head.append(all, sortButton('name', 'Name'), sortButton('modified', 'Modified', 'col-modified'), sortButton('size', 'Size', 'right'), h('span'));
  }

  function kindIcon(entry) {
    const map = { folder: 'folder', image: 'image', video: 'video', audio: 'music', archive: 'archive', document: 'file-text', code: 'code' };
    return map[entry.kind] || 'file';
  }

  function badge(entry) {
    return h('span', { class: `badge kind-${entry.kind}` }, icon(kindIcon(entry)));
  }

  function renderList() {
    const listing = $('listing');
    const empty = $('empty');
    listing.replaceChildren();
    listing.className = `listing${S.view === 'grid' ? ' grid' : ''}`;
    const rows = visibleEntries();

    $('list-head').hidden = Boolean(S.error) || (!rows.length);
    empty.hidden = true;

    if (S.error) {
      showEmpty('alert', "Can't open this folder", S.error.message, S.info.home !== S.path ? { label: 'Go to Home', run: () => navigate(S.info.home) } : null);
      return;
    }
    if (!rows.length) {
      const filtering = S.filter.trim();
      const hiddenCount = S.entries.filter(isHidden).length;
      if (filtering) showEmpty('search', 'No matches', `Nothing in this folder matches "${S.filter.trim()}".`);
      else if (S.entries.length && !S.showHidden && hiddenCount === S.entries.length) showEmpty('eye', 'Only hidden files here', 'Use the eye button in the top bar to show them.');
      else showEmpty('folder', 'This folder is empty', 'Drop files anywhere on this page, or use Upload files.', { label: 'Upload files', run: () => $('file-input').click() });
      return;
    }

    const frag = document.createDocumentFragment();
    for (const e of rows) frag.append(renderRow(e));
    listing.append(frag);
    const all = $('check-all');
    if (all) all.checked = rows.length > 0 && rows.every((e) => S.selected.has(e.name));
  }

  function showEmpty(iconName, title, text, action) {
    const empty = $('empty');
    empty.hidden = false;
    empty.replaceChildren(
      h('span', { class: 'badge kind-other' }, icon(iconName)),
      h('strong', {}, title),
      h('span', {}, text),
      action ? h('button', { class: 'btn primary', style: 'margin-top:12px', onclick: action.run }, action.label) : null,
    );
    empty.dataset.testid = 'empty-state';
  }

  function rowAction(name, label, cls, onclick) {
    return h('button', {
      class: `icon-btn small ${cls}`, 'aria-label': label, title: label,
      onclick: (ev) => { ev.stopPropagation(); onclick(); },
    }, icon(name));
  }

  function renderRow(e) {
    const full = join(S.path, e.name);
    const isDir = e.type === 'dir';
    const selected = S.selected.has(e.name);

    const check = h('input', {
      type: 'checkbox', class: 'check', 'aria-label': `Select ${e.name}`,
      onclick: (ev) => ev.stopPropagation(),
      onchange: (ev) => toggleSelect(e.name, ev.target.checked, ev.shiftKey || ev.target._shift),
    });
    check.checked = selected;
    check.addEventListener('click', (ev) => { check._shift = ev.shiftKey; });

    const isImage = e.kind === 'image' && !e.broken;
    // Image thumbnails fall back to the file icon if the picture cannot be shown
    const thumb = isImage ? h('img', { class: S.view === 'grid' ? '' : 'thumb', src: downloadUrl(full, true), loading: 'lazy', alt: '' }) : null;
    thumb?.addEventListener('error', () => thumb.replaceWith(badge(e)));
    const lead = S.view === 'grid' ? h('div', { class: 'tile' }, thumb || badge(e)) : thumb || badge(e);

    const name = h('span', { class: 'label', title: e.name }, e.name);
    const nameCell = S.view === 'grid'
      ? h('div', { class: 'cell-name' }, lead, h('div', { class: 'meta' }, name, h('span', { class: 'muted' }, isDir ? 'Folder' : formatSize(e.size))))
      : h('div', { class: 'cell-name' }, lead, name);

    const actions = h('div', { class: 'row-actions' },
      rowAction('download', isDir ? 'Download as ZIP' : 'Download', 'act-download', () => downloadEntries([e])),
      rowAction('pencil', 'Rename', 'act-rename', () => renameEntry(e)),
      rowAction('trash', 'Delete', 'act-delete', () => deleteEntries([e])));

    const row = h('div', {
      class: `row${selected ? ' selected' : ''}${isHidden(e) ? ' is-hidden' : ''}`,
      role: 'row',
      tabindex: '0',
      data: { testid: 'row', name: e.name, type: e.type, path: full },
      onclick: () => openEntry(e),
      onkeydown: (ev) => { if (ev.key === 'Enter' && ev.target === row) openEntry(e); },
    }, check, nameCell, h('span', { class: 'muted modified' }, formatDate(e.modified)), h('span', { class: 'size' }, isDir ? '—' : formatSize(e.size)), actions);
    return row;
  }

  function toggleSelect(name, on, range) {
    const vis = visibleEntries().map((x) => x.name);
    if (range && S.lastChecked && vis.includes(S.lastChecked)) {
      const [a, b] = [vis.indexOf(S.lastChecked), vis.indexOf(name)].sort((x, y) => x - y);
      for (const n of vis.slice(a, b + 1)) on ? S.selected.add(n) : S.selected.delete(n);
    } else if (on) S.selected.add(name);
    else S.selected.delete(name);
    S.lastChecked = name;
    renderList();
    renderActions();
  }

  function renderActions() {
    const sel = selectedEntries();
    document.body.classList.toggle('has-selection', sel.length > 0);
    $('actions-default').hidden = sel.length > 0;
    $('actions-selected').hidden = sel.length === 0;
    if (!sel.length) return;
    $('sel-count').textContent = `${sel.length} selected`;
    const single = sel.length === 1 && sel[0].type === 'file';
    $('btn-download-label').textContent = single ? 'Download' : 'Download as ZIP';
    $('btn-download').setAttribute('aria-label', single ? 'Download' : 'Download as ZIP');
    $('btn-rename').hidden = sel.length !== 1;
  }

  function renderStatus() {
    const vis = visibleEntries();
    const dirs = vis.filter((e) => e.type === 'dir').length;
    const files = vis.length - dirs;
    const bytes = vis.reduce((n, e) => n + (e.size || 0), 0);
    const parts = [plural(dirs, 'folder'), plural(files, 'file')];
    if (files) parts.push(formatSize(bytes));
    const hidden = S.entries.filter(isHidden).length;
    if (!S.showHidden && hidden) parts.push(`${hidden} hidden`);
    $('status').replaceChildren(S.error ? '' : parts.join(' · '));
  }

  // ------------------------------------------------------------------
  // Dialogs
  // ------------------------------------------------------------------
  function dialog(build, cls) {
    return new Promise((resolve) => {
      const dlg = h('dialog', { class: cls });
      let result = null;
      const close = (value) => { result = value; dlg.close(); };
      dlg.append(build(close, dlg));
      dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  function promptName({ title, label, value = '', confirm, validate }) {
    return dialog((close, dlg) => {
      const input = h('input', { type: 'text', id: 'dlg-input', 'aria-label': label, spellcheck: 'false', autocomplete: 'off' });
      input.value = value;
      const error = h('div', { class: 'error-text', role: 'alert' });
      const form = h('form', {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          const v = input.value.trim();
          if (!v) { error.textContent = 'Please enter a name.'; return; }
          if (/[\\/]/.test(v)) { error.textContent = 'A name cannot contain / or \\.'; return; }
          const problem = validate ? await validate(v) : null;
          if (problem) { error.textContent = problem; return; }
          close(v);
        },
      },
      h('h2', {}, title), h('label', { class: 'muted', for: 'dlg-input' }, label), input, error,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit', id: 'dlg-ok' }, confirm)));
      queueMicrotask(() => {
        input.focus();
        const dot = value.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : value.length);
      });
      return form;
    });
  }

  function confirmDialog({ title, text, items = [], confirm, danger }) {
    return dialog((close) => h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); close(true); } },
      h('h2', {}, title),
      h('p', {}, text),
      items.length ? h('ul', {}, items.slice(0, 6).map((n) => h('li', {}, n)), items.length > 6 ? h('li', {}, `and ${items.length - 6} more`) : null) : null,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'submit', id: 'dlg-ok' }, confirm))))
      .then(Boolean);
  }

  // ------------------------------------------------------------------
  // File operations
  // ------------------------------------------------------------------
  function openEntry(e) {
    if (e.type === 'dir') return navigate(join(S.path, e.name));
    if (e.preview) return openPreview(e);
    return downloadEntries([e]);
  }

  // ---- previews: images, video, audio, PDF and any text or code file ----
  const MAX_TEXT = 2 * 1024 * 1024;
  const MAX_LINES = 5000;
  const MAX_HIGHLIGHT = 400 * 1024;

  const KEYWORDS = new Set(('abstract and as assert async await begin bool boolean break by case catch char class const constructor continue ' +
    'create def default defer del delete do double elif else elsif end enum except export extends extern false final finally float fn for from func ' +
    'function global go goto group if impl implements import in include insert int interface is join lambda let limit long loop match mod module new nil ' +
    'none not null on or order override package pass private protected pub public raise readonly ref require return select self set static string ' +
    'struct super switch table this throw trait true try type typeof undefined union unsafe update use using val values var void volatile where while ' +
    'with yield').split(' '));
  const HASH_COMMENT = new Set('py sh bash zsh fish yml yaml toml rb conf ini env properties r ps1 tf gradle dockerfile makefile'.split(' '));
  const SLASH_COMMENT = new Set('js mjs cjs ts tsx jsx java kt kts swift c cpp cc h hpp cs go rs php dart scss less css jsonc vue svelte astro proto graphql gql'.split(' '));
  const MARKUP = new Set('html htm xml vue svelte astro'.split(' '));
  const PLAIN_CODE = new Set(['json', 'sql', 'lua', 'bat', 'diff', 'patch']);

  /** Splits code into [type, text] pieces. Types: comment, string, number, keyword, tag, plain. */
  function tokenize(text, ext) {
    const hash = HASH_COMMENT.has(ext);
    const slash = SLASH_COMMENT.has(ext);
    const markup = MARKUP.has(ext);
    if (!(hash || slash || markup || PLAIN_CODE.has(ext)) || text.length > MAX_HIGHLIGHT) return [['plain', text]];
    const parts = [];
    if (slash) parts.push('(?<c>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))');
    else if (hash) parts.push('(?<c>#[^\\n]*)');
    else if (markup) parts.push('(?<c><!--[\\s\\S]*?(?:-->|$))');
    else if (ext === 'sql' || ext === 'lua') parts.push('(?<c>--[^\\n]*)');
    else parts.push('(?<c>(?!))');
    parts.push('(?<s>"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?|`(?:\\\\.|[^`\\\\])*`?)');
    if (markup) parts.push('(?<t></?[A-Za-z][\\w:.-]*)');
    parts.push('(?<n>\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b)', '(?<w>[A-Za-z_][\\w]*)');
    const re = new RegExp(parts.join('|'), 'g');
    const out = [];
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (m.index > last) out.push(['plain', text.slice(last, m.index)]);
      const g = m.groups;
      if (g.c !== undefined) out.push(['comment', m[0]]);
      else if (g.s !== undefined) out.push(['string', m[0]]);
      else if (g.t !== undefined) out.push(['tag', m[0]]);
      else if (g.n !== undefined) out.push(['number', m[0]]);
      else if (KEYWORDS.has(m[0]) && !markup) out.push(['keyword', m[0]]);
      else out.push(['plain', m[0]]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(['plain', text.slice(last)]);
    return out;
  }

  function codeView(text, ext) {
    const code = h('pre', { class: 'code', tabindex: '0', 'data-testid': 'code' });
    let line = h('span', { class: 'line' });
    let lines = 1;
    let cut = false;
    const frag = document.createDocumentFragment();
    outer:
    for (const [type, chunk] of tokenize(text, ext)) {
      const pieces = chunk.split('\n');
      for (let i = 0; i < pieces.length; i++) {
        if (i > 0) {
          frag.append(line);
          if (++lines > MAX_LINES) { cut = true; line = null; break outer; }
          line = h('span', { class: 'line' });
        }
        if (pieces[i]) line.append(type === 'plain' ? document.createTextNode(pieces[i]) : h('span', { class: `tk-${type}` }, pieces[i]));
      }
    }
    if (line) frag.append(line);
    code.append(frag);
    return { node: code, cut };
  }

  const fmtSizeShort = (n) => formatSize(n);

  async function renderPreview(entry, body, ctx) {
    body.replaceChildren();
    const full = join(S.path, entry.name);
    const url = downloadUrl(full, true);
    const fail = (msg) => body.replaceChildren(h('div', { class: 'preview-msg', 'data-testid': 'preview-fail' },
      h('strong', {}, msg), h('a', { class: 'btn primary', href: downloadUrl(full), download: entry.name }, icon('download'), 'Download')));

    if (entry.preview === 'image') {
      const img = h('img', { src: url, alt: entry.name });
      img.addEventListener('error', () => fail("This image can't be shown in the browser."));
      body.append(img);
    } else if (entry.preview === 'video' || entry.preview === 'audio') {
      const media = h(entry.preview, { src: url, controls: true, autoplay: true });
      media.addEventListener('error', () => fail("Your browser can't play this file."));
      ctx.media = media;
      body.append(media);
    } else if (entry.preview === 'pdf') {
      body.append(h('iframe', { src: url, title: entry.name }));
    } else {
      body.append(h('div', { class: 'preview-msg' }, h('span', { class: 'muted' }, 'Loading…')));
      let res;
      try {
        res = await fetch(url, { headers: { Range: `bytes=0-${MAX_TEXT - 1}` } });
      } catch { return fail('Cannot reach the server.'); }
      if (ctx.entry !== entry) return; // user moved on
      if (!res.ok) return fail("This file can't be opened.");
      if (!(res.headers.get('content-type') || '').startsWith('text/')) {
        // looked like text from its name, but it is binary: just download it
        if (ctx.single) { ctx.close(); downloadEntries([entry]); return; }
        return fail("This file isn't text, so it can't be shown.");
      }
      const buf = await res.arrayBuffer();
      if (ctx.entry !== entry) return;
      const text = new TextDecoder('utf-8').decode(buf);
      const total = Number((res.headers.get('content-range') || '').split('/')[1]) || buf.byteLength;
      const { node, cut } = codeView(text, entry.ext || entry.name.toLowerCase());
      body.replaceChildren(node);
      if (total > buf.byteLength || cut) {
        body.append(h('div', { class: 'preview-note' }, cut ? `Showing the first ${MAX_LINES.toLocaleString()} lines.` : `Showing the first ${fmtSizeShort(buf.byteLength)} of ${fmtSizeShort(total)}.`, ' ',
          h('a', { href: downloadUrl(full), download: entry.name }, 'Download the whole file')));
        body.classList.add('has-note');
      }
      if (!text.length) node.append(h('span', { class: 'line muted' }, '(empty file)'));
    }
  }

  function openPreview(start) {
    const siblings = start.preview === 'maybe' ? [start]
      : visibleEntries().filter((x) => x.type === 'file' && x.preview && x.preview !== 'maybe');
    const ctx = { entry: start, media: null, single: start.preview === 'maybe', close: () => {} };
    let index = Math.max(0, siblings.findIndex((x) => x.name === start.name));

    dialog((close, dlg) => {
      ctx.close = () => close(null);
      const title = h('strong', {}, '');
      const sub = h('span', { class: 'muted preview-sub' }, '');
      const count = h('span', { class: 'muted preview-count' }, '');
      const dl = h('a', { class: 'btn', title: 'Download' }, icon('download'), h('span', {}, 'Download'));
      const prev = h('button', { class: 'icon-btn', 'aria-label': 'Previous file', title: 'Previous (←)', onclick: () => go(-1) }, icon('chevron-left'));
      const next = h('button', { class: 'icon-btn', 'aria-label': 'Next file', title: 'Next (→)', onclick: () => go(1) }, icon('chevron-right'));
      const body = h('div', { class: 'preview-body' });

      function show() {
        const e = siblings[index];
        ctx.media?.pause();
        ctx.media = null;
        ctx.entry = e;
        title.textContent = e.name;
        sub.textContent = formatSize(e.size);
        count.textContent = siblings.length > 1 ? `${index + 1} / ${siblings.length}` : '';
        dl.href = downloadUrl(join(S.path, e.name));
        dl.setAttribute('download', e.name);
        prev.hidden = next.hidden = siblings.length < 2;
        body.classList.remove('has-note');
        body.dataset.kind = e.preview;
        renderPreview(e, body, ctx);
      }
      function go(d) {
        index = (index + d + siblings.length) % siblings.length;
        show();
      }
      dlg.addEventListener('keydown', (ev) => {
        if (siblings.length < 2 || ev.target.matches('input,textarea') || ev.target.closest('video,audio')) return;
        if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(-1); }
        if (ev.key === 'ArrowRight') { ev.preventDefault(); go(1); }
      });
      dlg.addEventListener('close', () => ctx.media?.pause());
      body.tabIndex = -1;
      show();
      setTimeout(() => body.focus(), 0); // keeps the arrow keys working without a focus ring on the buttons
      return h('div', { class: 'preview-wrap', 'data-testid': 'preview' },
        h('div', { class: 'preview-head' }, prev, next, h('div', { class: 'preview-title' }, title, sub), count, dl,
          h('button', { class: 'icon-btn', 'aria-label': 'Close preview', onclick: () => close(null) }, icon('x'))),
        body);
    }, 'preview');
  }

  function downloadEntries(list) {
    if (list.length === 1 && list[0].type === 'file') {
      const a = h('a', { href: downloadUrl(join(S.path, list[0].name)), download: list[0].name });
      document.body.append(a);
      a.click();
      a.remove();
      return;
    }
    $('zip-paths').value = JSON.stringify(list.map((e) => join(S.path, e.name)));
    $('zip-form').submit();
    toast(`Preparing ZIP of ${plural(list.length, 'item')}…`);
  }

  async function newFolder() {
    const name = await promptName({
      title: 'New folder', label: 'Folder name', confirm: 'Create',
      validate: (v) => (S.entries.some((e) => e.name === v) ? 'Something with that name already exists.' : null),
    });
    if (!name) return;
    try {
      await api('/api/mkdir', { json: { path: S.path, name } });
      toast(`Created folder “${name}”`);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function renameEntry(e) {
    const name = await promptName({
      title: 'Rename', label: 'New name', value: e.name, confirm: 'Rename',
      validate: (v) => (v !== e.name && S.entries.some((x) => x.name === v) ? 'Something with that name already exists.' : null),
    });
    if (!name || name === e.name) return;
    try {
      await api('/api/rename', { json: { path: join(S.path, e.name), newName: name } });
      toast(`Renamed to “${name}”`);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteEntries(list) {
    const ok = await confirmDialog({
      title: list.length === 1 ? `Delete “${list[0].name}”?` : `Delete ${list.length} items?`,
      text: list.some((e) => e.type === 'dir') ? 'Folders are deleted with everything inside them. This cannot be undone.' : 'This cannot be undone.',
      items: list.length > 1 ? list.map((e) => e.name) : [],
      confirm: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/delete', { json: { paths: list.map((e) => join(S.path, e.name)) } });
      toast(list.length === 1 ? `Deleted “${list[0].name}”` : `Deleted ${list.length} items`);
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
      await refresh();
    }
  }

  // ------------------------------------------------------------------
  // Uploads (chunked, resumable, 2 at a time)
  // ------------------------------------------------------------------
  const CHUNK = store.get('chunk', 8 * 1024 * 1024); // 'fm.chunk' can be lowered for testing
  const PARALLEL = 2;
  const jobs = [];
  let running = 0;
  let speed = 0;
  let sample = { t: Date.now(), bytes: 0 };
  let refreshTimer = null;

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function addUploads(items) {
    // items: [{ file, rel }]
    if (!items.length) return;
    if (!S.path || S.error) { toast('Open a folder first, then upload', 'error'); return; }
    if (!jobs.some((j) => j.state === 'queued' || j.state === 'uploading')) {
      // new batch: drop old finished rows
      jobs.splice(0, jobs.length, ...jobs.filter((j) => j.state === 'error'));
    }
    for (const { file, rel } of items) {
      jobs.push({ id: uid(), file, rel, dir: S.path, state: 'queued', loaded: 0, total: file.size, error: '', xhr: null, cancelled: false, finalName: rel });
    }
    $('uploads').hidden = false;
    $('uploads').classList.remove('collapsed');
    pump();
    renderUploads();
  }

  function pump() {
    while (running < PARALLEL) {
      const job = jobs.find((j) => j.state === 'queued');
      if (!job) break;
      running++;
      job.state = 'uploading';
      runJob(job).finally(() => {
        running--;
        pump();
        renderUploads();
      });
    }
  }

  function sendChunk(job, offset, blob) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      job.xhr = xhr;
      xhr.open('POST', `/api/upload?${qs({ path: job.dir, name: job.rel, id: job.id, offset, total: job.total })}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { job.loaded = offset + e.loaded; };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status === 200) resolve(data);
        else reject(Object.assign(new Error(data.error || `Upload failed (${xhr.status})`), { status: xhr.status, data }));
      };
      xhr.onerror = () => reject(Object.assign(new Error('Network error'), { network: true }));
      xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      xhr.send(blob);
    });
  }

  async function runJob(job) {
    let offset = 0;
    let retries = 0;
    try {
      do {
        const blob = job.file.slice(offset, offset + CHUNK);
        try {
          const res = await sendChunk(job, offset, blob);
          offset += blob.size;
          job.loaded = offset;
          retries = 0;
          if (res.name) job.finalName = res.name;
        } catch (err) {
          if (err.cancelled || job.cancelled || err.status === 410) throw err;
          const transient = err.network || err.status === 409 || err.status >= 500;
          if (!transient || err.status === 507 || ++retries > 5) throw err;
          await sleep(500 * retries);
          const st = await api(`/api/upload-status?${qs({ path: job.dir, name: job.rel, id: job.id })}`).catch(() => null);
          if (st) offset = st.size;
        }
      } while (offset < job.file.size);
      job.state = 'done';
      job.loaded = job.total;
      if (job.dir === S.path) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 250);
      }
    } catch (err) {
      if (err.cancelled || job.cancelled || err.status === 410) {
        job.state = 'cancelled';
      } else {
        job.state = 'error';
        job.error = err.message;
        api(`/api/upload-cancel?${qs({ path: job.dir, name: job.rel, id: job.id })}`, { method: 'POST' }).catch(() => {});
      }
    }
  }

  function cancelJob(job) {
    job.cancelled = true;
    if (job.state === 'queued') job.state = 'cancelled';
    else if (job.state === 'uploading') job.xhr?.abort();
    api(`/api/upload-cancel?${qs({ path: job.dir, name: job.rel, id: job.id })}`, { method: 'POST' }).catch(() => {});
    renderUploads();
  }

  function renderUploads() {
    const panel = $('uploads');
    if (!jobs.length) { panel.hidden = true; return; }
    const active = jobs.filter((j) => j.state === 'queued' || j.state === 'uploading');
    const done = jobs.filter((j) => j.state === 'done').length;
    const failed = jobs.filter((j) => j.state === 'error').length;
    const counted = jobs.filter((j) => j.state !== 'cancelled');
    const total = counted.reduce((n, j) => n + j.total, 0);
    const loaded = counted.reduce((n, j) => n + Math.min(j.loaded, j.total), 0);

    const now = Date.now();
    if (now - sample.t >= 800) {
      const inst = ((loaded - sample.bytes) / (now - sample.t)) * 1000;
      speed = speed ? speed * 0.6 + Math.max(inst, 0) * 0.4 : Math.max(inst, 0);
      sample = { t: now, bytes: loaded };
    }

    panel.classList.toggle('is-done', !active.length);
    $('uploads-title').textContent = active.length
      ? `Uploading ${plural(active.length, 'file')}`
      : failed ? `${done} uploaded, ${failed} failed` : `Uploaded ${plural(done, 'file')}`;
    $('uploads-sub').textContent = active.length
      ? `${formatSize(loaded)} of ${formatSize(total)}${speed > 0 ? ` · ${formatSize(speed)}/s · ${formatDuration((total - loaded) / speed)} left` : ''}`
      : '';
    $('uploads-bar-fill').style.width = `${total ? Math.round((loaded / total) * 100) : 100}%`;
    $('uploads-close').setAttribute('aria-label', active.length ? 'Cancel all uploads' : 'Clear finished uploads');

    const list = $('uploads-list');
    list.replaceChildren(...jobs.map((j) => {
      const pct = j.total ? Math.min(100, Math.round((j.loaded / j.total) * 100)) : 100;
      const meta = {
        queued: 'Waiting…',
        uploading: `${pct}% · ${formatSize(j.loaded)} of ${formatSize(j.total)}`,
        done: `Uploaded · ${formatSize(j.total)}`,
        error: j.error || 'Failed',
        cancelled: 'Cancelled',
      }[j.state];
      const bar = h('div', { class: 'up-progress' }, h('div', {}));
      bar.firstChild.style.width = `${pct}%`;
      const busy = j.state === 'queued' || j.state === 'uploading';
      return h('li', { class: `up-item ${j.state}`, data: { testid: 'upload-item', state: j.state, name: j.rel } },
        h('span', { class: 'up-name', title: j.rel }, j.rel),
        busy ? h('button', { class: 'icon-btn', 'aria-label': `Cancel ${j.rel}`, onclick: () => cancelJob(j) }, icon('x'))
          : j.state === 'done' ? h('span', { class: 'icon-btn', style: 'color:var(--ok)' }, icon('check')) : h('span'),
        h('span', { class: 'up-meta' }, meta), bar);
    }));
  }
  setInterval(() => { if (jobs.some((j) => j.state === 'uploading')) renderUploads(); }, 400);

  // ---- picking and dropping files ----
  function filesToItems(fileList, useRelative) {
    return [...fileList].map((file) => ({ file, rel: useRelative && file.webkitRelativePath ? file.webkitRelativePath : file.name }));
  }

  async function readEntry(entry, prefix = '') {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      return [{ file, rel: prefix + entry.name }];
    }
    const reader = entry.createReader();
    const out = [];
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) out.push(...await readEntry(child, `${prefix}${entry.name}/`));
    }
    return out;
  }

  async function itemsFromDrop(dt) {
    const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return filesToItems(dt.files, false);
    const nested = await Promise.all(entries.map((en) => readEntry(en)));
    return nested.flat();
  }

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $('drop-target').textContent = `into ${S.path}`;
    $('dropzone').hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropzone').hidden = true;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    addUploads(await itemsFromDrop(e.dataTransfer));
  });

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function openMenu() { $('app').classList.add('menu-open'); }
  function closeMenu() { $('app').classList.remove('menu-open'); }

  function bind() {
    $('btn-menu').onclick = openMenu;
    $('scrim').onclick = closeMenu;
    $('btn-up').onclick = () => S.parent && navigate(S.parent);
    $('btn-refresh').onclick = refresh;
    $('crumbs').onclick = editPath;
    $('btn-hidden').onclick = () => { S.showHidden = !S.showHidden; store.set('hidden', S.showHidden); S.selected.clear(); render(); };
    $('btn-view').onclick = () => { S.view = S.view === 'grid' ? 'list' : 'grid'; store.set('view', S.view); render(); };
    $('btn-search').onclick = () => {
      const open = document.body.classList.toggle('search-open');
      if (open) $('search').focus(); else { $('search').value = ''; S.filter = ''; renderList(); renderStatus(); }
    };
    $('side-hidden').onclick = $('btn-hidden').onclick;
    $('side-theme').onclick = () => $('btn-theme').onclick();
    $('side-refresh').onclick = () => { closeMenu(); refresh(); };
    $('side-logout').onclick = () => $('btn-logout').onclick();
    const sheet = (open) => { $('sheet').hidden = !open; $('sheet-scrim').hidden = !open; };
    $('fab').onclick = () => sheet(true);
    $('sheet-scrim').onclick = () => sheet(false);
    $('sheet-files').onclick = () => { sheet(false); $('file-input').click(); };
    $('sheet-folder').onclick = () => { sheet(false); $('dir-input').click(); };
    $('sheet-new').onclick = () => { sheet(false); newFolder(); };
    $('btn-logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.reload(); };
    $('btn-theme').onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('fm.theme', next);
      render();
    };
    $('search').oninput = (e) => { S.filter = e.target.value; renderList(); renderStatus(); };

    $('btn-upload').onclick = () => $('file-input').click();
    $('btn-upload-folder').onclick = () => $('dir-input').click();
    $('file-input').onchange = (e) => { addUploads(filesToItems(e.target.files, false)); e.target.value = ''; };
    $('dir-input').onchange = (e) => { addUploads(filesToItems(e.target.files, true)); e.target.value = ''; };
    $('btn-newfolder').onclick = newFolder;

    $('btn-download').onclick = () => downloadEntries(selectedEntries());
    $('btn-rename').onclick = () => { const [e] = selectedEntries(); if (e) renameEntry(e); };
    $('btn-delete').onclick = () => deleteEntries(selectedEntries());
    $('btn-clear').onclick = () => { S.selected.clear(); renderList(); renderActions(); };

    $('uploads-toggle').onclick = () => $('uploads').classList.toggle('collapsed');
    $('uploads-close').onclick = () => {
      if (jobs.some((j) => j.state === 'queued' || j.state === 'uploading')) {
        jobs.filter((j) => j.state === 'queued' || j.state === 'uploading').forEach(cancelJob);
      }
      jobs.splice(0, jobs.length, ...jobs.filter((j) => j.state === 'queued' || j.state === 'uploading'));
      renderUploads();
    };

    window.addEventListener('hashchange', () => {
      const p = pathFromHash();
      if (p && p !== S.path) navigate(p, { push: false });
    });

    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if (document.querySelector('dialog[open]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); editPath(); return; }
      if (e.key === 'ArrowUp' && e.altKey && S.parent) { e.preventDefault(); navigate(S.parent); return; }
      if (typing) { if (e.key === 'Escape' && document.activeElement === $('search')) { $('search').value = ''; S.filter = ''; $('search').blur(); renderList(); renderStatus(); } return; }
      if (e.key === '/') { e.preventDefault(); $('search').focus(); }
      else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        S.selected = new Set(visibleEntries().map((x) => x.name));
        renderList(); renderActions();
      } else if (e.key === 'Escape') { S.selected.clear(); renderList(); renderActions(); }
      else if (e.key === 'Delete' && S.selected.size) deleteEntries(selectedEntries());
      else if (e.key === 'F2' && S.selected.size === 1) renameEntry(selectedEntries()[0]);
    });

    window.addEventListener('beforeunload', (e) => {
      if (jobs.some((j) => j.state === 'queued' || j.state === 'uploading')) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  async function init() {
    bind();
    try {
      S.info = await api('/api/info');
    } catch (err) {
      document.body.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'Cannot reach the server'), h('span', {}, err.message)));
      return;
    }
    $('host').textContent = S.info.hostname;
    $('btn-logout').hidden = !S.info.auth;
    $('side-logout').hidden = !S.info.auth;
    if (S.info.auth) $('security-note').textContent = 'Protected by a password.';
    $('version').textContent = `v${S.info.version}`;
    const start = pathFromHash() || store.get('path', null) || S.info.home;
    await navigate(start, { push: pathFromHash() === null });
    if (S.error && start !== S.info.home) await navigate(S.info.home);
  }

  init();
})();
