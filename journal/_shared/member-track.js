/* member-track.js — identify a logged-in Memberstack member to the analytics
   event store (worker /event), once per page load. Lets a member browsing the
   journal OR the media-kit show up in Studio analytics as an identified user,
   now that login is universal across oftmw.com.

   Auth: no token in the client. The worker trusts first-party browser beacons by
   Origin (oftmw.com), which a browser can't forge cross-site. Sent via
   sendBeacon with a text/plain blob so it's a "simple" request (no CORS preflight).

   Self-contained: if the page didn't already load Memberstack (media-kit pages
   don't), this loads it with the same app + cookie config as journal-auth.js, so
   the universal login cookie identifies the member. Only fires when logged in. */
(function () {
  var MS_APP = 'app_cmoq79nvv002d0syef7wpel3c';   // same Memberstack app as the map + journal
  var WORKER = 'https://tmw.jake-ab7.workers.dev';

  try { window.memberstackConfig = window.memberstackConfig || { useCookies: true, setCookieOnRootDomain: true }; } catch (e) {}
  if (!document.querySelector('script[data-memberstack-app]')) {
    var s = document.createElement('script');
    s.setAttribute('data-memberstack-app', MS_APP);
    s.src = 'https://static.memberstack.com/scripts/v2/memberstack.js';
    document.head.appendChild(s);
  }

  var sent = false;
  function planOf(member) {
    var plans = (member && member.planConnections) || [];
    for (var i = 0; i < plans.length; i++) {
      var p = plans[i]; if (!p) continue;
      // Any active plan connection = a member (Pro). Mirrors journal-auth's
      // isPaid so the analytics `plan` column agrees with the site's Pro-gating
      // — including comped / hand-assigned plans that carry no payment object.
      if (p.active === true || p.status === 'ACTIVE') return 'paid';
    }
    return 'free';
  }
  function nameOf(member) {
    var cf = (member && member.customFields) || {};
    var n = [(cf['first-name'] || cf.firstName || cf.first || ''), (cf['last-name'] || cf.lastName || cf.last || '')].join(' ').trim();
    return n || null;
  }
  function send(member) {
    if (sent || !member || !member.id) return;
    sent = true;
    var payload = JSON.stringify({
      member_id: member.id,
      email: (member.auth && member.auth.email) || member.email || null,
      member_name: nameOf(member),
      plan: planOf(member),
      event_name: 'page_view',
      path: location.pathname,
      referrer: document.referrer || null,
      client_ts: Math.floor(Date.now() / 1000),
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(WORKER + '/event', new Blob([payload], { type: 'text/plain' }));
      } else {
        fetch(WORKER + '/event', { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      }
    } catch (e) {}
    // Hand the identity to the journal "reading now" heartbeat (journal-dock.js)
    // so the live feed shows this member's name, then fire an immediate ping.
    try {
      window.__tmwMember = { id: member.id, name: nameOf(member) || ((member.auth && member.auth.email) || ''), plan: planOf(member) };
      if (typeof window.__tmwPing === 'function') window.__tmwPing();
    } catch (e) {}
  }

  var tries = 0;
  var t = setInterval(function () {
    var m = window.$memberstackDom;
    if (m && m.getCurrentMember) {
      clearInterval(t);
      m.getCurrentMember().then(function (r) { send(r && r.data); }).catch(function () {});
    } else if (++tries > 120) {
      clearInterval(t);   // ~12s — Memberstack never loaded / not logged in
    }
  }, 100);
})();
