#!/usr/bin/env python3
"""Build journal/map/money-flat.json — the CANONICAL "Follow the Money" dataset.

Ports the frontend money module's financing extraction to Python so there is ONE
source of truth (like firms-flat.json is for firms). Reads journal/map/projects-flat.json
and emits sanitized, de-duplicated, case-merged financing deals.

Both consumers read this file and apply the LIVE lender-map (overrides / hidden)
on top, so the Atlas "Follow the Money" surfaces and the admin Lenders tab always
agree — and neither shows the unit-error amounts the raw notes sometimes carry:
  - Atlas:  journal/_shared/intel-modules.js
  - Admin:  tmw-admin/map/index.html (Lenders tab)

Run from the repo root, after fetch_projects.py (which writes projects-flat.json):
    python3 generate_money.py
"""
import json, os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'journal', 'map', 'projects-flat.json')
OUT = os.path.join(ROOT, 'journal', 'map', 'money-flat.json')


def num(v):
    if v is None or v == '':
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if n == n and n not in (float('inf'), float('-inf')) else None


# A single real-estate construction loan realistically tops out around $2-3B (the
# largest disclosed deals in our data — Aman Singapore / SkyWaters — sit at ~$3B).
# A value above $6B ($6,000M) is almost always a unit OR currency error (raw dollars
# stored where millions were expected — "$600M" logged as 600000000 — or a THB/JPY
# figure read as USD, e.g. One Bangkok's THB 50B green loan logged as $50,000M).
# Reject it and re-parse the note for a sane figure.
def sane_m(v):
    n = num(v)
    return n if (n is not None and 0 < n <= 6000) else None


def note_amt(note):
    m = re.search(r'\$\s*([\d,]+(?:\.\d+)?)\s*(billion|bn|million|mm|m|b)\b', str(note or ''), re.I)
    if not m:
        return None
    v = float(m.group(1).replace(',', ''))
    return v * 1000 if re.match(r'^b', m.group(2), re.I) else v


def note_lender(note):
    m = re.search(r"\bfrom\s+([A-Z][A-Za-z0-9.&'’ -]{2,38}?)(?=\s*[,;(]|\s+(?:construction|bridge|senior|mezzanine|for|per|via|and|closed|to|in|on|at|loan)\b|$)", str(note or ''))
    if not m:
        return None
    lender = re.sub(r'\s+', ' ', m.group(1).strip())
    return lender if len(lender) >= 3 else None


def from_history(sh):
    if isinstance(sh, str):
        try:
            sh = json.loads(sh)
        except (ValueError, TypeError):
            return None
    if not isinstance(sh, list):
        return None
    best = None
    for h in sh:
        if not isinstance(h, dict):
            continue
        if not (h.get('phase') == 'financing' or re.search(r'financ|construction loan|refinanc', str(h.get('note') or ''), re.I)):
            continue
        amt = sane_m(h.get('loan_amount'))
        if amt is None:
            amt = sane_m(note_amt(h.get('note')))
        lender = h.get('lender') or note_lender(h.get('note'))
        date = h.get('effective_date') or h.get('source_published') or h.get('at') or ''
        if best is None or (amt or 0) > (best.get('amt') or 0):
            best = {'amt': amt, 'lender': lender or '', 'date': date, 'note': str(h.get('note') or '')}
    return best


# --- Liveness filter -------------------------------------------------------
# "Follow the Money" tells the PRIVATE development-capital story: who is lending
# to build what. Two things are NOT that and get filtered out here:
#  (a) civic / public infrastructure (stadiums, airports, universities, city
#      halls, museums, park expansions) — a public bond authority isn't a real-
#      estate lender, and these muddy the lender league table; and
#  (b) non-construction capital — municipal / TIF / green / conduit BONDS, public
#      facilities (EIB, Homes England, housing/aviation finance authorities), and
#      pure REFINANCINGS or PRE-DEVELOPMENT / site / bridge loans (not build money).
# A note that explicitly says "construction loan/financing" is always kept.
_CIVIC_TITLE = re.compile(r'\b(stadium|arena|ballpark|performing arts|city hall|'
                          r'courthouse|\bairport\b|university|\bcollege\b|museum|'
                          r'opera house|convention center|amphitheat|transit|'
                          r'rail station|seaport|cruise terminal|park expansion)\b', re.I)
