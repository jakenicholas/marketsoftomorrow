/* TMW Intelligence — reusable "Follow the Money" module.
   Mounts into any [data-tmw-money] element:
     <div data-tmw-money data-mode="teaser"></div>   (homepage strip)
     <div data-tmw-money data-mode="full"></div>      (Atlas tile)
   Reads the structured FinancingAmountM / FinancingLender / FinancingDate fields
   from projects-flat.json when present (populated by the map pipeline), falling
   back to parsing the financing milestone NOTE until they land. Self-contained
   (scoped styles, hardcoded tokens) so it drops onto any page unchanged.
   window.tmwMoney.mountAll() re-mounts (Atlas re-renders its container). */
(function () {
  'use strict';
  var PROJECTS = 'https://www.oftmw.com/map/projects-flat.json';
  var LENDER_MAP = 'https://tmw.jake-ab7.workers.dev/lender-map';
  var ATLAS = 'https://www.oftmw.com/atlas';

  function sharedJson(url) {
    var s = window.__tmwJsonMemo = window.__tmwJsonMemo || {};
    if (!s[url]) s[url] = fetch(url, { cache: 'no-cache' }).then(function (r) { return r.ok ? r.text() : 'null'; }).catch(function () { return 'null'; });
    return s[url].then(function (t) { try { return JSON.parse(t); } catch (e) { return null; } });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function mapSlug(t) { return String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function projHref(p) { return 'https://www.oftmw.com/map/?project=' + mapSlug(p && p.Title || ''); }
  function firstDev(v) { return String(v || '').split(/\s*[,/]\s*/).map(function (s) { return s.trim(); }).filter(function (s) { return s && s.toLowerCase() !== 'various'; })[0] || ''; }
  function num(v) { if (v == null || v === '') return null; var n = parseFloat(v); return isFinite(n) ? n : null; }
  function fmtM(m) { if (m == null) return null; return m >= 1000 ? '$' + (m / 1000).toFixed(m % 1000 ? 1 : 0) + 'B' : '$' + Math.round(m) + 'M'; }
  function parseWhen(s) {
    if (!s) return 0; s = String(s).trim();
    var t = Date.parse(s); if (!isNaN(t)) return t;
    var ym = s.match(/^(\d{4})-(\d{2})/); if (ym) return Date.parse(ym[1] + '-' + ym[2] + '-01');
    var md = s.match(/^([A-Za-z]{3,})\s+(\d{4})$/); if (md) return Date.parse(md[1] + ' 1, ' + md[2]);
    var y = s.match(/(\d{4})/); if (y) return Date.parse(y[1] + '-06-30');
    return 0;
  }
  function ago(ts) { if (!ts) return ''; var d = Math.floor((Date.now() - ts) / 86400000); if (d < 1) return 'today'; if (d < 30) return d + 'd ago'; return Math.round(d / 30) + 'mo ago'; }

  // --- financing extraction: prefer the structured flat fields; else parse notes.
  function noteAmt(note) { var m = String(note || '').match(/\$\s*([\d,]+(?:\.\d+)?)\s*(billion|bn|million|mm|m|b)\b/i); if (!m) return null; var v = parseFloat(m[1].replace(/,/g, '')); return /^b/i.test(m[2]) ? v * 1000 : v; }
  function noteLender(note) { var m = String(note || '').match(/\bfrom\s+([A-Z][A-Za-z0-9.&'’ -]{2,38}?)(?=\s*[,;(]|\s+(?:construction|bridge|senior|mezzanine|for|per|via|and|closed|to|in|on|at|loan)\b|$)/); if (!m) return null; var L = m[1].trim().replace(/\s+/g, ' '); return L.length >= 3 ? L : null; }
  // A single real-estate loan realistically tops out in the low tens of $B; a value
  // above $50B ($50,000M) is almost always a unit error (raw dollars stored where
  // millions were expected — "$600M" logged as 600000000). Reject it, re-parse note.
  function saneM(v) { return (v != null && isFinite(v) && v > 0 && v <= 50000) ? v : null; }
  function fromHistory(sh) {
    if (!Array.isArray(sh)) return null;
    var best = null;
    sh.forEach(function (h) {
      if (!h) return;
      if (!(h.phase === 'financing' || /financ|construction loan|refinanc/i.test(h.note || ''))) return;
      var amt = saneM(h.loan_amount);
      if (amt == null) amt = saneM(noteAmt(h.note));
      var lender = h.lender || noteLender(h.note);
      var date = h.effective_date || h.source_published || h.at || '';
      if (!best || (amt || 0) > (best.amt || 0)) best = { amt: amt, lender: lender || '', date: date };
    });
    return best;
  }
  // Apply the admin canonicalization map: hide false-positives, merge variants.
  function normLender(name, lmap) {
    if (!name) return '';
    var low = String(name).toLowerCase().trim();
    if (lmap && lmap.hidden && lmap.hidden.indexOf(low) >= 0) return '';
    if (lmap && lmap.overrides && lmap.overrides[low]) return lmap.overrides[low];
    return name;
  }
  function financeDeals(projects, lmap) {
    var out = [];
    projects.forEach(function (p) {
      var amt = saneM(num(p.FinancingAmountM)), lender = p.FinancingLender || '', date = p.FinancingDate || '';
      if (amt == null) {                              // no sane flat amount → derive from the notes
        var f = fromHistory(p.StatusHistory);
        if (f) { amt = f.amt; if (!lender) lender = f.lender; if (!date) date = f.date; }
        else if (!lender && !date) return;
      }
      if (amt == null && !lender && !date) return;
      out.push({ title: p.Title, city: (p.City || '').trim(), dev: firstDev(p.Developer), href: projHref(p), amt: amt, lender: normLender(lender, lmap), when: parseWhen(date) });
    });
    return out;
  }

  var CSS = `
.tmw-money{--g:#1FDF67;--gs:#42EB81;--gd:#18c75a;--pg:#B9A6FF;--cream:#ECEAE5;--mute:#8b958d;--mute2:#C2C9C3;--hair:rgba(255,255,255,.08);--hair2:rgba(255,255,255,.14);font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}
.tmw-money *{box-sizing:border-box}
.tmw-m-eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;color:var(--gs)}
.tmw-m-eyebrow .sp{width:13px;height:13px;fill:var(--gs);filter:drop-shadow(0 0 6px rgba(31,223,103,.6))}
.tmw-m-link{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--gs);text-decoration:none;white-space:nowrap}
.tmw-m-link:hover{color:#fff}
/* ---- teaser (homepage) ---- */
.tmw-money--teaser{margin-top:14px}
.tmw-m-card{border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px 18px;
  background:linear-gradient(180deg,rgba(255,255,255,.018),transparent),#0c0e0c}
.tmw-m-top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:13px}
.tmw-m-stats{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:14px}
.tmw-m-stats .s{display:flex;flex-direction:column;gap:3px}
.tmw-m-stats .s b{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:26px;letter-spacing:-.02em;color:var(--gs);line-height:1}
.tmw-m-stats .s span{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}
.tmw-m-recent{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
@media(max-width:760px){.tmw-m-recent{grid-template-columns:1fr}}
.tmw-m-deal{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:11px;background:rgba(255,255,255,.025);border:1px solid var(--hair);text-decoration:none;transition:border-color .15s,background .15s}
.tmw-m-deal:hover{border-color:rgba(31,223,103,.4);background:rgba(31,223,103,.06)}
.tmw-m-deal .dn{flex:1;min-width:0}
.tmw-m-deal .dn .nm{font-size:12.5px;font-weight:600;color:var(--cream);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmw-m-deal .dn .mt{font-size:9.5px;letter-spacing:.03em;color:var(--mute);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmw-m-deal .amt{font-family:'JetBrains Mono','Inter',monospace;font-size:12.5px;font-weight:700;color:var(--gs);flex:0 0 auto;font-variant-numeric:tabular-nums}
.tmw-m-deal .amt.na{color:var(--mute);font-weight:500}
/* ---- full (Atlas tile) ---- */
.tmw-money--full .tmw-m-statrow{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}
.tmw-money--full .tmw-m-statrow .s{border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px 18px;background:linear-gradient(180deg,rgba(255,255,255,.018),transparent),#0c0e0c}
.tmw-money--full .tmw-m-statrow .s b{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:30px;color:var(--gs);line-height:1;letter-spacing:-.02em;display:block}
.tmw-money--full .tmw-m-statrow .s span{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin-top:9px;display:block}
.tmw-money--full .tmw-m-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
@media(max-width:980px){.tmw-money--full .tmw-m-grid{grid-template-columns:1fr}}
.tmw-money--full .col{border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:18px 20px;background:linear-gradient(180deg,rgba(255,255,255,.018),transparent),#0c0e0c}
.tmw-money--full .col .h{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute2);margin-bottom:0;padding-bottom:11px;border-bottom:1px solid var(--hair)}
.tmw-money--full .r{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--hair);text-decoration:none}
.tmw-money--full .col .h + .r{border-top:0}
.tmw-money--full .r:hover .nm{color:#fff}
.tmw-money--full .r .rn{flex:1;min-width:0}
.tmw-money--full .r .rn .nm{font-size:13px;font-weight:600;color:var(--cream);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .15s}
.tmw-money--full .r .rn .mt{font-size:9.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--mute);margin-top:3px}
.tmw-money--full .r .amt{font-family:'JetBrains Mono','Inter',monospace;font-size:12.5px;font-weight:700;color:var(--gs);flex:0 0 auto;font-variant-numeric:tabular-nums}
.tmw-money--full .r .amt.na{color:var(--mute);font-weight:500}
.tmw-money .ramt{display:inline-flex;flex-direction:column;align-items:flex-end;gap:3px;flex:0 0 auto}
.tmw-money .rdate{font-size:8.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute);font-family:'JetBrains Mono','Inter',monospace}
.tmw-money--full .fl{display:flex;align-items:center;gap:10px;margin-bottom:11px}
.tmw-money--full .fl .nm{font-size:12.5px;color:var(--mute2);width:120px;flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmw-money--full .fl .tk{flex:1;height:7px;border-radius:4px;background:rgba(255,255,255,.07);overflow:hidden}
.tmw-money--full .fl .tk i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--gd),var(--gs))}
.tmw-money--full .fl .v{font-family:'JetBrains Mono','Inter',monospace;font-size:11px;color:var(--cream);font-weight:600;width:52px;text-align:right}
.tmw-money--full .note{margin-top:14px;font-size:10px;letter-spacing:.02em;color:var(--mute);line-height:1.5}
.tmw-m-loading{font-size:12px;color:var(--mute);padding:14px 2px}
`;

  function agg(deals) {
    var disclosed = deals.reduce(function (s, d) { return s + (d.amt || 0); }, 0);
    var mkt = {}; deals.forEach(function (d) { if (d.city) mkt[d.city] = 1; });
    return { disclosed: disclosed, markets: Object.keys(mkt).length, count: deals.length };
  }

  function dealRow(d, cls) {
    var amt = d.amt ? '<span class="amt">' + fmtM(d.amt) + '</span>' : '<span class="amt na">—</span>';
    var meta = [d.city, d.lender || d.dev].filter(Boolean).join(' · ');
    var date = d.when ? '<span class="rdate">' + ago(d.when) + '</span>' : '';
    return '<a class="' + cls + '" href="' + esc(d.href) + '" target="_blank" rel="noopener"><div class="' + (cls === 'tmw-m-deal' ? 'dn' : 'rn') + '"><div class="nm">' + esc(d.title) + '</div><div class="mt">' + esc(meta) + '</div></div><span class="ramt">' + amt + date + '</span></a>';
  }

  function renderTeaser(el, deals) {
    var a = agg(deals);
    // Lead the teaser with recent deals that actually name a figure, so it reads
    // substantive; top up with the rest if fewer than 3 have amounts.
    var byRecent = deals.slice().sort(function (x, y) { return y.when - x.when; });
    var recent = byRecent.filter(function (d) { return d.amt; }).slice(0, 3);
    if (recent.length < 3) recent = recent.concat(byRecent.filter(function (d) { return !d.amt; }).slice(0, 3 - recent.length));
    el.className = 'tmw-money tmw-money--teaser';
    el.innerHTML = '<div class="tmw-m-card">'
      + '<div class="tmw-m-top"><span class="tmw-m-eyebrow">' + SPARK + 'Follow the Money</span>'
      + '<a class="tmw-m-link" href="' + ATLAS + '">Where capital’s moving →</a></div>'
      + '<div class="tmw-m-stats">'
      + '<div class="s"><b>' + (a.disclosed ? fmtM(a.disclosed) : '—') + '</b><span>Disclosed capital</span></div>'
      + '<div class="s"><b>' + a.count + '</b><span>Financings tracked</span></div>'
      + '<div class="s"><b>' + a.markets + '</b><span>Markets</span></div>'
      + '</div>'
      + '<div class="tmw-m-recent">' + recent.map(function (d) { return dealRow(d, 'tmw-m-deal'); }).join('') + '</div>'
      + '</div>';
  }

  function renderFull(el, deals) {
    var a = agg(deals);
    var _yearAgo = Date.now() - 365 * 86400000;
    var recent = deals.filter(function (d) { return d.when && d.when >= _yearAgo; }).sort(function (x, y) { return y.when - x.when; }).slice(0, 7);
    var lend = {}; deals.forEach(function (d) { if (!d.lender) return; if (!lend[d.lender]) lend[d.lender] = { n: 0, amt: 0 }; lend[d.lender].n++; lend[d.lender].amt += (d.amt || 0); });
    var lenders = Object.keys(lend).map(function (k) { return { name: k, n: lend[k].n, amt: lend[k].amt }; }).sort(function (x, y) { return y.n - x.n || y.amt - x.amt; }).slice(0, 7);
    var mc = {}; deals.forEach(function (d) { var c = d.city || '—'; if (!mc[c]) mc[c] = { n: 0, amt: 0 }; mc[c].n++; mc[c].amt += (d.amt || 0); });
    var cities = Object.keys(mc).map(function (k) { return { city: k, n: mc[k].n, amt: mc[k].amt }; }).sort(function (x, y) { return y.n - x.n || y.amt - x.amt; }).slice(0, 7);
    el.className = 'tmw-money tmw-money--full';
    el.innerHTML = ''
      + '<div class="tmw-m-statrow">'
      + '<div class="s"><b>' + a.count + '</b><span>Financings tracked</span></div>'
      + '<div class="s"><b>' + (a.disclosed ? fmtM(a.disclosed) : '—') + '</b><span>Disclosed capital</span></div>'
      + '<div class="s"><b>' + a.markets + '</b><span>Markets receiving capital</span></div>'
      + '</div>'
      + '<div class="tmw-m-grid">'
      + '<div class="col"><div class="h">Recent financings</div>' + recent.map(function (d) { return dealRow(d, 'r'); }).join('') + '</div>'
      + '<div class="col"><div class="h">Most active lenders</div>' + (lenders.length ? lenders.map(function (l) { return '<div class="r"><div class="rn"><div class="nm">' + esc(l.name) + '</div><div class="mt">' + l.n + (l.n === 1 ? ' deal' : ' deals') + '</div></div><span class="amt' + (l.amt ? '' : ' na') + '">' + (l.amt ? fmtM(l.amt) : '—') + '</span></div>'; }).join('') : '<div class="note">No lenders yet.</div>') + '</div>'
      + '<div class="col"><div class="h">Where capital is landing</div>' + cities.map(function (c) { return '<div class="r"><div class="rn"><div class="nm">' + esc(c.city) + '</div><div class="mt">' + c.n + (c.n === 1 ? ' deal' : ' deals') + '</div></div><span class="amt' + (c.amt ? '' : ' na') + '">' + (c.amt ? fmtM(c.amt) : '—') + '</span></div>'; }).join('') + '</div>'
      + '</div>';
  }

  var SPARK = '<svg class="sp" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 5.9 5.9 2.3-5.9 2.3L12 18.9l-2.3-5.9L3.8 10.7l5.9-2.3z"/></svg>';

  function mountAll() {
    var els = document.querySelectorAll('[data-tmw-money]');
    if (!els.length) return;
    if (!document.getElementById('tmw-money-styles')) { var st = document.createElement('style'); st.id = 'tmw-money-styles'; st.textContent = CSS; document.head.appendChild(st); }
    var pending = [];
    Array.prototype.forEach.call(els, function (el) {
      if (el.getAttribute('data-tmw-money-done') === '1' && el.__mode === el.getAttribute('data-mode')) return;
      el.__mode = el.getAttribute('data-mode') || 'teaser';
      if (!el.innerHTML) el.innerHTML = '<div class="tmw-m-loading">Tracing the capital…</div>';
      pending.push(el);
    });
    if (!pending.length) return;
    Promise.all([sharedJson(PROJECTS), sharedJson(LENDER_MAP).catch(function () { return null; })]).then(function (o) {
      var projects = o[0], lmap = o[1] || { overrides: {}, hidden: [] };
      if (!Array.isArray(projects) || !projects.length) return;
      var deals = financeDeals(projects, lmap);
      pending.forEach(function (el) {
        try { (el.__mode === 'full' ? renderFull : renderTeaser)(el, deals); el.setAttribute('data-tmw-money-done', '1'); } catch (e) {}
      });
    });
  }

  window.tmwMoney = { mountAll: mountAll, financeDeals: financeDeals };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll); else mountAll();
})();
