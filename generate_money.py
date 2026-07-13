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


# A single real-estate loan realistically tops out in the low tens of $B; a value
# above $50B ($50,000M) is almost always a unit error (raw dollars stored where
# millions were expected — "$600M" logged as 600000000). Reject it, re-parse note.
def sane_m(v):
    n = num(v)
    return n if (n is not None and 0 < n <= 50000) else None


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
            best = {'amt': amt, 'lender': lender or '', 'date': date}
    return best


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

    out = []
    for p in projects:
        amt = sane_m(p.get('FinancingAmountM'))
        lender = (p.get('FinancingLender') or '').strip()
        date = (p.get('FinancingDate') or '').strip()
        if amt is None:                                  # no sane flat amount → parse the notes
            fh = from_history(p.get('StatusHistory'))
            if fh:
                amt = fh['amt']
                if not lender:
                    lender = fh['lender']
                if not date:
                    date = fh['date']
            elif not lender and not date:
                continue
        if amt is None and not lender and not date:
            continue
        out.append({
            'title': p.get('Title') or '',
            'city': (p.get('City') or '').strip(),
            'dev': first_dev(p.get('Developer')),
            'href': 'https://www.oftmw.com/map/?project=' + map_slug(p.get('Title') or ''),
            'amt': amt,
            'lender': lender,
            'date': date,
            'lat': num(p.get('Latitude')),
            'lng': num(p.get('Longitude')),
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

    # Canonicalize lender casing/spacing → the most-common spelling, so variants
    # ("Tyko Capital" / "TYKO Capital") merge into one lender everywhere.
    casing = {}
    for d in dedup:
        if not d['lender']:
            continue
        casing.setdefault(lkey(d['lender']), {})
        casing[lkey(d['lender'])][d['lender']] = casing[lkey(d['lender'])].get(d['lender'], 0) + 1
    canon = {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in casing.items()}
    for d in dedup:
        if d['lender']:
            d['lender'] = canon.get(lkey(d['lender']), d['lender'])

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
    print('  ✓ money-flat.json — %d financings, $%.1fB disclosed, %d markets'
          % (len(dedup), disclosed / 1000, markets))


if __name__ == '__main__':
    main()
