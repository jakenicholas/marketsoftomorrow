/* tmw-mobile-dock.js — the expandable liquid-glass tool dock (MOBILE ONLY).
   Loaded by journal-dock.js right after the bottom search pill initializes.
   Desktop is untouched (every rule lives inside a max-width media query).

   On mobile this REPLACES the old bottom pill (search + three toggles): the old
   .tmw-dock is hidden and the dock becomes a glass icon pill (Journal ·
   Database · Onyx · Dashboard) on the left + a +/✕ fab pinned bottom-right.
   The fab morphs the tray up from the dock line; the tray ends LEFT of the fab
   (never behind it). The tray is crowned by an exact visual replica of the
   floating search bar — same capsule, same placeholder, same masked conic
   purple chase (reusing journal-dock's --tmw-ang/@keyframes tmwChase; no blur
   layer) — and tapping it opens the real search overlay via tmwOpenSearch. */
(function () {
  'use strict';
  if (window.__tmwMobileDock) return;
  window.__tmwMobileDock = true;

  var MOBILE = '(max-width:640px)';

  /* ---------- context ---------- */
  var path = location.pathname;
  var CTX = null;
  function h1() { var el = document.querySelector('h1'); return el ? el.textContent.trim().slice(0, 80) : document.title.split('·')[0].trim(); }
  function openSearch(q) {
    close();
    if (window.tmwOpenSearch) { window.tmwOpenSearch(q || ''); return; }
    if (window.tmwOverlay && window.tmwOverlay.open) window.tmwOverlay.open(q || '');
  }
  function share() {
    close();
    var data = { title: document.title, url: location.href };
    if (navigator.share) { navigator.share(data).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(location.href).catch(function () {});
  }
  function go(url) { return function () { location.href = url; }; }
  function proxyClick(sel) { return function () { close(); var b = document.querySelector(sel); if (b) b.click(); }; }

  var I = {
    watch: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    onyx: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6M11 8v6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    atlas: '<path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/>',
    share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><polyline points="8 6 12 2 16 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
    trophy: '<path d="M8 21h8M12 17v4M6 3h12v5a6 6 0 0 1-12 0z"/><path d="M6 5H3v2a4 4 0 0 0 3 3.9M18 5h3v2a4 4 0 0 1-3 3.9"/>',
    passport: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 14h4"/>',
    journal: '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H12v18H5.5A2.5 2.5 0 0 0 3 23z"/><path d="M21 5.5A2.5 2.5 0 0 0 18.5 3H12v18h6.5a2.5 2.5 0 0 1 2.5 2z"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/>'
  };

  if (/^\/projects?\/[^/]+/.test(path)) {
    CTX = { label: 'This project', tools: [] };
    if (document.getElementById('watchBtn')) CTX.tools.push({ ic: 'watch', t: 'Watch', act: proxyClick('#watchBtn'), cls: 'act' });
    CTX.tools.push({ ic: 'onyx', t: 'Ask Onyx', act: function () { openSearch(h1()); }, cls: 'hero' });
    CTX.tools.push({ ic: 'atlas', t: 'Atlas', act: go('/atlas/') });
    CTX.tools.push({ ic: 'share', t: 'Share', act: share });
  } else if (/^\/post\//.test(path)) {
    CTX = { label: 'This story', tools: [
      { ic: 'onyx', t: 'Ask Onyx', act: function () { openSearch(h1()); }, cls: 'hero' },
      { ic: 'share', t: 'Share', act: share }
    ] };
  } else if (/^\/(golf|hotels|restaurants)\/?/.test(path)) {
    CTX = { label: 'This list', tools: [
      { ic: 'trophy', t: 'Leaderboard', act: go('/passport/'), cls: 'act' },
      { ic: 'passport', t: 'My Passport', act: go('/dashboard/#passport') },
      { ic: 'onyx', t: 'Ask Onyx', act: function () { openSearch(''); }, cls: 'hero' },
      { ic: 'share', t: 'Share', act: share }
    ] };
  }

  var GLOBAL = [
    { ic: 'journal', t: 'Journal', act: go('https://www.oftmw.com/') },
    { ic: 'map', t: 'Database', act: go('https://map.oftmw.com/') },
    { ic: 'passport', t: 'Passport', act: go('/passport/') },
    { ic: 'user', t: 'Dashboard', act: go('/dashboard/') }
  ];

  /* pill quick-nav (collapsed state) — page-aware highlight */
  var onJournal = /^\/($|post\/|category|markets)/.test(path);
  var PILL = [
    { ic: 'journal', t: 'Journal', act: go('https://www.oftmw.com/'), on: onJournal },
    { ic: 'map', t: 'Database', act: go('https://map.oftmw.com/') },
    { ic: 'search', t: 'Search', act: function () { openSearch(''); } },
    { ic: 'user', t: 'Dashboard', act: go('/dashboard/') }
  ];

  /* ---------- styles ---------- */
  var css = [
    '.tmwx-pill,.tmwx-fab,.tmwx-tray,.tmwx-scrim{display:none}',
    '@media ' + MOBILE + '{',
    /* retire the old bottom pill + its autocomplete on mobile */
    'html.tmwx-on .tmw-dock{display:none !important}',
    'html.tmwx-on .tmw-dock-ac{display:none !important}',

    '.tmwx-scrim{display:block;position:fixed;inset:0;background:rgba(4,4,6,.5);opacity:0;pointer-events:none;transition:opacity .3s ease;z-index:9001}',
    'html.tmwx-open .tmwx-scrim{opacity:1;pointer-events:auto}',

    /* collapsed glass icon pill (left) */
    '.tmwx-pill{display:flex;position:fixed;left:12px;bottom:14px;z-index:9002;align-items:center;gap:2px;padding:6px;border-radius:999px;',
    'background:linear-gradient(135deg,rgba(255,255,255,.13),rgba(255,255,255,.05) 45%,rgba(255,255,255,.08));',
    'backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);',
    'border:1px solid rgba(255,255,255,.18);box-shadow:0 14px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.24);',
    'transition:transform .3s cubic-bezier(.34,1.45,.5,1), opacity .2s ease}',
    'html.tmwx-open .tmwx-pill{transform:translateY(12px) scale(.9);opacity:0;pointer-events:none}',
    '.tmwx-pbtn{width:46px;height:46px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#ECEAE5;border:none;background:transparent;cursor:pointer}',
    '.tmwx-pbtn.on{background:rgba(255,255,255,.14)}',
    '.tmwx-pbtn:active{background:rgba(255,255,255,.18)}',
    '.tmwx-pbtn svg{width:20px;height:20px}',

    '.tmwx-fab{display:flex;position:fixed;right:12px;bottom:14px;width:54px;height:54px;border-radius:999px;z-index:9004;',
    'align-items:center;justify-content:center;border:none;cursor:pointer;color:#0a0a0c;background:rgba(255,255,255,.94);',
    'box-shadow:0 14px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.5)}',
    '.tmwx-fab svg{width:22px;height:22px;transition:transform .34s cubic-bezier(.34,1.45,.5,1)}',
    'html.tmwx-open .tmwx-fab svg{transform:rotate(45deg)}',

    /* tray: grows taller from the dock line and ENDS LEFT of the fab */
    '.tmwx-tray{display:block;position:fixed;left:12px;right:78px;bottom:14px;z-index:9003;border-radius:24px;padding:15px 13px 13px;',
    'background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.05) 40%,rgba(255,255,255,.09));',
    'backdrop-filter:blur(22px) saturate(1.6);-webkit-backdrop-filter:blur(22px) saturate(1.6);',
    'border:1px solid rgba(255,255,255,.2);box-shadow:0 14px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.26);',
    'transform:scaleY(.16) scaleX(.94);opacity:0;visibility:hidden;transform-origin:50% 100%;',
    'transition:transform .4s cubic-bezier(.3,1.3,.42,1), opacity .22s ease, visibility 0s .4s}',
    'html.tmwx-open .tmwx-tray{transform:none;opacity:1;visibility:visible;transition:transform .4s cubic-bezier(.3,1.3,.42,1), opacity .22s ease}',
    '.tmwx-in{opacity:0;transform:translateY(8px);transition:opacity .24s ease .12s, transform .3s ease .12s}',
    'html.tmwx-open .tmwx-in{opacity:1;transform:none}',

    /* the search bar — an exact replica of the floating bar (same capsule, same
       placeholder, same masked conic chase; reuses journal-dock's --tmw-ang). */
    '.tmwx-search{position:relative;border-radius:999px;margin:0 1px 13px}',
    '.tmwx-search .si{position:absolute;left:13px;top:50%;width:20px;height:20px;color:#9AA39C;pointer-events:none;transform:translateY(-50%);z-index:2}',
    '.tmwx-search input{height:46px;width:100%;padding:0 18px 0 42px;position:relative;z-index:1;',
    'background:rgba(9,11,9,.82);border:1px solid rgba(255,255,255,.10);border-radius:999px;',
    'color:#fff;font-size:14px;font-family:inherit;outline:none}',
    '.tmwx-search input::placeholder{color:#9AA39C}',
    '.tmwx-search::before{content:"";position:absolute;inset:-1.5px;border-radius:999px;padding:1.5px;z-index:0;pointer-events:none;',
    'background:conic-gradient(from var(--tmw-ang,0deg), rgba(167,139,250,0) 0deg, rgba(167,139,250,0) 205deg, #A78BFA 300deg, #E9DEFF 338deg, rgba(167,139,250,0) 360deg);',
    '-webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;',
    'animation:tmwChase 3s linear infinite}',

    '.tmwx-sec{font-family:ui-monospace,Menlo,monospace;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.55);margin:2px 5px 8px}',
    '.tmwx-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:9px}',
    '.tmwx-grid:last-child{margin-bottom:2px}',
    '.tmwx-tool{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 2px 9px;border-radius:14px;cursor:pointer;border:none;background:transparent;color:#f3f1ec;font-family:inherit}',
    '.tmwx-tool:active{background:rgba(255,255,255,.12)}',
    '.tmwx-tool svg{width:21px;height:21px}',
    '.tmwx-tool span{font-size:9.5px;color:rgba(255,255,255,.85)}',
    '.tmwx-tool.hero svg{color:#E6C574}',
    '.tmwx-tool.act svg{color:#34d27b}',
    '}',
    '@media (prefers-reduced-motion:reduce){.tmwx-search::before{animation:none}.tmwx-tray,.tmwx-fab svg,.tmwx-in,.tmwx-pill{transition:none!important}}'
  ].join('');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ---------- DOM ---------- */
  function svg(paths) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>'; }
  function toolBtn(t) {
    var b = document.createElement('button');
    b.className = 'tmwx-tool' + (t.cls ? ' ' + t.cls : '');
    b.innerHTML = svg(I[t.ic]) + '<span>' + t.t + '</span>';
    b.addEventListener('click', t.act);
    return b;
  }

  var scrim = document.createElement('div'); scrim.className = 'tmwx-scrim';
  var tray = document.createElement('div'); tray.className = 'tmwx-tray';
  var inner = document.createElement('div'); inner.className = 'tmwx-in';

  /* replica search bar */
  var sw = document.createElement('div'); sw.className = 'tmwx-search';
  sw.innerHTML = '<span class="si">' + svg(I.search) + '</span>' +
    '<input type="search" autocomplete="off" placeholder="Search projects, firms, places…" aria-label="Search projects, firms, places, brands, and more">';
  var sInput = sw.querySelector('input');
  sInput.addEventListener('focus', function () { sInput.blur(); openSearch(''); });
  sw.addEventListener('click', function () { openSearch(''); });
  inner.appendChild(sw);

  if (CTX && CTX.tools.length) {
    var s1 = document.createElement('div'); s1.className = 'tmwx-sec'; s1.textContent = CTX.label; inner.appendChild(s1);
    var g1 = document.createElement('div'); g1.className = 'tmwx-grid';
    CTX.tools.forEach(function (t) { g1.appendChild(toolBtn(t)); });
    inner.appendChild(g1);
  }
  var s2 = document.createElement('div'); s2.className = 'tmwx-sec'; s2.textContent = 'Markets of TMW'; inner.appendChild(s2);
  var g2 = document.createElement('div'); g2.className = 'tmwx-grid';
  GLOBAL.forEach(function (t) { g2.appendChild(toolBtn(t)); });
  inner.appendChild(g2);
  tray.appendChild(inner);

  /* collapsed pill */
  var pill = document.createElement('div'); pill.className = 'tmwx-pill';
  PILL.forEach(function (t) {
    var b = document.createElement('button');
    b.className = 'tmwx-pbtn' + (t.on ? ' on' : '');
    b.setAttribute('aria-label', t.t);
    b.innerHTML = svg(I[t.ic]);
    b.addEventListener('click', t.act);
    pill.appendChild(b);
  });

  var fab = document.createElement('button');
  fab.className = 'tmwx-fab';
  fab.setAttribute('aria-label', 'All tools');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  function close() { document.documentElement.classList.remove('tmwx-open'); }
  fab.addEventListener('click', function () { document.documentElement.classList.toggle('tmwx-open'); });
  scrim.addEventListener('click', close);
  addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  document.body.appendChild(scrim);
  document.body.appendChild(tray);
  document.body.appendChild(pill);
  document.body.appendChild(fab);
  document.documentElement.classList.add('tmwx-on');
})();
