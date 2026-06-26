#!/usr/bin/env node
/*
  intel-search-audit.js — proactive COMPLETENESS audit for TMW Intelligence.

  Runs queries through the LIVE search resolution (journal-search-core.js) against
  the LIVE project database (projects-flat.json — the source of truth), and reports
  per query: what the search understood, how many results it returned, how many the
  database SHOULD return for that intent, and exactly which projects (if any) were
  dropped. Catches over-narrowing / missing-result bugs BEFORE a user hits them.

  Why this works: the search and the "truth" use the SAME place/type resolution, so
  a discrepancy means the search applied an extra (wrong) narrowing — e.g. treating
  "opening" as the strict 'Opening Soon' badge instead of the forward pipeline.

  Usage:
    node intel-search-audit.js queries.txt      # one query per line
    node intel-search-audit.js --generate 25    # auto-generate N varied queries
    echo "hotels opening in florida" | node intel-search-audit.js -
  Output: JSON report on stdout; a readable summary on stderr.
*/
'use strict';
const fs = require('fs');

const LIVE_CORE = 'https://www.oftmw.com/_shared/journal-search-core.js';
const LIVE_DATA = 'https://www.oftmw.com/map/projects-flat.json';
const NOW = process.env.AUDIT_NOW || new Date().toISOString().slice(0, 10);

async function load() {
  let coreSrc, data, source;
  try {
    coreSrc = await (await fetch(LIVE_CORE)).text();
    data = await (await fetch(LIVE_DATA)).json();
    source = 'live (oftmw.com)';
  } catch (e) {
    coreSrc = fs.readFileSync(__dirname + '/../journal/_shared/journal-search-core.js', 'utf8');
    data = JSON.parse(fs.readFileSync(__dirname + '/../projects-flat.json', 'utf8'));
    source = 'local repo';
  }
  global.window = {};
  // eslint-disable-next-line no-eval
  eval(coreSrc);
  const Core = global.window.TmwSearchCore;
  const items = Array.isArray(data) ? data : (data.projects || data.items || []);
  return { Core, items, source };
}

// The DB set a query SHOULD return for its parsed intent: place + type, narrowed
// to an explicit status if one was named, else the forward pipeline (everything
// still coming or just opened). This is the same contract smartFilter must meet.
function expectedSet(Core, items, s, nowMs) {
  return items.filter(function (p) {
    if (s.area) { if (!Core.inArea(p, s.area)) return false; }
    else if (s.region === 'Florida') { if (!Core.inFlorida(p)) return false; }
    if (s.cities && s.cities.length) {
      const cf = String(p.City || '').toLowerCase(), c0 = cf.split(',')[0].trim();
      if (!s.cities.some(function (c) { const n = c.toLowerCase(); return cf === n || c0 === n; })) return false;
    }
    if (s.types && s.types.size) {
      const pt = ((p.PreferredType || '') + ' ' + (p.ProjectType || '')).toLowerCase();
      let ok = false; s.types.forEach(function (t) { if (pt.indexOf(String(t).toLowerCase()) >= 0) ok = true; });
      if (!ok) return false;
    }
    if (s.firm) {
      const sig = String(s.firm.name || '').toLowerCase().split(/\s+/).filter(function (t) { return t.length > 2; });
      const a = String(p.Architect || '').toLowerCase(), d = String(p.Developer || '').toLowerCase();
      if (!(sig.length && (sig.every(function (t) { return a.indexOf(t) >= 0; }) || sig.every(function (t) { return d.indexOf(t) >= 0; })))) return false;
    }
    if (s.statuses && s.statuses.size) { if (!s.statuses.has(p.Delivery)) return false; }
    else if (Core.statusRankOf(p, nowMs) === 5) return false;   // default → forward pipeline (drop long-open)
    return true;
  });
}

// A spread of query shapes so coverage builds across places, types, statuses and
// phrasings. Varied per run by the seed (the date) so it isn't the same 25 daily.
const PLACES = ['florida', 'south florida', 'miami', 'west palm beach', 'naples', 'tampa bay', 'manhattan',
  'midtown', 'brooklyn', 'nashville', 'austin', 'charleston', 'the caribbean', 'japan', 'london', 'dubai',
  'the gulf', 'mexico', 'southwest florida', 'palm beach county', 'fort lauderdale', 'new york city'];
const TYPES = ['hotels', 'condos', 'resorts', 'office towers', 'mixed-use districts', 'golf communities',
  'museums', 'stadiums', 'residences', 'marinas', 'parks', 'airports', 'projects', 'towers'];
