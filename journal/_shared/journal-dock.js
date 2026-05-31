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

    // ── Header CTA swapped from "Open Map" to an Instagram icon button.
    '.nav-cta.tmw-ig{padding:0; width:42px; height:42px; min-width:42px; justify-content:center; gap:0; overflow:visible}',
    '.nav-cta.tmw-ig svg{width:21px; height:21px; color:var(--cream); transition:color .2s}',
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
    '@media(prefers-reduced-motion:reduce){.tmw-dock-search::before{animation:none}}'
  ].join('');

  function mount() {
    // Lock the viewport: prevents iOS input-focus zoom (maximum-scale=1) and
    // pinch/double-tap zoom (user-scalable=no). viewport-fit=cover for notches.
    var vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement('meta'); vp.setAttribute('name', 'viewport'); document.head.appendChild(vp); }
    vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');

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

    wireBurgers();
    swapToInstagram();
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
