#!/usr/bin/env python3
"""
TMW Project Page Generator
Reads Google Sheet CSV → generates /projects/{slug}/index.html for each project
Run: python3 generate_pages.py
"""

import csv, io, os, re, json, time, urllib.request, urllib.parse, sys

SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1qwU7ykIDUrtPlIQu-qk2FIJwiz-WWg5caq02ja30sgM/export?format=csv&gid=0"
OUTPUT_DIR = "journal/projects"
SITE_URL = "https://www.oftmw.com/map"
# Project detail pages live at the site ROOT (/projects/<slug>/), not under the
# map (/map/...). SITE_URL stays the map base for "View Map" links + ?project=
# modal deep-links; ROOT_URL is the base for the project pages themselves.
ROOT_URL = "https://www.oftmw.com"
DEFAULT_IMAGE = "https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_93ffb2f000f94a12aa874fe44153be18~mv2.jpg"
LOGO_URL = "https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png"

# Mapbox static image config — used for the mini map preview at bottom of project pages
MAPBOX_TOKEN = "pk.eyJ1IjoiZmxvcmlkYW9mdG9tb3Jyb3ciLCJhIjoiY2xrYmpmdGQ2MGdibTNzcXZjMnA4aXh3ZiJ9.uBeYS7jmKwWS6xAgY-R1UA"
MAPBOX_STYLE = "floridaoftomorrow/clkbk4qlw000a01qw94rj0xa7"

def slugify(title):
    s = title.lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s-]+', '-', s).strip('-')
    return s

def map_slug(title):
    """Slug for map deep-link param (no hyphens, matches JS logic)"""
    return re.sub(r'[^a-z0-9]', '', title.lower())

def delivery_info(delivery):
    d = delivery.lower().strip()
    stages = [
        ('announced',         'Announced',       10,  '#999999'),
        ('breaking ground',   'Breaking Ground', 30,  '#FFD300'),
        ('under construction','Construction',    60,  '#FF9500'),
        ('opening soon',      'Opening Soon',    85,  '#1FDF67'),
        ('now open',          'Now Open',        100, '#1FDF67'),
    ]
    for key, label, pct, color in stages:
        if key in d:
            return label, pct, color
    return 'Announced', 10, '#999999'

# Date-driven progress math. Server-side Python twin of window.computeProgress
# in index.html. Keep these two implementations in sync.
#
# Pick the start date: explicit StartDate column wins; else assume N years
# before delivery based on status.
_ASSUMED_YEARS = {
    'announced':         4.0,
    'breaking ground':   3.0,
    'under construction':2.5,
    'topping out':       1.5,
    'opening soon':      0.5,
}

def _coming_soon_display(raw_date_str, parsed_date, today):
    """Decide how to display an upcoming delivery date based on the precision
    of the original input string. Returns dict:
      { 'label': str, 'precision': 'day'|'month'|'year' }

    Day-precise inputs ('2027-06-15') return a day countdown like '20d'.
    Month-precise inputs ('2027-06' or 'June 2027') return the month name.
    Year-only inputs ('2027') return a season placeholder ('Winter').
    Quarter inputs return their canonical month name.
    Season inputs return the season word.
    """
    import re as _re
    s = (raw_date_str or '').strip()
    if not s or parsed_date is None:
        return {'label': '', 'precision': 'unknown'}

    # 1. Full ISO date -> day countdown
    if _re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        days = (parsed_date - today).days
        return {'label': f'{days}d', 'precision': 'day'}

    # 2. Year-month ISO -> month name
    if _re.match(r'^\d{4}-\d{2}$', s):
        return {'label': parsed_date.strftime('%b'), 'precision': 'month'}

    # 3. Month + year (e.g. "June 2027")
    if _re.match(r'^[A-Za-z]+\.?\s+\d{4}$', s):
        # Could be month-name OR season-name. Disambiguate by parsed month.
        first = s.split()[0].lower().rstrip('.')
        SEASON_LABELS = {
            'winter': 'Winter', 'spring': 'Spring',
            'summer': 'Summer', 'fall':   'Fall',
            'autumn': 'Fall',
        }
        if first in SEASON_LABELS:
            return {'label': SEASON_LABELS[first], 'precision': 'month'}
        return {'label': parsed_date.strftime('%b'), 'precision': 'month'}

    # 4. Quarter: "Q1 2027"
    m = _re.match(r'^Q([1-4])\s+\d{4}$', s, _re.IGNORECASE)
    if m:
        # Quarter precision -> use the end-of-quarter month name
        return {'label': parsed_date.strftime('%b'), 'precision': 'month'}

    # 5. Year only -> "Winter" since YYYY resolves to Dec 31 (end of year).
    m = _re.match(r'^(\d{4})$', s)
    if m:
        return {'label': 'Winter', 'precision': 'year'}

    # Unrecognized format -> just fall back to day countdown if we have a date
    days = (parsed_date - today).days
    return {'label': f'{days}d', 'precision': 'day'}

def _parse_iso_date(s):
    """Best-effort parse of a delivery-date string. Returns datetime.date or None.

    Format priority (most specific wins):
      1. '2027-06-15'  full ISO date  (exact day)
      2. 'June 2027' / 'Jun 2027'  month name + year  (uses day 15)
      3. 'Summer 2027' / 'Fall 2027' / etc  season + year, where the
         DATE represents END OF SEASON (developer convention):
            winter  -> March 1
            spring  -> June 1
            summer  -> September 1
            fall / autumn -> December 1
      4. 'Q1 2027' / 'Q2 2027'  quarter + year (end of quarter)
      5. '2027-06'  year-month ISO  (day 15)
      6. '2027'  year only (mid-year)

    Keep this in sync with parseDate() in index.html. If you add a format
    here, add it there too (and vice versa).
    """
    if not s: return None
    from datetime import date
    s = str(s).strip()
    if not s: return None
    import re as _re

    # 1. Full ISO: "2027-06-15"
    m = _re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    if m:
        try: return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError: return None

    # 2. Month name + year: "June 2027" or "Jun 2027"
    MONTHS = {
        'january':1,'jan':1, 'february':2,'feb':2, 'march':3,'mar':3,
        'april':4,'apr':4, 'may':5, 'june':6,'jun':6, 'july':7,'jul':7,
        'august':8,'aug':8, 'september':9,'sep':9,'sept':9,
        'october':10,'oct':10, 'november':11,'nov':11, 'december':12,'dec':12,
    }
    m = _re.match(r'^([A-Za-z]+)\.?\s+(\d{4})$', s)
    if m:
        mi = MONTHS.get(m.group(1).lower())
        if mi is not None:
            try: return date(int(m.group(2)), mi, 15)
            except ValueError: return None

    # 3. Season + year: end-of-season convention
    SEASONS = {
        'winter': (3, 1),
        'spring': (6, 1),
        'summer': (9, 1),
        'fall':   (12, 1),
        'autumn': (12, 1),
    }
    m = _re.match(r'^([A-Za-z]+)\s+(\d{4})$', s)
    if m:
        seas = SEASONS.get(m.group(1).lower())
        if seas:
            try: return date(int(m.group(2)), seas[0], seas[1])
            except ValueError: return None

    # 4. Quarter: "Q1 2027" -> end of Q1 (Mar 31), Q2 -> Jun 30, etc.
    m = _re.match(r'^Q([1-4])\s+(\d{4})$', s, _re.IGNORECASE)
    if m:
        q = int(m.group(1))
        # End of quarter month + day. Q1 = Mar 31, Q2 = Jun 30, Q3 = Sep 30, Q4 = Dec 31.
        end_months = {1: (3,31), 2: (6,30), 3: (9,30), 4: (12,31)}
        em, ed = end_months[q]
        try: return date(int(m.group(2)), em, ed)
        except ValueError: return None

    # 5. Year-month ISO: "2027-06"
    m = _re.match(r'^(\d{4})-(\d{2})$', s)
    if m:
        try: return date(int(m.group(1)), int(m.group(2)), 15)
        except ValueError: return None

    # 6. Year only: "2027" -> end of year (Dec 31). An undated YYYY means
    # "by the end of YYYY" by convention.
    m = _re.match(r'^(\d{4})$', s)
    if m:
        try: return date(int(m.group(1)), 12, 31)
        except ValueError: return None

    return None

def _format_time_to_delivery(delivery_date_str, status):
    """Return a short subtitle string like '18 months to delivery' or
    'Delivered Sep '23'. Returns '' if the date can't be parsed."""
    from datetime import date
    d = _parse_iso_date(delivery_date_str)
    if not d: return ''
    today = date.today()
    diff_days = (d - today).days
    s = (status or '').lower()
    if 'now open' in s:
        if diff_days < 0:
            return "Delivered " + d.strftime("%b '%y")
        return 'Now open'
    if diff_days <= 0:
        # Delivery date has passed but status hasn't flipped to Now Open
        # (probably a delayed project). Show the date as-is rather than
        # a negative time-to-delivery, which would read weirdly.
        return 'Delivery ' + d.strftime('%b %Y')
    if diff_days < 14:
        return f'{diff_days} day{"" if diff_days == 1 else "s"} to delivery'
    if diff_days < 60:
        return f'{round(diff_days / 7)} weeks to delivery'
    months = round(diff_days / 30.44)
    if months < 24:
        return f'{months} month{"" if months == 1 else "s"} to delivery'
    years = diff_days / 365.25
    yrs = f'{years:.1f}'.rstrip('0').rstrip('.')
    return f'{yrs} yrs to delivery'

def _label_to_seg_idx(label):
    """Map a status label to its segment index in the 5-stage bar."""
    return {
        'Announced':       0,
        'Breaking Ground': 1,
        'Construction':    2,
        'Topping Out':     2,  # visualizes as late-Construction
        'Opening Soon':    3,
        'Now Open':        4,
    }.get(label, -1)

# Visual segment widths (must sum to 100). Matches the JS twin in index.html.
# Construction = 40 (was 60); other stages = 15 each (were 10). Trade-off:
# the 40% Construction block has less internal resolution but the bookend
# stages are easier to see at the same overall bar width.
_SEG_WIDTHS = [15, 15, 40, 15, 15]
_SEG_STAGES = [
    ('Announced',       'rgba(255,255,255,0.55)'),
    ('Breaking Ground', '#FFD300'),
    ('Construction',    '#FF9500'),
    ('Opening Soon',    '#1FDF67'),
    ('Now Open',        '#1FDF67'),
]

def _build_segments(active_idx, active_fill_pct):
    """Build the 5-segment list. Each entry: dict with label, color,
    width_pct, fill_pct, state (done/active/future)."""
    segs = []
    for i, (lbl, c) in enumerate(_SEG_STAGES):
        if i < active_idx:
            state, fill = 'done', 100
        elif i == active_idx:
            state, fill = 'active', round(active_fill_pct)
        else:
            state, fill = 'future', 0
        segs.append({
            'label': lbl, 'color': c, 'width_pct': _SEG_WIDTHS[i],
            'state': state, 'fill_pct': fill,
        })
    return segs

def compute_progress(delivery_date_str, status, start_date_str=''):
    """Server-side mirror of window.computeProgress in index.html.
    Returns (pct, label, color, subtitle, segments). See JS twin for
    math docs."""
    from datetime import date
    label, fallback_pct, color = delivery_info(status or '')
    s = (status or '').lower().strip()
    # Short-circuit: Now Open is always 100%
    if 'now open' in s:
        return 100, label, color, _format_time_to_delivery(delivery_date_str, status), _build_segments(4, 100)
    # Short-circuit: Announced is a completed milestone, not a duration.
    # Bar shows segment 0 at 100% regardless of when the announcement
    # happened. Mirrors the JS twin in index.html.
    if label == 'Announced':
        return 5, label, color, _format_time_to_delivery(delivery_date_str, status), _build_segments(0, 100)
    delivery = _parse_iso_date(delivery_date_str)
    if not delivery:
        # No parseable delivery date -- fall back to status-based default
        fallback_seg = {
            'Announced':       (0, 50),
            'Breaking Ground': (1, 50),
            'Construction':    (2, 50),
            'Topping Out':     (2, 95),
            'Opening Soon':    (3, 50),
        }.get(label, (0, 50))
        segs = _build_segments(*fallback_seg)
        return fallback_pct, label, color, '', segs
    # Resolve start: explicit StartDate column wins; else status-based assumption
    start = _parse_iso_date(start_date_str)
    if not start:
        years = _ASSUMED_YEARS.get('announced', 4.0)
        for key, yrs in _ASSUMED_YEARS.items():
            if key in s:
                years = yrs
                break
        # delivery − N years
        try:
            start = date(delivery.year - int(years), delivery.month, delivery.day)
            frac = years - int(years)
            if frac:
                from datetime import timedelta
                start = start - timedelta(days=int(frac * 365.25))
        except ValueError:
            start = date(delivery.year - int(years), 1, 1)
    today = date.today()
    total = (delivery - start).days
    elapsed = (today - start).days
    if total <= 0:
        pct = 50
        elapsed_pct = 50.0
    else:
        pct = (elapsed / total) * 100
        elapsed_pct = max(0.0, min(100.0, pct))
    pct = max(0, min(99, pct))

    # Locate active segment + fill within it (matches JS twin)
    seg_start = 0
    active_idx = 0
    active_fill = 0
    for i, w in enumerate(_SEG_WIDTHS):
        seg_end = seg_start + w
        if elapsed_pct <= seg_end or i == len(_SEG_WIDTHS) - 1:
            active_idx = i
            into = elapsed_pct - seg_start
            active_fill = max(0.0, min(100.0, (into / w) * 100))
            break
        seg_start = seg_end

    # Status word takes priority for WHICH segment is active. Date math
    # determines HOW FULL the active segment is. See JS twin for rationale.
    status_idx = _label_to_seg_idx(label)
    if status_idx >= 0 and status_idx != active_idx:
        if status_idx > active_idx:
            # Status ahead of time -- jump forward, low fill
            active_idx = status_idx
            active_fill = 15
        else:
            # Status behind time -- project delayed; stay earlier, cap fill
            active_idx = status_idx
            active_fill = min(95, active_fill)

    return (
        round(pct), label, color,
        _format_time_to_delivery(delivery_date_str, status),
        _build_segments(active_idx, active_fill),
    )

_MONTH_NAMES = ['January','February','March','April','May','June',
                'July','August','September','October','November','December']

# Abbreviations whose trailing period should NOT be treated as a sentence end
# when auto-generating hero mini-bios (otherwise "120 S. Dixie" splits at "S.").
_TEASER_ABBREV = {
    's', 'st', 'ave', 'blvd', 'rd', 'dr', 'mr', 'mrs', 'ms', 'jr', 'sr',
    'inc', 'co', 'ltd', 'corp', 'no', 'vs', 'dept', 'fig', 'approx',
    'etc', 'ft', 'sq', 'mt', 'mts', 'u.s', 'u.k', 'e.g', 'i.e', 'p.m', 'a.m',
}


def _split_sentences(text):
    """Split prose into sentences, but don't break on abbreviation periods
    (e.g. 'S.', 'St.', 'Inc.') or single-letter initials, and not on decimals
    like '0.87' (the period isn't followed by whitespace + a capital there)."""
    sentences, start = [], 0
    for m in re.finditer(r'([.!?])\s+(?=[A-Z0-9"\'“])', text):
        end = m.start()
        prev = text[max(0, end - 14):end]
        last_word = re.split(r'[\s(]', prev)[-1].lower().rstrip('.')
        if last_word in _TEASER_ABBREV or (len(last_word) == 1 and last_word.isalpha()):
            continue
        sentences.append(text[start:end + 1].strip())
        start = m.end()
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    return [s for s in sentences if s]


def _hero_teaser(text, target=190, cap=300):
    """Auto-generate a short hero mini-bio from a project's full description.
    Uses the first sentence (adding a second only if the first is very short),
    so the hero stays a tight teaser while the full text lives in About below.
    Falls back to a word-boundary cut + ellipsis if a single sentence is huge."""
    text = (text or '').strip()
    if not text:
        return ''
    sents = _split_sentences(text) or [text]
    out = sents[0]
    i = 1
    while len(out) < 110 and i < len(sents) and len(out) + 1 + len(sents[i]) <= cap:
        out += ' ' + sents[i]
        i += 1
    if len(out) > cap:
        cut = out[:cap]
        if ' ' in cut:
            cut = cut[:cut.rfind(' ')]
        out = cut.rstrip(' ,;:—–-') + '…'
    return out


# Inline TMW Intelligence mark — the spinning hexagon (pulse-glow + expanding
# ring), no wordmark. Sits in front of the "Last verified" line.
TMW_UPD_ICON = (
    '<span class="tmw-upd-ico" aria-hidden="true"><svg viewBox="0 0 100 100">'
    '<polygon class="tmw-upd-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" '
    'fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/>'
    '<g class="tmw-upd-spin">'
    '<polygon class="tmw-upd-core" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" '
    'fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/>'
    '</g>'
    '</svg></span>'
)


def format_updated(raw):
    """ISO 8601 timestamp -> 'Jun 1, 2026' (date only — time intentionally
    dropped). '' when blank/unparseable."""
    raw = (raw or '').strip()
    if not raw:
        return ''
    from datetime import datetime, timezone
    s = raw.replace('Z', '+00:00')
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.strptime(raw[:10], '%Y-%m-%d')
        except ValueError:
            return ''
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return f'{dt.strftime("%b")} {dt.day}, {dt.year}'


def format_fact_date(raw):
    """Compact date format for the Start / Completion fact tiles:
      'YYYY-MM-DD' -> 'MM.DD.YY'   e.g. '2024-02-15' -> '02.15.24'
      'YYYY-MM'    -> 'MM.YY'      e.g. '2024-02'    -> '02.24'
      'Month YYYY' -> 'MM.YY'      e.g. 'February 2024' -> '02.24'
      'YYYY'       -> 'YYYY'       (unchanged)
    Anything else: extract a 4-digit year if present, else pass through.
    Keep in sync with fmtFactDate() in index.html (map modal)."""
    if not raw:
        return ''
    import re as _re
    s = str(raw).strip()
    m = _re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    if m:
        return f'{m.group(2)}.{m.group(3)}.{m.group(1)[2:]}'
    m = _re.match(r'^(\d{4})-(\d{2})$', s)
    if m:
        return f'{m.group(2)}.{m.group(1)[2:]}'
    _MON = {'january':'01','jan':'01','february':'02','feb':'02','march':'03','mar':'03',
            'april':'04','apr':'04','may':'05','june':'06','jun':'06','july':'07','jul':'07',
            'august':'08','aug':'08','september':'09','sep':'09','sept':'09','october':'10','oct':'10',
            'november':'11','nov':'11','december':'12','dec':'12'}
    m = _re.match(r'^([A-Za-z]+)\.?\s+(\d{4})$', s)
    if m and _MON.get(m.group(1).lower()):
        return f'{_MON[m.group(1).lower()]}.{m.group(2)[2:]}'
    m = _re.match(r'^(\d{4})$', s)
    if m:
        return m.group(1)
    m = _re.search(r'(\d{4})', s)
    if m:
        return m.group(1)
    return s


def format_delivery_display(raw):
    """Display-formatter for delivery values shown on static project pages.
    Server-side mirror of window.formatDeliveryDisplay in index.html.
    Keep these two implementations in sync.

    Rules (priority order):
      'YYYY-MM-DD' -> 'Month Day, Year'   e.g. '2027-06-15' -> 'June 15, 2027'
      'YYYY-MM'    -> 'Month Year'        e.g. '2027-06'    -> 'June 2027'
      'YYYY'       -> 'YYYY'              (unchanged)
      anything else passes through untouched (e.g. 'Spring 2027', 'Q2 2028')
    """
    if not raw: return ''
    import re as _re
    s = str(raw).strip()
    if not s: return ''
    m = _re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    if m:
        mi = int(m.group(2)) - 1
        if 0 <= mi < 12:
            return f"{_MONTH_NAMES[mi]} {int(m.group(3))}, {m.group(1)}"
    m = _re.match(r'^(\d{4})-(\d{2})$', s)
    if m:
        mi = int(m.group(2)) - 1
        if 0 <= mi < 12:
            return f"{_MONTH_NAMES[mi]} {m.group(1)}"
    return s

