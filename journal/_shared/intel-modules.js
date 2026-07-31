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
  var MONEY = 'https://www.oftmw.com/map/money-flat.json';   // canonical, sanitized (generate_money.py)
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
  function fmtM(m) { if (m == null) return null; return m >= 1000 ? '$' + (m / 1000).toFixed(1) + 'B' : '$' + Math.round(m) + 'M'; }
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
  // Read the canonical money-flat.json (already sanitized + deduped + case-merged
  // by generate_money.py — the SAME file the admin Lenders tab reads) and apply the
  // LIVE lender-map (overrides / hidden) so the two always agree.
  function financeDeals(money, lmap) {
    return ((money && money.deals) || []).map(function (d) {
      // Split each disclosed loan into its named tranches (syndicated deals credit
      // each lender its own slice); normalize each through the live lender-map.
      // `lender` stays the joined DISPLAY string; `lenders` drives aggregation.
      var parts = (d.lenders && d.lenders.length ? d.lenders : [{ name: d.lender || '', amt: d.amt }])
        .map(function (p) { return { name: normLender(p.name || '', lmap), amt: (p.amt == null ? d.amt : p.amt) }; })
        .filter(function (p) { return p.name; });
      var disp = parts.map(function (p) { return p.name; }).join(', ') || normLender(d.lender, lmap);
      return { title: d.title, city: d.city || '', dev: d.dev || '', href: d.href, amt: d.amt, lender: disp, lenders: parts, when: parseWhen(d.date), lat: d.lat, lng: d.lng };
    });
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
.tmw-money--full .r .rn .mt{font-size:9.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--mute);margin-top:2px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
/* ---- interactive: tabs + flow + map + lender pages ---- */
.tmw-money--full .tmw-m-shell{border:1px solid rgba(255,255,255,.08);border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.02),transparent),#0c0e0c;padding:8px 20px 18px}
.tmw-money--full .tmw-m-shell .col{border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.025);padding:15px 17px}
.tmw-money--full .tmw-m-tabs{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:16px;border-bottom:1px solid rgba(255,255,255,.08)}
.tmw-money--full .tmw-m-tabgroup{display:flex;gap:6px}
.tmw-money--full .tmw-m-range{display:flex;gap:2px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:2px;margin-bottom:7px;flex:0 0 auto}
.tmw-money--full .tmw-m-range .rg{background:none;border:0;color:#8b958d;font:inherit;font-size:10.5px;font-weight:700;letter-spacing:.02em;padding:4px 9px;border-radius:6px;cursor:pointer;transition:.15s}
.tmw-money--full .tmw-m-range .rg:hover{color:#ECEAE5}
.tmw-money--full .tmw-m-range .rg.on{background:rgba(31,223,103,.14);color:#42EB81}
.tmw-money--full .tmw-m-tab{background:none;border:0;color:#8b958d;font:inherit;font-size:12.5px;font-weight:600;padding:9px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s,border-color .15s}
.tmw-money--full .tmw-m-tab:hover{color:#ECEAE5}
.tmw-money--full .tmw-m-tab.on{color:#fff;border-bottom-color:#1FDF67}
.tmw-money--full .r .rn .nm{line-height:1.25}
.tmw-money--full .r .rn .mt{line-height:1.3}
.tmw-money--full .tmw-m-view{display:none}
.tmw-money--full .tmw-m-view.on{display:block}
.tmw-money--full .tmw-m-cap{font-size:12px;color:#8b958d;margin:0 0 12px}
.tmw-money--full .tmw-m-cap b{color:#ECEAE5;font-weight:600}
.tmw-money--full .tmw-m-svgwrap{width:100%;overflow-x:auto;padding:2px 0}
.tmw-money--full .tmw-m-sankey,.tmw-money--full .tmw-m-map{width:100%;height:auto;display:block}
.tmw-money--full .sk-band{transition:stroke-opacity .18s}
.tmw-money--full .sk-label{font-size:11px;fill:#ECEAE5;font-family:'Inter',sans-serif}
.tmw-money--full .sk-val{font-size:9.5px;fill:#6d766e;font-family:'JetBrains Mono',monospace}
.tmw-money--full .sk-col{font-size:9px;letter-spacing:.14em;fill:#6d766e;text-transform:uppercase;font-family:'JetBrains Mono',monospace}
.tmw-money--full .tmw-m-flowread{margin-top:10px;font-size:12px;color:#8b958d;min-height:17px}
.tmw-money--full .tmw-m-flowread b{color:#42EB81}
.tmw-money--full .tmw-m-mapgrid{display:grid;grid-template-columns:1.35fr .65fr;gap:14px}
.tmw-money--full .tmw-m-mapbox{width:100%;height:440px;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.08);background:#0c0e0c}
.tmw-money--full .tmw-m-mapbox canvas{outline:none}
.tmw-money--full .tmw-m-mapbox .mapboxgl-ctrl-logo,.tmw-money--full .tmw-m-mapbox .mapboxgl-ctrl-attrib{display:none!important}
.tmw-money--full .tmw-m-mapbox .mapboxgl-ctrl-group{background:#0c0e0c;border:1px solid rgba(255,255,255,.14);box-shadow:none;overflow:hidden}
.tmw-money--full .tmw-m-mapbox .mapboxgl-ctrl-group button+button{border-top:1px solid rgba(255,255,255,.14)}
.tmw-money--full .tmw-m-mapbox .mapboxgl-ctrl-group button .mapboxgl-ctrl-icon{filter:invert(1) brightness(1.6)}
.tmw-money--full .tmw-m-mapbox .mapboxgl-ctrl-group button:hover{background:rgba(255,255,255,.08)}
.tmw-money--full .tmw-m-mapfallback{display:flex;flex-direction:column;gap:6px;padding:14px;max-height:440px;overflow-y:auto}
.tmw-money--full .tmw-m-mapfallback button{display:flex;justify-content:space-between;gap:10px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:9px 12px;cursor:pointer;color:inherit;font:inherit;font-size:12.5px;text-align:left}
.tmw-money--full .tmw-m-mapfallback button .v{color:#42EB81;font-family:'JetBrains Mono',monospace;font-weight:700}
@media(max-width:820px){.tmw-money--full .tmw-m-mapgrid,.tmw-money--full .tmw-m-lgrid{grid-template-columns:1fr!important}}
.tmw-money--full .mp-region{font-size:8px;letter-spacing:.16em;fill:#6d766e;text-transform:uppercase;font-family:'JetBrains Mono',monospace}
.tmw-money--full .mp-lab{font-size:10px;fill:#ECEAE5;font-family:'Inter',sans-serif;pointer-events:none}
.tmw-money--full .mp-cap{font-size:9px;fill:#42EB81;font-family:'JetBrains Mono',monospace;pointer-events:none}
.tmw-money--full .mp-bub{cursor:pointer}
.tmw-money--full .mp-glow{transition:opacity .2s}
.tmw-money--full .tmw-m-mapdetail{border:1px solid rgba(255,255,255,.07);border-radius:14px;background:rgba(255,255,255,.022);padding:14px 16px;min-height:220px}
.tmw-money--full .mp-city{font-family:'Fraunces',Georgia,serif;font-size:17px;color:#fff;font-weight:600;margin:0}
.tmw-money--full .mp-sub{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#8b958d;margin:3px 0 12px}
.tmw-money--full .mp-h{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#6d766e;margin:12px 0 6px}
.tmw-money--full .mp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid rgba(255,255,255,.08);font-size:12px;text-decoration:none;color:inherit}
.tmw-money--full .mp-row:first-of-type{border-top:0}
.tmw-money--full .mp-row .mp-n{flex:1;min-width:0;color:#8b958d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmw-money--full a.mp-row:hover .mp-n{color:#ECEAE5}
.tmw-money--full .mp-row .mp-a{flex:0 0 auto;color:#42EB81;font-family:'JetBrains Mono',monospace;font-weight:600;white-space:nowrap}
.tmw-money--full .mp-empty{color:#8b958d;font-size:12px;padding:30px 0;text-align:center}
.tmw-money--full .tmw-m-lgrid{display:grid;grid-template-columns:.85fr 1.15fr;gap:14px}
.tmw-money--full .tmw-m-chips{display:flex;flex-direction:column;gap:7px;max-height:440px;overflow-y:auto}
.tmw-money--full .mc-chip{display:flex;justify-content:space-between;align-items:center;gap:10px;background:rgba(255,255,255,.022);border:1px solid rgba(255,255,255,.08);border-radius:11px;padding:10px 12px;cursor:pointer;text-align:left;color:inherit;font:inherit;transition:border-color .15s,background .15s}
.tmw-money--full .mc-chip:hover{border-color:rgba(167,139,250,.4)}
.tmw-money--full .mc-chip.on{border-color:#A78BFA;background:rgba(167,139,250,.07)}
.tmw-money--full .mc-chip .cn{font-size:12.5px;font-weight:600;color:#fff;display:block}
.tmw-money--full .mc-chip .cd{font-size:9.5px;color:#8b958d;margin-top:1px;display:block;text-align:left}
.tmw-money--full .mc-chip .cv{font-family:'JetBrains Mono',monospace;font-size:12.5px;font-weight:700;color:#42EB81;flex:0 0 auto}
.tmw-money--full .tmw-m-lprofile{border:1px solid rgba(255,255,255,.07);border-radius:14px;background:rgba(255,255,255,.022);padding:16px 17px;min-height:440px}
.tmw-money--full .mc-name{font-family:'Fraunces',Georgia,serif;font-size:19px;color:#fff;font-weight:600;margin:0}
.tmw-money--full .mc-tag{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#B9A6FF;margin:4px 0 13px}
.tmw-money--full .mc-kpis{display:flex;gap:9px;margin-bottom:13px;flex-wrap:wrap}
.tmw-money--full .mc-kpi{flex:1;min-width:80px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:9px 11px}
.tmw-money--full .mc-kpi .k{font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:700;color:#fff}
.tmw-money--full .mc-kpi .k.g{color:#42EB81}
.tmw-money--full .mc-kpi .kl{font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:#6d766e;margin-top:3px}
.tmw-money--full .mc-h{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#6d766e;margin:13px 0 7px}
.tmw-money--full .mc-bar{display:grid;grid-template-columns:92px 1fr 46px;align-items:center;gap:9px;margin:5px 0}
.tmw-money--full .mc-bar .bl{font-size:11px;color:#ECEAE5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tmw-money--full .mc-bar .bw{height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden}
.tmw-money--full .mc-bar .bw i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,rgba(31,223,103,.5),#1FDF67)}
.tmw-money--full .mc-bar .bv{font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b958d;text-align:right}
.tmw-money--full .mc-subt{font-size:11px;color:#8b958d}
.tmw-money--full .mc-deal{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid rgba(255,255,255,.08);font-size:11.5px;text-decoration:none;color:inherit}
.tmw-money--full .mc-deal:first-of-type{border-top:0}
.tmw-money--full .mc-deal .dn{color:#ECEAE5}
.tmw-money--full .mc-deal .dc{color:#8b958d;font-size:9.5px}
.tmw-money--full .mc-deal .dv{font-family:'JetBrains Mono',monospace;color:#42EB81;font-weight:600;white-space:nowrap}
.tmw-money--full .tmw-m-recentbar{margin-top:16px;border-top:1px solid rgba(255,255,255,.08);padding-top:14px}
.tmw-money--full .rbh{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#6d766e;margin-bottom:10px}
.tmw-money--full .tmw-m-recentrow{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}
.tmw-money--full .tmw-m-recentrow .tmw-m-deal{min-width:232px;flex:0 0 auto}
.tmw-money--full .tmw-m-empty{color:#8b958d;font-size:12px;padding:20px 0}
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
    // 6 deals: the homepage teaser now lives in a half-width column beside the
    // Onyx Projections card, so a deeper stack balances the row's height.
    var recent = byRecent.filter(function (d) { return d.amt; }).slice(0, 6);
    if (recent.length < 6) recent = recent.concat(byRecent.filter(function (d) { return !d.amt; }).slice(0, 6 - recent.length));
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

  function _money(m) { return m ? fmtM(m) : '—'; }
  function svgEl(n, a) { var e = document.createElementNS('http://www.w3.org/2000/svg', n); for (var k in a) e.setAttribute(k, a[k]); return e; }

  function renderFull(el, deals) {
    if (deals) el.__all = deals;                         // stash the full set; the range toggle re-renders from it
    deals = el.__all || deals || [];
    var range = el.__range || 'all';                     // window: all / 12 / 6 / 3 months (undated deals always shown).
    if (range !== 'all') {                                // default 'all' so the full backfilled history is visible;
      var cutoff = Date.now() - parseInt(range, 10) * 30 * 86400000;  // older loans (pre-12mo) were otherwise hidden.
      deals = deals.filter(function (d) { return !d.when || d.when >= cutoff; });
    }
    var a = agg(deals);
    var yearAgo = Date.now() - 365 * 86400000;
    var recent = deals.filter(function (d) { return d.when && d.when >= yearAgo; }).sort(function (x, y) { return y.when - x.when; }).slice(0, 8);

    // lenders — each with its market breakdown + deals. Credit each lender its OWN
    // tranche (syndicated deals split across their named lenders, never double-count).
    var lm = {};
    deals.forEach(function (d) {
      (d.lenders || []).forEach(function (p) {
        if (!p.name) return;
        var L = lm[p.name] || (lm[p.name] = { name: p.name, n: 0, amt: 0, cities: {}, deals: [] });
        L.n++; L.amt += (p.amt || 0);
        if (d.city) L.cities[d.city] = (L.cities[d.city] || 0) + (p.amt || 0);
        L.deals.push(d);
      });
    });
    var lenders = Object.keys(lm).map(function (k) { return lm[k]; }).sort(function (x, y) { return y.amt - x.amt || y.n - x.n; });

    // cities — each with lenders, deals, averaged coordinates. City $ is the sum of
    // whole-deal totals (no double-count); per-lender split uses tranche amounts.
    var cm = {};
    deals.forEach(function (d) {
      var c = d.city; if (!c) return;
      var C = cm[c] || (cm[c] = { city: c, n: 0, amt: 0, lenders: {}, deals: [], la: 0, lo: 0, nc: 0 });
      C.n++; C.amt += (d.amt || 0);
      (d.lenders || []).forEach(function (p) {
        if (p.name) C.lenders[p.name] = (C.lenders[p.name] || 0) + (p.amt || 0);
      });
      C.deals.push(d);
      if (d.lat != null && d.lng != null) { C.la += d.lat; C.lo += d.lng; C.nc++; }
    });
    var cities = Object.keys(cm).map(function (k) { var C = cm[k]; C.lat = C.nc ? C.la / C.nc : null; C.lng = C.nc ? C.lo / C.nc : null; return C; }).sort(function (x, y) { return y.amt - x.amt || y.n - x.n; });

    // Sankey flow data — built MARKET-FIRST so every shown market ties out to the
    // SAME total the Money map shows (no undercounting a market fed by a smaller
    // lender). Markets = top 16 by true total; each market's capital is fully drawn
    // — its top lenders as named bands, the rest folded into ONE "Other lenders"
    // band. marketDetail carries the COMPLETE per-market lender list so hovering a
    // market surfaces the same breakdown the map does, even for bundled lenders.
    var NAMED = 10, OTHER = 'Other lenders';
    var topLenders = lenders.filter(function (l) { return l.amt > 0; }).slice(0, NAMED);
    var namedSet = {}; topLenders.forEach(function (l) { namedSet[l.name] = 1; });
    // Rank markets by the capital the TOP lenders move into them (surfaces the
    // markets those lenders actually fund — the point of the flow view), then show
    // each at its TRUE total with EVERY lender: top lenders draw as named bands, the
    // rest fold into one "Other lenders" band so the market always ties out to the
    // Money map. marketDetail carries the complete per-market breakdown for hover.
    var fmk = {};
    topLenders.forEach(function (l) { Object.keys(l.cities).forEach(function (c) { if (l.cities[c] > 0) fmk[c] = (fmk[c] || 0) + l.cities[c]; }); });
    var cityByName = {}; cities.forEach(function (c) { cityByName[c.city] = c; });
    var topMarkets = Object.keys(fmk).sort(function (a, b) { return fmk[b] - fmk[a]; }).slice(0, 16);
    var flows = [], flt = {}, marketDetail = {}, fmarkets = [];
    topMarkets.forEach(function (name) {
      var C = cityByName[name]; if (!C) return;
      fmarkets.push({ name: name, total: C.amt });
      var entries = Object.keys(C.lenders).map(function (k) { return { name: k, amt: C.lenders[k] }; })
        .filter(function (x) { return x.amt > 0; }).sort(function (p, q) { return q.amt - p.amt; });
      var namedSum = 0;
      entries.forEach(function (e) {
        if (namedSet[e.name]) { flows.push({ l: e.name, m: name, v: e.amt }); flt[e.name] = (flt[e.name] || 0) + e.amt; namedSum += e.amt; }
      });
      // Everything not drawn as a named band — smaller lenders AND undisclosed-lender
      // deals — folds into one "Other" band so the market ties out to its TRUE total.
      var otherBand = C.amt - namedSum;
      if (otherBand > 0.5) { flows.push({ l: OTHER, m: name, v: otherBand }); flt[OTHER] = (flt[OTHER] || 0) + otherBand; }
      // Hover detail = the complete disclosed-lender list + any undisclosed remainder,
      // so it ties out to the same total the Money map shows for this market.
      var disclosed = entries.reduce(function (s, e) { return s + e.amt; }, 0);
      if (C.amt - disclosed > 0.5) entries = entries.concat([{ name: 'Undisclosed', amt: C.amt - disclosed }]);
      marketDetail[name] = entries;
    });
    var flenders = Object.keys(flt).map(function (k) { return { name: k, total: flt[k] }; })
      .sort(function (p, q) { return (p.name === OTHER) - (q.name === OTHER) || q.total - p.total; });

    el.className = 'tmw-money tmw-money--full';
    el.innerHTML = ''
      + '<div class="tmw-m-statrow">'
      + '<div class="s"><b>' + a.count + '</b><span>Financings tracked</span></div>'
      + '<div class="s"><b>' + (a.disclosed ? fmtM(a.disclosed) : '—') + '</b><span>Disclosed capital</span></div>'
      + '<div class="s"><b>' + a.markets + '</b><span>Markets receiving capital</span></div>'
      + '</div>'
      + '<div class="tmw-m-shell">'
      + '<div class="tmw-m-tabs"><div class="tmw-m-tabgroup">'
      + '<button class="tmw-m-tab on" data-mt="overview">Overview</button>'
      + '<button class="tmw-m-tab" data-mt="flow">Capital flow</button>'
      + '<button class="tmw-m-tab" data-mt="map">Money map</button>'
      + '<button class="tmw-m-tab" data-mt="lenders">Lenders</button>'
      + '</div><div class="tmw-m-range">'
      + [['3', '3M'], ['6', '6M'], ['12', '12M'], ['all', 'All']].map(function (r) { return '<button class="rg' + (range === r[0] ? ' on' : '') + '" data-rg="' + r[0] + '">' + r[1] + '</button>'; }).join('')
      + '</div></div>'
      + '<div class="tmw-m-view on" data-v="overview"><div class="tmw-m-grid">'
      + '<div class="col"><div class="h">Recent financings</div>' + recent.slice(0, 7).map(function (d) { return dealRow(d, 'r'); }).join('') + '</div>'
      + '<div class="col"><div class="h">Most active lenders</div>' + (lenders.length ? lenders.slice(0, 7).map(function (l) { return '<div class="r"><div class="rn"><div class="nm">' + esc(l.name) + '</div><div class="mt">' + l.n + (l.n === 1 ? ' deal' : ' deals') + '</div></div><span class="amt' + (l.amt ? '' : ' na') + '">' + (l.amt ? fmtM(l.amt) : '—') + '</span></div>'; }).join('') : '<div class="note">No lenders yet.</div>') + '</div>'
      + '<div class="col"><div class="h">Where capital is landing</div>' + cities.slice(0, 7).map(function (c) { return '<div class="r"><div class="rn"><div class="nm">' + esc(c.city) + '</div><div class="mt">' + c.n + (c.n === 1 ? ' deal' : ' deals') + '</div></div><span class="amt' + (c.amt ? '' : ' na') + '">' + (c.amt ? fmtM(c.amt) : '—') + '</span></div>'; }).join('') + '</div>'
      + '</div></div>'
      + '<div class="tmw-m-view" data-v="flow"><p class="tmw-m-cap">Who\'s funding what, where — <b>hover a lender</b> to trace its capital into markets.</p>'
      + '<div class="tmw-m-svgwrap"><svg class="tmw-m-sankey" viewBox="0 0 720 500" preserveAspectRatio="xMidYMid meet" aria-label="Capital flow from lenders to markets"></svg></div>'
      + '<div class="tmw-m-flowread"></div></div>'
      + '<div class="tmw-m-view" data-v="map"><p class="tmw-m-cap">Where capital is landing — <b>click a market</b> for its deals + lenders.</p>'
      + '<div class="tmw-m-mapgrid"><div class="tmw-m-mapbox" aria-label="Capital by market map"></div>'
      + '<div class="tmw-m-mapdetail"></div></div></div>'
      + '<div class="tmw-m-view" data-v="lenders"><p class="tmw-m-cap">Every lender is a page — <b>click a lender</b> to open its profile.</p>'
      + '<div class="tmw-m-lgrid"><div class="tmw-m-chips"></div><div class="tmw-m-lprofile"></div></div></div>'
      + '</div>';

    try { buildFlow(el.querySelector('.tmw-m-sankey'), flenders, fmarkets, flows, el.querySelector('.tmw-m-flowread'), marketDetail); } catch (e) {}
    try { buildMap(el.querySelector('.tmw-m-mapbox'), el.querySelector('.tmw-m-mapdetail'), cities); } catch (e) {}
    try { buildLenders(el.querySelector('.tmw-m-chips'), el.querySelector('.tmw-m-lprofile'), lenders); } catch (e) {}
    wireTabs(el);
    // Time-range toggle — re-render from the stashed full set with the new window,
    // then restore whichever tab was active (so toggling doesn't jump to Overview).
    Array.prototype.forEach.call(el.querySelectorAll('.tmw-m-range .rg'), function (b) {
      b.addEventListener('click', function () { el.__range = b.getAttribute('data-rg'); renderFull(el); });
    });
    if (el.__tab && el.__tab !== 'overview') { var _tb = el.querySelector('.tmw-m-tab[data-mt="' + el.__tab + '"]'); if (_tb) _tb.click(); }
  }

  function wireTabs(el) {
    var tabs = el.querySelectorAll('.tmw-m-tab'), views = el.querySelectorAll('.tmw-m-view');
    Array.prototype.forEach.call(tabs, function (t) {
      t.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs, function (x) { x.classList.remove('on'); }); t.classList.add('on');
        var v = t.getAttribute('data-mt'); el.__tab = v;
        Array.prototype.forEach.call(views, function (vw) { vw.classList.toggle('on', vw.getAttribute('data-v') === v); });
        if (v === 'map') { var mb = el.querySelector('.tmw-m-mapbox'); if (mb && mb.__initMap) mb.__initMap(); }
      });
    });
  }

  function buildFlow(svg, lenders, markets, flows, readEl, marketDetail) {
    if (!svg || !lenders.length || !markets.length) { if (readEl) readEl.textContent = 'Not enough disclosed financing to chart flows yet.'; if (svg) svg.parentNode.style.display = lenders.length ? '' : 'none'; return; }
    var W = 720, H = 500, padT = 24, padB = 14, lx = 8, lw = 11, rx = W - 8 - lw;
    var innerH = H - padT - padB;
    var Ltot = lenders.reduce(function (s, l) { return s + l.total; }, 0) || 1;
    // Thickness deliberately under-fills the column (0.55×); each column is then
    // distributed with EQUAL gaps to span the full height — so both sides are
    // top-and-bottom aligned, every node is evenly spaced, and the flows read thin.
    var maxN = Math.max(lenders.length, markets.length);
    var scale = (innerH - (maxN - 1) * 7) / Ltot * 0.55;
    var mById = {};
    function place(nodes, isMkt) {
      var hs = nodes.map(function (n) { return Math.max(3, n.total * scale); });
      var sumH = hs.reduce(function (a, b) { return a + b; }, 0);
      var gp = nodes.length > 1 ? Math.max(2, (innerH - sumH) / (nodes.length - 1)) : 0;
      var y = padT;
      nodes.forEach(function (n, i) { n._h = hs[i]; n._y = y; y += n._h + gp; if (isMkt) mById[n.name] = n; });
    }
    place(lenders, false); place(markets, true);
    var c1 = svgEl('text', { x: lx, y: 14, class: 'sk-col' }); c1.textContent = 'Lenders'; svg.appendChild(c1);
    var c2 = svgEl('text', { x: rx + lw, y: 14, class: 'sk-col', 'text-anchor': 'end' }); c2.textContent = 'Markets'; svg.appendChild(c2);
    // Fade each band's ends into the panel background so the lender/market labels
    // that sit over the band edges stay legible.
    var defs = svgEl('defs', {});
    var grad = svgEl('linearGradient', { id: 'skFade', gradientUnits: 'userSpaceOnUse', x1: lx + lw, y1: 0, x2: rx, y2: 0 });
    [['0', '#0c0e0c'], ['0.2', '#1FDF67'], ['0.8', '#1FDF67'], ['1', '#0c0e0c']].forEach(function (s) { grad.appendChild(svgEl('stop', { offset: s[0], 'stop-color': s[1] })); });
    defs.appendChild(grad); svg.appendChild(defs);
    var loff = {}, moff = {}, bg = svgEl('g', {}); svg.appendChild(bg);
    flows.forEach(function (f) {
      var l = null; lenders.forEach(function (x) { if (x.name === f.l) l = x; }); var m = mById[f.m]; if (!l || !m) return;
      var t = f.v * scale; loff[f.l] = loff[f.l] || 0; moff[f.m] = moff[f.m] || 0;
      var y1 = l._y + loff[f.l] + t / 2, y2 = m._y + moff[f.m] + t / 2; loff[f.l] += t; moff[f.m] += t;
      var x1 = lx + lw, x2 = rx, cx = (x1 + x2) / 2;
      var p = svgEl('path', { class: 'sk-band', d: 'M' + x1 + ',' + y1 + ' C' + cx + ',' + y1 + ' ' + cx + ',' + y2 + ' ' + x2 + ',' + y2, fill: 'none', stroke: 'url(#skFade)', 'stroke-width': Math.max(1, t), 'stroke-opacity': .16 });
      p.setAttribute('data-l', f.l); p.setAttribute('data-m', f.m); bg.appendChild(p);
    });
    function node(x, yy, h, label, val, anchor, tint, key, isL) {
      var g = svgEl('g', { class: 'sk-node' }); g.style.cursor = 'pointer';
      g.appendChild(svgEl('rect', { x: x, y: yy, width: lw, height: Math.max(2, h), rx: 2, fill: tint, 'fill-opacity': .85 }));
      var tx = anchor === 'start' ? x + lw + 7 : x - 7;
      var twoLine = h >= 22;
      var t1 = svgEl('text', { x: tx, y: yy + h / 2 + (twoLine ? -1 : 0), class: 'sk-label', 'text-anchor': anchor, 'dominant-baseline': 'middle' }); t1.textContent = label;
      g.appendChild(t1);
      if (twoLine) { var t2 = svgEl('text', { x: tx, y: yy + h / 2 + 11, class: 'sk-val', 'text-anchor': anchor, 'dominant-baseline': 'middle' }); t2.textContent = fmtM(val); g.appendChild(t2); }
      g.setAttribute(isL ? 'data-l' : 'data-m', key); return g;
    }
    lenders.forEach(function (l) { svg.appendChild(node(lx, l._y, l._h, l.name, l.total, 'start', '#f0d68a', l.name, true)); });
    markets.forEach(function (m) { svg.appendChild(node(rx, m._y, m._h, m.name, m.total, 'end', '#42EB81', m.name, false)); });
    var bands = svg.querySelectorAll('.sk-band'), nodes = svg.querySelectorAll('.sk-node');
    function hi(type, key) {
      Array.prototype.forEach.call(bands, function (b) { var on = type === 'l' ? b.getAttribute('data-l') === key : b.getAttribute('data-m') === key; b.setAttribute('stroke-opacity', on ? .6 : .05); });
      // For a MARKET, read the COMPLETE lender breakdown (marketDetail) so the
      // read-out ties out to the Money map — including lenders folded into the
      // "Other lenders" band on the chart. For a lender, list the markets it feeds.
      if (type === 'm' && marketDetail && marketDetail[key]) {
        var det = marketDetail[key];
        var mtot = det.reduce(function (s, e) { return s + e.amt; }, 0);
        readEl.innerHTML = '<b>' + esc(key) + '</b> — ' + fmtM(mtot) + ' in from ' + det.map(function (e) { return esc(e.name) + ' ' + fmtM(e.amt); }).join(' · ');
        return;
      }
      var tot = 0, parts = [];
      flows.forEach(function (f) { if ((type === 'l' ? f.l : f.m) === key) { tot += f.v; parts.push((type === 'l' ? f.m : f.l) + (type === 'l' ? ' ' + fmtM(f.v) : '')); } });
      readEl.innerHTML = '<b>' + esc(key) + '</b> — ' + fmtM(tot) + (type === 'l' ? ' → ' : ' in from ') + parts.join(' · ');
    }
    function reset() { Array.prototype.forEach.call(bands, function (b) { b.setAttribute('stroke-opacity', .16); }); readEl.textContent = 'Hover any lender or market to isolate its capital.'; }
    Array.prototype.forEach.call(nodes, function (g) { g.addEventListener('mouseenter', function () { g.getAttribute('data-l') ? hi('l', g.getAttribute('data-l')) : hi('m', g.getAttribute('data-m')); }); g.addEventListener('mouseleave', reset); });
    Array.prototype.forEach.call(bands, function (b) { b.style.cursor = 'pointer'; b.addEventListener('mouseenter', function () { hi('l', b.getAttribute('data-l')); }); b.addEventListener('mouseleave', reset); });
    reset();
  }

  // --- Mapbox GL (lazy) — the money map is a real map; GL handles projection +
  //     label collision (no more overlap). Same token/style as the main TMW map. ---
  var MB_TOKEN = 'pk.eyJ1IjoiZmxvcmlkYW9mdG9tb3Jyb3ciLCJhIjoiY2xrYmpmdGQ2MGdibTNzcXZjMnA4aXh3ZiJ9.uBeYS7jmKwWS6xAgY-R1UA';
  var MB_STYLE = 'mapbox://styles/floridaoftomorrow/clkbk4qlw000a01qw94rj0xa7';
  var _mbQ;
  function loadMapbox(cb) {
    if (window.mapboxgl) return cb();
    if (_mbQ) { _mbQ.push(cb); return; }
    _mbQ = [cb];
    var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://api.mapbox.com/mapbox-gl-js/v2.14.1/mapbox-gl.css'; document.head.appendChild(css);
    var s = document.createElement('script'); s.src = 'https://api.mapbox.com/mapbox-gl-js/v2.14.1/mapbox-gl.js';
    s.onload = s.onerror = function () { var q = _mbQ; _mbQ = null; q.forEach(function (f) { try { f(); } catch (e) {} }); };
    document.head.appendChild(s);
  }

  function buildMap(container, detailEl, cities) {
    if (!container) return;
    var geo = cities.filter(function (c) { return c.lat != null && c.lng != null && isFinite(c.lat) && isFinite(c.lng); })
      .sort(function (a, b) { return (b.amt || 0) - (a.amt || 0) || b.n - a.n; }).slice(0, 40);
    if (!geo.length) { if (detailEl) detailEl.innerHTML = '<div class="mp-empty">No geolocated capital yet.</div>'; return; }
    var byName = {}; geo.forEach(function (c) { byName[c.city] = c; });
    var maxv = 1; geo.forEach(function (c) { var v = c.amt || c.n * 60; if (v > maxv) maxv = v; });
    function detail(c) {
      if (!c) return;
      var ll = Object.keys(c.lenders).map(function (k) { return { n: k, v: c.lenders[k] }; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 5)
        .map(function (x) { return '<div class="mp-row"><span class="mp-n">' + esc(x.n) + '</span><span class="mp-a">' + _money(x.v) + '</span></div>'; }).join('') || '<div class="mp-row"><span class="mp-n">No named lender yet</span></div>';
      var dd = c.deals.slice().sort(function (a, b) { return (b.amt || 0) - (a.amt || 0) || (b.when || 0) - (a.when || 0); }).slice(0, 6)
        .map(function (d) { return '<a class="mp-row" href="' + esc(d.href) + '" target="_blank" rel="noopener"><span class="mp-n">' + esc(d.title) + '</span><span class="mp-a">' + _money(d.amt) + '</span></a>'; }).join('');
      detailEl.innerHTML = '<p class="mp-city">' + esc(c.city) + '</p><p class="mp-sub">' + _money(c.amt) + ' · ' + c.n + (c.n === 1 ? ' deal' : ' deals') + '</p>'
        + '<div class="mp-h">Lenders active here</div>' + ll + '<div class="mp-h">Deals</div>' + dd;
    }
    if (detailEl) detail(geo.filter(function (c) { return /^miami$/i.test(c.city); })[0] || geo[0]);
    function fallback() {
      var box = document.createElement('div'); box.className = 'tmw-m-mapfallback';
      geo.forEach(function (c) { var b = document.createElement('button'); b.innerHTML = '<span>' + esc(c.city) + '</span><span class="v">' + _money(c.amt) + '</span>'; b.addEventListener('click', function () { detail(c); }); box.appendChild(b); });
      container.innerHTML = ''; container.appendChild(box);
    }
    // A hidden / zero-size container can't init a GL map, so defer the build to
    // the first time the Money-map tab is shown (wireTabs calls __initMap).
    container.__initMap = function () {
      if (container.__built) { if (container.__map) container.__map.resize(); return; }
      container.__built = true;
      loadMapbox(function () {
        if (!window.mapboxgl) { fallback(); return; }
        try {
          mapboxgl.accessToken = MB_TOKEN;
          var map = new mapboxgl.Map({ container: container, style: MB_STYLE, center: [-94, 33.5], zoom: 3.4, attributionControl: false, cooperativeGestures: true, logoPosition: 'bottom-left' });
          container.__map = map;
          map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
          map.on('load', function () {
            var feats = geo.map(function (c) { return { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { city: c.city, amt: c.amt || 0, cap: _money(c.amt) } }; });
            map.addSource('cap', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
            map.addLayer({ id: 'cap-glow', type: 'circle', source: 'cap', paint: { 'circle-color': '#1FDF67', 'circle-opacity': 0.15, 'circle-blur': 0.5, 'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'amt']], 0, 7, Math.sqrt(maxv), 40] } });
            map.addLayer({ id: 'cap-dot', type: 'circle', source: 'cap', paint: { 'circle-color': '#1FDF67', 'circle-radius': 3.4, 'circle-stroke-color': 'rgba(0,0,0,.6)', 'circle-stroke-width': 1 } });
            map.addLayer({ id: 'cap-lab', type: 'symbol', source: 'cap', layout: { 'text-field': ['format', ['get', 'city'], {}, '\n', {}, ['get', 'cap'], { 'font-scale': 0.85 }], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'] }, paint: { 'text-color': '#ECEAE5', 'text-halo-color': '#0a0a0a', 'text-halo-width': 1.4 } });
            // Start framed on the continental US (where most capital lands);
            // international markets (Singapore, Riyadh, Dubai) are a pan/zoom away.
            function pick(e) { var f = e.features && e.features[0]; if (f) detail(byName[f.properties.city]); }
            ['cap-glow', 'cap-dot'].forEach(function (L) {
              map.on('click', L, pick);
              map.on('mouseenter', L, function () { map.getCanvas().style.cursor = 'pointer'; });
              map.on('mouseleave', L, function () { map.getCanvas().style.cursor = ''; });
            });
          });
          map.on('error', function () {});
          setTimeout(function () { try { map.resize(); } catch (e) {} }, 80);
        } catch (e) { fallback(); }
      });
    };
  }

  function buildLenders(chipsEl, profileEl, lenders) {
    if (!chipsEl) return;
    var top = lenders.slice(0, 14);
    if (!top.length) { chipsEl.innerHTML = '<div class="tmw-m-empty">No lenders tracked yet.</div>'; return; }
    function show(l) {
      Array.prototype.forEach.call(chipsEl.querySelectorAll('.mc-chip'), function (c) { c.classList.toggle('on', c.getAttribute('data-l') === l.name); });
      var mk = Object.keys(l.cities).map(function (k) { return { city: k, amt: l.cities[k] }; }).sort(function (a, b) { return b.amt - a.amt; });
      var mmax = (mk[0] && mk[0].amt) || 1;
      var bars = mk.filter(function (m) { return m.amt > 0; }).slice(0, 5).map(function (m) { return '<div class="mc-bar"><span class="bl">' + esc(m.city) + '</span><div class="bw"><i style="width:' + (m.amt / mmax * 100) + '%"></i></div><span class="bv">' + fmtM(m.amt) + '</span></div>'; }).join('') || '<div class="mc-subt">Markets not disclosed.</div>';
      var avg = l.n ? Math.round(l.amt / l.n) : 0;
      var deals = l.deals.slice().sort(function (a, b) { return (b.amt || 0) - (a.amt || 0) || (b.when || 0) - (a.when || 0); }).slice(0, 6).map(function (d) { return '<a class="mc-deal" href="' + esc(d.href) + '" target="_blank" rel="noopener"><span><span class="dn">' + esc(d.title) + '</span> <span class="dc">' + esc(d.city || '') + '</span></span><span class="dv">' + _money(d.amt) + '</span></a>'; }).join('');
      profileEl.innerHTML = '<p class="mc-name">' + esc(l.name) + '</p><p class="mc-tag">' + l.n + (l.n === 1 ? ' deal' : ' deals') + ' tracked</p>'
        + '<div class="mc-kpis"><div class="mc-kpi"><div class="k g">' + _money(l.amt) + '</div><div class="kl">Deployed</div></div>'
        + '<div class="mc-kpi"><div class="k">' + l.n + '</div><div class="kl">Deals</div></div>'
        + '<div class="mc-kpi"><div class="k">' + (avg ? fmtM(avg) : '—') + '</div><div class="kl">Avg check</div></div></div>'
        + '<div class="mc-h">Where it lends</div>' + bars + '<div class="mc-h">Recent deals</div>' + deals;
    }
    chipsEl.innerHTML = '';
    top.forEach(function (l) {
      var b = document.createElement('button'); b.className = 'mc-chip'; b.setAttribute('data-l', l.name);
      b.innerHTML = '<span><span class="cn">' + esc(l.name) + '</span><span class="cd">' + l.n + (l.n === 1 ? ' deal' : ' deals') + '</span></span><span class="cv">' + _money(l.amt) + '</span>';
      b.addEventListener('click', function () { show(l); });
      chipsEl.appendChild(b);
    });
    show(top.filter(function (l) { return /^tyko capital$/i.test(l.name); })[0] || top[0]);
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
    Promise.all([sharedJson(MONEY), sharedJson(LENDER_MAP).catch(function () { return null; })]).then(function (o) {
      var money = o[0], lmap = o[1] || { overrides: {}, hidden: [] };
      if (!money || !money.deals || !money.deals.length) return;
      var deals = financeDeals(money, lmap);
      pending.forEach(function (el) {
        try { (el.__mode === 'full' ? renderFull : renderTeaser)(el, deals); el.setAttribute('data-tmw-money-done', '1'); } catch (e) {}
      });
    });
  }

  window.tmwMoney = { mountAll: mountAll, financeDeals: financeDeals };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll); else mountAll();
})();
