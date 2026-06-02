/*
  tmw-auth-modal.js — custom, TMW-branded auth modals on Memberstack's headless
  API. Replaces Memberstack's own Login / Signup / Profile / Security modals so
  the auth UI is fully on-brand (logo, guaranteed dark theme, our field order)
  and immune to the autofill/avatar/field-order issues of re-skinning theirs.

  Exposes  window.tmwAuthModal('login' | 'signup' | 'profile' | 'security')
  Requires Memberstack (window.$memberstackDom) — loaded by journal-auth.js.
  onAuthChange (in journal-auth.js) repaints the header after login/logout.

  Phase 1 (this file): login + signup. Profile + security land next.
*/
(function () {
  'use strict';
  if (window.tmwAuthModal) return;

  var MAPBOX_TOKEN = 'pk.eyJ1IjoiZmxvcmlkYW9mdG9tb3Jyb3ciLCJhIjoiY2xrYmpmdGQ2MGdibTNzcXZjMnA4aXh3ZiJ9.uBeYS7jmKwWS6xAgY-R1UA';
  function ms() { return window.$memberstackDom; }

  var GOOGLE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/></svg>';
  var EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';

  // ── styles ───────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('tmw-am-css')) return;
    var st = document.createElement('style'); st.id = 'tmw-am-css';
    st.textContent = [
      '.tmw-am{position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center; padding:20px; opacity:0; pointer-events:none; transition:opacity .2s}',
      '.tmw-am.show{opacity:1; pointer-events:auto}',
      '.tmw-am-bd{position:absolute; inset:0; background:rgba(0,0,0,.78); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px)}',
      '.tmw-am-card{position:relative; z-index:1; width:100%; max-width:430px; max-height:calc(100vh - 40px); overflow-y:auto; background:#0f1110; border:1px solid rgba(255,255,255,.1); border-radius:18px; padding:34px 32px 30px; box-shadow:0 40px 90px rgba(0,0,0,.6); transform:translateY(8px); transition:transform .2s; font-family:var(--sans,"Inter",-apple-system,sans-serif)}',
      // logged-in account modal: twice as wide on desktop. Forms stay a readable
      // centered column; the watchlist breaks out to the full width for its grid.
      '.tmw-am-card.wide{max-width:860px}',
      '.tmw-am-card.wide .tmw-am-sec{max-width:600px; margin-left:auto; margin-right:auto}',
      '.tmw-am-card.wide .tmw-am-sec.tmw-am-sec-wl{max-width:none}',
      '.tmw-am.show .tmw-am-card{transform:translateY(0)}',
      '.tmw-am-x{position:absolute; top:14px; right:16px; width:30px; height:30px; border:0; border-radius:50%; background:rgba(255,255,255,.06); color:rgba(255,255,255,.6); font-size:18px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s,color .15s}',
      '.tmw-am-x:hover{background:rgba(255,255,255,.12); color:#fff}',
      '.tmw-am-logo{display:flex; align-items:center; justify-content:center; gap:9px; margin-bottom:18px}',
      '.tmw-am-logo img{height:34px; width:auto; display:block; filter:brightness(0) invert(1)}',
      '.tmw-am-pro-pill{font-size:9px; font-weight:800; color:#000; background:#FFD300; padding:3px 8px; border-radius:5px; letter-spacing:.08em; text-transform:uppercase; line-height:1.2}',
      '.tmw-am h2{font-family:var(--serif,Georgia,serif); font-weight:500; font-size:23px; color:#fff; text-align:center; letter-spacing:-.01em; margin:0 0 22px}',
      '.tmw-am-field{margin-bottom:15px}',
      '.tmw-am-field label{display:block; font-size:12.5px; font-weight:600; color:#fff; margin-bottom:7px}',
      '.tmw-am-field .lrow{display:flex; align-items:baseline; justify-content:space-between}',
      '.tmw-am-field .lrow a{font-size:12px; color:#1FDF67; text-decoration:none; font-weight:500}',
      '.tmw-am-inp{position:relative}',
      '.tmw-am-inp input{box-sizing:border-box; width:100%; height:48px; padding:0 14px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.14); border-radius:10px; color:#fff; font-family:inherit; font-size:14px; outline:none; transition:border-color .15s}',
      '.tmw-am-inp input:focus{border-color:#1FDF67}',
      '.tmw-am-inp input::placeholder{color:rgba(255,255,255,.38)}',
      '.tmw-am-inp input:-webkit-autofill{-webkit-text-fill-color:#fff!important;-webkit-box-shadow:0 0 0 1000px #18191b inset!important;caret-color:#fff!important;transition:background-color 9999s ease-in-out 0s!important}',
      '.tmw-am-eye{position:absolute; top:0; right:0; height:48px; width:46px; border:0; background:none; color:rgba(255,255,255,.5); cursor:pointer; display:flex; align-items:center; justify-content:center}',
      '.tmw-am-eye:hover{color:#fff}',
      '.tmw-am-primary{width:100%; height:48px; border:0; border-radius:10px; background:#1FDF67; color:#04210f; font-family:var(--mono,monospace); font-weight:700; font-size:13px; letter-spacing:.04em; cursor:pointer; transition:background .15s; margin-top:4px}',
      '.tmw-am-primary:hover{background:#42eb81} .tmw-am-primary:disabled{opacity:.6; cursor:wait}',
      '.tmw-am-or{display:flex; align-items:center; gap:12px; margin:18px 0; color:rgba(255,255,255,.4); font-size:12px}',
      '.tmw-am-or::before,.tmw-am-or::after{content:""; flex:1; height:1px; background:rgba(255,255,255,.12)}',
      '.tmw-am-google{width:100%; height:48px; border:1px solid rgba(255,255,255,.18); border-radius:10px; background:rgba(255,255,255,.03); color:#fff; font-family:inherit; font-weight:600; font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; transition:background .15s}',
      '.tmw-am-google:hover{background:rgba(255,255,255,.08)}',
      '.tmw-am-alt{text-align:center; font-size:13px; color:rgba(255,255,255,.6); margin-top:20px}',
      '.tmw-am-alt a{color:#1FDF67; text-decoration:none; font-weight:600; cursor:pointer}',
      '.tmw-am-msg{font-size:12.5px; line-height:1.4; margin-top:13px; text-align:center; min-height:1px}',
      '.tmw-am-msg.err{color:#ff9b9b} .tmw-am-msg.ok{color:#42eb81}',
      // account view (profile / security)
      '.tmw-am-tabs{display:flex; gap:6px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1); border-radius:11px; padding:4px; margin-bottom:20px}',
      '.tmw-am-tab{flex:1; border:0; background:none; color:rgba(255,255,255,.6); font-family:var(--sans,"Inter",sans-serif); font-size:13px; font-weight:600; padding:9px; border-radius:8px; cursor:pointer; transition:background .15s,color .15s}',
      '.tmw-am-tab.on{background:rgba(255,255,255,.08); color:#fff}',
      '.tmw-am-row{display:flex; gap:9px}',
      '.tmw-am-row > *{flex:1; min-width:0}',
      '.tmw-am-geo{position:relative}',
      '.tmw-am-geolist{position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:6; background:#16181a; border:1px solid rgba(255,255,255,.16); border-radius:10px; overflow:hidden; max-height:200px; overflow-y:auto; box-shadow:0 16px 40px rgba(0,0,0,.55)}',
      '.tmw-am-geolist[hidden]{display:none}',
      '.tmw-am-geoitem{padding:10px 14px; font-size:13px; color:#e8e8e8; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.06)}',
      '.tmw-am-geoitem:last-child{border-bottom:0} .tmw-am-geoitem:hover{background:rgba(31,223,103,.12); color:#fff}',
      '.tmw-am-foot{display:flex; align-items:center; justify-content:space-between; margin-top:18px}',
      '.tmw-am-logout{background:none; border:0; color:rgba(255,255,255,.55); font-family:var(--sans,"Inter",sans-serif); font-size:13px; cursor:pointer}',
      '.tmw-am-logout:hover{color:#fff}',
      '.tmw-am-plans{background:none; border:0; color:#1FDF67; font-family:var(--sans,"Inter",sans-serif); font-size:13px; font-weight:600; cursor:pointer}',
      '.tmw-am-tab-pro{font-style:normal; font-size:8px; font-weight:800; color:#000; background:#FFD300; padding:1px 5px; border-radius:4px; margin-left:5px; letter-spacing:.06em; vertical-align:middle}',
      // watchlist
      // watchlist — image cards (mirrors the map tiles)
      '.tmw-am-wl{display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:start; max-height:480px; overflow-y:auto; overflow-x:hidden; padding:2px}',
      '.tmw-am-wlc{position:relative; display:block; height:170px; border-radius:13px; overflow:hidden; text-decoration:none; border:1px solid rgba(255,255,255,.1); background:linear-gradient(135deg,#1b1e1b,#0c0e0c)}',
      '.tmw-am-wlc img{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transition:transform .45s ease}',
      '.tmw-am-wlc::after{content:""; position:absolute; inset:0; background:linear-gradient(to top, rgba(5,6,5,.93), rgba(5,6,5,.12) 58%, transparent)}',
      '.tmw-am-wlc:hover img{transform:scale(1.05)}',
      '.tmw-am-wlc-meta{position:absolute; left:0; right:0; bottom:0; padding:12px 13px; z-index:2}',
      '.tmw-am-wlc-city{font-family:var(--mono,monospace); font-size:8.5px; letter-spacing:.14em; text-transform:uppercase; color:rgba(255,255,255,.72); margin-bottom:3px}',
      '.tmw-am-wlc-ttl{font-family:var(--serif,Georgia,serif); font-size:14.5px; line-height:1.15; color:#fff}',
      '.tmw-am-wl-empty{text-align:center; padding:10px 0}',
      '.tmw-am-wl-empty b{display:block; font-family:var(--serif,Georgia,serif); font-weight:500; font-size:18px; color:#fff; margin-bottom:6px}',
      '.tmw-am-wl-empty i{font-style:normal; display:block; font-size:12.5px; color:rgba(255,255,255,.55); line-height:1.45; margin-bottom:16px}',
      // watchlist — locked (non-pro)
      '.tmw-am-lock{text-align:center; padding:4px 0}',
      '.tmw-am-lock-pill{display:inline-block; font-size:9px; font-weight:800; color:#000; background:#FFD300; padding:3px 9px; border-radius:5px; letter-spacing:.08em; margin-bottom:13px}',
      '.tmw-am-lock-ttl{font-family:var(--serif,Georgia,serif); font-weight:500; font-size:19px; color:#fff; margin-bottom:7px}',
      '.tmw-am-lock-sub{font-size:12.5px; color:rgba(255,255,255,.6); line-height:1.5; max-width:34ch; margin:0 auto 16px}',
      '.tmw-am-lockrows{display:flex; flex-direction:column; gap:8px; margin-bottom:18px; -webkit-mask-image:linear-gradient(#000 30%,transparent); mask-image:linear-gradient(#000 30%,transparent); pointer-events:none}',
      '.tmw-am-lockrow{height:44px; border-radius:11px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08)}',
      '@media(max-width:560px){.tmw-am-wl{grid-template-columns:1fr}}',
      '@media(max-width:480px){.tmw-am-card{padding:30px 22px 24px}}'
    ].join('');
    document.head.appendChild(st);
  }

  var LOGO = '<div class="tmw-am-logo"><img src="https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/other/50822a-TMW_Logos-16.svg" alt="Markets of Tomorrow"></div>';

  // ── shell ─────────────────────────────────────────────────────────────────
  var current = null;
  function close() { if (!current) return; var el = current; current = null; el.classList.remove('show'); setTimeout(function () { el.remove(); }, 220); }
  function openShell() {
    injectCss();
    if (current) current.remove();
    var el = document.createElement('div');
    el.className = 'tmw-am';
    el.innerHTML = '<div class="tmw-am-bd"></div><div class="tmw-am-card" role="dialog" aria-modal="true"><button class="tmw-am-x" aria-label="Close">&times;</button><div class="tmw-am-body"></div></div>';
    document.body.appendChild(el);
    current = el;
    el.querySelector('.tmw-am-x').addEventListener('click', close);
    el.querySelector('.tmw-am-bd').addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    requestAnimationFrame(function () { el.classList.add('show'); });
    return el.querySelector('.tmw-am-body');
  }

  function setMsg(host, kind, text) { var m = host.querySelector('.tmw-am-msg'); if (m) { m.className = 'tmw-am-msg ' + (kind || ''); m.innerHTML = text || ''; } }
  function niceError(e) {
    var msg = (e && (e.message || (e.error && e.error.message))) || 'Something went wrong. Try again.';
    if (/password/i.test(msg) && /incorrect|wrong|invalid/i.test(msg)) return 'Incorrect email or password.';
    if (/not found|no member|does not exist/i.test(msg)) return "We couldn't find an account with that email.";
    if (/exist|already|registered|in use/i.test(msg)) return 'That email already has an account — log in instead.';
    return msg;
  }

  // ── login ───────────────────────────────────────────────────────────────
  function viewLogin(host) {
    host.innerHTML =
      LOGO +
      '<h2>Log in to your account</h2>' +
      '<form class="tmw-am-form" novalidate>' +
        '<div class="tmw-am-field"><label>Email Address</label><div class="tmw-am-inp"><input name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div></div>' +
        '<div class="tmw-am-field"><div class="lrow"><label>Password</label><a href="#" data-act="forgot">Forgot Password?</a></div><div class="tmw-am-inp"><input name="password" type="password" autocomplete="current-password" placeholder="••••••••" required><button type="button" class="tmw-am-eye" aria-label="Show password">' + EYE + '</button></div></div>' +
        '<button type="submit" class="tmw-am-primary">Log in</button>' +
      '</form>' +
      '<div class="tmw-am-or">or</div>' +
      '<button type="button" class="tmw-am-google" data-act="google">' + GOOGLE_ICON + ' Continue with Google</button>' +
      '<div class="tmw-am-msg" aria-live="polite"></div>' +
      '<div class="tmw-am-alt">Don’t have an account? <a data-act="to-signup">Sign up</a></div>';
    wireEye(host);
    host.querySelector('[data-act="to-signup"]').addEventListener('click', function () { viewSignup(host); });
    host.querySelector('[data-act="forgot"]').addEventListener('click', function (e) {
      e.preventDefault();
      var email = (host.querySelector('input[name="email"]').value || '').trim();
      if (!email) { setMsg(host, 'err', 'Enter your email above first, then tap Forgot Password.'); return; }
      var m = ms(); if (!m) return;
      m.sendMemberResetPasswordEmail({ email: email }).then(function () {
        setMsg(host, 'ok', '✓ Check your inbox for a reset link.');
      }).catch(function (err) { setMsg(host, 'err', niceError(err)); });
    });
    host.querySelector('[data-act="google"]').addEventListener('click', function () {
      var m = ms(); if (!m) return;
      m.loginWithProvider({ provider: 'google' }).then(close).catch(function (err) { setMsg(host, 'err', niceError(err)); });
    });
    host.querySelector('.tmw-am-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, email = (f.email.value || '').trim(), pw = f.password.value || '';
      if (!email || !pw) { setMsg(host, 'err', 'Enter your email and password.'); return; }
      var btn = f.querySelector('.tmw-am-primary'); btn.disabled = true; btn.textContent = 'Logging in…'; setMsg(host, '', '');
      var m = ms(); if (!m) { setMsg(host, 'err', 'Still loading — try again in a moment.'); btn.disabled = false; btn.textContent = 'Log in'; return; }
      m.loginMemberEmailPassword({ email: email, password: pw }).then(function () {
        try { if (window.gtag) window.gtag('event', 'login', { method: 'email' }); } catch (_) {}
        close();
      }).catch(function (err) { setMsg(host, 'err', niceError(err)); btn.disabled = false; btn.textContent = 'Log in'; });
    });
  }

  // ── signup ──────────────────────────────────────────────────────────────
  function viewSignup(host) {
    host.innerHTML =
      LOGO +
      '<h2>Create your account</h2>' +
      '<form class="tmw-am-form" novalidate>' +
        '<div class="tmw-am-field"><label>Email Address</label><div class="tmw-am-inp"><input name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div></div>' +
        '<div class="tmw-am-field"><label>Password</label><div class="tmw-am-inp"><input name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" required><button type="button" class="tmw-am-eye" aria-label="Show password">' + EYE + '</button></div></div>' +
        '<button type="submit" class="tmw-am-primary">Create account</button>' +
      '</form>' +
      '<div class="tmw-am-or">or</div>' +
      '<button type="button" class="tmw-am-google" data-act="google">' + GOOGLE_ICON + ' Continue with Google</button>' +
      '<div class="tmw-am-msg" aria-live="polite"></div>' +
      '<div class="tmw-am-alt">Already have an account? <a data-act="to-login">Log in</a></div>';
    wireEye(host);
    host.querySelector('[data-act="to-login"]').addEventListener('click', function () { viewLogin(host); });
    host.querySelector('[data-act="google"]').addEventListener('click', function () {
      var m = ms(); if (!m) return;
      m.signupWithProvider({ provider: 'google' }).then(close).catch(function (err) { setMsg(host, 'err', niceError(err)); });
    });
    host.querySelector('.tmw-am-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, email = (f.email.value || '').trim(), pw = f.password.value || '';
      if (!email) { setMsg(host, 'err', 'Enter your email.'); return; }
      if (pw.length < 8) { setMsg(host, 'err', 'Use at least 8 characters.'); return; }
      var btn = f.querySelector('.tmw-am-primary'); btn.disabled = true; btn.textContent = 'Creating…'; setMsg(host, '', '');
      var m = ms(); if (!m) { setMsg(host, 'err', 'Still loading — try again in a moment.'); btn.disabled = false; btn.textContent = 'Create account'; return; }
      m.signupMemberEmailPassword({ email: email, password: pw }).then(function () {
        try { if (window.gtag) window.gtag('event', 'sign_up', { method: 'email' }); } catch (_) {}
        // Hand to the profile step (reused from the newsletter funnel) if present.
        if (typeof window.tmwProfileStep === 'function') {
          var card = host.closest('.tmw-am-card'); if (card) { var x = card.querySelector('.tmw-am-x'); if (x) x.style.display = 'none'; }
          window.tmwProfileStep(host, email, function () { close(); });
        } else { close(); }
      }).catch(function (err) {
        var nm = niceError(err);
        setMsg(host, 'err', /log in instead/.test(nm) ? 'That email already has an account. <a data-act="to-login">Log in</a>' : nm);
        var ln = host.querySelector('.tmw-am-msg [data-act="to-login"]'); if (ln) ln.addEventListener('click', function () { viewLogin(host); });
        btn.disabled = false; btn.textContent = 'Create account';
      });
    });
  }

  function wireEye(host) {
    var eye = host.querySelector('.tmw-am-eye'); if (!eye) return;
    eye.addEventListener('click', function () {
      var inp = eye.parentElement.querySelector('input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  }

  // ── account (profile + security) ──────────────────────────────────────────
  function wireGeo(scope) {
    var inp = scope.querySelector('input[name="based"]'), list = scope.querySelector('.tmw-am-geolist');
    if (!inp || !list) return;
    var timer, hideT;
    function hide() { list.hidden = true; list.innerHTML = ''; }
    inp.addEventListener('input', function () {
      var q = inp.value.trim(); clearTimeout(timer);
      if (q.length < 2) { hide(); return; }
      timer = setTimeout(function () {
        fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(q) + '.json?access_token=' + MAPBOX_TOKEN + '&autocomplete=true&types=place,region,district&limit=5')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var fs = (d && d.features) || []; if (!fs.length) { hide(); return; }
            list.innerHTML = ''; fs.forEach(function (f) { var it = document.createElement('div'); it.className = 'tmw-am-geoitem'; it.textContent = f.place_name || ''; list.appendChild(it); }); list.hidden = false;
          }).catch(hide);
      }, 250);
    });
    list.addEventListener('mousedown', function (e) { var it = e.target.closest && e.target.closest('.tmw-am-geoitem'); if (!it) return; e.preventDefault(); inp.value = it.textContent; hide(); });
    inp.addEventListener('blur', function () { clearTimeout(hideT); hideT = setTimeout(hide, 150); });
  }

  function profileSection(el, cf, email, host) {
    el.innerHTML =
      '<div class="tmw-am-row">' +
        '<div class="tmw-am-field"><label>First name</label><div class="tmw-am-inp"><input name="first" autocomplete="given-name"></div></div>' +
        '<div class="tmw-am-field"><label>Last name</label><div class="tmw-am-inp"><input name="last" autocomplete="family-name"></div></div>' +
      '</div>' +
      '<div class="tmw-am-field"><label>Profession</label><div class="tmw-am-inp"><input name="profession"></div></div>' +
      '<div class="tmw-am-field"><label>Company</label><div class="tmw-am-inp"><input name="company"></div></div>' +
      '<div class="tmw-am-field"><label>Based</label><div class="tmw-am-geo"><div class="tmw-am-inp"><input name="based" autocomplete="off" placeholder="City"></div><div class="tmw-am-geolist" hidden></div></div></div>' +
      '<button class="tmw-am-primary" data-act="save-profile">Save changes</button>';
    var set = function (n, v) { var i = el.querySelector('input[name="' + n + '"]'); if (i) i.value = v || ''; };
    set('first', cf['first-name']); set('last', cf['last-name']); set('profession', cf['profession']); set('company', cf['company-name']); set('based', cf['based']);
    wireGeo(el);
    el.querySelector('[data-act="save-profile"]').addEventListener('click', function () {
      var v = function (n) { var i = el.querySelector('input[name="' + n + '"]'); return (i && i.value || '').trim(); };
      var data = { first: v('first'), last: v('last'), profession: v('profession'), company: v('company'), based: v('based') };
      var btn = el.querySelector('[data-act="save-profile"]'); btn.disabled = true; btn.textContent = 'Saving…'; setMsg(host, '', '');
      var jobs = [], m = ms();
      if (m && m.updateMember) jobs.push(m.updateMember({ customFields: { 'first-name': data.first, 'last-name': data.last, 'profession': data.profession, 'company-name': data.company, 'based': data.based } }).catch(function () {}));
      jobs.push(fetch('https://tmw-subscribe.jake-ab7.workers.dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, update: true, first_name: data.first, last_name: data.last, profession: data.profession, company_name: data.company, based: data.based }) }).catch(function () {}));
      Promise.all(jobs).then(function () { btn.disabled = false; btn.textContent = 'Save changes'; setMsg(host, 'ok', '✓ Saved.'); });
    });
  }

  function securitySection(el, email, host) {
    el.innerHTML =
      '<div class="tmw-am-field"><label>Email Address</label><div class="tmw-am-inp"><input name="email" type="email" autocomplete="email"></div></div>' +
      '<div class="tmw-am-field"><label>Current password</label><div class="tmw-am-inp"><input name="cur" type="password" autocomplete="current-password" placeholder="Needed to change password"></div></div>' +
      '<div class="tmw-am-field"><label>New password</label><div class="tmw-am-inp"><input name="new" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div></div>' +
      '<button class="tmw-am-primary" data-act="save-security">Save changes</button>' +
      '<div class="tmw-am-or">or</div>' +
      '<button class="tmw-am-google" data-act="connect-google">' + GOOGLE_ICON + ' Connect with Google</button>';
    var ei = el.querySelector('input[name="email"]'); if (ei) ei.value = email || '';
    el.querySelector('[data-act="connect-google"]').addEventListener('click', function () {
      var m = ms(); if (m && m.connectProvider) m.connectProvider({ provider: 'google' }).then(function () { setMsg(host, 'ok', '✓ Google connected.'); }).catch(function (e) { setMsg(host, 'err', niceError(e)); });
    });
    el.querySelector('[data-act="save-security"]').addEventListener('click', function () {
      var m = ms(); if (!m) return;
      var newEmail = (el.querySelector('input[name="email"]').value || '').trim();
      var cur = el.querySelector('input[name="cur"]').value || '', nw = el.querySelector('input[name="new"]').value || '';
      var btn = el.querySelector('[data-act="save-security"]'); setMsg(host, '', '');
      if (nw && nw.length < 8) { setMsg(host, 'err', 'New password must be at least 8 characters.'); return; }
      if (nw && !cur) { setMsg(host, 'err', 'Enter your current password to set a new one.'); return; }
      var ops = [];
      if (newEmail && newEmail !== email) ops.push(m.updateMemberAuth({ email: newEmail }));
      if (nw) ops.push(m.updateMemberAuth({ oldPassword: cur, newPassword: nw }));
      if (!ops.length) { setMsg(host, 'err', 'Nothing to update.'); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      Promise.all(ops).then(function () { btn.disabled = false; btn.textContent = 'Save changes'; setMsg(host, 'ok', '✓ Updated.'); })
        .catch(function (e) { setMsg(host, 'err', niceError(e)); btn.disabled = false; btn.textContent = 'Save changes'; });
    });
  }

  function isPaidMember(d) {
    var plans = (d && d.planConnections) || [];
    return plans.some(function (p) { return p.active === true || p.status === 'ACTIVE'; });
  }
  function unslug(s) { return String(s || '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  // Map projects (for watchlist images). Slug = projectSlugify(Title), same as
  // the map. Fetched once + cached; CORS is open on map.oftmw.com.
  function projectSlugify(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-|-$/g, ''); }
  // The map deep-link matches on title.toLowerCase().replace(/[^a-z0-9]+/g,'') —
  // fully concatenated, no separators (e.g. "The Nora Hotel" -> "thenorahotel").
  function mapSlug(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  var _projBySlug = null;
  function loadProjects() {
    if (_projBySlug) return Promise.resolve(_projBySlug);
    return fetch('https://map.oftmw.com/projects-flat.json').then(function (r) { return r.json(); }).then(function (arr) {
      var map = {};
      (Array.isArray(arr) ? arr : []).forEach(function (p) { var s = projectSlugify(p.Title); if (s && !map[s]) map[s] = p; });
      _projBySlug = map; return map;
    }).catch(function () { return {}; });
  }

  // Watchlist tab — Pro only. Free members see a locked, grayed preview + Go Pro.
  function watchlistSection(el, paid, host) {
    if (!paid) {
      el.innerHTML =
        '<div class="tmw-am-lock">' +
          '<span class="tmw-am-lock-pill">PRO</span>' +
          '<div class="tmw-am-lock-ttl">Your watchlist is a Pro feature</div>' +
          '<div class="tmw-am-lock-sub">Star any project on the map to follow it, build your list, and get notified when it moves forward.</div>' +
          '<div class="tmw-am-lockrows"><div class="tmw-am-lockrow"></div><div class="tmw-am-lockrow"></div><div class="tmw-am-lockrow"></div></div>' +
          '<button class="tmw-am-primary" data-act="go-pro">Go Pro</button>' +
        '</div>';
      el.querySelector('[data-act="go-pro"]').addEventListener('click', function () {
        close(); if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall('watchlist'); else window.location.href = 'https://map.oftmw.com/?upgrade=1';
      });
      return;
    }
    el.innerHTML = '<div class="tmw-am-msg">Loading your watchlist…</div>';
    var m = ms(); if (!m || !m.getMemberJSON) { el.innerHTML = '<div class="tmw-am-msg err">Couldn’t load your watchlist.</div>'; return; }
    Promise.all([m.getMemberJSON(), loadProjects()]).then(function (out) {
      var json = (out[0] && out[0].data) || {}, pmap = out[1] || {};
      var favs = Array.isArray(json.favorites) ? json.favorites.filter(function (s) { return typeof s === 'string' && s; }) : [];
      if (!favs.length) {
        el.innerHTML = '<div class="tmw-am-wl-empty"><b>No saved projects yet</b><i>Star projects on the map to start your watchlist.</i><a class="tmw-am-primary" href="https://map.oftmw.com" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;text-decoration:none">Explore the map →</a></div>';
        return;
      }
      el.innerHTML = '';
      var grid = document.createElement('div'); grid.className = 'tmw-am-wl';
      favs.forEach(function (slug) {
        var p = pmap[slug] || null;
        var mslug = (p && p.Title) ? mapSlug(p.Title) : slug.replace(/-/g, '');
        var a = document.createElement('a'); a.className = 'tmw-am-wlc';
        a.href = 'https://map.oftmw.com/?fullscreen=true&project=' + encodeURIComponent(mslug); a.target = '_blank'; a.rel = 'noopener';
        var img = (p && (p.ImageURL || p.Image2)) || '';
        if (img) { var im = document.createElement('img'); im.src = img; im.loading = 'lazy'; im.alt = ''; a.appendChild(im); }
        var meta = document.createElement('div'); meta.className = 'tmw-am-wlc-meta';
        if (p && p.City) { var c = document.createElement('div'); c.className = 'tmw-am-wlc-city'; c.textContent = p.City; meta.appendChild(c); }
        var t = document.createElement('div'); t.className = 'tmw-am-wlc-ttl'; t.textContent = (p && p.Title) || unslug(slug);
        meta.appendChild(t); a.appendChild(meta); grid.appendChild(a);
      });
      el.appendChild(grid);
    }).catch(function () { el.innerHTML = '<div class="tmw-am-msg err">Couldn’t load your watchlist.</div>'; });
  }

  function renderAccount(host, section, cf, email, paid) {
    var logo = paid ? LOGO.replace('</div>', '<span class="tmw-am-pro-pill">PRO</span></div>') : LOGO;
    host.innerHTML = logo +
      '<div class="tmw-am-tabs"><button class="tmw-am-tab" data-sec="profile">Profile</button><button class="tmw-am-tab" data-sec="security">Security</button><button class="tmw-am-tab" data-sec="watchlist">Watchlist' + (paid ? '' : '<em class="tmw-am-tab-pro">PRO</em>') + '</button></div>' +
      '<div class="tmw-am-sec"></div>' +
      '<div class="tmw-am-msg" aria-live="polite"></div>' +
      '<div class="tmw-am-foot"><button class="tmw-am-logout" data-act="logout">Log out</button><button class="tmw-am-plans" data-act="plans">' + (paid ? 'Manage plan →' : 'Go Pro →') + '</button></div>';
    var sec = host.querySelector('.tmw-am-sec'), tabs = host.querySelectorAll('.tmw-am-tab');
    function show(s) {
      tabs.forEach(function (t) { t.classList.toggle('on', t.getAttribute('data-sec') === s); });
      sec.classList.toggle('tmw-am-sec-wl', s === 'watchlist');
      setMsg(host, '', '');
      if (s === 'security') securitySection(sec, email, host);
      else if (s === 'watchlist') watchlistSection(sec, paid, host);
      else profileSection(sec, cf, email, host);
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { show(t.getAttribute('data-sec')); }); });
    host.querySelector('[data-act="logout"]').addEventListener('click', function () {
      var m = ms(); if (m && m.logout) { m.logout().then(function () { close(); location.reload(); }).catch(function () { close(); location.reload(); }); } else { close(); location.reload(); }
    });
    host.querySelector('[data-act="plans"]').addEventListener('click', function () {
      var m = ms();
      // Pro members → Stripe customer portal (update billing / cancel plan),
      // same call the map uses. Free members → the Go Pro paywall.
      if (paid && m && typeof m.launchStripeCustomerPortal === 'function') {
        var btn = host.querySelector('[data-act="plans"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
        m.launchStripeCustomerPortal({ returnUrl: window.location.href }).catch(function () {
          if (btn) { btn.disabled = false; btn.textContent = 'Manage plan →'; }
          setMsg(host, 'Couldn’t open the billing portal. Please try again.', 'err');
        });
        return;
      }
      close();
      if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall('account');
      else window.location.href = 'https://map.oftmw.com/?upgrade=1';
    });
    show(section || 'profile');
  }

  function viewAccount(host, section) {
    var m = ms(); if (!m) return;
    var card = host.closest && host.closest('.tmw-am-card'); if (card) card.classList.add('wide');
    host.innerHTML = LOGO + '<div class="tmw-am-msg">Loading…</div>';
    m.getCurrentMember().then(function (r) {
      var d = (r && r.data) || {};
      renderAccount(host, section, d.customFields || {}, (d.auth && d.auth.email) || d.email || '', isPaidMember(d));
    }).catch(function () { renderAccount(host, section, {}, '', false); });
  }

  window.tmwAuthModal = function (view) {
    if (!ms()) return;
    var host = openShell();
    if (view === 'profile' || view === 'account') viewAccount(host, 'profile');
    else if (view === 'security') viewAccount(host, 'security');
    else if (view === 'watchlist') viewAccount(host, 'watchlist');
    else if (view === 'signup') viewSignup(host);
    else viewLogin(host);
  };
})();
