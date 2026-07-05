#!/usr/bin/env node
/*
  intel-goldens.js — GOLDEN FIXTURES for TMW search resolution.

  Unlike intel-search-audit.js (which derives its expectation from the SAME
  parse it tests, so resolver bugs pass as "clean"), every expectation here is
  INDEPENDENT: hand-set minimum counts, case-invariance pairs, phrasing-
  consistency pairs, place/type purity shares, and sort checks. If the resolver
  breaks — a region alias stops matching, a neighborhood stops resolving, case
  sensitivity creeps in — these fail loudly.

  Run:  node scripts/intel-goldens.js            (live core + live data)
        node scripts/intel-goldens.js --event    (JSON event for the routine)
  Exit: 0 all pass · 1 failures.
*/
'use strict';
const fs = require('fs');

const LIVE_CORE = 'https://www.oftmw.com/_shared/journal-search-core.js';
const LIVE_DATA = 'https://www.oftmw.com/map/projects-flat.json';
const NOW = process.env.AUDIT_NOW || new Date().toISOString().slice(0, 10);

// Independent expectations. minCount values are set WELL below the live DB
// reality (July 2026) so organic growth never flakes them — they exist to
// catch collapses (91 → 8), not drift (91 → 89).
const GOLDENS = [
  { q: 'miami',                              minCount: 60, cityShare: { match: /miami/i, min: 0.7 } },
  { q: 'MIAMI',                              equals: 'miami' },                      // case invariance
  { q: 'West Palm Beach',                    equals: 'west palm beach' },
  { q: 'brickell',                           minCount: 8,  cityShare: { match: /miami/i, min: 0.6 } },   // neighborhood → Miami
  { q: 'wynwood',                            minCount: 2,  cityShare: { match: /miami/i, min: 0.6 } },
  { q: 'south florida',                      minCount: 100 },                        // region fan-out
  { q: 'projects in south florida',          withinPctOf: { of: 'south florida', pct: 45 } },  // phrasing consistency
  { q: 'the palm beaches',                   minCount: 40 },
  { q: 'west palm beach',                    minCount: 35 },
  { q: 'new high rises in west palm beach',  minCount: 12 },                         // the documented 1-vs-45 bug
  { q: 'hotels in miami',                    minCount: 8,  typeShare: { match: /hotel|resort/i, min: 0.6 } },
  { q: 'nashville',                          minCount: 12 },
  { q: 'new york city',                      minCount: 25 },
  { q: 'manhattan',                          minCount: 10, cityShare: { match: /new york|manhattan/i, min: 0.6 } },
  { q: 'tampa bay',                          minCount: 15 },
  { q: 'tallest towers in florida',          minCount: 10, sortedByFloors: true },
];

async function load() {
  let coreSrc, data;
  try {
    coreSrc = await (await fetch(LIVE_CORE)).text();
    data = await (await fetch(LIVE_DATA)).json();
  } catch (e) {
    coreSrc = fs.readFileSync(__dirname + '/../journal/_shared/journal-search-core.js', 'utf8');
    data = JSON.parse(fs.readFileSync(__dirname + '/../projects-flat.json', 'utf8'));
  }
  global.window = {};
  eval(coreSrc);                                   // eslint-disable-line no-eval
  return { Core: global.window.TmwSearchCore, items: Array.isArray(data) ? data : (data.projects || data.items || []) };
}

// Mirrors the overlay's resolution chain: structured parse (ranked) →
// area/region fan-out → bare city → bare neighborhood → (text-match = miss).
function runQuery(Core, items, q) {
  const s = Core.parseSmartQuery(q, { projects: items, firms: Core.__firms || [], now: NOW });
  if (s) {
    s.now = NOW;
    return { parsed: true, path: 'structured', results: Core.smartRank(Core.smartFilter(s, items) || [], s) };
  }
  const area = Core.detectArea ? Core.detectArea(q, items) : null;
  if (area) return { parsed: true, path: 'area', results: items.filter((p) => Core.inArea(p, area)) };
  const norm = Core.norm;
  const full = norm(q).trim();
  if (full && full.split(/\s+/).length <= 4 && Core.buildCitySet) {
    let best = null;
    Core.buildCitySet(items).forEach((disp, nc) => { if (full === nc && (!best || nc.length > best.nc.length)) best = { disp, nc }; });
    if (best) {
      const target = norm(best.disp);
      return { parsed: true, path: 'city', results: items.filter((p) => norm(String(p.City || '').split(',')[0].trim()) === target) };
    }
    const nb = Core.detectNeighborhood ? Core.detectNeighborhood(q, items) : null;
    if (nb && nb.city) {
      const target = norm(nb.city);
      return { parsed: true, path: 'neighborhood→' + nb.city, results: items.filter((p) => norm(String(p.City || '').split(',')[0].trim()) === target) };
    }
  }
  return { parsed: false, results: [] };
}

