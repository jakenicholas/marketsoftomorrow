/* ───────────────────────────────────────────────────────────────────────────
   TMW — the Dashboard button (header corner)

   Replaces the two competing controls (a Pulse count pill and a profile
   avatar, neither of which read as a button) with ONE purple-glow control:

        [ JN ]  DASHBOARD  ( 10 )

   · Signed IN  → the merged button, linking to /dashboard/. The Pulse count
                  moves inside it; the standalone bell is hidden.
   · Signed OUT → untouched. The profile button is the "Join" CTA and the
                  only way to sign in, so it must keep working exactly as-is.

   The account menu still exists — /dashboard/ carries the account links — and
   the profile button stays in the DOM (hidden) so any code that queries it,
   including Memberstack's own handlers, keeps functioning.
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.__tmwDashBtn) return;
  window.__tmwDashBtn = true;

  // ── The flash ───────────────────────────────────────────────────────────
  // Everything here arrives async: Memberstack resolves the member, the dock
  // paints the Pulse bell, and only then can this button replace them. On
  // every refresh that produced a visible sequence — old bell + avatar, then
  // a swap to the pill, initials popping from "ME" to the real ones, then the
  // count appearing. All correct, all ugly.
  //
  // So: remember the last known signed-in state and paint THAT on the first
  // frame, then reconcile. A returning member sees their own button
  // immediately; the async data only ever confirms it. The cache is a render
  // hint, never a source of truth — if the member turns out to be signed out,
  // the button is removed and the real chrome comes back.
  var LS = 'tmw_dashbtn_v1';
  function readCache() {
    try { return JSON.parse(localStorage.getItem(LS) || 'null') || null; } catch (e) { return null; }
  }
  function writeCache(o) {
    try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {}
  }
  function clearCache() { try { localStorage.removeItem(LS); } catch (e) {} }
  var CACHED = readCache();

  // Hide the controls this button replaces BEFORE they can paint. Only for a
  // member we have seen signed in — a signed-out visitor must keep the profile
  // button, it is their only way in.
  //
  // The pre-hide is SELF-EXPIRING, and that is the important part. Tying its
  // removal to the end of the polling loop was a real bug: on a stale cache a
  // signed-out visitor sat with the Join button hidden for 24s+ (worse in a
  // throttled background tab, where setTimeout drops to ~1/s) and had no way
  // to sign in. A guess about the header is never worth blocking the only
  // route to an account, so the guess gets a short deadline instead: if the
  // real button has not been built by then, the chrome comes straight back.
  // Being wrong now costs one frame of flash; it used to cost the sign-in.
  var PRE_HIDE_MS = 2500;
  function dropPreHide() {
    var pre = document.getElementById('tmw-dashbtn-pre');
    if (pre) pre.remove();
  }
  if (CACHED && CACHED.signedIn) {
    var pre0 = document.createElement('style');
    pre0.id = 'tmw-dashbtn-pre';
    pre0.textContent = '.tmw-auth .tmw-pulse-bell,.tmw-auth .v2-profile-btn{display:none !important}';
    (document.head || document.documentElement).appendChild(pre0);
    setTimeout(function () {
      // Built in time → build() has hidden them properly via .tmw-db-hidden
      // and the pre-hide has done its job. Not built → give the chrome back.
      if (!document.querySelector('.tmw-dashbtn')) { dropPreHide(); clearCache(); }
    }, PRE_HIDE_MS);
  }

  var CSS = [
    /* The pill itself is neutral dark gray; only the avatar and the count
       carry the purple, so the button reads as chrome, not as an alert. */
    '.tmw-dashbtn{display:inline-flex;align-items:center;gap:9px;padding:5px 13px 5px 6px;border-radius:999px;',
      'border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);text-decoration:none;cursor:pointer;',
      'transition:background .18s,border-color .18s,box-shadow .18s,transform .18s;flex:0 0 auto}',
    '.tmw-dashbtn:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.26);',
      'transform:translateY(-1px)}',
    '.tmw-dashbtn .db-face{width:24px;height:24px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;',
      'background:linear-gradient(135deg,#B9A6FF,#6d4fd6);color:#12091f;font:800 10px/1 "Inter",-apple-system,sans-serif;letter-spacing:.02em}',
    '.tmw-dashbtn .db-lbl{font:700 10.5px/1 "Inter",-apple-system,sans-serif;letter-spacing:.13em;text-transform:uppercase;',
      'color:#D8DCD9;white-space:nowrap}',
    /* Tier: gold = membership (purple stays the activity color). Pro warms the
       pill border, turns the avatar gold with a gold ring, and states PRO;
       free states FREE in a quiet outline tag that opens the Go Pro screen. */
    '.tmw-dashbtn.db-pro{border-color:rgba(230,197,116,.42)}',
    '.tmw-dashbtn.db-pro .db-face{background:linear-gradient(135deg,#f0d68a,#caa84f);',
      'box-shadow:0 0 0 1.5px rgba(7,8,7,.9),0 0 0 3px #E6C574,0 0 10px rgba(230,197,116,.45)}',
    '.tmw-dashbtn .db-tier{font:800 8.5px/1 "Inter",-apple-system,sans-serif;letter-spacing:.14em;margin-left:-2px;white-space:nowrap}',
    '.tmw-dashbtn .db-tier.pro{color:#12091f;background:linear-gradient(135deg,#f0d68a,#caa84f);padding:3px 6px;border-radius:5px}',
    '.tmw-dashbtn .db-tier.free{color:#6f776f;border:1px solid rgba(255,255,255,.14);padding:2px 6px;border-radius:5px;cursor:pointer;transition:border-color .15s,color .15s}',
    '.tmw-dashbtn .db-tier.free:hover{border-color:rgba(230,197,116,.6);color:#E6C574}',
    '.tmw-dashbtn .db-tier[hidden]{display:none}',
    /* the bell's number now lives in the button */
    '.tmw-auth .tmw-pulse-bell.tmw-db-hidden,.tmw-auth .v2-profile-btn.tmw-db-hidden{display:none !important}',
    '@media(max-width:720px){.tmw-dashbtn .db-lbl,.tmw-dashbtn .db-tier{display:none}.tmw-dashbtn{padding:5px 8px 5px 6px}}'
  ].join('');

  function injectCss() {
    if (document.getElementById('tmw-dashbtn-css')) return;
    var s = document.createElement('style');
    s.id = 'tmw-dashbtn-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function initials() {
    try {
      var m = window.__tmwMember || {};
      var n = String(m.name || m.first_name || '').trim();
      if (!n) {
        var e = String(m.email || (m.auth && m.auth.email) || '').trim();
        if (e) return e.slice(0, 2).toUpperCase();
        // Not resolved yet → last known initials beat a generic placeholder.
        return (CACHED && CACHED.initials) || 'ME';
      }
      var parts = n.split(/\s+/);
      return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    } catch (e) { return (CACHED && CACHED.initials) || 'ME'; }
  }

  function build(auth, profile) {
    var a = document.createElement('a');
    a.className = 'tmw-dashbtn';
    a.href = '/dashboard/';
    a.setAttribute('aria-label', 'Open your dashboard');
    a.innerHTML = '<span class="db-face">' + initials() + '</span>'
      + '<span class="db-lbl">Dashboard</span>'
      + '<span class="db-tier" hidden></span>';
    // Tier read: journal-auth's durable signal ('pro' | 'in' | 'out'). The button
    // only exists signed-in, so anything that isn't 'pro' paints as FREE.
    var tierEl = a.querySelector('.db-tier');
    function paintTier() {
      var pro = false;
      try { pro = localStorage.getItem('tmw_auth_state') === 'pro'; } catch (e) {}
      a.classList.toggle('db-pro', pro);
      tierEl.textContent = pro ? 'PRO' : 'FREE';
      tierEl.className = 'db-tier ' + (pro ? 'pro' : 'free');
      tierEl.hidden = false;
    }
    paintTier();
    // FREE tag → the Go Pro screen (all viewports; a free member tapping the
    // tier wants the upgrade, not the dashboard).
    a.addEventListener('click', function (ev) {
      var t = ev.target.closest && ev.target.closest('.db-tier.free');
      if (!t) return;
      ev.preventDefault(); ev.stopPropagation();
      if (window.tmwWelcome && window.tmwWelcome.pro && window.tmwWelcome.pro({ source: 'dashbtn_free_tag' })) return;
      window.location.href = '/map/?upgrade=1';
    });
    function sync() {
      writeCache({ signedIn: true, initials: a.querySelector('.db-face').textContent });
    }
    sync();
    if (profile) profile.classList.add('tmw-db-hidden');
    auth.appendChild(a);

    // The member record arrives AFTER this button can be built, so keep
    // resolving initials + tier for a few seconds rather than freezing the
    // first (cached) state. The Pulse count lives on the dock bell now.
    var tries = 0;
    (function refresh() {
      var f = a.querySelector('.db-face');
      if (f) { var ini = initials(); if (ini && ini !== f.textContent) { f.textContent = ini; sync(); } }
      paintTier();
      if (++tries < 40) setTimeout(refresh, 400);
    })();
    return a;
  }

  function tick(tries) {
    var auth = document.querySelector('.tmw-chrome-head .tmw-auth') || document.querySelector('.tmw-auth');
    var profile = auth && auth.querySelector('.v2-profile-btn');
    // Only signed-in members get the dashboard button. Signed out, the profile
    // button IS the Join CTA — replacing it would remove the way in.
    var signedIn = profile && profile.classList.contains('signed-in');
    if (auth && signedIn && !auth.querySelector('.tmw-dashbtn')) {
      injectCss();
      build(auth, profile);
      return;
    }
    if ((tries || 0) < 60) { setTimeout(function () { tick((tries || 0) + 1); }, 400); return; }
    // Gave up: the member never resolved as signed in. If we optimistically
    // hid the real chrome on a stale cache, put it back — a signed-out visitor
    // with no profile button has no way to sign in.
    if (CACHED && CACHED.signedIn) {
      clearCache();
      dropPreHide();
      var btn = document.querySelector('.tmw-dashbtn');
      if (btn) btn.remove();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { tick(0); });
  else tick(0);
})();
