#!/usr/bin/env python3
"""
generate_intel.py -- TMW Intelligence data pipeline.

Reads the TMW Google Sheet CSV. For every project that's still in flight
(status != "Now Open"), tries to find historical comparables from the
"Now Open" set in the same project type and metro. If enough comparables
are found, computes a median time-to-completion estimate and writes it
to intel.json alongside pulse.json.

The frontend reads intel.json and renders an intel block on the project
modal + a small intel chip in the map pin popup. Projects without enough
comparables get no block (graceful degradation).

Run after generate_pages.py and generate_pulse.py in the workflow. Uses
only existing CSV columns: Title, City, ProjectType, Delivery, StartDate,
DeliveryDate. No new sheet columns required.

Confidence tiers:
  high   - 8+ exact matches (same type AND same metro)
  medium - 3-7 exact OR 8+ relaxed (same type, any metro)
  low    - 1-2 exact OR 3-7 relaxed
  none   - skip the project

Usage:
    python generate_intel.py
"""

import csv
import io
import json
import re
import sys
import urllib.request
from datetime import date
from statistics import median


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SHEET_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1qwU7ykIDUrtPlIQu-qk2FIJwiz-WWg5caq02ja30sgM/export?format=csv&gid=0"
)
OUTPUT_PATH = "intel.json"

# Minimum comparables to compute an estimate at each confidence level.
# Tuned permissively for v1 -- once we see real coverage on the live site
# we can tighten these. The intel block stays hidden if a project doesn't
# qualify at any tier so over-permissive only hurts confidence labeling,
# not data integrity.
THRESH_HIGH_EXACT = 5      # type + metro
THRESH_MEDIUM_EXACT = 3
THRESH_MEDIUM_RELAXED = 5  # type only (any metro)
THRESH_LOW_EXACT = 1
THRESH_LOW_RELAXED = 3

# How many comparables to surface in the UI block (closest by similarity).
TOP_COMPARABLES = 3


# ---------------------------------------------------------------------------
# Metro map: cities are grouped into metros so Miami + Miami Beach + Bal
# Harbour all count as "South Florida" comparables for each other. Broader
# than state (FL covers Tampa Bay, Orlando, etc separately) but narrower
# than country.
# ---------------------------------------------------------------------------

