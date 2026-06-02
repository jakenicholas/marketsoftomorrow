/*
  TMW Studio — shared media browser.

  A folder-navigable, searchable image picker backed by the worker /admin/media
  endpoint (folders=1 → folder list; folder=<path>&q= → files). Folders are
  stored as " / "-separated nested paths; this renders them as a drill-down
  tree with breadcrumbs.

  Usage (any admin page that loads admin-auth.js):
      <script src="/_shared/media-browser.js" defer></script>
      TMWMediaBrowser.open({ onPick: (url, alt) => { … } });
*/
(function () {
  'use strict';
  var WORKER = 'https://tmw.jake-ab7.workers.dev';
  function token() {
    try { return ((window.TMWAuth && window.TMWAuth.token && window.TMWAuth.token()) || localStorage.getItem('tmw-admin-token-v1') || '').trim(); }
    catch (e) { return ''; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  if (!document.getElementById('tmw-mb-styles')) {
    var css = `
      .tmw-mb{position:fixed; inset:0; z-index:99990; background:rgba(5,6,5,.72); backdrop-filter:blur(6px); display:none; align-items:center; justify-content:center; padding:24px; font-family:'Inter',-apple-system,sans-serif}
      .tmw-mb.show{display:flex}
      .tmw-mb-panel{width:min(1000px,96vw); height:min(720px,90vh); background:#131613; border:1px solid rgba(255,255,255,.12); border-radius:16px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 30px 80px rgba(0,0,0,.6)}
      .tmw-mb-head{display:flex; align-items:center; gap:12px; padding:14px 18px; border-bottom:1px solid rgba(255,255,255,.08)}
      .tmw-mb-head h3{font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:18px; color:#fff; margin:0; flex-shrink:0}
      .tmw-mb-search{flex:1; display:flex; align-items:center; gap:8px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:8px 12px}
      .tmw-mb-search input{flex:1; background:transparent; border:0; outline:0; color:#fff; font:inherit; font-size:13px}
      .tmw-mb-search input::placeholder{color:#9AA39C}
      .tmw-mb-up{flex-shrink:0; background:#1FDF67; color:#0a0a0a; border:0; border-radius:8px; padding:9px 14px; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:11px; font-weight:700; letter-spacing:.04em; cursor:pointer}
      .tmw-mb-up:hover{background:#42EB81} .tmw-mb-up:disabled{opacity:.5; cursor:wait}
      .tmw-mb-x{background:none; border:0; color:#9AA39C; font-size:22px; line-height:1; cursor:pointer; padding:0 4px}
      .tmw-mb-x:hover{color:#fff}
      .tmw-mb-crumbs{display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:10px 18px; border-bottom:1px solid rgba(255,255,255,.06); font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:11px; color:#9AA39C}
      .tmw-mb-crumbs a{color:#42EB81; cursor:pointer; text-decoration:none}
      .tmw-mb-crumbs a:hover{text-decoration:underline}
      .tmw-mb-crumbs span.sep{opacity:.4}
      .tmw-mb-body{flex:1; overflow-y:auto; padding:16px 18px}
      .tmw-mb-folders{display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; margin-bottom:18px}
      .tmw-mb-folder{display:flex; align-items:center; gap:9px; padding:12px 14px; background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.08); border-radius:10px; cursor:pointer; transition:all .15s; color:#ECEAE5; text-align:left}
      .tmw-mb-folder:hover{border-color:rgba(31,223,103,.45); background:rgba(31,223,103,.06)}
      .tmw-mb-folder svg{width:18px; height:18px; color:#e6c574; flex-shrink:0}
      .tmw-mb-folder .nm{font-size:12.5px; font-weight:500; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
      .tmw-mb-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px}
      .tmw-mb-tile{position:relative; aspect-ratio:1; border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,.08); background:#0a0a0a; cursor:pointer; transition:all .15s}
      .tmw-mb-tile:hover{border-color:#1FDF67; transform:translateY(-2px)}
      .tmw-mb-tile img{width:100%; height:100%; object-fit:cover; display:block}
      .tmw-mb-tile .cap{position:absolute; left:0; right:0; bottom:0; padding:14px 8px 6px; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:9px; color:#fff; background:linear-gradient(transparent,rgba(0,0,0,.8)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
      .tmw-mb-empty{grid-column:1/-1; text-align:center; color:#9AA39C; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:12.5px; padding:50px 0}
      .tmw-mb-sect{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:#9AA39C; margin:0 0 10px}
    `;
    var st = document.createElement('style'); st.id = 'tmw-mb-styles'; st.textContent = css; document.head.appendChild(st);
  }

  var FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  var S = { folders: [], cur: '', q: '', onPick: null, items: [], el: null, t: null };

  function build() {
    var el = document.createElement('div');
    el.className = 'tmw-mb';
    el.innerHTML =
      '<div class="tmw-mb-panel">' +
        '<div class="tmw-mb-head"><h3>Choose an image</h3>' +
          '<div class="tmw-mb-search"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#9AA39C" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>' +
          '<input type="search" placeholder="Search all images by name…" data-mb-search></div>' +
          '<button class="tmw-mb-up" data-mb-upload>+ Upload</button>' +
          '<input type="file" accept="image/*" data-mb-file hidden>' +
          '<button class="tmw-mb-x" data-mb-close aria-label="Close">×</button>' +
        '</div>' +
        '<div class="tmw-mb-crumbs" data-mb-crumbs></div>' +
        '<div class="tmw-mb-body" data-mb-body></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) { if (e.target === el || e.target.closest('[data-mb-close]')) close(); });
    var search = el.querySelector('[data-mb-search]');
    search.addEventListener('input', function () {
      clearTimeout(S.t); S.t = setTimeout(function () { S.q = search.value.trim(); refresh(); }, 220);
    });
    var fileInput = el.querySelector('[data-mb-file]');
    el.querySelector('[data-mb-upload]').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', async function () {
      var f = fileInput.files && fileInput.files[0]; if (!f) return;
      var btn = el.querySelector('[data-mb-upload]'); var old = btn.textContent; btn.textContent = 'Uploading…'; btn.disabled = true;
      try {
        var form = new FormData(); form.append('file', f);
        var r = await fetch(WORKER + '/admin/media', { method: 'POST', headers: { Authorization: 'Bearer ' + token() }, body: form });
        var d = await r.json();
        if (!r.ok || !d.url) throw new Error(d.error || ('HTTP ' + r.status));
        if (S.onPick) { S.onPick(d.url, d.alt_text || f.name); close(); }
      } catch (e) { alert('Upload failed: ' + (e.message || e)); }
      finally { btn.textContent = old; btn.disabled = false; fileInput.value = ''; }
    });
    S.el = el;
    return el;
  }

  function close() { if (S.el) S.el.classList.remove('show'); }

  async function loadFolders() {
    try {
      var r = await fetch(WORKER + '/admin/media?folders=1', { headers: { Authorization: 'Bearer ' + token() } });
      if (r.ok) { var d = await r.json(); S.folders = (d.folders || []).map(function (f) { return f.folder; }).filter(function (x) { return x && x !== 'Unfiled'; }); }
    } catch (e) { S.folders = []; }
  }

  // Direct child folders of the current path.
  function childFolders() {
    var base = S.cur, out = {};
    S.folders.forEach(function (f) {
      if (base) {
        if (f.indexOf(base + ' / ') === 0) { var child = base + ' / ' + f.slice(base.length + 3).split(' / ')[0]; out[child] = 1; }
      } else {
        out[f.split(' / ')[0]] = 1;
      }
    });
    return Object.keys(out).sort();
  }

  async function loadFiles() {
    var p = new URLSearchParams({ limit: '150' });
    if (S.q) p.set('q', S.q);
    else if (S.cur) p.set('folder', S.cur);
    try {
      var r = await fetch(WORKER + '/admin/media?' + p, { headers: { Authorization: 'Bearer ' + token() } });
      S.items = r.ok ? ((await r.json()).items || []).filter(function (m) { return !m.mime_type || m.mime_type.indexOf('image/') === 0; }) : [];
    } catch (e) { S.items = []; }
  }

  function render() {
    var crumbs = S.el.querySelector('[data-mb-crumbs]');
    var parts = S.cur ? S.cur.split(' / ') : [];
    var html = '<a data-mb-go="">All media</a>';
    var acc = '';
    parts.forEach(function (p, i) { acc = i ? acc + ' / ' + p : p; html += '<span class="sep">/</span><a data-mb-go="' + esc(acc) + '">' + esc(p) + '</a>'; });
    if (S.q) html += '<span class="sep">/</span><span style="color:#fff">search: “' + esc(S.q) + '”</span>';
    crumbs.innerHTML = html;
    crumbs.querySelectorAll('[data-mb-go]').forEach(function (a) {
      a.addEventListener('click', function () { S.q = ''; var si = S.el.querySelector('[data-mb-search]'); if (si) si.value = ''; S.cur = a.getAttribute('data-mb-go'); refresh(); });
    });

    var body = S.el.querySelector('[data-mb-body]');
    var folders = S.q ? [] : childFolders();
    var foldersHtml = folders.length
      ? '<div class="tmw-mb-sect">Folders</div><div class="tmw-mb-folders">' + folders.map(function (f) {
          var name = f.split(' / ').pop();
          return '<button class="tmw-mb-folder" data-mb-folder="' + esc(f) + '">' + FOLDER_SVG + '<span class="nm">' + esc(name) + '</span></button>';
        }).join('') + '</div>'
      : '';
    var filesHtml = S.items.length
      ? '<div class="tmw-mb-sect">' + (S.q ? 'Results' : 'Images') + ' · ' + S.items.length + '</div><div class="tmw-mb-grid">' + S.items.map(function (m) {
          return '<div class="tmw-mb-tile" data-mb-url="' + esc(m.url) + '" data-mb-alt="' + esc(m.alt_text || m.filename || '') + '" title="' + esc(m.filename || '') + '"><img src="' + esc(m.url) + '" alt="" loading="lazy"><div class="cap">' + esc(m.filename || '') + '</div></div>';
        }).join('') + '</div>'
      : (folders.length ? '' : '<div class="tmw-mb-empty">No images here' + (S.q ? ' for “' + esc(S.q) + '”' : '') + '.</div>');
    body.innerHTML = foldersHtml + filesHtml;
    body.scrollTop = 0;
    body.querySelectorAll('[data-mb-folder]').forEach(function (b) {
      b.addEventListener('click', function () { S.cur = b.getAttribute('data-mb-folder'); refresh(); });
    });
    body.querySelectorAll('[data-mb-url]').forEach(function (t) {
      t.addEventListener('click', function () { if (S.onPick) S.onPick(t.getAttribute('data-mb-url'), t.getAttribute('data-mb-alt')); close(); });
    });
  }

  async function refresh() {
    var body = S.el.querySelector('[data-mb-body]');
    body.innerHTML = '<div class="tmw-mb-empty">Loading…</div>';
    await loadFiles();
    render();
  }

  async function open(opts) {
    opts = opts || {};
    S.onPick = opts.onPick || function () {};
    S.cur = ''; S.q = '';
    if (!S.el) build();
    var si = S.el.querySelector('[data-mb-search]'); if (si) si.value = '';
    S.el.classList.add('show');
    if (!S.folders.length) await loadFolders();
    await refresh();
  }

  window.TMWMediaBrowser = { open: open };
})();
