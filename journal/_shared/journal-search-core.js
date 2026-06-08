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
  var TYPE_GROUPS = [
    { token:'Residences', label:'Condo / Residences', noun:'condo',     syn:['condo','condominium'] },
    { token:'Residences', label:'Tower / High-rise',  noun:'tower',     syn:['tower','high-rise','highrise','skyscraper'] },
    { token:'Residences', label:'Residences',         noun:'residence', syn:['residence','residential','apartment','home'] },
    { token:'Hotel',      label:'Hotel',              noun:'hotel',     syn:['hotel'] },
    { token:'Resort',     label:'Resort',             noun:'resort',    syn:['resort'] },
    { token:'Office',     label:'Office',             noun:'office',    syn:['office'] },
    { token:'Retail',     label:'Retail',             noun:'retail project', syn:['retail','shopping','mall','shops'] },
    { token:'Eateries',   label:'Dining',             noun:'eatery',    syn:['restaurant','eatery','dining','food hall'] },
    { token:'Park',       label:'Park',               noun:'park',      syn:['park'] },
    { token:'Marina',     label:'Marina',             noun:'marina',    syn:['marina'] },
    { token:'Museum',     label:'Museum',             noun:'museum',    syn:['museum'] },
    { token:'Entertainment', label:'Entertainment',   noun:'venue',     syn:['entertainment'] },
    { token:'Golf',       label:'Golf',               noun:'golf course', syn:['golf','golf course','country club'] },
    { token:'Stadium',    label:'Stadium',            noun:'stadium',   syn:['stadium','arena','ballpark'] },
    { token:'Education',  label:'Education',          noun:'school',    syn:['school','university','college','campus'] },
    { token:'Cultural',   label:'Cultural',           noun:'cultural project', syn:['cultural'] },
    { token:'Spa',        label:'Spa',                noun:'spa',       syn:['spa','wellness'] },
    { token:'Mixed-Use',  label:'Mixed-use',          noun:'mixed-use project', syn:['mixed-use','mixed use'] },
    { token:'Hospital',   label:'Hospital',           noun:'hospital',  syn:['hospital','medical center'] },
    { token:'Airport',    label:'Airport',            noun:'airport',   syn:['airport'] }
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

  function inFlorida(p) {
    var la = parseFloat(p.Latitude), ln = parseFloat(p.Longitude);
    return la >= 24.3 && la <= 31.1 && ln >= -87.8 && ln <= -79.8;
  }

  // Build a normalized-city → display-city map from the projects array.
  // Caller passes projects in (rather than a stale module-cached copy)
  // so different surfaces with different filtered project sets stay
  // consistent with what they actually have.
  function buildCitySet(projects) {
    var m = new Map();
    (projects || []).forEach(function (p) {
      var c = (p.City || '').trim();
      if (c && c.length >= 4) m.set(norm(c), c);
    });
    return m;
  }

  // Detect a firm / architect / developer named in the query. Ranks by
  // match quality (exact phrase > all distinctive tokens > one long token)
  // then by specificity (longer name), so "related ross" picks Related
  // Ross over Related Group, and "kengo kuma" picks Kengo Kuma.
  function detectFirm(full, firms) {
    if (!firms || !firms.length) return null;
    var best = null, bestScore = 0, bestLen = 0;
    for (var i = 0; i < firms.length; i++) {
      var f = firms[i];
      var n = norm(f.name || '');
      if (n.length < 4) continue;
      var sig = n.split(/\s+/).filter(function (t) { return t.length > 2 && !FIRM_STOP.has(t); });
      if (!sig.length) continue;
      var score = 0;
      if (n.length >= 6 && (' ' + full + ' ').indexOf(' ' + n + ' ') >= 0)                  score = 3;  // whole name, word-bounded
      else if (n.length >= 6 && full.indexOf(n) >= 0)                                       score = 2;  // whole name, substring
      else if (sig.length >= 2 && sig.every(function (t) { return hasWord(full, t); }))     score = 2;  // all distinctive tokens
      else if (sig.length === 1 && sig[0].length >= 6 && hasWord(full, sig[0]))             score = 1;  // one distinctive long token
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
    citySet.forEach(function (disp, nc) { if (full.indexOf(nc) >= 0) cities.push(disp); });
    // drop a city that's a substring of another matched (keep "West Palm Beach" over "Palm Beach")
    cities = cities.filter(function (c) {
      return !cities.some(function (o) { return o !== c && norm(o).indexOf(norm(c)) >= 0; });
    });
    // year
    var yearMin = null, yearMax = null, yearLabel = '';
    var TY = opts.thisYear || THIS_YEAR;
    var yrs = (full.match(/20\d{2}/g) || []).map(Number);
    if (yrs.length) { yearMin = Math.min.apply(null, yrs); yearMax = Math.max.apply(null, yrs); yearLabel = yearMin === yearMax ? ('' + yearMin) : (yearMin + '–' + yearMax); }
    else if (hasWord(full, 'this year')) { yearMin = yearMax = TY; yearLabel = 'this year'; }
    else if (hasWord(full, 'next year')) { yearMin = yearMax = TY + 1; yearLabel = '' + (TY + 1); }
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

    var place = region || cities.length;
    var firm = detectFirm(full, opts.firms || []);
    var count = (statuses.size ? 1 : 0) + (phases.size ? 1 : 0) + (types.size ? 1 : 0) + (place ? 1 : 0) + (yearMin != null ? 1 : 0) + (sort ? 1 : 0) + (firm ? 1 : 0);
    if (!firm && count < 2) return null;  // no firm + too little structure → normal search

    return {
      statuses: statuses, statusLabels: statusLabels,
      phases: phases, phaseLabels: phaseLabels, phaseVerbs: phaseVerbs,
      types: types, typeLabel: typeLabel, typeNoun: typeNoun,
      region: region, cities: cities,
      yearMin: yearMin, yearMax: yearMax, yearLabel: yearLabel,
      sort: sort, firm: firm
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
        var pt = norm(firstField(p, ['ProjectType', 'PreferredType']));
        var typeMatch = false;
        s.types.forEach(function (t) { if (pt.indexOf(norm(t)) >= 0) typeMatch = true; });
        if (!typeMatch) return false;
      }
      if (s.cities.length) {
        if (!s.cities.some(function (c) { return norm(p.City) === norm(c); })) return false;
      }
      if (s.region === 'Florida' && !inFlorida(p)) return false;
      if (s.yearMin != null) {
        var y = yearOf(p);
        if (y == null || y < s.yearMin || y > s.yearMax) return false;
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
      rows.sort(function (a, b) {
        if (a.Featured && !b.Featured) return -1;
        if (!a.Featured && b.Featured) return 1;
        return floorsOf(b) - floorsOf(a);
      });
    }
    return rows;
  }

  // Synthesize a one-sentence answer + stats array from the resolved
  // rows. Returns { html, stats:[{v,k}] }. The LLM upgrade replaces the
  // sentence after; stats stay DB-derived.
  function buildSmartAnswer(s, rows) {
    var n = rows.length;
    var noun = s.typeNoun || 'project';
    var subj = '<b>' + n + ' ' + noun + (n !== 1 ? 's' : '') + '</b>';
    var statusPhrase = s.statusLabels.length ? ' ' + s.statusLabels.map(function (l) { return l.toLowerCase(); }).join(' / ') : '';
    var placePhrase = s.cities.length ? ' in ' + s.cities.join(' & ') : (s.region ? ' in ' + s.region : '');
    var yearPhrase = s.yearLabel ? (s.statuses.size ? ', delivering ' + s.yearLabel : ' delivering ' + s.yearLabel) : '';
    var hasPhase = !!(s.phases && s.phases.size);
    var phaseVerbs = s.phaseVerbs || [];
    var sentence;

    if (n === 0) {
      if (s.firm) return { html: 'We don’t track any ' + noun + 's tied to <b>' + esc(s.firm.name) + '</b>' + placePhrase + yearPhrase + ' yet.', stats: [] };
      var lead = hasPhase ? ' have ' + phaseVerbs.join(' / ')
               : (s.statusLabels.length ? ' are ' + s.statusLabels.map(function (l) { return l.toLowerCase(); }).join('/') : ' match');
      sentence = 'No tracked ' + noun + 's' + lead + placePhrase + yearPhrase + ' yet.';
      return { html: sentence, stats: [] };
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
      sentence = subj + placePhrase + yearPhrase + ' ' + be + ' tracked on the map.';
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
    var yrs = rows.map(yearOf).filter(Boolean);
    if (yrs.length) stats.push({ v: '' + Math.min.apply(null, yrs), k: 'First delivery' });
    return { html: sentence, stats: stats.slice(0, 4) };
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
    var yrs = rows.map(yearOf).filter(Boolean);
    var place = s.cities.length ? s.cities.join(' & ') : (s.region || null);
    var many = rows.length >= 2;
    return {
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
      firstDelivery: yrs.length ? Math.min.apply(null, yrs) : null,
      top: rows.slice(0, 8).map(function (p) {
        return { name: p.Title, city: p.City || '', status: p.Delivery || '', floors: floorsOf(p) || null, units: unitsOf(p) || null, delivery: fmtDelivery(p) || '' };
      })
    };
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
    yearOf: yearOf,
    fmtDelivery: fmtDelivery,
    inFlorida: inFlorida,
    // Intelligence pipeline (question / LLM path)
    isQuestion: isQuestion,
    buildIntelFacts: buildIntelFacts,
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
    parseSmartQuery: parseSmartQuery,
    smartFilter: smartFilter,
    smartRank: smartRank,
    buildSmartAnswer: buildSmartAnswer,
    buildSmartFacts: buildSmartFacts,
    detectFirm: detectFirm,
    buildCitySet: buildCitySet,
    // assets
    HEX_SVG: HEX_SVG
  };
})();