CITY_TO_METRO = {
    # South Florida metro -- one of the densest dev markets in the US
    'miami':            'South Florida',
    'miami beach':      'South Florida',
    'south beach':      'South Florida',
    'coral gables':     'South Florida',
    'coconut grove':    'South Florida',
    'pinecrest':        'South Florida',
    'doral':            'South Florida',
    'aventura':         'South Florida',
    'sunny isles':      'South Florida',
    'sunny isles beach':'South Florida',
    'north miami':      'South Florida',
    'north miami beach':'South Florida',
    'surfside':         'South Florida',
    'bay harbor islands':'South Florida',
    'bay harbour islands':'South Florida',
    'indian creek':     'South Florida',
    'fisher island':    'South Florida',
    'key biscayne':     'South Florida',
    'virginia key':     'South Florida',
    'bal harbour':      'South Florida',
    'bal harbor':       'South Florida',
    'brickell':         'South Florida',
    'edgewater':        'South Florida',
    'wynwood':          'South Florida',
    'allapattah':       'South Florida',
    'overtown':         'South Florida',
    'little havana':    'South Florida',
    'little river':     'South Florida',
    'design district':  'South Florida',
    'midtown miami':    'South Florida',
    'downtown miami':   'South Florida',
    'fort lauderdale':  'South Florida',
    'ft lauderdale':    'South Florida',
    'ft. lauderdale':   'South Florida',
    'pompano beach':    'South Florida',
    'oakland park':     'South Florida',
    'wilton manors':    'South Florida',
    'hollywood':        'South Florida',
    'dania beach':      'South Florida',
    'dania':            'South Florida',
    'hallandale beach': 'South Florida',
    'hallandale':       'South Florida',
    'plantation':       'South Florida',
    'sunrise':          'South Florida',
    'davie':            'South Florida',
    'cooper city':      'South Florida',
    'pembroke pines':   'South Florida',
    'miramar':          'South Florida',
    'weston':           'South Florida',
    'deerfield beach':  'South Florida',
    'parkland':         'South Florida',
    'coconut creek':    'South Florida',
    'coral springs':    'South Florida',

    # Palm Beach metro -- distinct dev character (more luxury/lower density)
    'west palm beach':  'Palm Beach',
    'palm beach':       'Palm Beach',
    'palm beach gardens':'Palm Beach',
    'the palm beaches': 'Palm Beach',
    'north palm beach': 'Palm Beach',
    'jupiter':          'Palm Beach',
    'jupiter island':   'Palm Beach',
    'tequesta':         'Palm Beach',
    'hobe sound':       'Palm Beach',
    'stuart':           'Palm Beach',
    'jensen beach':     'Palm Beach',
    'palm city':        'Palm Beach',
    'port st. lucie':   'Palm Beach',
    'port saint lucie': 'Palm Beach',
    'vero beach':       'Palm Beach',
    'sebastian':        'Palm Beach',
    'lake worth':       'Palm Beach',
    'lake worth beach': 'Palm Beach',
    'lantana':          'Palm Beach',
    'delray beach':     'Palm Beach',
    'boca raton':       'Palm Beach',
    'boynton beach':    'Palm Beach',
    'riviera beach':    'Palm Beach',
    'wellington':       'Palm Beach',
    'royal palm beach': 'Palm Beach',
    'loxahatchee':      'Palm Beach',
    'westlake':         'Palm Beach',
    'singer island':    'Palm Beach',
    'palm beach shores':'Palm Beach',
    'manalapan':        'Palm Beach',
    'south palm beach': 'Palm Beach',
    'gulf stream':      'Palm Beach',
    'highland beach':   'Palm Beach',
    'briny breezes':    'Palm Beach',
    'ocean ridge':      'Palm Beach',

    # Tampa Bay
    'tampa':            'Tampa Bay',
    'st. petersburg':   'Tampa Bay',
    'st petersburg':    'Tampa Bay',
    'saint petersburg': 'Tampa Bay',
    'clearwater':       'Tampa Bay',
    'tampa bay':        'Tampa Bay',
    'sarasota':         'Tampa Bay',
    'siesta key':       'Tampa Bay',
    'longboat key':     'Tampa Bay',
    'bradenton':        'Tampa Bay',
    'anna maria island':'Tampa Bay',

    # Southwest Florida
    'naples':           'Southwest Florida',
    'bonita springs':   'Southwest Florida',
    'marco island':     'Southwest Florida',
    'estero':           'Southwest Florida',
    'fort myers':       'Southwest Florida',
    'ft myers':         'Southwest Florida',
    'cape coral':       'Southwest Florida',
    'punta gorda':      'Southwest Florida',
    'sanibel':          'Southwest Florida',
    'sanibel island':   'Southwest Florida',
    'captiva':          'Southwest Florida',

    # Orlando
    'orlando':          'Orlando',
    'winter park':      'Orlando',
    'kissimmee':        'Orlando',
    'celebration':      'Orlando',
    'lake nona':        'Orlando',
    'lake mary':        'Orlando',

    # Northeast Florida
    'jacksonville':         'Northeast Florida',
    'st. augustine':        'Northeast Florida',
    'st augustine':         'Northeast Florida',
    'saint augustine':      'Northeast Florida',
    'amelia island':        'Northeast Florida',
    'fernandina beach':     'Northeast Florida',
    'ponte vedra':          'Northeast Florida',
    'ponte vedra beach':    'Northeast Florida',

    # Florida Keys
    'key west':         'Florida Keys',
    'key largo':        'Florida Keys',
    'marathon':         'Florida Keys',
    'islamorada':       'Florida Keys',

    # Florida Panhandle
    'panama city beach':'Florida Panhandle',
    'panama city':      'Florida Panhandle',
    'destin':           'Florida Panhandle',
    'rosemary beach':   'Florida Panhandle',
    'seaside':          'Florida Panhandle',
    'watercolor':       'Florida Panhandle',
    'alys beach':       'Florida Panhandle',
    '30a':              'Florida Panhandle',

    # Nashville
    'nashville':        'Nashville',
    'east nashville':   'Nashville',
    'germantown':       'Nashville',
    'franklin':         'Nashville',
    'brentwood':        'Nashville',
    'murfreesboro':     'Nashville',
    'gallatin':         'Nashville',
    'hendersonville':   'Nashville',
    'cookeville':       'Nashville',
    'spring hill':      'Nashville',

    # Other TN
    'memphis':          'Memphis',
    'knoxville':        'Knoxville',
    'chattanooga':      'Chattanooga',

    # Charleston
    'charleston':       'Charleston',
    'mount pleasant':   'Charleston',
    'mt pleasant':      'Charleston',
    'kiawah island':    'Charleston',
    'isle of palms':    'Charleston',
    'sullivans island': 'Charleston',
    'kiawah river':     'Charleston',

    # Other SC
    'hilton head':      'Hilton Head',
    'hilton head island':'Hilton Head',
    'bluffton':         'Hilton Head',
    'myrtle beach':     'Myrtle Beach',
    'greenville':       'Greenville',
    'columbia':         'Columbia',

    # NC
    'asheville':        'Asheville',
    'charlotte':        'Charlotte',
    'raleigh':          'Research Triangle',
    'durham':           'Research Triangle',
    'chapel hill':      'Research Triangle',
    'cary':             'Research Triangle',
    'wilmington':       'Wilmington',

    # Georgia
    'atlanta':          'Atlanta',
    'savannah':         'Savannah',
    'tybee island':     'Savannah',
    'sea island':       'Sea Island',
    'st. simons':       'Sea Island',
    'jekyll island':    'Sea Island',

    # NY
    'new york':         'New York',
    'new york city':    'New York',
    'nyc':              'New York',
    'manhattan':        'New York',
    'brooklyn':         'New York',
    'queens':           'New York',
    'bronx':            'New York',
    'long island':      'New York',
    'hamptons':         'Hamptons',
    'east hampton':     'Hamptons',
    'southampton':      'Hamptons',
    'sag harbor':       'Hamptons',
    'montauk':          'Hamptons',
    'westhampton':      'Hamptons',
    'bridgehampton':    'Hamptons',

    # TX
    'austin':           'Austin',
    'houston':          'Houston',
    'dallas':           'Dallas',
    'fort worth':       'Dallas',
    'ft worth':         'Dallas',
    'san antonio':      'San Antonio',

    # International (each city is its own "metro" for matching purposes)
    'london':           'London',
    'paris':            'Paris',
    'tokyo':            'Tokyo',
    'dubai':            'Dubai',
    'abu dhabi':        'Abu Dhabi',
    'france':           'France',
}


