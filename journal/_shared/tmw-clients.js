/* tmw-clients.js — THE universal "clients" section.
   One implementation of the logo grid + industry/market filters + view and
   sort toggles that /media has always had, so the ~10 surfaces that show it
   share a single source instead of each carrying a copy.

   Usage:  <div data-tmw-clients></div>          (auto-mounts)
           window.tmwClients.mount(el, {title, eyebrow, lede})

   CSS below is lifted verbatim from the media page so the two render
   identically; it is injected once and scoped under .tmwc-root. */
(function () {
  if (window.tmwClients) return;
  var ENDPOINT = 'https://tmw.jake-ab7.workers.dev/list/clients';
  var CSS = `/* -- client grid: two views (logo default, text) -- */
.pgrid{display:grid; gap:0}
.pgrid .p .pname,.pgrid .p .plogo{transition:opacity .2s}
/* TEXT view */
.pgrid.view-text{grid-template-columns:repeat(4,1fr); background-image:repeating-linear-gradient(to bottom,var(--hair) 0,var(--hair) 1px,transparent 1px,transparent 74px); border-bottom:1px solid var(--hair)}
.pgrid.view-text .p{display:flex; align-items:center; height:74px; box-sizing:border-box; font-family:var(--serif); font-weight:300; font-size:18px; line-height:1.2; color:var(--cream); padding:8px 14px 8px 0; transition:color .25s; overflow:hidden}
.pgrid.view-text .p:hover{color:var(--green-soft)}  /* color only -- no movement */
.pgrid.view-text .plogo{display:none}
/* LOGO view */
.pgrid.view-logo{grid-template-columns:repeat(6,1fr); gap:14px}
.pgrid.view-logo .p{display:flex; align-items:center; justify-content:center; aspect-ratio:1; border:1px solid var(--hair); border-radius:14px; background:rgba(255,255,255,.025); padding:14px; transition:border-color .25s, background .25s}
.pgrid.view-logo .p:hover{border-color:rgba(31,223,103,.4); background:rgba(31,223,103,.05)}  /* no movement */
.pgrid.view-logo .pname{display:none}
.pgrid.view-logo .plogo{max-width:100%; max-height:100%; width:auto; height:auto; object-fit:contain; filter:saturate(.95)}
.pgrid .p[hidden]{display:none}
/* collapsed: cap height, fade out bottom, until "show all" */
.pgrid.collapsed{max-height:520px; overflow:hidden; -webkit-mask-image:linear-gradient(180deg,#000 70%,transparent); mask-image:linear-gradient(180deg,#000 70%,transparent)}
.pgrid.filtering .p{animation:fadeIn .4s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
/* segmented toggle */
.seg{display:inline-flex; align-items:stretch; gap:4px; padding:3px; border:1px solid rgba(230,197,116,.32); border-radius:999px; height:38px; background:rgba(230,197,116,.04); box-shadow:0 0 18px -6px rgba(230,197,116,.25)}
.seg-group{display:inline-flex; gap:4px; align-items:stretch}
.seg-divider{width:1px; align-self:stretch; background:rgba(230,197,116,.32); margin:2px 4px; flex-shrink:0}
.seg-btn{background:transparent; border:none; color:var(--mute2); font-family:var(--mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; padding:0 10px; cursor:pointer; transition:background .2s, color .2s, box-shadow .2s; border-radius:999px; display:inline-flex; align-items:center; justify-content:center; min-width:42px}
.seg-btn svg{width:15px; height:15px; display:block}
.seg-btn.active{background:var(--gold); color:var(--ink); font-weight:700; box-shadow:0 0 0 1px rgba(230,197,116,.55), 0 0 22px rgba(230,197,116,.55), 0 0 4px rgba(230,197,116,.4)}
.seg-btn:not(.active):hover{color:var(--gold-soft)}
/* client filters */
.cfilters{display:flex; align-items:flex-end; gap:22px; flex-wrap:wrap; margin-bottom:24px}
.cfilter{display:flex; flex-direction:column; gap:8px}
.cfilter label{font-family:var(--mono); font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--gold-soft); text-shadow:0 0 14px rgba(230,197,116,.3)}
.cfilter-selects{display:flex; gap:10px; flex-wrap:wrap}
.cfilter select{appearance:none; -webkit-appearance:none; background:rgba(255,255,255,.04) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5L6 8l3-3.5' stroke='%239AA39C' stroke-width='1.4' fill='none'/%3E%3C/svg%3E") no-repeat right 14px center;
  border:1px solid var(--hair2); color:var(--cream); font-family:var(--sans); font-size:14px; padding:11px 38px 11px 15px; border-radius:10px; min-width:200px; cursor:pointer; transition:border-color .2s}
.cfilter select:hover{border-color:var(--hair2)}
.cfilter select:focus{outline:none; border-color:var(--gold)}
.cfilter select option{background:#141714; color:var(--cream)}
.cfilter-meta{margin-left:auto; font-family:var(--mono); font-size:12px; letter-spacing:.06em; color:var(--mute); padding-bottom:11px; display:flex; align-items:center; gap:12px}
.cfilter-meta #ccount{color:var(--gold-soft); font-weight:600; text-shadow:0 0 18px rgba(230,197,116,.5), 0 0 4px rgba(230,197,116,.35)}
.cclear{background:none; border:none; color:var(--mute); font-family:var(--mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; border-bottom:1px solid transparent; transition:color .2s, border-color .2s; padding:0 0 2px}
.cclear:hover{color:var(--green-soft); border-color:var(--green)}
.pgrid-empty{font-family:var(--serif); font-style:italic; font-weight:300; font-size:20px; color:var(--mute); padding:40px 0}
.loadmore{margin-top:30px; display:inline-flex; align-items:center; gap:10px; background:transparent; border:1px solid var(--hair2); color:var(--cream); font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase; padding:13px 22px; border-radius:999px; cursor:pointer; transition:border-color .2s, color .2s, background .2s}
.loadmore:hover{border-color:var(--green); color:var(--green-soft); background:rgba(31,223,103,.06)}
.loadmore .lm-plus{font-size:15px; line-height:1}
.loadmore[hidden]{display:none}
.pnote{font-size:13px; color:var(--mute); margin-top:26px; font-family:var(--mono); letter-spacing:.04em}



/* client tiles: 4 columns on mobile with tighter padding so logos fill more */
  .pgrid.view-logo{grid-template-columns:repeat(4,1fr); gap:8px}
  .pgrid.view-logo .p{padding:6px; border-radius:10px}
`;

  function injectCss() {
    if (document.getElementById('tmwc-css')) return;
    var s = document.createElement('style');
    s.id = 'tmwc-css';
    // scope every selector to .tmwc-root so a host page's own rules can't collide
    s.textContent = CSS.replace(/(^|\})\s*([^@{}]+)\{/g, function (m, brace, sel) {
      if (/^\s*(from|to|\d+%)\s*$/.test(sel)) return m;            // keyframe steps
      var scoped = sel.split(',').map(function (x) {
        x = x.trim();
        if (!x) return x;
        return x.indexOf('.tmwc-root') === 0 ? x : '.tmwc-root ' + x;
      }).join(',');
      return brace + scoped + '{';
    });
    document.head.appendChild(s);
  }

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }

  function shell(o) {
    return ''
      + (o.eyebrow ? '<div class="tmwc-eye">' + esc(o.eyebrow) + '</div>' : '')
      + (o.title ? '<h2 class="tmwc-h">' + esc(o.title) + '</h2>' : '')
      + (o.lede ? '<p class="tmwc-lede">' + esc(o.lede) + '</p>' : '')
      + '<div class="cfilters">'
      +   '<div class="cfilter cfilter-filter"><label>Filter</label><div class="cfilter-selects">'
      +     '<select class="f-ind" aria-label="Filter by Industry"><option value="">All Industries</option></select>'
      +     '<select class="f-loc" aria-label="Filter by Market"><option value="">All Markets</option></select>'
      +   '</div></div>'
      +   '<div class="cfilter cfilter-sort"><label>Sort</label><div class="seg seg-combined">'
      +     '<div class="seg-group seg-view" role="tablist" aria-label="View">'
      +       '<button type="button" class="seg-btn active" data-view="logo" title="Logos view" aria-label="Logos view">'
      +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M4 16l4.5-4.5 3.5 3.5 3-3 5 5"/><circle cx="9" cy="8.5" r="1.4" fill="currentColor" stroke="none"/></svg>'
      +       '</button>'
      +       '<button type="button" class="seg-btn" data-view="text" title="Text view" aria-label="Text view">'
      +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="6" x2="19" y2="6"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="18" x2="13" y2="18"/></svg>'
      +       '</button>'
      +     '</div>'
      +     '<span class="seg-divider" aria-hidden="true"></span>'
      +     '<div class="seg-group seg-sort" role="tablist" aria-label="Sort order">'
      +       '<button type="button" class="seg-btn active" data-sort="default" title="Default sort" aria-label="Default sort">'
      +         '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="7" cy="7" r="1.9"/><circle cx="17" cy="7" r="1.9"/><circle cx="7" cy="17" r="1.9"/><circle cx="17" cy="17" r="1.9"/></svg>'
      +       '</button>'
      +       '<button type="button" class="seg-btn" data-sort="alpha" title="Sort A-Z" aria-label="Alphabetical sort">'
      +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="14" y2="7"/><line x1="4" y1="12" x2="11" y2="12"/><line x1="4" y1="17" x2="8" y2="17"/><path d="M17 5v14m0 0l-3-3m3 3l3-3"/></svg>'
      +       '</button>'
      +     '</div>'
      +   '</div></div>'
      +   '<div class="cfilter-meta"><span class="c-count">0</span> clients <button class="cclear" type="button" hidden>Clear</button></div>'
      + '</div>'
      + '<div class="pgrid view-logo collapsed"></div>'
      + '<div class="pgrid-empty" hidden>No clients match those filters yet.</div>'
      + '<button class="loadmore" type="button">Show more <span class="lm-plus">+</span></button>';
  }

  function mount(root, opts) {
    opts = opts || {};
    injectCss();
    root.classList.add('tmwc-root');
    root.innerHTML = shell(opts);

    var grid = root.querySelector('.pgrid'), empty = root.querySelector('.pgrid-empty');
    var lm = root.querySelector('.loadmore'), count = root.querySelector('.c-count');
    var fInd = root.querySelector('.f-ind'), fLoc = root.querySelector('.f-loc');
    var clear = root.querySelector('.cclear');
    var items = [], sortMode = 'default';

    function options(sel, values) {
      values.sort().forEach(function (v) {
        var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o);
      });
    }
    function render() {
      var ind = fInd.value, loc = fLoc.value;
      var list = items.filter(function (i) {
        return (!ind || (i.industries || '').split('|').indexOf(ind) >= 0) && (!loc || i.location === loc);
      });
      if (sortMode === 'alpha') list = list.slice().sort(function (a, b) { return (a.name||'').localeCompare(b.name||''); });
      count.textContent = list.length;
      clear.hidden = !ind && !loc;
      empty.hidden = list.length > 0;
      grid.innerHTML = list.map(function (i) {
        return '<div class="p" data-name="' + esc(i.name) + '">'
          + '<span class="pname">' + esc(i.name) + '</span>'
          + (i.logo ? '<span class="plogo"><img src="' + esc(i.logo) + '" alt="' + esc(i.name) + '" loading="lazy"></span>' : '')
          + '</div>';
      }).join('');
      // "Show more" only matters while the grid is capped
      lm.hidden = !grid.classList.contains('collapsed') || list.length <= 18;
    }
    fInd.addEventListener('change', render);
    fLoc.addEventListener('change', render);
    clear.addEventListener('click', function () { fInd.value = ''; fLoc.value = ''; render(); });
    lm.addEventListener('click', function () { grid.classList.remove('collapsed'); lm.hidden = true; });
    root.querySelector('.seg-view').addEventListener('click', function (e) {
      var b = e.target.closest('.seg-btn'); if (!b) return;
      this.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
      grid.classList.toggle('view-logo', b.dataset.view === 'logo');
      grid.classList.toggle('view-text', b.dataset.view === 'text');
    });
    root.querySelector('.seg-sort').addEventListener('click', function (e) {
      var b = e.target.closest('.seg-btn'); if (!b) return;
      this.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
      sortMode = b.dataset.sort; render();
    });

    return fetch(ENDPOINT, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (w) {
        items = (w && w.data && Array.isArray(w.data.items))
          ? w.data.items.filter(function (i) { return i && i.active !== false; }) : [];
        var inds = {}, locs = {};
        items.forEach(function (i) {
          (i.industries || '').split('|').forEach(function (x) { if (x.trim()) inds[x.trim()] = 1; });
          if (i.location) locs[i.location] = 1;
        });
        options(fInd, Object.keys(inds));
        options(fLoc, Object.keys(locs));
        render();
        return items.length;
      })
      .catch(function () { empty.hidden = false; empty.textContent = 'Client list unavailable right now.'; return 0; });
  }

  window.tmwClients = { mount: mount };
  document.querySelectorAll('[data-tmw-clients]').forEach(function (el) {
    mount(el, { title: el.getAttribute('data-title') || '', eyebrow: el.getAttribute('data-eyebrow') || '', lede: el.getAttribute('data-lede') || '' });
  });
})();
