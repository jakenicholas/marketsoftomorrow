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
  // Normalize for matching: lowercase, strip accents, and collapse apostrophes
  // so possessives/special punctuation don't block matches —
  //   "Miami's Design District" -> "miami design district"
  //   "Spina O'Rourke"          -> "spina orourke"
  // Applied to BOTH query and data, so matching stays symmetric.
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/'s\b/g, '')
      .replace(/'/g, '');
  }
  function hasWord(haystack, word) {
    // Word-boundary match with an OPTIONAL trailing 's' for plurals
    // ("tower" matches "towers", "office" matches "offices"). Multi-word
    // phrases ("this year", "broke ground") are treated as substring so
    // we don't need to escape inner spaces or compose a multi-word regex.
    // Mirrors /search/'s hasWord so structured-query parsing produces
    // identical criteria on both surfaces.
    var w = norm(word);
    if (!w) return false;
    if (w.indexOf(' ') >= 0) return haystack.indexOf(w) >= 0;
    var escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('(^|[^a-z0-9])' + escaped + 's?($|[^a-z0-9])');
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
  // Rough SIZE of a project on a common square-foot scale, so "biggest projects"
  // can rank across types when there's no place. We don't store acreage/sq-ft as
  // fields, but most descriptions state them — so parse the biggest figure out of
  // the prose (acres → sq-ft), then fall back to units/floors as proxies. Returns
  // a comparable number; 0 when nothing is parseable.
  function sizeScoreOf(p) {
    var txt = String(firstField(p, ['DescriptionLong', 'Description']) || '');
    var best = 0, m;
    var reAcre = /([\d][\d,]*(?:\.\d+)?)\s*-?\s*acre/gi;
    while ((m = reAcre.exec(txt))) { var a = parseFloat(m[1].replace(/,/g, '')); if (a > 0) best = Math.max(best, a * 43560); }
    var reSqft = /([\d][\d,]*)\s*(?:square[ -]?feet|square[ -]?foot|sq\.?\s*ft|sf\b)/gi;
    while ((m = reSqft.exec(txt))) { var sf = parseFloat(m[1].replace(/,/g, '')); if (sf > 1000) best = Math.max(best, sf); }
    if (best) return best;
    var u = unitsOf(p), f = floorsOf(p);
    if (u) return u * 1200;          // ~1,200 sf/unit proxy
    if (f) return f * 12000;         // ~12,000 sf/floor proxy
    return 0;
  }
  function yearOf(p) {
    var m = String(p.DeliveryDate || '').match(/(20\d{2})/);
    return m ? +m[1] : null;
  }
  // The soonest delivery year that is still UPCOMING (this year or later). The
  // "First delivery" stat should look FORWARD — surfacing an already-completed
  // project's old date (e.g. 2022) just reads as a shallow database, not a
  // pipeline fact. Returns null when nothing is upcoming.
  function soonestFutureYear(rows) {
    var nowYr = new Date().getFullYear();
    var ys = (rows || []).map(yearOf).filter(function (y) { return y && y >= nowYr; });
    return ys.length ? Math.min.apply(null, ys) : null;
  }
  function startYearOf(p) {
    var m = String(p.StartDate || '').match(/(20\d{2})/);
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
    // Interrogative / auxiliary-led questions ("what is…", "does…").
    if (/^(what|why|how|when|where|who|which|whose|is|are|does|do|did|can|could|will|would|should|has|have|had)\s/i.test(t)) return true;
    // Imperative information-requests — complete asks that aren't phrased as a
    // grammatical question but clearly want a synthesized answer:
    //   "tell me about The Berkeley", "describe Olara",
    //   "give me the rundown on Currie Park", "explain Currie Park".
    if (/^(tell|describe|explain|summar(?:ize|ise|y)|walk|brief|overview|compare)\b/i.test(t)) return true;
    if (/\b(tell me|more about|everything about|info(?:rmation)?\s+(?:on|about)|details?\s+(?:on|about)|rundown on|overview of|story\s+(?:of|behind|on)|the deal with|the scoop on)\b/i.test(t)) return true;
    return false;
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
  function buildIntelFacts(topProjects, topArticles, place) {
    var projects = (topProjects || []).filter(function (p) { return p && p.Title; });
    var sig = computeSignals(projects);
    var top = projects.slice(0, 10).map(factRow);
    (topArticles || []).slice(0, 3).forEach(function (a) {
      top.push({
        id: a.slug || a.link || '', name: a.title || '', city: '', status: 'Article', type: '',
        floors: null, units: null,
        delivery: a.published_iso ? new Date(a.published_iso).toISOString().slice(0, 10) : '',
        district: false, blurb: String(a.excerpt || '').slice(0, 140)
      });
    });
    return {
      count: projects.length || top.length || 1,
      criteria: {},
      sort: null,
      place: place || null,
      tallest: null,
      largest: null,
      residencesTotal: null,
      firstDelivery: null,
      dominantType: sig.dominantType,
      soonest: sig.soonest,
      flagships: sig.flagships,
      top: top.slice(0, 12)
    };
  }

  // Facts for a JOURNAL-led answer (e.g. food & drink) — the topic isn't tracked
  // in the project DB, so the answer is synthesized from our ARTICLES instead of
  // projects. `topic` flips the worker prompt into journal-editor voice.
  function buildJournalFacts(articles, place, topic, placeTerms) {
    var rows = (articles || []).filter(function (a) { return a && a.title; }).slice(0, 12).map(function (a) {
      return {
        id: a.slug || a.link || '', name: a.title || '', city: '', status: 'Article', type: topic || 'Journal',
        floors: null, units: null,
        delivery: a.published_iso ? new Date(a.published_iso).toISOString().slice(0, 10) : '',
        district: false, blurb: String(a.excerpt || '').slice(0, 180)
      };
    });
    return {
      count: rows.length, criteria: {}, sort: null,
      place: place || null, topic: topic || 'journal',
      placeTerms: Array.isArray(placeTerms) ? placeTerms.slice(0, 10) : null,
      tallest: null, largest: null, residencesTotal: null, firstDelivery: null,
      dominantType: null, soonest: null, flagships: null,
      top: rows
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
      if (data && data.answer) return { ok: true, answer: data.answer, hero: data.hero || null };
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

  // ════════════════════════════════════════════════════════════════════
  // PHASE 2B — structured smart-query pipeline
  // ════════════════════════════════════════════════════════════════════
  // Deterministic (no LLM): parse a natural-language query into structured
  // criteria, then filter + rank the projects array and synthesize an
  // answer. Mirrors /search/index.html's pipeline; both surfaces should
  // produce identical structured results.

  // Default "this year" anchor for relative-year phrases ("next year",
  // "this year"). Callers can override via parseSmartQuery(q, opts).
  // Hardcoded annual; bump in lockstep with the /search/ copy until that
  // file is migrated to consume this core.
  var THIS_YEAR = 2026;

  var STATUS_GROUPS = [
    { value:'Under Construction', label:'Under construction', syn:['under construction','construction','being built','underway','rising'] },
    { value:'Breaking Ground',    label:'Breaking ground',    syn:['breaking ground','broke ground','groundbreaking','breaks ground'] },
    { value:'Opening Soon',       label:'Opening soon',       syn:['opening soon','coming soon','opening','opens','set to open'] },
    { value:'Now Open',           label:'Open',               syn:['now open','open','opened','completed','complete','delivered','finished'] },
    { value:'Announced',          label:'Announced',          syn:['announced','planned','proposed','pre-construction','preconstruction','unveiled'] }
  ];
  // Fine construction milestones (filter STRICTLY against logged StatusHistory).
  var PHASE_GROUPS = [
    { phase:'topping-out',    label:'Topped out',       verb:'topped out',               syn:['topped out','topping out','top off','topped'] },
    { phase:'financing',      label:'Financing closed', verb:'secured financing',        syn:['secured financing','closed financing','construction loan','got financing'] },
    { phase:'going-vertical', label:'Going vertical',   verb:'gone vertical',            syn:['going vertical','gone vertical','vertical construction'] },
    { phase:'halfway',        label:'Halfway',          verb:'reached the halfway mark', syn:['halfway','half complete','50% complete','fifty percent'] },
    { phase:'tco',            label:'TCO issued',       verb:'received a TCO',           syn:['tco','certificate of occupancy'] },
    { phase:'move-in',        label:'Move-ins started', verb:'started move-ins',         syn:['move-in','move in','moving in','residents moving'] },
    { phase:'tenant',         label:'Tenant signed',    verb:'signed a tenant',          syn:['anchor tenant','tenant signed','signed a lease'] },
    { phase:'bookings',       label:'Bookings open',    verb:'opened bookings',          syn:['bookings open','taking reservations','reservations open'] }
  ];
  // Query vocabulary → project-type token. `syn` entries are matched with
  // hasWord (auto-handles regular plurals + multi-word phrases), so only
  // irregular plurals (universities, galleries, eateries) need spelling out.
  // Keep every syn an UNAMBIGUOUS pointer to one type — a word that could mean
  // two categories (bare "club", "center", "theater") is left out so a type
  // query never narrows to the wrong bucket.
  var TYPE_GROUPS = [
    { token:'Residences', label:'Condo / Residences', noun:'condo',     syn:['condo','condominium','flat','penthouse','co-op','coop'] },
    { token:'Residences', label:'Tower / High-rise',  noun:'tower',     syn:['tower','high-rise','highrise','skyscraper','mid-rise','midrise'] },
    { token:'Residences', label:'Residences',         noun:'residence', syn:['residence','residential','apartment','home','multifamily','multi-family','rental','build-to-rent','senior living','active adult','assisted living'] },
    { token:'Estates',    label:'Estates / Homes',    noun:'home',      syn:['estate','estates','single-family','single family','single-family home','house','houses','townhouse','townhouses','townhome','townhomes','villa','villas'] },
    { token:'Hotel',      label:'Hotel',              noun:'hotel',     syn:['hotel','boutique hotel','aparthotel','lodging','inn'] },
    { token:'Resort',     label:'Resort',             noun:'resort',    syn:['resort','beach resort','ski resort','spa resort','wellness retreat'] },
    { token:'Office',     label:'Office',             noun:'office',    syn:['office','workplace','corporate campus','headquarters','class a office'] },
    { token:'Retail',     label:'Retail',             noun:'retail project', syn:['retail','shopping','mall','shops','shopping center','shopping centre','outlet','plaza','lifestyle center','shoppes'] },
    // NOTE: dining is NOT a tracked project type — restaurants/food & drink live
    // in the JOURNAL (articles categorized "<region> Food & Drink"), not the
    // project DB. So there is deliberately no Eateries/Dining type group: a food
    // query must NOT filter projects to a dead bucket. Food vocabulary is routed
    // to articles via the search overlay's synonym groups instead.
    { token:'Park',       label:'Park',               noun:'park',      syn:['park','green space','greenspace','promenade','linear park','public park'] },
    { token:'Marina',     label:'Marina',             noun:'marina',    syn:['marina','yacht','yacht club','harbor','harbour','boat slip'] },
    { token:'Museum',     label:'Museum',             noun:'museum',    syn:['museum','gallery','galleries','art museum'] },
    { token:'Entertainment', label:'Entertainment',   noun:'venue',     syn:['entertainment','venue','amphitheater','amphitheatre','concert hall','nightlife','casino','theme park','water park'] },
    { token:'Golf',       label:'Golf',               noun:'golf course', syn:['golf','golf course','country club','links','golf community','golf resort'] },
    { token:'Stadium',    label:'Stadium',            noun:'stadium',   syn:['stadium','arena','ballpark','soccer stadium','sports complex'] },
    { token:'Education',  label:'Education',          noun:'school',    syn:['school','university','universities','college','campus','academy','student housing','dormitory','dorm'] },
    { token:'Cultural',   label:'Cultural',           noun:'cultural project', syn:['cultural','arts center','performing arts','cultural center','arts district'] },
    { token:'Mixed-Use',  label:'Mixed-use',          noun:'mixed-use project', syn:['mixed-use','mixed use','live-work','town center','town centre','master-planned','master planned'] },
    { token:'Hospital',   label:'Hospital',           noun:'hospital',  syn:['hospital','medical center','medical','healthcare','health system','clinic','medical campus'] },
    { token:'Airport',    label:'Airport',            noun:'airport',   syn:['airport','terminal','aviation'] },
    { token:'Travel',     label:'Travel',             noun:'transit hub', syn:['transit','train station','rail','transportation','transit hub','high-speed rail','metro station'] }
  ];
  var SORT_GROUPS = [
    { key:'floors', dir:'desc', label:'Tallest first',   unit:'Stories', stat:'Tallest',     syn:['tallest','highest','tall'] },
    { key:'floors', dir:'asc',  label:'Shortest first',  unit:'Stories', stat:'Shortest',    syn:['shortest','lowest'] },
    { key:'units',  dir:'desc', label:'Most units',      unit:'Units',   stat:'Most units',  syn:['biggest','largest','most units','most residences','most homes'] },
    { key:'date',   dir:'asc',  label:'Opening soonest', unit:'Delivers',stat:'Opens first', syn:['soonest','earliest','opening first','next to open','delivering first'] },
    { key:'date',   dir:'desc', label:'Furthest out',    unit:'Delivers',stat:'Latest',      syn:['furthest out','latest delivery','last to open'] },
    { key:'updated',dir:'desc', label:'Newest',          unit:'Updated', stat:'Newest',      syn:['newest','newly','new','latest','most recent','recent','recently','just announced'] }
  ];

  var STATUS_BADGE = {
    'Under Construction': { cls:'sb-construction', label:'Under construction' },
    'Breaking Ground':    { cls:'sb-breaking',     label:'Breaking ground' },
    'Opening Soon':       { cls:'sb-soon',         label:'Opening soon' },
    'Now Open':           { cls:'sb-open',         label:'Now open' },
    'Announced':          { cls:'sb-announced',    label:'Announced' }
  };

  // Generic / structural words that shouldn't count toward a firm-name token
  // match. "Related Group" is just "Related"; "Foster + Partners" is "Foster".
  var FIRM_STOP = new Set(['the','of','and','group','partners','studio','architects','architecture','development','developments','developers','design','company','co','llc','inc','associates','international','global','real','estate','properties','holdings','capital','ventures','collective','residential','residences','tower','towers','project','projects','building','buildings','condo','condos','hotel','hotels','tallest','newest']);

  // Words that should NOT count as "meaningful tokens" in the multi-token
  // strict-filter that excludes weak matches from the grid. These are
  // generic intent/question words that almost never appear in a project,
  // firm, or city name. Without this list, "projects coming to nashville"
  // requires every project title to contain "projects" AND "coming" AND
  // "nashville" -- so the grid collapses to ~4 marginal matches instead
  // of all Nashville projects. Place-y nouns (park, city, lake, river,
  // beach, springs, north, south, etc.) are deliberately NOT here -- they
  // can be part of legitimate project / city names.
  var QUERY_STOPWORDS = new Set([
    // intent nouns
    'projects','project','things','stuff','one','ones',
    // intent verbs
    'show','find','give','tell','list','see','look','check','search','want','need',
    'describe','explain','summarize','summarise','share','walk','compare','learn','know',
    // info-request nouns + pure function words ("tell me about THE berkeley")
    'the','and','for','with','from','its','you','your','our','please',
    'overview','rundown','info','information','details','detail','everything','anything','story','scoop','deal',
    // intent adjectives + status-y generics
    'new','newest','latest','recent','upcoming','next','previous','past','old','coming','going','happening','planned','expected','set','about',
    // question + connector words
    'what','why','how','when','where','which','who','whom','whose',
    'around','near','into','throughout','some','any','all','every','each','more','less','most',
    'this','that','these','those','here','there',
    'can','will','would','could','should','may','might','must',
    'just','really','very','maybe','perhaps','still','also',
    // common auxiliary verbs + temporal qualifiers — without these "what
    // projects ARE opening SOON" leaks "are" into the residual narrowing
    // and surfaces as an Area chip.
    'are','was','were','been','being','have','has','had','does','did',
    'soon','already','yet'
  ]);
  // Build the meaningful-tokens list a surface uses for its strict relevance
  // filter -- length >= 3 AND not a generic stopword. Exposed so the overlay
  // (and any future search surface) applies the SAME filter logic. The
  // function takes the already-tokenized array so callers don't re-split.
  function filterMeaningfulTokens(toks) {
    return (toks || []).filter(function(t){ return t.length >= 3 && !QUERY_STOPWORDS.has(t); });
  }

  function inFlorida(p) {
    var la = parseFloat(p.Latitude), ln = parseFloat(p.Longitude);
    return la >= 24.3 && la <= 31.1 && ln >= -87.8 && ln <= -79.8;
  }

  // Multi-city AREAS (county / metro / region). Each project is stamped with a
  // `County` field (reverse-geocoded from lat/lng at build — see
  // geocode_counties.py), so SINGLE counties resolve data-driven: any "<X>
  // County" we actually have projects in is matched automatically, nationwide,
  // with no table to maintain. Multi-county REGIONS (and a couple of high-traffic
  // counties with a bbox fallback, so they still resolve before a project is
  // geocoded) stay curated. An area resolves to a LIST of county names; its
  // member cities are the cities of every project in those counties. This lets
  // "palm beach county" fan out to West Palm Beach + Boca + Delray + Jupiter + …
  // instead of collapsing to the town of Palm Beach.
  // Curated regions / metros / nicknames → the (state-scoped) counties they
  // cover. County names repeat across states (Orange County is in FL, CA AND NY),
  // so every match is keyed on County + state code. Counties listed that we don't
  // cover are harmless. Bare single-city names are intentionally NOT here.
  var REGIONS = [
    // — Florida —
    { name:'South Florida',     state:'FL', triggers:['south florida','sofla','so fla','tri-county','tricounty'], counties:['Miami-Dade County','Broward County','Palm Beach County'] },
    { name:'The Palm Beaches',  state:'FL', triggers:['the palm beaches','palm beaches'],            counties:['Palm Beach County'] },
    { name:'Treasure Coast',    state:'FL', triggers:['treasure coast'],                             counties:['Martin County','St. Lucie County','Indian River County'] },
    { name:'Space Coast',       state:'FL', triggers:['space coast'],                                counties:['Brevard County'] },
    { name:'Tampa Bay',         state:'FL', triggers:['tampa bay','tampa metro','greater tampa'],    counties:['Hillsborough County','Pinellas County','Pasco County','Manatee County'] },
    { name:'Southwest Florida', state:'FL', triggers:['southwest florida','swfl'],                   counties:['Lee County','Collier County'] },
    { name:'Greater Orlando',   state:'FL', triggers:['greater orlando','orlando metro','central florida'], counties:['Orange County','Seminole County','Osceola County','Lake County'] },
    { name:'Greater Jacksonville', state:'FL', triggers:['first coast','jacksonville metro','greater jacksonville'], counties:['Duval County','St. Johns County','Clay County','Nassau County'] },
    { name:'The Florida Keys',  state:'FL', triggers:['florida keys','the keys'],                    counties:['Monroe County'] },
    // — New York —
    { name:'New York City',     state:'NY', triggers:['nyc','new york city','the five boroughs','five boroughs'], counties:['New York County','Kings County','Queens County','Bronx County','Richmond County'] },
    { name:'Manhattan',         state:'NY', triggers:['manhattan'],                                  counties:['New York County'] },
    { name:'Brooklyn',          state:'NY', triggers:['brooklyn'],                                   counties:['Kings County'] },
    { name:'Queens (NYC)',      state:'NY', triggers:['queens nyc','queens new york'],               counties:['Queens County'] },
    { name:'Long Island',       state:'NY', triggers:['long island'],                                counties:['Suffolk County','Nassau County'] },
    { name:'Hudson Valley',     state:'NY', triggers:['hudson valley'],                              counties:['Dutchess County','Westchester County','Ulster County'] },
    { name:'Buffalo / WNY',     state:'NY', triggers:['buffalo','western new york'],                 counties:['Erie County'] },
    // — Tennessee —
    { name:'Nashville Area',    state:'TN', triggers:['music city','middle tennessee','nashville metro','greater nashville'], counties:['Davidson County','Williamson County','Rutherford County','Wilson County','Maury County'] },
    // — Texas —
    { name:'Dallas–Fort Worth', state:'TX', triggers:['dallas-fort worth','dallas fort worth','dfw','the metroplex','metroplex','north texas'], counties:['Dallas County','Tarrant County','Collin County','Denton County'] },
    { name:'Greater Austin',    state:'TX', triggers:['austin metro','greater austin','central texas'], counties:['Travis County','Williamson County','Hays County'] },
    { name:'Greater Houston',   state:'TX', triggers:['houston metro','greater houston'],            counties:['Harris County','Fort Bend County','Montgomery County'] },
    { name:'Texas Hill Country',state:'TX', triggers:['hill country','texas hill country'],          counties:['Gillespie County','Llano County','Kerr County','Blanco County','Kendall County'] },
    // — California —
    { name:'Southern California',state:'CA', triggers:['southern california','socal','so cal'],       counties:['Los Angeles County','Orange County','San Diego County','Riverside County','San Bernardino County','Ventura County'] },
    { name:'Greater Los Angeles',state:'CA', triggers:['greater los angeles','la metro','los angeles metro'], counties:['Los Angeles County','Orange County'] },
    { name:'SF Bay Area',       state:'CA', triggers:['bay area','sf bay area','san francisco bay'], counties:['San Francisco County','Alameda County','Santa Clara County','San Mateo County','Marin County','Contra Costa County','Napa County','Sonoma County'] },
    { name:'Wine Country',      state:'CA', triggers:['wine country','napa valley'],                 counties:['Napa County','Sonoma County'] },
    { name:'Greater San Diego', state:'CA', triggers:['san diego metro','greater san diego'],        counties:['San Diego County'] },
    // — Illinois / Utah / SC / Colorado / Hawaii / Wyoming + others —
    { name:'Chicagoland',       state:'IL', triggers:['chicagoland','chicago metro','greater chicago','chicago area'], counties:['Cook County','DuPage County','Lake County','Will County','Kane County'] },
    { name:'Wasatch Front',     state:'UT', triggers:['wasatch front','salt lake metro','greater salt lake'], counties:['Salt Lake County','Utah County','Davis County','Weber County'] },
    { name:'Park City Area',    state:'UT', triggers:['park city area','summit county utah'],         counties:['Summit County','Wasatch County'] },
    { name:'Southern Utah',     state:'UT', triggers:['southern utah','greater zion','st george'],    counties:['Washington County'] },
    { name:'The Lowcountry',    state:'SC', triggers:['lowcountry','low country','charleston metro','greater charleston'], counties:['Charleston County','Berkeley County','Dorchester County'] },
    { name:'Upstate SC',        state:'SC', triggers:['upstate south carolina','the upstate','greenville metro'], counties:['Greenville County','Spartanburg County','Anderson County'] },
    { name:'Denver Metro',      state:'CO', triggers:['denver metro','greater denver','front range'], counties:['Denver County','Arapahoe County','Jefferson County','Adams County','Douglas County'] },
    { name:'Aspen / Roaring Fork', state:'CO', triggers:['aspen','roaring fork'],                     counties:['Pitkin County'] },
    { name:'Steamboat Springs', state:'CO', triggers:['steamboat'],                                  counties:['Routt County'] },
    { name:'Oahu',              state:'HI', triggers:['oahu','honolulu metro'],                       counties:['Honolulu County'] },
    { name:'Kauai',             state:'HI', triggers:['kauai'],                                       counties:['Kauai County'] },
    { name:'Jackson Hole',      state:'WY', triggers:['jackson hole'],                                counties:['Teton County'] },
    { name:'Greater Pittsburgh',state:'PA', triggers:['pittsburgh metro','greater pittsburgh'],       counties:['Allegheny County'] },
    { name:'Greater Cleveland', state:'OH', triggers:['cleveland metro','greater cleveland'],          counties:['Cuyahoga County'] },
    { name:'Metro Detroit',     state:'MI', triggers:['metro detroit','detroit metro'],               counties:['Wayne County'] },
    { name:'Kansas City Metro', state:'MO', triggers:['kansas city metro','greater kansas city'],      counties:['Jackson County'] },
    { name:'Las Vegas Valley',  state:'NV', triggers:['las vegas valley','vegas','greater las vegas'], counties:['Clark County'] }
  ];
  // Whole-state handles (full name → every project in the state).
  var STATES = [
    { code:'FL', name:'Florida', triggers:['florida'] }, { code:'NY', name:'New York State', triggers:['new york state'] },
    { code:'TN', name:'Tennessee', triggers:['tennessee'] }, { code:'TX', name:'Texas', triggers:['texas'] },
    { code:'CA', name:'California', triggers:['california'] }, { code:'IL', name:'Illinois', triggers:['illinois'] },
    { code:'UT', name:'Utah', triggers:['utah'] }, { code:'SC', name:'South Carolina', triggers:['south carolina'] },
    { code:'HI', name:'Hawaii', triggers:['hawaii'] }, { code:'CO', name:'Colorado', triggers:['colorado'] },
    { code:'WY', name:'Wyoming', triggers:['wyoming'] }, { code:'NV', name:'Nevada', triggers:['nevada'] },
    { code:'PA', name:'Pennsylvania', triggers:['pennsylvania'] }, { code:'MI', name:'Michigan', triggers:['michigan'] },
    { code:'MO', name:'Missouri', triggers:['missouri'] }, { code:'OH', name:'Ohio', triggers:['ohio'] },
    { code:'PR', name:'Puerto Rico', triggers:['puerto rico'] }
  ];
  // ── Bulletproof place hierarchy ───────────────────────────────────
  // Every project belongs to a STACK of places — neighborhood ⊂ city ⊂ borough
  // ⊂ county ⊂ metro/region ⊂ state ⊂ country — but the data only stores a few
  // of those fields (City, Neighborhood, County, CountyState). The rest are
  // DERIVED here so a query at ANY level connects to the same project: a Midtown
  // tower answers to "midtown", "manhattan", "new york city", "new york county",
  // "new york", "nyc" AND "usa". placeTokensOf(p) computes that full token set;
  // resolvePlace(q) finds the most specific level a query names and matches on it.

  // NYC counties ARE boroughs — the only place the borough isn't the city.
  var BOROUGH_BY_COUNTY = {
    'New York County': ['manhattan'],
    'Kings County':    ['brooklyn'],
    'Queens County':   ['queens'],
    'Bronx County':    ['bronx', 'the bronx'],
    'Richmond County': ['staten island']
  };
  // State code → spoken names a user might type (full name + common variants).
  var STATE_NAMES = {
    FL:['florida'], NY:['new york','new york state'], TN:['tennessee'], TX:['texas'],
    CA:['california'], IL:['illinois'], UT:['utah'], SC:['south carolina'], HI:['hawaii'],
    CO:['colorado'], WY:['wyoming'], NV:['nevada'], PA:['pennsylvania'], MI:['michigan'],
    MO:['missouri'], OH:['ohio'], PR:['puerto rico'], GA:['georgia'], NC:['north carolina'],
    AZ:['arizona'], WA:['washington state'], MA:['massachusetts'], DC:['washington dc','d.c.']
  };
  // City aliases that are actually BOROUGHS — excluded from city-level tokens
  // (a Brooklyn project must NOT answer to "manhattan"); boroughs come from the
  // precise county instead, via BOROUGH_BY_COUNTY.
  var BOROUGH_ALIAS = { 'manhattan':1,'brooklyn':1,'queens':1,'bronx':1,'the bronx':1,'staten island':1 };

  // county "New York County|NY" → the region trigger words that cover it, built
  // once from REGIONS so a project inherits every metro/nickname it sits inside
  // ("south florida", "sofla", "the palm beaches", "swfl", …). Cached.
  var _regionsByCounty = null;
  function regionsByCounty() {
    if (_regionsByCounty) return _regionsByCounty;
    _regionsByCounty = {};
    REGIONS.forEach(function (r) {
      (r.counties || []).forEach(function (c) {
        var k = norm(c) + '|' + r.state;
        if (!_regionsByCounty[k]) _regionsByCounty[k] = [];
        // the region's display name + every trigger/nickname it answers to
        [r.name].concat(r.triggers).forEach(function (t) {
          var nt = norm(t);
          if (nt && _regionsByCounty[k].indexOf(nt) < 0) _regionsByCounty[k].push(nt);
        });
      });
    });
    return _regionsByCounty;
  }

  // The complete, normalized place-token set for one project — every level it
  // belongs to. Memoized on the project so repeat queries are free.
  function placeTokensOf(p) {
    if (p.__placeTokens) return p.__placeTokens;
    var toks = new Set();
    function add(s) { var n = norm(s); if (n && n.length >= 2) toks.add(n); }
    var st = String(p.CountyState || '').trim();
    var county = String(p.County || '').trim();
    // neighborhood — full value, its comma parts, AND the bare submarket
    // ("Midtown East" also answers to "midtown"; "Jamaica, Queens" → "jamaica")
    var nbhd = String(p.Neighborhood || '').trim();
    if (nbhd) {
      nbhd.split(',').forEach(function (part) {
        var pt = part.trim(); if (!pt) return;
        add(pt);
        var w = norm(pt).split(/\s+/);
        if (w.length > 1 && w[0].length >= 4) add(w[0]);          // leading submarket word
      });
    }
    // city (+ first comma part) and any non-borough alias the city answers to
    var city = String(p.City || '').trim();
    if (city) {
      add(city);
      var cFirst = city.split(',')[0].trim(); if (cFirst) add(cFirst);
      for (var ak in CITY_ALIASES) {
        if (CITY_ALIASES.hasOwnProperty(ak) && CITY_ALIASES[ak] === city && !BOROUGH_ALIAS[ak]) add(ak);
      }
    }
    // borough (NYC) — derived from the precise county
    if (county && BOROUGH_BY_COUNTY[county]) BOROUGH_BY_COUNTY[county].forEach(add);
    // county — with and without the "County"/"Parish" suffix
    if (county) { add(county); add(county.replace(/\s+(county|parish|borough)$/i, '')); }
    // metro / region / nicknames covering this county
    if (county && st) (regionsByCounty()[norm(county) + '|' + st] || []).forEach(add);
    // state — code + spoken names
    if (st) { add(st); (STATE_NAMES[st] || []).forEach(add); }
    // country (US data; international rows carry no US state code)
    if (st && STATE_NAMES[st]) { add('usa'); add('united states'); add('america'); }
    p.__placeTokens = toks;
    return toks;
  }

  // Resolve the place a query names, at the most specific level present, and
  // return a matcher. Handles single words ("manhattan"), neighborhoods
  // ("midtown"), neighborhood+scope ("midtown manhattan" → only NYC Midtown),
  // cities, counties, metros/nicknames, and states. Returns null if no place.
  var _placeVocabCache = null, _placeVocabFor = null;
  function buildPlaceVocab(projects) {
    if (_placeVocabCache && _placeVocabFor === projects) return _placeVocabCache;
    // level rank: higher = more specific (wins as the display/primary place)
    var vocab = new Map();   // token -> { token, level, display }
    function put(token, level, display) {
      var t = norm(token); if (!t || t.length < 2) return;
      var ex = vocab.get(t);
      if (!ex || level > ex.level) vocab.set(t, { token: t, level: level, display: display });
    }
    (projects || []).forEach(function (p) {
      var nbhd = String(p.Neighborhood || '').trim();
      if (nbhd) nbhd.split(',').forEach(function (part) { var pt = part.trim(); if (pt) put(pt, 6, pt); });
      var city = String(p.City || '').trim();
      if (city) { put(city, 5, city.split(',')[0].trim()); var cf = city.split(',')[0].trim(); if (cf) put(cf, 5, cf); }
      var county = String(p.County || '').trim();
      if (county && BOROUGH_BY_COUNTY[county]) BOROUGH_BY_COUNTY[county].forEach(function (b) { put(b, 5, b.replace(/\b\w/g, function (c) { return c.toUpperCase(); })); });
      if (county) { put(county, 3, county); put(county.replace(/\s+(county|parish|borough)$/i, ''), 3, county); }
    });
    // city aliases (non-borough) at city level
    for (var ak in CITY_ALIASES) if (CITY_ALIASES.hasOwnProperty(ak) && !BOROUGH_ALIAS[ak]) put(ak, 5, CITY_ALIASES[ak]);
    // regions / metros / nicknames (level 2) and states (level 1)
    REGIONS.forEach(function (r) { r.triggers.concat([r.name]).forEach(function (t) { put(t, 2, r.name); }); });
    STATES.forEach(function (s) { s.triggers.forEach(function (t) { put(t, 1, s.name); }); });
    _placeVocabCache = vocab; _placeVocabFor = projects;
    return vocab;
  }
  function resolvePlace(q, projects) {
    var full = norm(q);
    if (!full) return null;
    var vocab = buildPlaceVocab(projects || []);
    var matched = [];
    vocab.forEach(function (entry, token) {
      // short tokens (≤4: "nyc","ny","la","swfl") need a word boundary so they
      // don't fire inside a longer word; longer ones are distinctive substrings.
      var hit = token.length <= 4 ? hasWord(full, token) : full.indexOf(token) >= 0;
      if (hit) matched.push(entry);
    });
    if (!matched.length) return null;
    // Drop any matched token that is a substring of another matched token, so
    // "west palm beach" wins over "palm beach" and "southwest florida" over
    // "florida" — we keep the most specific phrasing the user actually typed.
    var kept = matched.filter(function (m) {
      return !matched.some(function (o) { return o.token !== m.token && o.token.indexOf(m.token) >= 0; });
    });
    // primary place = the most specific level (tiebreak: longest token)
    var primary = kept.slice().sort(function (a, b) { return b.level - a.level || b.token.length - a.token.length; })[0];
    var tokens = kept.map(function (m) { return m.token; });
    return {
      name: primary.display,
      level: primary.level,
      tokens: tokens,
      // a project matches when it carries EVERY place token the query named —
      // hierarchical tokens auto-scope ("midtown" + "manhattan" → NYC Midtown),
      // while a single token fans out to everything below it ("florida").
      match: function (p) {
        var pt = placeTokensOf(p);
        for (var i = 0; i < tokens.length; i++) if (!pt.has(tokens[i])) return false;
        return true;
      }
    };
  }

  // norm(County) -> {county, state} for the DOMINANT state when a county name
  // repeats (e.g. Orange County: FL vs CA), so a bare "orange county" resolves
  // to wherever we cover most.
  function _countySet(projects) {
    var counts = {};
    (projects || []).forEach(function (p) {
      var c = String(p.County || '').trim(), st = String(p.CountyState || '').trim();
      if (!c || !st) return;
      var k = norm(c) + '|' + st;
      if (!counts[k]) counts[k] = { county: c, state: st, n: 0 };
      counts[k].n++;
    });
    var best = {};
    Object.keys(counts).forEach(function (k) {
      var e = counts[k], nc = norm(e.county);
      if (!best[nc] || e.n > best[nc].n) best[nc] = { county: e.county, state: e.state, n: e.n };
    });
    return best;
  }
  // A query resolves to an AREA — region, whole state, or a single county —
  // returning { name, state, counties|null }. Longest trigger wins. `projects`
  // supplies the data-driven county vocabulary.
  function detectArea(q, projects) {
    var full = norm(q), best = null;
    function consider(name, state, counties, tlen) {
      if (!best || tlen > best.tlen) best = { name: name, state: state, counties: counties, tlen: tlen };
    }
    REGIONS.forEach(function (r) { r.triggers.forEach(function (t) { if (full.indexOf(t) >= 0) consider(r.name, r.state, r.counties, t.length); }); });
    STATES.forEach(function (s) { s.triggers.forEach(function (t) { if (full.indexOf(t) >= 0) consider(s.name, s.code, null, t.length); }); });
    var cs = _countySet(projects);
    Object.keys(cs).forEach(function (nc) { if (nc.length >= 5 && full.indexOf(nc) >= 0) consider(cs[nc].county, cs[nc].state, [cs[nc].county], nc.length); });
    return best ? { name: best.name, state: best.state, counties: best.counties } : null;
  }
  function inArea(p, area) {
    if (!area || !area.state) return false;
    if (String(p.CountyState || '') !== area.state) return false;
    if (!area.counties) return true;  // whole state
    return area.counties.indexOf(String(p.County || '').trim()) >= 0;
  }
  function citiesInArea(area, projects) {
    if (!area) return [];
    var set = {};
    (projects || []).forEach(function (p) {
      if (inArea(p, area)) { var c = String(p.City || '').split(',')[0].trim(); if (c) set[c] = 1; }
    });
    return Object.keys(set);
  }
  // GUARDRAIL: a county/parish/borough was explicitly named but we cover nothing
  // there → return the place name (for an honest "no coverage" answer), else null.
  function coverageMiss(q, projects) {
    var full = norm(q);
    var m = full.match(/\b([a-z][a-z .'-]*?)\s+(county|parish|borough)\b/);
    if (!m) return null;
    if (detectArea(q, projects)) return null;  // it resolved → we cover it
    return (m[1] + ' ' + m[2]).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // Build a normalized-city → display-city map from the projects array.
  // Caller passes projects in (rather than a stale module-cached copy)
  // so different surfaces with different filtered project sets stay
  // consistent with what they actually have.
  //
  // Each city is also indexed by its FIRST comma-separated part so the
  // query parser can match "nashville" against projects stored as
  // "Nashville, TN" or "Nashville, Tennessee". Without this, the same
  // place is silently treated as different cities depending on which
  // editor entered it. The first-part variant is added only if it's
  // long enough to be meaningful (>= 4 chars).
  // Common short forms / aliases for cities a user is likely to type. Only
  // include UNAMBIGUOUS short forms — e.g. "west palm" maps only to West Palm
  // Beach (no other city in the DB matches), but bare "palm beach" is left
  // out because it conflicts with Palm Beach Gardens, North Palm Beach, etc.
  // Aliases only apply when the corresponding canonical city is present in
  // the project set, so they auto-disable in test data without that city.
  var CITY_ALIASES = {
    'west palm':       'West Palm Beach',
    'wpb':             'West Palm Beach',
    'nyc':             'New York City',
    'new york':        'New York City',
    'manhattan':       'New York City',
    'brooklyn':        'New York City',
    'queens':          'New York City',
    'the bronx':       'New York City',
    'bronx':           'New York City',
    'staten island':   'New York City',
    'la':              'Los Angeles',
    'sf':              'San Francisco',
    'sd':              'San Diego',
    'ftl':             'Fort Lauderdale',
    'ft lauderdale':   'Fort Lauderdale',
    'fort myers':      'Fort Myers',
    'st pete':         'St. Petersburg',
    'st petersburg':   'St. Petersburg',
    'park city':       'Park City',
    'dc':              'Washington',
    'big apple':       'New York City',
    'south beach':     'Miami Beach',
  };
  function buildCitySet(projects) {
    var m = new Map();
    var canonical = new Set();  // canonical city names present in the DB
    (projects || []).forEach(function (p) {
      var c = (p.City || '').trim();
      if (!c || c.length < 4) return;
      m.set(norm(c), c);
      canonical.add(c);
      var first = c.split(',')[0].trim();
      if (first.length >= 4 && first !== c) {
        var firstNorm = norm(first);
        if (!m.has(firstNorm)) m.set(firstNorm, first);
        canonical.add(first);
      }
    });
    // Layer aliases on top, but only when the canonical city is actually in
    // the project set — keeps the map honest if a city ever leaves the DB.
    for (var aliasKey in CITY_ALIASES) {
      if (!CITY_ALIASES.hasOwnProperty(aliasKey)) continue;
      var canon = CITY_ALIASES[aliasKey];
      if (!canonical.has(canon)) continue;
      var aliasNorm = norm(aliasKey);
      if (!m.has(aliasNorm)) m.set(aliasNorm, canon);
    }
    return m;
  }

  // Detect a firm / architect / developer named in the query. Ranks by
  // match quality (exact phrase > all distinctive tokens > one long token)
  // then by specificity (longer name), so "related ross" picks Related
  // Ross over Related Group, and "kengo kuma" picks Kengo Kuma.
  function detectFirm(full, firms, cityWords) {
    if (!firms || !firms.length) return null;
    var best = null, bestScore = 0, bestLen = 0;
    for (var i = 0; i < firms.length; i++) {
      var f = firms[i];
      var n = norm(f.name || '');
      if (n.length < 4) continue;
      var sig = n.split(/\s+/).filter(function (t) { return t.length > 2 && !FIRM_STOP.has(t); });
      if (!sig.length) continue;
      // A token that's already a matched CITY in this query is NOT a firm
      // signal — "Nashville" the place must not match "Nashville <X>" the
      // developer. Only the token-based rules use this filtered signal; an
      // explicit full firm-name match still wins.
      var fsig = cityWords ? sig.filter(function (t) { return !cityWords[t]; }) : sig;
      var score = 0;
      // Word-bounded full-name match — safe at 4+ chars because the leading
      // and trailing spaces enforce a true word boundary, so "Terra" can be
      // detected without falsely matching "terraform" or "Terrazza".
      if (n.length >= 4 && (' ' + full + ' ').indexOf(' ' + n + ' ') >= 0)                  score = 3;  // whole name, word-bounded
      else if (n.length >= 6 && full.indexOf(n) >= 0)                                       score = 2;  // whole name, substring
      else if (fsig.length >= 2 && fsig.every(function (t) { return hasWord(full, t); }))   score = 2;  // all distinctive tokens
      else if (fsig.length === 1 && fsig[0].length >= 6 && hasWord(full, fsig[0]))          score = 1;  // one distinctive long token
      if (score && (score > bestScore || (score === bestScore && n.length > bestLen))) {
        best = f; bestScore = score; bestLen = n.length;
      }
    }
    return best;
  }

  // Parse a query into structured criteria. Returns null if there's not
  // enough structure to warrant a smart answer -- callers fall back to
  // text-match search + (optionally) the LLM question handler.
  //
  //   opts.firms     -- the FIRMS array (for detectFirm)
  //   opts.projects  -- the PROJECTS array (for citySet)
  //   opts.thisYear  -- override THIS_YEAR (test isolation)
  function parseSmartQuery(q, opts) {
    opts = opts || {};
    var full = norm(q);
    if (full.split(/\s+/).filter(Boolean).length < 2) return null;  // bare names → normal search

    // LITERAL PROJECT-NAME ESCAPE HATCH. If the full query string appears
    // verbatim in a tracked project's title, prefer text-match scoring
    // over structured smart parsing. Without this, queries like
    // "oracle campus" parsed as developer=Oracle + type=Education
    // (because "campus" is an Education synonym) and the smart filter
    // returned 0 results -- "We don't track any schools tied to Oracle"
    // -- even though Oracle Campus IS a tracked project. Scanning project
    // titles is O(n) and cheap (a few hundred entries).
    var _projs = opts.projects || [];
    for (var _pi = 0; _pi < _projs.length; _pi++) {
      if (norm(_projs[_pi].Title || '').indexOf(full) >= 0) return null;
    }

    // status
    var statuses = new Set(), statusLabels = [];
    STATUS_GROUPS.forEach(function (g) {
      if (g.syn.some(function (s) { return hasWord(full, s); })) {
        statuses.add(g.value);
        if (statusLabels.indexOf(g.label) < 0) statusLabels.push(g.label);
      }
    });
    // construction milestones (strict; filtered against logged StatusHistory)
    var phases = new Set(), phaseLabels = [], phaseVerbs = [];
    PHASE_GROUPS.forEach(function (g) {
      if (g.syn.some(function (s) { return hasWord(full, s); })) {
        phases.add(g.phase); phaseLabels.push(g.label); phaseVerbs.push(g.verb);
      }
    });
    // type
    var types = new Set(), typeLabel = '', typeNoun = '';
    TYPE_GROUPS.forEach(function (g) {
      if (g.syn.some(function (s) { return hasWord(full, s); })) {
        types.add(g.token);
        if (!typeLabel) { typeLabel = g.label; typeNoun = g.noun; }
      }
    });
    // region + cities
    var region = (hasWord(full, 'florida') || /\bfl\b/.test(full)) ? 'Florida' : '';
    var cities = [];
    var citySet = buildCitySet(opts.projects || []);
    // Short aliases (≤ 4 chars: "la", "sf", "ftl", "nyc", etc.) MUST match as
    // a whole word — substring matching would false-trigger inside longer
    // place names ("la" finding LA inside "fort lauderdale", "sf" inside
    // "san francisco bay area", etc.). Longer city names stay substring-
    // matched since they're distinctive enough.
    citySet.forEach(function (disp, nc) {
      var matched = nc.length <= 4 ? hasWord(full, nc) : full.indexOf(nc) >= 0;
      if (matched) cities.push(disp);
    });
    // Dedup exact duplicates (an alias and its canonical entry both hit, e.g.
    // "office west palm beach" matches both "west palm" → WPB and "west palm
    // beach" → WPB) before the substring filter.
    var seenCity = {};
    cities = cities.filter(function (c) { return seenCity[c] ? false : (seenCity[c] = true); });
    // drop a city that's a substring of another matched (keep "West Palm Beach" over "Palm Beach")
    cities = cities.filter(function (c) {
      return !cities.some(function (o) { return o !== c && norm(o).indexOf(norm(c)) >= 0; });
    });
    // year
    var yearMin = null, yearMax = null, yearLabel = '', yearMode = 'delivery';
    var TY = opts.thisYear || THIS_YEAR;
    var yrs = (full.match(/20\d{2}/g) || []).map(Number);
    if (yrs.length) { yearMin = Math.min.apply(null, yrs); yearMax = Math.max.apply(null, yrs); yearLabel = yearMin === yearMax ? ('' + yearMin) : (yearMin + '–' + yearMax); }
    else if (hasWord(full, 'this year')) { yearMin = yearMax = TY; yearLabel = 'this year'; }
    else if (hasWord(full, 'next year')) { yearMin = yearMax = TY + 1; yearLabel = '' + (TY + 1); }

    // "breaking ground in 2026" is a phase-event query, not a delivery query.
    // The Breaking Ground status above is a CURRENT-state filter; projects
    // that broke ground earlier in the year have already advanced to Under
    // Construction. Filter against StartDate (the groundbreak event) and
    // drop the now-redundant current-status filter.
    var GB_SYN = ['breaking ground','broke ground','groundbreaking','breaks ground','break ground'];
    var hasGbPhrase = GB_SYN.some(function (s) { return hasWord(full, s); });
    if (hasGbPhrase && yearMin != null) {
      yearMode = 'start';
      statuses.delete('Breaking Ground');
      var bgi = statusLabels.indexOf('Breaking ground');
      if (bgi >= 0) statusLabels.splice(bgi, 1);
    }
    // sort / superlative
    var sort = null;
    for (var i = 0; i < SORT_GROUPS.length; i++) {
      var g = SORT_GROUPS[i];
      if (g.syn.some(function (s) { return hasWord(full, s); })) { sort = g; break; }
    }

    // "recent(ly) ... opened / openings" means recently COMPLETED, not
    // about-to-open. Flip Opening Soon → Now Open in that case.
    var openish = hasWord(full, 'opening') || hasWord(full, 'opened') || hasWord(full, 'openings');
    var recentish = hasWord(full, 'recent') || hasWord(full, 'recently') || hasWord(full, 'just opened') || hasWord(full, 'newly opened');
    if (openish && recentish) {
      statuses.delete('Opening Soon');
      var idx = statusLabels.indexOf('Opening soon'); if (idx >= 0) statusLabels.splice(idx, 1);
      statuses.add('Now Open');
      if (statusLabels.indexOf('Open') < 0) statusLabels.push('Open');
    }

    // "soon" as a standalone word (e.g. "hotels opening around the world soon")
    // means the LIVE window — what just opened AND what's about to. Unlike the
    // strict "Opening Soon" status, surface BOTH recently-opened (Now Open) and
    // upcoming (Opening Soon), bounded to a rolling year either side of THIS_YEAR
    // so it reads as "the last/next ~12 months." Only fires when no explicit year
    // was given and it isn't already a strict "recently opened" (recentish) ask.
    var rolling = false, rollMin = null, rollMax = null;
    if (hasWord(full, 'soon') && yearMin == null && !recentish) {
      rolling = true;
      statuses.add('Opening Soon'); statuses.add('Now Open');
      if (statusLabels.indexOf('Opening soon') < 0) statusLabels.push('Opening soon');
      if (statusLabels.indexOf('Open') < 0) statusLabels.push('Open');
      // Rolling window: recently opened (last 6 months) through opening within the
      // next 12 months. Month-precise so a stale "2025" delivery doesn't read as
      // "recent"; bare-year delivery dates resolve to mid-year for comparison.
      var _now = opts.now ? new Date(opts.now) : new Date();
      var _pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var _lo = new Date(_now.getFullYear(), _now.getMonth() - 6, 1);
      var _hi = new Date(_now.getFullYear(), _now.getMonth() + 12, 1);
      rollMin = _lo.getFullYear() + '-' + _pad(_lo.getMonth() + 1);
      rollMax = _hi.getFullYear() + '-' + _pad(_hi.getMonth() + 1);
      yearLabel = 'Recent–' + _hi.getFullYear();
    }

    var place = region || cities.length;
    // Tokens already matched as a CITY here can't double as a firm signal.
    var cityWords = {};
    cities.forEach(function (c) { norm(c).split(/\s+/).forEach(function (t) { if (t.length >= 4) cityWords[t] = 1; }); });
    var firm = detectFirm(full, opts.firms || [], cityWords);
    // "Most active firm / developer / architect" — a request to RANK the firms
    // behind the matched projects, not the projects themselves. A specific firm
    // NAME (detectFirm) takes precedence over this generic ranking intent.
    var firmRank = null;
    var rankCue = /\b(most active|busiest|most prolific|prolific|leading|biggest)\b/.test(full) || hasWord(full, 'most') || hasWord(full, 'top');
    var wantDev = hasWord(full, 'developer') || hasWord(full, 'developers') || hasWord(full, 'builder') || hasWord(full, 'builders');
    var wantArch = hasWord(full, 'architect') || hasWord(full, 'architects');
    var wantFirm = hasWord(full, 'firm') || hasWord(full, 'firms') || hasWord(full, 'company') || hasWord(full, 'companies');
    if (rankCue && (wantDev || wantArch || wantFirm)) {
      firmRank = (wantFirm || (wantDev && wantArch)) ? 'both' : (wantDev ? 'developer' : 'architect');
      // A ranking ask ("most active developer") supersedes an incidental firm-name
      // match — e.g. detectFirm latching onto a firm literally named "MG Developer".
      firm = null;
    }
    var count = (statuses.size ? 1 : 0) + (phases.size ? 1 : 0) + (types.size ? 1 : 0) + (place ? 1 : 0) + (yearMin != null ? 1 : 0) + (sort ? 1 : 0) + (firm ? 1 : 0) + (firmRank ? 1 : 0);
    // Geographic / firm anchor alone is enough to trigger smart. "projects
    // coming to nashville", "deals in florida", "show me kengo kuma" all
    // converge to the same city/region/firm view rather than getting
    // punished by the strict count check + falling into a text-match that
    // requires every generic word ("projects", "coming") in each title.
    if (firm || place || firmRank) {
      return {
        statuses: statuses, statusLabels: statusLabels,
        phases: phases, phaseLabels: phaseLabels, phaseVerbs: phaseVerbs,
        types: types, typeLabel: typeLabel, typeNoun: typeNoun,
        region: region, cities: cities,
        yearMin: yearMin, yearMax: yearMax, yearLabel: yearLabel, yearMode: yearMode,
        sort: sort, firm: firm, firmRank: firmRank, rolling: rolling, rollMin: rollMin, rollMax: rollMax
      };
    }
    if (count < 2) return null;  // no anchor + too little structure → normal search

    return {
      statuses: statuses, statusLabels: statusLabels,
      phases: phases, phaseLabels: phaseLabels, phaseVerbs: phaseVerbs,
      types: types, typeLabel: typeLabel, typeNoun: typeNoun,
      region: region, cities: cities,
      yearMin: yearMin, yearMax: yearMax, yearLabel: yearLabel,
      sort: sort, firm: firm, rolling: rolling, rollMin: rollMin, rollMax: rollMax
    };
  }

  function phasesOf(p) {
    return (p.StatusHistory || []).map(function (h) {
      return String((h && h.phase) || '').toLowerCase();
    }).filter(Boolean);
  }

  function smartFilter(s, projects) {
    return (projects || []).filter(function (p) {
      if (s.statuses.size && !s.statuses.has(p.Delivery)) return false;
      // STRICT milestone filter -- project must actually have logged this phase
      if (s.phases && s.phases.size) {
        var ph = phasesOf(p);
        var hasAny = false;
        s.phases.forEach(function (x) { if (ph.indexOf(x) >= 0) hasAny = true; });
        if (!hasAny) return false;
      }
      if (s.types.size) {
        // Filter is intentionally broad here: ProjectType is the multi-tag
        // list, so a mixed-use project like Nauka (Residences + Golf +
        // Hotel) IS a legit hit for a "golf course" query. The HERO
        // selection in the overlay handles the false-positive case
        // separately by preferring candidates whose PreferredType (the
        // editor's PRIMARY type) actually matches the type filter --
        // that's what keeps an Altamira-style residential community
        // tagged "Residences, Golf" from grabbing the top slot.
        var pt = norm(firstField(p, ['ProjectType', 'PreferredType']));
        var typeMatch = false;
        s.types.forEach(function (t) { if (pt.indexOf(norm(t)) >= 0) typeMatch = true; });
        if (!typeMatch) return false;
      }
      if (s.cities.length) {
        // Match against both the full city string AND the first comma-
        // separated part. Projects in the database use mixed formats --
        // "Nashville", "Nashville, TN", "Nashville, Tennessee" all exist.
        // Without this, a city criterion of "Nashville" only catches the
        // exact-string variant and silently drops the rest, so a query
        // like "projects coming to nashville" surfaces 4 results instead
        // of all of them. Comparing the first comma-part normalizes
        // these variants without touching the underlying data.
        var pCityFull = norm(p.City || '');
        var pCityFirst = pCityFull.split(',')[0].trim();
        if (!s.cities.some(function (c) {
          var cNorm = norm(c);
          return pCityFull === cNorm || pCityFirst === cNorm;
        })) return false;
      }
      if (s.region === 'Florida' && !inFlorida(p)) return false;
      if (s.yearMin != null) {
        var y = s.yearMode === 'start' ? startYearOf(p) : yearOf(p);
        if (y == null || y < s.yearMin || y > s.yearMax) return false;
      }
      if (s.rollMin) {
        var _m = String(p.DeliveryDate || '').match(/^(\d{4})(?:-(\d{2}))?/);
        if (!_m) return false;
        var _ym = _m[1] + '-' + (_m[2] || '06');  // bare year → mid-year
        if (_ym < s.rollMin || _ym > s.rollMax) return false;
      }
      if (s.firm) {
        // Match by distinctive tokens (credits vary across editions). All-tokens-
        // present catches every project tied to the studio.
        var sig = norm(s.firm.name).split(/\s+/).filter(function (t) { return t.length > 2 && !FIRM_STOP.has(t); });
        var a = norm(p.Architect || ''), d = norm(p.Developer || '');
        if (!(sig.length && (sig.every(function (t) { return a.indexOf(t) >= 0; }) ||
                              sig.every(function (t) { return d.indexOf(t) >= 0; })))) return false;
      }
      return true;
    });
  }

  // ── Unified status spine ──────────────────────────────────────────
  // The ONE order TMW leads with everywhere — prose, the project grid, AND the
  // hero card: Coming Soon (hype) → Recently Opened (≤6mo) → Under Construction
  // → Breaking Ground → Announced → long-open. Featured (the editor's pick)
  // lifts a project ~2 tiers, so a featured under-construction tower leads, but
  // a genuinely imminent non-featured opening still beats a featured far-off
  // announcement. Tuned against real cases: Nora Hotel (Opening Soon+Featured)
  // leads WPB hotels; Curio (Announced) and Belgrove (opened 2024) sink; South
  // Flagler + Berkeley (Featured, building) lead condos; 120 S Dixie + PBKC
  // (Announced, far out) drop.
  var STATUS_RANK = { 'Opening Soon': 0, 'Under Construction': 2, 'Breaking Ground': 3, 'Announced': 4 };
  function _monthsSince(dateStr, nowMs) {
    var m = String(dateStr || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return null;
    var d = new Date(+m[1], m[2] ? +m[2] - 1 : 5, m[3] ? +m[3] : 15);
    return (nowMs - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  }
  function statusRankOf(p, nowMs) {
    var d = String(p.Delivery || '').trim();
    if (d === 'Now Open' || d === 'Completed' || d === 'Open' || d === 'Delivered') {
      var ms = _monthsSince(p.DeliveryDate, nowMs);
      return (ms != null && ms <= 6 && ms >= -1) ? 1 : 5;   // recently opened vs long-open
    }
    return Object.prototype.hasOwnProperty.call(STATUS_RANK, d) ? STATUS_RANK[d] : 6;
  }
  function _isFeatured(p) { return String(p.Featured || '').trim() ? 0 : 1; }
  // Sort rows by the status spine in place; returns the same array. Order is
  // exactly Jake's: Featured (editor's pick, top tier) → then by status:
  // Coming Soon → Recently Opened (≤6mo) → Under Construction → Breaking Ground
  // → Announced → long-open → unknown; soonest delivery, then taller, break ties.
  function rankByStatus(rows, opts) {
    opts = opts || {};
    var nowMs = opts.now ? (new Date(opts.now)).getTime() : Date.now();
    rows.sort(function (a, b) {
      var fa = _isFeatured(a), fb = _isFeatured(b);
      if (fa !== fb) return fa - fb;                                          // featured first
      var ra = statusRankOf(a, nowMs), rb = statusRankOf(b, nowMs);
      if (ra !== rb) return ra - rb;                                          // then status order
      var da = (a.DeliveryDate || '9999'), db = (b.DeliveryDate || '9999');   // soonest first; TBD/blank sinks
      if (da !== db) return da < db ? -1 : 1;
      return floorsOf(b) - floorsOf(a);                                       // taller breaks ties
    });
    return rows;
  }

  function smartRank(rows, s) {
    var big = 1e9;
    if (s.sort && s.sort.key === 'floors') {
      var dir = s.sort.dir === 'asc' ? 1 : -1;
      rows.sort(function (a, b) {
        var fa = floorsOf(a) || (dir > 0 ? big : -1);
        var fb = floorsOf(b) || (dir > 0 ? big : -1);
        return (fa - fb) * dir || floorsOf(b) - floorsOf(a);
      });
    } else if (s.sort && s.sort.key === 'units') {
      rows.sort(function (a, b) { return unitsOf(b) - unitsOf(a); });
    } else if (s.sort && s.sort.key === 'date') {
      var ddir = s.sort.dir === 'asc' ? 1 : -1;
      rows.sort(function (a, b) {
        var da = (a.DeliveryDate || '9999'), db = (b.DeliveryDate || '9999');
        return da < db ? -1 * ddir : da > db ? 1 * ddir : 0;
      });
    } else if (s.sort && s.sort.key === 'updated') {
      rows.sort(function (a, b) { return String(b.UpdatedAt || '').localeCompare(String(a.UpdatedAt || '')); });
    } else {
      // DEFAULT — the unified status spine. Replaces the old "featured then
      // tallest" / rolling / opening-soon heuristics: rankByStatus already folds
      // in featured boost, the recently-opened window, and soonest-delivery
      // tiebreaks, so prose, grid, and hero all order identically.
      rankByStatus(rows, { now: s && s.now });
    }
    return rows;
  }

  // Synthesize a one-sentence answer + stats array from the resolved
  // rows. Returns { html, stats:[{v,k}] }. The LLM upgrade replaces the
  // sentence after; stats stay DB-derived.
  // Rank the developers / architects behind a set of project rows by how many
  // of those projects credit them. Mirrors deriveFirmsFromProjects: Developer /
  // Architect are comma-separated and parallel to their *Slugs; blanks and
  // "Various" are skipped. Returns { developers:[{name,slug,count}], architects:[…] },
  // each sorted most-active first. Powers "most active firm/developer/architect".
  function rankFirms(rows) {
    function tally(getName, getSlug) {
      var map = {};
      (rows || []).forEach(function (p) {
        var names = String(getName(p) || '').split(',');
        var slugs = String(getSlug(p) || '').split(',');
        names.forEach(function (raw, i) {
          var nm = raw.trim();
          if (!nm || nm.toLowerCase() === 'various') return;
          var key = norm(nm);
          if (!map[key]) map[key] = { name: nm, slug: (slugs[i] || '').trim(), count: 0 };
          map[key].count++;
        });
      });
      return Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
    }
    return {
      developers: tally(function (p) { return p.Developer; }, function (p) { return p.DeveloperSlugs; }),
      architects: tally(function (p) { return p.Architect; }, function (p) { return p.ArchitectSlugs; })
    };
  }

  function buildSmartAnswer(s, rows) {
    var n = rows.length;
    var noun = s.typeNoun || 'project';
    var subj = '<b>' + n + ' ' + noun + (n !== 1 ? 's' : '') + '</b>';
    var statusPhrase = s.statusLabels.length ? ' ' + s.statusLabels.map(function (l) { return l.toLowerCase(); }).join(' / ') : '';
    var placePhrase = s.cities.length ? ' in ' + s.cities.join(' & ') : (s.region ? ' in ' + s.region : '');
    var yearVerb = s.yearMode === 'start' ? 'breaking ground in ' : 'delivering ';
    var yearPhrase = s.yearLabel ? (s.statuses.size ? ', ' + yearVerb + s.yearLabel : ' ' + yearVerb + s.yearLabel) : '';
    var hasPhase = !!(s.phases && s.phases.size);
    var phaseVerbs = s.phaseVerbs || [];
    var sentence;

    if (n === 0) {
      if (s.firm) return { html: 'We don’t track any ' + noun + 's tied to <b>' + esc(s.firm.name) + '</b>' + placePhrase + yearPhrase + ' yet.', stats: [] };
      if (s.yearMode === 'start') {
        return { html: 'No tracked ' + noun + 's are breaking ground' + placePhrase + ' in ' + esc(s.yearLabel) + ' yet.', stats: [] };
      }
      var lead = hasPhase ? ' have ' + phaseVerbs.join(' / ')
               : (s.statusLabels.length ? ' are ' + s.statusLabels.map(function (l) { return l.toLowerCase(); }).join('/') : ' match');
      sentence = 'No tracked ' + noun + 's' + lead + placePhrase + yearPhrase + ' yet.';
      return { html: sentence, stats: [] };
    }

    // "Most active firm / developer / architect" — answer with the top firm(s)
    // behind the matched rows, not a project overview. 'both' names a developer
    // AND an architect; 'developer'/'architect' name just that one.
    if (s.firmRank) {
      var fr = rankFirms(rows);
      var wantDev = s.firmRank === 'both' || s.firmRank === 'developer';
      var wantArch = s.firmRank === 'both' || s.firmRank === 'architect';
      // When the top firm has only one project, no one "leads" — the field is
      // spread, so say that instead of crowning a 1-project firm as "most active".
      var leadBit = function (role, list) {
        if (!list.length) return '';
        var t = list[0];
        if (t.count >= 2) return '<span class="hl">' + esc(t.name) + '</span> is the most active ' + role + ' (' + t.count + ' projects)';
        return 'no single ' + role + ' leads — ' + list.length + ' ' + role + 's, one project each';
      };
      var bits = [];
      if (wantDev) { var bd = leadBit('developer', fr.developers); if (bd) bits.push(bd); }
      if (wantArch) { var ba = leadBit('architect', fr.architects); if (ba) bits.push(ba); }
      if (bits.length) {
        var frStats = [{ v: '' + n, k: 'Results' }];
        if (wantDev && fr.developers.length) frStats.push({ v: '' + fr.developers.length, k: 'Developers' });
        if (wantArch && fr.architects.length) frStats.push({ v: '' + fr.architects.length, k: 'Architects' });
        return {
          html: 'Across <b>' + n + ' tracked ' + noun + (n !== 1 ? 's' : '') + '</b>' + placePhrase + ', ' + bits.join('; ') + '.',
          stats: frStats.slice(0, 4)
        };
      }
    }

    var be = (n === 1 ? 'is' : 'are');
    if (s.firm) {
      var rv = s.firm.role === 'developer' ? 'is the developer behind'
             : s.firm.role === 'architect' ? 'is the architect on'
             : 'is behind';
      var cntPhrase = '<b>' + n + ' tracked ' + noun + (n !== 1 ? 's' : '') + '</b>';
      var names = rows.slice(0, 3).map(function (p) { return '<span class="hl">' + esc(p.Title) + '</span>' + (p.City ? ' (' + esc(p.City) + ')' : ''); });
      var list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
      var more = n > 3 ? ', plus ' + (n - 3) + ' more' : '';
      sentence = '<b>' + esc(s.firm.name) + '</b> ' + rv + ' ' + cntPhrase + statusPhrase + placePhrase + yearPhrase + ' — ' + list + more + '.';
    } else if (hasPhase) {
      sentence = subj + ' ' + (n === 1 ? 'has' : 'have') + ' ' + phaseVerbs.join(' and ') + placePhrase + yearPhrase + '.';
    } else if (s.statuses.size) {
      sentence = subj + ' ' + be + statusPhrase + placePhrase + yearPhrase + '.';
    } else {
      sentence = subj + placePhrase + yearPhrase + ' ' + be + ' tracked in our database.';
    }

    // Sort highlight -- only with 2+ results (a single result isn't "the tallest")
    var top = rows[0];
    if (n >= 2 && s.sort && s.sort.key === 'floors' && s.sort.dir === 'desc' && floorsOf(top)) {
      sentence += ' The tallest is <span class="hl">' + esc(top.Title) + '</span> at <span class="hl">' + floorsOf(top) + ' stories</span>.';
    } else if (n >= 2 && s.sort && s.sort.key === 'units' && unitsOf(top)) {
      sentence += ' The largest is <span class="hl">' + esc(top.Title) + '</span> with <span class="hl">' + unitsOf(top).toLocaleString() + ' residences</span>.';
    } else if (n >= 2 && s.sort && s.sort.key === 'date' && s.sort.dir === 'asc' && fmtDelivery(top)) {
      sentence += ' Next to open: <span class="hl">' + esc(top.Title) + '</span> (' + fmtDelivery(top) + ').';
    }

    // Stats
    var stats = [];
    stats.push({ v: '' + n, k: 'Results' });
    var maxF = 0, maxU = 0;
    for (var i = 0; i < rows.length; i++) { var f = floorsOf(rows[i]); if (f > maxF) maxF = f; var u = unitsOf(rows[i]); if (u > maxU) maxU = u; }
    if (s.sort && s.sort.key === 'floors' && maxF) stats.push({ v: maxF + '<span class="u"> fl</span>', k: 'Tallest' });
    else if (s.sort && s.sort.key === 'units' && maxU) stats.push({ v: maxU.toLocaleString(), k: 'Most units' });
    else {
      var uc = rows.filter(function (p) { return p.Delivery === 'Under Construction'; }).length;
      if (uc) stats.push({ v: '' + uc, k: 'Under construction' });
    }
    var sumU = rows.reduce(function (a, p) { return a + unitsOf(p); }, 0);
    if (sumU > 0) stats.push({ v: '~' + sumU.toLocaleString(), k: 'Residences total' });
    var nextYr = soonestFutureYear(rows);
    if (nextYr) stats.push({ v: '' + nextYr, k: 'First delivery' });
    return { html: sentence, stats: stats.slice(0, 4) };
  }

  // ── editorial signals — the patterns a TMW analyst would lead with ──
  // Pure: derives "what's newsworthy here" from a set of project rows so the
  // LLM can write an overview (imminence, transformation, dominant theme)
  // instead of just naming the top-ranked match.
  function _isDistrict(p) { return p.IsDistrict === true || p.IsDistrict === 'true' || p.IsDistrict === 1; }
  function _primaryType(p) { return String(p.PreferredType || (p.ProjectType || '').split(',')[0] || '').trim(); }
  function computeSignals(rows) {
    rows = (rows || []).filter(function (p) { return p && p.Title && p.Delivery !== 'Article'; });
    if (!rows.length) return { dominantType: null, soonest: null, flagships: null };
    var d = new Date(), nowM = d.getFullYear() * 12 + d.getMonth();
    var idx = function (dd) { var m = String(dd || '').match(/^(\d{4})(?:-(\d{2}))?/); return m ? (+m[1]) * 12 + ((m[2] ? +m[2] : 6) - 1) : null; };
    // soonest UPCOMING opening (not already open) + how soon
    var up = rows.filter(function (p) { return p.Delivery !== 'Now Open'; })
      .map(function (p) { return { p: p, i: idx(p.DeliveryDate) }; })
      .filter(function (x) { return x.i != null && x.i >= nowM - 1; })
      .sort(function (a, b) { return a.i - b.i; });
    // dominant type — what the near-term pipeline (next ~2 yrs of openings) leans
    // toward, falling back to the whole set when the pipeline is thin. "Nashville
    // is leaning toward hotels" is about what's COMING, not what's already built.
    var nearRows = up.filter(function (x) { return x.i <= nowM + 24; }).map(function (x) { return x.p; });
    var basisRows = nearRows.length >= 3 ? nearRows : rows;
    var counts = {};
    basisRows.forEach(function (p) { var t = _primaryType(p); if (t) counts[t] = (counts[t] || 0) + 1; });
    var dt = null, dn = 0;
    for (var k in counts) { if (counts[k] > dn) { dn = counts[k]; dt = k; } }
    var dominantType = (basisRows.length >= 3 && dt && dn >= 2)
      ? { type: dt, count: dn, of: basisRows.length, scope: (basisRows === nearRows ? 'opening soon' : 'tracked') } : null;
    var soonest = null;
    if (up.length) {
      var u = up[0], diff = u.i - nowM;
      var urg = diff <= 0 ? 'this month' : diff === 1 ? 'next month' : diff <= 3 ? ('in ~' + diff + ' months')
              : (diff <= (11 - d.getMonth()) ? 'later this year' : (fmtDelivery(u.p) || u.p.DeliveryDate || ''));
      soonest = { name: u.p.Title, delivery: fmtDelivery(u.p) || u.p.DeliveryDate || '', urgency: urg, status: u.p.Delivery || '' };
    }
    // transformational flagships — districts + stadium / mega mixed-use, biggest first
    var scale = function (p) { return Math.max(floorsOf(p), unitsOf(p) / 10); };
    var flagships = rows.filter(function (p) {
      var t = norm(_primaryType(p) + ' ' + (p.ProjectType || ''));
      return _isDistrict(p) || /mixed-use|stadium|arena|ballpark|airport|entertainment/.test(t);
    }).sort(function (a, b) {
      return ((_isDistrict(b) ? 1 : 0) - (_isDistrict(a) ? 1 : 0)) || (scale(b) - scale(a));
    }).slice(0, 3).map(function (p) {
      return { name: p.Title, type: _primaryType(p), district: _isDistrict(p), blurb: String(p.Description || '').slice(0, 180) };
    });
    return { dominantType: dominantType, soonest: soonest, flagships: flagships.length ? flagships : null };
  }
  // The freshest sourced development from a project's dossier (StatusHistory) —
  // the concrete "more info" line (e.g. "broke ground June 8, 2026; completion
  // late 2027"). Gives TMW Intelligence per-project awareness beyond the static
  // description, so answers cite what actually just happened. Most recent note
  // with real text wins; capped so the facts payload stays lean.
  function latestUpdateOf(p) {
    var sh = p.StatusHistory;
    if (!Array.isArray(sh) || !sh.length) return '';
    var withNote = sh.filter(function (e) {
      if (!e || !e.note) return false;
      var n = String(e.note).trim();
      // skip internal data-ops notes (neighborhood/field backfills, housekeeping)
      // — they aren't news and would waste the model's attention.
      return n && !/backfill|per our [a-z ]*coverage|housekeep/i.test(n);
    });
    if (!withNote.length) return '';
    withNote.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    return String(withNote[0].note).trim().slice(0, 220);
  }
  // Enriched project shape shared by both fact-payload builders.
  function factRow(p) {
    return { id: p.Slug || '', name: p.Title || '', city: p.City || '', status: p.Delivery || '', type: _primaryType(p),
      floors: floorsOf(p) || null, units: unitsOf(p) || null, delivery: fmtDelivery(p) || '',
      district: _isDistrict(p), blurb: String(p.Description || '').slice(0, 140),
      update: latestUpdateOf(p) };
  }

  // Build the LLM facts payload from the resolved rows. Numbers are
  // DB-derived; the model is told to use only these. Used by the
  // /smart-answer upgrade step (replaces the deterministic sentence
  // with LLM prose after; stats stay).
  function buildSmartFacts(s, rows) {
    var maxF = 0, maxU = 0;
    for (var i = 0; i < rows.length; i++) {
      var f = floorsOf(rows[i]); if (f > maxF) maxF = f;
      var u = unitsOf(rows[i]); if (u > maxU) maxU = u;
    }
    var tallest = maxF ? rows.find(function (p) { return floorsOf(p) === maxF; }) : null;
    var largest = maxU ? rows.find(function (p) { return unitsOf(p) === maxU; }) : null;
    var place = s.cities.length ? s.cities.join(' & ') : (s.region || null);
    var many = rows.length >= 2;
    var sig = computeSignals(rows);
    var facts = {
      count: rows.length,
      criteria: {
        firm: s.firm ? s.firm.name : null,
        firmRole: s.firm ? s.firm.role : null,
        milestone: (s.phaseLabels && s.phaseLabels.join(' / ')) || null,
        status: s.statusLabels.join(' / ') || null,
        type: s.typeLabel || null,
        place: place,
        year: s.yearLabel || null
      },
      sort: s.sort ? s.sort.label : null,
      place: place,
      tallest: (many && tallest) ? { name: tallest.Title, floors: maxF } : null,
      largest: (many && largest) ? { name: largest.Title, units: maxU } : null,
      residencesTotal: rows.reduce(function (a, p) { return a + unitsOf(p); }, 0) || null,
      firstDelivery: soonestFutureYear(rows),
      dominantType: sig.dominantType,
      soonest: sig.soonest,
      flagships: sig.flagships,
      top: rows.slice(0, 8).map(factRow)
    };
    if (s.firmRank) {
      var fr = rankFirms(rows);
      facts.firmRanking = {
        scope: s.firmRank,
        topDevelopers: fr.developers.slice(0, 5).map(function (d) { return { name: d.name, projects: d.count }; }),
        topArchitects: fr.architects.slice(0, 5).map(function (a) { return { name: a.name, projects: a.count }; })
      };
    }
    return facts;
  }

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
    sizeScoreOf: sizeScoreOf,
    yearOf: yearOf,
    fmtDelivery: fmtDelivery,
    inFlorida: inFlorida,
    // Intelligence pipeline (question / LLM path)
    isQuestion: isQuestion,
    buildIntelFacts: buildIntelFacts,
    buildJournalFacts: buildJournalFacts,
    detectArea: detectArea,
    inArea: inArea,
    citiesInArea: citiesInArea,
    coverageMiss: coverageMiss,
    // bulletproof place hierarchy (neighborhood→city→borough→county→metro→state→country)
    placeTokensOf: placeTokensOf,
    resolvePlace: resolvePlace,
    askIntelligence: askIntelligence,
    // partner spotlights
    PARTNER_SPOTLIGHTS: PARTNER_SPOTLIGHTS,
    matchSpotlight: matchSpotlight,
    // structured smart-query pipeline (Phase 2B)
    THIS_YEAR: THIS_YEAR,
    STATUS_GROUPS: STATUS_GROUPS,
    PHASE_GROUPS: PHASE_GROUPS,
    TYPE_GROUPS: TYPE_GROUPS,
    SORT_GROUPS: SORT_GROUPS,
    STATUS_BADGE: STATUS_BADGE,
    FIRM_STOP: FIRM_STOP,
    QUERY_STOPWORDS: QUERY_STOPWORDS,
    filterMeaningfulTokens: filterMeaningfulTokens,
    parseSmartQuery: parseSmartQuery,
    smartFilter: smartFilter,
    smartRank: smartRank,
    rankByStatus: rankByStatus,
    statusRankOf: statusRankOf,
    buildSmartAnswer: buildSmartAnswer,
    buildSmartFacts: buildSmartFacts,
    computeSignals: computeSignals,
    detectFirm: detectFirm,
    buildCitySet: buildCitySet,
    // assets
    HEX_SVG: HEX_SVG
  };
})();