def metro_for_city(city):
    if not city:
        return 'Unknown'
    return CITY_TO_METRO.get(city.lower().strip(), 'Other')


# ---------------------------------------------------------------------------
# Date parsing (kept compatible with generate_pages.py's parser semantics)
# ---------------------------------------------------------------------------

def parse_date(s):
    """Mirrors _parse_iso_date in generate_pages.py. Year-only -> Dec 31."""
    if not s:
        return None
    s = str(s).strip()
    if not s:
        return None

    # Full ISO date
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    if m:
        try: return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError: return None

    # Year-month
    m = re.match(r'^(\d{4})-(\d{2})$', s)
    if m:
        try: return date(int(m.group(1)), int(m.group(2)), 15)
        except ValueError: return None

    # Month + year e.g. "June 2025"
    MONTHS = {
        'january':1,'jan':1, 'february':2,'feb':2, 'march':3,'mar':3,
        'april':4,'apr':4, 'may':5, 'june':6,'jun':6, 'july':7,'jul':7,
        'august':8,'aug':8, 'september':9,'sep':9,'sept':9,
        'october':10,'oct':10, 'november':11,'nov':11, 'december':12,'dec':12,
    }
    SEASONS = {
        'winter': (3, 1), 'spring': (6, 1), 'summer': (9, 1),
        'fall':   (12, 1), 'autumn': (12, 1),
    }
    m = re.match(r'^([A-Za-z]+)\.?\s+(\d{4})$', s)
    if m:
        word = m.group(1).lower()
        if word in MONTHS:
            try: return date(int(m.group(2)), MONTHS[word], 15)
            except ValueError: return None
        if word in SEASONS:
            mo, day = SEASONS[word]
            try: return date(int(m.group(2)), mo, day)
            except ValueError: return None

    # Quarter
    m = re.match(r'^Q([1-4])\s+(\d{4})$', s, re.IGNORECASE)
    if m:
        end_month = int(m.group(1)) * 3  # Q1->3, Q2->6, etc
        try: return date(int(m.group(2)), end_month, 28)
        except ValueError: return None

    # Year only -> Dec 31 (end of year convention)
    m = re.match(r'^(\d{4})$', s)
    if m:
        try: return date(int(m.group(1)), 12, 31)
        except ValueError: return None

    return None


