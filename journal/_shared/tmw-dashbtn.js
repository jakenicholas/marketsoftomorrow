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

  var CSS = [
    '.tmw-dashbtn{display:inline-flex;align-items:center;gap:9px;padding:5px 13px 5px 6px;border-radius:999px;',
      'border:1px solid rgba(167,139,250,.5);background:rgba(167,139,250,.12);text-decoration:none;cursor:pointer;',
      'transition:background .18s,border-color .18s,box-shadow .18s,transform .18s;',
      'box-shadow:0 0 18px rgba(167,139,250,.18);flex:0 0 auto}',
    '.tmw-dashbtn:hover{background:rgba(167,139,250,.2);border-color:rgba(167,139,250,.8);',
      'box-shadow:0 0 26px rgba(167,139,250,.42);transform:translateY(-1px)}',
    '.tmw-dashbtn .db-face{width:24px;height:24px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;',
      'background:linear-gradient(135deg,#B9A6FF,#6d4fd6);color:#12091f;font:800 10px/1 "Inter",-apple-system,sans-serif;letter-spacing:.02em}',
    '.tmw-dashbtn .db-lbl{font:700 10.5px/1 "Inter",-apple-system,sans-serif;letter-spacing:.13em;text-transform:uppercase;',
      'color:#EDE7FF;text-shadow:0 0 12px rgba(167,139,250,.55);white-space:nowrap}',
    '.tmw-dashbtn .db-n{font:800 10px/1.5 "Inter",-apple-system,sans-serif;color:#12091f;background:#B9A6FF;',
      'padding:2px 7px;border-radius:999px;min-width:19px;text-align:center;box-shadow:0 0 12px rgba(185,166,255,.6)}',
    '.tmw-dashbtn .db-n[hidden]{display:none}',
    /* the bell's number now lives in the button */
    '.tmw-auth .tmw-pulse-bell.tmw-db-hidden,.tmw-auth .v2-profile-btn.tmw-db-hidden{display:none !important}',
    '@media(max-width:720px){.tmw-dashbtn .db-lbl{display:none}.tmw-dashbtn{padding:5px 8px 5px 6px}}'
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
        return 'ME';
      }
      var parts = n.split(/\s+/);
      return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    } catch (e) { return 'ME'; }
  }

  // The count is the Pulse number — the same signal that used to sit in the bell.
  function pulseCount(bell) {
    var t = String((bell && bell.textContent) || '').replace(/[^\d]/g, '');
    return t ? parseInt(t, 10) : 0;
  }

  function build(auth, bell, profile) {
    var a = document.createElement('a');
    a.className = 'tmw-dashbtn';
    a.href = '/dashboard/';
    a.setAttribute('aria-label', 'Open your dashboard');
    a.innerHTML = '<span class="db-face">' + initials() + '</span>'
      + '<span class="db-lbl">Dashboard</span>'
      + '<span class="db-n"></span>';
    var n = a.querySelector('.db-n');
    function sync() {
      var c = pulseCount(bell);
      if (c > 0) { n.textContent = c > 99 ? '99+' : String(c); n.hidden = false; }
      else { n.hidden = true; }
    }
    sync();
    // The bell's count arrives async and updates later; mirror it.
    if (bell && window.MutationObserver) {
      new MutationObserver(sync).observe(bell, { childList: true, characterData: true, subtree: true });
    }
    if (bell) bell.classList.add('tmw-db-hidden');
    if (profile) profile.classList.add('tmw-db-hidden');
    auth.appendChild(a);

    // Both the member record and the Pulse bell arrive AFTER this button can be
    // built, so keep resolving them for a few seconds rather than freezing the
    // first (empty) state: initials would stay "ME" and the count blank.
    var live = bell, tries = 0;
    (function refresh() {
      var f = a.querySelector('.db-face');
      if (f) { var ini = initials(); if (ini && ini !== f.textContent) f.textContent = ini; }
      if (!live) {
        live = document.querySelector('.tmw-pulse-bell');
        if (live) {
          live.classList.add('tmw-db-hidden');
          bell = live; sync();
          if (window.MutationObserver) new MutationObserver(sync).observe(live, { childList: true, characterData: true, subtree: true });
        }
      } else { sync(); }
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
      build(auth, auth.querySelector('.tmw-pulse-bell'), profile);
      return;
    }
    if ((tries || 0) < 60) setTimeout(function () { tick((tries || 0) + 1); }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { tick(0); });
  else tick(0);
})();
