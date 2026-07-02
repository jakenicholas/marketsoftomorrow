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
//              window.tmwTrack.bindClick(anchorEl, id, type, label)  // convenience
// ---------------------------------------------------------------------------
(function () {
  if (window.tmwTrack) return;
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
  function click(id, type, label, surface) {
    if (!id) return;
    push({ id: id, type: type || 'ad', event: 'click', label: label || '', surface: surface || 'journal' });
    flush();  // the click may navigate away — don't wait for the batch timer
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

  window.tmwTrack = { view: view, click: click, bindClick: bindClick, flush: flush };
})();
