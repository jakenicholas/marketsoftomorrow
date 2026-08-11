/* tmw-loader.js — the between-pages loading screen ("Departure Board").
   Site-black veil with the passport's faint market-code field; THE / FUTURE /
   IS HERE spelled out on airport split-flap tiles that spin and settle with a
   purple glow, the Terminal's purple progress hairline beneath, and a
   "Loading your experience" caption.

   Triggers:
   - every qualifying same-origin <a> click (intercepted, veil holds the full
     2s fill, then navigates)
   - window.tmwLoader.go(url) — the SAME hold-then-navigate for programmatic
     redirects (the pinned action dock routes through this; any other JS
     `location.href` can too)
   Guards:
   - respects e.defaultPrevented (overlay/JS-handled links never trigger it),
     modifier/middle clicks, target=_blank, download, mailto/tel, same-page
     #hashes, and [data-no-loader]
   - pageshow ALWAYS hides it (bfcache restores would otherwise resurrect it)
   - a 6s failsafe hides it if no navigation was actually initiated
   - reduced-motion: tiles render settled instantly and navigation is NOT
     delayed
   - no CSS transitions anywhere (the GL map stalls them); animations only
   Include once per page (journal-chrome.js loads it site-wide). */
(function () {
  'use strict';
  if (window.__tmwLoader) return;
  window.__tmwLoader = true;

  var css = [
    '.tmwl{position:fixed;inset:0;z-index:99990;background:#070807;display:none;align-items:center;justify-content:center}',
    '.tmwl.on{display:flex}',
    /* the passport's faint market-code field, dropped behind the board */
    '.tmwl-codes{position:absolute;inset:-2% -2% auto -2%;margin:0;z-index:0;pointer-events:none;white-space:pre;overflow:hidden;font-family:\'JetBrains Mono\',ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;letter-spacing:.5px;color:rgba(228,230,234,.045)}',
    '.tmwl-board{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;align-items:center}',
    '.tmwl-row{display:flex;gap:6px}',
    '.tmwl-flap{width:clamp(30px,4.4vw,54px);height:clamp(42px,6.1vw,74px);border-radius:7px;background:linear-gradient(180deg,#151517 48%,#0e0e10 52%);border:1px solid rgba(255,255,255,.09);display:flex;align-items:center;justify-content:center;font:700 clamp(19px,2.9vw,35px) \'JetBrains Mono\',ui-monospace,Menlo,monospace;color:#9AA39C;position:relative;overflow:hidden}',
    '.tmwl-flap::after{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(0,0,0,.55)}',
    '.tmwl-flap.space{background:transparent;border-color:transparent}',
    '.tmwl-flap.done{color:#C4B5FD;text-shadow:0 0 22px rgba(167,139,250,.5);border-color:rgba(167,139,250,.4)}',
    /* the Terminal's progress hairline */
    '.tmwl-bar{width:min(380px,58vw);height:2px;background:rgba(255,255,255,.09);margin-top:20px;border-radius:2px;overflow:hidden}',
    '.tmwl-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#A78BFA,#C4B5FD);box-shadow:0 0 14px rgba(167,139,250,.7);animation:tmwlBar 1.9s ease forwards}',
    '@keyframes tmwlBar{to{width:100%}}',
    '.tmwl-sub{margin-top:15px;font:600 10.5px \'JetBrains Mono\',ui-monospace,Menlo,monospace;letter-spacing:.34em;color:#9AA39C;text-transform:uppercase}',
    '@media(prefers-reduced-motion:reduce){.tmwl-bar i{animation:none;width:100%}}'
  ].join('');
  var st = document.createElement('style'); st.textContent = css;
  document.head.appendChild(st);

  // The member-passport's market-code wallpaper (same seeded field).
  var CODES = ['LAX','WPB','LON','MIA','NYC','TYO','CHI','SLC','AUS','BNA','PAR','DXB','HKG','SIN','MIL','ASP','SFO','BOS','SEA','DFW','ATL','DEN','LAS','GVA','ZRH','MAD','ROM','SYD','DOH','SJD','JFK','LHR','CDG','HND','ORD','PBI','NAS','PHX','SAN','AUH','IST','BCN','VCE','MUC','AMS','VIE','CPH','DUB','MEX','SCL','BOM','DEL','BKK','ICN','PEK','MEL','CPT','TLV','RUH','JED','YYZ','YVR','HNL','MCO','NCE','LIS','ATH','PRG','KEF','NAP','MNL'];
  var codeField = (function(){
    var seed = 7, out = '';
    function rnd(){ seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var r = 0; r < 60; r++) { var ln = ''; for (var c = 0; c < 100; c++) ln += CODES[Math.floor(rnd() * CODES.length)] + ' '; out += ln + '\n'; }
    return out;
  })();

  var WORDS = ['THE', 'FUTURE', 'IS HERE'];
  var el = document.createElement('div');
  el.className = 'tmwl';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<pre class="tmwl-codes"></pre>' +
    '<div class="tmwl-board">' +
      WORDS.map(function(){ return '<div class="tmwl-row"></div>'; }).join('') +
      '<div class="tmwl-bar"><i></i></div>' +
      '<div class="tmwl-sub">Loading your experience</div>' +
    '</div>';
  el.querySelector('.tmwl-codes').textContent = codeField;
  function mount(){ if (!el.parentNode && document.body) document.body.appendChild(el); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  var GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var flapTimers = [];
  function reduced(){ try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } }
  function runFlaps(){
    flapTimers.forEach(function (t) { clearInterval(t.iv); clearTimeout(t.to); });
    flapTimers = [];
    var still = reduced();
    var rows = el.querySelectorAll('.tmwl-row');
    WORDS.forEach(function (word, ri) {
      var row = rows[ri]; if (!row) return;
      row.innerHTML = '';
      word.split('').forEach(function (ch, i) {
        var f = document.createElement('div');
        f.className = 'tmwl-flap' + (ch === ' ' ? ' space' : '');
        row.appendChild(f);
        if (ch === ' ') return;
        if (still) { f.textContent = ch; f.classList.add('done'); return; }
        f.textContent = GLYPHS[Math.floor(Math.random() * 26)];
        var iv = setInterval(function () { f.textContent = GLYPHS[Math.floor(Math.random() * 26)]; }, 55);
        var to = setTimeout(function () { clearInterval(iv); f.textContent = ch; f.classList.add('done'); },
          420 + ri * 250 + i * 120 + Math.random() * 150);
        flapTimers.push({ iv: iv, to: to });
      });
    });
    var bar = el.querySelector('.tmwl-bar i');
    if (bar) { bar.style.animation = 'none'; void bar.offsetHeight; bar.style.animation = ''; }
  }

  var hideTimer = null;
  var navigated = false;
  function show(){
    mount();
    runFlaps();
    el.classList.add('on');
    clearTimeout(hideTimer);
    // failsafe: a show that never became a navigation must not trap the page
    hideTimer = setTimeout(function () { if (!navigated) hide(); }, 6000);
  }
  function hide(){
    clearTimeout(hideTimer);
    flapTimers.forEach(function (t) { clearInterval(t.iv); clearTimeout(t.to); });
    flapTimers = [];
    el.classList.remove('on');
    var stub = document.getElementById('tmwl-stub');
    if (stub && stub.parentNode) stub.parentNode.removeChild(stub);
  }
  // Programmatic full-page redirects (the dock, any JS nav) come through here.
  // TRUE loading screen: stamp the handoff, show the board, navigate almost
  // immediately (120ms lets the veil paint) — the DESTINATION page re-shows
  // the board via the chrome stub + the arrival block below, and lifts it
  // only when the new page is fully loaded AND the 2s budget is spent. The
  // 2s is load time now, not a toll on top of it.
  function go(url){
    if (!url) return;
    if (reduced()) { location.href = url; return; }
    try { sessionStorage.setItem('tmwl_t0', String(Date.now())); } catch (_) {}
    show();
    navigated = false;
    setTimeout(function () { navigated = true; location.href = url; }, 120);
    // If the navigation gets canceled (Esc / stop) the old page would keep the
    // veil forever — lift it after 10s; a real navigation kills this timer
    // with the whole document anyway.
    setTimeout(hide, 10000);
  }
  window.tmwLoader = { show: show, hide: hide, go: go };

  // ── Arrival: continue the board on the destination page ────────────────
  // The origin page stamped tmwl_t0 right before navigating; the chrome stub
  // already covered this page in site-black. Take over with the full board
  // and lift it when the document is COMPLETE and at least 2s have passed
  // since the click (hard cap 6s so a slow third-party image can't trap it).
  var handoffT0 = 0;
  try {
    handoffT0 = +sessionStorage.getItem('tmwl_t0') || 0;
    sessionStorage.removeItem('tmwl_t0');
  } catch (_) {}
  if (handoffT0 && Date.now() - handoffT0 < 8000 && !reduced()) {
    mount();
    runFlaps();
    el.classList.add('on');
    var stub0 = document.getElementById('tmwl-stub');
    if (stub0 && stub0.parentNode) stub0.parentNode.removeChild(stub0);
    var arrivalCheck = function () {
      var elapsed = Date.now() - handoffT0;
      if ((document.readyState === 'complete' && elapsed >= 2000) || elapsed >= 6000) { hide(); return; }
      setTimeout(arrivalCheck, 100);
    };
    arrivalCheck();
    window.addEventListener('load', arrivalCheck);
  }

  // bfcache restore (Safari/Chrome back-forward) resurrects the old page WITH
  // the veil up — always drop it when a page becomes visible again. (persisted
  // restores only — the initial pageshow must not kill the arrival board)
  window.addEventListener('pageshow', function (e) { if (e.persisted) hide(); });

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;                        // an overlay/JS handled it
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.closest('[data-no-loader]') || a.hasAttribute('data-no-loader')) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    var u; try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.origin !== location.origin) return;
    if (u.pathname === location.pathname && u.search === location.search && u.hash) return;  // same-page anchor
    // Reduced-motion users navigate natively (no held animation).
    if (reduced()) return;
    e.preventDefault();
    go(u.href);
  });
})();