# ---------------------------------------------------------------------------
# Slug generation (matches generate_pages.py)
# ---------------------------------------------------------------------------

def slugify(text):
    """Match the canonical slugify in generate_pages.py exactly, which is
    in turn matched by pyStyleSlug() in index.html. This is critical: the
    slug is the only key the frontend uses to look up intel data, so any
    drift between this function and the others means the intel block
    silently fails for affected projects."""
    if not text:
        return ''
    s = str(text).lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s-]+', '-', s).strip('-')
    return s


# ---------------------------------------------------------------------------
# Project type normalization. Matches the convention in generate_pages.py:
# take first comma-separated value as the canonical type.
# ---------------------------------------------------------------------------

def normalize_type(raw):
    if not raw:
        return ''
    return raw.split(',')[0].strip()


# ---------------------------------------------------------------------------
# Status detection: a project is "complete" (eligible as a comparable) if its
# Delivery status string contains "now open" / "open" / "complete".
# Anything else is in-flight.
# ---------------------------------------------------------------------------

def is_complete(delivery_raw):
    if not delivery_raw:
        return False
    s = delivery_raw.strip().lower()
    return ('now open' in s) or s == 'open' or 'complete' in s or 'delivered' in s


# ---------------------------------------------------------------------------
# Format helpers
# ---------------------------------------------------------------------------

def format_years(years):
    """Round to one decimal but trim trailing .0 -> '3' instead of '3.0'."""
    rounded = round(years, 1)
    if rounded == int(rounded):
        return f'{int(rounded)}'
    return f'{rounded:.1f}'


# ---------------------------------------------------------------------------
# Build comparables index from all complete projects
# ---------------------------------------------------------------------------

def build_complete_index(rows):
    """Return a list of complete projects with computed years_to_complete.
    Each entry: { title, slug, city, metro, type, start, end, years }
    Only includes rows that have BOTH a parseable StartDate and DeliveryDate
    and a positive duration."""
    index = []
    for row in rows:
        delivery = (row.get('Delivery','') or '').strip()
        if not is_complete(delivery):
            continue
        start = parse_date(row.get('StartDate', ''))
        end = parse_date(row.get('DeliveryDate', ''))
        if not start or not end:
            continue
        years = (end - start).days / 365.25
        # Sanity filter: ignore <0.25 years (probably bad data) or >15 years
        # (probably also bad data -- nothing legit takes longer)
        if years < 0.25 or years > 15:
            continue
        title = (row.get('Title','') or '').strip()
        if not title:
            continue
        city = (row.get('City','') or '').strip()
        index.append({
            'title': title,
            'slug': slugify(title),
            'city': city,
            'metro': metro_for_city(city),
            'type': normalize_type(row.get('ProjectType', '')),
            'start': start,
            'end': end,
            'years': years,
        })
    return index


