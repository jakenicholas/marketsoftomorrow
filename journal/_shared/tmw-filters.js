/* ───────────────────────────────────────────────────────────────────────────
   TMW SHARED FILTER STATE — one query string across /map/ and /atlas/.

   Map and Atlas render the SAME projects two ways. They used to filter on the
   same three axes with different controls and different URL params, so a
   filter never survived a surface change: filter the Atlas to West Palm Beach
   condos delivering 2027, click Map, and you landed on an unfiltered map. This
   module is the contract that fixes that. The Journal|Map|Atlas toggle becomes
   a view switch on one result set instead of three separate destinations.

   THE CONTRACT (canonical form is always the slug):
     ?city=west-palm-beach   place, city level   (the map already owned ?city=)
     ?state=FL               place, state level  (atlas already owned ?state=)
     ?type=mixed-use         project type        (ANY of the ProjectType list)
     ?status=construction    lifecycle slug      (never the display string)
     ?year=2027              delivery year

   Absent means "no filter on that axis" — never an explicit "all". Empty
   params are stripped, so a clean state is a clean link.

   SOURCE OF TRUTH is worker/src/ontology.js → ONTOLOGY.filters. A browser
   cannot import worker source, so the vocabulary is copied here and stamped
   with the version it was written against. If GET /ontology reports a newer
   version and these lists have changed, this file is the thing that is stale.

   USAGE
     tmwFilters.get()                 → {city, state, type, status, year} (slugs, empties dropped)
     tmwFilters.cityName()            → 'West Palm Beach' (display form, for surfaces that need it)
     tmwFilters.set({type:'hotel'})   → merges, rewrites the URL (replaceState), notifies
     tmwFilters.clear()               → drops all five, leaves foreign params alone
     tmwFilters.hrefFor('map')        → '/map/?city=…' — carry state to another surface
     tmwFilters.onChange(fn)          → fn(state) on any set/clear/popstate
     tmwFilters.matches(project)      → does a projects-flat row pass the current filter
     tmwFilters.label()               → 'West Palm Beach · Hotel · Under Construction'
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.tmwFilters) return;

  var ONTOLOGY_VERSION = '2026-07-29.2';   // the version this vocabulary mirrors
  var PARAMS = ['city', 'state', 'type', 'status', 'year'];

  // ── vocabulary (mirrors ONTOLOGY.filters) ─────────────────────────────────
  var STATUS_ORDER = ['announced', 'breaking-ground', 'construction', 'coming-soon', 'open'];
  var STATUS_DISPLAY = {
    'announced': 'Announced', 'breaking-ground': 'Breaking Ground',
    'construction': 'Under Construction', 'coming-soon': 'Opening Soon', 'open': 'Now Open'
  };
  // Legacy Delivery values that predate the canonical list.
  var STATUS_ALIAS = { 'complete': 'open', 'completed': 'open' };

  var TYPE_ORDER = ['residences', 'mixed-use', 'hotel', 'golf', 'museum', 'office', 'entertainment',
                    'stadium', 'travel', 'cultural', 'park', 'retail', 'education', 'marina', 'healthcare'];
  var TYPE_DISPLAY = {
    'residences': 'Residences', 'mixed-use': 'Mixed-Use', 'hotel': 'Hotel', 'golf': 'Golf',
    'museum': 'Museum', 'office': 'Office', 'entertainment': 'Entertainment', 'stadium': 'Stadium',
    'travel': 'Travel', 'cultural': 'Cultural', 'park': 'Park', 'retail': 'Retail',
    'education': 'Education', 'marina': 'Marina', 'healthcare': 'Healthcare'
  };
  // Long-tail PreferredType values that are really one of the above. A project
  // may KEEP a preferred custom type name as its display label; these aliases
  // are how it stays visible without falling out of the canonical filter. Do
  // not "clean up" the rows — label and filter vocabulary are separate.
  var TYPE_ALIAS = {
    'hospital': 'healthcare', 'country-club': 'golf', 'members-club-and-boutique-hotel': 'hotel'
  };

  // ── helpers ───────────────────────────────────────────────────────────────
  function slug(t) {
    return String(t == null ? '' : t).toLowerCase().trim()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s-]+/g, '-')
      .replace(/^-|-$/g, '');
  }
  // Display form from a slug: 'west-palm-beach' → 'West Palm Beach'. Only used
  // for city, where the map needs the human name to match project rows.
  function unslug(s) {
    return String(s || '').split('-').filter(Boolean).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  function normStatus(v) {
    var s = slug(v);
    if (!s) return '';
    if (STATUS_ALIAS[s]) s = STATUS_ALIAS[s];
    // accept the display form too ("Under Construction")
    if (STATUS_ORDER.indexOf(s) < 0) {
      for (var k in STATUS_DISPLAY) { if (slug(STATUS_DISPLAY[k]) === s) return k; }
      return '';
    }
    return s;
  }
  function normType(v) {
    var s = slug(v);
    if (!s) return '';
    if (TYPE_ALIAS[s]) s = TYPE_ALIAS[s];
    return TYPE_ORDER.indexOf(s) >= 0 ? s : '';
  }
  function normState(v) {
    var s = String(v || '').trim().toUpperCase();
    if (s === 'ALL') return '';
    return /^[A-Z]{2}$/.test(s) ? s : '';
  }
  function normYear(v) {
    var s = String(v || '').trim();
    return /^(19|20)\d{2}$/.test(s) ? s : '';
  }
  // City accepts BOTH the canonical slug and the legacy display form that live
  // links, embeds and the sitemap still carry (?city=West%20Palm%20Beach).
  function normCity(v) { return slug(v); }

  var NORM = { city: normCity, state: normState, type: normType, status: normStatus, year: normYear };

  // ── read ──────────────────────────────────────────────────────────────────
  function readFrom(search) {
    var q = new URLSearchParams(search == null ? location.search : search);
    var out = {};
    PARAMS.forEach(function (k) {
      var v = NORM[k](q.get(k) || '');
      if (v) out[k] = v;
    });
    return out;
  }

  var _state = readFrom();
  var _subs = [];

  function get() {
    var c = {}; PARAMS.forEach(function (k) { if (_state[k]) c[k] = _state[k]; }); return c;
  }
  function isEmpty() { return Object.keys(get()).length === 0; }
  function cityName() { return _state.city ? unslug(_state.city) : ''; }

  // ── write ─────────────────────────────────────────────────────────────────
  // Only ever touches the five params it owns; anything else on the URL
  // (map's ?project=/?embed=, atlas's ?aview=) is preserved untouched.
  function queryString(state, existingSearch) {
    var q = new URLSearchParams(existingSearch == null ? location.search : existingSearch);
    PARAMS.forEach(function (k) {
      if (state[k]) q.set(k, state[k]); else q.delete(k);
    });
    var s = q.toString();
    return s ? '?' + s : '';
  }

  function apply(next, opts) {
    var changed = false;
    PARAMS.forEach(function (k) {
      var was = _state[k] || '', now = next[k] || '';
      if (was !== now) changed = true;
    });
    _state = {};
    PARAMS.forEach(function (k) { if (next[k]) _state[k] = next[k]; });
    if (!(opts && opts.silentUrl)) {
      // replaceState, not pushState: filtering is not navigation, and a
      // filter-per-back-button makes the back button useless.
      try { history.replaceState(null, '', location.pathname + queryString(_state) + location.hash); } catch (e) {}
    }
    if (changed && !(opts && opts.silent)) notify();
    return changed;
  }

  function set(patch, opts) {
    var next = get();
    Object.keys(patch || {}).forEach(function (k) {
      if (PARAMS.indexOf(k) < 0) return;
      var v = patch[k] == null ? '' : NORM[k](patch[k]);
      if (v) next[k] = v; else delete next[k];
    });
    return apply(next, opts);
  }
  function clear(opts) { return apply({}, opts); }

  function notify() {
    var s = get();
    _subs.slice().forEach(function (fn) { try { fn(s); } catch (e) {} });
  }
  function onChange(fn) { if (typeof fn === 'function') _subs.push(fn); }

  // The URL can change under us (back/forward, or a surface rewriting its own
  // view params). Re-read rather than trusting our cached copy.
  window.addEventListener('popstate', function () { apply(readFrom(), { silentUrl: true }); });

  // ── cross-surface links ───────────────────────────────────────────────────
  // 'explore' is an alias for the Atlas: the standalone /explore/ page was
  // retired, and the Atlas overview is the explore surface now.
  var SURFACE_PATH = { journal: '/', map: '/map/', atlas: '/atlas/', explore: '/atlas/' };
  function hrefFor(surface, extra) {
    var path = SURFACE_PATH[surface] || surface;
    // Start from a CLEAN query: the destination gets our filters, not our
    // view params (carrying ?project= from the map into the atlas is noise).
    var q = new URLSearchParams();
    PARAMS.forEach(function (k) { if (_state[k]) q.set(k, _state[k]); });
    Object.keys(extra || {}).forEach(function (k) { if (extra[k]) q.set(k, extra[k]); });
    var s = q.toString();
    return path + (s ? '?' + s : '');
  }

  // ── matching (one definition of "does this project pass") ─────────────────
  // Takes a projects-flat.json row. Surfaces differ in how they render, not in
  // what passes, so this lives here rather than being reimplemented twice.
  function matches(p, state) {
    var f = state || _state;
    if (!p) return false;
    if (f.city && slug(p.City || '') !== f.city) return false;
    if (f.state) {
      var st = String(p.CountyState || p.State || '').trim().toUpperCase();
      // CountyState can arrive as "Palm Beach, FL" — take the trailing code.
      var m = st.match(/([A-Z]{2})$/);
      if (!m || m[1] !== f.state) return false;
    }
    if (f.type) {
      // A project matches a type if ANY of its types match. ProjectType is a
      // comma-separated LIST ("Residences, Hotel, Mixed-Use"); PreferredType is
      // only the primary and disagrees with the list head on 151 of 911 rows,
      // so filtering on it would hide real matches. The map additionally
      // suppresses a district when one of its children covers the same type;
      // that rule needs the parent/child index and stays surface-side.
      var types = String(p.ProjectType || p.PreferredType || '')
        .split(',').map(function (t) { return normType(t); }).filter(Boolean);
      if (types.indexOf(f.type) < 0) return false;
    }
    if (f.status && normStatus(p.Delivery || '') !== f.status) return false;
    if (f.year) {
      // CUMULATIVE: "delivering BY end of <year>", not "delivering IN <year>".
      // This is Atlas's shipped meaning and the more useful pipeline filter.
      var dy = parseInt(String(p.DeliveryDate || '').slice(0, 4), 10);
      if (!dy || dy > parseInt(f.year, 10)) return false;
    }
    return true;
  }

  function label(state) {
    var f = state || _state, bits = [];
    if (f.city) bits.push(unslug(f.city));
    else if (f.state) bits.push(f.state);
    if (f.type) bits.push(TYPE_DISPLAY[f.type] || f.type);
    if (f.status) bits.push(STATUS_DISPLAY[f.status] || f.status);
    if (f.year) bits.push(f.year);
    return bits.join(' · ');
  }

  window.tmwFilters = {
    ONTOLOGY_VERSION: ONTOLOGY_VERSION,
    PARAMS: PARAMS,
    STATUS_ORDER: STATUS_ORDER, STATUS_DISPLAY: STATUS_DISPLAY,
    TYPE_ORDER: TYPE_ORDER, TYPE_DISPLAY: TYPE_DISPLAY,
    get: get, isEmpty: isEmpty, cityName: cityName,
    set: set, clear: clear, onChange: onChange,
    hrefFor: hrefFor, matches: matches, label: label,
    slug: slug, unslug: unslug,
    normalize: { city: normCity, state: normState, type: normType, status: normStatus, year: normYear },
    // exposed for tests / debugging
    _readFrom: readFrom, _queryString: queryString
  };
})();
