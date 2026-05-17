#!/usr/bin/env python3
"""
generate_intel.py -- TMW Intelligence data pipeline (v2: proximity + scale).

For every in-flight project, picks comparable completions and computes a
time-to-completion estimate written to intel.json alongside pulse.json.
The frontend reads intel.json and renders an intel block per project.

v2 paths (matters in this order — first match wins):
  Path 0  COMPLETED        -- reported fact from StartDate -> DeliveryDate
  Path 1  KNOWN_DATE       -- developer date within ~3 yrs at month+ precision
  Path 2  COMPARABLES      -- scored ranking across type / proximity / scale

Path 2 changes from v1:
  - Replaced city->metro bucket matching with Haversine distance on lat/lng.
    Same metro is still a soft signal, but distance is now the primary axis.
  - Added scale similarity using new schema fields (keys / units / floors).
    Comps within +/-1.5x score 1.0, +/-3x score 0.5, outside drops to 0.
  - Each candidate gets a 0-1 score combining distance + scale; the pool
    is the top N scored matches (not a binary exact/relaxed bucket).
  - Architect/developer track record: firms with >=3 completed projects and
    low schedule variance bump the in-flight confidence one tier AND blend
    their median into the estimate.

Confidence tiers (v2, based on COUNT OF GOOD-quality matches):
  high   - >= 5 comps with score >= 0.65
  medium - >= 2 comps with score >= 0.65
  low    - >= 1 comp with any score above the threshold
  none   - skip the project

Run after fetch_projects.py (which now emits Keys/Units/Floors + Architect/
Developer name lookups). Reads projects-flat.json from the same directory.

Usage:
    python generate_intel.py
"""

import csv
import io
import json
import math
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

# How many comparables to surface in the UI block (closest by similarity).
TOP_COMPARABLES = 3

# How many comps to include in the median pool. Beyond this, additional
# comps add little signal and dilute the median with weaker matches.
COMP_POOL_MAX = 25

# v2 scoring thresholds — see comp_score() below.
SCORE_MIN = 0.20          # score below this → not a comparable at all
SCORE_GOOD = 0.65         # score at/above this counts as a "good" match
                          # (used for confidence tier counting)

# Distance tiers (km). Haversine distance from in-flight target to candidate.
DIST_NEAR_KM = 25         # within → score 1.0 (true neighbors / same submarket)
DIST_METRO_KM = 80        # within → score 0.7 (same metro)
DIST_REGION_KM = 200      # within → score 0.4 (same region)
                          # beyond → score 0.1 (national fallback)

# Scale ratio tiers (max(a,b) / min(a,b)). Applied per scale field
# (keys / units / floors) where BOTH projects have data, then averaged.
SCALE_SIMILAR = 1.5       # within → 1.0 (e.g. 100 vs 150 units)
SCALE_ACCEPTABLE = 3.0    # within → 0.5 (e.g. 100 vs 300 units)
                          # outside → 0.0

# Score weighting: 60% scale + 40% distance when scale data is available.
# When scale data isn't present, distance carries the full signal.
W_DISTANCE_ONLY = 1.0     # used when no scale data
W_DISTANCE_WHEN_SCALED = 0.4
W_SCALE_WHEN_SCALED = 0.6

# Firm track record: at least N completed projects from the same firm to
# qualify as a signal. Standard deviation cap (years) for "consistent" firms.
FIRM_MIN_COMPLETIONS = 3
FIRM_TIGHT_STDDEV = 0.75
# Blend factor — firm median weighted against overall comp median when boosting.
FIRM_BLEND_FACTOR = 0.30

# Mixed-use projects: PreferredType = "Mixed-Use" signals a massive, phased,
# multi-component build (hotel + residential + retail + office stacked).
# These take meaningfully longer than the equivalent single-use project, but
# our completed-mixed-use comp pool is small (~2-3 entries). Two adjustments:
#   1. Apply a complexity multiplier to the comparables-path estimate so we
#      don't underclock based on the limited pool.
#   2. Cap confidence at "medium" — we can't claim "high" confidence with
#      so few completed mixed-use comparables.
# Multiplier tuned to roughly reflect TMW's observation that mixed-use
# projects routinely phase delivery over 5-8 years vs. 3-5 for single-use.
MIXED_USE_TYPES = {'mixed-use', 'mixed use', 'development', 'master plan', 'masterplan'}
MIXED_USE_COMPLEXITY_MULTIPLIER = 1.25
# Allow even 1-comp pools to pass through (default is to require enough comps
# for at least 'low' tier). Mixed-use is so rare in the completed index that
# strict gating drops the few projects that have any signal at all.
MIXED_USE_MIN_POOL = 1


