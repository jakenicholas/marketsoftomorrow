/* ------------------------------------------------------------------
   Markets of Tomorrow — pinned journal dock
   Injects a fixed bottom-center pill on every public journal page:
     [ map ]   [ search input ]   [ home ]
   - map icon  → the interactive map (map.oftmw.com)
   - search    → submits to the journal search page (/search/?q=)
   - home icon → journal home (www.oftmw.com; domain moving soon)
   Self-contained, no dependencies. Include once per page:
     <script src="/_shared/journal-dock.js" defer></script>
-------------------------------------------------------------------*/
(function () {
  'use strict';
  if (window.__tmwDock) return;
  window.__tmwDock = true;

  // Identify a logged-in member to analytics (loads /_shared/member-track.js once).
  // Self-contained there; covers every journal page that includes this dock.
  if (!document.querySelector('script[data-tmw-membertrack]')) {
    var _mt = document.createElement('script');
    _mt.src = '/_shared/member-track.js';
    _mt.defer = true;
    _mt.setAttribute('data-tmw-membertrack', '1');
    document.head.appendChild(_mt);
  }

  // The current surface. "map" = the map.oftmw.com host OR the /map clone path on
  // www.oftmw.com; "atlas" = the /atlas path; everything else is the journal.
  // Single source of truth so the toggle, surface tag, and accents stay in sync.
  function tmwSurface() {
    return (location.hostname === 'map.oftmw.com' || /^\/map(\/|$)/.test(location.pathname)) ? 'map'
      : (/^\/atlas(\/|$)/.test(location.pathname) ? 'atlas' : 'journal');
  }
  window.tmwSurface = tmwSurface;
  // Tag <html> with the surface so per-surface accents (the gold glow on Global
  // for the journal vs Database for the map/atlas) can be scoped in CSS.
  document.documentElement.classList.add('tmw-surf-' + tmwSurface());
  // Market landing pages are part of the development Database — give the Database
  // nav item the same gold active-glow that Global carries on the journal home.
  if (/^\/markets?(\/|$)/.test(location.pathname)) {
    document.documentElement.classList.add('tmw-nav-db');
  }

  // ── Google Analytics (GA4) — same property as the map. Journal traffic on
  //    www.oftmw.com lands under hostName www.oftmw.com so the studio's Journal
  //    analytics tab can scope to it (vs map.oftmw.com + /media).
  (function loadGA() {
    if (window.gtag) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=G-6NPTWCVFCG';
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', 'G-6NPTWCVFCG');
  })();

  // ── Journal click tracking → GA4 ──────────────────────────────────────
  //    Fires distinct `jrn_*` events so the studio's Journal analytics tab can
  //    group them into "Click Categories" (it splits on the first segment after
  //    `jrn_`, mirroring how the media kit groups `media_*`). Distinct event
  //    NAMES are used (not event params) so they're queryable in the GA4 Data
  //    API without registering custom dimensions. Subscribe events are fired by
  //    the forms themselves on success; everything else is delegated here.
  var INTERNAL_HOSTS = { 'www.oftmw.com': 1, 'oftmw.com': 1, 'map.oftmw.com': 1, 'localhost': 1, '127.0.0.1': 1 };
  function tmwTrack(name, params) {
    try { if (window.gtag) window.gtag('event', name, params || {}); } catch (e) {}
  }
  window.tmwTrack = tmwTrack;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href], button');
    if (!a) return;

    // Share buttons (article byline) — match by class/ancestor, may be buttons.
    if (a.classList.contains('share-ico') || a.closest('.share') || a.closest('[data-share]')) {
      var net = a.getAttribute('data-share') || a.getAttribute('aria-label') || a.getAttribute('title') || '';
      return tmwTrack('jrn_share', { network: net.toLowerCase().slice(0, 24) });
    }
    // Partner cards (universal partners section).
    var pcard = a.closest('.tmw-partner-card');
    if (pcard) return tmwTrack('jrn_partner', { partner: (pcard.getAttribute('data-partner-id') || '').slice(0, 40) });
    // Dock map button.
    if (a.closest('.tmw-dock') && /map\.oftmw\.com/.test(a.getAttribute('href') || '')) return tmwTrack('jrn_map');

    if (a.tagName !== 'A') return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) return;

    var host = '', path = '';
    try { var u = new URL(a.href, location.href); host = u.hostname; path = u.pathname; } catch (e) { return; }

    // Opening an article.
    if (/\/post\//.test(path)) return tmwTrack('jrn_post_open');
    // Map / media kit referrals.
    if (host === 'map.oftmw.com') return tmwTrack(/\/media/.test(path) ? 'jrn_mediakit' : 'jrn_map');
    // Outbound (anything off the journal's own hosts).
    if (host && !INTERNAL_HOSTS[host]) return tmwTrack('jrn_outbound', { domain: host.replace(/^www\./, '').slice(0, 40) });
  }, true);

  // ── "Active now" heartbeat → worker ───────────────────────────────────
  //    Every open journal page beacons a session id to the worker on load and
  //    while visible, so the studio's Journal tab can show readers active in
  //    the last 5 minutes (GA4 realtime can't be filtered to this host).
  (function heartbeat() {
    try {
      if (navigator.webdriver) return;
      var sid;
      try { sid = sessionStorage.getItem('tmw-sid'); if (!sid) { sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); sessionStorage.setItem('tmw-sid', sid); } }
      catch (e) { sid = 's' + Math.random().toString(36).slice(2, 10); }
      var PING = 'https://tmw.jake-ab7.workers.dev/journal-ping';
      function ping() {
        try {
          // member-track.js sets window.__tmwMember once it resolves the logged-in
          // member, so the "reading now" feed can show a name instead of anon.
          var mem = window.__tmwMember || null;
          // Path includes location.hash so the Studio's activity feed shows
          // "/post/abc/#search" while the spotlight lightbox is up (vs
          // "/post/abc/" while the user is reading the page). The overlay
          // pushes #search on open and rolls it back on close, then calls
          // __tmwPing() to flush an immediate heartbeat -- no waiting for
          // the 60s interval to reflect the state change.
          var p = JSON.stringify({
            sid: sid, path: location.pathname + location.hash, title: (document.title || '').slice(0, 200),
            member_id: (mem && mem.id) || null, member_name: (mem && mem.name) || null,
          });
          if (navigator.sendBeacon) navigator.sendBeacon(PING, p);
          else fetch(PING, { method: 'POST', body: p, keepalive: true, headers: { 'Content-Type': 'text/plain' } });
        } catch (e) {}
      }
      window.__tmwPing = ping;   // member-track.js calls this the moment it identifies the member
      ping();
      setInterval(function () { if (!document.hidden) ping(); }, 60000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) ping(); });
    } catch (e) {}
  })();

  // ── Destinations (single source of truth; update when domain moves) ──
  var MAP_URL     = 'https://www.oftmw.com/map';
  var HOME_URL    = 'https://www.oftmw.com';
  // The standalone /search/ page was retired; Enter-to-submit now opens the
  // in-page Intelligence overlay. This fallback only fires if the overlay
  // script somehow isn't present — '/' (homepage) reads ?q= and opens it there.
  var SEARCH_PAGE = '/';

  // ── Icons (inline SVG, currentColor) ──
  var ICON_MAP =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z"/><path d="M9 4v13"/><path d="M15 6.5v13"/></svg>';
  // Search icon doubles as the "Ask TMW" teaser: every 8s the search circle
  // morphs (via a hard spin) into the TMW purple hexagon, a pill grows out to
  // reveal "Ask TMW", then it all retracts back to the search icon. Animation
  // pauses on focus-within so the user can type undisturbed.
  var ICON_SEARCH =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" overflow="visible">' +
      '<g class="ds-hex-spinner">' +
        '<polygon class="ds-hex-core" points="12,4 18.93,8 18.93,16 12,20 5.07,16 5.07,8" fill="none" stroke="#A78BFA" stroke-width="1.7" stroke-linejoin="round"/>' +
      '</g>' +
      '<g class="ds-search-icon" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle class="ds-search-circle" cx="11" cy="11" r="6.5" fill="none" stroke-width="1.7"/>' +
        '<line class="ds-search-wand" x1="16" y1="16" x2="20" y2="20" stroke-width="1.7"/>' +
      '</g>' +
    '</svg>';
  var ICON_HOME =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9.5h5.5V14h3v5.5H19V10"/></svg>';
  var IG_URL  = 'https://www.instagram.com/floridaoftomorrow';
  var ICON_IG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor" stroke="none"/></svg>';

  // ── Dock live-search autocomplete ────────────────────────────────────────
  // Mirrors the map's dock pop-up on every NON-map surface (journal, atlas,
  // article, firm pages…). Each result navigates DIRECT:
  //   • project → the map's project page  (MAP_URL/?project=<slug>)
  //   • firm    → the firm's page         (/firm/<slug>/)
  //   • city    → the map's city overview (MAP_URL/?city=<name>)
  // Pressing Enter without picking a result still goes to the full /search/ page.
  var AC_BLDG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 11V3H7v4H3v14h8v-4h2v4h8V11h-4zM7 19H5v-2h2v2zm0-4H5v-2h2v2zm0-4H5V9h2v2zm4 4H9v-2h2v2zm0-4H9V9h2v2zm0-4H9V5h2v2zm4 12h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V9h2v2zm0-4h-2V5h2v2zm4 12h-2v-2h2v2zm0-4h-2v-2h2v2z"/></svg>';
  var AC_PIN  = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>';
  var AC_FIRM = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1 2 6v2h20V6L12 1zM4 10v8H3v3h18v-3h-1v-8h-2v8h-3v-8h-2v8h-2v-8H7v8H6v-8H4z"/></svg>';

  // The TMW spinning-hexagon "intelligence" mark (matches the header lockup).
  // NOTE: a custom wrapper class (.tmw-hexspin) — NOT .tmw-hex-badge, which the
  // dock force-hides on the logo lockup.
  var HEX_SPIN =
    '<span class="tmw-hexspin"><svg viewBox="0 0 100 100">' +
    '<polygon class="hxs-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/>' +
    '<g class="hxs-spin"><polygon class="hxs-core" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/></g>' +
    '</svg></span>';
  // (TEACH_Q + TEACH_ICON removed: the "Ask the Map" teach pop-up is gone --
   // the lightbox overlay now owns the starter-questions UI on every page
   // that opens it. The questions list lives in journal-search-overlay.js's
   // STARTER_CHIPS now, mirrored from the original wording here.)
  // ── TMW Intelligence quota (shared) ─────────────────────────────────────
  // Non-Pro members get 2 free natural-language searches (per device) as a taste;
  // the 3rd shows the "Try TMW Pro free for 2 weeks" paywall. Pro is unlimited and
  // never sees a count. Exposed on window so the /search/ page can count + gate +
  // track against the same state.
  window.tmwIntel = {
    FREE: 2,
    isPro: function () {
      try { return window._isPaidMember === true
        || (window.__tmwMember && window.__tmwMember.plan === 'paid')
        || localStorage.getItem('tmw_auth_state') === 'pro'; } catch (e) { return false; }
    },
    _norm: function (q) { return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim(); },
    _used: function () { try { return parseInt(localStorage.getItem('tmw_intel_used') || '0', 10) || 0; } catch (e) { return 0; } },
    _seen: function () { try { return JSON.parse(localStorage.getItem('tmw_intel_seen') || '[]'); } catch (e) { return []; } },
    used: function () { return this._used(); },
    left: function () { return this.isPro() ? Infinity : Math.max(0, this.FREE - this._used()); },
    seen: function (q) { return this._seen().indexOf(this._norm(q)) >= 0; },
    // Allowed to run? Pro, under the cap, or a query already counted before.
    allowed: function (q) { return this.isPro() || this._used() < this.FREE || this.seen(q); },
    // Count a NEW distinct query (no-op for Pro / repeats). Returns queries left.
    count: function (q) {
      if (this.isPro()) return Infinity;
      var nq = this._norm(q); if (!nq) return this.left();
      var seen = this._seen();
      if (seen.indexOf(nq) < 0) {
        seen.push(nq);
        try { localStorage.setItem('tmw_intel_seen', JSON.stringify(seen.slice(-300))); } catch (e) {}
        try { localStorage.setItem('tmw_intel_used', String(this._used() + 1)); } catch (e) {}
      }
      return this.left();
    },
    _did: function () { try { var d = localStorage.getItem('tmw_did'); if (!d) { d = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('tmw_did', d); } return d; } catch (e) { return 'anon'; } },
    // Log usage to the analytics store (who + what), first-party beacon.
    track: function (q, extra) {
      try {
        var m = window.__tmwMember || null;
        var payload = JSON.stringify({
          member_id: (m && m.id) || ('anon:' + this._did()),
          member_name: (m && m.name) || null,
          plan: this.isPro() ? 'paid' : (m ? 'free' : 'anon'),
          event_name: 'intel_query', path: '/search/',
          referrer: document.referrer || null,
          client_ts: Math.floor(Date.now() / 1000),
          props: Object.assign({ q: String(q || '').slice(0, 200), used: this._used(), pro: this.isPro() }, extra || {}),
        });
        var url = 'https://tmw.jake-ab7.workers.dev/event';
        if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }));
        else fetch(url, { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      } catch (e) {}
    },
    // Log a plain "normal" search (the universal nav search bar) to the same
    // analytics store as intel queries, but as event_name 'search' so the Studio
    // can tell them apart. extra carries { kind, target } — what the searcher
    // jumped to. Doesn't count against the intel quota.
    trackSearch: function (q, extra) {
      try {
        var m = window.__tmwMember || null;
        var payload = JSON.stringify({
          member_id: (m && m.id) || ('anon:' + this._did()),
          member_name: (m && m.name) || null,
          plan: this.isPro() ? 'paid' : (m ? 'free' : 'anon'),
          event_name: 'search', path: location.pathname + location.hash,
          referrer: document.referrer || null,
          client_ts: Math.floor(Date.now() / 1000),
          props: Object.assign({ q: String(q || '').slice(0, 200), search_location: 'nav_bar' }, extra || {}),
        });
        var url = 'https://tmw.jake-ab7.workers.dev/event';
        if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }));
        else fetch(url, { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      } catch (e) {}
    },
  };
  // (tmwIntelPillHTML + tmwAskTeachHTML removed: the teach pop-up now lives
   // inside the lightbox overlay /_shared/journal-search-overlay.js, which
   // renders its own spotlight-style PRO pill + starter rows. window.tmwIntel
   // -- the quota / count / track API above -- is still exposed and shared
   // between the overlay, the /search/ page, and any future search surface.
   // The map's /map/ floating dock checks `typeof window.tmwAskTeachHTML`
   // before calling it, so it gracefully no-ops when this is absent.)

  // The PRO badge (and any [data-tmw-paywall] trigger) opens the native in-page
  // paywall instead of navigating to a /pro page. Delegated + once, so it works
  // for every dynamically-rendered intel pop-up (dock, map drawer, search gate)
  // regardless of when the markup is injected. If the paywall module hasn't
  // loaded yet, the element's href (map upgrade flow) handles it as a fallback.
  if (!window.__tmwPaywallDelegated) {
    window.__tmwPaywallDelegated = true;
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-tmw-paywall]') : null;
      if (!el) return;
      if (typeof window.tmwShowPaywall === 'function') {
        e.preventDefault();
        window.tmwShowPaywall(el.getAttribute('data-tmw-paywall') || 'feature:intelligence');
      }
    }, false);
  }

  var _dockData = null, _dockDataPromise = null;
  function acNorm(s){ return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  // Mirror the map's handleDeepLink() slug EXACTLY (lowercase + strip non-alnum,
  // NO diacritic folding) so ?project=<slug> resolves the same pin there.
  function acSlug(t){ return String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function acEsc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c){ return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function acHi(text, ql){
    var t = String(text == null ? '' : text);
    if (!ql) return acEsc(t);
    var i = acNorm(t).indexOf(ql);
    if (i < 0) return acEsc(t);
    return acEsc(t.slice(0, i)) + '<em>' + acEsc(t.slice(i, i + ql.length)) + '</em>' + acEsc(t.slice(i + ql.length));
  }
  function loadDockData(){
    if (_dockDataPromise) return _dockDataPromise;
    _dockDataPromise = Promise.all([
      fetch('https://www.oftmw.com/map/projects-flat.json', { cache: 'no-cache' }).then(function (r){ return r.ok ? r.json() : []; }).catch(function (){ return []; }),
      fetch('https://www.oftmw.com/map/firms-flat.json',    { cache: 'no-cache' }).then(function (r){ return r.ok ? r.json() : null; }).catch(function (){ return null; })
    ]).then(function (res){
      var p = res[0], f = res[1];
      var projects = Array.isArray(p) ? p : (p.projects || p.items || []);
      var firms = [];
      if (f && (f.architects || f.developers)){
        firms = [].concat(
          (f.architects || []).map(function (x){ return { name: x.name, slug: x.slug, role: 'architect', count: +x.project_count || 0 }; }),
          (f.developers || []).map(function (x){ return { name: x.name, slug: x.slug, role: 'developer', count: +x.project_count || 0 }; })
        );
      }
      var cmap = {};
      projects.forEach(function (pr){ var c = (pr.City || '').trim(); if (c) cmap[c] = (cmap[c] || 0) + 1; });
      var cities = Object.keys(cmap).map(function (c){ return { name: c, count: cmap[c] }; });
      _dockData = { projects: projects, firms: firms, cities: cities };
      return _dockData;
    });
    return _dockDataPromise;
  }
  function dockMatches(q){
    if (!_dockData) return null;
    var ql = acNorm(q).trim();
    if (!ql) return { projects: [], firms: [], cities: [] };
    var toks = ql.split(/[^a-z0-9]+/).filter(Boolean);
    var projects = _dockData.projects.map(function (p){
      var title = acNorm(p.Title), city = acNorm(p.City || ''), s = 0;
      if (title === ql) s += 100; else if (title.indexOf(ql) === 0) s += 50; else if (title.indexOf(ql) >= 0) s += 26;
      toks.forEach(function (t){ if (title.indexOf(t) >= 0) s += 10; if (city.indexOf(t) >= 0) s += 4; });
      return { p: p, s: s };
    }).filter(function (x){ return x.s > 0; }).sort(function (a, b){ return b.s - a.s; }).slice(0, 4).map(function (x){ return x.p; });
    var firms = _dockData.firms.map(function (f){
      var name = acNorm(f.name), s = 0;
      if (name === ql) s += 100; else if (name.indexOf(ql) === 0) s += 50; else if (name.indexOf(ql) >= 0) s += 24;
      toks.forEach(function (t){ if (name.indexOf(t) >= 0) s += 8; });
      if (s > 0) s += Math.min(6, (f.count || 0) * 0.3);
      return { f: f, s: s };
    }).filter(function (x){ return x.s > 0 && x.f.slug; }).sort(function (a, b){ return b.s - a.s; }).slice(0, 3).map(function (x){ return x.f; });
    var cities = _dockData.cities.filter(function (c){
      var nc = acNorm(c.name);
      return nc.indexOf(ql) >= 0 || toks.some(function (t){ return nc.indexOf(t) >= 0; });
    }).sort(function (a, b){ return b.count - a.count; }).slice(0, 3);
    return { projects: projects, firms: firms, cities: cities };
  }
  function setupDockAC(form, input){
    if (typeof tmwSurface === 'function' && tmwSurface() === 'map') return; // map owns its own dock AC
    var ac = document.createElement('div');
    ac.className = 'tmw-dock-ac';
    ac.setAttribute('role', 'listbox');
    ac.setAttribute('aria-label', 'Search suggestions');
    form.appendChild(ac);
    var activeIdx = -1, debounce = null;

    function hide(){ ac.classList.remove('open'); activeIdx = -1; }
    function msg(text){ ac.innerHTML = '<div class="tmw-dock-ac-msg">' + acEsc(text) + '</div>'; ac.classList.add('open'); }
    // Empty box → no-op. The lightbox overlay's focus listener opens
    // immediately when the dock input gets focus, so the legacy teach
    // panel never had a chance to render here anyway. Kept as a stub so
    // existing call sites (focus, short-query early return) don't error.
    function showTeach(){ hide(); }
    function hrefFor(kind, d){
      if (kind === 'project') return MAP_URL + '/?project=' + acSlug(d.Title);
      if (kind === 'firm')    return '/firm/' + encodeURIComponent(d.slug) + '/';
      if (kind === 'city')    return MAP_URL + '/?city=' + encodeURIComponent(d.name);
      return '#';
    }
    function navTo(href){ if (href && href !== '#'){ hide(); window.location.href = href; } }
    // A committed pick from the live results IS a "normal search" — log who +
    // what they typed + what they jumped to (event_name 'search'), so it shows
    // alongside intel queries in the Studio. Plain Enter (no pick) instead lands
    // on /search/, which logs an intel_query, so we never double-count.
    function logSel(el){
      try {
        if (!el || !window.tmwIntel || !window.tmwIntel.trackSearch) return;
        var q = (input.value || '').trim(); if (!q) return;
        window.tmwIntel.trackSearch(q, { kind: el.getAttribute('data-kind') || null, target: el.getAttribute('data-label') || null });
      } catch (e) {}
    }
    function setActive(i){
      var els = ac.querySelectorAll('.tmw-dock-ac-item');
      if (!els.length) return;
      activeIdx = (i + els.length) % els.length;
      for (var k = 0; k < els.length; k++) els[k].classList.toggle('active', k === activeIdx);
      els[activeIdx].scrollIntoView({ block: 'nearest' });
    }
    function render(q){
      var m = dockMatches(q);
      if (!m){ msg('Loading…'); return; }
      var ql = acNorm(q), html = '';
      if (m.projects.length){
        html += '<div class="tmw-dock-ac-sec">Projects</div>';
        m.projects.forEach(function (p){
          html += '<a class="tmw-dock-ac-item" tabindex="-1" data-kind="project" data-label="' + acEsc(p.Title) + '" href="' + acEsc(hrefFor('project', p)) +
            '"><span class="tmw-dock-ac-ico project">' + AC_BLDG + '</span><span class="tmw-dock-ac-txt"><strong>' +
            acHi(p.Title, ql) + '</strong><span>' + acEsc(p.City || '') + '</span></span></a>';
        });
      }
      if (m.firms.length){
        if (html) html += '<div class="tmw-dock-ac-div"></div>';
        html += '<div class="tmw-dock-ac-sec">Firms</div>';
        m.firms.forEach(function (f){
          var sub = (f.role === 'architect' ? 'Architect' : 'Developer') + (f.count ? (' · ' + f.count + ' project' + (f.count !== 1 ? 's' : '')) : '');
          html += '<a class="tmw-dock-ac-item" tabindex="-1" data-kind="firm" data-label="' + acEsc(f.name) + '" href="' + acEsc(hrefFor('firm', f)) +
            '"><span class="tmw-dock-ac-ico firm">' + AC_FIRM + '</span><span class="tmw-dock-ac-txt"><strong>' +
            acHi(f.name, ql) + '</strong><span>' + acEsc(sub) + '</span></span></a>';
        });
      }
      if (m.cities.length){
        if (html) html += '<div class="tmw-dock-ac-div"></div>';
        html += '<div class="tmw-dock-ac-sec">Places</div>';
        m.cities.forEach(function (c){
          html += '<a class="tmw-dock-ac-item" tabindex="-1" data-kind="city" data-label="' + acEsc(c.name) + '" href="' + acEsc(hrefFor('city', c)) +
            '"><span class="tmw-dock-ac-ico place">' + AC_PIN + '</span><span class="tmw-dock-ac-txt"><strong>' +
            acHi(c.name, ql) + '</strong><span>' + c.count + ' project' + (c.count !== 1 ? 's' : '') + '</span></span></a>';
        });
      }
      if (!html){ msg('No matches — press Enter to search'); return; }
      ac.innerHTML = html;
      ac.classList.add('open');
      activeIdx = -1;
      var els = ac.querySelectorAll('.tmw-dock-ac-item');
      for (var i = 0; i < els.length; i++){
        (function (el){
          // mousedown fires before the input's blur, so the nav isn't cancelled.
          el.addEventListener('mousedown', function (e){ e.preventDefault(); logSel(el); navTo(el.getAttribute('href')); });
        })(els[i]);
      }
    }
    function onType(){
      var q = (input.value || '').trim();
      if (q.length < 2){ showTeach(); return; }   // empty/short → teaching panel
      if (!_dockData){
        msg('Loading…');
        loadDockData().then(function (){ if ((input.value || '').trim() === q) render(q); });
        return;
      }
      render(q);
    }
    input.addEventListener('input', function (){ clearTimeout(debounce); debounce = setTimeout(onType, 110); });
    input.addEventListener('focus', function (){ loadDockData(); var v = (input.value || '').trim(); if (v.length >= 2) onType(); else showTeach(); });
    input.addEventListener('blur',  function (){ setTimeout(hide, 160); });
    input.addEventListener('keydown', function (e){
      if (!ac.classList.contains('open')) return;
      if (e.key === 'ArrowDown'){ e.preventDefault(); setActive(activeIdx + 1); }
      else if (e.key === 'ArrowUp'){ e.preventDefault(); setActive(activeIdx - 1); }
      else if (e.key === 'Enter'){
        var els = ac.querySelectorAll('.tmw-dock-ac-item');
        if (activeIdx >= 0 && els[activeIdx]){ e.preventDefault(); logSel(els[activeIdx]); navTo(els[activeIdx].getAttribute('href')); }
        // else: fall through → the form submit navigates to /search/?q=
      }
      else if (e.key === 'Escape'){ hide(); }
    });
    // NOTE: Enter-submit logging lives in the canonical form 'submit' handler in
    // mount() (it preventDefaults + navigates synchronously, so a second submit
    // listener registered here would never run). See trackSearch there.
  }

  // ── Surface toggle (Journal · Map · Atlas) — icon-only variant for the dock ──
  var ST_ICON = {
    journal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.2A1.2 1.2 0 0 1 4.2 4H10a2 2 0 0 1 2 2 2 2 0 0 1 2-2h5.8A1.2 1.2 0 0 1 21 5.2v12.6a1 1 0 0 1-1 1h-6a2 2 0 0 0-2 2 2 2 0 0 0-2-2H4a1 1 0 0 1-1-1z"/><path d="M12 6v14"/></svg>',
    map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"/><path d="M9 3v15M15 6v15"/></svg>',
    atlas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>'
  };
  function buildToggle(active, mini) {
    var segs = [
      ['journal', 'Journal', 'https://www.oftmw.com/'],
      ['map', 'Map', 'https://www.oftmw.com/map'],
      ['atlas', 'Atlas', 'https://www.oftmw.com/atlas']
    ];
    return '<div class="tmw-st' + (mini ? ' mini' : '') + '" role="tablist" aria-label="Switch interface">' +
      segs.map(function (s) {
        var on = s[0] === active;
        return '<a class="tmw-st-seg' + (on ? ' on' : '') + '" data-s="' + s[0] + '" href="' + s[2] + '" title="' + s[1] + '" aria-label="' + s[1] + '"' + (on ? ' aria-current="page"' : '') + '>' +
          ST_ICON[s[0]] + (mini ? '' : '<span class="tmw-st-lbl">' + s[1] + '</span>') + '</a>';
      }).join('') + '</div>';
  }
  // Inject the labelled toggle into every header (nav.main .wrap), right after
  // the logo. Universal — covers the homepage's inline header AND the injected
  // chrome header. Guarded so it's added at most once per header.
  function injectSurfaceToggle() {
    var active = tmwSurface();
    var wraps = document.querySelectorAll('nav.main .wrap');
    for (var i = 0; i < wraps.length; i++) {
      var wrap = wraps[i];
      if (wrap.__tmwSt) continue;
      var logo = wrap.querySelector('.tmw-logo-lockup');
      if (!logo) continue;
      wrap.__tmwSt = true;
      var holder = document.createElement('div');
      holder.innerHTML = buildToggle(active, false);
      var el = holder.firstChild;
      if (logo.nextSibling) wrap.insertBefore(el, logo.nextSibling); else wrap.appendChild(el);
    }
  }

  // ── Styles ──
  var css = [
    '.tmw-dock{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9000;',
    'display:flex;align-items:center;gap:8px;padding:8px;',
    'background:rgba(9,11,9,.82);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);',
    'border:1px solid rgba(255,255,255,.13);border-radius:999px;',
    'box-shadow:0 16px 50px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.25);',
    'font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:calc(100vw - 24px);',
    'opacity:0;transform:translateX(-50%) translateY(10px);transition:opacity .4s ease}',
    /* Only opacity transitions. The dock centers via translateX(-50%), which
       recomputes whenever its width changes as content (search / Ask pill) loads
       in — if `transform` were transitioned, each recompute would animate, making
       the dock visibly slide in from the side on a (cached) load. Fade only. */
    '.tmw-dock.ready{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.tmw-dock-btn{width:46px;height:46px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;',
    'border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);',
    'color:#ECEAE5;transition:background .2s,color .2s,border-color .2s,transform .2s;cursor:pointer;text-decoration:none}',
    '.tmw-dock-btn:hover{background:#1FDF67;color:#070807;border-color:#1FDF67;transform:translateY(-1px)}',
    '.tmw-dock-btn svg{width:20px;height:20px}',
    '.tmw-dock-search{position:relative;display:flex;align-items:center;margin:0}',
    '.tmw-dock-search .ds-ico{position:absolute;left:13px;top:50%;width:20px;height:20px;color:#9AA39C;pointer-events:none;transform:translateY(-50%);z-index:2;overflow:visible}',
    '.tmw-dock-search .ds-ico svg{width:100%;height:100%;overflow:visible}',
    // Ask TMW teaser pill -- a translucent purple capsule that grows out of the icon, briefly reveals "Ask TMW", then retracts.
    '.tmw-dock-search .ds-ask-pill{position:absolute;top:50%;left:8px;height:30px;width:30px;transform:translateY(-50%);border-radius:999px;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.55);box-shadow:0 0 14px rgba(167,139,250,.18);z-index:1;opacity:0;pointer-events:none;animation:ds-pill-grow 8s ease-in-out infinite;will-change:width,opacity}',
    '.tmw-dock-search .ds-ask-text{position:absolute;top:50%;left:40px;transform:translateY(-50%);height:22px;max-width:0;overflow:hidden;white-space:nowrap;color:#fff;font-size:13px;font-weight:600;letter-spacing:.3px;line-height:22px;z-index:2;pointer-events:none;animation:ds-ask-clip 8s ease-in-out infinite;will-change:max-width}',
    // Caterpillar dots ride just to the right of "Ask TMW" inside the purple pill.
    '.tmw-dock-search .ds-ask-dots{position:absolute;top:50%;left:108px;transform:translateY(-50%);display:flex;align-items:center;gap:4px;height:22px;opacity:0;z-index:2;pointer-events:none;animation:ds-dots-show 8s linear infinite}',
    '.tmw-dock-search .ds-dot{width:5px;height:5px;background:rgba(255,255,255,.85);border-radius:50%;box-shadow:0 0 6px rgba(167,139,250,.55);animation:ds-dot-wave 1.1s ease-in-out infinite}',
    '.tmw-dock-search .ds-ask-dots .ds-dot:nth-child(2){animation-delay:.16s}',
    '.tmw-dock-search .ds-ask-dots .ds-dot:nth-child(3){animation-delay:.32s}',
    // Spin/show choreography matches tmw_search_to_hex_ask_final.html, rescaled for 24x24 viewBox.
    '.tmw-dock-search .ds-hex-spinner{transform-origin:50% 50%;animation:ds-hard-spin 8s ease-in-out infinite}',
    '.tmw-dock-search .ds-hex-core{animation:ds-hex-fade 8s linear infinite}',
    '.tmw-dock-search .ds-search-icon{stroke:#9AA39C;animation:ds-icon-color 8s linear infinite}',
    '.tmw-dock-search .ds-search-circle{animation:ds-circle-show 8s linear infinite}',
    '.tmw-dock-search .ds-search-wand{stroke-dasharray:6;stroke-dashoffset:0;animation:ds-wand-show 8s linear infinite}',
    // Pause the animation entirely while the user is interacting with the search.
    '.tmw-dock-search:focus-within .ds-ask-pill,.tmw-dock-search:focus-within .ds-ask-text,.tmw-dock-search:focus-within .ds-ask-dots,.tmw-dock-search:focus-within .ds-dot,.tmw-dock-search:focus-within .ds-hex-spinner,.tmw-dock-search:focus-within .ds-hex-core,.tmw-dock-search:focus-within .ds-search-icon,.tmw-dock-search:focus-within .ds-search-circle,.tmw-dock-search:focus-within .ds-search-wand{animation:none}',
    '.tmw-dock-search:focus-within .ds-ask-dots{opacity:0}',
    '.tmw-dock-search:focus-within input::placeholder{animation:none;color:#9AA39C}',
    '.tmw-dock-search:focus-within .ds-ask-pill{opacity:0}',
    '.tmw-dock-search:focus-within .ds-ask-text{max-width:0}',
    '.tmw-dock-search:focus-within .ds-hex-spinner{transform:rotate(0)}',
    '.tmw-dock-search:focus-within .ds-hex-core{opacity:0}',
    '.tmw-dock-search:focus-within .ds-search-icon{stroke:#9AA39C}',
    '.tmw-dock-search:focus-within .ds-search-circle{opacity:1}',
    '.tmw-dock-search:focus-within .ds-search-wand{opacity:1;stroke-dashoffset:0}',
    '@keyframes ds-pill-grow{0%,40%{width:30px;opacity:0}47.5%{width:30px;opacity:1}52.5%{width:142px;opacity:1}82.5%{width:142px;opacity:1}87.5%{width:30px;opacity:1}90%{width:30px;opacity:0}100%{width:30px;opacity:0}}',
    '@keyframes ds-ask-clip{0%,47.5%{max-width:0}52.5%{max-width:78px}82.5%{max-width:78px}87.5%{max-width:0}100%{max-width:0}}',
    '@keyframes ds-hard-spin{0%{transform:rotate(1440deg)}25%{transform:rotate(1440deg)}42.5%{transform:rotate(720deg)}87.5%{transform:rotate(720deg)}100%{transform:rotate(1440deg)}}',
    '@keyframes ds-hex-fade{0%,33%{opacity:0}40%{opacity:1}87.5%{opacity:1}94%{opacity:0}100%{opacity:0}}',
    '@keyframes ds-icon-color{0%,18%{stroke:#9AA39C}24%{stroke:#A78BFA}96%{stroke:#A78BFA}100%{stroke:#9AA39C}}',
    '@keyframes ds-circle-show{0%,33%{opacity:1}40%{opacity:0}87.5%{opacity:0}94%{opacity:1}100%{opacity:1}}',
    '@keyframes ds-wand-show{0%{opacity:1;stroke-dashoffset:0}25%{opacity:1;stroke-dashoffset:0}30%{opacity:1;stroke-dashoffset:6}31%{opacity:0;stroke-dashoffset:6}93%{opacity:0;stroke-dashoffset:6}94%{opacity:1;stroke-dashoffset:6}99%{opacity:1;stroke-dashoffset:0}100%{opacity:1;stroke-dashoffset:0}}',
    '@keyframes ds-dots-show{0%,55%{opacity:0}62%{opacity:1}82%{opacity:1}87%{opacity:0}100%{opacity:0}}',
    '@keyframes ds-dot-wave{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-4px);opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.tmw-dock-search .ds-hex-spinner,.tmw-dock-search .ds-hex-core,.tmw-dock-search .ds-search-icon,.tmw-dock-search .ds-search-circle,.tmw-dock-search .ds-search-wand,.tmw-dock-search .ds-ask-pill,.tmw-dock-search .ds-ask-text,.tmw-dock-search .ds-ask-dots,.tmw-dock-search .ds-dot,.tmw-dock-search input::placeholder{animation:none}',
    '.tmw-dock-search .ds-hex-core{opacity:0}',
    '.tmw-dock-search .ds-search-circle,.tmw-dock-search .ds-search-wand{opacity:1;stroke:#9AA39C}',
    '.tmw-dock-search .ds-ask-pill{opacity:0}.tmw-dock-search .ds-ask-text{max-width:0}',
    '.tmw-dock-search .ds-ask-dots{opacity:0}.tmw-dock-search .ds-ph{animation:none;opacity:1}}',
    '.tmw-dock-search input{height:46px;width:min(46vw,300px);padding:0 18px 0 42px;',
    'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:999px;',
    'color:#fff;font-size:14px;font-family:inherit;outline:none;transition:border-color .2s,background .2s,width .25s ease}',
    // Purple clear (×) glyph in place of the browser default
    '.tmw-dock-search input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;height:14px;width:14px;cursor:pointer;background:url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%3E%3Cpath%20d=%27M6%206l12%2012M18%206L6%2018%27%20stroke=%27%23B9A6FF%27%20stroke-width=%272.4%27%20stroke-linecap=%27round%27/%3E%3C/svg%3E) center/contain no-repeat}',
    // Placeholder fades to transparent while the Ask TMW pill is expanded so the
    // existing "Search projects, firms, cities..." text doesn't bleed through the
    // purple capsule. Reverts to normal gray for the rest of the loop and any
    // time the user focuses the input.
    '.tmw-dock-search input::placeholder{color:transparent}',
    // Placeholder text now lives in this overlay span, on the SAME 8s timeline as
    // the Ask TMW pulse — so the two can never drift out of sync (the old native
    // placeholder ran its own animation that desynced on focus/typing/pause).
    '.tmw-dock-search .ds-ph{position:absolute;top:50%;left:42px;right:16px;transform:translateY(-50%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#9AA39C;font-size:14px;line-height:1;z-index:1;pointer-events:none;animation:ds-ph-fade 8s linear infinite}',
    '@keyframes ds-ph-fade{0%,42%{opacity:1}46%{opacity:0}88%{opacity:0}92%{opacity:1}100%{opacity:1}}',
    '.tmw-dock-search .dph-sm{display:none}',
    // On focus (empty field) freeze the placeholder in view like a normal placeholder…
    '.tmw-dock-search:focus-within .ds-ph{animation:none;opacity:1}',
    // …and once the field has text, drop the whole animated overlay (icon stays).
    '.tmw-dock-search.ds-filled .ds-ph,.tmw-dock-search.ds-filled .ds-ask-pill,.tmw-dock-search.ds-filled .ds-ask-text,.tmw-dock-search.ds-filled .ds-ask-dots{opacity:0;animation:none}',
    '.tmw-dock-search input:focus{border-color:rgba(31,223,103,.55);background:rgba(255,255,255,.08);width:min(52vw,344px)}',
    // ── Live autocomplete pop-up (opens ABOVE the bottom dock) ──
    // position:FIXED + viewport-centered (not absolute-to-the-form, which sits
    // off-centre once the mobile toggle pushes the search field to one side).
    '.tmw-dock-ac{position:fixed;left:50%;transform:translateX(-50%);bottom:92px;width:min(440px,92vw);max-height:46vh;overflow-y:auto;background:rgba(13,13,15,.96);-webkit-backdrop-filter:blur(22px) saturate(1.3);backdrop-filter:blur(22px) saturate(1.3);border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.6);padding:6px;z-index:9001;opacity:0;pointer-events:none;transform-origin:bottom center;transition:opacity .14s ease}',
    '.tmw-dock-ac.open{opacity:1;pointer-events:auto}',
    '.tmw-dock-ac-sec{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.32);padding:8px 12px 4px}',
    '.tmw-dock-ac-div{height:1px;background:rgba(255,255,255,.06);margin:4px 0}',
    '.tmw-dock-ac-item{display:flex;align-items:center;gap:10px;padding:9px 11px;cursor:pointer;border-radius:10px;transition:background .15s ease;text-decoration:none}',
    '.tmw-dock-ac-item:hover,.tmw-dock-ac-item.active{background:rgba(255,255,255,.08)}',
    '.tmw-dock-ac-ico{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.tmw-dock-ac-ico svg{width:15px;height:15px}',
    '.tmw-dock-ac-ico.project{background:rgba(255,211,0,.12);color:#FFD300}',
    '.tmw-dock-ac-ico.firm{background:rgba(167,139,250,.15);color:#C2A8FF}',
    '.tmw-dock-ac-ico.place{background:rgba(31,223,103,.12);color:#1FDF67}',
    '.tmw-dock-ac-txt{flex:1;min-width:0}',
    '.tmw-dock-ac-txt strong{display:block;font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tmw-dock-ac-txt strong em{font-style:normal;color:#1FDF67}',
    '.tmw-dock-ac-txt span{display:block;font-size:11px;color:rgba(255,255,255,.42);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tmw-dock-ac-msg{padding:15px 16px;text-align:center;color:rgba(255,255,255,.5);font-size:13px}',
    '@media(max-width:560px){.tmw-dock-ac{width:92vw;bottom:78px}}',
    // ".tmw-dock-teach / .tdt-* / .tmw-hexspin / .hxs-* CSS removed (Phase 2C+).
    //  The teach pop-up that used to render inside the dock AC is gone; the
    //  lightbox overlay owns the spotlight starter view now. The hxs-* spin
    //  keyframes have a private namespaced copy inside journal-search-overlay.js
    //  (as .tmw-ov-hxs-*) so the overlay's spinning hexagon still works
    //  without depending on these rules."
    // Map · Atlas · Journal toggle inside the dock (icon-only). Shown on mobile;
    // hidden >=981px because the header already carries the labelled toggle there.
    '.tmw-dock .tmw-st{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:999px;padding:3px}',
    '.tmw-dock .tmw-st-seg{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:999px;color:#ECEAE5;text-decoration:none;transition:background .2s,color .2s}',
    '.tmw-dock .tmw-st-seg svg{width:19px;height:19px}',
    '.tmw-dock .tmw-st-seg:not(.on):hover{background:rgba(255,255,255,.08);color:#fff}',
    '.tmw-dock .tmw-st-seg.on{background:#3a3d42;color:#fff}',
    '@media(min-width:981px){.tmw-dock .tmw-st{display:none}}',
    '@media(max-width:560px){.tmw-dock .tmw-st-seg{width:36px;height:36px}.tmw-dock .tmw-st-seg svg{width:18px;height:18px}}',
    // Labelled toggle injected into the header (nav.main) right after the logo.
    // Active segment expands to show its label. Desktop only — mobile uses the dock.
    'nav.main .tmw-st{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:3px}',
    'nav.main .tmw-st .tmw-st-seg{display:inline-flex;align-items:center;height:34px;padding:0 9px;border-radius:999px;color:#C2C9C3;text-decoration:none;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;transition:background .22s ease,color .22s ease,padding .22s ease;white-space:nowrap}',
    'nav.main .tmw-st .tmw-st-seg svg{width:17px;height:17px;flex:0 0 auto}',
    'nav.main .tmw-st .tmw-st-lbl{display:inline-block;max-width:0;overflow:hidden;opacity:0;transition:max-width .22s ease,opacity .18s ease,margin .22s ease}',
    'nav.main .tmw-st .tmw-st-seg:hover{color:#fff}',
    'nav.main .tmw-st .tmw-st-seg.on{background:#3a3d42;color:#fff}',
    'nav.main .tmw-st .tmw-st-seg.on .tmw-st-lbl{max-width:90px;opacity:1;margin-left:7px}',
    // Lock the nav menu dead-centre of the header. It's absolutely positioned
    // (anchored like the logo) so it never shifts as the toggle injects on the
    // left or the login/Join state hydrates on the right — both used to jitter
    // it. Desktop only; mobile collapses into the burger drawer.
    '@media(min-width:981px){nav.main .wrap{position:relative}',
    'nav.main .nav-links{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); margin:0}',
    // The nav-links are out of flow now, so keep the logo+toggle pinned left and
    // the login pinned right: the toggle eats the free space to its right.
    'nav.main .tmw-st{margin-right:auto}}',
    '@media(min-width:981px){.nav-cta.tmw-ig{display:none !important}}',
    '@media(max-width:980px){nav.main .tmw-st{display:none}}',
    '@media(max-width:560px){.tmw-dock{bottom:14px;gap:6px;padding:6px}.tmw-dock-btn{width:42px;height:42px}',
    '.tmw-dock-btn svg{width:18px;height:18px}.tmw-dock-search input{width:46vw;height:42px;font-size:13px}',
    // Mobile: keep the full Ask-TMW animation (the placeholder + reveal share one
    // timeline now, so no desync) but use the SHORT placeholder text so it can't
    // overflow the narrow box; the widened ds-ph gap keeps it clear of "Ask TMW".
    '.tmw-dock-search .ds-ph{font-size:13px}',
    '.tmw-dock-search .dph-lg{display:none}.tmw-dock-search .dph-sm{display:inline}',
    '.tmw-dock-search input:focus{width:50vw}}',
    // Dock clearance lives on the FOOTER (not the body) so the footer's own
    // background fills the reserved strip — no black gap below the footer.
    'footer{padding-bottom:120px}',
    '.tmw-chrome-foot{padding-bottom:120px}',
    // ── Mobile hardening: no horizontal scroll, ever. overflow-x:clip clips
    //    runaway/fixed/absolute elements WITHOUT forcing overflow-y:auto (so the
    //    sticky header keeps working — which plain overflow:hidden would break).
    'html{overflow-x:clip}',
    'body{overflow-x:clip; max-width:100%}',
    // Disable double-tap-to-zoom (and the 300ms tap delay) site-wide.
    'html{touch-action:manipulation}',
    // ── Mobile header: burger LEFT, logo CENTERED + smaller, Open Map RIGHT.
    //    Targets nav.main so it applies to every journal header (inline pages +
    //    the shared chrome). Higher specificity than the pages' own mobile rules.
    '@media(max-width:980px){',
    // Lift the header above the pulse ticker so the open dropdown covers it
    // (otherwise the first item sits behind the ticker). Pad the top by the
    // safe-area inset so the logo/burger/Instagram clear the phone notch when
    // the header is stuck to the top of the viewport (viewport-fit=cover).
    'nav.main{position:relative; z-index:40; padding-top:env(safe-area-inset-top,0px)}',
    '.sticky-stack,.tmw-chrome-head{top:0}',
    'nav.main .wrap{position:relative; gap:10px}',
    'nav.main .nav-burger{display:flex; order:0; background:none; border:0; cursor:pointer; z-index:2}',
    'nav.main .nav-cta{order:1; margin-left:auto; padding:7px 8px 7px 12px; z-index:2}',
    'nav.main .tmw-logo-lockup{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); margin:0; z-index:1}',
    'nav.main .tmw-wordmark{width:74px}',
    'nav.main .tmw-hex-badge{width:16px; height:16px}',
    'nav.main .nav-links{order:5; position:absolute; top:100%; left:0; right:0; display:none; flex-direction:column; gap:0; align-items:stretch; width:auto; margin:0; background:rgba(7,8,7,.98); -webkit-backdrop-filter:blur(16px) saturate(1.4); backdrop-filter:blur(16px) saturate(1.4); border-bottom:1px solid var(--hair); padding:10px 22px 24px; height:calc(100dvh - 56px); max-height:calc(100dvh - 56px); overflow-y:auto; -webkit-overflow-scrolling:touch}',
    'nav.main .nav-links.open{display:flex}',
    'nav.main .nav-links > a{padding:14px 2px; border-bottom:1px solid var(--hair); font-size:12.5px}',
    'nav.main .nav-links > a:last-child{border-bottom:0}',
    'nav.main .nav-links a.active::after{display:none}',
    'nav.main .nav-burger.is-open span:nth-child(1){transform:translateY(5.5px) rotate(45deg)}',
    'nav.main .nav-burger.is-open span:nth-child(2){opacity:0}',
    'nav.main .nav-burger.is-open span:nth-child(3){transform:translateY(-5.5px) rotate(-45deg)}',
    '}',

    // ── Remove the animated "intelligence" hex badge from every logo (header +
    //    footer). Hidden, so the lockup re-centers on its own.
    '.tmw-hex-badge{display:none !important}',
    // Smaller wordmark in the header on desktop (mobile 74px is set above).
    'nav.main .tmw-wordmark{width:80px}',

    // ── Header stacking: nav.main has a backdrop-filter, so it forms its own
    //    stacking context. Static (the default) it would paint BELOW the
    //    positioned pulse ticker, hiding the open Focus Markets dropdown behind
    //    it. Promote nav.main above the ticker so the dropdown sits on top.
    'nav.main{position:relative; z-index:50}',

    // ── Header CTA swapped from "Open Map" to an Instagram icon button.
    //    No circle: transparent bg + no border, just the glyph.
    '.nav-cta.tmw-ig{padding:0; width:42px; height:42px; min-width:42px; justify-content:center; gap:0; overflow:visible; background:transparent !important; border:0 !important; box-shadow:none !important}',
    '.nav-cta.tmw-ig::before{display:none !important}',
    '.nav-cta.tmw-ig:hover{background:transparent !important; border-color:transparent !important; transform:none !important}',
    '.nav-cta.tmw-ig svg{width:22px; height:22px; color:var(--cream); transition:color .2s}',
    '.nav-cta.tmw-ig:hover svg{color:#fff}',
    '@media(max-width:980px){.nav-cta.tmw-ig{display:none !important}}',

    // ── Top featured ad banner: the WHOLE section scales proportionally
    //    with viewport width so the ad creative is never cropped (was
    //    height:340px which capped on wide screens and let object-fit:
    //    cover shave the top/bottom). Now matches the page-CSS aspect
    //    ratio of 1886/383 -- the ad creatives' native ratio.
    '.banner-ad{max-height:720px; width:100%; max-width:100vw}',
    '.featured-carousel{aspect-ratio: 1886 / 383; height:auto; width:100%}',
    '.fc-track,.fc-slide{width:100%; left:0; right:0}',
    '.fc-slide video,.fc-slide img{width:100%; height:100%; object-fit:cover; object-position:center}',
    '.fc-sponsor{display:none !important}',
    // Remove the slide-position dots (ticker) everywhere.
    '.fc-dots, .fc-dot{display:none !important}',
    // Arrows: no circle/background — a bare white chevron that appears on banner
    // hover, turning into a gold glow on the arrow itself.
    '.fc-arrow{background:transparent !important; border:0 !important; box-shadow:none !important; -webkit-backdrop-filter:none !important; backdrop-filter:none !important; border-radius:0 !important; color:#fff !important; width:46px; height:46px}',
    '.fc-arrow svg{width:22px; height:22px; filter:drop-shadow(0 1px 4px rgba(0,0,0,.7))}',
    '.fc-arrow:hover{background:transparent !important; border:0 !important; color:var(--gold,#e6c574) !important; transform:translateY(-50%) !important}',
    '.fc-arrow:hover svg{filter:drop-shadow(0 0 9px rgba(230,197,116,.95)) drop-shadow(0 0 3px rgba(230,197,116,.7))}',
    // Mobile header: slightly smaller hamburger + close (X). Gap stays 4px so
    //    the is-open X transforms below (±5.5px) stay aligned.
    'nav.main .nav-burger, .tmw-chrome-head .nav-burger{width:24px; gap:4px}',
    'nav.main .nav-burger span, .tmw-chrome-head .nav-burger span{width:18px}',

    // ── Universal right-side cluster (Instagram + profile/Join). On mobile the
    //    hamburger moves to the LEFT; the logo gets an auto right-margin so the
    //    cluster is pinned to the RIGHT edge. Same in inline + chrome headers.
    '@media(max-width:980px){'
      + 'nav.main .wrap, .tmw-chrome-head nav.main .wrap{position:relative}'
      + 'nav.main .nav-burger, .tmw-chrome-head .nav-burger{order:-2}'
      + 'nav.main .tmw-logo-lockup, .tmw-chrome-head .tmw-logo-lockup{order:-1; margin-right:auto}'
      + 'nav.main .tmw-auth, .tmw-chrome-head .tmw-auth{order:0}'
    + '}',

    // ── Featured-hero vertical tabs — modernized, applied on every page.
    '.story-card .sc-tabs{padding:5px; gap:4px; background:rgba(9,11,9,.74); border:1px solid rgba(255,255,255,.12); box-shadow:0 22px 50px -18px rgba(0,0,0,.78), inset 0 1px 0 rgba(255,255,255,.06)}',
    '.story-card .sc-tab{padding:11px 22px; font-size:11.5px; letter-spacing:.16em; color:var(--mute-2); border-radius:999px; transition:background .2s, color .2s, box-shadow .2s, transform .15s}',
    '.story-card .sc-tab:hover{background:rgba(255,255,255,.06); color:#fff; transform:translateY(-1px)}',
    '.story-card .sc-tab.on{background:#fff; color:var(--ink); font-weight:700; box-shadow:0 6px 16px -6px rgba(255,255,255,.5)}',
    '@media(max-width:560px){.story-card .sc-tab{padding:9px 15px; font-size:10.5px; letter-spacing:.12em}}',

    // ── Rank-page section tabs: no counts, single row, cleaner sort control.
    '.tab-btn .tb-count{display:none}',
    '.tabs{flex-wrap:nowrap}',
    '.tabs .tab-btn{white-space:nowrap}',
    '.tabs-bar .sort{background-color:transparent; border:0; padding-left:2px}',
    '.tabs-bar .sort:focus{border:0}',
    '@media(max-width:560px){.tabs .tab-btn{padding:8px 12px; font-size:10px; letter-spacing:.07em}.tabs{padding:4px}}',

    // ── Header nav: drop the green underline; gold glow text on hover/active.
    '.nav-links a.active::after, .tmw-chrome-head .nav-links a.active::after, nav.main .nav-links a.active::after{display:none !important}',
    '.nav-links a:hover, .nav-links a.active, .tmw-chrome-head .nav-links a:hover, .tmw-chrome-head .nav-links a.active{color:var(--gold-soft) !important; text-shadow:0 0 14px rgba(230,197,116,.55), 0 0 3px rgba(230,197,116,.35)}',
    // Per-surface gold accent: Global glows on the journal home; Database carries
    // the same glow on the map + atlas (their primary context) — but NOT on the
    // journal, where Database is just one nav item among many.
    'html.tmw-surf-journal nav.main .nav-links a.active{color:var(--gold-soft) !important; text-shadow:0 0 16px rgba(230,197,116,.7), 0 0 5px rgba(230,197,116,.42)}',
    'html.tmw-surf-map .tmw-fm-database .tmw-fm-trigger, html.tmw-surf-atlas .tmw-fm-database .tmw-fm-trigger, html.tmw-nav-db .tmw-fm-database .tmw-fm-trigger{color:#f0d68a !important; text-shadow:0 0 16px rgba(230,197,116,.7), 0 0 5px rgba(230,197,116,.42)}',
    // Pro members never need the in-dropdown Go Pro CTA.
    'html.tmw-paid .tmw-mm-cta[data-paywall="go-pro"]{display:none !important}',

    // ── Rank-page CTA (Book a table / Website): subtle gold-glow text, no fill.
    '.btn-cta{background:transparent !important; color:var(--gold-soft) !important; padding:8px 0 !important; border-radius:0 !important; text-shadow:0 0 14px rgba(230,197,116,.5), 0 0 3px rgba(230,197,116,.32)}',
    '.btn-cta:hover{background:transparent !important; transform:none !important; gap:11px}',
    '.btn-cta svg{color:var(--gold-soft)}',
    // Iconic-list "About" → Request Visit (gold text + gold arrow, opens mail client).
    '.about-cta{display:inline-flex; align-items:center; gap:9px; margin-top:34px; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:12px; letter-spacing:.18em; text-transform:uppercase; font-weight:700; color:var(--gold-soft); text-shadow:0 0 14px rgba(230,197,116,.5), 0 0 3px rgba(230,197,116,.32); text-decoration:none; transition:gap .2s ease, color .2s ease}',
    '.about-cta:hover{gap:14px; color:var(--gold)}',
    '.about-cta svg{width:15px; height:15px; stroke:currentColor; flex:0 0 auto}',
    // Tablet + mobile: match the ad's native 1886x382 (~4.94:1) aspect so the
    // creative fills the full width edge-to-edge — no side bars, no crop.
    '@media(max-width:980px){.banner-ad{max-height:240px}.featured-carousel{height:auto; aspect-ratio:1886 / 382}.fc-slide video,.fc-slide img{object-fit:cover}}',
    '@media(max-width:560px){.banner-ad{max-height:130px}}',

    // ── Hide the public in-page "Edit" toggle on the list/ranking pages.
    '.edit-toggle{display:none !important}',

    // ── Dock search: purple "intelligence" glow chasing around the border.
    '@property --tmw-ang{syntax:"<angle>"; inherits:false; initial-value:0deg}',
    '@keyframes tmwChase{to{--tmw-ang:360deg}}',
    '.tmw-dock-search{border-radius:999px}',
    '.tmw-dock-search input{position:relative; z-index:1}',
    '.tmw-dock-search .ds-ico{z-index:2}',
    // No animated filter:drop-shadow here — repainting a filter every frame on
    // this backdrop-filtered fixed dock caused whole-page GPU jitter. The conic
    // chase alone (rotating --tmw-ang) keeps the effect, cheaply.
    '.tmw-dock-search::before{content:""; position:absolute; inset:-1.5px; border-radius:999px; padding:1.5px; z-index:0; pointer-events:none; background:conic-gradient(from var(--tmw-ang,0deg), rgba(167,139,250,0) 0deg, rgba(167,139,250,0) 205deg, #A78BFA 300deg, #E9DEFF 338deg, rgba(167,139,250,0) 360deg); -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; animation:tmwChase 3s linear infinite}',
    '@media(prefers-reduced-motion:reduce){.tmw-dock-search::before{animation:none}}',

    // ── Focus Markets dropdown (header): replaces the per-region links with a
    //    single mega-menu of 5 rounded market tiles. 3-col desktop / 2-col mobile.
    '.tmw-fm{position:relative; display:inline-flex; align-items:center}',
    '.tmw-fm-trigger{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--mute-2,#C2C9C3); background:none; border:0; cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:0; line-height:1; transition:color .2s}',
    '.tmw-fm-trigger:hover, .tmw-fm.open .tmw-fm-trigger{color:var(--gold-soft,#f0d68a); text-shadow:0 0 14px rgba(230,197,116,.55), 0 0 3px rgba(230,197,116,.35)}',
    '.tmw-fm-chev{width:10px; height:10px; transition:transform .22s ease}',
    '.tmw-fm.open .tmw-fm-chev{transform:rotate(180deg)}',
    // Desktop: full-viewport-width mega-menu, 5 market tiles in one row, pinned
    // to the bottom of the sticky header (top set by JS via --tmw-fm-top).
    '.tmw-fm-trigger{position:relative}',
    '.tmw-fm-trigger::after{content:""; position:absolute; top:100%; left:-16px; right:-16px; height:24px}', // hover bridge to the panel
    '.tmw-fm-panel{position:absolute; top:calc(100% + 18px); left:0; width:100vw; display:grid; grid-template-columns:repeat(5,1fr); gap:14px; padding:22px clamp(24px,4vw,72px) 28px; background:rgba(9,11,9,.98); -webkit-backdrop-filter:blur(20px) saturate(1.4); backdrop-filter:blur(20px) saturate(1.4); border:0; border-bottom:1px solid rgba(255,255,255,.10); border-radius:0 0 18px 18px; box-shadow:0 30px 64px rgba(0,0,0,.55); opacity:0; visibility:hidden; pointer-events:none; transform:translateY(-10px); transition:opacity .2s ease, transform .22s cubic-bezier(.22,1,.36,1); z-index:70}',
    '.tmw-fm.open .tmw-fm-panel, .tmw-fm:hover .tmw-fm-panel{opacity:1; visibility:visible; pointer-events:auto; transform:translateY(0)}',
    '.tmw-fm-tile{position:relative; display:block; aspect-ratio:16/9; border-radius:13px; overflow:hidden; background:#141714 center/cover no-repeat; text-decoration:none; box-shadow:inset 0 0 0 1px rgba(255,255,255,.07); transition:box-shadow .2s, transform .2s}',
    '.tmw-fm-tile::after{content:""; position:absolute; inset:0; background:linear-gradient(180deg, rgba(7,8,7,0) 30%, rgba(7,8,7,.84) 100%); transition:background .2s ease}',
    '.tmw-fm-tile:hover{transform:translateY(-2px); box-shadow:inset 0 0 0 1px rgba(230,197,116,.5), 0 10px 26px rgba(0,0,0,.4)}',
    '.tmw-fm-tile:hover::after{background:linear-gradient(180deg, rgba(31,223,103,.10) 0%, rgba(7,8,7,.86) 100%)}',
    '.tmw-fm-name{position:absolute; left:14px; bottom:11px; z-index:1; font-family:var(--serif,"Fraunces",Georgia,serif); font-weight:600; font-size:17px; letter-spacing:-.01em; color:#fff; text-shadow:0 2px 12px rgba(0,0,0,.65)}',
    // mobile: Focus Markets is a full-width accordion inside the burger drawer —
    // one column of thin rows. Gradient is a full L→R wash so no bright corners.
    '@media(max-width:980px){.tmw-fm{display:block; width:100%}',
    '.tmw-fm-trigger{width:100%; justify-content:space-between; padding:14px 2px; border-bottom:1px solid rgba(255,255,255,.08); font-size:12.5px}',
    '.tmw-fm-trigger::after{display:none}',
    '.tmw-fm-panel{position:static; top:auto; transform:none; width:auto; grid-template-columns:1fr; gap:8px; padding:10px 0 4px; background:transparent; -webkit-backdrop-filter:none; backdrop-filter:none; border:0; border-radius:0; box-shadow:none; opacity:1; pointer-events:auto; display:none; visibility:visible}',
    '.tmw-fm.open .tmw-fm-panel, .tmw-fm:hover .tmw-fm-panel{display:none; transform:none; left:auto}',
    '.tmw-fm.open .tmw-fm-panel{display:grid; transform:none; left:auto}',
    '.tmw-fm-tile{aspect-ratio:auto; height:58px; border-radius:12px}',
    '.tmw-fm-tile::after{background:linear-gradient(90deg, rgba(7,8,7,.92) 0%, rgba(7,8,7,.55) 52%, rgba(7,8,7,.66) 100%)}',
    '.tmw-fm-tile:hover::after{background:linear-gradient(90deg, rgba(31,223,103,.14) 0%, rgba(7,8,7,.6) 60%, rgba(7,8,7,.66) 100%)}',
    '.tmw-fm-name{font-size:15px; left:16px; bottom:auto; top:50%; transform:translateY(-50%)}}'
  ].join('');

  function mount() {
    // Lock the viewport: prevents iOS input-focus zoom (maximum-scale=1) and
    // pinch/double-tap zoom (user-scalable=no). viewport-fit=cover for notches.
    var vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement('meta'); vp.setAttribute('name', 'viewport'); document.head.appendChild(vp); }
    vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');

    // Favicon — set on every journal page.
    if (!document.querySelector('link[rel="icon"]')) {
      var fav = document.createElement('link');
      fav.rel = 'icon';
      fav.type = 'image/png';
      fav.href = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png';
      document.head.appendChild(fav);
    }

    var style = document.createElement('style');
    style.setAttribute('data-tmw-dock', '');
    style.textContent = css;
    document.head.appendChild(style);

    var dock = document.createElement('div');
    dock.className = 'tmw-dock';
    dock.setAttribute('role', 'navigation');
    dock.setAttribute('aria-label', 'Journal');
    // Map · Atlas · Journal toggle on the left, then the search field. (The old
    // standalone map + home buttons are gone — Map and Journal live in the toggle.)
    var stActive = tmwSurface();
    dock.innerHTML =
      buildToggle(stActive, true) +
      '<form class="tmw-dock-search" role="search" action="' + SEARCH_PAGE + '" method="get">' +
        '<span class="ds-ask-pill" aria-hidden="true"></span>' +
        '<span class="ds-ico">' + ICON_SEARCH + '</span>' +
        '<span class="ds-ask-text" aria-hidden="true">Ask TMW</span>' +
        '<span class="ds-ask-dots" aria-hidden="true">' +
          '<span class="ds-dot"></span><span class="ds-dot"></span><span class="ds-dot"></span>' +
        '</span>' +
        // The placeholder text now lives in the overlay (same timeline as the Ask
        // TMW pulse) so the two can never drift out of sync. Hidden when the field
        // has text (.ds-filled, toggled in JS) or on focus.
        '<span class="ds-ph" aria-hidden="true"><span class="dph-lg">Search projects, firms, places, brands, and more…</span><span class="dph-sm">Search projects, firms, places…</span></span>' +
        '<input name="q" type="search" autocomplete="off" placeholder="" aria-label="Search projects, firms, places, brands, and more">' +
      '</form>';

    // Submit → navigate to the search page with ?q=
    var form  = dock.querySelector('form');
    var input = dock.querySelector('input');
    // Toggle the animated overlay (placeholder + Ask TMW) off while the field has
    // text — the native placeholder used to do this for free; now JS does it.
    var syncFilled = function(){ form.classList.toggle('ds-filled', !!input.value); };
    input.addEventListener('input', syncFilled); syncFilled();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = (input.value || '').trim();
      // Log the typed text as a "normal search" BEFORE navigating — this handler
      // synchronously sets location.href, so anything after the assignment (or in
      // a separate later-registered listener) may never run.
      try { if (q.length >= 2 && window.tmwIntel && window.tmwIntel.trackSearch) window.tmwIntel.trackSearch(q, {}); } catch (_) {}
      // On the /map/ surface the dock IS the spatial search — it drives the map's
      // own floating results + Enter handling. Never hand off to the Intelligence
      // overlay there (the map wires its own submit handler, which preventDefaults).
      if (typeof tmwSurface === 'function' && tmwSurface() === 'map') return;
      // Prefer the in-page Intelligence overlay (loaded alongside this dock);
      // only navigate as a last resort if it's unavailable.
      if (window.tmwOverlay && window.tmwOverlay.open) { window.tmwOverlay.open(q); }
      else { window.location.href = SEARCH_PAGE + (q ? '?q=' + encodeURIComponent(q) : ''); }
    });

    // Live result pop-up (projects/firms/cities). Skipped on the map surface,
    // which wires its own dock autocomplete onto the same input.
    setupDockAC(form, input);

    document.body.appendChild(dock);
    requestAnimationFrame(function () { dock.classList.add('ready'); });

    // Transform every header into the universal menu (consolidate the flat nav,
    // inject the surface toggle, swap Open Map -> Instagram) THEN reveal it, in
    // one pass, so the raw nav never flashes. The chrome header can mount a tick
    // later than the dock, so re-run a couple of times (every step is guarded).
    finishHeaders();
    requestAnimationFrame(finishHeaders);
    setTimeout(finishHeaders, 300);
    setTimeout(finishHeaders, 700);
    wireBurgers();
    setupFmPanel();
    loadAuth();
    linkifyArticle();
    loadProjectCards();
    loadSearchOverlay();
  }

  // Lazy-load the universal search & Intelligence overlay. Self-contained
  // module that mounts a bottom-pinned purple search lightbox available
  // on every journal page via "/" hotkey or [data-tmw-overlay] elements.
  // Deliberately does NOT touch the dock's existing search input/AC —
  // both surfaces coexist (dock = quick autocomplete + submit, overlay =
  // immersive search + inline TMW Intelligence via /smart-answer).
  //
  // Two scripts load together:
  //   - journal-search-core.js: pure-functions module exposing TmwSearchCore
  //     (isQuestion, askIntelligence, partner spotlights, fact-building).
  //     The overlay calls into it; safe to load in either order since the
  //     overlay defensively checks for window.TmwSearchCore on each query.
  //   - journal-search-overlay.js: the overlay UI itself.
  // Cache-bust the search scripts with a version token so a new build is fetched
  // under a fresh URL — bypassing aggressive client/proxy caches (e.g. Chrome
  // mobile Data Saver) that ignore `must-revalidate`. BUMP this whenever
  // journal-search-overlay.js or journal-search-core.js changes. (This file is
  // itself must-revalidate, so a compliant browser picks up the new token; once
  // it does, the versioned URL guarantees the new search code loads.)
  var SEARCH_V = '20260627b';
  function loadSearchOverlay() {
    if (!document.querySelector('script[data-tmw-search-core]')) {
      var c = document.createElement('script');
      c.src = '/_shared/journal-search-core.js?v=' + SEARCH_V;
      c.defer = true;
      c.setAttribute('data-tmw-search-core', '1');
      document.head.appendChild(c);
    }
    if (document.querySelector('script[data-tmw-search-overlay]')) return;
    var s = document.createElement('script');
    s.src = '/_shared/journal-search-overlay.js?v=' + SEARCH_V;
    s.defer = true;
    s.setAttribute('data-tmw-search-overlay', '1');
    document.head.appendChild(s);
  }

  // Render inline project cards (journal ↔ database bridge). Only loads the
  // renderer when the article actually embeds a project (new card embed or a
  // legacy map-embed iframe), so non-linked posts pay nothing.
  function loadProjectCards() {
    // Load on any post page (so the coverage auto-link can run) or when a post
    // already has a manual project embed / legacy map iframe.
    if (!document.querySelector('.article-body-content, .tmw-project-card[data-project], iframe.tmw-map-embed')) return;
    // Load the shared timeline/intelligence engine FIRST so project-card.js can
    // render the IDENTICAL construction timeline the map uses (same segment
    // widths, per-stage colours, %, and "Delivered" subtitle) — single source of
    // truth, no per-page drift. It self-injects its CSS and exposes window.TMWIntel.
    if (!document.querySelector('script[src*="tmw-project-intel.js"]')) {
      var pi = document.createElement('script');
      pi.src = '/_shared/tmw-project-intel.js';
      pi.async = false;  // run before project-card.js (insertion order)
      document.head.appendChild(pi);
    }
    if (document.querySelector('script[src*="project-card.js"]')) return;
    var s = document.createElement('script');
    s.src = '/_shared/project-card.js';
    s.async = false;  // wait for tmw-project-intel.js so window.TMWIntel is ready
    document.head.appendChild(s);
  }

  // Make bare URLs in an article body clickable. The editor auto-links most, but
  // a URL pasted with no trailing space (common at the very end of an article)
  // stays plain text — and existing posts may have bare URLs too. Wrap any
  // http(s) URL that isn't already inside a link / code block.
  function linkifyArticle() {
    var root = document.querySelector('.article-body-content');
    if (!root) return;
    var URL_RE = /(https?:\/\/[^\s<>"'`)\]}]+[^\s<>"'`)\]}.,;:!?])/g;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var targets = [], n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || n.nodeValue.indexOf('http') === -1) continue;
      if (n.parentNode && n.parentNode.closest && n.parentNode.closest('a, code, pre')) continue;
      URL_RE.lastIndex = 0;
      if (URL_RE.test(n.nodeValue)) targets.push(n);
    }
    targets.forEach(function (node) {
      var text = node.nodeValue, frag = document.createDocumentFragment(), last = 0, m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var a = document.createElement('a');
        a.href = m[0]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = m[0];
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  // Load the shared auth cluster (Instagram + profile/Join) on EVERY journal
  // page, AFTER swapToInstagram() so journal-auth.js reuses the dock's .tmw-ig
  // button instead of minting a second one. Guarded so pages that already embed
  // the script (or have it injected by the chrome) don't double-load.
  // Feature flag: the native in-page "Go Pro" paywall. While false, Pro tiles /
  // "Go Pro" keep their old behaviour (graceful fallback redirect to the map's
  // ?upgrade=1). Flip to true once the Memberstack checkout is verified.
  var PAYWALL_NATIVE = true;

  function loadAuth() {
    if (!document.querySelector('script[src*="journal-auth.js"], script[data-tmw-auth-loader]')) {
      var s = document.createElement('script');
      s.src = '/_shared/journal-auth.js';
      s.defer = true;
      s.setAttribute('data-tmw-auth-loader', '');
      document.head.appendChild(s);
    }
    // Custom TMW-branded auth modals (login/signup) on Memberstack headless.
    if (!document.querySelector('script[src*="tmw-auth-modal.js"], script[data-tmw-authui-loader]')) {
      var a = document.createElement('script');
      a.src = '/_shared/tmw-auth-modal.js';
      a.defer = true;
      a.setAttribute('data-tmw-authui-loader', '');
      document.head.appendChild(a);
    }
    // Native "Go Pro" paywall — so Pro upgrades pop up in-page instead of
    // redirecting to the map. Reuses the Memberstack instance auth.js loads.
    if (PAYWALL_NATIVE && !document.querySelector('script[src*="journal-paywall.js"], script[data-tmw-paywall-loader]')) {
      var p = document.createElement('script');
      p.src = '/_shared/journal-paywall.js';
      p.defer = true;
      p.setAttribute('data-tmw-paywall-loader', '');
      document.head.appendChild(p);
    }
  }

  // Stretch the desktop Focus Markets mega-panel to the full viewport width.
  // It's position:absolute inside the trigger (the header's backdrop-filter
  // makes position:fixed resolve against the header, not the viewport), so we
  // offset its left edge back to x=0 and set its width to the viewport.
  function setupFmPanel() {
    function pos() {
      var fms = document.querySelectorAll('.tmw-fm');
      var vw = document.documentElement.clientWidth;
      for (var i = 0; i < fms.length; i++) {
        var panel = fms[i].querySelector('.tmw-fm-panel');
        if (!panel) continue;
        if (vw > 980) {
          panel.style.left = (-Math.round(fms[i].getBoundingClientRect().left)) + 'px';
          panel.style.width = vw + 'px';
        } else {
          panel.style.left = '';
          panel.style.width = '';
        }
      }
    }
    pos();
    window.addEventListener('resize', pos);
    // Recompute right before it opens, in case layout shifted since load.
    document.querySelectorAll('.tmw-fm-trigger').forEach(function (t) {
      t.addEventListener('mouseenter', pos);
      t.addEventListener('click', pos);
    });
    var p = document.querySelector('.tmw-fm');
    if (p) p.addEventListener('mouseenter', pos);
  }

  // ── Focus Markets ───────────────────────────────────────────────────
  // The header used to list each region as its own nav link. Consolidate the
  // five into a single "Focus Markets" dropdown (after "Global") with rounded
  // image tiles. Each tile lands on the journal home filtered to that market
  // (?market=<key> → the existing category-pill filter). Universal: runs on
  // every journal page (incl. the 1,377 pre-rendered article pages) since they
  // all load this dock — no per-page nav edits or regeneration needed.
  var JOURNAL_HOME = '/';
  var SK = ['Followers', 'Mo. Views', 'Mo. Web', 'Interactions'];
  var FOCUS_MARKETS = [
    { key: 'florida',   name: 'Florida of Tomorrow',   h: 'floridaoftomorrow',   img: '/media/img/9998de3ca8af.jpg', flag: true,  s: ['160K', '3.5M', '1.2M', '150K'] },
    // TODO(jake): stats below are placeholders — swap for the real Hotels of
    // Tomorrow media-kit numbers when available.
    { key: 'hotels',    name: 'Hotels of Tomorrow',    h: 'hotelsoftomorrow',    img: 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_d7cb537f27f14e05b15e4787e1fa7d29~mv2.jpg', flag: false, s: ['20K', '1.1M', '60K', '12K'] },
    { key: 'new-york',  name: 'New York of Tomorrow',  h: 'newyorkoftomorrow',   img: '/media/img/e3c8a4e4ff38.jpg', flag: false, s: ['10K', '297K', '22K', '19K'] },
    { key: 'tennessee', name: 'Tennessee of Tomorrow', h: 'tennesseeoftomorrow', img: '/media/img/d3ce63b84f46.jpg', flag: false, s: ['12K', '305K', '41K', '32K'] },
    { key: 'caribbean', name: 'Caribbean of Tomorrow', h: 'caribbeanoftomorrow', img: '/media/img/5d9804404207.jpg', flag: false, s: ['2.5K', '88K', '12K', '5.7K'] },
    { key: 'rockies',   name: 'Rockies of Tomorrow',   h: 'rockiesoftomorrow',   img: '/media/img/35b59ff84cf5.jpg', flag: false, s: ['400', '12K', '4.1K', '1.1K'] }
  ];
  // Flat region/list link labels we pull OUT of the header (matched on visible
  // text) and re-home into the new Focus Markets / The Lists dropdowns.
  var MARKET_LABELS = { 'florida':1, 'new york':1, 'new-york':1, 'newyork':1, 'tennessee':1, 'caribbean':1, 'rockies':1, 'hotels':1, 'restaurants':1, 'golf':1 };

  var MAP_BASE = 'https://www.oftmw.com/map';
  var CHEV = '<svg class="tmw-fm-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
  var IG_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4.5"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/></svg>';
  var ARR2 = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
  // Social glyphs for the Focus Markets cards (IG reuses the outline IG_SM above).
  var SOC_LI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 11-.02 5.001A2.5 2.5 0 014.98 3.5zM3 9h4v12H3zM9 9h3.8v1.64h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.4c0-1.29-.02-2.95-1.8-2.95-1.8 0-2.07 1.4-2.07 2.85V21H9z"/></svg>';
  var SOC_FB = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12a10 10 0 10-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0022 12z"/></svg>';
  var SOC_X  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2.5h3.3l-7.2 8.26L23.7 21.5h-6.66l-5.21-6.82-5.96 6.82H2.56l7.7-8.84L1.4 2.5h6.83l4.71 6.23zm-1.16 17.04h1.83L7.13 4.36H5.16z"/></svg>';
  // A (non-anchor) social icon button. The card itself is an <a>, so these can't
  // be nested anchors — data-soc-url is opened by the delegated click handler.
  function socIcon(url, label, svg) {
    return '<span class="tmw-oc-soc" data-soc-url="' + url + '" role="link" tabindex="0" aria-label="' + label + '">' + svg + '</span>';
  }
  function ic(p) { return '<svg viewBox="0 0 24 24">' + p + '</svg>'; }
  // Canonical TMW feature icons (also used in the intelligence section on each page).
  var HEX_IC = '<polygon points="12,4.3 18.65,8.16 18.65,15.84 12,19.68 5.35,15.84 5.35,8.16"/>';      // Intelligence = TMW hexagon
  var EYE_IC = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'; // Watchlist = eye
  var CMP_IC = '<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/>'; // Compare = two columns
  var PULSE_IC = '<path d="M3 12h4l2 6 4-14 2 8h6"/>';                                                  // Pulse = live feed

  // The redesigned header nav: keep "Global", consolidate the region links into a
  // rich Focus Markets dropdown (media-kit social cards), add a "The Map" menu
  // (Explore + Pro intelligence) and a "The Lists" menu (Hotels/Restaurants/Golf).
  function buildHeaderNavCSS() {
    if (document.getElementById('tmw-nav2-css')) return;
    var s = document.createElement('style'); s.id = 'tmw-nav2-css';
    s.textContent = [
      // v2 mega panels — full-width backdrop, centered inner content.
      '.tmw-fm-panel.v2{display:block; grid-template-columns:none; padding:0; background:#0a0c0a; -webkit-backdrop-filter:none; backdrop-filter:none; z-index:9100}',
      '.tmw-fm-inner{max-width:1240px; margin:0 auto; padding:26px clamp(24px,4vw,72px) 32px}',
      // The open menu sits ON TOP of the whole site; the pinned search dock hides.
      'body:has(.tmw-fm.open) .tmw-dock, body:has(.nav-links.open) .tmw-dock{opacity:0 !important; visibility:hidden !important; pointer-events:none !important}',
      '.sticky-stack:has(.nav-links.open){z-index:9200}',
      '.tmw-nav-eyebrow{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:9.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--mute,#9AA39C); margin-bottom:15px}',
      // Focus Markets — the media-kit .ocard, with "Read articles" in place of chips.
      '.tmw-oc-grid{display:grid; grid-template-columns:repeat(6,1fr); gap:12px}',
      '.tmw-oc{display:flex; flex-direction:column; background:rgba(255,255,255,.025); border:1px solid rgba(255,255,255,.16); border-radius:14px; overflow:hidden; text-decoration:none; transition:transform .25s, border-color .25s}',
      '.tmw-oc:hover{transform:translateY(-3px); border-color:rgba(255,255,255,.32)}',
      '.tmw-oc-banner{position:relative; width:100%; aspect-ratio:2/1; overflow:hidden; border-bottom:1px solid rgba(255,255,255,.08)}',
      '.tmw-oc-banner img{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; transition:transform .5s ease}',
      '.tmw-oc:hover .tmw-oc-banner img{transform:scale(1.04)}',
      '.tmw-oc-body{padding:14px 16px 16px; display:flex; flex-direction:column; flex:1}',
      '.tmw-oc-name{font-size:13px; font-weight:600; color:#fff; text-transform:none; letter-spacing:normal; line-height:1.25; margin-bottom:13px}',
      '.tmw-oc-stats{display:grid; grid-template-columns:1fr 1fr; gap:13px 12px; padding-bottom:15px; border-bottom:1px solid rgba(255,255,255,.08)}',
      '.tmw-oc-st{display:flex; flex-direction:column; gap:3px}',
      '.tmw-oc-st .v{font-family:var(--serif,Georgia,serif); font-weight:600; font-size:20px; color:#fff; letter-spacing:-.01em; line-height:1}',
      '.tmw-oc-st .k{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute,#9AA39C)}',
      // Social row (IG · LinkedIn · Facebook · X) sits between two dividers
      // (the stats border above + its own border below); then a slim
      // "Read articles" row by itself.
      '.tmw-oc-social{margin-top:auto; display:flex; align-items:center; gap:8px; padding:13px 0; border-bottom:1px solid rgba(255,255,255,.08)}',
      '.tmw-oc-soc{flex:0 0 auto; display:flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:8px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); color:var(--mute,#9AA39C); cursor:pointer; transition:background .2s, color .2s, border-color .2s}',
      '.tmw-oc-soc:hover{background:rgba(31,223,103,.1); border-color:rgba(31,223,103,.3); color:#1FDF67}',
      '.tmw-oc-soc svg{width:15px; height:15px}',
      '.tmw-oc-foot{padding-top:11px; display:flex; align-items:center}',
      '.tmw-oc-read{display:inline-flex; align-items:center; gap:8px; white-space:nowrap; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--gold-soft,#f0d68a)}',
      '.tmw-oc-read svg{width:13px; height:13px; transition:transform .2s}',
      '.tmw-oc:hover .tmw-oc-read{color:#fff} .tmw-oc:hover .tmw-oc-read svg{transform:translateX(3px)}',
      // The Map — explore (free) + pro intelligence + Go Pro CTA.
      '.tmw-mm{display:grid; grid-template-columns:1fr; gap:14px; max-width:1000px}',
      '.tmw-mm-h{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:9.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--mute,#9AA39C); margin-bottom:8px}',
      '.tmw-mm-h-span{grid-column:1/-1; margin-bottom:-6px}',
      '.tmw-mm-pro-grid{display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px 14px}',
      '.tmw-mm-item{display:flex; gap:12px; padding:10px; border-radius:12px; text-decoration:none; transition:background .18s}',
      '.tmw-mm-item:hover{background:rgba(255,255,255,.05)}',
      '.tmw-mm-ic{flex:0 0 auto; width:34px; height:34px; border-radius:10px; display:flex; align-items:center; justify-content:center; background:rgba(167,139,250,.12); border:1px solid rgba(167,139,250,.3); color:#C4B5FD}',
      '.tmw-mm-ic.green{background:rgba(31,223,103,.1); border-color:rgba(31,223,103,.26); color:#42EB81}',
      '.tmw-mm-ic svg{width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.8}',
      '.tmw-mm-tx b{display:block; font-size:12px; font-weight:600; color:#fff}',
      '.tmw-mm-tx b em{font-style:normal; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:7.5px; letter-spacing:.12em; color:var(--gold-soft,#f0d68a); border:1px solid rgba(230,197,116,.42); border-radius:5px; padding:2px 5px; margin-left:7px; vertical-align:middle}',
      '.tmw-mm-tx b em.fpro{color:#42EB81; border-color:rgba(31,223,103,.42)}',
      '.tmw-mm-tx b em.ppro{color:#C4B5FD; border-color:rgba(167,139,250,.45)}',
      '.tmw-mm-tx i{font-style:normal; display:block; font-size:11px; color:var(--mute,#9AA39C); margin-top:2px}',
      '.tmw-mm-cta{grid-column:1/-1; display:flex; align-items:center; justify-content:space-between; gap:14px; padding:15px 18px; border-radius:13px; text-decoration:none; background:linear-gradient(120deg,rgba(167,139,250,.13),rgba(31,223,103,.06)); border:1px solid rgba(167,139,250,.3)}',
      '.tmw-mm-cta .t{font-family:var(--serif,Georgia,serif); font-weight:400; font-size:16px; line-height:1.25; letter-spacing:-.01em; text-transform:none; color:#fff}',
      '.tmw-mm-cta .t em{font-style:italic; color:#B9A6FF}',
      '.tmw-mm-cta .go{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:11px; letter-spacing:.06em; text-transform:uppercase; font-weight:700; padding:10px 16px; border-radius:9px; background:#FFD300; color:#0a0a0a; white-space:nowrap}',
      // The Lists — featured split: one hero list + two compact image rows.
      '.tmw-ll{display:grid; grid-template-columns:1.5fr 1fr; gap:14px; max-width:860px}',
      '.tmw-lc-feat{position:relative; display:block; border-radius:15px; overflow:hidden; text-decoration:none; min-height:262px; border:1px solid rgba(255,255,255,.1)}',
      '.tmw-lc-feat img{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transition:transform .55s ease}',
      '.tmw-lc-feat::after{content:""; position:absolute; inset:0; background:linear-gradient(to top, rgba(5,6,5,.93), rgba(5,6,5,.2) 55%, rgba(5,6,5,.4))}',
      '.tmw-lc-feat:hover img{transform:scale(1.05)}',
      '.tmw-lc-fm{position:absolute; left:0; right:0; bottom:0; padding:22px; z-index:2}',
      '.tmw-lc-eye{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--gold-soft,#f0d68a); margin-bottom:7px}',
      '.tmw-lc-feat h3{font-family:var(--serif,Georgia,serif); font-weight:500; font-size:28px; line-height:1; letter-spacing:-.015em; text-transform:none; color:#fff}',
      '.tmw-lc-feat p{font-family:var(--sans,"Inter",sans-serif); text-transform:none; font-size:12.5px; line-height:1.45; color:var(--mute-2,#C2C9C3); margin-top:9px; max-width:34ch}',
      '.tmw-lc-side{display:flex; flex-direction:column; gap:14px}',
      '.tmw-lc-row{position:relative; display:block; border-radius:14px; overflow:hidden; text-decoration:none; flex:1; min-height:123px; border:1px solid rgba(255,255,255,.1)}',
      '.tmw-lc-row img{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transition:transform .55s ease}',
      '.tmw-lc-row::after{content:""; position:absolute; inset:0; background:linear-gradient(100deg, rgba(5,6,5,.9) 36%, rgba(5,6,5,.4))}',
      '.tmw-lc-row:hover img{transform:scale(1.05)}',
      '.tmw-lc-rm{position:absolute; left:0; bottom:0; padding:16px 18px; z-index:2}',
      '.tmw-lc-row h3{font-family:var(--serif,Georgia,serif); font-weight:500; font-size:20px; line-height:1; letter-spacing:-.01em; text-transform:none; color:#fff}',
      // Mobile: panels become stacked accordion content (1 column).
      '@media(max-width:980px){',
      '.tmw-fm-panel.v2{display:none}',
      '.tmw-fm.open .tmw-fm-panel.v2{display:block}',
      '.tmw-fm-inner{padding:8px 0 8px; max-width:none}',
      'nav.main .nav-links{overscroll-behavior:contain}',
      // Focus Markets: 2 columns. Image fills the full top frame (flush to the
      // card's rounded corners, no gap); 16/9 keeps it tight so the title +
      // stats get the bigger share of the tile.
      '.tmw-oc-grid{grid-template-columns:repeat(2,1fr); max-width:none; gap:10px}',
      '.tmw-oc-banner{aspect-ratio:16/9; border-radius:13px 13px 0 0; border-bottom:0}',
      '.tmw-oc-banner img{object-fit:cover; object-position:center}',
      '.tmw-oc-body{padding:12px 13px 12px; gap:0}',
      '.tmw-oc-name{font-size:13.5px; margin-bottom:12px}',
      '.tmw-oc-stats{gap:10px 12px; padding-bottom:13px}',
      '.tmw-oc-st .v{font-size:16px}',
      // Footer: "Read articles" anchored LEFT, Instagram anchored RIGHT, equal
      // padding to each edge of the tile (no centred-floating link).
      '.tmw-oc-foot{padding-top:10px}',
      '.tmw-oc-read{font-size:8.5px; letter-spacing:.06em; flex:0 1 auto; justify-content:flex-start; gap:6px}',
      '.tmw-oc-social{gap:6px; padding:11px 0}',
      '.tmw-oc-soc{flex:0 0 auto; width:26px; height:26px}',
      '.tmw-mm{grid-template-columns:1fr; max-width:none; gap:10px}',
      '.tmw-mm-pro-grid{grid-template-columns:1fr}',
      '.tmw-ll{grid-template-columns:1fr; max-width:none; gap:10px}',
      '.tmw-lc-feat{min-height:200px}',
      // Go-Pro CTA: the pill is content-width and padded so it never touches the
      // card edges (was stretched edge-to-edge, "too long").
      '.tmw-mm-cta{flex-direction:column; align-items:center; text-align:center; gap:11px; padding:16px}',
      '.tmw-mm-cta .go{align-self:center; padding:11px 30px}',
      '.tmw-nav-eyebrow{margin:6px 0 10px}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  // Make one full-width mega dropdown (.tmw-fm) with a trigger + panel + toggle.
  function makeFm(label, innerHTML) {
    var fm = document.createElement('div');
    // e.g. "Database" -> "tmw-fm tmw-fm-database" so a single dropdown can be
    // targeted (the gold accent on Database for the map/atlas surfaces).
    fm.className = 'tmw-fm tmw-fm-' + label.toLowerCase().replace(/\s+/g, '-');
    fm.innerHTML =
      '<button type="button" class="tmw-fm-trigger" aria-expanded="false" aria-haspopup="true">' + label + CHEV + '</button>' +
      '<div class="tmw-fm-panel v2" role="menu"><div class="tmw-fm-inner">' + innerHTML + '</div></div>';
    var trigger = fm.querySelector('.tmw-fm-trigger');
    trigger.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      // Close any other open dropdown in this nav first.
      var sibs = fm.parentNode ? fm.parentNode.querySelectorAll('.tmw-fm.open') : [];
      for (var i = 0; i < sibs.length; i++) if (sibs[i] !== fm) sibs[i].classList.remove('open');
      var open = fm.classList.toggle('open');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!fm.contains(e.target)) { fm.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); }
    });
    return fm;
  }

  function focusMarketsPanel() {
    var cards = FOCUS_MARKETS.map(function (m) {
      var stats = m.s.slice(0, 2).map(function (v, i) { return '<div class="tmw-oc-st"><span class="v">' + v + '</span><span class="k">' + SK[i] + '</span></div>'; }).join('');
      // Handles are {market}oftomorrow everywhere EXCEPT X, which is {market}oftmw.
      var xh = m.h.replace(/tomorrow$/, 'tmw');
      return '<a class="tmw-oc" role="menuitem" href="' + JOURNAL_HOME + '?market=' + m.key + '">' +
        '<div class="tmw-oc-banner"><img src="' + m.img + '" alt="' + m.name + '" loading="lazy"></div>' +
        '<div class="tmw-oc-body"><span class="tmw-oc-name">' + m.name.replace(/ Tomorrow$/, '<br>Tomorrow') + '</span>' +
          '<div class="tmw-oc-stats">' + stats + '</div>' +
          '<div class="tmw-oc-social">' +
            socIcon('https://www.instagram.com/' + m.h, 'Instagram @' + m.h, IG_SM) +
            socIcon('https://www.linkedin.com/company/' + m.h, 'LinkedIn ' + m.h, SOC_LI) +
            socIcon('https://www.facebook.com/' + m.h, 'Facebook ' + m.h, SOC_FB) +
            socIcon('https://x.com/' + xh, 'X @' + xh, SOC_X) +
          '</div>' +
          '<div class="tmw-oc-foot"><span class="tmw-oc-read">Read articles ' + ARR2 + '</span></div>' +
        '</div></a>';
    }).join('');
    return '<div class="tmw-nav-eyebrow">Each market — its own journal feed, social &amp; project coverage</div><div class="tmw-oc-grid">' + cards + '</div>';
  }

  function theMapPanel() {
    var U = MAP_BASE, UP = MAP_BASE + '/?upgrade=1';
    function pro(icon, name, sub, ctx, href) {
      return '<a class="tmw-mm-item" href="' + (href || UP) + '" data-paywall="' + ctx + '"><span class="tmw-mm-ic">' + ic(icon) + '</span><span class="tmw-mm-tx"><b>' + name + '<em>PRO</em></b><i>' + sub + '</i></span></a>';
    }
    return '<div class="tmw-mm">' +
      '<div class="tmw-mm-h">Database Tools</div>' +
      '<div class="tmw-mm-pro-grid">' +
        '<a class="tmw-mm-item" href="/markets/"><span class="tmw-mm-ic green">' + ic('<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>') + '</span><span class="tmw-mm-tx"><b>Tracked Markets<em class="fpro">FREE</em></b><i>Explore every city, state, country.</i></span></a>' +
        '<a class="tmw-mm-item" href="/firm/"><span class="tmw-mm-ic green">' + ic('<path d="M3 21h18M6 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M14 21V9h3a1 1 0 0 1 1 1v11M9 8h2M9 12h2M9 16h2"/>') + '</span><span class="tmw-mm-tx"><b>Developers &amp; Architects<em class="fpro">FREE</em></b><i>Firm portfolios and pipeline.</i></span></a>' +
        '<a class="tmw-mm-item" href="https://www.oftmw.com/atlas/?aview=timeline"><span class="tmw-mm-ic">' + ic('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>') + '</span><span class="tmw-mm-tx"><b>Openings Tracker<em>PRO</em></b><i>What&apos;s opening next, by date.</i></span></a>' +
        '<a class="tmw-mm-item" href="' + U + '"><span class="tmw-mm-ic">' + ic('<path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"/><path d="M9 3v15M15 6v15"/>') + '</span><span class="tmw-mm-tx"><b>Interactive Map<em>PRO</em></b><i>396 projects across 40+ markets.</i></span></a>' +
        '<a class="tmw-mm-item" href="https://www.oftmw.com/atlas/?aview=overview"><span class="tmw-mm-ic">' + ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>') + '</span><span class="tmw-mm-tx"><b>The Atlas<em>PRO</em></b><i>Leaderboards, momentum &amp; coverage.</i></span></a>' +
        '<a class="tmw-mm-item" href="#search" data-dbopen="search"><span class="tmw-mm-ic">' + ic(HEX_IC) + '</span><span class="tmw-mm-tx"><b>TMW Intelligence<em>PRO</em></b><i>Ask anything &mdash; forecasts &amp; answers.</i></span></a>' +
        '<a class="tmw-mm-item" href="/account#watchlist"><span class="tmw-mm-ic">' + ic(EYE_IC) + '</span><span class="tmw-mm-tx"><b>Watchlist<em>PRO</em></b><i>Track projects, get notified.</i></span></a>' +
        pro(CMP_IC, 'Compare', 'Stack any projects side-by-side.', 'feature:compare', 'https://www.oftmw.com/map/?compare=new') +
        '<a class="tmw-mm-item" href="#" data-dbopen="pulse"><span class="tmw-mm-ic">' + ic(PULSE_IC) + '</span><span class="tmw-mm-tx"><b>Pulse<em>PRO</em></b><i>A live feed of every new project.</i></span></a>' +
      '</div>' +
      '<a class="tmw-mm-cta" href="' + UP + '" data-paywall="go-pro"><span class="t">Explore the map free. <em>Go Pro for the intelligence.</em></span><span class="go">Go Pro →</span></a>' +
    '</div>';
  }

  function theListsPanel() {
    var IMG_H = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_07e4600c7eb745c28897b90cbab6d7ff~mv2.jpeg';
    var IMG_R = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_42e28b9d09364b0ca9b3c4d6ca2e9498~mv2.jpeg';
    var IMG_G = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_d11891954f1f433f9d6a933b28d7cf5f~mv2.jpeg';
    return '<div class="tmw-nav-eyebrow">The definitive ranked guides</div><div class="tmw-ll">' +
      '<a class="tmw-lc-feat" href="/hotels/"><img src="' + IMG_H + '" alt="Iconic Hotels" loading="lazy">' +
        '<div class="tmw-lc-fm"><div class="tmw-lc-eye">The flagship guide</div><h3>Iconic Hotels</h3>' +
        '<p>The stays that define every market — ranked, property by property.</p></div></a>' +
      '<div class="tmw-lc-side">' +
        '<a class="tmw-lc-row" href="/restaurants/"><img src="' + IMG_R + '" alt="Iconic Restaurants" loading="lazy">' +
          '<div class="tmw-lc-rm"><div class="tmw-lc-eye">Where the future eats</div><h3>Iconic Restaurants</h3></div></a>' +
        '<a class="tmw-lc-row" href="/golf/"><img src="' + IMG_G + '" alt="Iconic Golf" loading="lazy">' +
          '<div class="tmw-lc-rm"><div class="tmw-lc-eye">The courses worth the trip</div><h3>Iconic Golf</h3></div></a>' +
      '</div>' +
    '</div>';
  }

  // Social icons inside the (anchor) market cards can't be nested anchors —
  // handle their click manually so they open the profile without following the
  // card link. New cards use .tmw-oc-soc[data-soc-url]; .tmw-oc-ig kept for
  // backward-compat.
  var _igWired = false;
  function wireIgClicks() {
    if (_igWired) return; _igWired = true;
    document.addEventListener('click', function (e) {
      var soc = e.target.closest && e.target.closest('.tmw-oc-soc');
      if (soc && soc.getAttribute('data-soc-url')) {
        e.preventDefault(); e.stopPropagation();
        window.open(soc.getAttribute('data-soc-url'), '_blank', 'noopener');
        return;
      }
      var ig = e.target.closest && e.target.closest('.tmw-oc-ig');
      if (!ig) return;
      e.preventDefault(); e.stopPropagation();
      window.open('https://www.instagram.com/' + ig.getAttribute('data-ig'), '_blank', 'noopener');
    });
  }

  // Intercept clicks on Pro tiles / "Go Pro" so the native paywall pops up
  // in-page instead of redirecting to the map's ?upgrade=1. Paid members fall
  // through to the link (the real map feature); if the paywall script hasn't
  // loaded yet, the href (map ?upgrade=1) is the graceful fallback.
  var _pwWired = false;
  function wirePaywallTiles() {
    if (_pwWired) return; _pwWired = true;
    document.addEventListener('click', function (e) {
      // Database-dropdown action tiles: open the search lightbox or pulse pop
      // on the current page (close the open mega-menu first).
      var dbo = e.target.closest && e.target.closest('[data-dbopen]');
      if (dbo) {
        e.preventDefault(); e.stopPropagation();
        var openFm = document.querySelector('.tmw-fm.open'); if (openFm) openFm.classList.remove('open');
        var act = dbo.getAttribute('data-dbopen');
        if (act === 'search') {
          if (location.hash === '#search') { try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch (_) {} }
          else { location.hash = '#search'; }
        } else if (act === 'pulse') {
          var bell = document.getElementById('tmw-pulse-bell'), pop = document.getElementById('tmw-pulse-pop');
          if (bell && (!pop || pop.hidden)) bell.click();
        }
        return;
      }
      var el = e.target.closest && e.target.closest('[data-paywall]');
      if (!el) return;
      if (window._isPaidMember) return;
      if (typeof window.tmwShowPaywall === 'function') {
        e.preventDefault(); e.stopPropagation();
        window.tmwShowPaywall(el.getAttribute('data-paywall'));
      }
    });
  }

  function buildFocusMarkets() {
    buildHeaderNavCSS();
    wireIgClicks();
    wirePaywallTiles();
    var navs = document.querySelectorAll('.nav-links');
    for (var n = 0; n < navs.length; n++) {
      var nav = navs[n];
      if (nav.__tmwFm) continue;
      nav.__tmwFm = true;

      // Find "Global" (insert point) and remove the flat region/list links.
      var anchors = nav.querySelectorAll('a');
      var globalAnchor = null, toRemove = [];
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var t = (a.textContent || '').trim().toLowerCase();
        if (t === 'global') globalAnchor = a;
        else if (MARKET_LABELS[t]) toRemove.push(a);
      }
      for (var r = 0; r < toRemove.length; r++) {
        if (toRemove[r].parentNode) toRemove[r].parentNode.removeChild(toRemove[r]);
      }

      // Build the three dropdowns and insert them after "Global".
      var fmMarkets = makeFm('Focus Markets', focusMarketsPanel());
      var fmMap     = makeFm('Database', theMapPanel());
      var fmLists   = makeFm('The Lists', theListsPanel());
      var ref = globalAnchor && globalAnchor.parentNode === nav ? globalAnchor : nav.firstElementChild;
      if (ref && ref.nextSibling) {
        nav.insertBefore(fmMarkets, ref.nextSibling);
        nav.insertBefore(fmMap, fmMarkets.nextSibling);
        nav.insertBefore(fmLists, fmMap.nextSibling);
      } else { nav.appendChild(fmMarkets); nav.appendChild(fmMap); nav.appendChild(fmLists); }
    }
  }

  // Swap the header's "Open Map" CTA for an Instagram icon → @floridaoftomorrow.
  // (The map is still one tap away via the dock's map button.) Universal: applies
  // to the inline page headers and the injected chrome header alike.
  function swapToInstagram() {
    var ctas = document.querySelectorAll('.nav-cta');
    for (var i = 0; i < ctas.length; i++) {
      var c = ctas[i];
      if (c.__tmwIg) continue;
      c.__tmwIg = true;
      c.setAttribute('href', IG_URL);
      c.setAttribute('target', '_blank');
      c.setAttribute('rel', 'noopener');
      c.setAttribute('aria-label', 'Instagram — @floridaoftomorrow');
      c.removeAttribute('id'); // was nav-map-cta; drop so the live-count fetch can't repopulate
      c.classList.add('tmw-ig');
      c.innerHTML = ICON_IG;
    }
  }

  // Run every header transform (all idempotently guarded) then flag each
  // nav.main ready. The universal nav is hidden by CSS until .tmw-nav-ready, so
  // the raw flat links + Open Map CTA never flash before the menu is built.
  function finishHeaders() {
    try { buildFocusMarkets(); } catch (e) {}
    try { injectSurfaceToggle(); } catch (e) {}
    try { swapToInstagram(); } catch (e) {}
    // Always reveal, even if a transform threw — a hidden nav is worse than an
    // imperfect one.
    var navs = document.querySelectorAll('nav.main');
    for (var i = 0; i < navs.length; i++) navs[i].classList.add('tmw-nav-ready');
  }

  // Robust body-scroll lock for the open mobile drawer. Setting only
  // documentElement.style.overflow='hidden' leaves iOS Safari able to rubber-
  // band scroll the page behind the menu; pinning the body with position:fixed
  // (and restoring the exact scroll offset on close) stops that on every engine.
  // The drawer is its own scroll container (overflow-y:auto) so it still scrolls
  // internally while the page underneath stays frozen.
  var __tmwLockedY = 0;
  function lockBodyScroll() {
    __tmwLockedY = window.pageYOffset || document.documentElement.scrollTop || 0;
    var b = document.body;
    b.style.top = (-__tmwLockedY) + 'px';
    b.style.position = 'fixed';
    b.style.left = '0';
    b.style.right = '0';
    b.style.width = '100%';
    document.documentElement.style.overflow = 'hidden';
  }
  function unlockBodyScroll() {
    var b = document.body;
    b.style.position = '';
    b.style.top = '';
    b.style.left = '';
    b.style.right = '';
    b.style.width = '';
    document.documentElement.style.overflow = '';
    window.scrollTo(0, __tmwLockedY);
  }
  // Size the open drawer to fill exactly from its top (just under the header) to
  // the viewport bottom, so its content scrolls (overflow-y:auto) instead of
  // running off the bottom edge unreachable. Robust to a banner/hero above the
  // header, header height, and safe-area insets — unlike a fixed
  // calc(100dvh - 56px), which overshoots whenever the header isn't at y=0.
  function sizeMobileDrawer(list) {
    if (window.innerWidth > 980) { list.style.height = ''; list.style.maxHeight = ''; return; }
    var top = list.getBoundingClientRect().top;
    var h = Math.max(160, Math.round(window.innerHeight - top)) + 'px';
    list.style.height = h;
    list.style.maxHeight = h;
  }

  // Wire the mobile hamburger(s) to open/close the nav dropdown. Works for both
  // the inline page headers and the shared chrome header (both use .nav-burger +
  // .nav-links inside nav.main). Single source of truth — the chrome component
  // no longer wires its own, so there's no double-toggle.
  function wireBurgers() {
    var burgers = document.querySelectorAll('.nav-burger');
    for (var i = 0; i < burgers.length; i++) {
      var b = burgers[i];
      if (b.__tmwWired) continue;
      var nav = b.closest('nav') || b.parentElement;
      var links = nav && nav.querySelector('.nav-links');
      if (!links) continue;
      b.__tmwWired = true;
      (function (btn, list) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          var open = list.classList.toggle('open');
          btn.classList.toggle('is-open', open);
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          // Lock the page behind the open drawer so scrolling the menu doesn't
          // scroll the article underneath (drawer itself stays overflow-y:auto).
          if (open) {
            lockBodyScroll();
            // After the lock freezes layout, size the drawer to the remaining
            // viewport so it scrolls. Re-size on resize/orientation while open.
            setTimeout(function () { sizeMobileDrawer(list); }, 0);
          } else {
            unlockBodyScroll();
            list.style.height = ''; list.style.maxHeight = '';
          }
        });
        // Close the menu after tapping a link
        list.addEventListener('click', function (e) {
          if (e.target.closest('a')) { list.classList.remove('open'); btn.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); unlockBodyScroll(); list.style.height = ''; list.style.maxHeight = ''; }
        });
      })(b, links);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();


