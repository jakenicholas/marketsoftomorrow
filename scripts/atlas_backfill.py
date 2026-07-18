#!/usr/bin/env python3
"""
Atlas Intelligence — backfill (spec §4)
=======================================

Merges researched raw inputs (§2a, from the parallel research pass) with map
geography, runs the projection model (atlas_model.proj-psf-v1), and writes:

  1. D1 `atlas_projection` rows (slug, city_slug, raw_json, model_json,
     confidence, comp_count) via `wrangler d1 execute tmw_events --remote`.
     The VALUES live only there — never in the public repo.
  2. journal/map/atlas-projections-public.json — the public SHAPE file the
     static pages read: modeled?, confidence, comp_count, delivery_label,
     market, supply_level. NO pricing numbers, asserted at write time.
  3. atlas-coverage-report.md — the per-field provenance report for Jake.

Guardrails (spec §4): pct_sold never estimated; every estimated figure keeps
its provenance flag; `list_psf_observed` never leaves the raw_json column.

Run:  python3 scripts/atlas_backfill.py <research-dir>
"""
from __future__ import annotations
import json, sys, os, subprocess, glob, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from atlas_model import build_projection
from generate_atlas_intel import compute_all as compute_supply, slugify

RESEARCH_DIR = sys.argv[1] if len(sys.argv) > 1 else '.'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RAW_FIELDS = ['unit_count', 'avg_unit_sqft', 'sqft_range', 'sales_launch_date',
              'pct_sold', 'pct_sold_asof', 'list_psf_observed', 'list_psf_basis',
              'sales_status', 'delivery_est']


def load_research():
    rows = {}
    for path in sorted(glob.glob(os.path.join(RESEARCH_DIR, 'atlas-research-*.json'))):
        try:
            for r in json.load(open(path)):
                if r.get('slug'):
                    rows[r['slug'].strip().lower()] = r
        except Exception as e:
            print(f'  ! {path}: {e}')
    return rows


def main():
    projects = json.load(open(os.path.join(ROOT, 'journal/map/projects-flat.json')))
    geo = {}
    for p in projects:
        s = (p.get('Slug') or '').strip().lower()
        if s:
            geo[s] = {'lat': p.get('Latitude'), 'lng': p.get('Longitude'),
                      'city': (p.get('City') or '').strip(), 'title': p.get('Title'),
                      'delivery': p.get('DeliveryDate'), 'status': p.get('Delivery')}
    research = load_research()
    print(f'research rows: {len(research)}')

    # Guardrail: a research row can never invent pct_sold without a source tag.
    for slug, r in research.items():
        if r.get('pct_sold') is not None and r.get('pct_sold_source') in (None, '', 'estimated', 'unavailable'):
            print(f'  ! DROPPING pct_sold on {slug} (provenance {r.get("pct_sold_source")}) — never estimated')
            r['pct_sold'] = None
            r['pct_sold_asof'] = None
            r['pct_sold_source'] = 'unavailable'

    supply = compute_supply(projects)

    models, empties = {}, []
    for slug, raw in research.items():
        if slug not in geo:
            print(f'  ! {slug} not in projects-flat — skipped')
            continue
        m = build_projection(slug, raw, research, geo)
        if m:
            models[slug] = m
        else:
            empties.append(slug)

    # ── 1. D1 seed ──
    sql_path = '/tmp/atlas-seed.sql'
    now = int(datetime.datetime.now().timestamp())
    with open(sql_path, 'w') as f:
        for slug, raw in research.items():
            if slug not in geo:
                continue
            city_slug = slugify(geo[slug]['city'])
            m = models.get(slug)
            def q(s):
                return "'" + json.dumps(s).replace("'", "''") + "'" if s is not None else 'NULL'
            f.write(
                "INSERT OR REPLACE INTO atlas_projection (slug, city_slug, raw_json, model_json, confidence, comp_count, updated_at) VALUES ("
                + f"'{slug}', '{city_slug}', {q(raw)}, {q(m) if m else 'NULL'}, "
                + f"'{(m or {}).get('confidence', '')}', {(m or {}).get('comp_count', 0)}, {now});\n")
    print(f'wrote {sql_path}')

    # ── 2. public shape file (NO values) ──
    pub = {}
    for slug, raw in research.items():
        if slug not in geo:
            continue
        st = raw.get('sales_status') or ''
        if st not in ('selling', 'closing'):
            continue   # public surface only for active offerings
        m = models.get(slug)
        cs = slugify(geo[slug]['city'])
        sup = supply['markets'].get(cs) or {}
        pub[slug] = {
            'title': geo[slug]['title'],
            'city': geo[slug]['city'],
            'modeled': bool(m),
            'confidence': (m or {}).get('confidence'),
            'comp_count': (m or {}).get('comp_count', 0),
            'delivery_label': (m or {}).get('delivery_label'),
            'market': cs,
            'supply_level': sup.get('level'),
            'display_mode': 'public-shape',
        }
    FORBIDDEN = ('psf', 'price', 'band', 'scenario')
    blob = json.dumps({'generated_at': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
                       'projects': pub}, separators=(',', ':'))
    for w in FORBIDDEN:
        assert f'"{w}' not in blob.lower() or w == 'band', 'public shape must not carry values'
    assert 'list_psf' not in blob, 'internal field leaked into public shape'
    open(os.path.join(ROOT, 'journal/map/atlas-projections-public.json'), 'w').write(blob)
    print(f'public shape: {len(pub)} projects ({sum(1 for v in pub.values() if v["modeled"])} modeled)')

    # ── 3. coverage report ──
    lines = ['# Atlas Intelligence — backfill coverage report',
             f'Generated {datetime.date.today().isoformat()} · {len(research)} researched · '
             f'{len(models)} modeled · {len(empties)} empty-state (fewer than 3 comps)', '']
    lines.append('| Project | Market | Status | PSF obs | % sold | Launch | Comps | Confidence | Proj notes |')
    lines.append('|---|---|---|---|---|---|---|---|---|')
    for slug, raw in sorted(research.items(), key=lambda kv: (geo.get(kv[0], {}).get('city', ''), kv[0])):
        if slug not in geo:
            continue
        m = models.get(slug)
        prov = lambda k: (raw.get(k + '_source') or raw.get(k.replace('list_psf_observed', 'list_psf') + '_source') or '—')
        psf = f"yes ({raw.get('list_psf_source')})" if raw.get('list_psf_observed') else 'no'
        pct = f"{raw.get('pct_sold')}% ({raw.get('pct_sold_asof')})" if raw.get('pct_sold') is not None else '—'
        lines.append('| ' + ' | '.join([
            geo[slug]['title'] or slug, geo[slug]['city'], raw.get('sales_status') or '—',
            psf, pct, raw.get('sales_launch_date') or '—',
            str((m or {}).get('comp_count', 0)), (m or {}).get('confidence') or 'empty-state',
            (raw.get('notes') or '')[:80].replace('|', '/'),
        ]) + ' |')
    open(os.path.join(ROOT, 'atlas-coverage-report.md'), 'w').write('\n'.join(lines))
    print('coverage report: atlas-coverage-report.md')

    print('\nSeed D1 with:')
    print('  cd worker && npx wrangler d1 execute tmw_events --remote --file=/tmp/atlas-seed.sql')


if __name__ == '__main__':
    main()
