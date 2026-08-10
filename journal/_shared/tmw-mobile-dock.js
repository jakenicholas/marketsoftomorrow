/* tmw-mobile-dock.js — the expandable liquid-glass tool dock (MOBILE ONLY).
   Loaded by journal-dock.js right after the bottom search pill initializes, so
   it exists exactly where the pill exists. Desktop is untouched.

   Collapsed: the existing glowing search pill docks LEFT, a glass ✕/+ fab pins
   to the bottom-RIGHT corner. Tapping the fab morphs a tray up FROM the dock
   line (scaleY, origin bottom) — the fab never moves, ending up inside the
   tray's corner. The tray is crowned by the Onyx bar (the site's chasing purple
   glow, promoted) and shows a CONTEXTUAL tool row per surface + the global apps.

   Contexts (inferred from the URL):
     /projects/<slug>  → Watch (proxies the page's #watchBtn) · Ask Onyx · Atlas · Share
     /post/<slug>      → Ask Onyx about this story · Share
     /golf|hotels|restaurants → Leaderboard · My Passport · Share · Ask Onyx
     anything else     → global apps only
*/
(function () {
  'use strict';
  if (window.__tmwMobileDock) return;
  window.__tmwMobileDock = true;

  var MOBILE = '(max-width:640px)';

  /* ---------- context ---------- */
  var path = location.pathname;
  var CTX = null;
  function h1() { var el = document.querySelector('h1'); return el ? el.textContent.trim().slice(0, 80) : document.title.split('·')[0].trim(); }
  function askOnyx(q) {
    close();
    if (window.tmwOverlay && window.tmwOverlay.open) { window.tmwOverlay.open(q || ''); return; }
    var inp = document.querySelector('.tmw-dock-search input');
    if (inp) { if (q) inp.value = q; inp.focus(); }
  }
  function share() {
    close();
    var data = { title: document.title, url: location.href };
    if (navigator.share) { navigator.share(data).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(location.href).catch(function () {});
  }
  function go(url) { return function () { location.href = url; }; }
  function proxyClick(sel) { return function () { close(); var b = document.querySelector(sel); if (b) b.click(); }; }

  var I = { /* 24×24 stroke icons */
    watch: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    onyx: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6M11 8v6"/>',
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
    CTX.tools.push({ ic: 'onyx', t: 'Ask Onyx', act: function () { askOnyx(h1()); }, cls: 'hero' });
    CTX.tools.push({ ic: 'atlas', t: 'Atlas', act: go('/atlas/') });
    CTX.tools.push({ ic: 'share', t: 'Share', act: share });
  } else if (/^\/post\//.test(path)) {
    CTX = { label: 'This story', tools: [
      { ic: 'onyx', t: 'Ask Onyx', act: function () { askOnyx(h1()); }, cls: 'hero' },
      { ic: 'share', t: 'Share', act: share }
    ] };
  } else if (/^\/(golf|hotels|restaurants)\/?/.test(path)) {
    CTX = { label: 'This list', tools: [
      { ic: 'trophy', t: 'Leaderboard', act: go('/passport/'), cls: 'act' },
      { ic: 'passport', t: 'My Passport', act: go('/dashboard/#passport') },
      { ic: 'onyx', t: 'Ask Onyx', act: function () { askOnyx(''); }, cls: 'hero' },
      { ic: 'share', t: 'Share', act: share }
    ] };
  }

  var GLOBAL = [
    { ic: 'journal', t: 'Journal', act: go('https://www.oftmw.com/') },
    { ic: 'map', t: 'Database', act: go('https://map.oftmw.com/') },
    { ic: 'passport', t: 'Passport', act: go('/passport/') },
    { ic: 'user', t: 'Dashboard', act: go('/dashboard/') }
  ];

  /* ---------- styles ---------- */
  var css = [
    '.tmwx-fab,.tmwx-tray,.tmwx-scrim{display:none}',
    '@media ' + MOBILE + '{',
    /* pill docks left to clear the corner fab (only while the fab exists) */
    'html.tmwx-on .tmw-dock{left:12px;right:74px;transform:none;max-width:none}',
    'html.tmwx-on .tmw-dock.ready{transform:none}',

    '.tmwx-scrim{display:block;position:fixed;inset:0;background:rgba(4,4,6,.5);opacity:0;pointer-events:none;transition:opacity .3s ease;z-index:9001}',
    'html.tmwx-open .tmwx-scrim{opacity:1;pointer-events:auto}',

    '.tmwx-fab{display:flex;position:fixed;right:12px;bottom:14px;width:54px;height:54px;border-radius:999px;z-index:9004;',
    'align-items:center;justify-content:center;border:none;cursor:pointer;color:#0a0a0c;background:rgba(255,255,255,.94);',
    'box-shadow:0 14px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.5)}',
    '.tmwx-fab svg{width:22px;height:22px;transition:transform .34s cubic-bezier(.34,1.45,.5,1)}',
    'html.tmwx-open .tmwx-fab svg{transform:rotate(45deg)}',

    /* tray grows taller from the dock line; fab overlaps its corner */
    '.tmwx-tray{display:block;position:fixed;left:12px;right:12px;bottom:14px;z-index:9003;border-radius:24px;padding:15px 13px 76px;',
    'background:linear-gradient(135deg,rgba(255,255,255,.15),rgba(255,255,255,.05) 40%,rgba(255,255,255,.09));',
    'backdrop-filter:blur(22px) saturate(1.6);-webkit-backdrop-filter:blur(22px) saturate(1.6);',
    'border:1px solid rgba(255,255,255,.2);box-shadow:0 14px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.26);',
    'transform:scaleY(.16) scaleX(.94);opacity:0;visibility:hidden;transform-origin:50% 100%;',
    'transition:transform .4s cubic-bezier(.3,1.3,.42,1), opacity .22s ease, visibility 0s .4s}',
    'html.tmwx-open .tmwx-tray{transform:none;opacity:1;visibility:visible;transition:transform .4s cubic-bezier(.3,1.3,.42,1), opacity .22s ease}',
    '.tmwx-in{opacity:0;transform:translateY(8px);transition:opacity .24s ease .12s, transform .3s ease .12s}',
    'html.tmwx-open .tmwx-in{opacity:1;transform:none}',

    /* the Onyx bar — the chasing purple glow, promoted into the tray */
    '.tmwx-onyx{position:relative;display:flex;align-items:center;gap:9px;border-radius:999px;padding:13px 16px;margin:0 2px 13px;',
    'background:rgba(10,10,14,.55);color:#c8c7c2;font-size:13px;cursor:pointer;isolation:isolate;border:none;width:calc(100% - 4px);text-align:left;font-family:inherit}',
    '.tmwx-onyx svg{width:15px;height:15px;color:#B9A6FF;flex:0 0 auto}',
    '.tmwx-onyx::before,.tmwx-onyx::after{content:"";position:absolute;inset:-1.5px;border-radius:999px;z-index:-1;',
    'background:conic-gradient(from var(--tmwx-sweep,0deg), transparent 0 12%, #B9A6FF 22%, #7c5cff 30%, transparent 42% 100%);',
    'animation:tmwx-chase 3.2s linear infinite}',
    '.tmwx-onyx::after{filter:blur(10px);opacity:.55}',
    '.tmwx-onyx .m{position:absolute;inset:1px;border-radius:999px;background:rgba(10,10,14,.92);z-index:-1}',

    '.tmwx-sec{font-family:ui-monospace,Menlo,monospace;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.55);margin:2px 5px 8px}',
    '.tmwx-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:9px}',
    '.tmwx-tool{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 2px 9px;border-radius:14px;cursor:pointer;border:none;background:transparent;color:#f3f1ec;font-family:inherit}',
    '.tmwx-tool:active{background:rgba(255,255,255,.12)}',
    '.tmwx-tool svg{width:21px;height:21px}',
    '.tmwx-tool span{font-size:9.5px;color:rgba(255,255,255,.85)}',
    '.tmwx-tool.hero svg{color:#E6C574}',
    '.tmwx-tool.act svg{color:#34d27b}',
    '}',
    '@property --tmwx-sweep{syntax:"<angle>";initial-value:0deg;inherits:false}',
    '@keyframes tmwx-chase{to{--tmwx-sweep:360deg}}',
    '@media (prefers-reduced-motion:reduce){.tmwx-onyx::before,.tmwx-onyx::after{animation:none}.tmwx-tray,.tmwx-fab svg,.tmwx-in{transition:none!important}}'
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

  var onyx = document.createElement('button');
  onyx.className = 'tmwx-onyx';
  onyx.innerHTML = '<span class="m"></span>' + svg(I.onyx) + '<span>' + (CTX && CTX.label === 'This project' ? 'Ask Onyx about ' + h1().split(',')[0] + '…' : 'Ask Onyx anything…') + '</span>';
  onyx.addEventListener('click', function () { askOnyx(CTX && CTX.label === 'This project' ? h1() : ''); });
  inner.appendChild(onyx);

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

  var fab = document.createElement('button');
  fab.className = 'tmwx-fab';
  fab.setAttribute('aria-label', 'All tools');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  function open() { document.documentElement.classList.add('tmwx-open'); }
  function close() { document.documentElement.classList.remove('tmwx-open'); }
  fab.addEventListener('click', function () { document.documentElement.classList.toggle('tmwx-open'); });
  scrim.addEventListener('click', close);
  addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  document.body.appendChild(scrim);
  document.body.appendChild(tray);
  document.body.appendChild(fab);
  document.documentElement.classList.add('tmwx-on');
})();
