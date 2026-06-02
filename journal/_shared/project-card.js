/*
  Markets of Tomorrow — inline project card (journal ↔ database bridge).

  Renders a rich project card inside a journal article from a project slug. Reads
  the SAME data the map uses (projects-flat.json + intel.json), so the basics and
  the TMW Intelligence panel are identical to the project modal on the map.

  Embed (what the Studio inserts):
      <div class="tmw-project-card" data-project="olara"></div>

  Legacy map-embed iframes are auto-upgraded into cards:
      <iframe class="tmw-map-embed" src="https://map.oftmw.com/?project=olara">

  Loaded on journal post pages (injected by journal-dock.js). No-ops if the page
  has no embeds.
*/
(function () {
  'use strict';

  var MAP_URL      = 'https://map.oftmw.com';
  var PROJECTS_URL = MAP_URL + '/projects-flat.json';
  var INTEL_URL    = MAP_URL + '/intel.json';
  var LINKS_URL    = '/_shared/project-links.json';  // reverse map coverage: postSlug -> projectSlug

  // ── 1) Collect embeds (new cards + legacy iframes) ──────────────────────
  function collect() {
    var out = [];
    document.querySelectorAll('.tmw-project-card[data-project]').forEach(function (el) {
      if (el.getAttribute('data-tmw-done')) return;
      out.push({ el: el, slug: (el.getAttribute('data-project') || '').trim() });
    });
    document.querySelectorAll('iframe.tmw-map-embed').forEach(function (ifr) {
      var m = (ifr.getAttribute('src') || '').match(/[?&]project=([^&]+)/);
      if (!m) return;
      var holder = document.createElement('div');
      holder.className = 'tmw-project-card';
      ifr.parentNode.replaceChild(holder, ifr);
      out.push({ el: holder, slug: decodeURIComponent(m[1]).trim() });
    });
    return out;
  }

  // Embeds are collected inside hydrate() (below) so it can re-run when a
  // client-rendered post injects its body after this script loads.

  // ── 2) Helpers ──────────────────────────────────────────────────────────
  // Mirrors the map's pyStyleSlug / generate_pulse.py slugify so keys line up.
  function slugify(t) {
    return String(t || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-|-$/g, '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  // Serve migrated Wix images from our public R2 (drop CDN transform suffixes).
  var R2_PUBLIC = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev';
  function img(url) {
    if (!url) return '';
    var u = String(url);
    if (u.indexOf('static.wixstatic.com/media/') !== -1) {
      u = u.replace(/^https?:\/\/static\.wixstatic\.com\/media\//, R2_PUBLIC + '/wix/');
      u = u.split('/v1/')[0];
    }
    // Re-point any older worker-served /media URLs to the public R2 base.
    u = u.replace(/^https?:\/\/tmw\.jake-ab7\.workers\.dev\/media\//, R2_PUBLIC + '/');
    return u;
  }
  function firstType(rec) {
    var t = rec.PreferredType || rec.ProjectType || '';
    return String(t).split(/\s*[,/]\s*/)[0] || '';
  }
  var PHASES = ['Announced', 'Breaking Ground', 'Construction', 'Opening Soon', 'Now Open'];
  function phaseIndex(delivery) {
    var d = (delivery || '').toLowerCase();
    if (/now open|\bopen\b|complete|delivered|opened/.test(d)) return 4;
    if (/opening soon|topp|finish/.test(d)) return 3;
    if (/construction|building|underway|vertical|rising/.test(d)) return 2;
    if (/breaking ground|groundbreak|site work|foundation|excavat/.test(d)) return 1;
    return 0;
  }
  function yearOf(v) {
    var m = String(v || '').match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  }
  function progressPct(rec, entry) {
    var s = yearOf(rec.StartDate);
    var eYear = yearOf((entry && entry.delivery_date) || rec.DeliveryDate);
    if (!s || !eYear || eYear <= s) return null;
    var nowY = new Date().getFullYear() + (new Date().getMonth() / 12);
    var p = Math.round(((nowY - s) / (eYear - s)) * 100);
    return Math.max(3, Math.min(97, p));
  }

  // ── 3) Intelligence panel — faithful port of the map's 3 branches ───────
  function renderIntel(entry) {
    if (!entry || entry.estimate_years == null || isNaN(entry.estimate_years)) return '';
    var HEX = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5zm0 2.5L18 8v8l-6 3.75L6 16V8l6-3.5z"/></svg>';
    var badge = '<span class="pm-intel-badge">' + HEX + ' TMW Intelligence</span>';
    var source = entry.source || 'comparables';
    var estimateLabel = entry.estimate_label || ('~' + entry.estimate_years + ' years');

    if (source === 'completed') {
      var isSpecC = !!entry.dates_speculative;
      return '<div class="pm-intel">' +
        '<div class="pm-intel-head">' + badge +
          '<div class="pm-intel-title">' + (isSpecC ? 'Estimated Time to Complete' : 'Actual Time to Complete') + '</div>' +
          '<span class="pm-intel-confidence" data-conf="' + (isSpecC ? 'medium' : 'high') + '">' + (isSpecC ? 'TMW estimate' : 'Completed') + '</span>' +
        '</div>' +
        '<div class="pm-intel-estimate">' + esc(estimateLabel) + ' <span class="unit">to complete</span></div>' +
        '<div class="pm-intel-pattern">' + esc(entry.pattern_summary || '') + '</div>' +
        (isSpecC ? '<div class="pm-intel-disclaimer">Dates not developer-confirmed. TMW estimated the timeline based on observed activity; actuals can vary.</div>' : '') +
      '</div>';
    }
    if (source === 'known_date') {
      var isDay = (entry.precision === 'day');
      var isSpecK = !!entry.dates_speculative;
      var pill = isSpecK ? '<span class="pm-intel-confidence" data-conf="medium">TMW estimate</span>'
        : (isDay ? '<span class="pm-intel-confidence" data-conf="high">Developer announced</span>' : '');
      var disc = isSpecK ? 'TMW-estimated dates based on project type and stage — not a developer commitment. Confidence drops accordingly.'
        : (isDay ? "Based on the developer's announced opening date. Schedules can shift; we update this daily."
                 : "Estimate based on the project's targeted opening window. Schedules can shift; we update this daily.");
      return '<div class="pm-intel">' +
        '<div class="pm-intel-head">' + badge +
          '<div class="pm-intel-title">Estimated Time to Completion</div>' + pill +
        '</div>' +
        '<div class="pm-intel-estimate">' + esc(estimateLabel) + ' <span class="unit">to completion</span></div>' +
        '<div class="pm-intel-pattern">' + esc(entry.pattern_summary || '') + '</div>' +
        '<div class="pm-intel-disclaimer">' + disc + '</div>' +
      '</div>';
    }
    // comparables
    var conf = entry.confidence || 'medium';
    var confLabel = ({ high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' })[conf] || '';
    var range = (entry.range_low != null && entry.range_high != null && entry.range_low !== entry.range_high)
      ? ' <span class="range">(' + entry.range_low + '–' + entry.range_high + ' yrs)</span>' : '';
    var similars = (entry.comparables || []).slice(0, 3).map(function (c) {
      return '<a class="pm-intel-similar" href="' + MAP_URL + '/?project=' + encodeURIComponent(c.slug || '') + '" target="_blank" rel="noopener">' +
        '<div class="pm-intel-similar-name">' + esc(c.name || '') + '</div>' +
        '<div class="pm-intel-similar-loc">' + esc(c.location || '') + '</div>' +
        '<div class="pm-intel-similar-row"><span><b>' + esc(c.years) + '</b> yrs</span></div></a>';
    }).join('');
    var pattern = esc(entry.pattern_summary || '');
    if (entry.comparable_count != null) {
      pattern = pattern.replace(new RegExp('\\b' + entry.comparable_count + '\\b'), '<span class="pm-intel-highlight">' + entry.comparable_count + '</span>');
    }
    return '<div class="pm-intel">' +
      '<div class="pm-intel-head">' + badge +
        '<div class="pm-intel-title">Estimated Time to Completion</div>' +
        (confLabel ? '<span class="pm-intel-confidence" data-conf="' + conf + '">' + confLabel + '</span>' : '') +
      '</div>' +
      '<div class="pm-intel-estimate">' + esc(estimateLabel) + ' <span class="unit">to completion</span>' + range + '</div>' +
      (similars ? '<div class="pm-intel-similar-label">Similar Projects in TMW\'s Data</div><div class="pm-intel-similars">' + similars + '</div>' : '') +
      '<div class="pm-intel-pattern">' + pattern + '</div>' +
      '<div class="pm-intel-disclaimer">Pattern-based estimate, not a developer commitment. Actual timelines can vary by 6–18 months.</div>' +
    '</div>';
  }

  // ── 4) Card ─────────────────────────────────────────────────────────────
  function renderCard(rec, slug, entry) {
    var ph = phaseIndex(rec.Delivery);
    var pct = progressPct(rec, entry);
    var segs = PHASES.map(function (_, i) {
      return '<div class="pc-seg' + (i < ph ? ' done' : (i === ph ? ' cur' : '')) + '"></div>';
    }).join('');
    var phaseLabels = PHASES.map(function (p, i) {
      return '<span' + (i === ph ? ' class="on"' : '') + '>' + p + '</span>';
    }).join('');
    var stats = [];
    if (rec.Units) stats.push('<div class="pc-stat"><span class="n">' + esc(rec.Units) + '</span><span class="l">Units</span></div>');
    if (rec.Floors) stats.push('<div class="pc-stat"><span class="n">' + esc(rec.Floors) + '</span><span class="l">Floors</span></div>');
    if (rec.Keys) stats.push('<div class="pc-stat"><span class="n">' + esc(rec.Keys) + '</span><span class="l">Keys</span></div>');
    var firms = [];
    if (rec.Developer) firms.push('Developed by <b>' + esc(rec.Developer) + '</b>');
    if (rec.Architect) firms.push('Architecture by <b>' + esc(rec.Architect) + '</b>');
    // Start / delivery line. When a date is a TMW estimate (speculative) rather
    // than developer-confirmed, label it "Estimated to start/deliver" so readers
    // know it's our projection, not an announced date.
    var startY = yearOf(rec.StartDate);
    var delivY = (entry && entry.delivery_date && entry.delivery_date.slice(0, 4)) || yearOf(rec.DeliveryDate);
    var startSpec = String(rec.StartSpeculative) === '1' || !!(entry && entry.start_speculative);
    var delivSpec = String(rec.DeliverySpeculative) === '1' || !!(entry && entry.delivery_speculative);
    var dParts = [];
    if (startY) dParts.push(ph >= 1 ? ('Started ' + startY) : (startSpec ? ('Estimated to start ' + startY) : ('Starts ' + startY)));
    if (delivY) dParts.push(delivSpec ? ('Estimated to deliver ' + delivY) : ('Est. delivery ' + delivY));
    var delivLine = dParts.join(' · ');
    var subline = [esc(rec.City)]; var t = firstType(rec); if (t) subline.push(esc(t));

    return '' +
    '<div class="pc-media">' +
      (rec.ImageURL ? '<img src="' + esc(img(rec.ImageURL)) + '" alt="' + esc(rec.Title) + '" loading="lazy">' : '') +
      '<span class="pc-badge">Tracking</span>' +
      '<button class="pc-flyover" type="button" aria-label="See on the map"><span class="lbl">See on the map</span>' +
        '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
    '</div>' +
    '<div class="pc-body">' +
      '<h3 class="pc-name">' + esc(rec.Title) + '</h3>' +
      '<div class="pc-loc">' + subline.join(' · ') + '</div>' +
      (rec.Description ? '<p class="pc-desc">' + esc(rec.Description) + '</p>' : '') +
      '<div class="pc-status">' +
        '<div class="pc-status-top"><span class="pc-phase">' + esc(rec.Delivery || PHASES[ph]) + '</span>' + (pct != null ? '<span class="pc-pct">' + pct + '%</span>' : '') + '</div>' +
        '<div class="pc-track">' + segs + '</div>' +
        '<div class="pc-phases">' + phaseLabels + '</div>' +
        (delivLine ? '<div class="pc-delivery">' + delivLine + '</div>' : '') +
      '</div>' +
      (stats.length ? '<div class="pc-stats">' + stats.join('') + '</div>' : '') +
      (firms.length ? '<div class="pc-firms">' + firms.join(' · ') + '</div>' : '') +
      renderIntel(entry) +
      '<div class="pc-actions">' +
        '<a class="pc-btn primary" href="' + MAP_URL + '/?project=' + encodeURIComponent(slug) + '" target="_blank" rel="noopener">Learn more</a>' +
        (rec.OfficialWebsite ? '<a class="pc-btn ghost" href="' + esc(rec.OfficialWebsite) + '" target="_blank" rel="noopener">Visit site <svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg></a>' : '') +
      '</div>' +
    '</div>';
  }

  function wire(card, slug) {
    var fly = card.querySelector('.pc-flyover');
    if (fly) fly.addEventListener('click', function () { window.open(MAP_URL + '/?project=' + encodeURIComponent(slug), '_blank', 'noopener'); });
  }

  // ── 5) Styles (scoped under .tmw-pcard) ─────────────────────────────────
  function injectCSS() {
    if (document.getElementById('tmw-pcard-styles')) return;
    var css = [
      '.tmw-pcard{--g:#e6c574;--gs:#f0d68a;--grn:#1FDF67;--or:#f59e3c;--pp:#A78BFA;--cream:#ECEAE5;--mute:#8b958d;--mute2:#C2C9C3;',
        'font-family:"Inter",-apple-system,sans-serif; display:grid; grid-template-columns:minmax(0,44%) 1fr;',
        // Break out of the narrow article column to the full hero-image width
        // (the .article-cover is max-width:1240px with 28px padding = 1184px),
        // centered on the page. min() keeps it inside the viewport on mobile.
        'width:min(100vw - 56px, 1184px); margin:2em 0; margin-left:50%; transform:translateX(-50%);',
        'background:linear-gradient(180deg, rgba(22,26,22,.94), rgba(10,12,10,.97)); border:1px solid rgba(255,255,255,.16); border-radius:22px; overflow:hidden;',
        'box-shadow:0 40px 110px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05); color:var(--cream)}',
      '.article-body-content > .tmw-pcard + *{margin-top:0 !important}',
      '.tmw-pcard .pc-media{position:relative; min-height:380px; overflow:hidden; background:#0a0a0a}',
      '.tmw-pcard .pc-media img{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; margin:0; border-radius:0}',
      '.tmw-pcard .pc-media::after{content:""; position:absolute; inset:0; background:linear-gradient(90deg, transparent 60%, rgba(10,12,10,.5)); pointer-events:none}',
      '.tmw-pcard .pc-badge{position:absolute; top:18px; left:18px; z-index:2; font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:10px; letter-spacing:.18em; text-transform:uppercase; font-weight:700; color:var(--gs); padding:8px 14px; border-radius:999px; background:rgba(7,8,7,.5); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); border:1px solid rgba(230,197,116,.55)}',
      '.tmw-pcard .pc-flyover{position:absolute; top:16px; right:16px; z-index:2; width:38px; height:38px; border-radius:999px; display:flex; align-items:center; justify-content:center; cursor:pointer; background:rgba(7,8,7,.55); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,.16); color:#fff; transition:all .18s; padding:0}',
      '.tmw-pcard .pc-flyover:hover{border-color:var(--g); color:var(--gs); transform:translateY(-1px)}',
      '.tmw-pcard .pc-flyover svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2}',
      '.tmw-pcard .pc-flyover .lbl{position:absolute; right:calc(100% + 8px); top:50%; transform:translateY(-50%); font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--cream); background:rgba(7,8,7,.75); padding:5px 9px; border-radius:6px; white-space:nowrap; opacity:0; transition:opacity .18s; pointer-events:none}',
      '.tmw-pcard .pc-flyover:hover .lbl{opacity:1}',
      '.tmw-pcard .pc-body{padding:30px 34px}',
      '.tmw-pcard .pc-name{font-family:"Fraunces",Georgia,serif; font-weight:600; font-size:clamp(28px,3.4vw,46px); line-height:1; letter-spacing:-.02em; color:#fff; margin:0}',
      '.tmw-pcard .pc-loc{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--mute2); margin-top:13px}',
      '.tmw-pcard .pc-desc{font-size:14.5px; line-height:1.6; color:var(--mute2); font-weight:300; margin:16px 0 0; max-width:48ch}',
      // The article CSS drop-caps the first <p>; .pc-desc is a first-of-type <p>
      // inside .pc-body, so it inherits the giant first letter. Reset it.
      '.tmw-pcard .pc-desc::first-letter{font-size:inherit !important; float:none !important; font-family:inherit !important; font-weight:inherit !important; padding:0 !important; line-height:inherit !important; color:inherit !important}',
      '.tmw-pcard .pc-status{margin-top:22px}',
      '.tmw-pcard .pc-status-top{display:flex; align-items:center; justify-content:space-between; margin-bottom:9px}',
      '.tmw-pcard .pc-phase{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; font-weight:700; color:var(--or)}',
      '.tmw-pcard .pc-pct{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:10.5px; color:var(--mute2)}',
      '.tmw-pcard .pc-track{display:flex; gap:5px}',
      '.tmw-pcard .pc-seg{flex:1; height:6px; border-radius:999px; background:rgba(255,255,255,.08); position:relative; overflow:hidden}',
      '.tmw-pcard .pc-seg.done{background:linear-gradient(90deg,#c9a558,var(--g))}',
      '.tmw-pcard .pc-seg.cur{background:rgba(245,158,60,.18)}',
      '.tmw-pcard .pc-seg.cur::after{content:""; position:absolute; left:0; top:0; bottom:0; width:45%; border-radius:999px; background:linear-gradient(90deg,var(--g),var(--or)); box-shadow:0 0 10px rgba(245,158,60,.6)}',
      '.tmw-pcard .pc-phases{display:flex; justify-content:space-between; margin-top:8px; font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:8px; letter-spacing:.05em; text-transform:uppercase; color:var(--mute)}',
      '.tmw-pcard .pc-phases span.on{color:var(--or)}',
      '.tmw-pcard .pc-delivery{font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--mute2); margin-top:10px}',
      '.tmw-pcard .pc-stats{display:flex; gap:30px; margin-top:20px}',
      '.tmw-pcard .pc-stat .n{font-family:"Fraunces",Georgia,serif; font-weight:600; font-size:28px; color:#fff; line-height:1; letter-spacing:-.02em}',
      '.tmw-pcard .pc-stat .l{display:block; font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:9px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); margin-top:6px}',
      '.tmw-pcard .pc-firms{font-size:13px; color:var(--mute2); margin-top:18px; font-weight:300}',
      '.tmw-pcard .pc-firms b{color:var(--cream); font-weight:600}',
      // TMW Intelligence — verbatim from the map's project modal (.pm-intel-*)
      '.tmw-pcard .pm-intel{margin:22px 0 0; padding:18px; background:rgba(167,139,250,.06); border:1px solid rgba(167,139,250,.18); border-radius:12px}',
      '.tmw-pcard .pm-intel-head{display:flex; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap}',
      '.tmw-pcard .pm-intel-badge{display:inline-flex; align-items:center; gap:6px; background:rgba(167,139,250,.14); border:1px solid rgba(167,139,250,.32); color:#A78BFA; padding:4px 10px; border-radius:12px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em}',
      '.tmw-pcard .pm-intel-badge svg{width:11px; height:11px; fill:currentColor}',
      '.tmw-pcard .pm-intel-confidence{font-size:10px; color:rgba(255,255,255,.5); text-transform:uppercase; letter-spacing:.08em; font-weight:600}',
      '.tmw-pcard .pm-intel-confidence[data-conf="high"]{color:#1FDF67}',
      '.tmw-pcard .pm-intel-confidence[data-conf="medium"]{color:#A78BFA}',
      '.tmw-pcard .pm-intel-confidence[data-conf="low"]{color:rgba(255,255,255,.45)}',
      '.tmw-pcard .pm-intel-title{font-size:13px; font-weight:700; color:#fff}',
      '.tmw-pcard .pm-intel-estimate{font-size:28px; font-weight:700; letter-spacing:-.02em; color:#A78BFA; margin-bottom:14px; line-height:1.05}',
      '.tmw-pcard .pm-intel-estimate .unit{font-size:14px; color:rgba(255,255,255,.62); font-weight:500; margin-left:6px}',
      '.tmw-pcard .pm-intel-estimate .range{font-size:13px; color:rgba(255,255,255,.4); font-weight:500}',
      '.tmw-pcard .pm-intel-similar-label{font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:#A78BFA; font-weight:700; margin-bottom:10px; padding-top:14px; border-top:1px solid rgba(167,139,250,.18)}',
      '.tmw-pcard .pm-intel-similars{display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-bottom:14px}',
      '.tmw-pcard .pm-intel-similar{background:rgba(0,0,0,.3); border:1px solid rgba(167,139,250,.16); border-radius:8px; padding:11px 12px; cursor:pointer; transition:all .15s; text-decoration:none; color:inherit; display:block}',
      '.tmw-pcard .pm-intel-similar:hover{border-color:rgba(167,139,250,.4); background:rgba(0,0,0,.5)}',
      '.tmw-pcard .pm-intel-similar-name{font-size:12px; font-weight:600; margin-bottom:2px; color:#fff; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}',
      '.tmw-pcard .pm-intel-similar-loc{font-size:10px; color:rgba(255,255,255,.55); margin-bottom:9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}',
      '.tmw-pcard .pm-intel-similar-row{display:flex; justify-content:flex-end; font-size:11px; color:rgba(255,255,255,.55); padding-top:7px; border-top:1px solid rgba(167,139,250,.1)}',
      '.tmw-pcard .pm-intel-similar-row b{color:#fff; font-weight:700}',
      '.tmw-pcard .pm-intel-pattern{background:rgba(167,139,250,.08); border:1px solid rgba(167,139,250,.22); border-radius:8px; padding:12px 14px; font-size:12px; line-height:1.55; color:rgba(255,255,255,.7)}',
      '.tmw-pcard .pm-intel-pattern .pm-intel-highlight{color:#A78BFA; font-weight:700}',
      '.tmw-pcard .pm-intel-disclaimer{font-size:10px; color:rgba(255,255,255,.4); margin-top:12px; font-style:italic; line-height:1.5}',
      '.tmw-pcard .pc-actions{display:flex; gap:12px; margin-top:22px; flex-wrap:wrap}',
      '.tmw-pcard .pc-btn{display:inline-flex; align-items:center; gap:8px; font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:11px; letter-spacing:.12em; text-transform:uppercase; font-weight:700; padding:13px 22px; border-radius:11px; text-decoration:none; cursor:pointer; transition:all .18s}',
      '.tmw-pcard .pc-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2.2}',
      '.tmw-pcard .pc-btn.primary{background:linear-gradient(180deg,var(--gs),var(--g)); color:#2a1f06; box-shadow:0 8px 26px rgba(230,197,116,.4)}',
      '.tmw-pcard .pc-btn.primary:hover{transform:translateY(-2px); box-shadow:0 12px 34px rgba(240,214,138,.55)}',
      '.tmw-pcard .pc-btn.ghost{background:rgba(255,255,255,.04); color:var(--cream); border:1px solid rgba(255,255,255,.16)}',
      '.tmw-pcard .pc-btn.ghost:hover{border-color:var(--g); color:#fff}',
      // Tighter vertical rhythm so the card stays wide & shallow, not tall.
      '.tmw-pcard .pc-body{padding:24px 30px}.tmw-pcard .pc-desc{margin-top:11px}.tmw-pcard .pc-status{margin-top:14px}.tmw-pcard .pc-stats{margin-top:14px}.tmw-pcard .pc-firms{margin-top:12px}.tmw-pcard .pm-intel{margin-top:14px;padding:15px 16px}.tmw-pcard .pm-intel-head{margin-bottom:10px}.tmw-pcard .pm-intel-estimate{margin-bottom:9px}.tmw-pcard .pc-actions{margin-top:15px}',
      '@media(max-width:720px){.tmw-pcard{grid-template-columns:1fr}.tmw-pcard .pc-media{min-height:240px}.tmw-pcard .pc-media::after{background:linear-gradient(180deg, transparent 55%, rgba(10,12,10,.5))}.tmw-pcard .pc-body{padding:24px 22px}.tmw-pcard .pm-intel-similars{grid-template-columns:1fr}}'
    ].join('');
    var st = document.createElement('style'); st.id = 'tmw-pcard-styles'; st.textContent = css; document.head.appendChild(st);
  }

  // ── 6) Fetch + render ───────────────────────────────────────────────────
  // Cache-bust per-minute so a freshly-published project resolves here within
  // ~60s instead of being pinned to a stale copy (force-cache used to hide the
  // card for any project added after the visitor last cached projects-flat).
  function fetchJson(u) {
    var bust = (u.indexOf('?') === -1 ? '?' : '&') + 'v=' + Math.floor(Date.now() / 60000);
    return fetch(u + bust, { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  // Auto-link from the map's reverse coverage when the article has no manual
  // embed: look up the current post slug in project-links.json and append a card
  // at the end of the article. A manual Studio link always takes precedence.
  function currentPostSlug() {
    var m = location.pathname.match(/\/post\/([^\/]+)\/?$/);
    if (m) return decodeURIComponent(m[1]);
    try { var q = new URLSearchParams(location.search).get('slug'); return q ? decodeURIComponent(q) : ''; } catch (e) { return ''; }
  }
  function autoLink(embeds) {
    if (embeds.length) return Promise.resolve();
    if (document.querySelector('.tmw-project-card[data-tmw-auto]')) return Promise.resolve(); // already auto-linked
    var body = document.querySelector('.article-body-content');
    var slug = currentPostSlug();
    if (!body || !slug) return Promise.resolve();
    return fetchJson(LINKS_URL).then(function (links) {
      var proj = links && links[slug];
      if (!proj) return;
      var div = document.createElement('div');
      div.className = 'tmw-project-card'; div.setAttribute('data-project', proj); div.setAttribute('data-tmw-auto', '');
      body.appendChild(div);
      embeds.push({ el: div, slug: proj });
    });
  }

  // Fetch the map data once per page, reuse across hydrate() runs.
  var _dataPromise = null;
  function loadData() {
    if (!_dataPromise) _dataPromise = Promise.all([fetchJson(PROJECTS_URL), fetchJson(INTEL_URL)]);
    return _dataPromise;
  }

  // Collect embeds and render their cards. Idempotent: already-rendered cards
  // carry data-tmw-done and are skipped, so this is safe to run more than once.
  function hydrate() {
    var embeds = collect();
    return autoLink(embeds).then(function () {
      if (!embeds.length) return;
      injectCSS();
      return loadData().then(function (res) {
        var rows = res[0] || [], intel = (res[1] && res[1].projects) || {};
        if (!Array.isArray(rows)) rows = rows.projects || rows.rows || [];
        var bySlug = {};
        rows.forEach(function (r) { var s = slugify(r.Title || r.Name || ''); if (s && !bySlug[s]) bySlug[s] = r; });
        embeds.forEach(function (e) {
          if (e.el.getAttribute('data-tmw-done')) return;
          var rec = bySlug[e.slug];
          if (!rec) { e.el.style.display = 'none'; return; }
          e.el.style.display = '';
          e.el.setAttribute('data-tmw-done', '1');
          e.el.className = 'tmw-pcard';
          e.el.innerHTML = renderCard(rec, e.slug, intel[e.slug]);
          wire(e.el, e.slug);
        });
      });
    });
  }

  hydrate();
  // Client-rendered post pages (/post/?slug=…) inject the article body — with
  // its project-card embed — AFTER this script runs. post.js dispatches
  // 'tmw:article-ready' once the body is in the DOM, so we re-hydrate then.
  document.addEventListener('tmw:article-ready', hydrate);
})();