def is_mixed_use_target(target):
    """True when the target's normalized type is in the mixed-use family.
    Used to trigger the longer-timeline + capped-confidence treatment."""
    t = (target.get('type','') or '').lower().strip()
    return t in MIXED_USE_TYPES


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
# Geographic distance (Haversine). Primary proximity signal in v2 — replaces
# the binary "same metro" bucket with continuous km distance, then snaps to
# tiered scores (near/metro/region/national).
# ---------------------------------------------------------------------------

EARTH_RADIUS_KM = 6371.0
KM_TO_MI = 0.621371

def haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance between two points in kilometers.
    Returns None if any coordinate is missing or invalid."""
    if None in (lat1, lng1, lat2, lng2):
        return None
    try:
        rlat1 = math.radians(float(lat1))
        rlat2 = math.radians(float(lat2))
        dlat = math.radians(float(lat2) - float(lat1))
        dlng = math.radians(float(lng2) - float(lng1))
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return EARTH_RADIUS_KM * c
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Tiny coercion helpers — projects-flat.json values are all strings.
# ---------------------------------------------------------------------------

def _to_float_or_none(v):
    if v is None or v == '':
        return None
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return None

def _to_int_or_none(v):
    if v is None or v == '':
        return None
    try:
        return int(float(str(v).strip()))  # via float so "120.0" works
    except (ValueError, TypeError):
        return None

def _split_names(s):
    """Split a comma-separated firm string (e.g. 'Foster + Partners, Pelli')
    into ['Foster + Partners', 'Pelli']. Empty entries dropped."""
    return [n.strip() for n in (s or '').split(',') if n.strip()]


# ---------------------------------------------------------------------------
# Type synonyms -- groups of project types that should be treated as
# comparable for intel matching. A "Hotel" project draws on Resort and
# Hospitality projects too. A "Residences" project draws on Condo and
# Residential. This widens the comparable pool significantly without
# sacrificing relevance.
#
# Each group is a list of lowercase strings. When matching, we expand the
# target's type to its full synonym set and consider any complete project
# whose type is in that set.
# ---------------------------------------------------------------------------

TYPE_SYNONYM_GROUPS = [
    # Hospitality: hotels, resorts, branded hotels share construction patterns
    ['hotel', 'hotels', 'resort', 'resorts', 'hospitality', 'inn', 'lodge'],
    # Residential: condos, apartments, residences, branded residences
    ['residences', 'residence', 'residential', 'condo', 'condos', 'condominium',
     'apartments', 'apartment', 'multifamily', 'multi-family', 'rental', 'rentals'],
    # Mixed-use / development: broader campus-scale projects
    ['mixed-use', 'mixed use', 'development', 'master plan', 'masterplan'],
    # Retail / commercial
    ['retail', 'shopping', 'mall', 'commercial', 'lifestyle center'],
    # Office / workplace
    ['office', 'offices', 'workplace', 'corporate'],
    # Cultural / institutional
    ['museum', 'museums', 'cultural', 'arts center', 'performing arts', 'gallery'],
    # Entertainment / venue
    ['entertainment', 'venue', 'theater', 'theatre', 'arena', 'stadium', 'amphitheater'],
    # Education
    ['education', 'school', 'university', 'campus', 'academic'],
    # Recreation / sports
    ['golf', 'golf club', 'country club', 'club', 'recreation'],
    # Travel / aviation / transit
    ['travel', 'aviation', 'airport', 'transit', 'transportation'],
    # Healthcare
    ['healthcare', 'health care', 'hospital', 'medical'],
    # Industrial / logistics
    ['industrial', 'logistics', 'warehouse', 'distribution'],
]

# Build a flat lookup: type-string -> set of synonyms (including self)
_TYPE_TO_SYNONYMS = {}
for group in TYPE_SYNONYM_GROUPS:
    group_set = set(group)
    for t in group:
        _TYPE_TO_SYNONYMS[t] = group_set


def expand_type_synonyms(target_type):
    """Return the set of lowercase type strings considered synonymous with
    target_type for comparable matching. If target_type is in a known
    synonym group, return that group. Otherwise return {target_type} only.
    Always includes the target itself."""
    if not target_type:
        return set()
    t = target_type.lower().strip()
    if t in _TYPE_TO_SYNONYMS:
        return _TYPE_TO_SYNONYMS[t]
    return {t}


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

def normalize_type(row):
    """Determine the canonical project type for intel matching. Mirrors the
    precedence used in generate_pages.py: PreferredType wins if set,
    otherwise the first comma-separated value of ProjectType."""
    preferred = (row.get('PreferredType', '') or '').strip()
    if preferred:
        return preferred
    raw = (row.get('ProjectType', '') or '').strip()
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

def detect_date_precision(raw):
    """Return one of 'day', 'month', 'year', 'other', or None based on
    the format of the original DeliveryDate string."""
    if not raw:
        return None
    s = raw.strip()
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s): return 'day'
    if re.match(r'^\d{4}-\d{2}$', s): return 'month'
    # "March 2026" / "Mar 2026"
    if re.match(r'^[A-Za-z]+\.?\s+\d{4}$', s):
        # Distinguish month name from season name. Months count as 'month',
        # seasons count as 'other' (quarter-ish precision is fuzzier than a
        # specific month).
        first = s.split()[0].lower().rstrip('.')
        if first in ('winter','spring','summer','fall','autumn'):
            return 'other'
        return 'month'
    # Quarter
    if re.match(r'^Q[1-4]\s+\d{4}$', s, re.IGNORECASE):
        return 'other'
    if re.match(r'^\d{4}$', s):
        return 'year'
    return 'other'


def known_date_estimate(delivery_raw, today):
    """If the project's DeliveryDate is precise enough to trust (day or
    month precision, in the future, within 18 months), compute a 'known
    date' intel entry directly from the date.

    Returns a dict with the same shape as the comparable estimate, OR
    None if the date isn't precise/timely enough.

    Threshold is 36 months because: developer commitments are generally
    better signal than a comparable median, even for projects 2-3 years
    out. Slippage exists but the median can be off by similar amounts.

    Accepted precisions:
      'day'   ("2026-06-15")     -- most confident
      'month' ("2026-06" / "June 2026")
      'other' ("Q1 2026" / "Winter 2026") -- still trustworthy near-term
      'year'  ("2026")           -- accepted ONLY when within 18 months
                                    (matches the frontend's "by end of year"
                                    convention so intel agrees with the
                                    existing progress bar countdown)

    Rejected:
      None / unparseable
      past dates
      day/month/other dates > 1095 days out (3+ years)
      year-only dates > 540 days out (18+ months)
    """
    precision = detect_date_precision(delivery_raw)
    if precision not in ('day', 'month', 'other', 'year'):
        return None
    d = parse_date(delivery_raw)
    if not d:
        return None
    days_out = (d - today).days
    if days_out <= 0:
        return None
    # Year-only has a stricter cap because it's a vague signal beyond
    # ~24 months; for closer dates it matches what the frontend already
    # shows on the progress bar.
    max_days = 720 if precision == 'year' else 1095
    if days_out > max_days:
        return None

    # Format the estimate. Tiers chosen to match how a reader would say it.
    if days_out <= 60:
        # "28 days" for projects this close. The frontend will animate this
        # down day-by-day via the daily workflow rebuild.
        estimate_label = f"{days_out} days"
        # For UI sorting purposes we also need a numeric years value
        estimate_years = round(days_out / 365.25, 2)
    elif days_out <= 365:
        months = round(days_out / 30.44)
        estimate_label = f"~{months} months"
        estimate_years = round(days_out / 365.25, 1)
    else:
        years_rounded = round(days_out / 365.25 * 2) / 2  # nearest 0.5
        estimate_label = f"~{format_years(years_rounded)} years"
        estimate_years = years_rounded

    return {
        'estimate_years': estimate_years,
        'estimate_label': estimate_label,
        'days_out': days_out,
        'source': 'known_date',  # vs 'comparables' for the inferred path
        'precision': precision,
        'delivery_date': d.isoformat(),
    }


def build_complete_index(rows):
    """Return a list of complete projects with computed years_to_complete.
    Each entry carries everything Path 2 needs to score comparables:
      title, slug, city, metro, type, start, end, years,
      lat, lng, keys, units, floors, architects[], developers[]
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
            'title':      title,
            'slug':       slugify(title),
            'city':       city,
            'metro':      metro_for_city(city),
            'type':       normalize_type(row),
            'start':      start,
            'end':        end,
            'years':      years,
            'lat':        _to_float_or_none(row.get('Latitude')),
            'lng':        _to_float_or_none(row.get('Longitude')),
            'keys':       _to_int_or_none(row.get('Keys')),
            'units':      _to_int_or_none(row.get('Units')),
            'floors':     _to_int_or_none(row.get('Floors')),
            'architects': _split_names(row.get('Architect')),
            'developers': _split_names(row.get('Developer')),
        })
    return index


