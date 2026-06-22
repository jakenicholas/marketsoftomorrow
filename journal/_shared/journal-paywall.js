/* =====================================================================
   journal-paywall.js — the native "Go Pro" subscription paywall for the
   journal (www.oftmw.com). Ports the map's paywall so Pro upgrades happen
   in-page instead of redirecting to map.oftmw.com/?upgrade=1.

   • Reuses Memberstack (window.$memberstackDom) that journal-auth.js loads.
   • Exposes window.tmwShowPaywall(ctx) / window.tmwHidePaywall().
   • Checkout goes straight to Stripe via Memberstack's
     purchasePlansWithCheckout (logged in) or the SIGNUP modal with the plan
     attached (logged out) — identical to the map.
   ===================================================================== */
(function () {
  if (window.tmwShowPaywall) return;                 // singleton

  var PRICE_ID_MONTHLY = 'prc_monthly-86u0uyc';
  var PRICE_ID_ANNUAL  = 'prc_annual-9i2e0eab';
  var ICON = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/other/50822a-TMW_Logos-16.svg';

  function ms() { return window.$memberstackDom; }

  // ── styles (ported from the map, prefixed-safe class names) ───────────
  var cssInjected = false;
  var hardLock = false;   // when true the paywall can't be dismissed (atlas gate)
  function injectCSS() {
    if (cssInjected) return; cssInjected = true;
    var s = document.createElement('style'); s.id = 'tmw-paywall-css';
    s.textContent = [
      '.paywall-modal{position:fixed; inset:0; z-index:99999; display:none; align-items:center; justify-content:center; padding:20px; padding-top:calc(20px + env(safe-area-inset-top)); padding-bottom:calc(20px + env(safe-area-inset-bottom))}',
      '.paywall-modal.active{display:flex}',
      '.paywall-backdrop{position:absolute; inset:0; background:rgba(8,8,8,.85); -webkit-backdrop-filter:blur(20px); backdrop-filter:blur(20px)}',
      '.paywall-card{position:relative; width:100%; max-width:440px; max-height:calc(100vh - 40px); overflow-y:auto; background:linear-gradient(180deg,rgba(28,28,28,.97) 0%,rgba(15,15,15,.97) 100%); border:1px solid rgba(255,255,255,.08); border-radius:18px; padding:28px 24px 22px; box-shadow:0 30px 80px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05); color:#fff; text-align:center; font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; animation:paywallPop .35s cubic-bezier(.34,1.56,.64,1)}',
      '@keyframes paywallPop{from{opacity:0; transform:scale(.9) translateY(20px)} to{opacity:1; transform:scale(1) translateY(0)}}',
      '.paywall-close{position:absolute; top:13px; right:13px; width:30px; height:30px; border-radius:50%; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.05); color:rgba(255,255,255,.7); font-size:17px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s,color .15s; z-index:2}',
      '.paywall-close:hover{background:rgba(255,255,255,.12); color:#fff}',
      '.paywall-modal.paywall-hard .paywall-close{display:none}',
      '.paywall-icon{margin:0 auto 18px; display:flex; align-items:center; justify-content:center}',
      '.paywall-icon img{height:34px; width:auto; display:block; filter:brightness(0) invert(1)}',
      // Map header font (Inter), not the journal\'s serif h2 — explicit so the
      // journal global "h2{font-family:var(--serif)}" rule can\'t win.
      '.paywall-title{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif !important; font-size:22px; font-weight:700; letter-spacing:-.01em; line-height:1.2; margin-bottom:8px}',
      '.paywall-subtitle{font-size:13px; color:rgba(255,255,255,.55); line-height:1.5; margin-bottom:22px}',
      '.paywall-plans{display:flex; flex-direction:column; gap:10px; margin-bottom:18px}',
      '.paywall-plan{position:relative; background:rgba(255,255,255,.04); border:1.5px solid rgba(255,255,255,.08); border-radius:12px; padding:16px 18px; color:#fff; cursor:pointer; text-align:left; transition:border-color .15s, background .15s, transform .1s; font-family:inherit}',
      '.paywall-plan:hover{border-color:rgba(31,223,103,.5); background:rgba(255,255,255,.06)}',
      '.paywall-plan:active{transform:scale(.99)}',
      '.paywall-plan-annual{border-color:#1FDF67; background:rgba(31,223,103,.06)}',
      '.paywall-plan-tag{position:absolute; top:-8px; right:14px; background:#1FDF67; color:#000; font-size:9px; font-weight:800; letter-spacing:.08em; padding:3px 8px; border-radius:20px}',
      '.paywall-plan-name{font-size:12px; font-weight:600; color:rgba(255,255,255,.5); text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px}',
      '.paywall-plan-price{font-size:26px; font-weight:700; line-height:1; margin-bottom:4px}',
      '.paywall-plan-per{font-size:13px; font-weight:500; color:rgba(255,255,255,.45); margin-left:2px}',
      '.paywall-plan-note{font-size:11px; color:rgba(255,255,255,.5)}',
      '.paywall-trial-note{font-size:11.5px; line-height:1.5; color:rgba(255,255,255,.5); margin:0 0 16px; max-width:340px; margin-left:auto; margin-right:auto}',
      '.paywall-features{display:flex; flex-direction:column; gap:8px; padding:14px 0; border-top:1px solid rgba(255,255,255,.06); border-bottom:1px solid rgba(255,255,255,.06); margin-bottom:14px}',
      '.paywall-feature{display:flex; align-items:center; gap:9px; font-size:12px; color:rgba(255,255,255,.7); text-align:left}',
      '.paywall-feature svg{flex-shrink:0}',
      // Yellow PRO pill (matches the avatar-dropdown Pro tag) in place of checks.
      '.paywall-feature-pro-pill{flex-shrink:0; font-size:9px; font-weight:800; color:#000; background:#FFD300; padding:2px 7px; border-radius:4px; letter-spacing:.08em; text-transform:uppercase; line-height:1.2}',
      '.paywall-founding{display:flex; flex-direction:column; align-items:center; gap:4px; margin:0 0 14px; padding:12px 18px; border-radius:12px; background:rgba(255,211,0,.10); border:1px solid rgba(255,211,0,.32); text-align:center; box-shadow:0 0 14px rgba(255,211,0,.18); width:100%; box-sizing:border-box}',
      '.paywall-founding-eyebrow{font-size:11px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:#FFD300}',
      '.paywall-founding-body{font-size:12px; font-weight:500; color:rgba(255,255,255,.78); line-height:1.4}',
      '.paywall-signin{font-size:12px; color:rgba(255,255,255,.45)}',
      '.paywall-signin a{color:#1FDF67; text-decoration:none; font-weight:600}',
      '.paywall-signin a:hover{text-decoration:underline}',
      '@media(max-width:480px){.paywall-card{padding:24px 18px 18px; max-width:100%} .paywall-title{font-size:19px} .paywall-plan-price{font-size:22px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  var CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#1FDF67" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  var FEATURES = [
    'Unlimited project exploration',
    'Access to TMW intelligence &amp; forecasts',
    'Full project details',
    'Create and follow your project watchlist',
    'Build and share project comparison sheets',
    'Daily project update notifications',
    'Architect &amp; developer pages'
  ];

  function build() {
    if (document.getElementById('paywallModal')) return;
    injectCSS();
    var modal = document.createElement('div');
    modal.id = 'paywallModal';
    modal.className = 'paywall-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML =
      '<div class="paywall-backdrop"></div>' +
      '<div class="paywall-card">' +
        '<button class="paywall-close" type="button" aria-label="Close">&times;</button>' +
        '<div class="paywall-icon"><img src="' + ICON + '" alt="Markets of Tomorrow"></div>' +
        '<h2 class="paywall-title">Try TMW Pro free for 2 weeks</h2>' +
        '<p class="paywall-subtitle">Full access to the Map of Tomorrow, the Atlas, TMW Intelligence, and every project behind the journal — free for 14 days, then it’s just:</p>' +
        '<div class="paywall-plans">' +
          '<button class="paywall-plan paywall-plan-annual" data-price-id="' + PRICE_ID_ANNUAL + '">' +
            '<div class="paywall-plan-tag">BEST VALUE</div>' +
            '<div class="paywall-plan-name">Annual</div>' +
            '<div class="paywall-plan-price">$90<span class="paywall-plan-per">/year</span></div>' +
            '<div class="paywall-plan-note">$7.50/month &middot; save 17% &middot; 14 days free</div>' +
          '</button>' +
          '<button class="paywall-plan paywall-plan-monthly" data-price-id="' + PRICE_ID_MONTHLY + '">' +
            '<div class="paywall-plan-name">Monthly</div>' +
            '<div class="paywall-plan-price">$9<span class="paywall-plan-per">/month</span></div>' +
            '<div class="paywall-plan-note">14 days free</div>' +
          '</button>' +
        '</div>' +
        '<div class="paywall-trial-note">Pick a plan to start your free trial. It auto-renews at the price above when the 14 days end &middot; cancel anytime &middot; no refunds.</div>' +
        '<div class="paywall-features">' +
          FEATURES.map(function (f) { return '<div class="paywall-feature"><span class="paywall-feature-pro-pill">PRO</span><span>' + f + '</span></div>'; }).join('') +
        '</div>' +
        '<div class="paywall-founding">' +
          '<span class="paywall-founding-eyebrow">Become a Founding Member</span>' +
          '<span class="paywall-founding-body">Rate locked for life, before July 2026.</span>' +
        '</div>' +
        '<div class="paywall-signin" id="tmwPaywallSigninWrap">Already a subscriber? <a href="#" id="tmwPaywallSignin">Sign in</a></div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.querySelectorAll('.paywall-plan').forEach(function (btn) {
      btn.addEventListener('click', function () { startCheckout(btn.getAttribute('data-price-id')); });
    });
    modal.querySelector('.paywall-backdrop').addEventListener('click', hide);
    modal.querySelector('.paywall-close').addEventListener('click', hide);
    modal.querySelector('#tmwPaywallSignin').addEventListener('click', function (e) {
      e.preventDefault();
      var m = ms();
      if (m && m.openModal) m.openModal('LOGIN').then(function () { try { m.hideModal(); } catch (_) {} }).catch(function () {});
    });
  }

  function show(ctx, opts) {
    build();
    hardLock = !!(opts && opts.hard);
    // close any open nav dropdown / drawer so the paywall is unobstructed
    document.querySelectorAll('.tmw-fm.open').forEach(function (f) { f.classList.remove('open'); });
    var nl = document.querySelector('nav.main .nav-links.open'); if (nl) nl.classList.remove('open');
    document.documentElement.style.overflow = 'hidden';
    var modal = document.getElementById('paywallModal');
    modal.classList.add('active');
    modal.classList.toggle('paywall-hard', hardLock);
    // hide the "Already a subscriber?" line for signed-in members
    var wrap = document.getElementById('tmwPaywallSigninWrap');
    if (wrap) wrap.style.display = window._tmwSignedIn ? 'none' : '';
    // context-aware headline
    var titleEl = modal.querySelector('.paywall-title');
    var subEl = modal.querySelector('.paywall-subtitle');
    var map = {
      'atlas': ['The full Atlas is a Pro feature', 'Every tracked project on one canvas. Start your free 2-week trial to explore the whole Atlas.'],
      'feature:intelligence': ['TMW Intelligence is a Pro feature', 'Completion forecasts and the comparable-project engine. Start your free 2-week trial to unlock intelligence on every development.'],
      'feature:watchlist': ['Watchlists are a Pro feature', 'Track the firms and projects you follow and get pinged when they move. Start your free 2-week trial.'],
      'feature:compare': ['Comparisons are a Pro feature', 'Stack any projects side by side across cities. Start your free 2-week trial.'],
      'feature:pulse': ['The live Pulse feed is a Pro feature', 'Follow every new project and milestone in real time. Start your free 2-week trial.']
    };
    if (titleEl && subEl) {
      var c = map[ctx];
      if (c) { titleEl.textContent = c[0]; subEl.textContent = c[1]; }
      else { titleEl.textContent = 'Try TMW Pro free for 2 weeks'; subEl.textContent = 'Full access to the Map of Tomorrow, the Atlas, TMW Intelligence, and every project behind the journal — free for 14 days.'; }
    }
    if (window.gtag) gtag('event', 'paywall_shown', { 'trigger': ctx || 'go-pro', 'surface': 'journal' });
  }

  function hide() {
    if (hardLock) return;            // hard block (atlas gate) — can't be dismissed
    var modal = document.getElementById('paywallModal');
    if (modal) modal.classList.remove('active');
    document.documentElement.style.overflow = '';
  }

  async function startCheckout(priceId) {
    var m = ms();
    if (!m) { alert('Payment system loading — please try again in a moment.'); return; }
    try {
      if (window.gtag) gtag('event', 'paywall_subscribe_clicked', { 'price_id': priceId, 'surface': 'journal' });
      var current = await m.getCurrentMember();
      if (current && current.data) {
        await m.purchasePlansWithCheckout({
          priceId: priceId,
          cancelUrl: window.location.href,
          successUrl: window.location.href.split('?')[0] + '?subscribed=1'
        });
      } else {
        await m.openModal('SIGNUP', { signup: { plans: [priceId] } });
      }
    } catch (e) {
      if (e && e.code !== 'modal-closed' && e.message !== 'Modal closed') {
        console.error('[tmw-paywall] checkout error', e);
        alert('Could not start checkout: ' + (e.message || e.code || 'unknown error'));
      }
    }
  }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });

  window.tmwShowPaywall = show;
  window.tmwHidePaywall = hide;
})();