(async function main() {
  const { Core, items } = await load();
  if (!Core || !Core.parseSmartQuery) { console.error('FATAL: search core failed to load'); process.exit(2); }
  const runs = {};                                  // q → results (for pair checks)
  const rows = [];
  let failures = 0;
  for (const g of GOLDENS) {
    const r = runQuery(Core, items, g.q);
    runs[g.q.toLowerCase()] = r;
    const n = r.results.length;
    const probs = [];
    if (!r.parsed) probs.push('did not parse (fell to text-match path)');
    if (g.minCount != null && n < g.minCount) probs.push(`count ${n} < min ${g.minCount}`);
    if (g.cityShare && n) {
      const share = r.results.filter((p) => g.cityShare.match.test(String(p.City || '') + ' ' + String(p.Neighborhood || ''))).length / n;
      if (share < g.cityShare.min) probs.push(`city purity ${(share * 100).toFixed(0)}% < ${g.cityShare.min * 100}%`);
    }
    if (g.typeShare && n) {
      const share = r.results.filter((p) => g.typeShare.match.test(String(p.PreferredType || '') + ' ' + String(p.ProjectType || ''))).length / n;
      if (share < g.typeShare.min) probs.push(`type purity ${(share * 100).toFixed(0)}% < ${g.typeShare.min * 100}%`);
    }
    if (g.equals) {
      const other = runs[g.equals] || runQuery(Core, items, g.equals);
      runs[g.equals] = other;
      if (other.results.length !== n) probs.push(`"${g.q}" → ${n} but "${g.equals}" → ${other.results.length} (must be identical)`);
    }
    if (g.withinPctOf) {
      const other = runs[g.withinPctOf.of] || runQuery(Core, items, g.withinPctOf.of);
      runs[g.withinPctOf.of] = other;
      const m = other.results.length || 1;
      const drift = Math.abs(n - m) / m * 100;
      if (drift > g.withinPctOf.pct) probs.push(`"${g.q}" → ${n} vs "${g.withinPctOf.of}" → ${m} (${drift.toFixed(0)}% apart > ${g.withinPctOf.pct}%)`);
    }
    if (g.sortedByFloors && n >= 3) {
      const fl = r.results.slice(0, 5).map((p) => parseInt(p.Floors, 10) || 0);
      const sorted = fl.every((v, i) => i === 0 || v <= fl[i - 1]);
      if (!sorted) probs.push(`top-5 not floor-sorted: [${fl.join(', ')}]`);
    }
    if (probs.length) failures++;
    rows.push({ q: g.q, count: n, pass: !probs.length, problems: probs });
    console.error((probs.length ? 'FAIL' : 'PASS') + `  ${g.q}  (${n})` + (probs.length ? '  — ' + probs.join(' · ') : ''));
  }
  const summary = { goldens: GOLDENS.length, failed: failures, health_pct: Math.round((1 - failures / GOLDENS.length) * 100), now: NOW };
  if (process.argv.includes('--event')) {
    console.log(JSON.stringify({ event: 'intel_goldens', props: { ...summary, report: rows.filter((r) => !r.pass) } }));
  } else {
    console.log(JSON.stringify({ ...summary, rows }, null, 1));
  }
  console.error(`goldens: ${GOLDENS.length} checks · ${failures} failing · health ${summary.health_pct}%`);
  process.exit(failures ? 1 : 0);
})();