_GOV_DEV = re.compile(r'\b(city of|county|university|port authority|aviation authority|'
                      r'housing finance authority|department of|state of|municipal)\b', re.I)
_NONCONSTR = re.compile(r'\b(refinanc|\brefi\b|pre-?development|pre-?dev|site loan|'
                        r'bridge loan|green bond|\bbond\b|tax-?exempt|\btif\b|conduit|'
                        r'\beib\b|european investment bank|homes england|'
                        r'housing finance authority|aviation authority|\bthda\b)\b', re.I)
_IS_CONSTR = re.compile(r'construction (?:loan|financing|facilit|debt)', re.I)


def exclude_reason(p, note):
    title = str(p.get('Title') or '')
    dev = str(p.get('Developer') or '')
    types = ' '.join(p.get('Types') or []) + ' ' + str(p.get('PreferredType') or '')
    if _CIVIC_TITLE.search(title) or re.search(r'\bstadium\b', types, re.I) or _GOV_DEV.search(dev):
        return 'civic/public'
    if _NONCONSTR.search(note) and not _IS_CONSTR.search(note):
        return 'non-construction capital (bond/refi/pre-dev)'
    return None


# --- Multi-lender split ----------------------------------------------------
# Pull every "$X <role> from <Lender>" tranche out of a financing note so a
# syndicated deal credits each lender its own slice in the league table
# (e.g. One Beverly Hills: $2.8B senior from J.P. Morgan + $1.5B mezz from VICI).
# Only trust the split when 2+ tranches are found AND they sum to ~the total;
# otherwise fall back to the single primary lender carrying the whole amount.
_TRANCHE = re.compile(
    r'\$\s*([\d.,]+)\s*((?i:billion|million|bn|mm|b|m))\b[^$]*?\bfrom\s+'
    r'([A-Z][A-Za-z0-9.&\'’ -]+?)(?=\s+(?:plus|and|with)\b|\s*[+;,]|\s*$)')


def parse_lenders(note, total, primary):
    note = str(note or '')
    found, seen = [], set()
    for m in _TRANCHE.finditer(note):
        amt = float(m.group(1).replace(',', '')) * (1000 if m.group(2)[0].lower() == 'b' else 1)
        name = re.sub(r'\s+', ' ', m.group(3)).strip(" .,-’'")
        if len(name) < 3:
            continue
        k = lkey(name)
        if k in seen:
            continue
        seen.add(k)
        found.append({'name': name, 'amt': round(amt, 3)})
    if len(found) >= 2 and total and abs(sum(x['amt'] for x in found) - total) <= max(50, 0.1 * total):
        return found
    if primary:
        return [{'name': primary, 'amt': total}]
    return [{'name': '', 'amt': total}] if total else []


def first_dev(v):
    for s in re.split(r'\s*[,/]\s*', str(v or '')):
        s = s.strip()
        if s and s.lower() != 'various':
            return s
    return ''


def map_slug(t):
    return re.sub(r'[^a-z0-9]+', '', str(t or '').lower())


def lkey(n):
    return re.sub(r'\s+', ' ', str(n).lower()).strip()


