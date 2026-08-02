/* ═══════════════════════════════════════════════════════════════════════════
   THE PASSPORT — member "I've been" check-ins on the iconic lists.
   Loaded by /golf, /hotels, /restaurants. Each page calls:
       tmwPassport.init({ listSlug: 'golf', entityType: 'golf' })
   after its ranking renders. This module then:
     • paints a per-item "I've been" control + "N been" count into every
       .rank-item .ri-ctas,
     • drops one distinct community module into #ranking after the top items,
     • runs the check-in dialog (visit date + optional note + first-time handle),
     • opens a leaderboard modal (per-category + overall).
   It re-decorates through a disconnect-safe MutationObserver, so the pages'
   own re-renders (region filter, sort, edit mode) never strip it.
   Member identity is Memberstack (mem_…), sent to the worker the same way the
   rest of the account layer does: first-party Origin + client-asserted id.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  var WORKER = 'https://tmw.jake-ab7.workers.dev';
  var CFG = null;                       // { listSlug, entityType }
  var MEMBER = null;                    // { id, handle } | null (logged out)
  var HAS_HANDLE = false;               // member already picked a leaderboard handle
  var COMMUNITY_AFTER = 3;              // inset the module after the top N items
  var STATE = { counts: {}, mine: {}, total: 0, community: [] };
  var observer = null, rafPending = false;

  // ── tiny helpers ──────────────────────────────────────────────────────────
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(msg) {
    if (window.tmwWatchToast) { try { window.tmwWatchToast(msg); return; } catch (_) {} }
    var t = el('div', 'tmw-pp-toast', esc(msg)); document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('on'); });
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }
  function thisMonth() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

  // ── Memberstack resolution (poll while the SDK boots) ──────────────────────
  function resolveMember(cb) {
    var tries = 0;
    (function poll() {
      var ms = window.$memberstackDom;
      if (ms && ms.getCurrentMember) {
        ms.getCurrentMember().then(function (r) {
          var m = r && r.data;
          if (m && m.id) {
            var cf = m.customFields || {};
            var handle = (cf['first-name'] || '').trim();
            if (handle && cf['last-name']) handle += ' ' + String(cf['last-name']).trim().charAt(0) + '.';
            if (!handle && m.auth && m.auth.email) handle = String(m.auth.email).split('@')[0];
            MEMBER = { id: m.id, handle: handle || 'TMW Member' };
          } else { MEMBER = null; }
          cb();
        }).catch(function () { MEMBER = null; cb(); });
        return;
      }
      if (tries++ < 30) setTimeout(poll, 300); else { MEMBER = null; cb(); }
    })();
  }

  // ── data ──────────────────────────────────────────────────────────────────
  function loadCounts() {
    var u = WORKER + '/checkin-counts?list_slug=' + encodeURIComponent(CFG.listSlug);
    if (MEMBER) u += '&me=' + encodeURIComponent(MEMBER.id);
    fetch(u, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.ok) { STATE.counts = d.counts || {}; STATE.mine = d.mine || {}; STATE.total = d.total || 0; STATE.community = d.community || []; }
      decorate();
    }).catch(function () { decorate(); });
    if (MEMBER) {
      fetch(WORKER + '/member-prefs?member_id=' + encodeURIComponent(MEMBER.id), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.prefs && d.prefs.display_name) { HAS_HANDLE = true; MEMBER.handle = d.prefs.display_name; } })
        .catch(function () {});
    }
  }

  // ── decorate (idempotent + observer-safe) ──────────────────────────────────
  function scheduleDecorate() { if (rafPending) return; rafPending = true; requestAnimationFrame(function () { rafPending = false; decorate(); }); }

  function decorate() {
    var wrap = document.getElementById('ranking'); if (!wrap) return;
    if (observer) observer.disconnect();
    try {
      var rows = wrap.querySelectorAll('.rank-item');
      rows.forEach(function (row) {
        var id = row.getAttribute('data-id') || ''; if (!id) return;
        var ctas = row.querySelector('.ri-ctas'); if (!ctas) return;
        var name = (row.querySelector('.ri-name') || {}).textContent || '';
        var loc = (row.querySelector('.ri-loc') || {}).textContent || '';
        var ctrl = ctas.querySelector('.tmw-been');
        if (!ctrl) {
          ctrl = buildBeenControl(id, name, loc);
          ctas.insertBefore(ctrl, ctas.firstChild);
        }
        paintBeenControl(ctrl, id);
      });
      ensureCommunityModule(wrap, rows);
    } finally { if (observer) observer.observe(wrap, { childList: true, subtree: true }); }
  }

  function buildBeenControl(id, name, loc) {
    var g = el('span', 'tmw-been');
    var btn = el('button', 'tmw-been-btn', beenIcon() + '<span class="lbl"></span>');
    btn.type = 'button';
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onBeenClick(id, name, loc); });
    var cnt = el('span', 'tmw-been-cnt', '');
    g.appendChild(btn); g.appendChild(cnt);
    g.__id = id; g.__name = name; g.__loc = loc;
    return g;
  }
  function paintBeenControl(g, id) {
    var mine = !!STATE.mine[id], n = STATE.counts[id] || 0;
    var btn = g.querySelector('.tmw-been-btn'), lbl = g.querySelector('.lbl'), cnt = g.querySelector('.tmw-been-cnt');
    btn.classList.toggle('on', mine);
    lbl.textContent = mine ? 'Been' : "I've been";
    cnt.textContent = n > 0 ? (n === 1 ? '1 been' : n.toLocaleString() + ' been') : '';
    cnt.style.display = n > 0 ? '' : 'none';
  }

  // Total items on this list (the leaderboard denominator: "4/50").
  function listTotal() {
    try { if (window.DATA && Array.isArray(window.DATA.items)) return window.DATA.items.length; } catch (_) {}
    return document.querySelectorAll('#ranking .rank-item').length || 0;
  }

  function ensureCommunityModule(wrap, rows) {
    var mod = wrap.querySelector('.tmw-pp-community');
    if (mod) mod.remove(); // rebuild so counts stay fresh
    mod = el('section', 'tmw-pp-community');
    var lt = listTotal();
    var chips = STATE.community.slice(0, 5).map(function (m) {
      return '<span class="tmw-pp-mchip"><i>#' + (m.rank || '') + '</i>' + esc(m.name) + '<b>' + (m.count || 0) + (lt ? '/' + lt : '') + '</b></span>';
    }).join('');
    var body = STATE.total > 0
      ? '<p class="tmw-pp-sub">' + STATE.total.toLocaleString() + ' member' + (STATE.total === 1 ? '' : 's') + ' ' +
        (STATE.total === 1 ? 'has' : 'have') + ' checked in on this list.</p>' +
        (chips ? '<div class="tmw-pp-mchips">' + chips + '</div>' : '')
      : '<p class="tmw-pp-sub">No one has checked in here yet. Be the first — tap “I’ve been” on any place above.</p>';
    mod.innerHTML =
      '<div class="tmw-pp-eyebrow">TMW Members · The Passport</div>' +
      '<h3 class="tmw-pp-h">Who’s been here</h3>' +
      body +
      '<button type="button" class="tmw-pp-lbbtn">See the leaderboard &rarr;</button>';
    mod.querySelector('.tmw-pp-lbbtn').addEventListener('click', function () { location.href = '/passport/?cat=' + encodeURIComponent(CFG.entityType); });
    // Insert after the top N visible rank items (or at the end for short lists).
    var anchor = rows[Math.min(COMMUNITY_AFTER, rows.length) - 1];
    if (anchor && anchor.nextSibling) wrap.insertBefore(mod, anchor.nextSibling);
    else wrap.appendChild(mod);
  }

  // ── check-in flow ───────────────────────────────────────────────────────────
  function onBeenClick(id, name, loc) {
    if (!MEMBER) return promptSignIn();
    openCheckinDialog(id, name, loc, !!STATE.mine[id]);
  }
  function promptSignIn() {
    toast('Sign in to save where you’ve been');
    try { if (window.$memberstackDom && window.$memberstackDom.openModal) window.$memberstackDom.openModal('LOGIN'); } catch (_) {}
  }

  function openCheckinDialog(id, name, loc, already) {
    var needHandle = !HAS_HANDLE;
    var handleRow = needHandle
      ? '<label class="tmw-pp-field"><span>Your leaderboard name</span>' +
        '<input type="text" id="tmwPpHandle" maxlength="40" value="' + esc(MEMBER.handle) + '" autocomplete="off"></label>' +
        '<p class="tmw-pp-fine">You’ll appear on TMW leaderboards as this. You can hide anytime in your dashboard.</p>'
      : '';
    var m = modal(
      (already ? 'Edit check-in' : 'Mark as visited'),
      '<p class="tmw-pp-place"><b>' + esc(name) + '</b>' + (loc ? ' <span>' + esc(loc) + '</span>' : '') + '</p>' +
      '<label class="tmw-pp-field"><span>When did you go?</span>' +
      '<input type="month" id="tmwPpWhen" value="' + thisMonth() + '" max="' + thisMonth() + '"></label>' +
      '<label class="tmw-pp-field"><span>Note <i>(optional)</i></span>' +
      '<input type="text" id="tmwPpNote" maxlength="200" placeholder="Played the back nine at sunset…" autocomplete="off"></label>' +
      handleRow +
      '<div class="tmw-pp-actions">' +
      (already ? '<button type="button" class="tmw-pp-remove">Remove check-in</button>' : '<span></span>') +
      '<button type="button" class="tmw-pp-save">' + (already ? 'Save' : 'I’ve been here') + '</button>' +
      '</div>'
    );
    m.node.querySelector('.tmw-pp-save').addEventListener('click', function () {
      var when = (m.node.querySelector('#tmwPpWhen') || {}).value || '';
      var note = (m.node.querySelector('#tmwPpNote') || {}).value || '';
      var handleI = m.node.querySelector('#tmwPpHandle');
      var handle = handleI ? handleI.value.trim() : null;
      if (!when) { toast('Pick when you went'); return; }
      if (needHandle && !handle) { toast('Add a leaderboard name'); return; }
      submitCheckin(id, name, loc, when, note, handle, false, m);
    });
    var rm = m.node.querySelector('.tmw-pp-remove');
    if (rm) rm.addEventListener('click', function () { submitCheckin(id, name, loc, '', '', null, true, m); });
  }

  function submitCheckin(id, name, loc, when, note, handle, remove, m) {
    var payload = {
      member_id: MEMBER.id, entity_type: CFG.entityType, list_slug: CFG.listSlug, item_id: id,
      item_name: name, item_location: loc, visited_on: when, note: note, remove: remove
    };
    if (handle) payload.display_name = handle;
    var btn = m.node.querySelector('.tmw-pp-save'); if (btn) { btn.disabled = true; btn.textContent = '…'; }
    fetch(WORKER + '/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'failed'); }); })
      .then(function (d) {
        if (remove) { delete STATE.mine[id]; } else { STATE.mine[id] = true; if (handle) { HAS_HANDLE = true; MEMBER.handle = handle; } }
        STATE.counts[id] = d.count || 0;
        m.close();
        toast(remove ? 'Removed from your passport' : 'Added to your passport ✓');
        // Refresh totals + community, then repaint.
        loadCounts();
      })
      .catch(function (e) { toast(e.message || 'Could not save'); if (btn) { btn.disabled = false; btn.textContent = remove ? 'Remove check-in' : 'I’ve been here'; } });
  }


  // ── generic modal ────────────────────────────────────────────────────────────
  function modal(title, bodyHtml, size) {
    var ov = el('div', 'tmw-pp-ov');
    var box = el('div', 'tmw-pp-box' + (size === 'wide' ? ' wide' : ''));
    box.innerHTML = '<button type="button" class="tmw-pp-x" aria-label="Close">&times;</button><h2 class="tmw-pp-title">' + esc(title) + '</h2><div class="tmw-pp-bd">' + bodyHtml + '</div>';
    ov.appendChild(box); document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('on'); });
    function close() { ov.classList.remove('on'); setTimeout(function () { ov.remove(); }, 220); }
    box.querySelector('.tmw-pp-x').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', function esc2(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); } });
    return { node: box, close: close };
  }

  function beenIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  }

  // ── styles ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('tmw-passport-css')) return;
    var s = el('style'); s.id = 'tmw-passport-css';
    s.textContent = [
      /* per-item control */
      '.tmw-been{display:inline-flex;align-items:center;gap:10px}',
      '.tmw-been-btn{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;padding:11px 18px;border-radius:999px;border:1px solid var(--hair-2,rgba(255,255,255,.14));color:var(--cream,#eee);display:inline-flex;align-items:center;gap:7px;cursor:pointer;background:transparent;transition:all .18s}',
      '.tmw-been-btn svg{width:13px;height:13px;opacity:.75;transition:all .18s}',
      '.tmw-been-btn:hover{border-color:var(--green,#7bd88f);color:var(--green,#7bd88f)}',
      '.tmw-been-btn:hover svg{opacity:1}',
      '.tmw-been-btn.on{background:var(--green,#7bd88f);border-color:var(--green,#7bd88f);color:var(--ink,#0a0a0a)}',
      '.tmw-been-btn.on svg{opacity:1}',
      '.tmw-been-cnt{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;color:var(--mute,#9aa39c);text-transform:uppercase}',
      /* community module */
      '.tmw-pp-community{margin:14px 0;padding:26px 28px;border:1px solid var(--hair-2,rgba(255,255,255,.14));border-radius:18px;background:linear-gradient(180deg,rgba(123,216,143,.055),rgba(255,255,255,.015));position:relative}',
      '.tmw-pp-community:before{content:"";position:absolute;left:0;top:22px;bottom:22px;width:3px;border-radius:3px;background:var(--green,#7bd88f);opacity:.65}',
      '.tmw-pp-eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--green,#7bd88f)}',
      '.tmw-pp-h{font-family:var(--serif,Georgia);font-size:22px;font-weight:500;margin:7px 0 6px;color:var(--white,#fff)}',
      '.tmw-pp-sub{color:var(--mute-2,#b7bdb6);font-size:14px;line-height:1.55;margin:0 0 14px;font-weight:300}',
      '.tmw-pp-mchips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}',
      '.tmw-pp-mchip{font-family:var(--mono);font-size:11px;letter-spacing:.05em;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.045);border:1px solid var(--hair-2,rgba(255,255,255,.12));color:var(--mute-2,#b7bdb6);display:inline-flex;gap:7px;align-items:center}',
      '.tmw-pp-mchip i{font-style:normal;color:var(--mute,#9aa39c);opacity:.75}',
      '.tmw-pp-mchip b{color:var(--green,#7bd88f);font-weight:700}',
      '.tmw-pp-lbbtn{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--ink,#0a0a0a);background:var(--green,#7bd88f);border:none;padding:11px 20px;border-radius:999px;cursor:pointer;transition:all .18s}',
      '.tmw-pp-lbbtn:hover{background:var(--green-soft,#9be7ac);transform:translateY(-1px)}',
      /* modal */
      '.tmw-pp-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(6,8,7,.66);backdrop-filter:blur(6px);opacity:0;transition:opacity .22s}',
      '.tmw-pp-ov.on{opacity:1}',
      '.tmw-pp-box{width:100%;max-width:440px;max-height:88vh;overflow:auto;background:#12140f;border:1px solid var(--hair-2,rgba(255,255,255,.14));border-radius:20px;padding:30px 28px;position:relative;transform:translateY(8px);transition:transform .22s}',
      '.tmw-pp-box.wide{max-width:520px}',
      '.tmw-pp-ov.on .tmw-pp-box{transform:none}',
      '.tmw-pp-x{position:absolute;top:16px;right:18px;background:none;border:none;color:var(--mute,#9aa39c);font-size:26px;line-height:1;cursor:pointer}',
      '.tmw-pp-x:hover{color:#fff}',
      '.tmw-pp-title{font-family:var(--serif,Georgia);font-size:23px;font-weight:500;color:#fff;margin:0 0 18px}',
      '.tmw-pp-place{font-size:15px;color:var(--mute-2,#b7bdb6);margin:0 0 18px}',
      '.tmw-pp-place b{color:#fff;font-weight:600}.tmw-pp-place span{display:block;font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute,#9aa39c);margin-top:3px}',
      '.tmw-pp-field{display:block;margin-bottom:14px}',
      '.tmw-pp-field>span{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--mute,#9aa39c);margin-bottom:7px}',
      '.tmw-pp-field>span i{text-transform:none;letter-spacing:0;font-style:normal;opacity:.7}',
      '.tmw-pp-field input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.04);border:1px solid var(--hair-2,rgba(255,255,255,.14));border-radius:11px;padding:12px 14px;color:#fff;font-family:var(--sans,system-ui);font-size:15px}',
      '.tmw-pp-field input:focus{outline:none;border-color:var(--green,#7bd88f)}',
      '.tmw-pp-fine{font-size:12px;line-height:1.5;color:var(--mute,#9aa39c);margin:-6px 0 16px}',
      '.tmw-pp-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:22px}',
      '.tmw-pp-save{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--ink,#0a0a0a);background:var(--green,#7bd88f);border:none;padding:13px 24px;border-radius:999px;cursor:pointer;transition:all .18s}',
      '.tmw-pp-save:hover{background:var(--green-soft,#9be7ac)}.tmw-pp-save:disabled{opacity:.6;cursor:default}',
      '.tmw-pp-remove{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute,#9aa39c);background:none;border:none;cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
      '.tmw-pp-remove:hover{color:#e88}',
      /* fallback toast */
      '.tmw-pp-toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,14px);background:#12140f;border:1px solid rgba(123,216,143,.4);color:#fff;font-family:var(--sans,system-ui);font-size:14px;padding:12px 20px;border-radius:999px;z-index:10000;opacity:0;transition:all .3s}',
      '.tmw-pp-toast.on{opacity:1;transform:translate(-50%,0)}',
      '@media(max-width:600px){.tmw-been-btn{padding:10px 14px}.tmw-pp-community{padding:22px 20px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── public init ─────────────────────────────────────────────────────────────
  window.tmwPassport = {
    init: function (cfg) {
      if (!cfg || !cfg.listSlug || !cfg.entityType) return;
      CFG = cfg; injectStyles();
      observer = new MutationObserver(scheduleDecorate);
      resolveMember(function () { loadCounts(); });
    }
  };
})();
