/*
  Iconic list pages (golf / hotels / restaurants) — a gold Card ⇄ Text view
  switch in the tabs-bar. Card view (the big ranked cards) is the default; Text
  view is a dense spreadsheet-style "power listing" built from whatever cards
  are currently rendered, so it stays in sync with the sort + region filters
  (a MutationObserver rebuilds it whenever #ranking re-renders).

  Shared + identical across all three pages:
      <script src="/_shared/iconic-view.js" defer></script>
*/
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  if (!document.getElementById('iconic-view-styles')) {
    var css =
      '.iv-toggle{display:inline-flex; gap:4px; padding:4px; background:rgba(255,255,255,.04); border:1px solid var(--hair-2); border-radius:999px}' +
      '.iv-btn{width:36px; height:30px; display:inline-flex; align-items:center; justify-content:center; border:0; background:transparent; color:var(--mute-2); border-radius:999px; cursor:pointer; transition:background .18s, color .18s; padding:0}' +
      '.iv-btn:hover{color:var(--gold-soft)}' +
      '.iv-btn.on{background:var(--gold); color:var(--ink)}' +
      '.iv-btn.on:hover{color:var(--ink)}' +
      '.iv-btn svg{width:16px; height:16px}' +
      '.iv-btn .iv-t{font-family:var(--serif); font-weight:700; font-size:16px; line-height:1}' +
      '.iv-sheet{margin-top:10px; border:1px solid var(--hair); border-radius:14px; overflow:hidden; background:rgba(255,255,255,.015)}' +
      '.iv-row{display:grid; grid-template-columns:56px 1.5fr 1fr 1fr; gap:18px; align-items:center; padding:13px 22px; border-top:1px solid var(--hair)}' +
      '.iv-row:first-child{border-top:0}' +
      '.iv-head{font-family:var(--mono); font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--mute); background:rgba(255,255,255,.025)}' +
      '.iv-row:not(.iv-head):hover{background:rgba(230,197,116,.05)}' +
      '.iv-rk{font-family:var(--serif); font-size:19px; font-weight:600; color:var(--gold-soft); font-variant-numeric:tabular-nums; letter-spacing:-.01em}' +
      '.iv-nm{font-weight:600; color:var(--white); font-size:15px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}' +
      '.iv-nm a{color:inherit; text-decoration:none}' +
      '.iv-nm a:hover{color:var(--gold-soft)}' +
      '.iv-lc{font-family:var(--mono); font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--green); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}' +
      '.iv-dt{font-size:13px; color:var(--mute-2); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}' +
      '.iv-empty{padding:50px 0; text-align:center; color:var(--mute); font-family:var(--mono); font-size:13px; letter-spacing:.1em}' +
      '@media(max-width:760px){.iv-row{grid-template-columns:38px 1fr auto; gap:12px} .iv-row .iv-dt{display:none} .iv-head span:nth-child(4){display:none}}';
    var st = document.createElement('style'); st.id = 'iconic-view-styles'; st.textContent = css; document.head.appendChild(st);
  }

  var IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.6" fill="currentColor" stroke="none"/><path d="M21 15l-5-4.5L6 20"/></svg>';

  function start() {
    var actions = document.querySelector('.tabs-bar .actions');
    var ranking = document.getElementById('ranking');
    if (!actions || !ranking || document.getElementById('iconicSheet')) return;

    var tg = document.createElement('div');
    tg.className = 'iv-toggle';
    tg.setAttribute('role', 'tablist');
    tg.innerHTML =
      '<button class="iv-btn on" data-v="card" title="Card view" aria-label="Card view">' + IMG + '</button>' +
      '<button class="iv-btn" data-v="text" title="List view" aria-label="List view"><span class="iv-t">T</span></button>';
    actions.insertBefore(tg, actions.firstChild);

    var sheet = document.createElement('div');
    sheet.id = 'iconicSheet'; sheet.className = 'iv-sheet'; sheet.hidden = true;
    ranking.parentNode.insertBefore(sheet, ranking.nextSibling);

    var mode = 'card';

    function buildSheet() {
      var cards = [].slice.call(ranking.querySelectorAll('.rank-item'));
      var head = '<div class="iv-row iv-head"><span>#</span><span>Name</span><span>Location</span><span>Details</span></div>';
      if (!cards.length) { sheet.innerHTML = head + '<div class="iv-empty">Nothing in this region yet.</div>'; return; }
      var body = cards.map(function (c) {
        function txt(sel) { var e = c.querySelector(sel); return e ? e.textContent.trim() : ''; }
        var arch = txt('.ri-chip.arch').replace(/^[^A-Za-z0-9]+/, '').trim();
        var year = txt('.ri-chip.year').trim();
        var details = [arch, year].filter(Boolean).join('  ·  ');
        var cta = c.querySelector('.btn-cta');
        var href = cta ? (cta.getAttribute('href') || '') : '';
        var name = txt('.ri-name');
        var nm = (href && href !== '#') ? ('<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(name) + '</a>') : esc(name);
        return '<div class="iv-row">' +
          '<span class="iv-rk">' + esc(txt('.ri-rank')) + '</span>' +
          '<span class="iv-nm">' + nm + '</span>' +
          '<span class="iv-lc">' + esc(txt('.ri-loc')) + '</span>' +
          '<span class="iv-dt">' + esc(details) + '</span></div>';
      }).join('');
      sheet.innerHTML = head + body;
    }

    function setMode(v) {
      if (v === mode) return;
      mode = v;
      var btns = tg.querySelectorAll('.iv-btn');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-v') === v);
      if (v === 'text') { buildSheet(); ranking.style.display = 'none'; sheet.hidden = false; }
      else { sheet.hidden = true; ranking.style.display = ''; }
    }

    tg.addEventListener('click', function (e) {
      var b = e.target.closest('.iv-btn'); if (b) setMode(b.getAttribute('data-v'));
    });

    // Keep the sheet current as the cards re-render (sort, region filter, edits).
    try { new MutationObserver(function () { if (mode === 'text') buildSheet(); }).observe(ranking, { childList: true }); } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
