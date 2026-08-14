// ---------------------------------------------------------------------------
// Placement tracker — first-party view/click beacons for the banner ad carousel
// (ads.json) and the Partners of Tomorrow cards (partners.json), replacing
// Linkly. Views batch and flush on pagehide/visibility/idle so a page's many
// carousel impressions become one request; clicks flush immediately because the
// click may unload the page. Reads land in D1 (worker POST /track) and surface
// in the Studio's Placements tab (GET /placements).
//
// Public API:  window.tmwTrack.view(id, type, label)
//              window.tmwTrack.click(id, type, label)   // type: 'ad' | 'partner'
//              window.tmwTrack.act(id, type, label, surface)        // engaged, no click-out
//              window.tmwTrack.viewOnce(el, id, type, label, surface) // impression when on screen
//              window.tmwTrack.bindClick(anchorEl, id, type, label)  // convenience
// ---------------------------------------------------------------------------
(function () {
  // journal-dock.js already defines window.tmwTrack as a generic event FUNCTION.
  // We AUGMENT it with placement view/click (functions can hold properties) —
  // never clobber it and never bail early, or the object form's .view/.click
  // would be missing and callers (the ad carousel) would throw. Skip only if
  // we've already augmented.
  if (window.tmwTrack && window.tmwTrack._plc) return;   // real methods already installed
  var WORKER = 'https://tmw.jake-ab7.workers.dev';
  var queue = [];

  function flush() {
    if (!queue.length) return;
    var events = queue.splice(0, queue.length);
    var payload = JSON.stringify({ events: events });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(WORKER + '/track', new Blob([payload], { type: 'text/plain' }));
      } else {
        fetch(WORKER + '/track', { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(function () {});
      }
    } catch (_) {}
  }

  function push(ev) { queue.push(ev); if (queue.length >= 20) flush(); }

  // surface defaults to 'journal' (the on-site banner/partner). The Resend
  // newsletter counts via the worker's /r + /px, not this beacon.
  function view(id, type, label, surface) {
    if (!id) return;
    push({ id: id, type: type || 'ad', event: 'view', label: label || '', surface: surface || 'journal' });
  }
  // The middle tier of a client report: the project was ENGAGED WITH (its map
  // modal opened, its Atlas card expanded) without necessarily clicking out to
  // the client's own site. Batched like a view — it never navigates away.
  function act(id, type, label, surface) {
    if (!id) return;
    push({ id: id, type: type || 'project', event: 'act', label: label || '', surface: surface || 'journal' });
  }
  function click(id, type, label, surface) {
    if (!id) return;
    push({ id: id, type: type || 'ad', event: 'click', label: label || '', surface: surface || 'journal' });
    flush();  // the click may navigate away — don't wait for the batch timer
  }

  // Impressions on a scrolling surface (Atlas cards, map list rows) should count
  // when the thing is actually ON SCREEN, and once per element — otherwise a
  // long scroll inflates every client's numbers. One shared observer does it.
  var seen = new WeakSet(), io = null;
  function viewOnce(el, id, type, label, surface) {
    if (!el || !id || seen.has(el)) return;
    seen.add(el);
    if (!('IntersectionObserver' in window)) { view(id, type, label, surface); return; }
    if (!io) io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i]; if (!e.isIntersecting) continue;
        var d = e.target._tmwPlc; if (d) view(d.id, d.type, d.label, d.surface);
        io.unobserve(e.target);
      }
    }, { threshold: 0.5 });
    el._tmwPlc = { id: id, type: type || 'project', label: label || '', surface: surface || 'journal' };
    io.observe(el);
  }

  // Convenience: attach a click beacon to an <a> without swallowing its default
  // navigation. sendBeacon is fire-and-forget and safe during unload, so the
  // browser follows the href normally right after.
  function bindClick(el, id, type, label) {
    if (!el || el._tmwTracked) return;
    el._tmwTracked = true;
    el.addEventListener('click', function () { click(id, type, label); }, { capture: true });
    // auxclick covers middle-click / cmd-click "open in new tab".
    el.addEventListener('auxclick', function (e) { if (e.button === 1) click(id, type, label); }, { capture: true });
  }

  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
  setInterval(flush, 10000);  // safety net for long-lived sessions

  // Attach onto the existing tmwTrack (function or object), preserving whatever
  // journal-dock defined, so both window.tmwTrack(name,params) and
  // window.tmwTrack.view/.click work.
  var api = window.tmwTrack || {};
  api.view = view; api.act = act; api.click = click; api.bindClick = bindClick;
  api.viewOnce = viewOnce; api.flush = flush;
  api._plc = true;   // marks the real placement methods as installed (vs dock's no-op stubs)
  window.tmwTrack = api;
})();
