/* ------------------------------------------------------------------
   Markets of Tomorrow — shared journal chrome (header + footer)
   Injects the universal site header (logo + nav + Open Map CTA) at the
   top of <body> and the site footer at the bottom. One source of truth,
   so every page that includes this stays in sync.
     <script src="/_shared/journal-chrome.js" defer></script>
   Relies on the page's design tokens (--green, --mute-2, --white, --hair,
   --hair-2, --cream, --ink, --ink-2); the few it can't assume
   (--glass, --purple, --purple-glow) are hardcoded below. The header/footer
   label font is hardcoded to Inter rather than var(--mono): the market and
   firm pages bind --mono to real JetBrains Mono for their own eyebrows, which
   bled into the shared chrome — so the chrome owns its font and stays
   identical across every page.
-------------------------------------------------------------------*/
(function () {
  'use strict';

  if (window.__tmwChrome) return;
  window.__tmwChrome = true;

  var HEX =
    '<div class="tmw-hex-badge"><svg viewBox="0 0 100 100">' +
    '<polygon class="tmw-hex-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/>' +
    '<g class="tmw-hex-spinner"><polygon class="tmw-hex-core" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/></g>' +
    '</svg></div>';

  var WORDMARK =
    '<div class="tmw-wordmark"><svg viewBox="100 60 900 410"><g class="wm-fill">' +
    '<path d="M233.5,220.4l1.1-105.9-.4-.4-30.2,106.3h-23.9l-30.6-107.2,1.1,107.2h-33.3V79h46.4l28.1,93.1h.4l27.7-93.1h46.6v141.4h-33.3Z"/>' +
    '<path d="M383.6,220.4l-6.9-20.5h-49.1l-7.5,20.5h-38.8l56.8-141.4h28.5l56.2,141.4h-39.2ZM352.6,123.1l-.6-.2-14.5,48.4h29.6l-14.5-48.2Z"/>' +
    '<path d="M504.9,220.4l-32.7-45.7h-.4v45.7h-34.6V79h46.3c14.7,0,26,1.9,33.4,5.2,15.3,6.9,26,23.5,26,43.6s-13.4,40.7-35.2,44.5l38.4,48.2h-41.3ZM485.3,150.1c14.3,0,23.1-6.7,23.1-20.3s-9.2-19.1-22.7-19.1h-13.8v39.4h13.4Z"/>' +
    '<path d="M641,220.4l-38.6-61.2h-.4v61.2h-36.1V79h36.1v63.6h.4l39.9-63.6h37.8l-46.8,70.5,49.9,70.9h-42.2Z"/>' +
    '<path d="M697.2,220.4V79h78.6v31.7h-44v22h42.6v31.7h-42.6v24.3h44v31.7h-78.6Z"/>' +
    '<path d="M815.1,220.4v-109.7h-27.9v-31.7h91.7v31.7h-27.7v109.7h-36.1Z"/>' +
    '<path d="M948.9,120.3c-1.5-10.1-5.7-13.8-12.8-13.8s-12.4,4.8-12.4,11.1,7.6,12.2,23.1,18.9c31.2,13.4,39,24.7,39,43.2,0,27.3-18.7,43.4-49.3,43.4s-51-16.1-51-46.4v-3.1h35.9c.2,11.7,5.9,19.3,14.9,19.3s13.6-5.9,13.6-13.6c0-11.3-15.7-16.2-28.5-21.4-23.1-9.4-33.6-21.6-33.6-39.9s23.3-41.7,49.3-41.7,17.6,2.1,25,5.9c15.1,7.8,22.4,19.1,22.6,38h-35.7Z"/>' +
    '<path d="M333.7,452.5v-169.1h-43v-48.9h141.4v48.9h-42.7v169.1h-55.7Z"/>' +
    '<path d="M633.3,452.5l1.8-163.2-.6-.6-46.5,163.8h-36.8l-47.1-165.3,1.8,165.3h-51.3v-218h71.6l43.3,143.5h.6l42.7-143.5h71.9v218h-51.3Z"/>' +
    '<path d="M881.6,452.5l-32.7-141.1h-.6l-32.7,141.1h-50.4l-56.3-218h56.6l29.2,141.7h.6l32.1-141.7h42.7l31.5,142.3h.6l29.8-142.3h56.3l-57.7,218h-48.9Z"/>' +
    '<path d="M111.8,281.1c0-27.9,20.1-48.8,47.4-48.8s47.6,20.3,47.6,46.1-20.7,47.3-46.5,47.3-48.5-18-48.5-44.6ZM183.8,279.2c0-14.1-10.1-26.6-24.6-26.6s-24.4,12-24.4,26.3,10.1,26.8,24.8,26.8,24.2-12,24.2-26.4Z"/>' +
    '<path d="M219.2,324.1v-90h49.1v20.2h-27.1v15.3h26.2v20.2h-26.2v34.3h-22Z"/>' +
    '</g></svg></div>';

  var LOGO = '<a href="/" class="tmw-logo-lockup" aria-label="Markets of Tomorrow">' + HEX + WORDMARK + '</a>';

  var NAV = [
    ['Global', '/', 'global'],
    ['Florida', '/#florida', 'florida'],
    ['New York', '/#new-york', 'new-york'],
    ['Tennessee', '/#tennessee', 'tennessee'],
    ['Caribbean', '/#caribbean', 'caribbean'],
    ['Rockies', '/#rockies', 'rockies'],
    ['Hotels', '/hotels/', 'hotels'],
    ['Restaurants', '/restaurants/', 'restaurants'],
    ['Golf', '/golf/', 'golf']
  ];
  var path = location.pathname;
  var active = /\/journal\/hotels\//.test(path) ? 'hotels'
    : /\/journal\/restaurants\//.test(path) ? 'restaurants'
    : /\/journal\/golf\//.test(path) ? 'golf'
    // "Global" is the active accent on the JOURNAL home only — not the map (which
    // also lives at "/"), where Database carries the gold glow instead.
    : ((path === '/' || path === '/index.html') && location.hostname !== 'map.oftmw.com') ? 'global'
    : '';
  var navHtml = NAV.map(function (n) {
    return '<a href="' + n[1] + '"' + (n[2] === active ? ' class="active"' : '') + '>' + n[0] + '</a>';
  }).join('');

  var CTA =
    '<a href="https://www.oftmw.com/map" class="nav-cta" id="nav-map-cta">' +
      '<span class="mc-pin" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 21s-7-7-7-12a7 7 0 0114 0c0 5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5" fill="currentColor"/></svg></span>' +
      '<span class="mc-label">Open Map</span><span class="mc-sep" aria-hidden="true"></span>' +
      '<span class="mc-count"><span class="mc-dot"></span><span id="mc-count-n">—</span> Live</span>' +
    '</a>';

  var headerHtml =
    '<div class="sticky-stack tmw-chrome-head"><nav class="main"><div class="wrap">' +
      LOGO + '<div class="nav-links">' + navHtml + '</div>' + CTA +
      '<button class="nav-burger" aria-label="Menu"><span></span><span></span><span></span></button>' +
    '</div></nav></div>';

  var footerHtml =
    '<footer class="tmw-chrome-foot"><div class="wrap"><div class="ft-grid">' +
      '<div>' + '<a href="/" class="tmw-logo-lockup">' + HEX + WORDMARK + '</a>' +
        '<p class="blurb">A powerhouse news network + data platform for hospitality, real estate, and lifestyle &mdash; powered by a real-time project database and TMW Intelligence, our AI for predictive forecasting.</p></div>' +
      // Data takes the slot the Focus Markets column used to occupy.
      '<div><h4>Data</h4><ul>' +
        '<li><a href="/markets/">Tracked Markets</a></li>' +
        '<li><a href="https://www.oftmw.com/map">Map</a></li>' +
        '<li><a href="https://www.oftmw.com/atlas">Atlas</a></li></ul></div>' +
      '<div><h4>Iconic Lists</h4><ul>' +
        '<li><a href="/golf/">Golf</a></li><li><a href="/restaurants/">Restaurants</a></li>' +
        '<li><a href="/hotels/">Hotels</a></li></ul></div>' +
      '<div><h4>Company</h4><ul>' +
        '<li><a href="/media/">About Us</a></li>' +
        '<li><a href="/media/">Advertise</a></li>' +
        '<li><a href="/media/#cta">Contact</a></li>' +
        '<li><a href="#" onclick="window.tmwFooterSubscribe(event);return false;">Subscribe</a></li>' +
        '<li><a href="/terms/">Terms</a></li></ul></div>' +
    '</div><div class="ft-bot"><div>&copy; <span id="tmw-yr"></span> Markets of Tomorrow</div>' +
      '<div>The Future is Here</div></div></div></footer>';

  var css = [
    '.tmw-chrome-head{position:sticky; top:0; z-index:60; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale}',
    '.tmw-chrome-head nav.main{position:relative; background:rgba(7,8,7,.78); backdrop-filter:blur(16px) saturate(1.4); -webkit-backdrop-filter:blur(16px) saturate(1.4); border-bottom:1px solid var(--hair)}',
    '.tmw-chrome-head nav.main .wrap{display:flex; align-items:center; justify-content:space-between; padding-top:14px; padding-bottom:14px; gap:24px; max-width:1240px; margin:0 auto; padding-left:28px; padding-right:28px}',
    // Hide the raw nav (flat region links + Open Map CTA) + hex until journal-dock
    // consolidates them into the universal menu, so the un-transformed chrome
    // header doesn't flash. journal-dock adds .tmw-nav-ready when done; the 1.2s
    // keyframe is the fallback if the dock never runs.
    'nav.main .tmw-hex-badge{display:none}',
    'nav.main .nav-links, nav.main .nav-cta{opacity:0; animation:tmwNavReveal 0s linear 1.5s forwards}',
    'nav.main.tmw-nav-ready .nav-links, nav.main.tmw-nav-ready .nav-cta{opacity:1; animation:none}',
    '@keyframes tmwNavReveal{to{opacity:1}}',
    '.tmw-chrome-head .nav-links{display:flex; gap:20px; align-items:center}',
    '.tmw-chrome-head .nav-links a{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--mute-2); transition:color .2s; position:relative; text-decoration:none}',
    '.tmw-chrome-head .nav-links a:hover, .tmw-chrome-head .nav-links a.active{color:var(--white)}',
    '.tmw-chrome-head .nav-links a.active::after{content:""; position:absolute; left:0; right:0; bottom:-6px; height:2px; background:var(--green); box-shadow:0 0 12px rgba(31,223,103,.6)}',
    '.tmw-chrome-head .nav-cta{display:inline-flex; align-items:center; gap:10px; padding:8px 8px 8px 14px; background:rgba(255,255,255,.04); border:1px solid var(--hair-2); border-radius:999px; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:11px; letter-spacing:.14em; text-transform:uppercase; font-weight:700; color:var(--white); transition:all .2s; position:relative; overflow:hidden; text-decoration:none}',
    '.tmw-chrome-head .nav-cta::before{content:""; position:absolute; inset:0; background:radial-gradient(60% 100% at 100% 50%, rgba(31,223,103,.18), transparent 70%); opacity:0; transition:opacity .25s}',
    '.tmw-chrome-head .nav-cta:hover{border-color:var(--green); transform:translateY(-1px)}',
    '.tmw-chrome-head .nav-cta:hover::before{opacity:1}',
    '.tmw-chrome-head .nav-cta .mc-pin{position:relative; width:18px; height:18px; flex:0 0 auto}',
    '.tmw-chrome-head .nav-cta .mc-pin svg{width:100%; height:100%; color:var(--green); filter:drop-shadow(0 0 4px rgba(31,223,103,.5))}',
    '.tmw-chrome-head .nav-cta .mc-pin::after{content:""; position:absolute; left:50%; top:50%; width:6px; height:6px; border-radius:50%; background:var(--green); transform:translate(-50%,-50%); animation:tmwcPinPulse 2.4s ease-out infinite; opacity:0}',
    '@keyframes tmwcPinPulse{0%{transform:translate(-50%,-50%) scale(.5); opacity:.8}80%{transform:translate(-50%,-50%) scale(3.6); opacity:0}100%{opacity:0}}',
    '.tmw-chrome-head .nav-cta .mc-label{position:relative; z-index:1}',
    '.tmw-chrome-head .nav-cta .mc-sep{width:1px; height:14px; background:var(--hair-2); position:relative; z-index:1}',
    '.tmw-chrome-head .nav-cta .mc-count{display:inline-flex; align-items:center; gap:6px; padding:5px 10px; background:rgba(31,223,103,.12); border:1px solid rgba(31,223,103,.32); border-radius:999px; color:var(--green); font-size:10.5px; letter-spacing:.06em; font-weight:700; position:relative; z-index:1}',
    '.tmw-chrome-head .nav-cta .mc-count .mc-dot{width:5px; height:5px; border-radius:50%; background:var(--green); box-shadow:0 0 6px var(--green); animation:tmwcDot 1.6s ease-in-out infinite}',
    '@keyframes tmwcDot{0%,100%{opacity:1}50%{opacity:.35}}',
    '@media(max-width:1180px){.tmw-chrome-head .nav-cta .mc-count{display:none}.tmw-chrome-head .nav-cta .mc-sep{display:none}}',
    '.tmw-chrome-head .nav-burger{display:none; width:28px; height:28px; flex-direction:column; gap:5px; padding:6px 0; align-items:flex-end; justify-content:center; background:none; border:0; cursor:pointer}',
    '.tmw-chrome-head .nav-burger span{display:block; width:22px; height:1.5px; background:var(--cream); transition:transform .2s}',
    '.tmw-chrome-head .tmw-logo-lockup{display:flex; align-items:center; gap:10px; text-decoration:none}',
    '.tmw-hex-badge{flex:0 0 auto; width:22px; height:22px}',
    '.tmw-hex-badge svg{width:100%; height:100%; display:block; overflow:visible}',
    '.tmw-hex-spinner{transform-origin:50% 50%; animation:tmwHardspin 4.2s cubic-bezier(.16,1,.3,1) infinite}',
    '@keyframes tmwHardspin{0%{transform:rotate(0)}55%{transform:rotate(810deg)}70%{transform:rotate(900deg)}100%{transform:rotate(1080deg)}}',
    '.tmw-hex-core{animation:tmwHexpulse 4.2s ease-in-out infinite; transform-origin:50% 50%}',
    '@keyframes tmwHexpulse{0%,45%{stroke:#A78BFA; filter:drop-shadow(0 0 0 rgba(167,139,250,0))}70%{stroke:#B9A6FF; filter:drop-shadow(0 0 6px rgba(185,166,255,.9))}100%{stroke:#A78BFA; filter:drop-shadow(0 0 0 rgba(167,139,250,0))}}',
    '.tmw-hex-ring{transform-origin:50% 50%; animation:tmwRing 4.2s ease-out infinite}',
    '@keyframes tmwRing{0%,60%{transform:scale(1);opacity:0}72%{opacity:.55}100%{transform:scale(1.7);opacity:0}}',
    '.tmw-wordmark{flex:0 1 auto; width:108px}',
    '.tmw-wordmark svg{width:100%; height:auto; display:block}',
    '.tmw-wordmark .wm-fill{fill:#fff}',
    '@media (prefers-reduced-motion: reduce){.tmw-hex-spinner,.tmw-hex-ring,.tmw-chrome-head .nav-cta .mc-pin::after,.tmw-chrome-head .nav-cta .mc-count .mc-dot{animation:none}.tmw-hex-ring{opacity:0}}',
    '@media(max-width:980px){',
    '.tmw-chrome-head .nav-burger{display:flex}',
    '.tmw-chrome-head .nav-links{position:absolute; top:100%; left:0; right:0; display:none; flex-direction:column; gap:0; align-items:stretch; background:rgba(7,8,7,.97); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border-bottom:1px solid var(--hair); padding:6px 28px 16px}',
    '.tmw-chrome-head .nav-links.open{display:flex}',
    // DIRECT children only (the flat region/section links). The rich dropdown
    // cards (.tmw-oc / .tmw-mm-item / .tmw-mm-cta) are also <a>s nested deeper in
    // .nav-links — a descendant `a` selector here gave them 13px top padding +
    // a border, which showed as a blank strip above every Focus Markets image
    // and crowded the Go-Pro pill. Scope to `> a` so only the flat links match.
    '.tmw-chrome-head .nav-links > a{padding:13px 0; border-bottom:1px solid var(--hair); font-size:12px}',
    '.tmw-chrome-head .nav-links > a.active::after{display:none}',
    '}',
    // font-family hardcoded on the root so the whole footer is self-owned —
    // the link list (ul a) + blurb have no font-family of their own, so
    // without this they inherit whatever the HOST page sets on <body>. Most
    // pages share a body font and look consistent; atlas sets its own
    // (font-family:var(--sans) on body), which is why its footer links/blurb
    // drifted from every other page. Inter matches the h4 + .ft-bot rules
    // (which already hardcode it), so this makes the footer render identically
    // everywhere. See [[tmw-universal-chrome-self-owned]].
    '.tmw-chrome-foot{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--ink-2); color:var(--mute-2); padding:60px 0 30px; border-top:1px solid var(--hair); margin-top:40px; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale}',
    '.tmw-chrome-foot .wrap{max-width:1240px; margin:0 auto; padding:0 28px}',
    '.tmw-chrome-foot .ft-grid{display:grid; grid-template-columns:1.5fr 1fr 1fr 1fr; gap:40px; padding-bottom:30px; border-bottom:1px solid var(--hair)}',
    '.tmw-chrome-foot h4{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--white); margin-bottom:14px; font-weight:600}',
    '.tmw-chrome-foot ul{list-style:none; display:flex; flex-direction:column; gap:9px; font-size:14px; margin:0; padding:0}',
    '.tmw-chrome-foot ul a{color:var(--mute); transition:color .2s; text-decoration:none}',
    '.tmw-chrome-foot ul a:hover{color:var(--green)}',
    '.tmw-chrome-foot .blurb{color:var(--mute); font-size:13px; line-height:1.55; margin-top:14px; max-width:32ch}',
    '.tmw-chrome-foot .tmw-wordmark{width:90px}',
    '.tmw-chrome-foot .ft-bot{padding-top:22px; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); display:flex; justify-content:space-between; flex-wrap:wrap; gap:14px}',
    '@media(max-width:900px){.tmw-chrome-foot .ft-grid{grid-template-columns:1fr 1fr; gap:30px}}',
    // Mobile (<=640): collapse the 4-section grid into a single stacked column
    // with hairline dividers between each section (Option A layout). Brand
    // block on top, then DATA / LISTS / COMPANY each as their own row, then
    // the © + tagline strip. Link list font bumps 14->15px so taps don't
    // require a magnifier on smaller phones; column max-width on the blurb
    // is dropped so the tagline uses the full footer width.
    '@media(max-width:640px){',
    '.tmw-chrome-foot{padding:44px 0 28px; margin-top:32px}',
    '.tmw-chrome-foot .ft-grid{grid-template-columns:1fr; gap:0; padding-bottom:0; border-bottom:0}',
    '.tmw-chrome-foot .ft-grid > *{padding:22px 0; border-top:1px solid var(--hair)}',
    '.tmw-chrome-foot .ft-grid > *:first-child{border-top:0; padding-top:4px}',
    '.tmw-chrome-foot .blurb{max-width:none; margin-bottom:4px}',
    '.tmw-chrome-foot h4{margin-bottom:12px}',
    '.tmw-chrome-foot ul{gap:11px; font-size:15px}',
    '.tmw-chrome-foot .ft-bot{padding-top:20px; border-top:1px solid var(--hair); margin-top:0}',
    '}'
  ].join('');

  function mount() {
    // Embedded mode (?embed=1) — the page is being shown inside the Onyx
    // answer bubble, so suppress the site chrome: no header, no footer, no
    // floating dock/search bar, no top padding. Just the project content.
    if (/[?&]embed=1\b/.test(location.search)) {
      try {
        document.documentElement.classList.add('tmw-embed');
        var es = document.createElement('style');
        es.setAttribute('data-tmw-embed', '');
        es.textContent = '.tmw-chrome-head,.tmw-chrome-foot,.tmw-dock,.banner-ad,'
          // map's own wordmark/logo variants (the map keeps its sidebar but the
          // "MARKETS OF TMW" lockup is chrome — hide it in embed):
          + '.tmw-hs-wm,.tmw-wordmark,.v2-tmw-logo,#header-logo-link{display:none!important}'
          + 'body{padding-top:0!important}#app-container{padding-top:0!important}';
        document.head.appendChild(es);
        // Keep the embed context across in-frame navigation (e.g. project page's
        // "View on Map" → /map/?project=…): stamp embed=1 onto same-origin links
        // so the destination also loads chrome-less. New-tab links break out.
        document.addEventListener('click', function (e) {
          var a = e.target && e.target.closest && e.target.closest('a[href]');
          if (!a || a.target === '_blank') return;
          var u; try { u = new URL(a.getAttribute('href'), location.href); } catch (_) { return; }
          if (u.origin === location.origin && !/[?&]embed=1\b/.test(u.search)) {
            u.searchParams.set('embed', '1');
            a.setAttribute('href', u.href);
          }
        }, true);
      } catch (e) {}
      return;   // skip header/footer injection entirely
    }
    var style = document.createElement('style');
    style.setAttribute('data-tmw-chrome', '');
    style.textContent = css;
    document.head.appendChild(style);

    var h = document.createElement('div');
    h.innerHTML = headerHtml;
    var headerEl = h.firstChild;
    // Keep the banner-ad on top: if the page opens with a banner, drop the
    // sticky header right AFTER it (instead of above it), matching the homepage.
    var banner = document.querySelector('.banner-ad');
    if (banner && banner.parentNode === document.body) {
      document.body.insertBefore(headerEl, banner.nextSibling);
    } else {
      document.body.insertBefore(headerEl, document.body.firstChild);
    }

    // If the page has a pulse ticker (the journal home + article pages do), pull
    // it INTO the header's sticky stack so the nav + ticker stick together as one
    // block — exactly like the home — instead of two sticky elements fighting for
    // top:0. Then drop the now-empty legacy .sticky-stack the ticker came from.
    // This lets every page use the one injected header without losing its ticker.
    try {
      var ticker = document.querySelector('.ticker');
      if (ticker && !headerEl.contains(ticker)) {
        var legacy = ticker.closest('.sticky-stack');
        headerEl.appendChild(ticker);
        if (legacy && legacy !== headerEl && legacy.children.length === 0) {
          legacy.parentNode && legacy.parentNode.removeChild(legacy);
        }
      }
    } catch (e) { /* ticker is optional; header still works without it */ }

    // Strip any pre-existing static page footer so only the universal chrome
    // footer renders. Pages that adopted the shared chrome kept their old
    // hand-rolled <footer> in place, which produced two stacked footers. This
    // removes every footer that isn't ours, making the chrome footer the single
    // source of truth across the whole site (one fix, all pages).
    try {
      var stale = document.querySelectorAll('footer:not(.tmw-chrome-foot)');
      for (var si = 0; si < stale.length; si++) {
        stale[si].parentNode && stale[si].parentNode.removeChild(stale[si]);
      }
    } catch (e) { /* defensive; footer injection still proceeds */ }

    var f = document.createElement('div');
    f.innerHTML = footerHtml;
    document.body.appendChild(f.firstChild);

    // Footer "Subscribe" → opens the same email-capture lightbox articles use.
    // Works on any page: reuse the signup funnel if it's already loaded,
    // otherwise lazy-load it (the funnel's own dedup guard prevents a double
    // popup with its 3s auto-trigger).
    window.tmwFooterSubscribe = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      function go() {
        try {
          // Clear any dismissed-but-not-removed popup so the funnel's singleton
          // guard doesn't make this CTA a no-op. Only nuke hidden ones — a
          // currently-open popup means there's nothing to do.
          var stale = document.querySelector('.tmw-sub:not(.show)');
          if (stale) stale.remove();
          if (window.tmwSignupFunnel && window.tmwSignupFunnel.email) window.tmwSignupFunnel.email();
          else if (window.tmwSignupFunnel && window.tmwSignupFunnel.open) window.tmwSignupFunnel.open();
        } catch (e) {}
      }
      if (window.tmwSignupFunnel && (window.tmwSignupFunnel.email || window.tmwSignupFunnel.open)) { go(); return; }
      var existing = document.querySelector('script[data-tmw-funnel-loader]');
      if (existing) { existing.addEventListener('load', go); return; }
      var s = document.createElement('script');
      s.src = '/_shared/journal-signup-funnel.js';
      s.setAttribute('data-tmw-funnel-loader', '');
      s.onload = go;
      document.body.appendChild(s);
    };

    var yr = document.getElementById('tmw-yr');
    if (yr) yr.textContent = String(new Date().getFullYear());

    // Shared Memberstack login — drops the account avatar into the header.
    if (!document.querySelector('script[data-tmw-auth-loader]')) {
      var authScript = document.createElement('script');
      authScript.src = '/_shared/journal-auth.js';
      authScript.defer = true;
      authScript.setAttribute('data-tmw-auth-loader', '');
      document.body.appendChild(authScript);
    }

    // Profile avatar → full-screen account dashboard (/account), replacing the
    // small dropdown. Capture phase + stopImmediatePropagation so we beat the
    // dropdown's own click handler. Signed-out "Join" pill is left untouched.
    if (!window.__tmwAccountNavWired) {
      window.__tmwAccountNavWired = true;
      document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('.v2-profile-btn.signed-in');
        if (!btn) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        location.href = '/account';
      }, true);
    }

    // Go-Pro paywall popup — load it on every page so the "Go Pro" CTA and
    // "Pro members" links work everywhere (the SEO market pages reference
    // window.tmwShowPaywall but never loaded the script, so they used to just
    // redirect). The script is a singleton; double-loading is a no-op.
    if (!window.tmwShowPaywall && !document.querySelector('script[data-tmw-paywall-loader]')) {
      var pwScript = document.createElement('script');
      pwScript.src = '/_shared/journal-paywall.js';
      pwScript.defer = true;
      pwScript.setAttribute('data-tmw-paywall-loader', '');
      document.body.appendChild(pwScript);
    }

    // Contextual headline for the ONE universal funnel — the boxes are identical
    // everywhere (one module, one CSS), but the headline is tailored per context
    // (the smart "Following X?" text). Markets sets its own opts in the block
    // further down; here we cover firm, project, and article pages. Must run
    // BEFORE the funnel script is appended so window.TMW_FUNNEL_OPTS is ready.
    (function setFunnelOptsByContext() {
      if (window.TMW_FUNNEL_OPTS) return;     // a page/block already chose the copy
      var p = location.pathname;
      function heroName() {
        try {
          var h = document.querySelector('.hero h1') || document.querySelector('h1');
          return h ? h.textContent.trim().replace(/\s+/g, ' ') : '';
        } catch (e) { return ''; }
      }
      if (/^\/firm\//.test(p)) {
        var firm = heroName();
        if (firm) window.TMW_FUNNEL_OPTS = { headline: 'Following ' + firm + '? Unlock TMW Intelligence — forecasts, the full pipeline, and updates.', eyebrow: 'The Future Is Here', source: 'firm_page' };
      } else if (/^\/projects\//.test(p)) {
        var proj = heroName();
        if (proj) window.TMW_FUNNEL_OPTS = { headline: 'Following ' + proj + '? Unlock TMW Intelligence — forecasts, data, and live updates.', eyebrow: 'The Future Is Here', source: 'project_page' };
      } else if (/^\/post\//.test(p)) {
        window.TMW_FUNNEL_OPTS = { headline: 'Go beyond the article — TMW Intelligence brings forecasts, data, and updates to every story.', eyebrow: 'The Future Is Here', source: 'article', event: 'subscribe_article' };
      }
    })();

    // Auto-load the signup funnel on MOST pages so non-logged-in visitors get
    // the email-capture / Go-Pro flow site-wide — not just on /markets/. The
    // funnel itself decides what to show (email capture every page until an
    // account exists; the Pro/trial upsell once per session). Articles now use
    // this same shared funnel (post.js no longer ships its own copy). Excluded:
    // the map & atlas (their own trial gates) and the account/legal pages.
    (function loadFunnelOnMostPages() {
      var p = location.pathname;
      if (/^\/(account|terms|privacy|auth|map|atlas)(\/|$)/.test(p)) return;
      if (p.indexOf('/markets/') === 0 || p === '/markets') return;   // handled by the contextual /markets/ block below
      if (window.tmwSignupFunnel || document.querySelector('script[data-tmw-funnel-loader]')) return;
      var fScript = document.createElement('script');
      fScript.src = '/_shared/journal-signup-funnel.js';
      fScript.defer = true;
      fScript.setAttribute('data-tmw-funnel-loader', '');
      document.body.appendChild(fScript);
    })();

    // Market pages: make EVERY Pro affordance open the popup. Most market pages
    // already wire their #market-pro-cta button + a.pro-link, but some Pro-
    // members links (e.g. on state rollups) and the /markets/ index are plain
    // upgrade links. A single delegated handler, scoped to /markets/, catches
    // them all without regenerating 140 static pages. defaultPrevented guard
    // means a page's own handler (which preventDefaults) wins — no double-open.
    if (location.pathname.indexOf('/markets/') === 0 || location.pathname === '/markets') {
      document.addEventListener('click', function (e) {
        if (e.defaultPrevented) return;
        var t = e.target;
        var a = t && t.closest && t.closest('a[href*="upgrade=1"], a.pro-link, [data-tmw-paywall]');
        if (!a) return;
        if (typeof window.tmwShowPaywall !== 'function') return;   // let the link navigate as fallback
        e.preventDefault();
        try { window.tmwFunnelTrack && window.tmwFunnelTrack('go_pro_clicked', { source: 'market_pro_link', path: location.pathname }); } catch (_) {}
        window.tmwShowPaywall({ source: 'market_page' });
      }, false);

      // Auto-triggering email→password→profile→Go-Pro funnel, same as the
      // article pages. It shares localStorage (tmw-sub-email / tmw-acct-skip)
      // with post.js, so a visitor who enters their email here and leaves
      // without a password gets the "add a password" step on their next visit
      // to ANY page — and vice versa. Headline is contextual to this market.
      (function () {
        // Place = the breadcrumb crumb right after "Markets" (city/state).
        var place = '';
        try {
          var crumbNav = document.querySelector('nav.crumbs, .crumbs');
          if (crumbNav) {
            var parts = crumbNav.textContent.split('/').map(function (s) { return s.trim(); }).filter(Boolean);
            var mi = parts.indexOf('Markets');
            var cand = mi >= 0 ? (parts[mi + 1] || '') : '';
            if (cand && cand.toLowerCase() !== 'by type') place = cand;
          }
        } catch (e) {}

        var headline, eyebrow;
        if (place) {
          headline = 'Following ' + place + '? Unlock TMW Intelligence — forecasts, the full pipeline, and updates.';
          eyebrow = place + ' · TMW Intelligence';
        } else {
          headline = 'Track tomorrow\'s developments with TMW Intelligence — forecasts, data, and updates.';
          eyebrow = 'The Future Is Here';
        }
        window.TMW_FUNNEL_OPTS = { headline: headline, eyebrow: eyebrow, source: 'market_page' };

        // Point the "See all on the map" buttons (the gold hero pill + the
        // per-status links) at a FRAMED map view instead of /map/?q= — the ?q=
        // form makes the map auto-open its search overlay on top of itself,
        // which is the weird double-popup. ?city=<place> frames the location
        // (exact city → pins overview; state/region → geocoded). Uses the same
        // clean breadcrumb place; type/index pages (no place) just open the map.
        try {
          var mapBtns = document.querySelectorAll('a[href*="/map/?q="]');
          for (var k = 0; k < mapBtns.length; k++) {
            mapBtns[k].setAttribute('href', place ? ('/map/?city=' + encodeURIComponent(place)) : '/map/');
          }
        } catch (e) {}

        if (!window.tmwSignupFunnel && !document.querySelector('script[data-tmw-funnel-loader]')) {
          var fScript = document.createElement('script');
          fScript.src = '/_shared/journal-signup-funnel.js';
          fScript.defer = true;
          fScript.setAttribute('data-tmw-funnel-loader', '');
          document.body.appendChild(fScript);
        }
      })();

      // Soft-gate the analytical "By the numbers" panel for non-Pro visitors.
      // The content stays in the DOM (we only blur it visually + lay an
      // "Unlock with Pro" card on top), so it's fully SEO-safe — Google still
      // renders and indexes the text. Pro members get the gate removed once
      // their auth resolves. The project lists / featured grid stay open.
      (function gatePremium() {
        var sec = null, ey = document.querySelectorAll('.section-eyebrow');
        for (var i = 0; i < ey.length; i++) {
          if (/by the numbers/i.test(ey[i].textContent || '')) { sec = ey[i].closest('section'); break; }
        }
        if (!sec || sec.querySelector('.tmw-gate-ov')) return;

        if (!document.getElementById('tmw-gate-css')) {
          var gst = document.createElement('style'); gst.id = 'tmw-gate-css';
          gst.textContent =
            // NB: distinct class from the generator's project-grid paywall
            // (.tmw-gate-inner there is a 460px-capped card) — name collision
            // was clamping this full-section wrapper. Keep this namespace unique.
            '.tmw-gated{position:relative}' +
            '.tmw-bng-inner{display:block;width:100%;max-width:none}' +
            '.tmw-gated .tmw-bng-inner{filter:blur(7px);pointer-events:none;user-select:none;-webkit-user-select:none;opacity:.85}' +
            '.tmw-gate-ov{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;z-index:2}' +
            '.tmw-gate-card{max-width:420px;text-align:center;background:rgba(20,20,20,.86);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid rgba(230,197,116,.4);border-radius:16px;padding:26px 28px;box-shadow:0 24px 60px rgba(0,0,0,.55);font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif}' +
            '.tmw-gate-eyebrow{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#f0d68a;margin-bottom:9px}' +
            '.tmw-gate-h{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:19px;line-height:1.25;color:#fff;margin:0 0 6px}' +
            '.tmw-bng-sub{font-size:13px;line-height:1.5;color:#C2C9C3;margin:0 0 16px}' +
            '.tmw-gate-btn{display:inline-block;background:#FFD300;color:#0a0a0a;border:0;border-radius:999px;padding:11px 22px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}' +
            '.tmw-gate-btn:hover{background:#ffdf3a}';
          document.head.appendChild(gst);
        }

        var inner = document.createElement('div'); inner.className = 'tmw-bng-inner';
        while (sec.firstChild) inner.appendChild(sec.firstChild);
        sec.appendChild(inner);
        var place = (window.TMW_FUNNEL_OPTS && window.TMW_FUNNEL_OPTS.eyebrow || '').split(' · ')[0] || 'this market';
        var ov = document.createElement('div'); ov.className = 'tmw-gate-ov';
        ov.innerHTML =
          '<div class="tmw-gate-card">' +
            '<div class="tmw-gate-eyebrow">TMW Pro</div>' +
            '<h3 class="tmw-gate-h">Unlock the full ' + (place === 'this market' ? 'market' : place) + ' data</h3>' +
            '<p class="tmw-bng-sub">Delivery forecasts, the full pipeline by phase, and developer breakdowns are a Pro feature.</p>' +
            '<button class="tmw-gate-btn" type="button" data-tmw-paywall="feature:intelligence">Unlock with Pro</button>' +
          '</div>';
        sec.appendChild(ov);
        sec.classList.add('tmw-gated');
        ov.querySelector('.tmw-gate-btn').addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();   // don't also trigger the delegated [data-tmw-paywall] handler
          try { window.tmwFunnelTrack && window.tmwFunnelTrack('go_pro_clicked', { source: 'market_gate', path: location.pathname }); } catch (_) {}
          if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall({ source: 'market_gate' });
          else window.location = '/map/?upgrade=1';
        });

        function ungate() { sec.classList.remove('tmw-gated'); var o = sec.querySelector('.tmw-gate-ov'); if (o) o.remove(); }
        // Pre-paint: a known Pro from last session → ungate synchronously so
        // there's no blur flash before auth resolves.
        try { if (localStorage.getItem('tmw_auth_state') === 'pro') { ungate(); return; } } catch (e) {}
        if (window._isPaidMember === true) { ungate(); return; }
        // Otherwise subscribe to auth once journal-auth is up; onChange fires on
        // resolution AND on later login, so a Pro member is ungated even if
        // Memberstack takes a while (no fixed timeout to miss).
        (function whenAuth() {
          function sub() { window.tmwAuth.onChange(function (a) { if (a && a.paid) ungate(); }); }
          if (window.tmwAuth && window.tmwAuth.onChange) { sub(); return; }
          var n = 0, iv = setInterval(function () {
            n++;
            if (window.tmwAuth && window.tmwAuth.onChange) { clearInterval(iv); sub(); }
            else if (n > 60) { clearInterval(iv); }
          }, 150);
        })();
      })();
    }

    // NOTE: the mobile hamburger toggle + mobile header layout are handled
    // centrally by journal-dock.js (wireBurgers + nav.main mobile CSS), so every
    // page — inline headers and this chrome — behaves identically.

    // Live "X Live" count from pulse.json (cheapest signal) + the universal
    // Pulse bell/feed in the header (works on every page).
    fetch('https://www.oftmw.com/map/pulse.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var el = document.getElementById('mc-count-n');
        if (el) {
          if (!data) { el.textContent = '387'; }
          else {
            var slugs = new Set();
            (data.events || []).forEach(function (e) { if (e.project_slug) slugs.add(e.project_slug); });
            var n = data.project_count || data.tracked || slugs.size || 387;
            el.textContent = Number(n).toLocaleString();
          }
        }
      })
      .catch(function () { var el = document.getElementById('mc-count-n'); if (el) el.textContent = '387'; });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
