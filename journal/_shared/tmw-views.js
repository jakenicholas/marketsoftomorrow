/* ───────────────────────────────────────────────────────────────────────────
   TMW SAVED VIEWS — the primitive the personal layer is built on.

   A saved view is one small object:

       { id, name, surface, route, filter, created }

   …which is enough to reconstruct exactly what someone was looking at:
   "Miami · Under Construction" on the Atlas Projects route, or "Florida
   hotels" on Capital. That single object is deliberately doing three jobs:

     · a bookmark        — reopen a view you use often
     · the PIN primitive — pinning to the dashboard is saving a view
     · a dashboard tile  — the dashboard renders saved views as modules

   One concept instead of three. The alternative (separate bookmark, pin and
   widget models) is the thing that makes composable dashboards feel like
   configuration software, which is exactly what we do not want.

   STORAGE is Memberstack JSON, alongside favorites and the follow sets.
   updateMemberJSON REPLACES the whole blob, so every write is
   merge-fetch-write — the same pattern post.js uses. Getting that wrong
   silently eats a member's favorites, so it is centralised here rather than
   reimplemented per surface.

   USAGE
     tmwViews.list()                      → Promise<[view]>   (cached)
     tmwViews.save({surface, route, filter, name})  → Promise<view|null>
     tmwViews.remove(id)                  → Promise<bool>
     tmwViews.rename(id, name)            → Promise<bool>
     tmwViews.matching(surface, route, filter) → view|null   (is THIS saved?)
     tmwViews.href(view)                  → '/atlas/projects/?city=miami'
     tmwViews.suggestName(route, filter)  → 'Miami · Under Construction'
     tmwViews.onChange(fn)                → fn(views) after any write
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.tmwViews) return;

  var KEY = 'saved_views';        // the Memberstack JSON key
  var MAX = 60;                   // a sane ceiling; the blob is not a database

  var _cache = null;              // [view]
  var _listP = null;
  var _subs = [];

  function ms() { return window.$memberstackDom; }

  // ── ids ───────────────────────────────────────────────────────────────────
  // No Date.now()/random in the hot path is not a constraint here, but a
  // readable, collision-resistant id keeps the blob debuggable by hand.
  function newId() {
    return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ── read ──────────────────────────────────────────────────────────────────
  // Memberstack loads async. Waiting for it is the difference between "this
  // member has no saved views" and "we could not ask yet" — see list().
  function msReady() {
    return new Promise(function (res) {
      (function go(n) {
        var m = ms();
        if (m && m.getMemberJSON) return res(m);
        if (n > 40) return res(null);            // ~10s, then give up
        setTimeout(function () { go(n + 1); }, 250);
      })(0);
    });
  }
  // Resolves to the JSON blob, or null meaning UNKNOWN (not "empty").
  function readJson() {
    return msReady().then(function (m) {
      if (!m) return null;
      return m.getMemberJSON()
        .then(function (r) { return (r && r.data && typeof r.data === 'object') ? r.data : {}; })
        .catch(function () { return null; });
    });
  }

  function normalize(v) {
    if (!v || typeof v !== 'object') return null;
    if (!v.id || !v.route) return null;
    return {
      id: String(v.id),
      name: String(v.name || '').slice(0, 80) || 'Untitled view',
      surface: v.surface === 'map' ? 'map' : 'atlas',
      route: String(v.route),
      filter: (v.filter && typeof v.filter === 'object') ? v.filter : {},
      created: v.created || ''
    };
  }

  function list(force) {
    if (_cache && !force) return Promise.resolve(_cache.slice());
    if (_listP && !force) return _listP;
    _listP = readJson().then(function (j) {
      if (j === null) {
        // Could not ask — Memberstack never showed up, or the read failed.
        // Caching this as "no saved views" was a real bug: the dashboard calls
        // list() on init, before Memberstack resolves, so an empty result got
        // cached forever and views saved on the Atlas never appeared here.
        // Leave the cache unset so the next call retries.
        _listP = null;
        return [];
      }
      var raw = Array.isArray(j[KEY]) ? j[KEY] : [];
      _cache = raw.map(normalize).filter(Boolean);
      return _cache.slice();
    });
    return _listP;
  }

  // ── write (merge-fetch-write; updateMemberJSON replaces the blob) ─────────
  function commit(next) {
    var m = ms();
    if (!m || !m.updateMemberJSON) return Promise.resolve(false);
    return readJson().then(function (j) {
      if (!j) return false;
      j[KEY] = next.slice(0, MAX);
      return m.updateMemberJSON({ json: j }).then(function () {
        _cache = next.slice(0, MAX);
        _listP = Promise.resolve(_cache.slice());
        notify();
        return true;
      }).catch(function () { return false; });
    });
  }

  function notify() {
    var v = _cache ? _cache.slice() : [];
    _subs.slice().forEach(function (fn) { try { fn(v); } catch (e) {} });
  }
  function onChange(fn) { if (typeof fn === 'function') _subs.push(fn); }

  // ── identity: is the CURRENT view already saved? ──────────────────────────
  // Compared on (surface, route, filter) rather than name, so re-saving the
  // same thing toggles instead of piling up near-duplicates.
  function sameFilter(a, b) {
    a = a || {}; b = b || {};
    var keys = {};
    Object.keys(a).forEach(function (k) { keys[k] = 1; });
    Object.keys(b).forEach(function (k) { keys[k] = 1; });
    return Object.keys(keys).every(function (k) { return String(a[k] || '') === String(b[k] || ''); });
  }
  function matching(surface, route, filter) {
    if (!_cache) return null;
    for (var i = 0; i < _cache.length; i++) {
      var v = _cache[i];
      if (v.surface === (surface || 'atlas') && v.route === route && sameFilter(v.filter, filter)) return v;
    }
    return null;
  }

  // ── naming ────────────────────────────────────────────────────────────────
  // Auto-name from what is actually filtered, so the common path is one click
  // with no typing. "Miami · Under Construction — Projects".
  var ROUTE_LABEL = {
    overview: 'Overview', markets: 'Markets', projects: 'Projects', firms: 'Firms',
    supply: 'Supply', pricing: 'Pricing', capital: 'Capital', pipeline: 'Pipeline'
  };
  function suggestName(route, filter) {
    var bits = '';
    try { if (window.tmwFilters) bits = window.tmwFilters.label(filter || {}); } catch (e) {}
    var r = ROUTE_LABEL[route] || (route ? route.charAt(0).toUpperCase() + route.slice(1) : 'View');
    return bits ? (bits + ' · ' + r) : ('All markets · ' + r);
  }

  // ── links ─────────────────────────────────────────────────────────────────
  function href(v) {
    if (!v) return '/atlas/';
    var q = new URLSearchParams();
    Object.keys(v.filter || {}).forEach(function (k) { if (v.filter[k]) q.set(k, v.filter[k]); });
    var qs = q.toString();
    if (v.surface === 'map') return '/map/' + (qs ? '?' + qs : '');
    var base = (v.route && v.route !== 'overview') ? ('/atlas/' + v.route + '/') : '/atlas/';
    return base + (qs ? '?' + qs : '');
  }

  // ── mutations ─────────────────────────────────────────────────────────────
  function save(opts) {
    opts = opts || {};
    var surface = opts.surface === 'map' ? 'map' : 'atlas';
    var route = String(opts.route || 'overview');
    var filter = (opts.filter && typeof opts.filter === 'object') ? opts.filter : {};
    return list().then(function (cur) {
      var dupe = matching(surface, route, filter);
      if (dupe) return dupe;              // already saved → hand back the same one
      var v = normalize({
        id: newId(),
        name: opts.name || suggestName(route, filter),
        surface: surface, route: route, filter: filter,
        created: new Date().toISOString().slice(0, 10)
      });
      if (!v) return null;
      var next = [v].concat(cur);         // newest first
      return commit(next).then(function (ok) { return ok ? v : null; });
    });
  }

  function remove(id) {
    return list().then(function (cur) {
      var next = cur.filter(function (v) { return v.id !== id; });
      if (next.length === cur.length) return false;
      return commit(next);
    });
  }

  function rename(id, name) {
    return list().then(function (cur) {
      var hit = false;
      var next = cur.map(function (v) {
        if (v.id !== id) return v;
        hit = true;
        return normalize({ id: v.id, name: name, surface: v.surface, route: v.route, filter: v.filter, created: v.created });
      });
      return hit ? commit(next) : false;
    });
  }

  // ── Presets ──────────────────────────────────────────────────────────────
  // A new member's dashboard is otherwise an empty grid, which is the standard
  // failure of composable dashboards: the tool is most confusing exactly when
  // someone knows least about it. A preset is a bundle of saved views WE author,
  // applied in one click.
  //
  // Three properties are deliberate:
  //   · A preset is a STARTING POINT, not a mode. Once applied the views are
  //     just yours — nothing to exit, no template you are locked into, and no
  //     second system where presets and pins have to coexist.
  //   · It SEEDS FROM YOUR FOLLOWS. Market-scoped views use the first market
  //     you follow, so even the default is about you. Follow nothing and they
  //     fall back to all markets rather than inventing a city for you.
  //   · Applying is ONE commit, not one per view. Four sequential Memberstack
  //     writes would be slow and could half-apply.
  var PRESETS = [
    {
      id: 'developer',
      name: 'Developer',
      blurb: 'What you are competing with, and where the money is landing.',
      views: [
        { route: 'supply',   scope: 'market', name: 'Supply pressure' },
        { route: 'capital',  scope: 'market', name: 'Capital landing' },
        { route: 'projects', scope: 'market', name: 'Delivering by next year', filter: { year: 'NEXT' } },
        { route: 'firms',    scope: 'none',   name: 'Most active firms' }
      ]
    },
    {
      id: 'broker',
      name: 'Broker',
      blurb: 'What is about to open, what just did, and what it is worth.',
      views: [
        { route: 'projects', scope: 'market', name: 'Opening soon', filter: { status: 'coming-soon' } },
        { route: 'projects', scope: 'market', name: 'Just opened',  filter: { status: 'open' } },
        { route: 'pricing',  scope: 'market', name: 'Projected pricing' },
        { route: 'markets',  scope: 'none',   name: 'Every market, ranked' }
      ]
    },
    {
      id: 'investor',
      name: 'Investor',
      blurb: 'Where capital is going, and whether the market can absorb it.',
      views: [
        { route: 'capital',  scope: 'none',   name: 'Capital flows' },
        { route: 'supply',   scope: 'market', name: 'Supply pressure' },
        { route: 'projects', scope: 'market', name: 'Under construction', filter: { status: 'construction' } },
        { route: 'pipeline', scope: 'none',   name: 'The pipeline' }
      ]
    }
  ];

  // The member's first followed market, if any, as a filter slug.
  function seedMarket() {
    return readJson().then(function (j) {
      if (!j) return '';
      var f = j.markets_followed;
      var first = (Array.isArray(f) && f.length) ? f[0] : '';
      if (!first) return '';
      try { return window.tmwFilters ? window.tmwFilters.normalize.city(first) : String(first).toLowerCase(); }
      catch (e) { return ''; }
    });
  }

  function applyPreset(id) {
    var preset = PRESETS.filter(function (p) { return p.id === id; })[0];
    if (!preset) return Promise.resolve(false);
    return Promise.all([list(), seedMarket()]).then(function (o) {
      var cur = o[0], city = o[1];
      var nextYear = String(new Date().getFullYear() + 1);
      var made = [];
      preset.views.forEach(function (spec) {
        var filter = {};
        Object.keys(spec.filter || {}).forEach(function (k) {
          filter[k] = spec.filter[k] === 'NEXT' ? nextYear : spec.filter[k];
        });
        if (spec.scope === 'market' && city) filter.city = city;
        // Never duplicate a view the member already has.
        if (matching('atlas', spec.route, filter)) return;
        if (made.some(function (m) { return m.route === spec.route && sameFilter(m.filter, filter); })) return;
        made.push(normalize({
          id: newId(), name: spec.name, surface: 'atlas',
          route: spec.route, filter: filter,
          created: new Date().toISOString().slice(0, 10)
        }));
      });
      if (!made.length) return true;              // nothing new to add
      return commit(made.concat(cur));            // ONE write
    });
  }

  // Reorder. The stored ARRAY ORDER is the layout — there is no separate
  // positions/layout object to drift out of sync with the view list. Moving a
  // tile is moving an array element, which is also why removing one can never
  // leave a hole in the grid.
  function move(id, delta) {
    return list().then(function (cur) {
      var i = cur.findIndex(function (v) { return v.id === id; });
      if (i < 0) return false;
      var j = i + delta;
      if (j < 0 || j >= cur.length) return false;
      var next = cur.slice();
      var tmp = next[i]; next[i] = next[j]; next[j] = tmp;
      return commit(next);
    });
  }
  // Explicit ordering, for a drag implementation later: pass the ids in the
  // order you want. Ids missing from the list are ignored; views missing from
  // the ids keep their relative order at the end, so a stale client cannot
  // silently delete anything.
  function reorder(ids) {
    return list().then(function (cur) {
      var byId = {};
      cur.forEach(function (v) { byId[v.id] = v; });
      var next = [];
      (ids || []).forEach(function (id) { if (byId[id]) { next.push(byId[id]); delete byId[id]; } });
      cur.forEach(function (v) { if (byId[v.id]) next.push(v); });
      return commit(next);
    });
  }

  window.tmwViews = {
    list: list, save: save, remove: remove, rename: rename,
    move: move, reorder: reorder,
    PRESETS: PRESETS, applyPreset: applyPreset,
    matching: matching, href: href, suggestName: suggestName,
    onChange: onChange,
    MAX: MAX,
    _sameFilter: sameFilter
  };
})();