# ---------------------------------------------------------------------------
# Firm track record. Aggregates duration stats across each firm's completed
# projects. Firms with enough history AND tight variance get used as a
# confidence-tightening signal on their in-flight projects (Path 2).
# ---------------------------------------------------------------------------

def build_firm_track_records(complete_index):
    """Return { firm_lowercase: { count, median_years, mean_years, stddev_years } }
    for every firm with at least FIRM_MIN_COMPLETIONS completed projects.
    Firms appear in both architects and developers — we aggregate by role-agnostic
    name since the construction-timeline signal is similar from either side."""
    by_firm = {}  # lowercase firm name -> list of duration-years floats
    for c in complete_index:
        for firm in (c.get('architects') or []) + (c.get('developers') or []):
            key = (firm or '').strip().lower()
            if not key:
                continue
            by_firm.setdefault(key, []).append(c['years'])

    result = {}
    for firm, durations in by_firm.items():
        if len(durations) < FIRM_MIN_COMPLETIONS:
            continue
        med = median(durations)
        mean = sum(durations) / len(durations)
        variance = sum((x - mean) ** 2 for x in durations) / len(durations)
        result[firm] = {
            'count':        len(durations),
            'median_years': round(med, 2),
            'mean_years':   round(mean, 2),
            'stddev_years': round(math.sqrt(variance), 2),
        }
    return result


