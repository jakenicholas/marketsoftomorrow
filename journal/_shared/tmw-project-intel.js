/* ------------------------------------------------------------------
   TMW project intelligence — ported from the map (index.html) so the
   journal search hero renders the IDENTICAL construction timeline and
   TMW Intelligence panel. Same math, same markup, same look.
   Exposes window.TMWIntel = { renderTimeline, loadIntel, renderIntel }.
-------------------------------------------------------------------*/
(function () {
  'use strict';
  if (window.TMWIntel) return;

  // ── constants (verbatim from the map) ──────────────────────────────
  var ASSUMED_YEARS_BEFORE_DELIVERY = {
    'announced': 4.0, 'breaking ground': 3.0, 'under construction': 2.5,
    'topping out': 1.5, 'opening soon': 0.5,
  };
  var MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function parseDate(str) {
    if (!str) return null;
    var s = String(str).trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    var MONTHS = { january:0,jan:0, february:1,feb:1, march:2,mar:2, april:3,apr:3, may:4,
      june:5,jun:5, july:6,jul:6, august:7,aug:7, september:8,sep:8,sept:8,
      october:9,oct:9, november:10,nov:10, december:11,dec:11 };
    m = s.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
    if (m) { var mi = MONTHS[m[1].toLowerCase()]; if (mi !== undefined) return new Date(+m[2], mi, 15); }
    var SEASONS = { winter:{m:2,d:1}, spring:{m:5,d:1}, summer:{m:8,d:1}, fall:{m:11,d:1}, autumn:{m:11,d:1} };
    m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (m) { var se = SEASONS[m[1].toLowerCase()]; if (se) return new Date(+m[2], se.m, se.d); }
    m = s.match(/^Q([1-4])\s+(\d{4})$/i);
    if (m) { var q = +m[1]; var endMonth = q * 3 - 1; return new Date(+m[2], endMonth + 1, 0); }
    m = s.match(/^(\d{4})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, 15);
    m = s.match(/^(\d{4})$/);
    if (m) return new Date(+m[1], 11, 31);
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function assumedSpanFor(status) {
    var s = (status || '').toLowerCase().trim();
    if (s.indexOf('now open') !== -1) return 'OPEN';
    for (var key in ASSUMED_YEARS_BEFORE_DELIVERY) {
      if (s.indexOf(key) !== -1) return ASSUMED_YEARS_BEFORE_DELIVERY[key] * MS_PER_YEAR;
    }
    return ASSUMED_YEARS_BEFORE_DELIVERY['announced'] * MS_PER_YEAR;
  }

  function formatTimeToDelivery(deliveryDate, status) {
    var d = parseDate(deliveryDate);
    if (!d) return '';
    var now = new Date();
    var diffMs = d.getTime() - now.getTime();
    var s = (status || '').toLowerCase();
    if (s.indexOf('now open') !== -1) {
      if (diffMs < 0) {
        var mon = d.toLocaleDateString('en-US', { month: 'short' });
        var yr = d.toLocaleDateString('en-US', { year: '2-digit' });
        return 'Delivered ' + mon + " '" + yr;
      }
      return 'Now open';
    }
    if (diffMs <= 0) return 'Delivery ' + d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    var days = Math.round(diffMs / (24 * 60 * 60 * 1000));
    if (days < 14) return days + (days === 1 ? ' day' : ' days') + ' to delivery';
    if (days < 60) return Math.round(days / 7) + ' weeks to delivery';
    var months = Math.round(days / 30.44);
    if (months < 24) return months + (months === 1 ? ' month' : ' months') + ' to delivery';
    var years = (diffMs / MS_PER_YEAR);
    return years.toFixed(1).replace(/\.0$/, '') + ' yrs to delivery';
  }

  function labelToSegIdx(label) {
    switch (label) {
      case 'Announced': return 0;
      case 'Breaking Ground': return 1;
      case 'Construction': return 2;
      case 'Topping Out': return 2;
      case 'Opening Soon': return 3;
      case 'Now Open': return 4;
      default: return -1;
    }
  }

  function buildSegments(activeIdx, activeFillPct) {
    var stages = [
      { label: 'Announced', color: 'rgba(255,255,255,0.55)', widthPct: 15 },
      { label: 'Breaking Ground', color: '#FFD300', widthPct: 15 },
      { label: 'Construction', color: '#FF9500', widthPct: 40 },
      { label: 'Opening Soon', color: '#1FDF67', widthPct: 15 },
      { label: 'Now Open', color: '#1FDF67', widthPct: 15 },
    ];
    return stages.map(function (s, i) {
      var state, fillPct;
      if (i < activeIdx) { state = 'done'; fillPct = 100; }
      else if (i === activeIdx) { state = 'active'; fillPct = Math.round(activeFillPct); }
      else { state = 'future'; fillPct = 0; }
      return { label: s.label, color: s.color, widthPct: s.widthPct, state: state, fillPct: fillPct };
    });
  }

  function computeProgress(deliveryDate, status, startDate) {
    var s = (status || '').toLowerCase().trim();
    var label = 'Announced', color = 'rgba(255,255,255,0.55)';
    if (s.indexOf('now open') !== -1) { label = 'Now Open'; color = '#1FDF67'; }
    else if (s.indexOf('opening') !== -1) { label = 'Opening Soon'; color = '#1FDF67'; }
    else if (s.indexOf('topping') !== -1) { label = 'Topping Out'; color = '#FF9500'; }
    else if (s.indexOf('construction') !== -1) { label = 'Construction'; color = '#FF9500'; }
    else if (s.indexOf('breaking ground') !== -1 || s.indexOf('groundbreak') !== -1) { label = 'Breaking Ground'; color = '#FFD300'; }

    var span = assumedSpanFor(status);
    if (span === 'OPEN') {
      return { pct: 100, label: label, color: color, subtitle: formatTimeToDelivery(deliveryDate, status), segments: buildSegments(4, 100) };
    }
    if (label === 'Announced') {
      return { pct: 5, label: label, color: color, subtitle: formatTimeToDelivery(deliveryDate, status), segments: buildSegments(0, 100) };
    }
    var delivery = parseDate(deliveryDate);
    if (!delivery) {
      var fb = { 'Announced': { pct:5,segIdx:0,segFill:50 }, 'Breaking Ground': { pct:25,segIdx:1,segFill:50 },
        'Construction': { pct:55,segIdx:2,segFill:50 }, 'Topping Out': { pct:80,segIdx:2,segFill:95 },
        'Opening Soon': { pct:92,segIdx:3,segFill:50 } }[label] || { pct:5,segIdx:0,segFill:50 };
      return { pct: fb.pct, label: label, color: color, subtitle: '', segments: buildSegments(fb.segIdx, fb.segFill) };
    }
    var explicitStart = parseDate(startDate);
    var start = explicitStart || new Date(delivery.getTime() - span);
    var now = new Date();
    var total = delivery.getTime() - start.getTime();
    var elapsed = now.getTime() - start.getTime();
    var pct;
    if (total <= 0) pct = 50; else pct = (elapsed / total) * 100;
    pct = Math.max(0, Math.min(99, pct));

    var segWidths = [15, 15, 40, 15, 15];
    var elapsedFrac = total > 0 ? elapsed / total : 0.5;
    var elapsedPct = Math.max(0, Math.min(100, elapsedFrac * 100));
    var activeIdx = 0, segStartPct = 0, activeFill = 0;
    for (var i = 0; i < segWidths.length; i++) {
      var segEndPct = segStartPct + segWidths[i];
      if (elapsedPct <= segEndPct || i === segWidths.length - 1) {
        activeIdx = i;
        var into = elapsedPct - segStartPct;
        activeFill = Math.max(0, Math.min(100, (into / segWidths[i]) * 100));
        break;
      }
      segStartPct = segEndPct;
    }
    var statusIdx = labelToSegIdx(label);
    if (statusIdx >= 0 && statusIdx !== activeIdx) {
      if (statusIdx > activeIdx) { activeIdx = statusIdx; activeFill = 15; }
      else { activeIdx = statusIdx; activeFill = Math.min(95, activeFill); }
    }
    return { pct: Math.round(pct), label: label, color: color, subtitle: formatTimeToDelivery(deliveryDate, status), segments: buildSegments(activeIdx, activeFill) };
  }

  function pyStyleSlug(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-|-$/g, '');
  }
  function mapSlug(t) {
    return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  }

  // ── Construction timeline (segmented bar) ──────────────────────────
  function renderTimeline(project) {
    var status = project.Delivery || '';
    var cp = computeProgress(project.DeliveryDate || '', status, project.StartDate || '');
    if (!cp) return '';
    var segHtml = cp.segments.map(function (seg) {
      var c = seg.state === 'future' ? 'rgba(255,255,255,0.08)' : seg.color;
      return '<div class="pm-seg pm-seg-' + seg.state + '" style="flex:' + seg.widthPct + ' 0 0;--seg-c:' + c + ';"><div class="pm-seg-fill" style="width:' + seg.fillPct + '%"></div></div>';
    }).join('');
    var labels = cp.segments.map(function (seg) {
      return '<span class="pm-step-label' + (seg.state === 'active' ? ' cur' : '') + '" style="flex:' + seg.widthPct + ' 0 0;' + (seg.state === 'active' ? '--stage-color:' + seg.color : '') + '">' + seg.label + '</span>';
    }).join('');
    var sub = cp.subtitle ? '<div class="pm-progress-sub">' + esc(cp.subtitle) + '</div>' : '';
    return '<div class="tmw-pm"><div class="pm-progress">' +
      '<div class="pm-progress-top"><span class="pm-stage" style="color:' + cp.color + '">' + esc(cp.label) + '</span><span class="pm-pct">' + cp.pct + '%</span></div>' +
      '<div class="pm-segments">' + segHtml + '</div>' +
      '<div class="pm-step-labels">' + labels + '</div>' + sub + '</div></div>';
  }

  // ── TMW Intelligence panel ─────────────────────────────────────────
  var _intel = null, _p = null;
  function loadIntel() {
    if (_intel) return Promise.resolve(_intel);
    if (_p) return _p;
    _p = fetch('/intel.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { _intel = (d && d.projects) || {}; return _intel; })
      .catch(function () { _intel = {}; return _intel; });
    return _p;
  }
  var INTEL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5zm0 2.5L18 8v8l-6 3.75L6 16V8l6-3.5z"/></svg>';

  function renderIntel(title, data) {
    var slug = pyStyleSlug(title);
    var entry = data && data[slug];
    if (!entry) return '';
    var estimate = entry.estimate_years;
    if (estimate == null || isNaN(estimate)) return '';
    var conf = entry.confidence || 'medium';
    var confLabel = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }[conf] || '';
    var range = (entry.range_low != null && entry.range_high != null && entry.range_low !== entry.range_high)
      ? ' <span style="font-size:13px;color:rgba(255,255,255,0.5);font-weight:500;">(' + entry.range_low + '–' + entry.range_high + ' yrs)</span>' : '';
    var similarsHtml = '';
    (entry.comparables || []).forEach(function (c) {
      similarsHtml += '<a class="pm-intel-similar" href="https://map.oftmw.com/?project=' + mapSlug(c.name || '') + '" target="_blank" rel="noopener">' +
        '<div class="pm-intel-similar-name">' + esc(c.name || '') + '</div>' +
        '<div class="pm-intel-similar-loc">' + esc(c.location || '') + '</div>' +
        '<div class="pm-intel-similar-row"><span><b>' + esc(c.years) + '</b> yrs</span></div></a>';
    });
    var countStr = String(entry.comparable_count);
    var pattern = esc(entry.pattern_summary || '');
    try { pattern = pattern.replace(new RegExp('\\b' + countStr + '\\b'), '<span class="pm-intel-highlight">' + countStr + '</span>'); } catch (e) {}
    var estimateLabel = entry.estimate_label || ('~' + entry.estimate_years + ' years');
    var source = entry.source || 'comparables';
    var inner;

    if (source === 'completed') {
      var isSpec = !!entry.dates_speculative;
      inner = '<div class="pm-intel-head"><span class="pm-intel-badge">' + INTEL_SVG + ' TMW Intelligence</span>' +
        '<div class="pm-intel-title">' + (isSpec ? 'Estimated Time to Complete' : 'Actual Time to Complete') + '</div>' +
        '<span class="pm-intel-confidence" data-conf="' + (isSpec ? 'medium' : 'high') + '">' + (isSpec ? 'TMW estimate' : 'Completed') + '</span></div>' +
        '<div class="pm-intel-estimate">' + esc(estimateLabel) + ' <span class="unit">to complete</span></div>' +
        '<div class="pm-intel-pattern">' + esc(entry.pattern_summary || '') + '</div>' +
        (isSpec ? '<div class="pm-intel-disclaimer">Dates not developer-confirmed. TMW estimated the timeline based on observed activity; actuals can vary.</div>' : '');
    } else if (source === 'known_date') {
      var isDay = (entry.precision === 'day');
      var isSpec2 = !!entry.dates_speculative;
      var pill = isSpec2 ? '<span class="pm-intel-confidence" data-conf="medium">TMW estimate</span>'
        : (isDay ? '<span class="pm-intel-confidence" data-conf="high">Developer announced</span>' : '');
      var disc = isSpec2 ? 'TMW-estimated dates based on project type and stage — not a developer commitment. Confidence drops accordingly.'
        : (isDay ? "Based on the developer's announced opening date. Schedules can shift; we update this daily."
          : "Estimate based on the project's targeted opening window. Schedules can shift; we update this daily.");
      inner = '<div class="pm-intel-head"><span class="pm-intel-badge">' + INTEL_SVG + ' TMW Intelligence</span>' +
        '<div class="pm-intel-title">Estimated Time to Completion</div>' + pill + '</div>' +
        '<div class="pm-intel-estimate">' + esc(estimateLabel) + ' <span class="unit">to completion</span></div>' +
        '<div class="pm-intel-pattern">' + esc(entry.pattern_summary || '') + '</div>' +
        '<div class="pm-intel-disclaimer">' + disc + '</div>';
    } else {
      inner = '<div class="pm-intel-head"><span class="pm-intel-badge">' + INTEL_SVG + ' TMW Intelligence</span>' +
        '<div class="pm-intel-title">Estimated Time to Completion</div>' +
        (confLabel ? '<span class="pm-intel-confidence" data-conf="' + conf + '">' + confLabel + '</span>' : '') + '</div>' +
        '<div class="pm-intel-estimate">' + esc(estimateLabel) + ' <span class="unit">to completion</span>' + range + '</div>' +
        (similarsHtml ? '<div class="pm-intel-similar-label">Similar Projects in TMW\'s Data</div><div class="pm-intel-similars">' + similarsHtml + '</div>' : '') +
        '<div class="pm-intel-pattern">' + pattern + '</div>' +
        '<div class="pm-intel-disclaimer">Pattern-based estimate, not a developer commitment. Actual timelines can vary by 6–18 months.</div>';
    }
    return '<div class="tmw-pm"><div class="pm-intel">' + inner + '</div></div>';
  }

  // ── CSS (ported, re-scoped from #projectModal → .tmw-pm) ───────────
  var css = [
    '.tmw-pm .pm-progress{margin-bottom:0}',
    '.tmw-pm .pm-progress-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}',
    '.tmw-pm .pm-stage{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
    '.tmw-pm .pm-pct{font-size:10px;color:rgba(255,255,255,.25)}',
    '.tmw-pm .pm-segments{display:flex;gap:3px;margin-bottom:5px;height:5px}',
    '.tmw-pm .pm-seg{height:100%;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden;position:relative}',
    '.tmw-pm .pm-seg-fill{height:100%;background:var(--seg-c,#FF9500);border-radius:2px;transition:width .4s ease}',
    '.tmw-pm .pm-seg-done .pm-seg-fill{width:100%!important}',
    '.tmw-pm .pm-seg-active{box-shadow:0 0 0 1px rgba(255,255,255,.04)}',
    '.tmw-pm .pm-seg-future .pm-seg-fill{width:0!important}',
    '.tmw-pm .pm-step-labels{display:flex;gap:3px}',
    '.tmw-pm .pm-step-label{font-size:7.5px;color:rgba(255,255,255,.2);letter-spacing:.02em;padding-right:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tmw-pm .pm-step-label.cur{color:var(--stage-color,#FF9500);font-weight:600}',
    '.tmw-pm .pm-progress-sub{margin-top:6px;font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif;font-size:9px;letter-spacing:.06em;color:rgba(255,255,255,.5)}',
    '.tmw-pm .pm-intel{margin:0;padding:18px;background:rgba(167,139,250,.06);border:1px solid rgba(167,139,250,.18);border-radius:12px}',
    '.tmw-pm .pm-intel-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}',
    '.tmw-pm .pm-intel-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(167,139,250,.14);border:1px solid rgba(167,139,250,.32);color:#A78BFA;padding:4px 10px;border-radius:12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}',
    '.tmw-pm .pm-intel-badge svg{width:11px;height:11px;fill:currentColor}',
    '.tmw-pm .pm-intel-confidence{font-size:10px;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:.08em;font-weight:600}',
    '.tmw-pm .pm-intel-confidence[data-conf="high"]{color:#1FDF67}',
    '.tmw-pm .pm-intel-confidence[data-conf="medium"]{color:#A78BFA}',
    '.tmw-pm .pm-intel-confidence[data-conf="low"]{color:rgba(255,255,255,.45)}',
    '.tmw-pm .pm-intel-title{font-size:13px;font-weight:700;color:#fff}',
    '.tmw-pm .pm-intel-estimate{font-size:30px;font-weight:700;letter-spacing:-.02em;color:#A78BFA;margin-bottom:14px;line-height:1.05}',
    '.tmw-pm .pm-intel-estimate .unit{font-size:14px;color:rgba(255,255,255,.62);font-weight:500;margin-left:6px}',
    '.tmw-pm .pm-intel-similar-label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#A78BFA;font-weight:700;margin-bottom:10px;padding-top:14px;border-top:1px solid rgba(167,139,250,.18)}',
    '.tmw-pm .pm-intel-similars{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:14px}',
    '@media(max-width:600px){.tmw-pm .pm-intel-similars{grid-template-columns:1fr}}',
    '.tmw-pm .pm-intel-similar{background:rgba(0,0,0,.3);border:1px solid rgba(167,139,250,.16);border-radius:8px;padding:11px 12px;cursor:pointer;transition:all .15s;text-decoration:none;color:inherit;display:block}',
    '.tmw-pm .pm-intel-similar:hover,.tmw-pm .pm-intel-similar:focus-visible{border-color:rgba(167,139,250,.4);background:rgba(0,0,0,.5);outline:none}',
    '.tmw-pm .pm-intel-similar-name{font-size:12px;font-weight:600;margin-bottom:2px;color:#fff;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.tmw-pm .pm-intel-similar-loc{font-size:10px;color:rgba(255,255,255,.55);margin-bottom:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.tmw-pm .pm-intel-similar-row{display:flex;justify-content:flex-end;font-size:11px;color:rgba(255,255,255,.55);padding-top:7px;border-top:1px solid rgba(167,139,250,.1)}',
    '.tmw-pm .pm-intel-similar-row b{color:#fff;font-weight:700}',
    '.tmw-pm .pm-intel-pattern{background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.22);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.55;color:rgba(255,255,255,.7)}',
    '.tmw-pm .pm-intel-pattern b{color:#fff;font-weight:600}',
    '.tmw-pm .pm-intel-pattern .pm-intel-highlight{color:#A78BFA;font-weight:700}',
    '.tmw-pm .pm-intel-disclaimer{font-size:10px;color:rgba(255,255,255,.4);margin-top:12px;font-style:italic;line-height:1.5}'
  ].join('');
  var st = document.createElement('style');
  st.setAttribute('data-tmw-intel', '');
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  window.TMWIntel = { renderTimeline: renderTimeline, loadIntel: loadIntel, renderIntel: renderIntel, computeProgress: computeProgress };
})();