/* ── Universal Pulse — gold count circle + activity feed popup ───────────────
   Lives in journal-dock.js because the dock is the ONLY shared script loaded on
   every surface (journal home, /map, /atlas). Renders a gold notification circle
   (the count of undismissed items) to the LEFT of the profile icon
   (.tmw-auth .v2-profile-btn) plus a popup feed where each tile has a red ✕ to
   clear it individually (the count drops per clear). Self-guarded; builds once. */
(function () {
  if (window.__tmwPulse) return; window.__tmwPulse = true;
  var PULSE_URL = 'https://www.oftmw.com/map/pulse.json';
  var DISMISS_KEY = 'tmw_pulse_dismissed';
  var FEED_MAX = 30;
  var events = [], circleEl = null, popEl = null, feedEl = null;

  function esc(s){ return (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function rel(ts){
    var t = new Date(ts).getTime(); if (isNaN(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 3600)   return Math.max(1, Math.floor(s/60)) + 'm ago';
    if (s < 86400)  return Math.floor(s/3600) + 'h ago';
    if (s < 604800) return Math.floor(s/86400) + 'd ago';
    try { return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric' }); } catch(e){ return ''; }
  }
  function byTime(a,b){ return new Date(b.timestamp) - new Date(a.timestamp); }
  // Milestones are ordered + windowed by when the milestone HAPPENED
  // (event_date) — matching the Atlas "Recent movers" feed — so a backfilled
  // milestone with an old event date never resurfaces as current activity just
  // because we logged it today. Articles (no event_date) fall back to publish
  // time. The window is 90 days (PULSE_WINDOW_MS), wide enough that genuine
  // recent movers still populate the feed (a tight window hid almost everything).
  function evTime(e){
    var typ = (e && e.type ? String(e.type) : '').toLowerCase();
    var d = (typ === 'status_change' && e && e.event_date) ? e.event_date
          : (e && e.timestamp) ? e.timestamp : (e && e.event_date);
    var t = new Date(d).getTime();
    return isNaN(t) ? 0 : t;
  }
  function byEvent(a,b){ return evTime(b) - evTime(a); }
  var PULSE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;   // last 90 days by event date — matches Atlas Recent movers
  // Format a real event date (YYYY / YYYY-MM / YYYY-MM-DD) → "Nov 2025".
  function fmtEv(s){
    var m = String(s || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return '';
    var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (m[2] && m[3]) return MON[+m[2]-1] + ' ' + (+m[3]) + ', ' + m[1];
    if (m[2]) return MON[+m[2]-1] + ' ' + m[1];
    return m[1];
  }
  // Chip TEXT: a milestone shows its own phase tag (Topped out, Financing
  // secured); never the generic "Update" word. Additions read "Tracking".
  function label(e){
    var t = (e.type || '').toLowerCase();
    if (t === 'article')       return 'Article';
    if (t === 'new_project' || t === 'tracking') return 'Tracking';
    if (t === 'status_change') return e.tag || '';
    var tag = (e.tag || '').toLowerCase();
    if (tag.indexOf('on tmw') > -1 || tag.indexOf('article') > -1) return 'Article';
    if (tag.indexOf('new on map') > -1 || tag.indexOf('added') > -1) return 'Tracking';
    return e.tag || '';
  }
  // Chip COLOR class by type (so the text can be a multi-word phase).
  function labelClass(e){
    var t = (e.type || '').toLowerCase();
    if (t === 'article') return 'article';
    if (t === 'new_project' || t === 'tracking') return 'tracking';
    return 'update'; // status_change → dossier purple
  }
  function title(e){
    var t = (e.type || '').toLowerCase();
    var s;
    if (t === 'status_change')   s = e.project_title || e.title || '';
    else if (t === 'new_project') s = 'Now tracking ' + (e.project_title || (e.title || '').replace(/\s+added to the map$/i, ''));
    else                          s = e.title || e.project_title || ''; // tracking already "Now tracking X"; article = headline
    return String(s).replace(/\s+/g, ' ').trim();
  }
  // "Now tracking …" (a project added to the map) events are excluded from the
  // pulse notifications entirely, per product decision — the feed shows article
  // + status-change activity only.
  function notTracking(e){
    var t = (e.type || '').toLowerCase();
    if (t === 'new_project' || t === 'tracking') return false;
    var tag = (e.tag || '').toLowerCase();
    if (tag.indexOf('new on map') > -1 || tag.indexOf('added') > -1) return false;
    return true;
  }
  function eid(e){ return e.id != null ? String(e.id) : (e.type + '|' + e.timestamp + '|' + (e.project_slug || e.title || '')); }
  function getDismissed(){ try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch(e){ return new Set(); } }
  function saveDismissed(set){ try { localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(set))); } catch(e){} }
  function active(){
    var d = getDismissed();
    var now = Date.now(), cutoff = now - PULSE_WINDOW_MS, upper = now + 2 * 24 * 60 * 60 * 1000;
    return events
      .filter(function(e){ var t = evTime(e); return t >= cutoff && t <= upper; })   // last 90 days by event date (Atlas parity)
      .filter(function(e){ return !d.has(eid(e)); })
      .slice(0, FEED_MAX);
  }
  function countNew(){ return active().length; }
  function itemHtml(e){
    var lab = label(e);
    var img = e.image ? '<img class="pi-img" src="' + esc(e.image) + '" alt="" loading="lazy">' : '<div class="pi-img"></div>';
    // Milestones show the real EVENT date (when it happened), not when we
    // tracked it; everything else falls back to relative "Nm ago".
    var when = ((e.type || '').toLowerCase() === 'status_change' && e.event_date) ? fmtEv(e.event_date) : rel(e.timestamp);
    var meta = (e.city ? esc(e.city) + ' · ' : '') + esc(when);
    var chip = lab ? '<span class="pi-tag pi-' + labelClass(e) + '">' + esc(lab) + '</span>' : '';
    // Parent-district context — when this pulse event is for a COMPONENT of an
    // umbrella district (generate_pulse.py now writes parent_slug/title on
    // child events), append a third sub-line "Part of <District>" so the
    // reader sees the relationship inline with the event.
    var partOf = e.parent_title
      ? '<div class="pi-partof">Part of ' + esc(e.parent_title) + '</div>'
      : '';
    return '<a class="tmw-pulse-item" href="' + esc(e.link || '#') + '" data-eid="' + esc(eid(e)) + '">' + img +
      '<div class="pi-body">' + chip +
      '<div class="pi-title">' + esc(title(e)) + '</div>' +
      '<div class="pi-meta">' + meta + '</div>' + partOf + '</div>' +
      '<span class="pi-x" role="button" aria-label="Clear notification" tabindex="0"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></span></a>';
  }
  // Fallback when the 2-week window is empty: the most recent few (by event date),
  // ignoring the window, so the dropdown is never blank in a quiet stretch.
  function recentFallback(){
    var d = getDismissed();
    return events.filter(function(e){ return !d.has(eid(e)); }).slice(0, 5);
  }
  function feedHtml(){
    var list = active();
    if (!list.length){
      var fb = recentFallback();
      if (!fb.length) return '<div class="tmw-pulse-empty">You’re all caught up</div>';
      return '<div class="tmw-pulse-note">Nothing new lately — here’s the latest</div>' + fb.map(itemHtml).join('');
    }
    return list.map(itemHtml).join('');
  }
  function paintCircle(){
    if (!circleEl) return;
    var n = countNew();
    var dot = '<span class="lbd" aria-hidden="true"></span>';
    if (n > 0){ circleEl.innerHTML = dot + '<span class="lbn">' + n + '</span>'; circleEl.classList.remove('is-zero'); }
    else      { circleEl.innerHTML = dot;                                         circleEl.classList.add('is-zero'); }
  }
  function repaint(){ paintCircle(); if (feedEl) feedEl.innerHTML = feedHtml(); }

  function injectCss(){
    if (document.getElementById('tmw-pulse-css')) return;
    var st = document.createElement('style'); st.id = 'tmw-pulse-css';
    st.textContent = [
      '.tmw-pulse-bell{position:relative;box-sizing:border-box;min-width:24px;height:24px;padding:0 9px 0 7px;border-radius:999px;background:rgba(167,139,250,.10);color:#fff;border:1px solid rgba(167,139,250,.6);cursor:pointer;display:inline-flex;align-items:center;gap:5px;justify-content:center;font:800 11px/1 "Inter",-apple-system,BlinkMacSystemFont,sans-serif;flex:0 0 auto;box-shadow:0 0 10px rgba(167,139,250,.4);transition:transform .12s,box-shadow .15s,width .15s,opacity .15s}',
      '.tmw-pulse-bell:hover{transform:scale(1.08);box-shadow:0 0 18px rgba(167,139,250,.8)}',
      '.tmw-pulse-bell.is-zero{padding:0 7px;opacity:.72;box-shadow:0 0 8px rgba(167,139,250,.35)}',
      '.tmw-pulse-bell.is-zero:hover{opacity:1;box-shadow:0 0 14px rgba(167,139,250,.65)}',
      /* intelligence "live" dot — pulsing ring, sits left of the count */
      '.tmw-pulse-bell .lbd{width:6px;height:6px;border-radius:50%;background:#B9A6FF;flex:0 0 auto;box-shadow:0 0 0 0 rgba(167,139,250,.6);animation:tmwBellLive 1.9s ease-out infinite}',
      '.tmw-pulse-bell .lbn{line-height:1}',
      '@keyframes tmwBellLive{0%{box-shadow:0 0 0 0 rgba(167,139,250,.55)}70%{box-shadow:0 0 0 5px rgba(167,139,250,0)}100%{box-shadow:0 0 0 0 rgba(167,139,250,0)}}',
      '@media (prefers-reduced-motion:reduce){.tmw-pulse-bell .lbd{animation:none}}',
      '.tmw-pulse-pop{position:absolute;top:calc(100% + 14px);right:0;width:372px;max-width:92vw;max-height:72vh;display:flex;flex-direction:column;background:rgba(16,16,18,.97);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.1);border-radius:16px;box-shadow:0 22px 60px rgba(0,0,0,.6);z-index:200;overflow:hidden}',
      '.tmw-pulse-pop[hidden]{display:none}',
      '.tmw-pulse-head{padding:12px 12px 12px 16px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '.tmw-pulse-head b{font-size:14px;font-weight:800;color:#fff;letter-spacing:.02em}',
      '.tmw-pulse-livedot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#1FDF67;margin-right:7px;vertical-align:middle;position:relative;top:-1px;box-shadow:0 0 0 0 rgba(31,223,103,.6);animation:tmwPulseLivedot 2s infinite}',
      '@keyframes tmwPulseLivedot{0%{box-shadow:0 0 0 0 rgba(31,223,103,.6)}70%{box-shadow:0 0 0 6px rgba(31,223,103,0)}100%{box-shadow:0 0 0 0 rgba(31,223,103,0)}}',
      '.tmw-pulse-head .tmw-pulse-sub{font-size:11px;color:rgba(255,255,255,.4)}',
      '.tmw-pulse-refresh{margin-left:auto;width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.6);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;transition:background .15s,color .15s,border-color .15s,transform .45s ease}',
      '.tmw-pulse-refresh:hover{background:rgba(255,211,0,.14);color:#FFD300;border-color:rgba(255,211,0,.4)}',
      '.tmw-pulse-refresh.spin{transform:rotate(360deg)}',
      '.tmw-pulse-refresh svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '.tmw-pulse-feed{overflow-y:auto;padding:6px}',
      '.tmw-pulse-item{position:relative;display:flex;gap:11px;padding:9px 32px 9px 10px;border-radius:11px;text-decoration:none;cursor:pointer;transition:background .12s}',
      '.tmw-pulse-item:hover{background:rgba(255,255,255,.05)}',
      '.tmw-pulse-item .pi-img{width:52px;height:52px;border-radius:9px;flex:0 0 auto;object-fit:cover;background:rgba(255,255,255,.06)}',
      '.tmw-pulse-item .pi-body{min-width:0;flex:1}',
      '.tmw-pulse-item .pi-tag{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px;color:#1FDF67}',
      '.tmw-pulse-item .pi-tag.pi-update{color:#A78BFA}',
      '.tmw-pulse-item .pi-tag.pi-tracking{color:#8b93a7}',
      '.tmw-pulse-item .pi-tag.pi-article{color:#8FB8FF}',
      '.tmw-pulse-item .pi-title{font-size:13px;font-weight:600;color:#ECEAE5;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.tmw-pulse-item .pi-meta{font-size:11px;color:rgba(255,255,255,.4);margin-top:3px}',
      // "Part of <District>" sub-line on child-component pulse events.
      // Purple to match the parent-chip vocabulary used across the rest of
      // the site (drawer/modal/search chips, TMW Intelligence anchor).
      '.tmw-pulse-item .pi-partof{font-size:10.5px;font-weight:600;color:#C9BBFF;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tmw-pulse-item .pi-x{position:absolute;top:50%;right:8px;transform:translateY(-50%);width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,.06);color:rgba(255,255,255,.45);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background .14s,color .14s,transform .12s}',
      '.tmw-pulse-item .pi-x:hover{background:#E5484D;color:#fff;transform:translateY(-50%) scale(1.12)}',
      '.tmw-pulse-item .pi-x svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}',
      '.tmw-pulse-empty{padding:28px 16px;text-align:center;color:rgba(255,255,255,.4);font-size:13px}',
      '.tmw-pulse-note{padding:10px 16px 6px;color:rgba(255,255,255,.45);font-size:11.5px;letter-spacing:.02em}',
      '@media(max-width:980px){.tmw-pulse-pop{position:fixed!important;top:62px!important;bottom:auto!important;left:12px!important;right:12px!important;width:auto!important;max-width:none!important;max-height:74vh!important}}'
    ].join('');
    document.head.appendChild(st);
  }

  function attach(){
    var box = document.querySelector('.tmw-auth');
    var prof = box ? box.querySelector('.v2-profile-btn') : null;
    if (!box || !prof) return false;
    if (document.getElementById('tmw-pulse-bell')){ circleEl = document.getElementById('tmw-pulse-bell'); return true; }
    injectCss();
    circleEl = document.createElement('button');
    circleEl.id = 'tmw-pulse-bell'; circleEl.className = 'tmw-pulse-bell'; circleEl.type = 'button';
    circleEl.setAttribute('aria-label', 'Pulse — recent activity');
    popEl = document.createElement('div');
    popEl.id = 'tmw-pulse-pop'; popEl.className = 'tmw-pulse-pop'; popEl.hidden = true;
    popEl.innerHTML =
      '<div class="tmw-pulse-head"><b><span class="tmw-pulse-livedot" aria-hidden="true"></span>Pulse</b><span class="tmw-pulse-sub">Latest across the network</span>' +
        '<button class="tmw-pulse-refresh" type="button" aria-label="Refresh" title="Refresh">' +
          '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
        '</button></div>' +
      '<div class="tmw-pulse-feed"></div>';
    box.insertBefore(circleEl, prof);
    box.appendChild(popEl);
    feedEl = popEl.querySelector('.tmw-pulse-feed');
    repaint();
    circleEl.addEventListener('click', function(ev){
      ev.stopPropagation();
      popEl.hidden = !popEl.hidden;   // opening no longer clears — dismiss each tile to lower the count
    });
    feedEl.addEventListener('click', function(ev){
      var x = ev.target.closest ? ev.target.closest('.pi-x') : null;
      if (!x) return;
      ev.preventDefault(); ev.stopPropagation();
      var item = x.closest('.tmw-pulse-item'); if (!item) return;
      var id = item.getAttribute('data-eid');
      var d = getDismissed(); d.add(id); saveDismissed(d);
      repaint();
    });
    popEl.querySelector('.tmw-pulse-refresh').addEventListener('click', function(ev){
      ev.stopPropagation();
      var btn = this; btn.classList.add('spin'); setTimeout(function(){ btn.classList.remove('spin'); }, 480);
      localStorage.removeItem(DISMISS_KEY);   // un-dismiss all → the count returns
      fetch(PULSE_URL, { cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){ if (d && d.events) events = d.events.filter(notTracking).sort(byEvent); repaint(); })
        .catch(function(){ repaint(); });
    });
    document.addEventListener('click', function(ev){
      if (popEl && !popEl.hidden && !circleEl.contains(ev.target) && !popEl.contains(ev.target)) popEl.hidden = true;
    });
    return true;
  }

  function go(){
    fetch(PULSE_URL, { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        events = ((d && d.events) || []).filter(notTracking).sort(byEvent);
        if (!attach()){ var n = 0, iv = setInterval(function(){ if (attach() || ++n > 80) clearInterval(iv); }, 150); }
      })
      .catch(function(){});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();

// ===================================================================
// MARKET FOLLOW — gold-glow "Follow <city>" button on /markets/<slug>/
// landing pages. Persists to Memberstack member JSON (markets_followed),
// the same store the account dashboard reads. Self-contained.
// ===================================================================
(function () {
  if (window.__tmwMFollow) return;
  var m = location.pathname.match(/^\/markets\/([^\/]+)\/?$/);
  if (!m) return;
  var slug = decodeURIComponent(m[1]).toLowerCase();
  if (!slug || slug === 'index.html') return;
  var hero = document.querySelector('.hero h1') || document.querySelector('.hero');
  if (!hero) return;
  window.__tmwMFollow = true;
  var WORKER = 'https://tmw.jake-ab7.workers.dev';
  function humanize(s){return String(s||'').replace(/[-_]+/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});}
  function ms(){return window.$memberstackDom;}
  var CSS='.tmw-mfollow{display:inline-flex;align-items:center;gap:9px;margin-top:22px;cursor:pointer;appearance:none;font-family:Inter,system-ui,sans-serif;font-size:14px;font-weight:600;color:#fff;background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.5);border-radius:999px;padding:11px 22px;box-shadow:0 0 22px rgba(167,139,250,.40);transition:transform .15s,box-shadow .2s,background .2s}'
    +'.tmw-mfollow:hover{transform:translateY(-1px);box-shadow:0 0 30px rgba(167,139,250,.6)}'
    +'.tmw-mfollow.on{background:rgba(167,139,250,.20);color:#fff;border:1px solid rgba(167,139,250,.7);box-shadow:0 0 22px rgba(167,139,250,.5)}'
    +'.tmw-mfollow[disabled]{opacity:.6;cursor:default}'
    +'.tmw-mfollow svg{width:15px;height:15px;flex:none}';
  if(!document.getElementById('tmw-mfollow-css')){var st=document.createElement('style');st.id='tmw-mfollow-css';st.textContent=CSS;document.head.appendChild(st);}
  var name=humanize(slug);
  var STAR='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
  var CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  var btn=document.createElement('button'); btn.type='button'; btn.className='tmw-mfollow';
  if(hero.tagName==='H1'&&hero.parentNode){ hero.parentNode.insertBefore(btn, hero.nextSibling); } else { hero.appendChild(btn); }
  // Cache the followed list locally so the button paints the right label
  // instantly on load (no Follow→Following flicker while Memberstack resolves).
  var CK='tmw_mkt_follows';
  function rc(){ try{ var a=JSON.parse(localStorage.getItem(CK)||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
  function wc(l){ try{ localStorage.setItem(CK, JSON.stringify(l||[])); }catch(e){} }
  var following=rc().indexOf(slug)>=0, busy=false;
  function paint(){ btn.classList.toggle('on',following); btn.innerHTML=following?(CHECK+'Following'):('Follow '+name); btn.setAttribute('aria-pressed',following?'true':'false'); }
  paint();
  function getJSON(m){ return m.getMemberJSON().then(function(r){return (r&&r.data)||{};}); }
  function signIn(){ var x=ms(); if(x&&x.openModal)return x.openModal('LOGIN'); if(window.tmwAuthModal)return window.tmwAuthModal('signup'); }
  function postEvent(mem){ try{ var cf=mem.customFields||{}; var nm=((cf['first-name']||'')+' '+(cf['last-name']||'')).trim()||null; var payload=JSON.stringify({member_id:mem.id,member_name:nm,event_name:'market_followed',props:{market:slug}}); if(navigator.sendBeacon){navigator.sendBeacon(WORKER+'/event',new Blob([payload],{type:'text/plain'}));}else{fetch(WORKER+'/event',{method:'POST',body:payload,headers:{'Content-Type':'text/plain'},keepalive:true}).catch(function(){});} }catch(e){} }
  // initial state once Memberstack + member resolve
  (function wait(t){ t=t||0; var x=ms(); if(x&&x.getCurrentMember){ x.getCurrentMember().then(function(r){ var mem=r&&r.data; if(!mem) return; getJSON(x).then(function(j){ var list=Array.isArray(j.markets_followed)?j.markets_followed:[]; wc(list); var nowF=list.indexOf(slug)>=0; if(nowF!==following){ following=nowF; paint(); } }); }).catch(function(){}); return; } if(++t>40)return; setTimeout(function(){wait(t);},250); })();
  btn.addEventListener('click',function(){
    if(busy) return; var x=ms();
    if(!x||!x.getCurrentMember) return signIn();
    x.getCurrentMember().then(function(r){
      var mem=r&&r.data; if(!mem) return signIn();
      busy=true; btn.disabled=true;
      getJSON(x).then(function(j){
        var prev=Array.isArray(j.markets_followed)?j.markets_followed.slice():[];
        var i=prev.indexOf(slug), on=(i<0), list=prev.slice();
        if(on) list.push(slug); else list.splice(i,1);
        j.markets_followed=list;
        // optimistic: flip + cache immediately so it feels instant
        following=on; wc(list); paint();
        x.updateMemberJSON({json:j}).then(function(){ busy=false; btn.disabled=false; if(on)postEvent(mem); }).catch(function(){ following=!on; wc(prev); paint(); busy=false; btn.disabled=false; });
      }).catch(function(){ busy=false; btn.disabled=false; });
    }).catch(function(){ busy=false; btn.disabled=false; });
  });
})();

// ===================================================================
// FIRM FOLLOW — purple "Follow <firm>" button on /firm/<slug>/ pages,
// persisted to Memberstack member JSON (firms_followed). Mirrors the
// MARKET FOLLOW block above and reuses its .tmw-mfollow styles.
// ===================================================================
(function () {
  if (window.__tmwFFollow) return;
  var m = location.pathname.match(/^\/firm\/([^\/]+)\/?$/);
  if (!m) return;
  var slug = decodeURIComponent(m[1]).toLowerCase();
  if (!slug || slug === 'index.html') return;
  var h1 = document.querySelector('.hero h1');
  var hero = h1 || document.querySelector('.hero');
  if (!hero) return;
  window.__tmwFFollow = true;
  var WORKER = 'https://tmw.jake-ab7.workers.dev';
  function ms(){return window.$memberstackDom;}
  var name = (h1 && h1.textContent.trim()) || String(slug).replace(/[-_]+/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
  var CSS='.tmw-mfollow{display:inline-flex;align-items:center;gap:9px;margin-top:22px;cursor:pointer;appearance:none;font-family:Inter,system-ui,sans-serif;font-size:14px;font-weight:600;color:#fff;background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.5);border-radius:999px;padding:11px 22px;box-shadow:0 0 22px rgba(167,139,250,.40);transition:transform .15s,box-shadow .2s,background .2s}'
    +'.tmw-mfollow:hover{transform:translateY(-1px);box-shadow:0 0 30px rgba(167,139,250,.6)}'
    +'.tmw-mfollow.on{background:rgba(167,139,250,.20);color:#fff;border:1px solid rgba(167,139,250,.7);box-shadow:0 0 22px rgba(167,139,250,.5)}'
    +'.tmw-mfollow[disabled]{opacity:.6;cursor:default}'
    +'.tmw-mfollow svg{width:15px;height:15px;flex:none}';
  if(!document.getElementById('tmw-mfollow-css')){var st=document.createElement('style');st.id='tmw-mfollow-css';st.textContent=CSS;document.head.appendChild(st);}
  var CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  var btn=document.createElement('button'); btn.type='button'; btn.className='tmw-mfollow';
  if(hero.tagName==='H1'&&hero.parentNode){ hero.parentNode.insertBefore(btn, hero.nextSibling); } else { hero.appendChild(btn); }
  var CK='tmw_firm_follows';
  function rc(){ try{ var a=JSON.parse(localStorage.getItem(CK)||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
  function wc(l){ try{ localStorage.setItem(CK, JSON.stringify(l||[])); }catch(e){} }
  var following=rc().indexOf(slug)>=0, busy=false;
  function paint(){ btn.classList.toggle('on',following); btn.innerHTML=following?(CHECK+'Following'):('Follow '+name); btn.setAttribute('aria-pressed',following?'true':'false'); }
  paint();
  function getJSON(x){ return x.getMemberJSON().then(function(r){return (r&&r.data)||{};}); }
  function signIn(){ var x=ms(); if(x&&x.openModal)return x.openModal('LOGIN'); if(window.tmwAuthModal)return window.tmwAuthModal('signup'); }
  function postEvent(mem){ try{ var cf=mem.customFields||{}; var nm=((cf['first-name']||'')+' '+(cf['last-name']||'')).trim()||null; var payload=JSON.stringify({member_id:mem.id,member_name:nm,event_name:'firm_followed',props:{firm:slug}}); if(navigator.sendBeacon){navigator.sendBeacon(WORKER+'/event',new Blob([payload],{type:'text/plain'}));}else{fetch(WORKER+'/event',{method:'POST',body:payload,headers:{'Content-Type':'text/plain'},keepalive:true}).catch(function(){});} }catch(e){} }
  (function wait(t){ t=t||0; var x=ms(); if(x&&x.getCurrentMember){ x.getCurrentMember().then(function(r){ var mem=r&&r.data; if(!mem) return; getJSON(x).then(function(j){ var list=Array.isArray(j.firms_followed)?j.firms_followed:[]; wc(list); var nowF=list.indexOf(slug)>=0; if(nowF!==following){ following=nowF; paint(); } }); }).catch(function(){}); return; } if(++t>40)return; setTimeout(function(){wait(t);},250); })();
  btn.addEventListener('click',function(){
    if(busy) return; var x=ms();
    if(!x||!x.getCurrentMember) return signIn();
    x.getCurrentMember().then(function(r){
      var mem=r&&r.data; if(!mem) return signIn();
      busy=true; btn.disabled=true;
      getJSON(x).then(function(j){
        var prev=Array.isArray(j.firms_followed)?j.firms_followed.slice():[];
        var i=prev.indexOf(slug), on=(i<0), list=prev.slice();
        if(on) list.push(slug); else list.splice(i,1);
        j.firms_followed=list;
        following=on; wc(list); paint();
        x.updateMemberJSON({json:j}).then(function(){ busy=false; btn.disabled=false; if(on)postEvent(mem); }).catch(function(){ following=!on; wc(prev); paint(); busy=false; btn.disabled=false; });
      }).catch(function(){ busy=false; btn.disabled=false; });
    }).catch(function(){ busy=false; btn.disabled=false; });
  });
})();

// ===================================================================
// ACHIEVEMENT TOASTS — when a member newly unlocks an achievement, a
// toast fires on the next page load (any journal page). Compares the
// server's achievement set to a per-member localStorage snapshot;
// first run stores silently so existing unlocks don't spam.
// ===================================================================
(function () {
  if (window.__tmwAchToast) return; window.__tmwAchToast = true;
  var WORKER = 'https://tmw.jake-ab7.workers.dev';
  var ACH = { founding:{n:'Founding Member',xp:100}, reader:{n:'Reader',xp:0}, globetrotter:{n:'Globetrotter',xp:150}, tastemaker:{n:'Tastemaker',xp:300}, centurion:{n:'Centurion',xp:250}, contributor:{n:'Contributor',xp:200} };
  var STAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
  var LVLUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/><path d="M18 9l-6-6-6 6"/></svg>';
  var CSS = '#tmw-ach-wrap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none}'
    +'.tmw-ach{display:flex;align-items:center;gap:13px;min-width:360px;max-width:460px;padding:14px 18px;border-radius:16px;background:rgba(16,18,24,.92);border:1px solid rgba(230,197,116,.35);box-shadow:0 0 30px rgba(230,197,116,.22),0 18px 50px rgba(0,0,0,.5);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font-family:Inter,system-ui,sans-serif;color:#ECEAE5;transform:translateY(22px);opacity:0;transition:transform .42s cubic-bezier(.2,.9,.3,1),opacity .42s;pointer-events:auto}'
    +'.tmw-ach.in{transform:translateY(0);opacity:1}'
    +'.tmw-ach-ic{width:40px;height:40px;border-radius:11px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(240,214,138,.95),rgba(230,197,116,.82));color:#4a3708;box-shadow:0 0 18px rgba(230,197,116,.4)}'
    +'.tmw-ach-ic svg{width:21px;height:21px}'
    +'.tmw-ach-bd{flex:1;min-width:0}'
    +'.tmw-ach-k{font-family:"JetBrains Mono",monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#e6c574;margin-bottom:3px}'
    +'.tmw-ach-n{font-family:Fraunces,Georgia,serif;font-size:17px;font-weight:600;color:#fff;line-height:1.1}'
    +'.tmw-ach-xp{font-family:"JetBrains Mono",monospace;font-size:13px;font-weight:700;color:#42EB81;text-shadow:0 0 12px rgba(31,223,103,.4);flex:0 0 auto}'
    +'.tmw-ach.lvl{border-color:rgba(167,139,250,.4);box-shadow:0 0 30px rgba(167,139,250,.25),0 18px 50px rgba(0,0,0,.5)}'
    +'.tmw-ach.lvl .tmw-ach-ic{background:linear-gradient(135deg,#c4b5fd,#A78BFA);color:#1a1340;box-shadow:0 0 18px rgba(167,139,250,.45)}'
    +'.tmw-ach.lvl .tmw-ach-k{color:#B9A6FF}'
    +'.tmw-ach.lvl .tmw-ach-xp{color:#B9A6FF;text-shadow:0 0 12px rgba(167,139,250,.45)}';
  function ensureCss(){ if(!document.getElementById('tmw-ach-css')){var s=document.createElement('style');s.id='tmw-ach-css';s.textContent=CSS;document.head.appendChild(s);} }
  function pushToast(o){
    ensureCss();
    var w=document.getElementById('tmw-ach-wrap'); if(!w){w=document.createElement('div');w.id='tmw-ach-wrap';document.body.appendChild(w);}
    var el=document.createElement('div'); el.className='tmw-ach'+(o.lvl?' lvl':'');
    el.innerHTML='<div class="tmw-ach-ic">'+(o.icon||STAR)+'</div><div class="tmw-ach-bd"><div class="tmw-ach-k">'+o.kicker+'</div><div class="tmw-ach-n">'+o.name+'</div></div>'+(o.sub?'<div class="tmw-ach-xp">'+o.sub+'</div>':'');
    // Tapping any toast takes you to your account (the climb / rewards live there).
    el.style.cursor='pointer'; el.setAttribute('role','link'); el.setAttribute('tabindex','0');
    function goAccount(){ try{ location.href=(o.href||'/account/'); }catch(e){} }
    el.addEventListener('click',goAccount);
    el.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); goAccount(); } });
    w.appendChild(el);
    requestAnimationFrame(function(){ el.classList.add('in'); });
    setTimeout(function(){ el.classList.remove('in'); setTimeout(function(){ if(el.parentNode)el.parentNode.removeChild(el); },420); }, 5400);
  }
  function toast(key){ var a=ACH[key]; if(!a) return; pushToast({kicker:'Achievement unlocked', name:a.n, sub:(a.xp?'+'+a.xp+' XP':'')}); }
  function toastLevel(lvl,tier){ pushToast({kicker:'Level up', name:'Level '+lvl+(tier?' · '+tier:''), icon:LVLUP, lvl:true}); }
  var FLAME = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 23c4.4 0 8-3.3 8-7.8 0-2.9-1.4-5.2-2.8-7-.3-.4-.9-.3-1.1.2-.5 1.4-1.5 2.3-2.3 2-.9-.3-.6-2-.4-3.7.2-2-.2-4-2.5-6-.4-.3-.9 0-1 .5-.2 2-1 3.4-2.2 4.8C5.8 8.6 4 11 4 15.2 4 19.7 7.6 23 12 23z"/></svg>';
  function toastStreak(n){ pushToast({kicker:'Daily streak', name:n+'-day streak', sub:'+10 XP', icon:FLAME}); }
  // Console test helper: run tmwToastTest() on any oftmw.com page to preview the toasts.
  window.tmwToastTest = function(){ toast('globetrotter'); setTimeout(function(){ toastLevel(4,'Insider'); }, 800); setTimeout(function(){ toastStreak(12); }, 1600); };
  function check(id){
    fetch(WORKER+'/member-stats?id='+encodeURIComponent(id),{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){
      if(!d) return;
      // achievements
      if(d.achievements){
        var now=Object.keys(d.achievements).filter(function(k){return d.achievements[k];});
        var key='tmw_ach_'+id, prev=null;
        try{ prev=JSON.parse(localStorage.getItem(key)||'null'); }catch(e){}
        if(!Array.isArray(prev)){ try{ localStorage.setItem(key,JSON.stringify(now)); }catch(e){} }
        else { var fresh=now.filter(function(k){ return prev.indexOf(k)<0; }); try{ localStorage.setItem(key,JSON.stringify(now)); }catch(e){} fresh.forEach(function(k,i){ setTimeout(function(){ toast(k); }, i*450); }); }
      }
      // level-ups
      if(typeof d.level==='number'){
        var lk='tmw_lvl_'+id, plvl=NaN; try{ plvl=parseInt(localStorage.getItem(lk),10); }catch(e){}
        if(isNaN(plvl)){ try{ localStorage.setItem(lk,String(d.level)); }catch(e){} }
        else if(d.level>plvl){ setTimeout(function(){ try{ localStorage.setItem(lk,String(d.level)); }catch(e){} toastLevel(d.level,d.tier); }, 200); }
        else if(d.level!==plvl){ try{ localStorage.setItem(lk,String(d.level)); }catch(e){} }
      }
      // daily-streak visit toast — once per calendar day, from day 2 onward
      var sk_streak=(d.stats&&d.stats.streak)||0;
      if(sk_streak>=2){
        var sd=new Date(), ymd=sd.getFullYear()+'-'+(sd.getMonth()+1)+'-'+sd.getDate(), stk='tmw_streak_toast_'+id, lastDay=null;
        try{ lastDay=localStorage.getItem(stk); }catch(e){}
        // Set the once-per-day gate INSIDE the timeout, together with the toast
        // — not before it. Otherwise a first page that navigates/redirects
        // within 600ms marks the day "shown" without the toast ever painting,
        // and every later page that day is then suppressed (the regression Jake
        // hit: streak toast missing on the first page visited). Now an
        // interrupted first page simply retries on the next page of the day.
        if(lastDay!==ymd){ setTimeout(function(){ try{ localStorage.setItem(stk,ymd); }catch(e){} toastStreak(sk_streak); }, 600); }
      }
    }).catch(function(){});
  }
  (function wait(t){ t=t||0; var m=window.$memberstackDom; if(m&&m.getCurrentMember){ m.getCurrentMember().then(function(r){ var mem=r&&r.data; if(mem&&mem.id) check(mem.id); }).catch(function(){}); return; } if(++t>40) return; setTimeout(function(){wait(t);},250); })();
})();
