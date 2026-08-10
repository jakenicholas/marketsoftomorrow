/* =====================================================================
   tmw-welcome.js — the full-screen, app-grade welcome flow ("Cinematic").

   Replaces the slide-up lightbox funnel with three full-screen moments:
     GATE      — create a free account to continue (email + password over a
                 rotating full-bleed project slideshow)
     MEMBER #  — the Blueprint member-number celebration, right after signup
     GO PRO    — the trial pitch with the two plans ($32/mo, $300/yr)

   Mockup this shipped from: /mockups/welcome-v1/ (direction A).

   Public API (all return true when the screen was shown):
     window.tmwWelcome.gate(opts)   opts: { email, source }
                                    email prefills the address (returning lead)
     window.tmwWelcome.pro(opts)    standalone Go-Pro screen (returning free
                                    member); opts: { source }
     window.tmwWelcome.close()

   Reuses the funnel's existing plumbing — window.tmwCreateFreeAccount for
   signup, the newsletter subscribe endpoint, tmwFunnelTrack beacons, the same
   localStorage keys — so the decision tree in journal-signup-funnel.js keeps
   working unchanged; only the RENDERING is elevated. Checkout goes through
   window.tmwProCheckout (exported by journal-paywall.js) so trial-eligibility,
   grandfathered pricing, and the signup fallback stay single-sourced.
   ===================================================================== */