def find_comparables(target, complete_index):
    """Given an in-flight target project, find comparables in the index.
    Returns (exact_matches, relaxed_matches) -- both lists of complete entries.
    Exact = same type AND same metro.
    Relaxed = same type, any metro (excluding the exact matches).
    """
    target_type = target['type'].lower()
    target_metro = target['metro']
    if not target_type:
        return [], []

    exact = []
    relaxed = []
    for c in complete_index:
        if c['type'].lower() != target_type:
            continue
        if c['metro'] == target_metro and target_metro != 'Other':
            exact.append(c)
        else:
            relaxed.append(c)
    return exact, relaxed


def confidence_tier(exact_count, relaxed_count):
    """Map match counts to a confidence label. Returns one of:
    'high', 'medium', 'low', or None (insufficient)."""
    if exact_count >= THRESH_HIGH_EXACT:
        return 'high'
    if exact_count >= THRESH_MEDIUM_EXACT or relaxed_count >= THRESH_MEDIUM_RELAXED:
        return 'medium'
    if exact_count >= THRESH_LOW_EXACT or relaxed_count >= THRESH_LOW_RELAXED:
        return 'low'
    return None


def closest_comparables(target, comparables, n=TOP_COMPARABLES):
    """Pick the n comparables closest in duration to the median of the set.
    These are surfaced in the UI as "Similar Projects". Closest-to-median
    is a reasonable similarity proxy when we don't have size/cost data."""
    if not comparables:
        return []
    durations = [c['years'] for c in comparables]
    med = median(durations)
    # Sort by distance from median, then alphabetically as a stable tiebreaker
    sorted_by_sim = sorted(
        comparables,
        key=lambda c: (abs(c['years'] - med), c['title'])
    )
    return sorted_by_sim[:n]


def build_pattern_summary(target, comparables, estimate, low, high, used_relaxed):
    """One-sentence editorial summary of what the data shows.
    Matches the tone of the design mock."""
    count = len(comparables)
    type_label = target['type'].lower() or 'comparable'
    metro_phrase = f"in {target['metro']}" if not used_relaxed and target['metro'] not in ('Other', 'Unknown') else ''
    estimate_str = format_years(estimate)
    low_str = format_years(low)
    high_str = format_years(high)
    base = (
        f"Among {count} comparable {type_label} project{'s' if count != 1 else ''}"
        f"{(' ' + metro_phrase) if metro_phrase else ''} in TMW's data, "
        f"the median time to completion is {estimate_str} years"
    )
    if low_str != high_str:
        base += f", with a range of {low_str}\u2013{high_str} years."
    else:
        base += "."
    return base


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def fetch_csv(url):
    """Fetch sheet CSV. Mirrors fetch behavior of generate_pages.py."""
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (TMW Intel Bot)'}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode('utf-8')


