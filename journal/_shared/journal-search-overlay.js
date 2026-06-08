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

    + '.tmw-ov-top{display:flex;align-items:center;gap:12px;padding:18px 26px;'
    + 'background:linear-gradient(180deg,rgba(7,8,7,.55),transparent)}'
    + '.tmw-ov-top .hexmark{width:30px;height:30px;display:flex;align-items:center;justify-content:center}'
    + '.tmw-ov-top .hexmark svg{width:100%;height:100%;overflow:visible}'
    + '.tmw-ov-hxs-spin{transform-origin:50% 50%;animation:tmwOvHxsSpin 4.2s cubic-bezier(.16,1,.3,1) infinite}'
    + '.tmw-ov-hxs-core{transform-origin:50% 50%;animation:tmwOvHxsPulse 4.2s ease-in-out infinite}'
    + '.tmw-ov-hxs-ring{transform-origin:50% 50%;animation:tmwOvHxsRing 4.2s ease-out infinite}'
    + '@media(prefers-reduced-motion:reduce){.tmw-ov-hxs-spin,.tmw-ov-hxs-ring{animation:none}.tmw-ov-hxs-ring{opacity:0}}'
    + '.tmw-ov-top .title{font-family:"Fraunces",Georgia,serif;font-size:15px;color:#B9A6FF;letter-spacing:.04em;font-weight:500}'
    + '.tmw-ov-top .title b{color:#fff;font-weight:600}'
    + '.tmw-ov-top .close{margin-left:auto;width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.04);'
    + 'border:1px solid rgba(255,255,255,.14);color:#C2C9C3;display:flex;align-items:center;justify-content:center;'
    + 'font-size:22px;line-height:1;cursor:pointer;transition:all .2s;font-family:inherit}'
    + '.tmw-ov-top .close:hover{color:#fff;border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.08)}'

    + '.tmw-ov-body{flex:1;overflow-y:auto;padding:8px 0 220px;-webkit-overflow-scrolling:touch}'
    + '.tmw-ov-body::-webkit-scrollbar{width:8px}'
    + '.tmw-ov-body::-webkit-scrollbar-track{background:transparent}'
    + '.tmw-ov-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:4px}'
    + '.tmw-ov-wrap{max-width:1080px;margin:0 auto;padding:0 22px}'

    /* Starter (empty) state */
    + '.tmw-ov-starter{padding:40px 0 24px;text-align:center;animation:tmwOvFadeIn .35s ease both}'
    + '.tmw-ov-starter .eyebrow{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#B9A6FF;margin-bottom:14px;font-weight:700}'
    + '.tmw-ov-starter h2{font-family:"Fraunces",Georgia,serif;font-size:30px;color:#fff;max-width:18ch;margin:0 auto 8px;font-weight:600;letter-spacing:-.015em;line-height:1.08}'
    + '.tmw-ov-starter p{color:#9AA39C;font-size:14px;max-width:42ch;margin:0 auto 28px}'
    + '.tmw-ov-chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:680px;margin:0 auto}'
    + '.tmw-ov-chip{font-family:inherit;font-size:12.5px;color:#ECEAE5;background:rgba(167,139,250,.08);'
    + 'border:1px solid rgba(167,139,250,.25);padding:9px 14px;border-radius:999px;cursor:pointer;transition:all .2s;line-height:1.2}'
    + '.tmw-ov-chip:hover{background:rgba(167,139,250,.16);border-color:#A78BFA;color:#fff}'
    + '.tmw-ov-chip-sep{display:flex;align-items:center;gap:14px;margin:32px auto 16px;max-width:300px;'
    + 'font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#9AA39C}'
    + '.tmw-ov-chip-sep::before,.tmw-ov-chip-sep::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.08)}'

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

    /* "View all results" CTA */
    + '.tmw-ov-viewall{display:flex;align-items:center;justify-content:center;gap:8px;margin:8px 0 0;'
    + 'padding:14px 20px;border-radius:12px;background:transparent;border:1px solid rgba(255,255,255,.14);'
    + 'color:#ECEAE5;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;'
    + 'cursor:pointer;transition:all .2s;text-decoration:none;width:100%;font-family:inherit}'
    + '.tmw-ov-viewall:hover{border-color:#e6c574;color:#fff;background:rgba(230,197,116,.06)}'
    + '.tmw-ov-viewall svg{width:14px;height:14px}'

    /* Empty result state */
    + '.tmw-ov-empty{padding:40px 0;text-align:center;color:#9AA39C;animation:tmwOvFadeIn .3s}'
    + '.tmw-ov-empty h3{font-family:"Fraunces",Georgia,serif;font-size:22px;color:#ECEAE5;margin-bottom:8px;font-weight:600}'
    + '.tmw-ov-empty p{font-size:14px;max-width:40ch;margin:0 auto 18px}'

    /* The bottom-pinned search bar (mirrors /search/'s .searchbox treatment) */
    + '.tmw-ov-bar{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);'
    + 'width:min(820px, calc(100vw - 32px));z-index:2}'
    + '.tmw-ov-bar-inner{position:relative;display:flex;align-items:center}'
    + '.tmw-ov-bar-inner::before{content:"";position:absolute;inset:-2px;border-radius:20px;padding:2px;z-index:0;pointer-events:none;'
    + 'background:conic-gradient(from var(--tmw-ov-ang,0deg),rgba(167,139,250,0) 0deg,rgba(167,139,250,0) 200deg,#A78BFA 300deg,#E9DEFF 340deg,rgba(167,139,250,0) 360deg);'
    + '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;'
    + 'animation:tmwOvChase 3.4s linear infinite}'
    + '@media(prefers-reduced-motion:reduce){.tmw-ov-bar-inner::before{animation:none}}'
    + '.tmw-ov-bar .mag{position:absolute;left:22px;width:22px;height:22px;color:#B9A6FF;pointer-events:none;z-index:2}'
    + '.tmw-ov-bar input{position:relative;z-index:1;width:100%;height:70px;padding:0 130px 0 58px;'
    + 'background:rgba(15,17,15,.92);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);'
    + 'border:1px solid rgba(167,139,250,.35);border-radius:18px;color:#fff;font-family:"Fraunces",Georgia,serif;font-size:23px;outline:none;'
    + 'box-shadow:0 0 38px rgba(167,139,250,.22), 0 22px 60px rgba(0,0,0,.6);transition:border-color .2s,box-shadow .2s}'
    + '.tmw-ov-bar input::placeholder{color:#9AA39C;font-family:"Fraunces",Georgia,serif;font-style:italic}'
    + '.tmw-ov-bar input:focus{border-color:rgba(167,139,250,.65);box-shadow:0 0 48px rgba(167,139,250,.34), 0 22px 60px rgba(0,0,0,.6)}'
    + '.tmw-ov-bar input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}'
    + '.tmw-ov-bar .hint{position:absolute;right:74px;font-size:10px;letter-spacing:.16em;'
    + 'text-transform:uppercase;color:#9AA39C;padding:4px 9px;border:1px solid rgba(255,255,255,.14);'
    + 'border-radius:6px;z-index:2;pointer-events:none}'
    + '.tmw-ov-bar .go{position:absolute;right:16px;height:46px;width:46px;padding:0;border:0;background:transparent;'
    + 'color:#e6c574;display:flex;align-items:center;justify-content:center;z-index:2;border-radius:50%;cursor:pointer;'
    + 'transition:transform .2s, background .2s}'
    + '.tmw-ov-bar .go:hover{background:rgba(230,197,116,.12);transform:translateX(2px)}'
    + '.tmw-ov-bar .go svg{width:24px;height:24px;filter:drop-shadow(0 0 8px rgba(230,197,116,.45))}'

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

    + '.tmw-ov-hidden{display:none!important}'

    + '@media(max-width:760px){'
    +   '.tmw-ov-hero{grid-template-columns:1fr}'
    +   '.tmw-ov-hero .media{min-height:180px}'
    +   '.tmw-ov-bar input{font-size:18px;height:62px;padding-right:64px}'
    +   '.tmw-ov-bar .hint{display:none}'
    +   '.tmw-ov-row .r-bar{display:none}'
    +   '.tmw-ov-top{padding:14px 18px}'
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

  var ICON_BLDG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V6.5L12 3l8 3.5V21"/><path d="M9 21v-6h6v6"/><path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/></svg>';
  var ICON_FIRM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
  var ICON_ARTICLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h14v16H6a2 2 0 0 1-2-2z"/><line x1="8" y1="9" x2="14" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/></svg>';
  var ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7.5 7-13a7 7 0 1 0-14 0c0 5.5 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></svg>';
  var ICON_SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12,3 21,8.5 21,15.5 12,21 3,15.5 3,8.5"/></svg>';
  var ICON_ARROW = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  var STARTER_CHIPS = [
    "What's happening in Wynwood right now?",
    "Tallest towers under construction in the Carolinas",
    "Which Arquitectonica projects break ground in 2026?",
    "What did MoT cover last month in St. Louis?"
  ];

  var QUICK_CHIPS = [
    { q:'1428 Brickell',     k:'project' },
    { q:'Foster + Partners', k:'firm' },
    { q:'Wynwood',           k:'place' },
    { q:'Currie Park',       k:'place' }
  ];

  var root = document.createElement('div');
  root.className = 'tmw-ov-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'TMW search & Intelligence');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = ''
    + '<div class="tmw-ov-scrim"></div>'
    + '<div class="tmw-ov-lb">'
    +   '<div class="tmw-ov-top">'
    +     '<div class="hexmark">' + ICON_HEX + '</div>'
    +     '<div class="title"><b>TMW</b> Intelligence &amp; Search</div>'
    +     '<button class="close" type="button" aria-label="Close">&times;</button>'
    +   '</div>'
    +   '<div class="tmw-ov-body">'
    +     '<div class="tmw-ov-wrap">'

    +       '<div class="tmw-ov-starter" data-state="starter">'
    +         '<div class="eyebrow">Search · Ask · Explore</div>'
    +         '<h2>What do you want to know about the urban South?</h2>'
    +         '<p>Find any project, firm, or city — or ask TMW Intelligence a question in plain English.</p>'
    +         '<div class="tmw-ov-chips" data-chips="questions">'
    +           STARTER_CHIPS.map(function(q){ return '<button class="tmw-ov-chip" type="button" data-q="'+esc(q)+'">'+esc(q)+'</button>'; }).join('')
    +         '</div>'
    +         '<div class="tmw-ov-chip-sep">Or jump to</div>'
    +         '<div class="tmw-ov-chips" data-chips="quick">'
    +           QUICK_CHIPS.map(function(c){ return '<button class="tmw-ov-chip" type="button" data-q="'+esc(c.q)+'">'+esc(c.q)+'</button>'; }).join('')
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
    +         '<div data-slot="viewall"></div>'
    +       '</div>'

    +       '<div data-state="empty" class="tmw-ov-empty tmw-ov-hidden">'
    +         '<h3>Nothing matched in the database</h3>'
    +         '<p>Try a firm name, city, or project. Or ask TMW Intelligence below — it can synthesize answers from the journal.</p>'
    +       '</div>'

    +     '</div>'
    +   '</div>'
    +   '<div class="tmw-ov-bar">'
    +     '<div class="tmw-ov-bar-inner">'
    +       '<svg class="mag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>'
    +       '<input type="search" autocomplete="off" placeholder="Ask TMW Intelligence or search projects, firms, cities…" aria-label="Search">'
    +       '<span class="hint">Esc to close</span>'
    +       '<button class="go" type="button" aria-label="Search">'
    +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
    +       '</button>'
    +     '</div>'
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
  var closeBtn = root.querySelector('.tmw-ov-top .close');
  var sStarter = root.querySelector('[data-state="starter"]');
  var sThinking= root.querySelector('[data-state="thinking"]');
  var sResults = root.querySelector('[data-state="results"]');
  var sEmpty   = root.querySelector('[data-state="empty"]');
  var slotIntel= root.querySelector('[data-slot="intel-cta"]');
  var slotHero = root.querySelector('[data-slot="hero"]');
  var slotRows = root.querySelector('[data-slot="rows"]');
  var slotView = root.querySelector('[data-slot="viewall"]');
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
    var meaningful = toks.filter(function(t){ return t.length>=3; });
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
  function renderProjectHero(p){
    var img = firstField(p,['ImageURL','Image2','Image3']);
    var type = firstField(p,['ProjectType','PreferredType']);
    var city = p.City || '';
    var desc = firstField(p,['DescriptionLong','Description']);
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(p.Title)+'" loading="eager" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    return '<a class="tmw-ov-hero" href="'+esc(mapLink(p.Title, true))+'">'
      + '<div class="media">'+media+'<div class="scrim"></div><span class="besttag">Top match</span></div>'
      + '<div class="body">'
      +   '<div class="eyebrow">'+esc(type || 'Project')+'</div>'
      +   '<h2>'+esc(p.Title)+'</h2>'
      +   (city ? '<div class="loc">'+esc(city)+'</div>' : '')
      +   (desc ? '<p class="desc">'+esc(desc)+'</p>' : '')
      + '</div></a>';
  }
  function renderFirmHero(f){
    var roleLbl = f.role==='architect' ? 'Architect of Tomorrow' : (f.role==='developer' ? 'Developer of Tomorrow' : 'Firm of Tomorrow');
    var pc = +f.project_count || 0;
    var initial = (f.name || '?').trim().charAt(0).toUpperCase();
    var href = f.slug ? ('https://www.oftmw.com/firm/' + encodeURIComponent(f.slug) + '/') : (SEARCH_URL + '?q=' + encodeURIComponent(f.name));
    return '<a class="tmw-ov-hero" href="'+esc(href)+'">'
      + '<div class="media"><div class="tmw-ov-firmmark">'+esc(initial)+'</div><div class="scrim"></div><span class="besttag">Top firm</span></div>'
      + '<div class="body">'
      +   '<div class="eyebrow">'+esc(roleLbl)+'</div>'
      +   '<h2>'+esc(f.name)+'</h2>'
      +   (f.hq ? '<div class="loc">'+esc(f.hq)+'</div>' : '')
      +   (pc>0 ? '<p class="desc">'+pc+' project'+(pc===1?'':'s')+' tracked in the Markets of Tomorrow network.</p>' : '')
      + '</div></a>';
  }
  function renderArticleHero(a){
    var img = a.cover_image || '';
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(a.title)+'" loading="eager" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var date = a.published_iso ? new Date(a.published_iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
    var excerpt = a.excerpt || a.description || '';
    return '<a class="tmw-ov-hero" href="https://www.oftmw.com/post/'+encodeURIComponent(a.slug||'')+'/">'
      + '<div class="media">'+media+'<div class="scrim"></div><span class="besttag">Top story</span></div>'
      + '<div class="body">'
      +   '<div class="eyebrow">From the journal</div>'
      +   '<h2>'+esc(a.title)+'</h2>'
      +   (date ? '<div class="loc">'+esc(date)+'</div>' : '')
      +   (excerpt ? '<p class="desc">'+esc(excerpt)+'</p>' : '')
      + '</div></a>';
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

  function renderViewAll(q, totalHits){
    return '<a class="tmw-ov-viewall" href="'+SEARCH_URL+'?q='+encodeURIComponent(q)+'">'
      + 'View all '+totalHits+' results on search'
      + ICON_ARROW
      + '</a>';
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
    bodyEl.scrollTop = 0;
  }

  var _renderToken = 0;
  // Separate token for the LLM call so a slow /smart-answer response
  // for query N doesn't paint over the loading shell of query N+1.
  var _intelToken = 0;
  var _intelDebounce = null;

  function runQuery(rawQ){
    var q = String(rawQ||'').trim();
    if (!q) { setState('starter'); return; }

    var token = ++_renderToken;
    setState('thinking');

    // ── Partner-of-Tomorrow spotlight (curated, no LLM, never gated) ──
    // Has to render BEFORE we touch the LLM or hit the database — typing
    // "tremble" should land on the spotlight card, not a generic search.
    var Core = window.TmwSearchCore;
    var spot = Core ? Core.matchSpotlight(q) : null;
    if (spot){
      slotIntel.innerHTML = '';
      slotHero.innerHTML = '<div class="tmw-ov-sec">' + spotlightHtml(spot) + '</div>';
      slotRows.innerHTML = '';
      slotView.innerHTML = '';
      sEmpty.classList.add('tmw-ov-hidden');
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
    var allowed = !window.tmwIntel || (typeof window.tmwIntel.allowed === 'function' && window.tmwIntel.allowed(q));
    if (!allowed) {
      // Out of free queries → gate panel (no DB query, no LLM call).
      slotIntel.innerHTML = intelGateHtml();
      slotHero.innerHTML = '';
      slotRows.innerHTML = '';
      slotView.innerHTML = '';
      setState('results');
      return;
    }

    var rows = Core.smartRank(Core.smartFilter(s, PROJECTS), s);
    var ans = Core.buildSmartAnswer(s, rows);

    // Header slot carries the "understood as" chips
    var chipsHtml = renderUnderstoodChips(s);
    var panelHtml = renderSmartIntelPanel(ans);
    slotIntel.innerHTML = chipsHtml + panelHtml;

    // No hero in the smart layout — the intel panel IS the hero.
    slotHero.innerHTML = '';

    if (rows.length){
      var maxMetric = 1;
      if (s.sort && s.sort.key === 'floors') maxMetric = Math.max.apply(null, rows.map(Core.floorsOf).concat([1]));
      else if (s.sort && s.sort.key === 'units') maxMetric = Math.max.apply(null, rows.map(Core.unitsOf).concat([1]));
      var SMART_CAP = 40;
      var shown = rows.slice(0, SMART_CAP);
      var rowsHtml = shown.map(function(p, i){ return renderSmartRow(p, i + 1, s, maxMetric); }).join('');
      var foot = (rows.length > SMART_CAP)
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
    slotView.innerHTML = renderViewAll(q, rows.length);

    // LLM upgrade: replace the deterministic sentence with prose (stats stay).
    if (rows.length) fireSmartIntelUpgrade(q, s, rows);

    // Count this query against the user's 10 free (intelligence.js gate)
    try {
      if (window.tmwIntel && window.tmwIntel.count) window.tmwIntel.count(q);
      if (window.tmwIntel && window.tmwIntel.track) window.tmwIntel.track(q, { results: rows.length, sort: s.sort ? s.sort.label : null, source: 'overlay' });
    } catch(_){}

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

      var totalHits = pScored.length + fScored.length + aScored.length;

      // ── Intelligence panel (inline LLM answer) ──────────────────────
      // Decide before paint so the panel slot is correct from the first
      // frame -- prevents a flash of a hero-only layout that then jumps
      // when the LLM loading shell appears above it.
      var allowed = !window.tmwIntel || (typeof window.tmwIntel.allowed === 'function' && window.tmwIntel.allowed(q));
      if (question){
        if (!allowed){
          // Out of free queries → gold gate panel (no LLM call).
          slotIntel.innerHTML = intelGateHtml();
        } else if (Core && totalHits > 0){
          // We have facts to seed the model with → fire it. Render the
          // loading shell first so the user sees instant feedback while
          // the worker round-trips (~600-1200ms typical).
          slotIntel.innerHTML = intelPanelHtml('loading', q);
          fireIntelligence(q,
            pScored.slice(0,5).map(function(x){ return x.p; }),
            aScored.slice(0,3).map(function(x){ return x.a; })
          );
        } else if (Core){
          // Question with zero text-match hits — still fire the LLM with
          // the empty fact set. It may have indexed coverage we don't,
          // or it'll politely tell us it doesn't know.
          slotIntel.innerHTML = intelPanelHtml('loading', q);
          fireIntelligence(q, [], []);
        } else {
          // Core hasn't loaded yet — fall back to the link-out CTA so
          // the user can still get Intelligence via /search/.
          slotIntel.innerHTML = renderIntelCTA(q);
        }
      } else {
        slotIntel.innerHTML = '';
      }

      // Empty state: if not a question and nothing matched, the empty
      // panel is the right UX. Question + empty already rendered an
      // Intelligence panel above so the user is never stranded.
      if (!totalHits && !question){
        slotHero.innerHTML = '';
        slotRows.innerHTML = '';
        slotView.innerHTML = '';
        setState('empty');
        return;
      }
      if (!totalHits){
        slotHero.innerHTML = '';
        slotRows.innerHTML = '';
        slotView.innerHTML = '';
        setState('results');
        return;
      }

      // Hero: most-relevant of (project, firm, article) by raw score
      var heroCandidates = [];
      if (pScored.length) heroCandidates.push({ kind:'project',  s:pScored[0].s * 1.05, item:pScored[0].p });  // small bias toward projects since they're the database core
      if (fScored.length) heroCandidates.push({ kind:'firm',     s:fScored[0].s,        item:fScored[0].f });
      if (aScored.length) heroCandidates.push({ kind:'article',  s:aScored[0].s,        item:aScored[0].a });
      heroCandidates.sort(function(a,b){ return b.s - a.s; });
      var hero = heroCandidates[0];
      if (hero){
        if (hero.kind === 'project') slotHero.innerHTML = '<div class="tmw-ov-sec">' + renderProjectHero(hero.item) + '</div>';
        else if (hero.kind === 'firm') slotHero.innerHTML = '<div class="tmw-ov-sec">' + renderFirmHero(hero.item) + '</div>';
        else slotHero.innerHTML = '<div class="tmw-ov-sec">' + renderArticleHero(hero.item) + '</div>';
      } else {
        slotHero.innerHTML = '';
      }

      // Smart-rows: mix top remaining projects + firms + articles, ranked
      // by score so the overlay reads as "here's the best 6-8 things in
      // the database for this query" regardless of type.
      var topScore = Math.max(
        pScored.length ? pScored[0].s : 0,
        fScored.length ? fScored[0].s : 0,
        aScored.length ? aScored[0].s : 0
      ) || 1;

      var rowItems = [];
      var skip = hero ? hero.item : null;
      pScored.slice(0, 6).forEach(function(x){ if (x.p !== skip) rowItems.push({ kind:'project', s:x.s, item:x.p }); });
      fScored.slice(0, 4).forEach(function(x){ if (x.f !== skip) rowItems.push({ kind:'firm',    s:x.s, item:x.f }); });
      aScored.slice(0, 4).forEach(function(x){ if (x.a !== skip) rowItems.push({ kind:'article', s:x.s, item:x.a }); });
      rowItems.sort(function(a,b){ return b.s - a.s; });
      rowItems = rowItems.slice(0, 7);

      if (rowItems.length){
        var rowsHtml = rowItems.map(function(r, i){
          var pct = Math.round((r.s / topScore) * 100);
          if (r.kind === 'project') return renderProjectRow(r.item, i+1, i===0 && !hero, pct);
          if (r.kind === 'firm')    return renderFirmRow(r.item, i+1, i===0 && !hero, pct);
          return renderArticleRow(r.item, i+1, i===0 && !hero, pct);
        }).join('');
        slotRows.innerHTML = ''
          + '<div class="tmw-ov-sec">'
          +   '<div class="tmw-ov-sec-head"><h3>Top matches</h3><span class="count">'+totalHits+' total</span></div>'
          +   '<div class="tmw-ov-rows">'+rowsHtml+'</div>'
          + '</div>';
      } else {
        slotRows.innerHTML = '';
      }

      slotView.innerHTML = renderViewAll(q, totalHits);
      setState('results');
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

  function navigateToSearch(q){
    var t = String(q||'').trim();
    if (!t) return;
    // Reuse the analytics hook the dock uses for normal-search logging
    try { if (window.tmwIntel && window.tmwIntel.trackSearch) window.tmwIntel.trackSearch(t, { source:'overlay' }); } catch(_){}
    window.location.href = SEARCH_URL + '?q=' + encodeURIComponent(t);
  }

  // ── open / close ──────────────────────────────────────────────────
  var _savedScrollY = 0;
  function open(initialQuery){
    if (root.classList.contains('open')) return;
    _savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.style.overflow = 'hidden';
    root.classList.add('open');
    setState('starter');
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
    // Restore scroll just in case
    setTimeout(function(){ window.scrollTo(0, _savedScrollY); }, 0);
    // Reset after fade-out
    setTimeout(function(){
      input.value = '';
      setState('starter');
      slotIntel.innerHTML = '';
      slotHero.innerHTML = '';
      slotRows.innerHTML = '';
      slotView.innerHTML = '';
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
      if (v) navigateToSearch(v);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  go.addEventListener('click', function(){
    var v = (input.value || '').trim();
    if (v) navigateToSearch(v);
  });

  // Starter chip click → fill bar + run inline. Phase 2 brought
  // Intelligence inline, so question chips no longer need to hand off
  // to /search/ -- both quick-jump and question chips run via runQuery.
  root.addEventListener('click', function(e){
    var chip = e.target.closest && e.target.closest('.tmw-ov-chip');
    if (!chip) return;
    var q = chip.getAttribute('data-q');
    if (!q) return;
    input.value = q;
    runQuery(q);
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
    open(existing);
    // Blur after focus has settled so the dock's AC dropdown also closes
    // (its blur handler hides the AC after a small timeout).
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
