/*
  Markets of Tomorrow — journal auth (Memberstack 2.0).

  One login across the MAP (map.oftmw.com) and the JOURNAL (www.oftmw.com): the
  same Memberstack app, so a member logged in on either side is logged in on
  both. Drops a profile avatar (initials, + gold ★ for Pro) into the header,
  right of the "Open Map" / Instagram control, with a small account menu.

  Include once per journal page:
      <script src="/_shared/journal-auth.js" defer></script>

  ⚠️ Requires (one-time, in the Memberstack dashboard): add `www.oftmw.com` as
  an allowed domain, and set the auth cookie domain to `.oftmw.com` so the
  session is shared with map.oftmw.com (true SSO).
*/
(function () {
  'use strict';
  var MS_APP = 'app_cmoq79nvv002d0syef7wpel3c';   // same app as the map
  var MAP_URL = 'https://map.oftmw.com';

  // 1) Load Memberstack once (shared across journal pages).
  //    Cross-subdomain SSO: store the session in a cookie on the ROOT domain
  //    (.oftmw.com) instead of localStorage, so a login on map.oftmw.com is the
  //    same session as www.oftmw.com (and vice-versa). Must be set BEFORE the
  //    Memberstack script loads, on every site sharing the app.
  try { window.memberstackConfig = window.memberstackConfig || { useCookies: true, setCookieOnRootDomain: true }; } catch (e) {}
  if (!document.querySelector('script[data-memberstack-app]')) {
    var s = document.createElement('script');
    s.setAttribute('data-memberstack-app', MS_APP);
    s.src = 'https://static.memberstack.com/scripts/v2/memberstack.js';
    s.type = 'text/javascript';
    document.head.appendChild(s);
  }

  // 2) Styles (scoped under .tmw-auth).
  if (!document.getElementById('tmw-auth-styles')) {
    var css = [
      '.tmw-auth{position:relative;display:inline-flex;align-items:center;flex:0 0 auto}',
      '.tmw-auth-login{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;color:#ECEAE5;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:9px 16px;cursor:pointer;transition:all .2s}',
      '.tmw-auth-login:hover{border-color:#1FDF67;color:#fff}',
      '.tmw-auth-avatar{position:relative;width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#1FDF67 0%,#18a04a 100%);border:1.5px solid rgba(255,255,255,.15);color:#06210f;font-weight:700;font-size:12.5px;font-family:"JetBrains Mono",ui-monospace,monospace;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .1s,box-shadow .15s;padding:0}',
      '.tmw-auth-avatar:hover{transform:scale(1.05);box-shadow:0 4px 14px rgba(31,223,103,.3)}',
      '.tmw-auth-star{position:absolute;bottom:-2px;right:-3px;width:15px;height:15px;background:#FFD300;color:#000;border:1.5px solid #0c0e0c;border-radius:50%;font-size:9px;line-height:12px;text-align:center;font-weight:700}',
      '.tmw-auth-menu{position:absolute;top:calc(100% + 10px);right:0;min-width:210px;background:rgba(16,18,16,.97);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.6);padding:7px;display:none;z-index:10000}',
      '.tmw-auth-menu.open{display:block}',
      '.tmw-auth-menu a,.tmw-auth-menu button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;color:#ECEAE5;font-family:"Inter",-apple-system,sans-serif;font-size:13.5px;font-weight:500;padding:10px 11px;border-radius:9px;cursor:pointer;text-decoration:none;transition:background .12s}',
      '.tmw-auth-menu a:hover,.tmw-auth-menu button:hover{background:rgba(255,255,255,.06);color:#fff}',
      '.tmw-auth-menu .tmw-auth-signout{color:#ff8a8a}.tmw-auth-menu .tmw-auth-signout:hover{background:rgba(255,93,93,.12)}',
      '.tmw-auth-pro{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:8.5px;letter-spacing:.1em;color:#0c0e0c;background:#FFD300;border-radius:5px;padding:2px 6px;font-weight:800}',
      '.tmw-auth-up{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:8.5px;letter-spacing:.1em;color:#2a1f06;background:#e6c574;border-radius:5px;padding:2px 6px;font-weight:800}',
      '.tmw-auth-sep{height:1px;background:rgba(255,255,255,.08);margin:5px 4px}'
    ].join('');
    var st = document.createElement('style'); st.id = 'tmw-auth-styles'; st.textContent = css; document.head.appendChild(st);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function getInitials(member) {
    var cf = member.customFields || {};
    var first = cf['first-name'] || cf.firstName || '';
    var last = cf['last-name'] || cf.lastName || '';
    var email = (member.auth && member.auth.email) || member.email || '';
    var ini = ((first.charAt(0) || '') + (last.charAt(0) || '')).toUpperCase();
    if (ini) return ini;
    var lp = (email.split('@')[0] || 'M').replace(/[^a-zA-Z]/g, '');
    return ((lp.charAt(0) || 'M') + (lp.charAt(1) || '')).toUpperCase();
  }
  function isPaid(member) {
    var plans = (member && member.planConnections) || [];
    return plans.some(function (p) { return p.active === true || p.status === 'ACTIVE'; });
  }

  function render(host, member) {
    var ms = window.$memberstackDom;
    if (member) {
      var paid = isPaid(member);
      host.innerHTML =
        '<button class="tmw-auth-avatar" aria-label="Account menu"><span>' + esc(getInitials(member)) + '</span>' +
        (paid ? '<span class="tmw-auth-star" title="Pro member">&#9733;</span>' : '') + '</button>' +
        '<div class="tmw-auth-menu" role="menu">' +
          '<button data-act="account">Account' + (paid ? '<span class="tmw-auth-pro">PRO</span>' : '') + '</button>' +
          '<a href="' + MAP_URL + '" data-act="map">Open the Map</a>' +
          (paid ? '' : '<button data-act="upgrade">Go Pro<span class="tmw-auth-up">UPGRADE</span></button>') +
          '<div class="tmw-auth-sep"></div>' +
          '<button class="tmw-auth-signout" data-act="signout">Sign out</button>' +
        '</div>';
      var btn = host.querySelector('.tmw-auth-avatar'), menu = host.querySelector('.tmw-auth-menu');
      btn.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('open'); });
      host.querySelector('[data-act="account"]').addEventListener('click', function () { menu.classList.remove('open'); try { ms.openModal('PROFILE'); } catch (e) {} });
      var up = host.querySelector('[data-act="upgrade"]'); if (up) up.addEventListener('click', function () { menu.classList.remove('open'); location.href = MAP_URL + '/?upgrade=1'; });
      host.querySelector('[data-act="signout"]').addEventListener('click', function () { menu.classList.remove('open'); try { ms.logout().then(function () { location.reload(); }); } catch (e) {} });
    } else {
      host.innerHTML = '<button class="tmw-auth-login">Log in</button>';
      host.querySelector('.tmw-auth-login').addEventListener('click', function () { try { ms.openModal('LOGIN'); } catch (e) {} });
    }
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.tmw-auth')) { var m = document.querySelector('.tmw-auth-menu.open'); if (m) m.classList.remove('open'); }
  });

  // Mount: an explicit [data-tmw-auth] slot, else right after the Instagram
  // link / "Open Map" CTA in the header.
  function findMount() {
    var m = document.querySelector('[data-tmw-auth]'); if (m) return m;
    var anchor = document.querySelector('header a[href*="instagram.com"], .tmw-chrome-head a[href*="instagram.com"], a[href*="instagram.com"]')
      || document.getElementById('nav-map-cta') || document.querySelector('.nav-cta');
    if (!anchor || !anchor.parentNode) return null;
    var host = document.createElement('div'); host.className = 'tmw-auth'; host.setAttribute('data-tmw-auth', '');
    anchor.parentNode.insertBefore(host, anchor.nextSibling);
    return host;
  }

  function whenMs(cb) {
    if (window.$memberstackDom) return cb();
    var n = 0, t = setInterval(function () { if (window.$memberstackDom || ++n > 80) { clearInterval(t); if (window.$memberstackDom) cb(); } }, 100);
  }

  function init() {
    // The header may be injected by journal-chrome.js; retry briefly for the anchor.
    var tries = 0;
    (function place() {
      var host = findMount();
      if (!host) { if (++tries < 40) return setTimeout(place, 100); return; }
      whenMs(function () {
        var ms = window.$memberstackDom;
        ms.getCurrentMember().then(function (r) { render(host, r && r.data); }).catch(function () { render(host, null); });
        if (typeof ms.onAuthChange === 'function') {
          ms.onAuthChange(function (member) { setTimeout(function () { try { ms.getCurrentMember().then(function (r) { render(host, r && r.data); }); } catch (e) {} }, 0); });
        }
      });
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