def main():
    print("Fetching sheet CSV...")
    try:
        raw = fetch_csv(SHEET_URL)
    except Exception as e:
        print(f"  ERROR fetching CSV: {e}", file=sys.stderr)
        sys.exit(1)

    reader = csv.DictReader(io.StringIO(raw))
    rows = list(reader)
    print(f"  ✓ Loaded {len(rows)} rows")

    print("Building completed-projects index...")
    complete_index = build_complete_index(rows)
    print(f"  ✓ {len(complete_index)} projects have full Start->Delivery dates")

    # Diagnostic: distribution by type so the user can see what data we
    # actually have to work with
    type_counts = {}
    metro_counts = {}
    for c in complete_index:
        type_counts[c['type']] = type_counts.get(c['type'], 0) + 1
        metro_counts[c['metro']] = metro_counts.get(c['metro'], 0) + 1
    print("  Complete projects by type:")
    for t, n in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"    {n:3d}  {t or '(no type)'}")
    print("  Complete projects by metro (top 10):")
    for m, n in sorted(metro_counts.items(), key=lambda x: -x[1])[:10]:
        print(f"    {n:3d}  {m}")

    print("Computing intel for in-flight projects...")
    intel = {}
    stats = {'high': 0, 'medium': 0, 'low': 0, 'skipped': 0, 'no_type': 0}
    for row in rows:
        delivery_raw = (row.get('Delivery','') or '').strip()
        # Only generate intel for in-flight projects (we already KNOW
        # how long the complete ones took -- no estimate needed)
        if is_complete(delivery_raw):
            continue
        title = (row.get('Title','') or '').strip()
        if not title:
            continue
        ptype = normalize_type(row.get('ProjectType',''))
        if not ptype:
            stats['no_type'] += 1
            continue
        city = (row.get('City','') or '').strip()
        target = {
            'title': title,
            'slug': slugify(title),
            'city': city,
            'metro': metro_for_city(city),
            'type': ptype,
        }
        exact, relaxed = find_comparables(target, complete_index)
        tier = confidence_tier(len(exact), len(relaxed))
        if not tier:
            stats['skipped'] += 1
            continue

        # For tier-up logic: if we have >= MEDIUM exact, use those alone
        # (purer signal). Otherwise pool exact + relaxed.
        if len(exact) >= THRESH_MEDIUM_EXACT:
            pool = exact
            used_relaxed = False
        else:
            pool = exact + relaxed
            used_relaxed = True

        durations = sorted(c['years'] for c in pool)
        estimate = median(durations)
        # Use 10th/90th percentile as range so single outliers don't
        # dominate. statistics.quantiles requires Python 3.8+.
        if len(durations) >= 10:
            # rough 10/90 via slicing the sorted list
            low_idx = max(0, int(len(durations) * 0.1) - 1)
            high_idx = min(len(durations) - 1, int(len(durations) * 0.9))
            low = durations[low_idx]
            high = durations[high_idx]
        else:
            low = durations[0]
            high = durations[-1]

        top_comps = closest_comparables(target, pool, n=TOP_COMPARABLES)
        comparables_payload = [
            {
                'name': c['title'],
                'slug': c['slug'],
                'location': c['city'],
                'years': round(c['years'], 1),
            }
            for c in top_comps
        ]

        intel[target['slug']] = {
            'estimate_years':    round(estimate, 1),
            'range_low':         round(low, 1),
            'range_high':        round(high, 1),
            'confidence':        tier,
            'comparable_count':  len(pool),
            'exact_count':       len(exact),
            'used_relaxed':      used_relaxed,
            'project_type':      ptype,
            'metro':             target['metro'],
            'comparables':       comparables_payload,
            'pattern_summary':   build_pattern_summary(
                target, pool, estimate, low, high, used_relaxed
            ),
        }
        stats[tier] += 1

    print("Intel generation summary:")
    print(f"  high   confidence: {stats['high']}")
    print(f"  medium confidence: {stats['medium']}")
    print(f"  low    confidence: {stats['low']}")
    print(f"  skipped (insufficient data): {stats['skipped']}")
    print(f"  skipped (no project type):   {stats['no_type']}")
    print(f"  total intel entries written: {len(intel)}")

    # Wrap in a top-level object so we can add metadata later without
    # breaking backward compat. Frontend reads `data.projects[slug]`.
    payload = {
        'generated_at': date.today().isoformat(),
        'projects': intel,
        'stats': stats,
    }

    print(f"Writing {OUTPUT_PATH}...")
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Wrote {OUTPUT_PATH} ({len(intel)} entries)")


if __name__ == '__main__':
    main()