def progress_bar_html(delivery, delivery_date='', start_date=''):
    """Render the Gradient Meter timeline (purple→green, with an overlay so green
    only shows at completion). Shared verbatim with tmw-project-intel.js
    renderTimeline (search/articles) and the map modal's buildProgress()."""
    _pct, _, _, subtitle, segments = compute_progress(delivery_date, delivery, start_date)
    # Knob sits within the ACTIVE stage's even zone (20% each) so it aligns with
    # the highlighted stage. Announced = 5%; never below 5%.
    ai = next((i for i, s in enumerate(segments) if s['state'] == 'active'), -1)
    if ai < 0:
        pct = 100 if all(s['state'] == 'done' for s in segments) else 5
    elif ai == 0:
        pct = 5
    else:
        pct = (ai + (segments[ai].get('fill_pct', 0) or 0) / 100) * 20
    pct = max(5, min(100, round(pct)))
    # "Opening Soon" means imminent — always read near-complete (>=78%).
    if ai == 3:
        pct = max(pct, 78)
    d = (delivery or '').lower()
    complete = pct >= 100 or 'now open' in d or 'complete' in d or 'delivered' in d
    glow = '31,223,103' if complete else '167,139,250'   # green when done, purple in progress
    accent = '#1FDF67' if complete else '#B9A6FF'

    stages_html = ''
    for seg in segments:
        on = seg['state'] == 'active'
        cls = 'on' if on else ('done' if seg['state'] == 'done' else '')
        style = (f' style="color:{accent};font-weight:800;'
                 f'text-shadow:0 0 12px rgba({glow},.5)"') if on else ''
        stages_html += f'<span class="pm-tl-stage {cls}"{style}>{seg["label"]}</span>'

    date_html = f'<div class="pm-tl-date">{subtitle}</div>' if subtitle else ''
    knob_left = 'calc(100% - 18px)' if pct >= 98 else f'{pct}%'

    return f'''
    <div class="pm-tl">{date_html}
      <div class="pm-tl-meter"><div class="pm-tl-grad"></div>
        <div class="pm-tl-empty" style="left:{pct}%"></div>
        <div class="pm-tl-knob" style="left:{knob_left};box-shadow:0 2px 8px rgba(0,0,0,.5),0 0 0 2px rgba({glow},.42),0 0 12px rgba({glow},.55)">{pct}%</div>
      </div>
      <div class="pm-tl-stages">{stages_html}</div>
    </div>'''

def gallery_html(row):
    imgs = [row.get('ImageURL',''), row.get('Image2',''), row.get('Image3',''),
            row.get('Image4',''), row.get('Image5','')]
    imgs = [i.strip() for i in imgs if i and i.strip()]
    if not imgs:
        return ''

    # Single image — same centered/rounded slider styling as multi-image,
    # just without arrow buttons or the image counter.
    if len(imgs) == 1:
        return f'''
    <div class="gallery gs-slider" data-count="1">
      <div class="gs-track">
        <img class="gs-slide" src="{imgs[0]}" alt="" loading="eager" data-i="0" data-pos="active" />
      </div>
    </div>'''

    # Multiple images — slider with desktop peek effect; mobile fades full-width
    slides = ''.join(
        f'<img class="gs-slide" src="{u}" alt="" '
        f'loading="{"eager" if i == 0 else "lazy"}" data-i="{i}" />'
        for i, u in enumerate(imgs)
    )
    return f'''
    <div class="gallery gs-slider" data-count="{len(imgs)}">
      <div class="gs-track">{slides}</div>
      <button class="gs-arrow gs-prev" aria-label="Previous image">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <button class="gs-arrow gs-next" aria-label="Next image">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
      <div class="gs-counter"><span class="gs-cur">1</span> / {len(imgs)}</div>
    </div>'''

def map_preview_html(lat, lng, map_url):
    """Generate a clickable Mapbox static image preview with a green pin at the project location."""
    if not lat or not lng:
        return ''
    try:
        flat, flng = float(lat), float(lng)
    except (TypeError, ValueError):
        return ''
    # Mapbox Static Image API URL — green pin at coords, zoom 14, 720x320 retina
    img_url = (
        f"https://api.mapbox.com/styles/v1/{MAPBOX_STYLE}/static/"
        f"pin-l+1FDF67({flng},{flat})/"
        f"{flng},{flat},14,0/720x320@2x"
        f"?access_token={MAPBOX_TOKEN}"
    )
    return f'''
    <a class="map-preview" href="{map_url}" aria-label="View on map">
      <img src="{img_url}" alt="Map location" loading="lazy" />
      <div class="map-preview-overlay">
        <div class="map-preview-cta">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
          View on Map
        </div>
      </div>
    </a>'''

def stat_card(label, value):
    if not value or not value.strip():
        return ''
    return f'''<div class="stat-card">
      <div class="stat-label">{label}</div>
      <div class="stat-val">{value.strip()}</div>
    </div>'''

def truncate_developer(dev):
    if not dev:
        return ''
    parts = re.split(r'\s*,\s*', dev)
    if len(parts) > 2:
        return parts[0].strip() + ' & More'
    return dev


def _format_article_date(iso):
    """Convert an ISO timestamp to 'Mar 12, 2026'. Empty input -> empty string."""
    if not iso:
        return ''
    try:
        from datetime import datetime
        # Articles.json publishes ISO 8601 with timezone; strip Z if present
        cleaned = iso.replace('Z', '+00:00') if iso.endswith('Z') else iso
        d = datetime.fromisoformat(cleaned)
        return d.strftime('%b %-d, %Y')
    except Exception:
        return ''


def _escape_attr(s):
    """Escape a string for safe use inside an HTML attribute value."""
    return (s or '').replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')


