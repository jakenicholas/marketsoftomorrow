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

  // ── 1b) Free-account upgrade for newsletter subscribers ─────────────────
  //    When a logged-out visitor subscribes to the newsletter, we offer to
  //    turn that email into a free Memberstack account — they only add a
  //    password. Cross-domain SSO means the account works on the map too, and
  //    journal-auth's onAuthChange listener repaints the header to signed-in.
  //    Used by the homepage newsletter strip and the article subscribe lightbox.
  window.tmwCreateFreeAccount = function (email, password) {
    var m = window.$memberstackDom;
    if (!m || typeof m.signupMemberEmailPassword !== 'function') {
      return Promise.resolve({ ok: false, code: 'not-ready', message: 'Accounts are still loading — please try again in a moment.' });
    }
    return m.signupMemberEmailPassword({ email: email, password: password })
      .then(function (res) { return { ok: true, member: res && res.data }; })
      .catch(function (e) {
        var message = (e && e.message) || 'Could not create your account.';
        var code = (e && (e.code || e.statusCode)) || '';
        if (/exist|already|registered|taken|in use/i.test(message)) { code = 'exists'; }
        return { ok: false, code: code, message: message };
      });
  };

  var FA_CSS = false;
  function injectFaCss() {
    if (FA_CSS || document.getElementById('tmw-fa-css')) return; FA_CSS = true;
    var st = document.createElement('style'); st.id = 'tmw-fa-css';
    st.textContent = [
      '.tmw-fa{text-align:left}',
      '.tmw-fa-h{font-family:var(--sans,"Inter",sans-serif); font-size:15px; font-weight:600; color:#fff; line-height:1.3; margin-bottom:5px}',
      '.tmw-fa-sub{font-family:var(--sans,"Inter",sans-serif); font-size:12px; color:rgba(255,255,255,.55); line-height:1.45; margin-bottom:13px}',
      '.tmw-fa-form{display:flex; gap:8px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.16); border-radius:999px; padding:6px 6px 6px 18px; transition:border-color .2s}',
      '.tmw-fa-form:focus-within{border-color:#1FDF67}',
      '.tmw-fa-form input{flex:1; min-width:0; border:0; outline:0; background:transparent; color:#fff; font-family:var(--sans,"Inter",sans-serif); font-size:14px}',
      '.tmw-fa-form input::placeholder{color:rgba(255,255,255,.4)}',
      '.tmw-fa-form button{flex:0 0 auto; border:0; border-radius:999px; background:#1FDF67; color:#04210f; font-family:var(--mono,monospace); font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; padding:11px 16px; cursor:pointer; white-space:nowrap; transition:background .2s}',
      '.tmw-fa-form button:hover{background:#42eb81}',
      '.tmw-fa-form button:disabled{opacity:.6; cursor:wait}',
      '.tmw-fa-msg{font-family:var(--sans,"Inter",sans-serif); font-size:12px; line-height:1.4; margin-top:10px}',
      '.tmw-fa-msg.err{color:#ff9b9b} .tmw-fa-msg.ok{color:#42eb81}',
      '.tmw-fa-msg a{color:#42eb81; font-weight:600; text-decoration:none}',
      '.tmw-fa-skip{margin-top:11px; background:none; border:0; color:rgba(255,255,255,.45); font-family:var(--sans,"Inter",sans-serif); font-size:11.5px; cursor:pointer; padding:0; text-decoration:underline}',
      '.tmw-fa-skip:hover{color:#fff}',
      // Third step — profile fields (stacked inputs)
      '.tmw-fa-prof{display:flex; flex-direction:column; gap:9px}',
      '.tmw-fa-row{display:flex; gap:9px}',
      '.tmw-fa-row > *{flex:1; min-width:0}',
      // box-sizing + fixed height + no flex-shrink → every field is the same height
      '.tmw-fa-prof input{box-sizing:border-box; width:100%; height:46px; flex-shrink:0; padding:0 14px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.16); border-radius:10px; color:#fff; font-family:var(--sans,"Inter",sans-serif); font-size:14px; line-height:normal; outline:none; transition:border-color .15s}',
      '.tmw-fa-prof input:focus{border-color:#1FDF67}',
      '.tmw-fa-prof input::placeholder{color:rgba(255,255,255,.4)}',
      '.tmw-fa-prof button{box-sizing:border-box; width:100%; height:46px; flex-shrink:0; margin-top:3px; border:0; border-radius:10px; background:#1FDF67; color:#04210f; font-family:var(--mono,monospace); font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; transition:background .2s}',
      '.tmw-fa-prof button:hover{background:#42eb81}',
      '.tmw-fa-prof button:disabled{opacity:.6; cursor:wait}',
      // "Based" — Mapbox place autocomplete dropdown
      '.tmw-fa-geo{position:relative}',
      '.tmw-fa-geo-list{position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:6; background:#16181a; border:1px solid rgba(255,255,255,.16); border-radius:10px; overflow:hidden; box-shadow:0 16px 40px rgba(0,0,0,.55); max-height:210px; overflow-y:auto}',
      '.tmw-fa-geo-list[hidden]{display:none}',
      '.tmw-fa-geo-item{padding:10px 14px; font-family:var(--sans,"Inter",sans-serif); font-size:13px; color:#e8e8e8; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.06)}',
      '.tmw-fa-geo-item:last-child{border-bottom:0}',
      '.tmw-fa-geo-item:hover{background:rgba(31,223,103,.12); color:#fff}'
    ].join('');
    document.head.appendChild(st);
  }

  // Render the "add a password for a free account" step into `host`. Returns
  // false (does nothing) if the visitor is already signed in. onClose(created?)
  // fires when the user finishes or skips.
  window.tmwFreeAccountPrompt = function (host, email, onClose) {
    if (!host || window._tmwSignedIn) return false;
    injectFaCss();
    host.innerHTML =
      '<div class="tmw-fa">' +
        '<div class="tmw-fa-h">You’re subscribed — create your free account</div>' +
        '<div class="tmw-fa-sub">Your email’s already set. Add a password to follow projects, build a watchlist, and pick up where you left off — across the journal and the map.</div>' +
        '<form class="tmw-fa-form" novalidate>' +
          '<input type="password" name="pw" placeholder="Create a password" autocomplete="new-password" required>' +
          '<button type="submit">Create account</button>' +
        '</form>' +
        '<div class="tmw-fa-msg" aria-live="polite"></div>' +
        '<button class="tmw-fa-skip" type="button">No thanks</button>' +
      '</div>';
    var form = host.querySelector('.tmw-fa-form');
    var msg = host.querySelector('.tmw-fa-msg');
    var skip = host.querySelector('.tmw-fa-skip');
    function done(ok) { if (typeof onClose === 'function') onClose(!!ok); }
    skip.addEventListener('click', function () { done(false); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = (form.pw.value || '');
      if (pw.length < 8) { msg.className = 'tmw-fa-msg err'; msg.textContent = 'Use at least 8 characters.'; form.pw.focus(); return; }
      var btn = form.querySelector('button'); var orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Creating…'; msg.className = 'tmw-fa-msg'; msg.textContent = '';
      window.tmwCreateFreeAccount(email, pw).then(function (res) {
        if (res.ok) {
          try { if (window.gtag) window.gtag('event', 'free_account_created', { source: 'newsletter' }); } catch (_) {}
          // Step 3: collect profile info → Memberstack custom fields + the list.
          window.tmwProfileStep(host, email, onClose);
        } else if (res.code === 'exists') {
          msg.className = 'tmw-fa-msg err';
          msg.innerHTML = 'Looks like you already have an account. <a href="#" class="tmw-fa-si">Sign in →</a>';
          btn.disabled = false; btn.textContent = orig;
          var si = host.querySelector('.tmw-fa-si');
          if (si) si.addEventListener('click', function (ev) { ev.preventDefault(); var m = window.$memberstackDom; if (m && m.openModal) m.openModal('LOGIN').then(function () { try { m.hideModal(); } catch (_) {} }).catch(function () {}); });
        } else {
          msg.className = 'tmw-fa-msg err'; msg.textContent = res.message || 'Could not create your account.';
          btn.disabled = false; btn.textContent = orig;
        }
      });
    });
    return true;
  };

  // Step 3 of the funnel: a short profile form after the account is created.
  // Writes to Memberstack custom fields (first-name / last-name / profession /
  // company-name / based) and best-effort posts the same to the newsletter
  // worker so Resend gets them too.
  window.tmwProfileStep = function (host, email, onClose) {
    injectFaCss();
    host.innerHTML =
      '<div class="tmw-fa">' +
        '<div class="tmw-fa-h">✓ Account created — tell us about you</div>' +
        '<div class="tmw-fa-sub">A few details so we send you what actually matters. You can skip this.</div>' +
        '<form class="tmw-fa-prof" novalidate>' +
          '<div class="tmw-fa-row"><input name="first" placeholder="First name" autocomplete="given-name"><input name="last" placeholder="Last name" autocomplete="family-name"></div>' +
          '<div class="tmw-fa-row"><input name="profession" placeholder="Profession" autocomplete="organization-title"><input name="company" placeholder="Company" autocomplete="organization"></div>' +
          '<div class="tmw-fa-geo"><input name="based" placeholder="Based in (city)" autocomplete="off"><div class="tmw-fa-geo-list" hidden></div></div>' +
          '<button type="submit">Finish</button>' +
        '</form>' +
        '<div class="tmw-fa-msg" aria-live="polite"></div>' +
        '<button class="tmw-fa-skip" type="button">Skip for now</button>' +
      '</div>';
    var form = host.querySelector('.tmw-fa-prof');
    var msg = host.querySelector('.tmw-fa-msg');
    var skip = host.querySelector('.tmw-fa-skip');
    function finish() { if (typeof onClose === 'function') onClose(true); }
    skip.addEventListener('click', finish);

    // "Based" — live place suggestions via Mapbox geocoding (public token).
    (function () {
      var MAPBOX_TOKEN = 'pk.eyJ1IjoiZmxvcmlkYW9mdG9tb3Jyb3ciLCJhIjoiY2xrYmpmdGQ2MGdibTNzcXZjMnA4aXh3ZiJ9.uBeYS7jmKwWS6xAgY-R1UA';
      var inp = host.querySelector('input[name="based"]');
      var list = host.querySelector('.tmw-fa-geo-list');
      if (!inp || !list) return;
      var timer, hideT;
      function hide() { list.hidden = true; list.innerHTML = ''; }
      inp.addEventListener('input', function () {
        var q = inp.value.trim();
        clearTimeout(timer);
        if (q.length < 2) { hide(); return; }
        timer = setTimeout(function () {
          fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(q) +
                '.json?access_token=' + MAPBOX_TOKEN + '&autocomplete=true&types=place,region,district&limit=5')
            .then(function (r) { return r.json(); })
            .then(function (d) {
              var feats = (d && d.features) || [];
              if (!feats.length) { hide(); return; }
              list.innerHTML = '';
              feats.forEach(function (f) {
                var it = document.createElement('div');
                it.className = 'tmw-fa-geo-item';
                it.textContent = f.place_name || '';
                list.appendChild(it);
              });
              list.hidden = false;
            })
            .catch(hide);
        }, 250);
      });
      list.addEventListener('mousedown', function (e) {
        var it = e.target.closest && e.target.closest('.tmw-fa-geo-item');
        if (!it) return;
        e.preventDefault();
        inp.value = it.textContent;
        hide();
      });
      inp.addEventListener('blur', function () { clearTimeout(hideT); hideT = setTimeout(hide, 150); });
    })();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = function (n) { return (form[n] && form[n].value || '').trim(); };
      var data = { first: v('first'), last: v('last'), profession: v('profession'), company: v('company'), based: v('based') };
      var btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Saving…';
      var jobs = [];
      var m = window.$memberstackDom;
      if (m && m.updateMember) {
        jobs.push(m.updateMember({ customFields: {
          'first-name': data.first, 'last-name': data.last,
          'profession': data.profession, 'company-name': data.company, 'based': data.based
        } }).catch(function () {}));
      }
      // Resend, via the newsletter worker (best-effort — the worker must accept
      // these fields + update the contact for them to land in Resend).
      jobs.push(fetch('https://tmw-subscribe.jake-ab7.workers.dev', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, update: true, first_name: data.first, last_name: data.last, profession: data.profession, company_name: data.company, based: data.based })
      }).catch(function () {}));
      Promise.all(jobs).then(function () {
        try { if (window.gtag) window.gtag('event', 'profile_completed', { source: 'newsletter' }); } catch (_) {}
        form.style.display = 'none'; skip.style.display = 'none';
        msg.className = 'tmw-fa-msg ok'; msg.textContent = '✓ You’re all set. Welcome to Markets of Tomorrow.';
        setTimeout(finish, 1700);
      });
    });
  };

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
      // The subscribe lightbox is fixed + has an email input + role=dialog, but
      // it is NOT a Memberstack modal — tagging it applied the dark MS scrim
      // (rgba(0,0,0,.78)) full-width behind it. Never treat it as one.
      if (el.classList && el.classList.contains('tmw-sub')) return false;
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
      // Chrome autofill punches a white background through the dark theme (login
      // email/password, security password). Force it dark with the inset-shadow trick.
      '.tmw-ms-modal input:-webkit-autofill,.tmw-ms-modal input:-webkit-autofill:hover,.tmw-ms-modal input:-webkit-autofill:focus,.tmw-ms-modal input:-webkit-autofill:active,#msOverlay input:-webkit-autofill{-webkit-text-fill-color:#fff!important;-webkit-box-shadow:0 0 0 1000px #1a1a1a inset!important;box-shadow:0 0 0 1000px #1a1a1a inset!important;caret-color:#fff!important;border:1px solid rgba(255,255,255,0.14)!important;border-radius:10px!important;transition:background-color 9999s ease-in-out 0s!important}',
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
      '.tmw-auth{position:relative;display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif}',
      // IG icon — either the dock\'s .tmw-ig (moved in) or our own fallback — sized to sit level with the avatar.
      '.tmw-auth .tmw-auth-ig{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;color:rgba(255,255,255,0.72);text-decoration:none;transition:color .15s}',
      '.tmw-auth .tmw-auth-ig svg{width:20px;height:20px}',
      '.tmw-auth .tmw-auth-ig:hover{color:#fff}',
      '.tmw-auth .nav-cta.tmw-ig{width:34px;min-width:34px;height:34px;margin:0}',
      '.tmw-auth .nav-cta.tmw-ig svg{width:23px;height:23px}',
      /* Mobile: hide the Instagram icon entirely (desktop keeps it, left of the
         profile). Also shrink the GO PRO pill so the cluster doesn't crowd the
         centered TMW logo on narrow screens. */
      '@media(max-width:980px){.tmw-auth .nav-cta.tmw-ig, .tmw-auth-ig{display:none !important}}',
      '@media(max-width:980px){.tmw-auth .v2-go-pro-badge{height:21px;padding:0 7px;font-size:8.5px;letter-spacing:.04em;box-shadow:0 0 0 1px rgba(255,211,0,0.4) inset,0 0 7px rgba(255,211,0,0.3)}}',
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
      '.tmw-auth .v2-go-pro-badge{display:none;align-items:center;height:26px;padding:0 10px;margin-left:0;background:#FFD300;color:#0a0a0a;border:none;border-radius:999px;font-family:inherit;font-size:10.5px;font-weight:800;letter-spacing:.06em;cursor:pointer;flex-shrink:0;transition:filter .15s,box-shadow .15s;box-shadow:0 0 0 1px rgba(255,211,0,0.4) inset,0 0 10px rgba(255,211,0,0.3)}',
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

  // The header's Instagram icon is owned by journal-dock.js (.nav-cta.tmw-ig).
  // We REUSE it — moving it into this cluster so [IG][profile] reads as one
  // tight unit on the right — and only mint our own as a fallback on pages
  // without the dock (e.g. /media). attachIG waits briefly for the dock to run
  // its swap before deciding, so the two never both render.
  function attachIG(host) {
    if (host.querySelector('.tmw-ig, .tmw-auth-ig')) return;     // already have one
    var ig = document.querySelector('.tmw-ig');
    if (ig) { host.insertBefore(ig, host.firstChild); return; }  // reuse the dock's
    var tries = 0;
    var t = setInterval(function () {
      if (host.querySelector('.tmw-ig, .tmw-auth-ig')) { clearInterval(t); return; }
      var el = document.querySelector('.tmw-ig');
      if (el) { clearInterval(t); host.insertBefore(el, host.firstChild); return; }
      if (++tries > 30) {                                        // ~3s, no dock here → mint our own
        clearInterval(t);
        var a = document.createElement('a');
        a.className = 'tmw-auth-ig';
        a.href = 'https://www.instagram.com/floridaoftomorrow';
        a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('aria-label', 'Instagram');
        a.innerHTML = IG_ICON;
        host.insertBefore(a, host.firstChild);
      }
    }, 100);
  }

  function buildUI(host) {
    host.innerHTML =
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
      var paid = signedIn && isPaid(member);
      btn.classList.toggle('signed-in', signedIn);
      btn.classList.toggle('is-pro', paid);
      btn.setAttribute('aria-label', signedIn ? 'Profile menu' : 'Join');
      if (!signedIn) menu.classList.remove('open');
      // Expose for the dock's paywall interceptor: paid members follow Pro
      // links straight to the map feature; everyone else gets the paywall.
      window._tmwSignedIn = signedIn;
      window._isPaidMember = paid;
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
      // Native in-page paywall; fall back to the map deep-link if it hasn't loaded.
      if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall('go-pro');
      else location.href = MAP_URL + '/?upgrade=1';
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
    // Prefer the dock's Instagram button (.tmw-ig) so the cluster lands right
    // where it is; else the header's Open Map / CTA button.
    var anchor = document.querySelector('.tmw-ig')
      || document.getElementById('nav-map-cta')
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
      if (host.__tmwBuilt) return;     // already initialised (script can load twice)
      host.__tmwBuilt = true;
      var refs = buildUI(host);        // render immediately in signed-out state
      attachIG(host);                  // pull in the dock's IG icon (or mint a fallback)
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
