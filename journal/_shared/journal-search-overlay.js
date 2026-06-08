/* ------------------------------------------------------------------
   Markets of Tomorrow — universal search & Intelligence overlay
   --------------------------------------------------------------------
   A bottom-pinned, purple, lightbox-style search surface accessible
   from ANY page. Open via:
     · "/" hotkey  (any page; ignored while typing in another input)
     · window.tmwOverlay.open(initialQuery)   — programmatic
     · any element with [data-tmw-overlay] in markup
   The existing dock search bar is NOT modified — this overlay lives
   alongside it as a parallel entry point for richer search and for
   the TMW Intelligence question-answering experience.

   On submit (Enter / gold arrow / View all): the overlay hands off to
   /search/?q=X — the canonical search page handles the full hero
   stack, Intelligence panel, and gridded sections. The overlay's job
   is fast inline preview (top project / firm / article + ranked rows)
   so a user can answer "is this in the database?" without leaving
   wherever they are.
-------------------------------------------------------------------*/
(function () {
  'use strict';
  if (window.__tmwOverlay) return;
  window.__tmwOverlay = true;

  var WORKER_URL = 'https://tmw.jake-ab7.workers.dev';
  var SEARCH_URL = 'https://www.oftmw.com/search/';
  var MAP_URL    = 'https://www.oftmw.com/map';

  // ── helpers (mirror /search/index.html so scoring stays in sync) ──
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function norm(s){ return String(s==null?'':s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
  function mapSlug(t){ return norm(t).replace(/[^a-z0-9]+/g,''); }
  function mapLink(t, full){ return MAP_URL + '/?project=' + mapSlug(t) + (full ? '&fullscreen=true' : ''); }
  function firstField(o, keys){ for (var i=0;i<keys.length;i++){ var k=keys[i]; if (o[k]!=null && String(o[k]).trim()!=='') return o[k]; } return ''; }
  function commaFirst(s){ return String(s||'').split(',')[0].trim(); }
  function tokenize(q){ return norm(q).split(/[^a-z0-9]+/).filter(Boolean); }
  function isQuestion(q){
    var t = String(q||'').trim();
    if (!t) return false;
    if (t.indexOf('?') !== -1) return true;
    return /^(what|why|how|when|where|who|which|whose|is|are|does|do|did|can|could|will|would|should|has|have|had)\s/i.test(t);
  }

  // ── inline styles (namespaced under .tmw-ov-* so we never collide) ──
  var css = ''
    + '@property --tmw-ov-ang{syntax:"<angle>";inherits:false;initial-value:0deg}'
    + '@keyframes tmwOvChase{to{--tmw-ov-ang:360deg}}'
    + '@keyframes tmwOvBnc{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-4px);opacity:1}}'
    + '@keyframes tmwOvHxsSpin{0%{transform:rotate(0)}55%{transform:rotate(810deg)}70%{transform:rotate(900deg)}100%{transform:rotate(1080deg)}}'
    + '@keyframes tmwOvHxsPulse{0%,45%{stroke:#A78BFA}70%{stroke:#E9DEFF}100%{stroke:#A78BFA}}'
    + '@keyframes tmwOvHxsRing{0%,60%{transform:scale(1);opacity:0}72%{opacity:.5}100%{transform:scale(1.7);opacity:0}}'
    + '@keyframes tmwOvFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}'

    + '.tmw-ov-root{position:fixed;inset:0;z-index:9998;pointer-events:none;opacity:0;transition:opacity .3s ease;'
    + 'font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#ECEAE5;font-size:15px;line-height:1.55}'
    + '.tmw-ov-root.open{opacity:1;pointer-events:auto}'

    + '.tmw-ov-scrim{position:absolute;inset:0;background:rgba(7,8,7,.82);'
    + '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}'

    + '.tmw-ov-lb{position:absolute;inset:0;display:flex;flex-direction:column}'

    /* The header bar (hex + "TMW Intelligence & Search" + close) is gone --
       the spotlight layout uses a floating close button in the top-right
       corner instead so nothing chrome-y competes with the centered
       starter content. */
    + '.tmw-ov-close{position:absolute;top:18px;right:22px;width:38px;height:38px;border-radius:50%;'
    + 'background:rgba(20,20,25,.6);border:1px solid rgba(255,255,255,.10);color:#C2C9C3;'
    + 'display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1;'
    + 'cursor:pointer;transition:all .2s;font-family:inherit;z-index:3;'
    + '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}'
    + '.tmw-ov-close:hover{color:#fff;border-color:rgba(255,255,255,.22);background:rgba(20,20,25,.85)}'
    /* Hex animations kept under .tmw-ov-hxs-* because the spotlight teach
       card still renders the small spinning hexagon next to the label. */
    + '.tmw-ov-hxs-spin{transform-origin:50% 50%;animation:tmwOvHxsSpin 4.2s cubic-bezier(.16,1,.3,1) infinite}'
    + '.tmw-ov-hxs-core{transform-origin:50% 50%;animation:tmwOvHxsPulse 4.2s ease-in-out infinite}'
    + '.tmw-ov-hxs-ring{transform-origin:50% 50%;animation:tmwOvHxsRing 4.2s ease-out infinite}'
    + '@media(prefers-reduced-motion:reduce){.tmw-ov-hxs-spin,.tmw-ov-hxs-ring{animation:none}.tmw-ov-hxs-ring{opacity:0}}'

    + '.tmw-ov-body{flex:1;overflow-y:auto;padding:8px 0 220px;-webkit-overflow-scrolling:touch}'
    + '.tmw-ov-body::-webkit-scrollbar{width:8px}'
    + '.tmw-ov-body::-webkit-scrollbar-track{background:transparent}'
    + '.tmw-ov-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:4px}'
    + '.tmw-ov-wrap{max-width:1080px;margin:0 auto;padding:0 22px}'

    /* Starter (empty) state — spotlight layout: centered on page, no
       card / box around it. Just the small TMW Intelligence label + Pro
       pill, the "Try asking" eyebrow, and the four teach-line rows
       (building icon + Fraunces text + return arrow), then the footer
       caption. The rows themselves keep the original "Ask the Map"
       look-and-feel; only the surrounding card chrome is gone. */
    + '.tmw-ov-starter{padding:24px 22px 40px;animation:tmwOvFadeIn .35s ease both;'
    + 'min-height:calc(100vh - 230px);display:flex;flex-direction:column;align-items:center;justify-content:center}'
    + '.tmw-ov-teach{width:100%;max-width:620px;margin:0 auto}'
    + '.tmw-ov-teach-h{display:flex;align-items:center;justify-content:center;gap:10px;'
    + 'padding:0 0 8px;margin-bottom:6px}'
    + '.tmw-ov-teach-hex{width:24px;height:24px;flex:0 0 auto;display:flex;align-items:center;justify-content:center}'
    + '.tmw-ov-teach-hex svg{width:100%;height:100%;overflow:visible}'
    + '.tmw-ov-teach-ttl{font-size:12px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#C2A8FF}'
    + '.tmw-ov-pill{display:flex;align-items:center;gap:8px;margin-left:14px}'
    + '.tmw-ov-quota{font-size:10.5px;font-weight:700;letter-spacing:.04em;color:#9AA39C;white-space:nowrap}'
    + '.tmw-ov-quota.low{color:#f0d68a}'
    + '.tmw-ov-pro{font-size:9.5px;font-weight:800;letter-spacing:.14em;color:#f0d68a;'
    + 'border:1px solid rgba(240,214,138,.6);border-radius:6px;padding:3px 8px;text-decoration:none;'
    + 'box-shadow:0 0 10px rgba(230,197,116,.22);transition:background .15s}'
    + '.tmw-ov-pro:hover{background:rgba(240,214,138,.14)}'
    + '.tmw-ov-pro.on{cursor:default}'
    + '.tmw-ov-teach-sec{font-size:10px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;'
    + 'color:rgba(255,255,255,.32);text-align:center;padding:8px 0 14px}'
    + '.tmw-ov-teach-ex{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:12px;'
    + 'background:transparent;border:0;width:100%;text-align:left;cursor:pointer;'
    + 'transition:background .15s;font-family:inherit;color:inherit;margin-bottom:2px}'
    + '.tmw-ov-teach-ex:hover{background:rgba(167,139,250,.10)}'
    + '.tmw-ov-teach-ex .tmw-ov-teach-i{width:32px;height:32px;flex:0 0 auto;border-radius:9px;'
    + 'background:rgba(167,139,250,.12);color:#C2A8FF;display:flex;align-items:center;justify-content:center}'
    + '.tmw-ov-teach-ex .tmw-ov-teach-i svg{width:16px;height:16px}'
    + '.tmw-ov-teach-qt{flex:1;font-family:"Fraunces",Georgia,serif;font-size:17px;color:#ECEAE5;line-height:1.3}'
    + '.tmw-ov-teach-ent{font-size:13px;color:#9AA39C;font-family:"SF Mono","Menlo",monospace}'
    + '.tmw-ov-teach-ex:hover .tmw-ov-teach-ent{color:#C2A8FF}'
    + '.tmw-ov-teach-foot{padding:16px 14px 0;margin-top:10px;'
    + 'font-size:12px;color:#9AA39C;text-align:center}'

    /* "Or jump to" quick-jump pill grid beneath the teach lines.
       Forced 2 rows of 3 via grid-template-columns:repeat(3,1fr). Cells
       stretch so each row's pills align cleanly even when their text
       widths differ ("Property Markets Group" vs "Miami"). On mobile the
       grid collapses to 2 columns so labels don't truncate. */
    + '.tmw-ov-chip-sep{display:flex;align-items:center;gap:14px;margin:22px auto 14px;max-width:340px;'
    + 'font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.32);font-weight:700}'
    + '.tmw-ov-chip-sep::before,.tmw-ov-chip-sep::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.08)}'
    + '.tmw-ov-chips{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:700px;margin:0 auto}'
    + '.tmw-ov-chip{font-family:inherit;font-size:12px;color:#ECEAE5;'
    + 'background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.25);'
    + 'padding:9px 10px;border-radius:999px;cursor:pointer;transition:all .15s;line-height:1.2;'
    + 'text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.tmw-ov-chip:hover{background:rgba(167,139,250,.18);border-color:#A78BFA;color:#fff}'
    + '@media(max-width:560px){.tmw-ov-chips{grid-template-columns:repeat(2,1fr);max-width:420px}'
    +   '.tmw-ov-chip{font-size:11.5px}'
    + '}'

    + '@media(max-width:640px){'
    +   '.tmw-ov-starter{padding:16px 16px 28px;min-height:calc(100vh - 200px)}'
    +   '.tmw-ov-teach-qt{font-size:15px;line-height:1.3}'
    +   '.tmw-ov-teach-ttl{font-size:11px;letter-spacing:.18em}'
    +   '.tmw-ov-teach-ex{padding:11px 12px;gap:12px}'
    +   '.tmw-ov-teach-ex .tmw-ov-teach-i{width:30px;height:30px}'
    +   '.tmw-ov-teach-foot{font-size:11px;padding:12px 10px 0}'
    + '}'

    /* Thinking spinner */
    + '.tmw-ov-thinking{display:none;align-items:center;gap:12px;padding:24px 0;justify-content:center;'
    + 'font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#9AA39C}'
    + '.tmw-ov-thinking.show{display:flex}'
    + '.tmw-ov-thinking .dots{display:inline-flex;gap:5px}'
    + '.tmw-ov-thinking .dots span{width:6px;height:6px;border-radius:50%;background:#B9A6FF;animation:tmwOvBnc 1.2s infinite}'
    + '.tmw-ov-thinking .dots span:nth-child(2){animation-delay:.15s}'
    + '.tmw-ov-thinking .dots span:nth-child(3){animation-delay:.3s}'

    /* "Ask TMW Intelligence" promo card (shown when query is question-shaped) */
    + '.tmw-ov-intel-cta{position:relative;display:flex;align-items:center;gap:14px;padding:18px 22px;margin-bottom:22px;'
    + 'border:1px solid rgba(167,139,250,.30);border-radius:16px;'
    + 'background:radial-gradient(130% 150% at 0% 0%,rgba(167,139,250,.12),transparent 55%),linear-gradient(180deg,#1a1d1a,#141714);'
    + 'box-shadow:0 18px 50px rgba(0,0,0,.45);text-decoration:none;color:inherit;transition:transform .2s,border-color .2s;'
    + 'animation:tmwOvFadeIn .35s ease both}'
    + '.tmw-ov-intel-cta:hover{transform:translateY(-1px);border-color:rgba(167,139,250,.5)}'
    + '.tmw-ov-intel-cta::before{content:"";position:absolute;inset:-1px;border-radius:16px;padding:1px;pointer-events:none;'
    + 'background:conic-gradient(from 210deg,rgba(167,139,250,0) 0deg,rgba(167,139,250,0) 250deg,#A78BFA 320deg,#E9DEFF 350deg,rgba(167,139,250,0) 360deg);'
    + '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}'
    + '.tmw-ov-intel-cta .icn{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(167,139,250,.16);color:#B9A6FF;box-shadow:0 0 16px rgba(167,139,250,.45);flex:0 0 auto}'
    + '.tmw-ov-intel-cta .icn svg{width:20px;height:20px}'
    + '.tmw-ov-intel-cta .body{flex:1;min-width:0}'
    + '.tmw-ov-intel-cta .lbl{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#B9A6FF;font-weight:700;margin-bottom:4px}'
    + '.tmw-ov-intel-cta .q{font-family:"Fraunces",Georgia,serif;font-size:17px;color:#fff;font-weight:500;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.tmw-ov-intel-cta .arrow{flex:0 0 auto;color:#B9A6FF;transition:transform .2s}'
    + '.tmw-ov-intel-cta:hover .arrow{transform:translateX(3px)}'

    /* Section heading */
    + '.tmw-ov-sec{margin-bottom:30px;animation:tmwOvFadeIn .35s ease both}'
    + '.tmw-ov-sec-head{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}'
    + '.tmw-ov-sec-head h3{font-family:"Fraunces",Georgia,serif;font-size:18px;color:#fff;font-weight:600;letter-spacing:-.015em}'
    + '.tmw-ov-sec-head .count{font-size:11px;letter-spacing:.1em;color:#9AA39C;padding:3px 9px;background:#141714;border:1px solid rgba(255,255,255,.08);border-radius:999px}'

    /* Hero (matches /search/'s .hero geometry) */
    + '.tmw-ov-hero{position:relative;display:grid;grid-template-columns:1.05fr 1fr;background:#141714;'
    + 'border:1px solid rgba(255,255,255,.14);border-radius:18px;overflow:hidden;'
    + 'box-shadow:0 24px 60px rgba(0,0,0,.45);text-decoration:none;color:inherit;transition:border-color .2s, transform .2s}'
    + '.tmw-ov-hero:hover{border-color:rgba(255,255,255,.22);transform:translateY(-2px)}'
    + '.tmw-ov-hero .media{position:relative;min-height:260px;background:#0a0c0a}'
    + '.tmw-ov-hero .media img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0;display:block}'
    + '.tmw-ov-hero .media .ph{position:absolute;inset:0;background:radial-gradient(120% 120% at 30% 0%,#23291f,#0a0c0a)}'
    + '.tmw-ov-hero .media .scrim{position:absolute;inset:0;background:linear-gradient(90deg,transparent 55%,rgba(20,23,20,.85))}'
    + '.tmw-ov-hero .media .besttag{position:absolute;top:14px;left:14px;display:inline-flex;align-items:center;gap:7px;'
    + 'font-size:10px;letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:#f0d68a;'
    + 'background:rgba(230,197,116,.1);border:1px solid rgba(230,197,116,.5);padding:6px 12px;border-radius:999px;'
    + '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);box-shadow:0 0 18px rgba(230,197,116,.4)}'
    + '.tmw-ov-hero .body{padding:24px 28px;display:flex;flex-direction:column;gap:12px}'
    + '.tmw-ov-hero .body .eyebrow{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#C2C9C3}'
    + '.tmw-ov-hero .body h2{font-family:"Fraunces",Georgia,serif;font-size:28px;line-height:1.06;color:#fff;font-weight:600;letter-spacing:-.015em}'
    + '.tmw-ov-hero .body .loc{font-size:12px;letter-spacing:.06em;color:#C2C9C3}'
    + '.tmw-ov-hero .body .desc{color:#C2C9C3;font-size:14px;font-weight:300;line-height:1.55;max-width:48ch;'
    + 'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}'
    + '.tmw-ov-firmmark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
    + 'font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:160px;color:rgba(255,255,255,.08);letter-spacing:-.04em;line-height:1}'

    /* Smart rows (matches /search/'s .srow exactly) */
    + '.tmw-ov-rows{display:flex;flex-direction:column;gap:9px}'
    + '.tmw-ov-row{display:flex;align-items:center;gap:16px;padding:13px 16px;background:#141714;'
    + 'border:1px solid rgba(255,255,255,.08);border-radius:13px;text-decoration:none;color:inherit;'
    + 'transition:border-color .2s,transform .2s;cursor:pointer}'
    + '.tmw-ov-row:hover{border-color:rgba(255,255,255,.14);transform:translateY(-1px)}'
    + '.tmw-ov-row .rank{flex:0 0 auto;width:24px;font-family:"Fraunces",Georgia,serif;font-size:16px;font-weight:700;color:#9AA39C;text-align:center}'
    + '.tmw-ov-row.lead .rank{color:#B9A6FF}'
    + '.tmw-ov-row .r-ico{flex:0 0 auto;width:30px;height:30px;border-radius:8px;background:#222622;'
    + 'display:flex;align-items:center;justify-content:center;color:#C2C9C3}'
    + '.tmw-ov-row .r-ico svg{width:15px;height:15px}'
    + '.tmw-ov-row .r-main{flex:1;min-width:0}'
    + '.tmw-ov-row .r-name{font-family:"Fraunces",Georgia,serif;font-size:16px;font-weight:600;color:#fff;'
    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.tmw-ov-row .r-sub{display:flex;align-items:center;gap:9px;margin-top:4px;font-size:11.5px;color:#9AA39C;flex-wrap:wrap}'
    + '.tmw-ov-row .sb{display:inline-flex;align-items:center;gap:6px;font-weight:600}'
    + '.tmw-ov-row .sb i{width:5px;height:5px;border-radius:50%;font-style:normal}'
    + '.tmw-ov-row .sb-construction,.tmw-ov-row .sb-breaking{color:#f0d68a}'
    + '.tmw-ov-row .sb-construction i,.tmw-ov-row .sb-breaking i{background:#f0d68a}'
    + '.tmw-ov-row .sb-soon{color:#FFB86b}.tmw-ov-row .sb-soon i{background:#FF9F45}'
    + '.tmw-ov-row .sb-open{color:#42EB81}.tmw-ov-row .sb-open i{background:#1FDF67}'
    + '.tmw-ov-row .dot{width:3px;height:3px;border-radius:50%;background:#9AA39C;opacity:.6}'
    + '.tmw-ov-row .r-bar{flex:0 0 110px;height:7px;border-radius:999px;background:rgba(255,255,255,.06);overflow:hidden}'
    + '.tmw-ov-row .r-bar span{display:block;height:100%;background:linear-gradient(90deg,#7c5cf0,#B9A6FF)}'
    + '.tmw-ov-row .arrow{flex:0 0 auto;color:#9AA39C;transition:transform .2s, color .2s}'
    + '.tmw-ov-row:hover .arrow{color:#B9A6FF;transform:translateX(3px)}'

    /* Empty result state */
    + '.tmw-ov-empty{padding:40px 0;text-align:center;color:#9AA39C;animation:tmwOvFadeIn .3s}'
    + '.tmw-ov-empty h3{font-family:"Fraunces",Georgia,serif;font-size:22px;color:#ECEAE5;margin-bottom:8px;font-weight:600}'
    + '.tmw-ov-empty p{font-size:14px;max-width:40ch;margin:0 auto 18px}'

    /* Bottom-pinned search bar — INHERITS journal-dock.js's .tmw-dock-search
       CSS by tagging the form with that class alongside .tmw-ov-bar-inner.
       Every dock animation (ds-ask-pill grow, ds-ask-text reveal, ds-ask-
       dots caterpillar, ds-hex-spinner spin, ds-search-icon morph, ds-ph
       placeholder fade) fires here on the same 8s timeline, the magnifier
       has the same #9AA39C color + left:13px, the pill border + background
       + green focus state are all the dock's. We only override what's
       overlay-specific:
         - width: fills the overlay container (not the dock's min(46vw,300px))
         - go button: dock has none -- we add a small gold arrow because the
           overlay no longer redirects to /search/. */
    /* Thumbs feedback row -- positioned just above the bar, hidden by
       default (no .show class). The buttons match the dock's pill
       aesthetic: subtle white-overlay bg, neutral border at rest, color
       coding on hover (green for up, red for down) so the rating
       intent reads at a glance. After the user votes, both buttons get
       .voted (pointer-events:none locks the rating in) and the .voted
       button itself gets a colored fill matching its rating. */
    + '.tmw-ov-feedback{position:absolute;left:50%;bottom:108px;transform:translateX(-50%);'
    + 'display:none;align-items:center;gap:10px;z-index:2;opacity:0;'
    + 'transition:opacity .3s ease}'
    + '.tmw-ov-feedback.show{display:flex;opacity:1}'
    + '.tmw-ov-fb-btn{width:38px;height:38px;border-radius:999px;padding:0;'
    + 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);'
    + 'color:#C2C9C3;cursor:pointer;display:flex;align-items:center;justify-content:center;'
    + 'transition:all .2s;font-family:inherit}'
    + '.tmw-ov-fb-btn svg{width:18px;height:18px}'
    + '.tmw-ov-fb-btn:hover{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.22);transform:translateY(-2px)}'
    + '.tmw-ov-fb-btn[data-rating="up"]:hover{color:#42EB81;border-color:rgba(31,223,103,.40);background:rgba(31,223,103,.08)}'
    + '.tmw-ov-fb-btn[data-rating="down"]:hover{color:#ff7676;border-color:rgba(255,93,93,.40);background:rgba(255,93,93,.08)}'
    + '.tmw-ov-fb-btn.voted{pointer-events:none}'
    + '.tmw-ov-fb-btn.voted[data-rating="up"]{background:rgba(31,223,103,.16);border-color:#1FDF67;color:#42EB81}'
    + '.tmw-ov-fb-btn.voted[data-rating="down"]{background:rgba(255,93,93,.16);border-color:#ff5d5d;color:#ff7676}'
    + '.tmw-ov-fb-btn.dimmed{opacity:.35}'
    + '.tmw-ov-fb-thanks{font-size:11.5px;letter-spacing:.02em;color:#9AA39C;'
    + 'opacity:0;transition:opacity .3s ease;pointer-events:none;margin-left:4px}'
    + '.tmw-ov-feedback.voted .tmw-ov-fb-thanks{opacity:1}'
    + '@media(max-width:560px){.tmw-ov-feedback{bottom:90px;gap:8px}'
    +   '.tmw-ov-fb-btn{width:34px;height:34px}'
    +   '.tmw-ov-fb-btn svg{width:16px;height:16px}'
    +   '.tmw-ov-fb-thanks{font-size:10.5px}'
    + '}'

    + '.tmw-ov-bar{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);'
    + 'width:min(820px, calc(100vw - 32px));z-index:2}'
    /* Dark-purple gradient backdrop fades content scrolling behind the bar
       so the input stays legible against busy hero images / row text. The
       gradient sits on .tmw-ov-lb as a pseudo-element so it follows the
       lightbox (not the page), and uses pointer-events:none so it doesn\'t
       block clicks on the bar or anything below it. Same height on
       desktop and mobile -- the user asked for the two views to match. */
    + '.tmw-ov-lb::after{content:"";position:absolute;left:0;right:0;bottom:0;height:170px;'
    + 'pointer-events:none;z-index:1;'
    + 'background:linear-gradient(180deg,transparent 0%,rgba(20,12,42,.45) 38%,rgba(7,8,7,.92) 100%)}'
    /* Width override: dock input is min(46vw,300px) and grows to min(52vw,344px)
       on focus. Overlay bar already fills the spotlight container so we lock
       it at 100% in both states and disable the width transition. */
    + '.tmw-ov-bar .tmw-dock-search input{width:100%;padding-right:50px}'
    + '.tmw-ov-bar .tmw-dock-search input:focus{width:100%;'
    /* Override the dock\'s green focus state -- the overlay is the
       Intelligence surface, so it keeps the purple aesthetic everywhere. */
    + 'border-color:rgba(167,139,250,.55)}'
    /* The dock hides the native placeholder (transparent) because it uses
       a .ds-ph overlay span for the animated text. We dropped that span,
       so restore a normal visible muted-gray placeholder. */
    + '.tmw-ov-bar .tmw-dock-search input::placeholder{color:#9AA39C}'
    /* Tiny gold submit arrow on the right -- the dock bar doesn\'t have one,
       but the overlay needs an explicit "run query" affordance now that it
       no longer redirects to /search/. Sized so it sits inside the dock\'s
       46px pill height. */
    + '.tmw-ov-bar .go{position:absolute;right:8px;top:50%;transform:translateY(-50%);'
    + 'height:30px;width:30px;padding:0;border:0;background:transparent;color:#e6c574;'
    + 'display:flex;align-items:center;justify-content:center;z-index:3;border-radius:999px;cursor:pointer;'
    + 'transition:color .2s,transform .2s,background .2s}'
    + '.tmw-ov-bar .go:hover{color:#f0d68a;background:rgba(230,197,116,.12);transform:translateY(-50%) translateX(2px)}'
    + '.tmw-ov-bar .go svg{width:16px;height:16px;filter:drop-shadow(0 0 6px rgba(230,197,116,.4))}'

    /* ─── PHASE 2: inline TMW Intelligence panel ─────────────────── */
    /* Purple-bordered card that renders the LLM /smart-answer response
       directly inside the overlay (no /search/ handoff). Three visual
       states: loading (caterpillar dots + "Thinking"), answer (serif
       prose + "Live answer" pip), no-answer (muted text + soft pip). */
    + '.tmw-ov-intel-panel{position:relative;padding:22px 24px 20px;margin-bottom:26px;'
    + 'border:1px solid rgba(167,139,250,.30);border-radius:18px;'
    + 'background:radial-gradient(130% 150% at 0% 0%,rgba(167,139,250,.14),transparent 55%),linear-gradient(180deg,#1a1d1a,#141714);'
    + 'box-shadow:0 18px 50px rgba(0,0,0,.45);animation:tmwOvFadeIn .35s ease both}'
    + '.tmw-ov-intel-panel::before{content:"";position:absolute;inset:-1px;border-radius:18px;padding:1px;pointer-events:none;'
    + 'background:conic-gradient(from 210deg,rgba(167,139,250,0) 0deg,rgba(167,139,250,0) 250deg,#A78BFA 320deg,#E9DEFF 350deg,rgba(167,139,250,0) 360deg);'
    + '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}'
    + '.tmw-ov-intel-h{display:flex;align-items:center;gap:10px;margin-bottom:14px}'
    + '.tmw-ov-intel-spark{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(167,139,250,.16);color:#B9A6FF;box-shadow:0 0 16px rgba(167,139,250,.45);flex:0 0 auto}'
    + '.tmw-ov-intel-spark svg{width:18px;height:18px}'
    + '.tmw-ov-intel-h .lbl{font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#B9A6FF}'
    + '.tmw-ov-intel-h .live{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:10px;'
    + 'letter-spacing:.12em;text-transform:uppercase;color:#9AA39C}'
    + '.tmw-ov-intel-h .live i{width:6px;height:6px;border-radius:50%;background:#B9A6FF;box-shadow:0 0 8px #B9A6FF;font-style:normal}'
    + '.tmw-ov-intel-h .live.dim i{background:#6c706c;box-shadow:none}'
    + '.tmw-ov-intel-ans{font-family:"Fraunces",Georgia,serif;font-size:18px;line-height:1.55;color:#fff;font-weight:400;max-width:68ch}'
    + '.tmw-ov-intel-ans.loading{color:#9AA39C;font-style:italic}'
    + '.tmw-ov-intel-ans .hl{color:#B9A6FF;font-weight:600}'
    + '.tmw-ov-intel-foot{display:flex;align-items:center;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid rgba(167,139,250,.18);'
    + 'font-size:11px;color:#9AA39C}'
    + '.tmw-ov-intel-foot .ai{color:#B9A6FF;font-weight:600}'
    + '.tmw-ov-intel-foot a{margin-left:auto;color:#e6c574;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;gap:5px}'
    + '.tmw-ov-intel-foot a:hover{color:#f0d68a}'
    + '.tmw-ov-intel-foot a svg{width:13px;height:13px}'

    /* Gate variant — gold accent for the "out of free queries" upgrade panel */
    + '.tmw-ov-intel-panel.gate{border-color:rgba(240,214,138,.4);'
    + 'background:radial-gradient(130% 150% at 0% 0%,rgba(240,214,138,.10),transparent 55%),linear-gradient(180deg,#1a1d1a,#141714)}'
    + '.tmw-ov-intel-panel.gate::before{background:conic-gradient(from 210deg,rgba(240,214,138,0) 0deg,rgba(240,214,138,0) 250deg,#e6c574 320deg,#f0d68a 350deg,rgba(240,214,138,0) 360deg)}'
    + '.tmw-ov-intel-panel.gate .lbl{color:#f0d68a}'
    + '.tmw-ov-intel-panel.gate .tmw-ov-intel-spark{color:#f0d68a;background:rgba(240,214,138,.16);box-shadow:0 0 16px rgba(240,214,138,.4)}'
    + '.tmw-ov-pro-btn{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:12px 20px;border-radius:11px;'
    + 'background:linear-gradient(180deg,#f0d68a,#e6c574);color:#0b0a08;font-family:inherit;font-weight:700;font-size:12px;'
    + 'letter-spacing:.06em;text-transform:uppercase;text-decoration:none;box-shadow:0 0 24px rgba(230,197,116,.3);transition:filter .15s}'
    + '.tmw-ov-pro-btn:hover{filter:brightness(1.07)}'

    /* Caterpillar dots inside the panel while LLM is thinking */
    + '.tmw-ov-intel-loader{display:inline-flex;align-items:center;gap:6px;margin-right:10px;vertical-align:-2px}'
    + '.tmw-ov-intel-loader span{width:5px;height:5px;border-radius:50%;background:#B9A6FF;animation:tmwOvBnc 1.2s infinite}'
    + '.tmw-ov-intel-loader span:nth-child(2){animation-delay:.15s}'
    + '.tmw-ov-intel-loader span:nth-child(3){animation-delay:.3s}'

    /* "Understood as" chips above a spotlight result */
    + '.tmw-ov-understood{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 18px}'
    + '.tmw-ov-understood .lead{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#9AA39C;font-weight:700}'
    + '.tmw-ov-uchip{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;'
    + 'background:rgba(167,139,250,.10);border:1px solid rgba(167,139,250,.30);font-size:12px;color:#ECEAE5}'
    + '.tmw-ov-uchip .ck{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#B9A6FF;font-weight:700}'
    + '.tmw-ov-uchip b{color:#fff;font-weight:600}'

    /* Partner spotlight CTA + item rows */
    + '.tmw-ov-spot-cta{display:inline-flex;align-items:center;gap:7px;margin-left:auto;padding:8px 14px;border-radius:999px;'
    + 'border:1px solid rgba(31,223,103,.3);background:rgba(31,223,103,.06);'
    + 'color:#42EB81;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;text-decoration:none}'
    + '.tmw-ov-spot-cta:hover{background:rgba(31,223,103,.12)}'
    + '.tmw-ov-spot-cta svg{width:13px;height:13px}'
    + '.tmw-ov-spot-head{display:flex;align-items:baseline;gap:12px;margin:0 2px 14px}'
    + '.tmw-ov-spot-head h3{font-family:"Fraunces",Georgia,serif;font-size:18px;color:#fff;font-weight:600;flex:1}'

    /* ─── PHASE 2B: structured smart query (parseSmartQuery results) ─── */
    /* Stats grid inside the intel panel — 4 columns of DB-derived numbers */
    + '.tmw-ov-intel-stats{display:grid;gap:14px;margin-top:18px;padding-top:16px;border-top:1px solid rgba(167,139,250,.18)}'
    + '.tmw-ov-istat .v{font-family:"Fraunces",Georgia,serif;font-size:22px;font-weight:600;color:#fff;letter-spacing:-.02em;line-height:1.1}'
    + '.tmw-ov-istat .v .u{font-size:13px;color:#B9A6FF;font-weight:500}'
    + '.tmw-ov-istat .k{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#9AA39C;margin-top:6px}'

    /* Header above the smart result rows (count, sort, map link) */
    + '.tmw-ov-smart-head{display:flex;align-items:baseline;gap:10px;margin:0 2px 14px}'
    + '.tmw-ov-smart-head h3{font-family:"Fraunces",Georgia,serif;font-size:18px;color:#fff;font-weight:600}'
    + '.tmw-ov-smart-head .sub{font-size:12px;color:#9AA39C}'
    + '.tmw-ov-smart-head .map-link{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:11px;'
    + 'letter-spacing:.08em;text-transform:uppercase;color:#42EB81;font-weight:700;padding:8px 13px;'
    + 'border:1px solid rgba(31,223,103,.3);border-radius:999px;text-decoration:none}'
    + '.tmw-ov-smart-head .map-link:hover{background:rgba(31,223,103,.1);color:#fff}'
    + '.tmw-ov-smart-head .map-link svg{width:13px;height:13px}'

    /* Smart row metric column (replaces relevance bar for sorted queries) */
    + '.tmw-ov-row .r-metric{flex:0 0 auto;text-align:right;min-width:64px;margin-left:6px}'
    + '.tmw-ov-row .r-metric .n{font-family:"Fraunces",Georgia,serif;font-size:18px;font-weight:700;color:#fff;line-height:1}'
    + '.tmw-ov-row .r-metric .l{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#9AA39C;margin-top:3px}'

    /* Smart-foot caption ("answer synthesized from the project database…") */
    + '.tmw-ov-smart-foot{display:flex;align-items:center;gap:8px;margin-top:18px;justify-content:center;'
    + 'font-size:11px;color:#9AA39C;text-align:center;flex-wrap:wrap}'
    + '.tmw-ov-smart-foot .ai{color:#B9A6FF;font-weight:600}'

    /* Sort-flavored "understood as" chip — green pip for sort, purple for the rest */
    + '.tmw-ov-uchip.sort{background:rgba(31,223,103,.08);border-color:rgba(31,223,103,.30)}'
    + '.tmw-ov-uchip.sort .ck{color:#42EB81}'

    /* ─── PHASE 2 (complete): full /search/-style result sections ─── */
    /* Rich hero card — image-left, body-right, full /search/ heroHtml parity.
       Single hero only (not a stack); all variants (project / article / firm)
       use the same geometry + min-height. Chips row, timeline, specs grid,
       byline, gold + ghost CTAs.  */
    + '.tmw-ov-hero .media{min-height:340px}'
    + '.tmw-ov-hero .body{padding:28px 30px 26px;gap:14px}'
    + '.tmw-ov-hero .body h2{font-size:30px;line-height:1.06}'

    /* Hero chips row (Type, Status) */
    + '.tmw-ov-hero-chips{display:flex;flex-wrap:wrap;gap:8px}'
    + '.tmw-ov-hero-chip{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;'
    + 'color:#C2C9C3;background:#1a1d1a;border:1px solid rgba(255,255,255,.08);border-radius:999px;padding:6px 11px}'
    + '.tmw-ov-hero-chip.type{color:#f0d68a;border-color:rgba(230,197,116,.3)}'
    + '.tmw-ov-hero-chip.status{color:#42EB81;border-color:rgba(31,223,103,.3)}'

    /* Timeline (construction progress bar) */
    + '.tmw-ov-tl{margin-top:4px}'
    + '.tmw-ov-tl-row{display:flex;align-items:center;justify-content:space-between;'
    + 'font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:#9AA39C;margin-bottom:8px}'
    + '.tmw-ov-tl-status{color:#1FDF67;font-weight:700}'
    + '.tmw-ov-tl-track{position:relative;height:6px;border-radius:999px;background:#222622;overflow:visible}'
    + '.tmw-ov-tl-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#18c75a,#1FDF67)}'
    + '.tmw-ov-tl-dot{position:absolute;top:50%;width:13px;height:13px;border-radius:50%;background:#fff;'
    + 'border:3px solid #1FDF67;transform:translate(-50%,-50%);box-shadow:0 0 0 4px rgba(31,223,103,.18)}'
    + '.tmw-ov-tl-ends{display:flex;align-items:center;justify-content:space-between;margin-top:8px;'
    + 'font-size:11px;color:#C2C9C3}'

    /* Specs strip (Units / Keys / Floors / Price) */
    + '.tmw-ov-specs{display:flex;flex-wrap:wrap;gap:18px;padding-top:4px}'
    + '.tmw-ov-spec{display:flex;flex-direction:column;gap:2px}'
    + '.tmw-ov-spec .v{font-family:"Fraunces",Georgia,serif;font-size:20px;color:#fff;line-height:1;font-weight:600}'
    + '.tmw-ov-spec .k{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#9AA39C}'

    /* Byline (Developer / Architect) */
    + '.tmw-ov-byline{font-size:13px;color:#C2C9C3}'
    + '.tmw-ov-byline b{color:#ECEAE5;font-weight:600}'

    /* CTA buttons (gold primary + ghost secondary) — matches /search/'s .btn */
    + '.tmw-ov-hero-cta{display:flex;flex-wrap:wrap;gap:10px;margin-top:auto;padding-top:8px}'
    + '.tmw-ov-btn{display:inline-flex;align-items:center;gap:9px;font-family:inherit;font-size:11px;'
    + 'letter-spacing:.12em;text-transform:uppercase;font-weight:700;padding:12px 18px;border-radius:11px;'
    + 'border:1px solid transparent;text-decoration:none;transition:all .2s;cursor:pointer}'
    + '.tmw-ov-btn.gold{background:#e6c574;color:#070807;box-shadow:0 0 22px rgba(230,197,116,.5),0 0 6px rgba(230,197,116,.35)}'
    + '.tmw-ov-btn.gold:hover{background:#f0d68a;transform:translateY(-1px);box-shadow:0 0 28px rgba(230,197,116,.62),0 0 8px rgba(230,197,116,.4)}'
    + '.tmw-ov-btn.ghost{background:transparent;color:#ECEAE5;border-color:rgba(255,255,255,.14)}'
    + '.tmw-ov-btn.ghost:hover{border-color:rgba(255,255,255,.22);color:#fff}'
    + '.tmw-ov-btn svg{width:15px;height:15px}'
    + '.tmw-ov-btn.ghost svg{color:#fff}'

    + '@media(max-width:760px){'
    +   '.tmw-ov-hero .media{min-height:220px}'
    +   '.tmw-ov-hero .body h2{font-size:24px}'
    +   '.tmw-ov-specs{gap:12px}'
    +   '.tmw-ov-spec .v{font-size:17px}'
    + '}'

    /* Article-card CTA inside the grid (small "Read story" pill at the bottom) */
    + '.tmw-ov-acard-body .acta{margin-top:12px;font-size:10.5px;letter-spacing:.12em;'
    + 'text-transform:uppercase;font-weight:700;color:#1FDF67;display:inline-flex;align-items:center;gap:6px}'
    + '.tmw-ov-acard:hover .acta{color:#42EB81}'
    + '.tmw-ov-acard:hover .acta svg{transform:translateX(2px)}'
    + '.tmw-ov-acard-body .acta svg{width:11px;height:11px;transition:transform .2s}'

    /* Nearby Projects grid — cards link straight to map.oftmw.com/?project=… */
    + '.tmw-ov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:14px}'
    + '.tmw-ov-pcard{display:flex;flex-direction:column;background:#141714;border:1px solid rgba(255,255,255,.08);'
    + 'border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;transition:border-color .2s,transform .2s}'
    + '.tmw-ov-pcard:hover{border-color:rgba(255,255,255,.22);transform:translateY(-2px)}'
    + '.tmw-ov-pcard-media{position:relative;height:148px;background:#0a0c0a;overflow:hidden}'
    + '.tmw-ov-pcard-media img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.tmw-ov-pcard-media .ph{position:absolute;inset:0;background:radial-gradient(120% 120% at 30% 0%,#1d231d,#0a0c0a)}'
    + '.tmw-ov-pcard-media .ptype{position:absolute;left:10px;bottom:10px;font-size:9.5px;letter-spacing:.12em;'
    + 'text-transform:uppercase;color:#f0d68a;background:rgba(7,8,7,.7);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);padding:4px 9px;border-radius:999px}'
    + '.tmw-ov-pcard-body{padding:13px 14px 15px;display:flex;flex-direction:column;gap:5px;flex:1}'
    + '.tmw-ov-pcard-body h4{font-family:"Fraunces",Georgia,serif;font-size:16px;line-height:1.15;color:#fff;font-weight:600;letter-spacing:-.015em}'
    + '.tmw-ov-pcard-body .loc{font-size:10.5px;letter-spacing:.06em;color:#9AA39C;text-transform:uppercase}'
    + '.tmw-ov-pcard-body .meta{margin-top:auto;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#C2C9C3;'
    + 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding-top:8px}'
    + '.tmw-ov-pcard-body .meta .openmap{color:#1FDF67;font-size:15px;line-height:1;transition:transform .2s}'
    + '.tmw-ov-pcard:hover .meta .openmap{transform:translateX(2px)}'

    /* Firms & places chiprow */
    + '.tmw-ov-chiprow{display:flex;flex-wrap:wrap;gap:10px}'
    + '.tmw-ov-entity{display:inline-flex;align-items:center;gap:10px;background:#141714;'
    + 'border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:11px 15px;'
    + 'text-decoration:none;color:inherit;transition:border-color .2s}'
    + '.tmw-ov-entity:hover{border-color:rgba(255,255,255,.22)}'
    + '.tmw-ov-entity .icn{width:30px;height:30px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;'
    + 'border-radius:8px;background:#222622;color:#C2C9C3}'
    + '.tmw-ov-entity .icn svg{width:15px;height:15px}'
    + '.tmw-ov-entity .nm{font-size:14px;color:#fff;font-weight:500}'
    + '.tmw-ov-entity .sub{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#9AA39C;margin-top:2px}'

    /* From the journal — article cards in a 3-col grid with load-more */
    + '.tmw-ov-alist{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}'
    + '@media(max-width:880px){.tmw-ov-alist{grid-template-columns:repeat(2,1fr)}}'
    + '@media(max-width:560px){.tmw-ov-alist{grid-template-columns:1fr}}'
    + '.tmw-ov-acard{display:block;background:#141714;border:1px solid rgba(255,255,255,.08);border-radius:14px;'
    + 'overflow:hidden;text-decoration:none;color:inherit;transition:transform .25s ease,border-color .25s ease}'
    + '.tmw-ov-acard:hover{transform:translateY(-3px);border-color:rgba(255,255,255,.14)}'
    + '.tmw-ov-acard-media{aspect-ratio:16/10;background:#1a1d1a;overflow:hidden}'
    + '.tmw-ov-acard-media img{width:100%;height:100%;object-fit:cover;transition:transform .6s ease;display:block}'
    + '.tmw-ov-acard:hover .tmw-ov-acard-media img{transform:scale(1.04)}'
    + '.tmw-ov-acard-media .ph{width:100%;height:100%;background:radial-gradient(120% 120% at 30% 0%,#23201a,#0a0c0a)}'
    + '.tmw-ov-acard-body{padding:18px 20px 20px}'
    + '.tmw-ov-acard-body .adate{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#9AA39C;margin-bottom:8px}'
    + '.tmw-ov-acard-body h4{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:18px;line-height:1.22;color:#fff;letter-spacing:-.015em}'

    /* Load-more button (matches /search/'s .loadmore) */
    + '.tmw-ov-loadmore{margin:20px auto 0;display:block;font-family:inherit;font-size:12px;letter-spacing:.14em;'
    + 'text-transform:uppercase;font-weight:700;color:#ECEAE5;background:#141714;border:1px solid rgba(255,255,255,.14);'
    + 'border-radius:999px;padding:13px 26px;cursor:pointer;transition:border-color .2s,background .2s,color .2s}'
    + '.tmw-ov-loadmore:hover{border-color:#1FDF67;color:#fff;background:#1a1d1a}'

    + '.tmw-ov-hidden{display:none!important}'

    + '@media(max-width:760px){'
    +   '.tmw-ov-hero{grid-template-columns:1fr}'
    +   '.tmw-ov-hero .media{min-height:180px}'
    +   '.tmw-ov-bar{bottom:18px;width:calc(100vw - 22px)}'
    +   '.tmw-ov-row .r-bar{display:none}'
    +   '.tmw-ov-close{top:14px;right:14px;width:34px;height:34px}'
    +   '.tmw-ov-body{padding:8px 0 130px}'
    +   '.tmw-ov-wrap{padding:0 16px}'
    + '}';

  // Inject styles once
  if (!document.querySelector('style[data-tmw-overlay]')) {
    var styleEl = document.createElement('style');
    styleEl.setAttribute('data-tmw-overlay', '');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  // ── DOM ─────────────────────────────────────────────────────────────
  var ICON_HEX = ''
    + '<svg viewBox="0 0 100 100" aria-hidden="true">'
    +   '<g class="tmw-ov-hxs-spin">'
    +     '<polygon class="tmw-ov-hxs-core" points="50,8 86,29 86,71 50,92 14,71 14,29" fill="none" stroke="#A78BFA" stroke-width="3" stroke-linejoin="round"/>'
    +   '</g>'
    +   '<circle class="tmw-ov-hxs-ring" cx="50" cy="50" r="28" fill="none" stroke="#A78BFA" stroke-width="2" opacity="0"/>'
    + '</svg>';

  // Identical SVG to journal-dock.js's ICON_SEARCH (line 141). Pairs with
  // the .ds-hex-spinner / .ds-hex-core / .ds-search-icon / .ds-search-circle
  // / .ds-search-wand CSS animations the dock already defines globally,
  // so reusing the SAME class names here gives us the exact same morph
  // (search icon -> spinning hexagon -> back) on the same 8s timeline.
  var ICON_SEARCH_DOCK = ''
    + '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" overflow="visible">'
    +   '<g class="ds-hex-spinner">'
    +     '<polygon class="ds-hex-core" points="12,4 18.93,8 18.93,16 12,20 5.07,16 5.07,8" fill="none" stroke="#A78BFA" stroke-width="1.7" stroke-linejoin="round"/>'
    +   '</g>'
    +   '<g class="ds-search-icon" stroke-linecap="round" stroke-linejoin="round">'
    +     '<circle class="ds-search-circle" cx="11" cy="11" r="6.5" fill="none" stroke-width="1.7"/>'
    +     '<line class="ds-search-wand" x1="16" y1="16" x2="20" y2="20" stroke-width="1.7"/>'
    +   '</g>'
    + '</svg>';

  var ICON_BLDG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V6.5L12 3l8 3.5V21"/><path d="M9 21v-6h6v6"/><path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/></svg>';
  // Building icon used in the teach-card rows — matches journal-dock.js's TEACH_ICON
  // for visual consistency with the original Ask the Map pop-up.
  var ICON_TEACH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M6 21V8l6-4 6 4v13"/></svg>';
  var ICON_FIRM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
  var ICON_ARTICLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h14v16H6a2 2 0 0 1-2-2z"/><line x1="8" y1="9" x2="14" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/></svg>';
  var ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7.5 7-13a7 7 0 1 0-14 0c0 5.5 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></svg>';
  var ICON_SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12,3 21,8.5 21,15.5 12,21 3,15.5 3,8.5"/></svg>';
  var ICON_ARROW = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  // Original "Ask the Map" starter questions — chosen so the structured
  // smart-query parser resolves each one cleanly into status/type/place/
  // year/sort criteria. Source of truth lives in journal-dock.js's TEACH_Q;
  // mirrored here so the overlay keeps the brand's curated phrasing.
  var STARTER_CHIPS = [
    'Tallest towers under construction in Florida',
    'Hotels opening around the world this year',
    'New condos coming to West Palm Beach',
    'Recent golf course openings'
  ];

  // Pre-rendered teach-row HTML. Built once at module load (the questions
  // never change at runtime) so the big DOM-template string concat stays
  // a simple list of static strings instead of mixing a .map() in.
  var STARTER_CHIPS_HTML = STARTER_CHIPS.map(function(q){
    return '<button class="tmw-ov-teach-ex" type="button" data-q="' + esc(q) + '">'
      +    '<span class="tmw-ov-teach-i">' + ICON_TEACH + '</span>'
      +    '<span class="tmw-ov-teach-qt">' + esc(q) + '</span>'
      +    '<span class="tmw-ov-teach-ent">&#8629;</span>'
      +  '</button>';
  }).join('');

  // "Or jump to" quick-jump pills — curated firm names + cities the user
  // wants to surface as one-click entry points below the question chips.
  // Same data-q click handler as the teach rows: typing in the value and
  // running runQuery inline. Order matters (firms first, places second).
  var QUICK_CHIPS = [
    'Related Ross',
    'Allen Morris Co',
    'Property Markets Group',
    'West Palm Beach',
    'Miami',
    'Nashville'
  ];
  var QUICK_CHIPS_HTML = QUICK_CHIPS.map(function(q){
    return '<button class="tmw-ov-chip" type="button" data-q="' + esc(q) + '">' + esc(q) + '</button>';
  }).join('');

  // Pro / quota pill — mirrors journal-dock.js's tmwIntelPillHTML so the
  // overlay's teach card shows the SAME PRO state + free-queries-left
  // count the dock teach panel does. Recomputed on every overlay open
  // since the quota can change between sessions.
  function renderProPill(){
    if (!window.tmwIntel) return '';
    var pro = window.tmwIntel.isPro && window.tmwIntel.isPro();
    if (pro) return '<span class="tmw-ov-pro on">PRO</span>';
    var left = window.tmwIntel.left ? window.tmwIntel.left() : 10;
    var lowCls = left <= 3 ? ' low' : '';
    return '<span class="tmw-ov-quota'+lowCls+'">' + left + ' / 10 left</span>'
      + '<a class="tmw-ov-pro" href="https://www.oftmw.com/map/?upgrade=1" data-tmw-paywall="feature:intelligence">PRO</a>';
  }
  function refreshProPill(){
    var slot = root.querySelector('[data-pill-slot]');
    if (slot) slot.innerHTML = renderProPill();
  }

  var root = document.createElement('div');
  root.className = 'tmw-ov-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'TMW search & Intelligence');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = ''
    + '<div class="tmw-ov-scrim"></div>'
    + '<div class="tmw-ov-lb">'
    +   '<button class="tmw-ov-close" type="button" aria-label="Close">&times;</button>'
    +   '<div class="tmw-ov-body">'
    +     '<div class="tmw-ov-wrap">'

    +       '<div class="tmw-ov-starter" data-state="starter">'
    +         '<div class="tmw-ov-teach" role="region" aria-label="TMW Intelligence — try asking">'
    +           '<div class="tmw-ov-teach-h">'
    +             '<div class="tmw-ov-teach-hex">' + ICON_HEX + '</div>'
    +             '<span class="tmw-ov-teach-ttl">TMW Intelligence</span>'
    +             '<span class="tmw-ov-pill" data-pill-slot></span>'
    +           '</div>'
    +           '<div class="tmw-ov-teach-sec">Try asking</div>'
    +           STARTER_CHIPS_HTML
    +           '<div class="tmw-ov-chip-sep">Or jump to</div>'
    +           '<div class="tmw-ov-chips">' + QUICK_CHIPS_HTML + '</div>'
    +           '<div class="tmw-ov-teach-foot">Type a name for instant results, or ask a full question.</div>'
    +         '</div>'
    +       '</div>'

    +       '<div class="tmw-ov-thinking" data-state="thinking">'
    +         '<div class="dots"><span></span><span></span><span></span></div>'
    +         '<span>Searching the database</span>'
    +       '</div>'

    +       '<div data-state="results" class="tmw-ov-hidden">'
    +         '<div data-slot="intel-cta"></div>'
    +         '<div data-slot="hero"></div>'
    +         '<div data-slot="rows"></div>'
    +         '<div data-slot="projects-grid"></div>'
    +         '<div data-slot="entities"></div>'
    +         '<div data-slot="articles-grid"></div>'
    +       '</div>'

    +       '<div data-state="empty" class="tmw-ov-empty tmw-ov-hidden">'
    +         '<h3>Nothing matched in the database</h3>'
    +         '<p>Try a firm name, city, or project. Or ask TMW Intelligence below — it can synthesize answers from the journal.</p>'
    +       '</div>'

    +     '</div>'
    +   '</div>'
    /* Thumbs feedback row -- centered above the search bar. Visible only
       on the results state (hidden during starter / thinking / empty).
       Two buttons (up / down) and a tiny "Thanks" confirmation that
       fades in after the user votes. Click POSTs a search_feedback
       event to the worker; rating + query text drive the discovery
       pipeline downstream. */
    +   '<div class="tmw-ov-feedback" data-feedback>'
    +     '<button class="tmw-ov-fb-btn" type="button" data-rating="up" aria-label="Helpful">'
    +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v9H3v-9zM21 9c0-1.1-.9-2-2-2h-5l1-3.5c.1-.4 0-.8-.3-1.1l-.7-.7-7 7v9h11l3-7V9z"/></svg>'
    +     '</button>'
    +     '<button class="tmw-ov-fb-btn" type="button" data-rating="down" aria-label="Not helpful">'
    +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 13V4h4v9zM3 15c0 1.1.9 2 2 2h5l-1 3.5c-.1.4 0 .8.3 1.1l.7.7 7-7V6H6L3 13v2z"/></svg>'
    +     '</button>'
    +     '<span class="tmw-ov-fb-thanks">Thanks — TMW will look into it</span>'
    +   '</div>'

    +   '<div class="tmw-ov-bar">'
    +     '<form class="tmw-ov-bar-inner tmw-dock-search" role="search">'
    +       '<span class="ds-ico">' + ICON_SEARCH_DOCK + '</span>'
    +       '<input type="search" autocomplete="off" placeholder="Search projects, firms, cities…" aria-label="Search projects, firms, cities">'
    +       '<button class="go" type="button" aria-label="Search">'
    +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
    +       '</button>'
    +     '</form>'
    +   '</div>'
    + '</div>';

  // Mount when body is available
  function mountRoot(){
    if (document.body) document.body.appendChild(root);
    else document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(root); });
  }
  mountRoot();

  var scrim  = root.querySelector('.tmw-ov-scrim');
  var input  = root.querySelector('.tmw-ov-bar input');
  var go     = root.querySelector('.tmw-ov-bar .go');
  var closeBtn = root.querySelector('.tmw-ov-close');
  var sStarter = root.querySelector('[data-state="starter"]');
  var sThinking= root.querySelector('[data-state="thinking"]');
  var sResults = root.querySelector('[data-state="results"]');
  var sEmpty   = root.querySelector('[data-state="empty"]');
  var slotIntel= root.querySelector('[data-slot="intel-cta"]');
  var slotHero = root.querySelector('[data-slot="hero"]');
  var slotRows = root.querySelector('[data-slot="rows"]');
  var slotProjGrid  = root.querySelector('[data-slot="projects-grid"]');
  var slotEntities  = root.querySelector('[data-slot="entities"]');
  var slotArticles  = root.querySelector('[data-slot="articles-grid"]');
  var bodyEl   = root.querySelector('.tmw-ov-body');

  // ── data loading (mirrors /search/) ────────────────────────────────
  var PROJECTS = [], FIRMS = [], ARTICLES = [], DATA_READY = false, _loading = null;

  function deriveFirmsFromProjects(projects){
    var map = new Map();
    function add(rawNames, rawSlugs, role){
      var names = String(rawNames||'').split(',').map(function(s){return s.trim();});
      var slugs = String(rawSlugs||'').split(',').map(function(s){return s.trim();});
      names.forEach(function(name, i){
        if (!name || name.toLowerCase()==='various') return;
        var slug = slugs[i] || '';
        var key = role+'|'+norm(name);
        var e = map.get(key);
        if (!e){ e = { name:name, role:role, slug:slug, project_count:0 }; map.set(key,e); }
        if (!e.slug && slug) e.slug = slug;
        e.project_count++;
      });
    }
    projects.forEach(function(p){ add(p.Developer, p.DeveloperSlugs, 'developer'); add(p.Architect, p.ArchitectSlugs, 'architect'); });
    return Array.from(map.values());
  }
  function loadArticles(){
    return fetch(WORKER_URL+'/posts?limit=500&status=published', { cache:'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if (d && Array.isArray(d.items) && d.items.length) return d.items;
        return [];
      })
      .catch(function(){ return []; });
  }
  function loadData(){
    if (_loading) return _loading;
    _loading = Promise.all([
      fetch('https://www.oftmw.com/map/projects-flat.json', { cache:'no-cache' }).then(function(r){ return r.ok ? r.json() : []; }).catch(function(){ return []; }),
      fetch('https://www.oftmw.com/firms-flat.json',         { cache:'no-cache' }).then(function(r){ return r.ok ? r.json() : []; }).catch(function(){ return []; }),
      loadArticles()
    ]).then(function(res){
      var p = res[0], f = res[1], a = res[2];
      PROJECTS = Array.isArray(p) ? p : (p.projects || p.items || []);
      if (Array.isArray(f) && f.length){
        FIRMS = f.map(function(x){ return Object.assign({ role:'firm' }, x); });
      } else if (f && (f.architects || f.developers)){
        FIRMS = [].concat(
          (f.architects||[]).map(function(x){ return Object.assign({}, x, { role:'architect' }); }),
          (f.developers||[]).map(function(x){ return Object.assign({}, x, { role:'developer' }); })
        );
      } else {
        FIRMS = [];
      }
      if (!FIRMS.length && PROJECTS.length) FIRMS = deriveFirmsFromProjects(PROJECTS);
      ARTICLES = a || [];
      DATA_READY = true;
    });
    return _loading;
  }

  // ── scoring (copied verbatim from /search/index.html so the overlay
  //   ranks results identically; if the search page ever updates these
  //   the overlay should be re-synced) ───────────────────────────────
  function scoreProject(p, toks, full){
    var title=norm(p.Title), city=norm(p.City), type=norm(firstField(p,['ProjectType','PreferredType']));
    var arch=norm(p.Architect), dev=norm(p.Developer);
    var desc=norm(firstField(p,['DescriptionLong','Description']));
    var s = 0;
    if (title===full) s+=120;
    else if (title.indexOf(full)===0) s+=50;
    else if (full && title.indexOf(full)>=0) s+=28;
    if (full && city===full) s+=22;
    for (var i=0;i<toks.length;i++){
      var t = toks[i];
      if (title.indexOf(t)>=0) s+=12;
      if (city.indexOf(t)>=0)  s+=8;
      if (type.indexOf(t)>=0)  s+=6;
      if (arch.indexOf(t)>=0)  s+=5;
      if (dev.indexOf(t)>=0)   s+=5;
      if (desc.indexOf(t)>=0)  s+=2;
    }
    if (s>0 && p.Featured) s+=1;
    return s;
  }
  function scoreFirm(f, toks, full){
    var name=norm(f.name), hq=norm(f.hq);
    var s=0;
    if (name===full) s+=60; else if (name.indexOf(full)===0) s+=28; else if (full && name.indexOf(full)>=0) s+=16;
    for (var i=0;i<toks.length;i++){ var t=toks[i]; if (name.indexOf(t)>=0) s+=10; if (hq.indexOf(t)>=0) s+=4; }
    if (s>0) s += Math.min(6, (+f.project_count||0)*0.4);
    return s;
  }
  function scoreArticle(a, toks, full){
    var title=norm(a.title), exc=norm(a.excerpt), cats=norm((a.categories||[]).join(' ')), tags=norm((a.tags||[]).join(' '));
    var hay = title+' '+exc+' '+cats+' '+tags;
    var meaningful = (window.TmwSearchCore && window.TmwSearchCore.filterMeaningfulTokens)
      ? window.TmwSearchCore.filterMeaningfulTokens(toks)
      : toks.filter(function(t){ return t.length>=3; });
    if (meaningful.length>=2){
      var need = Math.ceil(meaningful.length*0.6);
      var havePhrase = full && hay.indexOf(full)>=0;
      var haveWords = meaningful.filter(function(t){ return hay.indexOf(t)>=0; }).length;
      if (!havePhrase && haveWords < need) return 0;
    }
    var s=0;
    if (full){
      if (title.indexOf(full)>=0) s+=60;
      else if (exc.indexOf(full)>=0) s+=30;
      else if (hay.indexOf(full)>=0) s+=18;
    }
    var inTitle=0;
    for (var i=0;i<toks.length;i++){
      var t = toks[i];
      if (title.indexOf(t)>=0){ s+=10; inTitle++; }
      if (cats.indexOf(t)>=0) s+=6;
      if (tags.indexOf(t)>=0) s+=5;
      if (exc.indexOf(t)>=0)  s+=3;
    }
    if (meaningful.length>=2 && inTitle>=meaningful.length) s+=24;
    return s;
  }

  // ── status / sub-row helpers ──────────────────────────────────────
  function projectStatusBadge(p){
    var raw = String(firstField(p,['Delivery','Status']) || '').toLowerCase();
    if (!raw) return '';
    if (/complete|open|delivered|now open/.test(raw))     return '<span class="sb sb-open"><i></i>Open</span>';
    if (/construction|building/.test(raw))                 return '<span class="sb sb-construction"><i></i>Under construction</span>';
    if (/break(ing)? ground/.test(raw))                    return '<span class="sb sb-breaking"><i></i>Breaking ground</span>';
    if (/coming|soon|pre-?construction|permitting/.test(raw)) return '<span class="sb sb-soon"><i></i>'+esc(raw.charAt(0).toUpperCase()+raw.slice(1))+'</span>';
    return '<span class="sb">'+esc(raw.charAt(0).toUpperCase()+raw.slice(1))+'</span>';
  }

  // ── renderers ─────────────────────────────────────────────────────
  // Date / timeline helpers — ported from /search/'s parseYM + fmtMon +
  // timelineHtml so the overlay's hero matches the search page's hero
  // pixel-close (construction progress bar with start/end labels).
  function parseYM(s){
    var m = String(s||'').match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (!m) return null;
    return new Date(+m[1], (+m[2])-1, m[3] ? +m[3] : 1);
  }
  function fmtMon(d){ return d ? d.toLocaleString('en-US',{month:'short',year:'numeric'}) : ''; }

  function heroTimelineHtml(p){
    var start = parseYM(p.StartDate);
    var end   = parseYM(p.DeliveryDate);
    var status = firstField(p, ['Delivery']) || (end ? 'Expected ' + fmtMon(end) : '');
    if (!start && !end){
      return status
        ? '<div class="tmw-ov-tl"><div class="tmw-ov-tl-row"><span>Timeline</span><span class="tmw-ov-tl-status">'+esc(status)+'</span></div></div>'
        : '';
    }
    var pct;
    if (start && end){
      var nowTs = Date.now();
      pct = Math.max(0, Math.min(1, (nowTs - start.getTime()) / Math.max(1, (end.getTime() - start.getTime()))));
    } else {
      pct = end ? (Date.now() >= end.getTime() ? 1 : 0.5) : 0.05;
    }
    var pc = Math.round(pct * 100);
    var startLbl = start ? fmtMon(start) : '—';
    var endLbl   = end   ? fmtMon(end)   : 'TBA';
    return '<div class="tmw-ov-tl">'
      + '<div class="tmw-ov-tl-row"><span>Construction timeline</span>'+(status?'<span class="tmw-ov-tl-status">'+esc(status)+'</span>':'')+'</div>'
      + '<div class="tmw-ov-tl-track"><div class="tmw-ov-tl-fill" style="width:'+pc+'%"></div><div class="tmw-ov-tl-dot" style="left:'+pc+'%"></div></div>'
      + '<div class="tmw-ov-tl-ends"><span>'+esc(startLbl)+'</span><span>'+esc(endLbl)+'</span></div>'
    + '</div>';
  }

  function heroSpecHtml(p){
    var parts = [];
    function add(v, k){
      if (v == null) return;
      var s = String(v).trim();
      if (!s || s === '0') return;
      parts.push('<div class="tmw-ov-spec"><span class="v">'+esc(s)+'</span><span class="k">'+esc(k)+'</span></div>');
    }
    add(p.Units,  'Units');
    add(p.Keys,   'Keys');
    add(p.Floors, 'Floors');
    if (p.Price && String(p.Price).trim()) parts.push('<div class="tmw-ov-spec"><span class="v">'+esc(p.Price)+'</span><span class="k">From</span></div>');
    return parts.length ? '<div class="tmw-ov-specs">'+parts.join('')+'</div>' : '';
  }

  function commaFirstField(s){ return String(s||'').split(',')[0].trim(); }

  // Rich project hero — ports /search/'s heroHtml exactly. Image-left,
  // body-right. Body: h1 → loc → desc → timeline → specs → byline →
  // gold "Learn more" + ghost "Visit site" CTAs.
  function renderProjectHero(p){
    var img = firstField(p, ['ImageURL','Image2','Image3']);
    var city = p.City || '';
    var desc = firstField(p, ['DescriptionLong','Description']);
    var dev  = commaFirstField(p.Developer);
    var arch = commaFirstField(p.Architect);
    var site = p.OfficialWebsite;
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(p.Title)+'" loading="eager" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var byline = '';
    if (dev || arch){
      byline = '<div class="tmw-ov-byline">'
        + (dev  ? 'Developed by <b>'+esc(dev)+'</b>'      : '')
        + (dev && arch ? ' · ' : '')
        + (arch ? 'Architecture by <b>'+esc(arch)+'</b>' : '')
        + '</div>';
    }
    return '<article class="tmw-ov-hero">'
      + '<div class="media">'+media+'<div class="scrim"></div><span class="besttag">Top match</span></div>'
      + '<div class="body">'
      +   '<h2>'+esc(p.Title)+'</h2>'
      +   (city ? '<div class="loc">'+esc(city)+'</div>' : '')
      +   (desc ? '<p class="desc">'+esc(desc)+'</p>' : '')
      +   heroTimelineHtml(p)
      +   heroSpecHtml(p)
      +   byline
      +   '<div class="tmw-ov-hero-cta">'
      +     '<a class="tmw-ov-btn gold" href="'+esc(mapLink(p.Title, true))+'">'
      +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
      +       'Learn more'
      +     '</a>'
      +     (site
              ? '<a class="tmw-ov-btn ghost" href="'+esc(site)+'" target="_blank" rel="noopener">Visit site'
                + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>'
                + '</a>'
              : '')
      +   '</div>'
      + '</div>'
      + '</article>';
  }

  // Article hero — same image-left/body-right geometry as the project
  // hero, with the rich design treatment (eyebrow, big serif headline,
  // date, excerpt) PLUS the gold "Read story" CTA + ghost-link byline
  // for parity with the project hero's button row.
  function renderArticleHero(a){
    var img = a.cover_image || '';
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(a.title)+'" loading="eager" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var date = a.published_iso ? new Date(a.published_iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
    var excerpt = a.excerpt || a.description || '';
    var author = a.author_name || '';
    var byline = author
      ? '<div class="tmw-ov-byline">By <b>'+esc(author)+'</b></div>'
      : '';
    var href = 'https://www.oftmw.com/post/'+encodeURIComponent(a.slug||'')+'/';
    return '<article class="tmw-ov-hero">'
      + '<div class="media">'+media+'<div class="scrim"></div><span class="besttag">Top story</span></div>'
      + '<div class="body">'
      +   '<div class="tmw-ov-hero-chips"><span class="tmw-ov-hero-chip type">From the journal</span>'+(date?'<span class="tmw-ov-hero-chip">'+esc(date)+'</span>':'')+'</div>'
      +   '<h2>'+esc(a.title)+'</h2>'
      +   (excerpt ? '<p class="desc">'+esc(excerpt)+'</p>' : '')
      +   byline
      +   '<div class="tmw-ov-hero-cta">'
      +     '<a class="tmw-ov-btn gold" href="'+esc(href)+'">'
      +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
      +       'Read story'
      +     '</a>'
      +   '</div>'
      + '</div>'
      + '</article>';
  }

  // Firm hero — gradient-panel media (no cover image) with the firm
  // initial as a soft mark. Same body geometry + CTA row as the project
  // and article heroes.
  function renderFirmHero(f){
    var roleLbl = f.role === 'architect' ? 'Architect of Tomorrow'
               : f.role === 'developer' ? 'Developer of Tomorrow'
               : 'Firm of Tomorrow';
    var pc = +f.project_count || 0;
    var initial = (f.name || '?').trim().charAt(0).toUpperCase();
    var href = f.slug
      ? ('https://www.oftmw.com/firm/' + encodeURIComponent(f.slug) + '/')
      : (SEARCH_URL + '?q=' + encodeURIComponent(f.name));
    return '<article class="tmw-ov-hero">'
      + '<div class="media"><div class="tmw-ov-firmmark">'+esc(initial)+'</div><div class="scrim"></div><span class="besttag">Top firm</span></div>'
      + '<div class="body">'
      +   '<div class="tmw-ov-hero-chips"><span class="tmw-ov-hero-chip type">'+esc(roleLbl)+'</span></div>'
      +   '<h2>'+esc(f.name)+'</h2>'
      +   (f.hq ? '<div class="loc">'+esc(f.hq)+'</div>' : '')
      +   (pc > 0 ? '<p class="desc">'+pc+' project'+(pc===1?'':'s')+' tracked in the Markets of Tomorrow network.</p>' : '')
      +   '<div class="tmw-ov-hero-cta">'
      +     '<a class="tmw-ov-btn gold" href="'+esc(href)+'">'
      +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
      +       'View profile'
      +     '</a>'
      +   '</div>'
      + '</div>'
      + '</article>';
  }

  function renderProjectRow(p, rank, lead, scorePct){
    var city = p.City || '';
    var type = firstField(p,['ProjectType','PreferredType']);
    var badge = projectStatusBadge(p);
    var subParts = [];
    if (badge) subParts.push(badge);
    if (city) subParts.push('<span>'+esc(city)+'</span>');
    if (type) subParts.push('<span>'+esc(type)+'</span>');
    var sub = subParts.join('<span class="dot"></span>');
    return '<a class="tmw-ov-row '+(lead?'lead':'')+'" href="'+esc(mapLink(p.Title, true))+'">'
      + '<div class="rank">'+rank+'</div>'
      + '<div class="r-ico">'+ICON_BLDG+'</div>'
      + '<div class="r-main"><div class="r-name">'+esc(p.Title)+'</div><div class="r-sub">'+sub+'</div></div>'
      + '<div class="r-bar"><span style="width:'+Math.max(8,Math.min(100,scorePct))+'%"></span></div>'
      + '<div class="arrow">'+ICON_ARROW+'</div>'
      + '</a>';
  }
  function renderFirmRow(f, rank, lead, scorePct){
    var sub = (f.role==='architect' ? 'Architect' : (f.role==='developer' ? 'Developer' : 'Firm'))
            + (f.project_count ? (' · ' + f.project_count + ' project' + (f.project_count===1?'':'s')) : '');
    var href = f.slug ? ('https://www.oftmw.com/firm/' + encodeURIComponent(f.slug) + '/') : (SEARCH_URL + '?q=' + encodeURIComponent(f.name));
    return '<a class="tmw-ov-row '+(lead?'lead':'')+'" href="'+esc(href)+'">'
      + '<div class="rank">'+rank+'</div>'
      + '<div class="r-ico">'+ICON_FIRM+'</div>'
      + '<div class="r-main"><div class="r-name">'+esc(f.name)+'</div><div class="r-sub"><span>'+esc(sub)+'</span></div></div>'
      + '<div class="r-bar"><span style="width:'+Math.max(8,Math.min(100,scorePct))+'%"></span></div>'
      + '<div class="arrow">'+ICON_ARROW+'</div>'
      + '</a>';
  }
  function renderArticleRow(a, rank, lead, scorePct){
    var date = a.published_iso ? new Date(a.published_iso).toLocaleDateString('en-US',{month:'short',year:'numeric'}) : '';
    return '<a class="tmw-ov-row '+(lead?'lead':'')+'" href="https://www.oftmw.com/post/'+encodeURIComponent(a.slug||'')+'/">'
      + '<div class="rank">'+rank+'</div>'
      + '<div class="r-ico">'+ICON_ARTICLE+'</div>'
      + '<div class="r-main"><div class="r-name">'+esc(a.title)+'</div><div class="r-sub"><span>From the journal</span>'+(date?'<span class="dot"></span><span>'+esc(date)+'</span>':'')+'</div></div>'
      + '<div class="r-bar"><span style="width:'+Math.max(8,Math.min(100,scorePct))+'%"></span></div>'
      + '<div class="arrow">'+ICON_ARROW+'</div>'
      + '</a>';
  }

  function renderIntelCTA(q){
    return '<a class="tmw-ov-intel-cta" href="'+SEARCH_URL+'?q='+encodeURIComponent(q)+'">'
      + '<div class="icn">'+ICON_SPARK+'</div>'
      + '<div class="body">'
      +   '<div class="lbl">TMW Intelligence</div>'
      +   '<div class="q">'+esc(q)+'</div>'
      + '</div>'
      + '<div class="arrow">'+ICON_ARROW+'</div>'
      + '</a>';
  }

  // ─── PHASE 2: inline TMW Intelligence panel ─────────────────────────
  // Replaces the previous link-to-/search/ CTA with a real, in-overlay
  // panel that renders the LLM answer. Three states share the same shell
  // so the swap from loading → answer doesn't shift layout.
  function intelPanelHtml(state, q, answer){
    var live, ansClass, ansHtml;
    if (state === 'loading'){
      live = '<i></i>Thinking';
      ansClass = 'loading';
      ansHtml = '<span class="tmw-ov-intel-loader" aria-hidden="true"><span></span><span></span><span></span></span>'
              + 'Looking through projects and stories for an answer…';
    } else if (state === 'answer'){
      live = '<i></i>Live answer';
      ansClass = '';
      // LLM responses are plain text; render as textContent equivalent
      // (escaped) so a stray "<" can't break the panel.
      ansHtml = esc(answer || '');
    } else if (state === 'no-answer'){
      live = '<span class="live dim"><i></i></span>No verified answer';
      ansClass = '';
      ansHtml = 'No verified answer in our database for that question — the top match below is the closest we have.';
    } else { // error
      live = '<span class="live dim"><i></i></span>Intelligence unreachable';
      ansClass = '';
      ansHtml = 'Could not reach TMW Intelligence right now — showing the closest matches below.';
    }
    return '<section class="tmw-ov-intel-panel">'
      +   '<div class="tmw-ov-intel-h">'
      +     '<span class="tmw-ov-intel-spark">'+ICON_SPARK+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +     '<span class="live">'+live+'</span>'
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans '+ansClass+'">'+ansHtml+'</p>'
      +   '<div class="tmw-ov-intel-foot">'
      +     '<span class="ai">TMW Intelligence</span> · synthesized from the journal &amp; database'
      +     '<a href="'+SEARCH_URL+'?q='+encodeURIComponent(q||'')+'">Open in full search '+ICON_ARROW+'</a>'
      +   '</div>'
      + '</section>';
  }

  // Out-of-free-queries upgrade panel (gold accent) — mirrors /search/'s
  // intel-gate; opens the native in-page paywall via [data-tmw-paywall].
  function intelGateHtml(){
    return '<section class="tmw-ov-intel-panel gate">'
      +   '<div class="tmw-ov-intel-h">'
      +     '<span class="tmw-ov-intel-spark">'+ICON_SPARK+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans">You’ve used all <b>10 free</b> TMW Intelligence searches. Go <b>Pro</b> for unlimited natural-language search across the entire development pipeline — every project, firm, and milestone.</p>'
      +   '<a class="tmw-ov-pro-btn" href="https://www.oftmw.com/map/?upgrade=1" data-tmw-paywall="feature:intelligence">Go Pro — unlimited intelligence</a>'
      + '</section>';
  }

  // Partner-of-Tomorrow spotlight — curated answer for queries naming an
  // experiential partner (TREMBLE, Humanaut, etc.). NEVER gated and never
  // calls the LLM; the prose comes from the spotlight table.
  function spotlightHtml(spot){
    var chips = '<div class="tmw-ov-understood">'
      +   '<span class="lead">Understood as</span>'
      +   '<span class="tmw-ov-uchip"><span class="ck">Partner</span> <b>'+esc(spot.name)+'</b></span>'
      +   (spot.region    ? '<span class="tmw-ov-uchip"><span class="ck">Region</span> <b>'+esc(spot.region)+'</b></span>'    : '')
      +   (spot.catShort  ? '<span class="tmw-ov-uchip"><span class="ck">Category</span> <b>'+esc(spot.catShort)+'</b></span>': '')
      + '</div>';
    var prose = spot.prose
      ? spot.prose
      : '<b>'+esc(spot.name)+'</b> is a <b>Partner of Tomorrow</b> — '+esc(spot.catShort||'')+'. <span class="hl">'+esc(spot.tagline||'')+'</span>';
    var panel = '<section class="tmw-ov-intel-panel">'
      +   '<div class="tmw-ov-intel-h">'
      +     '<span class="tmw-ov-intel-spark">'+ICON_SPARK+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +     '<span class="live"><i></i>Live answer</span>'
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans">'+prose+'</p>'
      + '</section>';
    var cta = spot.ctaUrl
      ? '<a class="tmw-ov-spot-cta" href="'+esc(spot.ctaUrl)+'" target="_blank" rel="noopener">'+esc(spot.ctaLabel||'Learn more')+ICON_ARROW+'</a>'
      : '';
    var head = '<div class="tmw-ov-spot-head"><h3>'+esc(spot.name)+(spot.region?' · '+esc(spot.region):'')+'</h3>'+cta+'</div>';
    var rows = '';
    if (spot.items && spot.items.length){
      rows = '<div class="tmw-ov-rows">' + spot.items.map(function(it, i){
        return '<div class="tmw-ov-row '+(i===0?'lead':'')+'">'
          +   '<div class="rank">'+(i+1)+'</div>'
          +   '<div class="r-ico">'+ICON_PIN+'</div>'
          +   '<div class="r-main">'
          +     '<div class="r-name">'+esc(it.name)+'</div>'
          +     '<div class="r-sub"><span class="sb sb-open"><i></i>'+esc(it.badge||'Now open')+'</span>'
          +       (it.city?'<span class="dot"></span><span>'+esc(it.city)+'</span>':'')
          +     '</div>'
          +   '</div>'
          + '</div>';
      }).join('') + '</div>';
    }
    return chips + panel + head + rows;
  }

  // ─── PHASE 2 (complete): /search/-style result sections ─────────────
  // The "View all results on search" CTA is gone — the overlay IS the
  // search page now, with full hero stack + grids + articles + load-more
  // rendered inline. /search/ remains canonical for direct deep links
  // (?q=… URLs from analytics, share links) but isn't a destination
  // anyone needs to navigate to.

  // Hero eligibility — each kind has its own gate so a weak partial match
  // never gets promoted to "Top match". Mirrors /search/index.html.
  function heroProjectEligible(p, full, toks){
    var title = norm(p.Title);
    if (full && title.indexOf(full) >= 0) return true;
    var meaningful = (window.TmwSearchCore && window.TmwSearchCore.filterMeaningfulTokens)
      ? window.TmwSearchCore.filterMeaningfulTokens(toks)
      : toks.filter(function(t){ return t.length >= 3; });
    if (!meaningful.length) return false;
    var inTitle = meaningful.filter(function(t){ return title.indexOf(t) >= 0; }).length;
    return inTitle >= Math.ceil(meaningful.length * 0.6);
  }
  function heroArticleEligible(a, full, toks){
    var title = norm(a.title || '');
    var meaningful = (window.TmwSearchCore && window.TmwSearchCore.filterMeaningfulTokens)
      ? window.TmwSearchCore.filterMeaningfulTokens(toks)
      : toks.filter(function(t){ return t.length >= 3; });
    if (!meaningful.length) return false;
    var inTitle = meaningful.filter(function(t){ return title.indexOf(t) >= 0; }).length;
    return inTitle >= 1;
  }
  function heroFirmEligible(f, full){
    var nm = norm(f.name || '');
    return full && (nm === full || nm.indexOf(full) === 0);
  }

  // Build cities-with-counts from the PROJECTS array. Same shape /search/
  // uses for the chiprow: { name, count }.
  function deriveCitiesFromProjects(projects){
    var by = {};
    for (var i = 0; i < projects.length; i++){
      var c = (projects[i].City || '').trim();
      if (c) by[c] = (by[c] || 0) + 1;
    }
    return Object.keys(by).map(function(c){ return { name: c, count: by[c] }; });
  }
  function scoreCity(c, toks, full){
    var nc = norm(c.name);
    var s = 0;
    if (nc === full) s += 60;
    else if (nc.indexOf(full) === 0) s += 30;
    else if (full && nc.indexOf(full) >= 0) s += 18;
    for (var i = 0; i < toks.length; i++){ if (nc.indexOf(toks[i]) >= 0) s += 10; }
    if (s > 0) s += Math.min(6, (c.count || 0) * 0.3);
    return s;
  }

  // Compact "Nearby Project" card (for the grid section). Image-on-top
  // layout matches /search/'s .pcard exactly. Links open the map deeplink
  // with fullscreen so the user lands directly on the marker + drawer.
  function renderProjectCard(p){
    var img = firstField(p, ['ImageURL','Image2','Image3']);
    var type = firstField(p, ['ProjectType','PreferredType']);
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(p.Title)+'" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var status = p.Delivery || '';
    return '<a class="tmw-ov-pcard" href="'+esc(mapLink(p.Title, true))+'">'
      + '<div class="tmw-ov-pcard-media">'+media+(type?'<span class="ptype">'+esc(type)+'</span>':'')+'</div>'
      + '<div class="tmw-ov-pcard-body">'
      +   '<h4>'+esc(p.Title)+'</h4>'
      +   (p.City ? '<div class="loc">'+esc(p.City)+'</div>' : '')
      +   '<div class="meta"><span>'+esc(status)+'</span><span class="openmap">→</span></div>'
      + '</div></a>';
  }

  function renderFirmEntity(f){
    var sub = (f.role === 'architect' ? 'Architect' : (f.role === 'developer' ? 'Developer' : 'Firm'))
            + (f.project_count ? (' · ' + f.project_count + ' project' + (f.project_count === 1 ? '' : 's')) : '');
    var href = f.slug
      ? ('https://www.oftmw.com/firm/' + encodeURIComponent(f.slug) + '/')
      : (SEARCH_URL + '?q=' + encodeURIComponent(f.name));
    return '<a class="tmw-ov-entity" href="'+esc(href)+'">'
      + '<div class="icn">'+ICON_FIRM+'</div>'
      + '<div><div class="nm">'+esc(f.name)+'</div><div class="sub">'+esc(sub)+'</div></div>'
      + '</a>';
  }
  function renderCityEntity(c){
    return '<a class="tmw-ov-entity" href="'+MAP_URL+'/?city='+encodeURIComponent(c.name)+'">'
      + '<div class="icn">'+ICON_PIN+'</div>'
      + '<div><div class="nm">'+esc(c.name)+'</div><div class="sub">'+c.count+' project'+(c.count === 1 ? '' : 's')+'</div></div>'
      + '</a>';
  }

  function renderArticleCard(a){
    var img = a.cover_image || '';
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(a.title)+'" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var date = a.published_iso
      ? new Date(a.published_iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      : '';
    return '<a class="tmw-ov-acard" href="https://www.oftmw.com/post/'+encodeURIComponent(a.slug||'')+'/">'
      + '<div class="tmw-ov-acard-media">'+media+'</div>'
      + '<div class="tmw-ov-acard-body">'
      +   (date ? '<div class="adate">'+esc(date)+'</div>' : '')
      +   '<h4>'+esc(a.title)+'</h4>'
      +   '<div class="acta">Read story <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>'
      + '</div></a>';
  }

  // ─── PHASE 2B: structured smart query renderers ──────────────────────
  // When parseSmartQuery returns non-null criteria, the overlay renders
  // the "deterministic Intelligence" layout: understood-as chips, purple
  // panel with synthesized sentence + stats grid, header with map link,
  // ranked rows with metric column. Same shape as /search/'s renderSmart.

  function renderUnderstoodChips(s){
    var chips = [];
    if (s.firm) {
      var roleLbl = s.firm.role === 'developer' ? 'Developer' : (s.firm.role === 'architect' ? 'Architect' : 'Firm');
      chips.push('<span class="tmw-ov-uchip"><span class="ck">'+roleLbl+'</span> <b>'+esc(s.firm.name)+'</b></span>');
    }
    if (s.phaseLabels && s.phaseLabels.length) chips.push('<span class="tmw-ov-uchip"><span class="ck">Milestone</span> <b>'+esc(s.phaseLabels.join(' / '))+'</b></span>');
    if (s.statusLabels.length)                 chips.push('<span class="tmw-ov-uchip"><span class="ck">Status</span> <b>'+esc(s.statusLabels.join(' / '))+'</b></span>');
    if (s.typeLabel)                           chips.push('<span class="tmw-ov-uchip"><span class="ck">Type</span> <b>'+esc(s.typeLabel)+'</b></span>');
    if (s.cities.length)                       chips.push('<span class="tmw-ov-uchip"><span class="ck">City</span> <b>'+esc(s.cities.join(' & '))+'</b></span>');
    else if (s.region)                         chips.push('<span class="tmw-ov-uchip"><span class="ck">Region</span> <b>'+esc(s.region)+'</b></span>');
    if (s.yearLabel)                           chips.push('<span class="tmw-ov-uchip"><span class="ck">Delivery</span> <b>'+esc(s.yearLabel)+'</b></span>');
    if (s.sort)                                chips.push('<span class="tmw-ov-uchip sort"><span class="ck">Sort</span> <b>'+esc(s.sort.label)+'</b></span>');
    if (!chips.length) return '';
    return '<div class="tmw-ov-understood"><span class="lead">Understood as</span>' + chips.join('') + '</div>';
  }

  // The intel panel with the deterministic answer + DB-derived stats grid.
  // After this renders, fireSmartIntelUpgrade() may replace the sentence
  // with an LLM-written version (figures stay; only the prose softens).
  function renderSmartIntelPanel(ans){
    var stats = '';
    if (ans.stats && ans.stats.length){
      stats = '<div class="tmw-ov-intel-stats" style="grid-template-columns:repeat('+ans.stats.length+',1fr)">'
        + ans.stats.map(function(st){
            return '<div class="tmw-ov-istat"><div class="v">'+st.v+'</div><div class="k">'+esc(st.k)+'</div></div>';
          }).join('')
        + '</div>';
    }
    return '<section class="tmw-ov-intel-panel">'
      +   '<div class="tmw-ov-intel-h">'
      +     '<span class="tmw-ov-intel-spark">'+ICON_SPARK+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +     '<span class="live"><i></i>Live answer</span>'
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans">'+ans.html+'</p>'
      +   stats
      + '</section>';
  }

  function renderSmartHeader(s, rows){
    var n = rows.length;
    var title = n === 1 ? '1 project' : (n + ' projects');
    var sub = s.sort ? ' · ' + esc(s.sort.label.toLowerCase()) : '';
    var firmLink = (s.firm && s.firm.slug)
      ? '<a class="map-link" href="https://www.oftmw.com/firm/'+encodeURIComponent(s.firm.slug)+'/">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M6 21V8l5-3 5 3v13M10 12h2M10 16h2"/></svg> View ' + esc(s.firm.name)
        + '</a>'
      : '';
    var mapHref = (s.cities.length === 1) ? (MAP_URL + '/?city=' + encodeURIComponent(s.cities[0])) : MAP_URL;
    var mapLink = '<a class="map-link" href="' + esc(mapHref) + '">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"/><path d="M9 3v15M15 6v15"/></svg> Show on map'
      + '</a>';
    return '<div class="tmw-ov-smart-head"><h3>' + title + '</h3>'
      + (sub ? '<span class="sub">' + sub + '</span>' : '')
      + firmLink + mapLink
      + '</div>';
  }

  // A single sorted result row. When the query has a numeric sort
  // (floors / units / date), the relevance bar is replaced with a
  // metric column on the right that visualizes the sort dimension.
  function renderSmartRow(p, rank, s, maxMetric){
    var Core = window.TmwSearchCore;
    var badge = Core.STATUS_BADGE[p.Delivery] || { cls: 'sb-announced', label: p.Delivery || '' };
    var sortKey = s.sort && s.sort.key;
    var metric = '';
    var bar = '';
    if (sortKey === 'floors') {
      var f = Core.floorsOf(p);
      bar = '<div class="r-bar"><span style="width:' + (maxMetric > 0 ? Math.round((f / maxMetric) * 100) : 0) + '%"></span></div>';
      metric = '<div class="r-metric"><div class="n">' + (f || '—') + '</div><div class="l">Stories</div></div>';
    } else if (sortKey === 'units') {
      var u = Core.unitsOf(p);
      bar = '<div class="r-bar"><span style="width:' + (maxMetric > 0 ? Math.round((u / maxMetric) * 100) : 0) + '%"></span></div>';
      metric = '<div class="r-metric"><div class="n">' + (u ? u.toLocaleString() : '—') + '</div><div class="l">Units</div></div>';
    } else if (sortKey === 'date') {
      metric = '<div class="r-metric"><div class="n" style="font-size:14px">' + (esc(Core.fmtDelivery(p) || '—')) + '</div><div class="l">Delivers</div></div>';
    }
    var deliveryNote = (!sortKey && Core.fmtDelivery(p)) ? ('<span class="dot"></span><span>Delivers ' + esc(Core.fmtDelivery(p)) + '</span>') : '';
    var sub = '<span class="sb '+badge.cls+'"><i></i>'+esc(badge.label)+'</span>'
            + (p.City ? '<span class="dot"></span><span>'+esc(p.City)+'</span>' : '')
            + deliveryNote;
    return '<a class="tmw-ov-row '+(rank === 1 && sortKey ? 'lead' : '')+'" href="'+esc(mapLink(p.Title, true))+'">'
      + '<div class="rank">'+rank+'</div>'
      + '<div class="r-ico">'+ICON_BLDG+'</div>'
      + '<div class="r-main"><div class="r-name">'+esc(p.Title)+'</div><div class="r-sub">'+sub+'</div></div>'
      + bar
      + metric
      + '<div class="arrow">'+ICON_ARROW+'</div>'
      + '</a>';
  }

  // ── orchestration ─────────────────────────────────────────────────
  function setState(name){
    sStarter.classList.toggle('tmw-ov-hidden', name !== 'starter');
    sThinking.classList.toggle('show', name === 'thinking');
    sResults.classList.toggle('tmw-ov-hidden', name !== 'results');
    sEmpty.classList.toggle('tmw-ov-hidden', name !== 'empty');
    // Thumbs feedback row only makes sense when actual results are on
    // screen -- show on 'results' and 'empty' (a thumbs-down on an empty
    // result page is the highest-signal feedback we can capture), hide
    // everywhere else.
    var fbEl = root.querySelector('.tmw-ov-feedback');
    if (fbEl) fbEl.classList.toggle('show', name === 'results' || name === 'empty');
    bodyEl.scrollTop = 0;
  }

  var _renderToken = 0;
  // Separate token for the LLM call so a slow /smart-answer response
  // for query N doesn't paint over the loading shell of query N+1.
  var _intelToken = 0;
  var _intelDebounce = null;
  // Latest settled query + its result kind/count — used by the thumbs
  // feedback POST. Reset on every new query so a vote always describes
  // the result set currently on screen.
  var _lastQuery = '';
  var _lastResultsTotal = 0;
  var _lastResultKind = ''; // 'text' | 'smart' | 'spotlight' | 'question' | 'empty'

  // ── Thumbs feedback ─────────────────────────────────────────────────
  // Reset the feedback row to its unvoted, dim state. Called at the top
  // of every runQuery so a previous vote doesn\'t bleed across queries.
  function resetFeedback(){
    var fbEl = root.querySelector('.tmw-ov-feedback');
    if (!fbEl) return;
    fbEl.classList.remove('voted');
    var btns = fbEl.querySelectorAll('.tmw-ov-fb-btn');
    for (var i = 0; i < btns.length; i++){
      btns[i].classList.remove('voted', 'dimmed');
    }
  }
  // POST the user\'s vote to the worker as a search_feedback event.
  // Uses the same ingest path as window.tmwIntel.track (so it lands in
  // the same `events` D1 table) but with event_name="search_feedback"
  // so the admin can roll up these specifically. Best-effort -- a
  // dropped beacon shouldn\'t affect the user\'s flow.
  function sendFeedback(rating){
    try {
      if (!_lastQuery) return;
      var m = window.__tmwMember || null;
      var pro = !!(window.tmwIntel && window.tmwIntel.isPro && window.tmwIntel.isPro());
      var did = '';
      try { did = localStorage.getItem('tmw_did') || ''; } catch(_){}
      var payload = JSON.stringify({
        member_id: (m && m.id) || ('anon:' + (did || 'unknown')),
        member_name: (m && m.name) || null,
        plan: pro ? 'paid' : (m ? 'free' : 'anon'),
        event_name: 'search_feedback',
        path: location.pathname,
        referrer: document.referrer || null,
        client_ts: Math.floor(Date.now() / 1000),
        props: {
          q: String(_lastQuery).slice(0, 200),
          rating: rating, // 'up' or 'down'
          results: _lastResultsTotal,
          result_kind: _lastResultKind,
          source: 'overlay'
        }
      });
      var url = 'https://tmw.jake-ab7.workers.dev/event';
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }));
      else fetch(url, { method:'POST', body:payload, keepalive:true, headers:{ 'Content-Type':'text/plain' } }).catch(function(){});
    } catch(_){}
  }
  // Single delegated click handler for the two thumbs buttons. Voting
  // locks both buttons (pointer-events:none) so the user can\'t double-
  // vote on the same query; the chosen rating gets the colored fill,
  // the other goes dim. The .voted class on the parent fades in the
  // "Thanks" confirmation text.
  root.addEventListener('click', function(e){
    var btn = e.target.closest && e.target.closest('.tmw-ov-fb-btn');
    if (!btn) return;
    var fbEl = btn.closest('.tmw-ov-feedback');
    if (!fbEl || fbEl.classList.contains('voted')) return;
    var rating = btn.getAttribute('data-rating');
    if (rating !== 'up' && rating !== 'down') return;
    sendFeedback(rating);
    fbEl.classList.add('voted');
    var btns = fbEl.querySelectorAll('.tmw-ov-fb-btn');
    for (var i = 0; i < btns.length; i++){
      btns[i].classList.add('voted');
      if (btns[i] !== btn) btns[i].classList.add('dimmed');
    }
  });

  function runQuery(rawQ){
    var q = String(rawQ||'').trim();
    if (!q) { setState('starter'); return; }

    var token = ++_renderToken;
    setState('thinking');
    // Reset the thumbs row for the incoming query so a previous vote
    // doesn't bleed across. _lastQuery / _lastResultsTotal / _lastResultKind
    // are repopulated by whichever render path handles this query.
    _lastQuery = q;
    _lastResultsTotal = 0;
    _lastResultKind = '';
    resetFeedback();

    // ── Partner-of-Tomorrow spotlight (curated, no LLM, never gated) ──
    // Has to render BEFORE we touch the LLM or hit the database — typing
    // "tremble" should land on the spotlight card, not a generic search.
    var Core = window.TmwSearchCore;
    var spot = Core ? Core.matchSpotlight(q) : null;
    if (spot){
      slotIntel.innerHTML = '';
      slotHero.innerHTML = '<div class="tmw-ov-sec">' + spotlightHtml(spot) + '</div>';
      slotRows.innerHTML = '';
      slotProjGrid.innerHTML = '';
      slotEntities.innerHTML = '';
      slotArticles.innerHTML = '';
      sEmpty.classList.add('tmw-ov-hidden');
      _lastResultsTotal = 1;
      _lastResultKind = 'spotlight';
      setState('results');
      return;
    }

    loadData().then(function(){
      if (token !== _renderToken) return;

      // ── PHASE 2B: structured smart query ─────────────────────────────
      // Try parseSmartQuery FIRST — if the query has enough structure
      // (status + place + type, sort + place, firm + anything, etc.) we
      // skip text-match scoring entirely and render the deterministic
      // Intelligence layout. This is the "tallest towers under
      // construction in the Carolinas" path.
      var smart = Core && Core.parseSmartQuery
        ? Core.parseSmartQuery(q, { firms: FIRMS, projects: PROJECTS })
        : null;
      if (smart) {
        renderStructuredSmart(q, smart, token);
        return;
      }
      // Otherwise fall through to text-match scoring + the question /
      // LLM path. Token re-checked inside runTextMatch.
      runTextMatch(q, token);
    });
  }

  // The structured-smart-query render. Mirrors /search/'s renderSmart:
  // chips → intel panel (answer + stats) → header → ranked rows → foot.
  // Also fires the LLM upgrade to replace the deterministic sentence
  // with prose (figures stay DB-derived).
  function renderStructuredSmart(q, s, token){
    var Core = window.TmwSearchCore;
    // Clear sections owned by other paths so a previous text-match
    // render doesn't bleed through (grid / firms / articles).
    slotProjGrid.innerHTML = '';
    slotEntities.innerHTML = '';
    slotArticles.innerHTML = '';
    var allowed = !window.tmwIntel || (typeof window.tmwIntel.allowed === 'function' && window.tmwIntel.allowed(q));
    if (!allowed) {
      // Out of free queries → gate panel (no DB query, no LLM call).
      slotIntel.innerHTML = intelGateHtml();
      slotHero.innerHTML = '';
      slotRows.innerHTML = '';
      setState('results');
      return;
    }

    var rows = Core.smartRank(Core.smartFilter(s, PROJECTS), s);
    var ans = Core.buildSmartAnswer(s, rows);

    // Header slot carries the "understood as" chips
    var chipsHtml = renderUnderstoodChips(s);
    var panelHtml = renderSmartIntelPanel(ans);
    slotIntel.innerHTML = chipsHtml + panelHtml;

    // Promote the top smart-filtered project to a hero card -- same rich
    // /search/-style layout the text-match path uses (timeline, specs,
    // byline, Learn more / Visit site CTAs). The smart rows section
    // below skips this hero so the same project doesn't render twice.
    // When there's only one match (e.g. "pine crest school"), the hero
    // IS the result -- the rows section gets hidden so we don't show
    // an awkward empty "0 projects" header.
    var heroProject = rows.length ? rows[0] : null;
    var restRows = rows.length > 1 ? rows.slice(1) : [];
    if (heroProject) {
      slotHero.innerHTML = '<div class="tmw-ov-sec">' + renderProjectHero(heroProject) + '</div>';
    } else {
      slotHero.innerHTML = '';
    }

    if (restRows.length){
      var maxMetric = 1;
      if (s.sort && s.sort.key === 'floors') maxMetric = Math.max.apply(null, restRows.map(Core.floorsOf).concat([1]));
      else if (s.sort && s.sort.key === 'units') maxMetric = Math.max.apply(null, restRows.map(Core.unitsOf).concat([1]));
      var SMART_CAP = 40;
      var shown = restRows.slice(0, SMART_CAP);
      // Ranks start at 2 since rank 1 is the hero card above.
      var rowsHtml = shown.map(function(p, i){ return renderSmartRow(p, i + 2, s, maxMetric); }).join('');
      var foot = (restRows.length > SMART_CAP)
        ? '<div class="tmw-ov-smart-foot">Showing top '+SMART_CAP+' of '+rows.length+' — refine your question to narrow it.</div>'
        : '';
      foot += '<div class="tmw-ov-smart-foot"><span class="ai">TMW Intelligence</span> · answer synthesized from the project database · figures verified, not generated</div>';
      slotRows.innerHTML = '<div class="tmw-ov-sec">'
        + renderSmartHeader(s, shown)
        + '<div class="tmw-ov-rows">' + rowsHtml + '</div>'
        + foot
        + '</div>';
    } else {
      slotRows.innerHTML = '';
    }

    // LLM upgrade: replace the deterministic sentence with prose (stats stay).
    if (rows.length) fireSmartIntelUpgrade(q, s, rows);

    // Count this query against the user's 10 free (intelligence.js gate)
    try {
      if (window.tmwIntel && window.tmwIntel.count) window.tmwIntel.count(q);
      if (window.tmwIntel && window.tmwIntel.track) window.tmwIntel.track(q, { results: rows.length, sort: s.sort ? s.sort.label : null, source: 'overlay' });
    } catch(_){}

    _lastResultsTotal = rows.length;
    _lastResultKind = 'smart';
    setState('results');
  }

  // Debounced LLM rewrite of the structured-smart sentence. Same 700ms
  // settle as /search/. Stale-token guarded so a late response for
  // query N doesn't paint over query N+1.
  function fireSmartIntelUpgrade(q, s, rows){
    var Core = window.TmwSearchCore;
    if (!Core) return;
    var facts = Core.buildSmartFacts(s, rows);
    var myToken = ++_intelToken;
    clearTimeout(_intelDebounce);
    _intelDebounce = setTimeout(function(){
      if (myToken !== _intelToken) return;
      Core.askIntelligence(q, facts).then(function(res){
        if (myToken !== _intelToken) return;
        if (!res || !res.ok || !res.answer) return; // deterministic answer already shown
        var ansEl = slotIntel.querySelector('.tmw-ov-intel-ans');
        if (ansEl) ansEl.textContent = res.answer;
      });
    }, 700);
  }

  // Original text-match path -- extracted from runQuery body so the new
  // structured-smart branch can early-return cleanly. Same behavior as
  // before: spotlight already handled above, smart already tried; this
  // is the fallback for queries that are neither (e.g. typing a name or
  // a free-form question without structured criteria).
  // Render-state for the load-more articles button. Reset on every new
  // text-match query so we always start from the top of the new result
  // set instead of carrying a stale "10 already shown" pointer over.
  var _articlesAll = [];
  var _articlesShown = 0;
  var ARTICLES_BATCH = 10;
  var MAX_PROJECTS_GRID = 12;  // mirror /search/'s MAX_PROJECTS
  var MAX_FIRMS  = 6;
  var MAX_CITIES = 6;

  function runTextMatch(q, token){
    if (token !== _renderToken) return;
    var Core = window.TmwSearchCore;

    var full = norm(q);
    var toks = tokenize(q);
    // Use the shared isQuestion so /search/ and the overlay always agree
    // on what counts as a question (the local fallback runs only during
    // the brief window before journal-search-core.js finishes loading).
    var question = (Core ? Core.isQuestion : isQuestion)(q);

    var pScored = PROJECTS.map(function(p){ return { p:p, s:scoreProject(p, toks, full) }; })
                          .filter(function(x){ return x.s > 0; })
                          .sort(function(a,b){ return b.s - a.s; });
    var fScored = FIRMS.map(function(f){ return { f:f, s:scoreFirm(f, toks, full) }; })
                       .filter(function(x){ return x.s > 0; })
                       .sort(function(a,b){ return b.s - a.s; });
    var aScored = ARTICLES.map(function(a){ return { a:a, s:scoreArticle(a, toks, full) }; })
                          .filter(function(x){ return x.s > 0; })
                          .sort(function(a,b){ return b.s - a.s; });
    // Cities aren't a separate index — derive from projects on first use
    // per session. Same pattern as /search/.
    if (!PROJECTS._tmwOvCities) PROJECTS._tmwOvCities = deriveCitiesFromProjects(PROJECTS);
    var cScored = PROJECTS._tmwOvCities.map(function(c){ return { c:c, s:scoreCity(c, toks, full) }; })
                                       .filter(function(x){ return x.s > 0; })
                                       .sort(function(a,b){ return b.s - a.s; });

    var totalHits = pScored.length + fScored.length + aScored.length;

    // ── Intelligence panel (inline LLM answer) ──────────────────────
    // Decide before paint so the panel slot is correct from the first
    // frame -- prevents a flash of a hero-only layout that then jumps
    // when the LLM loading shell appears above it.
    var allowed = !window.tmwIntel || (typeof window.tmwIntel.allowed === 'function' && window.tmwIntel.allowed(q));
    if (question){
      if (!allowed){
        slotIntel.innerHTML = intelGateHtml();
      } else if (Core && totalHits > 0){
        slotIntel.innerHTML = intelPanelHtml('loading', q);
        fireIntelligence(q,
          pScored.slice(0,5).map(function(x){ return x.p; }),
          aScored.slice(0,3).map(function(x){ return x.a; })
        );
      } else if (Core){
        slotIntel.innerHTML = intelPanelHtml('loading', q);
        fireIntelligence(q, [], []);
      } else {
        slotIntel.innerHTML = renderIntelCTA(q);
      }
    } else {
      slotIntel.innerHTML = '';
    }

    // Clear smart-rows slot (it's only populated by parseSmartQuery path)
    slotRows.innerHTML = '';

    // Empty state: not a question, nothing matched, nothing to show.
    if (!totalHits && !question){
      slotHero.innerHTML = '';
      slotProjGrid.innerHTML = '';
      slotEntities.innerHTML = '';
      slotArticles.innerHTML = '';
      _lastResultsTotal = 0;
      _lastResultKind = 'empty';
      setState('empty');
      return;
    }
    if (!totalHits){
      // Question with no DB hits — Intelligence panel above is the answer.
      slotHero.innerHTML = '';
      slotProjGrid.innerHTML = '';
      slotEntities.innerHTML = '';
      slotArticles.innerHTML = '';
      _lastResultsTotal = 0;
      _lastResultKind = 'question';
      setState('results');
      return;
    }

    // ── Single hero ─────────────────────────────────────────────────
    // Promote ONE result as the hero — the highest-scoring across all
    // three types that passes its eligibility gate. The other types
    // still appear in their grid sections below, just without a "Top
    // match" treatment. Small score bias toward projects since they're
    // the database core and the most common search target.
    var heroProject = null, heroArticle = null, heroFirm = null;
    var heroCandidates = [];
    if (pScored.length && heroProjectEligible(pScored[0].p, full, toks)) heroCandidates.push({ kind:'project', s: pScored[0].s * 1.05, item: pScored[0].p });
    if (aScored.length && heroArticleEligible(aScored[0].a, full, toks)) heroCandidates.push({ kind:'article', s: aScored[0].s,        item: aScored[0].a });
    if (fScored.length && heroFirmEligible(fScored[0].f, full))          heroCandidates.push({ kind:'firm',    s: fScored[0].s,        item: fScored[0].f });
    heroCandidates.sort(function(a,b){ return b.s - a.s; });
    var hero = heroCandidates[0] || null;
    if (hero){
      var heroHtml = '';
      if      (hero.kind === 'project') { heroProject = hero.item; heroHtml = renderProjectHero(heroProject); }
      else if (hero.kind === 'article') { heroArticle = hero.item; heroHtml = renderArticleHero(heroArticle); }
      else if (hero.kind === 'firm')    { heroFirm    = hero.item; heroHtml = renderFirmHero(heroFirm); }
      slotHero.innerHTML = '<div class="tmw-ov-sec">' + heroHtml + '</div>';
    } else {
      slotHero.innerHTML = '';
    }

    // ── Projects ────────────────────────────────────────────────────
    // Tightened relevance filter for multi-token queries: a result must
    // either contain the full phrase OR all meaningful tokens (≥3 chars)
    // in its title. Without this, "Currie Park" pulls anything matching
    // just "park" — Saudi Arabia, Las Vegas etc. — and the section reads
    // as a false-positive dump. Single-token queries skip the filter
    // (relevance score already handles it).
    var meaningful = (window.TmwSearchCore && window.TmwSearchCore.filterMeaningfulTokens)
      ? window.TmwSearchCore.filterMeaningfulTokens(toks)
      : toks.filter(function(t){ return t.length >= 3; });
    var restProjects = pScored.filter(function(x){ return x.p !== heroProject; });
    if (meaningful.length >= 2) {
      restProjects = restProjects.filter(function(x){
        var t = norm(x.p.Title);
        if (full && t.indexOf(full) >= 0) return true;
        return meaningful.every(function(tok){ return t.indexOf(tok) >= 0; });
      });
    }
    var gridProjects = restProjects.slice(0, MAX_PROJECTS_GRID).map(function(x){ return x.p; });
    if (gridProjects.length){
      // Section label changed from "Nearby Projects" -> "Projects" — the
      // grid wasn't geographically nearby (the rest of the result set
      // can include any matching city), so the spatial framing was
      // misleading. Count reflects the filtered set, not the raw text-
      // match total.
      slotProjGrid.innerHTML = ''
        + '<div class="tmw-ov-sec">'
        +   '<div class="tmw-ov-sec-head"><h3>Projects</h3><span class="count">'+restProjects.length+' total</span></div>'
        +   '<div class="tmw-ov-grid">' + gridProjects.map(renderProjectCard).join('') + '</div>'
        + '</div>';
    } else {
      slotProjGrid.innerHTML = '';
    }

    // ── Firms & places ──────────────────────────────────────────────
    // Same multi-token filter as the projects grid: common single words
    // ("city", "park", "lake") create huge false-positive sets when used
    // alone -- e.g. "salt lake city" matched "City of WPB", "Park City",
    // "Lake Worth Beach" purely via one shared token. For multi-token
    // queries we now require the full phrase OR all meaningful tokens
    // (>=3 chars) in the name. Singletons skip the filter -- relevance
    // score handles them.
    var restFirms  = fScored.filter(function(x){ return x.f !== heroFirm; });
    var restCities = cScored.slice();
    if (meaningful.length >= 2) {
      restFirms = restFirms.filter(function(x){
        var t = norm(x.f.name);
        if (full && t.indexOf(full) >= 0) return true;
        return meaningful.every(function(tok){ return t.indexOf(tok) >= 0; });
      });
      restCities = restCities.filter(function(x){
        var t = norm(x.c.name);
        if (full && t.indexOf(full) >= 0) return true;
        return meaningful.every(function(tok){ return t.indexOf(tok) >= 0; });
      });
    }
    var firms  = restFirms.slice(0, MAX_FIRMS).map(function(x){ return x.f; });
    var cities = restCities.slice(0, MAX_CITIES).map(function(x){ return x.c; });
    if (firms.length || cities.length){
      var entityHtml = firms.map(renderFirmEntity).join('') + cities.map(renderCityEntity).join('');
      slotEntities.innerHTML = ''
        + '<div class="tmw-ov-sec">'
        +   '<div class="tmw-ov-sec-head"><h3>Firms &amp; places</h3><span class="count">'+(restFirms.length + restCities.length)+' total</span></div>'
        +   '<div class="tmw-ov-chiprow">'+entityHtml+'</div>'
        + '</div>';
    } else {
      slotEntities.innerHTML = '';
    }

    // ── From the journal (batched with load-more) ───────────────────
    _articlesAll = aScored.map(function(x){ return x.a; }).filter(function(a){ return a !== heroArticle; });
    _articlesShown = 0;
    if (_articlesAll.length){
      slotArticles.innerHTML = ''
        + '<div class="tmw-ov-sec">'
        +   '<div class="tmw-ov-sec-head"><h3>From the journal</h3><span class="count">'+aScored.length+' total</span></div>'
        +   '<div class="tmw-ov-alist"></div>'
        + '</div>';
      appendArticles();
    } else {
      slotArticles.innerHTML = '';
    }

    _lastResultsTotal = totalHits;
    _lastResultKind = question ? 'question' : 'text';
    setState('results');

    // Log plain text-match queries to the Studio analytics tab. Question
    // + structured-smart paths log via tmwIntel.count/track elsewhere;
    // plain searches (e.g. "1428 Brickell", "Wynwood") never reach those
    // paths, so without this branch the Studio would lose visibility on
    // every typed query that didn't trigger Intelligence.
    try {
      if (!question && window.tmwIntel && window.tmwIntel.trackSearch) {
        window.tmwIntel.trackSearch(q, { source: 'overlay', results: totalHits });
      }
    } catch(_){}
  }

  // Append the next batch of articles + manage the load-more button.
  // Idempotent: a final batch removes the button; called from runTextMatch
  // for the first batch and from the button click for each subsequent.
  function appendArticles(){
    var listEl = slotArticles.querySelector('.tmw-ov-alist');
    if (!listEl) return;
    var batch = _articlesAll.slice(_articlesShown, _articlesShown + ARTICLES_BATCH);
    if (!batch.length) return;
    listEl.insertAdjacentHTML('beforeend', batch.map(renderArticleCard).join(''));
    _articlesShown += batch.length;
    // Re-render the load-more button (remove existing, add a fresh one
    // if anything remains). Simpler than mutating in place.
    var existing = slotArticles.querySelector('.tmw-ov-loadmore');
    if (existing) existing.remove();
    if (_articlesShown < _articlesAll.length){
      var remaining = _articlesAll.length - _articlesShown;
      var nextBatch = Math.min(ARTICLES_BATCH, remaining);
      var sec = slotArticles.querySelector('.tmw-ov-sec');
      if (sec) sec.insertAdjacentHTML('beforeend',
        '<button class="tmw-ov-loadmore" type="button" data-action="more-articles">Load '+nextBatch+' more stor'+(nextBatch===1?'y':'ies')+'</button>'
      );
    }
  }

  // ── fire /smart-answer with debounce + stale-token guard ──────────
  // Called from runQuery once per settled query. Bumps _intelToken so a
  // late-returning response for a stale query doesn't paint over the
  // current loading shell.
  function fireIntelligence(q, topProjects, topArticles){
    var Core = window.TmwSearchCore;
    if (!Core) return;
    var facts = Core.buildIntelFacts(topProjects, topArticles);
    var myToken = ++_intelToken;
    clearTimeout(_intelDebounce);
    _intelDebounce = setTimeout(function(){
      if (myToken !== _intelToken) return;
      Core.askIntelligence(q, facts).then(function(res){
        if (myToken !== _intelToken) return;
        if (res && res.ok && res.answer){
          slotIntel.innerHTML = intelPanelHtml('answer', q, res.answer);
          // Count this against the user's 10 free queries (intelligence.js
          // gate; Pro users are uncounted). Mirrors /search/.
          try {
            if (window.tmwIntel && window.tmwIntel.count) window.tmwIntel.count(q);
            if (window.tmwIntel && window.tmwIntel.track) window.tmwIntel.track(q, { results: facts.top.length, source: 'overlay' });
          } catch(_){}
        } else if (res && res.error){
          slotIntel.innerHTML = intelPanelHtml('error', q);
        } else {
          slotIntel.innerHTML = intelPanelHtml('no-answer', q);
        }
      });
    }, 700);
  }

  // Debounced live-as-you-type. Short queries (1 char) just wait.
  var _debounce = null;
  function onInput(){
    var v = (input.value || '').trim();
    clearTimeout(_debounce);
    if (!v) { setState('starter'); return; }
    if (v.length < 2) { setState('starter'); return; }
    _debounce = setTimeout(function(){ runQuery(v); }, 180);
  }

  // navigateToSearch removed: the overlay IS the search experience now
  // (Enter / arrow click run runQuery inline instead of redirecting to
  // /search/?q=). The /search/ page remains as the canonical deep-link
  // target for share URLs, but no UI path navigates to it.
  //
  // Plain text-match queries are logged once per settled query via
  // window.tmwIntel.trackSearch from runTextMatch so the Studio's
  // analytics tab still sees what people type in the overlay alongside
  // the structured-smart + LLM queries fired by the Intelligence paths.

  // ── open / close ──────────────────────────────────────────────────
  var _savedScrollY = 0;
  function open(initialQuery){
    if (root.classList.contains('open')) return;
    _savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.style.overflow = 'hidden';
    root.classList.add('open');
    setState('starter');
    // Refresh the PRO / quota badge in the teach card -- the user may have
    // burned queries since the last time the overlay was opened.
    refreshProPill();
    if (initialQuery) {
      input.value = initialQuery;
      onInput();
    } else {
      input.value = '';
    }
    // Defocus map / page elements so iOS doesn't pop the keyboard awkwardly
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch(_){}
    // Focus after the transition starts so the bar is in place
    setTimeout(function(){ try { input.focus({ preventScroll:true }); } catch(_){ input.focus(); } }, 180);
    // Kick off data load now so by the time they type results are ready
    loadData();
  }
  function close(){
    if (!root.classList.contains('open')) return;
    root.classList.remove('open');
    document.documentElement.style.overflow = '';
    setTimeout(function(){ window.scrollTo(0, _savedScrollY); }, 0);
    setTimeout(function(){
      input.value = '';
      setState('starter');
      slotIntel.innerHTML = '';
      slotHero.innerHTML = '';
      slotRows.innerHTML = '';
      slotProjGrid.innerHTML = '';
      slotEntities.innerHTML = '';
      slotArticles.innerHTML = '';
      _articlesAll = [];
      _articlesShown = 0;
      _renderToken++;
    }, 320);
  }

  scrim.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', function(e){
    if (e.key === 'Enter') {
      e.preventDefault();
      var v = (input.value || '').trim();
      // The overlay IS the search experience now -- Enter runs the query
      // inline instead of redirecting to /search/. /search/ remains as a
      // canonical deep-link target for share URLs (?q=... permalinks) but
      // isn't a destination anyone needs to navigate to from the UI.
      if (v) runQuery(v);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  go.addEventListener('click', function(){
    var v = (input.value || '').trim();
    if (v) runQuery(v);
  });

  // Suggestion click (teach-card row OR legacy starter chip) → fill the
  // bar + run inline. Also wires the "Load more stories" button -- single
  // delegated handler for everything inside the overlay so the wiring
  // lives in one place. Match-by-data-q so any future suggestion variant
  // (different markup, same intent) just needs to carry the attribute.
  root.addEventListener('click', function(e){
    var sug = e.target.closest && e.target.closest('[data-q]');
    if (sug) {
      var q = sug.getAttribute('data-q');
      if (q) { input.value = q; runQuery(q); }
      return;
    }
    var more = e.target.closest && e.target.closest('[data-action="more-articles"]');
    if (more) {
      e.preventDefault();
      appendArticles();
      return;
    }
  });

  // ── Wire the dock's existing search bar to open the overlay ─────────
  // The dock bar (look + behavior at rest) is unchanged; focusing or
  // clicking it now opens the lightbox and carries over any text the
  // user already started typing. The dock input is blurred so its own
  // autocomplete dropdown doesn't pop up alongside the overlay.
  //
  // EXCEPTION: on the /map/ surface the dock search bar is the spatial
  // explorer (filter pins + fly to) — that role can't be hijacked. Map
  // users still get the overlay via the "/" hotkey, just not via the
  // dock click. This mirrors the user's "two-jobs" decision: sidebar/
  // dock-on-map = Explore, dock-on-journal + "/" = Ask.
  function handleDockTrigger(e){
    if (typeof window.tmwSurface === 'function' && window.tmwSurface() === 'map') return;
    var t = e.target;
    if (!t || !t.closest) return;
    var ds = t.closest('.tmw-dock input[type="search"][name="q"]');
    if (!ds) return;
    if (root.classList.contains('open')) return;
    var existing = (ds.value || '').trim();
    // Transfer focus to the overlay input INSIDE the user gesture (click /
    // focusin) so iOS keeps the keyboard up through the transition. If we
    // wait until after the open() animation starts, Safari dismisses the
    // keyboard and pops it back when we focus 180ms later -- jarring.
    input.value = existing;
    try { input.focus({ preventScroll: true }); } catch(_){ try { input.focus(); } catch(__){} }
    open(existing);
    setTimeout(function(){ try { ds.blur(); } catch(_){} }, 0);
  }
  document.addEventListener('focusin', handleDockTrigger);
  document.addEventListener('click',  handleDockTrigger);

  // ── global hotkey: "/" opens, Esc closes ──────────────────────────
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && root.classList.contains('open')) { close(); return; }
    if (e.key === '/' && !root.classList.contains('open')) {
      var ae = document.activeElement;
      var tag = ae && ae.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (ae && ae.isContentEditable)) return;
      e.preventDefault();
      open();
    }
  });

  // ── any [data-tmw-overlay] element opens it (lets pages drop in
  //    discoverable affordances without coupling to this script) ────
  document.addEventListener('click', function(e){
    var t = e.target && e.target.closest ? e.target.closest('[data-tmw-overlay]') : null;
    if (!t) return;
    // Don't hijack a real link if the user metaclicks it
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    var q = t.getAttribute('data-tmw-overlay-q') || '';
    open(q);
  }, true);

  // ── public API ────────────────────────────────────────────────────
  window.tmwOverlay = {
    open: open,
    close: close,
    isOpen: function(){ return root.classList.contains('open'); }
  };
})();
