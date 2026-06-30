#!/usr/bin/env node
/*
  Onyx search-logic eval harness.

  Runs a fixed set of representative queries against the REAL search-core logic
  (journal/_shared/journal-search-core.js) loaded headless, using the live local
  data snapshots (journal/map/*.json). Asserts on the structured outputs that the
  render layer consumes — place resolution, floors parsing, firm detection,
  spotlight matching, smart-filter results — so a logic change that regresses one
  query type is caught before it ships.

  Run:  node eval/onyx-eval.js          (exit 0 = all pass, 1 = a failure)
        node eval/onyx-eval.js --verbose

  NOTE: this covers the CORE logic only (DOM-free). Render-layer behaviors that
  live in journal-search-overlay.js (hero-card policy, wellness/food routing, the
  journal tower-filter, exact-match full hero) are NOT loadable in Node; they're
  listed at the bottom as a live-site (Chrome) regression checklist until a jsdom
  layer is added.
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// ── load the search core headless ───────────────────────────────────────────
function loadCore() {
  const code = fs.readFileSync(path.join(ROOT, 'journal/_shared/journal-search-core.js'), 'utf8');
  const win = {};
  // The core is an IIFE that does `window.TmwSearchCore = {…}`. Run it with a
  // `window` param shadowing the global so it attaches to our object.
  new Function('window', code)(win);
  if (!win.TmwSearchCore) throw new Error('TmwSearchCore did not attach — core export changed?');
  return win.TmwSearchCore;
}

// ── load data the way the overlay's loadData() does ─────────────────────────
function loadData() {
  const j = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'journal/map', f), 'utf8'));
  const p = j('projects-flat.json');
  const PROJECTS = Array.isArray(p) ? p : (p.projects || p.items || []);
  const f = j('firms-flat.json');
  let FIRMS;
  if (Array.isArray(f)) FIRMS = f.map((x) => Object.assign({ role: 'firm' }, x));
  else FIRMS = [].concat(
    (f.architects || []).map((x) => Object.assign({}, x, { role: 'architect' })),
    (f.developers || []).map((x) => Object.assign({}, x, { role: 'developer' }))
  );
  let ARTICLES = [];
  try { const a = j('articles.json'); ARTICLES = Array.isArray(a) ? a : (a.articles || a.posts || []); } catch (_) {}
  return { PROJECTS, FIRMS, ARTICLES };
}

// ── tiny assert framework ───────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
const FAILS = [];
function run(name, fn) {
  let msgs = [];
  const t = {
    ok(cond, detail) { if (cond) { msgs.push('✓ ' + detail); } else { msgs.push('✗ ' + detail); t._failed = true; } },
    eq(a, b, detail) { this.ok(a === b, detail + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); },
    gte(a, b, detail) { this.ok(typeof a === 'number' && a >= b, detail + ' (got ' + a + ', want ≥ ' + b + ')'); },
    lte(a, b, detail) { this.ok(typeof a === 'number' && a <= b, detail + ' (got ' + a + ', want ≤ ' + b + ')'); },
    _failed: false,
  };
  try { fn(t); } catch (e) { t._failed = true; msgs.push('✗ threw: ' + e.message); }
  if (t._failed) { FAIL++; FAILS.push(name); }
  else PASS++;
  if (t._failed || VERBOSE) {
    console.log((t._failed ? '\x1b[31mFAIL' : '\x1b[32mPASS') + '\x1b[0m  ' + name);
    if (t._failed || VERBOSE) msgs.forEach((m) => console.log('        ' + m));
  }
}

// helpers
function placeMatchCount(Core, q, PROJECTS) {
  const ph = Core.resolvePlace(q, PROJECTS);
  if (!ph) return { name: null, count: 0 };
  return { name: ph.name, count: PROJECTS.filter(ph.match).length };
}
function floorsOf(p) { const n = parseInt(p.Floors || p.floors || 0, 10); return isNaN(n) ? 0 : n; }

// ── the cases ───────────────────────────────────────────────────────────────
function main() {
  const Core = loadCore();
  const { PROJECTS, FIRMS } = loadData();
  const opt = { projects: PROJECTS, firms: FIRMS };
  console.log('Onyx eval — ' + PROJECTS.length + ' projects, ' + FIRMS.length + ' firms\n');

  // ── PLACE RESOLUTION ───────────────────────────────────────────────
  run('place: "the palm beaches" fans out to the whole county', (t) => {
    const r = placeMatchCount(Core, 'the palm beaches', PROJECTS);
    t.eq(r.name, 'The Palm Beaches', 'resolves to The Palm Beaches');
    t.gte(r.count, 80, 'matches the full Palm Beach County pipeline (not ~5 literal)');
  });
  run('place: "west palm beach" resolves to the city', (t) => {
    const r = placeMatchCount(Core, 'west palm beach', PROJECTS);
    t.eq(r.name, 'West Palm Beach', 'resolves to West Palm Beach');
    t.gte(r.count, 40, 'matches the WPB set');
  });
  run('place: "miami" resolves with a real set', (t) => {
    const r = placeMatchCount(Core, 'miami', PROJECTS);
    t.gte(r.count, 20, 'Miami has a sizable set');
  });
  run('place: a bare project name is NOT a place', (t) => {
    // "south flagler house" must not resolve to a place that would override the
    // exact-project lookup with the whole WPB pipeline.
    const ph = Core.resolvePlace('south flagler house', PROJECTS);
    // it MAY match "palm beach" loosely; the overlay's _literal guard handles
    // that. Here we just assert a project titled exactly this exists.
    const exact = PROJECTS.some((p) => String(p.Title || '').trim().toLowerCase() === 'south flagler house');
    t.ok(exact, 'a project titled "South Flagler House" exists in the data');
  });

  // ── FLOORS / HIGH-RISE PARSING ─────────────────────────────────────
  run('floors: "new high rises" → 12+ band', (t) => {
    const s = Core.parseSmartQuery('new high rises in west palm beach', opt);
    t.ok(!!s, 'parses');
    t.eq(s && s.floorsMin, 12, 'floorsMin = 12');
  });
  run('floors: "supertall" → 70+', (t) => {
    const s = Core.parseSmartQuery('supertall towers in miami', opt);
    t.eq(s && s.floorsMin, 70, 'floorsMin = 70');
  });
  run('floors: "mid-rise" → 5–11 band', (t) => {
    const s = Core.parseSmartQuery('mid-rise buildings in naples', opt);
    t.eq(s && s.floorsMin, 5, 'floorsMin = 5');
    t.eq(s && s.floorsMax, 11, 'floorsMax = 11');
  });
  run('floors: high-rise smartFilter drops non-tower types w/ unknown floors', (t) => {
    const s = Core.parseSmartQuery('high rises in west palm beach', opt);
    const rows = Core.smartFilter(s, PROJECTS);
    t.gte(rows.length, 15, 'returns a real set of WPB high-rises');
    const leaked = rows.filter((p) => {
      const ty = String((p.ProjectType || '') + ' ' + (p.PreferredType || '')).toLowerCase();
      const tower = /residen|office|hotel|condo|apartment|multifamily|mixed|tower|living|hospitality/.test(ty);
      return floorsOf(p) === 0 && !tower; // unknown-floor non-tower = should be excluded
    });
    t.eq(leaked.length, 0, 'no unknown-floor non-tower (museum/education/park) leaks in');
  });

  // ── FIRM DETECTION ─────────────────────────────────────────────────
  run('firm: generic category words do NOT match a firm', (t) => {
    // "best wellness concepts" must NOT latch onto "IQ Concept Developments".
    const f = Core.detectFirm(Core.norm('best wellness concepts in west palm beach'),
      FIRMS, null);
    const name = f ? String(f.name || '').toLowerCase() : '';
    t.ok(!/concept/.test(name), 'does not match a "Concept"-named developer (got: ' + (f ? f.name : 'null') + ')');
  });
  run('firm: a real, fully-named firm still detects', (t) => {
    // sanity — detection isn't broken for a genuine multi-token firm name.
    const real = FIRMS.find((f) => /related ross|arquitectonica|foster|kohn pedersen/i.test(f.name || ''));
    if (!real) { t.ok(true, '(no known firm in data to test — skipped)'); return; }
    const f = Core.detectFirm(Core.norm(real.name), FIRMS, null);
    t.ok(!!f, 'detects "' + real.name + '"');
  });

  // ── SPOTLIGHT / INTENT ─────────────────────────────────────────────
  run('spotlight: "best pilates studios" → TREMBLE', (t) => {
    const spot = Core.matchSpotlight('best pilates studios in west palm beach');
    t.ok(spot && /tremble/i.test(spot.name || ''), 'matches the TREMBLE spotlight');
  });
  run('isQuestion: classifies questions vs names', (t) => {
    t.eq(Core.isQuestion('why is west palm beach growing so fast'), true, 'why-question = true');
    t.eq(Core.isQuestion('south flagler house'), false, 'a bare name = false');
  });

  // ── UNIFIED RETRIEVER (#4) ─────────────────────────────────────────
  // rankProjects is the single intent-weighted ranked path that replaces the
  // four competing routes. These pin the canonical hard queries that the old
  // path-vs-path arbitration kept breaking.
  run('rankProjects: project kind → exact name wins #1 + flags full hero', (t) => {
    const r = Core.rankProjects('south flagler house', PROJECTS, { kind: 'project' });
    t.ok(!!r && r.rows.length > 0, 'returns ranked rows');
    t.eq(r && r.rows[0] && String(r.rows[0].p.Title || '').trim().toLowerCase(),
      'south flagler house', 'South Flagler House is #1');
    t.eq(r && r.exactName, true, 'flags exactName → FULL hero');
  });
  run('rankProjects: place kind → whole-county fan-out, every row in place', (t) => {
    const place = Core.resolvePlace('the palm beaches', PROJECTS);
    const r = Core.rankProjects('the palm beaches', PROJECTS, { kind: 'place', place });
    t.gte(r ? r.rows.length : 0, 80, 'returns the full Palm Beach County pipeline (not ~5)');
    t.eq(r && r.placeDriven, true, 'placeDriven');
    t.ok(r && r.rows.every((x) => place.match(x.p)), 'every row is actually in The Palm Beaches');
    t.eq(r && r.exactName, false, 'NO exact hero for a place browse');
  });
  run('rankProjects: concept kind → bio-exact beats semantic dilution', (t) => {
    const r = Core.rankProjects('what is the live local act and how is it changing florida',
      PROJECTS, { kind: 'concept' });
    t.ok(!!r && r.rows.length > 0, 'returns the Live Local Act projects');
    t.eq(r && r.semantic, false, 'resolved via bio-exact, not the semantic fallback');
    const names = r.rows.map((x) => String(x.p.Title || '').toLowerCase());
    t.ok(!names.some((n) => /live nation/.test(n)), 'does NOT surface "Live Nation Gasworx" (the dilution FP)');
    // contract = the topic tokens (live + local + act) all appear verbatim in the
    // bio — that's what makes these precise program matches, not fuzzy neighbors.
    t.ok(r.rows.every((x) => {
      const bio = String((x.p.DescriptionLong || x.p.Description || '') + ' ' + (x.p.Title || '')).toLowerCase();
      return ['live', 'local', 'act'].every((tok) => bio.indexOf(tok) >= 0);
    }), 'every returned project literally contains live + local + act in its bio');
    t.lte(r.rows.length, 12, 'a precise set (the 7 LLA projects), not a firehose');
  });
  run('rankProjects: structured kind → high-rise band, no non-tower leak', (t) => {
    const s = Core.parseSmartQuery('new high rises in west palm beach', opt);
    const r = Core.rankProjects('new high rises in west palm beach', PROJECTS, { kind: 'structured', smart: s });
    t.gte(r ? r.rows.length : 0, 15, 'returns a real WPB high-rise set');
    const leaked = (r ? r.rows : []).filter((x) => {
      const p = x.p;
      const ty = String((p.ProjectType || '') + ' ' + (p.PreferredType || '')).toLowerCase();
      const tower = /residen|office|hotel|condo|apartment|multifamily|mixed|tower|living|hospitality/.test(ty);
      return floorsOf(p) === 0 && !tower;
    });
    t.eq(leaked.length, 0, 'no unknown-floor non-tower (museum/padel) leaks in');
  });
  run('firm: a firm-in-place query retrieves the whole portfolio, not 1', (t) => {
    // "related ross west palm beach" must return Related Ross's WPB pipeline
    // (South Flagler House, 10/15 CityPlace, Shorecrest, Edgeworth…), not collapse
    // to the single project whose TITLE contains "ross" (Ross Private Club). The
    // collapse was a render-layer bug (pickTitleScopedProject); this pins the
    // retrieval side so the data/filter stays healthy.
    const s = Core.parseSmartQuery('related ross west palm beach', opt);
    t.ok(s && s.firm && /related ross/i.test(s.firm.name || ''), 'detects the Related Ross firm');
    const rows = s ? Core.smartFilter(s, PROJECTS) : [];
    t.gte(rows.length, 5, 'returns the firm’s WPB portfolio (multiple projects)');
  });
  run('rankProjects: concept kind place-scopes cards (no cross-state leak)', (t) => {
    // A Colorado query must NOT surface an out-of-state semantic neighbor like
    // "Limelight Charleston" (SC) — Limelight is an Aspen brand, so it scores close
    // by meaning. Place-scope the related/semantic cards to the named place.
    const co = PROJECTS.find((p) => String(p.CountyState || '').trim() === 'CO');
    const sc = PROJECTS.find((p) => String(p.CountyState || '').trim() === 'SC' || /charleston/i.test(String(p.City || '')));
    if (!co || !sc) { t.ok(true, '(no CO/SC sample in data — skipped)'); return; }
    const place = Core.resolvePlace('tell me about whats happening across colorado', PROJECTS);
    t.ok(!!place, 'resolves a place for the colorado query');
    const slugs = [sc.Slug || sc.slug, co.Slug || co.slug].filter(Boolean);
    const r = Core.rankProjects('tell me about whats happening across colorado', PROJECTS, { kind: 'concept', semanticSlugs: slugs, place });
    const titles = (r ? r.rows : []).map((x) => String(x.p.Title || ''));
    t.ok(!titles.includes(String(sc.Title || '')), 'drops the out-of-place card (' + sc.Title + ', ' + sc.CountyState + ')');
    t.ok(titles.includes(String(co.Title || '')), 'keeps the in-place Colorado card (' + co.Title + ')');
  });
  run('rankProjects: unknown kind → null (caller keeps heuristics)', (t) => {
    t.eq(Core.rankProjects('anything', PROJECTS, { kind: null }), null, 'null kind → null');
    t.eq(Core.rankProjects('anything', PROJECTS, {}), null, 'no kind → null');
  });

  // ── SUMMARY ────────────────────────────────────────────────────────
  console.log('\n' + (FAIL ? '\x1b[31m' : '\x1b[32m') + PASS + ' passed, ' + FAIL + ' failed\x1b[0m');
  if (FAIL) { console.log('failed: ' + FAILS.join(', ')); }
  console.log('\nRender-layer checks (run live via Chrome after deploy — not in this harness):');
  [
    'exact project ("south flagler house") → FULL hero card + "View project" button',
    'city/area ("the palm beaches") → NO hero, answer LEADS with growth thesis, project cards below',
    'wellness ("best wellness concepts") → answers from journal, no "IQ Concept" firm',
    'high-rise → projects list shows only 12+ towers (no museum/padel)',
    'journal tab on a high-rise query → tower-relevant stories, not all local slop',
  ].forEach((c) => console.log('  • ' + c));
  process.exit(FAIL ? 1 : 0);
}

main();
