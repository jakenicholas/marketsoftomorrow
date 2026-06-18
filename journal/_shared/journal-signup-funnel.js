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
  var DELAY_MS = OPTS.delayMs || 3000;
  var SOURCE = OPTS.source || 'market_page';
  var EYEBROW = OPTS.eyebrow || 'The Future Is Here';
  var HEADLINE = OPTS.headline || 'Track tomorrow\'s developments with TMW Intelligence — forecasts, data, and updates.';

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
      '.tmw-sub-eyebrow{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10.5px;letter-spacing:.26em;text-transform:uppercase;color:#f0d68a;text-shadow:0 0 12px rgba(230,197,116,.4);margin-bottom:12px}' +
      '.tmw-sub-h{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:clamp(20px,2.6vw,27px);line-height:1.16;color:#fff;max-width:34ch;margin:0 0 18px}' +
      '.tmw-sub-form{display:flex;gap:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:7px 7px 7px 22px;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:border-color .2s}' +
      '.tmw-sub-form:focus-within{border-color:#1FDF67}' +
      '.tmw-sub-form input{flex:1;border:0;outline:0;background:transparent;font-family:"Inter",sans-serif;font-size:14px;color:#fff;min-width:0;height:auto;padding:0}' +
      '.tmw-sub-form input::placeholder{color:#9AA39C}' +
      '.tmw-sub-form button{flex:0 0 auto;background:#1FDF67;color:#0a0a0a;padding:12px 22px;border:0;border-radius:999px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .2s}' +
      '.tmw-sub-form button:hover{background:#42EB81}' +
      '.tmw-sub-form button:disabled{opacity:.6;cursor:wait}' +
      '.tmw-sub-msg{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13.5px;letter-spacing:.04em;color:#1FDF67;margin-top:14px}' +
      '@media(max-width:560px){.tmw-sub{padding:0 8px 8px}.tmw-sub-panel{padding:22px 18px 20px}.tmw-sub-form{padding:6px 6px 6px 18px}.tmw-sub-form button{padding:11px 16px}}';
    var st = document.createElement('style'); st.id = 'tmw-funnel-css'; st.textContent = css; document.head.appendChild(st);
  }

  // ── Step 1: email subscribe form (first-time anon visitor) ───────────────
  function build() {
    if (document.querySelector('.tmw-sub')) return;     // max one at a time
    var el = document.createElement('div');
    el.className = 'tmw-sub';
    el.innerHTML =
      '<div class="tmw-sub-panel" role="dialog" aria-label="Create your TMW account">' +
        '<button class="tmw-sub-x" aria-label="Close">&times;</button>' +
        '<div class="tmw-sub-eyebrow">' + esc(EYEBROW) + '</div>' +
        '<h3 class="tmw-sub-h">' + esc(HEADLINE) + '</h3>' +
        '<form class="tmw-sub-form">' +
          '<input type="email" name="email" placeholder="you@example.com" autocomplete="email" required>' +
          '<button type="submit">Get Access</button>' +
        '</form>' +
        '<div class="tmw-sub-msg" aria-live="polite"></div>' +
      '</div>';
    document.body.appendChild(el);

    function close() { el.classList.remove('show'); }
    el.querySelector('.tmw-sub-x').addEventListener('click', close);
    el.addEventListener('click', function (e) { if (e.target === el) close(); });

    var form = el.querySelector('.tmw-sub-form');
    var msg = el.querySelector('.tmw-sub-msg');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = (form.email.value || '').trim();
      if (!email) return;
      var btn = form.querySelector('button'); var orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Working…';
      try {
        var r = await fetch(SUB_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, markets: MARKETS }) });
        var d = await r.json().catch(function () { return {}; });
        if (d && d.success) {
          try { if (window.gtag) window.gtag('event', 'subscribe_market'); } catch (_) {}
          try { window.tmwFunnelTrack && window.tmwFunnelTrack('subscribe_market', { email: email, source: SOURCE }); } catch (_) {}
          mark('subscribed');
          try { localStorage.setItem(SUB_EMAIL_KEY, email); } catch (_) {}
          // Step 2: offer a free account (add a password) — the SAME prompt the
          // article funnel uses, so the next page picks up where they left off.
          var panel = el.querySelector('.tmw-sub-panel');
          ['.tmw-sub-eyebrow', '.tmw-sub-h', '.tmw-sub-form', '.tmw-sub-msg'].forEach(function (sel) { var n = panel.querySelector(sel); if (n) n.style.display = 'none'; });
          var faHost = document.createElement('div'); panel.appendChild(faHost);
          var offered = window.tmwFreeAccountPrompt && window.tmwFreeAccountPrompt(faHost, email, function () { el.classList.remove('show'); });
          if (!offered) {
            msg.style.display = ''; msg.textContent = "✓ You're in! Welcome to TMW.";
            setTimeout(function () { el.classList.remove('show'); }, 2600);
          }
        } else { btn.disabled = false; btn.textContent = orig; }
      } catch (err) { btn.disabled = false; btn.textContent = orig; }
    });

    requestAnimationFrame(function () { el.classList.add('show'); });
  }

  // ── Step 2 directly: a returning subscriber (email already known) gets the
  //    "add a password" step, NOT re-asked to subscribe. ─────────────────────
  function buildAccountMode(email) {
    if (window._tmwSignedIn === true) return false;
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

  // ── Auto-trigger — same decision tree as the article funnel ──────────────
  function run() {
    checkAuth(function (signedIn, paid) {
      if (paid) return;                              // Pro members are done
      if (signedIn) { buildGoProMode(); return; }    // free member → Go-Pro pitch
      var subEmail = subscribedEmail();
      if (subEmail) {                                // subscribed, no account → password step
        try { if (sessionStorage.getItem('tmw-acct-skip')) return; } catch (e) {}
        buildAccountMode(subEmail);
      } else {
        build();                                     // first-timer → email form
      }
    });
  }

  var t = setTimeout(run, DELAY_MS);
  window.addEventListener('pagehide', function () { clearTimeout(t); });

  // Expose for manual invocation (e.g. a future CTA on the page).
  window.tmwSignupFunnel = { open: run, email: build, account: buildAccountMode, gopro: buildGoProMode };
})();
