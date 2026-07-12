/* TMW Intelligence — journal ask-bar plug (Concept A).
   A compact "Ask Onyx" card mounted between the hero and the category filter on
   each vertical home (News / Restaurants / Hotels / Golf). Styled to match the
   article's TMW Intelligence box (.article-intel): purple-glow eyebrow, Onyx 4.1
   live dot, hex-spinner ask input, per-vertical starter questions.

   It funnels into the SAME gated Onyx overlay the header search uses
   (window.tmwOverlay.open) — so anon gets 2 shared previews then a create-account
   wall, free accounts draw from the server-backed 5/month pool, Pro is unlimited.
   The plug pre-checks window.tmwIntel.allowed() so an out-of-quota user sees the
   wall here instead of a flash of the overlay. Self-contained (hardcoded tokens)
   so per-page token drift can't restyle it. Loaded only on the vertical homes. */
(function () {
  'use strict';
  if (window.__tmwPlug) return; window.__tmwPlug = true;

  var CSS = `
.tmw-plug{max-width:1200px; margin:6px auto 0; padding:0 32px; box-sizing:border-box}
.tmw-plug *{box-sizing:border-box}
.tmw-plug-card{position:relative; border:1px solid rgba(167,139,250,.26); border-radius:16px;
  background:linear-gradient(180deg, rgba(167,139,250,.075), rgba(167,139,250,.02));
  padding:18px 22px 18px; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}
.tmw-plug-head{display:flex; align-items:center; gap:8px; font-size:10.5px; letter-spacing:.16em;
  text-transform:uppercase; font-weight:700; color:#B9A6FF; margin-bottom:11px}
.tmw-plug-head .spark{width:15px; height:15px; flex:0 0 auto; fill:#B9A6FF; filter:drop-shadow(0 0 6px rgba(167,139,250,.75))}
.tmw-plug-head .live{margin-left:auto; display:inline-flex; align-items:center; gap:5px; font-size:9px; letter-spacing:.14em; color:#8b958d}
.tmw-plug-head .live i{width:5px; height:5px; border-radius:50%; background:#1FDF67; box-shadow:0 0 8px #1FDF67}
.tmw-plug-lede{font-size:15px; line-height:1.5; color:#ECEAE5; margin:0 0 13px; max-width:72ch}
.tmw-plug-lede em{font-style:normal; color:#B9A6FF}
.tmw-plug-ask{display:flex; align-items:center; gap:10px; padding:10px 11px 10px 14px; border-radius:12px;
  background:rgba(0,0,0,.28); border:1px solid rgba(167,139,250,.3); transition:border-color .15s, box-shadow .15s}
.tmw-plug-ask:focus-within{border-color:#A78BFA; box-shadow:0 0 0 3px rgba(167,139,250,.14)}
.tmw-plug-hex{width:20px; height:20px; flex:0 0 auto; display:block}
.tmw-plug-hex svg{width:100%; height:100%; display:block; overflow:visible}
.tmw-plug-hex .ph-spin{transform-origin:50% 50%; animation:tmwPlugSpin 4.2s cubic-bezier(.16,1,.3,1) infinite}
.tmw-plug-hex .ph-core{animation:tmwPlugPulse 4.2s ease-in-out infinite; transform-origin:50% 50%}
.tmw-plug-hex .ph-ring{transform-origin:50% 50%; animation:tmwPlugRing 4.2s ease-out infinite}
@keyframes tmwPlugSpin{0%{transform:rotate(0)}55%{transform:rotate(810deg)}70%{transform:rotate(900deg)}100%{transform:rotate(1080deg)}}
@keyframes tmwPlugPulse{0%,45%{stroke:#A78BFA}70%{stroke:#B9A6FF; filter:drop-shadow(0 0 6px rgba(185,166,255,.9))}100%{stroke:#A78BFA}}
@keyframes tmwPlugRing{0%{transform:scale(1); opacity:.5}70%{opacity:.5}100%{transform:scale(1.28); opacity:0}}
.tmw-plug-in{flex:1; min-width:0; background:transparent; border:0; outline:none; color:#ECEAE5;
  font-family:inherit; font-size:14.5px}
.tmw-plug-in::placeholder{color:#8b958d}
.tmw-plug-go{flex:0 0 auto; appearance:none; cursor:pointer; width:36px; height:36px; border-radius:50%;
  display:inline-flex; align-items:center; justify-content:center; background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.10); color:rgba(255,255,255,.5); transition:background .2s, border-color .2s, color .2s, transform .12s}
.tmw-plug-go:hover{background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.2); color:rgba(255,255,255,.85); transform:translateY(-1px)}
.tmw-plug-go svg{width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round}
.tmw-plug-chips{display:flex; flex-wrap:wrap; gap:8px; margin-top:12px}
.tmw-plug-chip{appearance:none; cursor:pointer; font-family:inherit; font-size:12.5px; font-weight:500; color:#C2C9C3;
  background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.12); border-radius:999px; padding:7px 13px;
  transition:color .15s, border-color .15s, background .15s; text-align:left}
.tmw-plug-chip:hover{color:#fff; border-color:#A78BFA; background:rgba(167,139,250,.1)}
.tmw-plug-foot{display:flex; align-items:center; gap:8px; margin-top:13px; font-size:11.5px; color:#8b958d; line-height:1.4}
.tmw-plug-foot .pro{flex:0 0 auto; font-size:8.5px; letter-spacing:.12em; color:#f0d68a; border:1px solid rgba(230,197,116,.4);
  border-radius:5px; padding:2px 6px; text-transform:uppercase; font-weight:600}
.tmw-plug-gate{margin-top:13px; font-size:13.5px; color:#C2C9C3; line-height:1.5}
.tmw-plug-gate b{color:#ECEAE5}
.tmw-plug-gbtn{display:inline-block; margin-top:10px; background:linear-gradient(135deg,#B9A6FF,#A78BFA); color:#0a0a0a;
  border:none; border-radius:10px; padding:9px 18px; font-weight:600; font-size:13.5px; cursor:pointer; font-family:inherit}
.tmw-plug-gbtn:hover{filter:brightness(1.06)}
@media (prefers-reduced-motion: reduce){.tmw-plug-hex .ph-spin,.tmw-plug-hex .ph-ring{animation:none}.tmw-plug-hex .ph-ring{opacity:0}}
@media (max-width:560px){.tmw-plug{padding:0 18px}.tmw-plug-card{padding:15px 16px 16px}.tmw-plug-lede{font-size:14px}}
`;

  var SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 5.9 5.9 2.3-5.9 2.3L12 18.9l-2.3-5.9L3.8 10.7l5.9-2.3z"/></svg>';
  var HEX = '<span class="tmw-plug-hex" aria-hidden="true"><svg viewBox="0 0 100 100">'
    + '<polygon class="ph-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/>'
    + '<g class="ph-spin"><polygon class="ph-core" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/></g>'
    + '</svg></span>';
  var ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  // Per-vertical copy — placeholder + one-line lede + three starter questions.
  var VERT = {
    news: {
      ph: 'Ask Onyx what’s coming to South Florida…',
      lede: 'Ask Onyx about the projects, developers, and timelines reshaping the region — <em>and what just moved.</em>',
      chips: ['Which developers are most active right now?', 'What’s breaking ground in West Palm Beach?', 'Show me projects topping out in 2027']
    },
    restaurants: {
      ph: 'Ask Onyx about restaurants opening near you…',
      lede: 'Ask Onyx about the restaurants, chefs, and openings <em>reshaping the region.</em>',
      chips: ['What new restaurants are opening in Miami?', 'Which chefs are expanding in South Florida?', 'Waterfront restaurants coming in 2026']
    },
    hotels: {
      ph: 'Ask Onyx about hotels & branded residences…',
      lede: 'Ask Onyx about the hotels and branded residences <em>coming to market.</em>',
      chips: ['What luxury hotels are coming to Florida?', 'New branded residences on the water', 'Which flags are entering the market?']
    },
    golf: {
      ph: 'Ask Onyx about golf communities & clubs…',
      lede: 'Ask Onyx about the golf communities and clubs <em>in development.</em>',
      chips: ['What golf communities are in development?', 'New private clubs opening this year', 'Golf real estate in Palm Beach County']
    }
  };

  function vert() {
    var p = location.pathname.replace(/\/+$/, '') || '/';
    if (/\/restaurants$/i.test(p)) return 'restaurants';
    if (/\/hotels$/i.test(p)) return 'hotels';
    if (/\/golf$/i.test(p)) return 'golf';
    return 'news';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function signedIn() { try { var TI = window.tmwIntel; return !!(TI && TI.signedIn && TI.signedIn()); } catch (e) { return false; } }

  // Hand the question to the gated Onyx overlay (it runs + consumes the credit);
  // fall back to the ?q= deep-link, which auto-opens the overlay on the home page.
  function ask(q, card) {
    q = (q || '').trim(); if (!q) return;
    var TI = window.tmwIntel;
    if (TI && typeof TI.allowed === 'function' && !TI.allowed(q)) { gate(card, !signedIn()); return; }
    try { if (TI && TI.trackSearch) TI.trackSearch(q, { source: 'journal-plug' }); } catch (e) {}
    if (window.tmwOverlay && window.tmwOverlay.open) window.tmwOverlay.open(q);
    else window.location.href = '/?q=' + encodeURIComponent(q);
  }

  // Out-of-quota wall — mirrors the article box + search page. Anon → create a
  // free account; free out of 5/mo → upgrade to Pro.
  function gate(card, anon) {
    var g = card.querySelector('.tmw-plug-gate');
    if (!g) { g = document.createElement('div'); g.className = 'tmw-plug-gate'; card.appendChild(g); }
    g.innerHTML = anon
      ? 'Create a free account to ask Onyx — <b>5 questions every month</b> across every project, firm, and milestone.<br><button type="button" class="tmw-plug-gbtn">Create a free account</button>'
      : 'You’ve used your <b>5 free Onyx questions</b> this month. Upgrade to Pro for unlimited.<br><button type="button" class="tmw-plug-gbtn">Upgrade to Pro</button>';
    var b = g.querySelector('.tmw-plug-gbtn');
    b.addEventListener('click', function () {
      if (anon) { try { if (window.tmwAuthModal) return window.tmwAuthModal('signup'); } catch (e) {} try { if (typeof window.tmwArticleSignup === 'function') return window.tmwArticleSignup(); } catch (e) {} }
      else { try { if (typeof window.tmwShowPaywall === 'function') return window.tmwShowPaywall('feature:intel'); } catch (e) {} }
    });
  }

  function mount() {
    if (document.getElementById('tmw-plug')) return true;
    var cardEl = document.querySelector('.story-card');
    var tabs = cardEl && cardEl.querySelector('.sc-tabs');
    if (!cardEl || !tabs) return false;                       // not a vertical home
    var sec = document.getElementById('featured') || cardEl.closest('section') || cardEl.parentElement;
    if (!sec || !sec.parentNode) return false;

    if (!document.getElementById('tmw-plug-styles')) {
      var st = document.createElement('style'); st.id = 'tmw-plug-styles'; st.textContent = CSS; document.head.appendChild(st);
    }
    var v = VERT[vert()] || VERT.news;
    var wrap = document.createElement('div');
    wrap.className = 'tmw-plug'; wrap.id = 'tmw-plug';
    wrap.innerHTML =
      '<div class="tmw-plug-card">'
      + '<div class="tmw-plug-head">' + SPARK + '<span>TMW Intelligence</span><span class="live"><i></i>Onyx 4.1</span></div>'
      + '<p class="tmw-plug-lede">' + v.lede + '</p>'
      + '<div class="tmw-plug-ask">' + HEX
      + '<input class="tmw-plug-in" type="text" placeholder="' + esc(v.ph) + '" aria-label="Ask Onyx">'
      + '<button class="tmw-plug-go" type="button" aria-label="Ask Onyx">' + ARROW + '</button>'
      + '</div>'
      + '<div class="tmw-plug-chips">' + v.chips.map(function (c) { return '<button class="tmw-plug-chip" type="button">' + esc(c) + '</button>'; }).join('') + '</div>'
      + '<div class="tmw-plug-foot"><span class="pro">Onyx Deep</span> Pro members get wide-context research across the full database.</div>'
      + '</div>';
    sec.parentNode.insertBefore(wrap, sec.nextSibling);

    var card = wrap.querySelector('.tmw-plug-card');
    var input = wrap.querySelector('.tmw-plug-in');
    var go = wrap.querySelector('.tmw-plug-go');
    go.addEventListener('click', function () { ask(input.value, card); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ask(input.value, card); } });
    Array.prototype.forEach.call(wrap.querySelectorAll('.tmw-plug-chip'), function (chip) {
      chip.addEventListener('click', function () { input.value = chip.textContent; ask(chip.textContent, card); });
    });
    return true;
  }

  // The hero (.story-card) is server-rendered, so it's present on DOMContentLoaded;
  // retry a few times in case chrome/dock scripts reflow late.
  function boot() { if (mount()) return; var n = 0, t = setInterval(function () { if (mount() || ++n > 20) clearInterval(t); }, 150); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
