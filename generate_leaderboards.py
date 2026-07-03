#!/usr/bin/env python3
"""Build journal/leaderboards.json for the homepage "Live Leaderboards" board.

Reads journal/map/projects-flat.json (the source of truth) and computes four
ranked boards + a "newest to the database" strip + per-market counts for the
tabs. Week-over-week MOVEMENT (up/down/new) is computed by diffing the
previously-published leaderboards.json, so each build reflects real change with
no separate snapshot store. First run (no prior file) marks everything flat.

Run from the repo root (same place the other generate_*.py run):
    python3 generate_leaderboards.py
"""
import json, os, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'journal', 'map', 'projects-flat.json')
OUT = os.path.join(ROOT, 'journal', 'leaderboards.json')
TOP = 6

def to_int(v):
    try:
        return int(str(v).replace(',', '').strip())
    except (TypeError, ValueError):
        return 0

def pairs(names, slugs):
    """Zip aligned comma-lists of firm names + slugs into (name, slug) pairs."""
    ns = [n.strip() for n in str(names or '').split(',') if n.strip()]
    ss = [s.strip() for s in str(slugs or '').split(',') if s.strip()]
    out = []
    for i, n in enumerate(ns):
        out.append((n, ss[i] if i < len(ss) else ''))
    return out

def city_slug(c):
    return ''.join(ch if ch.isalnum() else '-' for ch in str(c or '').lower()).strip('-')

def firm_board(rows, name_key, slug_key):
    counts = collections.Counter()
    display = {}          # slug -> name (last seen)
    cities = collections.defaultdict(collections.Counter)
    for r in rows:
        for name, slug in pairs(r.get(name_key), r.get(slug_key)):
            key = slug or name.lower()
            counts[key] += 1
            display[key] = name
            c = (r.get('City') or '').strip()
            if c:
                cities[key][c] += 1
    out = []
    for key, n in counts.most_common(TOP):
        top_city = cities[key].most_common(1)
        out.append({
            'id': key,
            'name': display[key],
            'slug': key if '-' in key or key.isalpha() else '',
            'sub': (top_city[0][0] if top_city else ''),
            'count': n,
        })
    return out

def biggest_board(rows):
    # Floors + units on SEPARATE lines; no movement arrows here. (Units will be
    # swapped for Gross Floor Area (GFA) later — see the reminder note.)
    scored = []
    for r in rows:
        fl, un, ke = to_int(r.get('Floors')), to_int(r.get('Units')), to_int(r.get('Keys'))
        scale = fl * 1000 + un + ke        # floors dominate, then unit/key count
        if scale <= 0:
            continue
        lines = []
        if fl: lines.append(f'{fl} fl')
        gfa = to_int(r.get('GfaSqFt'))            # Gross Floor Area (populated in the Studio → gfa_sqft → GfaSqFt)
        if gfa: lines.append(f'{gfa:,} sq ft')    # prefer GFA; falls back to units/keys until GFA is populated
        elif un: lines.append(f'{un:,} units')
        elif ke: lines.append(f'{ke:,} keys')
        scored.append({
            'id': r.get('Slug') or r.get('Title'),
            'name': r.get('Title') or '',
            'slug': r.get('Slug') or '',
            'sub': ' · '.join([p for p in [(r.get('ProjectType') or '').split(',')[0].strip(), (r.get('City') or '').strip()] if p]),
            'metric_lines': lines,
            'scale': scale,
        })
    scored.sort(key=lambda x: x['scale'], reverse=True)
    return scored[:TOP]

def market_board(rows):
    counts = collections.Counter((r.get('City') or '').strip() for r in rows if (r.get('City') or '').strip())
    top = counts.most_common(TOP)
    mx = top[0][1] if top else 1
    return [{'id': city_slug(c), 'name': c, 'slug': city_slug(c), 'count': n,
             'pct': round(100 * n / mx)} for c, n in top]

def newest_strip(rows):
    dated = [r for r in rows if (r.get('UpdatedAt') or '').strip()]
    dated.sort(key=lambda r: r.get('UpdatedAt'), reverse=True)
    out = []
    for r in dated[:TOP]:
        out.append({
            'id': r.get('Slug') or r.get('Title'),
            'name': r.get('Title') or '',
            'slug': r.get('Slug') or '',
            'sub': (r.get('City') or '').strip(),
        })
    return out

def apply_movement(board, prev_board):
    """Emit mv = up N / down N / new / flat vs the previous ranking (by id)."""
    prev_rank = {row.get('id'): i for i, row in enumerate(prev_board or [])}
    for i, row in enumerate(board):
        pid = row.get('id')
        if not prev_board:
            row['mv'] = 'flat'
        elif pid not in prev_rank:
            row['mv'] = 'new'
        else:
            d = prev_rank[pid] - i          # positive = moved up
            row['mv'] = f'up {d}' if d > 0 else (f'down {-d}' if d < 0 else 'flat')
    return board

def main():
    with open(SRC, 'r', encoding='utf-8') as f:
        rows = json.load(f)
    prev = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, 'r', encoding='utf-8') as f:
                prev = json.load(f)
        except (json.JSONDecodeError, OSError):
            prev = {}

    market_counts = collections.Counter((r.get('City') or '').strip() for r in rows if (r.get('City') or '').strip())
    data = {
        'total': len(rows),
        'markets_tabs': [{'name': c, 'count': n} for c, n in market_counts.most_common(6)],
        'developers': apply_movement(firm_board(rows, 'Developer', 'DeveloperSlugs'), prev.get('developers')),
        'architects': apply_movement(firm_board(rows, 'Architect', 'ArchitectSlugs'), prev.get('architects')),
        'biggest':    biggest_board(rows),   # no movement arrows on the biggest board
        'markets':    market_board(rows),
        'newest':     newest_strip(rows),
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(f'  ✓ leaderboards.json — {len(rows)} projects → '
          f'{len(data["developers"])} devs, {len(data["architects"])} architects, '
          f'{len(data["biggest"])} biggest, {len(data["markets"])} markets')

if __name__ == '__main__':
    main()
