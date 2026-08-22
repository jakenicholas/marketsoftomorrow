/* tmw-mobile-dock.js — the expandable tool dock (ALL viewports, v4).
   Loaded by journal-dock.js right after the old bottom pill initializes; the
   old pill (search + toggles) is hidden and this replaces it — EXCEPT on the
   /map surface, where the old dock IS the spatial project search: there our
   Search actions temporarily reveal + focus the native map dock (mapsearch
   mode) so nothing of the map's search/autocomplete is lost.

   Collapsed: a CENTERED cluster — icon pill (News · Atlas · Database · Search
   · Dashboard, page-aware selected circle) + the +/✕ fab. On expand BOTH
   slide outward (fab FLIP-slides right, pill fades) while the tray grows from
   the dock line. Tray sections: search bar (replica of the floating bar) →
   Homebase (News · Database · Atlas · Dashboard) → Iconic Lists (Golf ·
   Hotels · Restaurants · Passport) → contextual row for the current page.
   Every grid is a fixed 4-column: rows with fewer items fill from the left. */
(function () {
  'use strict';
  if (window.__tmwMobileDock) return;
  window.__tmwMobileDock = true;

  var path = location.pathname;
  var IS_MAP = /^\/map/.test(path);

  /* ---------- helpers ---------- */
  function h1() { var el = document.querySelector('h1'); return el ? el.textContent.trim().slice(0, 80) : document.title.split('·')[0].trim(); }
  function mapSearch() {
    closeNow();
    /* MOBILE: the search destination is the map's own discovery drawer with its
       input focused — every time, from any state. A project modal closes first;
       an already-open drawer just gets the keyboard. The old floating-pill
       "mapsearch" mode is DESKTOP-ONLY now: it hides this dock while active,
       which on mobile read as the action bar randomly disappearing (it came
       back on the next touch via the exit handler). */
    if (window.matchMedia('(max-width: 800px)').matches) {
      try { if (typeof window.closeProjectModal === 'function') window.closeProjectModal(); } catch (e) {}
      try { if (typeof window._dismissMapLanding === 'function') window._dismissMapLanding(); } catch (e) {}
      /* The map owns the search page state (full-screen panel, input docked
         at the bottom by the keyboard). Nothing else can open it. */
      if (typeof window.tmwMapMobileSearch === 'function') { window.tmwMapMobileSearch(true); return; }
      /* the v2 discovery sheet opens via the capsule; legacy drawer is the fallback */
      var cap = document.getElementById('v2Capsule');
      if (cap) { try { cap.click(); } catch (e) {} }
      else if (typeof window.mobileDrawerExpand === 'function') { try { window.mobileDrawerExpand(); } catch (e) {} }
      else { document.body.classList.add('v2-sheet-open'); }
      var minp = document.getElementById('v2SearchInput') || document.getElementById('mobileSearchBar');
      if (minp) {
        /* focus synchronously inside the tap gesture so iOS raises the
           keyboard; re-assert once the drawer's slide settles */
        try { minp.focus({ preventScroll: true }); } catch (e) { try { minp.focus(); } catch (e2) {} }
        setTimeout(function () { try { minp.focus(); } catch (e) {} }, 420);
      }
      return;
    }
    /* desktop: reveal the native map dock (the spatial search) and focus it */
    document.documentElement.classList.add('tmwx-mapsearch');
    var w = document.querySelector('.tmwx-wrap');
    if (w) w.style.display = 'none';
    var inp = document.querySelector('.tmw-dock-search input');
    if (inp) setTimeout(function () { inp.focus(); }, 60);
  }
  /* The other half of the map's purple control: open the project panel.
     Mobile opens the full-screen page; desktop un-collapses the floating box. */
  function mapList() {
    closeNow();
    if (window.matchMedia('(max-width: 800px)').matches) {
      try { if (typeof window.tmwMapMobileSearch === 'function') window.tmwMapMobileSearch(false); } catch (e) {}
      if (document.body.classList.contains('v2-sheet-open')) { document.body.classList.remove('v2-sheet-open'); return; }
      var cap = document.getElementById('v2Capsule');
      if (cap) { try { cap.click(); return; } catch (e) {} }
      if (typeof window.mobileDrawerExpand === 'function') { try { window.mobileDrawerExpand(); return; } catch (e) {} }
      document.body.classList.add('v2-sheet-open');
      return;
    }
    document.body.classList.remove('v2-sidebar-collapsed');
    var sb = document.getElementById('desktopSidebar');
    if (sb && !sb.classList.contains('open')) sb.classList.add('open');
  }
  function exitMapSearch() {
    document.documentElement.classList.remove('tmwx-mapsearch');
    var w = document.querySelector('.tmwx-wrap');
    if (w) w.style.display = '';
  }
  function openSearch(q) {
    closeNow();
    if (window.tmw && window.tmw.search) { window.tmw.search(q || ''); return; }
    if (IS_MAP) { mapSearch(); return; }
    if (window.tmwOpenSearch) { window.tmwOpenSearch(q || ''); return; }
    if (window.tmwOverlay && window.tmwOverlay.open) window.tmwOverlay.open(q || '');
  }
  function contractWatch(fallbackSel) {
    return function () {
      closeNow();
      if (window.tmw && window.tmw.watch && window.tmw.watch()) return;
      var b = document.querySelector(fallbackSel); if (b) b.click();
    };
  }
  function share() {
    closeNow();
    var data = { title: document.title, url: location.href };
    if (navigator.share) { navigator.share(data).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(location.href).catch(function () {});
  }
  // Full-page redirects route through the loading veil (Departure Board) so
  // the dock's tools trigger it exactly like link clicks do.
  function nav(url) { if (window.tmwLoader && window.tmwLoader.go) window.tmwLoader.go(url); else location.href = url; }
  function go(url) { return function () { closeNow(); nav(url); }; }
  function proxyClick(sel) { return function () { closeNow(); var b = document.querySelector(sel); if (b) b.click(); }; }

  /* icons — News + Atlas use the SAME svgs as the desktop surface toggle */
  var I = {
    news: '<path d="M3 5.2A1.2 1.2 0 0 1 4.2 4H10a2 2 0 0 1 2 2 2 2 0 0 1 2-2h5.8A1.2 1.2 0 0 1 21 5.2v12.6a1 1 0 0 1-1 1h-6a2 2 0 0 0-2 2 2 2 0 0 0-2-2H4a1 1 0 0 1-1-1z"/><path d="M12 6v14"/>',
    atlas: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    watch: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    onyx: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6M11 8v6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    /* matches #tmwDrawerHandle on the map's desktop surface */
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><polyline points="8 6 12 2 16 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
    trophy: '<path d="M8 21h8M12 17v4M6 3h12v5a6 6 0 0 1-12 0z"/><path d="M6 5H3v2a4 4 0 0 0 3 3.9M18 5h3v2a4 4 0 0 1-3 3.9"/>',
    passport: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 14h4"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    mapsearch: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><circle cx="12" cy="11.5" r="3.8"/><path d="m14.8 14.3 2.7 2.7"/>',   /* folded map with a magnifier inside */
    atlassearch: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><circle cx="16.8" cy="16.8" r="4"/><path d="m19.7 19.7 2.5 2.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8Z"/>',
    golf: '<path d="M12 18v-15l7 4-7 4"/><path d="M5 21c1.5-1.4 4-2.2 7-2.2s5.5.8 7 2.2"/>',
    hotel: '<path d="M3 21V7l9-4 9 4v14"/><path d="M3 21h18"/><path d="M9 9h1M14 9h1M9 13h1M14 13h1M11 21v-4h2v4"/>',
    dining: '<path d="M5 3v7a2 2 0 0 0 2 2v9"/><path d="M5 3v5M9 3v5M9 3v7"/><path d="M17 3c-1.7 0-3 2-3 5s1.3 4 3 4v9"/>',
    comment: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    compare: '<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/>'
  };

  /* page-aware selected states */
  var MATCH = {
    news: /^\/($|post\/|category|markets)/.test(path) && !IS_MAP,
    map: IS_MAP,
    passport: /^\/passport/.test(path),
    dashboard: /^\/dashboard/.test(path),
    atlas: /^\/atlas/.test(path),
    golf: /^\/golf/.test(path), hotels: /^\/hotels/.test(path), restaurants: /^\/restaurants/.test(path)
  };

  /* contextual row (rendered LAST, under the fixed sections) */
  var CTX = null;
  if (IS_MAP) {
    CTX = { label: 'This map', tools: [
      { ic: 'search', t: 'Search map', act: mapSearch, cls: 'hero' },
      { ic: 'watch', t: 'Watch', act: contractWatch('#pmLikeBtn'), cls: 'act' },
      /* Compare lived in the map's bottom-right rail; moved here 2026-08-10.
         compare.js owns the builder (and its own Pro gate). */
      { ic: 'compare', t: 'Compare', act: function () {
        closeNow();
        if (window.comparisons && typeof window.comparisons.openBuilder === 'function') { window.comparisons.openBuilder(); return; }
        try { var u = new URL(location.href); u.searchParams.set('view', 'compare'); nav(u.toString()); } catch (e) {}
      } },
      { ic: 'share', t: 'Share', act: share }
    ] };
  } else if (/^\/projects?\/[^/]+/.test(path)) {
    CTX = { label: 'This project', tools: [] };
    if (document.getElementById('watchBtn')) CTX.tools.push({ ic: 'watch', t: 'Watch', act: contractWatch('#watchBtn'), cls: 'act' });
    CTX.tools.push({ ic: 'onyx', t: 'Ask Onyx', act: function () { openSearch(h1()); }, cls: 'hero' });
    CTX.tools.push({ ic: 'share', t: 'Share', act: share });
  } else if (/^\/post\//.test(path)) {
    CTX = { label: 'This story', tools: [
      { ic: 'heart', t: 'Favorite', act: contractWatch('#fav-btn'), cls: 'act' },
      { ic: 'comment', t: 'Comment', act: proxyClick('#cmt-count-btn') },
      { ic: 'onyx', t: 'Ask Onyx', act: function () { openSearch(h1()); }, cls: 'hero' },
      { ic: 'share', t: 'Share', act: share }
    ] };
  } else if (/^\/(golf|hotels|restaurants)\/?/.test(path)) {
    CTX = { label: 'This list', tools: [
      { ic: 'trophy', t: 'Leaderboard', act: go('/passport/'), cls: 'act' },
      { ic: 'onyx', t: 'Ask Onyx', act: function () { openSearch(''); }, cls: 'hero' },
      { ic: 'share', t: 'Share', act: share }
    ] };
  }

  /* ---------- the SMART action ----------
     One purple, glowing quick action appended to the anchored pill — the tool
     you most likely want on THIS page. Story pages get "Favorite", the map
     gets its spatial search, the Atlas gets its market search, project pages
     get Watch. Pages with no obvious winner get none (the pill stays clean). */
  function atlasSearch() {
    closeNow();
    var inp = document.getElementById('acs-input');
    if (inp) { inp.focus(); try { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} return; }
    openSearch('');
  }
  var SMART = null;
  if (/^\/post\//.test(path))          SMART = { ic: 'heart',     t: 'Favorite this story',  act: contractWatch('#fav-btn') };
  /* The map is the one page whose own tools have to be one tap away, and the
     pill has no spare slot. So its purple action is a single capsule split in
     two: search on the left, open-the-panel on the right. Costs no slot, and
     the map icon stays lit as the page indicator. */
  else if (IS_MAP)                      SMART = [{ ic: 'search', t: 'Search the map', act: mapSearch },
                                                 { ic: 'list',   t: 'Project panel',  act: mapList }];
  else if (/^\/atlas/.test(path))       SMART = { ic: 'atlassearch', t: 'Search the Atlas',   act: atlasSearch };
  else if (/^\/projects?\//.test(path)) SMART = { ic: 'watch',     t: 'Watch this project',   act: contractWatch('#watchBtn') };

  var MAP_URL = 'https://www.oftmw.com/map/';
  var HOMEBASE = [
    { ic: 'news', t: 'News', act: go('https://www.oftmw.com/'), on: MATCH.news },
    { ic: 'atlas', t: 'Atlas', act: go('https://www.oftmw.com/atlas/'), on: MATCH.atlas },
    { ic: 'map', t: 'Map', act: go(MAP_URL), on: MATCH.map },
    { ic: 'user', t: 'Dashboard', act: go('/dashboard/'), on: MATCH.dashboard }
  ];
  var LISTS = [
    { ic: 'golf', t: 'Golf', act: go('/golf/#list'), on: MATCH.golf },
    { ic: 'hotel', t: 'Hotels', act: go('/hotels/#list'), on: MATCH.hotels },
    { ic: 'dining', t: 'Restaurants', act: go('/restaurants/#list'), on: MATCH.restaurants },
    { ic: 'passport', t: 'Passport', act: go('/passport/'), on: MATCH.passport }
  ];
  // Pulse bell — the header bell moved here (journal-dock hides its copy under
  // the dock but keeps it alive as the count source, and exposes the toggle).
  function openPulse(ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();   // the pop's outside-click closer must not see this click
    closeNow();
    if (window.tmwPulseToggle && window.tmwPulseToggle(true)) return;
    nav('/dashboard/');   // pop not built (yet) → the dashboard carries the feed
  }
  var PILL = [
    { ic: 'news', t: 'News', act: go('https://www.oftmw.com/'), on: MATCH.news },
    { ic: 'atlas', t: 'Atlas', act: go('https://www.oftmw.com/atlas/'), on: MATCH.atlas },
    { ic: 'map', t: 'Map', act: go(MAP_URL), on: MATCH.map },
    { ic: 'search', t: 'TMW Intelligence', act: function () { openSearch(''); } },
    { ic: 'watch', t: 'Pulse', act: openPulse, cls: 'bell' },
    { ic: 'user', t: 'Dashboard', act: go('/dashboard/'), on: MATCH.dashboard }
  ];

  /* ---------- styles (flat dark glass) ---------- */
  var GLASS = 'background:rgba(9,11,9,.82);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);border:1px solid rgba(255,255,255,.13);box-shadow:0 16px 50px rgba(0,0,0,.55)';
  var css = [
    /* retire the old pill + its autocomplete — EXCEPT in mapsearch mode, where
       the native dock (the map's spatial search) is revealed on demand */
    'html.tmwx-on:not(.tmwx-mapsearch) .tmw-dock{display:none !important}',
    'html.tmwx-on:not(.tmwx-mapsearch) .tmw-dock-ac{display:none !important}',
    'html.tmwx-mapsearch .tmw-dock > *:not(.tmw-dock-search){display:none !important}',
    'html.tmwx-mapsearch .tmwx-wrap{opacity:0;pointer-events:none}',

    '.tmwx-scrim{position:fixed;inset:0;background:rgba(4,4,6,.5);opacity:0;pointer-events:none;transition:opacity .3s ease;z-index:9001}',
    'html.tmwx-open .tmwx-scrim{opacity:1;pointer-events:auto}',

    '.tmwx-wrap{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9002;display:flex;align-items:flex-end;justify-content:flex-end;gap:8px;pointer-events:none;transition:opacity .2s ease}',
    'html.tmwx-open .tmwx-wrap{width:min(100vw - 24px, 480px)}',

    '.tmwx-pill{pointer-events:auto;display:flex;align-items:center;gap:2px;padding:6px;border-radius:999px;' + GLASS + ';',
    'transition:opacity .22s ease, transform .3s cubic-bezier(.34,1.45,.5,1)}',
    'html.tmwx-open .tmwx-pill{position:absolute;right:62px;bottom:0;opacity:0;transform:translateX(-18px) scale(.92);pointer-events:none}',
    '.tmwx-pbtn{width:44px;height:44px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#ECEAE5;border:none;background:transparent;cursor:pointer;transition:background .18s}',
    '.tmwx-pbtn.bell{position:relative}',
    '.tmwx-nbadge{position:absolute;top:3px;right:1px;min-width:16px;height:16px;border-radius:999px;background:linear-gradient(135deg,#f0d68a,#caa84f);color:#12091f;font:800 9px/16px "Inter",-apple-system,sans-serif;padding:0 4px;text-align:center;box-shadow:0 0 10px rgba(230,197,116,.5);pointer-events:none}',
    '.tmwx-nbadge[hidden]{display:none}',
    '.tmwx-pbtn.on{background:rgba(255,255,255,.16)}',
    '.tmwx-pbtn:active{background:rgba(255,255,255,.2)}',
    '.tmwx-pbtn svg{width:20px;height:20px}',

    '.tmwx-fab{pointer-events:auto;width:54px;height:54px;border-radius:999px;display:flex;align-items:center;justify-content:center;',
    'border:1px solid rgba(255,255,255,.13);cursor:pointer;color:#ECEAE5;background:rgba(9,11,9,.82);',
    'backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);flex:0 0 auto;z-index:9004;',
    'transition:background .2s ease,color .2s ease,border-color .2s ease;box-shadow:0 14px 40px rgba(0,0,0,.5)}',
    // Collapsed (+) matches the dock glass; opening flips it to the white close (✕) chip.
    'html.tmwx-open .tmwx-fab{color:#0a0a0c;background:rgba(255,255,255,.94);border-color:transparent;',
    'box-shadow:0 14px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.5)}',
    '.tmwx-fab svg{width:22px;height:22px;transition:transform .34s cubic-bezier(.34,1.45,.5,1)}',
    'html.tmwx-open .tmwx-fab svg{transform:rotate(45deg)}',

    '.tmwx-tray{pointer-events:auto;position:absolute;left:0;right:62px;bottom:0;border-radius:24px;padding:15px 13px 13px;' + GLASS + ';',
    'transform:scaleY(.16) scaleX(.94);opacity:0;visibility:hidden;transform-origin:50% 100%;',
    'transition:transform .4s cubic-bezier(.3,1.3,.42,1), opacity .22s ease, visibility 0s .4s}',
    'html.tmwx-open .tmwx-tray{transform:none;opacity:1;visibility:visible;transition:transform .4s cubic-bezier(.3,1.3,.42,1), opacity .22s ease}',
    '.tmwx-in{opacity:0;transform:translateY(8px);transition:opacity .24s ease .12s, transform .3s ease .12s}',
    'html.tmwx-open .tmwx-in{opacity:1;transform:none}',

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

    '.tmwx-sec{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:9.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.55);margin:2px 5px 8px}',
    '.tmwx-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:9px;justify-items:stretch}',
    '.tmwx-grid:last-child{margin-bottom:2px}',
    '.tmwx-tool{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 2px 9px;border-radius:14px;cursor:pointer;border:none;background:transparent;color:#f3f1ec;font-family:inherit;transition:background .16s}',
    '.tmwx-tool:hover{background:rgba(255,255,255,.08)}',
    '.tmwx-tool:active{background:rgba(255,255,255,.12)}',
    '.tmwx-tool.on{background:rgba(255,255,255,.13)}',
    '.tmwx-tool svg{width:21px;height:21px}',
    '.tmwx-tool span{font-size:9.5px;color:rgba(255,255,255,.85)}',
    /* contextual-row icons stay the same neutral gray as every other tool —
       no colored icons anywhere in the expanded tray */
    '/* the GL-heavy map page stalls CSS transitions (they hold their START frame '+
    'forever) - run every dock state change instantly there */',
    'html.tmwx-instant .tmwx-tray,html.tmwx-instant .tmwx-fab svg,html.tmwx-instant .tmwx-in,html.tmwx-instant .tmwx-pill,html.tmwx-instant .tmwx-scrim,html.tmwx-instant .tmwx-wrap{transition:none !important}',
    /* custom hover tooltips — DESKTOP ONLY (hover-capable, fine pointer) */
    '@media (hover:hover) and (pointer:fine){',
    '.tmwx-pbtn,.tmwx-fab{position:relative}',
    /* gray highlight circle on hover — same treatment the tray tools already
       have. Skips .on (already brighter at .16) and .smart (purple hover). */
    '.tmwx-pbtn:not(.on):not(.smart):hover{background:rgba(255,255,255,.1)}',
    'html:not(.tmwx-open) .tmwx-fab:hover{background:rgba(36,39,36,.88);border-color:rgba(255,255,255,.24)}',
    '.tmwx-pbtn[data-tip]::after,.tmwx-fab[data-tip]::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 11px);left:50%;',
    'transform:translateX(-50%) translateY(5px);white-space:nowrap;padding:8px 12px;border-radius:10px;',
    'background:rgba(9,11,9,.94);border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.5);',
    'color:#ECEAE5;font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:11px;font-weight:600;letter-spacing:.02em;line-height:1;',
    'opacity:0;pointer-events:none;z-index:9006;transition:opacity .16s ease, transform .2s ease}',
    '.tmwx-pbtn[data-tip]:hover::after,.tmwx-fab[data-tip]:hover::after{opacity:1;transform:translateX(-50%) translateY(0);transition-delay:.22s}',
    '}',
    /* the smart action — purple, glowing, unmistakably the suggested tool */
    '.tmwx-pbtn.smart{color:#C4B5FD;background:rgba(167,139,250,.13);margin-left:3px;',
    'box-shadow:inset 0 0 0 1px rgba(167,139,250,.42), 0 0 14px rgba(167,139,250,.32);',
    'animation:tmwxSmartGlow 2.6s ease-in-out infinite}',
    '.tmwx-pbtn.smart:hover{background:rgba(167,139,250,.22)}',
    /* Two actions sharing ONE purple slot: the group carries the glow and the
       halves go flat, so it still reads as a single smart control. */
    '.tmwx-smartgrp{display:flex;align-items:center;margin-left:3px;border-radius:999px;',
    'background:rgba(167,139,250,.13);',
    'box-shadow:inset 0 0 0 1px rgba(167,139,250,.42), 0 0 14px rgba(167,139,250,.32);',
    'animation:tmwxSmartGlow 2.6s ease-in-out infinite}',
    '.tmwx-smartgrp .tmwx-pbtn.smart{width:40px;margin:0;background:transparent;box-shadow:none;animation:none}',
    '.tmwx-smartgrp .tmwx-pbtn.smart:first-child{border-radius:999px 0 0 999px}',
    '.tmwx-smartgrp .tmwx-pbtn.smart:last-child{border-radius:0 999px 999px 0}',
    '.tmwx-smartgrp .tmwx-pbtn.smart:hover{background:rgba(167,139,250,.22)}',
    '.tmwx-smartgrp .tmwx-pbtn.smart:active{background:rgba(167,139,250,.3)}',
    '.tmwx-smartgrp .tmwx-div{width:1px;height:22px;flex:0 0 auto;background:rgba(167,139,250,.34)}',
    '@keyframes tmwxSmartGlow{0%,100%{box-shadow:inset 0 0 0 1px rgba(167,139,250,.42),0 0 10px rgba(167,139,250,.26)}50%{box-shadow:inset 0 0 0 1px rgba(167,139,250,.7),0 0 22px rgba(167,139,250,.55)}}',
    '.tmwx-search .si svg{width:100%;height:100%;display:block;overflow:visible}',
    /* The intelligence mark reads a touch larger than the other glyphs. */
    '.tmwx-pbtn svg.txs-mark{width:24px;height:24px}',
    '.tmwx-search .si:has(.txs-mark){width:24px;height:24px}',
    /* The intelligence mark rests in Onyx purple so the AI bar reads as a
       different tool from the map/Atlas magnifiers (static; the spinning
       hexagon morph was reverted 2026-08-21). */
    '.tmwx-pbtn:has(.txs-mark){color:#C4B5FD}',
    '.tmwx-pbtn:has(.txs-mark):hover{background:rgba(167,139,250,.14)}',
    '.tmwx-search .si:has(.txs-mark){color:#C4B5FD}',
    '@media (prefers-reduced-motion:reduce){.tmwx-search::before{animation:none}.tmwx-tray,.tmwx-fab svg,.tmwx-in,.tmwx-pill{transition:none!important}.tmwx-pbtn.smart{animation:none}}'
  ].join('');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ---------- DOM ---------- */
  function svg(paths) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>'; }
  function toolBtn(t) {
    var b = document.createElement('button');
    b.className = 'tmwx-tool' + (t.cls ? ' ' + t.cls : '') + (t.on ? ' on' : '');
    b.innerHTML = svg(I[t.ic]) + '<span>' + t.t + '</span>';
    b.addEventListener('click', t.act);
    return b;
  }

  var scrim = document.createElement('div'); scrim.className = 'tmwx-scrim';
  var wrap = document.createElement('div'); wrap.className = 'tmwx-wrap';
  var tray = document.createElement('div'); tray.className = 'tmwx-tray';
  var inner = document.createElement('div'); inner.className = 'tmwx-in';

  var sw = document.createElement('div'); sw.className = 'tmwx-search';
  /* The TMW Intelligence mark: the Onyx sparkle (Option A from the icon
     mockups), static, resting purple. It replaces the spinning-hexagon morph;
     the map and Atlas searches keep their magnifiers. */
  var HEX_SI =
    '<svg class="txs-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 2.5l2.3 5.9 5.9 2.3-5.9 2.3L12 18.9l-2.3-5.9L3.8 10.7l5.9-2.3z"/>' +
    '</svg>';
  sw.innerHTML = '<span class="si">' + HEX_SI + '</span>' +
    '<input type="search" autocomplete="off" placeholder="Search projects, firms, places…" aria-label="Search projects, firms, places, brands, and more">';
  var sInput = sw.querySelector('input');
  sInput.addEventListener('focus', function () { sInput.blur(); openSearch(''); });
  sw.addEventListener('click', function () { openSearch(''); });
  inner.appendChild(sw);

  function section(label, tools) {
    var s = document.createElement('div'); s.className = 'tmwx-sec'; s.textContent = label; inner.appendChild(s);
    var g = document.createElement('div'); g.className = 'tmwx-grid';
    tools.forEach(function (t) { g.appendChild(toolBtn(t)); });
    inner.appendChild(g);
  }
  section('Homebase', HOMEBASE);
  section('Iconic Lists', LISTS);
  if (CTX && CTX.tools.length) section(CTX.label, CTX.tools);
  tray.appendChild(inner);

  var pill = document.createElement('div'); pill.className = 'tmwx-pill';
  var bellBtn = null;
  PILL.forEach(function (t) {
    var b = document.createElement('button');
    b.className = 'tmwx-pbtn' + (t.cls ? ' ' + t.cls : '') + (t.on ? ' on' : '');
    b.setAttribute('aria-label', t.t);
    b.setAttribute('data-tip', t.t);
    /* The Search pill wears the Onyx sparkle, same as the tray's search
       bar - intelligence search is the sparkle everywhere in this dock. */
    b.innerHTML = (t.ic === 'search') ? HEX_SI : svg(I[t.ic]);
    if (t.cls === 'bell') { b.innerHTML += '<span class="tmwx-nbadge" hidden></span>'; bellBtn = b; }
    b.addEventListener('click', t.act);
    pill.appendChild(b);
  });
  // Badge count mirrors the (hidden) header bell — journal-dock repaints it on
  // every feed change, so clearing tiles in the pop updates this live.
  if (bellBtn) (function () {
    var badge = bellBtn.querySelector('.tmwx-nbadge'), src = null, tries = 0;
    function syncBadge() {
      var c = parseInt(String((src && src.textContent) || '').replace(/[^\d]/g, ''), 10) || 0;
      if (c > 0) { badge.textContent = c > 99 ? '99+' : String(c); badge.hidden = false; }
      else badge.hidden = true;
    }
    (function find() {
      src = document.getElementById('tmw-pulse-bell');
      if (src) {
        syncBadge();
        if (window.MutationObserver) new MutationObserver(syncBadge).observe(src, { childList: true, characterData: true, subtree: true });
        return;
      }
      if (++tries < 40) setTimeout(find, 700);
    })();
  })();
  if (SMART) {
    var smarts = [].concat(SMART);
    var host = pill;
    if (smarts.length > 1) {
      host = document.createElement('div');
      host.className = 'tmwx-smartgrp';
      pill.appendChild(host);
    }
    smarts.forEach(function (S, i) {
      if (i && host !== pill) {
        var dv = document.createElement('span'); dv.className = 'tmwx-div'; host.appendChild(dv);
      }
      var sb = document.createElement('button');
      sb.className = 'tmwx-pbtn smart';
      sb.setAttribute('aria-label', S.t);
      sb.setAttribute('data-tip', S.t);
      sb.innerHTML = svg(I[S.ic]);
      sb.addEventListener('click', S.act);
      host.appendChild(sb);
    });
  }

  var fab = document.createElement('button');
  fab.className = 'tmwx-fab';
  fab.setAttribute('aria-label', 'All tools');
  fab.setAttribute('data-tip', 'All tools');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  /* FLIP the fab so it slides between its center-cluster and right-edge spots */
  function toggleOpen() {
    var first = fab.getBoundingClientRect().left;
    document.documentElement.classList.toggle('tmwx-open');
    var last = fab.getBoundingClientRect().left;
    var dx = first - last;
    if (dx && !IS_MAP) {
      fab.style.transition = 'none';
      fab.style.transform = 'translateX(' + dx + 'px)';
      void fab.offsetWidth;
      fab.style.transition = 'transform .38s cubic-bezier(.3,1.3,.42,1)';
      fab.style.transform = '';
      fab.addEventListener('transitionend', function te() { fab.style.transition = ''; fab.removeEventListener('transitionend', te); });
    }
  }
  function closeNow() { if (document.documentElement.classList.contains('tmwx-open')) toggleOpen(); }
  fab.addEventListener('click', toggleOpen);
  scrim.addEventListener('click', closeNow);
  addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (document.documentElement.classList.contains('tmwx-mapsearch')) { exitMapSearch(); return; }
    closeNow();
  });
  /* leave mapsearch mode when tapping outside the native dock + its popup */
  if (IS_MAP) {
    document.addEventListener('pointerdown', function (e) {
      if (!document.documentElement.classList.contains('tmwx-mapsearch')) return;
      if (e.target.closest('.tmw-dock') || e.target.closest('.tmw-dock-ac')) return;
      exitMapSearch();
    }, true);
    /* focus leaving the native search (result chosen / keyboard closed) also
       exits — the stuck old-dock-behind-new-dock bug came from missing this */
    document.addEventListener('focusout', function (e) {
      if (!document.documentElement.classList.contains('tmwx-mapsearch')) return;
      if (!e.target.closest || !e.target.closest('.tmw-dock')) return;
      setTimeout(function () {
        var a = document.activeElement;
        if (a && a.closest && (a.closest('.tmw-dock') || a.closest('.tmw-dock-ac'))) return;
        exitMapSearch();
      }, 300);
    }, true);
  }

  wrap.appendChild(tray);
  wrap.appendChild(pill);
  wrap.appendChild(fab);
  document.body.appendChild(scrim);
  document.body.appendChild(wrap);
  document.documentElement.classList.add('tmwx-on');
  if (IS_MAP) document.documentElement.classList.add('tmwx-instant');
})();
