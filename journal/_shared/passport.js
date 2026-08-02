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
  var PASSPORT_ICON = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="display:block"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M9.5 16.5h5"/></svg>';
  function toast(msg) {
    // Use the GENERIC site toast with a white passport icon — NOT tmwWatchToast
    // (which appends "added to your watchlist"), and not the default 🎉.
    if (window.tmwCelebrateToast) { try { window.tmwCelebrateToast({ title: msg, emoji: PASSPORT_ICON }); return; } catch (_) {} }
    var t = el('div', 'tmw-pp-toast', esc(msg)); document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('on'); });
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }
  function thisMonth() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

  // ── Memberstack resolution (poll while the SDK boots) ──────────────────────
  // We only ever READ the session (getCurrentMember) — never sign anyone out.
  function applyMember(m) {
    if (m && m.id) {
      var cf = m.customFields || {};
      var handle = (cf['first-name'] || '').trim();
      if (handle && cf['last-name']) handle += ' ' + String(cf['last-name']).trim().charAt(0) + '.';
      if (!handle && m.auth && m.auth.email) handle = String(m.auth.email).split('@')[0];
      MEMBER = { id: m.id, handle: handle || 'TMW Member' };
    } else { MEMBER = null; }
    return MEMBER;
  }
  function resolveMember(cb) {
    var tries = 0;
    (function poll() {
      var ms = window.$memberstackDom;
      if (ms && ms.getCurrentMember) {
        ms.getCurrentMember().then(function (r) { applyMember(r && r.data); cb(); })
          .catch(function () { MEMBER = null; cb(); });
        return;
      }
      if (tries++ < 30) setTimeout(poll, 300); else { MEMBER = null; cb(); }
    })();
  }
  // A live re-check at click time. The initial poll can run before Memberstack
  // has hydrated the cookie session, so MEMBER may be stale-null for a logged-in
  // user; re-reading here prevents popping a login modal at someone who is in
  // fact signed in (which reads as "I got logged out").
  function withFreshMember(cb) {
    if (MEMBER) return cb(true);
    var ms = window.$memberstackDom;
    if (ms && ms.getCurrentMember) {
      ms.getCurrentMember().then(function (r) { cb(!!applyMember(r && r.data)); }).catch(function () { cb(false); });
    } else cb(false);
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
    g.appendChild(btn);
    g.__id = id; g.__name = name; g.__loc = loc;
    return g;
  }
  function paintBeenControl(g, id) {
    var mine = !!STATE.mine[id];
    var btn = g.querySelector('.tmw-been-btn'), lbl = g.querySelector('.lbl');
    btn.classList.toggle('on', mine);
    lbl.textContent = mine ? 'Been' : "I've been";
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
    var rowsHtml = STATE.community.slice(0, 5).map(function (m) {
      return '<div class="tmw-pp-mrow">' +
        '<span class="tmw-pp-rk">' + (m.rank || '') + '</span>' +
        '<span class="tmw-pp-nm">' + esc(m.name) + '</span>' +
        '<span class="tmw-pp-ct">' + (m.count || 0) + (lt ? '<i>/' + lt + '</i>' : '') + '</span></div>';
    }).join('');
    var body = STATE.total > 0
      ? '<p class="tmw-pp-sub">' + STATE.total.toLocaleString() + ' member' + (STATE.total === 1 ? '' : 's') + ' ' +
        (STATE.total === 1 ? 'has' : 'have') + ' checked in on this list.</p>' +
        (rowsHtml ? '<div class="tmw-pp-mrows">' + rowsHtml + '</div>' : '')
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
    // Re-check the live session first so a not-yet-hydrated member isn't treated
    // as logged out (which would wrongly pop a login modal).
    withFreshMember(function (signedIn) {
      if (signedIn) quickToggle(id, name, loc);
      else promptSignIn();
    });
  }
  function promptSignIn() {
    toast('Sign in to save where you’ve been');
    // Use the site's own login flow (same as the header/paywall), and let the
    // modal close itself on success — matches journal-auth.js exactly.
    try {
      if (typeof window.tmwAuthModal === 'function') { window.tmwAuthModal('login'); return; }
      var ms = window.$memberstackDom;
      if (ms && ms.openModal) ms.openModal('LOGIN').then(function () { try { ms.hideModal(); } catch (_) {} }).catch(function () {});
    } catch (_) {}
  }

  // One tap = check in (or un-check). No dialog: we default the visit date to
  // this month. The leaderboard handle always follows the member's current
  // Memberstack name, so we send the freshly-derived handle on every check-in
  // (keeps the board in sync when they rename in their account). Just a toast —
  // fast. Optimistic flip, reverted if the write fails.
  function quickToggle(id, name, loc) {
    var remove = !!STATE.mine[id];
    var payload = {
      member_id: MEMBER.id, entity_type: CFG.entityType, list_slug: CFG.listSlug,
      item_id: id, item_name: name, item_location: loc, remove: remove
    };
    if (!remove) {
      payload.visited_on = thisMonth();
      if (MEMBER.handle) payload.display_name = MEMBER.handle;
    }
    if (remove) { delete STATE.mine[id]; } else { STATE.mine[id] = true; }
    decorate(); // optimistic repaint
    fetch(WORKER + '/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'failed'); }); })
      .then(function () {
        if (!remove && payload.display_name) HAS_HANDLE = true;
        toast(remove ? 'Removed from your passport' : 'Added to your passport ✓');
        loadCounts(); // confirm totals + community
      })
      .catch(function (e) {
        if (remove) { STATE.mine[id] = true; } else { delete STATE.mine[id]; }
        decorate();
        toast(e.message || 'Could not save');
      });
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
      /* community module */
      '.tmw-pp-community{margin:14px 0;padding:26px 28px;border:1px solid var(--hair-2,rgba(255,255,255,.14));border-radius:18px;background:linear-gradient(180deg,rgba(123,216,143,.055),rgba(255,255,255,.015));position:relative}',
      '.tmw-pp-community:before{content:"";position:absolute;left:0;top:22px;bottom:22px;width:3px;border-radius:3px;background:var(--green,#7bd88f);opacity:.65}',
      '.tmw-pp-eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--green,#7bd88f)}',
      '.tmw-pp-h{font-family:var(--serif,Georgia);font-size:22px;font-weight:500;margin:7px 0 6px;color:var(--white,#fff)}',
      '.tmw-pp-sub{color:var(--mute-2,#b7bdb6);font-size:14px;line-height:1.55;margin:0 0 14px;font-weight:300}',
      '.tmw-pp-mrows{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}',
      '.tmw-pp-mrow{display:flex;align-items:center;gap:12px;padding:12px 15px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid var(--hair-2,rgba(255,255,255,.1))}',
      '.tmw-pp-mrow .tmw-pp-rk{font-family:var(--serif,Georgia);font-size:17px;color:var(--mute,#9aa39c);min-width:24px;text-align:center;font-variant-numeric:tabular-nums}',
      '.tmw-pp-mrow:nth-child(1) .tmw-pp-rk,.tmw-pp-mrow:nth-child(2) .tmw-pp-rk,.tmw-pp-mrow:nth-child(3) .tmw-pp-rk{color:var(--gold,#e6c574);font-weight:600}',
      '.tmw-pp-mrow .tmw-pp-nm{flex:1;min-width:0;color:#fff;font-size:15px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tmw-pp-mrow .tmw-pp-ct{font-family:var(--mono);font-size:14px;color:var(--green,#7bd88f);font-weight:700;font-variant-numeric:tabular-nums}',
      '.tmw-pp-mrow .tmw-pp-ct i{color:var(--mute,#9aa39c);font-style:normal;font-weight:400;font-size:11.5px}',
      '.tmw-pp-lbbtn{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--ink,#0a0a0a);background:var(--green,#7bd88f);border:none;padding:11px 20px;border-radius:999px;cursor:pointer;transition:all .18s}',
      '.tmw-pp-lbbtn:hover{background:var(--green-soft,#9be7ac);transform:translateY(-1px)}',
      /* toast */
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
