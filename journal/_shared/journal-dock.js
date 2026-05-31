/* ------------------------------------------------------------------
   Markets of Tomorrow — pinned journal dock
   Injects a fixed bottom-center pill on every public journal page:
     [ map ]   [ search input ]   [ home ]
   - map icon  → the interactive map (map.oftmw.com)
   - search    → submits to the journal search page (/journal/search/?q=)
   - home icon → journal home (www.oftmw.com; domain moving soon)
   Self-contained, no dependencies. Include once per page:
     <script src="/journal/_shared/journal-dock.js" defer></script>
-------------------------------------------------------------------*/
(function () {
  'use strict';
  if (window.__tmwDock) return;
  window.__tmwDock = true;

  // ── Destinations (single source of truth; update when domain moves) ──
  var MAP_URL     = 'https://map.oftmw.com';
  var HOME_URL    = 'https://www.oftmw.com';
  var SEARCH_PAGE = '/journal/search/';

  // ── Icons (inline SVG, currentColor) ──
  var ICON_MAP =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z"/><path d="M9 4v13"/><path d="M15 6.5v13"/></svg>';
  var ICON_SEARCH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>';
  var ICON_HOME =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9.5h5.5V14h3v5.5H19V10"/></svg>';
  var IG_URL  = 'https://www.instagram.com/floridaoftomorrow';
  var ICON_IG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor" stroke="none"/></svg>';

  // ── Styles ──
  var css = [
    '.tmw-dock{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9000;',
    'display:flex;align-items:center;gap:8px;padding:8px;',
    'background:rgba(9,11,9,.82);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);',
    'border:1px solid rgba(255,255,255,.13);border-radius:999px;',
    'box-shadow:0 16px 50px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.25);',
    'font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:calc(100vw - 24px);',
    'opacity:0;transform:translateX(-50%) translateY(10px);transition:opacity .4s ease,transform .4s cubic-bezier(.22,1,.36,1)}',
    '.tmw-dock.ready{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.tmw-dock-btn{width:46px;height:46px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;',
    'border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);',
    'color:#ECEAE5;transition:background .2s,color .2s,border-color .2s,transform .2s;cursor:pointer;text-decoration:none}',
    '.tmw-dock-btn:hover{background:#1FDF67;color:#070807;border-color:#1FDF67;transform:translateY(-1px)}',
    '.tmw-dock-btn svg{width:20px;height:20px}',
    '.tmw-dock-search{position:relative;display:flex;align-items:center;margin:0}',
    '.tmw-dock-search .ds-ico{position:absolute;left:15px;width:16px;height:16px;color:#9AA39C;pointer-events:none}',
    '.tmw-dock-search input{height:46px;width:min(46vw,300px);padding:0 18px 0 42px;',
    'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:999px;',
    'color:#fff;font-size:14px;font-family:inherit;outline:none;transition:border-color .2s,background .2s,width .25s ease}',
    '.tmw-dock-search input::placeholder{color:#9AA39C}',
    '.tmw-dock-search input:focus{border-color:rgba(31,223,103,.55);background:rgba(255,255,255,.08);width:min(52vw,344px)}',
    '@media(max-width:560px){.tmw-dock{bottom:14px;gap:6px;padding:6px}.tmw-dock-btn{width:42px;height:42px}',
    '.tmw-dock-btn svg{width:18px;height:18px}.tmw-dock-search input{width:46vw;height:42px}',
    '.tmw-dock-search input:focus{width:50vw}}',
    'body{padding-bottom:104px}',
    // ── Mobile hardening: no horizontal scroll, ever. overflow-x:clip clips
    //    runaway/fixed/absolute elements WITHOUT forcing overflow-y:auto (so the
    //    sticky header keeps working — which plain overflow:hidden would break).
    'html{overflow-x:clip}',
    'body{overflow-x:clip; max-width:100%}',
    // Disable double-tap-to-zoom (and the 300ms tap delay) site-wide.
    'html{touch-action:manipulation}',
    // ── Mobile header: burger LEFT, logo CENTERED + smaller, Open Map RIGHT.
    //    Targets nav.main so it applies to every journal header (inline pages +
    //    the shared chrome). Higher specificity than the pages' own mobile rules.
    '@media(max-width:980px){',
    // Lift the header above the pulse ticker so the open dropdown covers it
    // (otherwise the first item sits behind the ticker). Pad the top by the
    // safe-area inset so the logo/burger/Instagram clear the phone notch when
    // the header is stuck to the top of the viewport (viewport-fit=cover).
    'nav.main{position:relative; z-index:40; padding-top:env(safe-area-inset-top,0px)}',
    '.sticky-stack,.tmw-chrome-head{top:0}',
    'nav.main .wrap{position:relative; gap:10px}',
    'nav.main .nav-burger{display:flex; order:0; background:none; border:0; cursor:pointer; z-index:2}',
    'nav.main .nav-cta{order:1; margin-left:auto; padding:7px 8px 7px 12px; z-index:2}',
    'nav.main .tmw-logo-lockup{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); margin:0; z-index:1}',
    'nav.main .tmw-wordmark{width:74px}',
    'nav.main .tmw-hex-badge{width:16px; height:16px}',
    'nav.main .nav-links{order:5; position:absolute; top:100%; left:0; right:0; display:none; flex-direction:column; gap:0; align-items:stretch; width:auto; margin:0; background:rgba(7,8,7,.97); -webkit-backdrop-filter:blur(16px) saturate(1.4); backdrop-filter:blur(16px) saturate(1.4); border-bottom:1px solid var(--hair); padding:6px 22px 16px; max-height:calc(100vh - 60px); overflow-y:auto}',
    'nav.main .nav-links.open{display:flex}',
    'nav.main .nav-links a{padding:14px 2px; border-bottom:1px solid var(--hair); font-size:12.5px}',
    'nav.main .nav-links a:last-child{border-bottom:0}',
    'nav.main .nav-links a.active::after{display:none}',
    'nav.main .nav-burger.is-open span:nth-child(1){transform:translateY(6.5px) rotate(45deg)}',
    'nav.main .nav-burger.is-open span:nth-child(2){opacity:0}',
    'nav.main .nav-burger.is-open span:nth-child(3){transform:translateY(-6.5px) rotate(-45deg)}',
    '}',

    // ── Remove the animated "intelligence" hex badge from every logo (header +
    //    footer). Hidden, so the lockup re-centers on its own.
    '.tmw-hex-badge{display:none !important}',
    // Smaller wordmark in the header on desktop (mobile 74px is set above).
    'nav.main .tmw-wordmark{width:92px}',

    // ── Header stacking: nav.main has a backdrop-filter, so it forms its own
    //    stacking context. Static (the default) it would paint BELOW the
    //    positioned pulse ticker, hiding the open Focus Markets dropdown behind
    //    it. Promote nav.main above the ticker so the dropdown sits on top.
    'nav.main{position:relative; z-index:50}',

    // ── Header CTA swapped from "Open Map" to an Instagram icon button.
    //    No circle: transparent bg + no border, just the glyph.
    '.nav-cta.tmw-ig{padding:0; width:42px; height:42px; min-width:42px; justify-content:center; gap:0; overflow:visible; background:transparent !important; border:0 !important; box-shadow:none !important}',
    '.nav-cta.tmw-ig::before{display:none !important}',
    '.nav-cta.tmw-ig:hover{background:transparent !important; border-color:transparent !important; transform:none !important}',
    '.nav-cta.tmw-ig svg{width:22px; height:22px; color:var(--cream); transition:color .2s}',
    '.nav-cta.tmw-ig:hover svg{color:#fff}',
    '@media(max-width:980px){.nav-cta.tmw-ig{width:38px; height:38px; min-width:38px}}',

    // ── Top featured ad banner: explicit heights per device, full width, no
    //    sponsor chip. (Inline page rule is clamp(180px,22vw,280px).)
    '.banner-ad{max-height:300px; width:100%; max-width:100vw}',
    '.featured-carousel{height:260px; width:100%}',
    '.fc-track,.fc-slide{width:100%; left:0; right:0}',
    '.fc-slide video,.fc-slide img{width:100%; height:100%; object-fit:cover; object-position:center}',
    '.fc-sponsor{display:none !important}',

    // ── Featured-hero vertical tabs — modernized, applied on every page.
    '.story-card .sc-tabs{padding:5px; gap:4px; background:rgba(9,11,9,.74); border:1px solid rgba(255,255,255,.12); box-shadow:0 22px 50px -18px rgba(0,0,0,.78), inset 0 1px 0 rgba(255,255,255,.06)}',
    '.story-card .sc-tab{padding:11px 22px; font-size:11.5px; letter-spacing:.16em; color:var(--mute-2); border-radius:999px; transition:background .2s, color .2s, box-shadow .2s, transform .15s}',
    '.story-card .sc-tab:hover{background:rgba(255,255,255,.06); color:#fff; transform:translateY(-1px)}',
    '.story-card .sc-tab.on{background:#fff; color:var(--ink); font-weight:700; box-shadow:0 6px 16px -6px rgba(255,255,255,.5)}',
    '@media(max-width:560px){.story-card .sc-tab{padding:9px 15px; font-size:10.5px; letter-spacing:.12em}}',

    // ── Rank-page section tabs: no counts, single row, cleaner sort control.
    '.tab-btn .tb-count{display:none}',
    '.tabs{flex-wrap:nowrap}',
    '.tabs .tab-btn{white-space:nowrap}',
    '.tabs-bar .sort{background-color:transparent; border:0; padding-left:2px}',
    '.tabs-bar .sort:focus{border:0}',
    '@media(max-width:560px){.tabs .tab-btn{padding:8px 12px; font-size:10px; letter-spacing:.07em}.tabs{padding:4px}}',

    // ── Header nav: drop the green underline; gold glow text on hover/active.
    '.nav-links a.active::after, .tmw-chrome-head .nav-links a.active::after, nav.main .nav-links a.active::after{display:none !important}',
    '.nav-links a:hover, .nav-links a.active, .tmw-chrome-head .nav-links a:hover, .tmw-chrome-head .nav-links a.active{color:var(--gold-soft) !important; text-shadow:0 0 14px rgba(230,197,116,.55), 0 0 3px rgba(230,197,116,.35)}',

    // ── Rank-page CTA (Book a table / Website): subtle gold-glow text, no fill.
    '.btn-cta{background:transparent !important; color:var(--gold-soft) !important; padding:8px 0 !important; border-radius:0 !important; text-shadow:0 0 14px rgba(230,197,116,.5), 0 0 3px rgba(230,197,116,.32)}',
    '.btn-cta:hover{background:transparent !important; transform:none !important; gap:11px}',
    '.btn-cta svg{color:var(--gold-soft)}',
    '@media(max-width:980px){.banner-ad{max-height:170px}.featured-carousel{height:151px}}',
    '@media(max-width:560px){.banner-ad{max-height:120px}.featured-carousel{height:100px}}',

    // ── Hide the public in-page "Edit" toggle on the list/ranking pages.
    '.edit-toggle{display:none !important}',

    // ── Dock search: purple "intelligence" glow chasing around the border.
    '@property --tmw-ang{syntax:"<angle>"; inherits:false; initial-value:0deg}',
    '@keyframes tmwChase{to{--tmw-ang:360deg}}',
    '.tmw-dock-search{border-radius:999px}',
    '.tmw-dock-search input{position:relative; z-index:1}',
    '.tmw-dock-search .ds-ico{z-index:2}',
    '.tmw-dock-search::before{content:""; position:absolute; inset:-1.5px; border-radius:999px; padding:1.5px; z-index:0; pointer-events:none; background:conic-gradient(from var(--tmw-ang,0deg), rgba(167,139,250,0) 0deg, rgba(167,139,250,0) 205deg, #A78BFA 300deg, #E9DEFF 338deg, rgba(167,139,250,0) 360deg); -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; filter:drop-shadow(0 0 5px rgba(167,139,250,.7)); animation:tmwChase 3s linear infinite}',
    '@media(prefers-reduced-motion:reduce){.tmw-dock-search::before{animation:none}}',

    // ── Focus Markets dropdown (header): replaces the per-region links with a
    //    single mega-menu of 5 rounded market tiles. 3-col desktop / 2-col mobile.
    '.tmw-fm{position:relative; display:inline-flex; align-items:center}',
    '.tmw-fm-trigger{font-family:var(--mono,"JetBrains Mono",monospace); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--mute-2,#C2C9C3); background:none; border:0; cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:0; line-height:1; transition:color .2s}',
    '.tmw-fm-trigger:hover, .tmw-fm.open .tmw-fm-trigger{color:var(--gold-soft,#f0d68a); text-shadow:0 0 14px rgba(230,197,116,.55), 0 0 3px rgba(230,197,116,.35)}',
    '.tmw-fm-chev{width:10px; height:10px; transition:transform .22s ease}',
    '.tmw-fm.open .tmw-fm-chev{transform:rotate(180deg)}',
    '.tmw-fm-panel{position:absolute; top:calc(100% + 16px); left:50%; transform:translateX(-50%) translateY(-8px); width:min(640px,92vw); display:grid; grid-template-columns:repeat(3,1fr); gap:11px; padding:15px; background:rgba(9,11,9,.97); -webkit-backdrop-filter:blur(18px) saturate(1.4); backdrop-filter:blur(18px) saturate(1.4); border:1px solid rgba(255,255,255,.10); border-radius:18px; box-shadow:0 26px 64px rgba(0,0,0,.6); opacity:0; visibility:hidden; pointer-events:none; transition:opacity .22s ease, transform .22s cubic-bezier(.22,1,.36,1); z-index:80}',
    '.tmw-fm-panel::before{content:""; position:absolute; top:-16px; left:0; right:0; height:16px}', // hover bridge across the gap
    '.tmw-fm.open .tmw-fm-panel, .tmw-fm:hover .tmw-fm-panel{opacity:1; visibility:visible; pointer-events:auto; transform:translateX(-50%) translateY(0)}',
    '.tmw-fm-tile{position:relative; display:block; aspect-ratio:4/3; border-radius:13px; overflow:hidden; background:#141714 center/cover no-repeat; text-decoration:none; box-shadow:inset 0 0 0 1px rgba(255,255,255,.07); transition:box-shadow .2s, transform .2s}',
    '.tmw-fm-tile::after{content:""; position:absolute; inset:0; background:linear-gradient(180deg, rgba(7,8,7,0) 28%, rgba(7,8,7,.82) 100%); transition:background .2s ease}',
    '.tmw-fm-tile:hover{transform:translateY(-2px); box-shadow:inset 0 0 0 1px rgba(230,197,116,.5), 0 10px 26px rgba(0,0,0,.4)}',
    '.tmw-fm-tile:hover::after{background:linear-gradient(180deg, rgba(31,223,103,.10) 0%, rgba(7,8,7,.86) 100%)}',
    '.tmw-fm-name{position:absolute; left:13px; bottom:11px; z-index:1; font-family:var(--serif,"Fraunces",Georgia,serif); font-weight:600; font-size:17px; letter-spacing:-.01em; color:#fff; text-shadow:0 2px 12px rgba(0,0,0,.65)}',
    // mobile: Focus Markets is a full-width accordion inside the burger drawer
    '@media(max-width:980px){.tmw-fm{display:block; width:100%}',
    '.tmw-fm-trigger{width:100%; justify-content:space-between; padding:14px 2px; border-bottom:1px solid rgba(255,255,255,.08); font-size:12.5px}',
    '.tmw-fm-panel{position:static; transform:none; width:auto; grid-template-columns:repeat(2,1fr); gap:9px; padding:12px 0 6px; background:transparent; border:0; box-shadow:none; opacity:1; pointer-events:auto; display:none; visibility:visible}',
    // override the desktop open/hover transform (translateX(-50%)) which would
    // otherwise shove the static panel off-screen left inside the drawer
    '.tmw-fm.open .tmw-fm-panel, .tmw-fm:hover .tmw-fm-panel{display:none; transform:none; left:auto}',
    '.tmw-fm.open .tmw-fm-panel{display:grid; transform:none; left:auto}',
    '.tmw-fm-name{font-size:15px}}'
  ].join('');

  function mount() {
    // Lock the viewport: prevents iOS input-focus zoom (maximum-scale=1) and
    // pinch/double-tap zoom (user-scalable=no). viewport-fit=cover for notches.
    var vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement('meta'); vp.setAttribute('name', 'viewport'); document.head.appendChild(vp); }
    vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');

    // Favicon — set on every journal page.
    if (!document.querySelector('link[rel="icon"]')) {
      var fav = document.createElement('link');
      fav.rel = 'icon';
      fav.type = 'image/png';
      fav.href = 'https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png';
      document.head.appendChild(fav);
    }

    var style = document.createElement('style');
    style.setAttribute('data-tmw-dock', '');
    style.textContent = css;
    document.head.appendChild(style);

    var dock = document.createElement('div');
    dock.className = 'tmw-dock';
    dock.setAttribute('role', 'navigation');
    dock.setAttribute('aria-label', 'Journal');
    dock.innerHTML =
      '<a class="tmw-dock-btn" href="' + MAP_URL + '" title="Open the live map" aria-label="Open the live map">' + ICON_MAP + '</a>' +
      '<form class="tmw-dock-search" role="search" action="' + SEARCH_PAGE + '" method="get">' +
        '<span class="ds-ico">' + ICON_SEARCH + '</span>' +
        '<input name="q" type="search" autocomplete="off" placeholder="Search projects, firms, cities…" aria-label="Search">' +
      '</form>' +
      '<a class="tmw-dock-btn" href="' + HOME_URL + '" title="Journal home" aria-label="Journal home">' + ICON_HOME + '</a>';

    // Submit → navigate to the search page with ?q=
    var form  = dock.querySelector('form');
    var input = dock.querySelector('input');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = (input.value || '').trim();
      window.location.href = SEARCH_PAGE + (q ? '?q=' + encodeURIComponent(q) : '');
    });

    document.body.appendChild(dock);
    requestAnimationFrame(function () { dock.classList.add('ready'); });

    buildFocusMarkets();
    wireBurgers();
    swapToInstagram();
  }

  // ── Focus Markets ───────────────────────────────────────────────────
  // The header used to list each region as its own nav link. Consolidate the
  // five into a single "Focus Markets" dropdown (after "Global") with rounded
  // image tiles. Each tile lands on the journal home filtered to that market
  // (?market=<key> → the existing category-pill filter). Universal: runs on
  // every journal page (incl. the 1,377 pre-rendered article pages) since they
  // all load this dock — no per-page nav edits or regeneration needed.
  var JOURNAL_HOME = '/journal/';
  var FOCUS_MARKETS = [
    { key: 'florida',   name: 'Florida',   img: 'https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_43a9a53c6fa5471bb68ee3a4cd85870a~mv2.webp' },
    { key: 'new-york',  name: 'New York',  img: 'https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_bed92ab576ab4c41b17791ded5122897~mv2.jpg' },
    { key: 'tennessee', name: 'Tennessee', img: 'https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_3c779bada8a84d1e87b15996fb01265f~mv2.jpeg' },
    { key: 'caribbean', name: 'Caribbean', img: 'https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_35b55cec22e948cabe56b86bbfc912e4~mv2.webp' },
    { key: 'rockies',   name: 'Rockies',   img: 'https://tmw.jake-ab7.workers.dev/media/wix/68dd32_e3a61d884f2f4f4fadea9bb77e1308ab~mv2.jpeg' }
  ];
  // Region link labels we pull OUT of the header (matched on visible text).
  var MARKET_LABELS = { 'florida':1, 'new york':1, 'new-york':1, 'newyork':1, 'tennessee':1, 'caribbean':1, 'rockies':1 };

  function buildFocusMarkets() {
    var navs = document.querySelectorAll('.nav-links');
    for (var n = 0; n < navs.length; n++) {
      var nav = navs[n];
      if (nav.__tmwFm) continue;
      nav.__tmwFm = true;

      // Find the "Global" anchor (insert point) and the region links to remove.
      var anchors = nav.querySelectorAll('a');
      var globalAnchor = null, toRemove = [];
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var t = (a.textContent || '').trim().toLowerCase();
        if (t === 'global') globalAnchor = a;
        else if (MARKET_LABELS[t]) toRemove.push(a);
      }
      for (var r = 0; r < toRemove.length; r++) {
        if (toRemove[r].parentNode) toRemove[r].parentNode.removeChild(toRemove[r]);
      }

      // Build the dropdown.
      var tiles = '';
      for (var k = 0; k < FOCUS_MARKETS.length; k++) {
        var m = FOCUS_MARKETS[k];
        tiles += '<a class="tmw-fm-tile" role="menuitem" href="' + JOURNAL_HOME + '?market=' + m.key +
                 '" style="background-image:url(\'' + m.img + '\')" aria-label="' + m.name +
                 '"><span class="tmw-fm-name">' + m.name + '</span></a>';
      }
      var fm = document.createElement('div');
      fm.className = 'tmw-fm';
      fm.innerHTML =
        '<button type="button" class="tmw-fm-trigger" aria-expanded="false" aria-haspopup="true">Focus Markets' +
          '<svg class="tmw-fm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>' +
        '</button>' +
        '<div class="tmw-fm-panel" role="menu">' + tiles + '</div>';

      // Insert after "Global" if present, else after the first remaining link.
      var ref = globalAnchor && globalAnchor.parentNode === nav ? globalAnchor : nav.firstElementChild;
      if (ref && ref.nextSibling) nav.insertBefore(fm, ref.nextSibling);
      else nav.appendChild(fm);

      // Click toggle (touch + a11y) + outside-click close.
      (function (fmEl) {
        var trigger = fmEl.querySelector('.tmw-fm-trigger');
        trigger.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          var open = fmEl.classList.toggle('open');
          trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        document.addEventListener('click', function (e) {
          if (!fmEl.contains(e.target)) {
            fmEl.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
          }
        });
      })(fm);
    }
  }

  // Swap the header's "Open Map" CTA for an Instagram icon → @floridaoftomorrow.
  // (The map is still one tap away via the dock's map button.) Universal: applies
  // to the inline page headers and the injected chrome header alike.
  function swapToInstagram() {
    var ctas = document.querySelectorAll('.nav-cta');
    for (var i = 0; i < ctas.length; i++) {
      var c = ctas[i];
      if (c.__tmwIg) continue;
      c.__tmwIg = true;
      c.setAttribute('href', IG_URL);
      c.setAttribute('target', '_blank');
      c.setAttribute('rel', 'noopener');
      c.setAttribute('aria-label', 'Instagram — @floridaoftomorrow');
      c.removeAttribute('id'); // was nav-map-cta; drop so the live-count fetch can't repopulate
      c.classList.add('tmw-ig');
      c.innerHTML = ICON_IG;
    }
  }

  // Wire the mobile hamburger(s) to open/close the nav dropdown. Works for both
  // the inline page headers and the shared chrome header (both use .nav-burger +
  // .nav-links inside nav.main). Single source of truth — the chrome component
  // no longer wires its own, so there's no double-toggle.
  function wireBurgers() {
    var burgers = document.querySelectorAll('.nav-burger');
    for (var i = 0; i < burgers.length; i++) {
      var b = burgers[i];
      if (b.__tmwWired) continue;
      var nav = b.closest('nav') || b.parentElement;
      var links = nav && nav.querySelector('.nav-links');
      if (!links) continue;
      b.__tmwWired = true;
      (function (btn, list) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          var open = list.classList.toggle('open');
          btn.classList.toggle('is-open', open);
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        // Close the menu after tapping a link
        list.addEventListener('click', function (e) {
          if (e.target.closest('a')) { list.classList.remove('open'); btn.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); }
        });
      })(b, links);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