# ---------------------------------------------------------------------------
# Comparable scoring — the core of v2.
#
# Type-family is a hard gate (return None if not in same family). Among
# same-family candidates, score combines distance (km) and scale similarity
# (per-field ratios). Scale carries more weight than distance when present,
# because a similarly-sized project on the other side of the country still
# tells us more about construction timeline than a wildly-different-sized
# project next door.
# ---------------------------------------------------------------------------

def _distance_score(target, comp):
    """Tiered score 0.1-1.0 based on km distance. 0.5 if either side lacks coords."""
    if target.get('lat') is None or target.get('lng') is None or \
       comp.get('lat') is None or comp.get('lng') is None:
        return 0.5
    d = haversine_km(target['lat'], target['lng'], comp['lat'], comp['lng'])
    if d is None:
        return 0.5
    if d <= DIST_NEAR_KM:    return 1.0
    if d <= DIST_METRO_KM:   return 0.7
    if d <= DIST_REGION_KM:  return 0.4
    return 0.1


def _scale_score(target, comp):
    """Average per-field scale-ratio score across the scale fields where
    BOTH the target and comp have data. Returns None if no overlapping fields."""
    ratios = []
    for field in ('keys', 'units', 'floors'):
        tv = target.get(field)
        cv = comp.get(field)
        if tv and cv:
            try:
                hi = max(int(tv), int(cv))
                lo = min(int(tv), int(cv))
                if lo <= 0:
                    continue
                r = hi / lo
                if r <= SCALE_SIMILAR:      ratios.append(1.0)
                elif r <= SCALE_ACCEPTABLE: ratios.append(0.5)
                else:                       ratios.append(0.0)
            except (ValueError, TypeError, ZeroDivisionError):
                continue
    if not ratios:
        return None
    return sum(ratios) / len(ratios)


def comp_score(target, comp):
    """Return float 0-1 score, or None if comp isn't in target's type family.

    Weighting:
      - If both have scale data: 60% scale + 40% distance.
      - Otherwise: distance is the only differentiator (within the type-family gate).
    """
    target_type_family = expand_type_synonyms((target.get('type','') or '').lower())
    if not target_type_family:
        return None
    if (comp.get('type','') or '').lower() not in target_type_family:
        return None  # hard gate: must share a type family

    d_score = _distance_score(target, comp)
    s_score = _scale_score(target, comp)
    if s_score is None:
        return W_DISTANCE_ONLY * d_score
    return W_DISTANCE_WHEN_SCALED * d_score + W_SCALE_WHEN_SCALED * s_score


def score_and_rank(target, complete_index):
    """For an in-flight target, score every completed project and return
    a list of (score, comp) tuples in descending score order. Comps below
    SCORE_MIN are dropped. Comps not in the type family are dropped (score=None).
    """
    scored = []
    for c in complete_index:
        s = comp_score(target, c)
        if s is None or s < SCORE_MIN:
            continue
        scored.append((s, c))
    scored.sort(key=lambda x: -x[0])
    return scored


def confidence_from_scores(scored):
    """Tier based on count of GOOD-quality (>=SCORE_GOOD) matches in the pool."""
    good_count = sum(1 for s, _ in scored if s >= SCORE_GOOD)
    if good_count >= 5:
        return 'high', good_count
    if good_count >= 2:
        return 'medium', good_count
    if scored:
        return 'low', good_count
    return None, 0


def matching_firm_signal(target, firm_track_record):
    """If any of the target's firms have a tight track record (>=FIRM_MIN_COMPLETIONS
    completions and stddev <= FIRM_TIGHT_STDDEV years), return the most-credentialed
    one. Returns None otherwise."""
    candidates = []
    for firm in (target.get('architects') or []) + (target.get('developers') or []):
        key = (firm or '').strip().lower()
        tr = firm_track_record.get(key)
        if tr and tr['count'] >= FIRM_MIN_COMPLETIONS and tr['stddev_years'] <= FIRM_TIGHT_STDDEV:
            candidates.append({
                'firm':         firm,
                'count':        tr['count'],
                'median_years': tr['median_years'],
                'stddev_years': tr['stddev_years'],
            })
    if not candidates:
        return None
    # Prefer the firm with the largest sample size (more reliable signal)
    candidates.sort(key=lambda c: (-c['count'], c['stddev_years']))
    return candidates[0]