def main():
    with open(SRC, encoding='utf-8') as f:
        projects = json.load(f)

    out, excluded = [], []
    for p in projects:
        fh = from_history(p.get('StatusHistory')) or {}
        amt = sane_m(p.get('FinancingAmountM'))
        lender = (p.get('FinancingLender') or '').strip()
        date = (p.get('FinancingDate') or '').strip()
        note = fh.get('note', '')
        if amt is None:                                  # no sane flat amount → parse the notes
            amt = fh.get('amt')
        if not lender:
            lender = fh.get('lender', '')
        if not date:
            date = fh.get('date', '')
        if amt is None and not lender and not date:
            continue
        reason = exclude_reason(p, note)                 # drop civic + non-construction capital
        if reason:
            excluded.append((p.get('Title') or '', amt, reason))
            continue
        lenders = parse_lenders(note, amt, lender)       # split syndicated tranches
        out.append({
            'title': p.get('Title') or '',
            'city': (p.get('City') or '').strip(),
            'dev': first_dev(p.get('Developer')),
            'href': 'https://www.oftmw.com/map/?project=' + map_slug(p.get('Title') or ''),
            'amt': amt,
            'lender': ', '.join(x['name'] for x in lenders if x['name']) or lender,
            'lenders': lenders,
            'date': date,
            'lat': num(p.get('Latitude')),
            'lng': num(p.get('Longitude')),
            '_slug': (p.get('Slug') or '').strip(),           # internal, popped before write
            '_parent': (p.get('ParentSlug') or '').strip(),   # internal, popped before write
        })

    # Collapse a single SHARED loan recorded on multiple buildings of one project
    # (identical lender + amount + date) so it isn't double-counted.
    seen, dedup = set(), []
    for d in out:
        if d['lender'] and d['amt'] is not None:
            k = (d['lender'].lower(), d['amt'], d['date'])
            if k in seen:
                continue
            seen.add(k)
        dedup.append(d)

    # Collapse a shared loan recorded on BOTH a parent development and its child
    # (e.g. Aman Beverly Hills' $4.3B is the SAME package as its parent One Beverly
    # Hills' — different lender/date spellings dodge the exact-key dedup above).
    # Group by (parent-or-self slug, amount); keep ONE — prefer the parent's own
    # row, then any row that names a lender. Only same-parent same-amount rows
    # merge, so unrelated projects are never touched.
    groups = {}
    for i, d in enumerate(dedup):
        if d['amt'] is None:
            continue
        gk = ((d['_parent'] or d['_slug']), d['amt'])
        if not gk[0]:
            continue
        groups.setdefault(gk, []).append(i)
    drop = set()
    for (gslug, _amt), idxs in groups.items():
        if len(idxs) < 2:
            continue
        # survivor identity: prefer the parent's own row, then any row with a lender
        keep = min(idxs, key=lambda i: (0 if dedup[i]['_slug'] == gslug else 1,
                                        0 if dedup[i]['lender'] else 1))
        # keep the parent's name/href but borrow the named lender(s)/tranches/date
        # off a sibling when the parent's own row is blank
        if not dedup[keep]['lender']:
            for i in idxs:
                if dedup[i]['lender']:
                    dedup[keep]['lender'] = dedup[i]['lender']
                    dedup[keep]['lenders'] = dedup[i]['lenders']
                    break
        if not dedup[keep]['date']:
            for i in idxs:
                if dedup[i]['date']:
                    dedup[keep]['date'] = dedup[i]['date']
                    break
        drop.update(i for i in idxs if i != keep)
    dedup = [d for i, d in enumerate(dedup) if i not in drop]
    for d in dedup:                                   # drop internal keys
        d.pop('_slug', None)
        d.pop('_parent', None)

    # Canonicalize lender casing/spacing → the most-common spelling, so variants
    # ("Tyko Capital" / "TYKO Capital") merge into one lender everywhere. Operates
    # on the per-tranche NAMES, then re-derives each deal's display string.
    casing = {}
    for d in dedup:
        for ld in d.get('lenders') or []:
            nm = ld.get('name')
            if not nm:
                continue
            casing.setdefault(lkey(nm), {})
            casing[lkey(nm)][nm] = casing[lkey(nm)].get(nm, 0) + 1
    canon = {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in casing.items()}
    for d in dedup:
        for ld in d.get('lenders') or []:
            if ld.get('name'):
                ld['name'] = canon.get(lkey(ld['name']), ld['name'])
        d['lender'] = ', '.join(x['name'] for x in (d.get('lenders') or []) if x['name']) or d['lender']

    disclosed = sum(d['amt'] for d in dedup if d['amt'])
    markets = len({d['city'] for d in dedup if d['city']})
    data = {
        '_comment': 'Canonical Follow-the-Money dataset (sanitized, deduped, case-merged). '
                    'Generated by generate_money.py from projects-flat.json. Read by the Atlas '
                    'money module AND the admin Lenders tab; both apply the live lender-map on top.',
        'total': len(dedup),
        'disclosed_m': round(disclosed),
        'markets': markets,
        'deals': dedup,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    syndicated = sum(1 for d in dedup if len(d.get('lenders') or []) > 1)
    print('  ✓ money-flat.json — %d financings, $%.1fB disclosed, %d markets '
          '(%d syndicated, %d filtered out as non-live)'
          % (len(dedup), disclosed / 1000, markets, syndicated, len(excluded)))
    from collections import Counter
    for reason, n in Counter(r for _, _, r in excluded).items():
        print('      – %d %s' % (n, reason))


if __name__ == '__main__':
    main()
