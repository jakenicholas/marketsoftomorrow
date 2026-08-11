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
  /* Shared cross-script JSON loader: one network fetch per URL per pageview
     (memoized promise on window), but each caller parses its OWN copy so no
     consumer can mutate another's data. projects-flat.json is 563KB — before
     this, four scripts each fetched it independently with cache:'no-cache'. */
  function __tmwSharedJson(url){
    var store = window.__tmwJsonMemo = window.__tmwJsonMemo || {};
    if (!store[url]) store[url] = fetch(url, { cache: 'no-cache' }).then(function(r){ return r.ok ? r.text() : 'null'; }).catch(function(){ return 'null'; });
    return store[url].then(function(t){ try { return JSON.parse(t); } catch(e){ return null; } });
  }

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
  // Project bios are capped at 300 chars — a long DescriptionLong is trimmed to
  // the last sentence-or-word boundary under the cap and gets an ellipsis, so a
  // card never dumps a 600-char paragraph. Returns the (possibly clipped) text.
  function clipBio(s, max){
    s = String(s == null ? '' : s).trim();
    max = max || 300;
    if (s.length <= max) return s;
    var cut = s.slice(0, max);
    var lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (lastStop >= max * 0.6) return cut.slice(0, lastStop + 1);   // clean sentence end
    var lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '') + '…';
  }
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
  // Does the query EXPLICITLY ask for a list of projects? Those keep the project
  // cards; every other question is slimmed to the pure LLM prose. Deliberately
  // narrow — an analytical question that merely mentions "opening"/"new" (e.g.
  // "what's opening across our markets by region?") is NOT a list request.
  function listIntent(q){
    var t = String(q||'').toLowerCase().trim();
    if (/\b(give me|show me|make|build|need|want)\b.*\blist\b/.test(t)) return true;         // "give me a list …"
    if (/\blist\s+(of|the|all|me|out)?\s*(projects?|developments?|condos?|towers?|hotels?|buildings?|deals?)\b/.test(t)) return true;
    if (/\b(new|newest|latest|recent|upcoming)\s+(projects?|developments?|condos?|listings?|launches?)\b/.test(t)) return true;
    if (/^(list|projects?|developments?)\b/.test(t)) return true;                             // starts with "list"/"projects"
    // Size/superlative "rank me a list" asks — "biggest projects", "tallest towers",
    // "most units". These want the ranked cards (now sorted by scale), not pure prose.
    if (/\b(biggest|largest|tallest|highest|shortest|most|top)\b/.test(t) && /\b(projects?|developments?|towers?|buildings?|condos?|hotels?|deals?|residences?)\b/.test(t)) return true;
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

    // visibility:hidden when closed (delayed past the fade) — opacity:0 alone
    // still PAINTS the near-opaque scrim under some compositing paths (seen as
    // a full-width black band behind the signup modal on project pages).
    + '.tmw-ov-root{position:fixed;inset:0;z-index:9998;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .3s ease,visibility 0s linear .3s;'
    + 'font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#ECEAE5;font-size:15px;line-height:1.55}'
    + '.tmw-ov-root.open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .3s ease,visibility 0s}'

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
    /* Past chats — button (left of New chat) + full-cover history panel */
    + '.tmw-ov-history{position:absolute;top:18px;right:186px;z-index:3;display:inline-flex;align-items:center;gap:7px;'
    + 'height:38px;padding:0 15px;border-radius:999px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;'
    + 'letter-spacing:.02em;color:#C2C9C3;background:rgba(20,20,25,.62);border:1px solid rgba(255,255,255,.14);transition:all .18s;'
    + '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}'
    + '.tmw-ov-history:hover{color:#fff;border-color:rgba(255,255,255,.3);background:rgba(28,28,34,.85)}'
    + '.tmw-ov-history svg{width:15px;height:15px;display:block;flex:0 0 auto}'
    /* right:176px (not 154) — the New chat pill ends around 164px from the right
       edge on mobile, so 154 overlapped it by ~10px. */
    + '@media(max-width:640px){.tmw-ov-history{right:176px;top:14px;height:34px;padding:0;width:34px;justify-content:center;gap:0}.tmw-ov-history-lbl{display:none}}'
    /* Gemini-style recents: translucent purple-glow glass, roomy single-line
       rows (title left, quiet time right), no icon chips, NO monospace. */
    + '.tmw-ov-histpanel{position:absolute;inset:0;z-index:10;display:none;flex-direction:column;border-radius:inherit;overflow:hidden;'
    +   'background:radial-gradient(760px 320px at 18% 0%, rgba(167,139,250,.13), transparent 62%), rgba(8,9,11,.86);'
    +   'backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2)}'
    + '.tmw-ov-histpanel.open{display:flex}'
    + '.tmw-ov-histpanel-head{display:flex;align-items:center;justify-content:space-between;padding:22px 20px 14px;flex:0 0 auto;width:100%;max-width:720px;margin:0 auto}'
    + '.tmw-ov-histpanel-ttl{font-family:Fraunces,Georgia,serif;font-size:21px;font-weight:600;color:#fff;letter-spacing:.01em}'
    + '.tmw-ov-histpanel-x{width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#C2C9C3;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:all .18s}'
    + '.tmw-ov-histpanel-x:hover{color:#fff;border-color:rgba(167,139,250,.5);background:rgba(167,139,250,.12)}'
    + '.tmw-ov-histpanel-x svg{width:14px;height:14px;display:block}'
    + '.tmw-ov-histpanel-body{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 16px 28px;display:flex;flex-direction:column;gap:2px;width:100%;max-width:720px;margin:0 auto}'
    + '.tmw-ov-hist-row{display:flex;align-items:center;gap:14px;padding:16px 16px;border-radius:14px;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s;border:1px solid transparent}'
    + '.tmw-ov-hist-row:hover{background:rgba(167,139,250,.09);border-color:rgba(167,139,250,.28);box-shadow:0 0 22px -8px rgba(167,139,250,.45)}'
    + '.tmw-ov-hist-main{flex:1 1 auto;min-width:0}'
    + '.tmw-ov-hist-ttl{display:block;font-size:15px;color:#ECEAE5;font-weight:500;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.tmw-ov-hist-meta{flex:0 0 auto;font-size:12px;color:#8b958d;white-space:nowrap}'
    + '@media(max-width:640px){.tmw-ov-hist-n{display:none}}'
    + '.tmw-ov-hist-del{flex:0 0 auto;width:30px;height:30px;border-radius:7px;border:1px solid transparent;background:transparent;color:#6b736c;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:all .15s}'
    + '.tmw-ov-hist-row:hover .tmw-ov-hist-del{opacity:1}'
    + '.tmw-ov-hist-del:hover{color:#ff6b6b;border-color:rgba(255,107,107,.4);background:rgba(255,107,107,.1)}'
    + '.tmw-ov-hist-del svg{width:14px;height:14px}'
    + '.tmw-ov-hist-empty{padding:64px 20px;text-align:center;color:#6b736c;font-size:14px;line-height:1.6}'
    /* Hex animations kept under .tmw-ov-hxs-* because the spotlight teach
       card still renders the small spinning hexagon next to the label. */
    + '.tmw-ov-hxs-spin{transform-origin:50% 50%;animation:tmwOvHxsSpin 4.2s cubic-bezier(.16,1,.3,1) infinite}'
    + '.tmw-ov-hxs-core{transform-origin:50% 50%;animation:tmwOvHxsPulse 4.2s ease-in-out infinite}'
    + '.tmw-ov-hxs-ring{transform-origin:50% 50%;animation:tmwOvHxsRing 4.2s ease-out infinite}'
    + '@media(prefers-reduced-motion:reduce){.tmw-ov-hxs-spin,.tmw-ov-hxs-ring{animation:none}.tmw-ov-hxs-ring{opacity:0}}'

    + '.tmw-ov-body{flex:1;overflow-y:auto;padding:8px 0 120px;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;position:relative;z-index:1}'
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
    /* Source-article chip under the query bubble — shows Onyx (and the reader)
       exactly which article a handed-off question is about; links to it. */
    + '.tmw-ov-actx{margin-top:7px;display:inline-flex;align-items:center;gap:6px;max-width:80%;padding:5px 11px;'
    +   'border-radius:999px;border:1px solid rgba(167,139,250,.5);background:rgba(167,139,250,.12);'
    +   'color:#C9BBFF;font:600 11.5px/1.2 "Inter",-apple-system,system-ui,sans-serif;text-decoration:none;'
    +   'transition:background .18s,border-color .18s}'
    + '.tmw-ov-actx:hover{background:rgba(167,139,250,.22);border-color:rgba(167,139,250,.75);color:#EFEAFB}'
    + '.tmw-ov-actx svg{width:13px;height:13px;flex:0 0 auto}'
    + '.tmw-ov-actx span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.tmw-ov-answer{display:block}'
    /* Per-answer thumbs: bottom-right of each turn, votes on that turn alone.
       Pin the "Noted" confirmation under the right-aligned buttons (the base
       rule centers it on the row, which is full-width here). */
    + '.tmw-ov-turn-fb{justify-content:flex-end;align-items:center;width:100%;margin-top:16px}'
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

    /* Direction A — quiet invitation. One warm serif prompt replaces the
       "Try asking" label; suggestions are hairline rows, not tiles. */
    + '.tmw-ov-prompt{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:26px;line-height:1.14;'
    + 'letter-spacing:-.01em;color:#ECEAE5;text-align:center;margin:24px 0 0;text-wrap:balance}'
    + '.tmw-ov-prompt-sub{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
    + 'font-weight:400;font-size:13px;letter-spacing:.01em;color:#9AA39C;margin-top:10px}'
    + '.tmw-ov-qlist{margin-top:26px;display:flex;flex-direction:column}'
    + '.tmw-ov-qrow{display:flex;align-items:center;justify-content:space-between;gap:12px;'
    + 'width:100%;text-align:left;cursor:pointer;font-family:inherit;color:inherit;'
    + 'background:transparent;border:0;border-top:1px solid rgba(255,255,255,.08);'
    + 'padding:15px 4px;transition:padding-left .18s ease}'
    + '.tmw-ov-qrow:last-child{border-bottom:1px solid rgba(255,255,255,.08)}'
    + '.tmw-ov-qrow-t{flex:1;font-family:"Fraunces",Georgia,serif;font-size:16.5px;line-height:1.25;color:#ECEAE5}'
    + '.tmw-ov-qrow-ar{flex:0 0 auto;width:16px;height:16px;color:#6c706c;transition:color .18s,transform .18s}'
    + '.tmw-ov-qrow-ar svg{width:100%;height:100%}'
    + '.tmw-ov-qrow:hover{padding-left:10px}'
    + '.tmw-ov-qrow:hover .tmw-ov-qrow-ar{color:#B9A6FF;transform:translateX(2px)}'
    /* Starter-only: give the search bar a soft purple wash so it reads as the
       clear next step. Gated via :has() so it reverts to neutral in a thread. */
    + '.tmw-ov-lb:has(.tmw-ov-starter:not(.tmw-ov-hidden)) .tmw-ov-bar{'
    + 'background:rgba(167,139,250,.07);border-color:rgba(167,139,250,.34);box-shadow:0 0 0 3px rgba(167,139,250,.05)}'

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
    +   '.tmw-ov-teach-ttl{font-size:11px;letter-spacing:.18em}'
    +   '.tmw-ov-prompt{font-size:23px;margin-top:20px}'
    +   '.tmw-ov-prompt-sub{font-size:12.5px}'
    +   '.tmw-ov-qlist{margin-top:22px}'
    +   '.tmw-ov-qrow{padding:14px 2px}'
    +   '.tmw-ov-qrow-t{font-size:15px}'
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
    /* Firms & places live ONLY in their tab — never on the Overview (and so
       never as secondary cards under a hero). */
    + '[data-state="results"][data-filter="overview"] [data-cat="firms"]{display:none}'
    + '[data-state="results"][data-filter="articles"] [data-cat]:not([data-cat="articles"]){display:none}'
    /* ANSWER-ONLY — for analytical/synthesis questions (compare, why, "what\'s
       going on in X") the LLM prose IS the answer; suppress the hero card,
       Related-projects, From-the-journal, Firms, and the count tabs so a
       semi-arbitrary card doesn\'t cheapen a written answer. */
    + '[data-state="results"][data-answer-only="1"] .tmw-ov-hero,'
    + '[data-state="results"][data-answer-only="1"] .tmw-ov-exacthero .tmw-pv,'
    + '[data-state="results"][data-answer-only="1"] [data-cat="projects"],'
    + '[data-state="results"][data-answer-only="1"] [data-cat="articles"],'
    + '[data-state="results"][data-answer-only="1"] [data-cat="firms"],'
    + '[data-state="results"][data-answer-only="1"] [data-slot="filter-pills"]{display:none !important}'
    /* SLIM: an analytical QUESTION drops the project LISTS (ranked rows + related
       grid) and the firm/entity list from the Overview so it reads as the pure LLM
       answer. A single hero card, the prose, the journal, and the Projects/Journal
       tabs all stay — so "1 hero card answer" and drill-in still work. */
    + '[data-state="results"][data-filter="overview"][data-slim="1"] [data-slot="rows"],'
    + '[data-state="results"][data-filter="overview"][data-slim="1"] [data-slot="projects-grid"],'
    + '[data-state="results"][data-filter="overview"][data-slim="1"] [data-slot="entities"]{display:none !important}'
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
    + '.tmw-ov-jempty{font-size:13px;color:#9AA39C;padding:6px 0 2px}'
    + '.tmw-ov-jempty a{color:#e6c574;text-decoration:none}'
    + '.tmw-ov-jempty a:hover{text-decoration:underline}'

    /* Onyx 5 — answer-first OVERVIEW lens (the default). Shows the
       Intelligence answer + hero + a capped taste of each section; the
       counts-bar pills drill into any single category for the full set.
       Caps are scoped to [data-filter="overview"] so the category tabs
       (Projects / Firms / Journal) still render everything. */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-grid > *:nth-child(n+4){display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-chiprow > *:nth-child(n+7){display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-alist > *:nth-child(n+4){display:none}'
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
    /* Onyx 5 model badge — transparent purple fill + glowing purple border */
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
    + '[data-state="results"][data-filter="overview"]{position:relative;background:#0f120f;border:1px solid rgba(255,255,255,.13);border-radius:18px;padding:24px 26px;box-sizing:border-box}'
    /* Spotlight (curated partner) gets the SAME black bubble as overview, but
       none of the overview flatten/cap rules — it keeps its custom layout,
       just boxed for consistency. */
    + '[data-state="results"][data-filter="spotlight"]{position:relative;background:#0f120f;border:1px solid rgba(255,255,255,.13);border-radius:18px;padding:20px 22px;box-sizing:border-box}'
    /* answer panel → plain text block (no inner box / glow / footer) */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-intel-panel{border:0;background:none;box-shadow:none;padding:0;margin:0 0 14px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-intel-panel::before{display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-intel-foot:not(.has-ground){display:none}'
    + '.tmw-ov-intel-foot .dim{opacity:.55}'
    /* Responses are slimmed to the pure LLM answer: NO "TMW Intelligence" header
       row (label + Onyx 5 / Deep pill) and NO "Thinking / Live answer" status
       pip on top of any answer (loading OR answered). The loader dots (while it
       streams) stay. The sign-up / Go-Pro GATE keeps its header (:not(.gate)). */
    + '.tmw-ov-intel-panel:not(.gate) .tmw-ov-intel-h{display:none}'
    + '.tmw-ov-feedback .live{display:none}'
    /* hero → a compact thumbnail row: title + location only */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero{display:flex;min-height:0;box-shadow:none;border-radius:12px;margin-bottom:8px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .media{min-height:0;width:84px;flex:0 0 84px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .media .scrim,[data-state="results"][data-filter="overview"] .tmw-ov-hero .besttag{display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .body{padding:11px 15px;gap:4px;justify-content:center}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .body h2{font-size:16px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .desc,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .excerpt,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .tmw-ov-specs,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .tmw-ov-byline{display:none}'
    /* keep the CTA visible in overview so the hero has a "View project" button
       (opens the full native card); align it left under the compact body */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .tmw-ov-hero-cta{margin-top:6px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-hero .tmw-ov-btn{padding:8px 13px;font-size:12.5px}'
    /* Perfect single-project match → restore the FULL hero card (the "old" big
       hero) instead of the compact overview row: big media, full body, desc,
       specs, byline. Higher specificity (extra .tmw-ov-exacthero class) beats
       the compaction rules above. */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero{display:grid;grid-template-columns:1.05fr 1fr;margin-bottom:0;border-radius:18px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .media{width:auto;flex:initial;min-height:330px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .media .scrim{display:block}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .media .besttag{display:inline-flex}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .body{padding:26px 30px;gap:12px;justify-content:flex-start}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .body h2{font-size:28px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .desc{display:block}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .tmw-ov-specs{display:flex}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .tmw-ov-byline{display:block}'
    + '@media(max-width:700px){[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero{grid-template-columns:1fr}[data-state="results"][data-filter="overview"] .tmw-ov-exacthero .tmw-ov-hero .media{min-height:200px}}'
    /* JOURNAL HERO — one big full-width story card (like the project hero), never
       the compact thumbnail row. Mirrors the exact-hero rules for .tmw-ov-arthero. */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero{display:grid;grid-template-columns:1.05fr 1fr;margin-bottom:0;border-radius:18px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero .media{width:auto;flex:initial;min-height:330px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero .media .scrim{display:block}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero .media .besttag{display:inline-flex}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero .body{padding:26px 30px;gap:12px;justify-content:flex-start}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero .body h2{font-size:28px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero .desc{display:block}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero .tmw-ov-byline{display:block}'
    + '@media(max-width:700px){[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero{grid-template-columns:1fr}[data-state="results"][data-filter="overview"] .tmw-ov-arthero .tmw-ov-hero .media{min-height:200px}}'
    /* OVERVIEW journal = the single hero tile only. The full "From the journal"
       LIST lives in the Journal tab, never stacked under the hero on overview. */
    + '[data-state="results"][data-filter="overview"] [data-slot="articles-grid"]{display:none}'
    /* sections → tight, with small de-emphasized labels (no big serif headers) */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec{margin-bottom:18px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec:last-child{margin-bottom:0}'
    /* light divider + breathing room above each TITLED section (Related projects,
       From the journal, …) so they stop cramming against the hero/section above.
       The hero section has no .tmw-ov-sec-head, so it never gets a top rule. */
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec:has(> .tmw-ov-sec-head){border-top:1px solid rgba(255,255,255,.08);padding-top:20px}'
    /* PROJECTS-FIRST: the overview journal LIST is always hidden (above); this
       rule is kept scoped to the list slot so it never hides the single journal
       HERO tile — the overview shows up to 3 project cards + one big story hero,
       and the rest of the stories live in the Journal tab. */
    + '[data-state="results"][data-filter="overview"][data-projfirst="1"] [data-slot="articles-grid"]{display:none}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec-head{margin-bottom:12px}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-sec-head h3,'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-smart-head h3{font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#8a948a}'
    + '[data-state="results"][data-filter="overview"] .tmw-ov-smart-head{margin-bottom:8px}'
    /* Removed: the fact-chip stats grid (the LLM answer already states them) and
       the inline Onyx 5 header badge (moved to the "i" info button). */
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
    /* Overview shows a 3-tile taste of the journal (capped via .tmw-ov-alist
       nth-child below), matching the 3 project tiles — the full list lives under
       the Journal tab. */
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
    + '.tmw-ov-row .r-ico{flex:0 0 auto;width:46px;height:46px;border-radius:9px;background:#222622;overflow:hidden;'
    + 'display:flex;align-items:center;justify-content:center;color:#C2C9C3}'
    + '.tmw-ov-row .r-ico.has-img{background:#0c0e0c}'
    + '.tmw-ov-row .r-ico img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.tmw-ov-row .r-ico svg{width:15px;height:15px}'
    + '.tmw-ov-row .r-main{flex:1;min-width:0}'
    + '.tmw-ov-row .r-name{font-family:"Fraunces",Georgia,serif;font-size:16px;font-weight:600;color:#fff;'
    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.tmw-ov-row .r-sub{display:flex;align-items:center;gap:9px;margin-top:4px;font-size:11.5px;color:#9AA39C;flex-wrap:wrap}'
    /* Mobile rows: let the project name WRAP (no mid-name "…" truncation),
       tighten the gaps + rank/icon, and top-align so a 2-line title reads clean. */
    + '@media(max-width:640px){'
    +   '.tmw-ov-row{gap:11px;padding:12px 13px;align-items:flex-start}'
    +   '.tmw-ov-row .rank{width:16px;font-size:14px;line-height:1.3}'
    +   '.tmw-ov-row .r-ico{width:26px;height:26px}'
    +   '.tmw-ov-row .r-main{align-self:center}'
    +   '.tmw-ov-row .r-name{white-space:normal;font-size:15px;line-height:1.25}'
    +   '.tmw-ov-row .r-sub{font-size:11px;gap:5px 8px;margin-top:5px}'
    + '}'
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
    + '.tmw-ov-watch-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.34);color:#B9A6FF;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;flex:0 0 auto;transition:background .2s,border-color .2s,transform .15s}'
    + '.tmw-ov-watch-btn svg{flex:0 0 auto}'
    + '.tmw-ov-watch-btn:hover{background:rgba(167,139,250,.18);border-color:rgba(167,139,250,.55);transform:translateY(-1px)}'
    + '.tmw-ov-watch-btn svg{width:15px;height:15px}'
    + '.tmw-ov-watch-btn .ic-check{display:none}'
    + '.tmw-ov-watch-btn.on .ic-bell{display:none}'
    + '.tmw-ov-watch-btn.on .ic-check{display:inline-block}'
    + '.tmw-ov-watch-btn.on{background:rgba(230,197,116,.14);border-color:rgba(230,197,116,.62);color:#f0d68a;box-shadow:0 0 16px rgba(230,197,116,.5),0 0 3px rgba(230,197,116,.4)}'
    + '.tmw-ov-watch-btn.on:hover{background:rgba(230,197,116,.2);border-color:rgba(230,197,116,.85);box-shadow:0 0 22px rgba(230,197,116,.7)}'
    /* Share this answer — neutral outline pill (open to everyone; copies a /?q= deep link). */
    + '.tmw-ov-share-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);color:#C2C9C3;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;flex:0 0 auto;transition:background .2s,border-color .2s,transform .15s}'
    + '.tmw-ov-share-btn svg{width:15px;height:15px;flex:0 0 auto}'
    + '.tmw-ov-share-btn:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.28);transform:translateY(-1px)}'
    + '.tmw-ov-share-btn .ic-copied{display:none}'
    + '.tmw-ov-share-btn.copied{color:#8FE0A8;border-color:rgba(120,220,150,.5);background:rgba(120,220,150,.12)}'
    + '.tmw-ov-share-btn.copied .ic-share{display:none}'
    + '.tmw-ov-share-btn.copied .ic-copied{display:inline-block}'
    /* Grounding byline relocated into the feedback row (by relocateBylines): the
       receipts line sits LEFT, Watch/thumbs group RIGHT, on one line (desktop).
       The byline is display:block so it wraps as normal TEXT (not the broken
       flex-grid it did on mobile). On mobile it takes the full width + wraps, and
       the actions drop to the next line. */
    + '.tmw-ov-feedback{width:100%;flex-wrap:wrap;gap:10px 16px}'
    + '.tmw-ov-feedback > .tmw-ov-intel-foot{flex:1 1 auto;min-width:0;margin:0;padding:0;border-top:0;display:block;line-height:1.55;font-size:13px;color:#C2C9C3;text-align:left}'
    /* ── Onyx Deep tease — collapsed purple bar under every free-tier answer;
          expands to a skeleton preview of what Deep would have covered. ── */
    + '.tmw-dt{margin-top:14px;border:1px solid rgba(167,139,250,.38);border-radius:14px;padding:12px 18px;position:relative;overflow:hidden;background:linear-gradient(180deg,rgba(167,139,250,.06),rgba(167,139,250,.015));animation:tmwDtGlow 2.6s ease-in-out infinite}'
    + '.tmw-dt.open{padding:16px 20px 18px}'
    + '@keyframes tmwDtGlow{0%,100%{box-shadow:0 0 0 1px rgba(167,139,250,.08) inset,0 0 22px -6px rgba(167,139,250,.22)}50%{box-shadow:0 0 0 1px rgba(167,139,250,.14) inset,0 0 32px -4px rgba(167,139,250,.4)}}'
    + '@media(prefers-reduced-motion:reduce){.tmw-dt{animation:none}.tmw-dt .bar{animation:none}}'
    + '.tmw-dt .dt-toggle{width:100%;background:none;border:0;padding:0;cursor:pointer;font:inherit;color:inherit;text-align:left;display:flex;align-items:center;gap:12px}'
    + '.tmw-dt .dt-eye{font:700 11px/1 "Inter",-apple-system,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#C4B5FD;text-shadow:0 0 14px rgba(167,139,250,.5);display:flex;align-items:center;gap:7px;flex:none}'
    + '.tmw-dt .dt-eye svg{width:13px;height:13px;flex:none}'
    + '.tmw-dt .dt-pro{font-size:8px;letter-spacing:.12em;background:#C4B5FD;color:#120a24;border-radius:4px;padding:2px 5px;font-weight:800}'
    + '.tmw-dt .dt-peek{font-size:12.5px;color:rgba(236,234,229,.62);flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.tmw-dt .dt-chev{color:#C4B5FD;font-size:12px;flex:none;transition:transform .2s}'
    + '.tmw-dt.open .dt-chev{transform:rotate(180deg)}'
    + '.tmw-dt .dt-body{display:none;margin-top:10px}'
    + '.tmw-dt.open .dt-body{display:block}'
    + '.tmw-dt .dt-sub{font-size:12.5px;color:rgba(236,234,229,.7);margin:0 0 10px}'
    + '.tmw-dt .sec{padding:10px 0;border-top:1px solid rgba(255,255,255,.06)}'
    + '.tmw-dt .sec-t{font-size:13px;font-weight:600;color:#ECEAE5;display:flex;align-items:center;gap:8px;margin-bottom:7px}'
    + '.tmw-dt .sec-t .k{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:8.5px;color:#C4B5FD;letter-spacing:.14em}'
    + '.tmw-dt .bar{height:7px;border-radius:4px;margin:5px 0;background:linear-gradient(90deg,rgba(255,255,255,.05) 25%,rgba(167,139,250,.13) 50%,rgba(255,255,255,.05) 75%);background-size:200% 100%;animation:tmwDtShimmer 1.8s linear infinite}'
    + '@keyframes tmwDtShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}'
    + '.tmw-dt .dt-cta{display:inline-flex;align-items:center;gap:8px;margin-top:12px;padding:10px 16px;border-radius:999px;border:1px solid rgba(167,139,250,.5);background:rgba(167,139,250,.12);color:#C4B5FD;font:600 12.5px/1 "Inter",-apple-system,system-ui,sans-serif;letter-spacing:.03em;cursor:pointer;text-shadow:0 0 14px rgba(167,139,250,.5)}'
    + '.tmw-dt .dt-cta:hover{background:rgba(167,139,250,.18)}'
    + '.tmw-ov-feedback > .tmw-ov-intel-foot .ai{color:#B9A6FF;font-weight:600}'
    + '.tmw-ov-feedback > .tmw-ov-intel-foot b{color:#ECEAE5;font-weight:600}'
    /* margin-left:auto keeps the actions right even when there is NO byline
       (error / no-grounding answers), preserving the old right-alignment. */
    + '.tmw-ov-fb-actions{flex:0 0 auto;margin-left:auto}'
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
    +   '.tmw-ov-feedback{gap:10px}'
    /* Byline takes the full width and wraps to a 2nd line if long; the actions
       drop below it (they won't fit on the same line on mobile). */
    +   '.tmw-ov-feedback > .tmw-ov-intel-foot{flex-basis:100%;font-size:12.5px}'
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
    /* Desktop reserves room on the right for the in-bar Deep chip + go arrow. */
    + '.tmw-ov-bar .tmw-dock-search input{width:100%!important;padding-right:156px;font-size:14px}'
    /* Mobile: pill a touch taller than the dock's 42px; placeholder 1pt below
       the input's 16px (the host page's iOS anti-zoom rule keeps the INPUT at
       16px — only the placeholder shrinks, so focus-zoom stays disabled). */
    + '@media(max-width:640px){.tmw-ov-bar .tmw-dock-search input{padding-right:48px;height:48px}'
    + '.tmw-ov-bar .tmw-dock-search input::placeholder{font-size:15px}}'
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

    /* ─── DEEP MODE (Pro) — toggle chip + Gemini-style pulsing glow ─────── */
    /* A big, soft, breathing aurora that fades in behind ALL overlay content
       (starter homepage AND in-chat results) the moment Deep is flicked on. Two
       blurred radial blooms drift + pulse; screen-blended over the dark scrim so
       it reads as ambient light, not a shape. pointer-events:none — purely
       decorative, never intercepts a click. */
    + '.tmw-ov-glow{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:0;overflow:hidden;transition:opacity .7s ease}'
    + '.tmw-ov-root[data-deep="1"] .tmw-ov-glow{opacity:1}'
    + '.tmw-ov-glow b{position:absolute;border-radius:50%;filter:blur(72px);mix-blend-mode:screen;display:block}'
    + '.tmw-ov-glow b.a{width:66vw;height:66vw;left:4vw;bottom:-20vw;background:radial-gradient(circle,rgba(139,92,246,.58),rgba(139,92,246,0) 66%);animation:tmwOvGlowA 7s ease-in-out infinite}'
    + '.tmw-ov-glow b.b{width:66vw;height:66vw;right:4vw;bottom:-20vw;background:radial-gradient(circle,rgba(96,120,255,.5),rgba(96,120,255,0) 66%);animation:tmwOvGlowB 9s ease-in-out infinite}'
    + '.tmw-ov-glow b.c{width:44vw;height:44vw;left:28vw;top:-16vw;background:radial-gradient(circle,rgba(185,166,255,.32),rgba(185,166,255,0) 68%);animation:tmwOvGlowC 11s ease-in-out infinite}'
    + '@keyframes tmwOvGlowA{0%,100%{transform:translate(0,0) scale(1);opacity:.55}50%{transform:translate(6vw,-4vw) scale(1.24);opacity:.9}}'
    + '@keyframes tmwOvGlowB{0%,100%{transform:translate(0,0) scale(1.05);opacity:.42}50%{transform:translate(-5vw,-6vw) scale(1.3);opacity:.72}}'
    + '@keyframes tmwOvGlowC{0%,100%{transform:translate(0,0) scale(1);opacity:.3}50%{transform:translate(-4vw,5vw) scale(1.22);opacity:.6}}'
    + '@media(prefers-reduced-motion:reduce){.tmw-ov-glow b{animation:none!important}}'
    /* When Deep is armed, the search bar itself gains a soft purple halo that
       gently breathes, so it\'s obvious the next question runs deep. */
    + '.tmw-ov-root[data-deep="1"] .tmw-ov-bar .tmw-dock-search input{border-color:rgba(167,139,250,.55)!important;animation:tmwOvDeepBar 3.4s ease-in-out infinite}'
    + '@keyframes tmwOvDeepBar{0%,100%{box-shadow:0 0 22px rgba(139,92,246,.32)}50%{box-shadow:0 0 40px rgba(139,92,246,.55)}}'
    /* Deep toggle chip — shared look; positioned two ways (see below). */
    + '.tmw-ov-deep{display:inline-flex;align-items:center;gap:7px;padding:5px 10px 5px 11px;border-radius:999px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(20,20,25,.6);color:#C9C4D6;font:600 12px/1 "Inter",-apple-system,system-ui,sans-serif;letter-spacing:.02em;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:border-color .25s,color .25s,background .25s,box-shadow .25s}'
    + '.tmw-ov-deep:hover{border-color:rgba(167,139,250,.5);color:#EFEAFB}'
    + '.tmw-ov-deep .dico{display:flex;width:14px;height:14px;color:#B9A6FF}'
    + '.tmw-ov-deep .dico svg{width:14px;height:14px}'
    + '.tmw-ov-deep .dsw{width:26px;height:15px;border-radius:999px;background:rgba(255,255,255,.16);position:relative;transition:background .25s ease;flex:0 0 auto}'
    + '.tmw-ov-deep .dsw i{position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#EDEBF3;transition:transform .25s ease}'
    + '.tmw-ov-deep[aria-pressed="true"]{border-color:rgba(167,139,250,.7);color:#fff;background:linear-gradient(135deg,rgba(139,92,246,.34),rgba(96,120,255,.24));box-shadow:0 0 22px rgba(139,92,246,.45)}'
    + '.tmw-ov-deep[aria-pressed="true"] .dico{color:#DBCFFF}'
    + '.tmw-ov-deep[aria-pressed="true"] .dsw{background:linear-gradient(135deg,#8b5cf6,#6078ff)}'
    + '.tmw-ov-deep[aria-pressed="true"] .dsw i{transform:translateX(11px)}'
    /* DESKTOP: the in-bar copy sits inside the search bar, left of the go arrow. */
    + '.tmw-ov-deep.in-bar{position:absolute;right:50px;top:50%;transform:translateY(-50%);z-index:3;font-size:11.5px}'
    /* The top-left copy is mobile-only; hidden on desktop. */
    + '.tmw-ov-deep.top{display:none;position:absolute;top:18px;left:22px;height:38px;z-index:3}'
    /* Cap meter — a small caption pinned just above the bar, right-aligned. */
    + '.tmw-ov-deep-meta{position:absolute;right:6px;bottom:100%;margin-bottom:9px;z-index:3;pointer-events:none;font:600 11px/1.3 "Inter",-apple-system,system-ui,sans-serif;color:#9C93B5;letter-spacing:.01em}'
    + '.tmw-ov-deep-meta.warn{color:#E6C574}'
    + '.tmw-ov-deep-meta.buy{pointer-events:auto}'
    /* "Buy more" pills shown in the meter when a member is out of deep searches. */
    + '.tmw-ov-buy{display:inline-flex;align-items:center;margin-left:8px;padding:3px 9px;border-radius:999px;border:1px solid rgba(167,139,250,.6);background:rgba(139,92,246,.18);color:#EBE4FF;font:700 11px/1 "Inter",-apple-system,system-ui,sans-serif;cursor:pointer;letter-spacing:.01em}'
    + '.tmw-ov-buy:hover{background:rgba(139,92,246,.34)}'
    /* Purchase-confirmation toast (shown on the paid return). */
    + '.tmw-ov-toast{position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:2147483000;background:linear-gradient(135deg,#8b5cf6,#6078ff);color:#fff;font:600 13px/1.3 "Inter",-apple-system,system-ui,sans-serif;padding:11px 18px;border-radius:999px;box-shadow:0 8px 30px rgba(139,92,246,.5);opacity:0;transition:opacity .3s ease}'
    + '.tmw-ov-toast.show{opacity:1}'
    /* MOBILE: swap the in-bar chip for the top-left one (aligned with New chat). */
    + '@media(max-width:640px){'
    +   '.tmw-ov-deep.in-bar{display:none}'
    +   '.tmw-ov-deep.top{display:inline-flex;top:14px;left:16px;height:34px;padding:0 12px;font-size:11px}'
    /* Dark gradient behind the top buttons (Deep / New chat / X) so chat scrolling
       behind them stays legible. */
    +   '.tmw-ov-lb::before{content:"";position:absolute;top:0;left:0;right:0;height:104px;pointer-events:none;z-index:2;background:linear-gradient(180deg,rgba(7,8,7,.96) 0%,rgba(7,8,7,.72) 46%,transparent 100%)}'
    /* When Deep is armed, the top band turns into a pulsing purple glow (not just
       a dark scrim) so the mode reads at the top of the screen too. */
    +   '.tmw-ov-root[data-deep="1"] .tmw-ov-lb::before{height:150px;background:linear-gradient(180deg,rgba(96,60,180,.9) 0%,rgba(76,54,150,.55) 42%,rgba(40,30,90,.18) 74%,transparent 100%);animation:tmwOvTopPulse 4s ease-in-out infinite}'
    /* Bottom fade behind the search bar — kept short so it doesn\'t wash up the page. */
    +   '.tmw-ov-lb::after{height:132px;background:linear-gradient(180deg,transparent 0%,rgba(7,8,7,.55) 48%,rgba(7,8,7,.96) 82%)}'
    /* Bigger, brighter aurora on mobile so Deep lights the whole background. */
    +   '.tmw-ov-glow b.a{width:135vw;height:135vw;left:-32vw;bottom:-42vw;background:radial-gradient(circle,rgba(139,92,246,.78),rgba(139,92,246,0) 68%)}'
    +   '.tmw-ov-glow b.b{width:125vw;height:125vw;right:-38vw;bottom:-30vw;background:radial-gradient(circle,rgba(96,120,255,.6),rgba(96,120,255,0) 68%)}'
    +   '.tmw-ov-glow b.c{width:110vw;height:110vw;left:-5vw;top:-30vw;background:radial-gradient(circle,rgba(185,166,255,.5),rgba(185,166,255,0) 70%)}'
    + '}'
    + '@keyframes tmwOvTopPulse{0%,100%{opacity:.72}50%{opacity:1}}'
    /* Deep answers are multi-paragraph — render the \\n\\n breaks the worker keeps. */
    + '.tmw-ov-intel-ans.deep{white-space:pre-line}'
    /* The base model badge is globally hidden (moved to the "i" button), but the
       DEEP badge must always show next to the title — override the hide for it. */
    + '.tmw-ov-model.deep{display:inline-flex!important;align-items:center;background:linear-gradient(135deg,rgba(139,92,246,.4),rgba(96,120,255,.32));color:#EBE4FF;border-color:rgba(167,139,250,.5)}'

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
    + '.tmw-ov-ans-link{color:#B9A6FF;text-decoration:none;border-bottom:1px solid rgba(185,166,255,.35);transition:border-color .15s,color .15s}'
    + '.tmw-ov-ans-link:hover{color:#D4C7FF;border-bottom-color:rgba(185,166,255,.85)}'
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
    /* The "TMW Intelligence" header stays PURPLE everywhere (brand), even in the
       gold-accented gate — only the CTA button carries the gold. */
    + '.tmw-ov-pro-btn{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:12px 20px;border:0;border-radius:11px;cursor:pointer;'
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
    /* Status text keeps its lifecycle color (matches the row badges). */
    + '.tmw-ov-pcard-body .meta .st{font-weight:600}'
    + '.tmw-ov-pcard-body .meta .st.sb-construction,.tmw-ov-pcard-body .meta .st.sb-breaking{color:#f0d68a}'
    + '.tmw-ov-pcard-body .meta .st.sb-soon{color:#FFB86b}'
    + '.tmw-ov-pcard-body .meta .st.sb-open{color:#42EB81}'
    + '.tmw-ov-pcard-body .meta .st.sb-announced{color:#9AA39C}'
    + '.tmw-ov-pcard-body .meta .st.sb-journal{color:#f0d68a}'
    /* Embedded project-view frame — fills the ANSWER BUBBLE (not the screen).
       The host bubble is forced to a fixed height while open so every embed is
       the same size regardless of the original answer height; X returns. */
    + '.tmw-ov-projview{position:absolute;inset:0;z-index:9;display:none;background:#0a0c0a;border-radius:inherit;overflow:hidden}'
    + '.tmw-ov-projview.open{display:block}'
    + '.tmw-ov-projview-body{width:100%;height:100%;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;background:#0b0d0b}'
    /* ── Native project card (replaces the iframe embed) ── */
    + '.tmw-pv{display:flex;flex-direction:column;color:#fff;height:100%}'
    /* Card fills the frame exactly; hero flexes (grow + shrink) to absorb the
       slack so the whole card fits with no scroll, CTAs anchored at the bottom. */
    + '.tmw-pv-hero{position:relative;width:100%;flex:1 1 200px;min-height:150px;background:#151815;overflow:hidden}'
    + '.tmw-pv-track{display:flex;width:100%;height:100%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}'
    + '.tmw-pv-track::-webkit-scrollbar{display:none}'
    + '.tmw-pv-track img{width:100%;height:100%;flex:0 0 100%;object-fit:cover;scroll-snap-align:center;display:block}'
    + '.tmw-pv-hero .scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(8,9,8,.96) 2%,rgba(8,9,8,.5) 26%,transparent 55%);pointer-events:none}'
    + '.tmw-pv-arrow{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:38px;border-radius:50%;background:rgba(10,12,10,.6);border:1px solid rgba(255,255,255,.22);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}'
    + '.tmw-pv-arrow.prev{left:14px}.tmw-pv-arrow.next{right:14px}'
    + '.tmw-pv-arrow svg{width:16px;height:16px}'
    + '.tmw-pv-count{position:absolute;bottom:14px;right:16px;z-index:2;font-size:11px;letter-spacing:.04em;color:#cfd6cf;background:rgba(10,12,10,.6);border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:3px 9px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}'
    + '.tmw-pv-badge{position:absolute;left:18px;bottom:16px;z-index:2;display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:6px 12px;border-radius:999px;background:rgba(10,12,10,.66);border:1px solid rgba(255,255,255,.16);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}'
    + '.tmw-pv-badge i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}'
    + '.tmw-pv-badge.sb-construction,.tmw-pv-badge.sb-breaking{color:#f0d68a}.tmw-pv-badge.sb-soon{color:#FFB86b}.tmw-pv-badge.sb-open{color:#42EB81}.tmw-pv-badge.sb-announced{color:#9AA39C}'
    + '.tmw-pv-body{padding:4px 22px 26px;display:flex;flex-direction:column;gap:16px}'
    + '.tmw-pv-title{font-family:"Fraunces",Georgia,serif;font-size:30px;line-height:1.05;font-weight:600;letter-spacing:-.02em;margin:0}'
    + '.tmw-pv-loc{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:#9AA39C;margin-top:-8px}'
    /* status spine */
    + '.tmw-pv-spine{margin:2px 0}'
    + '.tmw-pv-spine-bar{position:relative;height:5px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}'
    + '.tmw-pv-spine-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,#7b5cff,#9b7bff)}'
    + '.tmw-pv-spine-stages{display:flex;justify-content:space-between;margin-top:8px;gap:4px}'
    + '.tmw-pv-spine-stages span{font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:#6f776f;white-space:nowrap}'
    + '.tmw-pv-spine-stages span.on{color:#b9a6ff;font-weight:700}'
    /* stat tiles */
    + '.tmw-pv-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}'
    + '.tmw-pv-stat{background:#141714;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 13px;min-width:0}'
    + '.tmw-pv-stat .v{font-size:18px;font-weight:600;color:#fff;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.tmw-pv-stat .k{font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:#8b938b;margin-top:3px}'
    + '.tmw-pv-desc{font-size:14.5px;line-height:1.55;color:#d7ddd7;margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}'
    + '.tmw-pv-cta{display:flex;gap:8px;flex-wrap:nowrap;margin-top:2px}'
    + '.tmw-pv-cta .tmw-pv-btn{flex:1 1 0;min-width:0;justify-content:center;text-align:center;white-space:nowrap;padding:13px 12px}'
    + '@media(max-width:430px){.tmw-pv-cta .tmw-pv-btn{font-size:12px;gap:5px}.tmw-pv-cta .tmw-pv-btn svg{width:13px;height:13px}}'
    + '.tmw-pv-btn{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;padding:11px 16px;border-radius:12px;cursor:pointer;text-decoration:none;transition:transform .15s,background .15s,border-color .15s}'
    + '.tmw-pv-btn.primary{background:#fff;color:#0b0d0b;border:1px solid #fff}'
    + '.tmw-pv-btn.primary:hover{transform:translateY(-1px)}'
    + '.tmw-pv-btn.ghost{background:rgba(255,255,255,.04);color:#fff;border:1px solid rgba(255,255,255,.2)}'
    + '.tmw-pv-btn.ghost:hover{border-color:rgba(255,255,255,.4)}'
    + '.tmw-pv-btn svg{width:15px;height:15px}'
    /* Watch button on the project card — purple, flips gold when watching */
    + '.tmw-pv-btn.watch{background:rgba(167,139,250,.12);color:#B9A6FF;border:1px solid rgba(167,139,250,.4)}'
    + '.tmw-pv-btn.watch:hover{border-color:rgba(167,139,250,.7);transform:translateY(-1px)}'
    + '.tmw-pv-btn.watch.on{background:rgba(230,197,116,.14);color:#f0d68a;border:1px solid rgba(230,197,116,.6);box-shadow:0 0 16px rgba(230,197,116,.45)}'
    + '.tmw-pv-btn.watch.on:hover{border-color:rgba(230,197,116,.85);box-shadow:0 0 22px rgba(230,197,116,.65)}'
    + '.tmw-pv-btn.watch .ic-check{display:none}'
    + '.tmw-pv-btn.watch.on .ic-bell{display:none}'
    + '.tmw-pv-btn.watch.on .ic-check{display:inline-block}'
    /* Developer / architect firm chips — clickable pill + arrow (matches SEO pages) */
    + '.tmw-pv-firms{display:flex;flex-wrap:wrap;gap:16px}'
    + '.tmw-pv-fgroup{min-width:0}'
    + '.tmw-pv-fk{font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:#8b938b;margin-bottom:6px}'
    + '.tmw-pv-fchips{display:flex;flex-wrap:wrap;gap:6px}'
    + '.tmw-pv-firm{display:inline-flex;align-items:center;max-width:100%;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);font-size:13px;font-weight:600;color:#fff;text-decoration:none;line-height:1;box-sizing:border-box;transition:border-color .15s,background .15s}'
    + '.tmw-pv-firm .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + 'a.tmw-pv-firm::after{content:"\\2197";font-size:12px;margin-left:6px;color:#1FDF67;opacity:.75}'
    + 'a.tmw-pv-firm:hover{border-color:rgba(31,223,103,.5);background:rgba(31,223,103,.10)}'
    + '.tmw-pv-firm.is-plain{color:#C2C9C3;cursor:default}'
    /* ── Native map card ── */
    + '@media(max-width:700px){.tmw-pv-hero{flex-basis:170px;min-height:130px}.tmw-pv-title{font-size:24px}.tmw-pv-body{padding:4px 16px 18px;gap:11px}.tmw-pv-stat .v{font-size:16px}.tmw-pv-desc{-webkit-line-clamp:2}}'
    /* Inline answer card (results hero) gets the bordered card look at every
       size. Scoped to .tmw-ov-sec so the fullscreen project view panel stays
       full-bleed. */
    + '.tmw-ov-sec .tmw-pv{height:auto;border-radius:20px;overflow:hidden;background:#0f120f;border:1px solid rgba(255,255,255,.08)}'
    + '.tmw-ov-sec .tmw-pv .tmw-pv-body{padding-top:16px}'
    /* The status badge is redundant on the answer card — the timeline spine
       right below the photo already says it. (Fullscreen panel keeps it.) */
    + '.tmw-ov-sec .tmw-pv .tmw-pv-badge{display:none}'
    /* Mobile: the answer card's photo was clamping to the generic 170px
       basis — give it real height. */
    + '@media(max-width:700px){.tmw-ov-sec .tmw-pv .tmw-pv-hero{flex-basis:250px;min-height:250px}}'
    /* Desktop: the inline answer card goes 2-column — image fills the left
       half at full card height, content on the right. */
    + '@media(min-width:860px){'
    +   '.tmw-ov-sec .tmw-pv{display:grid;grid-template-columns:1.08fr 1fr;align-items:stretch}'
    +   '.tmw-ov-sec .tmw-pv .tmw-pv-hero{flex:initial;height:100%;min-height:440px}'
    +   '.tmw-ov-sec .tmw-pv .tmw-pv-hero .scrim{background:linear-gradient(to top,rgba(8,9,8,.72) 0%,rgba(8,9,8,.28) 22%,transparent 48%)}'
    +   '.tmw-ov-sec .tmw-pv .tmw-pv-body{padding:26px 28px;justify-content:center;gap:15px;min-width:0}'
    +   '.tmw-ov-sec .tmw-pv .tmw-pv-desc{-webkit-line-clamp:4}'
    + '}'
    + '[data-state="results"].tmw-ov-proj-open{position:relative;height:min(660px,78vh)!important;min-height:0!important;padding:0!important;overflow:hidden;border-radius:18px!important}'
    /* Mobile: cap the embed so its bottom sits ABOVE the floating Onyx search
       bar (the dock) instead of scrolling behind it — leave room for the dock
       + the query bubble above. */
    + '@media(max-width:700px){[data-state="results"].tmw-ov-proj-open{height:min(660px,calc(100dvh - 210px))!important}}'
    + '.tmw-ov-projview-x{position:absolute;top:16px;right:18px;z-index:2;width:42px;height:42px;border-radius:50%;'
    + 'background:rgba(10,12,10,.72);border:1px solid rgba(255,255,255,.2);color:#fff;display:flex;align-items:center;justify-content:center;'
    + 'cursor:pointer;padding:0;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:background .15s,transform .15s}'
    + '.tmw-ov-projview-x:hover{background:rgba(26,26,32,.92);transform:scale(1.05)}'
    + '.tmw-ov-projview-x svg{width:17px;height:17px;display:block}'

    /* Firms & places chiprow */
    /* Firm / place cards — proper cards in the firm-SEO style (monogram + gold
       role + serif name + count + arrow), 2-up grid. Replaces the old cramped
       icon-row .tmw-ov-entity. */
    + '.tmw-ov-chiprow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}'
    + '@media(max-width:860px){.tmw-ov-chiprow{grid-template-columns:repeat(2,minmax(0,1fr))}}'
    + '@media(max-width:560px){.tmw-ov-chiprow{grid-template-columns:1fr}}'
    + '.tmw-ov-firmcard{display:flex;align-items:center;gap:14px;background:#141714;'
    + 'border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:13px 16px;'
    + 'text-decoration:none;color:inherit;transition:border-color .2s,background .2s,transform .15s}'
    + '.tmw-ov-firmcard:hover{border-color:rgba(230,197,116,.42);background:#181b18;transform:translateY(-1px)}'
    + '.tmw-ov-firmcard .fc-mark{width:50px;height:50px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;'
    + 'border-radius:11px;background:linear-gradient(140deg,#23281f,#15181a);border:1px solid rgba(230,197,116,.22);'
    + 'font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:25px;color:#e6c574;line-height:1}'
    + '.tmw-ov-firmcard .fc-mark svg{width:21px;height:21px;color:#e6c574}'
    + '.tmw-ov-firmcard .fc-body{flex:1 1 auto;min-width:0}'
    + '.tmw-ov-firmcard-slim{padding:15px 18px}'
    + '.tmw-ov-firmcard-slim .fc-meta{margin-top:3px}'
    + '.tmw-ov-firmcard .fc-role{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#e6c574;font-weight:600}'
    + '.tmw-ov-firmcard .fc-name{font-family:"Fraunces",Georgia,serif;font-size:17px;color:#fff;font-weight:600;line-height:1.2;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.tmw-ov-firmcard .fc-meta{font-size:11px;color:#9AA39C;margin-top:3px}'
    + '.tmw-ov-firmcard .fc-arrow{flex:0 0 auto;color:#6c706c;display:flex;align-items:center;transition:color .2s,transform .2s}'
    + '.tmw-ov-firmcard .fc-arrow svg{width:16px;height:16px}'
    + '.tmw-ov-firmcard:hover .fc-arrow{color:#e6c574;transform:translateX(3px)}'

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
    + '.tmw-ov-card-hidden{display:none}'  /* grid tiles past the first page, revealed by Load more */

    + '.tmw-ov-hidden{display:none!important}'

    + '@media(max-width:760px){'
    +   '.tmw-ov-hero{grid-template-columns:1fr}'
    +   '.tmw-ov-hero .media{min-height:180px}'
    +   '.tmw-ov-bar{bottom:18px;width:calc(100vw - 22px)}'
    +   '.tmw-ov-row .r-bar{display:none}'
    +   '.tmw-ov-close{top:14px;right:14px;width:34px;height:34px}'
    /* Clear the dock (bar + deep-meta) AND iOS Safari\'s bottom toolbar / home
       indicator so the last line of an answer never hides under the search bar. */
    +   '.tmw-ov-body{padding:8px 0 calc(120px + env(safe-area-inset-bottom,0px))}'
    +   '.tmw-ov-dock{padding-bottom:calc(18px + env(safe-area-inset-bottom,0px))}'
    +   '.tmw-ov-wrap{padding:0 16px}'
    /* Mobile scroll LAG: a full-screen backdrop-blur re-composites every frame
       while the lightbox scrolls (same problem the /map/ surface had — see the
       .tmw-surf-map override above). Drop the blur on small screens and lean on a
       near-opaque fill so scrolling stays smooth. */
    +   '.tmw-ov-scrim{-webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(7,8,7,.97)}'
    + '}';

  // Inject styles once
  if (!document.querySelector('style[data-tmw-overlay]')) {
    var styleEl = document.createElement('style');
    styleEl.setAttribute('data-tmw-overlay', '');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  // ── DOM ─────────────────────────────────────────────────────────────
  // Deep-mode sparkle — a four-point star with a small companion, the Gemini-ish
  // "smarter mode" glyph. Uses currentColor so the toggle can tint it purple.
  var ICON_DEEP = ''
    + '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    +   '<path d="M12 2c.3 3.3 1.9 5 5.2 5.3-3.3.3-4.9 2-5.2 5.3-.3-3.3-1.9-5-5.2-5.3C10.1 7 11.7 5.3 12 2Z"/>'
    +   '<path d="M18.5 13.2c.16 1.8 1.04 2.7 2.85 2.9-1.81.15-2.69 1.05-2.85 2.9-.16-1.85-1.04-2.75-2.85-2.9 1.81-.2 2.69-1.1 2.85-2.9Z"/>'
    + '</svg>';

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

  // Direction A starter — three quiet hairline suggestion rows (serif text +
  // a faint arrow). Reuses the generic [data-q] click handler that runs a query.
  var STARTER_ROW_AR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  var STARTER_ROWS_HTML = STARTER_CHIPS.slice(0, 3).map(function(q){
    return '<button class="tmw-ov-qrow" type="button" data-q="' + esc(q) + '">'
      +    '<span class="tmw-ov-qrow-t">' + esc(q) + '</span>'
      +    '<span class="tmw-ov-qrow-ar">' + STARTER_ROW_AR + '</span>'
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
    // No account → an account is required to try Intelligence; prompt to sign up
    // rather than showing a free-quota they can't actually spend.
    var signedIn = window.tmwIntel.signedIn ? window.tmwIntel.signedIn() : true;
    if (!signedIn) {
      var _al = window.tmwIntel.anonLeft ? window.tmwIntel.anonLeft() : ((window.tmwIntel && window.tmwIntel.ANON_FREE) || 2);
      if (_al > 0) return '<span class="tmw-ov-quota' + (_al <= 1 ? ' low' : '') + '">' + _al + ' free preview' + (_al === 1 ? '' : 's') + '</span>';
      return '<a class="tmw-ov-pro" data-tmw-signup href="#">Sign up to try</a>';
    }
    var left = window.tmwIntel.left ? window.tmwIntel.left() : ((window.tmwIntel && window.tmwIntel.FREE) || 5);
    var lowCls = left <= 3 ? ' low' : '';
    return '<span class="tmw-ov-quota'+lowCls+'">' + left + ' / ' + ((window.tmwIntel && window.tmwIntel.FREE) || 5) + ' left</span>'
      + '<a class="tmw-ov-pro" href="https://www.oftmw.com/map/?upgrade=1" data-tmw-paywall="feature:intelligence">PRO</a>';
  }
  function refreshProPill(){
    var slot = root.querySelector('[data-pill-slot]');
    if (slot) slot.innerHTML = renderProPill();
  }
  // Let the shared quota object refresh the pill live whenever the server-side,
  // account-bound remaining changes (sync on open, consume after a query).
  try { if (window.tmwIntel) window.tmwIntel._onChange = refreshProPill; } catch (e) {}

  // Per-turn answer block (chat thread). One of these is created for every query
  // and appended to .tmw-ov-thread; the render functions write into ITS slots
  // (re-pointed by newTurn). Same markup the single results view used before.
  var TURN_ANSWER_HTML = ''
    + '<div class="tmw-ov-thinking" data-state="thinking">'
    +   '<div class="dots"><span></span><span></span><span></span></div>'
    +   '<span>Searching the database</span>'
    + '</div>'
    + '<div data-state="results" class="tmw-ov-hidden">'
    +   '<button class="tmw-ov-info" type="button" aria-label="Powered by TMW Intelligence, Onyx 5"><span aria-hidden="true">i</span><span class="tmw-ov-info-pop">TMW Intelligence · Onyx 5</span></button>'
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
    +       '<button class="tmw-ov-share-btn" type="button" aria-label="Share this answer" title="Copy a shareable link to this answer">'
    +         '<svg class="ic-share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>'
    +         '<svg class="ic-copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
    +         '<span class="tmw-ov-share-txt">Share</span>'
    +       '</button>'
    +       '<button class="tmw-ov-watch-btn" type="button" aria-label="Watch this — get proactive alerts on this">'
    +         '<svg class=\"ic-bell\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9\"/><path d=\"M13.7 21a2 2 0 0 1-3.4 0\"/></svg><svg class=\"ic-check\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 6L9 17l-5-5\"/></svg>'
    +         '<span class="tmw-ov-watch-txt">Watch this</span>'
    +       '</button>'
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
    +   '<h3>We came up empty on that one</h3>'
    +   '<p>Try a firm, a city, or a specific project name, or ask again in a moment and Onyx will take another pass.</p>'
    + '</div>';

  var root = document.createElement('div');
  root.className = 'tmw-ov-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'TMW search & Intelligence');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = ''
    + '<div class="tmw-ov-scrim"></div>'
    + '<div class="tmw-ov-lb">'
    +   '<div class="tmw-ov-glow" aria-hidden="true"><b class="a"></b><b class="b"></b><b class="c"></b></div>'
    +   '<button class="tmw-ov-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
    +   '<button class="tmw-ov-newchat" type="button" aria-label="New chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>New chat</button>'
    +   '<button class="tmw-ov-history" type="button" aria-label="Past chats" title="Past chats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.3L2 8"/><path d="M2 3v5h5"/><path d="M12 8v4.5l3 1.8"/></svg><span class="tmw-ov-history-lbl">Past chats</span></button>'
    /* Deep toggle — MOBILE lives top-left, aligned with New chat (desktop uses the in-bar copy). */
    +   '<button type="button" class="tmw-ov-deep top" data-deep-toggle aria-pressed="false" title="Deep search — wide-context analysis across the whole pipeline (Pro)">'
    +     '<span class="dico">' + ICON_DEEP + '</span>'
    +     '<span class="dlbl">Deep</span>'
    +     '<span class="dsw"><i></i></span>'
    +   '</button>'
    +   '<div class="tmw-ov-body">'
    +     '<div class="tmw-ov-wrap">'

    +       '<div class="tmw-ov-starter" data-state="starter">'
    +         '<div class="tmw-ov-teach" role="region" aria-label="TMW Intelligence">'
    +           '<div class="tmw-ov-teach-h">'
    +             '<div class="tmw-ov-teach-hex">' + ICON_HEX + '</div>'
    +             '<span class="tmw-ov-teach-ttl">TMW Intelligence</span>'
    +             '<span class="tmw-ov-pill" data-pill-slot></span>'
    +           '</div>'
    +           '<h2 class="tmw-ov-prompt">What do you want to know?'
    +             '<span class="tmw-ov-prompt-sub">Ask about any project, firm, or place we track.</span>'
    +           '</h2>'
    +           '<div class="tmw-ov-qlist">' + STARTER_ROWS_HTML + '</div>'
    +         '</div>'
    +       '</div>'

    +       '<div class="tmw-ov-thread"></div>'

    +     '</div>'
    +   '</div>'
    /* Bottom dock holds the search bar. (Thumbs feedback now lives per-answer,
       bottom-right of each turn, not in the dock.) */
    +   '<div class="tmw-ov-dock">'
    +     '<div class="tmw-ov-bar">'
    +       '<span class="tmw-ov-deep-meta" data-deep-meta></span>'
    +       '<form class="tmw-ov-bar-inner tmw-dock-search" role="search">'
    +         '<span class="ds-ico">' + ICON_SEARCH_DOCK + '</span>'
    +         '<input type="search" autocomplete="off" placeholder="Search projects, firms, places and more.." aria-label="Search projects, firms, places and more">'
    /* Deep toggle — DESKTOP lives inside the bar, just left of the go button. */
    +         '<button type="button" class="tmw-ov-deep in-bar" data-deep-toggle aria-pressed="false" title="Deep search — wide-context analysis across the whole pipeline (Pro)">'
    +           '<span class="dico">' + ICON_DEEP + '</span>'
    +           '<span class="dlbl">Deep</span>'
    +           '<span class="dsw"><i></i></span>'
    +         '</button>'
    +         '<button class="go" type="button" aria-label="Run search (press Enter)" title="Press Enter to search">'
    +           '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
    +         '</button>'
    +       '</form>'
    +     '</div>'  /* close .tmw-ov-bar */
    +   '</div>'    /* close .tmw-ov-dock */
    /* Embedded project view — clicking a project opens its full SEO page in a
       fixed-size frame here (incl. the "view on map" button) instead of leaving
       Onyx. The X returns to the query result. */
    +   '<div class="tmw-ov-histpanel" aria-hidden="true">'
    +     '<div class="tmw-ov-histpanel-head">'
    +       '<span class="tmw-ov-histpanel-ttl">Past chats</span>'
    +       '<button class="tmw-ov-histpanel-x" type="button" aria-label="Close past chats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
    +     '</div>'
    +     '<div class="tmw-ov-histpanel-body"></div>'
    +   '</div>'
    +   '<div class="tmw-ov-projview" aria-hidden="true">'
    +     '<button class="tmw-ov-projview-x" type="button" aria-label="Close project view">'
    +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    +     '</button>'
    +     '<div class="tmw-ov-projview-body"></div>'
    +   '</div>'
    + '</div>';    /* close .tmw-ov-lb */

  // Mount when body is available
  function mountRoot(){
    if (document.body) document.body.appendChild(root);
    else document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(root); });
  }
  mountRoot();

  // Relocate the grounding byline ("Onyx 5 · Grounded in …") OUT of the intel
  // panel and DOWN into that turn's feedback row, so it sits on the same bottom
  // line as Watch / thumbs (below the hero card + project/article grids) on
  // desktop, and wraps to its own line(s) above the actions on mobile. The intel
  // panel re-renders async as the answer arrives, so a MutationObserver keeps the
  // byline relocated across every re-render (it settles: once moved out of the
  // panel it no longer matches, so no loop).
  function relocateBylines(){
    try {
      var foots = root.querySelectorAll('.tmw-ov-intel-panel .tmw-ov-intel-foot.has-ground');
      for (var i = 0; i < foots.length; i++) {
        var foot = foots[i];
        var turn = foot.closest && foot.closest('.tmw-ov-turn'); if (!turn) continue;
        var fb = turn.querySelector('.tmw-ov-feedback'); if (!fb) continue;
        var actions = fb.querySelector('.tmw-ov-fb-actions'); if (!actions) continue;
        var stale = fb.querySelector(':scope > .tmw-ov-intel-foot'); if (stale && stale !== foot) stale.remove();
        fb.insertBefore(foot, actions);
      }
    } catch (e) {}
  }
  try {
    new MutationObserver(function(){ relocateBylines(); }).observe(root, { childList: true, subtree: true });
  } catch (e) {}

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

  // ─── DEEP MODE (Pro) — wide-context analyst search ─────────────────────
  // Flicking Deep on arms the pulsing glow and routes the next question through
  // the worker's wide-context path (Sonnet over a much larger matched set). Pro
  // only; a free user who taps it gets the paywall instead. State persists per
  // device so it stays armed across visits.
  var DEEP_KEY = 'tmw_onyx_deep';
  var _deep = false;
  // Two copies of the toggle share one state: an in-bar chip (desktop) and a
  // top-left chip (mobile). CSS shows the right one per breakpoint.
  var deepBtns = root.querySelectorAll('[data-deep-toggle]');
  var deepMeta = root.querySelector('[data-deep-meta]');
  function _isPro(){
    try {
      if (window.tmwIntel && typeof window.tmwIntel.isPro === 'function' && window.tmwIntel.isPro()) return true;
    } catch(_){}
    return window._isPaidMember === true;
  }
  function setDeep(on){
    _deep = !!on;
    root.setAttribute('data-deep', _deep ? '1' : '0');
    for (var i = 0; i < deepBtns.length; i++) deepBtns[i].setAttribute('aria-pressed', _deep ? 'true' : 'false');
    if (deepMeta && !_deep) { deepMeta.textContent = ''; deepMeta.classList.remove('warn'); }
    try { localStorage.setItem(DEEP_KEY, _deep ? '1' : '0'); } catch(_){}
  }
  function _deepActive(){ return _deep && _isPro(); }
  // Model badge for the intel panel header. Defaults to the armed toggle state so
  // "Onyx 5 Deep" shows the moment a deep query is submitted; pass an explicit
  // bool (from the arrived answer) to force it after the fact.
  function modelBadgeHtml(deep){
    var on = (typeof deep === 'boolean') ? deep : _deepActive();
    return '<span class="tmw-ov-model' + (on ? ' deep' : '') + '" title="The model powering TMW Intelligence">' + (on ? 'Onyx 5 Deep' : 'Onyx 5') + '</span>';
  }
  // Sync a rendered panel's model badge to the answer's actual mode (a capped
  // deep request comes back standard, so downgrade the armed "Deep" badge).
  function syncModelBadge(slot, deep){
    if (!slot) return;
    var m = slot.querySelector('.tmw-ov-model');
    if (!m) return;
    if (deep) { m.classList.add('deep'); m.textContent = 'Onyx 5 Deep'; }
    else { m.classList.remove('deep'); m.textContent = 'Onyx 5'; }
  }
  // Reflect the worker's cap meta after each deep answer ("N of 12 deep left").
  function updateDeepMeta(res){
    if (!deepMeta) return;
    if (res && res.capped) {
      // Out of searches — offer the two credit packs inline.
      deepMeta.classList.add('warn'); deepMeta.classList.add('buy');
      deepMeta.innerHTML = '';
      var lbl = document.createElement('span'); lbl.textContent = 'Out of deep searches —';
      var b1 = document.createElement('button'); b1.type = 'button'; b1.className = 'tmw-ov-buy'; b1.textContent = '10 for $5'; b1.onclick = function(){ buyDeep('small'); };
      var b2 = document.createElement('button'); b2.type = 'button'; b2.className = 'tmw-ov-buy'; b2.textContent = '25 for $10'; b2.onclick = function(){ buyDeep('large'); };
      deepMeta.appendChild(lbl); deepMeta.appendChild(b1); deepMeta.appendChild(b2);
    } else if (res && res.deep && res.unlimited) {
      deepMeta.classList.remove('warn'); deepMeta.classList.remove('buy');
      deepMeta.textContent = 'Unlimited deep searches';
    } else if (res && res.deep && typeof res.remaining === 'number') {
      deepMeta.classList.remove('warn'); deepMeta.classList.remove('buy');
      var cap = res.cap || 12;
      // Base months read "N of 12"; once extra credits are in play just show the total.
      deepMeta.textContent = (res.remaining > cap)
        ? (res.remaining + ' deep searches left')
        : (res.remaining + ' of ' + cap + ' deep searches left this month');
    }
  }
  // Lightweight toast for the purchase return (the overlay may be closed).
  function deepToast(msg){
    try {
      var t = document.createElement('div'); t.className = 'tmw-ov-toast'; t.textContent = msg;
      document.body.appendChild(t);
      requestAnimationFrame(function(){ t.classList.add('show'); });
      setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 400); }, 4200);
    } catch(_){}
  }
  // Buy a credit pack — resolve the member, open Stripe Checkout.
  function buyDeep(pack){
    if (!_isPro()) { try { if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall('feature:deep'); } catch(_){} return; }
    _resolveMid().then(function(mid){
      if (!mid) { deepToast('Please sign in first'); return; }
      fetch(WORKER_URL + '/deep-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: mid, pack: pack, return_url: location.href }) })
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d && d.url) { window.location.href = d.url; } else { deepToast(d && d.error === 'pack not configured' ? 'Deep packs open soon' : 'Could not start checkout'); } })
        .catch(function(){ deepToast('Could not start checkout'); });
    });
  }
  // On the paid return (?deep_claim=<session>), confirm + grant, then toast.
  function claimDeepPurchase(){
    var sid = null;
    try { sid = new URLSearchParams(location.search).get('deep_claim'); } catch(_){}
    if (!sid) return;
    try { var u = new URL(location.href); u.searchParams.delete('deep_claim'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch(_){}
    fetch(WORKER_URL + '/deep-claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sid }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.ok) {
          deepToast(d.already ? 'Deep searches already added ✓' : ('✓ Added ' + (d.granted || '') + ' deep searches'));
          if (_isPro()) setDeep(true);
          if (typeof d.remaining === 'number') updateDeepMeta({ deep: true, remaining: d.remaining, cap: d.cap });
        } else { deepToast('Could not confirm purchase'); }
      })
      .catch(function(){});
  }
  // Restore prior state — only honor "on" for a Pro member.
  try { if (localStorage.getItem(DEEP_KEY) === '1' && _isPro()) _deep = true; } catch(_){}
  setDeep(_deep);
  for (var _di = 0; _di < deepBtns.length; _di++) {
    deepBtns[_di].addEventListener('click', function(){
      if (!_isPro()) {
        try {
          if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall('feature:deep');
          else window.location.href = 'https://www.oftmw.com/map/?upgrade=1';
        } catch(_){}
        return;
      }
      setDeep(!_deep);
    });
  }
  claimDeepPurchase();   // handle a returning Stripe checkout on any overlay-loaded page
  // The Intelligence gate's "Create a free account" button opens the signup modal.
  root.addEventListener('click', function(e){
    var b = e.target && e.target.closest && e.target.closest('[data-tmw-signup]');
    if (!b) return;
    e.preventDefault();
    try { if (typeof window.tmwAuthModal === 'function') window.tmwAuthModal('signup'); } catch(_){}
  });

  // ── data loading (mirrors /search/) ────────────────────────────────
  var PROJECTS = [], FIRMS = [], ARTICLES = [], DATA_READY = false, _loading = null;
  var MARKET_SLUGS = {};   // "City Name" -> market-page slug, for answer auto-linking (best-effort; see markets-index.json)
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
      __tmwSharedJson('https://www.oftmw.com/map/projects-flat.json').then(function(v){ return v || []; }),
      __tmwSharedJson('https://www.oftmw.com/map/firms-flat.json').then(function(v){ return v || []; }),
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
    // Best-effort: the market-page slug set for answer auto-linking. Non-blocking
    // and safe if the manifest isn't built yet (firm links still work).
    try {
      __tmwSharedJson('https://www.oftmw.com/markets-index.json')
        .then(function(mi){ if (mi && typeof mi === 'object' && !Array.isArray(mi)) MARKET_SLUGS = mi; })
        .catch(function(){});
    } catch (_) {}
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
  // Wellness/fitness is journal COVERAGE (pilates, biohacking, gyms, recovery,
  // longevity, spas), not a project type — route these to the text/article path
  // so they answer from our wellness articles instead of mis-matching a firm or
  // dumping a generic project pipeline. Mirrors the food gate.
  var WELLNESS_INTENT = {
    wellness:1, fitness:1, gym:1, gyms:1, pilates:1, yoga:1, spa:1, spas:1,
    sauna:1, saunas:1, biohacking:1, biohack:1, longevity:1, recovery:1,
    'reformer':1, wellbeing:1, 'well-being':1, holistic:1, healthclub:1,
    bathhouse:1, bathhouses:1, contrast:1, cryotherapy:1, cryo:1, ['cold-plunge']:1
  };
  function isWellnessQuery(q){
    var toks = norm(q).split(/\s+/);
    for (var i = 0; i < toks.length; i++){ if (WELLNESS_INTENT[toks[i]]) return true; }
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

  // ALL of a place's journal stories, geography-first (newest first). The old
  // bare term match over title+excerpt let name-collision stories pollute a
  // place's Journal tab — a "london" query pulled "The London" (an NYC hotel),
  // NYC restaurants debuting London concepts, and WPB golf. Geography outranks
  // words:
  //  · linked project sits in the place            → in
  //  · linked project sits in a DIFFERENT city     → out, whatever the text says
  //  · a curated category names the place          → in
  //  · a category names another covered city       → out
  //  · no geography signal at all                  → term match (title+excerpt)
  function articlesForPlace(placeName){
    var terms = placeAliasTerms(placeName) || [];
    if (!terms.length) return [];
    function hit(s){
      if (!s) return false;
      for (var i = 0; i < terms.length; i++){ if (terms[i] && s.indexOf(terms[i]) >= 0) return true; }
      return false;
    }
    var Core = window.TmwSearchCore, citySet = null;
    try { citySet = (Core && Core.buildCitySet) ? Core.buildCitySet(PROJECTS) : null; } catch(_){}
    // Same-family place names are NOT "another city": "Palm Beach" / "The Palm
    // Beaches" on a West Palm Beach query, "Miami Beach" on a Miami query.
    // Containment either way (with a plural strip) marks the family — without
    // this, the exclusion rules dropped nine legit Palm-Beaches stories from
    // the WPB Journal tab.
    function family(nc){
      if (!nc) return false;
      var ncs = nc.replace(/s$/, '');
      for (var i = 0; i < terms.length; i++){
        var t = terms[i]; if (!t) continue;
        if (nc.indexOf(t) >= 0 || t.indexOf(nc) >= 0) return true;
        if (ncs && (t.indexOf(ncs) >= 0 || ncs.indexOf(t) >= 0)) return true;
      }
      return false;
    }
    function isOtherCity(nc){
      if (!nc || family(nc)) return false;
      if (citySet && citySet.has(nc)) return true;
      return NYC_FAMILY.indexOf(nc) >= 0;   // "New York City" isn't a City-field value but IS a place
    }
    // Curated category → its place form: "The Palm Beaches" → "palm beaches",
    // "New York of Tomorrow" → "new york", "All Food & Drinks" → "food & drinks".
    function catPlace(c){
      return norm(c).replace(/^the /, '').replace(/^all /, '')
        .replace(/ of tomorrow$/, '').replace(/ food & drinks?$/, '');
    }
    return ARTICLES.filter(function(a){
      var pr = a.project_slug ? projBySlug()[a.project_slug] : null;
      if (pr){
        var pc = norm(String(pr.City || '').split(',')[0].trim());
        if (pc && family(pc)) return true;
        if (isOtherCity(pc)) return false;
      }
      // main_category is the editor's PRIMARY placement and outranks the
      // multi-tag list — "Gymkhana, London's ... debuts NYC concept" carries
      // BOTH a "London" and a "New York City" category, but its main is
      // New York City: it's a New York story.
      var mc = catPlace(a.main_category || '');
      if (mc){
        if (family(mc)) return true;
        if (isOtherCity(mc)) return false;
      }
      var cats = a.categories || [], i, cn;
      for (i = 0; i < cats.length; i++){
        cn = catPlace(cats[i]);
        if (family(cn)) return true;
      }
      for (i = 0; i < cats.length; i++){
        cn = catPlace(cats[i]);
        if (isOtherCity(cn)) return false;
      }
      // Fallback: words — but the place must WIN the title's geography.
      // "Gymkhana, London's Michelin-starred venue, debuts NYC concept" names
      // London first yet is a New York story: in TMW's title style the
      // DESTINATION is the last place named ("X ... debuts in Y"), an origin
      // qualifier loses to it. Compare END positions so a nested city name
      // ("Palm Beach" inside "West Palm Beach") can't outrank the place
      // itself. An excerpt-only mention loses to ANY other city in the title.
      var tl = norm(a.title || ''), selfEnd = -1, otherEnd = -1;
      for (i = 0; i < terms.length; i++){
        var si = terms[i] ? tl.lastIndexOf(terms[i]) : -1;
        if (si >= 0 && si + terms[i].length > selfEnd) selfEnd = si + terms[i].length;
      }
      function scanOther(nc){
        if (!nc || family(nc)) return;
        var oi = tl.lastIndexOf(nc);
        if (oi >= 0 && oi + nc.length > otherEnd) otherEnd = oi + nc.length;
      }
      if (citySet) citySet.forEach(function(disp, nc){ scanOther(nc); });
      for (i = 0; i < NYC_FAMILY.length; i++) scanOther(NYC_FAMILY[i]);
      if (otherEnd > selfEnd) return false;   // another city wins the title
      return hit(tl + ' ' + norm(a.excerpt || ''));
    }).sort(function(a, b){ return String(b.published_iso || '').localeCompare(String(a.published_iso || '')); });
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
  // STRICT supplement gate: is this article a genuine TOPICAL match to the query
  // (a phrase or token hit in its title/excerpt/categories/tags), vs merely sharing
  // the queried place by geography? Cards are a supplement to the answer — we only
  // surface a "clear hit," never a place-only co-location dump.
  function articleHasTextHit(a, toks, full){
    var hay = norm(a.title) + ' ' + norm(a.excerpt) + ' ' + norm((a.categories||[]).join(' ')) + ' ' + norm((a.tags||[]).join(' '));
    if (full && hay.indexOf(full) >= 0) return true;
    for (var i=0;i<toks.length;i++){ if (tokenInHay(toks[i], hay)) return true; }
    return false;
  }
  function scoreArticle(a, toks, full){
    // The worker's body scan (/posts?q=) confirmed this article's BODY matched the
    // query. Trust it enough to BYPASS the summary-only exclusion gates below, but
    // still score it by title/excerpt strength — so a genuine title match ("Moss, a
    // new private members' club") ranks ABOVE an article that merely mentions the
    // words in its body (a golf course that happens to say "private" + "club"). A
    // pure body-only match gets a low floor so it still shows but sinks under the
    // strong ones. (Was: a flat return 45, which tied every body-hit and let the
    // worker's DATE order win — burying real matches under recent loosely-related ones.)
    var _bodyHit = !!(a && a._bodyHit && a._bodyHit === full);
    var _inPlace = articleInPlace(a);
    var title=norm(a.title), exc=norm(a.excerpt), cats=norm((a.categories||[]).join(' ')), tags=norm((a.tags||[]).join(' '));
    var hay = title+' '+exc+' '+cats+' '+tags;
    if (!_inPlace && !_bodyHit && articleWrongState(title, hay)) return 0;   // title is about a different state → exclude
    var meaningful = (window.TmwSearchCore && window.TmwSearchCore.filterMeaningfulTokens)
      ? window.TmwSearchCore.filterMeaningfulTokens(toks)
      : toks.filter(function(t){ return t.length>=3; });
    if (meaningful.length>=2 && !_inPlace && !_bodyHit){
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
    // Confirmed body match but no title/summary signal → a low floor so it still
    // appears in the Journal tab, but ranks under every title/excerpt match above.
    if (s === 0 && _bodyHit) s = 12;
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
    s = String(s||'');
    var m = s.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (m) return new Date(+m[1], (+m[2])-1, m[3] ? +m[3] : 1);
    // Year-only (e.g. "2028") — a common delivery/completion target. Without this
    // it returned null and the timeline showed "TBA" even though a year was set.
    var y = s.match(/\b(19|20)\d{2}\b/);
    if (y) { var dy = new Date(+y[0], 0, 1); dy._yearOnly = true; return dy; }
    return null;
  }
  function fmtMon(d){
    if (!d) return '';
    if (d._yearOnly) return String(d.getFullYear());   // year-only → just "2028"
    return d.toLocaleString('en-US',{month:'short',year:'numeric'});
  }

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
    var desc = clipBio(firstField(p, ['DescriptionLong','Description']), 300);
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
      +     '<button class="tmw-ov-btn gold" type="button"'+_projAttr(p)+'>'
      +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
      +       'View project'
      +     '</button>'
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

  // Journal article as a PROJECT-CARD tile (Jake: "lean into the project card
  // design"). Same .tmw-ov-pcard shell as renderProjectCard — cover image on
  // top, title, "From the journal" where the location sits, the publish date
  // (gold) where the status sits, and the arrow.
  function renderArticlePCard(a){
    var img = a.cover_image || '';
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(a.title)+'" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var date = a.published_iso ? new Date(a.published_iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
    var href = 'https://www.oftmw.com/post/'+encodeURIComponent(a.slug||'')+'/';
    return '<a class="tmw-ov-pcard tmw-ov-acard" href="'+esc(href)+'">'
      + '<div class="tmw-ov-pcard-media">'+media+'</div>'
      + '<div class="tmw-ov-pcard-body">'
      +   '<h4>'+esc(a.title)+'</h4>'
      +   '<div class="loc">From the journal</div>'
      +   '<div class="meta"><span class="st sb-journal">'+esc(date||'Journal')+'</span><span class="openmap">→</span></div>'
      + '</div></a>';
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
    var sub = (f.role==='architect' ? 'Design' : (f.role==='developer' ? 'Developer' : 'Firm'))
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
  // ── Answer auto-linking ── wrap firm + market names in the Onyx prose with a
  // link to their page (/firm/<slug>/, /markets/<slug>/). Operates on the already-
  // ESCAPED answer text: collects only the entities actually PRESENT (cheap indexOf
  // scan so the regex stays tiny), matches longest-name-first in a single left-to-
  // right pass, and links each distinct entity once (so no nested links, no
  // over-linking). Only entities with a KNOWN page are linked — never a 404.
  function _reEsc(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function linkifyAnswer(text){
    if (!text) return text;
    try {
      var map = {}, names = [];
      function add(escName, href){
        if (!escName || escName.length < 4 || map[escName]) return;
        if (text.indexOf(escName) < 0) return;   // only link names present in the prose
        map[escName] = href; names.push(escName);
      }
      (FIRMS || []).forEach(function(f){
        if (f && f.slug && f.name) add(esc(String(f.name).trim()), 'https://www.oftmw.com/firm/' + encodeURIComponent(f.slug) + '/');
      });
      Object.keys(MARKET_SLUGS || {}).forEach(function(city){
        add(esc(String(city).trim()), 'https://www.oftmw.com/markets/' + MARKET_SLUGS[city] + '/');
      });
      if (!names.length) return text;
      names.sort(function(a, b){ return b.length - a.length; });   // longest first so "Mack Real Estate Group" beats "Mack"
      var rx = new RegExp('(?<![\\w>&/-])(' + names.map(_reEsc).join('|') + ')(?![\\w<;/-])', 'g');
      var used = {};
      return text.replace(rx, function(m0, m1){
        if (used[m1] || !map[m1]) return m0;
        used[m1] = 1;
        return '<a class="tmw-ov-ans-link" href="' + map[m1] + '">' + m1 + '</a>';
      });
    } catch (_) { return text; }
  }

  function intelPanelHtml(state, q, answer, deep, grounding){
    var live, ansClass, ansHtml;
    if (state === 'loading'){
      live = '<i></i>Thinking';
      ansClass = 'loading';
      ansHtml = '<span class="tmw-ov-intel-loader" aria-hidden="true"><span></span><span></span><span></span></span>'
              + 'Looking through projects and stories for an answer…';
    } else if (state === 'answer'){
      live = '<i></i>Live answer';
      // Deep answers keep their \n\n paragraph breaks (CSS white-space:pre-line).
      ansClass = deep ? 'deep' : '';
      // LLM responses are plain text; escape (so a stray "<" can't break the
      // panel) then auto-link known firms + markets to their pages.
      ansHtml = linkifyAnswer(esc(answer || ''));
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
      +     '<span class="tmw-ov-model'+(deep?' deep':'')+'" title="The model powering TMW Intelligence">'+(deep?'Onyx 5 Deep':'Onyx 5')+'</span>'
      // The answer's "Live answer" pip lives in the feedback row (relocated there
      // by setState). Omit it from the header on the answer state so it doesn't
      // show twice — the loading/no-answer/error states keep it (no feedback row yet).
      +     (state === 'answer' ? '' : '<span class="live">'+live+'</span>')
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans '+ansClass+'">'+ansHtml+'</p>'
      +   '<div class="tmw-ov-intel-foot' + ((state === 'answer' && grounding && (grounding.p || grounding.a)) ? ' has-ground' : '') + '">'
      +     '<span class="ai">Onyx 5</span> · ' + _groundingLine(state, grounding)
      +   '</div>'
      + '</section>';
  }

  // The receipts line under every answer: exactly what the reply was grounded
  // in ("Grounded in 14 tracked projects · 2 TMW articles · Miami"), with the
  // sources themselves rendered as the cards right below the panel. Falls back
  // to the generic line when a path has no grounding info (errors, misses).
  function _groundingLine(state, g){
    if (state !== 'answer' || !g || (!g.p && !g.a)) return 'TMW Intelligence, synthesized from the journal &amp; database';
    var bits = [];
    if (g.p) bits.push('<b>' + g.p + ' tracked project' + (g.p === 1 ? '' : 's') + '</b>');
    if (g.a) bits.push('<b>' + g.a + ' Article' + (g.a === 1 ? '' : 's') + '</b>');
    var line = 'Grounded in ' + bits.join(' · ');
    if (g.place) line += ' · ' + esc(String(g.place));
    return line;
  }

  // Intelligence gate. Two states: (1) NOT SIGNED IN → you need an account to try
  // TMW Intelligence at all → prompt to create a free account; (2) signed-in but
  // out of free searches → the Go Pro upgrade panel.
  function _intelSignedIn(){
    try {
      if (window.tmwIntel && typeof window.tmwIntel.signedIn === 'function') return window.tmwIntel.signedIn();
      return window._tmwSignedIn === true || window._isPaidMember === true || !!(window.__tmwMember && window.__tmwMember.id);
    } catch (e) { return false; }
  }
  function intelGateHtml(){
    var head = '<div class="tmw-ov-intel-h"><span class="tmw-ov-intel-spark">'+ICON_HEX+'</span><span class="lbl">TMW Intelligence</span></div>';
    if (!_intelSignedIn()) {
      var _af = (window.tmwIntel && window.tmwIntel.ANON_FREE) || 2;
      var _au = (window.tmwIntel && window.tmwIntel._anonUsed) ? window.tmwIntel._anonUsed() : 0;
      var _msg = _au >= _af
        ? 'You’ve used your <b>' + _af + ' free previews</b>. Create a free account for <b>5 searches every month</b> — natural-language answers across every project, firm, and milestone.'
        : 'Create a free account to try <b>TMW Intelligence</b> — natural-language answers across the entire development pipeline: every project, firm, and milestone.';
      return '<section class="tmw-ov-intel-panel gate">'
        + head
        + '<p class="tmw-ov-intel-ans">' + _msg + '</p>'
        + '<button type="button" class="tmw-ov-pro-btn" data-tmw-signup>Create a free account</button>'
        + '</section>';
    }
    return '<section class="tmw-ov-intel-panel gate">'
      + head
      + '<p class="tmw-ov-intel-ans">You’ve used all <b>' + ((window.tmwIntel && window.tmwIntel.FREE) || 5) + ' free</b> TMW Intelligence searches. Go <b>Pro</b> for unlimited natural-language search across the entire development pipeline — every project, firm, and milestone.</p>'
      + '<a class="tmw-ov-pro-btn" href="https://www.oftmw.com/map/?upgrade=1" data-tmw-paywall="feature:intelligence">Go Pro — unlimited intelligence</a>'
      + '</section>';
  }

  // ── Native project + map cards (open in-place inside the answer bubble,
  //    replacing the old SEO-page iframe embed). All data comes from the
  //    project object we already hold client-side. ──────────────────────────
  var SPINE_ORDER = ['Announced','Breaking Ground','Under Construction','Opening Soon','Now Open'];
  var SPINE_SHORT = { 'Announced':'Announced','Breaking Ground':'Breaking','Under Construction':'Construction','Opening Soon':'Opening soon','Now Open':'Now open' };
  function _spinePct(st){ var i = SPINE_ORDER.indexOf(st); return i < 0 ? 8 : [8,32,62,88,100][i]; }
  function _projImages(p){
    var out = [];
    ['ImageURL','Image2','Image3','Image4','Image5'].forEach(function(k){ var v = p[k]; if (v && out.indexOf(v) < 0) out.push(v); });
    return out;
  }
  function renderProjView(p){
    var Core = window.TmwSearchCore;
    var st = p.Delivery || 'Announced';
    var badge = (Core && Core.STATUS_BADGE && Core.STATUS_BADGE[st]) || { cls:'sb-announced', label: st };
    var imgs = _projImages(p);
    var hero = imgs.length
      ? '<div class="tmw-pv-track">' + imgs.map(function(u){ return '<img src="'+esc(u)+'" alt="'+esc(p.Title || '')+'" loading="lazy" onerror="this.style.display=\'none\'">'; }).join('') + '</div>'
        + (imgs.length > 1
          ? '<button class="tmw-pv-arrow prev" data-pvprev type="button" aria-label="Previous image"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg></button>'
            + '<button class="tmw-pv-arrow next" data-pvnext type="button" aria-label="Next image"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg></button>'
            + '<span class="tmw-pv-count"><b data-pvidx>1</b> / ' + imgs.length + '</span>'
          : '')
      : '<div class="tmw-pv-track" style="background:#15181a"></div>';
    // Firms behind the project as clickable pills → /firm/<slug>/ (canonical
    // slugs from projects-flat's DeveloperSlugs/ArchitectSlugs, paired by index),
    // matching the SEO project-page firm-chip design. Non-DB firms are plain.
    function firmChip(name, fslug){
      var nm = '<span class="nm">' + esc(name) + '</span>';
      return fslug
        ? '<a class="tmw-pv-firm" href="https://www.oftmw.com/firm/' + esc(fslug) + '/">' + nm + '</a>'
        : '<span class="tmw-pv-firm is-plain">' + nm + '</span>';
    }
    // Pair firm NAMES to SLUGS using the slugs (one per firm, unambiguous) as the
    // source of truth — the names field can contain commas WITHIN a single firm
    // ("Skidmore, Owings & Merrill"), so a naive comma-split over-splits. Greedily
    // join name parts until they slugify to the next slug.
    function fSlug(t){ return String(t==null?'':t).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
    function fHuman(s){ return String(s||'').replace(/[-_]+/g,' ').replace(/\b\w/g,function(c){ return c.toUpperCase(); }); }
    function pairFirms(raw, rawSlugs){
      var names = String(raw||'').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      var slugs = String(rawSlugs||'').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      if (!slugs.length) return names.map(function(n){ return { name:n, slug:'' }; });
      var out = [], i = 0;
      slugs.forEach(function(sl){
        var acc = '', matched = false;
        for (var j=i; j<names.length; j++){
          acc = acc ? (acc + ', ' + names[j]) : names[j];
          if (fSlug(acc) === sl){ out.push({ name:acc, slug:sl }); i = j+1; matched = true; break; }
        }
        if (!matched){ out.push({ name: names[i] || fHuman(sl), slug: sl }); if (i < names.length) i++; }
      });
      for (; i<names.length; i++) out.push({ name:names[i], slug:'' });
      return out;
    }
    function firmGroup(label, raw, rawSlugs){
      var pairs = pairFirms(raw, rawSlugs);
      if (!pairs.length) return '';
      var chips = pairs.map(function(p){ return firmChip(p.name, p.slug); }).join('');
      return '<div class="tmw-pv-fgroup"><div class="tmw-pv-fk">' + (label === 'Design' ? label : label + (pairs.length>1?'s':'')) + '</div><div class="tmw-pv-fchips">' + chips + '</div></div>';
    }
    var firms = firmGroup('Developer', p.Developer, p.DeveloperSlugs) + firmGroup('Design', p.Architect, p.ArchitectSlugs);
    var desc = clipBio(firstField(p, ['DescriptionLong','description_long','Description','description']) || '', 300);
    var type = String(firstField(p, ['PreferredType','ProjectType']) || '').split(',')[0].trim();
    var slug = p.Slug || p.slug || '';
    var spine = '<div class="tmw-pv-spine"><div class="tmw-pv-spine-bar"><div class="tmw-pv-spine-fill" style="width:' + _spinePct(st) + '%"></div></div>'
      + '<div class="tmw-pv-spine-stages">' + SPINE_ORDER.map(function(s){ return '<span class="' + (s === st ? 'on' : '') + '">' + esc(SPINE_SHORT[s] || s) + '</span>'; }).join('') + '</div></div>';
    var hasGeo = p.Latitude && p.Longitude;
    return '<div class="tmw-pv">'
      + '<div class="tmw-pv-hero">' + hero + '<div class="scrim"></div><span class="tmw-pv-badge ' + badge.cls + '"><i></i>' + esc(badge.label || st) + '</span></div>'
      + '<div class="tmw-pv-body">'
      +   '<h2 class="tmw-pv-title">' + esc(p.Title || '') + '</h2>'
      +   '<div class="tmw-pv-loc">' + esc(_locOf(p) || '') + (type ? ' &middot; ' + esc(type) : '') + '</div>'
      +   spine
      +   (desc ? '<p class="tmw-pv-desc">' + esc(desc) + '</p>' : '')
      +   (firms ? '<div class="tmw-pv-firms">' + firms + '</div>' : '')
      +   '<div class="tmw-pv-cta">'
      +     (hasGeo ? '<a class="tmw-pv-btn primary" href="https://www.oftmw.com/map/?project=' + esc(slug.replace(/-/g, '')) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20l-6-3V4l6 3 6-3 6 3v13l-6-3-6 3z"/><path d="M9 7v13M15 4v13"/></svg>View on map</a>' : '')
      +     '<a class="tmw-pv-btn ghost" href="https://www.oftmw.com/projects/' + esc(slug) + '/">Full details <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>'
      +     (slug ? '<button class="tmw-pv-btn watch" type="button" data-pvwatch data-slug="' + esc(slug) + '"><svg class="ic-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><svg class="ic-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><span class="tmw-pv-watch-txt">Watch</span></button>' : '')
      +   '</div>'
      + '</div></div>';
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
      +     modelBadgeHtml()
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
  // data-projslug marks a card/row as a project whose click opens the native
  // project card in-overlay (intercepted in the delegated click handler) instead
  // of leaving for the map.
  function _projAttr(p){
    var slug = p && (p.Slug || p.slug);
    return slug ? ' data-projslug="' + esc(String(slug)) + '"' : '';
  }

  function renderProjectCard(p){
    var img = firstField(p, ['ImageURL','Image2','Image3']);
    var media = img
      ? '<img src="'+esc(img)+'" alt="'+esc(p.Title)+'" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="ph"></div>';
    var status = p.Delivery || '';
    var Core = window.TmwSearchCore;
    var bcls = (Core && Core.STATUS_BADGE && Core.STATUS_BADGE[p.Delivery] && Core.STATUS_BADGE[p.Delivery].cls) || 'sb-announced';
    return '<a class="tmw-ov-pcard" href="'+esc(mapLink(p.Title, true))+'"'+_projAttr(p)+'>'
      + '<div class="tmw-ov-pcard-media">'+media+'</div>'
      + '<div class="tmw-ov-pcard-body">'
      +   '<h4>'+esc(p.Title)+'</h4>'
      +   (_locOf(p) ? '<div class="loc">'+esc(_locOf(p))+'</div>' : '')
      +   '<div class="meta"><span class="st '+bcls+'">'+esc(status)+'</span><span class="openmap">→</span></div>'
      + '</div></a>';
  }

  function renderFirmEntity(f){
    var roleLbl = f.role === 'architect' ? 'Design' : (f.role === 'developer' ? 'Developer' : 'Firm');
    var pc = +f.project_count || 0;
    var href = f.slug
      ? ('https://www.oftmw.com/firm/' + encodeURIComponent(f.slug) + '/')
      : (SEARCH_URL + '?q=' + encodeURIComponent(f.name));
    return '<a class="tmw-ov-firmcard tmw-ov-firmcard-slim" href="'+esc(href)+'">'
      + '<div class="fc-body">'
      +   '<div class="fc-name">'+esc(f.name)+'</div>'
      +   '<div class="fc-meta">'+esc(roleLbl)+(pc > 0 ? ' · '+pc+' project'+(pc===1?'':'s') : '')+'</div>'
      + '</div>'
      + '<span class="fc-arrow">'+ICON_ARROW+'</span>'
      + '</a>';
  }
  function renderCityEntity(c){
    return '<a class="tmw-ov-firmcard tmw-ov-firmcard-slim" href="'+MAP_URL+'/?city='+encodeURIComponent(c.name)+'">'
      + '<div class="fc-body">'
      +   '<div class="fc-name">'+esc(c.name)+'</div>'
      +   '<div class="fc-meta">Place · '+c.count+' project'+(c.count === 1 ? '' : 's')+'</div>'
      + '</div>'
      + '<span class="fc-arrow">'+ICON_ARROW+'</span>'
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
      var roleLbl = s.firm.role === 'developer' ? 'Developer' : (s.firm.role === 'architect' ? 'Design' : 'Firm');
      chips.push('<span class="tmw-ov-uchip"><span class="ck">'+roleLbl+'</span> <b>'+esc(s.firm.name)+'</b></span>');
    }
    if (s.firmRank) {
      var frLbl = s.firmRank === 'developer' ? 'Most active developer' : (s.firmRank === 'architect' ? 'Most active design firm' : 'Most active firms');
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
  // Receipts for the structured-smart path. The material behind the answer is
  // known synchronously (the ranked rows + iconic picks the LLM is fed), so the
  // grounding line can render with the panel — the question path builds the same
  // shape from its facts. Without this, smart-path turns ("resorts in hawaii")
  // showed NO receipts footer at all.
  function smartGrounding(s, rows, iconicHits){
    var place = s.area ? s.area.name
      : (s.cities && s.cities.length ? s.cities.join(' & ') : (s.region || null));
    return { p: (rows || []).length, a: (iconicHits || []).length, place: place };
  }

  // Onyx Deep tease — non-Pro only. Shows the SHAPE of what Deep would have
  // produced for this exact query (intent-derived section titles + real
  // grounding counts), never the content. Collapsed to one slim bar by
  // default (same dropdown treatment as the article intelligence).
  function renderDeepTease(q, ground, s){
    var pro = window.tmwIntel && window.tmwIntel.isPro && window.tmwIntel.isPro();
    if (pro) return '';
    var pCount = (ground && ground.p) || 0;
    var measured = pCount > 1 ? ' · ' + pCount + ' projects measured' : '';
    var secs;
    if (s && s.firm && s.firm.name){
      secs = ['Portfolio delivery record — ' + s.firm.name + "'s full track record",
              'Comparable developer pipelines' + measured,
              'Delivery risk — slippage history & forecast confidence'];
    } else if (s && s.cities && s.cities.length === 1){
      secs = ['Neighborhood pipeline — ' + s.cities[0] + measured,
              'Firm track record — developers & architects behind them',
              'Delivery risk — slippage history & forecast confidence'];
    } else {
      secs = ['Comparable pipeline' + measured,
              'Firm track record — developers & architects behind them',
              'Delivery risk — slippage history & forecast confidence'];
    }
    var body = secs.map(function(t, i){
      return '<div class="sec"><div class="sec-t"><span class="k">0'+(i+1)+'</span>'+esc(t)+'</div>'
        + '<div class="bar" style="width:'+(92 - i*7)+'%"></div><div class="bar" style="width:'+(72 - i*8)+'%"></div></div>';
    }).join('');
    return '<div class="tmw-dt" data-dt data-dt-q="'+esc(String(q||'').slice(0,200))+'">'
      + '<button type="button" class="dt-toggle" data-dt-toggle aria-expanded="false">'
      +   '<span class="dt-eye">' + ICON_DEEP + ' Onyx Deep <span class="dt-pro">PRO</span></span>'
      +   '<span class="dt-peek">See what the deep read would have covered</span>'
      +   '<span class="dt-chev" aria-hidden="true">▾</span>'
      + '</button>'
      + '<div class="dt-body">'
      +   '<p class="dt-sub">Deep reads every project record, firm history and article in scope for this question. It would have covered:</p>'
      +   body
      +   '<button type="button" class="dt-cta" data-dt-cta>Go deeper with Onyx Deep →</button>'
      + '</div>'
      + '</div>';
  }

  function renderSmartIntelPanel(ans, q, immediate, ground, s){
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
    var ansHtml = cached ? linkifyAnswer(esc(cached))
      : (immediate ? (ans.html || '')
      : '<span class="tmw-ov-intel-loader" aria-hidden="true"><span></span><span></span><span></span></span>Looking through the pipeline for an answer…');
    return '<section class="tmw-ov-intel-panel">'
      +   '<div class="tmw-ov-intel-h">'
      +     '<span class="tmw-ov-intel-spark">'+ICON_HEX+'</span>'
      +     '<span class="lbl">TMW Intelligence</span>'
      +     modelBadgeHtml()
      +     '<span class="live"><i></i>'+(showNow ? 'Live answer' : 'Thinking')+'</span>'
      +   '</div>'
      +   '<p class="tmw-ov-intel-ans '+ansCls+'" data-fallback="'+esc(ans.html)+'">'+ansHtml+'</p>'
      +   stats
      +   '<div class="tmw-ov-intel-foot' + ((ground && (ground.p || ground.a)) ? ' has-ground' : '') + '">'
      +     '<span class="ai">Onyx 5</span> · ' + _groundingLine((ground && (ground.p || ground.a)) ? 'answer' : '', ground)
      +   '</div>'
      +   renderDeepTease(q, ground, s)
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
    var rImg = firstField(p, ['ImageURL','Image2','Image3']);
    var rMedia = rImg
      ? '<img src="'+esc(rImg)+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
      : ICON_BLDG;
    return '<a class="tmw-ov-row '+(rank === 1 && sortKey ? 'lead' : '')+'" href="'+esc(mapLink(p.Title, true))+'"'+_projAttr(p)+'>'
      + '<div class="rank">'+rank+'</div>'
      + '<div class="r-ico'+(rImg ? ' has-img' : '')+'">'+rMedia+'</div>'
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
  function renderWebAnswer(q, answer, sources){
    var srcs = (sources || []).slice(0, 3).map(function(s){
      var host = ''; try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch (_) { host = s.url; }
      return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener" style="color:#1FDF67;text-decoration:none;font-size:11.5px;margin-right:12px">' + esc(host) + ' \u2197</a>';
    }).join('');
    slotIntel.innerHTML = '<div class="tmw-ov-sec" style="padding:18px 20px;border:1px solid rgba(167,139,250,.3);border-radius:14px;background:rgba(167,139,250,.06)">'
      + '<div style="font-size:15px;line-height:1.7;color:#ECEAE5">' + esc(answer) + '</div>'
      + (srcs ? '<div style="margin-top:10px">' + srcs + '</div>' : '')
      + '<div style="margin-top:12px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:rgba(167,139,250,.8)">From the web \u00b7 not yet in the TMW database</div></div>';
    slotHero.innerHTML = ''; slotRows.innerHTML = ''; slotProjGrid.innerHTML = '';
    slotEntities.innerHTML = ''; slotArticles.innerHTML = ''; slotFilterPills.innerHTML = '';
    setState('results');
  }

  // BEYOND-THE-DATABASE fallback: instead of a dead "nothing matched" state,
  // ask the worker's /answer-web (Claude + live web search, TMW voice). The
  // static empty state now only appears if this call itself fails.
  function webFallback(q, token){
    // Repeat visit / replay: a previously fetched web answer renders instantly.
    var _wc = cachedAnswer(q);
    if (_wc) {
      var _wg = cachedGrounding(q) || {};
      renderWebAnswer(q, _wc, (_wg && _wg.web_sources) || []);
      return;
    }
    if (_replaying) { setState('empty'); return; }
    slotIntel.innerHTML = '<div class="tmw-ov-sec" id="tmwWebFb" style="padding:18px 20px;border:1px solid rgba(167,139,250,.3);border-radius:14px;background:rgba(167,139,250,.06)">'
      + '<div style="font-size:13.5px;color:#9AA39C;font-style:italic">Nothing in our database yet \u2014 Onyx is searching the wider web\u2026</div></div>';
    slotHero.innerHTML = ''; slotRows.innerHTML = ''; slotProjGrid.innerHTML = '';
    slotEntities.innerHTML = ''; slotArticles.innerHTML = ''; slotFilterPills.innerHTML = '';
    setState('results');
    // Carry the thread's subject: prior turns + the place under discussion, so
    // a subjectless follow-up that missed the DB still answers in context.
    var _wfPlace = (_thread.length && _thread[_thread.length - 1].place) || _priorPlaceName() || '';
    fetch(WORKER_URL + '/answer-web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q, history: threadHistory(), place: _wfPlace }) })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (token !== _renderToken) return;
        if (j && j.answer) {
          renderWebAnswer(q, j.answer, j.sources || []);
          cacheAnswer(q, j.answer, { web_sources: (j.sources || []).slice(0, 3) });
        } else {
          setState('empty');
        }
      })
      .catch(function(){ if (token === _renderToken) setState('empty'); });
  }

  function buildNoResultsAnswer(s, q){
    var noun = s.iconic ? (ICONIC_NOUN[s.iconic] || 'results')
      : (s.typeLabel ? (s.typeLabel.toLowerCase() + (/s$/.test(s.typeLabel) ? '' : ' projects')) : 'projects');
    var place = (s.cities && s.cities.length) ? s.cities.join(' & ') : (s.region || placeFromQuery(q));
    // ABSENCE GUARD — never claim we don't track a type we DO track. With no
    // place to scope the miss, count what the database actually holds for the
    // parsed type(s); if we have any, the honest answer is "couldn't match the
    // specifics", not a false "we're not tracking any hotels yet" (which reads
    // as a data gap and torches trust). Place-scoped misses stay as-is: "no
    // hotels in <place> yet" is a true statement about our coverage there.
    if (!place && s.types && s.types.size && typeof PROJECTS !== 'undefined' && PROJECTS && PROJECTS.length){
      var _cnt = 0;
      try {
        PROJECTS.forEach(function(p){
          var pt = String(p.ProjectType || '');
          var hit = false;
          s.types.forEach(function(t){ if (pt.indexOf(t) >= 0) hit = true; });
          if (hit) _cnt++;
        });
      } catch(_){}
      if (_cnt) {
        return 'We track <b>' + _cnt + ' ' + esc(noun) + '</b> worldwide, but nothing matched every detail of that ask. Try adding a place or a project name.';
      }
    }
    return 'We’re not tracking any ' + esc(noun) + (place ? ' in <b>' + esc(tc(place)) + '</b>' : '') + ' yet.';
  }

  // ── orchestration ─────────────────────────────────────────────────
  // Chat thread: every query gets its own turn (user message + answer block).
  // newTurn() appends a turn and RE-POINTS the render targets at it, so all the
  // existing render functions keep writing into "the current turn" unchanged.
  // Source-article context for a search opened from an article ("Explore in
  // Onyx"). _pendingCtx is set by open(q, ctx); the next turn consumes it into
  // _currentTurnCtx — a purple chip on the query bubble + the article context
  // sent to Onyx so a terse question ("when") resolves against the right article.
  var _pendingCtx = null, _currentTurnCtx = null;
  function _ctxChipHtml(ctx){
    if (!ctx || !ctx.title) return '';
    var t = String(ctx.title);
    var short = t.length > 46 ? (t.slice(0, 44).replace(/\s+\S*$/, '') + '…') : t;
    var href = ctx.slug ? ('https://www.oftmw.com/post/' + ctx.slug + '/') : '#';
    return '<div class="tmw-ov-msg-row"><a class="tmw-ov-actx" href="' + esc(href) + '" target="_blank" rel="noopener" title="' + esc(t) + '">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>'
      + '<span>' + esc(short) + '</span></a></div>';
  }

  function newTurn(userText){
    sStarter.classList.add('tmw-ov-hidden');        // hide the teach card once a conversation starts
    _currentTurnCtx = _pendingCtx; _pendingCtx = null;   // this turn owns the article context (if any)
    var turn = document.createElement('div');
    turn.className = 'tmw-ov-turn';
    turn.innerHTML = '<div class="tmw-ov-msg-row"><div class="tmw-ov-msg">' + esc(userText) + '</div></div>'
      + _ctxChipHtml(_currentTurnCtx)
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
    // The free-quota pill lives in the starter header — refresh it on every entry
    // so the "N / FREE left" count reflects queries burned this session (New chat,
    // empty-query reset, etc.), not the stale value from when the overlay opened.
    if (name === 'starter') refreshProPill();
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
        markWatchBtn(fbEl);   // reflect already-watched state on the button
        // (The live/thinking pip is gone — responses are slimmed to the pure
        // answer, so nothing is relocated into the feedback row anymore.)
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
    // If a replay was mid-render, the turn it was building is now orphaned — this
    // query's render token invalidates that turn's pending async answer, so it
    // would sit blank forever. Drop it (and its thread record) before appending
    // the user's turn, so a cancelled replay never leaves a ghost response.
    if (_replaying) {
      try {
        var _lt = _threadEl && _threadEl.lastElementChild;
        var _lr = _lt && _lt.querySelector('[data-state="results"]');
        var _blank = !_lr || _lr.classList.contains('tmw-ov-hidden') || !((_lr.innerHTML || '').trim());
        if (_lt && _blank) { _lt.remove(); if (_thread.length) _thread.pop(); }
      } catch (_) {}
    }
    _replaying = false;       // a real user query → DO track it
    input.value = '';
    if (go) go.classList.remove('ready');
    _thread.push({ q: q, parsed: null, answer: null });
    saveThread();
    newTurn(q);
    runQuery(q);
  }

  var _renderToken = 0;
  var _answerOnly = false;   // analytical/synthesis question → render the LLM prose only, no cards/tabs
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
  // Set the active filter AND the projects-first flag in one place. When a query
  // matches 3+ projects, the OVERVIEW leads with the answer + project cards only —
  // journal tiles are hidden on overview (CSS), though the Journal pill still
  // opens them. Projects are the database core; when we have a real set of them,
  // they outrank journal coverage on the default view. Returns the filter string.
  function _setFilter(computed, counts){
    var f = _stickyDefault(computed, counts);
    sResults.setAttribute('data-filter', f);
    if (counts && counts.projects >= 3) sResults.setAttribute('data-projfirst', '1');
    else sResults.removeAttribute('data-projfirst');
    return f;
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
  // Full turns for the account thread: query + the answer we rendered + its
  // grounding receipts. Sent alongside `qs` so a resume (this device or another)
  // paints every turn instantly instead of replaying the whole conversation
  // through the LLM — the "returns to loading and re-queries" bug.
  function _threadTurns(){
    return _thread.filter(function(t){ return t && t.q; }).slice(-12).map(function(t){
      return {
        q: String(t.q).slice(0, 200),
        a: t.answer || cachedAnswer(t.q) || null,
        g: cachedGrounding(t.q) || null,
      };
    });
  }
  var _serverSaveTimer = null;
  var _syncedTs = 0;   // cloud updated_at (server ms) this device is currently in sync with
  // Push the query list to the worker so the same member resumes on any device.
  // Debounced + best-effort; the localStorage copy remains the offline fallback.
  function saveThreadToServer(){
    return;   // session-only history (2026-07-19): no cloud mirror, no cross-visit restore
    clearTimeout(_serverSaveTimer);
    _serverSaveTimer = setTimeout(function(){
      _resolveMid().then(function(mid){
        if (!mid) return;   // logged out → device-local only
        try {
          fetch(WORKER_URL + '/intel-thread', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
            body: JSON.stringify({ member_id: mid, qs: _threadQs(), turns: _threadTurns() })
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
          // Seed the local answer cache from the stored turns BEFORE any replay
          // runs, so every restored turn renders its remembered answer (and
          // receipts) instantly — no loading shell, no LLM re-query.
          try {
            ((d && d.turns) || []).forEach(function(t){
              if (t && t.q && t.a) cacheAnswer(t.q, t.a, t.g || null);
            });
          } catch(_){}
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
    return;   // session-only history: never adopt another device's thread mid-session
    if (!root.classList.contains('open')) return;
    // NEVER adopt-and-replay a cloud thread once the user is actively using THIS
    // one. _resumeReplay clears the thread and re-runs every query, which races
    // the user's in-flight turn and leaves it blank (the "my response vanished"
    // bug — especially with the overlay open in several tabs, each polling). A
    // background sync silently nuking a live conversation is never acceptable;
    // cross-device adoption still happens on a fresh open, before any interaction.
    if (_userInteracted) return;
    fetchServerThread().then(function(res){
      if (!res || !res.ts || res.ts <= _syncedTs) return;   // nothing newer than what we have
      _syncedTs = res.ts;
      if (res.qs && res.qs.join('') !== _threadQs().join('')) {
        if (_userInteracted) return;   // user typed during the fetch → don't clobber their live thread
        _resumeReplay(res.qs);
      }
    });
  }
  // Poll while the overlay is open so another device's update lands within ~10s
  // even with both screens visible (no focus change). The listeners below make a
  // device-switch (tab regains focus/visibility) sync instantly.
  var _syncPoll = null;
  function _startSyncPoll(){ /* session-only history: cloud sync disabled */ }
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
    // SESSION-SCOPED (2026-07-19): the conversation lives for the browser
    // session only — reloads and same-tab navigation keep it, closing the
    // site clears it. Fresh visits always start at the teach screen.
    try {
      if (qs.length) sessionStorage.setItem(_THREAD_KEY, JSON.stringify({ qs: qs, ts: Date.now() }));
      else sessionStorage.removeItem(_THREAD_KEY);
    } catch(_){}
    _liveWrite();   // mirror to the cross-session store so it can be filed into Past chats
  }
  function readThread(){
    try {
      var raw = sessionStorage.getItem(_THREAD_KEY); if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && Array.isArray(o.qs) && o.qs.length && (Date.now() - (o.ts || 0) < _RESUME_TTL)) return o.qs;
    } catch(_){}
    return null;
  }
  // ── Past chats (persistent history) ─────────────────────────────────────
  // The LIVE conversation is mirrored to localStorage tagged with the browser
  // session id (dock's 'tmw-sid', sessionStorage-scoped so it's fresh each
  // browser session). When a NEW session opens, the previous session's mirror
  // is filed into a capped history list the user reopens from "Past chats".
  var _HIST_KEY = 'tmw_intel_history';   // [{id,title,qs,startedTs,updatedTs}]
  var _LIVE_KEY = 'tmw_intel_live';      // {sid,id,title,qs,updatedTs} — this session's convo
  var _HIST_CAP = 50;
  var _liveId = null;                    // stable id for the current conversation
  function _sid(){ try { return sessionStorage.getItem('tmw-sid') || ''; } catch(_){ return ''; } }
  function _histRead(){ try { var a = JSON.parse(localStorage.getItem(_HIST_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch(_){ return []; } }
  function _histWrite(a){ try { localStorage.setItem(_HIST_KEY, JSON.stringify((a || []).slice(0, _HIST_CAP))); } catch(_){} }
  function _histTitle(qs){ var t = (qs && qs[0]) || 'Conversation'; t = String(t).replace(/\s+/g, ' ').trim(); return t.length > 90 ? t.slice(0, 90) + '…' : t; }
  function _histUpsert(entry){   // newest-first, dedupe by id
    if (!entry || !entry.id || !entry.qs || !entry.qs.length) return;
    var a = _histRead().filter(function(e){ return e.id !== entry.id; });
    a.unshift(entry); _histWrite(a);
  }
  function _liveWrite(){         // mirror the current conversation for THIS session
    try {
      var qs = _threadQs();
      if (!qs.length) { localStorage.removeItem(_LIVE_KEY); return; }
      if (!_liveId) _liveId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      localStorage.setItem(_LIVE_KEY, JSON.stringify({ sid: _sid(), id: _liveId, title: _histTitle(qs), qs: qs, updatedTs: Date.now() }));
    } catch(_){}
  }
  function _flushPrevSession(){  // move a previous (now-closed) session's convo into history
    try {
      var raw = localStorage.getItem(_LIVE_KEY); if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.qs && o.qs.length && o.sid && o.sid !== _sid()) {
        _histUpsert({ id: o.id, title: o.title || _histTitle(o.qs), qs: o.qs, startedTs: o.updatedTs, updatedTs: o.updatedTs });
        localStorage.removeItem(_LIVE_KEY);   // consumed; this session starts its own mirror
      }
    } catch(_){}
  }
  function _relTime(ts){
    var s = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    try { return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch(_){ return ''; }
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
    // No session thread: start clean with this query (no cloud restore —
    // history is session-only by design, 2026-07-19).
    submitQuery(initialQuery);
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
  // One-time migration: history used to live in localStorage (persisted across
  // visits). Session-scoped now — clear any legacy copies.
  try { localStorage.removeItem('tmw_intel_thread'); localStorage.removeItem('tmw_intel_lastq'); } catch (_) {}
  _flushPrevSession();   // a conversation left over from a closed browser session → move it into Past chats
  var _RESUME_TTL = 7 * 24 * 3600 * 1000;   // a week — long enough to "return", not forever
  function saveLastQuery(q){
    try {
      if (q && String(q).trim()) sessionStorage.setItem(_RESUME_KEY, JSON.stringify({ q: String(q).trim(), ts: Date.now() }));
    } catch(_){}
  }
  function readLastQuery(){
    try {
      var raw = sessionStorage.getItem(_RESUME_KEY); if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && o.q && (Date.now() - (o.ts || 0) < _RESUME_TTL)) return o.q;
    } catch(_){}
    return null;
  }

  // ── LLM answer cache ────────────────────────────────────────────────
  // Remember the LLM answer per query so reopening (or re-asking) shows it
  // INSTANTLY instead of flashing the deterministic database sentence and then
  // swapping in the LLM. Users should see ONE answer — the LLM's — not two.
  // 7-DAY device cache (was 24h — 'come back tomorrow' repeat visits burned
  // a fresh LLM call). The worker's own 24h cache still refreshes server-side;
  // an instant slightly-aged answer beats a spinner every time.
  var _ANS_KEY = 'tmw_intel_ans', _ANS_TTL = 7 * 24 * 3600 * 1000;
  function _normKey(q){ return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function _ansMap(){ try { return JSON.parse(localStorage.getItem(_ANS_KEY) || '{}'); } catch(_){ return {}; } }
  function cacheAnswer(q, a, g){
    if (!q || !a) return;
    try {
      var m = _ansMap(); m[_normKey(q)] = { a: String(a), g: g || null, ts: Date.now() };
      var keys = Object.keys(m);
      // 120-entry cap (was 40 — heavy sessions evicted answers the thread still
      // referenced, so a resume re-queried turns it should have had on hand).
      while (keys.length > 200) { keys.sort(function(x, y){ return (m[x].ts || 0) - (m[y].ts || 0); }); delete m[keys[0]]; keys.shift(); }
      localStorage.setItem(_ANS_KEY, JSON.stringify(m));
    } catch(_){}
  }
  function cachedAnswer(q){
    try { var e = _ansMap()[_normKey(q)]; if (e && e.a && (Date.now() - (e.ts || 0) < _ANS_TTL)) return e.a; } catch(_){}
    return null;
  }
  function cachedGrounding(q){
    try { var e = _ansMap()[_normKey(q)]; if (e && e.g && (Date.now() - (e.ts || 0) < _ANS_TTL)) return e.g; } catch(_){}
    return null;
  }
  // Loading panel that shows the cached LLM answer up front when we have one
  // (so there's no spinner on a repeat/resumed query).
  function intelLoadingHtml(q){
    var c = cachedAnswer(q);
    return c ? intelPanelHtml('answer', q, c, false, cachedGrounding(q)) : intelPanelHtml('loading', q);
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
  // Deep-tease funnel: expand + CTA both land in the events table so the
  // two-step funnel (expand -> click -> upgrade) is measurable against popups.
  function sendTeaseEvent(name, q){
    try {
      var m = window.__tmwMember || null;
      var did = '';
      try { did = localStorage.getItem('tmw_did') || ''; } catch(_){}
      var payload = JSON.stringify({
        member_id: (m && m.id) || ('anon:' + (did || 'unknown')),
        member_name: (m && m.name) || null,
        plan: m ? 'free' : 'anon',
        event_name: name,
        path: location.pathname,
        referrer: document.referrer || null,
        client_ts: Math.floor(Date.now() / 1000),
        props: { q: String(q || '').slice(0, 200), source: 'overlay' }
      });
      var url = 'https://tmw.jake-ab7.workers.dev/event';
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }));
      else fetch(url, { method:'POST', body:payload, keepalive:true, headers:{ 'Content-Type':'text/plain' } }).catch(function(){});
    } catch(_){}
  }
  root.addEventListener('click', function(e){
    var cta = e.target && e.target.closest ? e.target.closest('[data-dt-cta]') : null;
    if (cta){
      var boxc = cta.closest('[data-dt]');
      sendTeaseEvent('deep_tease_click', boxc ? boxc.getAttribute('data-dt-q') : '');
      try { if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall('feature:deep'); } catch(_){}
      return;
    }
    var tog = e.target && e.target.closest ? e.target.closest('[data-dt-toggle]') : null;
    if (tog){
      var box = tog.closest('[data-dt]');
      var open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      tog.setAttribute('aria-expanded', String(open));
      if (open && !box.getAttribute('data-dt-seen')){
        box.setAttribute('data-dt-seen', '1');
        sendTeaseEvent('deep_tease_expand', box.getAttribute('data-dt-q'));
      }
    }
  });

  // "Watch this" — Phase 2 Onyx Watch entry point. Non-Pro → the Go Pro paywall;
  // Pro → creates a smart watch on this query (matched against pulse moves).
  // Already-watched detection — so the button shows "Watching" for a query the
  // member already saved (instead of "Watch this", which made re-watching look
  // like nothing happened). Loaded once per session for Pro members.
  var _watchedQ = null;
  function loadWatched(){
    if (_watchedQ) return Promise.resolve(_watchedQ);
    var mid = (window.__tmwMember && window.__tmwMember.id) || '';
    var pro = window.tmwIntel && window.tmwIntel.isPro && window.tmwIntel.isPro();
    if (!mid || !pro){ _watchedQ = new Set(); return Promise.resolve(_watchedQ); }
    return fetch('https://tmw.jake-ab7.workers.dev/watch/smart?member=' + encodeURIComponent(mid), { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ _watchedQ = new Set(((d && d.smart_watches) || []).map(function(w){ return String(w.query || '').trim().toLowerCase(); })); return _watchedQ; })
      .catch(function(){ _watchedQ = new Set(); return _watchedQ; });
  }
  function markWatchBtn(fbEl){
    if (!fbEl) return;
    var wb = fbEl.querySelector('.tmw-ov-watch-btn'); if (!wb) return;
    var q = (fbEl.getAttribute('data-fbq') || '').trim().toLowerCase();
    loadWatched().then(function(set){
      var txt = wb.querySelector('.tmw-ov-watch-txt');
      if (q && set.has(q)){ wb.classList.add('on'); if (txt) txt.textContent = 'Watching'; }
      else { wb.classList.remove('on'); if (txt) txt.textContent = 'Watch this'; }
    });
  }

  root.addEventListener('click', function(e){
    var wb = e.target.closest && e.target.closest('.tmw-ov-watch-btn');
    if (!wb) return;
    e.preventDefault(); e.stopPropagation();
    var fb = wb.closest('[data-feedback]');
    var q = (fb && fb.getAttribute('data-fbq')) || _lastQuery || '';
    var pro = window.tmwIntel && window.tmwIntel.isPro && window.tmwIntel.isPro();
    if (!pro) {
      if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall({ source: 'onyx_watch' });
      return;
    }
    if (!q) return;
    var mid = (window.__tmwMember && window.__tmwMember.id) || '';
    var txt = wb.querySelector('.tmw-ov-watch-txt');
    var qk = String(q).trim().toLowerCase();
    // Already watching → clicking again REVERTS the watch (delete).
    if (wb.classList.contains('on')) {
      if (txt) txt.textContent = 'Removing…';
      fetch('https://tmw.jake-ab7.workers.dev/watch/delete', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ member: mid, query: q })
      }).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
        if (d && d.ok) { wb.classList.remove('on'); if (txt) txt.textContent = 'Watch this'; if (_watchedQ) _watchedQ.delete(qk); }
        else if (txt) txt.textContent = 'Watching';
      }).catch(function(){ if (txt) txt.textContent = 'Watching'; });
      return;
    }
    if (txt) txt.textContent = 'Watching…';
    fetch('https://tmw.jake-ab7.workers.dev/watch/create', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ member: mid, query: q })
    }).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if (d && d.ok) { wb.classList.add('on'); if (txt) txt.textContent = 'Watching'; if (_watchedQ) _watchedQ.add(qk); }
      else if (txt) txt.textContent = 'Watch this';
    }).catch(function(){ if (txt) txt.textContent = 'Watch this'; });
  });
  // ── Share this answer ──────────────────────────────────────────────
  // Every answer turn is deep-linkable: the query is the shareable unit
  // (opening https://www.oftmw.com/?q=<question> re-opens Onyx and re-runs
  // it through the live pipeline — same mechanism the newsletter's "people
  // asked Onyx" links use). On mobile we hand it to the native share sheet;
  // elsewhere we copy the link and flash a "Copied" confirmation. Open to
  // everyone (no Pro gate) — sharing is top-of-funnel.
  function _fallbackCopy(text){
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch(_){}
  }
  root.addEventListener('click', function(e){
    var sb = e.target.closest && e.target.closest('.tmw-ov-share-btn');
    if (!sb) return;
    e.preventDefault(); e.stopPropagation();
    var fb = sb.closest('[data-feedback]');
    var q = ((fb && fb.getAttribute('data-fbq')) || _lastQuery || '').trim();
    if (!q) return;
    var url = 'https://www.oftmw.com/?q=' + encodeURIComponent(q);
    var txt = sb.querySelector('.tmw-ov-share-txt');
    function flashCopied(){
      sb.classList.add('copied'); if (txt) txt.textContent = 'Copied';
      setTimeout(function(){ sb.classList.remove('copied'); if (txt) txt.textContent = 'Share'; }, 2000);
    }
    // Native share sheet on touch devices (iOS/Android) — best UX for "send this".
    var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    if (isMobile && navigator.share) {
      navigator.share({ title: 'TMW Intelligence', text: q, url: url }).catch(function(){});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(flashCopied, function(){ _fallbackCopy(url); flashCopied(); });
    } else { _fallbackCopy(url); flashCopied(); }
  });
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
    // A new turn instantly invalidates any in-flight Intelligence answer from a
    // prior turn. Without this there's a gap — the prior turn's token stays
    // "current" until THIS turn's own fire bumps it — and a late-arriving answer
    // for the old query passes the token guard and paints into the NEW turn's
    // slot (the London-turn-shows-the-WPB-answer-and-receipts bug).
    _intelToken++;
    _qPlaceArts = null;    // never let a prior turn's place-journal set leak into this one
    _answerOnly = false;   // clear any prior analytical query; re-decided after classify
    try { sResults.setAttribute('data-answer-only', '0'); } catch (_) {}
    try { sResults.setAttribute('data-slim', '0'); } catch (_) {}   // re-decided after classify (project-list suppression)
    setState('thinking');
    // Reset the thumbs row for the incoming query so a previous vote
    // doesn't bleed across. _lastQuery / _lastResultsTotal / _lastResultKind
    // are repopulated by whichever render path handles this query.
    _lastQuery = q;
    saveLastQuery(q);   // remember for "resume where you left off" on reopen
    _lastResultsTotal = 0;
    _lastResultKind = '';
    resetFeedback();

    // ── ACCOUNT GATE ─────────────────────────────────────────────────
    // Anonymous visitors get ANON_FREE preview searches (per device). While a
    // preview remains they flow through to real results like a signed-in member;
    // once they run out, this full-screen "create a free account" gate takes over
    // (no tabs, hero, project/journal cards, or feedback row).
    if (!_intelSignedIn() && !(window.tmwIntel && window.tmwIntel.allowed && window.tmwIntel.allowed(q))) {
      if (slotIntel) slotIntel.innerHTML = intelGateHtml();
      [slotFilterPills, slotHero, slotRows, slotProjGrid, slotEntities, slotArticles].forEach(function(s){ if (s) s.innerHTML = ''; });
      setState('results');
      try { var _fb = sResults && sResults.querySelector('.tmw-ov-feedback'); if (_fb) { _fb.classList.remove('show'); _fb.style.display = 'none'; } } catch(_){}
      try { if (!_replaying && window.tmwIntel && window.tmwIntel.track) window.tmwIntel.track(q, { gated: 'anon', source: 'overlay' }); } catch(_){}
      _lastResultKind = 'gate';
      return;
    }

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
      sResults.setAttribute('data-filter', 'spotlight');   // black bubble, no overview flatten/caps
      sEmpty.classList.add('tmw-ov-hidden');
      _lastResultsTotal = 1;
      _lastResultKind = 'spotlight';
      setState('results');
      return;
    }

    // ── BUSINESS INQUIRY ("get featured", advertising, sponsorship, press) ──
    // Anyone asking how to be featured/advertise is a LEAD, not a search miss.
    // Route them straight to /media + media@oftmw.com, never a zero-state.
    var MEDIA_RE = /\b(get\s+featured|be\s+featured|feature\s+(us|me|my|our)|(how\s+(do\s+i|to|can\s+i)\s+|want\s+to\s+|can\s+i\s+)advertise|advertise\s+(with|on)\b|advertising\s+(rates?|options?|opportunit\w*|costs?|packages?)|sponsor(ship)?\s+(opportunit\w*|rates?|options?|packages?)|sponsor\s+(a\s+post|an?\s+article|content)|media\s*kit|press\s*kit|pr\s+(contact|inquiry)|list\s+my\s+(project|property|development)|add\s+my\s+(project|property|development)|submit\s+(a\s+|my\s+|our\s+)?(project|property|development|listing)|work\s+with\s+(you|tmw|markets\s+of\s+tomorrow)|partner(ship)?\s+with\s+(you|tmw)|partnership\s+opportunit\w*)\b/i;
    if (MEDIA_RE.test(q)) {
      slotIntel.innerHTML = '<div class="tmw-ov-sec" style="padding:20px 22px;border:1px solid rgba(167,139,250,.35);border-radius:15px;background:radial-gradient(420px 160px at 12% 0%,rgba(167,139,250,.14),transparent 60%),rgba(167,139,250,.06);box-shadow:0 0 30px rgba(167,139,250,.12)">'
        + '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#A78BFA;font-weight:700;margin-bottom:9px">Partner with Markets of Tomorrow</div>'
        + '<div style="font-size:15px;line-height:1.65;color:#ECEAE5">Want your project, brand or firm featured? We work with developers, hospitality brands and agencies on features, placements and campaigns across the journal, the map and the newsletter. Start on our media page, or email us directly and we\u2019ll come back fast.</div>'
        + '<div style="display:flex;gap:10px;margin-top:15px;flex-wrap:wrap">'
        + '<a href="https://www.oftmw.com/media" style="text-decoration:none;background:#A78BFA;color:#0a0a0a;font-weight:700;font-size:13px;padding:10px 17px;border-radius:999px">Media &amp; partnerships \u2192</a>'
        + '<a href="mailto:media@oftmw.com" style="text-decoration:none;border:1px solid rgba(167,139,250,.45);color:#A78BFA;font-weight:700;font-size:13px;padding:10px 17px;border-radius:999px">media@oftmw.com</a>'
        + '</div></div>';
      slotHero.innerHTML = ''; slotRows.innerHTML = ''; slotProjGrid.innerHTML = '';
      slotEntities.innerHTML = ''; slotArticles.innerHTML = ''; slotFilterPills.innerHTML = '';
      sResults.setAttribute('data-filter', 'spotlight');
      sEmpty.classList.add('tmw-ov-hidden');
      _lastResultsTotal = 1;
      _lastResultKind = 'media-inquiry';
      setState('results');
      try { if (!_replaying && window.tmwIntel && window.tmwIntel.track) window.tmwIntel.track(q, { source: 'overlay', media_inquiry: 1 }); } catch (_) {}
      try { if (window.tmwFunnelTrack) tmwFunnelTrack('media_inquiry_search', { q: q }); } catch (_) {}
      return;
    }

    // Returned so the thread-resume replay can await each turn in sequence
    // (the global _renderToken would otherwise invalidate all but the last).
    // Intent router (#1): classify in PARALLEL with loadData so there's no added
    // latency; the classifier's `kind` steers routing below, with the heuristic
    // gates as fallback when it's null / low-confidence / times out.
    var _intentP = (Core && Core.classifyIntent) ? Core.classifyIntent(q) : Promise.resolve({ kind: null });
    // Cap the classify wait so the UI paints fast even when a fresh classify runs
    // 1.5–3.5s; routing falls back to the heuristic gates if it hasn't landed yet.
    var _classDeadline = new Promise(function (r) { setTimeout(function () { r({ kind: null, _timedout: true }); }, 1200); });
    var _renderIntentP = Promise.race([_intentP, _classDeadline]);
    return Promise.all([loadData(), _renderIntentP]).then(function (_arr) {
      if (token !== _renderToken) return;
      var intent = _arr[1] || { kind: null };
      var _ik = (intent && (intent.confidence == null || intent.confidence >= 0.6)) ? intent.kind : null;
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
      // A browse-all ask ("okay give me all projects then") means the WHOLE
      // database — never inherit the prior turn's type/place filters into it.
      if (smart && _prior && Core.resolveFollowup && !smart.browseAll) { smart = Core.resolveFollowup(smart, _prior); }
      // Stash the parse on the current turn for the NEXT follow-up + the LLM.
      if (_thread.length) _thread[_thread.length - 1].parsed = smart || null;
      // Record the place THIS query names on its turn — here, not in the fact
      // builders, so cache-replayed answers (which skip fact-building entirely)
      // still leave a place for the next follow-up to inherit.
      try {
        var _tps = placeScopeFor(q);
        if (_tps && _thread.length) _thread[_thread.length - 1].place = _tps.name;
      } catch(_){}
      // Dining isn't a project type — it's journal coverage. Route ANY food
      // query to the text path, which answers from the Food & Drink articles.
      // A coincidental firm match ("Nashville" → "The Nashville Predators") must
      // NOT keep it in the project readout. Only an explicit project TYPE in the
      // query ("hotels with restaurants") keeps the structured parse.
      if (smart && isFoodQuery(q) && !(smart.types && smart.types.size)) {
        smart = null;
      }
      // Wellness/fitness is journal coverage too — route to the text/article path
      // (unless an explicit project TYPE is named, e.g. "wellness resort hotels").
      if (smart && isWellnessQuery(q) && !(smart.types && smart.types.size)) {
        smart = null;
      }
      // CONCEPT QUESTION that merely mentions a place ("what is the live local
      // act and how is it changing florida development") — the TOPIC, not the
      // place, is the subject, so don't dump the generic place pipeline; route to
      // the topic-relevant semantic path. A place-trajectory question ("why is
      // west palm beach growing so fast") has only growth/change DESCRIPTORS
      // beyond the place, not a real concept, so it KEEPS the place pipeline.
      var _conceptQ = false;
      // INTENT OVERRIDES — the classifier resolves the routing decisions that
      // the heuristics kept getting wrong, but only for the cases it's reliable
      // on (project / concept / place); everything else keeps the heuristics.
      // Iconic ("list"), firm, food, wellness stay on their existing gates so a
      // "best hotels" iconic parse isn't lost.
      if (_ik === 'project') {
        smart = null;                       // exact project lookup → text path's full-hero
      } else if (_ik === 'concept' || _ik === 'topic') {
        // Topic/policy → semantic concept path. BUT if parseSmartQuery already found
        // a concrete structured intent — a SIZE sort, an explicit type, a height
        // band, or a US-country scope — it's a database LIST ("biggest projects in
        // the united states"), not a concept. Keep the structured parse so it ranks
        // by scale instead of falling to keyword text-match (which floated a padel
        // court into "biggest projects"). Place-only questions still go concept.
        if (smart && (smart.sort || smart.usOnly || smart.browseAll || (smart.types && smart.types.size) || smart.floorsMin != null)) {
          /* keep smart — structured list */
        } else {
          _conceptQ = true; smart = null;
        }
      }
      // #4 (hybrid steering, down payment): let the classifier's structured
      // extraction drive RETRIEVAL, not just routing — fill a filter the
      // heuristic parse missed. Floors is a safe scalar; high-rise phrasings the
      // regex doesn't catch ("skyline-defining towers") still filter correctly.
      if (smart && _ik && smart.floorsMin == null && typeof intent.floorsMin === 'number' && intent.floorsMin >= 5) {
        smart.floorsMin = intent.floorsMin;
      }
      // Heuristic concept gate — only when the classifier didn't already decide.
      if (!_conceptQ && smart && (Core && Core.isQuestion ? Core.isQuestion(q) : isQuestion(q))
          && !(smart.types && smart.types.size) && !smart.firm && !smart.firmRank && !smart.iconic && !smart.sort && smart.floorsMin == null) {
        var _placeStr = ((smart.cities || []).join(' ') + ' ' + (smart.region || '') + ' ' + (smart.area || '')).toLowerCase();
        var _descr = /^(grow|grows|growing|growth|fast|faster|boom|booming|hot|happening|going|changing|change|changed|develop|developing|development|developments|market|markets|doing|driving|driven|popular|trend|trending|trends|active|activity|new|newest|rising|rise|coming|now|today|currently|recent|recently|big|bigger|biggest|expanding|expansion|attracting|drawing)$/;
        var _toks = (Core && Core.filterMeaningfulTokens ? Core.filterMeaningfulTokens(tokenize(q)) : tokenize(q).filter(function (t) { return t.length >= 3; }))
          .filter(function (t) { return _placeStr.indexOf(t) < 0 && !_descr.test(t); });
        if (_toks.length >= 2) { _conceptQ = true; smart = null; }
      }
      // Analytical/synthesis question → the LLM prose IS the answer. Force the
      // text/Intelligence path (never a structured project readout) so we always
      // produce written prose to show after the cards are suppressed.
      if (_answerOnly) smart = null;
      // NAMED-PROJECT OVERRIDE — a question that names a specific tracked
      // project ("when will hotel ORA tampa construction begin") must anchor on
      // THAT project. The structured parse reads it as a status browse (Tampa +
      // Hotel + Under Construction) and its status filter can drop the very
      // project asked about (ORA is Breaking Ground) — no hero, wrong Projects
      // tab. A distinctive title token (rare across the dataset), city-broken
      // for brand siblings, is decisive: route to the project path so the full
      // hero renders and the ranked rows lead with the named project. The
      // question/Intelligence answer still fires inside the text path.
      if (!_answerOnly) {
        var _namedP = null;
        try { _namedP = detectNamedProject(q); } catch(_){}
        if (_namedP) { smart = null; _conceptQ = false; intent = { kind: 'project', confidence: 1 }; _ik = 'project'; }
      }
      if (smart) {
        renderStructuredSmart(q, smart, token);
        return;
      }
      // Otherwise fall through to text-match scoring + the question /
      // LLM path. Token re-checked inside runTextMatch. Pass the intent so the
      // text path can force exact-project vs place routing.
      runTextMatch(q, token, { conceptQ: _conceptQ, intent: intent });
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
  // Surface RELATED projects via the semantic index when keyword search found
  // none (concept/term questions like "what is mass timber" → 120 S. Dixie
  // Highway, which the keyword pass misses but the index relates). Additive +
  // async; renders a "Related projects" section, flips to the answer-first
  // Overview, and rebuilds the counts bar so the Projects tab appears. Never
  // overwrites real keyword/spine projects.
  function enrichSemanticProjects(q, token, artCount){
    if (_answerOnly) { if (slotProjGrid) slotProjGrid.innerHTML = ''; return; }   // answer-only: no Related projects
    var Core = window.TmwSearchCore;
    if (!Core || !slotProjGrid || !Core.rankProjects) return;
    // Food & wellness are JOURNAL coverage, not project types — so semantic
    // "related projects" for them are off-topic noise (a "restaurants opening in
    // colorado" query pulling a Shanghai opera house / a Gstaad hotel). The
    // journal answer stands on its own; surface NO project cards rather than junk.
    if (isFoodQuery(q) || isWellnessQuery(q)) return;

    function paint(rp){
      if (token !== _renderToken || !rp || !rp.length) return;
      if (slotProjGrid.querySelector('.tmw-ov-grid, .tmw-ov-rows')) return;   // projects already shown — leave them
      var sa = (rp.length > 3) ? '<button class="tmw-ov-seeall" type="button" data-goto="projects">'+(rp.length - 3)+' more projects <span aria-hidden="true">&rarr;</span></button>' : '';
      slotProjGrid.innerHTML = '<div class="tmw-ov-sec" data-cat="projects"><div class="tmw-ov-sec-head"><h3>Related projects</h3></div>'
        + '<div class="tmw-ov-grid">' + rp.slice(0, MAX_PROJECTS_GRID).map(renderProjectCard).join('') + '</div>' + sa + '</div>';
      _lastFilterCounts.projects = rp.length;
      _setFilter('overview', _lastFilterCounts);
      slotFilterPills.innerHTML = renderFilterPills({ intel: _lastFilterCounts.intel, projects: rp.length, firms: _lastFilterCounts.firms || 0, articles: (typeof artCount === 'number' ? artCount : 0) });
      var f = sResults.getAttribute('data-filter') || 'overview';
      var ap = slotFilterPills.querySelector('.tmw-ov-fp[data-filter="' + f + '"]');
      if (ap) { var ps = slotFilterPills.querySelectorAll('.tmw-ov-fp'); for (var i = 0; i < ps.length; i++) ps[i].classList.toggle('active', ps[i] === ap); }
    }

    // Resolve any place the query names so the retriever can scope BOTH the
    // bio-exact and the semantic cards to it — a "across colorado" query must not
    // surface "Limelight Charleston" (SC) just because Limelight is an Aspen brand.
    var _place = Core.resolvePlace ? Core.resolvePlace(q, PROJECTS) : null;

    // #4 unified retriever — concept kind. Bio-substring-exact for a named
    // program ("Live Local Act", "mass timber") runs FIRST inside rankProjects
    // (a dense embedding dilutes the phrase across a ~1,600-char bio, so "Live
    // Nation" would win on the word "live") — these verbatim matches are the most
    // precise, so they paint immediately and synchronously.
    var bio = Core.rankProjects(q, PROJECTS, { kind: 'concept', place: _place });
    if (bio && !bio.semantic && bio.rows.length) { paint(bio.rows.map(function (x) { return x.p; })); return; }

    // Semantic fallback — fetch related slugs, then rank them through the SAME
    // retriever (place-scoped) so the render is identical. Topic-clean the query
    // first so the topic drives recall, not "around the world". Place-scoped so a
    // semantic neighbor in the wrong place never surfaces.
    if (!Core.semanticSearch) return;
    var topicQ = q.replace(/\b(what|whats|which|who|where|when|why|how|are|is|am|do|does|did|happening|going on|tell me|show me|about|the|a|an|any|some|right now|currently|these days|nowadays|today|around|across|throughout|worldwide|world|globally|global|anywhere|everywhere|projects?|developments?|buildings?)\b/gi, ' ')
      .replace(/\b(florida|california|texas|new york|north carolina|south carolina|carolina|tennessee|georgia|nevada|arizona|colorado|utah|hawaii|illinois|fl|ca|tx|ny)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    Core.semanticSearch(topicQ || q).then(function (sem) {
      if (token !== _renderToken) return;
      var r = Core.rankProjects(q, PROJECTS, { kind: 'concept', semanticSlugs: sem.projects || [], place: _place });
      paint(r ? r.rows.map(function (x) { return x.p; }) : []);
    }).catch(function () {});
  }

  // ── Named-project detector ──────────────────────────────────────
  // Does the query name ONE specific tracked project? Decided by a DISTINCTIVE
  // title token: a meaningful query token that appears in at most 4 project
  // titles across the whole dataset ("ora", "amanvari", "pendry") — generic
  // words (hotel, tampa, tower) are common across titles so rarity filters
  // them out naturally. Ambiguity between same-brand siblings (Hotel Ora Tampa
  // vs Ora by Casa Tua Miami) is broken by the project's own city appearing in
  // the query. Returns the project or null; null on any ambiguity.
  function detectNamedProject(q){
    var Core = window.TmwSearchCore;
    if (!Core || !Core.norm || !PROJECTS || !PROJECTS.length) return null;
    var toks = (Core.filterMeaningfulTokens ? Core.filterMeaningfulTokens(tokenize(q)) : tokenize(q))
      .filter(function(tk){ return tk.length >= 3 && !/^\d+$/.test(tk); });
    if (!toks.length) return null;
    // token → how many project titles contain it (word-boundary)
    var titleToks = PROJECTS.map(function(p){
      return ' ' + Core.norm(p.Title || '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    });
    var qn = ' ' + Core.norm(q).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    var hits = {};   // project index → rare-token hit count
    toks.forEach(function(tk){
      var needle = ' ' + tk + ' ', idxs = [];
      for (var i = 0; i < titleToks.length; i++) if (titleToks[i].indexOf(needle) >= 0) { idxs.push(i); if (idxs.length > 4) break; }
      if (!idxs.length || idxs.length > 4) return;   // absent or too common → not distinctive
      idxs.forEach(function(i){ hits[i] = (hits[i] || 0) + 1; });
    });
    var cand = Object.keys(hits).map(function(k){ return { p: PROJECTS[+k], n: hits[k] }; });
    if (!cand.length) return null;
    cand.sort(function(a, b){ return b.n - a.n; });
    cand = cand.filter(function(c){ return c.n === cand[0].n; });
    if (cand.length > 1) {
      // brand siblings — the query's place decides
      var byCity = cand.filter(function(c){
        var city = Core.norm(String(c.p.City || '').split(',')[0]).replace(/[^a-z0-9 ]+/g, ' ').trim();
        return city && qn.indexOf(' ' + city + ' ') >= 0;
      });
      if (byCity.length !== 1) return null;
      cand = byCity;
    }
    return cand[0].p;
  }

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
        // Word-boundary match on the TITLE so a token like "high" (from "high
        // rises") doesn't match "Highway" and falsely collapse the result set.
        var re = new RegExp('(^|[^a-z0-9])' + tk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?($|[^a-z0-9])');
        if (re.test(t)) { hits++; if (cityN.indexOf(tk) < 0) distinct++; }
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

    // #4 unified retriever — structured kind. The place / type / status / floors
    // browse (area fan-out, high-rise band, "mixed-use in miami") gets its project
    // set from the one shared retriever (smartFilter + smartRank under the hood),
    // so it ranks identically to the eval harness and the other kinds.
    var rows = (Core.rankProjects
      ? Core.rankProjects(q, PROJECTS, { kind: 'structured', smart: s }).rows.map(function (x) { return x.p; })
      : Core.smartRank(Core.smartFilter(s, PROJECTS), s));
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
      if (!iconicHits.length && rows.length && !hasProjectPlace && !placeFromQuery(q)){
        // The iconic cue fired but the editorial list matched nothing, and the
        // query names NO place (a named-but-untracked place like "hotels in
        // fiji" keeps the honest place-scoped absence answer instead). We DO
        // have database rows; fall back to them rather than wiping the set and
        // falsely answering "we're not tracking any X yet".
        s.iconic = null;
      } else if (!s.types.size || !hasProjectPlace) {
        rows = [];
      }
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
    // Title-scope to ONE project only for a bare place query (e.g. "viceroy fort
    // lauderdale"). When a TYPE was named ("high rises in west palm beach"), it's
    // a browse of that type in the place — never collapse it to a single project.
    // A QUESTION ("why is west palm beach growing so fast") wants the FULL place
    // pipeline ranked by the spine — never let its phrasing ("growing", "fast")
    // act as a project-name or neighborhood filter that narrows the set.
    var _isQ = (Core && Core.isQuestion ? Core.isQuestion : isQuestion)(q);
    // SLIM RESPONSES: an analytical/synthesis QUESTION (not an explicit list
    // request) drops the PROJECT list + firm list from the Overview so it reads as
    // the pure LLM answer. The prose, a single hero, the JOURNAL matches, and the
    // Projects/Journal tabs all stay (drill-in still works). List-intent questions
    // ("give me a list", "new projects") keep the project cards; plain name/keyword
    // lookups (not questions) are untouched, so their hero + matches render as before.
    if (_isQ && !listIntent(q)) {
      try { sResults.setAttribute('data-slim', '1'); } catch (_) {}
    }
    // A FIRM browse ("related ross west palm beach") must NOT collapse to one
    // project either — the firm's name tokens ("ross") coincidentally match a
    // single project's TITLE ("Ross Private Club") and would scope away the other
    // 10 the firm is building. Same class of bug as the type/floors guards.
    var titleHit = (!_isQ && (s.cities.length || s.region) && !s.iconic && !(s.types && s.types.size) && s.floorsMin == null && !s.firm) ? pickTitleScopedProject(q, rows) : null;
    if (titleHit) rows = [titleHit];
    // Narrow to a residual neighborhood/qualifier ("design district") the
    // structured parse ignored, and surface it as an "Area" chip. Skip
    // when we've already narrowed to one project by title.
    // Residual narrowing (e.g. "design district") only makes sense when the query
    // named a place to narrow WITHIN. For global type/status queries like "hotels
    // opening around the world soon", leftover words ("world") must not filter the
    // set down to the handful of projects that happen to mention them.
    if (!_isQ && !titleHit && (s.cities.length || s.region) && !s.iconic && s.floorsMin == null) {
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
        // List the ACTUAL places the firm's tracked projects span (most-populous
        // first), not just the single dominant city — a firm's footprint is usually
        // scattered across several markets ("across West Palm Beach, Miami and Cabo
        // Rojo"), so naming one city misrepresents it.
        s._firmCityFallback = {
          requestedPlace: s.cities[0] || s.region,
          altCount: altRows.length,
          altCities: sortedCities.slice(0, 8),
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
      var places = fb.altCities || (fb.altCity ? [fb.altCity] : []);
      var altLoc = '';
      if (places.length === 1) {
        altLoc = ' in <b>' + esc(places[0]) + '</b>';
      } else if (places.length >= 2) {
        var shown = places.slice(0, 3).map(function (p) { return '<b>' + esc(p) + '</b>'; });
        var extra = places.length - shown.length;
        var joined;
        if (extra > 0) joined = shown.join(', ') + ' and ' + extra + ' other market' + (extra === 1 ? '' : 's');
        else if (shown.length === 2) joined = shown[0] + ' and ' + shown[1];
        else joined = shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1];   // "A, B and C"
        altLoc = ' across ' + joined;
      }
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
    var panelHtml = renderSmartIntelPanel(ans, q, !willFire, smartGrounding(s, rows, iconicHits), s);
    slotIntel.innerHTML = chipsHtml + panelHtml;

    // Firms & Places tab — CONSISTENCY with the text-match path (which builds
    // this section from scored matches): a smart query that resolved a firm or
    // a single place still surfaces that entity in its own tab. Without this,
    // "allen morris co" (smart path) had no Firms & Places tab while
    // "tampa bay rays" (text path) did.
    var _entCount = 0;
    (function(){
      var ents = '';
      if (s.firm && s.firm.name){
        var ff = null;
        for (var _i = 0; _i < FIRMS.length; _i++){
          if ((s.firm.slug && FIRMS[_i].slug === s.firm.slug) || norm(FIRMS[_i].name) === norm(s.firm.name)) { ff = FIRMS[_i]; break; }
        }
        ents += renderFirmEntity(ff || { name: s.firm.name, slug: s.firm.slug || '', role: s.firm.role || 'firm', project_count: rows.length });
        _entCount++;
      }
      if (s.cities && s.cities.length === 1){
        ents += renderCityEntity({ name: s.cities[0], count: rows.length });
        _entCount++;
      }
      if (ents){
        slotEntities.innerHTML = '<div class="tmw-ov-sec" data-cat="firms">'
          + '<div class="tmw-ov-sec-head"><h3>Firms &amp; places</h3><span class="count">' + _entCount + ' total</span></div>'
          + '<div class="tmw-ov-chiprow">' + ents + '</div>'
          + '</div>';
      }
    })();

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
    var SMART_CAP = 40, ROW_PAGE = 10, GRID_PAGE = 12;
    var maxMetric = 1;
    if (s.sort && s.sort.key === 'floors') maxMetric = Math.max.apply(null, rows.map(Core.floorsOf).concat([1]));
    else if (s.sort && s.sort.key === 'units') maxMetric = Math.max.apply(null, rows.map(Core.unitsOf).concat([1]));
    // Numbered rows ONLY for a quantitative ranking ("tallest", "most units",
    // "opening soonest") — there the rank + metric bar IS the answer. Every
    // other project set (place/type/status browses) renders the same tile GRID
    // the text-match path uses, so "projects coming to london" and a WPB place
    // question look identical (tiles everywhere).
    var rankedList = !!(s.sort && s.sort.key);
    // Render a paginated projects section (header + first page + the rest
    // hidden behind a Load-more button). startRank = the first row's #.
    function renderRowsSection(rowsArr, headHtml, startRank, withCredit){
      if (!rowsArr.length) return '';
      var shownR = rowsArr.slice(0, SMART_CAP);
      var listH, mb;
      if (rankedList){
        var rowsH = shownR.map(function(p, i){
          var html = renderSmartRow(p, i + startRank, s, maxMetric);
          return i >= ROW_PAGE ? html.replace('class="tmw-ov-row ', 'class="tmw-ov-row tmw-ov-row-hidden ') : html;
        }).join('');
        var hc = Math.max(0, shownR.length - ROW_PAGE);
        mb = hc > 0 ? '<button class="tmw-ov-loadmore" type="button" data-action="more-rows">Load '+Math.min(ROW_PAGE, hc)+' more</button>' : '';
        listH = '<div class="tmw-ov-rows">' + rowsH + '</div>';
      } else {
        var cardsH = shownR.map(function(p, i){
          var html = renderProjectCard(p);
          return i >= GRID_PAGE ? html.replace('class="tmw-ov-pcard"', 'class="tmw-ov-pcard tmw-ov-card-hidden"') : html;
        }).join('');
        var hcg = Math.max(0, shownR.length - GRID_PAGE);
        mb = hcg > 0 ? '<button class="tmw-ov-loadmore" type="button" data-action="more-cards">Load '+Math.min(GRID_PAGE, hcg)+' more</button>' : '';
        listH = '<div class="tmw-ov-grid">' + cardsH + '</div>';
      }
      var ft = (rowsArr.length > SMART_CAP) ? '<div class="tmw-ov-smart-foot">Showing top '+SMART_CAP+' of '+rowsArr.length+' — refine your question to narrow it.</div>' : '';
      if (withCredit) ft += '<div class="tmw-ov-smart-foot"><span class="ai">TMW Intelligence</span> · answer synthesized from the project database · figures verified, not generated</div>';
      // Onyx Overview: a "see all N →" jumps to the full Projects tab (visible
      // only in Overview, where the list is capped to 3; the in-section
      // "Load more" is hidden there).
      var saMore = rowsArr.length - 3;   // Overview shows the top 3; this is the rest
      var sa = (saMore > 0) ? '<button class="tmw-ov-seeall" type="button" data-goto="projects">'+saMore+' more projects <span aria-hidden="true">&rarr;</span></button>' : '';
      return '<div class="tmw-ov-sec" data-cat="projects">' + headHtml + listH + sa + mb + ft + '</div>';
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
    _lastFilterCounts = { intel: true, projects: rows.length, firms: _entCount, iconicArticles: iconicHits.length };
    // Onyx 5 redesign: the smart path defaults to the answer-first OVERVIEW
    // too — the Intelligence answer + hero + the ranked rows (and a capped
    // taste of journal), with the counts bar to drill in. Previously pipeline
    // asks ("tallest towers") isolated the Projects tab and HID the answer,
    // which is exactly the firehose-vs-lead problem this redesign fixes. A
    // user who explicitly picked a lens last query still gets it via sticky.
    var defFilter = _setFilter('overview', { intel: true, projects: rows.length, firms: 0 });
    // Place-gate the journal to the queried state (drops a TX/FL golf piece on a
    // CA query). Only for an actual US state (stateCode set, or Florida).
    _qStateName = (s.stateCode || s.region === 'Florida') ? norm(s.region) : '';
    // Journal for a PLACE browse ("projects coming to london") lists the place's
    // stories geography-first — the keyword score alone let name-collision
    // stories through ("The London", an NYC hotel; WPB golf). Same helper (and
    // same authority) as the place-question path.
    var _smPlace = s.area ? s.area.name : (s.cities.length === 1 ? s.cities[0] : '');
    if (_smPlace) { try { var _smArts = articlesForPlace(_smPlace); if (_smArts.length) _qPlaceArts = _smArts; } catch(_){} }
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
      if (!_replaying && window.tmwIntel && window.tmwIntel.track) window.tmwIntel.track(q, { results: rows.length, top_score: _relTopScore(q, rows), sort: s.sort ? s.sort.label : null, source: 'overlay' });
    } catch(_){}

    _lastResultsTotal = rows.length + iconicHits.length;
    _lastResultKind = 'smart';
    setState('results');
  }

  // Top project-relevance score among the displayed rows (0 if none), using the
  // SAME keyword scorer the ranker uses. Powers the weak-hit signal: a query that
  // returned rows but whose best row scores low (< ~24 — the full query never
  // landed in a title/city/neighborhood) means we showed tangential junk, not a
  // real match. Logged with each search so the discovery routine can auto-queue
  // weak hits, not just zero-result misses. Pure + defensive: any failure → 0.
  function _relTopScore(q, rows){
    try {
      var Core = window.TmwSearchCore;
      if (!Core || !Core.scoreProjectKw || !Core.norm || !rows || !rows.length) return 0;
      var full = Core.norm(q || '');
      var toks = full.split(/\s+/).filter(Boolean);
      if (Core.filterMeaningfulTokens) { var mt = Core.filterMeaningfulTokens(toks); if (mt && mt.length) toks = mt; }
      var top = 0, n = Math.min(rows.length, 6);
      for (var i = 0; i < n; i++){ var p = rows[i]; if (!p || !p.Title) continue; var sc = Core.scoreProjectKw(p, toks, full); if (sc > top) top = sc; }
      return top;
    } catch(_){ return 0; }
  }

  // Debounced LLM rewrite of the structured-smart sentence. Same 700ms
  // settle as /search/. Stale-token guarded so a late response for
  // query N doesn't paint over query N+1.
  function fireSmartIntelUpgrade(q, s, rows, iconicHits){
    var Core = window.TmwSearchCore;
    if (!Core) return;
    var facts = attachPlaceScope(Core.buildSmartFacts(s, rows, iconicHits), q);
    // History rides along for real follow-ups AND any turn that inherited the
    // thread's place — the LLM then knows what "the pipeline" refers to.
    var hist = (_isFollowupQ(q) || (s && s._inheritedPlace) || facts._inheritedPlace) ? threadHistory() : [];
    var _intelSlot = slotIntel;                              // capture THIS turn's slot (it moves per turn)
    var _turnRec = _thread.length ? _thread[_thread.length - 1] : null;
    var _turnCtx = _currentTurnCtx;                          // article context for THIS turn (if opened from an article)
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
      Core.askIntelligence(q, facts, hist, { deep: _deepActive(), member: _memberId(), article: _turnCtx }).then(function(res){
        var ansEl = _intelSlot.querySelector('.tmw-ov-intel-ans');
        if (!ansEl) return;
        if (res && res.ok && res.answer){
          ansEl.innerHTML = linkifyAnswer(esc(res.answer)); ansEl.classList.remove('loading'); setLive();
          // Deep answers are multi-paragraph — render the preserved breaks; sync the
          // header badge to the answer's actual mode (downgrades if it was capped).
          if (res.deep) ansEl.classList.add('deep'); else ansEl.classList.remove('deep');
          syncModelBadge(_intelSlot, !!res.deep);
          updateDeepMeta(res);
          cacheAnswer(q, res.answer, smartGrounding(s, rows, iconicHits));   // remember (with receipts) for instant resume
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
  var _qPlaceArts = null;     // place question → ALL the place's stories for the Journal tab (newest first)
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
      // Flag every article the worker matched by BODY for THIS query (nq) — both
      // ones already loaded (summary-only, so the client scorer missed the body
      // hit) and brand-new ones. scoreArticle trusts this flag so true title+body
      // journal matches surface instead of being dropped by the summary-only gate.
      var nq = norm(q);
      var bySlug = {};
      ARTICLES.forEach(function(a){ var k = a.slug || a.id; if (k) bySlug[k] = a; });
      var changed = 0;
      results.forEach(function(d){
        var items = (d && Array.isArray(d.items)) ? d.items : [];
        items.forEach(function(a){
          var k = a.slug || a.id; if (!k) return;
          var ex = bySlug[k];
          if (ex){ if (ex._bodyHit !== nq){ ex._bodyHit = nq; changed++; } }
          else { a._bodyHit = nq; ARTICLES.push(a); bySlug[k] = a; changed++; }
        });
      });
      if (changed) renderArticleSection(q, token, { fromBodyMerge: true });
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
    // SLIM (text/keyword path): a QUESTION that isn't an explicit list request drops
    // the project + firm lists so it reads as the pure LLM answer. Mirrors the same
    // gate in renderStructuredSmart. List-intent ("give me a list", "biggest
    // projects") and plain name/keyword lookups keep their cards.
    if (question && !listIntent(q)) {
      try { sResults.setAttribute('data-slim', '1'); } catch (_) {}
    }

    _qPlaceTokens = null; _qPlaceMatch = null; _qStateName = '';   // reset place-aware article matching per query
    // COVERAGE MISS — the query named a place we don't track ("... in port st lucie").
    // Show NO project/firm cards rather than keyword-leaking a same-word project from
    // another city ("port" → "PORT 32 Palm Beach Gardens"); the prose + journal answer.
    var _cityMiss = (Core && Core.namedCityMiss) ? Core.namedCityMiss(q, PROJECTS) : null;
    var pScored = _cityMiss ? [] : PROJECTS.map(function(p){ return { p:p, s:scoreProject(p, stoks, full) }; })
                          .filter(function(x){ return x.s >= MIN_PROJECT_SCORE; })
                          .sort(function(a,b){ return b.s - a.s; });
    var fScored = _cityMiss ? [] : FIRMS.map(function(f){ return { f:f, s:scoreFirm(f, stoks, full) }; })
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

    // ── #4 UNIFIED RETRIEVER — project kind ──────────────────────────
    // A classifier-confident PROJECT query (a direct name lookup) ranks through
    // the one shared core retriever instead of this function's inline keyword +
    // scattered _literal/_exactName logic. The keyword signal is identical
    // (Core.scoreProjectKw === scoreProject), so the ranked set is unchanged; the
    // win is a single source of truth in core that the place/concept kinds join
    // next. The downstream _intentKind==='project' guards still force the
    // exact-name path + full hero. Skipped during a semantic-rescue re-invoke.
    var _ik = (opts.intent && (opts.intent.confidence == null || opts.intent.confidence >= 0.6)) ? opts.intent.kind : null;
    if (_ik === 'project' && !opts.rescueProjects && Core && Core.rankProjects) {
      var _rp = Core.rankProjects(q, PROJECTS, { kind: 'project', toks: toks, full: full });
      if (_rp && _rp.rows.length) {
        var _kept = _rp.rows.filter(function (x) { return x.s >= MIN_PROJECT_SCORE; });
        // keep the named project even if it scores below the grid threshold
        pScored = _kept.length ? _kept : _rp.rows.slice(0, 1);
        totalHits = pScored.length + fScored.length + aScored.length;
      }
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
      // Compare on alphanumerics only so stray punctuation/typos ("south flagler
      // house\") don't break the exact-name match and wrongly trigger the place
      // override. Match either direction (title contains query OR query contains
      // title) so a fully-typed project name resolves to that project.
      // Literal = the query IS a project's name (exact, or the query is that full
      // title plus extra words). NOT when the query is merely a FRAGMENT of a
      // longer title — "the palm beaches" is a substring of "YMCA of the Palm
      // Beaches" but names a PLACE, so it must keep the place fan-out.
      var _fa = full.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      var _literal = false;
      if (_fa.length >= 4) for (var _li = 0; _li < PROJECTS.length; _li++) {
        var _ta = norm(PROJECTS[_li].Title || '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (_ta.length >= 4 && (_ta === _fa || _fa.indexOf(_ta) >= 0)) { _literal = true; break; }
      }
      // Intent router override: a classified PROJECT forces the exact-project
      // path (skip the place override); a classified CITY/AREA forces the place
      // fan-out (so a title-substring can't hijack it). Heuristic stands otherwise.
      var _intentKind = opts && opts.intent && opts.intent.kind;
      if (_intentKind === 'project') _literal = true;
      else if (_intentKind === 'area' || _intentKind === 'city') _literal = false;
      // Not when a real firm name dominates the query (e.g. "Allen Morris"): a
      // strong firm match outranks an incidental place token.
      var _firmDom = fScored.length && fScored[0].s >= 6 && pScored.length < 3;
      var _sq = Core.parseSmartQuery ? Core.parseSmartQuery(q, { projects: PROJECTS, firms: [] }) : null;
      // Not for a firm-RANKING ask ("most active developer in Miami") — that
      // answer is a firm leaderboard; let the existing city/firm path own it.
      var _firmRank = _sq && _sq.firmRank;
      // A concept question that only mentions the place ("...changing florida
      // development") must NOT rebuild the generic place pipeline — let it fall
      // through to the topic-relevant semantic enrichment instead.
      if (!_literal && !_firmDom && !_firmRank && !opts.conceptQ) {
        // #4 unified retriever — place kind. The project set (every project in the
        // place, type/status-refined, spine-ranked) comes from the one shared
        // retriever, identical to the structured/eval paths. The overlay-side
        // place-aware article matching + re-scoring stays here.
        var _pr = Core.rankProjects ? Core.rankProjects(q, PROJECTS, { kind: 'place', place: placeHit, smart: _sq }) : null;
        var _rows = _pr ? _pr.rows.map(function (x) { return x.p; }) : [];
        if (_rows.length) {
          pScored = _pr.rows;   // already {p,s} descending in spine order
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
      // ── Analytical questions that NAME a place render as a PLACE BROWSE ──
      // "tell me about the construction pipeline in west palm beach" was
      // keyword-scored: Projects tab said 1 (of WPB's 60) and a stale article
      // took the hero. Resolve the place from the question, promote its full
      // spine-ranked pipeline into the result set, and flip placeDriven so the
      // hero policy leads with the answer + project cards, not an old article.
      if (question && !placeDriven && !areaHit && !cityHit && !foodIntent){
        try {
          var _qs = Core.parseSmartQuery ? Core.parseSmartQuery(q, { projects: PROJECTS, firms: FIRMS || [] }) : null;
          var _qName = null, _qSet = null;
          if (_qs && (_qs.area || (_qs.cities && _qs.cities.length))) {
            _qName = _qs.area ? _qs.area.name : _qs.cities.join(' & ');
            _qSet = Core.smartRank(Core.smartFilter(_qs, PROJECTS) || [], _qs);
            if (_qSet.length && _qSet.length < 25) {          // top thin status/type cuts up to the whole pipeline
              var _qAll = Core.parseSmartQuery(_qName, { projects: PROJECTS, firms: [] });
              if (_qAll) {
                var _qSeen = {}; _qSet.forEach(function(pp){ _qSeen[pp.Title] = 1; });
                (Core.smartRank(Core.smartFilter(_qAll, PROJECTS) || [], _qAll)).forEach(function(pp){
                  if (!_qSeen[pp.Title]) { _qSet.push(pp); _qSeen[pp.Title] = 1; }
                });
              }
            }
          } else if (Core.resolvePlace) {                     // place/neighborhood named mid-sentence
            var _qrp = Core.resolvePlace(q, PROJECTS);
            if (_qrp && _qrp.name) {
              var _qsn = Core.parseSmartQuery(_qrp.name, { projects: PROJECTS, firms: [] });
              if (_qsn) { _qSet = Core.smartRank(Core.smartFilter(_qsn, PROJECTS) || [], _qsn); _qName = _qrp.name; }
              else if (Core.detectNeighborhood) {
                var _qnb = Core.detectNeighborhood(_qrp.name, PROJECTS);
                if (_qnb && _qnb.city) { _qSet = PROJECTS.filter(inCity(_qnb.city)); _qName = _qnb.city; }
              }
            }
          }
          // The place set is AUTHORITATIVE scope for a place question — loose
          // keyword scoring can "match" hundreds of projects on words like
          // "development"/"west", so never compare sizes against it.
          if (_qSet && _qSet.length >= 3) {
            pScored = _qSet.map(function(pp, i){ return { p: pp, s: _qSet.length - i }; });
            placeDriven = true; placeName = _qName;
            // Journal tab: a place question lists ALL the place's stories
            // (newest first) — not the few keyword matches. Geography-first
            // matching (articlesForPlace) so name-collision stories from other
            // cities never pollute the tab.
            try {
              // AUTHORITATIVE when non-empty (not a count contest against the
              // keyword list): a smaller clean geography set beats a bigger
              // polluted keyword set every time.
              var _qArts = articlesForPlace(_qName);
              if (_qArts.length) { aScored = _qArts.map(function(a, i){ return { a: a, s: _qArts.length - i }; }); _qPlaceArts = _qArts; }
            } catch(_){}
          }
        } catch(_){}
      }
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
            // Feed the FULL place set (facts caps its own detail rows; count =
            // everything), so the answer + receipts reflect the real pipeline.
            intelProjects = pScored.slice(0, 60).map(function(x){ return x.p; });
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
            // A QUESTION that names a place ("tell me about the construction
            // pipeline in west palm beach", "what's happening in brickell") must
            // be grounded in the PLACE'S pipeline — not the handful of
            // keyword-scored matches — or the answer (and its receipts) see 5
            // projects where the city has 60. The analytical override skips the
            // structured RENDER path, so reuse the parse/resolvers for SCOPE.
            var _placeSet = null;
            try {
              var sPl = Core.parseSmartQuery ? Core.parseSmartQuery(q, { projects: PROJECTS, firms: FIRMS || [] }) : null;
              if (sPl && (sPl.area || (sPl.cities && sPl.cities.length))) {
                _placeSet = Core.smartRank(Core.smartFilter(sPl, PROJECTS) || [], sPl);
                intelPlace = sPl.area ? sPl.area.name : sPl.cities.join(' & ');
                // The parse may carry status/type narrowing ("construction" →
                // Under Construction, 13 of WPB's 60). Good lead ordering — but
                // an overview answer wants the WHOLE pipeline behind it, so top
                // up with the rest of the place's projects after the narrowed set.
                if (_placeSet.length && _placeSet.length < 25) {
                  var sAll = Core.parseSmartQuery(intelPlace, { projects: PROJECTS, firms: [] });
                  if (sAll) {
                    var _seen = {}; _placeSet.forEach(function(pp){ _seen[pp.Title] = 1; });
                    (Core.smartRank(Core.smartFilter(sAll, PROJECTS) || [], sAll)).forEach(function(pp){
                      if (!_seen[pp.Title]) { _placeSet.push(pp); _seen[pp.Title] = 1; }
                    });
                  }
                }
              }
              if (!_placeSet || !_placeSet.length) {
                // Neighborhood or place named mid-sentence ("what's happening in
                // brickell right now") — vocab scan, then neighborhood → parent city.
                var rp = Core.resolvePlace ? Core.resolvePlace(q, PROJECTS) : null;
                if (rp && rp.name) {
                  var sName = Core.parseSmartQuery(rp.name, { projects: PROJECTS, firms: [] });
                  if (sName) {
                    _placeSet = Core.smartRank(Core.smartFilter(sName, PROJECTS) || [], sName);
                    intelPlace = rp.name;
                  } else if (Core.detectNeighborhood) {
                    var nbq = Core.detectNeighborhood(rp.name, PROJECTS);
                    if (nbq && nbq.city) { _placeSet = PROJECTS.filter(inCity(nbq.city)); intelPlace = nbq.city; }
                  }
                }
              }
            } catch(_){ _placeSet = null; }
            if (_placeSet && _placeSet.length) {
              intelProjects = _placeSet.slice(0, 60);
            } else {
              intelProjects = pScored.slice(0, 5).map(function(x){ return x.p; });
              intelPlace = null;
            }
          }
          // Food queries already fired (journal facts) inside the branch above.
          if (!foodIntent) {
            // Among the top keyword-scored articles, prefer the NEWEST for the
            // answer's context — a year-old top-off story shouldn't headline a
            // "what's happening now" answer just because it scores highest.
            var _recentArts = aScored.slice(0, 8).map(function(x){ return x.a; })
              .sort(function(a, b){ return String(b.published_iso || '').localeCompare(String(a.published_iso || '')); })
              .slice(0, 3);
            fireIntelligence(q, intelProjects, _recentArts, nycPlace(intelPlace), null, token);
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
        webFallback(q, token);
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
      _setFilter(question ? 'intel' : 'articles', _lastFilterCounts);
      var _ac = renderArticleSection(q, token);
      _lastResultsTotal = 0;
      _lastResultKind = 'question';
      setState('results');
      enrichSemanticProjects(q, token, _ac);
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
    // HERO POLICY: the big hero card shows ONLY for a perfect project-name match
    // (a direct project search). City / area / topic browses lead with the
    // answer + a few supporting project CARDS — never a hero. Food still leads
    // with its article; an explicit firm search keeps its firm hero.
    var _exactName = false;
    if (!foodIntent && pScored.length && heroProjectEligible(pScored[0].p, full, toks)) {
      var _fa = full.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      var _ta = norm(pScored[0].p.Title || '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      _exactName = _ta.length >= 4 && (_ta === _fa || _fa.indexOf(_ta) >= 0);
      // Intent router: a classified PROJECT query gets the full hero even if the
      // alphanumeric match is fuzzy (typos), as long as the top result is solid.
      if (opts && opts.intent && opts.intent.kind === 'project' && pScored[0].s >= 2) _exactName = true;
      if (_exactName) heroCandidates.push({ kind:'project', s: 1e5, item: pScored[0].p });
    }
    if (aScored.length) {
      var heroArt = aScored[0].a;
      if (foodIntent) { var fa = aScored.filter(function(x){ return isFoodArticle(x.a); })[0]; if (fa) heroArt = fa.a; }
      // Article hero only for food, or a non-place journal/topic answer — NOT for
      // a city/area browse (those just list projects under the area answer).
      if (foodIntent || (!placeDriven && heroArticleEligible(aScored[0].a, full, toks))) {
        heroCandidates.push({ kind:'article', s: foodIntent ? 1e6 : aScored[0].s, item: heroArt });
      }
    }
    // Firms never take the hero slot (2026-07-12): an exact firm-name query
    // heroes that firm's flagship PROJECT instead (e.g. "tampa bay rays" ->
    // the Rays ballpark) when the firm has exactly one tracked project. The
    // firm itself stays in the Firms & Places tab. Multi-project firms get
    // the normal answer + project grid (no single flagship to crown).
    if (!heroCandidates.length && fScored.length && heroFirmEligible(fScored[0].f, full)) {
      var _fw = norm(fScored[0].f.name || '');
      var _byFirm = _fw ? PROJECTS.filter(function(_fp){
        return norm(((_fp.Developer || '') + ' ' + (_fp.Architect || ''))).indexOf(_fw) >= 0;
      }) : [];
      if (_byFirm.length === 1) { _exactName = true; heroCandidates.push({ kind:'project', s: 9e4, item: _byFirm[0] }); }
    }
    heroCandidates.sort(function(a,b){ return b.s - a.s; });
    var hero = heroCandidates[0] || null;
    if (hero){
      var heroHtml = '';
      var heroCat = 'projects';
      if      (hero.kind === 'project') { heroProject = hero.item; heroHtml = renderProjView(heroProject); heroCat = 'projects'; }
      else if (hero.kind === 'article') { heroArticle = hero.item; heroHtml = renderArticleHero(heroArticle); heroCat = 'articles'; }
      // Perfect database match (exact project name) → render the FULL hero card,
      // not the compacted overview row. A journal hero is ALWAYS the full card
      // (Jake: one big full-width story tile like the project hero; the rest of
      // the stories live in the Journal tab).
      var _fullHero = !!(hero.kind === 'project' && typeof _exactName !== 'undefined' && _exactName);
      var _heroClass = _fullHero ? ' tmw-ov-exacthero' : (heroCat === 'articles' ? ' tmw-ov-arthero' : '');
      slotHero.innerHTML = '<div class="tmw-ov-sec'+_heroClass+'" data-cat="'+heroCat+'">' + heroHtml + '</div>';
      // The inline pv card needs the same wiring the fullscreen panel gets in
      // _paintProjCard: the 1/N counter follows the track scroll, and the Watch
      // button paints its saved state. (Arrow + Watch CLICKS ride the delegated
      // root handler.)
      var _hpv = slotHero.querySelector('.tmw-pv');
      if (_hpv){
        var _htk = _hpv.querySelector('.tmw-pv-track'), _hix = _hpv.querySelector('[data-pvidx]');
        if (_htk && _hix) _htk.addEventListener('scroll', function(){ _hix.textContent = String(Math.round(_htk.scrollLeft / Math.max(1, _htk.clientWidth)) + 1); }, { passive: true });
        var _hwb = _hpv.querySelector('[data-pvwatch]');
        if (_hwb) loadFavs().then(function(set){ var s = _hwb.getAttribute('data-slug'); if (s && set.has(s.toLowerCase())){ _hwb.classList.add('on'); var t = _hwb.querySelector('.tmw-pv-watch-txt'); if (t) t.textContent = 'Watching'; } });
      }
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
    // Perfect project-name match (a direct search like "ponce park") → the user
    // wants THAT project, not a grid of everything else that shares a common word
    // ("park" pulling projects from all over the state, or a fuzzy same-developer
    // connection). Suppress the generic Projects grid; keep ONLY projects in the
    // SAME FORMAL parent-child hierarchy as the hero (a district's towers via
    // ParentSlug), never the loose description/developer-anchored connections.
    if (_fullHero && heroProject) {
      var _hSlug   = (heroProject.Slug || '').trim();
      var _hParent = (heroProject.ParentSlug || '').trim();
      restProjects = restProjects.filter(function (x) {
        var pSlug = (x.p.Slug || '').trim(), pParent = (x.p.ParentSlug || '').trim();
        if (_hSlug && pParent === _hSlug) return true;                 // hero is this project's parent (its child tower)
        if (_hParent && pSlug === _hParent) return true;               // this project IS the hero's parent
        if (_hParent && pParent && pParent === _hParent) return true;  // shared parent (true sibling)
        return false;
      });
    }
    // A full place pipeline can run 60+ projects — render up to GRID_CAP tiles
    // with everything past the first page hidden behind a Load-more (the grid
    // previously hard-capped at 12 with only the Overview see-all, so the
    // Projects tab could never show the rest).
    var GRID_CAP = 60;
    var gridProjects = restProjects.slice(0, GRID_CAP).map(function(x){ return x.p; });
    if (gridProjects.length){
      // Section label changed from "Nearby Projects" -> "Projects" — the
      // grid wasn't geographically nearby (the rest of the result set
      // can include any matching city), so the spatial framing was
      // misleading. Count reflects the filtered set, not the raw text-
      // match total.
      var gridHtml = gridProjects.map(function(p, gi){
        var html = renderProjectCard(p);
        return gi >= MAX_PROJECTS_GRID ? html.replace('class="tmw-ov-pcard"', 'class="tmw-ov-pcard tmw-ov-card-hidden"') : html;
      }).join('');
      var gridHidden = Math.max(0, gridProjects.length - MAX_PROJECTS_GRID);
      slotProjGrid.innerHTML = ''
        + '<div class="tmw-ov-sec" data-cat="projects">'
        +   '<div class="tmw-ov-sec-head"><h3>Projects</h3><span class="count">'+restProjects.length+(heroProject?' more':' total')+'</span></div>'
        +   '<div class="tmw-ov-grid">' + gridHtml + '</div>'
        +   (restProjects.length > 3 ? '<button class="tmw-ov-seeall" type="button" data-goto="projects">See all '+restProjects.length+' projects <span aria-hidden="true">&rarr;</span></button>' : '')
        +   (gridHidden > 0 ? '<button class="tmw-ov-loadmore" type="button" data-action="more-cards">Load '+Math.min(MAX_PROJECTS_GRID, gridHidden)+' more</button>' : '')
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
      webFallback(q, token);
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
    // Onyx 5 redesign: every query defaults to the answer-first OVERVIEW —
    // the analyst answer + the single best hero + a capped taste of each
    // section. The counts-bar pills drill into any one category for the full
    // set. A user who explicitly picked a lens last query gets it back via
    // stickiness; otherwise Overview leads.
    var defF = _setFilter('overview', _lastFilterCounts);
    var _artC = renderArticleSection(q, token);

    _lastResultsTotal = totalHits;
    _lastResultKind = question ? 'question' : 'text';
    setState('results');
    // No project rows landed (e.g. a concept question that only hit articles) —
    // surface the projects the index relates to the topic. Additive; the helper
    // no-ops if real projects are already shown.
    if (!(restProjects.length + (heroProject ? 1 : 0))) enrichSemanticProjects(q, token, _artC);

    // Log plain text-match queries to the Studio analytics tab. Question
    // + structured-smart paths log via tmwIntel.count/track elsewhere;
    // plain searches (e.g. "1428 Brickell", "Wynwood") never reach those
    // paths, so without this branch the Studio would lose visibility on
    // every typed query that didn't trigger Intelligence.
    try {
      if (!_replaying && !question && window.tmwIntel && window.tmwIntel.trackSearch) {
        var _txtRows = (heroProject ? [heroProject] : []).concat(restProjects || []);
        window.tmwIntel.trackSearch(q, { source: 'overlay', results: totalHits, top_score: _relTopScore(q, _txtRows) });
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
    // Analytical/synthesis question → the LLM prose IS the answer; no journal list, no tabs.
    if (_answerOnly) { slotArticles.innerHTML = ''; slotFilterPills.innerHTML = ''; return 0; }
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
                          // STRICT: a card must be a real topical hit, not a place-only
                          // co-location. Skip the gate only for a broad browse (no query
                          // tokens, e.g. "what's new") where "latest" is the intent.
                          // A worker BODY hit (_bodyHit === full) always passes — the term
                          // lives in the article body, which articleHasTextHit can't see.
                          .filter(function(x){ return x.s > 0 && x.a !== hero && (!stoks.length || (x.a && x.a._bodyHit === full) || articleHasTextHit(x.a, stoks, full)); })
                          .sort(function(a,b){ return b.s - a.s; });
    // High-rise / tower queries carry no topical article tokens (the height words
    // are stopwords), so the place alone matches every local story — dumping
    // wellness/dining/etc. slop under "high rises in X". Keep only genuinely
    // tower-relevant pieces. (If none qualify, leave the set as-is.)
    if (/\b(high[\s-]?rises?|highrises?|skyscrapers?|supertall|towers?)\b/.test(full)) {
      var _towerRe = /high[\s-]?rise|skyscraper|\btower|supertall|condo|penthouse|skyline|tallest|stor(?:y|ies)|\bfloors?\b|mixed[\s-]?use|residential tower|office tower|apartment tower/;
      var _tw = aScored.filter(function(x){
        var a = x.a;
        var blob = norm((a.title || '') + ' ' + (a.excerpt || a.dek || a.summary || '') + ' ' + ((a.categories || []).join(' ')) + ' ' + ((a.tags || []).join(' ')));
        return _towerRe.test(blob);
      });
      if (_tw.length) aScored = _tw;
    }
    // Place question/browse: the Journal tab lists ALL the place's stories
    // (newest first, geography-first via articlesForPlace) — keyword matches
    // are ignored entirely, whatever their count: a smaller clean geography
    // set beats a bigger polluted one.
    if (_qPlaceArts && _qPlaceArts.length) {
      aScored = _qPlaceArts.filter(function(a){ return a !== hero; }).map(function(a, i){ return { a: a, s: _qPlaceArts.length - i }; });
    }
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
      // No article matched this query. Show the "latest stories" browse fallback
      // ONLY for a broad/empty browse (no meaningful query tokens, e.g. "what's
      // new"). For a SPECIFIC query — a place or topic that simply has no matching
      // coverage (e.g. "across asia") — dumping recent GLOBAL stories (a Mexico
      // resort, a Spain hotel, a WPB condo) reads as junk and unrelated, so show a
      // graceful empty note instead. (Suppressed entirely when an iconic list is
      // already the Journal answer.)
      var broadBrowse = !stoks.length;
      if (opts.suppressFallback) {
        slotArticles.innerHTML = '';
      } else if (broadBrowse) {
        var recent = ARTICLES.slice(0, 9);
        slotArticles.innerHTML = recent.length
          ? ('<div class="tmw-ov-sec tmw-ov-jfallback" data-cat="articles">'
              + '<div class="tmw-ov-sec-head"><h3>Latest from the journal</h3><span class="count">browse all</span></div>'
              + '<div class="tmw-ov-alist">' + recent.map(renderArticleCard).join('') + '</div>'
              + '</div>')
          : '';
      } else {
        slotArticles.innerHTML = '<div class="tmw-ov-sec tmw-ov-jfallback" data-cat="articles">'
          + '<div class="tmw-ov-sec-head"><h3>From the journal</h3></div>'
          + '<div class="tmw-ov-jempty">No journal stories on this yet — <a href="'+SEARCH_URL+'">browse all stories &rarr;</a></div>'
          + '</div>';
      }
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
    if (_answerOnly) return '';   // answer-only: no category tabs, just the prose
    var pills = [];
    pills.push('<button class="tmw-ov-fp active" type="button" data-filter="overview">Overview</button>');
    if (counts.projects > 0) {
      pills.push('<button class="tmw-ov-fp" type="button" data-filter="projects">Projects <span class="tmw-ov-fp-n">'+counts.projects+'</span></button>');
    }
    if (counts.firms > 0) {
      pills.push('<button class="tmw-ov-fp" type="button" data-filter="firms">Firms &amp; Places <span class="tmw-ov-fp-n">'+counts.firms+'</span></button>');
    }
    // Journal tab is always present (Jake wants the Overview / Journal / Projects
    // tabs); the COUNT is shown only when stories matched, and the content under it
    // is curated to real topical hits (see articleHasTextHit) so it's not a dump.
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
    // End every paint on a COMPLETE row while more stories remain — a lone
    // card on the last row reads as "that's the end" when it isn't.
    // Column count: when the grid is laid out, gridTemplateColumns resolves to
    // a px list ("437px 437px 437px" → count the entries). But this runs while
    // the results pane is still hidden (setState('results') comes after the
    // render), where the SPECIFIED value comes back instead — "repeat(3, 1fr)"
    // — which the splitter miscounted as 2, so 10 % 2 === 0 skipped the trim
    // and the Journal tab opened on an orphaned last row. Parse repeat(N) first.
    var _cols = 3;
    try {
      var _tc = getComputedStyle(listEl).gridTemplateColumns || '';
      var _rep = _tc.match(/repeat\(\s*(\d+)/);
      _cols = _rep ? +_rep[1] : ((_tc.split(' ').filter(Boolean).length) || 3);
    } catch(_){}
    var _want = _articlesShown + ARTICLES_BATCH;
    if (_want < _articlesAll.length && _cols > 1 && (_want % _cols)) _want -= (_want % _cols);
    var batch = _articlesAll.slice(_articlesShown, Math.max(_articlesShown + 1, _want));
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
    if (best) return best.disp;
    // Bare neighborhood ("brickell", "wynwood") → its parent city, so the query
    // scopes to Miami's pipeline instead of falling to fuzzy text-match.
    var nb = Core.detectNeighborhood ? Core.detectNeighborhood(q, PROJECTS) : null;
    return nb && nb.city ? nb.city : null;
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
    if (_answerOnly) { slotHero.innerHTML = ''; return; }   // analytical → prose only, no hero
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
    slotHero.innerHTML = '<div class="tmw-ov-sec tmw-ov-arthero" data-cat="articles">' + renderArticleHero(a) + '</div>';
    try { renderArticleSection(q, token, { fromBodyMerge: true }); } catch(_){}
  }

  // Place scope for the ANSWER: when the query resolves to a real place, the
  // worker must keep its semantic `related` recall (and therefore the prose)
  // INSIDE that place — otherwise "across colorado" can let the answer cite a
  // Charleston project (Limelight is an Aspen brand → semantic neighbor). The
  // worker only has each match's city, so we hand it the set of in-place city
  // names. Returns null for non-resolvable "places" (e.g. "asia") → no scope.
  function placeScopeFor(q){
    var Core = window.TmwSearchCore;
    if (!Core || !Core.resolvePlace) return null;
    var ph = Core.resolvePlace(q, PROJECTS);
    if (!ph || typeof ph.match !== 'function') return null;
    var seen = {}, cities = [];
    for (var i = 0; i < PROJECTS.length; i++) {
      if (!ph.match(PROJECTS[i])) continue;
      var c = norm(String(PROJECTS[i].City || '').split(',')[0].trim());
      if (c && !seen[c]) { seen[c] = 1; cities.push(c); if (cities.length >= 80) break; }
    }
    return cities.length ? { name: ph.name, cities: cities } : null;
  }
  // Latest place the conversation referenced (walking back over turns).
  function _priorPlaceName(){
    for (var i = _thread.length - 2; i >= 0; i--){
      var t = _thread[i];
      if (t && t.place) return t.place;
    }
    return null;
  }
  // Attach the resolved place scope to a facts object. When THIS query names no
  // place but the thread already has one, inherit it — a follow-up ("whats the
  // total unit count in the pipeline") stays scoped to the market being
  // discussed instead of going cold. Skipped when the turn is about a FIRM
  // (firm portfolios span markets). The resolved place is recorded on the turn
  // so the chain keeps flowing forward.
  function attachPlaceScope(facts, q){
    if (!facts) return facts;
    var ps = placeScopeFor(q);
    if (!ps){
      var cur = _thread.length ? _thread[_thread.length - 1] : null;
      var isFirmTurn = !!(cur && cur.parsed && (cur.parsed.firm || cur.parsed.firmRank));
      var pp = isFirmTurn ? null : _priorPlaceName();
      if (pp){ ps = placeScopeFor(pp); if (ps) facts._inheritedPlace = true; }
    }
    if (ps) {
      facts.placeName = ps.name; facts.placeCities = ps.cities;
      if (_thread.length) _thread[_thread.length - 1].place = ps.name;
    }
    return facts;
  }

  function fireIntelligence(q, topProjects, topArticles, place, topic, token, placeTerms){
    var Core = window.TmwSearchCore;
    if (!Core) return;
    // Capture THIS turn's record now (before the async call) so a journal/question
    // answer is stored for follow-up context + faithful resume — the structured
    // path does this; this path didn't, so those turns never fed the LLM history.
    var _turnRec = _thread.length ? _thread[_thread.length - 1] : null;
    // INSTANT RESUME — an answer we already have (this device's 24h cache, or
    // seeded from the account thread) renders immediately and NEVER re-queries
    // the LLM. The structured path has had this guard for a while; this path
    // didn't, so every restored question-turn flashed the loading shell and
    // burned a fresh /smart-answer call on each return visit.
    var _cachedA = cachedAnswer(q);
    if (_cachedA) {
      slotIntel.innerHTML = intelPanelHtml('answer', q, _cachedA, false, cachedGrounding(q));
      if (_turnRec) _turnRec.answer = _cachedA;   // follow-ups still get their context
      return;
    }
    var _turnCtx = _currentTurnCtx;                          // article context for THIS turn (if opened from an article)
    // Capture THIS turn's intel slot too — `slotIntel` advances when the next
    // turn renders, so an async answer painted into the LIVE slotIntel lands on
    // the WRONG turn's panel (stale answer + receipts on a follow-up turn). The
    // structured path (fireSmartIntelUpgrade) already does this.
    var _intelSlot = slotIntel;
    // `topic` (e.g. 'food & drink') → answer from journal ARTICLES, not projects.
    // placeTerms lets the worker pull body-level matches from D1 for the place.
    var facts = attachPlaceScope((topic && Core.buildJournalFacts)
      ? Core.buildJournalFacts(topArticles, place, topic, placeTerms)
      : Core.buildIntelFacts(topProjects, topArticles, place), q);
    var myToken = ++_intelToken;
    clearTimeout(_intelDebounce);
    _intelDebounce = setTimeout(function(){
      if (myToken !== _intelToken) return;
      var _fuHist = (_isFollowupQ(q) || (facts && facts._inheritedPlace)) ? threadHistory() : [];
      Core.askIntelligence(q, facts, _fuHist, { deep: _deepActive(), member: _memberId(), article: _turnCtx }).then(function(res){
        if (myToken !== _intelToken) return;
        // The 'Thinking' live-pip was relocated into the feedback row by setState
        // BEFORE this async answer arrived; rebuilding the panel below makes a new
        // pip in the (overview-hidden) header but leaves the relocated one stuck on
        // 'Thinking'. Flip every live pip in this turn so the footer stops saying
        // THINKING once the answer (or a miss) lands. (The structured path has its
        // own setLive(); this is the question/concept/journal path's equivalent.)
        function _stopThinking(ok){
          try {
            var _t = _intelSlot.closest && _intelSlot.closest('.tmw-ov-turn');
            if (!_t) return;
            _t.querySelectorAll('.live').forEach(function(l){
              if (ok) { l.classList.remove('dim'); l.innerHTML = '<i></i>Live answer'; }
              else { l.classList.add('dim'); l.innerHTML = '<i></i>Answer'; }
            });
          } catch(_){}
        }
        if (res && res.ok && res.answer){
          var _artN = 0;
          try { _artN = (facts.top || []).filter(function(t){ return t && t.status === 'Article'; }).length; } catch(_){}
          var _ground = { p: Math.max(0, (facts.count || 0)), a: _artN, place: facts.place || null };
          _intelSlot.innerHTML = intelPanelHtml('answer', q, res.answer, res.deep, _ground);
          updateDeepMeta(res);
          _stopThinking(true);
          if (_turnRec) _turnRec.answer = res.answer;   // feed the next follow-up's context
          cacheAnswer(q, res.answer, _ground);   // remember for instant resume / repeat
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
          _intelSlot.innerHTML = intelPanelHtml('error', q);
          _stopThinking(false);
        } else {
          _intelSlot.innerHTML = intelPanelHtml('no-answer', q);
          _stopThinking(false);
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
    // Emptying the box (e.g. backspacing out a query) must NOT snap back to the
    // starter/home suggestions once a conversation exists — that yanked the user
    // to the top of the page. Only fall back to the starter on a fresh session.
    if (!v && (!_thread || !_thread.length)) setState('starter');
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
      // Already on a search hash (#search or a #search=<query> deep link) — leave it,
      // so we never clobber a shared query hash or stack a duplicate history entry.
      if (isSearchHash()) return;
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
  function open(initialQuery, ctx){
    _pendingCtx = (ctx && ctx.title) ? ctx : null;   // article handoff context for the first turn
    if (root.classList.contains('open')) return;
    _savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.style.overflow = 'hidden';
    root.classList.add('open');
    // Reflect the open spotlight in the URL (#search) so the state is
    // linkable + the Studio activity feed can tell "reading" from "searching".
    // No-op when we arrived via a #search / #search=<query> deep link.
    pushHash();
    // Refresh the PRO / quota badge in the teach card -- and pull the AUTHORITATIVE
    // account-bound remaining from the server (so the gate + counter reflect real
    // usage, not per-device localStorage). sync() refreshes the pill on return.
    if (window.tmwIntel && window.tmwIntel.sync) window.tmwIntel.sync(); else refreshProPill();
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
      else { input.value = ''; setState('starter'); }
      // Session-only history: no cloud reconcile — the session thread is the whole story.
    }
  }
  function close(){
    if (!root.classList.contains('open')) return;
    closeProj();   // tear down any embedded project view so reopening is clean
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
    if (root.classList.contains('open') && !isSearchHash()){
      close();
    }
  });
  // Deep link: if the page loads with #search already in the URL (someone
  // shared a spotlight link), open the lightbox automatically once the
  // module is mounted. `#search=<encoded query>` (the newsletter's "people
  // asked Onyx" links) opens AND submits that question — a live demo that
  // flows straight into the normal quota/gate funnel.
  function hashQuery(){
    try {
      var h = location.hash || '';
      if (h.indexOf(TMW_HASH + '=') === 0) return decodeURIComponent(h.slice(TMW_HASH.length + 1).replace(/\+/g, '%20')).trim().slice(0, 200);
    } catch(_){}
    return '';
  }
  function isSearchHash(){ return location.hash === TMW_HASH || (location.hash || '').indexOf(TMW_HASH + '=') === 0; }
  if (isSearchHash()){
    setTimeout(function(){ open(hashQuery()); }, 0);
  }
  // Also open when the hash becomes #search at runtime (e.g. a dropdown link
  // sets it on the current page) — not just on initial load.
  window.addEventListener('hashchange', function(){
    if (isSearchHash() && !root.classList.contains('open')) open(hashQuery());
  });

  scrim.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  // "New chat": clear the conversation + return to the TMW Intelligence
  // homescreen (the teach/starter screen), keeping the overlay open.
  function newChat(){
    // File the current conversation into Past chats before wiping it.
    try {
      if (_thread.length) { _liveWrite(); var _lr = localStorage.getItem(_LIVE_KEY);
        if (_lr) { var _lo = JSON.parse(_lr); if (_lo && _lo.qs && _lo.qs.length) _histUpsert({ id: _lo.id, title: _lo.title, qs: _lo.qs, startedTs: _lo.updatedTs, updatedTs: _lo.updatedTs }); } }
    } catch(_){}
    _liveId = null;   // the next conversation is a fresh history record
    try { localStorage.removeItem(_LIVE_KEY); } catch(_){}
    closeProj();   // park the embed out of the thread before we wipe it
    _pendingCtx = null; _currentTurnCtx = null;   // drop any source-article context
    _thread = [];
    if (_threadEl) _threadEl.innerHTML = '';
    try { sessionStorage.removeItem(_THREAD_KEY); } catch (_) {}
    if (input) { input.value = ''; try { onInput(); } catch (_) {} }
    setState('starter');
    if (bodyEl) bodyEl.scrollTop = 0;
    if (input) { try { input.focus(); } catch (_) {} }
  }
  var newChatBtn = root.querySelector('.tmw-ov-newchat');
  if (newChatBtn) newChatBtn.addEventListener('click', newChat);

  // ── Past chats panel ─────────────────────────────────────────────────────
  var histBtn = root.querySelector('.tmw-ov-history');
  var histPanel = root.querySelector('.tmw-ov-histpanel');
  var histBody = root.querySelector('.tmw-ov-histpanel-body');
  var histX = root.querySelector('.tmw-ov-histpanel-x');
  var HIST_DEL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
  function _histEsc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function renderHistory(){
    if (!histBody) return;
    var list = _histRead();
    if (!list.length) { histBody.innerHTML = '<div class="tmw-ov-hist-empty">No past chats yet.<br>Conversations move here once you start a new chat or leave the site.</div>'; return; }
    histBody.innerHTML = list.map(function(e){
      var n = (e.qs ? e.qs.length : 0);
      // Gemini-style single line: title left, quiet meta right (message count
      // hides on phones), delete on hover. No icon chip, no monospace.
      return '<div class="tmw-ov-hist-row" data-id="' + _histEsc(e.id) + '">'
        + '<span class="tmw-ov-hist-main"><span class="tmw-ov-hist-ttl">' + _histEsc(e.title || 'Conversation') + '</span></span>'
        + '<span class="tmw-ov-hist-meta"><span class="tmw-ov-hist-n">' + n + ' message' + (n === 1 ? '' : 's') + ' &middot; </span>' + _histEsc(_relTime(e.updatedTs || e.startedTs)) + '</span>'
        + '<button class="tmw-ov-hist-del" type="button" aria-label="Delete conversation" title="Delete">' + HIST_DEL_ICON + '</button>'
        + '</div>';
    }).join('');
  }
  function openHistory(){ if (!histPanel) return; renderHistory(); histPanel.classList.add('open'); histPanel.setAttribute('aria-hidden', 'false'); }
  function closeHistory(){ if (!histPanel) return; histPanel.classList.remove('open'); histPanel.setAttribute('aria-hidden', 'true'); }
  if (histBtn) histBtn.addEventListener('click', openHistory);
  if (histX) histX.addEventListener('click', closeHistory);
  if (histBody) histBody.addEventListener('click', function(e){
    var del = e.target.closest && e.target.closest('.tmw-ov-hist-del');
    var row = e.target.closest && e.target.closest('.tmw-ov-hist-row');
    if (!row) return;
    var id = row.getAttribute('data-id');
    if (del) { e.stopPropagation(); _histWrite(_histRead().filter(function(x){ return x.id !== id; })); renderHistory(); return; }
    var entry = _histRead().filter(function(x){ return x.id === id; })[0];
    if (!entry || !entry.qs || !entry.qs.length) return;
    // Reopen and continue this conversation (later turns update the same record).
    closeHistory(); closeProj();
    _liveId = entry.id; _userInteracted = false;
    _resumeReplay(entry.qs);
  });
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
  // ── Native project / map card ───────────────────────────────────────
  // Clicking a project opens a native card (hero, status spine, stats, desc,
  // CTAs) inside a fixed-height frame in THIS answer bubble — no iframe, no
  // site chrome. "View on map" flips to a static map card with a full-map
  // breakout. Everything is built from the project object we already hold.
  var projview = root.querySelector('.tmw-ov-projview');
  var projbody = root.querySelector('.tmw-ov-projview-body');
  var projX = root.querySelector('.tmw-ov-projview-x');
  var projLbHome = root.querySelector('.tmw-ov-lb') || root;   // where it parks when closed
  var _projHost = null;                                        // the answer bubble currently hosting it
  var _projP = null;                                           // the project currently shown
  function _projBySlug(slug){
    for (var i = 0; i < PROJECTS.length; i++){ if ((PROJECTS[i].Slug || PROJECTS[i].slug) === slug) return PROJECTS[i]; }
    return null;
  }
  // Project watchlist (Memberstack favorites) — for the card's Watch button.
  var _favSet = null;
  function loadFavs(){
    if (_favSet) return Promise.resolve(_favSet);
    var m = window.$memberstackDom;
    if (!m || !m.getMemberJSON) return Promise.resolve(new Set());
    return m.getMemberJSON().then(function(r){ var j=(r&&r.data)||{}; _favSet = new Set((j.favorites||[]).map(function(s){ return String(s).toLowerCase(); })); return _favSet; }).catch(function(){ return new Set(); });
  }
  function beaconEventOv(name, projectSlug){
    try {
      var m = window.$memberstackDom; if (!m || !m.getCurrentMember) return;
      m.getCurrentMember().then(function(r){ var mem=r&&r.data; if(!mem)return; var cf=mem.customFields||{}; var nm=((cf['first-name']||'')+' '+(cf['last-name']||'')).trim()||null;
        var payload = JSON.stringify({ member_id:mem.id, member_name:nm, event_name:name, props:{ project_slug:projectSlug } });
        if (navigator.sendBeacon) navigator.sendBeacon('https://tmw.jake-ab7.workers.dev/event', new Blob([payload],{type:'text/plain'}));
        else fetch('https://tmw.jake-ab7.workers.dev/event', { method:'POST', body:payload, headers:{'Content-Type':'text/plain'}, keepalive:true }).catch(function(){});
      });
    } catch(e){}
  }
  function handlePvWatch(wbtn){
    var pro = window.tmwIntel && window.tmwIntel.isPro && window.tmwIntel.isPro();
    if (!pro){ try { if (typeof window.tmwShowPaywall === 'function') window.tmwShowPaywall({ source:'onyx_watch' }); } catch(e){} return; }
    var slug = wbtn.getAttribute('data-slug'); if (!slug) return;
    var key = slug.toLowerCase(), txt = wbtn.querySelector('.tmw-pv-watch-txt'), on = wbtn.classList.contains('on');
    var m = window.$memberstackDom; if (!m || !m.getMemberJSON || !m.updateMemberJSON) return;
    if (txt) txt.textContent = on ? 'Removing…' : 'Watching…';
    m.getMemberJSON().then(function(r){
      var j = (r && r.data) || {};
      var fv = Array.isArray(j.favorites) ? j.favorites.slice() : [];
      var i = fv.indexOf(slug);
      if (on){ if (i>=0) fv.splice(i,1); } else { if (i<0) fv.push(slug); }
      j.favorites = fv;
      m.updateMemberJSON({ json:j }).then(function(){
        if (on){ wbtn.classList.remove('on'); if(txt) txt.textContent='Watch'; if(_favSet) _favSet.delete(key); beaconEventOv('favorite_removed', slug); }
        else   {
          wbtn.classList.add('on');    if(txt) txt.textContent='Watching'; if(_favSet) _favSet.add(key); beaconEventOv('favorite_added', slug);
          // Celebration toast — shared across every watch surface.
          var wname = (_projP && _projP.Title) ? String(_projP.Title) : slug.replace(/-/g,' ').replace(/\b[a-z]/g, function(c){ return c.toUpperCase(); });
          if (window.tmwWatchToast) window.tmwWatchToast(wname);
          else { var cs=document.createElement('script'); cs.src='https://www.oftmw.com/_shared/tmw-celebrate.js'; cs.defer=true; cs.onload=function(){ window.tmwWatchToast && window.tmwWatchToast(wname); }; document.head.appendChild(cs); }
        }
      }).catch(function(){ if (txt) txt.textContent = on ? 'Watching' : 'Watch'; });
    });
  }
  function _paintProjCard(){
    projbody.scrollTop = 0;
    projbody.innerHTML = renderProjView(_projP);
    var tk = projbody.querySelector('.tmw-pv-track'), idxEl = projbody.querySelector('[data-pvidx]');
    if (tk && idxEl) tk.addEventListener('scroll', function(){ idxEl.textContent = String(Math.round(tk.scrollLeft / Math.max(1, tk.clientWidth)) + 1); }, { passive: true });
    var wb = projbody.querySelector('[data-pvwatch]');
    if (wb) loadFavs().then(function(set){ var s = wb.getAttribute('data-slug'); if (s && set.has(s.toLowerCase())){ wb.classList.add('on'); var t = wb.querySelector('.tmw-pv-watch-txt'); if (t) t.textContent = 'Watching'; } });
  }
  function openProjCard(p, bubble){
    if (!projview || !projbody || !p) return;
    var host = bubble || _projHost;
    if (!host) return;
    _projP = p;
    host.appendChild(projview);                 // mount INSIDE the answer bubble
    host.classList.add('tmw-ov-proj-open');     // bubble → fixed height
    _projHost = host;
    _paintProjCard();
    projview.classList.add('open');
    projview.setAttribute('aria-hidden', 'false');
    // Scroll the turn (query bubble + card) to the top so the fixed-height
    // card sits fully in view above the search dock, not half-behind it.
    try {
      var turnEl = host.closest('.tmw-ov-turn') || host;
      requestAnimationFrame(function(){ turnEl.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
    } catch (_) {}
  }
  function closeProj(){
    if (!projview || !projview.classList.contains('open')) return false;
    projview.classList.remove('open');
    projview.setAttribute('aria-hidden', 'true');
    if (_projHost) { _projHost.classList.remove('tmw-ov-proj-open'); _projHost = null; }
    if (projLbHome) projLbHome.appendChild(projview);   // park back out of the turn so it survives thread clears
    if (projbody) projbody.innerHTML = '';
    _projP = null;
    return true;
  }
  if (projX) projX.addEventListener('click', closeProj);

  root.addEventListener('click', function(e){
    // Never treat a feedback-row click as a query submission (the thumbs live
    // inside the answer; a stray data-* there must not re-run the query).
    if (e.target.closest && e.target.closest('.tmw-ov-feedback')) return;
    // Watch button + carousel arrows. The pv card renders both in the
    // fullscreen project panel AND inline as the answer hero, so resolve
    // the track against the nearest .tmw-pv instead of assuming the panel
    // is open (the inline card's arrows were dead under that guard).
    var pvw = e.target.closest('[data-pvwatch]');
    if (pvw) { e.preventDefault(); e.stopPropagation(); handlePvWatch(pvw); return; }
    var arrow = e.target.closest('[data-pvprev],[data-pvnext]');
    if (arrow) {
      e.preventDefault();
      var pvCard = arrow.closest('.tmw-pv');
      var track = pvCard && pvCard.querySelector('.tmw-pv-track');
      if (track) track.scrollBy({ left: (arrow.hasAttribute('data-pvnext') ? 1 : -1) * track.clientWidth, behavior: 'smooth' });
      return;
    }
    // Project card/row → open the native project card in THIS answer bubble.
    var projLink = e.target.closest && e.target.closest('[data-projslug]');
    if (projLink) {
      e.preventDefault();
      var p = _projBySlug(projLink.getAttribute('data-projslug'));
      if (p) openProjCard(p, projLink.closest('[data-state="results"]'));
      return;
    }
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
    // Load-more for project TILES (the grid mirror of more-rows above).
    var moreCards = e.target.closest && e.target.closest('[data-action="more-cards"]');
    if (moreCards) {
      e.preventDefault();
      var csec = moreCards.closest('.tmw-ov-sec');
      if (csec) {
        var chidden = csec.querySelectorAll('.tmw-ov-pcard.tmw-ov-card-hidden');
        var CARD_PAGE = 12;
        for (var ci = 0; ci < Math.min(CARD_PAGE, chidden.length); ci++) chidden[ci].classList.remove('tmw-ov-card-hidden');
        var cleft = csec.querySelectorAll('.tmw-ov-pcard.tmw-ov-card-hidden').length;
        if (cleft > 0) moreCards.textContent = 'Load ' + Math.min(CARD_PAGE, cleft) + ' more';
        else moreCards.remove();
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
    if (e.key === 'Escape' && root.classList.contains('open')) { if (closeProj()) return; close(); return; }
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
    if (window.tmwIntel && window.tmwIntel.sync) window.tmwIntel.sync(); else refreshProPill();
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