(function () {
  'use strict';
  if (window.tmwWelcome) return;

  var SUB_ENDPOINT = 'https://tmw-subscribe.jake-ab7.workers.dev';
  var WORKER = 'https://tmw.jake-ab7.workers.dev';
  var MARKETS = ['florida', 'tennessee', 'newyork', 'caribbean', 'rockies', 'hotel'];
  var KEY = 'tmw-sub-lightbox-v1';
  var SUB_EMAIL_KEY = 'tmw-sub-email';
  // Same trial price ids as journal-paywall.js (2026-08 lineup).
  var PRICE_MONTHLY = 'prc_pro-monthly-2026-08--rewl0anz';
  var PRICE_ANNUAL = 'prc_pro-annual-trial-2026-08--rast0ag0';
  var IMGS = [
    'https://media.oftmw.com/wix/ca3b83_07e4600c7eb745c28897b90cbab6d7ff~mv2.jpeg',
    'https://media.oftmw.com/2026/08/6940d5419dd3-Martis-3-wide.jpg',
    'https://media.oftmw.com/wix/ca3b83_9a497901ced54548b083a156b3171fc8~mv2.jpg',
    'https://media.oftmw.com/miami/waldorf-astoria-residences-miami.jpeg',
    'https://media.oftmw.com/2026/07/7ab0cbb6d61f-macarthur-place-grounds.jpg',
    'https://media.oftmw.com/wix/ca3b83_829dcd8c0fc34ce3be4be20101831d64~mv2.webp'
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ── fonts (bring-your-own, same rule as the funnel) ───────────────────
  function ensureFonts() {
    var head = document.head.innerHTML;
    if (document.getElementById('tmw-welcome-fonts')) return;
    if (/family=Fraunces/.test(head) || /font-family:\s*['"]?Fraunces/i.test(head)) return;
    var l = document.createElement('link');
    l.id = 'tmw-welcome-fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=Inter:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(l);
  }

  // ── CSS ────────────────────────────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('tmw-welcome-css')) return;
    var css = [
      '.tmww{position:fixed;inset:0;z-index:99990;background:#050605;color:#ECEAE5;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased;opacity:0;transition:opacity .4s ease}',
      '.tmww.show{opacity:1}',
      /* GL-heavy map page stalls transitions/animations at their start frame —
         the overlay was opening INVISIBLE there (a "dead click"). Instant mode. */
      '.tmww.instant{transition:none}',
      '.tmww.instant .bg img{transition:none}',
      '.tmww.instant .scr.on{animation:none}',
      '.tmww .bg{position:absolute;inset:0}',
      '.tmww .bg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 1.4s ease}',
      '.tmww .bg img.on{opacity:1}',
      '.tmww .bg::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(5,6,5,.96) 0%,rgba(5,6,5,.72) 34%,rgba(5,6,5,.28) 62%,rgba(5,6,5,.48) 100%)}',
      '.tmww .skip{position:absolute;top:calc(16px + env(safe-area-inset-top));right:18px;z-index:6;font:600 11px/1 "Inter",sans-serif;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.6);background:rgba(8,8,8,.4);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:10px 16px;cursor:pointer;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
      '.tmww .skip:hover{color:#fff}',
      '.tmww .scr{position:absolute;inset:0;z-index:2;display:none}',
      '.tmww .scr.on{display:block;animation:tmwwIn .45s ease both}',
      '@keyframes tmwwIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}',
      '.tmww .wm{display:flex;align-items:center}',
      '.tmww .wm img{height:56px;width:auto;display:block;filter:brightness(0) invert(1)}',
      '.tmww .in{width:100%;height:52px;border-radius:13px;border:1px solid rgba(255,255,255,.16);background:rgba(10,11,10,.6);color:#fff;padding:0 16px;font-size:15px;font-family:inherit;outline:none;transition:border-color .15s;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}',
      '.tmww .in:focus{border-color:#A78BFA}',
      '.tmww .in::placeholder{color:#7b847c}',
      '.tmww .cta{width:100%;height:54px;border-radius:14px;border:0;background:#1FDF67;color:#04210f;font:800 13px/1 "Inter",sans-serif;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;transition:filter .15s,transform .12s}',
      '.tmww .cta:hover{filter:brightness(1.06)}',
      '.tmww .cta:active{transform:scale(.99)}',
      '.tmww .cta:disabled{opacity:.6;cursor:wait}',
      '.tmww .cta.purple{background:linear-gradient(120deg,#A78BFA,#8b6ff0);color:#0d0618;box-shadow:0 0 26px rgba(167,139,250,.4)}',
      '.tmww .cta.alt{background:transparent;border:1px solid rgba(255,255,255,.16);color:#C2C9C3;font-weight:700}',
      '.tmww .fine{font-size:11.5px;color:#9AA39C;line-height:1.55}',
      '.tmww .fine a{color:#C4B5FD;text-decoration:none;font-weight:600;cursor:pointer}',
      '.tmww .msg{font-size:13px;color:#1FDF67;min-height:18px;margin-top:10px}',
      '.tmww .msg.err{color:#ff8a8a}',
      '.tmww .msg a{color:#C4B5FD;font-weight:600;cursor:pointer;text-decoration:underline}',
      /* GATE */
      '.tmww .g-inner{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:26px clamp(22px,6vw,70px) 40px;max-width:660px}',
      '.tmww .g-inner .wm{margin-bottom:auto;padding-top:env(safe-area-inset-top)}',
      '.tmww .g-h{font-family:"Fraunces",Georgia,serif;font-weight:400;font-size:clamp(30px,4.2vw,50px);line-height:1.06;letter-spacing:-.015em;color:#fff;text-wrap:balance}',
      '.tmww .g-h em{font-style:italic;color:#C4B5FD}',
      '.tmww .g-sub{font-size:14.5px;color:#C2C9C3;line-height:1.6;margin:14px 0 22px;max-width:46ch}',
      '.tmww .g-form{display:flex;flex-direction:column;gap:10px;max-width:430px}',
      '.tmww .g-row{display:flex;gap:10px}',
      '.tmww .g-row .in{flex:1;min-width:0}',
      '.tmww .g-fine{margin-top:10px}',
      '.tmww .g-ticker{position:absolute;right:clamp(22px,5vw,58px);bottom:44px;z-index:3;text-align:right;display:flex;flex-direction:column;gap:16px}',
      '.tmww .tk .v{font-family:"Fraunces",Georgia,serif;font-size:clamp(22px,2.6vw,34px);font-weight:600;color:#fff;line-height:1}',
      '.tmww .tk .k{font-size:9.5px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#9AA39C;margin-top:5px}',
      '@media(max-width:760px){.tmww .g-ticker{display:none}.tmww .g-row{flex-direction:column}.tmww .g-inner{padding:28px 22px 28px}}',
      /* CELEBRATE + PRO shared center layout */
      '.tmww .c-wrap{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:44px 24px;text-align:center;overflow-y:auto}',
      '.tmww .eyeb{font-size:10.5px;font-weight:800;letter-spacing:.3em;text-transform:uppercase;margin-bottom:16px}',
      '.tmww .eyeb.gold{color:#f0d68a}',
      '.tmww .eyeb.purple{color:#C4B5FD;animation:tmwwGlow 2.4s ease-in-out infinite}',
      '@keyframes tmwwGlow{0%,100%{text-shadow:0 0 6px rgba(167,139,250,.4)}50%{text-shadow:0 0 16px rgba(167,139,250,.85)}}',
      '.tmww .c-num{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:clamp(48px,8vw,88px);line-height:1;color:#fff;letter-spacing:-.02em}',
      '.tmww .c-num i{font-style:normal;color:#C4B5FD;text-shadow:0 0 34px rgba(167,139,250,.55)}',
      '.tmww .c-sub{font-size:15px;color:#C2C9C3;line-height:1.65;margin:18px 0 32px;max-width:48ch}',
      '.tmww .c-sub b{color:#fff;font-weight:600}',
      '.tmww .c-form{width:min(380px,100%);display:flex;flex-direction:column;gap:10px}',
      '.tmww .ring{position:absolute;left:50%;top:40%;width:340px;height:340px;transform:translate(-50%,-50%);border-radius:50%;border:1px solid rgba(167,139,250,.2);animation:tmwwRing 3.2s ease-in-out infinite;pointer-events:none}',
      '@keyframes tmwwRing{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.5}50%{transform:translate(-50%,-50%) scale(1.08);opacity:1}}',
      /* PRO */
      '.tmww .p-h{font-family:"Fraunces",Georgia,serif;font-weight:400;font-size:clamp(28px,3.8vw,46px);line-height:1.08;color:#fff;max-width:20ch;text-wrap:balance}',
      '.tmww .p-sub{font-size:14.5px;color:#C2C9C3;line-height:1.6;margin:14px 0 26px;max-width:50ch}',
      '.tmww .plans{display:flex;gap:12px;width:min(560px,100%);margin-bottom:14px}',
      '.tmww .plan{flex:1;text-align:left;padding:18px;border-radius:16px;border:1.5px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);cursor:pointer;transition:border-color .15s,background .15s;color:#fff;font-family:inherit;position:relative}',
      '.tmww .plan.sel{border-color:#A78BFA;background:rgba(167,139,250,.1);box-shadow:0 0 22px rgba(167,139,250,.3)}',
      '.tmww .plan .nm{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:6px}',
      '.tmww .plan .pr{font-size:24px;font-weight:700;line-height:1}',
      '.tmww .plan .pr small{font-size:12px;font-weight:500;color:rgba(255,255,255,.5)}',
      '.tmww .plan .nt{font-size:10.5px;color:rgba(255,255,255,.55);margin-top:6px}',
      '.tmww .plan .tag{position:absolute;top:-9px;right:12px;background:#A78BFA;color:#0d0d0d;font-size:8.5px;font-weight:800;letter-spacing:.08em;padding:3px 8px;border-radius:20px}',
      '.tmww .p-feat{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin:4px 0 20px;max-width:560px}',
      '.tmww .p-ft{display:flex;align-items:center;gap:7px;font-size:12px;color:#C2C9C3}',
      '.tmww .p-form{width:min(560px,100%);display:flex;flex-direction:column;gap:10px}',
      '@media(max-width:560px){.tmww .plans{flex-direction:column}.tmww .p-feat{display:none}}',
      '@media(prefers-reduced-motion:reduce){.tmww .ring,.tmww .eyeb.purple{animation:none}.tmww .scr.on{animation:none}}'
    ].join('');
    var s = document.createElement('style'); s.id = 'tmw-welcome-css'; s.textContent = css;
    document.head.appendChild(s);
  }

  var LOGO_IMG = '<img src="https://media.oftmw.com/wix/other/50822a-TMW_Logos-16.svg" alt="Markets of Tomorrow">';

  var IS_MAP_SURFACE = (location.hostname === 'map.oftmw.com') || /^\/map(\/|$)/.test(location.pathname);

  var root = null, slideTimer = null;

  function close(force) {
    if (!root) return;
    if (hardMode && force !== true) return;   // hard gate (atlas, map limit) — no escape
    hardMode = false;
    var el = root; root = null;
    clearInterval(slideTimer); slideTimer = null;
    el.classList.remove('show');
    document.documentElement.style.overflow = '';
    setTimeout(function () { el.remove(); }, 420);
  }

  function build() {
    if (root) return root;
    ensureFonts(); injectCSS();
    root = document.createElement('div');
    root.className = 'tmww' + (IS_MAP_SURFACE ? ' instant show' : '');
    root.innerHTML = '<div class="bg">' + IMGS.map(function (src, i) {
      return '<img src="' + esc(src) + '" alt=""' + (i === 0 ? ' class="on"' : '') + '>';
    }).join('') + '</div>';
    document.body.appendChild(root);
    document.documentElement.style.overflow = 'hidden';
    var i = 0;
    slideTimer = setInterval(function () {
      if (!root) return;
      var imgs = root.querySelectorAll('.bg img');
      imgs[i % imgs.length].classList.remove('on');
      i++; imgs[i % imgs.length].classList.add('on');
    }, 4200);
    if (!IS_MAP_SURFACE) requestAnimationFrame(function () { if (root) root.classList.add('show'); });
    return root;
  }

  function screen(html) {
    var el = build();
    el.querySelectorAll('.scr').forEach(function (s) { s.remove(); });
    var s = document.createElement('div');
    s.className = 'scr on';
    s.innerHTML = html;
    el.appendChild(s);
    return s;
  }

  function track(ev, extra) {
    try { if (window.gtag) window.gtag('event', ev); } catch (e) {}
    try { window.tmwFunnelTrack && window.tmwFunnelTrack(ev, extra || {}); } catch (e) {}
  }

  // ── GATE ───────────────────────────────────────────────────────────────
  function gate(opts) {
    opts = opts || {};
    if (window._tmwSignedIn === true) return false;
    var source = opts.source || 'welcome_gate';
    var s = screen(
      (hardMode ? '' : '<button class="skip" data-w="close">Not now</button>') +
      '<div class="g-inner">' +
        '<div class="wm">' + LOGO_IMG + '</div>' +
        '<h2 class="g-h">The world of tomorrow, <em>tracked live.</em></h2>' +
        '<p class="g-sub">1,600+ verified developments, the interactive Map and Atlas, and Onyx, our intelligence engine. Create a free account to continue.</p>' +
        '<form class="g-form" novalidate>' +
          '<div class="g-row">' +
            '<input class="in" type="email" name="email" placeholder="you@example.com" autocomplete="email" value="' + esc(opts.email || '') + '" required>' +
            '<input class="in" type="password" name="password" placeholder="Create a password" autocomplete="new-password" minlength="8" required>' +
          '</div>' +
          '<button class="cta" type="submit">Create free account</button>' +
          '<p class="fine g-fine">Already a member? <a data-w="login">Sign in</a></p>' +
          '<div class="msg" aria-live="polite"></div>' +
        '</form>' +
      '</div>' +
      '<div class="g-ticker">' +
        '<div class="tk"><div class="v">1,600+</div><div class="k">Tracked projects</div></div>' +
        '<div class="tk"><div class="v">8.1M</div><div class="k">Monthly views</div></div>' +
        '<div class="tk"><div class="v">40+</div><div class="k">Markets</div></div>' +
      '</div>'
    );
    track('welcome_gate_shown', { source: source });
    var form = s.querySelector('form'), msg = s.querySelector('.msg');
    (opts.email ? form.password : form.email).focus();
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = (form.email.value || '').trim();
      var password = form.password.value || '';
      msg.className = 'msg'; msg.textContent = '';
      if (!email) { form.email.focus(); return; }
      if (password.length < 8) { msg.className = 'msg err'; msg.textContent = 'Password must be at least 8 characters.'; form.password.focus(); return; }
      var btn = form.querySelector('.cta'); var orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Creating…';
      var res = window.tmwCreateFreeAccount ? await window.tmwCreateFreeAccount(email, password) : { ok: false, message: 'Accounts are still loading — try again in a moment.' };
      if (res && res.ok) {
        try { fetch(SUB_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, markets: MARKETS }) }); } catch (e2) {}
        try { localStorage.setItem(KEY, 'subscribed'); localStorage.setItem(SUB_EMAIL_KEY, email); } catch (e2) {}
        track('subscribe_article', { email: email, source: source });
        track('free_account_created', { email: email, source: source });
        member();
      } else if (res && res.code === 'exists') {
        btn.disabled = false; btn.textContent = orig;
        msg.className = 'msg err';
        msg.innerHTML = 'You already have an account. <a data-w="login">Log in</a>';
      } else {
        btn.disabled = false; btn.textContent = orig;
        msg.className = 'msg err'; msg.textContent = (res && res.message) || 'Could not create your account.';
      }
    });
    return true;
  }

  // ── SIGN IN (same splash, no lightbox) ─────────────────────────────────
  function login(opts) {
    opts = opts || {};
    var s = screen(
      (hardMode ? '' : '<button class="skip" data-w="close">Not now</button>') +
      '<div class="g-inner">' +
        '<div class="wm">' + LOGO_IMG + '</div>' +
        '<h2 class="g-h">Welcome <em>back.</em></h2>' +
        '<p class="g-sub">Sign in to pick up where you left off.</p>' +
        '<form class="g-form" novalidate>' +
          '<div class="g-row">' +
            '<input class="in" type="email" name="email" placeholder="you@example.com" autocomplete="email" value="' + esc(opts.email || '') + '" required>' +
            '<input class="in" type="password" name="password" placeholder="Password" autocomplete="current-password" required>' +
          '</div>' +
          '<button class="cta" type="submit">Sign in</button>' +
          '<p class="fine g-fine">New here? <a data-w="togate">Create a free account</a> &middot; <a data-w="forgot">Forgot password?</a></p>' +
          '<div class="msg" aria-live="polite"></div>' +
        '</form>' +
      '</div>'
    );
    track('welcome_login_shown');
    var form = s.querySelector('form'), msg = s.querySelector('.msg');
    (opts.email ? form.password : form.email).focus();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = (form.email.value || '').trim();
      var password = form.password.value || '';
      msg.className = 'msg'; msg.textContent = '';
      if (!email || !password) { msg.className = 'msg err'; msg.textContent = 'Enter your email and password.'; return; }
      var btn = form.querySelector('.cta'); btn.disabled = true; btn.textContent = 'Signing in…';
      var m = window.$memberstackDom;
      if (!m || !m.loginMemberEmailPassword) { btn.disabled = false; btn.textContent = 'Sign in'; msg.className = 'msg err'; msg.textContent = 'Still loading — try again in a moment.'; return; }
      m.loginMemberEmailPassword({ email: email, password: password }).then(function () {
        try { if (window.gtag) window.gtag('event', 'login', { method: 'email' }); } catch (e2) {}
        msg.textContent = '\u2713 Signed in.';
        setTimeout(function () { close(true); location.reload(); }, 400);
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = 'Sign in';
        msg.className = 'msg err';
        msg.textContent = (err && (err.message || (err.data && err.data.message))) || 'Could not sign you in. Check your email and password.';
      });
    });
    return true;
  }

  // ── MEMBER # ───────────────────────────────────────────────────────────
  function member() {
    var s = screen(
      '<div class="ring"></div>' +
      '<div class="c-wrap">' +
        '<div class="eyeb gold">Welcome to the Blueprint</div>' +
        '<div class="c-num">Member <i data-w="num">#····</i></div>' +
        '<p class="c-sub">Your number is permanent, and it&rsquo;s yours. You&rsquo;re one of the members <b>shaping the map of what&rsquo;s next</b>. Watch projects, follow markets, and ask Onyx anything.</p>' +
        '<div class="c-form">' +
          '<button class="cta purple" data-w="topro">See what Pro unlocks</button>' +
          '<button class="cta alt" data-w="close">Start exploring</button>' +
        '</div>' +
      '</div>'
    );
    track('welcome_member_shown');
    try { window.tmwConfetti && window.tmwConfetti({ count: 140 }); } catch (e) {}
    // Resolve the real member number (best effort; the dots stay if it fails).
    try {
      var m = window.$memberstackDom;
      if (m && m.getCurrentMember) m.getCurrentMember().then(function (r) {
        var id = r && r.data && r.data.id; if (!id) return;
        fetch(WORKER + '/member-stats?id=' + encodeURIComponent(id), { cache: 'no-store' })
          .then(function (x) { return x.ok ? x.json() : null; })
          .then(function (d) {
            var n = d && (d.memberNo || d.member_no);
            var el = s.querySelector('[data-w="num"]');
            if (n && el) el.textContent = '#' + String(n).padStart(4, '0');
          }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  // ── GO PRO ─────────────────────────────────────────────────────────────
  // Context-aware headline per gating surface — mirrors the lightbox paywall's
  // map so the full-screen swap loses no specificity.
  var PRO_COPY = {
    'atlas': ['The full Atlas is a Pro feature', 'Every tracked project on one canvas. Start your free 2-week trial to explore the whole Atlas.'],
    'trial_ended': ['That&rsquo;s your 3 free opens for today', 'Free accounts get 3 project opens a day. Go Pro for the whole map, unlimited, plus the Atlas and Onyx.'],
    'feature:intelligence': ['TMW Intelligence is a Pro feature', 'Completion forecasts and the comparable-project engine. Start your free 2-week trial to unlock intelligence on every development.'],
    'feature:watchlist': ['Watchlists are a Pro feature', 'Track the firms and projects you follow and get pinged when they move. Start your free 2-week trial.'],
    'feature:watch': ['Watch this project', 'Watching is a Pro feature. Start your free 2-week trial to track updates and build your list.'],
    'feature:compare': ['Comparisons are a Pro feature', 'Stack any projects side by side across cities. Start your free 2-week trial.'],
    'feature:pulse': ['The live Pulse feed is a Pro feature', 'Follow every new project and milestone in real time. Start your free 2-week trial.'],
    'feature:share': ['Share with friends', 'Sharing projects is a Pro feature. Start your free 2-week trial to send any development to your network.'],
    'feature:deep': ['Deep search is a Pro feature', 'Onyx Deep reasons across the entire pipeline at once. Start your free 2-week trial to unlock it.']
  };
  var hardMode = false;
  function pro(opts) {
    opts = opts || {};
    if (window._isPaidMember === true) return false;
    hardMode = !!opts.hard;
    var copy = PRO_COPY[opts.source] || ['Try everything, free for 2 weeks', 'The full Map and Atlas, unlimited Onyx with Deep mode, projected pricing, watchlists and your weekly brief. Cancel anytime during the trial and pay nothing.'];
    var s = screen(
      (opts.hard
        ? (opts.source === 'atlas' ? '<button class="skip" data-w="gohome">Maybe later</button>' : '')
        : '<button class="skip" data-w="close">Maybe later</button>') +
      '<div class="c-wrap">' +
        '<div class="eyeb purple">TMW Pro</div>' +
        '<h2 class="p-h">' + copy[0] + '</h2>' +
        '<p class="p-sub">' + copy[1] + '</p>' +
        '<div class="plans">' +
          '<button class="plan sel" data-price="' + PRICE_ANNUAL + '"><span class="tag">Save 22%</span><div class="nm">Annual</div><div class="pr">$300<small>/yr</small></div><div class="nt">$25/month &middot; 14 days free</div></button>' +
          '<button class="plan" data-price="' + PRICE_MONTHLY + '"><div class="nm">Monthly</div><div class="pr">$32<small>/mo</small></div><div class="nt">14 days free</div></button>' +
        '</div>' +
        '<div class="p-feat">' +
          '<span class="p-ft">&#10003; Full Map &amp; Atlas</span><span class="p-ft">&#10003; Unlimited Onyx + Deep</span>' +
          '<span class="p-ft">&#10003; Projected pricing</span><span class="p-ft">&#10003; Watchlist &amp; weekly brief</span>' +
        '</div>' +
        '<div class="p-form">' +
          '<button class="cta purple" data-w="checkout">Start my free trial</button>' +
          '<a class="cta alt" href="https://www.oftmw.com/pro/" style="display:flex;align-items:center;justify-content:center;text-decoration:none">View all Pro features</a>' +
          '<p class="fine">No charge for 14 days. Cancel anytime in your account.' +
            (window._tmwSignedIn === true ? '' : ' &middot; Already a subscriber? <a data-w="login">Sign in</a>') + '</p>' +
          '<div class="msg" aria-live="polite"></div>' +
        '</div>' +
      '</div>'
    );
    track('welcome_pro_shown', { source: opts.source || '' });
    s.querySelectorAll('.plan').forEach(function (p) {
      p.addEventListener('click', function () {
        s.querySelectorAll('.plan').forEach(function (x) { x.classList.toggle('sel', x === p); });
      });
    });
    s.querySelector('[data-w="checkout"]').addEventListener('click', function () {
      var sel = s.querySelector('.plan.sel');
      var priceId = (sel && sel.getAttribute('data-price')) || PRICE_ANNUAL;
      track('welcome_pro_checkout', { price_id: priceId });
      // journal-paywall.js owns checkout (trial eligibility, grandfathered
      // no-trial pricing, the signup fallback). Load it if it isn't up yet.
      function go() {
        if (typeof window.tmwProCheckout === 'function') { close(true); window.tmwProCheckout(priceId); }
        else if (typeof window.tmwShowPaywall === 'function') { close(true); window.tmwShowPaywall('go-pro'); }
      }
      if (window.tmwProCheckout || window.tmwShowPaywall) { go(); return; }
      var sc = document.createElement('script');
      sc.src = '/_shared/journal-paywall.js';
      sc.onload = go;
      document.body.appendChild(sc);
    });
    return true;
  }

  // ── shared click / key handling ────────────────────────────────────────
  document.addEventListener('click', function (e) {
    if (!root) return;
    var w = e.target.closest && e.target.closest('[data-w]');
    if (!w || !root.contains(w)) return;
    var act = w.getAttribute('data-w');
    if (act === 'close') { track('welcome_dismissed'); close(); }
    else if (act === 'forceclose') { close(true); }
    else if (act === 'gohome') { track('welcome_dismissed_home'); location.href = 'https://www.oftmw.com/'; }
    else if (act === 'topro') pro({ source: 'post_signup' });
    else if (act === 'login') {
      e.preventDefault();
      var em = '';
      try { var f = root.querySelector('input[name="email"]'); em = (f && f.value || '').trim(); } catch (e2) {}
      login({ email: em });
    }
    else if (act === 'togate') { e.preventDefault(); gate({ source: 'from_login' }); }
    else if (act === 'forgot') {
      e.preventDefault(); close();
      try { if (typeof window.tmwAuthModal === 'function') window.tmwAuthModal('forgot'); else location.href = '/dashboard/'; }
      catch (e3) { location.href = '/dashboard/'; }
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && root) { track('welcome_dismissed'); close(); } });

  window.tmwWelcome = { gate: gate, pro: pro, member: member, login: login, close: close };
})();