const SHAPES = [
  function (pl, ty) { return ty + ' opening in ' + pl; },
  function (pl, ty) { return 'new ' + ty + ' in ' + pl; },
  function (pl, ty) { return ty + ' coming to ' + pl; },
  function (pl, ty) { return 'what ' + ty + ' are opening in ' + pl + '?'; },
  function (pl, ty) { return 'how many ' + ty + ' are in the pipeline for ' + pl + '?'; },
  function (pl, ty) { return ty + ' under construction in ' + pl; },
  function (pl, ty) { return 'biggest ' + ty + ' in ' + pl; },
  function (pl)     { return 'what is being built in ' + pl + '?'; },
  function (pl)     { return 'projects in ' + pl; },
];
function generate(n, seed) {
  // deterministic-per-day shuffle so a day's set is reproducible but varies daily
  let x = 0; for (let i = 0; i < String(seed).length; i++) x = (x * 31 + String(seed).charCodeAt(i)) >>> 0;
  const rnd = function () { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const out = new Set();
  while (out.size < n) {
    const pl = PLACES[Math.floor(rnd() * PLACES.length)];
    const ty = TYPES[Math.floor(rnd() * TYPES.length)];
    const sh = SHAPES[Math.floor(rnd() * SHAPES.length)];
    out.add(sh(pl, ty));
  }
  return [...out];
}

function readQueries(argv) {
  const genIdx = argv.indexOf('--generate');
  if (genIdx >= 0) return generate(parseInt(argv[genIdx + 1] || '25', 10) || 25, NOW);
  const fileArg = argv.find(function (a) { return a && a[0] !== '-'; });
  let raw = '';
  if (fileArg && fileArg !== '-' && fs.existsSync(fileArg)) raw = fs.readFileSync(fileArg, 'utf8');
  else if (argv.includes('-')) raw = fs.readFileSync(0, 'utf8');
  else return generate(25, NOW);
  return raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
}

(async function main() {
  const { Core, items, source } = await load();
  if (!Core || !Core.parseSmartQuery) { console.error('search core failed to load'); process.exit(2); }
  const nowMs = new Date(NOW).getTime();
  const queries = readQueries(process.argv.slice(2));
  const report = [];
  for (const q of queries) {
    const s = Core.parseSmartQuery(q, { projects: items, firms: Core.__firms || [], now: NOW });
    if (!s) { report.push({ q, parsed: null, note: 'no structured parse (text-match path)' }); continue; }
    s.now = NOW;
    const got = Core.smartFilter(s, items);
    const want = expectedSet(Core, items, s, nowMs);
    const gotKeys = new Set(got.map(function (p) { return p.Title; }));
    const missing = want.filter(function (p) { return !gotKeys.has(p.Title); }).map(function (p) { return p.Title; });
    report.push({
      q,
      parsed: {
        place: s.area ? s.area.name : (s.cities && s.cities.length ? s.cities.join(' & ') : (s.region || null)),
        type: s.types ? [...s.types] : [], statuses: s.statuses ? [...s.statuses] : [],
        pipeline: !!s.pipeline, sort: s.sort ? s.sort.label : null, firm: s.firm ? s.firm.name : null,
      },
      search_count: got.length,
      expected_count: want.length,
      gap: missing.length,
      missing_sample: missing.slice(0, 12),
      sample: got.slice(0, 6).map(function (p) { return p.Title; }),
    });
  }
  const gaps = report.filter(function (r) { return r.gap > 0; });
  const summary = {
    now: NOW, source, total_projects: items.length,
    queries_tested: queries.length,
    clean: report.filter(function (r) { return r.parsed && r.gap === 0; }).length,
    gaps_found: gaps.length,
    health_pct: queries.length ? Math.round((1 - gaps.length / queries.length) * 100) : 100,
  };
  console.log(JSON.stringify({ summary, gaps, report }, null, 2));
  console.error('TMW Intelligence search audit — ' + summary.now + ' (' + source + ')');
  console.error('  ' + summary.queries_tested + ' queries · ' + summary.clean + ' clean · '
    + summary.gaps_found + ' GAPS · health ' + summary.health_pct + '%');
  gaps.slice(0, 15).forEach(function (r) {
    console.error('  GAP  "' + r.q + '"  search=' + r.search_count + ' expected=' + r.expected_count
      + ' missing: ' + r.missing_sample.slice(0, 5).join(', '));
  });
})();
