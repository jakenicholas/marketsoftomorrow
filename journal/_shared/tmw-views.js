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
  function readJson() {
    var m = ms();
    if (!m || !m.getMemberJSON) return Promise.resolve(null);
    return m.getMemberJSON()
      .then(function (r) { return (r && r.data && typeof r.data === 'object') ? r.data : {}; })
      .catch(function () { return null; });
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
      var raw = (j && Array.isArray(j[KEY])) ? j[KEY] : [];
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

  window.tmwViews = {
    list: list, save: save, remove: remove, rename: rename,
    matching: matching, href: href, suggestName: suggestName,
    onChange: onChange,
    MAX: MAX,
    _sameFilter: sameFilter
  };
})();
