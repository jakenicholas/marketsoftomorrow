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
      '.tmw-am.show .tmw-am-card{transform:translateY(0)}',
      '.tmw-am-x{position:absolute; top:14px; right:16px; width:30px; height:30px; border:0; border-radius:50%; background:rgba(255,255,255,.06); color:rgba(255,255,255,.6); font-size:18px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s,color .15s}',
      '.tmw-am-x:hover{background:rgba(255,255,255,.12); color:#fff}',
      '.tmw-am-logo{display:flex; justify-content:center; margin-bottom:18px}',
      '.tmw-am-logo b{font-family:var(--sans,"Inter",sans-serif); font-weight:800; font-size:17px; letter-spacing:-.02em; line-height:.92; color:#fff; text-align:center; text-transform:uppercase}',
      '.tmw-am-logo b span{display:block; font-size:9px; font-weight:600; letter-spacing:.12em; color:rgba(255,255,255,.55)}',
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
      '@media(max-width:480px){.tmw-am-card{padding:30px 22px 24px}}'
    ].join('');
    document.head.appendChild(st);
  }

  var LOGO = '<div class="tmw-am-logo"><b>Markets<span>of</span>TMW</b></div>';

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

  window.tmwAuthModal = function (view) {
    if (!ms()) return;
    var host = openShell();
    if (view === 'signup') viewSignup(host);
    else viewLogin(host);
  };
})();
