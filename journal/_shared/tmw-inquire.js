/* ===================================================================
   tmw-inquire.js, the lead-capture front door.

   The whole referral thesis: TMW's audience drives real transactions
   (condos, club memberships, homes) but people see a post on Instagram
   and run STRAIGHT to the developer, cutting TMW out. This makes them
   run through us instead, a "Request info / Join the interest list"
   modal on our own project pages that captures the buyer as a
   first-party, timestamped lead (our attribution evidence), posts to
   the worker /lead endpoint, notifies the TMW backend, and (when we
   have the partner's email) forwards the referral to the developer.

   Usage:
     • Auto-injects a "Request info" CTA on /projects/<slug>/ pages.
     • Any element with [data-tmw-inquire] opens it (reads
       data-project-slug / data-project-title / data-partner-email /
       data-intent / data-source off the trigger, or the opts arg).
     • window.tmwInquire.open({ project_slug, project_title, ... }).
     • #inquire hash or ?inquire=1 auto-opens (deep-linkable from IG).
   =================================================================== */
(function () {
  if (window.tmwInquire) return;
  var WORKER = 'https://tmw.jake-ab7.workers.dev';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function ensureCss() {
    if (document.getElementById('tmw-inq-css')) return;
    var css = [
      /* pointer-events:none while closed, otherwise the invisible full-screen
         scrim keeps eating every click on the page and nothing is clickable
         until a reload. .on flips it back to auto so the modal is interactive. */
      '.tmw-inq-scrim{position:fixed;inset:0;z-index:2147482000;background:rgba(4,4,6,.72);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .25s ease;display:flex;align-items:center;justify-content:center;padding:20px}',
      '.tmw-inq-scrim.on{opacity:1;pointer-events:auto}',
      '.tmw-inq{width:min(430px,100%);max-height:92vh;overflow:auto;background:#0d0f0d;border:1px solid rgba(255,255,255,.12);border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.6);transform:translateY(14px) scale(.98);opacity:0;transition:transform .3s cubic-bezier(.2,.9,.3,1),opacity .3s;font-family:Inter,-apple-system,system-ui,sans-serif;color:#ECEAE5}',
      '.tmw-inq-scrim.on .tmw-inq{transform:none;opacity:1}',
      '.tmw-inq-hd{position:relative;padding:26px 26px 4px}',
      '.tmw-inq-x{position:absolute;top:16px;right:16px;width:32px;height:32px;border:0;background:transparent;color:#8b8f96;cursor:pointer;font-size:20px;line-height:1;border-radius:8px}',
      '.tmw-inq-x:hover{color:#fff}',
      '.tmw-inq-eye{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#B9A6FF;font-weight:700;margin-bottom:10px}',
      '.tmw-inq-h{font-family:Fraunces,Georgia,serif;font-size:23px;font-weight:600;line-height:1.12;letter-spacing:-.01em;margin:0}',
      '.tmw-inq-sub{font-size:13.5px;color:#9AA39C;line-height:1.5;margin:9px 0 0}',
      '.tmw-inq-bd{padding:18px 26px 26px;display:flex;flex-direction:column;gap:11px}',
      '.tmw-inq input,.tmw-inq textarea{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.14);border-radius:12px;color:#fff;font:15px/1.4 inherit;padding:13px 15px;outline:none;transition:border-color .15s}',
      '.tmw-inq input:focus,.tmw-inq textarea:focus{border-color:#A78BFA}',
      '.tmw-inq input::placeholder,.tmw-inq textarea::placeholder{color:#7b847c}',
      '.tmw-inq textarea{resize:vertical;min-height:64px}',
      '.tmw-inq-row{display:flex;gap:11px}.tmw-inq-row>*{flex:1;min-width:0}',
      '.tmw-inq-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0}',
      '.tmw-inq-go{width:100%;height:52px;border:0;border-radius:13px;background:linear-gradient(135deg,#A78BFA,#8b6ff0);color:#0d0618;font:800 13px/1 Inter,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;box-shadow:0 0 24px rgba(167,139,250,.35);transition:filter .15s,transform .12s;margin-top:2px}',
      '.tmw-inq-go:hover{filter:brightness(1.08)}.tmw-inq-go:active{transform:scale(.99)}.tmw-inq-go:disabled{opacity:.6;cursor:wait}',
      '.tmw-inq-fine{font-size:11px;color:#6c706c;line-height:1.5;text-align:center;margin-top:2px}',
      '.tmw-inq-err{font-size:12.5px;color:#ff8a8a;min-height:16px}',
      '.tmw-inq-done{padding:34px 30px 40px;text-align:center}',
      '.tmw-inq-done .ok{width:52px;height:52px;margin:0 auto 16px;border-radius:50%;background:rgba(31,223,103,.14);border:1.5px solid rgba(31,223,103,.6);display:flex;align-items:center;justify-content:center;color:#42EB81}',
      '.tmw-inq-done .ok svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}',
      '.tmw-inq-done h3{font-family:Fraunces,Georgia,serif;font-size:21px;font-weight:600;margin:0 0 8px}',
      '.tmw-inq-done p{font-size:14px;color:#9AA39C;line-height:1.55;margin:0;max-width:34ch;margin-left:auto;margin-right:auto}',
      /* the auto-injected CTA on project pages (base, used when not in the grid) */
      '.tmw-inq-cta{display:inline-flex;align-items:center;gap:8px;font-family:Inter,-apple-system,sans-serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;padding:13px 22px;border-radius:11px;text-decoration:none;cursor:pointer;border:1px solid rgba(167,139,250,.5);background:rgba(167,139,250,.12);color:#fff;box-shadow:0 6px 22px rgba(167,139,250,.3),0 0 30px rgba(167,139,250,.22);transition:all .18s}',
      '.tmw-inq-cta:hover{background:rgba(167,139,250,.2);transform:translateY(-1px);box-shadow:0 8px 28px rgba(167,139,250,.5)}',
      '.tmw-inq-cta svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2.2}',
      /* ── Project-page CTA row normalized to a uniform 2x2 grid ──
         Row 1: Request info + Dive Deeper. Row 2: Share + Watch. Every button
         gets the same size/font/all-caps/radius, no text wrapping. Overrides the
         static page's per-button styles so all four match without regenerating pages. */
      '.cta-row.tmw-cta-2x2{display:grid !important;grid-template-columns:1fr 1fr;gap:10px;max-width:440px;align-items:stretch}',
      '.cta-row.tmw-cta-2x2>*{box-sizing:border-box;height:52px !important;width:auto !important;min-width:0 !important;flex:none !important;margin:0 !important;padding:0 12px !important;font-family:Inter,-apple-system,system-ui,sans-serif !important;font-size:11.5px !important;font-weight:700 !important;letter-spacing:.11em !important;text-transform:uppercase !important;line-height:1 !important;border-radius:11px !important;white-space:nowrap !important;display:inline-flex !important;align-items:center !important;justify-content:center !important;gap:8px !important;animation:none !important;text-decoration:none;cursor:pointer;overflow:hidden}',
      '.cta-row.tmw-cta-2x2>* svg{width:14px !important;height:14px !important;flex-shrink:0}',
      '.cta-row.tmw-cta-2x2>* .btn-share-tooltip{text-transform:none;letter-spacing:0}',
      /* secondary trio (dive / share / watch): uniform dark hairline pill */
      '.cta-row.tmw-cta-2x2 .btn-dive,.cta-row.tmw-cta-2x2 .btn-share,.cta-row.tmw-cta-2x2 .btn-watch{background:rgba(255,255,255,.06) !important;border:1px solid rgba(255,255,255,.14) !important;color:#fff !important;box-shadow:none !important}',
      '.cta-row.tmw-cta-2x2 .btn-dive:hover,.cta-row.tmw-cta-2x2 .btn-share:hover,.cta-row.tmw-cta-2x2 .btn-watch:hover{background:rgba(255,255,255,.11) !important;transform:none !important}',
      /* primary (request info): the purple money button, same geometry */
      '.cta-row.tmw-cta-2x2 .tmw-inq-cta{background:linear-gradient(135deg,rgba(167,139,250,.24),rgba(139,111,240,.16)) !important;border:1px solid rgba(167,139,250,.6) !important;color:#fff !important;box-shadow:0 6px 22px rgba(167,139,250,.28),0 0 30px rgba(167,139,250,.2) !important}',
      '.cta-row.tmw-cta-2x2 .tmw-inq-cta:hover{background:linear-gradient(135deg,rgba(167,139,250,.34),rgba(139,111,240,.24)) !important;transform:translateY(-1px)}',
      '@media(prefers-reduced-motion:reduce){.tmw-inq,.tmw-inq-scrim{transition:opacity .15s}.tmw-inq{transform:none}}'
    ].join('');
    var s = document.createElement('style'); s.id = 'tmw-inq-css'; s.textContent = css; document.head.appendChild(s);
  }

  var _scrim = null, _ctx = {};
  function utmParams() {
    try {
      var p = new URLSearchParams(location.search), o = {};
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) { if (p.get(k)) o[k] = p.get(k); });
      return Object.keys(o).length ? o : null;
    } catch (e) { return null; }
  }
  function inferSource() {
    try {
      var p = new URLSearchParams(location.search);
      if (p.get('utm_source')) return p.get('utm_source');
      var r = (document.referrer || '').toLowerCase();
      if (/instagram|ig\b/.test(r)) return 'instagram';
      if (/facebook|fb\./.test(r)) return 'facebook';
      if (/t\.co|twitter|x\.com/.test(r)) return 'x';
      if (/linkedin/.test(r)) return 'linkedin';
      if (/tiktok/.test(r)) return 'tiktok';
      if (/google|bing|duckduck/.test(r)) return 'search';
      if (/\/post\//.test(location.pathname)) return 'article';
    } catch (e) {}
    return null;
  }

  function bodyMarkup() {
    return '<div class="tmw-inq-hd"><button class="tmw-inq-x" type="button" aria-label="Close">×</button>' +
      '<div class="tmw-inq-eye" data-eye>Markets of Tomorrow</div>' +
      '<h2 class="tmw-inq-h" data-h>Request information</h2>' +
      '<p class="tmw-inq-sub" data-sub>Tell us where to send pricing, availability, and private-tour details.</p></div>' +
      '<form class="tmw-inq-bd" novalidate>' +
      '<input class="tmw-inq-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<input data-f="name" type="text" placeholder="Full name" autocomplete="name" required>' +
      '<input data-f="email" type="email" placeholder="Email" autocomplete="email" inputmode="email">' +
      '<input data-f="phone" type="tel" placeholder="Phone" autocomplete="tel" inputmode="tel">' +
      '<textarea data-f="message" placeholder="Anything specific? Budget, timeline, unit size… (optional)"></textarea>' +
      '<div class="tmw-inq-err" data-err></div>' +
      '<button class="tmw-inq-go" type="submit">Request info</button>' +
      '<p class="tmw-inq-fine">We’ll connect you with the team behind this project. No spam.</p>' +
      '</form>';
  }
  // (Re)render the form into the dialog and wire it. Called on EVERY open so a
  // fresh form is guaranteed — after a successful submit the dialog holds the
  // "you're on the list" state, and reopening must not crash on a missing form.
  function renderBody() {
    var inq = _scrim.querySelector('.tmw-inq');
    inq.innerHTML = bodyMarkup();
    inq.querySelector('.tmw-inq-x').addEventListener('click', close);
    inq.querySelector('form').addEventListener('submit', submit);
  }
  function build() {
    ensureCss();
    _scrim = document.createElement('div');
    _scrim.className = 'tmw-inq-scrim';
    _scrim.innerHTML = '<div class="tmw-inq" role="dialog" aria-modal="true" aria-label="Request information"></div>';
    document.body.appendChild(_scrim);
    _scrim.addEventListener('click', function (e) { if (e.target === _scrim) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && _scrim && _scrim.classList.contains('on')) close(); });
    renderBody();
  }

  function open(opts) {
    opts = opts || {};
    if (!_scrim) build(); else renderBody();   // always a fresh form
    _ctx = {
      project_slug: opts.project_slug || '',
      project_title: opts.project_title || '',
      partner: opts.partner || '',
      partner_email: opts.partner_email || '',
      intent: opts.intent || 'info',
      source: opts.source || inferSource() || '',   // channel: instagram/facebook/search/…
      surface: opts.surface || '',                  // where they clicked: project/article
    };
    var proj = _ctx.project_title || '';
    var eye = _scrim.querySelector('[data-eye]'), h = _scrim.querySelector('[data-h]'), sub = _scrim.querySelector('[data-sub]');
    if (_ctx.intent === 'interest-list') {
      eye.textContent = proj || 'Markets of Tomorrow';
      h.textContent = proj ? 'Join the ' + proj + ' interest list' : 'Join the interest list';
      sub.textContent = 'First access to pricing, availability, and private tours, straight from the source.';
      _scrim.querySelector('.tmw-inq-go').textContent = 'Join the list';
    } else if (_ctx.intent === 'tour') {
      eye.textContent = proj || 'Markets of Tomorrow';
      h.textContent = proj ? 'Book a private tour of ' + proj : 'Book a private tour';
      sub.textContent = 'Tell us how to reach you and we’ll arrange it with the team.';
      _scrim.querySelector('.tmw-inq-go').textContent = 'Request a tour';
    } else {
      eye.textContent = proj || 'Markets of Tomorrow';
      h.textContent = proj ? 'Request information on ' + proj : 'Request information';
      sub.textContent = 'Tell us where to send pricing, availability, and private-tour details.';
      _scrim.querySelector('.tmw-inq-go').textContent = 'Request info';
    }
    document.documentElement.style.overflow = 'hidden';
    _scrim.classList.add('on');
    setTimeout(function () { try { _scrim.querySelector('[data-f="name"]').focus(); } catch (e) {} }, 220);
    try { if (window.tmwTrack) window.tmwTrack('inquire_open', { project: _ctx.project_slug, source: _ctx.source }); } catch (e) {}
  }
  function close() {
    if (!_scrim) return;
    _scrim.classList.remove('on');
    document.documentElement.style.overflow = '';
  }

  function submit(e) {
    e.preventDefault();
    var form = e.currentTarget, err = _scrim.querySelector('[data-err]');
    var get = function (k) { var el = form.querySelector('[data-f="' + k + '"]'); return el ? el.value.trim() : ''; };
    var name = get('name'), email = get('email'), phone = get('phone');
    if (!name) { err.textContent = 'Please add your name.'; return; }
    if (!email && !phone) { err.textContent = 'Add an email or a phone so the team can reach you.'; return; }
    err.textContent = '';
    var btn = form.querySelector('.tmw-inq-go'); btn.disabled = true; var orig = btn.textContent; btn.textContent = 'Sending…';
    var payload = {
      name: name, email: email, phone: phone, message: get('message'),
      project_slug: _ctx.project_slug, project_title: _ctx.project_title,
      partner: _ctx.partner, partner_email: _ctx.partner_email,
      intent: _ctx.intent, source: _ctx.source, surface: _ctx.surface, source_url: location.href, utm: utmParams(),
      hp: (form.querySelector('[name="website"]') || {}).value || ''
    };
    fetch(WORKER + '/lead', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { throw new Error(j.error || 'Something went wrong.'); }); })
      .then(function () {
        try { if (window.tmwTrack) window.tmwTrack('inquire_submit', { project: _ctx.project_slug, source: _ctx.source, intent: _ctx.intent }); } catch (e) {}
        var inq = _scrim.querySelector('.tmw-inq');
        inq.innerHTML =
          '<button class="tmw-inq-x" type="button" aria-label="Close">×</button>' +
          '<div class="tmw-inq-done"><div class="ok"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></div>' +
          '<h3>You’re on the list.</h3><p>The team behind ' + (esc(_ctx.project_title) || 'this project') + ' will reach out with pricing and tour details. Keep an eye on your inbox.</p></div>';
        inq.querySelector('.tmw-inq-x').addEventListener('click', close);
      })
      .catch(function (ex) { err.textContent = ex.message || 'Something went wrong. Try again.'; btn.disabled = false; btn.textContent = orig; });
  }

  // Wire any [data-tmw-inquire] trigger (buttons/links in articles or custom placements).
  function wireTriggers(root) {
    (root || document).querySelectorAll('[data-tmw-inquire]').forEach(function (el) {
      if (el.__tmwInqWired) return; el.__tmwInqWired = true;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        open({
          project_slug: el.getAttribute('data-project-slug') || '',
          project_title: el.getAttribute('data-project-title') || '',
          partner: el.getAttribute('data-partner') || '',
          partner_email: el.getAttribute('data-partner-email') || '',
          intent: el.getAttribute('data-intent') || 'info',
          source: el.getAttribute('data-source') || ''
        });
      });
    });
  }

  // Auto-inject a CTA on /projects/<slug>/ pages so every IG link that lands here
  // has the front door, with no page regeneration. Reads the project title from
  // the page, the slug from the URL, and an optional partner email from a meta tag
  // (<meta name="tmw:partner-email" content="sales@developer.com">) TMW can set per pilot.
  function autoInjectProject() {
    var m = location.pathname.match(/^\/projects\/([^\/]+)\/?$/);
    if (!m) return;
    ensureCss();
    var slug = decodeURIComponent(m[1]);
    var titleEl = document.querySelector('.pp-name, .pp-hero h1, h1');
    var title = (titleEl ? titleEl.textContent : document.title.replace(/\s*[—|].*$/, '')).trim();
    var pe = document.querySelector('meta[name="tmw:partner-email"]');
    var opts = { project_slug: slug, project_title: title, partner_email: (pe ? pe.getAttribute('content') : '') || '', intent: 'interest-list', surface: 'project' };
    var cta = document.createElement('button');
    cta.type = 'button'; cta.className = 'tmw-inq-cta';
    cta.innerHTML = 'Request info <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    cta.addEventListener('click', function () { open(opts); });
    var row = document.querySelector('.cta-row');
    if (row && !row.__tmwInq) {
      row.__tmwInq = true;
      row.insertBefore(cta, row.firstChild);
      // Normalize the row to the uniform 2x2 grid and give the icon-only Share
      // button a visible label so all four buttons read the same.
      row.classList.add('tmw-cta-2x2');
      var share = row.querySelector('.btn-share');
      if (share && !share.querySelector('.tmw-cta-lbl')) {
        var lbl = document.createElement('span'); lbl.className = 'tmw-cta-lbl'; lbl.textContent = 'Share';
        var firstSvg = share.querySelector('svg');
        if (firstSvg && firstSvg.nextSibling) share.insertBefore(lbl, firstSvg.nextSibling); else share.appendChild(lbl);
      }
    } else if (!row) {
      // No CTA row on this template, float a pill bottom-center above the dock.
      cta.style.cssText += ';position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:9000';
      document.body.appendChild(cta);
    }
    // Deep-link: IG links can point at /projects/<slug>/?inquire=1 or #inquire to auto-open.
    try {
      var wantOpen = /(^|[?&])inquire=1/.test(location.search) || location.hash === '#inquire';
      if (wantOpen) setTimeout(function () { open(opts); }, 400);
    } catch (e) {}
  }

  // (The generic end-of-article CTA was removed: many articles cover things
  // with nothing to request — a new airport, a restaurant. Request Info now
  // lives on each linked-project card inside articles, which are real database
  // projects, plus the project pages and the map modal.)

  function boot() { ensureCss(); wireTriggers(document); autoInjectProject(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.tmwInquire = { open: open, close: close, wire: wireTriggers };
})();
