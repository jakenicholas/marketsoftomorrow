/* ------------------------------------------------------------------
   Markets of Tomorrow — shared search & Intelligence core
   --------------------------------------------------------------------
   Pure functions + data only. NO DOM rendering. Each search surface
   (/search/ page, dock overlay, future map sidebar, future API
   consumers) owns its own rendering and just calls into this module
   for the brains: question detection, fact-building for the LLM, the
   /smart-answer worker call, the Partner-of-Tomorrow spotlight table,
   and small project-shape helpers.

   Currently consumed by:
     - /_shared/journal-search-overlay.js  (lightbox; Phase 2)
     - /search/index.html                  (TODO: migrate to use this;
                                            still duplicates these defs)

   When extending, keep this module FRAMEWORK-FREE and DOM-FREE so a
   future server-side renderer or non-browser caller can reuse it.
-------------------------------------------------------------------*/
(function () {
  'use strict';
  if (window.TmwSearchCore) return;

  var WORKER_URL = 'https://tmw.jake-ab7.workers.dev';

  // ── pure string helpers ───────────────────────────────────────────
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function hasWord(haystack, word) {
    // Word-boundary match on the already-normalized haystack. Multi-word
    // "words" (e.g. "this year") are treated as a phrase substring.
    var w = norm(word);
    if (!w) return false;
    if (w.indexOf(' ') >= 0) return haystack.indexOf(w) >= 0;
    var re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])');
    return re.test(haystack);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  // ── project-shape helpers (match /search/index.html exactly) ──────
  function firstField(o, keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (o[k] != null && String(o[k]).trim() !== '') return o[k];
    }
    return '';
  }
  function floorsOf(p) {
    var raw = firstField(p, ['Floors', 'Stories', 'Storeys']);
    var n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function unitsOf(p) {
    var raw = firstField(p, ['Units', 'Keys', 'Rooms']);
    var n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function yearOf(p) {
    var m = String(p.DeliveryDate || '').match(/(20\d{2})/);
    return m ? +m[1] : null;
  }
  function fmtDelivery(p) {
    var m = String(p.DeliveryDate || '').match(/(20\d{2})-(\d{2})/);
    if (m) {
      var M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1];
      return (M ? M + ' ' : '') + m[1];
    }
    var y = yearOf(p);
    return y ? ('' + y) : '';
  }

  // ── question detection (mirror /search/index.html) ────────────────
  // Anything ending with a "?", or starting with what/why/how/etc.,
  // counts as a question and should be routed to the LLM rather than
  // pure text-match search.
  function isQuestion(q) {
    var t = String(q || '').trim();
    if (!t) return false;
    if (t.indexOf('?') !== -1) return true;
    return /^(what|why|how|when|where|who|which|whose|is|are|does|do|did|can|could|will|would|should|has|have|had)\s/i.test(t);
  }

  // ── Partner-of-Tomorrow spotlights ────────────────────────────────
  // Curated answers for experiential partner queries — bypasses the LLM
  // entirely (always free, always available). Copied verbatim from
  // /search/index.html; when edited there, copy here too (until /search/
  // is migrated to consume this module).
  var PARTNER_SPOTLIGHTS = [
    { name:'TREMBLE', triggers:['tremble','pilates'], region:'Miami & The Palm Beaches', catShort:'Pilates · Reformer',
      ctaUrl:'https://2ly.link/24Be5', ctaLabel:'Join TREMBLE',
      prose:'<b>TREMBLE</b> is one of South Florida’s most talked-about fitness concepts — a high-intensity, low-impact studio blending strength, cardio, and <b>Pilates-inspired</b> movement on precision-engineered reformers. It’s scaling fast across <span class="hl">Miami</span> and <span class="hl">The Palm Beaches</span>, most recently opening its <b>fourth Palm Beach County studio</b> in <span class="hl">Wellington</span> — a single-row reformer layout that gives every client an unobstructed view — joining Boca Raton, West Palm Beach, and Jupiter.',
      items:[
        { name:'TREMBLE Wellington',       city:'Wellington, FL' },
        { name:'TREMBLE Boca Raton',       city:'Boca Raton, FL' },
        { name:'TREMBLE West Palm Beach',  city:'West Palm Beach, FL' },
        { name:'TREMBLE Jupiter',          city:'Jupiter, FL' }
      ]
    },
    { name:'MedHouse',       triggers:['medhouse'],                       catShort:'Biohack of Tomorrow',  tagline:'Longevity, by membership.',           ctaUrl:'https://linkly.link/2GbpS', ctaLabel:'Become a member' },
    { name:'Higher Order',   triggers:['higher order'],                   catShort:'Club of Tomorrow',     tagline:'Membership for the few.',             ctaUrl:'https://linkly.link/2HfAG', ctaLabel:'Request Invitation' },
    { name:'TRAPHOUSE',      triggers:['traphouse'],                      catShort:'Sweat of Tomorrow',    tagline:'Grit, made glamorous.',               ctaUrl:'https://linkly.link/2WiJd', ctaLabel:'Learn More' },
    { name:'Humanaut Health',triggers:['humanaut'],                       catShort:'Medicine of Tomorrow', tagline:'Concierge medicine, reimagined.',     ctaUrl:'https://linkly.link/2FdrC', ctaLabel:'Schedule a consult' },
    { name:'PUR-FORM',       triggers:['pur-form','pur form','purform'],  catShort:'Biohack of Tomorrow',  tagline:'Recovery for the relentless.',        ctaUrl:'https://linkly.link/2FdrO', ctaLabel:'Become a member' }
  ];
  function matchSpotlight(q) {
    var full = norm(q);
    for (var i = 0; i < PARTNER_SPOTLIGHTS.length; i++) {
      var sp = PARTNER_SPOTLIGHTS[i];
      for (var j = 0; j < sp.triggers.length; j++) {
        if (hasWord(full, sp.triggers[j])) return sp;
      }
    }
    return null;
  }

  // ── fact-building for /smart-answer (project shape only) ──────────
  // Mixes top projects + top articles into a single .top array. Articles
  // are tagged status='Article' so the LLM at least SEES the journal
  // coverage that may be the real answer to the question.
  function buildIntelFacts(topProjects, topArticles) {
    var top = [];
    (topProjects || []).slice(0, 5).forEach(function (p) {
      top.push({
        name: p.Title || '',
        city: p.City || '',
        status: p.Delivery || '',
        floors: floorsOf(p) || null,
        units: unitsOf(p) || null,
        delivery: fmtDelivery(p) || ''
      });
    });
    (topArticles || []).slice(0, 3).forEach(function (a) {
      top.push({
        name: a.title || '',
        city: '',
        status: 'Article',
        floors: null,
        units: null,
        delivery: a.published_iso ? new Date(a.published_iso).toISOString().slice(0, 10) : ''
      });
    });
    return {
      count: top.length || 1,
      criteria: {},
      sort: null,
      place: null,
      tallest: null,
      largest: null,
      residencesTotal: null,
      firstDelivery: null,
      top: top.slice(0, 8)
    };
  }

  // ── the /smart-answer LLM call ────────────────────────────────────
  // Returns a Promise that resolves to { ok, answer, error }. Caller is
  // responsible for debouncing keystrokes and discarding stale responses
  // via its own token check.
  function askIntelligence(q, facts) {
    return fetch(WORKER_URL + '/smart-answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q, facts: facts })
    })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (data && data.answer) return { ok: true, answer: data.answer };
      return { ok: false, answer: null };
    })
    .catch(function (e) { return { ok: false, answer: null, error: e }; });
  }

  // ── hexagon spinner SVG (matches /search/'s HEX_SVG) ──────────────
  // Caller scopes the .hxs* class names to its own surface so animations
  // don't interfere with the host page (e.g. the overlay uses .tmw-ov-hxs*).
  // This raw markup uses the canonical .hxs* names from /search/.
  var HEX_SVG = ''
    + '<svg class="hxs" viewBox="0 0 100 100">'
    +   '<polygon class="hxs-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/>'
    +   '<g class="hxs-spin">'
    +     '<polygon class="hxs-core" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/>'
    +   '</g>'
    + '</svg>';

  // ── exports ───────────────────────────────────────────────────────
  window.TmwSearchCore = {
    WORKER_URL: WORKER_URL,
    // string helpers
    norm: norm,
    hasWord: hasWord,
    esc: esc,
    // project helpers
    firstField: firstField,
    floorsOf: floorsOf,
    unitsOf: unitsOf,
    yearOf: yearOf,
    fmtDelivery: fmtDelivery,
    // Intelligence pipeline
    isQuestion: isQuestion,
    buildIntelFacts: buildIntelFacts,
    askIntelligence: askIntelligence,
    // partner spotlights
    PARTNER_SPOTLIGHTS: PARTNER_SPOTLIGHTS,
    matchSpotlight: matchSpotlight,
    // assets
    HEX_SVG: HEX_SVG
  };
})();
