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

  // Tag <html> with the current surface so per-surface accents (the gold glow on
  // Global for the journal vs Database for the map/atlas) can be scoped in CSS.
  (function tagSurface() {
    var surf = location.hostname === 'map.oftmw.com' ? 'map'
      : (/^\/atlas(\/|$)/.test(location.pathname) ? 'atlas' : 'journal');
    document.documentElement.classList.add('tmw-surf-' + surf);
  })();

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

  // ── Surface toggle (Journal · Map · Atlas) — icon-only variant for the dock ──
  var ST_ICON = {
    journal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.2A1.2 1.2 0 0 1 4.2 4H10a2 2 0 0 1 2 2 2 2 0 0 1 2-2h5.8A1.2 1.2 0 0 1 21 5.2v12.6a1 1 0 0 1-1 1h-6a2 2 0 0 0-2 2 2 2 0 0 0-2-2H4a1 1 0 0 1-1-1z"/><path d="M12 6v14"/></svg>',
    map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"/><path d="M9 3v15M15 6v15"/></svg>',
    atlas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>'
  };
  function buildToggle(active, mini) {
    var segs = [
      ['journal', 'Journal', 'https://www.oftmw.com/'],
      ['map', 'Map', 'https://map.oftmw.com'],
      ['atlas', 'Atlas', 'https://www.oftmw.com/atlas']
    ];
    return '<div class="tmw-st' + (mini ? ' mini' : '') + '" role="tablist" aria-label="Switch interface">' +
      segs.map(function (s) {
        var on = s[0] === active;
        return '<a class="tmw-st-seg' + (on ? ' on' : '') + '" data-s="' + s[0] + '" href="' + s[2] + '" title="' + s[1] + '" aria-label="' + s[1] + '"' + (on ? ' aria-current="page"' : '') + '>' +
          ST_ICON[s[0]] + (mini ? '' : '<span class="tmw-st-lbl">' + s[1] + '</span>') + '</a>';
      }).join('') + '</div>';
  }
  // Inject the labelled toggle into every header (nav.main .wrap), right after
  // the logo. Universal — covers the homepage's inline header AND the injected
  // chrome header. Guarded so it's added at most once per header.
  function injectSurfaceToggle() {
    var active = location.hostname === 'map.oftmw.com' ? 'map' : (/^\/atlas(\/|$)/.test(location.pathname) ? 'atlas' : 'journal');
    var wraps = document.querySelectorAll('nav.main .wrap');
    for (var i = 0; i < wraps.length; i++) {
      var wrap = wraps[i];
      if (wrap.__tmwSt) continue;
      var logo = wrap.querySelector('.tmw-logo-lockup');
      if (!logo) continue;
      wrap.__tmwSt = true;
      var holder = document.createElement('div');
      holder.innerHTML = buildToggle(active, false);
      var el = holder.firstChild;
      if (logo.nextSibling) wrap.insertBefore(el, logo.nextSibling); else wrap.appendChild(el);
    }
  }

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
    // Map · Atlas · Journal toggle inside the dock (icon-only). Shown on mobile;
    // hidden >=981px because the header already carries the labelled toggle there.
    '.tmw-dock .tmw-st{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:999px;padding:3px}',
    '.tmw-dock .tmw-st-seg{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:999px;color:#ECEAE5;text-decoration:none;transition:background .2s,color .2s}',
    '.tmw-dock .tmw-st-seg svg{width:19px;height:19px}',
    '.tmw-dock .tmw-st-seg:not(.on):hover{background:rgba(255,255,255,.08);color:#fff}',
    '.tmw-dock .tmw-st-seg.on{background:#3a3d42;color:#fff}',
    '@media(min-width:981px){.tmw-dock .tmw-st{display:none}}',
    '@media(max-width:560px){.tmw-dock .tmw-st-seg{width:36px;height:36px}.tmw-dock .tmw-st-seg svg{width:18px;height:18px}}',
    // Labelled toggle injected into the header (nav.main) right after the logo.
    // Active segment expands to show its label. Desktop only — mobile uses the dock.
    'nav.main .tmw-st{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:3px}',
    'nav.main .tmw-st .tmw-st-seg{display:inline-flex;align-items:center;height:34px;padding:0 9px;border-radius:999px;color:#C2C9C3;text-decoration:none;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;transition:background .22s ease,color .22s ease,padding .22s ease;white-space:nowrap}',
    'nav.main .tmw-st .tmw-st-seg svg{width:17px;height:17px;flex:0 0 auto}',
    'nav.main .tmw-st .tmw-st-lbl{display:inline-block;max-width:0;overflow:hidden;opacity:0;transition:max-width .22s ease,opacity .18s ease,margin .22s ease}',
    'nav.main .tmw-st .tmw-st-seg:hover{color:#fff}',
    'nav.main .tmw-st .tmw-st-seg.on{background:#3a3d42;color:#fff}',
    'nav.main .tmw-st .tmw-st-seg.on .tmw-st-lbl{max-width:90px;opacity:1;margin-left:7px}',
    // Lock the nav menu dead-centre of the header. It's absolutely positioned
    // (anchored like the logo) so it never shifts as the toggle injects on the
    // left or the login/Join state hydrates on the right — both used to jitter
    // it. Desktop only; mobile collapses into the burger drawer.
    '@media(min-width:981px){nav.main .wrap{position:relative}',
    'nav.main .nav-links{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); margin:0}',
    // The nav-links are out of flow now, so keep the logo+toggle pinned left and
    // the login pinned right: the toggle eats the free space to its right.
    'nav.main .tmw-st{margin-right:auto}}',
    '@media(min-width:981px){.nav-cta.tmw-ig{display:none !important}}',
    '@media(max-width:980px){nav.main .tmw-st{display:none}}',
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
    'nav.main .nav-links{order:5; position:absolute; top:100%; left:0; right:0; display:none; flex-direction:column; gap:0; align-items:stretch; width:auto; margin:0; background:rgba(7,8,7,.98); -webkit-backdrop-filter:blur(16px) saturate(1.4); backdrop-filter:blur(16px) saturate(1.4); border-bottom:1px solid var(--hair); padding:10px 22px 24px; height:calc(100dvh - 56px); max-height:calc(100dvh - 56px); overflow-y:auto; -webkit-overflow-scrolling:touch}',
    'nav.main .nav-links.open{display:flex}',
    'nav.main .nav-links > a{padding:14px 2px; border-bottom:1px solid var(--hair); font-size:12.5px}',
    'nav.main .nav-links > a:last-child{border-bottom:0}',
    'nav.main .nav-links a.active::after{display:none}',
    'nav.main .nav-burger.is-open span:nth-child(1){transform:translateY(5.5px) rotate(45deg)}',
    'nav.main .nav-burger.is-open span:nth-child(2){opacity:0}',
    'nav.main .nav-burger.is-open span:nth-child(3){transform:translateY(-5.5px) rotate(-45deg)}',
    '}',

    // ── Remove the animated "intelligence" hex badge from every logo (header +
    //    footer). Hidden, so the lockup re-centers on its own.
    '.tmw-hex-badge{display:none !important}',
    // Smaller wordmark in the header on desktop (mobile 74px is set above).
    'nav.main .tmw-wordmark{width:80px}',

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
    '@media(max-width:980px){.nav-cta.tmw-ig{display:none !important}}',

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
    // Per-surface gold accent: Global glows on the journal home; Database carries
    // the same glow on the map + atlas (their primary context). A touch stronger
    // than the shared hover glow so it reads clearly against every chrome.
    'html.tmw-surf-journal nav.main .nav-links a.active{color:var(--gold-soft) !important; text-shadow:0 0 16px rgba(230,197,116,.7), 0 0 5px rgba(230,197,116,.42)}',
    'html.tmw-surf-map .tmw-fm-database .tmw-fm-trigger, html.tmw-surf-atlas .tmw-fm-database .tmw-fm-trigger{color:var(--gold-soft) !important; text-shadow:0 0 16px rgba(230,197,116,.7), 0 0 5px rgba(230,197,116,.42)}',

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
    '.tmw-fm-trigger{font-family:var(--mono,"Inter",-apple-system,BlinkMacSystemFont,sans-serif); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--mute-2,#C2C9C3); background:none; border:0; cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:0; line-height:1; transition:color .2s}',
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
      fav.href = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png';
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
    // Map · Atlas · Journal toggle on the left, then the search field. (The old
    // standalone map + home buttons are gone — Map and Journal live in the toggle.)
    var stActive = location.hostname === 'map.oftmw.com' ? 'map' : (/^\/atlas(\/|$)/.test(location.pathname) ? 'atlas' : 'journal');
    dock.innerHTML =
      buildToggle(stActive, true) +
      '<form class="tmw-dock-search" role="search" action="' + SEARCH_PAGE + '" method="get">' +
        '<span class="ds-ico">' + ICON_SEARCH + '</span>' +
        '<input name="q" type="search" autocomplete="off" placeholder="Search projects, firms, cities…" aria-label="Search">' +
      '</form>';

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

    // Transform every header into the universal menu (consolidate the flat nav,
    // inject the surface toggle, swap Open Map -> Instagram) THEN reveal it, in
    // one pass, so the raw nav never flashes. The chrome header can mount a tick
    // later than the dock, so re-run a couple of times (every step is guarded).
    finishHeaders();
    requestAnimationFrame(finishHeaders);
    setTimeout(finishHeaders, 300);
    setTimeout(finishHeaders, 700);
    wireBurgers();
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
  // Feature flag: the native in-page "Go Pro" paywall. While false, Pro tiles /
  // "Go Pro" keep their old behaviour (graceful fallback redirect to the map's
  // ?upgrade=1). Flip to true once the Memberstack checkout is verified.
  var PAYWALL_NATIVE = true;

  function loadAuth() {
    if (!document.querySelector('script[src*="journal-auth.js"], script[data-tmw-auth-loader]')) {
      var s = document.createElement('script');
      s.src = '/_shared/journal-auth.js';
      s.defer = true;
      s.setAttribute('data-tmw-auth-loader', '');
      document.head.appendChild(s);
    }
    // Custom TMW-branded auth modals (login/signup) on Memberstack headless.
    if (!document.querySelector('script[src*="tmw-auth-modal.js"], script[data-tmw-authui-loader]')) {
      var a = document.createElement('script');
      a.src = '/_shared/tmw-auth-modal.js';
      a.defer = true;
      a.setAttribute('data-tmw-authui-loader', '');
      document.head.appendChild(a);
    }
    // Native "Go Pro" paywall — so Pro upgrades pop up in-page instead of
    // redirecting to the map. Reuses the Memberstack instance auth.js loads.
    if (PAYWALL_NATIVE && !document.querySelector('script[src*="journal-paywall.js"], script[data-tmw-paywall-loader]')) {
      var p = document.createElement('script');
      p.src = '/_shared/journal-paywall.js';
      p.defer = true;
      p.setAttribute('data-tmw-paywall-loader', '');
      document.head.appendChild(p);
    }
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
  var SK = ['Followers', 'Mo. Views', 'Mo. Web', 'Interactions'];
  var FOCUS_MARKETS = [
    { key: 'florida',   name: 'Florida of Tomorrow',   h: 'floridaoftomorrow',   img: '/media/img/9998de3ca8af.jpg', flag: true,  s: ['150,000', '3.5M', '1.2M', '150K'] },
    { key: 'new-york',  name: 'New York of Tomorrow',  h: 'newyorkoftomorrow',   img: '/media/img/e3c8a4e4ff38.jpg', flag: false, s: ['9,000', '297K', '22K', '19K'] },
    { key: 'tennessee', name: 'Tennessee of Tomorrow', h: 'tennesseeoftomorrow', img: '/media/img/d3ce63b84f46.jpg', flag: false, s: ['11,000', '305K', '41K', '32K'] },
    { key: 'caribbean', name: 'Caribbean of Tomorrow', h: 'caribbeanoftomorrow', img: '/media/img/5d9804404207.jpg', flag: false, s: ['2,500', '88K', '12K', '5.7K'] },
    { key: 'rockies',   name: 'Rockies of Tomorrow',   h: 'rockiesoftomorrow',   img: '/media/img/35b59ff84cf5.jpg', flag: false, s: ['400', '12K', '4.1K', '1.1K'] }
  ];
  // Flat region/list link labels we pull OUT of the header (matched on visible
  // text) and re-home into the new Focus Markets / The Lists dropdowns.
  var MARKET_LABELS = { 'florida':1, 'new york':1, 'new-york':1, 'newyork':1, 'tennessee':1, 'caribbean':1, 'rockies':1, 'hotels':1, 'restaurants':1, 'golf':1 };

  var MAP_BASE = 'https://map.oftmw.com';
  var CHEV = '<svg class="tmw-fm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
  var IG_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4.5"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/></svg>';
  var ARR2 = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
  function ic(p) { return '<svg viewBox="0 0 24 24">' + p + '</svg>'; }
  // Canonical TMW feature icons (also used in the intelligence section on each page).
  var HEX_IC = '<polygon points="12,4.3 18.65,8.16 18.65,15.84 12,19.68 5.35,15.84 5.35,8.16"/>';      // Intelligence = TMW hexagon
  var EYE_IC = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'; // Watchlist = eye
  var CMP_IC = '<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/>'; // Compare = two columns
  var PULSE_IC = '<path d="M3 12h4l2 6 4-14 2 8h6"/>';                                                  // Pulse = live feed

  // The redesigned header nav: keep "Global", consolidate the region links into a
  // rich Focus Markets dropdown (media-kit social cards), add a "The Map" menu
  // (Explore + Pro intelligence) and a "The Lists" menu (Hotels/Restaurants/Golf).
  function buildHeaderNavCSS() {
    if (document.getElementById('tmw-nav2-css')) return;
    var s = document.createElement('style'); s.id = 'tmw-nav2-css';
    s.textContent = [
      // v2 mega panels — full-width backdrop, centered inner content.
      '.tmw-fm-panel.v2{display:block; grid-template-columns:none; padding:0; background:#0a0c0a; -webkit-backdrop-filter:none; backdrop-filter:none; z-index:9100}',
      '.tmw-fm-inner{max-width:1240px; margin:0 auto; padding:26px clamp(24px,4vw,72px) 32px}',
      // The open menu sits ON TOP of the whole site; the pinned search dock hides.
      'body:has(.tmw-fm.open) .tmw-dock, body:has(.nav-links.open) .tmw-dock{opacity:0 !important; visibility:hidden !important; pointer-events:none !important}',
      '.sticky-stack:has(.nav-links.open){z-index:9200}',
      '.tmw-nav-eyebrow{font-family:var(--mono,"Inter",-apple-system,BlinkMacSystemFont,sans-serif); font-size:9.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--mute,#9AA39C); margin-bottom:15px}',
      // Focus Markets — the media-kit .ocard, with "Read articles" in place of chips.
      '.tmw-oc-grid{display:grid; grid-template-columns:repeat(5,1fr); gap:12px}',
      '.tmw-oc{display:flex; flex-direction:column; background:rgba(255,255,255,.025); border:1px solid rgba(255,255,255,.16); border-radius:14px; overflow:hidden; text-decoration:none; transition:transform .25s, border-color .25s}',
      '.tmw-oc:hover{transform:translateY(-3px); border-color:rgba(255,255,255,.32)}',
      '.tmw-oc-banner{position:relative; width:100%; aspect-ratio:2/1; overflow:hidden; border-bottom:1px solid rgba(255,255,255,.08)}',
      '.tmw-oc-banner img{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; transition:transform .5s ease}',
      '.tmw-oc:hover .tmw-oc-banner img{transform:scale(1.04)}',
      '.tmw-oc-body{padding:14px 16px 16px; display:flex; flex-direction:column; flex:1}',
      '.tmw-oc-name{font-size:13px; font-weight:600; color:#fff; text-transform:none; letter-spacing:normal; line-height:1.25; margin-bottom:13px}',
      '.tmw-oc-stats{display:grid; grid-template-columns:1fr 1fr; gap:13px 12px; padding-bottom:15px; border-bottom:1px solid rgba(255,255,255,.08)}',
      '.tmw-oc-st{display:flex; flex-direction:column; gap:3px}',
      '.tmw-oc-st .v{font-family:var(--serif,Georgia,serif); font-weight:600; font-size:20px; color:#fff; letter-spacing:-.01em; line-height:1}',
      '.tmw-oc-st .k{font-family:var(--mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute,#9AA39C)}',
      // Footer row: "Read articles" (left) + Instagram button (right), bottom-aligned.
      '.tmw-oc-foot{margin-top:auto; padding-top:13px; display:flex; align-items:center; justify-content:space-between; gap:10px; position:relative}',
      '.tmw-oc-read{display:inline-flex; align-items:center; gap:8px; white-space:nowrap; font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--gold-soft,#f0d68a)}',
      '.tmw-oc-read svg{width:13px; height:13px; transition:transform .2s}',
      '.tmw-oc:hover .tmw-oc-read{color:#fff} .tmw-oc:hover .tmw-oc-read svg{transform:translateX(3px)}',
      '.tmw-oc-ig{flex:0 0 auto; display:flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:8px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); color:var(--mute,#9AA39C); cursor:pointer; transition:background .2s, color .2s, border-color .2s}',
      '.tmw-oc-ig:hover{background:rgba(31,223,103,.1); border-color:rgba(31,223,103,.3); color:#1FDF67}',
      '.tmw-oc-ig svg{width:15px; height:15px}',
      // The Map — explore (free) + pro intelligence + Go Pro CTA.
      '.tmw-mm{display:grid; grid-template-columns:1fr 2fr; gap:22px 30px; max-width:980px}',
      '.tmw-mm-h{font-family:var(--mono); font-size:9.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--mute,#9AA39C); margin-bottom:8px}',
      '.tmw-mm-pro-grid{display:grid; grid-template-columns:1fr 1fr; gap:4px 14px}',
      '.tmw-mm-item{display:flex; gap:12px; padding:10px; border-radius:12px; text-decoration:none; transition:background .18s}',
      '.tmw-mm-item:hover{background:rgba(255,255,255,.05)}',
      '.tmw-mm-ic{flex:0 0 auto; width:34px; height:34px; border-radius:10px; display:flex; align-items:center; justify-content:center; background:rgba(167,139,250,.12); border:1px solid rgba(167,139,250,.3); color:#C4B5FD}',
      '.tmw-mm-ic.green{background:rgba(31,223,103,.1); border-color:rgba(31,223,103,.26); color:#42EB81}',
      '.tmw-mm-ic svg{width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.8}',
      '.tmw-mm-tx b{display:block; font-size:12px; font-weight:600; color:#fff}',
      '.tmw-mm-tx b em{font-style:normal; font-family:var(--mono); font-size:7.5px; letter-spacing:.12em; color:var(--gold-soft,#f0d68a); border:1px solid rgba(230,197,116,.42); border-radius:5px; padding:2px 5px; margin-left:7px; vertical-align:middle}',
      '.tmw-mm-tx i{font-style:normal; display:block; font-size:11px; color:var(--mute,#9AA39C); margin-top:2px}',
      '.tmw-mm-cta{grid-column:1/-1; display:flex; align-items:center; justify-content:space-between; gap:14px; padding:15px 18px; border-radius:13px; text-decoration:none; background:linear-gradient(120deg,rgba(167,139,250,.13),rgba(31,223,103,.06)); border:1px solid rgba(167,139,250,.3)}',
      '.tmw-mm-cta .t{font-family:var(--serif,Georgia,serif); font-weight:400; font-size:16px; line-height:1.25; letter-spacing:-.01em; text-transform:none; color:#fff}',
      '.tmw-mm-cta .t em{font-style:italic; color:#B9A6FF}',
      '.tmw-mm-cta .go{font-family:var(--mono); font-size:11px; letter-spacing:.06em; text-transform:uppercase; font-weight:700; padding:10px 16px; border-radius:9px; background:#FFD300; color:#0a0a0a; white-space:nowrap}',
      // The Lists — featured split: one hero list + two compact image rows.
      '.tmw-ll{display:grid; grid-template-columns:1.5fr 1fr; gap:14px; max-width:860px}',
      '.tmw-lc-feat{position:relative; display:block; border-radius:15px; overflow:hidden; text-decoration:none; min-height:262px; border:1px solid rgba(255,255,255,.1)}',
      '.tmw-lc-feat img{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transition:transform .55s ease}',
      '.tmw-lc-feat::after{content:""; position:absolute; inset:0; background:linear-gradient(to top, rgba(5,6,5,.93), rgba(5,6,5,.2) 55%, rgba(5,6,5,.4))}',
      '.tmw-lc-feat:hover img{transform:scale(1.05)}',
      '.tmw-lc-fm{position:absolute; left:0; right:0; bottom:0; padding:22px; z-index:2}',
      '.tmw-lc-eye{font-family:var(--mono); font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--gold-soft,#f0d68a); margin-bottom:7px}',
      '.tmw-lc-feat h3{font-family:var(--serif,Georgia,serif); font-weight:500; font-size:28px; line-height:1; letter-spacing:-.015em; text-transform:none; color:#fff}',
      '.tmw-lc-feat p{font-family:var(--sans,"Inter",sans-serif); text-transform:none; font-size:12.5px; line-height:1.45; color:var(--mute-2,#C2C9C3); margin-top:9px; max-width:34ch}',
      '.tmw-lc-side{display:flex; flex-direction:column; gap:14px}',
      '.tmw-lc-row{position:relative; display:block; border-radius:14px; overflow:hidden; text-decoration:none; flex:1; min-height:123px; border:1px solid rgba(255,255,255,.1)}',
      '.tmw-lc-row img{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transition:transform .55s ease}',
      '.tmw-lc-row::after{content:""; position:absolute; inset:0; background:linear-gradient(100deg, rgba(5,6,5,.9) 36%, rgba(5,6,5,.4))}',
      '.tmw-lc-row:hover img{transform:scale(1.05)}',
      '.tmw-lc-rm{position:absolute; left:0; bottom:0; padding:16px 18px; z-index:2}',
      '.tmw-lc-row h3{font-family:var(--serif,Georgia,serif); font-weight:500; font-size:20px; line-height:1; letter-spacing:-.01em; text-transform:none; color:#fff}',
      // Mobile: panels become stacked accordion content (1 column).
      '@media(max-width:980px){',
      '.tmw-fm-panel.v2{display:none}',
      '.tmw-fm.open .tmw-fm-panel.v2{display:block}',
      '.tmw-fm-inner{padding:8px 0 8px; max-width:none}',
      'nav.main .nav-links{overscroll-behavior:contain}',
      // Focus Markets: 2 columns; banner fills the top; only Followers + Mo. Views.
      '.tmw-oc-grid{grid-template-columns:repeat(2,1fr); max-width:none; gap:10px}',
      '.tmw-oc-banner{aspect-ratio:16/10}',
      '.tmw-oc-body{padding:11px 12px 9px}',
      '.tmw-oc-name{font-size:13px}',
      '.tmw-oc-stats{gap:10px 12px; padding-bottom:13px}',
      '.tmw-oc-st .v{font-size:16px}',
      // Mobile: centre "Read articles" in the space left of the IG button (right).
      '.tmw-oc-foot{gap:6px}',
      '.tmw-oc-read{font-size:8.5px; letter-spacing:.06em; flex:1; justify-content:center; gap:6px}',
      '.tmw-oc-ig{width:24px; height:24px}',
      '.tmw-mm{grid-template-columns:1fr; max-width:none; gap:10px}',
      '.tmw-mm-pro-grid{grid-template-columns:1fr}',
      '.tmw-ll{grid-template-columns:1fr; max-width:none; gap:10px}',
      '.tmw-lc-feat{min-height:200px}',
      '.tmw-mm-cta{flex-direction:column; align-items:stretch; text-align:center; gap:10px}',
      '.tmw-nav-eyebrow{margin:6px 0 10px}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  // Make one full-width mega dropdown (.tmw-fm) with a trigger + panel + toggle.
  function makeFm(label, innerHTML) {
    var fm = document.createElement('div');
    // e.g. "Database" -> "tmw-fm tmw-fm-database" so a single dropdown can be
    // targeted (the gold accent on Database for the map/atlas surfaces).
    fm.className = 'tmw-fm tmw-fm-' + label.toLowerCase().replace(/\s+/g, '-');
    fm.innerHTML =
      '<button type="button" class="tmw-fm-trigger" aria-expanded="false" aria-haspopup="true">' + label + CHEV + '</button>' +
      '<div class="tmw-fm-panel v2" role="menu"><div class="tmw-fm-inner">' + innerHTML + '</div></div>';
    var trigger = fm.querySelector('.tmw-fm-trigger');
    trigger.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      // Close any other open dropdown in this nav first.
      var sibs = fm.parentNode ? fm.parentNode.querySelectorAll('.tmw-fm.open') : [];
      for (var i = 0; i < sibs.length; i++) if (sibs[i] !== fm) sibs[i].classList.remove('open');
      var open = fm.classList.toggle('open');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!fm.contains(e.target)) { fm.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); }
    });
    return fm;
  }

  function focusMarketsPanel() {
    var cards = FOCUS_MARKETS.map(function (m) {
      var stats = m.s.slice(0, 2).map(function (v, i) { return '<div class="tmw-oc-st"><span class="v">' + v + '</span><span class="k">' + SK[i] + '</span></div>'; }).join('');
      return '<a class="tmw-oc" role="menuitem" href="' + JOURNAL_HOME + '?market=' + m.key + '">' +
        '<div class="tmw-oc-banner"><img src="' + m.img + '" alt="' + m.name + '" loading="lazy"></div>' +
        '<div class="tmw-oc-body"><span class="tmw-oc-name">' + m.name.replace(/ Tomorrow$/, '<br>Tomorrow') + '</span>' +
          '<div class="tmw-oc-stats">' + stats + '</div>' +
          '<div class="tmw-oc-foot"><span class="tmw-oc-read">Read articles ' + ARR2 + '</span>' +
            '<span class="tmw-oc-ig" data-ig="' + m.h + '" role="link" tabindex="0" aria-label="Instagram">' + IG_SM + '</span></div></div></a>';
    }).join('');
    return '<div class="tmw-nav-eyebrow">Each market — its own journal feed, social &amp; project coverage</div><div class="tmw-oc-grid">' + cards + '</div>';
  }

  function theMapPanel() {
    var U = MAP_BASE, UP = MAP_BASE + '/?upgrade=1';
    function pro(icon, name, sub, ctx) {
      return '<a class="tmw-mm-item" href="' + UP + '" data-paywall="' + ctx + '"><span class="tmw-mm-ic">' + ic(icon) + '</span><span class="tmw-mm-tx"><b>' + name + '<em>PRO</em></b><i>' + sub + '</i></span></a>';
    }
    return '<div class="tmw-mm">' +
      '<div><div class="tmw-mm-h">Explore — free</div>' +
        '<a class="tmw-mm-item" href="' + U + '"><span class="tmw-mm-ic green">' + ic('<path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"/><path d="M9 3v15M15 6v15"/>') + '</span><span class="tmw-mm-tx"><b>Interactive Map</b><i>396 projects across 40+ markets.</i></span></a>' +
        '<a class="tmw-mm-item" href="' + U + '/?view=atlas"><span class="tmw-mm-ic green">' + ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>') + '</span><span class="tmw-mm-tx"><b>The Atlas</b><i>Every tracked project on one canvas.</i></span></a></div>' +
      '<div class="tmw-mm-pro"><div class="tmw-mm-h">Pro tools</div><div class="tmw-mm-pro-grid">' +
        pro(HEX_IC, 'TMW Intelligence', 'Completion forecasts &amp; confidence.', 'feature:intelligence') +
        pro(EYE_IC, 'Watchlist', 'Track projects, get notified.', 'feature:watchlist') +
        pro(CMP_IC, 'Compare', 'Stack any projects side-by-side.', 'feature:compare') +
        pro(PULSE_IC, 'Pulse', 'A live feed of every new project.', 'feature:pulse') +
      '</div></div>' +
      '<a class="tmw-mm-cta" href="' + UP + '" data-paywall="go-pro"><span class="t">Explore the map free. <em>Go Pro for the intelligence.</em></span><span class="go">Go Pro →</span></a>' +
    '</div>';
  }

  function theListsPanel() {
    var IMG_H = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_07e4600c7eb745c28897b90cbab6d7ff~mv2.jpeg';
    var IMG_R = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_42e28b9d09364b0ca9b3c4d6ca2e9498~mv2.jpeg';
    var IMG_G = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_d11891954f1f433f9d6a933b28d7cf5f~mv2.jpeg';
    return '<div class="tmw-nav-eyebrow">The definitive ranked guides</div><div class="tmw-ll">' +
      '<a class="tmw-lc-feat" href="/hotels/"><img src="' + IMG_H + '" alt="Iconic Hotels" loading="lazy">' +
        '<div class="tmw-lc-fm"><div class="tmw-lc-eye">The flagship guide</div><h3>Iconic Hotels</h3>' +
        '<p>The stays that define every market — ranked, property by property.</p></div></a>' +
      '<div class="tmw-lc-side">' +
        '<a class="tmw-lc-row" href="/restaurants/"><img src="' + IMG_R + '" alt="Iconic Restaurants" loading="lazy">' +
          '<div class="tmw-lc-rm"><div class="tmw-lc-eye">Where the future eats</div><h3>Iconic Restaurants</h3></div></a>' +
        '<a class="tmw-lc-row" href="/golf/"><img src="' + IMG_G + '" alt="Iconic Golf" loading="lazy">' +
          '<div class="tmw-lc-rm"><div class="tmw-lc-eye">The courses worth the trip</div><h3>Iconic Golf</h3></div></a>' +
      '</div>' +
    '</div>';
  }

  // IG icons inside the (anchor) market cards can't be nested anchors — handle
  // their click manually so they open Instagram without following the card link.
  var _igWired = false;
  function wireIgClicks() {
    if (_igWired) return; _igWired = true;
    document.addEventListener('click', function (e) {
      var ig = e.target.closest && e.target.closest('.tmw-oc-ig');
      if (!ig) return;
      e.preventDefault(); e.stopPropagation();
      window.open('https://www.instagram.com/' + ig.getAttribute('data-ig'), '_blank', 'noopener');
    });
  }

  // Intercept clicks on Pro tiles / "Go Pro" so the native paywall pops up
  // in-page instead of redirecting to the map's ?upgrade=1. Paid members fall
  // through to the link (the real map feature); if the paywall script hasn't
  // loaded yet, the href (map ?upgrade=1) is the graceful fallback.
  var _pwWired = false;
  function wirePaywallTiles() {
    if (_pwWired) return; _pwWired = true;
    document.addEventListener('click', function (e) {
      var el = e.target.closest && e.target.closest('[data-paywall]');
      if (!el) return;
      if (window._isPaidMember) return;
      if (typeof window.tmwShowPaywall === 'function') {
        e.preventDefault(); e.stopPropagation();
        window.tmwShowPaywall(el.getAttribute('data-paywall'));
      }
    });
  }

  function buildFocusMarkets() {
    buildHeaderNavCSS();
    wireIgClicks();
    wirePaywallTiles();
    var navs = document.querySelectorAll('.nav-links');
    for (var n = 0; n < navs.length; n++) {
      var nav = navs[n];
      if (nav.__tmwFm) continue;
      nav.__tmwFm = true;

      // Find "Global" (insert point) and remove the flat region/list links.
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

      // Build the three dropdowns and insert them after "Global".
      var fmMarkets = makeFm('Focus Markets', focusMarketsPanel());
      var fmMap     = makeFm('Database', theMapPanel());
      var fmLists   = makeFm('The Lists', theListsPanel());
      var ref = globalAnchor && globalAnchor.parentNode === nav ? globalAnchor : nav.firstElementChild;
      if (ref && ref.nextSibling) {
        nav.insertBefore(fmMarkets, ref.nextSibling);
        nav.insertBefore(fmMap, fmMarkets.nextSibling);
        nav.insertBefore(fmLists, fmMap.nextSibling);
      } else { nav.appendChild(fmMarkets); nav.appendChild(fmMap); nav.appendChild(fmLists); }
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

  // Run every header transform (all idempotently guarded) then flag each
  // nav.main ready. The universal nav is hidden by CSS until .tmw-nav-ready, so
  // the raw flat links + Open Map CTA never flash before the menu is built.
  function finishHeaders() {
    try { buildFocusMarkets(); } catch (e) {}
    try { injectSurfaceToggle(); } catch (e) {}
    try { swapToInstagram(); } catch (e) {}
    // Always reveal, even if a transform threw — a hidden nav is worse than an
    // imperfect one.
    var navs = document.querySelectorAll('nav.main');
    for (var i = 0; i < navs.length; i++) navs[i].classList.add('tmw-nav-ready');
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
          // Lock the page behind the open drawer so scrolling the menu doesn't
          // scroll the article underneath (drawer itself stays overflow-y:auto).
          document.documentElement.style.overflow = open ? 'hidden' : '';
        });
        // Close the menu after tapping a link
        list.addEventListener('click', function (e) {
          if (e.target.closest('a')) { list.classList.remove('open'); btn.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); document.documentElement.style.overflow = ''; }
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
