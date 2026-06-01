/*
  Markets of Tomorrow — journal auth (Memberstack 2.0).

  One login across the MAP (map.oftmw.com) and the JOURNAL (www.oftmw.com): the
  same Memberstack app, so a member logged in on either side is logged in on
  both. This file makes the journal's auth chrome PIXEL-IDENTICAL to the map:

    • signed-out  → translucent "Join" pill   (.v2-profile-btn, no .signed-in)
    • signed-in   → circular person icon       (.v2-profile-btn.signed-in)
    • Pro member  → person icon + gold ★ badge  (+ .is-pro)
    • free member → gold "GO PRO" chip beside the icon
    • Login / Signup / Profile modals          → dark TMW theme (.tmw-ms-modal)

  The profile-button CSS and the Memberstack modal dark theme are lifted
  verbatim from the map (root index.html) and re-scoped under .tmw-auth so the
  two surfaces stay in lockstep.

  Include once per journal page:
      <script src="/_shared/journal-auth.js" defer></script>
*/
(function () {
  'use strict';
  var MS_APP = 'app_cmoq79nvv002d0syef7wpel3c';   // same app as the map
  var MAP_URL = 'https://map.oftmw.com';

  // ── 1) Load Memberstack once (shared across journal pages) ──────────────
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

  // ── 2) Memberstack modal dark theme ─────────────────────────────────────
  //    Memberstack v2's modal DOM uses container names that aren't documented
  //    and change between versions, so we run a MutationObserver that tags any
  //    body-attached fixed overlay that looks like a Memberstack modal with a
  //    stable hook (.tmw-ms-modal) + per-element classes the CSS below targets.
  //    Lifted verbatim from the map so the Login / Signup / Profile modals look
  //    identical on both surfaces.
  (function tagMemberstackModals() {
    function looksLikeMSModal(el) {
      if (!el || el.nodeType !== 1) return false;
      try {
        var cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
      } catch (_) { return false; }
      if (el.querySelector && (
          el.querySelector('[data-ms-modal]') ||
          el.querySelector('[data-cy]') ||
          el.querySelector('[data-ms-form]') ||
          (el.id && el.id.toLowerCase().indexOf('ms') === 0)
      )) return true;
      var hasEmail = el.querySelector && el.querySelector('input[type="email"]');
      var hasPwd   = el.querySelector && el.querySelector('input[type="password"]');
      if (hasEmail || hasPwd) return true;
      return false;
    }
    function tagContainerAndChildren(el) {
      if (!el || !el.classList) return;
      if (!el.classList.contains('tmw-ms-modal')) el.classList.add('tmw-ms-modal');
      try {
        el.querySelectorAll('input, textarea, select').forEach(function (node) {
          node.classList.add('tmw-ms-input');
        });
        el.querySelectorAll('button').forEach(function (node) {
          var isSubmit = node.getAttribute('type') === 'submit';
          var dataCy   = (node.getAttribute('data-cy') || '').toLowerCase();
          var ariaLbl  = (node.getAttribute('aria-label') || '').toLowerCase();
          var txt      = (node.textContent || '').trim().toLowerCase();
          if (isSubmit
              || dataCy.indexOf('save') !== -1
              || dataCy.indexOf('submit') !== -1
              || /^(save|sign in|sign up|log in|create account|continue)$/i.test(txt)) {
            node.classList.add('tmw-ms-btn-primary');
          } else if (ariaLbl.indexOf('close') !== -1 || dataCy.indexOf('close') !== -1) {
            node.classList.add('tmw-ms-btn-close');
          } else if (ariaLbl.indexOf('password') !== -1) {
            node.classList.add('tmw-ms-btn-eye');
          } else {
            node.classList.add('tmw-ms-btn-secondary');
          }
        });
        el.querySelectorAll('label').forEach(function (node) { node.classList.add('tmw-ms-label'); });
        el.querySelectorAll('img').forEach(function (node) { node.classList.add('tmw-ms-img'); });
      } catch (_) {}
    }
    function scan() {
      var nodes = document.body ? document.body.children : [];
      for (var i = 0; i < nodes.length; i++) {
        if (looksLikeMSModal(nodes[i])) tagContainerAndChildren(nodes[i]);
      }
    }
    if (document.body) scan();
    else document.addEventListener('DOMContentLoaded', scan);
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.parentNode === document.body && looksLikeMSModal(node)) {
            tagContainerAndChildren(node);
            continue;
          }
          var modalAncestor = node.closest && node.closest('.tmw-ms-modal');
          if (modalAncestor) tagContainerAndChildren(modalAncestor);
        }
      }
    });
    function startObserver() {
      if (document.body) obs.observe(document.body, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', startObserver);
    }
    startObserver();
  })();

  // ── 3) Styles ───────────────────────────────────────────────────────────
  // (a) Memberstack modal dark theme — verbatim from the map (.tmw-ms-modal).
  if (!document.getElementById('tmw-ms-theme')) {
    var modalCss = [
      '.tmw-ms-modal,#msOverlay,body>div[id^="ms-"]{background:rgba(0,0,0,0.78)!important;backdrop-filter:blur(8px)!important;-webkit-backdrop-filter:blur(8px)!important}',
      '.tmw-ms-modal>div,.tmw-ms-modal [role="dialog"],#msOverlay>div{background:#0f0f0f!important;color:#fff!important;border:1px solid rgba(255,255,255,0.08)!important;border-radius:16px!important;box-shadow:0 30px 90px rgba(0,0,0,0.55)!important}',
      '.tmw-ms-modal img,#msOverlay img{filter:brightness(0) invert(1)!important;opacity:0.95!important}',
      '.tmw-ms-modal,.tmw-ms-modal *,#msOverlay,#msOverlay *{color:#fff!important;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif!important}',
      '.tmw-ms-modal h1,.tmw-ms-modal h2,.tmw-ms-modal h3,#msOverlay h1,#msOverlay h2,#msOverlay h3{color:#fff!important;letter-spacing:-0.01em!important}',
      '.tmw-ms-modal p,.tmw-ms-modal small,#msOverlay p,#msOverlay small{color:rgba(255,255,255,0.7)!important}',
      '.tmw-ms-modal label,#msOverlay label{color:#fff!important;font-weight:600!important;font-size:13px!important}',
      '.tmw-ms-modal input,.tmw-ms-modal textarea,.tmw-ms-modal select,#msOverlay input,#msOverlay textarea,#msOverlay select{background:rgba(255,255,255,0.05)!important;border:1px solid rgba(255,255,255,0.14)!important;color:#fff!important;border-radius:10px!important;padding:12px 14px!important;font-size:14px!important;box-shadow:none!important;transition:border-color 0.15s,background 0.15s,box-shadow 0.15s!important}',
      '.tmw-ms-modal input:focus,.tmw-ms-modal textarea:focus,#msOverlay input:focus,#msOverlay textarea:focus{outline:none!important;border-color:#1FDF67!important;background:rgba(255,255,255,0.07)!important;box-shadow:0 0 0 3px rgba(31,223,103,0.20)!important}',
      '.tmw-ms-modal input::placeholder,#msOverlay input::placeholder{color:rgba(255,255,255,0.35)!important;opacity:1!important}',
      '.tmw-ms-modal input[disabled],.tmw-ms-modal input[readonly]{color:rgba(255,255,255,0.6)!important;background:rgba(255,255,255,0.03)!important}',
      '.tmw-ms-modal button[aria-label*="assword"],.tmw-ms-modal button[aria-label*="show" i],.tmw-ms-modal button[aria-label*="hide" i],.tmw-ms-modal [class*="eye" i]{background:transparent!important;border:none!important;color:rgba(255,255,255,0.55)!important;box-shadow:none!important;outline:none!important}',
      '.tmw-ms-modal button[aria-label*="assword"]:focus{outline:none!important;box-shadow:0 0 0 2px rgba(31,223,103,0.5)!important;border-radius:6px!important}',
      '.tmw-ms-modal button[type="submit"],.tmw-ms-modal button[class*="primary" i],.tmw-ms-modal [data-cy*="save"],.tmw-ms-modal [data-cy*="submit"],#msOverlay button[type="submit"]{background:#1FDF67!important;color:#000!important;border:none!important;border-radius:10px!important;font-weight:700!important;padding:13px 18px!important;cursor:pointer!important;transition:background 0.15s!important}',
      '.tmw-ms-modal button[type="submit"]:hover,.tmw-ms-modal button[class*="primary" i]:hover,#msOverlay button[type="submit"]:hover{background:#18c75a!important}',
      '.tmw-ms-modal [data-cy="save-btn"],.tmw-ms-modal [data-cy="save"]{background:#1FDF67!important;color:#000!important}',
      '.tmw-ms-modal button:not([type="submit"]):not([class*="primary" i]):not([aria-label*="lose" i]):not([aria-label*="assword" i]):not([aria-label*="show" i]):not([aria-label*="hide" i]):not([data-cy*="save"]){background:rgba(255,255,255,0.06)!important;color:#fff!important;border:1px solid rgba(255,255,255,0.10)!important;border-radius:10px!important;cursor:pointer!important}',
      '.tmw-ms-modal a,#msOverlay a{color:#1FDF67!important;text-decoration:none!important;font-weight:600!important}',
      '.tmw-ms-modal a:hover{text-decoration:underline!important}',
      '.tmw-ms-modal button[aria-label*="lose" i],.tmw-ms-modal [class*="close" i]:not(button[class*="primary" i]),.tmw-ms-modal [data-cy*="close"]{color:rgba(255,255,255,0.5)!important;background:transparent!important;border:none!important;box-shadow:none!important}',
      '.tmw-ms-modal button[aria-label*="lose" i]:hover{color:#fff!important}',
      '.tmw-ms-modal nav button,.tmw-ms-modal [class*="sidebar" i] button,.tmw-ms-modal [class*="tabs" i] button,.tmw-ms-modal [data-cy*="tab"]{color:#fff!important;background:transparent!important;border:none!important;text-align:left!important}',
      '.tmw-ms-modal nav button[aria-current="true"],.tmw-ms-modal nav button.active,.tmw-ms-modal [aria-current="page"],.tmw-ms-modal [data-cy*="tab"][aria-current="true"]{background:rgba(31,223,103,0.10)!important;color:#1FDF67!important;border-radius:8px!important}',
      '.tmw-ms-modal [data-cy*="logout"],.tmw-ms-modal button[aria-label*="ogout" i]{color:rgba(255,255,255,0.7)!important;background:transparent!important;border:none!important}',
      '.tmw-ms-modal hr{border:none!important;border-top:1px solid rgba(255,255,255,0.08)!important;margin:16px 0!important}',
      '.tmw-ms-modal [class*="error" i],.tmw-ms-modal [role="alert"]{color:#FF6B6B!important;background:rgba(255,107,107,0.10)!important;border:1px solid rgba(255,107,107,0.25)!important;border-radius:8px!important;padding:10px 12px!important}',
      '.tmw-ms-input{background:#1a1a1a!important;border:1px solid rgba(255,255,255,0.14)!important;color:#fff!important;border-radius:10px!important;padding:12px 14px!important;font-size:14px!important;box-shadow:none!important;caret-color:#1FDF67!important;transition:border-color 0.15s,background 0.15s,box-shadow 0.15s!important}',
      '.tmw-ms-input:focus{outline:none!important;border-color:#1FDF67!important;background:#1f1f1f!important;box-shadow:0 0 0 3px rgba(31,223,103,0.22)!important}',
      '.tmw-ms-input::placeholder{color:rgba(255,255,255,0.35)!important;opacity:1!important}',
      '.tmw-ms-input[disabled],.tmw-ms-input[readonly]{color:rgba(255,255,255,0.55)!important;background:#141414!important}',
      '.tmw-ms-input:-webkit-autofill,.tmw-ms-input:-webkit-autofill:hover,.tmw-ms-input:-webkit-autofill:focus{-webkit-text-fill-color:#fff!important;-webkit-box-shadow:0 0 0 1000px #1a1a1a inset!important;transition:background-color 9999s ease-in-out 0s!important}',
      '.tmw-ms-btn-primary{background:#1FDF67!important;color:#000!important;border:none!important;border-radius:10px!important;font-weight:700!important;padding:13px 18px!important;cursor:pointer!important;transition:background 0.15s!important}',
      '.tmw-ms-btn-primary:hover{background:#18c75a!important}',
      '.tmw-ms-btn-primary:disabled,.tmw-ms-btn-primary[disabled]{background:rgba(31,223,103,0.35)!important;color:rgba(0,0,0,0.55)!important;cursor:default!important}',
      '.tmw-ms-btn-secondary{background:#1a1a1a!important;color:#fff!important;border:1px solid rgba(255,255,255,0.15)!important;border-radius:10px!important;padding:10px 14px!important;font-weight:600!important;font-size:13px!important;cursor:pointer!important;transition:background 0.15s,border-color 0.15s!important}',
      '.tmw-ms-btn-secondary:hover{background:#222!important;border-color:rgba(255,255,255,0.25)!important}',
      '.tmw-ms-btn-close{color:rgba(255,255,255,0.55)!important;background:transparent!important;border:none!important;box-shadow:none!important;padding:6px!important;cursor:pointer!important}',
      '.tmw-ms-btn-close:hover{color:#fff!important}',
      '.tmw-ms-btn-eye{background:transparent!important;border:none!important;color:rgba(255,255,255,0.55)!important;box-shadow:none!important;outline:none!important;padding:4px!important;cursor:pointer!important}',
      '.tmw-ms-btn-eye:focus{outline:none!important;box-shadow:0 0 0 2px rgba(31,223,103,0.5)!important;border-radius:6px!important}',
      '.tmw-ms-label{color:#fff!important;font-weight:600!important;font-size:13px!important}',
      '.tmw-ms-img{filter:brightness(0) invert(1)!important;opacity:0.95!important}'
    ].join('');
    var mt = document.createElement('style'); mt.id = 'tmw-ms-theme'; mt.textContent = modalCss; document.head.appendChild(mt);
  }

  // (b) Profile button + menu — verbatim from the map, re-scoped under .tmw-auth.
  if (!document.getElementById('tmw-auth-styles')) {
    var css = [
      '.tmw-auth{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif}',
      '.tmw-auth .tmw-auth-ig{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;margin-right:8px;color:rgba(255,255,255,0.72);text-decoration:none;transition:color .15s}',
      '.tmw-auth .tmw-auth-ig svg{width:18px;height:18px}',
      '.tmw-auth .tmw-auth-ig:hover{color:#fff}',
      '.tmw-auth .v2-profile-btn{width:30px;height:30px;border-radius:50%;background:transparent;border:none;position:relative;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;color:#fff;padding:0;transition:width .15s,border-radius .15s,background .15s,padding .15s}',
      '.tmw-auth .v2-profile-btn svg.profile-icon{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '.tmw-auth .v2-profile-btn .v2-premium-star{position:absolute;bottom:-3px;right:-3px;width:14px;height:14px;background:#FFD300;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid rgba(15,15,15,0.85)}',
      '.tmw-auth .v2-profile-btn .v2-premium-star svg{width:8px;height:8px;fill:#0a0a0a}',
      '.tmw-auth .v2-profile-btn .v2-login-text{display:none;font-size:12px;font-weight:700;white-space:nowrap;letter-spacing:.01em}',
      '.tmw-auth .v2-profile-btn:not(.signed-in){width:auto;padding:0 11px;height:30px;border-radius:20px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.18)}',
      '.tmw-auth .v2-profile-btn:not(.signed-in) .v2-login-text{display:inline}',
      '.tmw-auth .v2-profile-btn:not(.signed-in) svg.profile-icon{display:none}',
      '.tmw-auth .v2-profile-btn:not(.signed-in) .v2-premium-star{display:none!important}',
      '.tmw-auth .v2-profile-btn.signed-in .v2-login-text{display:none}',
      '.tmw-auth .v2-profile-btn:not(.is-pro) .v2-premium-star{display:none!important}',
      '.tmw-auth .v2-go-pro-badge{display:none;align-items:center;height:26px;padding:0 10px;margin-left:6px;background:#FFD300;color:#0a0a0a;border:none;border-radius:999px;font-family:inherit;font-size:10.5px;font-weight:800;letter-spacing:.06em;cursor:pointer;flex-shrink:0;transition:filter .15s,box-shadow .15s;box-shadow:0 0 0 1px rgba(255,211,0,0.4) inset,0 0 10px rgba(255,211,0,0.3)}',
      '.tmw-auth .v2-go-pro-badge:hover{filter:brightness(1.08);box-shadow:0 0 0 1px rgba(255,211,0,0.6) inset,0 0 14px rgba(255,211,0,0.4)}',
      '.tmw-auth:has(.v2-profile-btn.signed-in:not(.is-pro)) .v2-go-pro-badge{display:inline-flex}',
      '.tmw-auth .v2-profile-menu{position:absolute;top:calc(100% + 8px);right:0;left:auto;min-width:220px;background:rgba(20,20,20,0.96);backdrop-filter:blur(28px) saturate(1.4);-webkit-backdrop-filter:blur(28px) saturate(1.4);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:6px;box-shadow:0 16px 40px rgba(0,0,0,0.5);display:none;z-index:10000}',
      '.tmw-auth .v2-profile-menu.open{display:block}',
      '.tmw-auth .v2-profile-menu .v2-menu-item{display:flex;align-items:center;gap:12px;padding:10px 12px;color:rgba(255,255,255,0.85);font-size:14px;font-weight:500;cursor:pointer;border-radius:8px;background:transparent;border:none;width:100%;text-align:left;font-family:inherit;text-decoration:none}',
      '.tmw-auth .v2-profile-menu .v2-menu-item:hover{background:rgba(255,255,255,0.06);color:#fff}',
      '.tmw-auth .v2-profile-menu .v2-menu-item svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;opacity:.7}',
      '.tmw-auth .v2-profile-menu .v2-menu-divider{height:1px;background:rgba(255,255,255,0.08);margin:6px 4px}',
      '.tmw-auth .v2-profile-menu .v2-menu-signout{color:rgba(255,120,120,0.9)}',
      '.tmw-auth .v2-profile-menu .v2-menu-signout:hover{background:rgba(255,80,80,0.08);color:#ff6464}',
      '.tmw-auth .v2-menu-label{flex:0 1 auto}'
    ].join('');
    var st = document.createElement('style'); st.id = 'tmw-auth-styles'; st.textContent = css; document.head.appendChild(st);
  }

  // ── 4) Helpers ──────────────────────────────────────────────────────────
  function isPaid(member) {
    var plans = (member && member.planConnections) || [];
    return plans.some(function (p) { return p.active === true || p.status === 'ACTIVE'; });
  }

  // Person icon (signed-in) + gold star (Pro) + "Join" pill (signed-out): one
  // button, state driven by .signed-in / .is-pro — exactly like the map.
  var PROFILE_ICON = '<svg class="profile-icon" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>';
  var STAR_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2l3 6.3 6.9 1-5 4.9 1.2 7L12 17.8 5.9 21.2l1.2-7-5-4.9L9 8.3z"/></svg>';

  var IG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4.5"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/></svg>';

  function buildUI(host) {
    host.innerHTML =
      '<a class="tmw-auth-ig" href="https://www.instagram.com/floridaoftomorrow" target="_blank" rel="noopener" aria-label="Instagram">' + IG_ICON + '</a>' +
      '<button class="v2-profile-btn" type="button" aria-label="Join">' +
        '<span class="v2-login-text">Join</span>' + PROFILE_ICON +
        '<span class="v2-premium-star">' + STAR_ICON + '</span>' +
      '</button>' +
      '<button class="v2-go-pro-badge" type="button" aria-label="Upgrade to TMW Pro">GO PRO</button>' +
      '<div class="v2-profile-menu" role="menu">' +
        '<button class="v2-menu-item" data-act="account" role="menuitem"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>Account</button>' +
        '<a class="v2-menu-item" data-act="map" href="' + MAP_URL + '" role="menuitem"><svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg><span class="v2-menu-label">Open the Map</span></a>' +
        '<div class="v2-menu-divider"></div>' +
        '<button class="v2-menu-item v2-menu-signout" data-act="signout" role="menuitem"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>Sign out</button>' +
      '</div>';

    var btn = host.querySelector('.v2-profile-btn');
    var menu = host.querySelector('.v2-profile-menu');
    var goPro = host.querySelector('.v2-go-pro-badge');

    function ms() { return window.$memberstackDom; }

    // Repaint the button from the current auth state.
    function applyState(member) {
      var signedIn = !!member;
      btn.classList.toggle('signed-in', signedIn);
      btn.classList.toggle('is-pro', signedIn && isPaid(member));
      btn.setAttribute('aria-label', signedIn ? 'Profile menu' : 'Join');
      if (!signedIn) menu.classList.remove('open');
    }
    // Re-fetch the member and repaint (after login / plan change).
    function refresh() {
      try { var m = ms(); if (m) m.getCurrentMember().then(function (r) { applyState(r && r.data); }); } catch (_) {}
    }

    // Signed out → open the Memberstack modal (Join = signup, with a "log in"
    // link inside). openModal() resolves on success but does NOT close itself,
    // so we hideModal() + repaint once it resolves. Signed in → toggle menu.
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.classList.contains('signed-in')) { menu.classList.toggle('open'); return; }
      try {
        var m = ms();
        if (m) m.openModal('SIGNUP').then(function () {
          try { m.hideModal(); } catch (_) {}
          refresh();
        }).catch(function () { try { m.hideModal(); } catch (_) {} });
      } catch (_) {}
    });
    goPro.addEventListener('click', function (e) {
      e.stopPropagation(); e.preventDefault();
      location.href = MAP_URL + '/?upgrade=1';
    });
    host.querySelector('[data-act="account"]').addEventListener('click', function (e) {
      e.stopPropagation(); menu.classList.remove('open');
      try {
        var m = ms();
        if (m) m.openModal('PROFILE').then(function () { try { m.hideModal(); } catch (_) {} refresh(); }).catch(function () {});
      } catch (_) {}
    });
    host.querySelector('[data-act="map"]').addEventListener('click', function () { menu.classList.remove('open'); });
    host.querySelector('[data-act="signout"]').addEventListener('click', function (e) {
      e.stopPropagation(); menu.classList.remove('open');
      try {
        var m = ms();
        if (m && m.logout) { m.logout().then(function () { location.reload(); }).catch(function () { location.reload(); }); return; }
      } catch (_) {}
      location.reload();
    });

    return { apply: applyState, refresh: refresh };
  }

  // Close the menu on any outside click.
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.tmw-auth')) {
      var m = document.querySelector('.tmw-auth .v2-profile-menu.open');
      if (m) m.classList.remove('open');
    }
  });

  // ── 5) Mount ────────────────────────────────────────────────────────────
  // An explicit [data-tmw-auth] slot, else right after the header's "Open Map"
  // / CTA button. We deliberately anchor to the HEADER CTA only — never a
  // page-wide `a[href*="instagram.com"]`, which would match Instagram links
  // inside article bodies and mount the avatar in the wrong place.
  function findMount() {
    var existing = document.querySelector('[data-tmw-auth]'); if (existing) return existing;
    var anchor = document.getElementById('nav-map-cta')
      || document.querySelector('.tmw-chrome-head .nav-cta, nav.main .nav-cta, header .nav-cta, .nav-cta');
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
    var tries = 0;
    (function place() {
      var host = findMount();
      if (!host) { if (++tries < 40) return setTimeout(place, 100); return; }
      var refs = buildUI(host);        // render immediately in signed-out state
      whenMs(function () {
        var ms = window.$memberstackDom;
        ms.getCurrentMember().then(function (r) { refs.apply(r && r.data); }).catch(function () { refs.apply(null); });
        if (typeof ms.onAuthChange === 'function') {
          ms.onAuthChange(function () {
            setTimeout(function () {
              try { ms.getCurrentMember().then(function (r) { refs.apply(r && r.data); }); } catch (e) {}
            }, 0);
          });
        }
      });
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
