/* tmw-followers.js — live follower counts on the media client subpages.
   Reads the worker /followers cache (fed by the admin Followers tab) and fills,
   PRESERVING each surface's existing format (abbreviated "199K" vs full "199,005"):
     • the "Total followers" proof stat   (.proof-grid .ps → .ps-num)   → umbrella
     • the umbrella strip Followers value  (.us → .uv, label "Followers") → umbrella
     • per-market outlet cards             (.ocard, matched by .oname)    → that market
     • any explicit [data-fc="umbrella" | "<marketkey>"] element
   Then injects a gold-glow growth bar after the outlet cards (or proof grid).
   The main /media page has its own inline copy of this; this file is for the
   subpages, which don't load journal-dock.js. */
(function () {
  var KEY = {
    'florida of tomorrow': 'florida', 'hotels of tomorrow': 'hotels',
    'tennessee of tomorrow': 'tennessee', 'new york of tomorrow': 'newyork',
    'caribbean of tomorrow': 'caribbean', 'rockies of tomorrow': 'rockies',
    'markets of tomorrow': 'markets'
  };
  function fmtK(n) { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (n >= 1e4) return Math.round(n / 1e3) + 'K'; if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'; return String(n); }
  // Keep the element's existing style: abbreviated (has K/M) → K/M, else full w/ commas.
  function styled(existing, n) { return /[km]/i.test(existing || '') ? fmtK(n) : (Number(n) || 0).toLocaleString(); }
  function set(el, n) { if (el && n != null) el.textContent = styled(el.textContent, n); }
  function injectCss() {
    if (document.getElementById('tmw-fc-css')) return;
    var s = document.createElement('style'); s.id = 'tmw-fc-css';
    s.textContent = '.tmw-growth-bar{display:flex;align-items:center;justify-content:center;gap:11px;margin:26px auto 0;max-width:780px;padding:13px 22px;border-radius:14px;font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12.5px;letter-spacing:.03em;color:#f0d68a;border:1px solid rgba(230,197,116,.42);background:linear-gradient(180deg,rgba(230,197,116,.10),rgba(230,197,116,.03));box-shadow:0 0 0 1px rgba(230,197,116,.10) inset,0 14px 50px -22px rgba(230,197,116,.55);text-align:center}.tmw-growth-bar .gi{font-size:12px}.tmw-growth-bar b{color:#fbe9b0;font-weight:700}.tmw-growth-bar .gs{color:rgba(236,234,229,.6)}';
    document.head.appendChild(s);
  }
  function apply(d) {
    var m = d.markets || {}, umb = d.umbrella || 0;
    document.querySelectorAll('.proof-grid .ps').forEach(function (ps) {
      var lab = ps.querySelector('.ps-lab'); if (lab && /total followers/i.test(lab.textContent)) set(ps.querySelector('.ps-num'), umb);
    });
    document.querySelectorAll('.us').forEach(function (us) {
      var k = us.querySelector('.uk'); if (k && /^followers/i.test(k.textContent.trim())) set(us.querySelector('.uv'), umb);
    });
    document.querySelectorAll('[data-fc]').forEach(function (el) {
      var key = (el.getAttribute('data-fc') || '').replace(/-/g, '');
      if (key === 'umbrella') set(el, umb); else if (m[key] != null) set(el, m[key]);
    });
    document.querySelectorAll('.ocard').forEach(function (card) {
      var nm = card.querySelector('.oname'); if (!nm) return;
      var key = KEY[nm.textContent.trim().toLowerCase()]; if (!key || m[key] == null) return;
      set(card.querySelector('.ost .ov'), m[key]);   // first stat per card = Followers
    });
    // Catch-all: proposal/media surfaces label the umbrella inconsistently
    // ("Total followers" / "Total social media followers" / "TOTAL FOLLOWERS"),
    // so also replace any leaf element still showing the old static placeholder.
    if (umb) {
      var OLD = /^(192,900|192,200|192\.9K|205K|205,000)$/;
      document.querySelectorAll('div,span,b,strong,p,td').forEach(function (el) {
        if (el.children.length === 0) { var t = (el.textContent || '').trim(); if (OLD.test(t)) el.textContent = styled(t, umb); }
      });
    }
    // Growth bar: prefers an explicit <... data-growth-bar> placeholder (bar appended
    // into it), else falls back to after the outlet cards / proof grid.
    if (d.growth && d.growth.delta != null && d.growth.delta !== 0 && !document.querySelector('.tmw-growth-bar')) {
      var ph = document.querySelector('[data-growth-bar]');
      var anchor = ph || document.querySelector('.ocards') || document.querySelector('.proof-grid');
      if (anchor) {
        injectCss();
        var g = d.growth, up = g.delta >= 0, dt = new Date(g.since + 'T00:00:00');
        var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var since = MON[dt.getMonth()] + ' ' + dt.getDate();
        var bar = document.createElement('div'); bar.className = 'tmw-growth-bar';
        bar.innerHTML = '<span class="gi">' + (up ? '▲' : '▼') + '</span><span><b>' + (up ? '+' : '') + g.delta.toLocaleString()
          + '</b> followers across the network this month<span class="gs">  (' + (up ? '+' : '') + g.pct + '% since ' + since + ')</span></span>';
        if (ph) ph.appendChild(bar); else anchor.parentNode.insertBefore(bar, anchor.nextSibling);
      }
    }
  }
  fetch('https://tmw.jake-ab7.workers.dev/followers', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d) apply(d); })
    .catch(function () {});
})();
