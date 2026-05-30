/*
  TMW Studio admin auth — GitHub login glue.

  Include early in <head> on any admin page:
      <script src="/journal/_shared/admin-auth.js"></script>

  - Captures the session token the worker hands back in the URL fragment
    (#tmw_session=…) after GitHub OAuth, stores it under the same localStorage
    key the studio pages already read ('tmw-admin-token-v1') AND the analytics
    sessionStorage key ('tmw_admin_token'), then cleans the URL.
  - Exposes window.TMWAuth = { token, loginUrl, logout }.
  - Injects a small top-right "Log in with GitHub" / "● username · logout"
    widget on every admin page.

  The worker accepts this session token as a Bearer exactly like the old
  ADMIN_TOKEN, so existing pages keep working with zero other changes.
*/
(function () {
  'use strict';
  var LS_KEY = 'tmw-admin-token-v1';     // studio pages
  var SS_KEY = 'tmw_admin_token';        // analytics.html
  var WORKER = 'https://tmw.jake-ab7.workers.dev';

  // 1) Capture the session from the OAuth redirect fragment.
  var freshLogin = false;
  try {
    var m = (location.hash || '').match(/[#&]tmw_session=([^&]+)/);
    if (m) {
      var tok = decodeURIComponent(m[1]);
      try { localStorage.setItem(LS_KEY, tok); } catch (e) {}
      try { sessionStorage.setItem(SS_KEY, tok); } catch (e) {}
      freshLogin = true;
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (e) {}

  function token() {
    try { return (localStorage.getItem(LS_KEY) || sessionStorage.getItem(SS_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function loginUrl() {
    return WORKER + '/admin/auth/login?redirect=' + encodeURIComponent(location.origin + location.pathname + location.search);
  }
  function logout() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
    location.reload();
  }
  window.TMWAuth = { token: token, loginUrl: loginUrl, logout: logout, freshLogin: freshLogin };

  // 2) Floating login/logout widget.
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function loginBtn() {
    return '<a href="' + loginUrl() + '" style="background:#fff;color:#070807;padding:8px 15px;border-radius:99px;text-decoration:none;font-weight:700;letter-spacing:.04em">Log in with GitHub</a>';
  }
  function render() {
    var el = document.getElementById('tmw-auth-widget'); if (!el) return;
    if (!token()) { el.innerHTML = loginBtn(); return; }
    fetch(WORKER + '/admin/auth/me', { headers: { 'Authorization': 'Bearer ' + token() } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.user) {
          el.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px;background:rgba(31,223,103,.12);color:#42EB81;padding:7px 13px;border-radius:99px;border:1px solid rgba(31,223,103,.3)">● ' + esc(d.user) +
            ' <a href="#" id="tmw-logout" style="color:#9AA39C;text-decoration:none;font-weight:600">logout</a></span>';
          var lo = document.getElementById('tmw-logout');
          if (lo) lo.onclick = function (e) { e.preventDefault(); logout(); };
        } else {
          el.innerHTML = loginBtn();   // stored token no longer valid
        }
      })
      .catch(function () { el.innerHTML = loginBtn(); });
  }
  function mount() {
    if (document.getElementById('tmw-auth-widget')) return;
    var el = document.createElement('div');
    el.id = 'tmw-auth-widget';
    el.style.cssText = 'position:fixed;top:11px;right:16px;z-index:99999;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11.5px';
    document.body.appendChild(el);
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
