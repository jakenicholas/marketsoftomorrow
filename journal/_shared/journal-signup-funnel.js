/*
  journal-signup-funnel.js — the auto-triggering email → password → profile →
  Go-Pro funnel, as a SHARED module so non-article pages (the /markets/ SEO
  pages) run the exact same flow article pages do.

  WHY SHARED STATE WORKS: this uses the IDENTICAL localStorage keys, subscribe
  endpoint, and journal-auth step functions as the article funnel in
  journal/post/post.js:
    • tmw-sub-email        — the address a visitor subscribed with
    • tmw-sub-lightbox-v1  — "has subscribed" marker
    • tmw-acct-skip        — (sessionStorage) dismissed the password step this session
  So a visitor who enters their email on a market page and leaves WITHOUT a
  password will, on their next visit to ANY page (market OR article), be shown
  the "add a password" step where they left off — and vice versa. The two
  surfaces communicate purely through this shared local state.

  Steps 2–4 (password / profile / Go-Pro pitch) are window.tmwFreeAccountPrompt
  / tmwProfileStep / tmwGoProStep, defined once in journal-auth.js and reused
  here exactly as the article funnel reuses them.

  Customize the first (email) step per page via window.TMW_FUNNEL_OPTS BEFORE
  this script loads:
    window.TMW_FUNNEL_OPTS = { headline, eyebrow, source, delayMs };

  Loaded on market pages by journal-chrome.js (scoped to /markets/). Article
  pages keep their own copy in post.js, so this never double-fires there.
*/
(function () {
  'use strict';
  if (window.tmwSignupFunnel) return;            // singleton

  var OPTS = window.TMW_FUNNEL_OPTS || {};
  var SUB_ENDPOINT = 'https://tmw-subscribe.jake-ab7.workers.dev';
  var MARKETS = ['florida', 'tennessee', 'newyork', 'caribbean', 'rockies', 'hotel'];
  var KEY = 'tmw-sub-lightbox-v1';
  var SUB_EMAIL_KEY = 'tmw-sub-email';
  var GOPRO_SESSION_KEY = 'tmw-gopro-shown';   // sessionStorage: the Pro/trial upsell has fired this session
  var GOPRO_FIRST_KEY = 'tmw-gopro-firstdone'; // localStorage: the first-session Pro upsell has fired at least once
  var GOPRO_FIRST_DELAY_MS = 120000;           // first session after signup: breathe 2 min before the upsell
  var DELAY_MS = OPTS.delayMs || 3000;
  var SOURCE = OPTS.source || 'market_page';
  var EYEBROW = OPTS.eyebrow || 'The Future Is Here';
  var HEADLINE = OPTS.headline || 'Track tomorrow\'s developments with TMW Intelligence: forecasts, data, and updates.';
  var EVENT = OPTS.event || 'subscribe_market';   // analytics event name; article pages override to 'subscribe_article'

  function mark(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function subscribedEmail() { try { return localStorage.getItem(SUB_EMAIL_KEY); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ── CSS (self-contained; mirrors post.css's .tmw-sub but with hardcoded
  //    colors so it looks identical on pages that don't load post.css) ──────
  if (!document.getElementById('tmw-funnel-css')) {
    var css =
      '.tmw-sub{position:fixed;left:0;right:0;bottom:0;z-index:9500;display:flex;justify-content:center;padding:0 14px 14px;pointer-events:none}' +
      '.tmw-sub-panel{pointer-events:auto;width:min(680px,100%);background:linear-gradient(180deg,#12150f,#0a0c08);border:1px solid rgba(230,197,116,.22);border-radius:18px;padding:26px 26px 24px;box-shadow:0 -12px 60px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.3);position:relative;transform:translateY(150%);transition:transform .55s cubic-bezier(.22,1,.36,1);font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif}' +
      '.tmw-sub.show .tmw-sub-panel{transform:translateY(0)}' +
      '.tmw-sub-x{position:absolute;top:11px;right:14px;background:none;border:0;color:#9AA39C;font-size:26px;line-height:1;cursor:pointer;padding:0}' +
      '.tmw-sub-x:hover{color:#fff}' +
      '.tmw-sub-eyebrow{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;font-size:10.5px;letter-spacing:.26em;text-transform:uppercase;color:#f0d68a;text-shadow:0 0 12px rgba(230,197,116,.4);margin-bottom:12px}' +
      '.tmw-sub-h{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:clamp(20px,2.6vw,27px);line-height:1.16;color:#fff;max-width:34ch;margin:0 0 18px}' +
      '.tmw-sub-form{display:flex;gap:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:7px 7px 7px 22px;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:border-color .2s}' +
      '.tmw-sub-form:focus-within{border-color:#1FDF67}' +
      '.tmw-sub-form input{flex:1;border:0;outline:0;background:transparent;font-family:"Inter",sans-serif;font-size:14px;color:#fff;min-width:0;height:auto;padding:0}' +
      '.tmw-sub-form input::placeholder{color:#9AA39C}' +
      '.tmw-sub-form button{flex:0 0 auto;background:#1FDF67;color:#0a0a0a;padding:12px 22px;border:0;border-radius:999px;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .2s}' +
      '.tmw-sub-form button:hover{background:#42EB81}' +
      '.tmw-sub-form button:disabled{opacity:.6;cursor:wait}' +
      '.tmw-sub-msg{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;font-size:13.5px;letter-spacing:.04em;color:#1FDF67;margin-top:14px}' +
      '.tmw-sub-msg.err{color:#ff8a8a}' +
      // Combined email + password step → a stacked form (not the single-line pill).
      // Email + password sit side by side (2 columns); the button spans below.
      '.tmw-sub-form.stack{display:grid;grid-template-columns:1fr 1fr;gap:10px;background:transparent;border:0;padding:0;border-radius:0;-webkit-backdrop-filter:none;backdrop-filter:none}' +
      '.tmw-sub-form.stack input{width:100%;min-width:0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:13px 16px;height:auto}' +
      '.tmw-sub-form.stack input:focus{border-color:#1FDF67}' +
      '.tmw-sub-form.stack button{grid-column:1 / -1;width:100%;padding:14px;border-radius:12px}' +
      '.tmw-sub-alt{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;color:#9AA39C;margin-top:13px}' +
      '.tmw-sub-alt a{color:#f0d68a;text-decoration:none;font-weight:600;cursor:pointer}' +
      '.tmw-sub-alt a:hover{text-decoration:underline}' +
      '.tmw-sub-msg a{color:#f0d68a;text-decoration:underline;font-weight:600;cursor:pointer}' +
      '@media(max-width:560px){.tmw-sub{padding:0 8px 8px}.tmw-sub-panel{padding:22px 18px 20px}.tmw-sub-form{padding:6px 6px 6px 18px}.tmw-sub-form button{padding:11px 16px}.tmw-sub-form.stack{grid-template-columns:1fr;padding:0}.tmw-sub-form.stack button{padding:14px}}';
    var st = document.createElement('style'); st.id = 'tmw-funnel-css'; st.textContent = css; document.head.appendChild(st);
  }

  // ── Bring our own fonts ──────────────────────────────────────────────────
  // The popup styles itself in Fraunces (headline) + Inter (everything else).
  // Some pages never load those webfonts (e.g. project pages only ship JetBrains
  // Mono), which is what made the box look different there. Inject the font link
  // once — same "bring-your-own" model the toast system uses — so the boxes are
  // identical everywhere. Skipped if the page already loaded Fraunces.
  // Skip if the page already provides Fraunces — either a Google Fonts link
  // (family=Fraunces) OR a self-hosted @font-face (font-family:'Fraunces', e.g.
  // the homepage). Without the self-hosted check this re-added the Google font on
  // pages that self-host, undoing the point of self-hosting.
  var _headHtml = document.head.innerHTML;
  var _hasFraunces = /family=Fraunces/.test(_headHtml) || /font-family:\s*['"]?Fraunces/i.test(_headHtml);
  if (!document.getElementById('tmw-funnel-fonts') && !_hasFraunces) {
    var fontLink = document.createElement('link');
    fontLink.id = 'tmw-funnel-fonts';
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(fontLink);
  }

  // ── Step 1: email + password in ONE step → creates the account ───────────
  // The auto-funnel is just two slides: (1) email + password (this), (2) Go-Pro.
  function build() {
    // Full-screen welcome (tmw-welcome.js, loaded by journal-chrome.js) is the
    // elevated experience; the slide-up panel below survives only as the
    // fallback when that module hasn't loaded.
    if (window.tmwWelcome && !document.querySelector('.tmww') && window.tmwWelcome.gate({ source: SOURCE })) return;
    if (document.querySelector('.tmw-sub')) return;     // max one at a time
    var el = document.createElement('div');
    el.className = 'tmw-sub';
    el.innerHTML =
      '<div class="tmw-sub-panel" role="dialog" aria-label="Create your TMW account">' +
        '<button class="tmw-sub-x" aria-label="Close">&times;</button>' +
        '<div class="tmw-sub-eyebrow">' + esc(EYEBROW) + '</div>' +
        '<h3 class="tmw-sub-h">' + esc(HEADLINE) + '</h3>' +
        '<form class="tmw-sub-form stack">' +
          '<input type="email" name="email" placeholder="you@example.com" autocomplete="email" required>' +
          '<input type="password" name="password" placeholder="Create a password (8+ characters)" autocomplete="new-password" minlength="8" required>' +
          '<button type="submit">Create free account</button>' +
        '</form>' +
        '<div class="tmw-sub-alt">Already have an account? <a class="tmw-sub-login" href="#">Log in</a></div>' +
        '<div class="tmw-sub-msg" aria-live="polite"></div>' +
      '</div>';
    document.body.appendChild(el);

    // Remove (not just hide) on close so build()'s singleton guard doesn't
    // stay tripped — otherwise the footer "Subscribe" CTA silently no-ops
    // after the auto-popup has been dismissed once. Mirrors buildAccountMode.
    function close() { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 350); }
    el.querySelector('.tmw-sub-x').addEventListener('click', close);
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    // "Log in" → the login modal (existing account, falls back to /dashboard/).
    function toLogin() { close(); try { if (typeof window.tmwAuthModal === 'function') window.tmwAuthModal('login'); else location.href = '/dashboard/'; } catch (_) { location.href = '/dashboard/'; } }
    var loginLink = el.querySelector('.tmw-sub-login');
    if (loginLink) loginLink.addEventListener('click', function (e) { e.preventDefault(); toLogin(); });

    var form = el.querySelector('.tmw-sub-form');
    var msg = el.querySelector('.tmw-sub-msg');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = (form.email.value || '').trim();
      var password = (form.password.value || '');
      msg.className = 'tmw-sub-msg'; msg.style.display = ''; msg.textContent = '';
      if (!email) { form.email.focus(); return; }
      if (password.length < 8) { msg.className = 'tmw-sub-msg err'; msg.textContent = 'Password must be at least 8 characters.'; form.password.focus(); return; }
      var btn = form.querySelector('button'); var orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Creating…';
      // Memberstack signup IS the source of truth — try to create, and only if
      // IT reports the email is registered do we surface "you already have an
      // account" (an /email-status pre-check false-positives on newsletter-only
      // addresses, redirecting people who have no account to log into).
      var res = window.tmwCreateFreeAccount ? await window.tmwCreateFreeAccount(email, password) : { ok: false, message: 'Accounts are still loading — try again in a moment.' };
      if (res && res.ok) {
        try { fetch(SUB_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, markets: MARKETS }) }); } catch (_) {}   // keep them on the newsletter too
        try { if (window.gtag) window.gtag('event', EVENT); } catch (_) {}
        try { window.tmwFunnelTrack && window.tmwFunnelTrack(EVENT, { email: email, source: SOURCE }); } catch (_) {}
        try { window.tmwFunnelTrack && window.tmwFunnelTrack('free_account_created', { email: email, source: SOURCE }); } catch (_) {}
        mark('subscribed');
        try { localStorage.setItem(SUB_EMAIL_KEY, email); } catch (_) {}
        // Account created (Memberstack signs them in) → confirm, then STEP 2: Go-Pro.
        form.style.display = 'none';
        var alt = el.querySelector('.tmw-sub-alt'); if (alt) alt.style.display = 'none';
        msg.textContent = "✓ You're in! Welcome to TMW.";
        // Celebrate the free account first (perks + limits + confetti), then let
        // its CTA carry them into the Go-Pro trial. Falls back to the old direct
        // Go-Pro pitch if the celebration module hasn't loaded yet.
        setTimeout(function () {
          el.classList.remove('show');
          if (window.tmwWelcomePopup) window.tmwWelcomePopup();
          else showGoProOncePerSession();
        }, 1200);
      } else if (res && res.code === 'exists') {
        // Already registered → warn + offer login (don't silently redirect).
        btn.disabled = false; btn.textContent = orig;
        msg.className = 'tmw-sub-msg err';
        msg.innerHTML = 'You already have an account. <a class="tmw-sub-login" href="#">Log in</a>';
        var si = msg.querySelector('.tmw-sub-login');
        if (si) si.addEventListener('click', function (ev) { ev.preventDefault(); toLogin(); });
      } else {
        btn.disabled = false; btn.textContent = orig;
        msg.className = 'tmw-sub-msg err'; msg.textContent = (res && res.message) || 'Could not create your account.';
      }
    });

    requestAnimationFrame(function () { el.classList.add('show'); });
  }

  // ── Step 2 directly: a returning subscriber (email already known) gets the
  //    "add a password" step, NOT re-asked to subscribe. ─────────────────────
  function buildAccountMode(email) {
    if (window._tmwSignedIn === true) return false;
    if (window.tmwWelcome && !document.querySelector('.tmww') && window.tmwWelcome.gate({ email: email, source: SOURCE })) return true;
    if (document.querySelector('.tmw-sub')) return false;
    var el = document.createElement('div');
    el.className = 'tmw-sub';
    el.innerHTML =
      '<div class="tmw-sub-panel" role="dialog" aria-label="Create your account">' +
        '<button class="tmw-sub-x" aria-label="Close">&times;</button>' +
        '<div class="tmw-sub-eyebrow">' + esc(EYEBROW) + '</div>' +
        '<div class="tmw-sub-acct"></div>' +
      '</div>';
    document.body.appendChild(el);
    function close(skip) { el.classList.remove('show'); if (skip) { try { sessionStorage.setItem('tmw-acct-skip', '1'); } catch (e) {} } }
    el.querySelector('.tmw-sub-x').addEventListener('click', function () { close(true); });
    el.addEventListener('click', function (e) { if (e.target === el) close(true); });
    var host = el.querySelector('.tmw-sub-acct');
    var ok = window.tmwFreeAccountPrompt && window.tmwFreeAccountPrompt(host, email, function (created) {
      if (created) { setTimeout(function () { el.classList.remove('show'); }, 200); } else { close(true); }
    });
    if (!ok) { el.remove(); return false; }
    requestAnimationFrame(function () { el.classList.add('show'); });
    return true;
  }

  // ── Step 4 standalone: already-signed-in free member → the Go-Pro pitch ────
  function buildGoProMode() {
    if (document.querySelector('.tmw-sub')) return false;
    var el = document.createElement('div');
    el.className = 'tmw-sub';
    el.innerHTML =
      '<div class="tmw-sub-panel" role="dialog" aria-label="Unlock TMW Pro">' +
        '<button class="tmw-sub-x" aria-label="Close">&times;</button>' +
        '<div class="tmw-sub-acct"></div>' +
      '</div>';
    document.body.appendChild(el);
    function close() { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 350); }
    el.querySelector('.tmw-sub-x').addEventListener('click', close);
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    var host = el.querySelector('.tmw-sub-acct');
    if (typeof window.tmwGoProStep !== 'function') { el.remove(); return false; }
    window.tmwGoProStep(host, close);
    requestAnimationFrame(function () { el.classList.add('show'); });
    return true;
  }

  function checkAuth(cb) {
    function answer() { cb(window._tmwSignedIn === true, window._isPaidMember === true); }
    if (window._tmwSignedIn === true || window._tmwSignedIn === false) { answer(); return; }
    var m = window.$memberstackDom;
    if (m && m.getCurrentMember) { m.getCurrentMember().then(function () { answer(); }).catch(function () { cb(false, false); }); return; }
    cb(false, false);
  }

  // The TMW Pro / trial upsell is capped to ONCE per browser session. The email
  // capture, by contrast, can reappear on most pages until an account exists.
  function goProShownThisSession() { try { return sessionStorage.getItem(GOPRO_SESSION_KEY) === '1'; } catch (e) { return false; } }
  function showGoProOncePerSession() {
    if (goProShownThisSession()) return false;
    // Prefer the full-screen Go-Pro moment; the paywall lightbox is the fallback.
    if (window.tmwWelcome && window.tmwWelcome.pro) {
      try { sessionStorage.setItem(GOPRO_SESSION_KEY, '1'); } catch (e) {}
      if (window.tmwWelcome.pro({ source: 'session_upsell' })) return true;
    }
    if (typeof window.tmwShowPaywall !== 'function') return false;   // paywall not ready — don't burn the session slot
    try { sessionStorage.setItem(GOPRO_SESSION_KEY, '1'); } catch (e) {}
    window.tmwShowPaywall('go-pro');
    return true;
  }

  // ── Auto-trigger — same decision tree as the article funnel ──────────────
  function run() {
    checkAuth(function (signedIn, paid) {
      if (paid) return;                              // Pro members are done
      var subEmail = subscribedEmail();
      // Anonymous with no account yet → email capture. Shows on most pages,
      // every visit, until they have an account (then signedIn flips true).
      if (!signedIn && !subEmail) { build(); return; }
      // Already a lead (email on file) or a signed-in free member → the TMW Pro
      // trial upsell, once per session. On the FIRST session after signup we let
      // the user breathe — the upsell waits 2 minutes instead of popping right
      // after the welcome. Every RETURNING visit shows it at the normal delay.
      if (goProShownThisSession()) return;
      var firstDone = false;
      try { firstDone = localStorage.getItem(GOPRO_FIRST_KEY) === '1'; } catch (e) {}
      if (firstDone) { showGoProOncePerSession(); return; }
      var gp = setTimeout(function () {
        if (showGoProOncePerSession()) { try { localStorage.setItem(GOPRO_FIRST_KEY, '1'); } catch (e) {} }
      }, GOPRO_FIRST_DELAY_MS);
      window.addEventListener('pagehide', function () { clearTimeout(gp); });
    });
  }

  var t = setTimeout(run, DELAY_MS);
  window.addEventListener('pagehide', function () { clearTimeout(t); });

  // Expose for manual invocation (e.g. a future CTA on the page).
  window.tmwSignupFunnel = { open: run, email: build, account: buildAccountMode, gopro: buildGoProMode };
})();
