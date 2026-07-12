/* TMW Intelligence — journal ask-bar plug (Concept A).
   A compact "Ask Onyx" card mounted BELOW the section title on each vertical home
   (News "The Latest" / the Iconic Restaurant·Hotel·Golf lists). Styled to match the
   article's TMW Intelligence box (.article-intel): purple-glow eyebrow, Onyx 4.1
   live dot, hex-spinner input, a caret that expands the example questions, and an
   Onyx Deep teaser with the search page's purple pulse-glow.

   It answers INLINE (like the article box) via TmwSearchCore.answerQuery — the same
   place→rank→facts→/smart-answer path the search overlay runs — and is gated through
   window.tmwIntel: anon gets 2 shared previews then a create-account wall, free draws
   from the server-backed 5/month pool, Pro is unlimited. Self-contained (hardcoded
   tokens) so per-page token drift can't restyle it. Loaded only on vertical homes. */
(function () {
  'use strict';
  if (window.__tmwPlug) return; window.__tmwPlug = true;

  var CSS = `
.tmw-plug{max-width:none; margin:2px 0 26px; padding:0; box-sizing:border-box}
.tmw-plug *{box-sizing:border-box}
.tmw-plug-card{position:relative; border:1px solid rgba(167,139,250,.26); border-radius:16px;
  background:linear-gradient(180deg, rgba(167,139,250,.075), rgba(167,139,250,.02));
  padding:16px 20px 15px; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}
.tmw-plug-head{display:flex; align-items:center; gap:8px; font-size:10.5px; letter-spacing:.16em;
  text-transform:uppercase; font-weight:700; color:#B9A6FF; margin-bottom:12px}
.tmw-plug-head .spark{width:15px; height:15px; flex:0 0 auto; fill:#B9A6FF; filter:drop-shadow(0 0 6px rgba(167,139,250,.75))}
.tmw-plug-head .live{margin-left:auto; display:inline-flex; align-items:center; gap:5px; font-size:9px; letter-spacing:.14em; color:#8b958d}
.tmw-plug-head .live i{width:5px; height:5px; border-radius:50%; background:#1FDF67; box-shadow:0 0 8px #1FDF67}
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
.tmw-plug-in{flex:1; min-width:0; background:transparent; border:0; outline:none; color:#ECEAE5; font-family:inherit; font-size:14.5px}
.tmw-plug-in::placeholder{color:#8b958d}
.tmw-plug-go{flex:0 0 auto; appearance:none; cursor:pointer; width:36px; height:36px; border-radius:50%;
  display:inline-flex; align-items:center; justify-content:center; background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.10); color:rgba(255,255,255,.5); transition:background .2s, border-color .2s, color .2s, transform .12s}
.tmw-plug-go:hover{background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.2); color:rgba(255,255,255,.85); transform:translateY(-1px)}
.tmw-plug-go svg{width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round}
/* inline answer (matches article .ai-ask-a / loading) */
.tmw-plug-ans{margin-top:12px}
.tmw-plug-ans[hidden]{display:none}
.tmw-plug-loading{display:flex; align-items:center; gap:10px; font-size:13.5px; color:#C2C9C3; padding:2px 2px}
.tmw-plug-a{font-size:14.5px; line-height:1.55; color:#ECEAE5; padding:2px 2px}
.tmw-plug-afoot{margin-top:9px}
.tmw-plug-more-link{display:inline-flex; align-items:center; gap:6px; appearance:none; cursor:pointer; background:none; border:0; padding:2px;
  font-family:inherit; font-size:12.5px; font-weight:600; color:#B9A6FF}
.tmw-plug-more-link:hover{color:#fff}
.tmw-plug-more-link svg{width:12px; height:12px; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round}
/* footer row: Onyx Deep teaser (left) + examples caret (right) */
.tmw-plug-foot{display:flex; align-items:center; gap:12px; margin-top:12px}
.tmw-plug-deep{display:inline-flex; align-items:center; gap:8px; font-size:11.5px; color:#8b958d; line-height:1.3}
.tmw-plug-deep .dspark{flex:0 0 auto; width:13px; height:13px; fill:#B9A6FF; animation:tmwPlugDeepPulse 2.6s ease-in-out infinite}
.tmw-plug-deep .dpro{flex:0 0 auto; font-size:8.5px; letter-spacing:.12em; text-transform:uppercase; color:#B9A6FF; font-weight:600;
  border:1px solid rgba(167,139,250,.45); border-radius:5px; padding:2px 6px; animation:tmwPlugDeepGlow 2.6s ease-in-out infinite}
.tmw-plug-deep .dtxt{color:#8b958d}
@keyframes tmwPlugDeepPulse{0%,100%{opacity:.7; filter:drop-shadow(0 0 3px rgba(167,139,250,.5))}50%{opacity:1; filter:drop-shadow(0 0 9px rgba(185,166,255,.95))}}
@keyframes tmwPlugDeepGlow{0%,100%{box-shadow:0 0 6px rgba(139,92,246,.22); border-color:rgba(167,139,250,.4)}50%{box-shadow:0 0 16px rgba(139,92,246,.6); border-color:rgba(185,166,255,.85)}}
.tmw-plug-expand{margin-left:auto; flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; appearance:none; cursor:pointer;
  background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.12); border-radius:999px; padding:6px 12px;
  font-family:inherit; font-size:11.5px; font-weight:600; color:#C2C9C3; transition:color .15s, border-color .15s, background .15s}
.tmw-plug-expand:hover{color:#fff; border-color:#A78BFA; background:rgba(167,139,250,.1)}
.tmw-plug-expand svg{width:13px; height:13px; stroke:currentColor; fill:none; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; transition:transform .25s}
.tmw-plug.is-open .tmw-plug-expand svg{transform:rotate(180deg)}
/* collapsible examples (article-style grid-rows transition) */
.tmw-plug-more{display:grid; grid-template-rows:0fr; opacity:0; transition:grid-template-rows .3s ease, opacity .3s ease, margin-top .3s ease}
.tmw-plug-more-in{overflow:hidden; min-height:0}
.tmw-plug.is-open .tmw-plug-more{grid-template-rows:1fr; opacity:1; margin-top:13px}
.tmw-plug-exlabel{font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:#8b958d; font-weight:600; margin-bottom:9px}
.tmw-plug-chips{display:flex; flex-wrap:wrap; gap:8px}
.tmw-plug-chip{appearance:none; cursor:pointer; font-family:inherit; font-size:12.5px; font-weight:500; color:#C2C9C3;
  background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.12); border-radius:999px; padding:7px 13px;
  transition:color .15s, border-color .15s, background .15s; text-align:left}
.tmw-plug-chip:hover{color:#fff; border-color:#A78BFA; background:rgba(167,139,250,.1)}
/* out-of-quota wall */
.tmw-plug-gate{margin-top:13px; font-size:13.5px; color:#C2C9C3; line-height:1.5}
.tmw-plug-gate b{color:#ECEAE5}
.tmw-plug-gbtn{display:inline-block; margin-top:10px; background:linear-gradient(135deg,#B9A6FF,#A78BFA); color:#0a0a0a;
  border:none; border-radius:10px; padding:9px 18px; font-weight:600; font-size:13.5px; cursor:pointer; font-family:inherit}
.tmw-plug-gbtn:hover{filter:brightness(1.06)}
@media (prefers-reduced-motion: reduce){.tmw-plug-hex .ph-spin,.tmw-plug-hex .ph-ring,.tmw-plug-deep .dspark,.tmw-plug-deep .dpro{animation:none}.tmw-plug-hex .ph-ring{opacity:0}}
@media (max-width:560px){.tmw-plug-card{padding:14px 15px 14px}.tmw-plug-foot{flex-wrap:wrap; gap:9px}.tmw-plug-deep .dtxt{display:none}}
`;

  var SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 5.9 5.9 2.3-5.9 2.3L12 18.9l-2.3-5.9L3.8 10.7l5.9-2.3z"/></svg>';
  var DSPARK = '<svg class="dspark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 5.9 5.9 2.3-5.9 2.3L12 18.9l-2.3-5.9L3.8 10.7l5.9-2.3z"/></svg>';
  var HEX = '<span class="tmw-plug-hex" aria-hidden="true"><svg viewBox="0 0 100 100">'
    + '<polygon class="ph-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/>'
    + '<g class="ph-spin"><polygon class="ph-core" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/></g>'
    + '</svg></span>';
  var ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  var MORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';
  var CARET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  var VERT = {
    news: { ph: 'Ask Onyx what’s coming to South Florida…',
      chips: ['Which developers are most active right now?', 'What’s breaking ground in West Palm Beach?', 'Show me projects topping out in 2027'] },
    restaurants: { ph: 'Ask Onyx about restaurants opening near you…',
      chips: ['What new restaurants are opening in Miami?', 'Which chefs are expanding in South Florida?', 'Waterfront restaurants coming in 2026'] },
    hotels: { ph: 'Ask Onyx about hotels & branded residences…',
      chips: ['What luxury hotels are coming to Florida?', 'New branded residences on the water', 'Which flags are entering the market?'] },
    golf: { ph: 'Ask Onyx about golf communities & clubs…',
      chips: ['What golf communities are in development?', 'New private clubs opening this year', 'Golf real estate in Palm Beach County'] }
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

  // Shared, memoized JSON (one fetch per url per pageview; same store the other
  // scripts use so the 563KB projects file isn't re-fetched).
  function sharedJson(url) {
    var s = window.__tmwJsonMemo = window.__tmwJsonMemo || {};
    if (!s[url]) s[url] = fetch(url, { cache: 'no-cache' }).then(function (r) { return r.ok ? r.text() : 'null'; }).catch(function () { return 'null'; });
    return s[url].then(function (t) { try { return JSON.parse(t); } catch (e) { return null; } });
  }

  var _asking = false;
  function openOverlay(q) {
    if (window.tmwOverlay && window.tmwOverlay.open) window.tmwOverlay.open(q);
    else window.location.href = '/?q=' + encodeURIComponent(q);
  }
  function wireMoreLink(ansEl, q) {
    var mb = ansEl.querySelector('.tmw-plug-more-link');
    if (mb) mb.addEventListener('click', function () { openOverlay(q); });
  }

  // Answer INLINE via the search core's one-shot path, gated + counted like the
  // article box. Falls back to opening the overlay if the core isn't loaded yet.
  function ask(q, card, ansEl) {
    q = (q || '').trim(); if (!q || _asking) return;
    var TI = window.tmwIntel;
    if (TI && typeof TI.allowed === 'function' && !TI.allowed(q)) { gate(card, !signedIn()); return; }
    try { if (TI && TI.trackSearch) TI.trackSearch(q, { source: 'journal-plug' }); } catch (e) {}
    _asking = true; ansEl.hidden = false;
    ansEl.innerHTML = '<div class="tmw-plug-loading">' + HEX + '<span>Onyx is thinking…</span></div>';
    Promise.all([
      sharedJson('https://www.oftmw.com/map/projects-flat.json'),
      sharedJson('https://www.oftmw.com/map/firms-flat.json')
    ]).then(function (o) {
      var projects = o[0] || [], firms = o[1] || [];
      var Core = window.TmwSearchCore;
      if (!Core || typeof Core.answerQuery !== 'function') { _asking = false; ansEl.hidden = true; openOverlay(q); return; }
      Core.answerQuery(q, projects, firms, []).then(function (res) {
        _asking = false;
        if (res && res.answer) {
          try { if (TI && TI.count) TI.count(q); } catch (e) {}   // consume from the shared 5/mo pool
          ansEl.innerHTML = '<div class="tmw-plug-a">' + esc(res.answer).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>') + '</div>'
            + '<div class="tmw-plug-afoot"><button class="tmw-plug-more-link" type="button">Explore in Onyx ' + MORE + '</button></div>';
        } else {
          ansEl.innerHTML = '<div class="tmw-plug-a">I couldn’t find enough on that here.</div>'
            + '<div class="tmw-plug-afoot"><button class="tmw-plug-more-link" type="button">Try the full Onyx search ' + MORE + '</button></div>';
        }
        wireMoreLink(ansEl, q);
      }).catch(function () {
        _asking = false;
        ansEl.innerHTML = '<div class="tmw-plug-a">Something went wrong.</div><div class="tmw-plug-afoot"><button class="tmw-plug-more-link" type="button">Open Onyx ' + MORE + '</button></div>';
        wireMoreLink(ansEl, q);
      });
    });
  }

  function gate(card, anon) {
    var g = card.querySelector('.tmw-plug-gate');
    if (!g) { g = document.createElement('div'); g.className = 'tmw-plug-gate'; card.appendChild(g); }
    g.innerHTML = anon
      ? 'Create a free account to ask Onyx — <b>5 questions every month</b> across every project, firm, and milestone.<br><button type="button" class="tmw-plug-gbtn">Create a free account</button>'
      : 'You’ve used your <b>5 free Onyx questions</b> this month. Upgrade to Pro for unlimited.<br><button type="button" class="tmw-plug-gbtn">Upgrade to Pro</button>';
    g.querySelector('.tmw-plug-gbtn').addEventListener('click', function () {
      if (anon) { try { if (window.tmwAuthModal) return window.tmwAuthModal('signup'); } catch (e) {} try { if (typeof window.tmwArticleSignup === 'function') return window.tmwArticleSignup(); } catch (e) {} }
      else { try { if (typeof window.tmwShowPaywall === 'function') return window.tmwShowPaywall('feature:intel'); } catch (e) {} }
    });
  }

  // Anchor: below the section title. News home → after .grid-section .section-head
  // (before the cards); the iconic lists → after header.list-intro.
  function anchor() {
    var home = document.querySelector('.grid-section .section-head');
    if (home && home.parentNode) return home;
    var intro = document.querySelector('.tab-panel[data-panel="ranking"] .list-intro') || document.querySelector('header.list-intro');
    if (intro && intro.parentNode) return intro;
    return null;
  }

  function mount() {
    if (document.getElementById('tmw-plug')) return true;
    var a = anchor();
    if (!a) return false;

    if (!document.getElementById('tmw-plug-styles')) {
      var st = document.createElement('style'); st.id = 'tmw-plug-styles'; st.textContent = CSS; document.head.appendChild(st);
    }
    var v = VERT[vert()] || VERT.news;
    var wrap = document.createElement('div');
    wrap.className = 'tmw-plug'; wrap.id = 'tmw-plug';
    wrap.innerHTML =
      '<div class="tmw-plug-card">'
      + '<div class="tmw-plug-head">' + SPARK + '<span>TMW Intelligence</span><span class="live"><i></i>Onyx 4.1</span></div>'
      + '<div class="tmw-plug-ask">' + HEX
      + '<input class="tmw-plug-in" type="text" placeholder="' + esc(v.ph) + '" aria-label="Ask Onyx">'
      + '<button class="tmw-plug-go" type="button" aria-label="Ask Onyx">' + ARROW + '</button>'
      + '</div>'
      + '<div class="tmw-plug-ans" hidden></div>'
      + '<div class="tmw-plug-foot">'
      + '<span class="tmw-plug-deep">' + DSPARK + '<span>Onyx Deep</span><span class="dpro">Pro</span><span class="dtxt">wide-context research across the full database</span></span>'
      + '<button class="tmw-plug-expand" type="button" aria-expanded="false">Examples ' + CARET + '</button>'
      + '</div>'
      + '<div class="tmw-plug-more"><div class="tmw-plug-more-in">'
      + '<div class="tmw-plug-exlabel">Try asking</div>'
      + '<div class="tmw-plug-chips">' + v.chips.map(function (c) { return '<button class="tmw-plug-chip" type="button">' + esc(c) + '</button>'; }).join('') + '</div>'
      + '</div></div>'
      + '</div>';
    a.parentNode.insertBefore(wrap, a.nextSibling);

    var card = wrap.querySelector('.tmw-plug-card');
    var input = wrap.querySelector('.tmw-plug-in');
    var ansEl = wrap.querySelector('.tmw-plug-ans');
    wrap.querySelector('.tmw-plug-go').addEventListener('click', function () { ask(input.value, card, ansEl); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ask(input.value, card, ansEl); } });
    var exp = wrap.querySelector('.tmw-plug-expand');
    exp.addEventListener('click', function () {
      var open = wrap.classList.toggle('is-open');
      exp.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.tmw-plug-chip'), function (chip) {
      chip.addEventListener('click', function () { input.value = chip.textContent; ask(chip.textContent, card, ansEl); });
    });
    return true;
  }

  function boot() { if (mount()) return; var n = 0, t = setInterval(function () { if (mount() || ++n > 30) clearInterval(t); }, 150); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
