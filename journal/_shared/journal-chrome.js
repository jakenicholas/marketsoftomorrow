/* ------------------------------------------------------------------
   Markets of Tomorrow — shared journal chrome (header + footer)
   Injects the universal site header (logo + nav + Open Map CTA) at the
   top of <body> and the site footer at the bottom. One source of truth,
   so every page that includes this stays in sync.
     <script src="/_shared/journal-chrome.js" defer></script>
   Relies on the page's design tokens (--green, --mute-2, --white, --hair,
   --hair-2, --cream, --ink, --ink-2, --mono); the few it can't assume
   (--glass, --purple, --purple-glow) are hardcoded below.
-------------------------------------------------------------------*/
(function () {
  'use strict';

  // ── Universal Pulse trigger ──────────────────────────────────────────────
  // Runs BEFORE the chrome guard so Pulse appears on every page — including the
  // map, which mounts its header inline and sets __tmwChrome (so the chrome
  // block below is skipped there). buildPulse + pEsc + pRel are function
  // declarations, hoisted to the top of this IIFE, so they're callable here.
  (function () {
    if (window.__tmwPulse) return; window.__tmwPulse = true;
    function go(){
      fetch('https://www.oftmw.com/map/pulse.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) buildPulse(d.events || []); })
        .catch(function () {});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  })();

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
        '<p class="blurb">A powerhouse news network covering the brands shaping the future of hospitality, real estate, and lifestyle.</p></div>' +
      '<div><h4>Focus Markets</h4><ul>' +
        '<li><a href="/">Global</a></li><li><a href="/?market=florida">Florida</a></li>' +
        '<li><a href="/?market=new-york">New York</a></li><li><a href="/?market=tennessee">Tennessee</a></li>' +
        '<li><a href="/?market=caribbean">Caribbean</a></li><li><a href="/?market=rockies">Rockies</a></li></ul></div>' +
      '<div><h4>Iconic Lists</h4><ul>' +
        '<li><a href="/golf/">Golf</a></li><li><a href="/restaurants/">Restaurants</a></li>' +
        '<li><a href="/hotels/">Hotels</a></li></ul></div>' +
      '<div><h4>Company</h4><ul>' +
        '<li><a href="https://www.oftmw.com/map">Map of Tomorrow</a></li><li><a href="/media/">About Us</a></li>' +
        '<li><a href="/media/">Advertise</a></li><li><a href="mailto:hello@oftmw.com">Contact</a></li></ul></div>' +
    '</div><div class="ft-bot"><div>&copy; <span id="tmw-yr"></span> Markets of Tomorrow</div>' +
      '<div>The Future is Here</div></div></div></footer>';

  var css = [
    '.tmw-chrome-head{position:sticky; top:0; z-index:60}',
    '.tmw-chrome-head nav.main{position:relative; background:rgba(7,8,7,.82); backdrop-filter:blur(16px) saturate(1.4); -webkit-backdrop-filter:blur(16px) saturate(1.4); border-bottom:1px solid var(--hair)}',
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
    '.tmw-chrome-head .nav-links a{font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--mute-2); transition:color .2s; position:relative; text-decoration:none}',
    '.tmw-chrome-head .nav-links a:hover, .tmw-chrome-head .nav-links a.active{color:var(--white)}',
    '.tmw-chrome-head .nav-links a.active::after{content:""; position:absolute; left:0; right:0; bottom:-6px; height:2px; background:var(--green); box-shadow:0 0 12px rgba(31,223,103,.6)}',
    '.tmw-chrome-head .nav-cta{display:inline-flex; align-items:center; gap:10px; padding:8px 8px 8px 14px; background:rgba(255,255,255,.04); border:1px solid var(--hair-2); border-radius:999px; font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; font-weight:700; color:var(--white); transition:all .2s; position:relative; overflow:hidden; text-decoration:none}',
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
    '.tmw-hex-badge{flex:0 0 auto; width:18px; height:18px}',
    '.tmw-hex-badge svg{width:100%; height:100%; display:block; overflow:visible}',
    '.tmw-hex-spinner{transform-origin:50% 50%; animation:tmwHardspin 4.2s cubic-bezier(.16,1,.3,1) infinite}',
    '@keyframes tmwHardspin{0%{transform:rotate(0)}55%{transform:rotate(810deg)}70%{transform:rotate(900deg)}100%{transform:rotate(1080deg)}}',
    '.tmw-hex-core{animation:tmwHexpulse 4.2s ease-in-out infinite; transform-origin:50% 50%}',
    '@keyframes tmwHexpulse{0%,45%{stroke:#A78BFA; filter:drop-shadow(0 0 0 rgba(167,139,250,0))}70%{stroke:#B9A6FF; filter:drop-shadow(0 0 6px rgba(185,166,255,.9))}100%{stroke:#A78BFA; filter:drop-shadow(0 0 0 rgba(167,139,250,0))}}',
    '.tmw-hex-ring{transform-origin:50% 50%; animation:tmwRing 4.2s ease-out infinite}',
    '@keyframes tmwRing{0%,60%{transform:scale(1);opacity:0}72%{opacity:.55}100%{transform:scale(1.7);opacity:0}}',
    '.tmw-wordmark{flex:0 1 auto; width:88px}',
    '.tmw-wordmark svg{width:100%; height:auto; display:block}',
    '.tmw-wordmark .wm-fill{fill:#fff}',
    '@media (prefers-reduced-motion: reduce){.tmw-hex-spinner,.tmw-hex-ring,.tmw-chrome-head .nav-cta .mc-pin::after,.tmw-chrome-head .nav-cta .mc-count .mc-dot{animation:none}.tmw-hex-ring{opacity:0}}',
    '@media(max-width:980px){',
    '.tmw-chrome-head .nav-burger{display:flex}',
    '.tmw-chrome-head .nav-links{position:absolute; top:100%; left:0; right:0; display:none; flex-direction:column; gap:0; align-items:stretch; background:rgba(7,8,7,.97); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border-bottom:1px solid var(--hair); padding:6px 28px 16px}',
    '.tmw-chrome-head .nav-links.open{display:flex}',
    '.tmw-chrome-head .nav-links a{padding:13px 0; border-bottom:1px solid var(--hair); font-size:12px}',
    '.tmw-chrome-head .nav-links a.active::after{display:none}',
    '}',
    '.tmw-chrome-foot{background:var(--ink-2); color:var(--mute-2); padding:60px 0 30px; border-top:1px solid var(--hair); margin-top:40px}',
    '.tmw-chrome-foot .wrap{max-width:1240px; margin:0 auto; padding:0 28px}',
    '.tmw-chrome-foot .ft-grid{display:grid; grid-template-columns:1.5fr 1fr 1fr 1fr; gap:40px; padding-bottom:30px; border-bottom:1px solid var(--hair)}',
    '.tmw-chrome-foot h4{font-family:var(--mono); font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--white); margin-bottom:14px; font-weight:600}',
    '.tmw-chrome-foot ul{list-style:none; display:flex; flex-direction:column; gap:9px; font-size:14px; margin:0; padding:0}',
    '.tmw-chrome-foot ul a{color:var(--mute); transition:color .2s; text-decoration:none}',
    '.tmw-chrome-foot ul a:hover{color:var(--green)}',
    '.tmw-chrome-foot .blurb{color:var(--mute); font-size:13px; line-height:1.55; margin-top:14px; max-width:32ch}',
    '.tmw-chrome-foot .tmw-wordmark{width:118px}',
    '.tmw-chrome-foot .ft-bot{padding-top:22px; font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); display:flex; justify-content:space-between; flex-wrap:wrap; gap:14px}',
    '@media(max-width:900px){.tmw-chrome-foot .ft-grid{grid-template-columns:1fr 1fr; gap:30px}}',
    '@media(max-width:520px){.tmw-chrome-foot .ft-grid{grid-template-columns:1fr 1fr; gap:22px}}'
  ].join('');

  function mount() {
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

    var f = document.createElement('div');
    f.innerHTML = footerHtml;
    document.body.appendChild(f.firstChild);

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
        if (data) buildPulse(data.events || []);
      })
      .catch(function () { var el = document.getElementById('mc-count-n'); if (el) el.textContent = '387'; });
  }

  // ── Universal Pulse ──────────────────────────────────────────────────────
  // A bell + gold "new since you last looked" count, left of the profile icon
  // on every page; clicking opens a popup feed (like the account menu).
  function pEsc(s){ return (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function pRel(ts){
    var t = new Date(ts).getTime(); if (isNaN(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 3600) return Math.max(1, Math.floor(s/60)) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    if (s < 604800) return Math.floor(s/86400) + 'd ago';
    try { return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric' }); } catch(e){ return ''; }
  }
  function buildPulse(events){
    if (document.getElementById('tmw-pulse-bell')) return;
    events = (events || []).slice().sort(function(a,b){ return new Date(b.timestamp) - new Date(a.timestamp); });
    if (!document.getElementById('tmw-pulse-css')){
      var st = document.createElement('style'); st.id = 'tmw-pulse-css';
      st.textContent = [
        '.tmw-pulse-bell{position:relative;width:32px;height:32px;border-radius:50%;background:transparent;border:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:rgba(255,255,255,0.72);flex:0 0 auto;padding:0;transition:color .15s}',
        '.tmw-pulse-bell:hover{color:#fff}',
        '.tmw-pulse-bell svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
        '.tmw-pulse-count{position:absolute;top:-3px;right:-5px;min-width:11px;height:16px;padding:0 4px;border-radius:999px;background:#FFD300;color:#0a0a0a;font-size:10px;font-weight:800;line-height:16px;text-align:center;border:2px solid rgba(10,10,10,0.92)}',
        '.tmw-pulse-count[hidden]{display:none}',
        '.tmw-pulse-pop{position:absolute;top:calc(100% + 14px);right:0;width:372px;max-width:92vw;max-height:72vh;display:flex;flex-direction:column;background:rgba(16,16,18,0.97);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;box-shadow:0 22px 60px rgba(0,0,0,0.6);z-index:200;overflow:hidden}',
        '.tmw-pulse-pop[hidden]{display:none}',
        '.tmw-pulse-head{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;align-items:baseline;gap:8px;flex:0 0 auto}',
        '.tmw-pulse-head b{font-size:14px;font-weight:800;color:#fff;letter-spacing:.02em}',
        '.tmw-pulse-head .tmw-pulse-sub{font-size:11px;color:rgba(255,255,255,0.4)}',
        '.tmw-pulse-feed{overflow-y:auto;padding:6px}',
        '.tmw-pulse-item{display:flex;gap:11px;padding:9px 10px;border-radius:11px;text-decoration:none;cursor:pointer;transition:background .12s}',
        '.tmw-pulse-item:hover{background:rgba(255,255,255,0.05)}',
        '.tmw-pulse-item .pi-img{width:52px;height:52px;border-radius:9px;flex:0 0 auto;object-fit:cover;background:rgba(255,255,255,0.06)}',
        '.tmw-pulse-item .pi-body{min-width:0;flex:1}',
        '.tmw-pulse-item .pi-tag{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#1FDF67;margin-bottom:3px}',
        '.tmw-pulse-item .pi-title{font-size:13px;font-weight:600;color:#ECEAE5;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
        '.tmw-pulse-item .pi-meta{font-size:11px;color:rgba(255,255,255,0.4);margin-top:3px}',
        '.tmw-pulse-empty{padding:28px 16px;text-align:center;color:rgba(255,255,255,0.4);font-size:13px}',
        '@media(max-width:980px){.tmw-pulse-pop{position:fixed!important;top:62px!important;bottom:auto!important;left:12px!important;right:12px!important;width:auto!important;max-width:none!important;max-height:74vh!important}}'
      ].join('');
      document.head.appendChild(st);
    }
    var SEEN_KEY = 'tmw_pulse_seen';
    var seen = parseInt(localStorage.getItem(SEEN_KEY) || '0', 10);
    if (!seen) seen = Date.now() - 7 * 86400000;        // first visit → last 7 days
    var newCount = events.filter(function(e){ return new Date(e.timestamp).getTime() > seen; }).length;
    var feedHtml = events.length ? events.slice(0, 30).map(function(e){
      var img = e.image ? '<img class="pi-img" src="' + pEsc(e.image) + '" alt="" loading="lazy">' : '<div class="pi-img"></div>';
      var meta = (e.city ? pEsc(e.city) + ' · ' : '') + pRel(e.timestamp);
      return '<a class="tmw-pulse-item" href="' + pEsc(e.link || '#') + '">' + img +
        '<div class="pi-body"><span class="pi-tag">' + pEsc(e.tag || 'Update') + '</span>' +
        '<div class="pi-title">' + pEsc(e.title || e.project_title || '') + '</div>' +
        '<div class="pi-meta">' + meta + '</div></div></a>';
    }).join('') : '<div class="tmw-pulse-empty">No recent activity</div>';

    function attach(){
      var authBox = document.querySelector('.tmw-auth');
      var prof = authBox ? authBox.querySelector('.v2-profile-btn') : null;
      if (!authBox || !prof) return false;
      if (document.getElementById('tmw-pulse-bell')) return true;
      var bell = document.createElement('button');
      bell.id = 'tmw-pulse-bell'; bell.className = 'tmw-pulse-bell'; bell.type = 'button'; bell.setAttribute('aria-label', 'Pulse');
      bell.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>' +
        '<span class="tmw-pulse-count"' + (newCount > 0 ? '' : ' hidden') + '>' + (newCount > 9 ? '9+' : newCount) + '</span>';
      var pop = document.createElement('div');
      pop.id = 'tmw-pulse-pop'; pop.className = 'tmw-pulse-pop'; pop.hidden = true;
      pop.innerHTML = '<div class="tmw-pulse-head"><b>Pulse</b><span class="tmw-pulse-sub">Latest across the network</span></div>' +
        '<div class="tmw-pulse-feed">' + feedHtml + '</div>';
      authBox.insertBefore(bell, prof);
      authBox.appendChild(pop);
      bell.addEventListener('click', function(ev){
        ev.stopPropagation();
        var opening = pop.hidden;
        pop.hidden = !opening;
        if (opening){
          localStorage.setItem(SEEN_KEY, String(Date.now()));
          var c = bell.querySelector('.tmw-pulse-count'); if (c) c.hidden = true;
        }
      });
      document.addEventListener('click', function(ev){
        if (!pop.hidden && !bell.contains(ev.target) && !pop.contains(ev.target)) pop.hidden = true;
      });
      return true;
    }
    if (!attach()){ var n = 0, iv = setInterval(function(){ if (attach() || ++n > 60) clearInterval(iv); }, 150); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