def _escape_text(s):
    """Escape a string for safe insertion into HTML text content."""
    return (s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def coverage_section_html(articles, project_title, default_image):
    """Render the 'Coverage on TMW' section as static HTML.

    articles: list of {title, link, image, published_at, guid} dicts (already
              sorted newest first by the pulse pipeline).
    project_title: used to build a fallback search link if there are more
                   articles than fit in the section.
    default_image: project's hero image, used as a thumbnail fallback when
                   an article has no image of its own.

    Returns empty string if the project has no matching articles -- the
    section won't appear on those pages.
    """
    if not articles:
        return ''

    featured = articles[0]
    rest = articles[1:5]
    total = len(articles)

    f_img = featured.get('image') or default_image or ''
    f_img_style = f' style="background-image:url(\'{_escape_attr(f_img)}\')"' if f_img else ''

    rows_html = ''
    for a in rest:
        a_img = a.get('image') or default_image or ''
        a_thumb_style = f' style="background-image:url(\'{_escape_attr(a_img)}\')"' if a_img else ''
        rows_html += f'''
          <a class="cv-row" href="{_escape_attr(a.get('link',''))}" target="_blank" rel="noopener">
            <div class="cv-thumb"{a_thumb_style}></div>
            <div class="cv-row-body">
              <div class="cv-row-title">{_escape_text(a.get('title',''))}</div>
              <div class="cv-row-meta">{_escape_text(_format_article_date(a.get('published_at','')))}</div>
            </div>
            <div class="cv-row-arrow">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </a>
        '''

    list_html = f'<div class="cv-list">{rows_html}</div>' if rows_html.strip() else ''

    view_all_html = ''
    if total > 5:
        # Use form-encoding (spaces become +) to match oftmw.com/search URL style.
        # quote_plus does exactly this.
        search_url = f"https://www.oftmw.com/search?q={urllib.parse.quote_plus(project_title)}"
        view_all_html = f'''
          <a class="cv-view-all" href="{_escape_attr(search_url)}" target="_blank" rel="noopener">
            View all {total} articles
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          </a>
        '''

    # Inline styles -- self-contained so this drops into any project page
    # without needing edits to the shared stylesheet.
    return f'''
  <section class="coverage-section">
    <div class="cv-header">
      <h2 class="cv-title">Coverage on TMW <span class="cv-count">{total}</span></h2>
    </div>
    <a class="cv-featured" href="{_escape_attr(featured.get('link',''))}" target="_blank" rel="noopener">
      <div class="cv-featured-img"{f_img_style}>
        <div class="cv-featured-tag">Latest</div>
      </div>
      <div class="cv-featured-body">
        <div class="cv-featured-title">{_escape_text(featured.get('title',''))}</div>
        <div class="cv-meta">{_escape_text(_format_article_date(featured.get('published_at','')))}</div>
      </div>
    </a>
    {list_html}
    {view_all_html}
  </section>
'''


# ── Living dossier: the sourced, event-dated milestone timeline ───────────────
# Full construction-phase taxonomy. Two coarse phases ('construction',
# 'coming-soon') come straight from the lifecycle `status`; the finer ones are
# logged by the sweep as type:'milestone' status_history events. The generic
# coarse phases are suppressed when a finer phase in their band is present.
DOSSIER_ORDER = [
    'announced', 'financing', 'breaking-ground', 'construction', 'going-vertical',
    'halfway', 'topping-out', 'tenant', 'tco', 'coming-soon', 'move-in', 'bookings', 'grand-opening',
]
DOSSIER_RANK = {k: i for i, k in enumerate(DOSSIER_ORDER)}
DOSSIER_LABEL = {
    'announced': 'Announced', 'financing': 'Financing secured', 'breaking-ground': 'Broke ground',
    'construction': 'Under construction', 'going-vertical': 'Going vertical', 'halfway': 'Halfway there',
    'topping-out': 'Topped out', 'tenant': 'Tenant announced', 'tco': 'TCO received',
    'coming-soon': 'Coming soon', 'move-in': 'Resident move-in', 'bookings': 'Bookings open',
    'grand-opening': 'Opened',
}
# Lifecycle status → its phase in the timeline.
DOSSIER_STATUS_TO_PHASE = {
    'announced': 'announced', 'breaking-ground': 'breaking-ground', 'construction': 'construction',
    'coming-soon': 'coming-soon', 'open': 'grand-opening',
}
DOSSIER_FINE_CONSTRUCTION = ['topping-out', 'halfway', 'going-vertical']  # highest-rank first
DOSSIER_FINE_NEAROPEN = ['bookings', 'move-in', 'tco']                    # highest-rank first


def _url_domain(u):
    try:
        from urllib.parse import urlparse
        host = (urlparse(u or '').netloc or '').lower()
        return host[4:] if host.startswith('www.') else host
    except Exception:
        return ''


def _dossier_status_code(raw):
    s = (raw or '').strip().lower()
    if not s:
        return 'announced'
    if 'open' in s or 'complete' in s:
        return 'open'
    if 'coming' in s or 'opening' in s:
        return 'coming-soon'
    if 'construction' in s or 'topping' in s or 'vertical' in s:
        return 'construction'
    if 'breaking' in s or 'ground' in s:
        return 'breaking-ground'
    return 'announced'


def _fmt_event_date(s):
    """YYYY / YYYY-MM / YYYY-MM-DD (or an ISO datetime) -> 'Sep 3, 2025' /
    'Sep 2025' / '2025'. '' when unparseable."""
    s = (s or '').strip()
    m = re.match(r'^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?', s)
    if not m:
        return ''
    MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    y, mo, d = m.group(1), m.group(2), m.group(3)
    if mo and d:
        return f"{MONTHS[int(mo) - 1]} {int(d)}, {y}"
    if mo:
        return f"{MONTHS[int(mo) - 1]} {y}"
    return y


def build_milestones(row, articles=None):
    """Assemble the event-dated, sourced milestone timeline for a project over the
    full construction-phase taxonomy. Sources, in order of authority:
      1. status_history type:'milestone' events (fine phases) + status transitions
         (coarse phases) — both carry effective_date + source.
      2. StartDate -> broke ground, DeliveryDate -> opening (field anchors).
      3. earliest article date -> 'announced' proxy (guarded against inversion).
    Generic 'construction'/'coming-soon' are suppressed when a finer phase in
    their band exists. Returns {'milestones': [...], 'current': phase}."""
    cur_status = _dossier_status_code(row.get('Delivery', ''))
    cur_phase = DOSSIER_STATUS_TO_PHASE.get(cur_status, 'announced')

    def entry(phase, date_str='', source_url='', estimated=False, sourced=False, note=''):
        return {
            'phase': phase, 'rank': DOSSIER_RANK.get(phase, 0),
            'label': DOSSIER_LABEL.get(phase, phase),
            'date': date_str or '', 'date_display': _fmt_event_date(date_str),
            'source_url': source_url or '', 'source_domain': _url_domain(source_url),
            'estimated': bool(estimated), 'sourced': bool(sourced),
            'note': (note or '').strip(),
        }

    found = {}
    def consider(e):
        prev = found.get(e['phase'])
        # Prefer a sourced entry, then one carrying a date.
        if (prev is None
                or (e['sourced'] and not prev['sourced'])
                or (e['date'] and not prev['date'] and e['sourced'] == prev['sourced'])):
            found[e['phase']] = e

    # 1) status_history: milestone events + status transitions.
    for h in (row.get('StatusHistory') or []):
        if not isinstance(h, dict):
            continue
        t = h.get('type')
        if t in ('date', 'field'):
            continue
        ev = (h.get('effective_date') or '').strip()
        rec = (h.get('at') or '').strip()
        if t == 'milestone':
            ph = (h.get('phase') or '').strip().lower()
            if ph in DOSSIER_RANK:
                consider(entry(ph, ev or rec[:10], h.get('source_url', ''), estimated=not ev, sourced=True, note=h.get('note', '')))
        else:
            ph = DOSSIER_STATUS_TO_PHASE.get((h.get('to') or '').strip().lower())
            if ph:
                consider(entry(ph, ev or rec[:10], h.get('source_url', ''), estimated=not ev, sourced=True, note=h.get('note', '')))

    # 2) field anchors.
    start_date = (row.get('StartDate', '') or '').strip()
    delivery_date = (row.get('DeliveryDate', '') or '').strip()
    if start_date and 'breaking-ground' not in found:
        consider(entry('breaking-ground', start_date, estimated=(row.get('StartSpeculative', '') == '1')))
    if delivery_date and 'grand-opening' not in found:
        consider(entry('grand-opening', delivery_date, estimated=(row.get('DeliverySpeculative', '') == '1')))

    # 3) announced proxy (earliest article) — only when it predates everything
    # else, so late coverage can't invert the timeline.
    if articles and 'announced' not in found:
        dated = [a for a in articles if (a.get('published_at', '') or '').strip()]
        if dated:
            first = min(dated, key=lambda a: (a.get('published_at', '') or '')[:10])
            adate = (first.get('published_at', '') or '')[:10]
            others = [e['date'][:10] for e in found.values() if e['date']]
            if start_date:
                others.append(start_date[:10])
            if delivery_date:
                others.append(delivery_date[:10])
            if adate and (not others or adate < min(others)):
                consider(entry('announced', adate, first.get('link', ''), sourced=bool(first.get('link'))))

    # Prefer TMW's own coverage (oftmw.com) as the source when we published about
    # a milestone the same month (or year, for year-grain dates) it happened —
    # keep readers in our ecosystem when we covered the event.
    if articles:
        tmw_by_key = {}
        for a in sorted(articles, key=lambda x: (x.get('published_at', '') or '')):
            link = (a.get('link', '') or '')
            pa = (a.get('published_at', '') or '')[:10]
            if 'oftmw.com' not in link or not pa:
                continue
            tmw_by_key.setdefault(pa[:7], link)   # YYYY-MM (first/earliest that month)
            tmw_by_key.setdefault(pa[:4], link)   # YYYY
        if tmw_by_key:
            for e in found.values():
                d = e['date'] or ''
                key = d[:7] if len(d) >= 7 else d[:4]
                if key and key in tmw_by_key and 'oftmw.com' not in (e['source_url'] or ''):
                    e['source_url'] = tmw_by_key[key]
                    e['source_domain'] = _url_domain(tmw_by_key[key])

    # Suppress the generic coarse phase when a finer one in its band is present,
    # and move the "current" marker to the finest present phase in that band.
    if any(p in found for p in DOSSIER_FINE_CONSTRUCTION):
        found.pop('construction', None)
        if cur_phase == 'construction':
            cur_phase = next((p for p in DOSSIER_FINE_CONSTRUCTION if p in found), cur_phase)
    if any(p in found for p in DOSSIER_FINE_NEAROPEN):
        found.pop('coming-soon', None)
        if cur_phase == 'coming-soon':
            cur_phase = next((p for p in DOSSIER_FINE_NEAROPEN if p in found), cur_phase)
    cur_rank = DOSSIER_RANK.get(cur_phase, 0)

    entries = []
    for phase in DOSSIER_ORDER:
        m = found.get(phase)
        rank = DOSSIER_RANK[phase]
        is_current = (phase == cur_phase)
        if m is None and not is_current and phase != 'grand-opening':
            continue  # honest: don't invent dateless milestones
        if m is None:
            m = entry(phase)
        # Projected (future, hollow) when it hasn't happened: the opening before
        # the project is open, or an un-sourced phase beyond the current point.
        m['projected'] = (not m['sourced']) and (
            (phase == 'grand-opening' and cur_status != 'open') or (rank > cur_rank)
        )
        if phase == 'grand-opening' and m['projected']:
            m['label'] = 'Expected opening'
        entries.append(m)

    # Order CHRONOLOGICALLY (by event date), not by phase rank — a financing or
    # tenant milestone can legitimately land mid-build. Date-less confirmed
    # entries slot after the dated ones (by rank); projected (future) always last.
    def _sort_key(m):
        mm = re.match(r'^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?', (m['date'] or '')[:10])
        nd = f"{mm.group(1)}-{mm.group(2) or '01'}-{mm.group(3) or '01'}" if mm else ''
        if m['projected']:
            return (2, nd or '9999-99-99', m['rank'])
        return (0, nd, m['rank']) if nd else (1, '', m['rank'])
    entries.sort(key=_sort_key)

    for m in entries:
        m['state'] = 'future' if m['projected'] else 'past'
    done = [m for m in entries if not m['projected']]
    if done:
        done[-1]['state'] = 'now'  # latest confirmed (chronological) = now
    return {'milestones': entries, 'current': cur_phase}


def dossier_rows_html(ms):
    """The SHARED inner `.dos-row` markup for the dossier timeline. Generated once
    (here, server-side) and used by BOTH the project page (wrapped in a section)
    and the map (injected into the panel via dossiers.json) — so the two are
    byte-identical with a single renderer. Returns '' when there's no real story
    to tell (< 2 substantive milestones)."""
    if not ms or len([m for m in ms if m.get('date_display') or m.get('state') != 'future']) < 2:
        return ''
    rows = []
    for m in ms:
        state = m['state']
        dot = f'<span class="dos-dot dos-{state}"></span>'
        if m['date_display']:
            est = '<span class="dos-est">est.</span>' if m['estimated'] else ''
            date_html = f'<span class="dos-date">{_escape_text(m["date_display"])}{est}</span>'
        elif state == 'future':
            date_html = '<span class="dos-date dos-tbd">date TBD</span>'
        else:
            date_html = ''
        src_html = ''
        if m['source_url'] and m['source_domain']:
            src_html = (f'<a class="dos-src" href="{_escape_attr(m["source_url"])}" '
                        f'target="_blank" rel="noopener">{_escape_text(m["source_domain"])}'
                        f'<svg class="dos-arr" viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" '
                        f'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                        f'<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>')
        info_html = ''
        if m.get('note'):
            info_html = (
                '<span class="dos-info" tabindex="0">'
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
                'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/>'
                '<line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
                f'<span class="dos-tip">{_escape_text(m["note"])}</span></span>'
            )
        rows.append(
            f'<div class="dos-row dos-row-{state}">{dot}'
            f'<div class="dos-body"><div class="dos-line">'
            f'<span class="dos-label">{_escape_text(m["label"])}</span>{date_html}{info_html}</div>'
            f'{src_html}</div></div>'
        )
    return ''.join(rows)


def dossier_section_html(row, articles=None):
    # Reuse the precomputed list (set in main()); fall back to computing for
    # standalone/local renders.
    ms = row.get('Milestones')
    if ms is None:
        ms = build_milestones(row, articles)['milestones']
    rows = dossier_rows_html(ms)
    if not rows:
        return ''
    return (
        f'<div class="pp-sec pp-dossier"><div class="pp-sec-h">{TMW_UPD_ICON} The story so far</div>'
        f'<div class="dos-tl">{rows}</div>'
        f'<div class="dos-note">Milestones are dated to when they actually happened and linked to '
        f'their source. This record fills in over time as TMW tracks the project.</div></div>'
    )


def build_page(row, articles=None, nearby=None):
    title = row.get('Title','').strip()
    city  = row.get('City','').strip()
    # Subtitle prefers the sheet's "PreferredType" column when set (a single curated
    # label, e.g. "Apartments"); otherwise falls back to the first value from the
    # comma-separated ProjectType list.
    preferred_type = row.get('PreferredType','').strip()
    first_project_type = row.get('ProjectType','').strip().split(',')[0].strip()
    proj_type = preferred_type if preferred_type else first_project_type
    delivery  = row.get('Delivery','').strip()
    delivery_date = row.get('DeliveryDate','').strip()
    # Optional explicit start date. When present, compute_progress uses it
    # directly. When blank (column doesn't exist yet, or row not backfilled),
    # falls back to: delivery_date − N years, with N keyed off status.
    start_date = row.get('StartDate','').strip()
    developer = truncate_developer(row.get('Developer','').strip())
    architect = row.get('Architect','').strip().split(',')[0].strip()
    description = row.get('DescriptionLong','').strip() or row.get('Description','').strip()
    image = row.get('ImageURL','').strip() or DEFAULT_IMAGE
    website = row.get('OfficialWebsite','').strip()
    featured = row.get('Featured','').strip().lower() == 'featured'
    lat = row.get('Latitude','').strip()
    lng = row.get('Longitude','').strip()

    slug     = slugify(title)
    mslug    = map_slug(title)
    # Attribute-safe title for embedding in data-* attributes (the Watch
    # button hydration script reads this to pass back to the favorites API).
    esc_attr_title = _escape_attr(title)
    page_url = f"{ROOT_URL}/projects/{slug}/"
    # Deep-link to the map: ?project=<slug> opens the project's modal there.
    map_url  = f"{SITE_URL}/?project={mslug}"

    seo_title = f"{title}, {city} | Markets of Tomorrow"
    seo_desc  = description[:200].rstrip() + ('…' if len(description) > 200 else '')

    # Pills — only the Featured star, project type now lives in subtitle only
    pills = ''
    if featured:
        pills += '<span class="pill pill-featured">★ Featured</span>'
    pills_section = f'<div class="pills">{pills}</div>' if pills else ''

    # Stats
    stats = ''
    stats += stat_card('Developer', developer)
    stats += stat_card('Architect', architect)
    stats += stat_card('Delivery', format_delivery_display(delivery_date or delivery))
    stats += stat_card('Market', city)
    stats_section = f'<div class="stats-grid">{stats}</div>' if stats.strip() else ''

    # Primary CTA — gold-glow "Dive Deeper" → opens this project on the map.
    dive_btn = (
        f'<a class="btn-dive" href="{map_url}">Dive Deeper '
        '<svg viewBox="0 0 24 24" aria-hidden="true">'
        '<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>'
        '<line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg></a>'
    )
    # Subtle "Official Website" text link placed below the description paragraph.
    # Only shown when a website exists (no disabled placeholder).
    website_subtle = ''
    if website:
        website_subtle = (
            f'<a class="btn-website" href="{website}" target="_blank" rel="noopener">Official Website '
            '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/>'
            '<polyline points="7 7 17 7 17 17"/></svg></a>'
        )

    # Share button — uses Web Share API on mobile/supported browsers, falls back to clipboard
    share_btn = (
        '<button class="btn-share" type="button" aria-label="Share project" '
        'onclick="window.shareProject &amp;&amp; window.shareProject(this)">'
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>'
        '<polyline points="16 6 12 2 8 6"/>'
        '<line x1="12" y1="2" x2="12" y2="15"/>'
        '</svg>'
        '<span class="btn-share-tooltip" aria-live="polite"></span>'
        '</button>'
    )

    # JSON-LD structured data
    jsonld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Place",
        "name": title,
        "description": seo_desc,
        "image": image,
        "url": page_url,
        "address": { "@type": "PostalAddress", "addressLocality": city },
        "additionalProperty": [
            {"@type": "PropertyValue", "name": "Status", "value": delivery},
            {"@type": "PropertyValue", "name": "Developer", "value": developer},
            {"@type": "PropertyValue", "name": "Architect", "value": architect},
        ]
    }, indent=2)

    # ── Cinematic layout fragments ──────────────────────────────────────────
    # Status eyebrow (colored dot + raw status word, e.g. "Now Open").
    status_label, _status_pct, status_color = delivery_info(delivery)
    status_text = delivery or status_label
    star = '★ ' if featured else ''
    eyebrow_html = (f'<span class="pp-eyebrow"><span class="d" style="color:{status_color}"></span>'
                    f'{star}{status_text}</span>')

    # Hero lede (auto-generated mini-bio) vs. below "About" (full bio).
    # Short descriptions are no longer authored in the backend, so we always
    # derive a tight hero teaser from the full description and keep the complete
    # text in the About section below. Source the full bio from DescriptionLong,
    # falling back to the legacy Description field.
    about_long = (row.get('DescriptionLong', '').strip()
                  or row.get('Description', '').strip())
    lede = _hero_teaser(about_long)
    about_section = ''
    if about_long and about_long != lede:
        about_section = (f'<div class="pp-sec"><div class="pp-sec-h">About the project</div>'
                         f'<p class="pp-about">{about_long}</p></div>')

    # Gallery images — hero background cycles through these (ImageURL + Image2..5).
    gallery_imgs = []
    for _k in ('ImageURL', 'Image2', 'Image3', 'Image4', 'Image5'):
        _v = (row.get(_k, '') or '').strip()
        if _v and _v not in gallery_imgs:
            gallery_imgs.append(_v)
    if not gallery_imgs:
        gallery_imgs = [image]
    hero_bg0 = gallery_imgs[0]
    images_attr = _escape_attr(json.dumps(gallery_imgs))

    gallery_cluster = ''
    if len(gallery_imgs) > 1:
        gallery_cluster = (
            '<div class="pp-gal" id="ppGal">'
            '<button class="pp-gal-prev" type="button" aria-label="Previous photo">'
            '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>'
            '<div class="pp-gal-dots"></div><span class="pp-gal-cnt"></span>'
            '<button class="pp-gal-next" type="button" aria-label="Next photo">'
            '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></div>'
        )

    # Hero mini-stats (panel) — the standardized fact set, matching the map
    # modal: Units / Floors / Keys / Start / Delivery / Market, whichever are
    # available. Start shows only when a real (non-speculative) start date exists,
    # and always sits just before Delivery (the two timeline bookends).
    mini_items = []
    def _add_mini(_v, _l):
        _v = (_v or '').strip()
        if _v:
            mini_items.append((_v, _l))
    # Order: Start · Completion · Keys · Units · Floors (Market removed; dates
    # in compact MM.DD.YY / MM.YY / YYYY form). Start only when non-speculative.
    _start_raw = (row.get('StartDate', '') or '').strip()
    _start_spec = (row.get('StartSpeculative', '') or '').strip() in ('1', 'true', 'True')
    if _start_raw and not _start_spec:
        _add_mini(format_fact_date(_start_raw), 'Start')
    # Completion — prefix "Est" when the delivery date is a TMW estimate.
    _delivery_spec = (row.get('DeliverySpeculative', '') or '').strip() in ('1', 'true', 'True')
    _completion = format_fact_date(delivery_date)
    if _completion and _delivery_spec:
        _completion = 'Est ' + _completion
    _add_mini(_completion, 'Completion')
    _add_mini(row.get('Keys', ''), 'Keys')
    _add_mini(row.get('Units', ''), 'Units')
    _add_mini(row.get('Floors', ''), 'Floors')
    minis_html = ''
    if mini_items:
        minis_html = '<div class="pp-minis">' + ''.join(
            f'<div class="pp-mini"><div class="v">{_v}</div><div class="k">{_l}</div></div>'
            for _v, _l in mini_items) + '</div>'

    # "Last verified <date>" row with the spinning TMW Intelligence hexagon —
    # sits at the top of the panel, above the timeline. Hidden when no stamp.
    _updated_fmt = format_updated(row.get('UpdatedAt', ''))
    updated_html = ''
    if _updated_fmt:
        updated_html = (f'<div class="pp-updated">{TMW_UPD_ICON}'
                        f'<span class="pp-updated-t">Last verified {_updated_fmt}</span></div>')

    # Developer & design firm cards (link to /firm/<slug>/ when a slug exists).
    def _firm_card(name, fslug, role):
        if not name:
            return ''
        if fslug:
            return (f'<a class="pp-firm" href="/firm/{fslug}/"><div class="k">{role}</div>'
                    f'<div class="v">{name}</div><span class="go">View firm profile →</span></a>')
        return (f'<div class="pp-firm"><div class="k">{role}</div><div class="v">{name}</div></div>')

    _dev_names = [n.strip() for n in (row.get('Developer', '') or '').split(',') if n.strip()]
    _dev_slugs = [s.strip() for s in (row.get('DeveloperSlugs', '') or '').split(',') if s.strip()]
    _arch_names = [n.strip() for n in (row.get('Architect', '') or '').split(',') if n.strip()]
    _arch_slugs = [s.strip() for s in (row.get('ArchitectSlugs', '') or '').split(',') if s.strip()]
    dev_card = _firm_card(_dev_names[0] if _dev_names else '',
                          _dev_slugs[0] if _dev_slugs else '', 'Developer')
    arch_card = _firm_card(_arch_names[0] if _arch_names else '',
                           _arch_slugs[0] if _arch_slugs else '', 'Architect')
    firms_section = ''
    if dev_card or arch_card:
        firms_section = (f'<div class="pp-sec"><div class="pp-sec-h">Developer &amp; design</div>'
                         f'<div class="pp-firms">{dev_card}{arch_card}</div></div>')

    # Watch button (moved out of the template so it can live inside the hero).
    watch_btn = (
        f'<button class="btn-watch" id="watchBtn" type="button" aria-label="Watch this project" '
        f'data-slug="{slug}" data-title="{esc_attr_title}">'
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>'
        '<circle cx="12" cy="12" r="3"/></svg>'
        '<span class="btn-watch-label" id="watchBtnLabel">Watch</span>'
        '<span class="btn-watch-dot" aria-hidden="true"></span></button>'
    )

    # Static (JS-hydrated) blocks that now live inside #ppBelow.
    watching_card_html = (
        '<div class="watching-card" id="watchingCard" hidden>'
        '<div class="watching-card-eyebrow"><svg viewBox="0 0 24 24" aria-hidden="true">'
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
        ' You\'re watching</div><div class="watching-card-body" id="watchingCardBody"></div></div>'
    )
    # "Project Updates" (pulse-hydrated, showed the LOGGED date) is removed — the
    # dossier "story so far" supersedes it (event-dated + sourced). Empty string so
    # the #ppBelow template + the harmless ppInitUpdates no-op stay intact.
    updates_section_html = ''

    # The living dossier — sourced, event-dated milestone timeline. Server-rendered
    # (not pulse-hydrated) so it shows the real event dates, full history, and
    # never depends on a rolling feed window.
    dossier_html = dossier_section_html(row, articles)

    proj_type_sep = f' · {proj_type}' if proj_type else ''

    # Nearby Projects — up to 3 same-market projects (passed in by main()).
    def _near_card(r):
        nt = (r.get('Title', '') or '').strip()
        if not nt:
            return ''
        ns = slugify(nt)
        nimg = (r.get('ImageURL', '') or '').strip() or DEFAULT_IMAGE
        ncity = (r.get('City', '') or '').strip()
        nstatus = (r.get('Delivery', '') or '').strip()
        ntype = ((r.get('PreferredType', '') or r.get('ProjectType', '') or '').split(',')[0]).strip()
        nmeta = ' · '.join([x for x in [ncity, ntype] if x])
        status_pill = f'<span class="pp-near-status">{_escape_text(nstatus)}</span>' if nstatus else ''
        return (
            f'<a class="pp-near-card" href="/projects/{ns}/">'
            f'<div class="pp-near-img" style="background-image:url(\'{_escape_attr(nimg)}\')">{status_pill}</div>'
            f'<div class="pp-near-b"><div class="pp-near-t">{_escape_text(nt)}</div>'
            f'<div class="pp-near-m">{_escape_text(nmeta)}</div></div></a>'
        )
    nearby_section = ''
    if nearby:
        near_cards = ''.join(_near_card(r) for r in nearby)
        if near_cards.strip():
            nearby_section = (
                f'<div class="pp-sec pp-near"><div class="pp-sec-h">Nearby Projects</div>'
                f'<div class="pp-near-grid">{near_cards}</div></div>'
            )

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- Cache hint: project pages should always reflect the latest sheet data.
       GitHub Pages still has an edge cache (~10min) so changes can lag, but
       this at least keeps browsers + intermediate proxies honest. -->
  <meta http-equiv="Cache-Control" content="no-cache, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <!-- Disable iOS Safari Data Detectors so phone numbers, addresses, dates, etc.
       in body copy aren't auto-linked into tappable blue text -->
  <meta name="format-detection" content="telephone=no, address=no, email=no, date=no">
  <meta name="x-apple-disable-message-reformatting" content="">
  <title>{seo_title}</title>
  <meta name="description" content="{seo_desc}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="{page_url}">
  <!-- Mono face used by the date-driven progress subtitle. Single weight
       loads quickly. Inter (the body family) is loaded later via the
       general <style> block. -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

  <!-- Memberstack 2.0 - for Watch button + watching card hydration. Loads
       async so it doesn't block page render; the hydration script at the
       bottom of the page polls for window.$memberstackDom before wiring up
       the button so initial render works even on slow connections. -->
  <script data-memberstack-app="app_cmoq79nvv002d0syef7wpel3c"
          src="https://static.memberstack.com/scripts/v2/memberstack.js"
          type="text/javascript"></script>

  <!-- Memberstack modal dark theme: tagger script + targeted CSS.
       See index.html for the full rationale. Identical strategy here. -->
  <script>
    (function tagMemberstackModals() {{
      function looksLikeMSModal(el) {{
        if (!el || el.nodeType !== 1) return false;
        try {{
          var cs = window.getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
        }} catch (_) {{ return false; }}
        if (el.querySelector && (
            el.querySelector('[data-ms-modal]') ||
            el.querySelector('[data-cy]') ||
            el.querySelector('[data-ms-form]') ||
            el.id && el.id.toLowerCase().indexOf('ms') === 0
        )) return true;
        var hasEmail = el.querySelector && el.querySelector('input[type="email"]');
        var hasPwd   = el.querySelector && el.querySelector('input[type="password"]');
        if (hasEmail || hasPwd) return true;
        return false;
      }}
      function tagContainerAndChildren(el) {{
        if (!el || !el.classList) return;
        if (!el.classList.contains('tmw-ms-modal')) {{
          el.classList.add('tmw-ms-modal');
        }}
        try {{
          el.querySelectorAll('input, textarea, select').forEach(function(node) {{
            node.classList.add('tmw-ms-input');
          }});
          el.querySelectorAll('button').forEach(function(node) {{
            var isSubmit = node.getAttribute('type') === 'submit';
            var dataCy   = (node.getAttribute('data-cy') || '').toLowerCase();
            var ariaLbl  = (node.getAttribute('aria-label') || '').toLowerCase();
            var txt      = (node.textContent || '').trim().toLowerCase();
            if (isSubmit
                || dataCy.indexOf('save') !== -1
                || dataCy.indexOf('submit') !== -1
                || /^(save|sign in|sign up|log in|create account|continue)$/i.test(txt)) {{
              node.classList.add('tmw-ms-btn-primary');
            }} else if (ariaLbl.indexOf('close') !== -1 || dataCy.indexOf('close') !== -1) {{
              node.classList.add('tmw-ms-btn-close');
            }} else if (ariaLbl.indexOf('password') !== -1) {{
              node.classList.add('tmw-ms-btn-eye');
            }} else {{
              node.classList.add('tmw-ms-btn-secondary');
            }}
          }});
          el.querySelectorAll('label').forEach(function(node) {{
            node.classList.add('tmw-ms-label');
          }});
          el.querySelectorAll('img').forEach(function(node) {{
            node.classList.add('tmw-ms-img');
          }});
        }} catch (_) {{ /* defensive */ }}
      }}
      function scan() {{
        var nodes = document.body ? document.body.children : [];
        for (var i = 0; i < nodes.length; i++) {{
          if (looksLikeMSModal(nodes[i])) tagContainerAndChildren(nodes[i]);
        }}
      }}
      if (document.body) scan();
      else document.addEventListener('DOMContentLoaded', scan);
      var obs = new MutationObserver(function(muts) {{
        for (var i = 0; i < muts.length; i++) {{
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {{
            var node = added[j];
            if (node.nodeType !== 1) continue;
            if (node.parentNode === document.body && looksLikeMSModal(node)) {{
              tagContainerAndChildren(node);
              continue;
            }}
            var modalAncestor = node.closest && node.closest('.tmw-ms-modal');
            if (modalAncestor) {{
              tagContainerAndChildren(modalAncestor);
            }}
          }}
        }}
      }});
      function startObserver() {{
        if (document.body) obs.observe(document.body, {{ childList: true, subtree: true }});
        else document.addEventListener('DOMContentLoaded', startObserver);
      }}
      startObserver();
    }})();
  </script>

  <style>
    .tmw-ms-modal,
    #msOverlay,
    body > div[id^="ms-"] {{
      background: rgba(0,0,0,0.78) !important;
      backdrop-filter: blur(8px) !important;
      -webkit-backdrop-filter: blur(8px) !important;
    }}
    .tmw-ms-modal > div,
    .tmw-ms-modal [role="dialog"],
    #msOverlay > div {{
      background: #0f0f0f !important;
      color: #fff !important;
      border: 1px solid rgba(255,255,255,0.08) !important;
      border-radius: 16px !important;
      box-shadow: 0 30px 90px rgba(0,0,0,0.55) !important;
    }}
    .tmw-ms-modal img,
    #msOverlay img {{
      filter: brightness(0) invert(1) !important;
      opacity: 0.95 !important;
    }}
    .tmw-ms-modal, .tmw-ms-modal *,
    #msOverlay, #msOverlay * {{
      color: #fff !important;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif !important;
    }}
    .tmw-ms-modal h1, .tmw-ms-modal h2, .tmw-ms-modal h3,
    #msOverlay h1, #msOverlay h2, #msOverlay h3 {{
      color: #fff !important;
    }}
    .tmw-ms-modal p, .tmw-ms-modal small,
    #msOverlay p, #msOverlay small {{
      color: rgba(255,255,255,0.7) !important;
    }}
    .tmw-ms-modal label, #msOverlay label {{
      color: #fff !important;
      font-weight: 600 !important;
      font-size: 13px !important;
    }}
    .tmw-ms-modal input,
    .tmw-ms-modal textarea,
    .tmw-ms-modal select,
    #msOverlay input, #msOverlay textarea {{
      background: rgba(255,255,255,0.05) !important;
      border: 1px solid rgba(255,255,255,0.14) !important;
      color: #fff !important;
      border-radius: 10px !important;
      padding: 12px 14px !important;
      font-size: 14px !important;
      box-shadow: none !important;
    }}
    .tmw-ms-modal input:focus,
    #msOverlay input:focus {{
      outline: none !important;
      border-color: #1FDF67 !important;
      background: rgba(255,255,255,0.07) !important;
      box-shadow: 0 0 0 3px rgba(31,223,103,0.20) !important;
    }}
    .tmw-ms-modal input::placeholder,
    #msOverlay input::placeholder {{
      color: rgba(255,255,255,0.35) !important;
      opacity: 1 !important;
    }}
    .tmw-ms-modal input[disabled],
    .tmw-ms-modal input[readonly] {{
      color: rgba(255,255,255,0.6) !important;
      background: rgba(255,255,255,0.03) !important;
    }}
    .tmw-ms-modal button[aria-label*="assword"] {{
      background: transparent !important;
      border: none !important;
      color: rgba(255,255,255,0.55) !important;
      box-shadow: none !important;
      outline: none !important;
    }}
    .tmw-ms-modal button[aria-label*="assword"]:focus {{
      box-shadow: 0 0 0 2px rgba(31,223,103,0.5) !important;
      border-radius: 6px !important;
    }}
    .tmw-ms-modal button[type="submit"],
    .tmw-ms-modal button[class*="primary" i],
    .tmw-ms-modal [data-cy*="save"],
    .tmw-ms-modal [data-cy*="submit"] {{
      background: #1FDF67 !important;
      color: #000 !important;
      border: none !important;
      border-radius: 10px !important;
      font-weight: 700 !important;
      padding: 13px 18px !important;
      cursor: pointer !important;
    }}
    .tmw-ms-modal button[type="submit"]:hover {{
      background: #18c75a !important;
    }}
    .tmw-ms-modal [data-cy="save-btn"],
    .tmw-ms-modal [data-cy="save"] {{
      background: #1FDF67 !important;
      color: #000 !important;
    }}
    .tmw-ms-modal button:not([type="submit"]):not([class*="primary" i]):not([aria-label*="lose" i]):not([aria-label*="assword" i]):not([data-cy*="save"]) {{
      background: rgba(255,255,255,0.06) !important;
      color: #fff !important;
      border: 1px solid rgba(255,255,255,0.10) !important;
      border-radius: 10px !important;
      cursor: pointer !important;
    }}
    .tmw-ms-modal a, #msOverlay a {{
      color: #1FDF67 !important;
      text-decoration: none !important;
      font-weight: 600 !important;
    }}
    .tmw-ms-modal button[aria-label*="lose" i],
    .tmw-ms-modal [data-cy*="close"] {{
      color: rgba(255,255,255,0.5) !important;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
    }}
    .tmw-ms-modal nav button,
    .tmw-ms-modal [class*="sidebar" i] button,
    .tmw-ms-modal [data-cy*="tab"] {{
      color: #fff !important;
      background: transparent !important;
      border: none !important;
      text-align: left !important;
    }}
    .tmw-ms-modal nav button[aria-current="true"],
    .tmw-ms-modal nav button.active,
    .tmw-ms-modal [data-cy*="tab"][aria-current="true"] {{
      background: rgba(31,223,103,0.10) !important;
      color: #1FDF67 !important;
      border-radius: 8px !important;
    }}
    .tmw-ms-modal [data-cy*="logout"],
    .tmw-ms-modal button[aria-label*="ogout" i] {{
      color: rgba(255,255,255,0.7) !important;
      background: transparent !important;
      border: none !important;
    }}
    .tmw-ms-modal [class*="error" i],
    .tmw-ms-modal [role="alert"] {{
      color: #FF6B6B !important;
      background: rgba(255,107,107,0.10) !important;
      border: 1px solid rgba(255,107,107,0.25) !important;
      border-radius: 8px !important;
      padding: 10px 12px !important;
    }}

    /* === Direct per-element classes ====================================
       The tagger script tags inputs/buttons/labels inside any Memberstack
       modal so styling reaches them regardless of how deeply they're nested. */
    .tmw-ms-input {{
      background: #1a1a1a !important;
      border: 1px solid rgba(255,255,255,0.14) !important;
      color: #fff !important;
      border-radius: 10px !important;
      padding: 12px 14px !important;
      font-size: 14px !important;
      box-shadow: none !important;
      caret-color: #1FDF67 !important;
    }}
    .tmw-ms-input:focus {{
      outline: none !important;
      border-color: #1FDF67 !important;
      background: #1f1f1f !important;
      box-shadow: 0 0 0 3px rgba(31,223,103,0.22) !important;
    }}
    .tmw-ms-input::placeholder {{
      color: rgba(255,255,255,0.35) !important;
      opacity: 1 !important;
    }}
    .tmw-ms-input[disabled], .tmw-ms-input[readonly] {{
      color: rgba(255,255,255,0.55) !important;
      background: #141414 !important;
    }}
    .tmw-ms-input:-webkit-autofill,
    .tmw-ms-input:-webkit-autofill:hover,
    .tmw-ms-input:-webkit-autofill:focus {{
      -webkit-text-fill-color: #fff !important;
      -webkit-box-shadow: 0 0 0 1000px #1a1a1a inset !important;
    }}

    .tmw-ms-btn-primary {{
      background: #1FDF67 !important;
      color: #000 !important;
      border: none !important;
      border-radius: 10px !important;
      font-weight: 700 !important;
      padding: 13px 18px !important;
      cursor: pointer !important;
    }}
    .tmw-ms-btn-primary:hover {{ background: #18c75a !important; }}
    .tmw-ms-btn-primary:disabled, .tmw-ms-btn-primary[disabled] {{
      background: rgba(31,223,103,0.35) !important;
      color: rgba(0,0,0,0.55) !important;
      cursor: default !important;
    }}

    .tmw-ms-btn-secondary {{
      background: #1a1a1a !important;
      color: #fff !important;
      border: 1px solid rgba(255,255,255,0.15) !important;
      border-radius: 10px !important;
      padding: 10px 14px !important;
      font-weight: 600 !important;
      font-size: 13px !important;
      cursor: pointer !important;
    }}
    .tmw-ms-btn-secondary:hover {{
      background: #222 !important;
      border-color: rgba(255,255,255,0.25) !important;
    }}

    .tmw-ms-btn-close {{
      color: rgba(255,255,255,0.55) !important;
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      padding: 6px !important;
      cursor: pointer !important;
    }}
    .tmw-ms-btn-close:hover {{ color: #fff !important; }}

    .tmw-ms-btn-eye {{
      background: transparent !important;
      border: none !important;
      color: rgba(255,255,255,0.55) !important;
      box-shadow: none !important;
      outline: none !important;
      padding: 4px !important;
      cursor: pointer !important;
    }}
    .tmw-ms-btn-eye:focus {{
      outline: none !important;
      box-shadow: 0 0 0 2px rgba(31,223,103,0.5) !important;
      border-radius: 6px !important;
    }}

    .tmw-ms-label {{
      color: #fff !important;
      font-weight: 600 !important;
      font-size: 13px !important;
    }}

    .tmw-ms-img {{
      filter: brightness(0) invert(1) !important;
      opacity: 0.95 !important;
    }}
  </style>

  <!-- Open Graph -->
  <meta property="og:site_name" content="Markets of Tomorrow">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{seo_title}">
  <meta property="og:description" content="{seo_desc}">
  <meta property="og:image" content="{image}">
  <meta property="og:url" content="{page_url}">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@floridaoftomorrow">
  <meta name="twitter:title" content="{seo_title}">
  <meta name="twitter:description" content="{seo_desc}">
  <meta name="twitter:image" content="{image}">

  <!-- Favicon -->
  <link rel="icon" href="{LOGO_URL}" type="image/png">

  <!-- JSON-LD -->
  <script type="application/ld+json">{jsonld}</script>

  <style>
    /* Design tokens the shared chrome (header/dock/auth) expects. */
    :root {{
      --ink: #070807; --ink-2: #0d0f0e;
      --hair: rgba(255,255,255,.08); --hair-2: rgba(255,255,255,.14);
      --white: #fff; --cream: #ECEAE5; --mute: #9AA39C; --mute-2: #C2C9C3;
      --green: #1FDF67; --gold: #e6c574; --gold-soft: #f0d68a;
      --mono: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }}
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    html {{ overflow-x: hidden; }}
    body {{ background: #0d0d0d; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; overflow-x: hidden; max-width: 100%; }}
    /* Belt-and-suspenders defense against iOS Safari Data Detectors:
       even when the format-detection meta tag is set, iOS sometimes still auto-links
       addresses/phones/dates inside body copy. Neutralize any that slip through. */
    .description a[href^="tel:"], .description a[href^="mailto:"], .description a[x-apple-data-detectors] {{
      color: inherit !important;
      text-decoration: inherit !important;
      pointer-events: none !important;
      cursor: text !important;
    }}

    /* Gallery */
    .gallery {{ width: 100%; position: relative; overflow: hidden; }}
    .gallery-hero {{ width: 100%; height: 320px; object-fit: cover; display: block; }}

    /* Slider — multi-image cycling gallery
       Desktop: center slide at 60% width with prev/next visible at lower opacity.
       Hidden slides park at the peek positions (just at opacity 0) so when they
       transition into prev/next state only opacity animates — no horizontal flash.
       Mobile: full-width single-slide fade. */
    .gs-slider {{
      height: 460px;
      background: #0d0d0d;
      padding: 24px 0;
      box-sizing: content-box;
      overflow: hidden;
    }}
    .gs-track {{ position: relative; width: 100%; height: 100%; }}
    .gs-slide {{
      position: absolute;
      top: 0;
      height: 100%;
      width: 60%;
      object-fit: cover;
      border-radius: 12px;
      transition: left 0.4s ease, opacity 0.4s ease;
      pointer-events: none;
      box-shadow: 0 8px 30px rgba(0,0,0,0.5);
      /* Default: parked off-screen right at opacity 0 (used until JS assigns data-pos) */
      left: 105%;
      opacity: 0;
    }}
    .gs-slide[data-pos="active"] {{
      left: 20%;
      opacity: 1;
      pointer-events: auto;
      z-index: 3;
    }}
    .gs-slide[data-pos="prev"] {{
      left: -42%;
      opacity: 0.55;
      z-index: 1;
    }}
    .gs-slide[data-pos="next"] {{
      left: 82%;
      opacity: 0.55;
      z-index: 1;
    }}
    /* Hidden slides park at the peek positions but invisible, so when they
       transition into prev/next state only opacity changes (no horizontal flash). */
    .gs-slide[data-pos="hidden-left"] {{
      left: -42%;
      opacity: 0;
      z-index: 0;
    }}
    .gs-slide[data-pos="hidden-right"] {{
      left: 82%;
      opacity: 0;
      z-index: 0;
    }}
    .gs-arrow {{
      position: absolute;
      top: 50%; transform: translateY(-50%);
      width: 38px; height: 38px;
      border-radius: 50%;
      background: rgba(255,255,255,0.92);
      border: none;
      color: #000;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
      transition: background 0.15s, transform 0.1s;
      z-index: 3;
    }}
    .gs-arrow:hover {{ background: #fff; }}
    .gs-arrow:active {{ transform: translateY(-50%) scale(0.94); }}
    .gs-arrow svg {{ width: 18px; height: 18px; }}
    .gs-prev {{ left: 14%; transform: translate(-50%, -50%); }}
    .gs-prev:active {{ transform: translate(-50%, -50%) scale(0.94); }}
    .gs-next {{ right: 14%; transform: translate(50%, -50%); }}
    .gs-next:active {{ transform: translate(50%, -50%) scale(0.94); }}
    .gs-counter {{
      position: absolute;
      bottom: 38px; left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.7);
      color: rgba(255,255,255,0.95);
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 20px;
      z-index: 3;
      letter-spacing: 0.02em;
    }}

    /* Content */
    .content {{ max-width: 560px; margin: 0 auto; padding: 20px 20px 40px; }}

    /* Pills */
    .pills {{ display: flex; gap: 6px; margin-bottom: 12px; }}
    .pill {{ font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 9px; border-radius: 20px; }}
    .pill-featured {{ background: #FFD300; color: #000; }}

    /* Title */
    .project-title {{ font-size: 28px; font-weight: 700; line-height: 1.15; margin-bottom: 4px; }}
    .project-city {{ font-size: 13px; color: rgba(255,255,255,0.45); margin-bottom: 16px; }}

    /* Progress */
    /* ── Gradient Meter timeline (purple → green; green only at completion).
       Shared verbatim with tmw-project-intel.js renderTimeline and the map
       modal's buildProgress() so every surface reads as one system. ── */
    .pm-tl {{ margin-bottom: 16px; }}
    .pm-tl-date {{ text-align: right; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.5); margin-bottom: 8px; }}
    .pm-tl-meter {{ position: relative; height: 11px; border-radius: 999px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,0.55); }}
    .pm-tl-grad {{ position: absolute; inset: 0; background: linear-gradient(90deg, #3a2f6b, #7C5CE0 38%, #A78BFA 64%, #1FDF67); }}
    .pm-tl-grad::after {{ content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent); background-size: 200% 100%; animation: pmtlShine 2.6s linear infinite; mix-blend-mode: overlay; }}
    @keyframes pmtlShine {{ 0% {{ background-position: 200% 0; }} 100% {{ background-position: -60% 0; }} }}
    @media (prefers-reduced-motion: reduce) {{ .pm-tl-grad::after {{ animation: none; }} }}
    .pm-tl-empty {{ position: absolute; top: 0; bottom: 0; right: 0; background: #0d0f0e; box-shadow: inset 2px 0 3px rgba(0,0,0,0.6); }}
    .pm-tl-knob {{ position: absolute; top: 50%; transform: translate(-50%,-50%); background: #fff; color: #0a0a0a; font-size: 9.5px; font-weight: 800; padding: 4px 9px; border-radius: 999px; white-space: nowrap; z-index: 2; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; box-shadow: 0 2px 6px rgba(0,0,0,.5); }}
    .pm-tl-stages {{ display: flex; gap: 3px; margin-top: 12px; }}
    .pm-tl-stage {{ flex: 1; font-size: 7.5px; letter-spacing: 0.02em; text-transform: uppercase; color: rgba(255,255,255,0.2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }}
    .pm-tl-stage:first-child {{ text-align: left; }}
    .pm-tl-stage:last-child {{ text-align: right; }}
    .pm-tl-stage.done {{ color: rgba(255,255,255,0.5); }}

    /* Divider */
    .divider {{ height: 0.5px; background: rgba(255,255,255,0.07); margin: 16px 0; }}

    /* Description */
    .description {{ font-size: 14px; color: rgba(255,255,255,0.6); line-height: 1.7; margin-bottom: 16px; }}

    /* Stats */
    .stats-grid {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin-bottom: 20px; align-items: stretch; }}
    .stat-card {{ background: rgba(255,255,255,0.04); border-radius: 8px; padding: 10px 12px; min-width: 0; display: flex; flex-direction: column; }}
    .stat-label {{ font-size: 8px; color: rgba(255,255,255,0.28); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }}
    .stat-val {{ font-size: 13px; color: #fff; font-weight: 500; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto; }}

    /* CTA */
    .cta-row {{ display: flex; gap: 10px; align-items: stretch; margin-bottom: 16px; }}
    .btn-primary {{ flex: 1; background: #1FDF67; color: #000; border: none; border-radius: 10px; padding: 13px 16px; font-size: 14px; font-weight: 700; cursor: pointer; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 6px; }}
    .btn-primary:hover {{ background: #18c75a; }}
    .btn-disabled {{ background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.3); cursor: default; }}

    /* Primary CTA — gold-glow "Dive Deeper" → opens this project on the map */
    .btn-dive {{
      flex: 0 1 auto;
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      background: linear-gradient(135deg, #f3dc93, #e3bf63);
      color: #1c1606; border: none; border-radius: 11px;
      padding: 14px 24px; font-size: 14px; font-weight: 800; letter-spacing: 0.01em;
      text-decoration: none; cursor: pointer;
      box-shadow: 0 0 0 1px rgba(230,197,116,0.45), 0 6px 22px rgba(230,197,116,0.34), 0 0 34px rgba(230,197,116,0.26);
      animation: diveGlow 3.2s ease-in-out infinite;
      transition: box-shadow 0.2s, transform 0.12s;
    }}
    .btn-dive:hover {{ transform: translateY(-1px); animation: none;
      box-shadow: 0 0 0 1px rgba(243,220,147,0.75), 0 8px 28px rgba(230,197,116,0.5), 0 0 48px rgba(230,197,116,0.45); }}
    .btn-dive:active {{ transform: translateY(0); }}
    .btn-dive svg {{ width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }}
    @keyframes diveGlow {{
      0%, 100% {{ box-shadow: 0 0 0 1px rgba(230,197,116,0.45), 0 6px 22px rgba(230,197,116,0.30), 0 0 30px rgba(230,197,116,0.22); }}
      50%      {{ box-shadow: 0 0 0 1px rgba(243,220,147,0.6), 0 6px 24px rgba(230,197,116,0.45), 0 0 44px rgba(230,197,116,0.4); }}
    }}
    @media (prefers-reduced-motion: reduce) {{ .btn-dive {{ animation: none; }} }}

    /* Subtle "Official Website" text link below the description — no bg, white,
       white arrow, far less prominent than the gold CTA */
    .btn-website {{
      display: inline-flex; align-items: center; gap: 6px;
      margin: 14px 0 4px; color: #fff; opacity: 0.82;
      font-size: 13px; font-weight: 500; text-decoration: none;
      transition: opacity 0.15s, gap 0.15s;
    }}
    .btn-website:hover {{ opacity: 1; gap: 9px; }}
    .btn-website svg {{ width: 13px; height: 13px; stroke: #fff; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }}

    /* Watch button (Phase 4) - hydrated client-side by Memberstack script.
       Default state is the same dark "Watch" pill as the modal; .watching
       turns it green-tinted; .has-unread shows a pulsing green dot. Mobile
       collapses to icon-only to keep the cta-row tidy. */
    .btn-watch {{
      flex: 0 0 auto;
      display: inline-flex; align-items: center; justify-content: center;
      gap: 6px;
      height: 50px;
      padding: 0 14px;
      background: rgba(255,255,255,0.06);
      border: 0.5px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      color: rgba(255,255,255,0.85);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      line-height: 1;
      position: relative;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }}
    .btn-watch:hover {{ background: rgba(255,255,255,0.10); color: #fff; }}
    .btn-watch svg {{ width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 1.8; flex-shrink: 0; }}
    .btn-watch.watching {{
      background: rgba(31,223,103,0.12);
      border-color: rgba(31,223,103,0.4);
      color: #1FDF67;
    }}
    .btn-watch.watching:hover {{ background: rgba(31,223,103,0.18); }}
    .btn-watch-dot {{
      display: none;
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #1FDF67;
      margin-left: 2px;
      box-shadow: 0 0 8px rgba(31,223,103,0.8);
      animation: pulseDot 1.6s ease-in-out infinite;
    }}
    .btn-watch.watching.has-unread .btn-watch-dot {{ display: inline-block; }}
    @media (max-width: 480px) {{
      .btn-watch {{ width: 50px; padding: 0; gap: 0; }}
      .btn-watch-label {{ display: none; }}
      .btn-watch-dot {{
        position: absolute;
        top: 8px; right: 8px;
        margin: 0;
      }}
    }}
    @keyframes pulseDot {{
      0%, 100% {{ transform: scale(1);    opacity: 1;   }}
      50%      {{ transform: scale(1.25); opacity: 0.7; }}
    }}

    /* "You're watching" summary card */
    .watching-card[hidden] {{ display: none; }}
    .watching-card {{
      margin: 0 0 16px;
      padding: 12px 14px;
      background: rgba(31,223,103,0.08);
      border: 1px solid rgba(31,223,103,0.25);
      border-radius: 10px;
    }}
    .watching-card-eyebrow {{
      display: flex; align-items: center; gap: 6px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #1FDF67;
      margin-bottom: 4px;
    }}
    .watching-card-eyebrow svg {{
      width: 12px; height: 12px;
      stroke: currentColor; fill: none; stroke-width: 2;
    }}
    .watching-card-body {{
      font-size: 13px;
      line-height: 1.4;
      color: rgba(255,255,255,0.85);
    }}
    .watching-card-body strong {{
      color: #fff;
      font-weight: 700;
    }}
    /* Share button — square, gray pill matching map-preview CTA aesthetic */
    .btn-share {{
      flex: 0 0 auto;
      width: 50px;
      background: rgba(255,255,255,0.07);
      border: 0.5px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      color: rgba(255,255,255,0.85);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s, color 0.15s;
      position: relative;
      padding: 0;
    }}
    .btn-share:hover {{ background: rgba(255,255,255,0.14); color: #fff; }}
    .btn-share:active {{ transform: scale(0.97); }}
    .btn-share svg {{ opacity: 0.85; }}
    /* "Link copied" tooltip — fades in for 1.5s after a desktop fallback copy */
    .btn-share-tooltip {{
      position: absolute;
      bottom: calc(100% + 6px); right: 0;
      background: rgba(0,0,0,0.85);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 9px;
      border-radius: 6px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s;
    }}
    .btn-share.copied .btn-share-tooltip {{ opacity: 1; }}

    /* Mini map preview — clickable Mapbox static image with overlay CTA */
    .map-preview {{
      display: block;
      position: relative;
      width: 100%;
      height: 180px;
      border-radius: 12px;
      overflow: hidden;
      text-decoration: none;
      margin-bottom: 16px;
      background: #1a1a1a;
      transition: transform 0.15s, box-shadow 0.15s;
    }}
    .map-preview:hover {{ transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0,0,0,0.4); }}
    .map-preview img {{
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }}
    .map-preview-overlay {{
      position: absolute; inset: 0;
      background: linear-gradient(to bottom, rgba(0,0,0,0) 50%, rgba(0,0,0,0.7) 100%);
      display: flex; align-items: flex-end; justify-content: center;
      padding: 14px;
    }}
    .map-preview-cta {{
      display: flex; align-items: center; gap: 7px;
      background: rgba(255,255,255,0.07);
      border: 0.5px solid rgba(255,255,255,0.15);
      color: rgba(255,255,255,0.9);
      padding: 10px 16px;
      border-radius: 22px;
      font-size: 13px; font-weight: 500;
      box-shadow: 0 2px 10px rgba(0,0,0,0.4);
      transition: background 0.15s;
    }}
    .map-preview-cta svg {{ opacity: 0.7; }}
    .map-preview:hover .map-preview-cta {{ background: rgba(255,255,255,0.14); }}

    /* Site header is hidden across all viewports — brand lives in the footer logo */
    .site-header {{ display: none !important; }}

    /* Footer logo — centered Markets of Tomorrow wordmark below content (all viewports) */
    .footer-logo {{
      display: block;
      padding: 40px 20px 48px;
      text-align: center;
    }}
    .footer-logo a {{
      display: inline-block;
      transition: opacity 0.2s;
    }}
    .footer-logo a:hover {{ opacity: 0.8; }}
    .footer-logo img {{
      height: 56px;
      width: auto;
      filter: brightness(0) invert(1);
      opacity: 0.9;
    }}

    @media (max-width: 480px) {{
      /* Mobile keeps a slightly smaller footer logo */
      .footer-logo img {{ height: 48px; }}
      /* Gallery taller on mobile since header reclaim is freed up */
      .gallery-hero {{ height: 280px; }}
      /* Mobile slider: revert to full-width single-image fade (no desktop peek) */
      .gs-slider {{ height: 280px; padding: 0; }}
      .gs-slide {{ border-radius: 0; box-shadow: none; width: 100%; left: 0; }}
      .gs-slide[data-pos="active"] {{ left: 0; width: 100%; transform: none; opacity: 1; }}
      .gs-slide[data-pos="prev"],
      .gs-slide[data-pos="next"],
      .gs-slide[data-pos="hidden-left"],
      .gs-slide[data-pos="hidden-right"] {{
        left: 0; width: 100%; opacity: 0; transform: none; filter: none; pointer-events: none;
      }}
      .gs-arrow {{ width: 34px; height: 34px; }}
      .gs-prev {{ left: 10px; transform: translateY(-50%); }}
      .gs-prev:active {{ transform: translateY(-50%) scale(0.94); }}
      .gs-next {{ right: 10px; transform: translateY(-50%); }}
      .gs-next:active {{ transform: translateY(-50%) scale(0.94); }}
      .gs-counter {{ bottom: 14px; left: auto; right: 14px; transform: none; }}
      .project-title {{ font-size: 24px; }}
      .stats-grid {{ grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }}
      .map-preview {{ height: 180px; }}
    }}

    /* ── Living dossier: sourced, event-dated milestone timeline ── */
    .pp-dossier .pp-sec-h {{ color: var(--purple-soft, #B9A6FF); }}
    .dos-tl {{ position: relative; margin-top: 4px; }}
    .dos-row {{ position: relative; display: flex; gap: 14px; padding: 11px 0 13px 2px; }}
    .dos-row:not(:last-child)::before {{ content: ""; position: absolute; left: 7px; top: 19px; bottom: -7px; width: 1px; background: rgba(255,255,255,.13); }}
    .dos-dot {{ position: relative; z-index: 1; flex: 0 0 auto; width: 11px; height: 11px; border-radius: 50%; margin-top: 4px; box-sizing: border-box; }}
    .dos-past {{ background: #1FDF67; }}
    .dos-now {{ background: #A78BFA; box-shadow: 0 0 0 4px rgba(167,139,250,.18); }}
    .dos-future {{ background: transparent; border: 1.5px solid rgba(255,255,255,.30); }}
    .dos-body {{ flex: 1; min-width: 0; }}
    .dos-line {{ display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }}
    .dos-label {{ font-size: 14.5px; font-weight: 600; color: #fff; }}
    .dos-row-future .dos-label {{ color: rgba(255,255,255,.58); font-weight: 500; }}
    .dos-date {{ font-size: 12px; color: rgba(255,255,255,.6); font-variant-numeric: tabular-nums; }}
    .dos-date.dos-tbd {{ color: rgba(255,255,255,.35); }}
    .dos-est {{ font-size: 9.5px; color: rgba(255,255,255,.4); margin-left: 5px; text-transform: uppercase; letter-spacing: .05em; }}
    .dos-info {{ position: relative; display: inline-flex; align-items: center; margin-left: 7px; color: rgba(255,255,255,.34); cursor: help; vertical-align: middle; }}
    .dos-info:hover, .dos-info:focus {{ color: rgba(255,255,255,.72); outline: none; }}
    .dos-info > svg {{ width: 13px; height: 13px; display: block; }}
    .dos-tip {{ position: absolute; left: 0; bottom: calc(100% + 8px); width: max-content; max-width: 260px; background: #15110f; border: 1px solid rgba(255,255,255,.14); color: #ECEAE5; font-size: 12px; line-height: 1.45; padding: 8px 11px; border-radius: 9px; box-shadow: 0 14px 38px -12px rgba(0,0,0,.85); opacity: 0; visibility: hidden; transition: opacity .14s; z-index: 30; pointer-events: none; white-space: normal; font-weight: 400; }}
    .dos-info:hover .dos-tip, .dos-info:focus .dos-tip {{ opacity: 1; visibility: visible; }}
    .dos-src {{ display: inline-flex; align-items: center; gap: 3px; margin-top: 4px; font-size: 11px; color: #42EB81; text-decoration: none; }}
    .dos-src .dos-arr {{ flex: none; }}
    .dos-src:hover {{ text-decoration: underline; }}
    .dos-note {{ margin-top: 13px; font-size: 11px; color: rgba(255,255,255,.42); line-height: 1.55; }}

    /* ── Coverage on TMW: list of articles mentioning this project ── */
    .coverage-section {{ margin-top: 28px; padding-top: 22px; border-top: 1px solid rgba(255,255,255,0.08); }}
    .cv-header {{ display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }}
    .cv-title {{ font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; color: #fff; margin: 0; display: flex; align-items: center; gap: 8px; }}
    .cv-count {{ font-size: 10px; background: rgba(31,223,103,0.12); color: #1FDF67; padding: 2px 7px; border-radius: 10px; font-weight: 700; letter-spacing: 0.04em; }}
    .cv-featured {{ display: block; background: #000; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; overflow: hidden; text-decoration: none; color: inherit; margin-bottom: 12px; transition: border-color 0.15s; }}
    .cv-featured:hover {{ border-color: rgba(31,223,103,0.3); }}
    .cv-featured-img {{ width: 100%; height: 160px; background-size: cover; background-position: center; background-color: #000; position: relative; }}
    .cv-featured-tag {{ position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); color: #1FDF67; padding: 3px 8px; border-radius: 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }}
    .cv-featured-body {{ padding: 14px 16px 16px; }}
    .cv-featured-title {{ font-size: 15px; font-weight: 600; line-height: 1.35; margin-bottom: 6px; color: #fff; }}
    .cv-meta {{ font-size: 11px; color: rgba(255,255,255,0.4); }}
    .cv-list {{ display: flex; flex-direction: column; gap: 1px; background: rgba(255,255,255,0.06); border-radius: 12px; overflow: hidden; border: 1px solid rgba(255,255,255,0.08); }}
    .cv-row {{ background: #000; padding: 12px 14px; display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; transition: background 0.15s; }}
    .cv-row:hover {{ background: #0a0a0a; }}
    .cv-thumb {{ width: 56px; height: 56px; flex-shrink: 0; background-size: cover; background-position: center; background-color: #000; border-radius: 8px; }}
    .cv-row-body {{ flex: 1; min-width: 0; }}
    .cv-row-title {{ font-size: 13px; font-weight: 600; line-height: 1.35; margin-bottom: 3px; color: #fff; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }}
    .cv-row-meta {{ font-size: 11px; color: rgba(255,255,255,0.4); }}
    .cv-row-arrow {{ color: rgba(255,255,255,0.4); flex-shrink: 0; }}
    .cv-row-arrow svg {{ stroke: currentColor; fill: none; }}
    .cv-view-all {{ display: flex; align-items: center; justify-content: center; gap: 6px; padding: 12px; margin-top: 12px; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; font-size: 12px; color: rgba(255,255,255,0.55); font-weight: 600; text-decoration: none; transition: color 0.15s, border-color 0.15s; }}
    .cv-view-all:hover {{ color: #fff; border-color: rgba(255,255,255,0.18); }}
    .cv-view-all svg {{ stroke: currentColor; fill: none; }}

    /* ============ Cinematic project layout ============ */
    .pp {{ position: relative; }}
    .pp-hero {{ position: relative; min-height: calc(100svh - 56px); display: flex; align-items: flex-end; overflow: hidden; }}
    .pp-bg {{ position: absolute; inset: 0; background-size: cover; background-position: center; transition: opacity .55s ease, transform 7s ease; will-change: opacity, transform; }}
    .pp-hero::after {{ content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none; background: linear-gradient(180deg, rgba(7,8,7,.30), rgba(7,8,7,.12) 30%, rgba(7,8,7,.60) 64%, rgba(13,13,13,.98)); }}
    .pp-hero-inner {{ position: relative; z-index: 3; max-width: 1240px; margin: 0 auto; width: 100%; padding: 0 64px 54px; display: grid; grid-template-columns: 1.5fr 1fr; gap: 42px; align-items: end; transition: transform .34s ease, opacity .34s ease; will-change: transform, opacity; }}
    .pp-eyebrow {{ display: inline-flex; align-items: center; gap: 8px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #f0d68a; border: 1px solid rgba(230,197,116,.32); border-radius: 999px; padding: 5px 12px; background: rgba(0,0,0,.28); }}
    .pp-eyebrow .d {{ width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }}
    .pp-h1 {{ font-size: 60px; font-weight: 800; letter-spacing: -.03em; line-height: 1.0; margin-top: 14px; text-shadow: 0 2px 40px rgba(0,0,0,.55); }}
    .pp-loc {{ font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: rgba(255,255,255,.62); margin-top: 12px; }}
    .pp-lede {{ font-size: 14.5px; color: rgba(255,255,255,.84); line-height: 1.62; margin-top: 16px; max-width: 60ch; }}
    .pp-hero .cta-row {{ max-width: 440px; margin-top: 22px; margin-bottom: 0; }}
    .pp-hero .btn-primary {{ flex: 0 1 auto; padding: 13px 20px; }}
    .pp-panel {{ background: rgba(15,17,16,.60); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px); border: 1px solid rgba(255,255,255,.14); border-radius: 18px; padding: 20px 22px; box-shadow: 0 30px 80px -30px rgba(0,0,0,.9); }}
    .pp-panel .pm-tl {{ margin-bottom: 0; }}
    /* "Last verified" row above the timeline + the spinning TMW hexagon. */
    .pp-updated {{ display: flex; align-items: center; gap: 7px; margin-bottom: 14px; font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: rgba(255,255,255,.42); font-family: 'JetBrains Mono', ui-monospace, monospace; }}
    .pp-updated .tmw-upd-ico {{ width: 15px; height: 15px; flex: none; }}
    .pp-updated .tmw-upd-ico svg {{ width: 100%; height: 100%; display: block; overflow: visible; }}
    .tmw-upd-spin {{ transform-origin: 50% 50%; animation: tmwUpdSpin 4.2s cubic-bezier(.16,1,.3,1) infinite; }}
    @keyframes tmwUpdSpin {{ 0% {{ transform: rotate(0deg); }} 55% {{ transform: rotate(810deg); }} 70% {{ transform: rotate(900deg); }} 100% {{ transform: rotate(1080deg); }} }}
    .tmw-upd-core {{ transform-origin: 50% 50%; animation: tmwUpdPulse 4.2s ease-in-out infinite; }}
    @keyframes tmwUpdPulse {{ 0%,45% {{ stroke: #A78BFA; filter: drop-shadow(0 0 0 rgba(167,139,250,0)); }} 70% {{ stroke: #B9A6FF; filter: drop-shadow(0 0 8px rgba(185,166,255,.9)); }} 100% {{ stroke: #A78BFA; filter: drop-shadow(0 0 0 rgba(167,139,250,0)); }} }}
    .tmw-upd-ring {{ transform-origin: 50% 50%; animation: tmwUpdRing 4.2s ease-out infinite; }}
    @keyframes tmwUpdRing {{ 0%,60% {{ transform: scale(1); opacity: 0; }} 72% {{ opacity: .55; }} 100% {{ transform: scale(1.7); opacity: 0; }} }}
    @media (prefers-reduced-motion: reduce) {{
      .tmw-upd-spin, .tmw-upd-core, .tmw-upd-ring {{ animation: none; }}
      .tmw-upd-ring {{ opacity: 0; }}
    }}
    .pp-minis {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-top: 16px; }}
    .pp-mini {{ padding: 10px 11px; background: rgba(0,0,0,.30); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; min-width: 0; overflow: hidden; }}
    .pp-mini .v {{ font-size: 15px; font-weight: 800; letter-spacing: -.02em; white-space: nowrap; }}
    .pp-mini .k {{ font-size: 8px; letter-spacing: .07em; text-transform: uppercase; color: rgba(255,255,255,.4); margin-top: 5px; white-space: nowrap; }}
    /* Narrow phones: shrink the fact tiles a touch so the full date fits in a
       quarter-column instead of overflowing the row (which caused the page to
       scroll sideways). */
    @media (max-width: 480px) {{
      .pp-mini {{ padding: 9px 7px; }}
      .pp-mini .v {{ font-size: 12.5px; letter-spacing: -.03em; }}
    }}

    /* gallery cluster (this project's photos) */
    .pp-gal {{ position: absolute; z-index: 6; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 13px; background: rgba(0,0,0,.42); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.1); border-radius: 999px; padding: 7px 10px; }}
    .pp-gal button {{ width: 30px; height: 30px; border-radius: 50%; border: 1px solid rgba(255,255,255,.18); background: rgba(0,0,0,.35); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: .15s; padding: 0; }}
    .pp-gal button:hover {{ background: #fff; color: #000; }}
    .pp-gal button svg {{ width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }}
    .pp-gal-dots {{ display: flex; gap: 6px; align-items: center; }}
    .pp-gal-dots i {{ width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,.4); transition: .2s; cursor: pointer; }}
    .pp-gal-dots i.on {{ background: #fff; width: 20px; border-radius: 3px; }}
    .pp-gal-cnt {{ font-size: 10px; letter-spacing: .06em; color: rgba(255,255,255,.7); font-variant-numeric: tabular-nums; min-width: 30px; text-align: center; }}

    .pp-scrollcue {{ position: absolute; z-index: 5; left: 50%; bottom: 72px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 5px; font-size: 8.5px; letter-spacing: .18em; text-transform: uppercase; color: rgba(255,255,255,.4); animation: ppbob 1.8s ease-in-out infinite; pointer-events: none; }}
    .pp-scrollcue svg {{ width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; }}
    @keyframes ppbob {{ 0%, 100% {{ transform: translate(-50%, 0); }} 50% {{ transform: translate(-50%, 5px); }} }}
    @media (prefers-reduced-motion: reduce) {{ .pp-scrollcue {{ animation: none; }} }}

    /* below-the-fold */
    .pp-below {{ max-width: 620px; margin: 0 auto; padding: 50px 20px 70px; transition: opacity .34s ease; }}
    .pp-sec {{ margin-top: 30px; }}
    .pp-sec:first-child {{ margin-top: 0; }}
    .pp-sec-h {{ font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #fff; font-weight: 800; margin-bottom: 14px; display: flex; align-items: center; gap: 9px; }}
    .pp-about {{ font-size: 15px; color: rgba(255,255,255,.66); line-height: 1.75; }}
    .pp-firms {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }}
    .pp-firm {{ background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 14px 16px; text-decoration: none; color: inherit; display: block; transition: border-color .15s; }}
    .pp-firm:hover {{ border-color: rgba(31,223,103,.35); }}
    .pp-firm .k {{ font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.4); }}
    .pp-firm .v {{ font-size: 15px; font-weight: 600; margin-top: 5px; color: #fff; }}
    .pp-firm .go {{ font-size: 11px; color: #1FDF67; margin-top: 7px; display: inline-block; }}
    @media (max-width: 540px) {{ .pp-firms {{ grid-template-columns: 1fr; }} }}

    /* Nearby Projects — 3 same-market cards (like the article "read more" rail) */
    .pp-near-grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }}
    .pp-near-card {{ background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; overflow: hidden; text-decoration: none; color: inherit; transition: border-color .15s, transform .15s; }}
    .pp-near-card:hover {{ border-color: rgba(31,223,103,.35); transform: translateY(-2px); }}
    .pp-near-img {{ aspect-ratio: 16/10; background-size: cover; background-position: center; background-color: #111; position: relative; }}
    .pp-near-status {{ position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,.6); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); color: #fff; font-size: 8.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 3px 7px; border-radius: 5px; }}
    .pp-near-b {{ padding: 11px 12px 13px; }}
    .pp-near-t {{ font-size: 13.5px; font-weight: 600; line-height: 1.3; color: #fff; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }}
    .pp-near-m {{ font-size: 11px; color: rgba(255,255,255,.45); margin-top: 4px; }}

    @media (max-width: 860px) {{
      /* MOBILE HERO REFLOW — only phase + title + location overlap the image;
         the gallery scroller, description and everything else push down below. */
      .pp-hero {{ min-height: 0; display: block; position: relative; }}
      /* Image occupies the top of the hero only */
      .pp-bg {{ inset: auto; top: 0; left: 0; right: 0; height: 58vh; will-change: auto; }}
      /* Gradient is TALLER than the image so it also covers the ken-burns
         scale(1.06) overflow, and fades into the page colour (#0d0d0d) so there's
         no bright sliver of photo between the image and the content below it. */
      .pp-hero::after {{ inset: auto; top: 0; left: 0; right: 0; height: 61vh; z-index: 1;
        background: linear-gradient(180deg, rgba(13,13,13,.12), rgba(13,13,13,0) 24%, rgba(13,13,13,.5) 54%, rgba(13,13,13,.9) 80%, #0d0d0d 99%); }}
      /* keep a stacking context (like desktop) so hero text composites cleanly
         ABOVE the image layer — without this the white title renders see-through
         over the GPU-promoted background. The padding-top reserves the image
         height so the gallery + description flow BELOW the photo with breathing room. */
      .pp-hero-inner {{ position: relative; z-index: 3; display: block; padding: calc(58vh + 26px) 20px 0; }}
      .pp-hero-main {{ display: block; }}
      /* phase + title + location pinned to the bottom edge of the image */
      .pp-hero-head {{ position: absolute; left: 20px; right: 20px; top: 58vh; transform: translateY(-100%); z-index: 2; }}
      .pp-h1 {{ font-size: 38px; text-shadow: 0 2px 10px rgba(0,0,0,.8), 0 1px 3px rgba(0,0,0,.75); }}
      .pp-loc {{ text-shadow: 0 1px 6px rgba(0,0,0,.75); }}
      /* gallery scroller sits just under the image, before the description */
      .pp-gal {{ position: static; transform: none; left: auto; bottom: auto; margin: 0 auto 20px; width: max-content; }}
      .pp-lede {{ max-width: none; margin-top: 0; }}
      .pp-hero .cta-row {{ max-width: none; }}
      .pp-panel {{ margin-top: 18px; }}
      .pp-scrollcue {{ display: none; }}
      /* Nearby: horizontal scroll-snap rail on phones */
      .pp-near-grid {{ display: flex; overflow-x: auto; gap: 10px; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; padding-bottom: 4px; margin: 0 -20px; padding-left: 20px; padding-right: 20px; }}
      .pp-near-grid::-webkit-scrollbar {{ display: none; }}
      .pp-near-card {{ flex: 0 0 78%; scroll-snap-align: start; }}
    }}
  </style>
</head>
<body>

  <!-- ════ Cinematic project page ════
       #pp carries the per-page data the gallery needs (data-slug + the gallery
       image list). Everything is server-rendered for SEO; project-shuffle.js
       only drives the photo gallery (the hero background).

       DOM order is the MOBILE order (phase/title/location, then the gallery
       scroller, then description, then the rest). On desktop CSS lifts the head
       group + gallery + panel into the bottom overlay grid. -->
  <main class="pp" id="pp" data-slug="{slug}" data-images="{images_attr}">
    <section class="pp-hero" id="ppHero">
      <div class="pp-bg" data-l="0" style="background-image:url('{hero_bg0}')"></div>
      <div class="pp-bg" data-l="1" style="opacity:0"></div>

      <div class="pp-hero-inner" id="ppHeroInner">
        <div class="pp-hero-main">
          <div class="pp-hero-head">
            {eyebrow_html}
            <h1 class="pp-h1">{title}</h1>
            <div class="pp-loc">{city}{proj_type_sep}</div>
          </div>
          {gallery_cluster}
          <!-- Bio FIRST in the DOM (after the head) so search engines build the
               snippet from the project description, not the timeline labels. -->
          <p class="pp-lede description">{lede}</p>
          {website_subtle}
          <div class="cta-row">{dive_btn}{share_btn}{watch_btn}</div>
        </div>
        <div class="pp-panel">
          {updated_html}
          {progress_bar_html(delivery, delivery_date, start_date)}
          {minis_html}
        </div>
      </div>

      <div class="pp-scrollcue">Scroll for details<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></div>
    </section>

    <div class="pp-below" id="ppBelow">
      {watching_card_html}
      {dossier_html}
      {about_section}
      {firms_section}
      <div class="pp-sec"><div class="pp-sec-h">Location</div>{map_preview_html(lat, lng, map_url)}</div>
      {updates_section_html}
      {coverage_section_html(articles or [], title, image)}
      {nearby_section}
    </div>
  </main>

  <!-- Footer is injected by the shared chrome (journal-chrome.js) below. -->

  <script>
    // Share button — uses Web Share API on mobile/supported browsers,
    // falls back to copying the page URL to the clipboard with a "Link copied" tooltip.
    window.shareProject = function(btn) {{
      const url = window.location.href;
      const title = document.title;
      const shareData = {{ title: title, url: url }};
      if (navigator.share) {{
        navigator.share(shareData).catch(() => {{ /* user dismissed; nothing to do */ }});
        return;
      }}
      // Clipboard fallback
      const showTooltip = (text) => {{
        const tip = btn && btn.querySelector('.btn-share-tooltip');
        if (!tip) return;
        tip.textContent = text;
        btn.classList.add('copied');
        clearTimeout(btn._tipTimer);
        btn._tipTimer = setTimeout(() => btn.classList.remove('copied'), 1500);
      }};
      if (navigator.clipboard && navigator.clipboard.writeText) {{
        navigator.clipboard.writeText(url)
          .then(() => showTooltip('Link copied'))
          .catch(() => showTooltip('Press \u2318C to copy'));
      }} else {{
        // Last resort: legacy execCommand
        try {{
          const ta = document.createElement('textarea');
          ta.value = url; ta.setAttribute('readonly', '');
          ta.style.position = 'absolute'; ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          showTooltip('Link copied');
        }} catch (e) {{
          showTooltip('Could not copy');
        }}
      }}
    }};

    // Gallery slider — arrow cycling, keyboard arrows, and touch swipe
    // Uses data-pos="active|prev|next" so CSS can position the center slide and
    // peek slides on desktop, while mobile collapses to a full-width fade.
    (function() {{
      const slider = document.querySelector('.gs-slider');
      if (!slider) return;
      const slides = slider.querySelectorAll('.gs-slide');
      const counter = slider.querySelector('.gs-cur');
      const prevBtn = slider.querySelector('.gs-prev');
      const nextBtn = slider.querySelector('.gs-next');
      const total = slides.length;
      let cur = 0;

      // Preload an image so transitions feel instant
      function preload(idx) {{
        const img = slides[idx];
        if (!img) return;
        if (img.dataset.preloaded) return;
        const ghost = new Image();
        ghost.src = img.src;
        img.dataset.preloaded = '1';
      }}

      function applyPositions() {{
        const prevIdx = (cur - 1 + total) % total;
        const nextIdx = (cur + 1) % total;

        // Determine the new pos for each slide
        const newPos = new Array(total);
        slides.forEach((slide, i) => {{
          if (i === cur) {{
            newPos[i] = 'active';
            return;
          }}
          if (total === 2) {{
            newPos[i] = i === nextIdx ? 'next' : 'hidden-right';
            return;
          }}
          if (i === prevIdx) {{
            newPos[i] = 'prev';
          }} else if (i === nextIdx) {{
            newPos[i] = 'next';
          }} else {{
            // Park hidden slides on the side closer in cycle direction so they only
            // need to fade in (not slide across the screen) when activated.
            const forwardDist  = (i - cur + total) % total;
            const backwardDist = (cur - i + total) % total;
            newPos[i] = forwardDist <= backwardDist ? 'hidden-right' : 'hidden-left';
          }}
        }});

        // Snap-then-animate: if a slide is changing from a left-side state to a
        // right-side state (or vice versa), it would otherwise animate horizontally
        // across the visible area, causing a half-image flash. Disable its `left`
        // transition for one frame so the position change is instant, then restore
        // the transition so subsequent state changes animate normally.
        const LEFT_SIDE  = new Set(['prev', 'hidden-left']);
        const RIGHT_SIDE = new Set(['next', 'hidden-right']);
        const teleporters = [];
        slides.forEach((slide, i) => {{
          const oldP = slide.getAttribute('data-pos');
          const newP = newPos[i];
          if (!oldP || oldP === newP) return;
          const crossesSides =
            (LEFT_SIDE.has(oldP) && RIGHT_SIDE.has(newP)) ||
            (RIGHT_SIDE.has(oldP) && LEFT_SIDE.has(newP));
          if (crossesSides) teleporters.push(slide);
        }});

        teleporters.forEach(s => {{ s.style.transition = 'opacity 0.4s ease'; }});
        slides.forEach((slide, i) => slide.setAttribute('data-pos', newPos[i]));
        if (teleporters.length) {{
          // Force layout flush, then restore the transition next frame so future
          // state changes animate `left` normally.
          // eslint-disable-next-line no-unused-expressions
          teleporters[0].offsetHeight;
          requestAnimationFrame(() => {{
            teleporters.forEach(s => {{ s.style.transition = ''; }});
          }});
        }}
      }}

      function go(next) {{
        if (next === cur) return;
        cur = (next + total) % total;
        applyPositions();
        if (counter) counter.textContent = cur + 1;
        // Preload neighbors
        preload((cur + 1) % total);
        preload((cur - 1 + total) % total);
      }}

      // Initial render
      applyPositions();

      prevBtn?.addEventListener('click', () => go(cur - 1));
      nextBtn?.addEventListener('click', () => go(cur + 1));

      // Click on a peek slide to navigate to it
      slides.forEach((slide, i) => {{
        slide.addEventListener('click', () => {{
          const pos = slide.getAttribute('data-pos');
          if (pos === 'prev') go(cur - 1);
          else if (pos === 'next') go(cur + 1);
        }});
      }});

      // Keyboard arrows when slider is focused/in view
      document.addEventListener('keydown', (e) => {{
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowLeft')  go(cur - 1);
        if (e.key === 'ArrowRight') go(cur + 1);
      }});

      // Touch swipe for mobile
      let startX = 0, startY = 0;
      slider.addEventListener('touchstart', (e) => {{
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      }}, {{ passive: true }});
      slider.addEventListener('touchend', (e) => {{
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {{
          go(dx < 0 ? cur + 1 : cur - 1);
        }}
      }}, {{ passive: true }});

      // Preload the second image immediately
      preload(1 % total);
    }})();

    /* ─── Watch button hydration (Phase 4) ─────────────────────────────
       Static pages don't know who the visitor is at build time, so the
       Watch button ships in its default "Watch" state. On page load:
         1. Wait for Memberstack to be ready
         2. Read favorites + last_viewed_at from the member JSON
         3. If watching this project, flip button to "Watching" state
         4. Fetch pulse.json + compute unread count → show summary card
         5. Stamp last_viewed_at = now (matches the map modal's behavior)
         6. Wire click handler: toggle favorite + persist (merge-fetch-write
            to avoid clobbering sibling JSON keys) + update UI

       Anonymous users see a stable "Watch" button. Clicking it sends them
       to the map's signup wall via the standard map URL.

       Exposed as window.ppInitWatch so project-shuffle.js can re-hydrate the
       freshly swapped-in Watch button after a shuffle (it reads slug/title
       from the button's own data-* attributes, so re-running is safe). */
    window.ppInitWatch = function watchBtnHydrate() {{
      var btn      = document.getElementById('watchBtn');
      var labelEl  = document.getElementById('watchBtnLabel');
      var card     = document.getElementById('watchingCard');
      var cardBody = document.getElementById('watchingCardBody');
      if (!btn) return;
      var slug = btn.getAttribute('data-slug') || '';
      var title = btn.getAttribute('data-title') || '';
      if (!slug) return;

      // Sync UI to current state. `watching` toggles the green pill; the
      // dot piggybacks on `.has-unread` which is set by the unread-counter
      // step below once pulse.json comes back.
      function setUI(watching) {{
        if (watching) {{
          btn.classList.add('watching');
          if (labelEl) labelEl.textContent = 'Watching';
          btn.setAttribute('aria-label', 'Stop watching this project');
        }} else {{
          btn.classList.remove('watching', 'has-unread');
          if (labelEl) labelEl.textContent = 'Watch';
          btn.setAttribute('aria-label', 'Watch this project');
          if (card) card.setAttribute('hidden', '');
        }}
      }}

      function waitForMemberstack(cb, tries) {{
        tries = tries || 0;
        if (window.$memberstackDom && window.$memberstackDom.getCurrentMember) {{
          cb(window.$memberstackDom);
        }} else if (tries < 60) {{
          // Poll up to ~6s. Plenty for the async <script> tag in head.
          setTimeout(function() {{ waitForMemberstack(cb, tries + 1); }}, 100);
        }}
      }}

      // Compute "N new updates since last_viewed_at" for this project from
      // pulse.json. Same logic as the map's getUnreadForProject() but local
      // to this page so we don't pull in the whole map JS bundle.
      function fetchUnread(lastViewedIso, cb) {{
        fetch('/map/pulse.json', {{ cache: 'no-store' }})
          .then(function(r) {{ if (!r.ok) throw 0; return r.json(); }})
          .then(function(data) {{
            var events = (data && Array.isArray(data.events)) ? data.events : [];
            var count = 0;
            var lastEvent = null;
            for (var i = 0; i < events.length; i++) {{
              var ev = events[i];
              if (ev.project_slug !== slug) continue;
              var ts = ev.timestamp || '';
              if (!lastViewedIso || ts > lastViewedIso) {{
                count++;
                if (!lastEvent || ts > (lastEvent.timestamp || '')) lastEvent = ev;
              }}
            }}
            cb(count, lastEvent);
          }})
          .catch(function() {{ cb(0, null); }});
      }}

      function renderWatchingCard(count, lastEvent, lastViewedIso) {{
        if (!card || !cardBody) return;
        // Show the card on EVERY watched project. Copy adapts: highlight new
        // activity when there is some, or quietly reinforce that we're
        // tracking when there isn't.
        if (count > 0) {{
          btn.classList.add('has-unread');
          var detail = '';
          if (lastEvent) {{
            var t = lastEvent.type || '';
            if (t === 'article')           detail = ' \u2014 incl. a new article';
            else if (t === 'status_change') detail = ' \u2014 incl. a status change';
          }}
          var noun = count === 1 ? 'update' : 'updates';
          cardBody.innerHTML = '<strong>' + count + ' new ' + noun + '</strong> since you last viewed' + detail;
        }} else {{
          btn.classList.remove('has-unread');
          var when = '';
          if (lastViewedIso) {{
            var ms = new Date(lastViewedIso).getTime();
            if (ms) {{
              var s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
              if (s < 60)        when = 'just now';
              else if (s < 3600) when = Math.floor(s / 60)   + 'm ago';
              else if (s < 86400) when = Math.floor(s / 3600) + 'h ago';
              else if (s < 604800) when = Math.floor(s / 86400) + 'd ago';
              else                when = Math.floor(s / 604800) + 'w ago';
            }}
          }}
          if (when) {{
            cardBody.innerHTML = '<strong>You\u2019re up to date</strong> \u2014 last viewed ' + when;
          }} else {{
            cardBody.innerHTML = '<strong>Tracking this project</strong> \u2014 we\u2019ll surface news and status changes here.';
          }}
        }}
        card.removeAttribute('hidden');
      }}

      // Merge-fetch-write to Memberstack JSON. Required because updateMemberJSON
      // REPLACES the entire blob (Memberstack API behavior, not a merge).
      async function saveMemberJson(patch) {{
        var ms = window.$memberstackDom;
        if (!ms) return;
        try {{
          var cur = await ms.getMemberJSON();
          var json = (cur && cur.data && typeof cur.data === 'object') ? cur.data : {{}};
          for (var k in patch) {{ json[k] = patch[k]; }}
          await ms.updateMemberJSON({{ json: json }});
        }} catch (e) {{ /* swallow; non-fatal */ }}
      }}

      // Anon users: clicking the watch button just sends them to the map's
      // signup flow. The map already handles the sign-up wall, so we route
      // there with the deep-link to this project so after sign-up they land
      // back in context.
      function anonClick() {{
        var mapHref = '{SITE_URL}/?project=' + encodeURIComponent(slug);
        window.location.href = mapHref;
      }}

      waitForMemberstack(async function(ms) {{
        var memberResp;
        try {{ memberResp = await ms.getCurrentMember(); }} catch (e) {{ memberResp = null; }}
        var member = memberResp && memberResp.data;
        if (!member) {{
          // Anonymous: leave button in default state. Clicking it deep-links
          // to the map (which knows how to handle the signup wall).
          btn.addEventListener('click', anonClick);
          return;
        }}

        // Signed in: load JSON, set state, wire click
        var json = {{}};
        try {{
          var got = await ms.getMemberJSON();
          json = (got && got.data && typeof got.data === 'object') ? got.data : {{}};
        }} catch (e) {{ json = {{}}; }}
        var favs = Array.isArray(json.favorites) ? json.favorites : [];
        var lastViewed = (json.last_viewed_at && typeof json.last_viewed_at === 'object') ? json.last_viewed_at : {{}};
        var isWatching = favs.indexOf(slug) !== -1;
        setUI(isWatching);

        if (isWatching) {{
          // Pull unread count then render summary card. Then mark this view
          // as "just viewed" so the counter resets for next time.
          fetchUnread(lastViewed[slug] || '', function(count, lastEvent) {{
            // Pass the prior last_viewed so the "0 unread" path can show
            // relative time. Then stamp = now so next visit's counter is
            // accurate.
            renderWatchingCard(count, lastEvent, lastViewed[slug] || '');
            lastViewed[slug] = new Date().toISOString();
            saveMemberJson({{ last_viewed_at: lastViewed }});
          }});
        }}

        // Click handler. Paid-tier gate matches the map: free users get
        // routed to the map for the subscription paywall flow. Detecting
        // paid status here is best-effort -- if any plan is active we
        // assume paid. (The map is the source of truth; this is just to
        // avoid silently doing nothing on free clicks.)
        var plans = member.planConnections || [];
        var isPaid = plans.some(function(p) {{ return p.active === true || p.status === 'ACTIVE'; }});

        btn.addEventListener('click', async function() {{
          if (!isPaid) {{
            // Free users: route to map which handles the paywall UX.
            anonClick();
            return;
          }}
          // Toggle state, persist, repaint
          var idx = favs.indexOf(slug);
          if (idx === -1) {{
            favs.push(slug);
            isWatching = true;
          }} else {{
            favs.splice(idx, 1);
            isWatching = false;
          }}
          setUI(isWatching);
          // Persist favorites (merge-write to preserve last_viewed_at etc).
          await saveMemberJson({{ favorites: favs }});
        }});
      }});
    }};
    window.ppInitWatch();

    /* The pulse-hydrated "Project Updates" section was retired (superseded by the
       "story so far" dossier). Kept as a no-op so project-shuffle.js can still call
       window.ppInitUpdates() after a swap without erroring. */
    window.ppInitUpdates = function updatesHydrate() {{}};
  </script>

  <!-- Cinematic gallery + same-market shuffle engine (gallery photos, edge
       arrows → another project via pjax fragment swap + pushState). -->
  <script src="/_shared/project-shuffle.js" defer></script>

  <!-- Universal site chrome: global header + footer + account cluster, the same
       one injected on every journal page. -->
  <script src="/_shared/journal-chrome.js" defer></script>
  <script src="/_shared/journal-dock.js" defer></script>
</body>
</html>'''
    return html, slug

def _parse_price(s):
    """Best-effort parse of Price column. Returns dollar value as int, or 0 if unparseable.
    Handles: $50M, $1.2B, $500K, "starting from $400K", "$2M-$5M" (uses low end),
    "Available upon request", blank, etc. Returns 0 for missing/range/unparseable."""
    if not s:
        return 0
    s = s.lower().strip()
    if 'request' in s or 'tbd' in s or 'undisclosed' in s:
        return 0
    # Take first number-ish chunk
    import re as _re
    m = _re.search(r'\$?\s*([\d,]+(?:\.\d+)?)\s*([kmb])?', s)
    if not m:
        return 0
    try:
        n = float(m.group(1).replace(',', ''))
    except ValueError:
        return 0
    suffix = (m.group(2) or '').lower()
    if suffix == 'k':
        n *= 1_000
    elif suffix == 'm':
        n *= 1_000_000
    elif suffix == 'b':
        n *= 1_000_000_000
    elif n > 1_000_000:
        # No suffix but already a big number; assume it's literal dollars
        pass
    elif n > 1000:
        # No suffix, 4-digit+ number = likely already in thousands or square feet,
        # not safe to guess. Skip.
        return 0
    else:
        # Tiny number with no suffix; meaningless
        return 0
    return int(n)

def _format_dollars_short(n):
    """4,200,000,000 -> '$4.2B', 84_000_000_000 -> '$84B', 500_000 -> '$500K'."""
    if n <= 0:
        return '$0'
    if n >= 1_000_000_000:
        v = n / 1_000_000_000
        return f'${v:.1f}B' if v < 10 else f'${int(v)}B'
    if n >= 1_000_000:
        v = n / 1_000_000
        return f'${v:.1f}M' if v < 10 else f'${int(v)}M'
    if n >= 1_000:
        return f'${int(n/1_000)}K'
    return f'${n}'

def _normalize_entity_name(s):
    """Drop blank/placeholder developer/architect names that aren't real entities."""
    if not s:
        return ''
    s = s.strip()
    if not s:
        return ''
    bad = s.lower()
    if bad in ('multiple', 'various', 'tbd', 'tba', 'unknown', 'n/a', 'na', '-', 'undisclosed'):
        return ''
    return s

def _normalize_project_type(s):
    """Single canonical type per project. Takes first comma-separated value."""
    if not s:
        return ''
    first = s.split(',')[0].strip()
    return first

# Whitelist of well-known firm names that legitimately contain commas. These
# would otherwise get incorrectly split on the comma by _split_entities. The
# pre-splitter pass below replaces matches with comma-free canonical forms.
# Keys are lowercase substrings to match; values are the canonical replacement.
_KNOWN_FIRM_NORMALIZATIONS = [
    ('skidmore, owings & merrill', 'Skidmore Owings & Merrill'),
    ('skidmore, owings and merrill', 'Skidmore Owings & Merrill'),
    ('skidmore, owings', 'Skidmore Owings'),  # truncated variant
]

def _protect_known_firms(raw):
    """Replace known multi-word firm names that legitimately contain commas
    with comma-free canonical versions BEFORE splitting. Returns the cleaned
    string. Case-insensitive matching."""
    if not raw:
        return raw
    lower = raw.lower()
    out = raw
    for needle, replacement in _KNOWN_FIRM_NORMALIZATIONS:
        idx = lower.find(needle)
        while idx >= 0:
            out = out[:idx] + replacement + out[idx + len(needle):]
            lower = out.lower()
            idx = lower.find(needle, idx + len(replacement))
    return out

def _split_entities(raw):
    """Split a developer/architect field that may list multiple entities.
    Per data-entry convention, multiple entities are separated ONLY by commas.
    This preserves entity names that legitimately contain `&`, `/`, '+', or the
    word 'and' (e.g. "H&H Group", "Foster + Partners", "Smith and Sons").
    Known firm names containing commas (e.g. "Skidmore, Owings & Merrill") are
    protected via _protect_known_firms before the split.
    Placeholders like 'TBD' / 'Various' are filtered out."""
    if not raw:
        return []
    raw = _protect_known_firms(raw)
    parts = raw.split(',')
    seen = set()
    out = []
    for p in parts:
        norm = _normalize_entity_name(p)
        if not norm:
            continue
        # Dedupe within the same row (same dev listed twice with different
        # punctuation shouldn't count twice).
        key = norm.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(norm)
    return out

_CITY_TO_STATE = {
    # Florida -- core coverage area
    'miami': 'FL', 'miami beach': 'FL', 'south beach': 'FL',
    'coral gables': 'FL', 'coconut grove': 'FL', 'pinecrest': 'FL',
    'doral': 'FL', 'aventura': 'FL', 'sunny isles': 'FL', 'sunny isles beach': 'FL',
    'north miami': 'FL', 'north miami beach': 'FL', 'surfside': 'FL',
    'bay harbor islands': 'FL', 'bay harbour islands': 'FL', 'indian creek': 'FL',
    'fisher island': 'FL', 'key biscayne': 'FL', 'virginia key': 'FL',
    'bal harbour': 'FL', 'bal harbor': 'FL',
    'brickell': 'FL', 'edgewater': 'FL', 'wynwood': 'FL',
    'allapattah': 'FL', 'overtown': 'FL',
    'little havana': 'FL', 'little river': 'FL', 'design district': 'FL',
    'midtown miami': 'FL', 'downtown miami': 'FL',
    'fort lauderdale': 'FL', 'ft lauderdale': 'FL', 'ft. lauderdale': 'FL',
    'pompano beach': 'FL', 'oakland park': 'FL', 'wilton manors': 'FL',
    'hollywood': 'FL', 'dania beach': 'FL', 'dania': 'FL',
    'hallandale beach': 'FL', 'hallandale': 'FL',
    'plantation': 'FL', 'sunrise': 'FL', 'davie': 'FL', 'cooper city': 'FL',
    'pembroke pines': 'FL', 'miramar': 'FL', 'weston': 'FL',
    'deerfield beach': 'FL', 'parkland': 'FL', 'coconut creek': 'FL',
    'coral springs': 'FL',
    'west palm beach': 'FL', 'palm beach': 'FL', 'palm beach gardens': 'FL',
    'the palm beaches': 'FL',
    'north palm beach': 'FL', 'jupiter': 'FL', 'jupiter island': 'FL', 'tequesta': 'FL',
    'hobe sound': 'FL', 'stuart': 'FL', 'jensen beach': 'FL',
    'palm city': 'FL', 'port st. lucie': 'FL', 'port saint lucie': 'FL',
    'vero beach': 'FL', 'sebastian': 'FL',
    'lake worth': 'FL', 'lake worth beach': 'FL', 'lantana': 'FL',
    'delray beach': 'FL', 'boca raton': 'FL', 'boynton beach': 'FL',
    'riviera beach': 'FL', 'wellington': 'FL', 'royal palm beach': 'FL',
    'loxahatchee': 'FL', 'westlake': 'FL',
    'singer island': 'FL', 'palm beach shores': 'FL',
    'manalapan': 'FL', 'south palm beach': 'FL', 'gulf stream': 'FL',
    'highland beach': 'FL', 'briny breezes': 'FL', 'ocean ridge': 'FL',
    'tampa': 'FL', 'st. petersburg': 'FL', 'st petersburg': 'FL', 'saint petersburg': 'FL',
    'clearwater': 'FL', 'tampa bay': 'FL',
    'sarasota': 'FL', 'siesta key': 'FL', 'longboat key': 'FL',
    'bradenton': 'FL', 'anna maria island': 'FL',
    'naples': 'FL', 'bonita springs': 'FL', 'marco island': 'FL', 'estero': 'FL',
    'orlando': 'FL', 'winter park': 'FL', 'kissimmee': 'FL', 'celebration': 'FL',
    'lake nona': 'FL', 'lake mary': 'FL',
    'jacksonville': 'FL', 'st. augustine': 'FL', 'st augustine': 'FL', 'saint augustine': 'FL',
    'amelia island': 'FL', 'fernandina beach': 'FL', 'ponte vedra': 'FL', 'ponte vedra beach': 'FL',
    'fort myers': 'FL', 'ft myers': 'FL', 'cape coral': 'FL', 'punta gorda': 'FL',
    'sanibel': 'FL', 'sanibel island': 'FL', 'captiva': 'FL',
    'key west': 'FL', 'key largo': 'FL', 'marathon': 'FL', 'islamorada': 'FL',
    'panama city beach': 'FL', 'panama city': 'FL', 'destin': 'FL', 'rosemary beach': 'FL',
    'seaside': 'FL', 'watercolor': 'FL', 'alys beach': 'FL', '30a': 'FL',
    # Tennessee
    'nashville': 'TN', 'east nashville': 'TN', 'germantown': 'TN',
    'memphis': 'TN', 'knoxville': 'TN', 'chattanooga': 'TN',
    'franklin': 'TN', 'brentwood': 'TN', 'murfreesboro': 'TN', 'gallatin': 'TN',
    'hendersonville': 'TN', 'cookeville': 'TN', 'spring hill': 'TN',
    # Carolinas
    'charleston': 'SC', 'mount pleasant': 'SC', 'mt pleasant': 'SC',
    'kiawah island': 'SC', 'isle of palms': 'SC', 'sullivans island': 'SC',
    'hilton head': 'SC', 'hilton head island': 'SC', 'bluffton': 'SC',
    'myrtle beach': 'SC', 'greenville': 'SC', 'columbia': 'SC',
    'asheville': 'NC', 'charlotte': 'NC', 'raleigh': 'NC', 'durham': 'NC',
    'wilmington': 'NC', 'chapel hill': 'NC', 'cary': 'NC',
    'kiawah river': 'SC',
    # Georgia
    'atlanta': 'GA', 'savannah': 'GA', 'tybee island': 'GA', 'sea island': 'GA',
    'st. simons': 'GA', 'jekyll island': 'GA',
    # New York
    'new york': 'NY', 'new york city': 'NY', 'nyc': 'NY', 'manhattan': 'NY',
    'brooklyn': 'NY', 'queens': 'NY', 'bronx': 'NY',
    'long island': 'NY', 'hamptons': 'NY', 'east hampton': 'NY', 'southampton': 'NY',
    'sag harbor': 'NY', 'montauk': 'NY', 'westhampton': 'NY', 'bridgehampton': 'NY',
    # Texas
    'austin': 'TX', 'houston': 'TX', 'dallas': 'TX', 'san antonio': 'TX',
    'fort worth': 'TX', 'ft worth': 'TX',
    # International
    'london': 'UK', 'paris': 'FR', 'tokyo': 'JP',
    'dubai': 'AE', 'abu dhabi': 'AE',
    'france': 'FR',  # appears as "France" alone in some rows
}

# Friendly region names for filter UI (state code -> label)
_STATE_LABELS = {
    'FL': 'Florida', 'TN': 'Tennessee', 'SC': 'South Carolina', 'NC': 'North Carolina',
    'GA': 'Georgia',  'NY': 'New York',  'TX': 'Texas',
    'UK': 'UK', 'FR': 'France', 'JP': 'Japan', 'AE': 'UAE',
}

def _state_for_city(city):
    if not city:
        return 'Other'
    return _CITY_TO_STATE.get(city.lower().strip(), 'Other')

def build_atlas_json(rows, pulse_path='pulse.json', articles_archive=None):
    """Compute Atlas page aggregates from CSV rows. Returns dict ready to json.dump.

    Each leaderboard entry includes a 'states' array of state codes where that
    entity has projects, so the client-side filter can hide/show entries
    without needing to refetch. Developer + architect fields are split into
    multiple entities when the row lists "Dev A, Dev B" or "Arch A / Arch B"
    -- each gets a separate +1 count."""
    from collections import Counter, defaultdict
    from datetime import date

    now = date.today()
    current_year = now.year

    total_projects = len(rows)
    total_dollars = 0
    under_construction = 0
    opening_this_year = 0

    status_counts = Counter()
    dev_counts = Counter()
    arch_counts = Counter()
    city_counts = Counter()
    type_counts = Counter()
    monthly_announcements = Counter()
    openings_by_year_counts = Counter()  # int year -> count

    # Per-entity state tracking (entity -> Counter(state)) for the global LB
    # variants (showing which states an entity operates in).
    dev_states = defaultdict(Counter)
    arch_states = defaultdict(Counter)
    city_states = {}  # city -> single state (cities only live in one state)
    type_states = defaultdict(Counter)

    # Per-state leaderboard counts. Keyed by state code -> Counter(entity).
    # When a state filter is active, we draw the leaderboard from these counters
    # instead of the global one so small markets aren't dropped out by the top-30
    # cap on the global view.
    dev_by_state = defaultdict(Counter)
    arch_by_state = defaultdict(Counter)
    city_by_state = defaultdict(Counter)
    type_by_state = defaultdict(Counter)

    # Sublabel data (entity -> Counter(city))
    dev_cities = defaultdict(Counter)
    arch_cities = defaultdict(Counter)

    for row in rows:
        status_raw = (row.get('Delivery','') or '').strip()
        status_label, _, _ = delivery_info(status_raw)
        status_counts[status_label] += 1

        if status_label == 'Construction' or 'construction' in status_raw.lower() or 'topping' in status_raw.lower():
            under_construction += 1

        total_dollars += _parse_price(row.get('Price', ''))

        # Delivery year tracking. Opening this year (current cal year) + openings_by_year
        delivery_date_str = (row.get('DeliveryDate','') or '').strip()
        d = _parse_iso_date(delivery_date_str)
        if d and status_label != 'Now Open':
            if d.year == current_year:
                opening_this_year += 1
            # Bucket into openings_by_year for the next 5 calendar years
            if current_year <= d.year <= current_year + 4:
                openings_by_year_counts[d.year] += 1

        sd = _parse_iso_date((row.get('StartDate','') or '').strip())
        if sd:
            monthly_announcements[f'{sd.year:04d}-{sd.month:02d}'] += 1

        city = (row.get('City','') or '').strip()
        state = _state_for_city(city)

        if city:
            city_counts[city] += 1
            city_states[city] = state
            city_by_state[state][city] += 1

        # Multi-developer split. "Related, BH3 / PMG" -> ['Related', 'BH3', 'PMG'].
        # Each gets +1 in the count for this row (a co-developed project credits
        # every participant, matching user's stated requirement).
        dev_raw = (row.get('Developer','') or '').strip()
        for dev in _split_entities(dev_raw):
            dev_counts[dev] += 1
            dev_cities[dev][city] += 1
            dev_states[dev][state] += 1
            dev_by_state[state][dev] += 1

        # Multi-architect split. Same logic as developers.
        arch_raw = (row.get('Architect','') or '').strip()
        for arch in _split_entities(arch_raw):
            arch_counts[arch] += 1
            arch_cities[arch][city] += 1
            arch_states[arch][state] += 1
            arch_by_state[state][arch] += 1

        # Product type (still first listed; type taxonomy is single-value)
        t = _normalize_project_type(row.get('ProjectType',''))
        if t:
            type_counts[t] += 1
            type_states[t][state] += 1
            type_by_state[state][t] += 1

    # --- Available states for filter (only those with >0 projects) ---
    state_project_counts = Counter()
    unmapped_cities = Counter()
    for row in rows:
        city = (row.get('City','') or '').strip()
        st = _state_for_city(city)
        state_project_counts[st] += 1
        if st == 'Other' and city:
            unmapped_cities[city] += 1
    # Diagnostic: print any cities that fell to "Other" so we know what's missing
    # from _CITY_TO_STATE. Visible in the GitHub Actions workflow log.
    if unmapped_cities:
        print(f"[atlas] {sum(unmapped_cities.values())} projects in {len(unmapped_cities)} unmapped cities:")
        for city, count in unmapped_cities.most_common():
            print(f"  {count:3d}  {city}")
    # Build filter list: all states sorted by project count desc
    available_states = []
    for st_code, count in state_project_counts.most_common():
        if st_code == 'Other':
            continue  # don't list "Other" as a filter option (catches edge cases only)
        available_states.append({
            'code': st_code,
            'label': _STATE_LABELS.get(st_code, st_code),
            'count': count,
        })

    # --- Build firm name -> slug maps so leaderboards can carry slugs ---
    # Names and slugs live as parallel ', '-joined strings on each project row
    # (Architect/ArchitectSlugs, Developer/DeveloperSlugs). We zip them by index.
    # First-name-wins on collisions (a single name shouldn't map to two slugs in
    # practice, but be defensive about it).
    arch_name_to_slug = {}
    dev_name_to_slug = {}
    for row in rows:
        a_names = [n.strip() for n in (row.get('Architect','') or '').split(',')]
        a_slugs = [s.strip() for s in (row.get('ArchitectSlugs','') or '').split(',')]
        for n, s in zip(a_names, a_slugs):
            if n and s and n not in arch_name_to_slug:
                arch_name_to_slug[n] = s
        d_names = [n.strip() for n in (row.get('Developer','') or '').split(',')]
        d_slugs = [s.strip() for s in (row.get('DeveloperSlugs','') or '').split(',')]
        for n, s in zip(d_names, d_slugs):
            if n and s and n not in dev_name_to_slug:
                dev_name_to_slug[n] = s

    # --- Build leaderboards (top 30 each, both global and per-state) ---
    def _states_for(state_counter):
        """Return sorted list of state codes for an entity, most-projects-first."""
        return [s for s, _ in state_counter.most_common()]

    # Build city_devs once and reuse across global + per-state city LB calls
    _city_devs = defaultdict(set)
    for row in rows:
        c = (row.get('City','') or '').strip()
        for d in _split_entities(row.get('Developer','')):
            if c:
                _city_devs[c].add(d)

    def _lb_developers(state_filter=None):
        src = dev_by_state[state_filter] if state_filter else dev_counts
        out = []
        for name, count in src.most_common(30):
            top_city = dev_cities[name].most_common(1)[0][0] if dev_cities[name] else ''
            sub = top_city if top_city else f'{count} project{"s" if count != 1 else ""}'
            out.append({
                'name': name,
                'slug': dev_name_to_slug.get(name, ''),
                'sub': sub, 'count': count,
                'states': _states_for(dev_states[name]),
            })
        return out

    def _lb_architects(state_filter=None):
        src = arch_by_state[state_filter] if state_filter else arch_counts
        out = []
        for name, count in src.most_common(30):
            top_city = arch_cities[name].most_common(1)[0][0] if arch_cities[name] else ''
            sub = top_city if top_city else f'{count} project{"s" if count != 1 else ""}'
            out.append({
                'name': name,
                'slug': arch_name_to_slug.get(name, ''),
                'sub': sub, 'count': count,
                'states': _states_for(arch_states[name]),
            })
        return out

    def _lb_cities(state_filter=None):
        src = city_by_state[state_filter] if state_filter else city_counts
        out = []
        for name, count in src.most_common(30):
            n_devs = len(_city_devs[name])
            dev_part = f'{count} development{"s" if count != 1 else ""}'
            if n_devs:
                sub = f'{dev_part} \u00b7 {n_devs} developer{"s" if n_devs != 1 else ""}'
            else:
                sub = dev_part
            out.append({
                'name': name, 'sub': sub, 'count': count,
                'states': [city_states.get(name, 'Other')],
            })
        return out

    def _lb_types(state_filter=None):
        src = type_by_state[state_filter] if state_filter else type_counts
        # Use total projects for denominator when global, total filtered count when per-state
        denom = (state_project_counts.get(state_filter, 0) if state_filter else total_projects) or 1
        out = []
        for name, count in src.most_common(30):
            pct = (count / denom * 100)
            sub = f'{pct:.0f}% of pipeline'
            out.append({
                'name': name, 'sub': sub, 'count': count,
                'states': _states_for(type_states[name]),
            })
        return out

    # --- Status distribution ordered by canonical sequence ---
    canonical_status_order = ['Announced', 'Breaking Ground', 'Construction', 'Topping Out', 'Opening Soon', 'Now Open']
    status_distribution = []
    for label in canonical_status_order:
        c = status_counts.get(label, 0)
        if c > 0 or label in ('Announced', 'Construction', 'Now Open'):
            status_distribution.append({'label': label, 'count': c})

    # --- Momentum: 12 months ending current month ---
    momentum = []
    y, m = now.year, now.month
    for _ in range(12):
        key = f'{y:04d}-{m:02d}'
        momentum.append({
            'month': f'{date(y, m, 1).strftime("%b")}',
            'year': y,
            'count': monthly_announcements.get(key, 0)
        })
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    momentum.reverse()

    # --- Openings by year: current year + 4 ahead ---
    openings_by_year = []
    for yr in range(current_year, current_year + 5):
        openings_by_year.append({
            'year': yr,
            'count': openings_by_year_counts.get(yr, 0),
        })

    # --- Recent activity from pulse.json ---
    recent_activity = []
    try:
        with open(pulse_path, 'r', encoding='utf-8') as f:
            pulse_data = json.load(f)
        events = pulse_data.get('events', []) if isinstance(pulse_data, dict) else pulse_data
        recent_activity = events[:6] if isinstance(events, list) else []
    except (FileNotFoundError, json.JSONDecodeError, Exception):
        pass

    # --- Most-covered projects ---
    # Articles archive shape: { slug: [ {title, link, image, published_at}, ... ] }
    # Build a slug -> row lookup so we can resolve title/city from the slug key.
    most_covered = []
    if articles_archive:
        slug_to_row = {}
        for row in rows:
            t = (row.get('Title','') or '').strip()
            if not t:
                continue
            try:
                slug_to_row[slugify(t)] = row
            except Exception:
                continue
        # Build a sortable list of (slug, count, latest_date, row)
        coverage_items = []
        for slug, articles in articles_archive.items():
            if not isinstance(articles, list) or len(articles) < 2:
                continue  # Skip 0 or 1 article -- not "coverage" worth ranking
            row = slug_to_row.get(slug)
            if not row:
                continue  # Orphaned coverage (project removed from sheet)
            # Latest article date for sub-label
            latest = ''
            for a in articles:
                d = (a.get('published_at','') or '').strip()
                if d > latest:
                    latest = d
            coverage_items.append((slug, len(articles), latest, row))
        coverage_items.sort(key=lambda x: (-x[1], -ord(x[2][0]) if x[2] else 0))
        for slug, count, latest, row in coverage_items[:15]:
            most_covered.append({
                'slug': slug,
                'title': (row.get('Title','') or '').strip(),
                'city': (row.get('City','') or '').strip(),
                'count': count,
                'latest_date': latest,
            })

    # --- Coming soon: projects delivering in the rest of THIS calendar year. ---
    # Three buckets: next 30 days, 31-90 days, rest-of-year. This captures
    # late-year deliveries (e.g. a November project from May) that wouldn't
    # fit in a 120-day window.
    coming_soon = []
    today = now
    year_end = date(current_year, 12, 31)
    for row in rows:
        delivery_date_str = (row.get('DeliveryDate','') or '').strip()
        d = _parse_iso_date(delivery_date_str)
        if not d:
            continue
        days_out = (d - today).days
        # Must be in the future AND deliver before year-end
        if days_out < 0 or d > year_end:
            continue
        status_label, _, _ = delivery_info((row.get('Delivery','') or '').strip())
        if status_label == 'Now Open':
            continue
        title = (row.get('Title','') or '').strip()
        if not title:
            continue
        if days_out <= 30:
            bucket = '30d'
        elif days_out <= 90:
            bucket = '90d'
        else:
            bucket = 'rest'
        try:
            slug = slugify(title)
        except Exception:
            slug = ''
        display = _coming_soon_display(delivery_date_str, d, today)
        coming_soon.append({
            'slug': slug,
            'title': title,
            'city': (row.get('City','') or '').strip(),
            'delivery_date': d.isoformat(),
            'days_out': days_out,
            'bucket': bucket,
            'status': status_label,
            'display_label': display['label'],
            'display_precision': display['precision'],
        })
    coming_soon.sort(key=lambda x: x['days_out'])
    coming_soon = coming_soon[:15]

    # --- Per-state leaderboards. Pre-compute for every state that has projects ---
    leaderboards_by_state = {}
    for st in available_states:
        code = st['code']
        leaderboards_by_state[code] = {
            'developers': _lb_developers(code),
            'architects': _lb_architects(code),
            'cities':     _lb_cities(code),
            'types':      _lb_types(code),
        }

    # --- Scale: total units / hotel keys / floors across the tracked pipeline ---
    def _sum_int(field):
        tot = 0
        for r in rows:
            v = (r.get(field, '') or '').strip()
            try:
                tot += int(float(v))
            except (ValueError, TypeError):
                pass
        return tot
    scale = {
        'units': _sum_int('Units'),
        'keys': _sum_int('Keys'),
        'floors': _sum_int('Floors'),
    }

    # --- Per-state core aggregates ---------------------------------------
    # The new dashboard modules (headline tiles, pipeline-by-stage, the
    # momentum index) read top-level fields by default, but must respond to
    # the state filter exactly like the leaderboards do. Pre-compute the same
    # four payloads for each available state so the client can swap them in.
    def _core_aggregates(subset):
        sc = Counter()
        uc = 0
        units = keys = floors = 0
        mon = Counter()
        for r in subset:
            sraw = (r.get('Delivery', '') or '').strip()
            slabel, _, _ = delivery_info(sraw)
            sc[slabel] += 1
            if slabel == 'Construction' or 'construction' in sraw.lower() or 'topping' in sraw.lower():
                uc += 1
            for fld in ('Units', 'Keys', 'Floors'):
                v = (r.get(fld, '') or '').strip()
                try:
                    iv = int(float(v))
                except (ValueError, TypeError):
                    iv = 0
                if fld == 'Units':
                    units += iv
                elif fld == 'Keys':
                    keys += iv
                else:
                    floors += iv
            sd = _parse_iso_date((r.get('StartDate', '') or '').strip())
            if sd:
                mon[f'{sd.year:04d}-{sd.month:02d}'] += 1
        dist = []
        for label in canonical_status_order:
            c = sc.get(label, 0)
            if c > 0 or label in ('Announced', 'Construction', 'Now Open'):
                dist.append({'label': label, 'count': c})
        mom = []
        yy, mm = now.year, now.month
        for _ in range(12):
            k = f'{yy:04d}-{mm:02d}'
            mom.append({'month': date(yy, mm, 1).strftime('%b'), 'year': yy, 'count': mon.get(k, 0)})
            mm -= 1
            if mm == 0:
                mm = 12
                yy -= 1
        mom.reverse()
        return {
            'hero_stats': {'total_projects': len(subset), 'under_construction': uc},
            'scale': {'units': units, 'keys': keys, 'floors': floors},
            'status_distribution': dist,
            'momentum': mom,
        }

    rows_by_state = defaultdict(list)
    for r in rows:
        rows_by_state[_state_for_city((r.get('City', '') or '').strip())].append(r)
    by_state = {st['code']: _core_aggregates(rows_by_state[st['code']]) for st in available_states}

    # (The atlas "Movers" panel now reads recent_activity — the Pulse feed of real
    # event-dated milestones — so it stays in sync with the project dossiers. The
    # old LastChange-based `movers` array is retired.)

    return {
        'generated_at': now.isoformat(),
        'hero_stats': {
            'total_projects': total_projects,
            'total_dollars_short': _format_dollars_short(total_dollars),
            'total_dollars_raw': total_dollars,
            'under_construction': under_construction,
            'opening_this_year': opening_this_year,
        },
        'scale': scale,
        'leaderboards': {
            'developers': _lb_developers(),
            'architects': _lb_architects(),
            'cities': _lb_cities(),
            'types': _lb_types(),
        },
        'leaderboards_by_state': leaderboards_by_state,
        # Per-state core aggregates for the dashboard tiles / stage bars /
        # momentum index, so they filter like the leaderboards do.
        'by_state': by_state,
        # Full city → state map so the atlas pipeline-timeline view can filter
        # by state without being limited to the top-30-per-state leaderboard
        # subset. Each city maps to exactly one state code (cities live in
        # one state). Small payload addition (~hundreds of entries).
        'city_state_map': dict(city_states),
        'status_distribution': status_distribution,
        'momentum': momentum,
        'openings_by_year': openings_by_year,
        'available_states': available_states,
        'recent_activity': recent_activity,
        'most_covered': most_covered,
        'coming_soon': coming_soon,
    }

def main():
    # Read projects from projects-flat.json (written by fetch_projects.py,
    # which runs first in the workflow and converts tmw-data's rich JSON
    # to the CSV-shape dicts the rest of this script expects).
    #
    # The legacy Google Sheet code path below remains commented-out for
    # rollback purposes -- if anything goes wrong with the new pipeline,
    # un-comment and remove the JSON block to fall back instantly.
    print("Loading projects-flat.json...")
    try:
        with open('projects-flat.json', 'r', encoding='utf-8') as f:
            rows = json.load(f)
        rows = [r for r in rows if r.get('Title','').strip()]
        print(f"  ✓ Loaded {len(rows)} projects from projects-flat.json")
    except FileNotFoundError:
        print("  ✗ projects-flat.json not found.")
        print("     Did fetch_projects.py run first? See generate-pages.yml step order.")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"  ✗ projects-flat.json wasn't valid JSON: {e}")
        sys.exit(1)

    # --- LEGACY CSV PATH (kept for rollback) ---
    # cache_buster = f"&t={int(time.time())}"
    # sheet_url = SHEET_CSV_URL + cache_buster
    # try:
    #     req = urllib.request.Request(sheet_url, headers={
    #         'User-Agent': 'Mozilla/5.0',
    #         'Cache-Control': 'no-cache',
    #         'Pragma': 'no-cache',
    #     })
    #     with urllib.request.urlopen(req, timeout=30) as resp:
    #         content = resp.read().decode('utf-8')
    #     print("  ✓ Fetched from Google Sheets")
    # except Exception as e:
    #     print(f"  ✗ Could not fetch sheet: {e}")
    #     print("  Trying local cache...")
    #     try:
    #         with open('projects_latest.csv') as f:
    #             content = f.read()
    #         print("  ✓ Using local cache")
    #     except:
    #         print("  ✗ No local cache found. Exiting.")
    #         sys.exit(1)
    # rows = list(csv.DictReader(io.StringIO(content)))
    # rows = [r for r in rows if r.get('Title','').strip()]
    # print(f"  {len(rows)} projects found")

    # Load articles.json so we can render the "Coverage on TMW" section on
    # individual project pages. Lookup keys are the same hyphenated slugs the
    # pulse pipeline writes. If articles.json doesn't exist yet (first run
    # before generate_pulse.py has written it), fall back to {} -- pages
    # render fine, just without coverage.
    articles_archive = {}
    try:
        with open('articles.json', 'r', encoding='utf-8') as f:
            articles_archive = json.load(f)
        if not isinstance(articles_archive, dict):
            articles_archive = {}
        print(f"  ✓ Loaded articles.json ({sum(len(v) for v in articles_archive.values())} articles across {len(articles_archive)} projects)")
    except FileNotFoundError:
        print("  · articles.json not found yet (skipping Coverage sections)")
    except Exception as e:
        print(f"  · articles.json load error: {e}")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Build a market -> projects index so each page can show "Nearby Projects"
    # (up to 3 other projects in the same city).
    from collections import defaultdict as _dd
    city_index = _dd(list)
    for _r in rows:
        _t = (_r.get('Title', '') or '').strip()
        if _t:
            city_index[(_r.get('City', '') or '').strip()].append(_r)

    # Generate index page
    index_items = []
    generated = 0
    skipped = 0
    pages_with_coverage = 0  # diagnostic: how many pages got a Coverage section
    dossiers = {}  # slug -> precomputed dossier rows HTML (for the map, identical to the page)

    for row in rows:
        title = row.get('Title','').strip()
        if not title:
            continue
        try:
            slug_for_lookup = slugify(title)
            page_articles = articles_archive.get(slug_for_lookup, [])
            if page_articles:
                pages_with_coverage += 1
            # Precompute the dossier milestone timeline ONCE (with articles, for the
            # "Announced" proxy + oftmw source preference) and stash it on the row,
            # so the page render reuses it AND it gets embedded in projects-flat.json
            # for the map — guaranteeing the page + map dossiers are identical.
            row['Milestones'] = build_milestones(row, page_articles)['milestones']
            # Nearby = up to 3 other projects in the same city.
            _city = (row.get('City', '') or '').strip()
            nearby_rows = [r for r in city_index.get(_city, [])
                           if (r.get('Title', '') or '').strip() != title][:3]
            html, slug = build_page(row, articles=page_articles, nearby=nearby_rows)
            # Stash the SAME rows HTML the page just rendered for the map sidecar,
            # keyed by the MAP slug (no hyphens, strip non-alnum) — the map computes
            # this identically from the title, so unicode titles (e.g. "Kōloa") match.
            _drows = dossier_rows_html(row.get('Milestones') or [])
            if _drows:
                dossiers[map_slug(title)] = _drows
            page_dir = os.path.join(OUTPUT_DIR, slug)
            os.makedirs(page_dir, exist_ok=True)
            with open(os.path.join(page_dir, 'index.html'), 'w', encoding='utf-8') as f:
                f.write(html)
            generated += 1
            index_items.append((slug, title, row.get('City',''), row.get('Delivery',''), row.get('ImageURL','')))
        except Exception as e:
            print(f"  Error on '{title}': {e}")
            skipped += 1

    print(f"  Coverage diagnostic: {pages_with_coverage}/{generated} pages have a Coverage section")

    # dossiers.json — the precomputed dossier rows HTML keyed by slug. The map
    # injects this EXACT string, so the map + project-page timelines are rendered
    # by a single renderer (this file) and can never drift or differ.
    try:
        with open('dossiers.json', 'w', encoding='utf-8') as f:
            json.dump(dossiers, f, ensure_ascii=False, separators=(',', ':'))
        print(f"  ✓ dossiers.json ({len(dossiers)} project timelines)")
    except Exception as e:
        print(f"  ✗ Could not write dossiers.json: {e}")

    # --- Atlas aggregates: developers/architects/cities leaderboards + hero stats ---
    # Pre-computed at build time so the Atlas view in index.html just fetches a
    # static JSON and renders. Same pattern as pulse.json.
    print("Building atlas.json...")
    try:
        atlas = build_atlas_json(rows, articles_archive=articles_archive)
        with open('atlas.json', 'w', encoding='utf-8') as f:
            json.dump(atlas, f, indent=2)
        n_devs = len(atlas['leaderboards']['developers'])
        n_arch = len(atlas['leaderboards']['architects'])
        n_cities = len(atlas['leaderboards']['cities'])
        n_types = len(atlas['leaderboards']['types'])
        print(f"  ✓ atlas.json (devs:{n_devs} arch:{n_arch} cities:{n_cities} types:{n_types})")
    except Exception as e:
        print(f"  ✗ Could not build atlas.json: {e}")

    # Generate /projects/index.html
    build_index(index_items)

    # Generate sitemap.xml + robots.txt at repo root
    write_sitemap_and_robots(index_items)

    print(f"\n✅ Done! Generated {generated} pages, skipped {skipped}")
    print(f"   Output: ./{OUTPUT_DIR}/")
    print(f"   Sitemap: ./sitemap.xml ({generated + 2} URLs)")

def write_sitemap_and_robots(items):
    """Write sitemap.xml and robots.txt to repo root for SEO."""
    from datetime import datetime
    today = datetime.utcnow().strftime('%Y-%m-%d')

    urls = []
    # Map root (highest priority)
    urls.append({'loc': SITE_URL + '/', 'priority': '1.0', 'changefreq': 'daily'})
    # Projects index
    urls.append({'loc': ROOT_URL + '/projects/', 'priority': '0.9', 'changefreq': 'daily'})
    # Each individual project page
    for slug, title, city, delivery, image in items:
        urls.append({
            'loc': f"{ROOT_URL}/projects/{slug}/",
            'priority': '0.8',
            'changefreq': 'weekly',
        })

    # ── Journal: home + rank pages + search + every pre-rendered article ──
    # Single sitemap (this file is the one submitted to Search Console), so the
    # journal lives here rather than in a second sitemap. Article slugs come
    # from the worker; best-effort so a worker hiccup never breaks the map build.
    urls.append({'loc': SITE_URL + '/journal/', 'priority': '0.9', 'changefreq': 'daily'})
    for p in ('golf', 'restaurants', 'hotels'):
        urls.append({'loc': f"{SITE_URL}/journal/{p}/", 'priority': '0.8', 'changefreq': 'weekly'})
    urls.append({'loc': SITE_URL + '/journal/search/', 'priority': '0.4', 'changefreq': 'monthly'})
    try:
        import subprocess, json as _json
        raw = subprocess.check_output(
            ["curl", "-s", "https://tmw.jake-ab7.workers.dev/posts?limit=1500&status=published"],
            timeout=90)
        posts = _json.loads(raw).get("items", [])
        for it in posts:
            s = it.get("slug")
            if not s:
                continue
            urls.append({'loc': f"{SITE_URL}/journal/post/{s}/", 'priority': '0.7', 'changefreq': 'monthly'})
        print(f"   Sitemap: +{len(posts)} journal articles")
    except Exception as e:
        print(f"   Sitemap: journal articles skipped ({e})")

    sitemap_xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    sitemap_xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    for u in urls:
        sitemap_xml += '  <url>\n'
        sitemap_xml += f'    <loc>{u["loc"]}</loc>\n'
        sitemap_xml += f'    <lastmod>{today}</lastmod>\n'
        sitemap_xml += f'    <changefreq>{u["changefreq"]}</changefreq>\n'
        sitemap_xml += f'    <priority>{u["priority"]}</priority>\n'
        sitemap_xml += '  </url>\n'
    sitemap_xml += '</urlset>\n'

    with open('sitemap.xml', 'w', encoding='utf-8') as f:
        f.write(sitemap_xml)

    robots_txt = (
        "User-agent: *\n"
        "Allow: /\n\n"
        f"Sitemap: {SITE_URL}/sitemap.xml\n"
    )
    with open('robots.txt', 'w', encoding='utf-8') as f:
        f.write(robots_txt)

def build_index(items):
    cards = ''
    for slug, title, city, delivery, image in items:
        stage, pct, color = delivery_info(delivery)
        img = image or DEFAULT_IMAGE
        cards += f'''
    <a class="card" href="./{slug}/">
      <div class="card-img" style="background-image:url('{img}')"></div>
      <div class="card-body">
        <div class="card-title">{title}</div>
        <div class="card-city">{city}</div>
        <div class="card-status" style="color:{color}">{stage}</div>
      </div>
    </a>'''

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>All Projects | Markets of Tomorrow</title>
  <meta name="description" content="Browse all {len(items)} projects tracked on the Map of Tomorrow — luxury real estate, hotels, stadiums, and more from Markets of Tomorrow.">
  <meta property="og:title" content="All Projects | Markets of Tomorrow">
  <meta property="og:description" content="Browse {len(items)} future developments on the Map of Tomorrow.">
  <meta property="og:image" content="{DEFAULT_IMAGE}">
  <link rel="icon" href="{LOGO_URL}" type="image/png">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ background: #0d0d0d; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }}
    .site-header {{ display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 0.5px solid rgba(255,255,255,0.08); position: sticky; top:0; background: rgba(13,13,13,0.92); backdrop-filter: blur(12px); z-index:10; }}
    .site-logo img {{ height: 28px; }}
    .header-map-btn {{ display:flex;align-items:center;gap:7px;background:rgba(255,255,255,0.07);border:0.5px solid rgba(255,255,255,0.15);border-radius:8px;padding:8px 14px;color:rgba(255,255,255,0.8);text-decoration:none;font-size:13px;font-weight:500; }}
    .page-header {{ padding: 32px 20px 20px; max-width: 1200px; margin: 0 auto; }}
    .page-header h1 {{ font-size: 28px; font-weight: 700; margin-bottom: 6px; }}
    .page-header p {{ color: rgba(255,255,255,0.45); font-size: 14px; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; padding: 0 20px 40px; max-width: 1200px; margin: 0 auto; }}
    .card {{ text-decoration: none; color: #fff; background: #111; border-radius: 12px; overflow: hidden; transition: transform 0.15s; }}
    .card:hover {{ transform: translateY(-2px); }}
    .card-img {{ height: 160px; background-size: cover; background-position: center; }}
    .card-body {{ padding: 12px; }}
    .card-title {{ font-size: 14px; font-weight: 600; margin-bottom: 3px; }}
    .card-city {{ font-size: 12px; color: rgba(255,255,255,0.4); margin-bottom: 5px; }}
    .card-status {{ font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }}
  </style>
</head>
<body>
  <header class="site-header">
    <a class="site-logo" href="{SITE_URL}"><img src="{LOGO_URL}" alt="Markets of Tomorrow" /></a>
    <a class="header-map-btn" href="{SITE_URL}">← View Map</a>
  </header>
  <div class="page-header">
    <h1>All Projects</h1>
    <p>{len(items)} developments tracked on the Map of Tomorrow</p>
  </div>
  <div class="grid">{cards}</div>
</body>
</html>'''

    with open(os.path.join(OUTPUT_DIR, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"  ✓ Index page: ./{OUTPUT_DIR}/index.html")

if __name__ == '__main__':
    main()