def build_pattern_summary(target, pool_count, estimate, low, high, avg_distance_km, firm_signal):
    """One-sentence editorial summary reflecting v2 axes (proximity, scale, firm)."""
    type_label = (target.get('type','') or '').lower() or 'comparable'
    estimate_str = format_years(estimate)
    low_str = format_years(low)
    high_str = format_years(high)

    # Proximity adjective \u2014 derived from avg distance of the comp pool
    if avg_distance_km is None:
        prox_adj = ''
    elif avg_distance_km <= DIST_NEAR_KM:
        prox_adj = 'nearby '
    elif avg_distance_km <= DIST_METRO_KM:
        prox_adj = 'same-metro '
    elif avg_distance_km <= DIST_REGION_KM:
        prox_adj = 'regional '
    else:
        prox_adj = ''

    base = (
        f"Among {pool_count} {prox_adj}{type_label} project{'s' if pool_count != 1 else ''}"
        f" in TMW's data, the median time to completion is {estimate_str} years"
    )
    if low_str != high_str:
        base += f", with a range of {low_str}\u2013{high_str} years."
    else:
        base += "."

    if firm_signal:
        base += (
            f" {firm_signal['firm']} has {firm_signal['count']} prior projects "
            f"delivered with low schedule variance \u2014 confidence tightened toward "
            f"their typical {format_years(firm_signal['median_years'])}-year pace."
        )
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
    # Read projects from projects-flat.json (written by fetch_projects.py
    # earlier in the workflow). The flat file's CSV-shape keys match what
    # build_complete_index() and the rest of this module already read via
    # row.get('Title') / row.get('Delivery') / etc.
    print("Loading projects-flat.json...")
    try:
        with open('projects-flat.json', 'r', encoding='utf-8') as f:
            rows = json.load(f)
    except FileNotFoundError:
        print("  ERROR: projects-flat.json not found. Run fetch_projects.py first.", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"  ERROR: projects-flat.json wasn't valid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"  ✓ Loaded {len(rows)} rows")

    print("Building completed-projects index...")
    complete_index = build_complete_index(rows)
    print(f"  ✓ {len(complete_index)} projects have full Start->Delivery dates")

    # Diagnostic: distribution by type so the user can see what data we
    # actually have to work with
    type_counts = {}
    metro_counts = {}
    scale_counts = {'keys': 0, 'units': 0, 'floors': 0, 'lat_lng': 0}
    for c in complete_index:
        type_counts[c['type']] = type_counts.get(c['type'], 0) + 1
        metro_counts[c['metro']] = metro_counts.get(c['metro'], 0) + 1
        if c.get('keys'):   scale_counts['keys'] += 1
        if c.get('units'):  scale_counts['units'] += 1
        if c.get('floors'): scale_counts['floors'] += 1
        if c.get('lat') is not None and c.get('lng') is not None:
            scale_counts['lat_lng'] += 1
    print("  Complete projects by type:")
    for t, n in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"    {n:3d}  {t or '(no type)'}")
    print("  Complete projects by metro (top 10):")
    for m, n in sorted(metro_counts.items(), key=lambda x: -x[1])[:10]:
        print(f"    {n:3d}  {m}")
    print(f"  Scale data coverage: {scale_counts['keys']} have keys, "
          f"{scale_counts['units']} have units, {scale_counts['floors']} have floors, "
          f"{scale_counts['lat_lng']} have coords")

    print("Building firm track records...")
    firm_track_record = build_firm_track_records(complete_index)
    tight_firms = [k for k, v in firm_track_record.items()
                   if v['stddev_years'] <= FIRM_TIGHT_STDDEV]
    print(f"  ✓ {len(firm_track_record)} firms with >={FIRM_MIN_COMPLETIONS} completions "
          f"({len(tight_firms)} with tight schedule variance)")

    print("Computing intel for all projects...")
    intel = {}
    stats = {'high': 0, 'medium': 0, 'low': 0, 'known_date': 0,
             'completed': 0, 'skipped': 0, 'no_type': 0,
             'firm_boosted': 0, 'speculative_softened': 0}
    # Track projects that had a DeliveryDate but still fell through to the
    # comparable path. The workflow log prints these so we can see why each
    # project ended up where it did (e.g. year-only date, unparseable format,
    # date too far out).
    comparable_fallthroughs = []
    today = date.today()
    for row in rows:
        delivery_raw = (row.get('Delivery','') or '').strip()
        title = (row.get('Title','') or '').strip()
        if not title:
            continue
        target_slug = slugify(title)
        city = (row.get('City','') or '').strip()
        ptype = normalize_type(row)
        # `DatesSpeculative` flag (from tmw-data's `dates_speculative` boolean)
        # marks projects where StartDate/DeliveryDate are TMW best-guesses
        # rather than developer-confirmed. We still use the dates as the
        # estimate driver, but downgrade confidence + change the pattern
        # wording so readers know it's our inference, not a commitment.
        dates_speculative = str(row.get('DatesSpeculative','') or '').strip() in ('1', 'true', 'True')

        # --- Path 0: COMPLETED project ---
        # Past-tense report showing actual time taken. Drawn directly from
        # StartDate -> DeliveryDate in the sheet. No estimate, no
        # comparables -- this is reported fact.
        if is_complete(delivery_raw):
            start = parse_date((row.get('StartDate', '') or '').strip())
            end = parse_date((row.get('DeliveryDate', '') or '').strip())
            if start and end:
                duration_days = (end - start).days
                if 90 < duration_days < 365.25 * 15:  # sanity: 3 months - 15 years
                    duration_years = duration_days / 365.25
                    # Past-tense formatter -- same buckets as known_date but
                    # phrased as "Took X" instead of "~X to completion"
                    if duration_days <= 365:
                        months = round(duration_days / 30.44)
                        estimate_label = f"{months} months"
                    else:
                        years_rounded = round(duration_years * 2) / 2
                        estimate_label = f"{format_years(years_rounded)} years"
                    # Speculative-dates softening: when Jake flagged these
                    # dates as TMW best-guesses (rare for completed projects
                    # but possible), drop confidence to 'medium' and rephrase
                    # so readers don't think we're reporting a hard fact.
                    if dates_speculative:
                        completed_confidence = 'medium'
                        completed_pattern = (
                            f"TMW estimates this took ~{estimate_label} based on "
                            f"observed activity from {start.year}–{end.year}."
                        )
                        stats['speculative_softened'] += 1
                    else:
                        completed_confidence = 'high'
                        completed_pattern = (
                            f"Completed in {estimate_label}, from {start.year} "
                            f"groundbreaking to {end.year} opening."
                        )
                    intel[target_slug] = {
                        'estimate_years':   round(duration_years, 1),
                        'estimate_label':   estimate_label,
                        'start_date':       start.isoformat(),
                        'end_date':         end.isoformat(),
                        'start_year':       start.year,
                        'end_year':         end.year,
                        'source':           'completed',
                        'confidence':       completed_confidence,
                        'project_type':     ptype,
                        'metro':            metro_for_city(city),
                        'comparables':      [],
                        'comparable_count': 0,
                        'pattern_summary':  completed_pattern,
                        'dates_speculative': dates_speculative,
                    }
                    stats['completed'] += 1
            # If StartDate or DeliveryDate missing, the project IS open --
            # we just can't report how long it took. No chip in that case.
            continue

        # --- Path 1: KNOWN DATE override ---
        # If the developer has committed to a specific date in the near
        # future (within 18 months, month+ precision), use THAT as the
        # estimate. The comparable algorithm exists for projects without
        # firm dates -- if we have a firm date we should trust it.
        delivery_date_raw = (row.get('DeliveryDate','') or '').strip()
        known = known_date_estimate(delivery_date_raw, today)
        if known:
            # Pattern summary + confidence depend on TWO axes:
            #   (a) Date precision — day-precise dates earn "Developer-announced"
            #       phrasing; vaguer precisions (month/quarter/season/year) soften
            #       to "Targeted for opening" so we don't overclaim certainty.
            #   (b) Speculative flag — when the project's dates are flagged as
            #       TMW best-guesses (not developer-confirmed), we override the
            #       phrasing to "TMW estimate" and drop confidence one notch.
            #       Readers see the same number but framed honestly.
            if dates_speculative:
                pattern_summary = (
                    f"TMW estimates an opening in {known['estimate_label']} "
                    f"based on project type and current stage."
                )
                # Day precision + speculative is contradictory in spirit
                # (Jake wouldn't usually flag a day-precise date as a guess),
                # but if it happens we still treat it as medium so the UI
                # frames it consistently.
                confidence = 'medium'
                stats['speculative_softened'] += 1
            elif known['precision'] == 'day':
                pattern_summary = f"Developer-announced opening in {known['estimate_label']}."
                confidence = 'high'
            else:
                pattern_summary = f"Targeted for opening in {known['estimate_label']}."
                confidence = 'high'
            intel[target_slug] = {
                'estimate_years':   known['estimate_years'],
                'estimate_label':   known['estimate_label'],
                'days_out':         known['days_out'],
                'delivery_date':    known['delivery_date'],
                'source':           'known_date',
                'precision':        known['precision'],
                'confidence':       confidence,
                'project_type':     ptype,
                'metro':            metro_for_city(city),
                # Empty comparables payload -- the UI will conditionally
                # render different content for source=known_date.
                'comparables':      [],
                'comparable_count': 0,
                'pattern_summary':  pattern_summary,
                'dates_speculative': dates_speculative,
            }
            stats['known_date'] += 1
            continue

        # --- Path 2: COMPARABLE INFERENCE ---
        # No firm near-term date -- fall back to median-of-comparables.
        # Capture WHY we fell through here, so the workflow log shows it
        # for any project with a DeliveryDate that didn't trigger known_date.
        # This is the debug surface for "why is X showing 2.6yrs when it
        # opens in 8 months".
        if delivery_date_raw:
            fallthrough_diag = {
                'title': title,
                'raw_date': delivery_date_raw,
                'precision': detect_date_precision(delivery_date_raw),
                'parsed': str(parse_date(delivery_date_raw)) if parse_date(delivery_date_raw) else None,
            }
            if fallthrough_diag['parsed']:
                d = parse_date(delivery_date_raw)
                fallthrough_diag['days_out'] = (d - today).days
            comparable_fallthroughs.append(fallthrough_diag)
        if not ptype:
            stats['no_type'] += 1
            continue

        # Build the target with everything comp_score() looks at
        target = {
            'title':      title,
            'slug':       target_slug,
            'city':       city,
            'metro':      metro_for_city(city),
            'type':       ptype,
            'lat':        _to_float_or_none(row.get('Latitude')),
            'lng':        _to_float_or_none(row.get('Longitude')),
            'keys':       _to_int_or_none(row.get('Keys')),
            'units':      _to_int_or_none(row.get('Units')),
            'floors':     _to_int_or_none(row.get('Floors')),
            'architects': _split_names(row.get('Architect')),
            'developers': _split_names(row.get('Developer')),
        }

        # Score & rank all comparables across the entire complete index.
        # Top N (by score) form the median pool — no metro-bucket gate.
        scored = score_and_rank(target, complete_index)
        if not scored:
            stats['skipped'] += 1
            continue

        pool_scored = scored[:COMP_POOL_MAX]
        pool = [c for _, c in pool_scored]
        tier, good_count = confidence_from_scores(pool_scored)
        is_mu = is_mixed_use_target(target)
        # Mixed-use rescue: comp pool may be too small for the standard
        # confidence_from_scores to grant any tier (needs >=2 good or any pool).
        # We accept even single-comp pools for mixed-use targets since the
        # completed-mixed-use universe is so small. Force the floor tier.
        if not tier and is_mu and len(pool_scored) >= MIXED_USE_MIN_POOL:
            tier, good_count = 'low', sum(1 for s, _ in pool_scored if s >= SCORE_GOOD)
        if not tier:
            stats['skipped'] += 1
            continue

        durations = sorted(c['years'] for c in pool)
        estimate = median(durations)
        # 10/90 percentile range (avoids single-outlier domination)
        if len(durations) >= 10:
            low_idx = max(0, int(len(durations) * 0.1) - 1)
            high_idx = min(len(durations) - 1, int(len(durations) * 0.9))
            low = durations[low_idx]
            high = durations[high_idx]
        else:
            low = durations[0]
            high = durations[-1]

        # Firm track record adjustment: if a known-consistent firm is on this
        # project, blend their median into the estimate AND bump the tier up.
        firm_signal = matching_firm_signal(target, firm_track_record)
        if firm_signal:
            estimate = (1.0 - FIRM_BLEND_FACTOR) * estimate + FIRM_BLEND_FACTOR * firm_signal['median_years']
            if tier == 'medium':
                tier = 'high'
            elif tier == 'low':
                tier = 'medium'
            stats['firm_boosted'] += 1

        # Mixed-use complexity surcharge — applied AFTER firm-blend so the
        # surcharge reflects the project's full inherent complexity.
        # Multiplier acknowledges that phased delivery, regulatory load, and
        # cross-component coordination routinely add ~20-30% to mixed-use
        # timelines vs. the equivalent single-use comp suggests.
        # Confidence capped at "medium" — even with firm boost, we can't claim
        # high confidence with so few completed mixed-use comparables.
        mu_applied = False
        if is_mu:
            estimate = estimate * MIXED_USE_COMPLEXITY_MULTIPLIER
            low = low * MIXED_USE_COMPLEXITY_MULTIPLIER
            high = high * MIXED_USE_COMPLEXITY_MULTIPLIER
            if tier == 'high':
                tier = 'medium'
            mu_applied = True
            stats['mixed_use_adjusted'] = stats.get('mixed_use_adjusted', 0) + 1

        # Top-N comparables for UI surfacing — also stamp distance for each
        top_comps_payload = []
        avg_distance_km_values = []
        for s, c in pool_scored[:TOP_COMPARABLES]:
            d = haversine_km(target.get('lat'), target.get('lng'), c.get('lat'), c.get('lng'))
            entry = {
                'name':     c['title'],
                'slug':     c['slug'],
                'location': c['city'],
                'years':    round(c['years'], 1),
                'score':    round(s, 2),
            }
            if d is not None:
                entry['distance_km'] = round(d, 1)
                entry['distance_mi'] = round(d * KM_TO_MI, 1)
                avg_distance_km_values.append(d)
            top_comps_payload.append(entry)

        # Distance across ALL pool members (not just top 3) — better signal
        # for the pattern-summary's "nearby / same-metro / regional" label.
        all_pool_distances = []
        for _, c in pool_scored:
            d = haversine_km(target.get('lat'), target.get('lng'), c.get('lat'), c.get('lng'))
            if d is not None:
                all_pool_distances.append(d)
        avg_distance_km = (sum(all_pool_distances) / len(all_pool_distances)) if all_pool_distances else None

        # Did scale data actually contribute to the score? Yes iff target has
        # any scale field AND at least one pool member shares that field.
        target_has_scale = any(target.get(f) for f in ('keys', 'units', 'floors'))
        scale_used = target_has_scale and any(
            any(target.get(f) and c.get(f) for f in ('keys', 'units', 'floors'))
            for c in pool
        )

        intel[target['slug']] = {
            'estimate_years':    round(estimate, 1),
            'estimate_label':    f"~{format_years(round(estimate, 1))} years",
            'range_low':         round(low, 1),
            'range_high':        round(high, 1),
            'confidence':        tier,
            'comparable_count':  len(pool),
            'good_count':        good_count,
            # Back-compat field used by the existing frontend — maps to good_count
            'exact_count':       good_count,
            # Back-compat: "used relaxed" is true when we leaned on weak (sub-good) matches
            'used_relaxed':      good_count < 2,
            'avg_match_score':   round(sum(s for s, _ in pool_scored) / len(pool_scored), 2),
            'avg_distance_km':   round(avg_distance_km, 1) if avg_distance_km is not None else None,
            'avg_distance_mi':   round(avg_distance_km * KM_TO_MI, 1) if avg_distance_km is not None else None,
            'scale_used':        scale_used,
            'firm_signal':       firm_signal,
            'source':            'comparables',
            'project_type':      ptype,
            'metro':             target['metro'],
            'comparables':       top_comps_payload,
            'pattern_summary':   (
                # Mixed-use override — the standard pattern summary talks about
                # "same-type" comparables which is misleading when the comp pool
                # is tiny AND we've applied a complexity surcharge. Substitute
                # a mixed-use-aware sentence that names the dynamics readers
                # need to understand: small completed pool, complexity uplift,
                # phased delivery.
                f"Mixed-use developments of this scale routinely span "
                f"{format_years(round(low, 1))}–{format_years(round(high, 1))} years "
                f"with phased delivery. Based on {len(pool)} completed mixed-use "
                f"comparable{'s' if len(pool) != 1 else ''}, with an added complexity "
                f"factor since cross-component coordination typically extends timelines."
                if mu_applied
                else build_pattern_summary(
                    target, len(pool), estimate, low, high, avg_distance_km, firm_signal
                )
            ),
            # Pass the speculative flag through even on the comparables path —
            # the estimate doesn't depend on Jake's dates here, but the map
            # still wants to surface the "EST" badge on the popup/modal so
            # readers know the project's underlying dates aren't confirmed.
            'dates_speculative': dates_speculative,
            # Set when the mixed-use complexity surcharge was applied to this
            # entry. The frontend can use this to surface a small "mixed-use"
            # tag on the intel block so readers know the timeline reflects
            # phased / multi-component reality, not a simple single-use build.
            'is_mixed_use':      mu_applied,
        }
        stats[tier] += 1

    print("Intel generation summary:")
    print(f"  completed (reported):        {stats['completed']}")
    print(f"  known-date entries:          {stats['known_date']}")
    print(f"  high   confidence:           {stats['high']}")
    print(f"  medium confidence:           {stats['medium']}")
    print(f"  low    confidence:           {stats['low']}")
    print(f"  firm-track-record boosts:    {stats['firm_boosted']}")
    print(f"  speculative-dates softened:  {stats['speculative_softened']}")
    print(f"  mixed-use complexity uplift: {stats.get('mixed_use_adjusted', 0)}")
    print(f"  skipped (insufficient data): {stats['skipped']}")
    print(f"  skipped (no project type):   {stats['no_type']}")
    print(f"  total intel entries written: {len(intel)}")

    # Debug surface: projects that had a DeliveryDate but ended up on the
    # comparable path. Each row shows the raw date, detected precision,
    # parsed value, and days_out. If you see a project here with a clearly
    # parseable date that should trigger known_date, that's a bug.
    if comparable_fallthroughs:
        print(f"\nProjects with DeliveryDate that fell through to comparables ({len(comparable_fallthroughs)}):")
        # Sort by days_out ascending so the most-puzzling cases (close-in
        # dates that should obviously be known_date) appear first.
        sorted_ft = sorted(
            comparable_fallthroughs,
            key=lambda x: (x.get('days_out') is None, x.get('days_out', 99999))
        )
        for ft in sorted_ft[:20]:
            print(f"    {ft['title']:<40s} raw={ft['raw_date']!r:18s} "
                  f"precision={ft['precision']!r:8s} days_out={ft.get('days_out', '-')!s:5s}")
        if len(sorted_ft) > 20:
            print(f"    ... and {len(sorted_ft) - 20} more")

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
