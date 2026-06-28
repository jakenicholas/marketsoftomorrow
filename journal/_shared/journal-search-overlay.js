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
  // The standalone /search/ page was retired — the overlay IS the full
  // search now. Deep-links use the homepage with ?q=, which auto-opens this
  // overlay (see the ?q= bootstrap at the bottom of this IIFE).
  var SEARCH_URL = 'https://www.oftmw.com/';
  // Display location: the borough/sub-locality when set, else the city (mirrors
  // Core.locationOf; safe even before journal-search-core.js finishes loading).
  function _locOf(p){ var C = window.TmwSearchCore; return (C && C.locationOf) ? C.locationOf(p) : (String((p && p.Borough) || '').trim() || (p && p.City) || ''); }
  var MAP_URL    = 'https://www.oftmw.com/map';

  // ── helpers (mirror /search/index.html so scoring stays in sync) ──
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  // Normalize for matching: lowercase, strip accents, and collapse apostrophes
  // so possessives/special punctuation don't block matches —
  //   "Miami's Design District" -> "miami design district"
  //   "Spina O'Rourke"          -> "spina orourke"
  // (curly ' / modifier ' folded to straight first, possessive 's dropped,
  // remaining apostrophes removed). Lets a "Miami Design District" query match
  // an article that says "Miami's Design District", both as tokens and phrase.
  function norm(s){
    return String(s==null?'':s).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g,'')
      .replace(/[‘’ʼ]/g,"'")
      .replace(/'s\b/g,'')
      .replace(/'/g,'');
  }
  function mapSlug(t){ return norm(t).replace(/[^a-z0-9]+/g,''); }
  function mapLink(t, full){ return MAP_URL + '/?project=' + mapSlug(t) + (full ? '&fullscreen=true' : ''); }
  function firstField(o, keys){ for (var i=0;i<keys.length;i++){ var k=keys[i]; if (o[k]!=null && String(o[k]).trim()!=='') return o[k]; } return ''; }
  function commaFirst(s){ return String(s||'').split(',')[0].trim(); }
  function tokenize(q){ return norm(q).split(/[^a-z0-9]+/).filter(Boolean); }
  // Field matcher used by project scoring. SHORT needles (< 5 chars) must
  // match as a whole word so a 4-letter brand like "nora" doesn't substring-
  // match inside "panoramic" / "sonora" — that false positive is what used to
  // drag ~20 unrelated projects (e.g. a resort with "panoramic" views) into a
  // "Nora" search. Longer needles keep substring matching so "design",
  // "revelstoke", etc. still hit. `hay` is expected already normalized.
  function fieldHit(hay, t){
    if (!t || !hay) return false;
    if (t.length >= 5) return hay.indexOf(t) >= 0;
    var i = hay.indexOf(t);
    while (i >= 0){
      var before = i === 0 ? '' : hay.charAt(i - 1);
      var after  = hay.charAt(i + t.length);
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      i = hay.indexOf(t, i + 1);
    }
    return false;
  }
  function isQuestion(q){
    var t = String(q||'').trim();
    if (!t) return false;
    if (t.indexOf('?') !== -1) return true;
    if (/^(what|why|how|when|where|who|which|whose|is|are|does|do|did|can|could|will|would|should|has|have|had)\s/i.test(t)) return true;
    // Imperative info-requests ("tell me about X", "describe X") — mirrors
    // TmwSearchCore.isQuestion; this local copy only runs before core loads.
    if (/^(tell|describe|explain|summar(?:ize|ise|y)|walk|brief|overview|compare)\b/i.test(t)) return true;
    if (/\b(tell me|more about|everything about|info(?:rmation)?\s+(?:on|about)|details?\s+(?:on|about)|rundown on|overview of|story\s+(?:of|behind|on)|the deal with|the scoop on)\b/i.test(t)) return true;
    return false;
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
    /* On the /map/ surface the scrim sits over a LIVE Mapbox WebGL canvas that
       keeps repainting (pulsing pins/glows). A full-screen backdrop blur over a
       constantly-changing canvas is re-composited every frame — that's the lag
       on open + scroll the spotlight only has on the map. Drop the blur there and
       lean on a near-opaque fill instead (the map behind doesn't need to show
       through a search lightbox). Other surfaces keep the blurred glass look. */
    + 'html.tmw-surf-map .tmw-ov-scrim{-webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(6,7,6,.97)}'
    + 'html.tmw-surf-map .tmw-ov-close{-webkit-backdrop-filter:none;backdrop-filter:none}'

    + '.tmw-ov-lb{position:absolute;inset:0;display:flex;flex-direction:column}'

    /* The header bar (hex + "TMW Intelligence & Search" + close) is gone --
       the spotlight layout uses a floating close button in the top-right
       corner instead so nothing chrome-y competes with the centered
       starter content. */
    + '.tmw-ov-close{position:absolute;top:18px;right:22px;width:38px;height:38px;border-radius:50%;'
    + 'background:rgba(20,20,25,.6);border:1px solid rgba(255,255,255,.10);color:#C2C9C3;'
    + 'display:flex;align-items:center;justify-content:center;padding:0;'
    + 'cursor:pointer;transition:all .2s;font-family:inherit;z-index:3;'
    + '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}'
    + '.tmw-ov-close:hover{color:#fff;border-color:rgba(255,255,255,.22);background:rgba(20,20,25,.85)}'
    /* SVG × instead of the &times; glyph -- that character is slightly off-
       baseline in most fonts (looks ~2px low and 1px right of the circle
       center). SVG geometry is symmetric so it sits dead-center. */
    + '.tmw-ov-close svg{width:14px;height:14px;display:block}'
    /* "New chat" — anchored beside the close button, purple glow border. Clears
       the conversation and returns to the TMW Intelligence homescreen. */
    + '.tmw-ov-newchat{position:absolute;top:18px;right:70px;z-index:3;display:inline-flex;align-items:center;gap:7px;'
    + 'height:38px;padding:0 16px;border-radius:999px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;'
    + 'letter-spacing:.02em;color:#D8CCFA;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.65);'
    + 'box-shadow:0 0 12px rgba(167,139,250,.45);transition:all .18s;'
    + '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}'
    + '.tmw-ov-newchat:hover{background:rgba(167,139,250,.26);box-shadow:0 0 16px rgba(167,139,250,.6);color:#fff}'
    + '.tmw-ov-newchat svg{width:15px;height:15px;display:block}'
    + '@media(max-width:640px){.tmw-ov-newchat{right:56px;top:14px;height:34px;padding:0 12px;font-size:11px}}'
    /* Hex animations kept under .tmw-ov-hxs-* because the spotlight teach
       card still renders the small spinning hexagon next to the label. */
    + '.tmw-ov-hxs-spin{transform-origin:50% 50%;animation:tmwOvHxsSpin 4.2s cubic-bezier(.16,1,.3,1) infinite}'
    + '.tmw-ov-hxs-core{transform-origin:50% 50%;animation:tmwOvHxsPulse 4.2s ease-in-out infinite}'
    + '.tmw-ov-hxs-ring{transform-origin:50% 50%;animation:tmwOvHxsRing 4.2s ease-out infinite}'
    + '@media(prefers-reduced-motion:reduce){.tmw-ov-hxs-spin,.tmw-ov-hxs-ring{animation:none}.tmw-ov-hxs-ring{opacity:0}}'

    + '.tmw-ov-body{flex:1;overflow-y:auto;padding:8px 0 120px;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column}'
    + '.tmw-ov-body::-webkit-scrollbar{width:8px}'
    + '.tmw-ov-body::-webkit-scrollbar-track{background:transparent}'
    + '.tmw-ov-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:4px}'
    + '.tmw-ov-wrap{max-width:1080px;margin:0 auto;padding:0 22px}'
    /* Bottom-anchor the thread when it's shorter than the viewport (a short
       answer rests just above the search box, chat-style); margin-top:auto
       collapses to 0 once the content overflows, so scrolling stays normal. */
    + '.tmw-ov-wrap{margin-top:auto;width:100%}'
    /* ── Chat thread: each turn = a sent user message + its full answer ── */
    + '.tmw-ov-thread{display:flex;flex-direction:column;gap:30px}'
    + '.tmw-ov-turn{display:flex;flex-direction:column;gap:14px}'
    + '.tmw-ov-turn + .tmw-ov-turn{border-top:1px solid rgba(255,255,255,.07);padding-top:30px}'
    + '.tmw-ov-msg-row{display:flex;justify-content:flex-end}'
    + '.tmw-ov-msg{max-width:80%;background:linear-gradient(135deg,rgba(167,139,250,.22),rgba(167,139,250,.13));'
    +   'border:1px solid rgba(167,139,250,.38);color:#F4F1EA;font-family:"Inter",system-ui,sans-serif;'
    +   'font-size:15px;line-height:1.4;font-weight:500;padding:11px 16px;border-radius:16px 16px 4px 16px;'
    +   'box-shadow:0 2px 14px rgba(167,139,250,.12);word-break:break-word}'
    + '.tmw-ov-answer{display:block}'
    /* Per-answer thumbs: bottom-right of each turn, votes on that turn alone.
       Pin the "Noted" confirmation under the right-aligned buttons (the base
       rule centers it on the row, which is full-width here). */
    + '.tmw-ov-turn-fb{justify-content:space-between;align-items:center;width:100%;margin-top:16px}'
    + '.tmw-ov-turn-fb .tmw-ov-fb-thanks{left:auto;right:6px;transform:none}'
    /* Live/Thinking indicator relocated (by setState) from the answer header to
       the bottom feedback row — left-aligned, on the thumbs' horizontal line. */
    + '.tmw-ov-feedback .live{margin-left:0;display:flex;align-items:center;gap:7px;font-size:10px;'
    + 'letter-spacing:.16em;text-transform:uppercase;color:#9AA39C;font-weight:700;font-style:normal}'
    + '.tmw-ov-feedback .live i{width:6px;height:6px;border-radius:50%;background:#B9A6FF;'
    + 'box-shadow:0 0 8px #B9A6FF;font-style:normal;display:inline-block}'
    + '.tmw-ov-feedback .live.dim i{background:#6c706c;box-shadow:none}'
    + '@media(max-width:640px){.tmw-ov-thread{gap:22px}.tmw-ov-turn + .tmw-ov-turn{padding-top:22px}.tmw-ov-msg{max-width:88%;font-size:14px}.tmw-ov-turn-fb{margin-top:12px}}'

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
    + '.tmw-ov-teach-hex{width:20px;height:20px;flex:0 0 auto;display:flex;align-items:center;justify-content:center}'
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
    + '.tmw-ov-chips{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;max-width:700px;margin:0 auto}'
    + '.tmw-ov-chip-break{flex-basis:100%;width:100%;height:0;margin:0}'
    + '.tmw-ov-chip{font-family:inherit;font-size:12px;color:#ECEAE5;'
    + 'background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.25);'
    + 'padding:9px 10px;border-radius:999px;cursor:pointer;transition:all .15s;line-height:1.2;'
    + 'text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.tmw-ov-chip:hover{background:rgba(167,139,250,.18);border-color:#A78BFA;color:#fff}'
    + '@media(max-width:560px){.tmw-ov-chips{max-width:420px}'
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

    /* ─── Filter pills (purple) — appear above results, let the user
       filter the body by category. Pills are purple-tinted at rest and
       go solid-purple-with-ink-text when active. The count subscript is
       slightly muted so the label reads first. */
    + '.tmw-ov-fp-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;'
    + 'animation:tmwOvFadeIn .3s ease both}'
    + '.tmw-ov-fp{display:inline-flex;align-items:center;gap:6px;'
    + 'background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.25);'
    + 'color:#ECEAE5;padding:7px 13px;border-radius:999px;'
    + 'font-family:inherit;font-size:12px;font-weight:500;line-height:1.2;'
    + 'cursor:pointer;transition:all .15s}'
    + '.tmw-ov-fp:hover{background:rgba(167,139,250,.16);border-color:#A78BFA;color:#fff}'
    + '.tmw-ov-fp.active{background:#A78BFA;border-color:#A78BFA;color:#1a1408;font-weight:600}'
    + '.tmw-ov-fp-n{font-size:10.5px;opacity:.7;font-variant-numeric:tabular-nums}'
    + '.tmw-ov-fp.active .tmw-ov-fp-n{opacity:.85}'

    /* Filter visibility. Every section that should respect the filter
       carries data-cat="<category>" on its outer .tmw-ov-sec. Filter
       pills set data-filter on the results state; CSS hides anything
       whose data-cat doesn\'t match (sections without data-cat are
       always visible -- filter-pills, intel-cta). */
    + '[data-state="results"][data-filter="intel"] [data-cat]{display:none}'
    + '[data-state="results"][data-filter="projects"] [data-cat]:not([data-cat="projects"]){display:none}'
    + '[data-state="results"][data-filter="firms"] [data-cat]:not([data-cat="firms"]){display:none}'
    + '[data-state="results"][data-filter="articles"] [data-cat]:not([data-cat="articles"]){display:none}'
    /* The Intelligence answer (+ "understood as" chips) lives in the intel-cta
       slot, which has no data-cat — so the rules above never touch it. Hide it
       explicitly whenever a non-Intelligence category filter is active, so
       clicking "Projects"/"Firms"/"Articles" hides the answer as expected. */
    + '[data-state="results"][data-filter="projects"] [data-slot="intel-cta"],'
    + '[data-state="results"][data-filter="firms"] [data-slot="intel-cta"],'
    + '[data-state="results"][data-filter="articles"] [data-slot="intel-cta"]{display:none}'
    /* The Journal tab is always present. When the query matched no articles it
       renders a "latest stories" browse fallback — hidden in the All view (so
       it doesn\'t clutter project searches) and revealed only under the Journal
       filter, so the tab is never a dead end. */
    + '.tmw-ov-jfallback{display:none}'
    + '[data-state="results"][data-filter="articles"] .tmw-ov-jfallback{display:block}'

    /* Onyx 4.1 — answer-first OVERVIEW lens (the default). Shows the
       Intelligence answer + hero + a capped taste of each section; the
       counts-bar pills drill into any single category for the full set.
       Caps are scoped to [data-filter="overview"] so the category tabs
       (Projects / Firms / Journal) still render everything. */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-grid > *:nth-child(n+4){display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-chiprow > *:nth-child(n+7){display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-alist > *:nth-child(n+3){display:none}'
    /* Smart/pipeline ranked rows ("24 more projects") render into .tmw-ov-rows,
       internally paginated to ROW_PAGE — cap to a 3-row taste in Overview and
       hide the in-section "Load more" + "showing top N" foot (the see-all link
       + the Projects pill are the drill-in). */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-rows > *:nth-child(n+4){display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-loadmore{display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-smart-foot{display:none}'
    /* "See all N →" — visible only in Overview (each category tab already
       shows its full set, so the link would be redundant there). */
    + '.tmw-ov-seeall{display:none;align-items:center;gap:6px;margin-top:14px;background:none;border:0;'
    + 'padding:0;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;color:#8a948a;'
    + 'letter-spacing:.07em;text-transform:uppercase}'
    + '.tmw-ov-seeall:hover{color:#fff}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-seeall{display:inline-flex}'
    /* Onyx 4.1 model badge — transparent purple fill + glowing purple border */
    + '.tmw-ov-model{font-size:9px;letter-spacing:.13em;text-transform:uppercase;font-weight:700;'
    + 'color:#D8CCFA;background:rgba(167,139,250,.2);border:1px solid rgba(167,139,250,.75);'
    + 'box-shadow:0 0 10px rgba(167,139,250,.55);padding:2px 8px;border-radius:999px;margin-left:8px;align-self:center}'

    /* ── Onyx Overview = ONE compact reply card ───────────────────────────
       Wrap the whole turn in a single bubble and strip the inner panel/hero/
       section chrome so the default answer reads like a chat message, not a
       stack of cards. Scoped to [data-filter="overview"] — the category tabs
       keep the full rich layout.
       CRITICAL: .tmw-ov-wrap needs a DEFINITE width. The overlay column is
       otherwise content-width (a fixed shell with no set width), so it was held
       open only by the big hero card — compacting the hero without this anchor
       collapses the whole flex chain to ~0 and the answer wraps to a 8000px
       sliver (the bug in the first attempt). */
    + '.tmw-ov-wrap{width:100%}'
    + '[data-state="results"][data-filter="overview"]{position:relative;background:#0f120f;border:1px solid rgba(255,255,255,.13);border-radius:18px;padding:20px 22px;box-sizing:border-box}'
    /* answer panel → plain text block (no inner box / glow / footer) */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-intel-panel{border:0;background:none;box-shadow:none;padding:0;margin:0 0 14px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-intel-panel::before{display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-intel-foot{display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-intel-h{margin-bottom:9px}'
    /* hero → a compact thumbnail row: title + location only */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero{display:flex;min-height:0;box-shadow:none;border-radius:12px;margin-bottom:8px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .media{min-height:0;width:84px;flex:0 0 84px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .media .scrim,[data-state="results"][data-filter="overview"] .tmw-ov-hero .besttag{display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .body{padding:11px 15px;gap:4px;justify-content:center}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .body h2{font-size:16px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .desc,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .excerpt,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .tmw-ov-specs,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .tmw-ov-byline,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .tmw-ov-hero-cta{display:none}'
    /* sections → tight, with small de-emphasized labels (no big serif headers) */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec{margin-bottom:14px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec:last-child{margin-bottom:0}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec-head{margin-bottom:8px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec-head h3,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-smart-head h3{font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#8a948a}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-smart-head{margin-bottom:8px}'
    /* Removed: the fact-chip stats grid (the LLM answer already states them) and
       the inline Onyx 4.1 header badge (moved to the "i" info button). */
    + '.tmw-ov-intel-stats{display:none!important}'
    + '.tmw-ov-model{display:none!important}'
    /* "i" info button — top-right of the reply card; hover/focus reveals the model. */
    + '.tmw-ov-info{display:none;position:absolute;top:14px;right:16px;z-index:4;width:20px;height:20px;'
    + 'border-radius:50%;border:1px solid rgba(167,139,250,.55);background:rgba(167,139,250,.12);color:#C9BCF5;'
    + 'font-family:Georgia,serif;font-style:italic;font-size:12px;line-height:1;align-items:center;justify-content:center;'
    + 'cursor:pointer;padding:0;transition:all .15s}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-info{display:inline-flex}'
    + '.tmw-ov-info:hover,.tmw-ov-info:focus{background:rgba(167,139,250,.24);border-color:#A78BFA;color:#fff;outline:none}'
    + '.tmw-ov-info-pop{position:absolute;top:26px;right:0;white-space:nowrap;pointer-events:none;'
    + 'background:#1a1d22;border:1px solid rgba(167,139,250,.4);box-shadow:0 0 14px rgba(167,139,250,.3);'
    + 'border-radius:8px;padding:7px 11px;font-family:"Inter",system-ui,sans-serif;font-style:normal;'
    + 'font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:#D8CCFA;'
    + 'opacity:0;transform:translateY(-4px);transition:opacity .15s,transform .15s}'
    + '.tmw-ov-info:hover .tmw-ov-info-pop,.tmw-ov-info:focus .tmw-ov-info-pop{opacity:1;transform:translateY(0)}'
    /* Feedback row: live indicator left, [Noted + thumbs] grouped right. */
    + '.tmw-ov-fb-actions{display:flex;align-items:center;gap:10px}'
    + '.tmw-ov-feedback .tmw-ov-fb-thanks{position:static;transform:none;left:auto;right:auto;top:auto;'
    + 'opacity:0;font-size:11px;color:#9AA39C;letter-spacing:.04em;white-space:nowrap;transition:opacity .2s}'
    + '.tmw-ov-feedback.voted .tmw-ov-fb-thanks{opacity:1}'
    /* Mobile: let the section header take the full row so its title never wraps
       around the Full list / View all button (the button drops below it). */
    + '@media(max-width:640px){.tmw-ov-smart-head{flex-wrap:wrap}.tmw-ov-smart-head h3{flex:1 1 100%}}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-fp-row{margin:0 0 14px}'
    /* Overview drops journal articles (they live under the Journal tab now) */
    + '[data-state="results"][data-filter="overview"] [data-slot="articles-grid"]{display:none}'
    /* Feedback row (live indicator left, thumbs right) gets breathing room above
       so it sits centered in the card's bottom padding, not crowding the last row */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-turn-fb{margin-top:22px}'
    /* "Understood as" line removed entirely — not needed */
    + '.tmw-ov-understood{display:none!important}'


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
    // Host-page hardening: zero the UA/host margins on the hero body's text
    // children so the flex `gap:12px` is the ONLY spacing authority. Without
    // this the host cascade leaks in — most visibly the browser UA default
    // `p{margin:1em 0}` on the `.desc` paragraph, which renders tight on pages
    // that ship a CSS reset (homepage) but adds a ~16px gap on pages that
    // don't (the map, which only resets `*{position:relative;z-index:1}`).
    // The overlay must look identical on every page it injects into, so it
    // can't depend on the host having a reset. Scoped to the text elements
    // only (h2 / p / .loc) — NOT `>*`, so it leaves .tmw-ov-hero-cta's
    // `margin-top:auto` (which bottom-anchors the buttons) intact.
    + '.tmw-ov-hero .body>h2,.tmw-ov-hero .body>p,.tmw-ov-hero .body>.loc,.tmw-ov-hero .body>.eyebrow{margin:0}'
    + '.tmw-ov-hero .body .eyebrow{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#C2C9C3}'
    + '.tmw-ov-hero .body h2{font-family:"Fraunces",Georgia,serif;font-size:28px;line-height:1.06;color:#fff;font-weight:600;letter-spacing:-.015em}'
    + '.tmw-ov-hero .body .loc{font-size:12px;letter-spacing:.06em;color:#C2C9C3}'
    + '.tmw-ov-hero-chip{align-self:flex-start;display:inline-flex;align-items:center;padding:4px 9px;font-size:11px;font-weight:600;color:#C9BBFF;background:rgba(167,139,250,0.14);border:1px solid rgba(167,139,250,0.32);border-radius:6px;text-decoration:none;transition:background .15s ease,color .15s ease}'
    + '.tmw-ov-hero-chip:hover{background:rgba(167,139,250,0.24);color:#fff}'
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
    // Announced has no colored dot — give it a muted gray one so the status
    // text left-aligns with the colored-dot rows instead of looking indented.
    + '.tmw-ov-row .sb-announced{color:#9AA39C}.tmw-ov-row .sb-announced i{background:#9AA39C}'
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
    /* Bottom dock: wraps the thumbs feedback row + the search bar in one
       flex-column container so they're guaranteed-centered and move as a
       unit. The dock itself is absolute-positioned at the bottom; the
       children sit naturally centered via align-items:center -- no more
       trying to manually transform individual elements.

       CRITICAL: the `> * pointer-events:auto` rule is SCOPED to
       .tmw-ov-root.open. Without that scope, the dock children were
       intercepting clicks even when the overlay was closed (parent
       pointer-events:none on .tmw-ov-root normally cascades to block
       descendant click handling, but our explicit auto override on the
       dock children defeated that protection). That broke the dock-
       trigger flow -- the user could no longer click the journal dock
       search bar to OPEN the spotlight, because the (invisible) overlay
       bar was eating the click first. */
    + '.tmw-ov-dock{position:absolute;left:0;right:0;bottom:0;z-index:2;'
    + 'display:flex;flex-direction:column;align-items:center;gap:12px;'
    + 'padding:0 0 24px;pointer-events:none}'
    + '.tmw-ov-root.open .tmw-ov-dock > *{pointer-events:auto}'
    /* Thumbs feedback row -- hidden by default via visibility (lets the
       opacity transition actually fire, unlike display:none). Centered
       automatically by the dock's flex layout. The buttons match the
       dock's pill aesthetic: subtle white-overlay bg, neutral border at
       rest, color coding on hover (green for up, red for down) so the
       rating intent reads at a glance. After the user votes, both buttons
       get .voted (pointer-events:none locks the rating in) and the
       .voted button itself gets a colored fill matching its rating. */
    /* position:relative anchors the absolutely-positioned thanks message so
       it can sit below the buttons WITHOUT taking flex space -- otherwise
       the (invisible) text reserves room on the right and the two buttons
       end up visually offset left of the dock's actual center. */
    + '.tmw-ov-feedback{position:relative;display:flex;align-items:center;gap:10px;'
    + 'visibility:hidden;opacity:0;transition:opacity .25s ease,visibility 0s linear .25s}'
    + '.tmw-ov-feedback.show{visibility:visible;opacity:1;transition:opacity .25s ease}'
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
    /* Absolutely positioned below the buttons, centered on the feedback
       row's center axis. Out of the flex flow so the two thumb buttons
       stay perfectly centered both before AND after voting. */
    + '.tmw-ov-fb-thanks{position:absolute;left:50%;top:100%;transform:translateX(-50%);'
    + 'margin-top:6px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;font-weight:600;'
    + 'color:#9AA39C;opacity:0;transition:opacity .3s ease;pointer-events:none;white-space:nowrap}'
    + '.tmw-ov-feedback.voted .tmw-ov-fb-thanks{opacity:1}'
    + '@media(max-width:560px){'
    /* Mobile: bump the dock padding-bottom + gap so the thumbs sit higher
       above the search bar (was visually too low / close to the bar). */
    +   '.tmw-ov-dock{padding:0 0 22px;gap:14px}'
    +   '.tmw-ov-feedback{gap:8px}'
    +   '.tmw-ov-fb-btn{width:34px;height:34px}'
    +   '.tmw-ov-fb-btn svg{width:16px;height:16px}'
    /* Mobile: anchor "Noted" inline to the RIGHT of the buttons rather
       than below them. Still position:absolute (so the two thumb buttons
       stay perfectly centered on the dock axis), but the anchor point
       moves from top:100% (below) to left:100% (beside). */
    +   '.tmw-ov-fb-thanks{font-size:10.5px;top:50%;left:100%;'
    +     'transform:translateY(-50%);margin-left:8px;margin-top:0}'
    + '}'

    + '.tmw-ov-bar{position:relative;width:min(820px, calc(100vw - 32px));z-index:2}'
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
    /* !important so a host page's own .tmw-dock-search width rules (e.g. the map
       trims the bottom dock input to ~36-42vw) can NEVER leak in and squish the
       lightbox input — the spotlight must look identical on every page. */
    + '.tmw-ov-bar .tmw-dock-search input{width:100%!important;padding-right:50px;font-size:14px}'
    + '.tmw-ov-bar .tmw-dock-search input:focus{width:100%!important;'
    /* Override the dock\'s green focus state -- the overlay is the
       Intelligence surface, so it keeps the purple aesthetic everywhere. */
    + 'border-color:rgba(167,139,250,.55)}'
    /* The dock hides the native placeholder (transparent) because it uses
       a .ds-ph overlay span for the animated text. We dropped that span,
       so restore a normal visible muted-gray placeholder. */
    + '.tmw-ov-bar .tmw-dock-search input::placeholder{color:#9AA39C}'
    /* Submit affordance — round gray glyph at rest; lights up gold + glows
       + gently pulses the moment there\'s enough typed to search, so it\'s
       unambiguous that users must hit Enter / click here to run a query.
       Search no longer fires on every keystroke; this button is the only
       path to results besides Enter. */
    + '.tmw-ov-bar .go{position:absolute;right:8px;top:50%;transform:translateY(-50%);'
    + 'height:34px;width:34px;padding:0;border:1px solid rgba(255,255,255,.10);'
    + 'background:rgba(255,255,255,.04);color:rgba(255,255,255,.50);'
    + 'display:flex;align-items:center;justify-content:center;z-index:3;border-radius:50%;cursor:pointer;'
    + 'transition:color .2s,transform .2s,background .2s,border-color .2s,box-shadow .2s}'
    + '.tmw-ov-bar .go svg{width:15px;height:15px;transition:filter .2s,transform .2s}'
    + '.tmw-ov-bar .go.ready{background:linear-gradient(135deg,#e6c574,#f0d68a);border-color:#f0d68a;color:#0a0a0a;'
    + 'box-shadow:0 0 18px rgba(230,197,116,.45),0 0 4px rgba(230,197,116,.3);animation:tmwOvGoPulse 2s ease-in-out infinite}'
    + '.tmw-ov-bar .go.ready svg{filter:drop-shadow(0 0 4px rgba(230,197,116,.6))}'
    + '.tmw-ov-bar .go.ready:hover{background:linear-gradient(135deg,#f0d68a,#f7e6a8);transform:translateY(-50%) translateX(1px) scale(1.05);box-shadow:0 0 24px rgba(230,197,116,.6),0 0 6px rgba(230,197,116,.4)}'
    + '.tmw-ov-bar .go:not(.ready):hover{color:#ECEAE5;border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.07)}'
    + '@keyframes tmwOvGoPulse{0%,100%{box-shadow:0 0 18px rgba(230,197,116,.45),0 0 4px rgba(230,197,116,.3)}50%{box-shadow:0 0 28px rgba(230,197,116,.65),0 0 8px rgba(230,197,116,.45)}}'

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
    + '.tmw-ov-intel-spark{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(167,139,250,.16);color:#B9A6FF;box-shadow:0 0 16px rgba(167,139,250,.45);flex:0 0 auto}'
    + '.tmw-ov-intel-spark svg{width:15px;height:15px}'
    + '.tmw-ov-intel-h .lbl{font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#B9A6FF}'
    + '.tmw-ov-intel-h .live{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:10px;'
    + 'letter-spacing:.12em;text-transform:uppercase;color:#9AA39C}'
    + '.tmw-ov-intel-h .live i{width:6px;height:6px;border-radius:50%;background:#B9A6FF;box-shadow:0 0 8px #B9A6FF;font-style:normal}'
    + '.tmw-ov-intel-h .live.dim i{background:#6c706c;box-shadow:none}'
    + '.tmw-ov-intel-ans{font-family:"Inter",-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.6;color:#E9E7E1;font-weight:400;letter-spacing:.005em;max-width:none}'
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

    /* "Understood as" — collapsed to a single inline text line (no boxed chips) */
    + '.tmw-ov-understood{font-size:12px;color:#9AA39C;margin:0 0 14px;line-height:1.7}'
    + '.tmw-ov-understood .lead{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#9AA39C;font-weight:700;margin-right:10px}'
    + '.tmw-ov-uchip{display:inline;color:#ECEAE5}'
    + '.tmw-ov-uchip .ck{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#B9A6FF;font-weight:700;margin-right:4px}'
    + '.tmw-ov-uchip b{color:#fff;font-weight:600}'
    + '.tmw-ov-uchip + .tmw-ov-uchip::before{content:"·";color:#5E5C58;margin:0 8px}'

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
    + 'letter-spacing:.08em;text-transform:uppercase;color:#C9C7C1;font-weight:700;padding:8px 13px;'
    + 'border:1px solid rgba(255,255,255,.16);border-radius:999px;text-decoration:none;'
    + 'transition:border-color .2s,color .2s,background .2s}'
    + '.tmw-ov-smart-head .map-link + .map-link{margin-left:10px}'
    + '.tmw-ov-smart-head .map-link:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.30);color:#fff}'
    + '.tmw-ov-smart-head .map-link svg{width:13px;height:13px;opacity:.85}'

    /* Smart row metric column (replaces relevance bar for sorted queries) */
    + '.tmw-ov-row .r-metric{flex:0 0 auto;text-align:right;min-width:64px;margin-left:6px}'
    + '.tmw-ov-row .r-metric .n{font-family:"Fraunces",Georgia,serif;font-size:18px;font-weight:700;color:#fff;line-height:1}'
    + '.tmw-ov-row .r-metric .l{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#9AA39C;margin-top:3px}'

    /* Smart-foot caption ("answer synthesized from the project database…") */
    + '.tmw-ov-smart-foot{display:flex;align-items:center;gap:8px;margin-top:18px;justify-content:center;'
    + 'font-size:11px;color:#9AA39C;text-align:center;flex-wrap:wrap}'
    + '.tmw-ov-smart-foot .ai{color:#B9A6FF;font-weight:600}'

    /* Sort-flavored "understood as" chip — green label for sort, purple for the rest */
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
    + '.tmw-ov-row-hidden{display:none}'   /* project rows past the first page, revealed by Load more */

    + '.tmw-ov-hidden{display:none!important}'

    + '@media(max-width:760px){'
    +   '.tmw-ov-hero{grid-template-columns:1fr}'
    +   '.tmw-ov-hero .media{min-height:180px}'
    +   '.tmw-ov-bar{bottom:18px;width:calc(100vw - 22px)}'
    +   '.tmw-ov-row .r-bar{display:none}'
    +   '.tmw-ov-close{top:14px;right:14px;width:34px;height:34px}'
    +   '.tmw-ov-body{padding:8px 0 96px}'
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
    +     '<polygon class="tmw-ov-hxs-core" points="50,8 86,29 86,71 50,92 14,71 14,29" fill="none" stroke="#A78BFA" stroke-width="8" stroke-linejoin="round"/>'
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
    'Hotels opening around the world soon',
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
  // Firms then places — one continuous flow so the chips wrap naturally and FILL
  // each row (no forced break that orphans a single chip on its own line). On
  // mobile this lands as ~3 filled rows.
  var QUICK_CHIPS = ['Related Ross', 'Naftali Group', 'Allen Morris Co', 'Property Markets Group', 'West Palm Beach', 'Miami', 'Manhattan', 'Nashville'];
  function quickChipBtn(q){
    return '<button class="tmw-ov-chip" type="button" data-q="' + esc(q) + '">' + esc(q) + '</button>';
  }
  var QUICK_CHIPS_HTML = QUICK_CHIPS.map(quickChipBtn).join('');

  // Pro / quota pill — mirrors journal-dock.js's tmwIntelPillHTML so the
  // overlay's teach card shows the SAME PRO state + free-queries-left
  // count the dock teach panel does. Recomputed on every overlay open
  // since the quota can change between sessions.
  function renderProPill(){
    if (!window.tmwIntel) return '';
    var pro = window.tmwIntel.isPro && window.tmwIntel.isPro();
    if (pro) return '<span class="tmw-ov-pro on">PRO</span>';
    var left = window.tmwIntel.left ? window.tmwIntel.left() : ((window.tmwIntel && window.tmwIntel.FREE) || 5);
    var lowCls = left <= 3 ? ' low' : '';
    return '<span class="tmw-ov-quota'+lowCls+'">' + left + ' / ' + ((window.tmwIntel && window.tmwIntel.FREE) || 5) + ' left</span>'
      + '<a class="tmw-ov-pro" href="https://www.oftmw.com/map/?upgrade=1" data-tmw-paywall="feature:intelligence">PRO</a>';
  }
  function refreshProPill(){
    var slot = root.querySelector('[data-pill-slot]');
    if (slot) slot.innerHTML = renderProPill();
  }

  // Per-turn answer block (chat thread). One of these is created for every query
  // and appended to .tmw-ov-thread; the render functions write into ITS slots
  // (re-pointed by newTurn). Same markup the single results view used before.
  var TURN_ANSWER_HTML = ''
    + '<div class="tmw-ov-thinking" data-state="thinking">'
    +   '<div class="dots"><span></span><span></span><span></span></div>'
    +   '<span>Searching the database</span>'
    + '</div>'
    + '<div data-state="results" class="tmw-ov-hidden">'
    +   '<button class="tmw-ov-info" type="button" aria-label="Powered by TMW Intelligence, Onyx 4.1"><span aria-hidden="true">i</span><span class="tmw-ov-info-pop">TMW Intelligence · Onyx 4.1</span></button>'
    +   '<div data-slot="filter-pills"></div>'
    +   '<div data-slot="intel-cta"></div>'
    +   '<div data-slot="hero"></div>'
    +   '<div data-slot="rows"></div>'
    +   '<div data-slot="projects-grid"></div>'
    +   '<div data-slot="entities"></div>'
    +   '<div data-slot="articles-grid"></div>'
    // Per-answer feedback — sits in the bottom-right of the reply card, votes on
    // THIS turn only (feeds the backend intel improver). Inside the results box
    // so it reads as part of the message. setState finds it via turn.querySelector.
    +   '<div class="tmw-ov-feedback tmw-ov-turn-fb" data-feedback>'
    +     '<div class="tmw-ov-fb-actions">'
    +       '<span class="tmw-ov-fb-thanks">Noted</span>'
    +       '<button class="tmw-ov-fb-btn" type="button" data-rating="up" aria-label="Helpful">'
    +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v9H3v-9zM21 9c0-1.1-.9-2-2-2h-5l1-3.5c.1-.4 0-.8-.3-1.1l-.7-.7-7 7v9h11l3-7V9z"/></svg>'
    +       '</button>'
    +       '<button class="tmw-ov-fb-btn" type="button" data-rating="down" aria-label="Not helpful">'
    +         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 13V4h4v9zM3 15c0 1.1.9 2 2 2h5l-1 3.5c-.1.4 0 .8.3 1.1l.7.7 7-7V6H6L3 13v2z"/></svg>'
    +       '</button>'
    +     '</div>'
    +   '</div>'
    + '</div>'
    + '<div data-state="empty" class="tmw-ov-empty tmw-ov-hidden">'
    +   '<h3>Nothing matched in the database</h3>'
    +   '<p>Try a firm name, city, or project. Or ask TMW Intelligence below — it can synthesize answers from the journal.</p>'
    + '</div>';

  var root = document.createElement('div');
  root.className = 'tmw-ov-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'TMW search & Intelligence');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = ''
    + '<div class="tmw-ov-scrim"></div>'
    + '<div class="tmw-ov-lb">'
    +   '<button class="tmw-ov-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
    +   '<button class="tmw-ov-newchat" type="button" aria-label="New chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>New chat</button>'
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

    +       '<div class="tmw-ov-thread"></div>'

    +     '</div>'
    +   '</div>'
    /* Bottom dock holds the search bar. (Thumbs feedback now lives per-answer,
       bottom-right of each turn, not in the dock.) */
    +   '<div class="tmw-ov-dock">'
    +     '<div class="tmw-ov-bar">'
    +       '<form class="tmw-ov-bar-inner tmw-dock-search" role="search">'
    +         '<span class="ds-ico">' + ICON_SEARCH_DOCK + '</span>'
    +         '<input type="search" autocomplete="off" placeholder="Search projects, firms, places, brands, and more…" aria-label="Search projects, firms, places, brands, and more">'
    +         '<button class="go" type="button" aria-label="Run search (press Enter)" title="Press Enter to search">'
    +           '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
    +         '</button>'
    +       '</form>'
    +     '</div>'  /* close .tmw-ov-bar */
    +   '</div>'    /* close .tmw-ov-dock */
    + '</div>';    /* close .tmw-ov-lb */

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
  var sStarter = root.querySelector('[data-state="starter"]');   // standalone teach card (empty thread)
  var _threadEl = root.querySelector('.tmw-ov-thread');           // holds the chat turns
  // Per-turn render targets — null until newTurn() points them at the current
  // turn's elements. Every render path writes into these (unchanged).
  let sThinking = null, sResults = null, sEmpty = null;
  let slotFilterPills = null, slotIntel = null, slotHero = null, slotRows = null, slotProjGrid = null, slotEntities = null, slotArticles = null;
  var bodyEl   = root.querySelector('.tmw-ov-body');

  // ── data loading (mirrors /search/) ────────────────────────────────
  var PROJECTS = [], FIRMS = [], ARTICLES = [], DATA_READY = false, _loading = null;
  // Iconic editorial lists (golf / hotels / restaurants), loaded once from the
  // worker alongside the projects so "best hotels", "good golf in california",
  // etc. can blend curated picks into the results.
  var ICONIC = { golf: [], hotels: [], restaurants: [] };
  function _loadIconicList(slug){
    return fetch(WORKER_URL + '/list/' + slug, { cache:'no-cache' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ var data = d && d.data; var items = data && (data.items || (Array.isArray(data) ? data : null)); return Array.isArray(items) ? items : []; })
      .catch(function(){ return []; });
  }

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
      fetch('https://www.oftmw.com/map/firms-flat.json',     { cache:'no-cache' }).then(function(r){ return r.ok ? r.json() : []; }).catch(function(){ return []; }),
      loadArticles(),
      _loadIconicList('golf'), _loadIconicList('hotels'), _loadIconicList('restaurants')
    ]).then(function(res){
      var p = res[0], f = res[1], a = res[2];
      ICONIC = { golf: res[3] || [], hotels: res[4] || [], restaurants: res[5] || [] };
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
    var arch=norm(p.Architect), dev=norm(p.Developer), nbhd=norm(p.Neighborhood);
    var desc=norm(firstField(p,['DescriptionLong','Description']));
    var s = 0;
    if (title===full) s+=120;
    else if (title.indexOf(full)===0) s+=50;
    else if (full && fieldHit(title, full)) s+=28;
    // When the query IS a town name, projects actually IN that town win — a title
    // that merely contains the town in a DIFFERENT town must not outrank it. (e.g.
    // searching "palm beach" → the exclusive island first, not a West Palm Beach
    // college whose title starts with "Palm Beach".)
    if (full && city===full) s+=55;
    else if (full==='palm beach' && city==='west palm beach') s+=18;   // island first, then West Palm Beach
    if (full && nbhd && nbhd===full) s+=24;          // exact neighborhood match
    else if (full && nbhd && fieldHit(nbhd, full)) s+=16;
    for (var i=0;i<toks.length;i++){
      var t = toks[i];
      if (fieldHit(title, t)) s+=12;
      if (fieldHit(city, t))  s+=8;
      if (nbhd && fieldHit(nbhd, t)) s+=9;            // neighborhood token match
      if (fieldHit(type, t))  s+=6;
      if (fieldHit(arch, t))  s+=5;
      if (fieldHit(dev, t))   s+=5;
      if (fieldHit(desc, t))  s+=2;
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
  // Journal-search synonym groups. Any token in a group matches every other
  // member, in both directions, when scoring articles or fanning out body
  // searches. Cleanly handles the common case where users type "miami condos"
  // but our newer copy says "Residences" / "Condominium" / "Tower". Each group
  // is checked in O(1) via TOKEN_SYNONYM_INDEX (token → variants array).
  var TOKEN_SYNONYM_GROUPS = [
    ['condo','condos','condominium','condominiums','residence','residences','residential','apartment','apartments','unit','units','home','homes','tower','towers','high-rise','highrise','skyscraper','penthouse','penthouses'],
    ['hotel','hotels','resort','resorts','inn','hospitality'],
    // Dining/F&B — TMW doesn't track restaurants as projects; these queries
    // should surface JOURNAL articles (categorized "<region> Food & Drink").
    // Synonym-matching is substring-based, so keep entries distinctive — no
    // short ambiguous tokens like "bar" (would hit "harbor", "Barcelona").
    ['restaurant','restaurants','eatery','eateries','dining','food','foods','drink','drinks','food-hall','foodhall','cuisine','culinary','cocktail','cocktails','chef','michelin','foodie','gastronomy','steakhouse'],
    ['office','offices','workplace','workspace','workspaces'],
    ['retail','shopping','mall','malls','shops','shop','store','stores','plaza'],
    ['airport','airports','terminal','terminals'],
    ['stadium','stadiums','arena','arenas','ballpark','ballparks'],
    ['marina','marinas'],
    ['museum','museums','gallery','galleries'],
  ];
  var TOKEN_SYNONYM_INDEX = (function(){
    var idx = {};
    TOKEN_SYNONYM_GROUPS.forEach(function(g){ g.forEach(function(t){ idx[t] = g; }); });
    return idx;
  })();
  function expandToken(t){ return TOKEN_SYNONYM_INDEX[t] || [t]; }
  // True if ANY synonym of `t` appears in the haystack string `hay`.
  function tokenInHay(t, hay){
    var variants = TOKEN_SYNONYM_INDEX[t];
    if (!variants) return hay.indexOf(t) >= 0;
    for (var i = 0; i < variants.length; i++) {
      if (hay.indexOf(variants[i]) >= 0) return true;
    }
    return false;
  }

  // Dining / food & drink is JOURNAL coverage, not a tracked project type. A
  // query carrying these intent words must be answered from our Food & Drink
  // ARTICLES (we post a lot), never from the project pipeline — otherwise
  // "new restaurants in west palm beach" wrongly reads out condos/hotels.
  var FOOD_INTENT = {
    restaurant:1, restaurants:1, eatery:1, eateries:1, dining:1, dine:1, diner:1,
    food:1, foods:1, drink:1, drinks:1, cuisine:1, culinary:1, cocktail:1, cocktails:1,
    chef:1, chefs:1, michelin:1, foodie:1, gastronomy:1, steakhouse:1, brunch:1, cafe:1
  };
  function isFoodQuery(q){
    var toks = norm(q).split(/\s+/);
    for (var i = 0; i < toks.length; i++){ if (FOOD_INTENT[toks[i]]) return true; }
    return false;
  }
  function isFoodArticle(a){
    if (!a) return false;
    var cats = norm((a.categories || []).join(' ') + ' ' + (a.tags || []).join(' '));
    if (cats.indexOf('food') >= 0 || cats.indexOf('drink') >= 0 ||
        cats.indexOf('dining') >= 0 || cats.indexOf('restaurant') >= 0) return true;
    // Fallback for thinly-categorized posts: a clearly food-titled article.
    return /(restaurant|eatery|food hall|steakhouse|michelin|trattoria|osteria|izakaya|omakase|cocktail bar|wine bar|tasting menu)/
      .test(norm(a.title || ''));
  }
  // Generic geo words that must NOT become a standalone city alias ("lake",
  // "palm", "west" would over-match). Used to derive a distinctive short form.
  var GEN_GEO_WORDS = { lake:1,palm:1,west:1,east:1,north:1,south:1,beach:1,bay:1,port:1,fort:1,'new':1,san:1,santa:1,saint:1,st:1,the:1,grand:1,old:1 };
  // Match terms for a place: its full normalized name + a distinctive first
  // word (so "Delray"/"Boynton"/"Juno" in a headline still count).
  // New York City is ONE market — Manhattan and every borough roll up to it.
  // A query for any borough (or "New York"/"NYC") matches content tagged with
  // any of them, and the displayed place normalizes to "New York City".
  var NYC_FAMILY = ['new york city','new york','nyc','manhattan','brooklyn','queens','the bronx','bronx','staten island'];
  function nycPlace(name){ return NYC_FAMILY.indexOf(norm(name)) >= 0 ? 'New York City' : name; }
  function placeAliasTerms(name){
    var c = norm(name); if (!c) return [];
    if (NYC_FAMILY.indexOf(c) >= 0) return NYC_FAMILY.slice();
    var out = [c], first = c.split(' ')[0];
    if (first.length >= 4 && !GEN_GEO_WORDS[first] && out.indexOf(first) < 0) out.push(first);
    return out;
  }

  // Place-aware article matching state, set per query when a place is resolved.
  // _qPlaceTokens = the FULL ancestor token set of the query's place (city →
  // county → region → state); _qPlaceMatch = placeHit.match for linked projects.
  var _qPlaceTokens = null, _qPlaceMatch = null, _qProjBySlug = null;
  // When the query names a US state, drop journal articles that are explicitly
  // about a DIFFERENT state (e.g. a Texas/Florida golf piece on a "golf courses
  // in california" search). Conservative: only excludes articles that name
  // another state AND don't name the queried one — a CA article that only says
  // "Tahoe" or "La Quinta" (no other state) is untouched.
  var _qStateName = '';
  var _US_STATES = ['florida','california','texas','new york','tennessee','illinois','utah','south carolina','hawaii','colorado','wyoming','nevada','pennsylvania','michigan','missouri','ohio','puerto rico','georgia','north carolina','arizona','massachusetts'];
  function articleWrongState(title, hay){
    if (!_qStateName) return false;
    if (hay.indexOf(_qStateName) >= 0) return false;   // names the queried state anywhere → keep
    // Only drop when the TITLE is about another state — a passing body mention of
    // a bordering state (e.g. Tahoe's "Nevada's Carson Range") won't exclude an
    // otherwise on-topic article.
    for (var i = 0; i < _US_STATES.length; i++){
      if (_US_STATES[i] !== _qStateName && title.indexOf(_US_STATES[i]) >= 0) return true;
    }
    return false;
  }
  function projBySlug(){
    if (_qProjBySlug) return _qProjBySlug;
    _qProjBySlug = {};
    for (var i = 0; i < PROJECTS.length; i++){ var s = PROJECTS[i].Slug; if (s) _qProjBySlug[s] = PROJECTS[i]; }
    return _qProjBySlug;
  }
  // True when an article BELONGS to the query's place even if its text never
  // names the city — via its curated categories (region/place tags like "The
  // Palm Beaches") or its linked project sitting in that place. This is what
  // lets a "west palm beach" search surface a Palm-Beaches-tagged story or an
  // article about a WPB project that only names the project, not the city.
  function articleInPlace(a){
    if (!_qPlaceTokens || !a) return false;
    // linked project in the place
    if (a.project_slug){
      var pr = projBySlug()[a.project_slug];
      if (pr && _qPlaceMatch && _qPlaceMatch(pr)) return true;
    }
    // a curated category that is one of the place's ancestor tokens
    var cats = a.categories || [];
    for (var i = 0; i < cats.length; i++){
      var c = norm(cats[i]);
      if (c && _qPlaceTokens.has(c)) return true;
      // region categories ("The Palm Beaches") also match without the article
      var c2 = c.replace(/^the /, '');
      if (c2 && _qPlaceTokens.has(c2)) return true;
    }
    return false;
  }
  function scoreArticle(a, toks, full){
    var _inPlace = articleInPlace(a);
    var title=norm(a.title), exc=norm(a.excerpt), cats=norm((a.categories||[]).join(' ')), tags=norm((a.tags||[]).join(' '));
    var hay = title+' '+exc+' '+cats+' '+tags;
    if (!_inPlace && articleWrongState(title, hay)) return 0;   // title is about a different state → exclude
    var meaningful = (window.TmwSearchCore && window.TmwSearchCore.filterMeaningfulTokens)
      ? window.TmwSearchCore.filterMeaningfulTokens(toks)
      : toks.filter(function(t){ return t.length>=3; });
    if (meaningful.length>=2 && !_inPlace){
      var need = Math.ceil(meaningful.length*0.6);
      var havePhrase = full && hay.indexOf(full)>=0;
      // Synonym-aware coverage so "miami condos" still scores an article
      // titled "<X> Residences in Miami" — "condos" hits via the residence/
      // condominium variants. Articles that belong to the place (by category or
      // linked project) skip this text gate — their relevance is the place.
      var haveWords = meaningful.filter(function(t){ return tokenInHay(t, hay); }).length;
      if (!havePhrase && haveWords < need) return 0;
    }
    var s=0;
    if (_inPlace) s+=40;   // belongs to the queried place — strong relevance even w/o a text hit
    if (full){
      if (title.indexOf(full)>=0) s+=60;
      else if (exc.indexOf(full)>=0) s+=30;
      else if (hay.indexOf(full)>=0) s+=18;
    }
    var inTitle=0;
    for (var i=0;i<toks.length;i++){
      var t = toks[i];
      // Each field check counts the token OR any of its synonyms. Direct
      // hits still beat synonym hits via the title bonus block — exact
      // "condos" in the title scores +10, plus the indexOf below preserves
      // the existing weight ordering across all fields.
      if (tokenInHay(t, title)){ s+=10; inTitle++; }
      if (tokenInHay(t, cats))  s+=6;
      if (tokenInHay(t, tags))  s+=5;
      if (tokenInHay(t, exc))   s+=3;
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
  // Format every comma-separated name as a byline: "A", "A & B", "A, B & C".
  function commaAllField(s){
    var parts = String(s||'').split(',').map(function(x){return x.trim();}).filter(Boolean);
    if (parts.length <= 1) return parts[0] || '';
    return parts.slice(0, -1).join(', ') + ' & ' + parts[parts.length - 1];
  }

  // Rich project hero — ports /search/'s heroHtml exactly. Image-left,
  // body-right. Body: h1 → loc → desc → timeline → specs → byline →
  // gold "Learn more" + ghost "Visit site" CTAs.
  function renderProjectHero(p){
    var img = firstField(p, ['ImageURL','Image2','Image3']);
    var city = _locOf(p);
    var desc = firstField(p, ['DescriptionLong','Description']);
    // Show EVERY credited developer / architect, not just the first — a project
    // can be a JV (e.g. Highland Park Miami = Black Salmon + The Allen Morris
    // Company). Join the comma list with " & " so it reads as a byline.
    var dev  = commaAllField(p.Developer);
    var arch = commaAllField(p.Architect);
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
    // Part-of-district chip — resolved against the overlay's PROJECTS
    // closure (loaded by loadData() before any render runs) so the
    // umbrella's display name surfaces. Same purple-pill vocabulary as
    // the map/atlas/firm cards. Falls back to nothing on standalone
    // projects.
    var parentChipHtml = '';
    var parentSlug = (p.ParentSlug || '').trim();
    if (parentSlug && typeof PROJECTS !== 'undefined' && Array.isArray(PROJECTS)) {
      var parentRec = PROJECTS.find(function(r){ return (r.Slug || '') === parentSlug; });
      var parentName = parentRec ? (parentRec.Title || '') : '';
      if (parentName) {
        parentChipHtml = '<a class="tmw-ov-hero-chip" href="'+esc(mapLink(parentName, true))+'">'
          + 'Part of ' + esc(parentName) + ' →</a>';
      }
    }
    return '<article class="tmw-ov-hero">'
      + '<div class="media">'+media+'<div class="scrim"></div><span class="besttag">Top match</span></div>'
      + '<div class="body">'
      +   '<h2>'+esc(p.Title)+'</h2>'
      +   (city ? '<div class="loc">'+esc(city)+'</div>' : '')
      +   parentChipHtml
      +   (desc ? '<p class="desc">'+esc(desc)+'</p>' : '')
      +   (window.TMWIntel && window.TMWIntel.renderTimeline ? window.TMWIntel.renderTimeline(p) : heroTimelineHtml(p))
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
    var city = _locOf(p);
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
      +     '<span class="tmw-ov-intel-spark">'+ICON_HEX+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +     '<span class="tmw-ov-model" title="The model powering TMW Intelligence">Onyx 4.1</span>'
      +     '<span class="live">'+live+'</span>'
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans '+ansClass+'">'+ansHtml+'</p>'
      +   '<div class="tmw-ov-intel-foot">'
      +     '<span class="ai">Onyx 4.1</span> · TMW Intelligence, synthesized from the journal &amp; database'
      +   '</div>'
      + '</section>';
  }

  // Out-of-free-queries upgrade panel (gold accent) — mirrors /search/'s
  // intel-gate; opens the native in-page paywall via [data-tmw-paywall].
  function intelGateHtml(){
    return '<section class="tmw-ov-intel-panel gate">'
      +   '<div class="tmw-ov-intel-h">'
      +     '<span class="tmw-ov-intel-spark">'+ICON_HEX+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans">You’ve used all <b>' + ((window.tmwIntel && window.tmwIntel.FREE) || 5) + ' free</b> TMW Intelligence searches. Go <b>Pro</b> for unlimited natural-language search across the entire development pipeline — every project, firm, and milestone.</p>'
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
      +     '<span class="tmw-ov-intel-spark">'+ICON_HEX+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +     '<span class="tmw-ov-model" title="The model powering TMW Intelligence">Onyx 4.1</span>'
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
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(p.Title)+'" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var status = p.Delivery || '';
    return '<a class="tmw-ov-pcard" href="'+esc(mapLink(p.Title, true))+'">'
      + '<div class="tmw-ov-pcard-media">'+media+'</div>'
      + '<div class="tmw-ov-pcard-body">'
      +   '<h4>'+esc(p.Title)+'</h4>'
      +   (_locOf(p) ? '<div class="loc">'+esc(_locOf(p))+'</div>' : '')
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
    // Top chips use controlled vocabulary — title-case each word ("opening soon"
    // → "Opening Soon"). Leaves already-capitalised letters, digits, en-dashes and
    // proper nouns (firm / city) untouched.
    var tc = function (x) { return String(x).replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); }); };
    if (s.firm) {
      var roleLbl = s.firm.role === 'developer' ? 'Developer' : (s.firm.role === 'architect' ? 'Architect' : 'Firm');
      chips.push('<span class="tmw-ov-uchip"><span class="ck">'+roleLbl+'</span> <b>'+esc(s.firm.name)+'</b></span>');
    }
    if (s.firmRank) {
      var frLbl = s.firmRank === 'developer' ? 'Most active developer' : (s.firmRank === 'architect' ? 'Most active architect' : 'Most active firms');
      chips.push('<span class="tmw-ov-uchip"><span class="ck">Ranking</span> <b>'+esc(frLbl)+'</b></span>');
    }
    if (s.phaseLabels && s.phaseLabels.length) chips.push('<span class="tmw-ov-uchip"><span class="ck">Milestone</span> <b>'+esc(tc(s.phaseLabels.join(' / ')))+'</b></span>');
    if (s.statusLabels.length)                 chips.push('<span class="tmw-ov-uchip"><span class="ck">Status</span> <b>'+esc(tc(s.statusLabels.join(' / ')))+'</b></span>');
    if (s.typeLabel)                           chips.push('<span class="tmw-ov-uchip"><span class="ck">Type</span> <b>'+esc(tc(s.typeLabel))+'</b></span>');
    if (s.cities.length)                       chips.push('<span class="tmw-ov-uchip"><span class="ck">City</span> <b>'+esc(s.cities.join(' & '))+'</b></span>');
    else if (s.region)                         chips.push('<span class="tmw-ov-uchip"><span class="ck">Region</span> <b>'+esc(s.region)+'</b></span>');
    if (s._areaLabel)                          chips.push('<span class="tmw-ov-uchip"><span class="ck">Area</span> <b>'+esc(s._areaLabel)+'</b></span>');
    if (s.yearLabel)                           chips.push('<span class="tmw-ov-uchip"><span class="ck">'+(s.yearMode === 'start' ? 'Groundbreak' : 'Delivery')+'</span> <b>'+esc(tc(s.yearLabel))+'</b></span>');
    if (s.sort)                                chips.push('<span class="tmw-ov-uchip sort"><span class="ck">Sort</span> <b>'+esc(tc(s.sort.label))+'</b></span>');
    if (!chips.length) return '';
    return '<div class="tmw-ov-understood"><span class="lead">Understood as</span>' + chips.join('') + '</div>';
  }

  // The intel panel with the deterministic answer + DB-derived stats grid.
  // After this renders, fireSmartIntelUpgrade() may replace the sentence
  // with an LLM-written version (figures stay; only the prose softens).
  function renderSmartIntelPanel(ans, q, immediate){
    var stats = '';
    if (ans.stats && ans.stats.length){
      stats = '<div class="tmw-ov-intel-stats" style="grid-template-columns:repeat('+ans.stats.length+',1fr)">'
        + ans.stats.map(function(st){
            return '<div class="tmw-ov-istat"><div class="v">'+st.v+'</div><div class="k">'+esc(st.k)+'</div></div>';
          }).join('')
        + '</div>';
    }
    // LLM-first: show a cached LLM answer instantly, else a loader — never the
    // deterministic sentence up front (it would flash, then get replaced). The
    // deterministic prose stays the fallback if the LLM can't be reached.
    // EXCEPTION — `immediate`: when we know the LLM will NOT be called (zero
    // results, or a fully-deterministic firm/no-results answer), show the answer
    // text right away. Otherwise the loader would spin forever ("Thinking…").
    var cached = cachedAnswer(q);
    var showNow = !!cached || !!immediate;
    var ansCls = showNow ? '' : 'loading';
    var ansHtml = cached ? esc(cached)
      : (immediate ? (ans.html || '')
      : '<span class="tmw-ov-intel-loader" aria-hidden="true"><span></span><span></span><span></span></span>Looking through the pipeline for an answer…');
    return '<section class="tmw-ov-intel-panel">'
      +   '<div class="tmw-ov-intel-h">'
      +     '<span class="tmw-ov-intel-spark">'+ICON_HEX+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +     '<span class="tmw-ov-model" title="The model powering TMW Intelligence">Onyx 4.1</span>'
      +     '<span class="live"><i></i>'+(showNow ? 'Live answer' : 'Thinking')+'</span>'
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans '+ansCls+'" data-fallback="'+esc(ans.html)+'">'+ansHtml+'</p>'
      +   stats
      + '</section>';
  }

  function renderSmartHeader(s, rows, hasHero){
    var n = rows.length;
    // When a hero card is shown ABOVE this list (rank 1), these are the REST —
    // label them "N more project(s)" so it's clear they're in addition to it.
    var title = hasHero ? (n === 1 ? '1 more project' : (n + ' more projects'))
                        : (n === 1 ? '1 project' : (n + ' projects'));
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
      metric = '<div class="r-metric"><div class="n" style="font-size:14px">' + (esc(Core.fmtDelivery(p) || '—')) + '</div><div class="l">' + Core.deliveryVerb(p) + '</div></div>';
    }
    var deliveryNote = (!sortKey && Core.fmtDelivery(p)) ? ('<span class="dot"></span><span>' + Core.deliveryVerb(p) + ' ' + esc(Core.fmtDelivery(p)) + '</span>') : '';
    var sub = '<span class="sb '+badge.cls+'"><i></i>'+esc(badge.label)+'</span>'
            + (_locOf(p) ? '<span class="dot"></span><span>'+esc(_locOf(p))+'</span>' : '')
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

  // ── iconic editorial lists (golf / hotels / restaurants) ──────────
  var ICONIC_NOUN = { golf: 'golf courses', hotels: 'hotels', restaurants: 'restaurants' };
  var ICON_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.7 5.4 6 .9-4.3 4.2 1 6L12 17l-5.4 2.8 1-6L3.3 9.3l6-.9L12 3z"/></svg>';
  // The place a narrowed iconic list resolved to (dominant region of the hits),
  // for the header + answer. Empty when the full list is shown (no place named).
  function iconicPlaceLabel(kind, items){
    var full = (ICONIC[kind] || []).length;
    if (!items.length || items.length >= full) return '';
    var rc = {}; items.forEach(function(it){ var r = it.region || ''; if (r) rc[r] = (rc[r] || 0) + 1; });
    return Object.keys(rc).sort(function(a, b){ return rc[b] - rc[a]; })[0] || '';
  }
  function renderIconicRow(item, rank, s){
    var loc = item.location || item.region || '';
    // Deep-link to the item's anchor on OUR iconic list page (not its external
    // site): /golf/#<id>, /hotels/#<id>, /restaurants/#<id>. The list page reads
    // the hash on load and scrolls to that card.
    var href = 'https://www.oftmw.com/' + s.iconic + '/' + (item.id ? '#' + encodeURIComponent(item.id) : '');
    var thumb = item.image
      ? '<div class="r-ico" style="background-image:url('+esc(item.image)+');background-size:cover;background-position:center;border:none;border-radius:8px"></div>'
      : '<div class="r-ico">'+ICON_STAR+'</div>';
    var sub = '<span class="sb" style="padding:3px 11px;border-radius:7px;background:rgba(168,135,255,.16);color:#cdb6ff"><i style="background:#b69bff"></i>Iconic</span>'
            + (loc ? '<span class="dot"></span><span>'+esc(loc)+'</span>' : '');
    return '<a class="tmw-ov-row" href="'+esc(href)+'">'
      + '<div class="rank">'+rank+'</div>'
      + thumb
      + '<div class="r-main"><div class="r-name">'+esc(item.name)+'</div><div class="r-sub">'+sub+'</div></div>'
      + '<div class="arrow">'+ICON_ARROW+'</div>'
      + '</a>';
  }
  // The #1 iconic pick rendered as a rich hero card — same geometry/treatment as
  // the project hero (image-left, body-right, CTAs) so an iconic result ALWAYS
  // leads with a hero, not just a row.
  function renderIconicHero(item, s){
    var loc = item.location || item.region || '';
    var listHref = 'https://www.oftmw.com/' + s.iconic + '/' + (item.id ? '#' + encodeURIComponent(item.id) : '');
    var site = item.officialUrl || '';
    var desc = item.description || '';
    var media = item.image
      ? '<img src="'+esc(item.image)+'" alt="'+esc(item.name)+'" loading="eager" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var bits = [];
    if (item.architect) bits.push('Designed by <b>'+esc(item.architect)+'</b>');
    if (item.year) bits.push('Est. <b>'+esc(String(item.year))+'</b>');
    var byline = bits.length ? '<div class="tmw-ov-byline">'+bits.join(' · ')+'</div>' : '';
    return '<article class="tmw-ov-hero">'
      + '<div class="media">'+media+'<div class="scrim"></div><span class="besttag" style="background:rgba(168,135,255,.92);color:#1a1430">Iconic pick</span></div>'
      + '<div class="body">'
      +   '<h2>'+esc(item.name)+'</h2>'
      +   (loc ? '<div class="loc">'+esc(loc)+'</div>' : '')
      +   '<span class="tmw-ov-hero-chip" style="background:rgba(168,135,255,.16);color:#cdb6ff;border-color:rgba(168,135,255,.42)">Iconic '+esc((ICONIC_NOUN[s.iconic]||'pick').replace(/ courses$/,'').replace(/s$/,''))+'</span>'
      +   (desc ? '<p class="desc">'+esc(desc)+'</p>' : '')
      +   byline
      +   '<div class="tmw-ov-hero-cta">'
      +     '<a class="tmw-ov-btn gold" href="'+esc(listHref)+'">'
      +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
      +       'View on list'
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
  function renderIconicSection(items, s, q){
    if (!items.length) return '';
    var noun = ICONIC_NOUN[s.iconic] || 'picks';
    var placeLbl = iconicPlaceLabel(s.iconic, items);
    var CAP = 24, shown = items.slice(0, CAP);   // #1 lives IN the list now (no separate hero card)
    // Header echoes the user's ACTUAL query so qualifiers they typed (e.g.
    // "waterfront") show; falls back to a constructed label if q is absent.
    var label = (q && q.trim()) ? q.trim() : ('iconic ' + noun + (placeLbl ? ' in ' + placeLbl : ''));
    var rowsHtml = shown.map(function(it, i){ return renderIconicRow(it, i + 1, s); }).join('');   // ranks from 1
    var head = '<div class="tmw-ov-smart-head"><h3>'+esc(label)+'</h3>'
      + '<a class="map-link" href="https://www.oftmw.com/'+s.iconic+'/">'+ICON_STAR+' Full list</a></div>';
    var foot = (items.length > CAP) ? '<div class="tmw-ov-smart-foot">showing top '+CAP+' of '+items.length+'</div>' : '';
    return '<div class="tmw-ov-sec" data-cat="articles">'+head+'<div class="tmw-ov-rows">'+rowsHtml+'</div>'+foot+'</div>';
  }
  function buildIconicAnswerHtml(s, items, projectRows){
    var noun = ICONIC_NOUN[s.iconic] || 'picks';
    var placeLbl = iconicPlaceLabel(s.iconic, items);
    var names = items.slice(0, 3).map(function(it){ return '<b>'+esc(it.name)+'</b>'; });
    var html = items.length + ' iconic ' + noun + (placeLbl ? ' in ' + esc(placeLbl) : '') + ' on our radar'
      + (names.length ? ' — led by ' + names.join(', ') : '') + '.';
    if (projectRows.length) html += ' Plus <b>'+projectRows.length+'</b> tracked development'
      + (projectRows.length === 1 ? '' : 's') + ' in the pipeline.';
    return html;
  }
  // Pull a place phrase out of the raw query for a no-results message when the
  // place wasn't a tracked project place (e.g. "best golf courses in china").
  function placeFromQuery(q){
    var m = String(q || '').match(/\b(?:in|near|around|across|throughout|within|at|of)\s+(.+?)\s*[?.!]*$/i);
    return m ? m[1].replace(/[?.!]+$/, '').trim() : '';
  }
  // Instant "we're not tracking any X in Y yet." — shown the moment a typed /
  // iconic query resolves to zero results, instead of a loader that never fills.
  function buildNoResultsAnswer(s, q){
    var noun = s.iconic ? (ICONIC_NOUN[s.iconic] || 'results')
      : (s.typeLabel ? (s.typeLabel.toLowerCase() + (/s$/.test(s.typeLabel) ? '' : ' projects')) : 'projects');
    var place = (s.cities && s.cities.length) ? s.cities.join(' & ') : (s.region || placeFromQuery(q));
    return 'We’re not tracking any ' + esc(noun) + (place ? ' in <b>' + esc(tc(place)) + '</b>' : '') + ' yet.';
  }

  // ── orchestration ─────────────────────────────────────────────────
  // Chat thread: every query gets its own turn (user message + answer block).
  // newTurn() appends a turn and RE-POINTS the render targets at it, so all the
  // existing render functions keep writing into "the current turn" unchanged.
  function newTurn(userText){
    sStarter.classList.add('tmw-ov-hidden');        // hide the teach card once a conversation starts
    var turn = document.createElement('div');
    turn.className = 'tmw-ov-turn';
    turn.innerHTML = '<div class="tmw-ov-msg-row"><div class="tmw-ov-msg">' + esc(userText) + '</div></div>'
      + '<div class="tmw-ov-answer">' + TURN_ANSWER_HTML + '</div>';
    _threadEl.appendChild(turn);
    // Re-point the per-turn render targets at this turn.
    sThinking = turn.querySelector('[data-state="thinking"]');
    sResults  = turn.querySelector('[data-state="results"]');
    sEmpty    = turn.querySelector('[data-state="empty"]');
    slotFilterPills = turn.querySelector('[data-slot="filter-pills"]');
    slotIntel = turn.querySelector('[data-slot="intel-cta"]');
    slotHero  = turn.querySelector('[data-slot="hero"]');
    slotRows  = turn.querySelector('[data-slot="rows"]');
    slotProjGrid = turn.querySelector('[data-slot="projects-grid"]');
    slotEntities = turn.querySelector('[data-slot="entities"]');
    slotArticles = turn.querySelector('[data-slot="articles-grid"]');
    // Bring the new message + loader into view immediately (at the bottom, above
    // the bar) while the answer loads; setState does the authoritative long/short
    // positioning once results land.
    try { bodyEl.scrollTop = bodyEl.scrollHeight; } catch(_){}
    return turn;
  }

  function setState(name){
    // 'starter' = the empty-thread teach screen (standalone, above the thread).
    sStarter.classList.toggle('tmw-ov-hidden', name !== 'starter');
    // thinking / results / empty operate on the CURRENT turn (re-pointed by
    // newTurn). Guard in case a state is set before any turn exists.
    if (sThinking) sThinking.classList.toggle('show', name === 'thinking');
    if (sResults)  sResults.classList.toggle('tmw-ov-hidden', name !== 'results');
    if (sEmpty)    sEmpty.classList.toggle('tmw-ov-hidden', name !== 'empty');
    // Per-turn thumbs row: show on results/empty and stamp it with THIS turn's
    // query context so a vote describes the right answer (feeds the intel improver).
    var turn = (sResults && sResults.closest) ? sResults.closest('.tmw-ov-turn') : null;
    var fbEl = turn ? turn.querySelector('.tmw-ov-feedback') : null;
    if (fbEl) {
      var on = (name === 'results' || name === 'empty');
      fbEl.classList.toggle('show', on);
      if (on) {
        // NOTE: use data-fbq, NOT data-q — the suggestion click handler treats
        // any [data-q] click as "run this query", so a data-q here made clicking
        // a thumb re-submit the query as a duplicate turn.
        fbEl.setAttribute('data-fbq', _lastQuery || '');
        fbEl.setAttribute('data-results', String(_lastResultsTotal));
        fbEl.setAttribute('data-kind', _lastResultKind || '');
        // Relocate the live/thinking indicator from the answer header into this
        // feedback row (left side) so it lands on the thumbs' horizontal line.
        var _liveEl = turn && turn.querySelector('.tmw-ov-intel-h .live');
        if (_liveEl && _liveEl.parentNode !== fbEl) fbEl.insertBefore(_liveEl, fbEl.firstChild);
      }
      // Position the freshly-answered turn: long → message pinned to top, short
      // → bottom-anchored above the bar. setState('results'/'empty') fires ONCE
      // per query (the LLM upgrade + journal body-scan re-render their slots
      // without calling setState), so this never fires on async re-renders and
      // won't yank the view when the user has scrolled up to an earlier turn.
      if (on) positionLatestTurn();
    }
  }

  // Position the just-answered turn (called ONCE per query, from setState after
  // the answer has rendered — so the long/short decision is based on the real
  // height). Long turn → pin the user message to the top so the full answer
  // leads the viewport. Short turn → rest its bottom just above the search bar
  // (bottom-anchor). DOCK_RESERVE ≈ the search dock's height, so "fits" means
  // "fits in the space above the bar."
  var DOCK_RESERVE = 170;
  function positionLatestTurn(){
    if (!bodyEl || !_threadEl) return;
    var turn = (sResults && sResults.closest && sResults.closest('.tmw-ov-turn')) || _threadEl.lastElementChild;
    if (!turn) return;
    var fits = turn.offsetHeight <= (bodyEl.clientHeight - DOCK_RESERVE);
    if (fits) {
      bodyEl.scrollTop = bodyEl.scrollHeight;             // bottom-anchor (just above the dock)
    } else {
      var msg = turn.querySelector('.tmw-ov-msg-row') || turn;
      bodyEl.scrollTop = Math.max(0, msg.offsetTop - 14); // top-anchor the user message
    }
  }

  // Single entry point for a user-initiated query: the text leaves the bar and
  // becomes a sent message, a new turn is appended, and runQuery renders into it.
  function submitQuery(q){
    q = String(q || '').trim();
    if (!q) return;
    _userInteracted = true;   // the user took over → don't let a pending cloud-resume overwrite their turn
    _replaySeq++;             // cancel any in-flight resume replay
    _replaying = false;       // a real user query → DO track it
    input.value = '';
    if (go) go.classList.remove('ready');
    _thread.push({ q: q, parsed: null, answer: null });
    saveThread();
    newTurn(q);
    runQuery(q);
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

  // ── Chat thread state ───────────────────────────────────────────────
  // The conversation: one record per turn. `parsed` (the structured query) and
  // `answer` (the LLM reply) are filled in as the turn renders — `parsed` powers
  // follow-up resolution, `answer` powers conversation context + persistence.
  var _thread = [];                  // [{ q, parsed, answer }]
  var _THREAD_KEY = 'tmw_intel_thread';
  // Sticky output preference: once the user clicks a tab (Intelligence / Projects
  // / Journal / All) THIS session, that becomes the default lens for FOLLOWING
  // queries instead of re-guessing per query. Deliberately SESSION-ONLY (not
  // restored from a prior visit) — every fresh load starts on All (see below).
  var _FILTER_KEY = 'tmw_intel_filter_pref';
  var _stickyFilter = '';
  function _setStickyFilter(f){
    _stickyFilter = f || '';
    try { if (_stickyFilter) localStorage.setItem(_FILTER_KEY, _stickyFilter); else localStorage.removeItem(_FILTER_KEY); } catch(_){}
  }
  // The FIRST result view of a page load always defaults to All, regardless of any
  // sticky lens — "every time you load into search, you land on All."
  var _sessionFirstView = true;
  // Honor the sticky preference when its category has content for THIS query;
  // otherwise fall back to Intelligence (the always-relevant synthesis) — or All
  // if this query produced no Intelligence answer. counts: {intel, projects, firms}.
  // ('articles' is provisional here — renderArticleSection corrects it once the
  // journal match count is known.)
  function _stickyDefault(computed, counts){
    counts = counts || {};
    if (_sessionFirstView) { _sessionFirstView = false; return 'overview'; }   // fresh load → Overview
    if (!_stickyFilter) return computed;
    if (_stickyFilter === 'all' || _stickyFilter === 'overview') return 'overview';   // 'all' = legacy sticky
    if (_stickyFilter === 'articles') return 'articles';   // provisional (see renderArticleSection)
    if (_stickyFilter === 'intel'    && counts.intel)        return 'intel';
    if (_stickyFilter === 'projects' && counts.projects > 0) return 'projects';
    if (_stickyFilter === 'firms'    && counts.firms > 0)    return 'firms';
    return counts.intel ? 'intel' : 'overview';   // sticky lens empty for this query → Intelligence, else Overview
  }
  // Logged-in Memberstack id (mem_*) → enables device-to-device thread sync.
  // The map page (and others) don't all load member-track.js / set __tmwMember,
  // so resolve the member directly from Memberstack and cache it. Falls back to
  // __tmwMember when that's the only thing set.
  var _mid = '';
  (function _pollMember(){
    var tries = 0;
    var t = setInterval(function(){
      try {
        if (window.__tmwMember && typeof window.__tmwMember.id === 'string' && window.__tmwMember.id.indexOf('mem_') === 0) { _mid = window.__tmwMember.id; clearInterval(t); return; }
        var ms = window.$memberstackDom;
        if (ms && ms.getCurrentMember){
          clearInterval(t);
          ms.getCurrentMember().then(function(r){
            var m = r && r.data;
            if (m && typeof m.id === 'string' && m.id.indexOf('mem_') === 0) _mid = m.id;
          }).catch(function(){});
        } else if (++tries > 120) { clearInterval(t); }   // ~12s — Memberstack never loaded / logged out
      } catch(_){ clearInterval(t); }
    }, 100);
  })();
  function _memberId(){ return _mid; }
  // Resolve the logged-in Memberstack id ON DEMAND (the init poll may not have
  // finished, or __tmwMember may never be set on this page). Cached once found.
  function _resolveMid(){
    if (_mid) return Promise.resolve(_mid);
    try {
      if (window.__tmwMember && typeof window.__tmwMember.id === 'string' && window.__tmwMember.id.indexOf('mem_') === 0) { _mid = window.__tmwMember.id; return Promise.resolve(_mid); }
      var ms = window.$memberstackDom;
      if (ms && ms.getCurrentMember) {
        return ms.getCurrentMember().then(function(r){
          var m = r && r.data;
          if (m && typeof m.id === 'string' && m.id.indexOf('mem_') === 0) _mid = m.id;
          return _mid;
        }).catch(function(){ return ''; });
      }
    } catch(_){}
    return Promise.resolve('');
  }
  function _threadQs(){ return _thread.map(function(t){ return t.q; }).filter(Boolean).slice(-12); }
  var _serverSaveTimer = null;
  var _syncedTs = 0;   // cloud updated_at (server ms) this device is currently in sync with
  // Push the query list to the worker so the same member resumes on any device.
  // Debounced + best-effort; the localStorage copy remains the offline fallback.
  function saveThreadToServer(){
    clearTimeout(_serverSaveTimer);
    _serverSaveTimer = setTimeout(function(){
      _resolveMid().then(function(mid){
        if (!mid) return;   // logged out → device-local only
        try {
          fetch(WORKER_URL + '/intel-thread', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
            body: JSON.stringify({ member_id: mid, qs: _threadQs() })
          })
          .then(function(r){ return r.ok ? r.json() : null; })
          .then(function(d){ if (d && d.ts) _syncedTs = d.ts; try { console.info('[TMW Intelligence] conversation synced to your account'); } catch(_){} })
          .catch(function(){});
        } catch(_){}
      });
    }, 1200);
  }
  function fetchServerThread(){
    return _resolveMid().then(function(mid){
      if (!mid) return { qs: null, ts: 0 };
      return fetch(WORKER_URL + '/intel-thread?member_id=' + encodeURIComponent(mid) + '&t=' + Date.now(), { cache: 'no-store' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){
          var qs = (d && Array.isArray(d.qs) && d.qs.length) ? d.qs : null;
          return { qs: qs, ts: (d && d.ts) || 0 };
        })
        .catch(function(){ return { qs: null, ts: 0 }; });
    });
  }
  // Live cross-device sync: while the overlay is open, adopt a thread written by
  // ANOTHER device (cloud ts newer than our last sync) with no page refresh.
  // The ts gate means this device's OWN saves never trigger a re-adopt, and a
  // pending local save isn't clobbered (cloud ts only advances once it lands).
  function _reconcileCloud(){
    if (!root.classList.contains('open')) return;
    fetchServerThread().then(function(res){
      if (!res || !res.ts || res.ts <= _syncedTs) return;   // nothing newer than what we have
      _syncedTs = res.ts;
      if (res.qs && res.qs.join('') !== _threadQs().join('')) {
        _userInteracted = false;
        _resumeReplay(res.qs);
      }
    });
  }
  // Poll while the overlay is open so another device's update lands within ~10s
  // even with both screens visible (no focus change). The listeners below make a
  // device-switch (tab regains focus/visibility) sync instantly.
  var _syncPoll = null;
  function _startSyncPoll(){ clearInterval(_syncPoll); _syncPoll = setInterval(_reconcileCloud, 10000); }
  function _stopSyncPoll(){ clearInterval(_syncPoll); _syncPoll = null; }
  try {
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) _reconcileCloud(); });
    window.addEventListener('focus', function(){ _reconcileCloud(); });
  } catch(_){}
  function saveThread(){
    var qs = _threadQs();
    // Defense: before the user has actually submitted this session, never clobber a
    // LONGER saved thread with a shorter one (guards against a race writing before a
    // restore completes). Real submits set _userInteracted, so they always save.
    if (!_userInteracted && qs.length) {
      try { var stored = readThread(); if (stored && stored.length > qs.length) return; } catch(_){}
    }
    try {
      if (qs.length) localStorage.setItem(_THREAD_KEY, JSON.stringify({ qs: qs, ts: Date.now() }));
      else localStorage.removeItem(_THREAD_KEY);
    } catch(_){}
    saveThreadToServer();   // mirror to the member's cloud thread (logged-in only)
  }
  function readThread(){
    try {
      var raw = localStorage.getItem(_THREAD_KEY); if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && Array.isArray(o.qs) && o.qs.length && (Date.now() - (o.ts || 0) < _RESUME_TTL)) return o.qs;
    } catch(_){}
    return null;
  }
  // Replay a saved query list into the thread (used by resume). Re-renders each
  // turn sequentially (so the global _renderToken doesn't invalidate earlier
  // ones); cheap because data loads once and LLM answers are cached. Does NOT
  // re-save — saving happens on real user submits, so a replay can't clobber the
  // member's cloud thread while we're still reconciling it.
  var _replaySeq = 0;        // bumps to cancel an in-flight replay (adopt-cloud / user-takeover)
  var _userInteracted = false;   // set on a user submit; blocks a late cloud-resume from overwriting their turn
  var _replaying = false;        // true while restoring a saved thread — suppresses analytics + quota (it's a re-render, not a new query)
  function _resumeReplay(qs, done){
    if (!qs || !qs.length) { if (done) done(); return; }
    var mySeq = ++_replaySeq;
    input.value = '';
    _thread = [];
    if (_threadEl) _threadEl.innerHTML = '';   // clear any prior render (e.g. swapping a stale local thread for the cloud one)
    sStarter.classList.add('tmw-ov-hidden');   // never flash the teach card before the replay
    _replaying = true;                         // suppress analytics/quota for restored turns
    loadData().then(function(){
      (function next(i){
        if (mySeq !== _replaySeq) { _replaying = false; return; }   // superseded → stop suppressing (NO done — a user took over)
        if (i >= qs.length) { _replaying = false; if (done) done(); return; }   // done → tracking back on + run the continuation
        var q = qs[i];
        _thread.push({ q: q, parsed: null, answer: null });
        newTurn(q);
        var p = runQuery(q);
        (p && p.then ? p : Promise.resolve()).then(function(){ if (mySeq === _replaySeq) setTimeout(function(){ next(i + 1); }, 0); });
      })(0);
    });
  }
  // open(initialQuery) entry (e.g. a /?q=… deep link or an "open in search" launcher):
  // RESTORE the saved conversation first, THEN append this query as a follow-up turn —
  // so the deep link continues the thread instead of starting (and overwriting) a new one.
  function _resumeThenSubmit(initialQuery){
    var baseQs = readThread();
    if (!baseQs) { var _r0 = readLastQuery(); if (_r0) baseQs = [_r0]; }
    if (baseQs && baseQs.length) { _userInteracted = false; _resumeReplay(baseQs, function(){ submitQuery(initialQuery); }); return; }
    // No local thread (cache cleared / different device): check the cloud, but don't
    // stall the answer if it's slow or the user is logged out.
    var fired = false;
    var t = setTimeout(function(){ if (!fired) { fired = true; submitQuery(initialQuery); } }, 1500);
    fetchServerThread().then(function(res){
      if (fired) return; fired = true; clearTimeout(t);
      var serverQs = res && res.qs;
      if (serverQs && serverQs.length) { _userInteracted = false; _resumeReplay(serverQs, function(){ submitQuery(initialQuery); }); }
      else submitQuery(initialQuery);
    }).catch(function(){ if (!fired) { fired = true; clearTimeout(t); submitQuery(initialQuery); } });
  }
  // Prior turns (oldest→newest, capped) as { q, answer } for the LLM's context.
  function threadHistory(){
    return _thread.slice(0, -1).filter(function(t){ return t.q && t.answer; })
      .slice(-3).map(function(t){ return { q: t.q, answer: t.answer }; });
  }
  // Only a short elliptical follow-up ("what about Miami?", "and condos?") should
  // carry prior-turn context to the LLM. A complete query is answered single-turn
  // (the proven-good path) — sending history made it reference the wrong prior
  // facts and turn apologetic ("outside our verified coverage").
  function _isFollowupQ(q){
    var qn = String(q || '').trim().toLowerCase().replace(/[?!.]+$/, '');
    var wc = qn ? qn.split(/\s+/).length : 0;
    return wc > 0 && (wc <= 4 || /^(and|or|but|what about|how about|whatabout|ok|okay|now|also|plus|then|in|for)\b/.test(qn));
  }

  // ── Resume last session ─────────────────────────────────────────────
  // Persist the user's last query so re-opening TMW Intelligence returns them to
  // where they were — not a blank reset. Survives navigating into a project/firm
  // and coming back. Re-running a remembered query is free (it's already counted
  // in tmwIntel.seen and the LLM answer is server-cached), so restore is cheap.
  var _RESUME_KEY = 'tmw_intel_lastq';
  var _RESUME_TTL = 7 * 24 * 3600 * 1000;   // a week — long enough to "return", not forever
  function saveLastQuery(q){
    try {
      if (q && String(q).trim()) localStorage.setItem(_RESUME_KEY, JSON.stringify({ q: String(q).trim(), ts: Date.now() }));
    } catch(_){}
  }
  function readLastQuery(){
    try {
      var raw = localStorage.getItem(_RESUME_KEY); if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && o.q && (Date.now() - (o.ts || 0) < _RESUME_TTL)) return o.q;
    } catch(_){}
    return null;
  }

  // ── LLM answer cache ────────────────────────────────────────────────
  // Remember the LLM answer per query so reopening (or re-asking) shows it
  // INSTANTLY instead of flashing the deterministic database sentence and then
  // swapping in the LLM. Users should see ONE answer — the LLM's — not two.
  var _ANS_KEY = 'tmw_intel_ans', _ANS_TTL = 24 * 3600 * 1000;   // matches the worker's 24h server cache
  function _normKey(q){ return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function _ansMap(){ try { return JSON.parse(localStorage.getItem(_ANS_KEY) || '{}'); } catch(_){ return {}; } }
  function cacheAnswer(q, a){
    if (!q || !a) return;
    try {
      var m = _ansMap(); m[_normKey(q)] = { a: String(a), ts: Date.now() };
      var keys = Object.keys(m);
      if (keys.length > 40) { keys.sort(function(x, y){ return (m[x].ts || 0) - (m[y].ts || 0); }); delete m[keys[0]]; }
      localStorage.setItem(_ANS_KEY, JSON.stringify(m));
    } catch(_){}
  }
  function cachedAnswer(q){
    try { var e = _ansMap()[_normKey(q)]; if (e && e.a && (Date.now() - (e.ts || 0) < _ANS_TTL)) return e.a; } catch(_){}
    return null;
  }
  // Loading panel that shows the cached LLM answer up front when we have one
  // (so there's no spinner on a repeat/resumed query).
  function intelLoadingHtml(q){
    var c = cachedAnswer(q);
    return c ? intelPanelHtml('answer', q, c) : intelPanelHtml('loading', q);
  }

  // ── Thumbs feedback ─────────────────────────────────────────────────
  // Reset the feedback row to its unvoted, dim state. Called at the top
  // of every runQuery so a previous vote doesn\'t bleed across queries.
  function resetFeedback(){
    var turn = (sResults && sResults.closest) ? sResults.closest('.tmw-ov-turn') : null;
    var fbEl = turn ? turn.querySelector('.tmw-ov-feedback') : null;
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
  function sendFeedback(rating, ctx){
    try {
      ctx = ctx || {};
      var fq = ctx.q || _lastQuery;          // the voted turn's query (per-answer)
      if (!fq) return;
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
          q: String(fq).slice(0, 200),
          rating: rating, // 'up' or 'down'
          results: (ctx.results != null && !isNaN(ctx.results)) ? ctx.results : _lastResultsTotal,
          result_kind: ctx.kind || _lastResultKind,
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
    sendFeedback(rating, {
      q: fbEl.getAttribute('data-fbq') || _lastQuery,
      results: parseInt(fbEl.getAttribute('data-results') || '', 10),
      kind: fbEl.getAttribute('data-kind') || ''
    });
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
    saveLastQuery(q);   // remember for "resume where you left off" on reopen
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
      slotFilterPills.innerHTML = '';
      sResults.removeAttribute('data-filter');
      sEmpty.classList.add('tmw-ov-hidden');
      _lastResultsTotal = 1;
      _lastResultKind = 'spotlight';
      setState('results');
      return;
    }

    // Returned so the thread-resume replay can await each turn in sequence
    // (the global _renderToken would otherwise invalidate all but the last).
    return loadData().then(function(){
      if (token !== _renderToken) return;
      try {
      // ── PHASE 2B: structured smart query ─────────────────────────────
      // Try parseSmartQuery FIRST — if the query has enough structure
      // (status + place + type, sort + place, firm + anything, etc.) we
      // skip text-match scoring entirely and render the deterministic
      // Intelligence layout. This is the "tallest towers under
      // construction in the Carolinas" path.
      var smart = Core && Core.parseSmartQuery
        ? Core.parseSmartQuery(q, { firms: FIRMS, projects: PROJECTS })
        : null;
      // Conversational: a partial follow-up ("what about Miami?", "and condos?")
      // inherits the prior turn's unset dimensions (type/status/sort/firm/iconic)
      // so the RESULTS stay on-topic, not just the narration.
      var _prior = null;
      for (var _ti = _thread.length - 2; _ti >= 0; _ti--){ if (_thread[_ti] && _thread[_ti].parsed){ _prior = _thread[_ti].parsed; break; } }
      if (smart && _prior && Core.resolveFollowup) { smart = Core.resolveFollowup(smart, _prior); }
      // Stash the parse on the current turn for the NEXT follow-up + the LLM.
      if (_thread.length) _thread[_thread.length - 1].parsed = smart || null;
      // Dining isn't a project type — it's journal coverage. Route ANY food
      // query to the text path, which answers from the Food & Drink articles.
      // A coincidental firm match ("Nashville" → "The Nashville Predators") must
      // NOT keep it in the project readout. Only an explicit project TYPE in the
      // query ("hotels with restaurants") keeps the structured parse.
      if (smart && isFoodQuery(q) && !(smart.types && smart.types.size)) {
        smart = null;
      }
      if (smart) {
        renderStructuredSmart(q, smart, token);
        return;
      }
      // Otherwise fall through to text-match scoring + the question /
      // LLM path. Token re-checked inside runTextMatch.
      runTextMatch(q, token);
      } catch (err) {
        // A render bug must never strand the user on the loading spinner.
        try { console.error('[tmw-search] render failed:', err); } catch(_){}
        if (token === _renderToken) {
          try { slotIntel.innerHTML=''; slotHero.innerHTML=''; slotRows.innerHTML=''; slotProjGrid.innerHTML=''; slotEntities.innerHTML=''; slotArticles.innerHTML=''; slotFilterPills.innerHTML=''; } catch(_){}
          _lastResultsTotal = 0; _lastResultKind = 'empty';
          setState('empty');
        }
      }
    });
  }

  // Generic nouns that should NOT drive neighborhood/submarket narrowing.
  var RESIDUAL_STOP = { tower:1,towers:1,condo:1,condos:1,residence:1,residences:1,
    project:1,projects:1,building:1,buildings:1,development:1,developments:1,
    apartment:1,apartments:1,new:1,luxury:1,upcoming:1,recent:1,recently:1,newest:1,latest:1,
    tallest:1,biggest:1,largest:1,happening:1,activity:1,
    // Forward / pipeline / status intent words — these drive the parse (pipeline,
    // status), they're never a place qualifier. Without them here, a query like
    // "new hotels OPENING in florida" used "opening" as a residual text filter and
    // collapsed 51 FL hotels down to the 2 whose blurb literally said "opening".
    opening:1,openings:1,opens:1,opened:1,coming:1,comes:1,come:1,soon:1,planned:1,
    proposed:1,announced:1,unveiled:1,slated:1,scheduled:1,'set':1,debuting:1,debut:1,
    launching:1,launch:1,underway:1,future:1,rising:1,rise:1,unbuilt:1,forthcoming:1,
    pipeline:1,works:1,way:1,horizon:1,breaking:1,ground:1,groundbreaking:1,broke:1,
    construction:1,completed:1,complete:1,delivered:1,delivering:1,delivers:1,finished:1,
    just:1,now:1,currently:1,being:1,built:1,develop:1,developed:1,track:1,tracked:1,tracking:1,
    // Geographic filler words — keep the actual place name as the residual.
    // (NB: "district" is intentionally NOT here — it's part of "design district".)
    neighborhood:1,neighbourhood:1,neighborhoods:1,area:1,areas:1,submarket:1,
    hood:1,zone:1,section:1,vibe:1,scene:1,located:1 };

  // When the structured parse consumes a city/firm/etc. but leaves a residual
  // qualifier the engine ignored — most importantly a NEIGHBORHOOD like "design
  // district" (there's no neighborhood field, so it lives in Title/Description)
  // — narrow the result set to projects whose text actually mentions it. This
  // is what makes "miami design district" surface MIRAI / Fouquet's /
  // Jean-Georges instead of all 88 Miami projects. Never empties the set, and
  // only narrows on a meaningful (non-generic) residual.
  function applyResidualText(q, s, rows){
    var Core = window.TmwSearchCore;
    var toks = (Core && Core.filterMeaningfulTokens) ? Core.filterMeaningfulTokens(tokenize(q)) : tokenize(q);
    if (!toks.length || !rows.length) return { rows: rows };
    var consumed = norm([
      (s.cities||[]).join(' '), s.region||'', (s.firm&&s.firm.name)||'',
      s.typeLabel||'', (s.statusLabels||[]).join(' '), (s.phaseLabels||[]).join(' '),
      s.yearLabel||'', (s.sort&&s.sort.label)||''
    ].join(' '));
    var residual = toks.filter(function(t){
      var sing = t.replace(/s$/, '');  // "hotels" → "hotel" so a consumed type noun matches its plural
      return consumed.indexOf(t) < 0 && consumed.indexOf(sing) < 0 && !RESIDUAL_STOP[t];
    });
    if (!residual.length) return { rows: rows };
    var phrase = residual.join(' ');
    function blob(p){ return norm((p.Title||'')+' '+(p.Neighborhood||'')+' '+(p.DescriptionLong||'')+' '+(p.Description||'')); }
    var byPhrase = rows.filter(function(p){ return blob(p).indexOf(phrase) >= 0; });
    var hit = byPhrase.length ? byPhrase
      : rows.filter(function(p){ var b=blob(p); return residual.every(function(t){ return b.indexOf(t)>=0; }); });
    if (!hit.length || hit.length === rows.length) return { rows: rows };
    var label = residual.map(function(w){ return w.charAt(0).toUpperCase()+w.slice(1); }).join(' ');
    return { rows: hit, label: label };
  }

  // Score each row by how many meaningful query tokens land in its
  // title, with extra weight for tokens that are NOT part of the project's
  // city name (a distinctive token like "viceroy" is stronger evidence
  // than the generic "fort"). If one row's distinctive-hit count strictly
  // dominates the runner-up, return it — the query is about that one
  // project, not the city set. Otherwise return null and let the smart
  // path render the full aggregate.
  function pickTitleScopedProject(q, rows){
    if (!rows || rows.length < 2) return null;
    var Core = window.TmwSearchCore;
    if (!Core || !Core.norm) return null;
    var toks = Core.filterMeaningfulTokens
      ? Core.filterMeaningfulTokens(tokenize(q))
      : tokenize(q).filter(function(t){ return t.length >= 3; });
    if (!toks.length) return null;
    var scored = rows.map(function(r){
      var t = Core.norm(r.Title || '');
      var cityN = Core.norm(r.City || '');
      var hits = 0, distinct = 0;
      toks.forEach(function(tk){
        if (t.indexOf(tk) >= 0) { hits++; if (cityN.indexOf(tk) < 0) distinct++; }
      });
      return { r:r, hits:hits, distinct:distinct };
    });
    scored.sort(function(a,b){ return (b.distinct - a.distinct) || (b.hits - a.hits); });
    var top = scored[0], next = scored[1];
    if (top.distinct >= 1 && top.distinct > next.distinct) return top.r;
    return null;
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
    // ICONIC blend. For a curation query ("best golf in california", "best
    // hotels in miami", "iconic restaurants"), pull the editorial iconic list
    // for the category, place-filtered. Restaurants aren't a project type, and
    // a place that isn't a tracked project place (California, Hawaii, Europe…)
    // means smartFilter couldn't narrow projects geographically — in both cases
    // suppress the project rows so we don't pad with off-place/global projects.
    // When the place IS a project place (e.g. Miami), keep the projects and blend.
    var iconicHits = s.iconic ? Core.iconicItems(ICONIC[s.iconic] || [], s.q) : [];
    if (s.iconic){
      // Blend development projects ONLY when the query names both a matching
      // project type (golf/hotel) AND a tracked project place (e.g. "best hotels
      // in miami" → Miami hotel projects). Otherwise the iconic list stands alone
      // — no place ("best hotels") would pull every hotel project; a non-project
      // place ("best golf in california", restaurants) has no projects to blend.
      var hasProjectPlace = s.cities.length || s.region || s.area;
      if (!s.types.size || !hasProjectPlace) rows = [];
    }
    // If the query strongly identifies ONE specific project in the result
    // set (e.g. "how many units does viceroy fort lauderdale have" picks
    // Viceroy out of 14 Fort Lauderdale projects), narrow to just that
    // project so the intel stats grid reflects IT — not the city aggregate.
    // Without this, the sentence (LLM-upgraded to the specific project)
    // and the "First delivery 2025" / "~7,144 residences total" stats grid
    // contradict each other.
    // Only scope to a single project when the query named a place to disambiguate
    // within (e.g. "viceroy fort lauderdale"). For a global type/status query like
    // "hotels opening around the world soon" a stray token ("world" → "Worldcenter")
    // must not collapse the whole set down to one project.
    // For iconic queries the quality cue ("best"/"good"/"iconic") is intent, not
    // a place qualifier — never let it collapse the project set to one row or
    // surface as an "Area" chip.
    var titleHit = ((s.cities.length || s.region) && !s.iconic) ? pickTitleScopedProject(q, rows) : null;
    if (titleHit) rows = [titleHit];
    // Narrow to a residual neighborhood/qualifier ("design district") the
    // structured parse ignored, and surface it as an "Area" chip. Skip
    // when we've already narrowed to one project by title.
    // Residual narrowing (e.g. "design district") only makes sense when the query
    // named a place to narrow WITHIN. For global type/status queries like "hotels
    // opening around the world soon", leftover words ("world") must not filter the
    // set down to the handful of projects that happen to mention them.
    if (!titleHit && (s.cities.length || s.region) && !s.iconic) {
      var resid = applyResidualText(q, s, rows);
      rows = resid.rows;
      if (resid.label) s._areaLabel = resid.label;
    }
    // Firm-in-place fallback: when the user asks about a developer/architect
    // in a specific city/region and we have ZERO matches, broaden to the firm
    // alone and surface what we DO have. e.g. "terra miami beach" → "no Terra
    // projects in Miami Beach, however 14 in Miami." Picks the most-common
    // city across the firm's portfolio as the "closest area."
    if (rows.length === 0 && s.firm && (s.cities.length || s.region)) {
      var sNoPlace = {};
      for (var k in s) if (s.hasOwnProperty(k)) sNoPlace[k] = s[k];
      sNoPlace.cities = []; sNoPlace.region = '';
      var altRows = Core.smartRank(Core.smartFilter(sNoPlace, PROJECTS), sNoPlace);
      if (altRows.length) {
        var cityCounts = {};
        altRows.forEach(function(p){
          var c = String(p.City || '').split(',')[0].trim();
          if (c) cityCounts[c] = (cityCounts[c] || 0) + 1;
        });
        var sortedCities = Object.keys(cityCounts).sort(function(a, b){
          return cityCounts[b] - cityCounts[a];
        });
        var dominantCity = sortedCities[0] || '';
        // Name the top city whenever it holds ≥ 25 % of the firm's tracked
        // footprint OR has the plurality of projects — matches the user's
        // expected "no X here, but N in <city>" copy pattern. A firm whose
        // top city is below 25 % is genuinely scattered → mention no city.
        var dominantShare = dominantCity ? cityCounts[dominantCity] / altRows.length : 0;
        s._firmCityFallback = {
          requestedPlace: s.cities[0] || s.region,
          altCount: altRows.length,
          altCity: dominantShare >= 0.25 ? dominantCity : '',
        };
        rows = altRows;
      }
    }
    var ans = Core.buildSmartAnswer(s, rows);
    // Iconic queries get an iconic-led sentence. The project LLM upgrade is
    // skipped for these (below), so this deterministic answer is what shows.
    if (iconicHits.length){
      ans.html = buildIconicAnswerHtml(s, iconicHits, rows);
      if (!rows.length) ans.stats = [];   // iconic-only → no project stats grid
    }
    // When the firm-in-place fallback fired, rewrite the synthesized sentence
    // so the user knows the result set is the firm's BROADER footprint, not a
    // hit on the place they actually asked about.
    if (s._firmCityFallback && s.firm) {
      var fb = s._firmCityFallback;
      var altLoc = fb.altCity ? ' in <b>' + esc(fb.altCity) + '</b>' : '';
      var n2 = fb.altCount;
      ans.html = 'No tracked <b>' + esc(s.firm.name) + '</b> developments in <b>'
        + esc(fb.requestedPlace) + '</b> — but <b>' + n2 + ' '
        + (n2 === 1 ? 'project' : 'projects') + '</b>' + altLoc
        + (n2 === 1 ? ' is' : ' are') + ' tracked elsewhere.';
    }

    // Will we call the LLM for this query? Only when there's material to write
    // about (project rows and/or iconic items) and it isn't the firm-fallback.
    // If not, the deterministic answer must show IMMEDIATELY (no spinning loader).
    var willFire = (rows.length || iconicHits.length) && !s._firmCityFallback;
    if (!willFire && !rows.length && !iconicHits.length && !s._firmCityFallback){
      // Zero results — answer the absence instantly ("not tracking any … yet").
      ans.html = buildNoResultsAnswer(s, q);
      ans.stats = [];
    }

    // Header slot carries the "understood as" chips
    var chipsHtml = renderUnderstoodChips(s);
    var panelHtml = renderSmartIntelPanel(ans, q, !willFire);
    slotIntel.innerHTML = chipsHtml + panelHtml;

    // Promote the top smart-filtered project to a hero card -- same rich
    // /search/-style layout the text-match path uses (timeline, specs,
    // byline, Learn more / Visit site CTAs). The smart rows section
    // below skips this hero so the same project doesn't render twice.
    // When there's only one match (e.g. "pine crest school"), the hero
    // IS the result -- the rows section gets hidden so we don't show
    // an awkward empty "0 projects" header.
    //
    // Hero picker: when a TYPE filter is active, scan rows in their
    // already-sorted order and prefer the FIRST one whose PreferredType
    // (the editor's PRIMARY type) actually matches the type filter --
    // not just its multi-tag ProjectType list. This is what keeps an
    // Altamira-by-Lennar (ProjectType="Residences, Golf",
    // PreferredType="Residences") from grabbing the "Top match" slot on
    // a "golf course openings" query even though it's the most recently
    // updated row. Falls back to rows[0] when no row's PreferredType
    // matches (e.g. every match is a mixed-use project) so we never
    // silently show NO hero.
    function pickHero(rs, sm) {
      if (!rs.length) return null;
      // When the user asked for a quantitative ranking ("tallest", "biggest",
      // "most units"), buildSmartAnswer has already sorted rs and the intel
      // panel will quote rs[0] as the headline answer. Promoting a different
      // row to the hero just because its PreferredType matches the type
      // filter desyncs the page (intel says one project, hero shows another).
      // So when sort is active, trust the order.
      if (sm && sm.sort && sm.sort.key) return rs[0];
      if (sm && sm.types && sm.types.size) {
        var typeList = [];
        sm.types.forEach(function (t) { typeList.push(String(t).toLowerCase()); });
        for (var i = 0; i < rs.length; i++) {
          var pt = String(rs[i].PreferredType || '').toLowerCase();
          for (var j = 0; j < typeList.length; j++) {
            if (pt.indexOf(typeList[j]) >= 0) return rs[i];
          }
        }
      }
      return rs[0];
    }
    var SMART_CAP = 40, ROW_PAGE = 10;
    var maxMetric = 1;
    if (s.sort && s.sort.key === 'floors') maxMetric = Math.max.apply(null, rows.map(Core.floorsOf).concat([1]));
    else if (s.sort && s.sort.key === 'units') maxMetric = Math.max.apply(null, rows.map(Core.unitsOf).concat([1]));
    // Render a paginated project-rows section (header + first ROW_PAGE rows +
    // the rest hidden behind a Load-more button). startRank = the first row's #.
    function renderRowsSection(rowsArr, headHtml, startRank, withCredit){
      if (!rowsArr.length) return '';
      var shownR = rowsArr.slice(0, SMART_CAP);
      var rowsH = shownR.map(function(p, i){
        var html = renderSmartRow(p, i + startRank, s, maxMetric);
        return i >= ROW_PAGE ? html.replace('class="tmw-ov-row ', 'class="tmw-ov-row tmw-ov-row-hidden ') : html;
      }).join('');
      var hc = Math.max(0, shownR.length - ROW_PAGE);
      var mb = hc > 0 ? '<button class="tmw-ov-loadmore" type="button" data-action="more-rows">Load '+Math.min(ROW_PAGE, hc)+' more</button>' : '';
      var ft = (rowsArr.length > SMART_CAP) ? '<div class="tmw-ov-smart-foot">Showing top '+SMART_CAP+' of '+rowsArr.length+' — refine your question to narrow it.</div>' : '';
      if (withCredit) ft += '<div class="tmw-ov-smart-foot"><span class="ai">TMW Intelligence</span> · answer synthesized from the project database · figures verified, not generated</div>';
      // Onyx Overview: a "see all N →" jumps to the full Projects tab (visible
      // only in Overview, where the rows are capped to 3; the in-section
      // "Load more" is hidden there).
      var saMore = rowsArr.length - 3;   // Overview shows the top 3; this is the rest
      var sa = (saMore > 0) ? '<button class="tmw-ov-seeall" type="button" data-goto="projects">'+saMore+' more projects <span aria-hidden="true">&rarr;</span></button>' : '';
      return '<div class="tmw-ov-sec" data-cat="projects">' + headHtml + '<div class="tmw-ov-rows">' + rowsH + '</div>' + sa + mb + ft + '</div>';
    }

    // ONE hero at a time. When the answer is iconic (the curated list), its top
    // pick IS the hero — DB projects (forthcoming golf in that place) drop to a
    // secondary "In development" rows section, never a competing hero card. When
    // there's no iconic list (a pipeline / "new golf courses" ask), the DB
    // project is the hero as before.
    if (iconicHits.length){
      slotHero.innerHTML = '';   // iconic pick (inside renderIconicSection) is the hero
      var devHead = '<div class="tmw-ov-smart-head"><h3>In development</h3>'
        + '<span class="sub">' + rows.length + ' tracked ' + (rows.length === 1 ? 'project' : 'projects') + '</span>'
        + '<button class="map-link" type="button" data-goto="projects">' + ICON_STAR + ' View all</button></div>';
      var devSection = renderRowsSection(rows, devHead, 1, false);
      slotRows.innerHTML = renderIconicSection(iconicHits, s, q) + devSection;
    } else {
      // No separate hero card — the #1 project is just the first row in the
      // ranked list (Onyx Overview reads as one message). No top header either;
      // the gray "N more projects" link at the bottom is the only count cue.
      slotHero.innerHTML = '';
      slotRows.innerHTML = renderRowsSection(rows, '', 1, true);
    }

    // Journal + filter pills via the shared renderer, so architect/city/status
    // queries (e.g. "kengo kuma") also surface journal entries — both from the
    // loaded set and the worker body-scan. "Intel" is always present (a smart
    // query always produces an answer); the Journal tab is always present too.
    _heroArticleRef = null; // structured hero is always a project
    // Iconic editorial picks count under Journal now (they're TMW curation, not
    // pipeline projects), so the "best hotels" ask lands on the Journal tab.
    _lastFilterCounts = { intel: true, projects: rows.length, firms: 0, iconicArticles: iconicHits.length };
    // Onyx 4.1 redesign: the smart path defaults to the answer-first OVERVIEW
    // too — the Intelligence answer + hero + the ranked rows (and a capped
    // taste of journal), with the counts bar to drill in. Previously pipeline
    // asks ("tallest towers") isolated the Projects tab and HID the answer,
    // which is exactly the firehose-vs-lead problem this redesign fixes. A
    // user who explicitly picked a lens last query still gets it via sticky.
    var defFilter = _stickyDefault('overview', { intel: true, projects: rows.length, firms: 0 });
    sResults.setAttribute('data-filter', defFilter);
    // Place-gate the journal to the queried state (drops a TX/FL golf piece on a
    // CA query). Only for an actual US state (stateCode set, or Florida).
    _qStateName = (s.stateCode || s.region === 'Florida') ? norm(s.region) : '';
    renderArticleSection(q, token, { suppressFallback: iconicHits.length > 0 });

    // LLM upgrade: replace the deterministic sentence with prose (stats stay).
    // Skip the upgrade when the firm-in-place fallback fired — the deterministic
    // sentence already explains the mismatch ("no Terra projects in Tampa, but
    // N in Miami"), and the LLM, seeing the requested place doesn't match the
    // returned rows, tends to produce a confused "tracked elsewhere" rewrite.
    // Fire the LLM whenever we have ANY material — project rows and/or iconic
    // items. For iconic queries the iconic picks (with their descriptions) are
    // fed in too, so the answer can name what's newly coming AND spotlight the
    // top iconic items. (buildIconicAnswerHtml stays as the offline fallback.)
    // Only fire the LLM when we DON'T already have a polished answer cached for
    // this query. A cached answer is already the final paragraph — re-firing
    // would render it, then swap it ~10s later for a near-identical one (the
    // confusing "answer, then a better answer" flash). No cache → the panel
    // shows the loader (never the deterministic draft) until the LLM lands once.
    if ((rows.length || iconicHits.length) && !s._firmCityFallback && !cachedAnswer(q)) fireSmartIntelUpgrade(q, s, rows, iconicHits);

    // Count this query against the user's free quota (window.tmwIntel.FREE)
    try {
      if (!_replaying && window.tmwIntel && window.tmwIntel.count) window.tmwIntel.count(q);
      if (!_replaying && window.tmwIntel && window.tmwIntel.track) window.tmwIntel.track(q, { results: rows.length, sort: s.sort ? s.sort.label : null, source: 'overlay' });
    } catch(_){}

    _lastResultsTotal = rows.length + iconicHits.length;
    _lastResultKind = 'smart';
    setState('results');
  }

  // Debounced LLM rewrite of the structured-smart sentence. Same 700ms
  // settle as /search/. Stale-token guarded so a late response for
  // query N doesn't paint over query N+1.
  function fireSmartIntelUpgrade(q, s, rows, iconicHits){
    var Core = window.TmwSearchCore;
    if (!Core) return;
    var facts = Core.buildSmartFacts(s, rows, iconicHits);
    var hist = _isFollowupQ(q) ? threadHistory() : [];       // context only for real follow-ups
    var _intelSlot = slotIntel;                              // capture THIS turn's slot (it moves per turn)
    var _turnRec = _thread.length ? _thread[_thread.length - 1] : null;
    var myToken = ++_intelToken;
    clearTimeout(_intelDebounce);
    _intelDebounce = setTimeout(function(){
      if (myToken !== _intelToken) return;
      function setLive(){ var t = _intelSlot.closest && _intelSlot.closest('.tmw-ov-turn'); var l = (t && t.querySelector('.live')) || _intelSlot.querySelector('.tmw-ov-intel-h .live'); if (l) l.innerHTML = '<i></i>Live answer'; }
      function fallback(){
        var ansEl = _intelSlot.querySelector('.tmw-ov-intel-ans');
        if (ansEl && ansEl.classList.contains('loading')) { ansEl.innerHTML = ansEl.getAttribute('data-fallback') || ''; ansEl.classList.remove('loading'); setLive(); }
      }
      // Render into the CAPTURED slot (not the live `slotIntel`, which may have
      // advanced to a newer turn) so the answer lands on its own message.
      Core.askIntelligence(q, facts, hist).then(function(res){
        var ansEl = _intelSlot.querySelector('.tmw-ov-intel-ans');
        if (!ansEl) return;
        if (res && res.ok && res.answer){
          ansEl.textContent = res.answer; ansEl.classList.remove('loading'); setLive();
          cacheAnswer(q, res.answer);                        // remember for instant resume
          if (_turnRec) _turnRec.answer = res.answer;        // feed the next follow-up's context
        } else {
          fallback();                                        // LLM unreachable → deterministic sentence
        }
      }).catch(fallback);
    }, 160);
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
  // Confidence floor: a project that matches ONLY via a single description
  // mention scores +2 (see scoreProject). That tier is noise — "Lady Bird Lake"
  // surfacing for "palm beach gardens" because its blurb happens to contain a
  // shared token. Require a hit on a real field (title/city/neighborhood/type/
  // firm = 5+) so weak description-only matches never reach the grid, the hero,
  // or the Intelligence context. When nothing clears the bar the overlay falls
  // through to its honest empty state instead of padding with noise.
  var MIN_PROJECT_SCORE = 3;
  var MAX_FIRMS  = 6;
  var MAX_CITIES = 6;

  // ── Server-side body search ───────────────────────────────────────
  // The overlay loads only article summaries (title/excerpt/categories/tags),
  // so a term that lives only in an article BODY (e.g. "miami design district")
  // would never match client-side. For each settled query we ask the worker to
  // scan post bodies (/posts?q=…, which now searches body_html) and merge any
  // new hits into ARTICLES, then re-render — without re-firing Intelligence.
  var _bodyMatchFor = null;
  // Counts/state shared with the article-section renderer so it can (re)build
  // the filter-pill row (incl. the live Journal count) for whichever path —
  // text-match or structured-smart — produced the projects/firms/intel counts.
  var _lastFilterCounts = { intel: false, projects: 0, firms: 0 };
  var _heroArticleRef = null; // article promoted to hero (text path), excluded from the journal list
  function fetchBodyMatches(q, stoks, token){
    _bodyMatchFor = q; // mark up front so we fire at most once per query
    var terms = stoks.filter(function(t){ return t.length >= 4; });
    if (!terms.length) return;

    // Build the set of alt queries: the original PLUS one variant per
    // synonym-eligible token, swapping just that token for each of its
    // synonyms. Cap to keep traffic + merge cost reasonable. "miami condos"
    // becomes ["miami condos", "miami residences", "miami condominium",
    // "miami tower", "miami penthouse"], catching newer copy that doesn't
    // literally use the word "condos".
    var altQueries = [stoks.join(' ')];
    var seenQ = {}; seenQ[altQueries[0]] = 1;
    for (var i = 0; i < stoks.length && altQueries.length < 6; i++) {
      var t = stoks[i];
      var variants = TOKEN_SYNONYM_INDEX[t];
      if (!variants) continue;
      for (var v = 0; v < variants.length && altQueries.length < 6; v++) {
        var alt = variants[v];
        if (alt === t) continue;
        var copy = stoks.slice(); copy[i] = alt;
        var key = copy.join(' ');
        if (seenQ[key]) continue;
        seenQ[key] = 1;
        altQueries.push(key);
      }
    }

    Promise.all(altQueries.map(function(qs){
      return fetch(WORKER_URL + '/posts?status=published&limit=25&q=' + encodeURIComponent(qs), { cache:'no-store' })
        .then(function(r){ return r.ok ? r.json() : null; })
        .catch(function(){ return null; });
    })).then(function(results){
      if (token !== _renderToken) return; // user moved on
      var seen = {};
      ARTICLES.forEach(function(a){ var k = a.slug || a.id; if (k) seen[k] = 1; });
      var added = 0;
      results.forEach(function(d){
        var items = (d && Array.isArray(d.items)) ? d.items : [];
        items.forEach(function(a){
          var k = a.slug || a.id;
          if (k && !seen[k]){ seen[k] = 1; ARTICLES.push(a); added++; }
        });
      });
      if (added) renderArticleSection(q, token, { fromBodyMerge: true });
    });
  }

  function runTextMatch(q, token, opts){
    opts = opts || {};
    if (token !== _renderToken) return;
    var Core = window.TmwSearchCore;

    var full = norm(q);
    var toks = tokenize(q);
    // Scoring tokens: the meaningful tokens only (drop 1-char noise AND generic
    // stopwords like "the"/"tell"/"about"). Two reasons:
    //  · "Fouquet's" → ["fouquet","s"]: the stray "s" used to substring-match
    //    nearly every record and inflate results to the whole catalog ("436").
    //  · Natural-language questions — "tell me about Olara" → ["tell","me",
    //    "about","olara"] — would otherwise let "tell"/"about" pollute the grid
    //    with every project whose description happens to contain those words.
    // Falls back to the length filter if stripping leaves nothing (e.g. a query
    // that is purely short/stopwords). Hero eligibility still uses raw `toks`.
    var stoks = (Core && Core.filterMeaningfulTokens) ? Core.filterMeaningfulTokens(toks)
                                                      : toks.filter(function(t){ return t.length >= 3; });
    if (!stoks.length) stoks = toks.filter(function(t){ return t.length >= 2; });
    // (The worker body-scan + journal rendering are handled by
    // renderArticleSection at the tail of this function.)
    // Use the shared isQuestion so /search/ and the overlay always agree
    // on what counts as a question (the local fallback runs only during
    // the brief window before journal-search-core.js finishes loading).
    var question = (Core ? Core.isQuestion : isQuestion)(q);

    _qPlaceTokens = null; _qPlaceMatch = null; _qStateName = '';   // reset place-aware article matching per query
    var pScored = PROJECTS.map(function(p){ return { p:p, s:scoreProject(p, stoks, full) }; })
                          .filter(function(x){ return x.s >= MIN_PROJECT_SCORE; })
                          .sort(function(a,b){ return b.s - a.s; });
    var fScored = FIRMS.map(function(f){ return { f:f, s:scoreFirm(f, stoks, full) }; })
                       .filter(function(x){ return x.s > 0; })
                       .sort(function(a,b){ return b.s - a.s; });
    var aScored = ARTICLES.map(function(a){ return { a:a, s:scoreArticle(a, stoks, full) }; })
                          .filter(function(x){ return x.s > 0; })
                          .sort(function(a,b){ return b.s - a.s; });
    // Cities aren't a separate index — derive from projects on first use
    // per session. Same pattern as /search/.
    if (!PROJECTS._tmwOvCities) PROJECTS._tmwOvCities = deriveCitiesFromProjects(PROJECTS);
    var cScored = PROJECTS._tmwOvCities.map(function(c){ return { c:c, s:scoreCity(c, stoks, full) }; })
                                       .filter(function(x){ return x.s > 0; })
                                       .sort(function(a,b){ return b.s - a.s; });

    var totalHits = pScored.length + fScored.length + aScored.length;
    // SEMANTIC RESCUE seed: this is a re-invoke carrying projects/articles the
    // keyword pass missed (only happens when the first pass found NOTHING). Seed
    // the scored lists so the normal render path runs with relevant candidates.
    if (opts.rescueProjects && opts.rescueProjects.length) {
      pScored = opts.rescueProjects.map(function (p, i) { return { p: p, s: opts.rescueProjects.length - i }; });
      if (opts.rescueArticles && opts.rescueArticles.length) {
        aScored = opts.rescueArticles.map(function (a, i) { return { a: a, s: opts.rescueArticles.length - i }; });
      }
      totalHits = pScored.length + fScored.length + aScored.length;
    }

    // STRONG LITERAL PROJECT-NAME MATCH? When the user typed the full
    // name (or a substantial substring) of a tracked project, treat
    // that project as the "anchor" and surface its connected siblings
    // -- same developer in the same city PLUS any project whose
    // description literally mentions the anchor's title or developer.
    // This is what turns a "oracle campus" query into "Oracle Campus
    // + Oracle Pedestrian Bridge + Nobu Hotel Nashville (description
    // mentions 'Oracle campus')". Then Intelligence is fired with the
    // anchor + connected so the LLM can write the East-Bank-style
    // synthesis the user asked for.
    // A bare place query ("palm beach gardens") is a PLACE search, not a
    // project-name anchor: the user wants projects IN that place, not the
    // "connected siblings" of a project whose title merely contains the city
    // name. Detect it up front so we can skip the anchor mechanism — otherwise
    // a same-developer/description-linked project two states away (e.g. an
    // Austin tower) leaks into the grid via the connected-siblings injection.
    // The Intelligence answer is unaffected: it runs off `cityHit` separately.
    var cityQuery = detectCityQuery(q);
    var foodIntent = isFoodQuery(q);   // dining = journal coverage, not projects
    var areaHit = (Core && Core.detectArea) ? Core.detectArea(q, PROJECTS) : null; // county/metro → many cities

    // ── Bulletproof place override ──────────────────────────────────
    // If the query names a place at ANY level — neighborhood (Midtown,
    // Brickell), city (Naples), borough (Manhattan), county (Collier County),
    // metro/nickname (Southwest Florida, SWFL), or state (Florida) — drive the
    // PROJECT set from the FULL list of projects in that place, ranked by the
    // status spine (Featured → Coming Soon → Recently Opened → Under
    // Construction → Breaking Ground → Announced). This is what makes
    // "manhattan" return all 24 instead of the 1 that literally contains the
    // word, and what keeps the hero + grid + Intelligence answer in one order.
    var placeHit = (Core && Core.resolvePlace && !foodIntent) ? Core.resolvePlace(q, PROJECTS) : null;
    var placeDriven = false, placeName = null;
    if (placeHit) {
      // Not when the whole query is literally a tracked project's name — the
      // anchor path below owns "Oracle Campus"-style lookups.
      var _literal = false;
      if (full.length >= 4) for (var _li = 0; _li < PROJECTS.length; _li++) {
        if (norm(PROJECTS[_li].Title || '').indexOf(full) >= 0) { _literal = true; break; }
      }
      // Not when a real firm name dominates the query (e.g. "Allen Morris"): a
      // strong firm match outranks an incidental place token.
      var _firmDom = fScored.length && fScored[0].s >= 6 && pScored.length < 3;
      var _sq = Core.parseSmartQuery ? Core.parseSmartQuery(q, { projects: PROJECTS, firms: [] }) : null;
      // Not for a firm-RANKING ask ("most active developer in Miami") — that
      // answer is a firm leaderboard; let the existing city/firm path own it.
      var _firmRank = _sq && _sq.firmRank;
      if (!_literal && !_firmDom && !_firmRank) {
        var _rows = PROJECTS.filter(placeHit.match);
        // refine by type / status when the query named them
        if (_sq && _sq.types && _sq.types.size) {
          _rows = _rows.filter(function (p) {
            var pt = norm((p.PreferredType || '') + ' ' + (p.ProjectType || '')), ok = false;
            _sq.types.forEach(function (t) { if (pt.indexOf(norm(t)) >= 0) ok = true; });
            return ok;
          });
        }
        if (_sq && _sq.statuses && _sq.statuses.size) {
          _rows = _rows.filter(function (p) { return _sq.statuses.has(String(p.Delivery || '').trim()); });
        }
        if (_rows.length) {
          Core.rankByStatus(_rows, {});
          // descending synthetic scores preserve spine order through later sorts
          pScored = _rows.map(function (p, i) { return { p: p, s: (_rows.length - i) }; });
          placeDriven = true;
          placeName = placeHit.name;
          // make article matching place-aware: an article in this place (by
          // category or linked project) surfaces even without a text hit. Use
          // the full ancestor token stack of a representative project here.
          if (Core.placeTokensOf) { _qPlaceTokens = Core.placeTokensOf(_rows[0]); _qPlaceMatch = placeHit.match; }
          aScored = ARTICLES.map(function(a){ return { a:a, s:scoreArticle(a, stoks, full) }; })
                            .filter(function(x){ return x.s > 0; })
                            .sort(function(a,b){ return b.s - a.s; });
          totalHits = pScored.length + fScored.length + aScored.length;
        }
      }
    }

    // ── Global "biggest / largest" fallback ─────────────────────────
    // "biggest projects globally", "largest developments in the world" — a
    // superlative with NO place named used to return nothing. Rank EVERY project
    // by size (acreage/sq-ft parsed from the description, else units/floors), so
    // the giant mixed-use districts surface. Only fires when nothing else
    // resolved (no place, no firm, no literal project name).
    if (!placeDriven && Core && Core.sizeScoreOf) {
      var _superl = /\b(biggest|largest|grandest|most massive|mega)\b/.test(full);
      var _global = /\b(global|globally|world|worldwide|anywhere|on earth|ever)\b/.test(full) || !(areaHit || cityQuery);
      var _firmStrong = fScored.length && fScored[0].s >= 6;
      if (_superl && _global && !_firmStrong && PROJECTS.length) {
        var _sq2 = Core.parseSmartQuery ? Core.parseSmartQuery(q, { projects: PROJECTS, firms: [] }) : null;
        var _big = PROJECTS.slice();
        if (_sq2 && _sq2.types && _sq2.types.size) {
          _big = _big.filter(function (p) {
            var pt = norm((p.PreferredType || '') + ' ' + (p.ProjectType || '')), ok = false;
            _sq2.types.forEach(function (t) { if (pt.indexOf(norm(t)) >= 0) ok = true; });
            return ok;
          });
        }
        _big.sort(function (a, b) { return Core.sizeScoreOf(b) - Core.sizeScoreOf(a); });
        _big = _big.slice(0, 60);
        if (_big.length) {
          pScored = _big.map(function (p, i) { return { p: p, s: (_big.length - i) }; });
          placeDriven = true;
          placeName = null;   // not a geography — the query tells the LLM it's a "biggest" ask
          totalHits = pScored.length + fScored.length + aScored.length;
        }
      }
    }

    var strongAnchor = null;
    var connectedProjects = [];
    if (pScored.length && full.length >= 4 && !cityQuery) {
      var topTitle = norm(pScored[0].p.Title || '');
      if (topTitle.indexOf(full) >= 0) {
        strongAnchor = pScored[0].p;
        var anchorTitle = norm(strongAnchor.Title || '');
        var anchorCity  = norm(strongAnchor.City  || '');
        var anchorDevTokens = (strongAnchor.Developer || '').toLowerCase()
          .split(/[,\s/&]+/).filter(function(t){ return t.length > 3; });
        // Distinctive brand/district tokens of the anchor's name, dropping the
        // generic structure suffix ("Nora House" -> ["nora"]). These connect
        // same-place SIBLINGS that share the name but NOT the developer — e.g.
        // "Nora House" -> "The Nora Hotel", "The Nora District". Without this
        // the LLM only ever heard the one developer's projects and missed the
        // district's soonest-opening building entirely.
        var GENERIC_NAME = { house:1,hotel:1,hotels:1,tower:1,towers:1,residence:1,residences:1,
          apartment:1,apartments:1,condo:1,condos:1,district:1,districts:1,villa:1,villas:1,
          loft:1,lofts:1,suite:1,suites:1,club:1,resort:1,resorts:1,place:1,park:1,plaza:1,
          center:1,centre:1,collection:1,phase:1,the:1,at:1,on:1,of:1,and:1 };
        var anchorNameTokens = anchorTitle.split(/[^a-z0-9]+/)
          .filter(function(t){ return t.length >= 4 && !GENERIC_NAME[t]; });
        var seen = {}; seen[strongAnchor.Title] = true;
        // Rough great-circle distance (miles) from the anchor, used to weed out
        // cross-metro "siblings". A degree of latitude is ~69 mi; longitude
        // shrinks with latitude (~60 mi near 27°N). Exact enough to tell a
        // same-metro sibling from a different-state coincidence.
        var aLat = parseFloat(strongAnchor.Latitude), aLng = parseFloat(strongAnchor.Longitude);
        function milesFromAnchor(p) {
          var la = parseFloat(p.Latitude), ln = parseFloat(p.Longitude);
          if (isNaN(aLat) || isNaN(aLng) || isNaN(la) || isNaN(ln)) return null;
          var dLat = (la - aLat) * 69, dLng = (ln - aLng) * 60;
          return Math.sqrt(dLat * dLat + dLng * dLng);
        }
        var scored = [];
        PROJECTS.forEach(function (p) {
          if (seen[p.Title]) return;
          var sc = 0, strong = false;
          var pDev  = (p.Developer || '').toLowerCase();
          var pCity = norm(p.City || '');
          var pTitle = norm(p.Title || '');
          var pDesc = norm(firstField(p, ['DescriptionLong','Description']));
          // Same place + shared distinctive name token = district sibling. Rank
          // it ABOVE same-developer so the named district always leads.
          if (anchorNameTokens.length && pCity === anchorCity &&
              anchorNameTokens.some(function (t) { return fieldHit(pTitle, t); })) { sc += 35; strong = true; }
          if (anchorDevTokens.length && pCity === anchorCity &&
              anchorDevTokens.some(function (t) { return pDev.indexOf(t) >= 0; })) { sc += 30; strong = true; }
          // Description names the anchor outright — an explicit, real connection.
          if (anchorTitle.length >= 6 && pDesc.indexOf(anchorTitle) >= 0) { sc += 20; strong = true; }
          // Weak signal: the description merely mentions a developer token. On
          // its own this is the rule that used to leak cross-country matches.
          if (anchorDevTokens.length &&
              anchorDevTokens.some(function (t) { return pDesc.indexOf(t) >= 0; })) sc += 8;
          if (sc > 0) {
            var mi = milesFromAnchor(p);
            if (mi != null && mi > 100) {
              // Different metro: a weak-only link (a shared developer mentioned
              // in the description) isn't a real sibling — drop it. A strong link
              // (same-place, or an explicit name-drop) survives but is heavily
              // down-weighted so it can never lead the connected set.
              if (!strong) return;
              sc = Math.max(1, Math.round(sc * 0.2));
            }
            scored.push({ p: p, s: sc });
          }
        });
        scored.sort(function(a,b){ return b.s - a.s; });
        connectedProjects = scored.slice(0, 4).map(function (x) { return x.p; });
      }
    }

    // ── Intelligence panel (inline LLM answer) ──────────────────────
    // Decide before paint so the panel slot is correct from the first
    // frame -- prevents a flash of a hero-only layout that then jumps
    // when the LLM loading shell appears above it.
    // Skip all Intelligence painting on the body-merge re-render — the panel
    // is already loading/answered for this query; re-touching it would flicker
    // and double-count the quota.
    if (!opts.fromBodyMerge) {
      var allowed = !window.tmwIntel || (typeof window.tmwIntel.allowed === 'function' && window.tmwIntel.allowed(q));
      // Fire Intelligence either when the query is phrased as a question
      // OR when we found a strong project-name anchor with at least one
      // connected sibling (so the LLM has real cross-project context to
      // synthesize -- a single isolated project becomes the existing
      // hero card and doesn't need a synthesized sentence).
      var cityHit = cityQuery;
      // GUARDRAIL: a county/parish/borough named but uncovered (and it isn't a
      // city/region/firm we know either) → answer honestly instead of dumping
      // unrelated results.
      var coverMiss = (Core && Core.coverageMiss) ? Core.coverageMiss(q, PROJECTS) : null;
      var honestMiss = coverMiss && !areaHit && !cityHit && !strongAnchor;
      var trigger = question || cityHit || foodIntent || areaHit || placeDriven || honestMiss || (strongAnchor && connectedProjects.length > 0);
      if (trigger){
        if (!allowed){
          slotIntel.innerHTML = intelGateHtml();
        } else if (honestMiss){
          slotIntel.innerHTML = intelPanelHtml('answer', q,
            'We don’t track development' + (foodIntent ? ' or dining' : '') + ' in ' + coverMiss +
            ' yet — it’s outside our current coverage. Try a market we follow, like Miami, Nashville, Austin or Charleston.');
        } else if (Core && totalHits > 0){
          slotIntel.innerHTML = intelLoadingHtml(q);
          // For an anchor query, the projects we feed Intelligence are
          // the anchor + connected ones (dedup'd, capped at 5). For a
          // regular question we use the top-scored as before.
          var intelProjects, intelPlace = null;
          if (foodIntent) {
            // Dining is journal coverage, not a project type — answer from our
            // Food & Drink articles (we post a lot), never the project pipeline.
            // Pull coverage for the PLACE comprehensively (every food article that
            // mentions the city — not just ones matching the exact query tokens),
            // newest first. A county fans out across all its cities.
            var placeTerms = [], foodPlace = null;
            if (areaHit) {
              foodPlace = areaHit.name;
              placeAliasTerms(areaHit.name).forEach(function(t){ placeTerms.push(t); });
              (Core.citiesInArea ? Core.citiesInArea(areaHit, PROJECTS) : []).forEach(function(c){
                placeAliasTerms(c).forEach(function(t){ if (placeTerms.indexOf(t) < 0) placeTerms.push(t); });
              });
            } else {
              var fc = cityHit || (cScored.length ? cScored[0].c.name : null);
              if (fc) { foodPlace = fc; placeTerms = placeAliasTerms(fc); }
            }
            if (foodPlace) foodPlace = nycPlace(foodPlace);
            var foodArts = [];
            if (placeTerms.length) {
              foodArts = ARTICLES.filter(isFoodArticle).filter(function(a){
                var hay = norm((a.title||'') + ' ' + (a.excerpt||'') + ' ' + (a.categories||[]).join(' '));
                for (var i = 0; i < placeTerms.length; i++){ if (placeTerms[i] && hay.indexOf(placeTerms[i]) >= 0) return true; }
                return false;
              }).sort(function(a,b){ return String(b.published_iso||'').localeCompare(String(a.published_iso||'')); });
            }
            if (!foodArts.length) {
              // No place (or nothing matched) → fall back to the query-scored
              // food articles so we still answer from the journal, never projects.
              foodArts = aScored.map(function(x){ return x.a; }).filter(isFoodArticle);
              if (!foodArts.length) foodArts = aScored.map(function(x){ return x.a; });
            }
            fireIntelligence(q, [], foodArts.slice(0, 12), foodPlace, 'food & drink', token, placeTerms);
            intelProjects = null; // handled above
          } else if (placeDriven) {
            // Place query at any level → the LLM leads with the SAME spine-ranked
            // set the grid + hero show (pScored is already the place set, ranked).
            // Top of the list first so the prose opens on the hero (Nora, etc.).
            intelProjects = pScored.slice(0, 8).map(function(x){ return x.p; });
            intelPlace = placeName;
          } else if (areaHit) {
            // County/metro project overview — every project inside the bbox.
            intelProjects = Core.inArea ? PROJECTS.filter(function(p){ return Core.inArea(p, areaHit); }) : [];
            intelPlace = areaHit.name;
          } else if (cityHit) {
            // Bare city query → city OVERVIEW: feed the whole city set so the
            // answer covers the pipeline (count, dominant type, soonest opening,
            // transformational anchors) — not just a coincidentally-named match.
            intelProjects = PROJECTS.filter(inCity(cityHit));
            intelPlace = cityHit;
          } else if (strongAnchor) {
            intelProjects = [strongAnchor];
            var seenT = {}; seenT[strongAnchor.Title] = true;
            connectedProjects.forEach(function (p) {
              if (!seenT[p.Title]) { intelProjects.push(p); seenT[p.Title] = true; }
            });
            intelProjects = intelProjects.slice(0, 5);
          } else {
            intelProjects = pScored.slice(0, 5).map(function(x){ return x.p; });
          }
          // Food queries already fired (journal facts) inside the branch above.
          if (!foodIntent) {
            fireIntelligence(q, intelProjects, aScored.slice(0,3).map(function(x){ return x.a; }), nycPlace(intelPlace), null, token);
          }
        } else if (Core){
          slotIntel.innerHTML = intelLoadingHtml(q);
          fireIntelligence(q, [], [], null, null, token);
        } else {
          slotIntel.innerHTML = renderIntelCTA(q);
        }
      } else {
        slotIntel.innerHTML = '';
      }
    }

    // Clear smart-rows slot (it's only populated by parseSmartQuery path)
    slotRows.innerHTML = '';

    // Empty state: not a question, nothing matched, nothing to show.
    if (!totalHits && !question){
      var showEmptyState = function(){
        slotHero.innerHTML = '';
        slotProjGrid.innerHTML = '';
        slotEntities.innerHTML = '';
        slotArticles.innerHTML = '';
        slotFilterPills.innerHTML = '';
        sResults.removeAttribute('data-filter');
        _lastResultsTotal = 0;
        _lastResultKind = 'empty';
        // Log the zero-result query — the single most valuable coverage signal
        // (feeds the worker's /search-gaps no_results bucket).
        try {
          if (!_replaying && window.tmwIntel && window.tmwIntel.trackSearch) {
            window.tmwIntel.trackSearch(q, { source: 'overlay', results: 0 });
          }
        } catch(_){}
        setState('empty');
      };
      // SEMANTIC RESCUE: keyword search dead-ended — fall back to meaning-based
      // retrieval over the whole corpus before showing "nothing matched". Maps
      // the returned slugs to real project/article objects and re-renders through
      // the normal path. Purely additive: only fires when keyword found nothing.
      if (!opts._rescued && Core && Core.semanticSearch){
        Core.semanticSearch(q).then(function(sem){
          if (token !== _renderToken) return;
          var pBy = {}; PROJECTS.forEach(function(p){ var s = p.Slug || p.slug; if (s) pBy[s] = p; });
          var aBy = {}; ARTICLES.forEach(function(a){ var s = a.slug || a.Slug; if (s) aBy[s] = a; });
          var rp = (sem.projects || []).map(function(s){ return pBy[s]; }).filter(Boolean).slice(0, 18);
          var ra = (sem.articles || []).map(function(s){ return aBy[s]; }).filter(Boolean).slice(0, 12);
          if (rp.length || ra.length) runTextMatch(q, token, { rescueProjects: rp, rescueArticles: ra, _rescued: true });
          else showEmptyState();
        }).catch(showEmptyState);
        return;
      }
      showEmptyState();
      return;
    }
    if (!totalHits){
      // Question with no DB hits — Intelligence panel above is the answer.
      // Still run the journal search (incl. worker body-scan) so a matching
      // article surfaces, and expose the always-on Journal tab + fallback.
      slotHero.innerHTML = '';
      slotProjGrid.innerHTML = '';
      slotEntities.innerHTML = '';
      _heroArticleRef = null;
      _lastFilterCounts = { intel: question, projects: 0, firms: 0 };
      // No DB hits — the Intelligence answer is the response, so lead with it
      // (unless the user has a sticky lens that's available here).
      sResults.setAttribute('data-filter', _stickyDefault(question ? 'intel' : 'articles', _lastFilterCounts));
      renderArticleSection(q, token);
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
    // Food queries lead with a Food & Drink article, never a project.
    // Place-driven: pScored[0] IS the spine hero (Nora, South Flagler…) — push it
    // unconditionally with a strong bias so the place's leader takes the hero slot.
    if (!foodIntent && placeDriven && pScored.length) heroCandidates.push({ kind:'project', s: 1e5, item: pScored[0].p });
    else if (!foodIntent && pScored.length && heroProjectEligible(pScored[0].p, full, toks)) heroCandidates.push({ kind:'project', s: pScored[0].s * 1.05, item: pScored[0].p });
    if (aScored.length) {
      var heroArt = aScored[0].a;
      if (foodIntent) { var fa = aScored.filter(function(x){ return isFoodArticle(x.a); })[0]; if (fa) heroArt = fa.a; }
      if (foodIntent || heroArticleEligible(aScored[0].a, full, toks)) {
        heroCandidates.push({ kind:'article', s: foodIntent ? 1e6 : aScored[0].s, item: heroArt });
      }
    }
    if (fScored.length && heroFirmEligible(fScored[0].f, full))          heroCandidates.push({ kind:'firm',    s: fScored[0].s,        item: fScored[0].f });
    heroCandidates.sort(function(a,b){ return b.s - a.s; });
    var hero = heroCandidates[0] || null;
    if (hero){
      var heroHtml = '';
      var heroCat = 'projects';
      if      (hero.kind === 'project') { heroProject = hero.item; heroHtml = renderProjectHero(heroProject); heroCat = 'projects'; }
      else if (hero.kind === 'article') { heroArticle = hero.item; heroHtml = renderArticleHero(heroArticle); heroCat = 'articles'; }
      else if (hero.kind === 'firm')    { heroFirm    = hero.item; heroHtml = renderFirmHero(heroFirm);       heroCat = 'firms'; }
      slotHero.innerHTML = '<div class="tmw-ov-sec" data-cat="'+heroCat+'">' + heroHtml + '</div>';
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
    if (meaningful.length >= 2 && !placeDriven) {
      // Expanded strict filter: check the FULL haystack (title + city +
      // developer + architect), not just the title. Previously "projects
      // in west palm" (meaningful tokens "west" + "palm") matched only
      // projects with both words in their title -- so a query for WPB
      // projects pulled ~7 results instead of all 50+ projects actually
      // in West Palm Beach (most have "west palm beach" in their City
      // field, not their title). The expanded haystack catches those
      // too. Currie Park / Salt Lake City / etc. still filter correctly
      // because the all-tokens-required rule is preserved -- we just
      // check more places for each token.
      restProjects = restProjects.filter(function(x){
        var hay = norm(x.p.Title) + ' | ' + norm(x.p.City || '') + ' | '
                + norm(x.p.Developer || '') + ' | ' + norm(x.p.Architect || '');
        if (full && hay.indexOf(full) >= 0) return true;
        return meaningful.every(function(tok){ return hay.indexOf(tok) >= 0; });
      });
    }
    // When a strong anchor + connected siblings were detected upstream,
    // inject them into the grid AFTER the strict filter -- they came in
    // via the description / same-developer signals that the title-based
    // strict filter rejects (e.g. "oracle campus" anchor pulls in Nobu
    // Hotel Nashville because its description mentions Oracle campus,
    // even though Nobu's title contains neither "oracle" nor "campus").
    // Dedup against the hero and already-listed restProjects.
    if (strongAnchor && connectedProjects.length) {
      var alreadyIn = {};
      if (heroProject) alreadyIn[heroProject.Title] = true;
      restProjects.forEach(function (x) { alreadyIn[x.p.Title] = true; });
      connectedProjects.forEach(function (p) {
        if (!alreadyIn[p.Title]) {
          restProjects.push({ p: p, s: 0.5 }); // tiny synthetic score so they sort after real hits
          alreadyIn[p.Title] = true;
        }
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
        + '<div class="tmw-ov-sec" data-cat="projects">'
        +   '<div class="tmw-ov-sec-head"><h3>Projects</h3><span class="count">'+restProjects.length+(heroProject?' more':' total')+'</span></div>'
        +   '<div class="tmw-ov-grid">' + gridProjects.map(renderProjectCard).join('') + '</div>'
        +   (restProjects.length > 3 ? '<button class="tmw-ov-seeall" type="button" data-goto="projects">See all '+restProjects.length+' projects <span aria-hidden="true">&rarr;</span></button>' : '')
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
      // Firms: check name + HQ so "miami firms" catches studios with hq in
      // Miami even when the firm name doesn't include "miami".
      restFirms = restFirms.filter(function(x){
        var hay = norm(x.f.name) + ' | ' + norm(x.f.hq || '');
        if (full && hay.indexOf(full) >= 0) return true;
        return meaningful.every(function(tok){ return hay.indexOf(tok) >= 0; });
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
        + '<div class="tmw-ov-sec" data-cat="firms">'
        +   '<div class="tmw-ov-sec-head"><h3>Firms &amp; places</h3><span class="count">'+(restFirms.length + restCities.length)+' total</span></div>'
        +   '<div class="tmw-ov-chiprow">'+entityHtml+'</div>'
        +   ((restFirms.length + restCities.length) > 6 ? '<button class="tmw-ov-seeall" type="button" data-goto="firms">See all '+(restFirms.length + restCities.length)+' firms &amp; places <span aria-hidden="true">&rarr;</span></button>' : '')
        + '</div>';
    } else {
      slotEntities.innerHTML = '';
    }

    // ── SAFETY NET: never paint a blank results view ────────────────
    // totalHits (above) is counted from the UNFILTERED scored lists, but the
    // visible slots are populated from lists that get filtered down later
    // (e.g. the meaningful-token filter drops firms/cities lacking every
    // query token). So a query like "shoma bay" can weakly hit the developer
    // "Shoma Group" → totalHits>0 → 'results' state — yet "bay" isn't in
    // "Shoma Group", the firm gets filtered out, and every slot ends up empty:
    // a black screen. If, after the synchronous render, NOTHING landed in any
    // visible slot and there are no article matches, divert to the helpful
    // empty state ("Nothing matched…"). Questions are exempt — their
    // Intelligence answer renders on its own async path.
    var _renderedSomething = heroProject || heroFirm || heroArticle
      || restProjects.length || restFirms.length || restCities.length || aScored.length;
    if (!_renderedSomething && !question) {
      slotHero.innerHTML = ''; slotProjGrid.innerHTML = ''; slotEntities.innerHTML = '';
      slotArticles.innerHTML = ''; slotFilterPills.innerHTML = '';
      sResults.removeAttribute('data-filter');
      _lastResultsTotal = 0;
      _lastResultKind = 'empty';
      try {
        if (!_replaying && window.tmwIntel && window.tmwIntel.trackSearch) {
          window.tmwIntel.trackSearch(q, { source: 'overlay', results: 0 });
        }
      } catch (_) {}
      setState('empty');
      return;
    }

    // ── Journal + filter pills (shared renderer) ────────────────────
    // renderArticleSection scores ARTICLES, paints the journal section (matches
    // or the latest-stories browse fallback), fires the worker body-scan, and
    // builds the filter-pill row — including the always-on Journal tab. The
    // hero article (if any) is excluded from the list but counted.
    _heroArticleRef = heroArticle;
    _lastFilterCounts = {
      intel: question,
      projects: restProjects.length + (heroProject ? 1 : 0),
      firms:    restFirms.length + restCities.length + (heroFirm ? 1 : 0),
    };
    // Onyx 4.1 redesign: every query defaults to the answer-first OVERVIEW —
    // the analyst answer + the single best hero + a capped taste of each
    // section. The counts-bar pills drill into any one category for the full
    // set. A user who explicitly picked a lens last query gets it back via
    // stickiness; otherwise Overview leads.
    var defF = _stickyDefault('overview', _lastFilterCounts);
    sResults.setAttribute('data-filter', defF);
    renderArticleSection(q, token);

    _lastResultsTotal = totalHits;
    _lastResultKind = question ? 'question' : 'text';
    setState('results');

    // Log plain text-match queries to the Studio analytics tab. Question
    // + structured-smart paths log via tmwIntel.count/track elsewhere;
    // plain searches (e.g. "1428 Brickell", "Wynwood") never reach those
    // paths, so without this branch the Studio would lose visibility on
    // every typed query that didn't trigger Intelligence.
    try {
      if (!_replaying && !question && window.tmwIntel && window.tmwIntel.trackSearch) {
        window.tmwIntel.trackSearch(q, { source: 'overlay', results: totalHits });
      }
    } catch(_){}
  }

  // Append the next batch of articles + manage the load-more button.
  // Idempotent: a final batch removes the button; called from runTextMatch
  // for the first batch and from the button click for each subsequent.
  // ─── Filter pills ──────────────────────────────────────────────────
  // Render purple-themed filter pills at the top of the results state so
  // the user can narrow the body to a single category. Counts come from
  // the calling render path (text-match or smart) -- pills only appear
  // for categories that actually have results. "All" + "Intelligence"
  // never carry counts; the rest do (Projects 12, Firms & Places 4 etc).
  // Journal search + render, shared by BOTH the text-match and the structured-
  // smart paths — so journal entries surface for architect/city/status queries
  // (e.g. "kengo kuma" → ARCHITECT) too, not just free-text. Scores ARTICLES,
  // fires the worker body-scan (full-archive), paints the journal section
  // (matches, or the latest-stories browse fallback), and rebuilds the filter-
  // pill row with the live Journal count. Touches only the articles slot + the
  // pill row, so the body-merge re-render never disturbs hero/projects/intel.
  function renderArticleSection(q, token, opts){
    opts = opts || {};
    if (token !== _renderToken) return 0;
    var Core = window.TmwSearchCore;
    var full = norm(q);
    var toks = tokenize(q);
    var stoks = (Core && Core.filterMeaningfulTokens) ? Core.filterMeaningfulTokens(toks)
                                                      : toks.filter(function(t){ return t.length >= 3; });
    if (!stoks.length) stoks = toks.filter(function(t){ return t.length >= 2; });

    // Full-archive body-scan once per query (skipped on the merge re-render).
    if (!opts.fromBodyMerge && _bodyMatchFor !== q) fetchBodyMatches(q, stoks, token);

    var hero = _heroArticleRef;
    var aScored = ARTICLES.map(function(a){ return { a:a, s:scoreArticle(a, stoks, full) }; })
                          .filter(function(x){ return x.s > 0 && x.a !== hero; })
                          .sort(function(a,b){ return b.s - a.s; });
    var count = aScored.length + (hero ? 1 : 0);

    _articlesAll = aScored.map(function(x){ return x.a; });
    _articlesShown = 0;
    if (_articlesAll.length){
      slotArticles.innerHTML = ''
        + '<div class="tmw-ov-sec" data-cat="articles">'
        +   '<div class="tmw-ov-sec-head"><h3>From the journal</h3><span class="count">'+count+' total</span></div>'
        +   '<div class="tmw-ov-alist"></div>'
        +   (count > 2 ? '<button class="tmw-ov-seeall" type="button" data-goto="articles">See all '+count+' stories <span aria-hidden="true">&rarr;</span></button>' : '')
        + '</div>';
      appendArticles();
    } else {
      // No matches — the always-on Journal tab still gets the latest stories as
      // a browse fallback (hidden in All, shown under the Journal filter).
      // Skipped when an iconic editorial list is already the Journal answer, so
      // "best hotels" doesn't trail unrelated latest posts under its curated list.
      var recent = ARTICLES.slice(0, 9);
      slotArticles.innerHTML = (recent.length && !opts.suppressFallback)
        ? ('<div class="tmw-ov-sec tmw-ov-jfallback" data-cat="articles">'
            + '<div class="tmw-ov-sec-head"><h3>Latest from the journal</h3><span class="count">browse all</span></div>'
            + '<div class="tmw-ov-alist">' + recent.map(renderArticleCard).join('') + '</div>'
            + '</div>')
        : '';
    }

    // (Re)build the filter pills with the live article count, preserving the
    // active filter so a body-merge re-render doesn't snap back to "All".
    var active = sResults.getAttribute('data-filter') || 'overview';
    // Sticky "Journal" carried into a query that matched NO stories → fall back to
    // Intelligence (or Overview if this query produced no Intelligence answer).
    if (active === 'articles' && count === 0) { active = (_lastFilterCounts.intel ? 'intel' : 'overview'); sResults.setAttribute('data-filter', active); }
    slotFilterPills.innerHTML = renderFilterPills({
      intel: _lastFilterCounts.intel,
      projects: _lastFilterCounts.projects,
      firms: _lastFilterCounts.firms,
      articles: count + (_lastFilterCounts.iconicArticles || 0),  // iconic picks live under Journal now
    });
    var ap = slotFilterPills.querySelector('.tmw-ov-fp[data-filter="'+active+'"]');
    if (ap){ var ps = slotFilterPills.querySelectorAll('.tmw-ov-fp'); for (var i=0;i<ps.length;i++) ps[i].classList.toggle('active', ps[i]===ap); }
    return count;
  }

  function renderFilterPills(counts){
    var pills = [];
    pills.push('<button class="tmw-ov-fp active" type="button" data-filter="overview">Overview</button>');
    if (counts.projects > 0) {
      pills.push('<button class="tmw-ov-fp" type="button" data-filter="projects">Projects <span class="tmw-ov-fp-n">'+counts.projects+'</span></button>');
    }
    if (counts.firms > 0) {
      pills.push('<button class="tmw-ov-fp" type="button" data-filter="firms">Firms &amp; Places <span class="tmw-ov-fp-n">'+counts.firms+'</span></button>');
    }
    // Journal is ALWAYS present — it's the way to isolate/browse stories even
    // when the query matched none (the section then shows the latest posts as
    // a browse fallback). Count shown only when there are matches.
    pills.push('<button class="tmw-ov-fp" type="button" data-filter="articles">Journal'
      + (counts.articles > 0 ? ' <span class="tmw-ov-fp-n">'+counts.articles+'</span>' : '')
      + '</button>');
    // Don't render the row if there's only "All" (no categories to filter to)
    if (pills.length < 2) return '';
    return '<div class="tmw-ov-fp-row">' + pills.join('') + '</div>';
  }

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
  // Detect a bare city-name query (the whole query IS a city) so we answer it
  // as a city overview rather than latching onto a coincidentally-named project
  // (e.g. "nashville" anchoring on "Nashville Yards"). Returns display name|null.
  function detectCityQuery(q){
    var Core = window.TmwSearchCore;
    if (!Core || !Core.buildCitySet || !Core.norm) return null;
    var full = Core.norm(q).trim();
    if (!full || full.split(/\s+/).length > 4) return null;
    var set = Core.buildCitySet(PROJECTS), best = null;
    set.forEach(function(disp, nc){ if (full === nc && (!best || nc.length > best.nc.length)) best = { disp: disp, nc: nc }; });
    return best ? best.disp : null;
  }
  function inCity(cityDisp){
    var Core = window.TmwSearchCore, target = Core.norm(cityDisp);
    return function(p){ return Core.norm(String(p.City||'').split(',')[0].trim()) === target; };
  }
  // /smart-answer returns hero = the slug of the story it leads with. When it
  // names a journal article different from the keyword-ranked hero, promote it:
  // swap the hero card and rebuild the journal list (so the new hero is excluded
  // and the old one rejoins the grid). Article heroes only — project-led queries
  // already track the DB lead, and a non-article id simply no-ops here.
  function applyIntelHero(heroId, heroDoc, q, token){
    var id = String(heroId || '').trim(); if (!id) return;
    var a = null;
    for (var i = 0; i < ARTICLES.length; i++){
      var x = ARTICLES[i];
      if (x && (x.slug === id || x.link === id)){ a = x; break; }
    }
    // Body-discovered story not in the loaded set — synthesize it from the
    // worker's heroDoc so we can still feature it (and add to ARTICLES so the
    // journal grid lists it instead of dropping it).
    if (!a && heroDoc && heroDoc.slug === id){
      a = { slug: heroDoc.slug, title: heroDoc.title || '', cover_image: heroDoc.image || '',
            excerpt: heroDoc.excerpt || '', published_iso: heroDoc.published_iso || '', link: heroDoc.link || '' };
      ARTICLES.push(a);
    }
    if (!a || a === _heroArticleRef) return;
    _heroArticleRef = a;
    slotHero.innerHTML = '<div class="tmw-ov-sec" data-cat="articles">' + renderArticleHero(a) + '</div>';
    try { renderArticleSection(q, token, { fromBodyMerge: true }); } catch(_){}
  }

  function fireIntelligence(q, topProjects, topArticles, place, topic, token, placeTerms){
    var Core = window.TmwSearchCore;
    if (!Core) return;
    // `topic` (e.g. 'food & drink') → answer from journal ARTICLES, not projects.
    // placeTerms lets the worker pull body-level matches from D1 for the place.
    var facts = (topic && Core.buildJournalFacts)
      ? Core.buildJournalFacts(topArticles, place, topic, placeTerms)
      : Core.buildIntelFacts(topProjects, topArticles, place);
    var myToken = ++_intelToken;
    clearTimeout(_intelDebounce);
    _intelDebounce = setTimeout(function(){
      if (myToken !== _intelToken) return;
      Core.askIntelligence(q, facts).then(function(res){
        if (myToken !== _intelToken) return;
        if (res && res.ok && res.answer){
          slotIntel.innerHTML = intelPanelHtml('answer', q, res.answer);
          cacheAnswer(q, res.answer);   // remember for instant resume / repeat
          // Count this against the user's free quota (window.tmwIntel.FREE)
          // (intelligence.js
          // gate; Pro users are uncounted). Mirrors /search/.
          try {
            if (!_replaying && window.tmwIntel && window.tmwIntel.count) window.tmwIntel.count(q);
            if (!_replaying && window.tmwIntel && window.tmwIntel.track) window.tmwIntel.track(q, { results: facts.top.length, source: 'overlay' });
          } catch(_){}
          // Let Intelligence's editorial pick drive the hero card — promote the
          // story it chose to feature over the blunt keyword-ranked one.
          if (res.hero) applyIntelHero(res.hero, res.heroDoc, q, token);
        } else if (res && res.error){
          slotIntel.innerHTML = intelPanelHtml('error', q);
        } else {
          slotIntel.innerHTML = intelPanelHtml('no-answer', q);
        }
      });
    }, 700);
  }

  // Wait for explicit submit (Enter / arrow click) before running a query —
  // the prior debounced live-as-you-type approach flooded the Studio
  // analytics with every keystroke and burned LLM credits on half-words. The
  // input handler now only toggles the visual state so the user can SEE the
  // submit affordance light up when they have enough typed to search.
  function onInput(){
    var v = (input.value || '').trim();
    // .ready makes the submit button light up gold + show the Enter kbd hint.
    if (go) go.classList.toggle('ready', v.length >= 2);
    if (!v) setState('starter');
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
  // URL hash we push while the spotlight is open. Lets the Studio analytics
  // distinguish "user is reading /post/abc/" from "user is searching from
  // /post/abc/" — heartbeat reports the hash, so the activity feed shows
  // "/post/abc/#search" while the lightbox is up. Also gives a deep-link
  // affordance: visiting any-page#search auto-opens the spotlight.
  var TMW_HASH = '#search';
  function pushHash(){
    try {
      if (location.hash === TMW_HASH) return;
      var url = location.pathname + location.search + TMW_HASH;
      history.pushState({ tmwOv: true }, '', url);
    } catch(_){}
  }
  function popHash(){
    try {
      // Only undo if we're the ones who pushed it (history.state set above).
      // Avoids stepping on a user's own hash if they navigated here manually.
      if (location.hash === TMW_HASH && history.state && history.state.tmwOv){
        history.back();
      } else if (location.hash === TMW_HASH){
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch(_){}
  }
  function open(initialQuery){
    if (root.classList.contains('open')) return;
    _savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.style.overflow = 'hidden';
    root.classList.add('open');
    // Refresh the PRO / quota badge in the teach card -- the user may have
    // burned queries since the last time the overlay was opened.
    refreshProPill();
    if (initialQuery) {
      _resumeThenSubmit(initialQuery);   // restore the saved thread, then append this query (was: blow it away)
    } else if (_thread.length) {
      // Same-session reopen — the rendered thread is still in the DOM; leave it.
    } else {
      // Resume the saved conversation. Replay this device's LOCAL thread instantly
      // (offline-safe, no flash); for a logged-in member, then reconcile against
      // their CLOUD thread so they pick up where they left off on another device.
      var localQs = readThread();
      if (!localQs) { var _r = readLastQuery(); if (_r) localQs = [_r]; }
      _userInteracted = false;   // fresh open: a pending cloud-resume may take over
      var localKey = (localQs || []).join('');
      if (localQs && localQs.length) { _resumeReplay(localQs); }
      else { input.value = ''; setState('starter'); }   // teach for now; the cloud check may replace it

      // Always reconcile with the cloud. fetchServerThread resolves the member
      // itself and returns null when logged out, so this is a safe no-op then.
      fetchServerThread().then(function(res){
        var serverQs = res && res.qs;
        if (res && res.ts) _syncedTs = res.ts;   // baseline for live polling
        if (!serverQs || !serverQs.length) {
          if (localQs && localQs.length) saveThreadToServer();   // cloud empty: migrate this device up
          return;
        }
        // Adopt the cloud thread (a more-recently-active device) only if the user
        // has not started a new turn since open and it differs from what we replayed.
        // (compare cloud to local below)
        if (!_userInteracted && serverQs.join('') !== localKey) {
          _resumeReplay(serverQs);
        }
      });
    }
    // Defocus map / page elements so iOS doesn't pop the keyboard awkwardly
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch(_){}
    // Focus after the transition starts so the bar is in place
    setTimeout(function(){ try { input.focus({ preventScroll:true }); } catch(_){ input.focus(); } }, 180);
    // Kick off data load now so by the time they type results are ready
    loadData();
    // Update the URL so the Studio sees this user is in the spotlight, then
    // fire a heartbeat ping right away so the activity feed updates without
    // waiting for the 60s interval.
    pushHash();
    try { if (window.__tmwPing) window.__tmwPing(); } catch(_){}
    _startSyncPoll();   // live cross-device sync while open
  }
  function close(){
    if (!root.classList.contains('open')) return;
    _stopSyncPoll();
    root.classList.remove('open');
    document.documentElement.style.overflow = '';
    setTimeout(function(){ window.scrollTo(0, _savedScrollY); }, 0);
    // Keep the chat thread rendered + in memory so reopening continues the
    // conversation (resume). Just cancel any in-flight render + clear the bar.
    setTimeout(function(){
      input.value = '';
      _articlesAll = [];
      _articlesShown = 0;
      _renderToken++;
    }, 320);
    // Roll back the URL + ping so the activity feed flips back to the page
    // the user came from.
    popHash();
    try { if (window.__tmwPing) window.__tmwPing(); } catch(_){}
  }

  // Back-button / hashchange handling: if the user presses Back while the
  // spotlight is open, treat it as "close the spotlight" rather than
  // navigating off the page. Same for any explicit hash flip away from
  // #search (e.g. clicking an in-page anchor while overlay is up).
  window.addEventListener('popstate', function(){
    if (root.classList.contains('open') && location.hash !== TMW_HASH){
      close();
    }
  });
  // Deep link: if the page loads with #search already in the URL (someone
  // shared a spotlight link), open the lightbox automatically once the
  // module is mounted.
  if (location.hash === TMW_HASH){
    setTimeout(function(){ open(''); }, 0);
  }
  // Also open when the hash becomes #search at runtime (e.g. a dropdown link
  // sets it on the current page) — not just on initial load.
  window.addEventListener('hashchange', function(){
    if (location.hash === TMW_HASH && !root.classList.contains('open')) open('');
  });

  scrim.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  // "New chat": clear the conversation + return to the TMW Intelligence
  // homescreen (the teach/starter screen), keeping the overlay open.
  function newChat(){
    _thread = [];
    if (_threadEl) _threadEl.innerHTML = '';
    try { localStorage.removeItem(_THREAD_KEY); } catch (_) {}
    if (input) { input.value = ''; try { onInput(); } catch (_) {} }
    setState('starter');
    if (bodyEl) bodyEl.scrollTop = 0;
    if (input) { try { input.focus(); } catch (_) {} }
  }
  var newChatBtn = root.querySelector('.tmw-ov-newchat');
  if (newChatBtn) newChatBtn.addEventListener('click', newChat);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', function(e){
    if (e.key === 'Enter') {
      e.preventDefault();
      var v = (input.value || '').trim();
      // The overlay IS the search experience now -- Enter runs the query
      // inline instead of redirecting to /search/. /search/ remains as a
      // canonical deep-link target for share URLs (?q=... permalinks) but
      // isn't a destination anyone needs to navigate to from the UI.
      if (v) submitQuery(v);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  go.addEventListener('click', function(){
    var v = (input.value || '').trim();
    if (v) submitQuery(v);
  });

  // Suggestion click (teach-card row OR legacy starter chip) → fill the
  // bar + run inline. Also wires the "Load more stories" button -- single
  // delegated handler for everything inside the overlay so the wiring
  // lives in one place. Match-by-data-q so any future suggestion variant
  // (different markup, same intent) just needs to carry the attribute.
  root.addEventListener('click', function(e){
    // Never treat a feedback-row click as a query submission (the thumbs live
    // inside the answer; a stray data-* there must not re-run the query).
    if (e.target.closest && e.target.closest('.tmw-ov-feedback')) return;
    var sug = e.target.closest && e.target.closest('[data-q]');
    if (sug) {
      var q = sug.getAttribute('data-q');
      if (q) { submitQuery(q); }
      return;
    }
    var more = e.target.closest && e.target.closest('[data-action="more-articles"]');
    if (more) {
      e.preventDefault();
      appendArticles();
      return;
    }
    // Load-more for project rows: reveal the next page of hidden rows within
    // THIS turn's section (self-contained, so it works on any turn in the thread).
    var moreRows = e.target.closest && e.target.closest('[data-action="more-rows"]');
    if (moreRows) {
      e.preventDefault();
      var sec = moreRows.closest('.tmw-ov-sec');
      if (sec) {
        var hidden = sec.querySelectorAll('.tmw-ov-row.tmw-ov-row-hidden');
        var ROW_PAGE = 10;
        for (var ri = 0; ri < Math.min(ROW_PAGE, hidden.length); ri++) hidden[ri].classList.remove('tmw-ov-row-hidden');
        var left = sec.querySelectorAll('.tmw-ov-row.tmw-ov-row-hidden').length;
        if (left > 0) moreRows.textContent = 'Load ' + Math.min(ROW_PAGE, left) + ' more';
        else moreRows.remove();
      }
      return;
    }
    // "See all N →" inside a capped Overview section: jump to that category's
    // full view by activating its counts-bar pill (reuses the pill logic below).
    var seeall = e.target.closest && e.target.closest('[data-goto]');
    if (seeall) {
      e.preventDefault();
      var goto = seeall.getAttribute('data-goto');
      var saRes = (seeall.closest && seeall.closest('[data-state="results"]')) || sResults;
      var targetPill = saRes.querySelector('.tmw-ov-fp[data-filter="'+goto+'"]');
      if (targetPill) targetPill.click();
      else saRes.setAttribute('data-filter', goto);
      return;
    }
    // Filter pill click: swap the active pill's class + write the new filter to
    // the results state's data-filter attribute. CSS hides sections whose
    // data-cat doesn\'t match; "overview" (the default) shows all sections but
    // caps each to a preview. Always SET the attribute (overview included) so
    // the cap CSS applies.
    var pill = e.target.closest && e.target.closest('.tmw-ov-fp');
    if (pill) {
      e.preventDefault();
      var filter = pill.getAttribute('data-filter') || 'overview';
      _setStickyFilter(filter);   // remember this lens for following queries
      var allPills = pill.parentNode ? pill.parentNode.querySelectorAll('.tmw-ov-fp') : [];
      for (var i = 0; i < allPills.length; i++) {
        allPills[i].classList.toggle('active', allPills[i] === pill);
      }
      // Scope to THIS pill's own turn (it sits inside that turn's results div),
      // so filtering an older turn doesn't reach into the latest one.
      var resDiv = (pill.closest && pill.closest('[data-state="results"]')) || sResults;
      resDiv.setAttribute('data-filter', filter);
      // Snap to the top of this turn (its tab bar) so switching tabs — e.g. from
      // the "N more projects" link at the bottom — lands at the top of the new
      // view, not wherever the user was scrolled to.
      var _turn = resDiv.closest && resDiv.closest('.tmw-ov-turn');
      if (_turn && _turn.scrollIntoView) _turn.scrollIntoView({ block: 'start', behavior: 'smooth' });
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

  // Open with a prefix populated but NO search fired — used by SEO market
  // pages where the user lands at /markets/west-palm-beach-residences/ and
  // clicks the "Ask anything about this market" input. We want to drop them
  // into the starter/suggestions state with the market name already in the
  // box so they can continue typing their question with the filter implicit.
  function openWithPrefix(prefix) {
    if (root.classList.contains('open')) return;
    _savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.style.overflow = 'hidden';
    root.classList.add('open');
    setState('starter');                     // stays in starter (no search run)
    refreshProPill();
    input.value = '';
    if (prefix && prefix.trim()) {
      var v = prefix.trim() + ' ';
      input.value = v;
    }
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch(_){}
    setTimeout(function(){
      try { input.focus({ preventScroll: true }); } catch(_) { input.focus(); }
      // Drop cursor at the end so they can type immediately after the prefix.
      try { input.setSelectionRange(input.value.length, input.value.length); } catch(_) {}
    }, 180);
    loadData();
    pushHash();
    try { if (window.__tmwPing) window.__tmwPing(); } catch(_){}
  }

  // ── public API ────────────────────────────────────────────────────
  window.tmwOverlay = {
    open: open,
    openWithPrefix: openWithPrefix,
    close: close,
    isOpen: function(){ return root.classList.contains('open'); }
  };

  // ── ?q= deep-link bootstrap ─────────────────────────────────────────
  // Now that the standalone /search/ page is gone, "https://www.oftmw.com/?q=X"
  // is the canonical search deep-link: any page that loads this overlay opens
  // the spotlight pre-loaded with X. Powers the homepage SearchAction, the
  // dock submit fallback, slug-less firm cards, and the map's coverage /
  // recent-search links — all of which point at /?q=… instead of /search/.
  try {
    var _bootQ = new URLSearchParams(location.search).get('q');
    if (_bootQ && _bootQ.trim()) {
      // open() routes an initial query through submitQuery → it posts as the
      // first message + renders its answer turn (a /?q=… deep-link lands on
      // results, e.g. the Studio Search-Health "open in search" arrows).
      open(_bootQ.trim());
    }
  } catch(_){}
})();
