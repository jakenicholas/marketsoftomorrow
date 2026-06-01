/* ------------------------------------------------------------------
   Markets of Tomorrow — pinned journal dock
   Injects a fixed bottom-center pill on every public journal page:
     [ map ]   [ search input ]   [ home ]
   - map icon  → the interactive map (map.oftmw.com)
   - search    → submits to the journal search page (/search/?q=)
   - home icon → journal home (www.oftmw.com; domain moving soon)
   Self-contained, no dependencies. Include once per page:
     <script src="/_shared/journal-dock.js" defer></script>
-------------------------------------------------------------------*/
(function () {
  'use strict';
  if (window.__tmwDock) return;
  window.__tmwDock = true;

  // ── Google Analytics (GA4) — same property as the map. Journal traffic on
  //    www.oftmw.com lands under hostName www.oftmw.com so the studio's Journal
  //    analytics tab can scope to it (vs map.oftmw.com + /media).
  (function loadGA() {
    if (window.gtag) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=G-6NPTWCVFCG';
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', 'G-6NPTWCVFCG');
  })();

  // ── Journal click tracking → GA4 ──────────────────────────────────────
  //    Fires distinct `jrn_*` events so the studio's Journal analytics tab can
  //    group them into "Click Categories" (it splits on the first segment after
  //    `jrn_`, mirroring how the media kit groups `media_*`). Distinct event
  //    NAMES are used (not event params) so they're queryable in the GA4 Data
  //    API without registering custom dimensions. Subscribe events are fired by
  //    the forms themselves on success; everything else is delegated here.
  var INTERNAL_HOSTS = { 'www.oftmw.com': 1, 'oftmw.com': 1, 'map.oftmw.com': 1, 'localhost': 1, '127.0.0.1': 1 };
  function tmwTrack(name, params) {
    try { if (window.gtag) window.gtag('event', name, params || {}); } catch (e) {}
  }
  window.tmwTrack = tmwTrack;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href], button');
    if (!a) return;

    // Share buttons (article byline) — match by class/ancestor, may be buttons.
    if (a.classList.contains('share-ico') || a.closest('.share') || a.closest('[data-share]')) {
      var net = a.getAttribute('data-share') || a.getAttribute('aria-label') || a.getAttribute('title') || '';
      return tmwTrack('jrn_share', { network: net.toLowerCase().slice(0, 24) });
    }
    // Partner cards (universal partners section).
    var pcard = a.closest('.tmw-partner-card');
    if (pcard) return tmwTrack('jrn_partner', { partner: (pcard.getAttribute('data-partner-id') || '').slice(0, 40) });
    // Dock map button.
    if (a.closest('.tmw-dock') && /map\.oftmw\.com/.test(a.getAttribute('href') || '')) return tmwTrack('jrn_map');

    if (a.tagName !== 'A') return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) return;

    var host = '', path = '';
    try { var u = new URL(a.href, location.href); host = u.hostname; path = u.pathname; } catch (e) { return; }

    // Opening an article.
    if (/\/post\//.test(path)) return tmwTrack('jrn_post_open');
    // Map / media kit referrals.
    if (host === 'map.oftmw.com') return tmwTrack(/\/media/.test(path) ? 'jrn_mediakit' : 'jrn_map');
    // Outbound (anything off the journal's own hosts).
    if (host && !INTERNAL_HOSTS[host]) return tmwTrack('jrn_outbound', { domain: host.replace(/^www\./, '').slice(0, 40) });
  }, true);

  // ── "Active now" heartbeat → worker ───────────────────────────────────
  //    Every open journal page beacons a session id to the worker on load and
  //    while visible, so the studio's Journal tab can show readers active in
  //    the last 5 minutes (GA4 realtime can't be filtered to this host).
  (function heartbeat() {
    try {
      if (navigator.webdriver) return;
      var sid;
      try { sid = sessionStorage.getItem('tmw-sid'); if (!sid) { sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); sessionStorage.setItem('tmw-sid', sid); } }
      catch (e) { sid = 's' + Math.random().toString(36).slice(2, 10); }
      var PING = 'https://tmw.jake-ab7.workers.dev/journal-ping';
      function ping() {
        try {
          var p = JSON.stringify({ sid: sid, path: location.pathname, title: (document.title || '').slice(0, 200) });
          if (navigator.sendBeacon) navigator.sendBeacon(PING, p);
          else fetch(PING, { method: 'POST', body: p, keepalive: true, headers: { 'Content-Type': 'text/plain' } });
        } catch (e) {}
      }
      ping();
      setInterval(function () { if (!document.hidden) ping(); }, 60000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) ping(); });
    } catch (e) {}
  })();

  // ── Destinations (single source of truth; update when domain moves) ──
  var MAP_URL     = 'https://map.oftmw.com';
  var HOME_URL    = 'https://www.oftmw.com';
  var SEARCH_PAGE = '/search/';

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
    // Dock clearance lives on the FOOTER (not the body) so the footer's own
    // background fills the reserved strip — no black gap below the footer.
    'footer{padding-bottom:120px}',
    '.tmw-chrome-foot{padding-bottom:120px}',
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
    'nav.main .nav-links{order:5; position:absolute; top:100%; left:0; right:0; display:none; flex-direction:column; gap:0; align-items:stretch; width:auto; margin:0; background:rgba(7,8,7,.98); -webkit-backdrop-filter:blur(16px) saturate(1.4); backdrop-filter:blur(16px) saturate(1.4); border-bottom:1px solid var(--hair); padding:10px 22px 24px; min-height:calc(100dvh - 56px); max-height:none; overflow-y:auto}',
    'nav.main .nav-links.open{display:flex}',
    'nav.main .nav-links a{padding:14px 2px; border-bottom:1px solid var(--hair); font-size:12.5px}',
    'nav.main .nav-links a:last-child{border-bottom:0}',
    'nav.main .nav-links a.active::after{display:none}',
    'nav.main .nav-burger.is-open span:nth-child(1){transform:translateY(5.5px) rotate(45deg)}',
    'nav.main .nav-burger.is-open span:nth-child(2){opacity:0}',
    'nav.main .nav-burger.is-open span:nth-child(3){transform:translateY(-5.5px) rotate(-45deg)}',
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
    '.banner-ad{max-height:360px; width:100%; max-width:100vw}',
    '.featured-carousel{height:340px; width:100%}',
    '.fc-track,.fc-slide{width:100%; left:0; right:0}',
    '.fc-slide video,.fc-slide img{width:100%; height:100%; object-fit:cover; object-position:center}',
    '.fc-sponsor{display:none !important}',
    // Remove the slide-position dots (ticker) everywhere.
    '.fc-dots, .fc-dot{display:none !important}',
    // Arrows: no circle/background — a bare white chevron that appears on banner
    // hover, turning into a gold glow on the arrow itself.
    '.fc-arrow{background:transparent !important; border:0 !important; box-shadow:none !important; -webkit-backdrop-filter:none !important; backdrop-filter:none !important; border-radius:0 !important; color:#fff !important; width:46px; height:46px}',
    '.fc-arrow svg{width:22px; height:22px; filter:drop-shadow(0 1px 4px rgba(0,0,0,.7))}',
    '.fc-arrow:hover{background:transparent !important; border:0 !important; color:var(--gold,#e6c574) !important; transform:translateY(-50%) !important}',
    '.fc-arrow:hover svg{filter:drop-shadow(0 0 9px rgba(230,197,116,.95)) drop-shadow(0 0 3px rgba(230,197,116,.7))}',
    // Mobile header: slightly smaller hamburger + close (X). Gap stays 4px so
    //    the is-open X transforms below (±5.5px) stay aligned.
    'nav.main .nav-burger, .tmw-chrome-head .nav-burger{width:24px; gap:4px}',
    'nav.main .nav-burger span, .tmw-chrome-head .nav-burger span{width:18px}',

    // ── Universal right-side cluster (Instagram + profile/Join). On mobile the
    //    hamburger moves to the LEFT; the logo gets an auto right-margin so the
    //    cluster is pinned to the RIGHT edge. Same in inline + chrome headers.
    '@media(max-width:980px){'
      + 'nav.main .wrap, .tmw-chrome-head nav.main .wrap{position:relative}'
      + 'nav.main .nav-burger, .tmw-chrome-head .nav-burger{order:-2}'
      + 'nav.main .tmw-logo-lockup, .tmw-chrome-head .tmw-logo-lockup{order:-1; margin-right:auto}'
      + 'nav.main .tmw-auth, .tmw-chrome-head .tmw-auth{order:0}'
    + '}',

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
    // Iconic-list "About" → Request Visit (gold text + gold arrow, opens mail client).
    '.about-cta{display:inline-flex; align-items:center; gap:9px; margin-top:34px; font-family:var(--mono); font-size:12px; letter-spacing:.18em; text-transform:uppercase; font-weight:700; color:var(--gold-soft); text-shadow:0 0 14px rgba(230,197,116,.5), 0 0 3px rgba(230,197,116,.32); text-decoration:none; transition:gap .2s ease, color .2s ease}',
    '.about-cta:hover{gap:14px; color:var(--gold)}',
    '.about-cta svg{width:15px; height:15px; stroke:currentColor; flex:0 0 auto}',
    // Tablet + mobile: match the ad's native 1886x382 (~4.94:1) aspect so the
    // creative fills the full width edge-to-edge — no side bars, no crop.
    '@media(max-width:980px){.banner-ad{max-height:240px}.featured-carousel{height:auto; aspect-ratio:1886 / 382}.fc-slide video,.fc-slide img{object-fit:cover}}',
    '@media(max-width:560px){.banner-ad{max-height:130px}}',

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
    // Desktop: full-viewport-width mega-menu, 5 market tiles in one row, pinned
    // to the bottom of the sticky header (top set by JS via --tmw-fm-top).
    '.tmw-fm-trigger{position:relative}',
    '.tmw-fm-trigger::after{content:""; position:absolute; top:100%; left:-16px; right:-16px; height:24px}', // hover bridge to the panel
    '.tmw-fm-panel{position:absolute; top:calc(100% + 18px); left:0; width:100vw; display:grid; grid-template-columns:repeat(5,1fr); gap:14px; padding:22px clamp(24px,4vw,72px) 28px; background:rgba(9,11,9,.98); -webkit-backdrop-filter:blur(20px) saturate(1.4); backdrop-filter:blur(20px) saturate(1.4); border:0; border-bottom:1px solid rgba(255,255,255,.10); border-radius:0 0 18px 18px; box-shadow:0 30px 64px rgba(0,0,0,.55); opacity:0; visibility:hidden; pointer-events:none; transform:translateY(-10px); transition:opacity .2s ease, transform .22s cubic-bezier(.22,1,.36,1); z-index:70}',
    '.tmw-fm.open .tmw-fm-panel, .tmw-fm:hover .tmw-fm-panel{opacity:1; visibility:visible; pointer-events:auto; transform:translateY(0)}',
    '.tmw-fm-tile{position:relative; display:block; aspect-ratio:16/9; border-radius:13px; overflow:hidden; background:#141714 center/cover no-repeat; text-decoration:none; box-shadow:inset 0 0 0 1px rgba(255,255,255,.07); transition:box-shadow .2s, transform .2s}',
    '.tmw-fm-tile::after{content:""; position:absolute; inset:0; background:linear-gradient(180deg, rgba(7,8,7,0) 30%, rgba(7,8,7,.84) 100%); transition:background .2s ease}',
    '.tmw-fm-tile:hover{transform:translateY(-2px); box-shadow:inset 0 0 0 1px rgba(230,197,116,.5), 0 10px 26px rgba(0,0,0,.4)}',
    '.tmw-fm-tile:hover::after{background:linear-gradient(180deg, rgba(31,223,103,.10) 0%, rgba(7,8,7,.86) 100%)}',
    '.tmw-fm-name{position:absolute; left:14px; bottom:11px; z-index:1; font-family:var(--serif,"Fraunces",Georgia,serif); font-weight:600; font-size:17px; letter-spacing:-.01em; color:#fff; text-shadow:0 2px 12px rgba(0,0,0,.65)}',
    // mobile: Focus Markets is a full-width accordion inside the burger drawer —
    // one column of thin rows. Gradient is a full L→R wash so no bright corners.
    '@media(max-width:980px){.tmw-fm{display:block; width:100%}',
    '.tmw-fm-trigger{width:100%; justify-content:space-between; padding:14px 2px; border-bottom:1px solid rgba(255,255,255,.08); font-size:12.5px}',
    '.tmw-fm-trigger::after{display:none}',
    '.tmw-fm-panel{position:static; top:auto; transform:none; width:auto; grid-template-columns:1fr; gap:8px; padding:10px 0 4px; background:transparent; -webkit-backdrop-filter:none; backdrop-filter:none; border:0; border-radius:0; box-shadow:none; opacity:1; pointer-events:auto; display:none; visibility:visible}',
    '.tmw-fm.open .tmw-fm-panel, .tmw-fm:hover .tmw-fm-panel{display:none; transform:none; left:auto}',
    '.tmw-fm.open .tmw-fm-panel{display:grid; transform:none; left:auto}',
    '.tmw-fm-tile{aspect-ratio:auto; height:58px; border-radius:12px}',
    '.tmw-fm-tile::after{background:linear-gradient(90deg, rgba(7,8,7,.92) 0%, rgba(7,8,7,.55) 52%, rgba(7,8,7,.66) 100%)}',
    '.tmw-fm-tile:hover::after{background:linear-gradient(90deg, rgba(31,223,103,.14) 0%, rgba(7,8,7,.6) 60%, rgba(7,8,7,.66) 100%)}',
    '.tmw-fm-name{font-size:15px; left:16px; bottom:auto; top:50%; transform:translateY(-50%)}}'
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
    setupFmPanel();
    loadAuth();
    linkifyArticle();
    loadProjectCards();
  }

  // Render inline project cards (journal ↔ database bridge). Only loads the
  // renderer when the article actually embeds a project (new card embed or a
  // legacy map-embed iframe), so non-linked posts pay nothing.
  function loadProjectCards() {
    // Load on any post page (so the coverage auto-link can run) or when a post
    // already has a manual project embed / legacy map iframe.
    if (!document.querySelector('.article-body-content, .tmw-project-card[data-project], iframe.tmw-map-embed')) return;
    if (document.querySelector('script[src*="project-card.js"]')) return;
    var s = document.createElement('script');
    s.src = '/_shared/project-card.js';
    s.defer = true;
    document.head.appendChild(s);
  }

  // Make bare URLs in an article body clickable. The editor auto-links most, but
  // a URL pasted with no trailing space (common at the very end of an article)
  // stays plain text — and existing posts may have bare URLs too. Wrap any
  // http(s) URL that isn't already inside a link / code block.
  function linkifyArticle() {
    var root = document.querySelector('.article-body-content');
    if (!root) return;
    var URL_RE = /(https?:\/\/[^\s<>"'`)\]}]+[^\s<>"'`)\]}.,;:!?])/g;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var targets = [], n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || n.nodeValue.indexOf('http') === -1) continue;
      if (n.parentNode && n.parentNode.closest && n.parentNode.closest('a, code, pre')) continue;
      URL_RE.lastIndex = 0;
      if (URL_RE.test(n.nodeValue)) targets.push(n);
    }
    targets.forEach(function (node) {
      var text = node.nodeValue, frag = document.createDocumentFragment(), last = 0, m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var a = document.createElement('a');
        a.href = m[0]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = m[0];
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  // Load the shared auth cluster (Instagram + profile/Join) on EVERY journal
  // page, AFTER swapToInstagram() so journal-auth.js reuses the dock's .tmw-ig
  // button instead of minting a second one. Guarded so pages that already embed
  // the script (or have it injected by the chrome) don't double-load.
  function loadAuth() {
    if (document.querySelector('script[src*="journal-auth.js"], script[data-tmw-auth-loader]')) return;
    var s = document.createElement('script');
    s.src = '/_shared/journal-auth.js';
    s.defer = true;
    s.setAttribute('data-tmw-auth-loader', '');
    document.head.appendChild(s);
  }

  // Stretch the desktop Focus Markets mega-panel to the full viewport width.
  // It's position:absolute inside the trigger (the header's backdrop-filter
  // makes position:fixed resolve against the header, not the viewport), so we
  // offset its left edge back to x=0 and set its width to the viewport.
  function setupFmPanel() {
    function pos() {
      var fms = document.querySelectorAll('.tmw-fm');
      var vw = document.documentElement.clientWidth;
      for (var i = 0; i < fms.length; i++) {
        var panel = fms[i].querySelector('.tmw-fm-panel');
        if (!panel) continue;
        if (vw > 980) {
          panel.style.left = (-Math.round(fms[i].getBoundingClientRect().left)) + 'px';
          panel.style.width = vw + 'px';
        } else {
          panel.style.left = '';
          panel.style.width = '';
        }
      }
    }
    pos();
    window.addEventListener('resize', pos);
    // Recompute right before it opens, in case layout shifted since load.
    document.querySelectorAll('.tmw-fm-trigger').forEach(function (t) {
      t.addEventListener('mouseenter', pos);
      t.addEventListener('click', pos);
    });
    var p = document.querySelector('.tmw-fm');
    if (p) p.addEventListener('mouseenter', pos);
  }

  // ── Focus Markets ───────────────────────────────────────────────────
  // The header used to list each region as its own nav link. Consolidate the
  // five into a single "Focus Markets" dropdown (after "Global") with rounded
  // image tiles. Each tile lands on the journal home filtered to that market
  // (?market=<key> → the existing category-pill filter). Universal: runs on
  // every journal page (incl. the 1,377 pre-rendered article pages) since they
  // all load this dock — no per-page nav edits or regeneration needed.
  var JOURNAL_HOME = '/';
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
