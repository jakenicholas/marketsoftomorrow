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
  var MAP_URL = 'https://www.oftmw.com/map';

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

  // Identify a logged-in member to analytics from EVERY page (journal-auth is
  // universal — the dock isn't on every surface, e.g. /account or the giveaways
  // page, so relying on the dock alone left fresh signups untracked). Same guard
  // as journal-dock.js's loader so member-track.js loads exactly once per page.
  if (!document.querySelector('script[data-tmw-membertrack]')) {
    var _mt = document.createElement('script');
    _mt.src = '/_shared/member-track.js';
    _mt.defer = true;
    _mt.setAttribute('data-tmw-membertrack', '1');
    document.head.appendChild(_mt);
  }

  // Ensure the custom auth modal (Account / Articles / Watchlist tabs + the
  // signed-out login UI) is present — the profile dropdown's quick-keys and the
  // Join flow call window.tmwAuthModal. Idempotent; same guard journal-dock uses.
  if (!document.querySelector('script[src*="tmw-auth-modal.js"], script[data-tmw-authui-loader]')) {
    var am = document.createElement('script');
    am.src = '/_shared/tmw-auth-modal.js';
    am.defer = true;
    am.setAttribute('data-tmw-authui-loader', '');
    document.head.appendChild(am);
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

  // ── 1c) Funnel telemetry beacon ─────────────────────────────────────────
  //    Posts ONE funnel event to the worker's /event ingester so it lands
  //    in the D1 `events` table the Studio analytics dashboard reads.
  //    Mirrors the existing tmwTrack pattern from journal-dock.js (same
  //    anon-id key, same beacon-or-fetch fallback, same payload shape) so
  //    one query in the worker can union jrn_* + funnel events. Always
  //    fires alongside the existing gtag() calls -- gtag goes to GA4 for
  //    cross-cohort analysis, this goes to OUR D1 for the per-event
  //    funnel view we own end-to-end.
  function _tmwDid() {
    try {
      var d = localStorage.getItem('tmw_did');
      if (!d) { d = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('tmw_did', d); }
      return d;
    } catch (e) { return 'anon'; }
  }
  window.tmwFunnelTrack = function (name, props) {
    try {
      var m = window.__tmwMember || null;
      var plan = (window._isPaidMember === true) ? 'paid' : (window._tmwSignedIn === true ? 'free' : 'anon');
      var payload = JSON.stringify({
        member_id: (m && m.id) || ('anon:' + _tmwDid()),
        member_name: (m && m.name) || null,
        email: (m && m.auth && m.auth.email) || (m && m.email) || null,
        plan: plan,
        event_name: 'funnel:' + String(name).slice(0, 60),
        path: location.pathname,
        referrer: document.referrer || null,
        client_ts: Math.floor(Date.now() / 1000),
        props: Object.assign({}, props || {})
      });
      var url = 'https://tmw.jake-ab7.workers.dev/event';
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }));
      else fetch(url, { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
    } catch (e) {}
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
      '.tmw-fa-geo-item:hover{background:rgba(31,223,103,.12); color:#fff}',
      // Fourth step — the Go Pro pitch. Restyled to mirror the database
      // (.tmw-mm) dropdown's feature-row design language: round purple
      // icon containers + clean white title + muted gray description, no
      // boxy gold tiles. Title gets an animated TMW hex glyph in front
      // pulsing in purple.
      '.tmw-fa-pro-title{display:flex; align-items:center; gap:11px; margin-bottom:14px}',
      '.tmw-fa-pro-hex{flex:0 0 auto; width:30px; height:30px; display:flex; align-items:center; justify-content:center; color:#A78BFA; transform-origin:center; animation:tmwFaProHexPulse 2.8s ease-in-out infinite}',
      '.tmw-fa-pro-hex svg{width:100%; height:100%; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linejoin:round}',
      '@keyframes tmwFaProHexPulse{0%,100%{filter:drop-shadow(0 0 3px rgba(167,139,250,.45)); transform:rotate(0deg)} 50%{filter:drop-shadow(0 0 12px rgba(167,139,250,.95)); transform:rotate(180deg)}}',
      '.tmw-fa-pro-title-tx{font-family:var(--sans,"Inter",sans-serif); font-size:16.5px; font-weight:700; color:#fff; line-height:1.2; letter-spacing:-.005em}',
      '.tmw-fa-pro-list{list-style:none; margin:0 0 14px 0; padding:0; display:flex; flex-direction:column; gap:2px}',
      '.tmw-fa-pro-list li{display:flex; gap:12px; padding:9px 10px; border-radius:12px; transition:background .18s}',
      '.tmw-fa-pro-list li:hover{background:rgba(255,255,255,.04)}',
      '.tmw-fa-pro-i{flex:0 0 auto; width:34px; height:34px; border-radius:10px; display:flex; align-items:center; justify-content:center; background:rgba(167,139,250,.12); border:1px solid rgba(167,139,250,.3); color:#C4B5FD}',
      '.tmw-fa-pro-i svg{width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round}',
      '.tmw-fa-pro-tx{flex:1; min-width:0}',
      '.tmw-fa-pro-tx b{display:block; font-size:12.5px; font-weight:600; color:#fff; line-height:1.2}',
      '.tmw-fa-pro-tx i{font-style:normal; display:block; font-size:11px; color:#9AA39C; margin-top:3px; line-height:1.4}',
      // CTA: purple-violet gradient background to read as the same family
      // as the icon tiles, with a yellow "Go Pro" chip embedded (mirrors
      // the dropdown CTA pattern at .tmw-mm-cta).
      '.tmw-fa-pro-cta{box-sizing:border-box; width:100%; padding:13px 16px; border:1px solid rgba(167,139,250,.32); border-radius:12px; background:linear-gradient(120deg,rgba(167,139,250,.18),rgba(31,223,103,.06)); color:#fff; font-family:var(--sans,"Inter",sans-serif); font-size:13.5px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:12px; transition:filter .15s, border-color .15s}',
      '.tmw-fa-pro-cta:hover{filter:brightness(1.08); border-color:rgba(167,139,250,.5)}',
      '.tmw-fa-pro-cta .t{flex:1; text-align:left; font-family:var(--serif,Georgia,serif); font-weight:400; font-size:14.5px; line-height:1.25; color:#fff}',
      '.tmw-fa-pro-cta .t em{font-style:italic; color:#B9A6FF}',
      '.tmw-fa-pro-cta .go{flex:0 0 auto; font-family:var(--mono,monospace); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; font-weight:700; padding:9px 14px; border-radius:8px; background:#FFD300; color:#0a0a0a; white-space:nowrap}'
    ].join('');
    document.head.appendChild(st);
  }

  // ── 1d) Recognize an email the platform already knows ───────────────────
  //    Lets every email-capture form (home newsletter strip, footer Subscribe,
  //    article + markets pop-ups) route a KNOWN address to LOGIN ("you already
  //    have an account") instead of letting the same email be re-submitted
  //    forever. Resolves { account: bool, you?: bool }; fast-paths the signed-in
  //    member's own address, else asks the worker /email-status (works
  //    incognito). Never rejects — resolves { account:false } on any error so
  //    the form still proceeds to its normal subscribe flow.
  window.tmwCheckEmail = function (email) {
    email = String(email || '').trim().toLowerCase();
    return new Promise(function (resolve) {
      if (!email || email.indexOf('@') < 1) { resolve({ account: false }); return; }
      try {
        var mem = window.tmwAuth && window.tmwAuth.member;
        var myEmail = mem && ((mem.auth && mem.auth.email) || mem.email);
        if (window._tmwSignedIn && myEmail && String(myEmail).toLowerCase() === email) {
          resolve({ account: true, you: true }); return;
        }
      } catch (e) {}
      try {
        fetch('https://tmw.jake-ab7.workers.dev/email-status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { resolve({ account: !!(d && d.account) }); })
          .catch(function () { resolve({ account: false }); });
      } catch (e) { resolve({ account: false }); }
    });
  };

  // Render the "this email already has an account → log in" step into `host`.
  // Every email form falls back to this when tmwCheckEmail reports an account,
  // so a known address never gets re-subscribed. opts.you = the visitor's own
  // (signed-in) address.
  window.tmwAccountExistsPrompt = function (host, opts) {
    if (!host) return false;
    opts = opts || {};
    injectFaCss();
    host.innerHTML =
      '<div class="tmw-fa">' +
        '<div class="tmw-fa-h">' + (opts.you ? 'You already have an account.' : 'This email already has an account.') + '</div>' +
        '<div class="tmw-fa-sub">Log in to pick up your watchlist, follows, and Pro features — no need to sign up again.</div>' +
        '<div class="tmw-fa-prof"><button type="button" class="tmw-fa-login">Log in →</button></div>' +
      '</div>';
    host.querySelector('.tmw-fa-login').addEventListener('click', function () {
      var m = window.$memberstackDom;
      if (m && m.openModal) m.openModal('LOGIN').then(function () { try { m.hideModal(); } catch (_) {} }).catch(function () {});
    });
    return true;
  };

  // Render the "add a password for a free account" step into `host`. Returns
  // false (does nothing) if the visitor is already signed in. onClose(created?)
  // fires when the user finishes or skips. opts.alreadyLive reframes the copy
  // for an email we already had on the newsletter list ("your email is already
  // live — create a password").
  window.tmwFreeAccountPrompt = function (host, email, onClose, opts) {
    if (!host || window._tmwSignedIn) return false;
    opts = opts || {};
    injectFaCss();
    host.innerHTML =
      '<div class="tmw-fa">' +
        '<div class="tmw-fa-h">' + (opts.alreadyLive ? 'Your email’s already live — create a password' : 'You’re in — create your account') + '</div>' +
        '<div class="tmw-fa-sub">' + (opts.alreadyLive
          ? 'We found your subscription. Add a password to turn it into a free account — follow projects and build a watchlist.'
          : 'Your email’s already set. Add a password to follow projects, build a watchlist, and pick up where you left off.') + '</div>' +
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
          try { window.tmwFunnelTrack && window.tmwFunnelTrack('free_account_created', { source: 'newsletter' }); } catch (_) {}
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
    // "Finish" or "Skip for now" both chain into Step 4 (Go Pro pitch)
    // -- the upgrade nudge should fire whether or not the user filled in
    // their profile details. tmwGoProStep is responsible for the final
    // onClose, so this function is just the bridge from this step to it.
    function finish() { window.tmwGoProStep(host, onClose); }
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
        try { window.tmwFunnelTrack && window.tmwFunnelTrack('profile_completed', { source: 'newsletter' }); } catch (_) {}
        form.style.display = 'none'; skip.style.display = 'none';
        msg.className = 'tmw-fa-msg ok'; msg.textContent = '✓ You’re all set. Welcome to Markets of Tomorrow.';
        // Step 4: Go Pro pitch (non-Pro only). After the welcome message
        // sits for a beat, swap the host's content for the upgrade
        // pitch instead of closing -- tmwGoProStep is responsible for
        // calling onClose when the user accepts or skips.
        setTimeout(function () { window.tmwGoProStep(host, onClose); }, 1500);
      });
    });
  };

  // Step 4 (final): the Go Pro pitch. Always runs for fresh signups since
  // the funnel reaches here right after free-account creation. A safety
  // check for _isPaidMember short-circuits in the unlikely case the user
  // is somehow already Pro by this point.
  window.tmwGoProStep = function (host, onClose) {
    if (!host) { if (typeof onClose === 'function') onClose(true); return; }
    if (window._isPaidMember === true) { if (typeof onClose === 'function') onClose(true); return; }
    injectFaCss();
    // SVGs reused from the universal header's Map/Database dropdown so
    // each feature row reads as the same thing the user can see in the
    // nav. Stroke + size are inherited from .tmw-fa-pro-i svg.
    var SVG_HEX  = '<svg viewBox="0 0 24 24"><polygon points="12,4.3 18.65,8.16 18.65,15.84 12,19.68 5.35,15.84 5.35,8.16"/></svg>';
    var SVG_EYE  = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    var SVG_CMP  = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/></svg>';
    var SVG_PUL  = '<svg viewBox="0 0 24 24"><path d="M3 12h4l2 6 4-14 2 8h6"/></svg>';
    var SVG_MAP  = '<svg viewBox="0 0 24 24"><path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"/><path d="M9 3v15M15 6v15"/></svg>';
    var SVG_ATL  = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
    function row(svg, title, desc) {
      return '<li><span class="tmw-fa-pro-i">' + svg + '</span>' +
        '<span class="tmw-fa-pro-tx"><b>' + title + '</b><i>' + desc + '</i></span></li>';
    }
    host.innerHTML =
      '<div class="tmw-fa tmw-fa-pro">' +
        '<div class="tmw-fa-pro-title">' +
          '<span class="tmw-fa-pro-hex">' + SVG_HEX + '</span>' +
          '<span class="tmw-fa-pro-title-tx">Unlock TMW Pro + Intelligence</span>' +
        '</div>' +
        '<ul class="tmw-fa-pro-list">' +
          row(SVG_HEX, 'TMW Intelligence', 'Completion forecasts, unlimited AI-powered search, and project research on every page.') +
          row(SVG_EYE, 'Watchlist',        'Track projects, get notified the moment they move.') +
          row(SVG_CMP, 'Compare',          'Stack any projects side-by-side &mdash; units, timeline, firms.') +
          row(SVG_PUL, 'Pulse',            'Live feed of every new project hitting the database.') +
          row(SVG_MAP, 'Interactive Map',  '396 projects across 40+ markets.') +
          row(SVG_ATL, 'The Atlas',        'Every tracked project on one canvas.') +
        '</ul>' +
        '<button class="tmw-fa-pro-cta" type="button">' +
          '<span class="t">Explore the journal free. <em>Go Pro for the intelligence.</em></span>' +
          '<span class="go">Go Pro →</span>' +
        '</button>' +
        '<button class="tmw-fa-skip" type="button">Continue with free</button>' +
      '</div>';
    var cta = host.querySelector('.tmw-fa-pro-cta');
    var skip = host.querySelector('.tmw-fa-skip');
    function done() { if (typeof onClose === 'function') onClose(true); }
    skip.addEventListener('click', function () {
      try { if (window.gtag) window.gtag('event', 'go_pro_skipped', { source: 'article_funnel' }); } catch (_) {}
      try { window.tmwFunnelTrack && window.tmwFunnelTrack('go_pro_skipped', { source: 'article_funnel' }); } catch (_) {}
      done();
    });
    cta.addEventListener('click', function () {
      try { if (window.gtag) window.gtag('event', 'go_pro_clicked', { source: 'article_funnel' }); } catch (_) {}
      try { window.tmwFunnelTrack && window.tmwFunnelTrack('go_pro_clicked', { source: 'article_funnel' }); } catch (_) {}
      // Close the funnel host FIRST so the paywall doesn't stack on top
      // of the article lightbox; then trigger the in-page paywall (or
      // deep-link to the map upgrade flow as a fallback).
      done();
      setTimeout(function () {
        if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall('go-pro');
        else location.href = 'https://www.oftmw.com/map/?upgrade=1';
      }, 120);
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
      // Our own fixed overlays (subscribe lightbox, custom auth modal) have
      // email/password inputs but are NOT Memberstack modals — never tag them,
      // or the MS theme overrides their styling.
      if (el.classList && (el.classList.contains('tmw-sub') || el.classList.contains('tmw-am'))) return false;
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
         profile). The old "GO PRO" pill that sat next to the profile icon is
         GONE -- the CTA is now the top item inside the account dropdown
         (.v2-menu-pro below), so it no longer crowds the cluster at any width. */
      '@media(max-width:980px){.tmw-auth .nav-cta.tmw-ig, .tmw-auth-ig{display:none !important}}',
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
      /* Go Pro = the first dropdown item, gold-accented so it reads as the
         conversion CTA. Hidden by default; the :has() rule below reveals it
         ONLY when the profile is signed-in-but-not-Pro. Pro members never
         see it. Signed-out users see it too (they hit the Join modal
         first; once they sign up free we want the upgrade nudge available
         in their dropdown next session). */
      '.tmw-auth .v2-profile-menu .v2-menu-pro{display:none;color:#FFD300;font-weight:700;background:rgba(255,211,0,0.06)}',
      '.tmw-auth .v2-profile-menu .v2-menu-pro svg{opacity:1;color:#FFD300;fill:none;stroke:#FFD300}',
      '.tmw-auth .v2-profile-menu .v2-menu-pro:hover{background:rgba(255,211,0,0.14);color:#FFE266}',
      '.tmw-auth:has(.v2-profile-btn.signed-in:not(.is-pro)) .v2-profile-menu .v2-menu-pro{display:flex}',
      '.tmw-auth .v2-profile-menu{position:absolute;top:calc(100% + 8px);right:0;left:auto;min-width:220px;background:rgba(20,20,20,0.96);backdrop-filter:blur(28px) saturate(1.4);-webkit-backdrop-filter:blur(28px) saturate(1.4);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:6px;box-shadow:0 16px 40px rgba(0,0,0,0.5);display:none;z-index:10000}',
      '.tmw-auth .v2-profile-menu.open{display:block}',
      '.tmw-auth .v2-profile-menu .v2-menu-item{display:flex;align-items:center;gap:12px;padding:10px 12px;color:rgba(255,255,255,0.85);font-size:14px;font-weight:500;cursor:pointer;border-radius:8px;background:transparent;border:none;width:100%;text-align:left;font-family:inherit;text-decoration:none}',
      '.tmw-auth .v2-profile-menu .v2-menu-item:hover{background:rgba(255,255,255,0.06);color:#fff}',
      '.tmw-auth .v2-profile-menu .v2-menu-item svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;opacity:.7}',
      '.tmw-auth .v2-profile-menu .v2-menu-divider{height:1px;background:rgba(255,255,255,0.08);margin:6px 4px}',
      '.tmw-auth .v2-profile-menu .v2-menu-signout{color:rgba(255,120,120,0.9)}',
      '.tmw-auth .v2-profile-menu .v2-menu-signout:hover{background:rgba(255,80,80,0.08);color:#ff6464}',
      '.tmw-auth .v2-menu-label{flex:0 1 auto}',
      // Yellow PRO tag, right-aligned inside the Account row — shown for Pro members.
      '.tmw-auth .v2-profile-menu .v2-account-pro{display:none;font-style:normal;font-size:8px;font-weight:800;color:#0a0a0a;background:#FFD300;padding:1px 5px;border-radius:4px;margin-left:auto;letter-spacing:.06em;line-height:1.5}',
      '.tmw-auth .v2-profile-menu .v2-account-pro.show{display:inline-block}',
      // Watchlist quick-key: grayed for free members, with a small PRO tag.
      '.tmw-auth .v2-profile-menu .v2-menu-watch .v2-menu-protag{display:none;font-style:normal;font-size:8px;font-weight:800;color:#0a0a0a;background:#FFD300;padding:1px 5px;border-radius:4px;margin-left:auto;letter-spacing:.06em;line-height:1.5}',
      '.tmw-auth .v2-profile-menu .v2-menu-watch.is-locked{opacity:.5}',
      '.tmw-auth .v2-profile-menu .v2-menu-watch.is-locked .v2-menu-protag{display:inline-block}'
    ]
      // Make the shared account/Join cluster authoritative on EVERY surface:
      // double the leading `.tmw-auth` class so these rules out-specify any
      // page's own overrides (e.g. the map's legacy `body.ui-v2 .v2-profile-btn`
      // / `.v2-go-pro-badge`, which used to hijack the GO PRO + profile styling
      // there). Same element, just higher specificity — no visual change where
      // there's nothing to override.
      .map(function (r) { return r.replace(/(^|,|\{)(\s*)\.tmw-auth(?![\w-])/g, '$1$2.tmw-auth.tmw-auth'); })
      .join('');
    var st = document.createElement('style'); st.id = 'tmw-auth-styles'; st.textContent = css; document.head.appendChild(st);
  }

  // ── 4) Helpers ──────────────────────────────────────────────────────────
  function isPaid(member) {
    var plans = (member && member.planConnections) || [];
    return plans.some(function (p) { return p.active === true || p.status === 'ACTIVE'; });
  }

  // ── Single source of truth for auth across every surface ────────────────
  // journal-auth is the authoritative Memberstack detector and mounts on every
  // page (including /map/). Other surfaces (the map's paywall, the dock's
  // Intelligence quota via window.tmwIntel.isPro) should READ this rather than
  // re-detecting Memberstack themselves — that duplication is what caused the
  // Pro-lockout / wrong-modal collisions. publishAuth() is the ONE place that
  // writes the legacy globals AND the clean window.tmwAuth API + notifies subs.
  var _authSubs = [];
  window.tmwAuth = window.tmwAuth || {
    signedIn: false, paid: false, member: null, ready: false,
    _menuItems: [],
    // Subscribe to auth changes. Fires immediately if state is already known.
    onChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      _authSubs.push(cb);
      if (this.ready) { try { cb(this); } catch (e) {} }
      return function () { var i = _authSubs.indexOf(cb); if (i >= 0) _authSubs.splice(i, 1); };
    },
    // Force a fresh Memberstack re-detect (e.g. after a plan change).
    refresh: function () {
      try { var m = window.$memberstackDom; if (m) m.getCurrentMember().then(function (r) { publishAuth(r && r.data); }); } catch (e) {}
    },
    // Inject an item into the SHARED profile dropdown so a surface (the map)
    // extends the ONE universal menu instead of maintaining a parallel widget.
    //   item = { id, label, icon (svg html), onClick(fn), proOnly(bool) }
    // Items render between "Account" and the divider, above "Sign out".
    addMenuItem: function (item) {
      if (!item || !item.id) return;
      if (!this._menuItems.some(function (m) { return m.id === item.id; })) this._menuItems.push(item);
      var menus = document.querySelectorAll('.tmw-auth .v2-profile-menu');
      for (var i = 0; i < menus.length; i++) renderExtraMenuItems(menus[i]);
    }
  };
  function publishAuth(member) {
    var signedIn = !!member;
    var paid = signedIn && isPaid(member);
    // Legacy globals other code already reads (tmwIntel.isPro, compare.js,
    // the map paywall, cross-page pre-paint). Unchanged values/keys.
    window._tmwSignedIn = signedIn;
    window._isPaidMember = paid;
    try { localStorage.setItem('tmw_auth_state', paid ? 'pro' : signedIn ? 'in' : 'out'); } catch (_) {}
    // Clean shared API for new consumers.
    var a = window.tmwAuth;
    a.signedIn = signedIn; a.paid = paid; a.member = member || null; a.ready = true;
    try { document.documentElement.classList.toggle('tmw-paid', paid); } catch (_) {}
    for (var i = 0; i < _authSubs.length; i++) { try { _authSubs[i](a); } catch (e) {} }
  }

  // Render registered extension items into a profile menu (between Account and
  // the divider), wire their handlers, and reflect proOnly visibility. Idempotent.
  function renderExtraMenuItems(menu) {
    if (!menu || !window.tmwAuth || !window.tmwAuth._menuItems) return;
    var divider = menu.querySelector('.v2-menu-divider');
    window.tmwAuth._menuItems.forEach(function (it) {
      if (menu.querySelector('[data-tmw-ext="' + it.id + '"]')) return; // already present
      var b = document.createElement('button');
      b.className = 'v2-menu-item';
      b.setAttribute('role', 'menuitem');
      b.setAttribute('data-tmw-ext', it.id);
      if (it.proOnly) b.setAttribute('data-pro-only', '');
      b.innerHTML = (it.icon || '') + esc(it.label || '');
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        menu.classList.remove('open');
        try { it.onClick && it.onClick(e); } catch (err) {}
      });
      if (divider && divider.parentNode === menu) menu.insertBefore(b, divider);
      else menu.appendChild(b);
    });
    syncExtraMenuVisibility(menu);
  }
  function syncExtraMenuVisibility(menu) {
    var paid = !!(window.tmwAuth && window.tmwAuth.paid);
    var items = (menu || document).querySelectorAll('[data-tmw-ext][data-pro-only]');
    for (var i = 0; i < items.length; i++) items[i].style.display = paid ? '' : 'none';
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
      // GO PRO pill removed from the header per design. The CTA lives INSIDE the
      // dropdown below as the gold first item; applyState() shows it for signed-in
      // non-Pro members only (inline display beats the CSS so Pro never sees it).
      // Pro members instead get a yellow PRO tag right-aligned on the Account row.
      '<div class="v2-profile-menu" role="menu">' +
        '<button class="v2-menu-item v2-menu-pro" data-act="go-pro" role="menuitem">' +
          '<svg viewBox="0 0 24 24"><polygon points="13 2 4 14 11 14 9 22 20 10 13 10 15 2"/></svg>' +
          'Go Pro' +
        '</button>' +
        '<button class="v2-menu-item" data-act="account" role="menuitem"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>Account<em class="v2-account-pro">PRO</em></button>' +
        '<button class="v2-menu-item" data-act="articles" role="menuitem"><svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>Articles</button>' +
        '<button class="v2-menu-item v2-menu-watch" data-act="watchlist" role="menuitem"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>Watchlist<em class="v2-menu-protag">PRO</em></button>' +
        '<div class="v2-menu-divider"></div>' +
        '<button class="v2-menu-item v2-menu-signout" data-act="signout" role="menuitem"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>Sign out</button>' +
      '</div>';

    var btn = host.querySelector('.v2-profile-btn');
    var menu = host.querySelector('.v2-profile-menu');
    var goPro = host.querySelector('[data-act="go-pro"]');
    var accountProTag = host.querySelector('.v2-account-pro');
    var watchItem = host.querySelector('[data-act="watchlist"]');
    // Inject any extension items a surface registered (the map's Watchlist/Compare)
    // so this ONE shared menu carries them too.
    renderExtraMenuItems(menu);

    // Pre-paint from the cached auth state (written by applyState on the last
    // load) so a returning member sees their avatar immediately instead of a
    // "Join" pill that flips to the avatar once Memberstack resolves async — the
    // flash. Memberstack still confirms via applyState() and corrects if stale.
    try {
      var cached = localStorage.getItem('tmw_auth_state');
      try { document.documentElement.classList.toggle('tmw-paid', cached === 'pro'); } catch (_) {}
      if (cached === 'in' || cached === 'pro') {
        btn.classList.add('signed-in');
        if (cached === 'pro') {
          btn.classList.add('is-pro');
          if (accountProTag) accountProTag.classList.add('show');
          goPro.style.display = 'none';
        } else {
          goPro.style.display = 'flex';
          if (watchItem) watchItem.classList.add('is-locked');
        }
        btn.setAttribute('aria-label', 'Profile menu');
      }
    } catch (_) {}

    function ms() { return window.$memberstackDom; }

    // Repaint the button from the current auth state.
    function applyState(member) {
      var signedIn = !!member;
      var paid = signedIn && isPaid(member);
      btn.classList.toggle('signed-in', signedIn);
      btn.classList.toggle('is-pro', paid);
      btn.setAttribute('aria-label', signedIn ? 'Profile menu' : 'Join');
      // Account-row PRO tag + Go Pro item + watchlist lock all follow paid state.
      // Inline display on Go Pro beats the stylesheet so a Pro member never
      // sees it, and a signed-in free member always does (regardless of :has()).
      if (accountProTag) accountProTag.classList.toggle('show', paid);
      goPro.style.display = (signedIn && !paid) ? 'flex' : 'none';
      if (watchItem) watchItem.classList.toggle('is-locked', !paid);
      if (!signedIn) menu.classList.remove('open');
      syncExtraMenuVisibility(menu);   // proOnly extension items follow paid state
      // Publish to the single source of truth: writes window._tmwSignedIn /
      // window._isPaidMember / localStorage.tmw_auth_state (read by the dock's
      // Intelligence quota, compare.js, the map paywall) and the window.tmwAuth
      // API + notifies subscribers.
      publishAuth(member);
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
      // Custom TMW login/signup modal; fall back to Memberstack's own if it
      // hasn't loaded yet.
      if (typeof window.tmwAuthModal === 'function') { window.tmwAuthModal('signup'); return; }
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
      menu.classList.remove('open');
      // Native in-page paywall; fall back to the map deep-link if it hasn't loaded.
      if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall('go-pro');
      else location.href = MAP_URL + '/?upgrade=1';
    });
    // Quick-keys → open the account modal on the matching tab. Articles (saved
    // reads) is free; Watchlist is a Pro feature — the item is grayed for free
    // members and its modal tab shows the lock + upgrade.
    var articlesItem = host.querySelector('[data-act="articles"]');
    if (articlesItem) articlesItem.addEventListener('click', function (e) {
      e.stopPropagation(); menu.classList.remove('open');
      if (typeof window.tmwAuthModal === 'function') window.tmwAuthModal('articles');
    });
    if (watchItem) watchItem.addEventListener('click', function (e) {
      e.stopPropagation(); menu.classList.remove('open');
      if (typeof window.tmwAuthModal === 'function') window.tmwAuthModal('watchlist');
    });
    host.querySelector('[data-act="account"]').addEventListener('click', function (e) {
      e.stopPropagation(); menu.classList.remove('open');
      if (typeof window.tmwAuthModal === 'function') { window.tmwAuthModal('profile'); return; }
      try {
        var m = ms();
        if (m) m.openModal('PROFILE').then(function () { try { m.hideModal(); } catch (_) {} refresh(); }).catch(function () {});
      } catch (_) {}
    });
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
