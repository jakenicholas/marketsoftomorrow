/* =====================================================================
   tmw-celebrate.js — the celebration layer for the conversion funnel.

   Two moments, one tiny self-contained module (no external libs — CSP-safe):
     • FREE ACCOUNT created  → welcome popup (free perks + limits + Pro tease)
                               with a confetti burst. Called by the signup
                               funnel right after Memberstack creates the account.
     • PRO upgrade complete  → confetti + a "Welcome to TMW Pro" toast. Fires
                               automatically when a member lands back on any page
                               with ?subscribed=1 (the Stripe successUrl).

   Public API:
     window.tmwConfetti(opts)        — fire a confetti burst
     window.tmwWelcomePopup(opts)    — show the free-account welcome modal
     window.tmwCelebrateToast(o)     — small celebratory toast (used by pro flow)

   New members (2026-07 onward) are #0100+ → the "Blueprint Member" cohort
   (Founding Members were #0001–0099 and that cohort is closed). See the worker
   member registry (ensureMemberRecord).
   ===================================================================== */
(function () {
  if (window.tmwConfetti) return;                        // singleton
  var reduce = false;
  try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var COLORS = ['#1FDF67', '#42EB81', '#A78BFA', '#B9A6FF', '#FFD300', '#f0d68a', '#ECEAE5'];

  // ── confetti — a short canvas burst that removes itself ────────────────
  function confetti(opts) {
    opts = opts || {};
    if (reduce) return;                                   // respect reduced-motion
    var count = opts.count || 120;
    var duration = opts.duration || 4400;
    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:100050';
    document.body.appendChild(cv);
    var ctx = cv.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    function size() { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    size();
    var W = function () { return innerWidth; }, H = function () { return innerHeight; };
    // Two cannons from the lower corners firing up + inward, plus a center puff.
    var parts = [];
    for (var i = 0; i < count; i++) {
      var side = i % 3;                                   // 0 left, 1 right, 2 center-top
      var ox, oy, ang, spd;
      if (side === 0) { ox = W() * 0.05; oy = H() * 0.94; ang = -Math.PI / 2 - 0.55 - Math.random() * 0.55; spd = 8 + Math.random() * 6; }
      else if (side === 1) { ox = W() * 0.95; oy = H() * 0.94; ang = -Math.PI / 2 + 0.55 + Math.random() * 0.55; spd = 8 + Math.random() * 6; }
      else { ox = W() * (0.05 + Math.random() * 0.9); oy = -20; ang = Math.PI / 2 + (Math.random() - 0.5) * 0.7; spd = 1.5 + Math.random() * 2.5; }
      parts.push({
        x: ox, y: oy,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        w: 6 + Math.random() * 6, h: 8 + Math.random() * 7,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
        sway: Math.random() * 6.28, swayAmp: 0.4 + Math.random() * 0.7,
        life: 0
      });
    }
    var start = null, raf;
    function frame(t) {
      if (start == null) start = t;
      var elapsed = t - start;
      ctx.clearRect(0, 0, cv.width, cv.height);
      var stillAlive = false;
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        p.vy += 0.13;                                     // gravity — gentle so it floats down
        p.vx *= 0.985; p.vy *= 0.985;                     // air resistance
        p.x += p.vx + Math.sin(elapsed * 0.003 + p.sway) * p.swayAmp;   // side-to-side flutter
        p.y += p.vy; p.rot += p.vr; p.life = elapsed;
        var alpha = elapsed < duration - 1200 ? 1 : Math.max(0, (duration - elapsed) / 1200);
        if (p.y < H() + 40 && alpha > 0) stillAlive = true;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < duration && stillAlive) { raf = requestAnimationFrame(frame); }
      else { cv.remove(); }
    }
    raf = requestAnimationFrame(frame);
    // safety: never leave a canvas behind
    setTimeout(function () { try { cancelAnimationFrame(raf); cv.remove(); } catch (e) {} }, duration + 1200);
  }

  // ── shared CSS ─────────────────────────────────────────────────────────
  var cssDone = false;
  function css() {
    if (cssDone) return; cssDone = true;
    var s = document.createElement('style'); s.id = 'tmw-celebrate-css';
    s.textContent = [
      '.tmwc-modal{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;padding:20px;padding-top:calc(20px + env(safe-area-inset-top));padding-bottom:calc(20px + env(safe-area-inset-bottom))}',
      '.tmwc-modal.active{display:flex}',
      '.tmwc-backdrop{position:absolute;inset:0;background:rgba(8,8,8,.85);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}',
      '.tmwc-card{position:relative;width:100%;max-width:440px;max-height:calc(100vh - 40px);overflow-y:auto;background:linear-gradient(180deg,rgba(28,28,28,.97) 0%,rgba(15,15,15,.97) 100%);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:30px 26px 24px;box-shadow:0 30px 80px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05);color:#fff;text-align:center;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;animation:tmwcPop .4s cubic-bezier(.34,1.56,.64,1)}',
      '@keyframes tmwcPop{from{opacity:0;transform:scale(.9) translateY(20px)}to{opacity:1;transform:scale(1) translateY(0)}}',
      '.tmwc-close{position:absolute;top:13px;right:13px;width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:rgba(255,255,255,.7);font-size:17px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;z-index:2}',
      '.tmwc-close:hover{background:rgba(255,255,255,.12);color:#fff}',
      '.tmwc-icon{margin:0 auto 16px;display:flex;align-items:center;justify-content:center}',
      '.tmwc-icon img{height:32px;width:auto;display:block;filter:brightness(0) invert(1)}',
      '.tmwc-eyebrow{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#42EB81;margin-bottom:8px}',
      '.tmwc-title{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif !important;font-size:22px;font-weight:700;letter-spacing:-.01em;line-height:1.2;margin-bottom:8px}',
      '.tmwc-sub{font-size:13px;color:rgba(255,255,255,.55);line-height:1.5;margin-bottom:20px}',
      '.tmwc-perks{display:flex;flex-direction:column;gap:11px;text-align:left;margin-bottom:20px}',
      '.tmwc-perk{display:flex;align-items:flex-start;gap:11px;font-size:13.5px;color:rgba(255,255,255,.82);line-height:1.35}',
      '.tmwc-perk svg{flex-shrink:0;margin-top:1px}',
      '.tmwc-perk b{color:#fff;font-weight:700}',
      '.tmwc-pro{position:relative;border-radius:13px;padding:15px 16px;margin-bottom:16px;background:radial-gradient(120% 160% at 0% 0%,rgba(167,139,250,.14),transparent 60%),rgba(167,139,250,.06);border:1px solid rgba(167,139,250,.4);box-shadow:0 0 18px rgba(167,139,250,.2);text-align:left}',
      '.tmwc-pro-h{font-size:12.5px;font-weight:700;color:#C4B5FD;margin-bottom:4px;display:flex;align-items:center;gap:7px}',
      '.tmwc-pro-b{font-size:12px;color:rgba(255,255,255,.66);line-height:1.45}',
      '.tmwc-cta{display:block;width:100%;box-sizing:border-box;background:#A78BFA;color:#0a0a0a;border:none;border-radius:999px;padding:14px 20px;font-family:inherit;font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;transition:filter .15s,transform .1s;margin-bottom:10px}',
      '.tmwc-cta:hover{filter:brightness(1.07)}',
      '.tmwc-cta:active{transform:scale(.99)}',
      '.tmwc-later{background:none;border:none;color:rgba(255,255,255,.45);font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;padding:4px}',
      '.tmwc-later:hover{color:rgba(255,255,255,.7)}',
      // celebratory toast (pro upgrade)
      '.tmwc-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(140%);z-index:100060;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);padding:14px 18px;border-radius:14px;background:linear-gradient(180deg,rgba(30,30,30,.98),rgba(16,16,16,.98));border:1px solid rgba(167,139,250,.45);box-shadow:0 20px 50px rgba(0,0,0,.6),0 0 24px rgba(167,139,250,.28);color:#fff;font-family:"Inter",-apple-system,sans-serif;transition:transform .5s cubic-bezier(.34,1.56,.64,1)}',
      '.tmwc-toast.show{transform:translateX(-50%) translateY(0)}',
      '.tmwc-toast .em{font-size:22px;line-height:1}',
      '.tmwc-toast .tt{font-size:13.5px;font-weight:800;letter-spacing:.01em}',
      '.tmwc-toast .ts{font-size:12px;color:rgba(255,255,255,.6);margin-top:2px}',
      '.tmwc-toast.link{cursor:pointer}',
      '.tmwc-toast.link:hover{border-color:rgba(167,139,250,.7);box-shadow:0 20px 50px rgba(0,0,0,.6),0 0 32px rgba(167,139,250,.45)}',
      '.tmwc-toast .arr{flex:none;width:16px;height:16px;color:#C4B5FD;transition:transform .2s}',
      '.tmwc-toast.link:hover .arr{transform:translateX(3px)}',
      '@media(max-width:480px){.tmwc-card{padding:26px 18px 20px} .tmwc-title{font-size:19px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  var ICON = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/other/50822a-TMW_Logos-16.svg';
  var CHK = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#1FDF67" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  var SPARK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="#C4B5FD"><path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z"/></svg>';

  // ── free-account welcome popup ─────────────────────────────────────────
  function welcome(opts) {
    opts = opts || {};
    css();
    var prev = document.getElementById('tmwcWelcome'); if (prev) prev.remove();
    var modal = document.createElement('div');
    modal.id = 'tmwcWelcome';
    modal.className = 'tmwc-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML =
      '<div class="tmwc-backdrop"></div>' +
      '<div class="tmwc-card">' +
        '<button class="tmwc-close" type="button" aria-label="Close">&times;</button>' +
        '<div class="tmwc-icon"><img src="' + ICON + '" alt="Markets of Tomorrow"></div>' +
        '<div class="tmwc-eyebrow">You&rsquo;re in</div>' +
        '<h2 class="tmwc-title">Welcome to Markets of Tomorrow</h2>' +
        '<p class="tmwc-sub">Your free account is ready. Here&rsquo;s what you can do:</p>' +
        '<div class="tmwc-perks">' +
          '<div class="tmwc-perk">' + CHK + '<span>Ask <b>Onyx</b> &mdash; <b>5 intelligence searches</b> every month</span></div>' +
          '<div class="tmwc-perk">' + CHK + '<span><b>Save up to 3 projects</b> to your watchlist</span></div>' +
          '<div class="tmwc-perk">' + CHK + '<span>Explore the <b>full development map</b> &amp; read every story</span></div>' +
        '</div>' +
        '<div class="tmwc-pro">' +
          '<div class="tmwc-pro-h">' + SPARK + 'Go unlimited with TMW Pro</div>' +
          '<div class="tmwc-pro-b">Unlimited Onyx &amp; saves, the full Atlas, side-by-side comparisons, and live alerts on the projects you follow. <b style="color:rgba(255,255,255,.85)">Free for 2 weeks.</b></div>' +
        '</div>' +
        '<button class="tmwc-cta" type="button">Start your 2-week free trial</button>' +
        '<button class="tmwc-later" type="button">Explore for now</button>' +
      '</div>';
    document.body.appendChild(modal);
    document.documentElement.style.overflow = 'hidden';
    function close() {
      modal.classList.remove('active');
      document.documentElement.style.overflow = '';
      setTimeout(function () { try { modal.remove(); } catch (e) {} }, 250);
    }
    // Dismissing the welcome (X / backdrop / "Explore for now") RELOADS the current
    // page. The account was just created, so a reload hands the user a clean
    // logged-in state — recurring signup/paywall popups stop, the account UI
    // populates — and lands them right back where they were (same URL, same map
    // spot via ?project=). Falls back to a plain close if reload is unavailable.
    function dismissAndRefresh() {
      try { window.location.reload(); } catch (e) { close(); }
    }
    modal.querySelector('.tmwc-backdrop').addEventListener('click', dismissAndRefresh);
    modal.querySelector('.tmwc-close').addEventListener('click', dismissAndRefresh);
    modal.querySelector('.tmwc-later').addEventListener('click', dismissAndRefresh);
    modal.querySelector('.tmwc-cta').addEventListener('click', function () {
      close();
      try { if (window.gtag) gtag('event', 'welcome_go_pro_clicked', { surface: 'journal' }); } catch (e) {}
      setTimeout(function () { if (window.tmwShowPaywall) window.tmwShowPaywall('welcome'); }, 200);
    });
    requestAnimationFrame(function () { modal.classList.add('active'); });
    try { if (window.gtag) gtag('event', 'welcome_popup_shown', { surface: 'journal' }); } catch (e) {}
    // a beat after the pop so the burst reads as a reward, not a page load
    setTimeout(function () { confetti({ count: 110 }); }, 260);
  }

  // ── celebratory toast ──────────────────────────────────────────────────
  function toast(o) {
    o = o || {};
    css();
    var prev = document.querySelector('.tmwc-toast'); if (prev) prev.remove();
    var t = document.createElement('div');
    t.className = 'tmwc-toast' + (o.href ? ' link' : '');
    t.innerHTML = '<span class="em">' + (o.emoji || '🎉') + '</span><div><div class="tt">' +
      (o.title || 'Welcome to TMW Pro') + '</div>' + (o.sub ? '<div class="ts">' + o.sub + '</div>' : '') + '</div>'
      + (o.href ? '<svg class="arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' : '');
    if (o.href) { t.setAttribute('role', 'link'); t.tabIndex = 0; t.addEventListener('click', function () { location.href = o.href; }); }
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { try { t.remove(); } catch (e) {} }, 600); }, o.hold || 5200);
  }

  // ── pro-upgrade auto-celebration (Stripe successUrl adds ?subscribed=1) ──
  function checkProReturn() {
    var p; try { p = new URLSearchParams(location.search); } catch (e) { return; }
    if (!p || p.get('subscribed') !== '1') return;
    // strip the param so a refresh doesn't re-fire the celebration
    try {
      p.delete('subscribed');
      var qs = p.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) {}
    function go() {
      confetti({ count: 150, duration: 4800 });
      // new subscribers are #0100+ → Blueprint Members (founding cohort is closed)
      setTimeout(function () {
        toast({ emoji: '🎉', title: 'Welcome to TMW Pro', sub: 'You&rsquo;re a Blueprint Member — enjoy unlimited access.' });
      }, 500);
      try { if (window.gtag) gtag('event', 'pro_welcome_celebration', { surface: 'journal' }); } catch (e) {}
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(go, 600);
    else document.addEventListener('DOMContentLoaded', function () { setTimeout(go, 600); });
  }

  // Watchlist celebration — one shared voice for every surface that can add a
  // project to the watchlist (map, hotels Opening Radar, Onyx overlay, article
  // project cards). Callers pass the project's display name.
  function watchToast(name) {
    toast({ emoji: '🔔', title: (name || 'Project') + ' added to your watchlist',
      sub: 'You&rsquo;ll get the alert when it moves.', hold: 4200 });
  }

  window.tmwConfetti = confetti;
  window.tmwWelcomePopup = welcome;
  window.tmwCelebrateToast = toast;
  window.tmwWatchToast = watchToast;

  checkProReturn();
})();
