#!/usr/bin/env python3
"""
generate_firm_pages.py -- Firm profile page generator.

Reads firms-flat.json (architects + developers, written by fetch_projects.py),
projects-flat.json (the canonical project list with ArchitectSlugs/DeveloperSlugs
columns), and articles.json (per-project coverage archive from generate_pulse.py).
Writes one static HTML page per firm, flat by slug:

  journal/firm/<slug>/index.html   (served at https://www.oftmw.com/firm/<slug>/)

A firm that is both an architect and a developer (e.g. Gensler) is merged into a
single page showing both roles and the union of its projects.

Each page renders:
  - Hero with firm name, role, founded year, HQ, active markets
  - 4-stat grid (projects, residential units, hotel keys, avg years to delivery)
  - Faux-map snippet showing pin distribution from lat/lng
  - Tabbed portfolio (All / In progress / Completed)
  - Coverage section pulling any articles that mention the firm's projects

Skips firms with zero referenced projects (noise reduction).

Run after fetch_projects.py (writes firms-flat.json + projects-flat.json) and
generate_pulse.py (refreshes articles.json). Sites it in front of the project
modal's existing architect/developer chip, which will eventually link here
(see follow-up commit on map index.html).

Usage:
    python generate_firm_pages.py
"""

import collections
import html
import json
import os
import re
import statistics
import sys
from collections import defaultdict

# Borrow the market-page renderers so firm pages and market pages share
# typography, cards, timeline boxes, firm bubbles, and Pro CTA verbatim.
from generate_market_pages import (
    card_html as market_card_html,
    _exclude_completed,
    _status_breakdown,
    _count_firms,
    slugify as market_slugify,
    FEAT_STAR_SVG,
    TYPE_PHRASING,
    ROOT_URL as MARKET_ROOT_URL,
    SITE_NAME,
)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PROJECTS_FLAT = 'projects-flat.json'
FIRMS_FLAT    = 'firms-flat.json'
ARTICLES_JSON = 'articles.json'

OUTPUT_ROOT = 'journal/firm'  # writes <slug>/index.html — one flat page per firm,
                              # merging a firm that is both architect + developer.

# Where the firm pages are served (used for canonical/og URLs).
SITE_ORIGIN = 'https://www.oftmw.com'
# Where the live interactive map lives (the "Open on Map" CTA target).
MAP_URL = 'https://www.oftmw.com/map/'

# Date sanity: durations outside [0.25, 15] years are likely bad data
DURATION_MIN_YEARS = 0.25
DURATION_MAX_YEARS = 15

# Coverage cap — most pages don't need more than N most-recent articles
MAX_COVERAGE_ITEMS = 12

# Status display + swatch color (matches the live map's STATUS_PIN_COLOR scheme)
STATUS_DISPLAY = {
    'announced':        ('Announced',        '#9CA3AF'),
    'breaking-ground':  ('Breaking Ground',  '#FFD300'),
    'breaking ground':  ('Breaking Ground',  '#FFD300'),
    'construction':     ('Construction',     '#FF9500'),
    'under construction': ('Construction',   '#FF9500'),
    'coming-soon':      ('Coming Soon',      '#4DABFF'),
    'opening soon':     ('Coming Soon',      '#4DABFF'),
    'open':             ('Now Open',         '#1FDF67'),
    'now open':         ('Now Open',         '#1FDF67'),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slugify(text):
    """Match generate_pages.py / index.html slugify so /projects/<slug>/ links work."""
    if not text:
        return ''
    s = str(text).lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s-]+', '-', s).strip('-')
    return s


def safe_int(v):
    if v is None or v == '':
        return None
    try:
        return int(float(str(v).strip()))
    except (ValueError, TypeError):
        return None


def safe_float(v):
    if v is None or v == '':
        return None
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return None


def split_csv(s):
    """Split a ', '-joined string into a list of stripped entries."""
    if not s:
        return []
    return [x.strip() for x in str(s).split(',') if x.strip()]


def load_json(path, default=None):
    if not os.path.exists(path):
        if default is not None:
            return default
        print(f"ERROR: required input {path} not found.", file=sys.stderr)
        sys.exit(1)
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def normalize_status(raw):
    """Map a Delivery string to a stable slug key for the status swatch."""
    k = (raw or '').strip().lower()
    if 'open' in k and 'now' in k: return 'open'
    if 'now open' in k or k == 'open': return 'open'
    if 'opening soon' in k or 'coming' in k: return 'coming-soon'
    if 'construction' in k: return 'construction'
    if 'breaking' in k: return 'breaking-ground'
    return 'announced'


def parse_year(date_str):
    """Extract a year integer from a date string (YYYY, YYYY-MM, YYYY-MM-DD)."""
    if not date_str:
        return None
    m = re.match(r'^(\d{4})', str(date_str).strip())
    return int(m.group(1)) if m else None


def fmt_month_year(date_str):
    """'2026-03-14' -> 'Mar 2026'; '2026' -> '2026'; empty -> '—'."""
    if not date_str:
        return '—'
    s = str(date_str).strip()
    months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    m = re.match(r'^(\d{4})-(\d{2})', s)
    if m:
        return f"{months[int(m.group(2))-1]} {m.group(1)}"
    m = re.match(r'^(\d{4})$', s)
    if m:
        return m.group(1)
    return s


def fmt_thousands(n):
    if n is None:
        return '—'
    try:
        return f"{int(n):,}"
    except (ValueError, TypeError):
        return '—'


# ---------------------------------------------------------------------------
# Per-firm aggregations
# ---------------------------------------------------------------------------

def projects_for_firm(firm_slug, slug_field, projects):
    """Return projects whose ArchitectSlugs/DeveloperSlugs CSV contains firm_slug."""
    out = []
    for p in projects:
        slugs = split_csv(p.get(slug_field, ''))
        if firm_slug in slugs:
            out.append(p)
    return out


def aggregate_stats(firm_projects):
    """Compute totals + averages used in the stats grid."""
    total = len(firm_projects)
    in_progress = sum(1 for p in firm_projects
                      if normalize_status(p.get('Delivery', '')) != 'open')
    completed = total - in_progress

    total_units = sum(safe_int(p.get('Units')) or 0 for p in firm_projects)
    total_keys  = sum(safe_int(p.get('Keys'))  or 0 for p in firm_projects)

    # Avg years to delivery — start_date to delivery_date, only when both present
    durations = []
    for p in firm_projects:
        sy = parse_year(p.get('StartDate'))
        dy = parse_year(p.get('DeliveryDate'))
        if sy and dy and dy >= sy:
            yrs = dy - sy
            if DURATION_MIN_YEARS <= yrs <= DURATION_MAX_YEARS:
                durations.append(yrs)
    avg_years = statistics.mean(durations) if durations else None

    # Active markets = unique non-empty cities
    markets = sorted({(p.get('City') or '').strip() for p in firm_projects if p.get('City')})

    return {
        'total':       total,
        'in_progress': in_progress,
        'completed':   completed,
        'total_units': total_units,
        'total_keys':  total_keys,
        'avg_years':   avg_years,
        'duration_sample_size': len(durations),
        'markets':     markets,
    }


def coverage_for_firm(firm_projects, articles_archive):
    """Return up to MAX_COVERAGE_ITEMS recent articles mentioning any of the firm's projects.

    articles.json shape: { project_slug: [article_obj, ...] }.
    article_obj fields: guid, title, link, image, published_at, _manual?
    """
    seen_urls = set()
    items = []
    for p in firm_projects:
        slug = slugify(p.get('Title', ''))
        if not slug:
            continue
        entries = articles_archive.get(slug, []) or []
        for art in entries:
            if not isinstance(art, dict):
                continue
            url = art.get('link') or art.get('guid') or ''
            key = (url or '').strip().lower().rstrip('/')
            if not key or key in seen_urls:
                continue
            seen_urls.add(key)
            items.append({
                'title':         art.get('title') or '',
                'url':           url,
                'image':         art.get('image') or '',
                'published_at':  art.get('published_at') or '',
                'project_name':  p.get('Title', ''),
                'project_slug':  slug,
            })
    items.sort(key=lambda a: a.get('published_at') or '', reverse=True)
    return items[:MAX_COVERAGE_ITEMS]


# ---------------------------------------------------------------------------
# HTML rendering
# ---------------------------------------------------------------------------

FIRM_CSS = """
    :root {
      --ink:#0d0d0d; --panel:#141714;
      --hair:rgba(255,255,255,.08); --hair-2:rgba(255,255,255,.14);
      --white:#fff; --cream:#ECEAE5; --mute:#9AA39C; --mute2:#9AA39C; --mute-2:#C2C9C3;
      --green:#1FDF67; --gold:#FFD300; --amber:#FFB45E;
      --purple:#A78BFA; --purple-bright:#C4B5FD; --purple-glow:#B9A6FF;
      --ink-2:#0d0f0e; --glass:rgba(20,23,20,.6);
      --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      --serif:'Fraunces',Georgia,serif;
      --mono:'JetBrains Mono','SF Mono',ui-monospace,monospace;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--ink); color: var(--cream); font-family: var(--sans); -webkit-font-smoothing:antialiased; line-height:1.55; }
    body::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none;
      background:
        radial-gradient(820px 540px at 76% -6%, rgba(167,139,250,.10), transparent 60%),
        radial-gradient(700px 480px at 4% 58%, rgba(255,211,0,.04), transparent 60%);
    }
    a { color: inherit; text-decoration: none; }
    .wrap { position:relative; z-index:1; max-width: 1200px; margin: 0 auto; padding: 0 24px; }

    /* Breadcrumb */
    .crumbs { padding: 22px 0 0; font-family: var(--mono); font-size: 11px; letter-spacing:.1em; text-transform:uppercase; color: var(--mute); }
    .crumbs a:hover { color: var(--white); }
    .crumbs .sep { opacity: .4; margin: 0 8px; }
    .crumbs b { color: var(--purple-bright); font-weight: 500; }

    /* Hero */
    .hero { padding: 30px 0 38px; border-bottom:1px solid var(--hair); }
    .hero-eyebrow { font-family:var(--mono); font-size:10.5px; letter-spacing:.2em; text-transform:uppercase; color:var(--purple-bright); margin-bottom:18px; display:inline-flex; align-items:center; gap:9px; }
    .hero-eyebrow::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--purple); box-shadow:0 0 10px var(--purple); }
    .hero h1 { font-family:var(--serif); font-size:clamp(40px, 5.6vw, 68px); line-height:1.04; font-weight:500; letter-spacing:-.022em; color:var(--white); max-width:20ch; }
    .firm-pills { display:flex; gap:8px; flex-wrap:wrap; margin-top:18px; }
    .firm-pills .meta-pill { font-family: var(--sans); font-size:12.5px; color:var(--mute-2); padding:6px 12px; background:rgba(255,255,255,.04); border:1px solid var(--hair); border-radius:999px; }
    .firm-pills .meta-pill b { color:var(--white); font-weight:600; margin-right:6px; }
    .hero .sub { font-family:var(--serif); font-style:italic; font-weight:300; font-size:20px; color:var(--mute-2); margin-top:18px; line-height:1.5; max-width:62ch; }
    .hero .sub b { font-style:normal; font-weight:500; color:var(--white); }
    .hero .sub a { color:var(--purple-bright); text-decoration:underline; text-underline-offset:3px; text-decoration-thickness:1px; }

    /* Stats strip */
    .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; padding: 32px 0; border-bottom:1px solid var(--hair); }
    .stat { background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; padding: 18px; }
    .stat .n { font-family:var(--serif); font-size: 32px; font-weight: 500; letter-spacing:-.018em; color: var(--white); line-height: 1; }
    .stat .l { font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color: var(--mute); margin-top: 10px; }
    .stat.uc .n { color: var(--amber); }
    .stat.bg .n { color: var(--gold); }
    .stat.os .n { color: var(--purple-bright); }
    .stat.no .n { color: var(--green); }

    /* Sections */
    .section { padding: 46px 0; border-bottom:1px solid var(--hair); }
    .section-head { display:flex; align-items:baseline; justify-content:space-between; gap:24px; margin-bottom: 22px; flex-wrap: wrap; }
    .section-title { font-family:var(--serif); font-size: 28px; line-height: 1.15; font-weight: 500; letter-spacing:-.018em; color: var(--white); }
    .section-eyebrow { font-family:var(--mono); font-size:10px; letter-spacing:.2em; text-transform:uppercase; color: var(--purple-bright); margin-bottom: 8px; font-weight:600; }
    .section-meta { font-family:var(--mono); font-size: 11px; letter-spacing:.12em; text-transform:uppercase; color: var(--mute); }
    .section-meta a { color: var(--purple-bright); text-decoration: underline; text-underline-offset:3px; }
    .section-meta a.see-all-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 999px;
      background: rgba(255,211,0,.06); color: var(--gold);
      border: 1px solid rgba(255,211,0,.45);
      box-shadow: 0 0 14px rgba(255,211,0,.18), inset 0 0 12px rgba(255,211,0,.05);
      font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em;
      text-transform: uppercase; text-decoration: none; font-weight: 700;
      transition: background .15s, box-shadow .15s, border-color .15s;
    }
    .section-meta a.see-all-pill:hover { background: rgba(255,211,0,.12); border-color: rgba(255,211,0,.7); box-shadow: 0 0 22px rgba(255,211,0,.32); }

    /* Project grid — full-rich cards from market pages (timeline + firm bubbles) */
    .grid.tmw-project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; }
    .card { display: flex; flex-direction: column; background:#111; border-radius:14px; overflow:hidden; transition: transform .15s, border-color .15s; border:1px solid transparent; position:relative; }
    .card:hover { transform: translateY(-2px); border-color: rgba(167,139,250,.3); }
    .card-link { display: block; text-decoration: none; color: inherit; }
    .card-firms-wrap { padding: 0 20px 20px; }
    .card-feat-badge { position:absolute; top:10px; right:10px; z-index:2; width:22px; height:22px; border-radius:5px; background:var(--gold); display:inline-flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,.4); }
    .card-feat-badge svg { width:12px; height:12px; fill:#0a0a0a; }
    .card-img { height: 220px; background-size: cover; background-position: center; position: relative; }
    .card-img::after { content:""; position:absolute; inset:0; background:linear-gradient(180deg, transparent 60%, rgba(0,0,0,.45) 100%); }
    .card-body { padding: 18px 20px 4px; }
    .card-title { font-family: var(--serif); font-size: 22px; font-weight: 500; letter-spacing:-.014em; line-height: 1.2; color: var(--white); margin-bottom: 6px; }
    .card-loc { font-family: var(--sans); font-size: 13px; color: var(--mute-2); margin-bottom: 14px; }
    .card-verified { display:flex; align-items:center; gap:8px; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,.5); margin-bottom: 12px; padding: 8px 0; border-top:1px solid var(--hair); border-bottom:1px solid var(--hair); }
    .card-v-ico { width:14px; height:14px; display:inline-block; }
    .card-v-ico svg { width:100%; height:100%; }

    /* Timeline */
    .pm-tl { margin-bottom: 14px; }
    .pm-tl-date { text-align: right; font-family: var(--mono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.5); margin-bottom: 8px; }
    .pm-tl-meter { position: relative; height: 11px; border-radius: 999px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,0.55); }
    .pm-tl-grad { position: absolute; inset: 0; background: linear-gradient(90deg, #3a2f6b, #7C5CE0 38%, #A78BFA 64%, #1FDF67); }
    .pm-tl-empty { position: absolute; top: 0; bottom: 0; right: 0; background: #0d0f0e; box-shadow: inset 2px 0 3px rgba(0,0,0,0.6); }
    .pm-tl-knob { position: absolute; top: 50%; transform: translate(-50%,-50%); background: #fff; color: #0a0a0a; font-size: 9.5px; font-weight: 800; padding: 4px 9px; border-radius: 999px; white-space: nowrap; z-index: 2; font-family: var(--sans); box-shadow: 0 2px 6px rgba(0,0,0,.5); }
    .pm-tl-stages { display: flex; gap: 3px; margin-top: 10px; }
    .pm-tl-stage { flex: 1; font-size: 7.5px; letter-spacing: 0.02em; text-transform: uppercase; color: rgba(255,255,255,0.2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; font-family: var(--sans); }
    .pm-tl-stage:first-child { text-align: left; }
    .pm-tl-stage:last-child { text-align: right; }
    .pm-tl-stage.done { color: rgba(255,255,255,0.5); }

    /* Mini stats */
    .pp-minis { display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 6px; margin-top: 14px; margin-bottom: 14px; }
    .pp-mini { padding: 10px 11px; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; overflow: hidden; }
    .pp-mini .v { font-family: var(--sans); font-size: 15px; font-weight: 800; letter-spacing: -.02em; color: var(--white); white-space: nowrap; }
    .pp-mini .k { font-family: var(--mono); font-size: 8px; letter-spacing: .07em; text-transform: uppercase; color: rgba(255,255,255,.4); margin-top: 5px; white-space: nowrap; }

    /* Firm bubbles inside cards */
    .pp-firms { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .pp-firm { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 13px 14px; text-decoration: none; color: inherit; display: block; transition: border-color .15s; }
    .pp-firm:hover { border-color: rgba(31,223,103,.35); }
    .pp-firm .k { font-family: var(--mono); font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.4); }
    .pp-firm .v { font-family: var(--sans); font-size: 15px; font-weight: 700; color: var(--white); margin-top: 4px; line-height: 1.25; }
    .pp-firm .go { display: inline-block; margin-top: 7px; font-family: var(--sans); font-size: 11px; color: var(--green); }
    .pp-firm-empty { cursor: default; }

    /* Top-markets + Frequent-collaborators panels */
    .leads { display:grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .lead { background: rgba(167,139,250,.04); border: 1px solid rgba(167,139,250,.22); border-radius: 14px; padding: 22px 24px; }
    .lead h3 { font-family: var(--mono); font-size: 10.5px; letter-spacing: .18em; text-transform: uppercase; color: var(--purple-bright); margin-bottom: 18px; font-weight: 700; }
    .lead-row { display:flex; justify-content: space-between; align-items: baseline; padding: 12px 0; border-top: 1px solid rgba(255,255,255,.05); }
    .lead-row:first-of-type { border-top: 0; padding-top: 4px; }
    .lead-row .name { font-family: var(--serif); font-size: 19px; font-weight: 500; color: var(--white); letter-spacing:-.012em; }
    .lead-row .name a { color: var(--white); }
    .lead-row .name a:hover { color: var(--purple-bright); text-decoration: underline; text-underline-offset:3px; }
    .lead-row .count { font-family: var(--mono); font-size: 12px; color: var(--mute); }

    /* Intel ask */
    .intel { background: linear-gradient(120deg, rgba(167,139,250,.10), rgba(255,211,0,.03)); border: 1px solid rgba(167,139,250,.32); border-radius: 18px; padding: 32px; }
    .intel-eyebrow { font-family: var(--mono); font-size: 10.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--purple-bright); margin-bottom: 14px; font-weight:600; display:inline-flex; align-items:center; gap:8px; }
    .intel-eyebrow::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--purple); box-shadow:0 0 10px var(--purple); }
    .intel h2 { font-family: var(--serif); font-size: 28px; line-height: 1.2; font-weight: 500; letter-spacing:-.018em; color: var(--white); max-width: 28ch; }
    .intel .ex { font-family:var(--mono); font-size: 11px; letter-spacing:.06em; color: var(--mute); margin-top: 16px; line-height: 1.9; }
    .intel .ex span { display:inline-block; padding: 6px 12px; margin: 4px 6px 4px 0; background: rgba(255,255,255,.04); border: 1px solid var(--hair); border-radius: 999px; font-family: var(--sans); font-size: 13px; letter-spacing: 0; text-transform: none; color: var(--cream); }
    .intel form { display:flex; gap: 10px; margin-top: 22px; }
    .intel input { flex: 1; background: rgba(0,0,0,.4); border: 1px solid rgba(167,139,250,.32); border-radius: 10px; padding: 14px 18px; font-family: var(--sans); font-size: 15px; color: var(--white); cursor: pointer; }
    .intel input:focus { outline: 0; border-color: var(--purple-bright); }
    .intel button { font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; padding: 0 24px; border-radius: 10px; background: var(--purple); color: #0a0a0a; border: 0; cursor:pointer; }
    .intel .intel-chip { cursor: pointer; transition: background .15s, border-color .15s; }
    .intel .intel-chip:hover { background: rgba(167,139,250,.12); border-color: rgba(167,139,250,.4); color: var(--white); }

    /* Related */
    .related { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
    .rel-card { background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; padding: 18px 20px; transition: border-color .15s, transform .15s; display:block; }
    .rel-card:hover { border-color: rgba(167,139,250,.4); transform: translateY(-2px); }
    .rel-card .city { font-family: var(--mono); font-size: 10px; letter-spacing:.14em; text-transform: uppercase; color: var(--mute); }
    .rel-card .name { font-family: var(--serif); font-size: 20px; font-weight: 500; letter-spacing:-.015em; color: var(--white); margin-top: 6px; line-height: 1.2; }
    .rel-card .count { font-family: var(--mono); font-size: 11px; color: var(--purple-bright); margin-top: 8px; }

    /* Pro CTA */
    .pro-cta { margin-top: 38px; padding: 32px; background: linear-gradient(120deg, rgba(255,211,0,.08), rgba(167,139,250,.04)); border: 1px solid rgba(255,211,0,.32); border-radius: 18px; display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
    .pro-cta .l { font-family: var(--serif); font-size: 19px; line-height: 1.4; color: var(--white); max-width: 50ch; font-weight: 500; }
    .pro-cta .l em { font-style: italic; color: var(--gold); font-weight: 400; }
    .pro-cta .l i { display:block; font-style:normal; font-family: var(--mono); font-size: 10.5px; letter-spacing:.16em; text-transform: uppercase; color: var(--mute); margin-top: 6px; font-weight: 600; }
    .pro-cta .go { font-family: var(--mono); font-size: 12px; letter-spacing:.12em; text-transform: uppercase; font-weight: 700; padding: 14px 24px; border-radius: 10px; background: var(--gold); color: #0a0a0a; white-space:nowrap; border:0; cursor:pointer; }

    /* Long-tail body */
    .copy { padding: 46px 0; font-family: var(--serif); font-size: 17px; line-height: 1.7; color: var(--mute-2); max-width: 72ch; font-weight: 300; }
    .copy h2 { font-size: 26px; font-weight: 500; letter-spacing:-.018em; color: var(--white); margin: 30px 0 12px; line-height: 1.2; }
    .copy h2:first-child { margin-top: 0; }
    .copy p { margin-bottom: 16px; }
    .copy a { color: var(--purple-bright); text-decoration: underline; text-underline-offset:3px; }
    .copy b { font-weight: 500; color: var(--cream); }

    /* Coverage */
    .coverage-list { display:flex; flex-direction:column; gap:8px; }
    .coverage-item { display:grid; grid-template-columns:auto 1fr auto; gap:14px; padding:14px 16px; background:rgba(255,255,255,.03); border:1px solid var(--hair); border-radius:10px; align-items:center; transition:border-color .15s; color:inherit; }
    .coverage-item:hover { border-color: rgba(167,139,250,.32); }
    .coverage-dot { width:8px; height:8px; border-radius:50%; background:var(--purple); box-shadow:0 0 8px var(--purple); }
    .coverage-title { font-family: var(--serif); font-size: 16px; font-weight: 500; color:var(--white); letter-spacing:-.01em; }
    .coverage-meta { font-family: var(--sans); font-size: 12px; color:var(--mute); margin-top:3px; }
    .coverage-meta b { color: var(--purple-bright); font-weight: 600; }
    .coverage-date { font-family: var(--mono); font-size: 11px; color:var(--mute); letter-spacing:.04em; }

    @media (max-width: 760px) {
      .wrap { padding: 0 18px; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .leads { grid-template-columns: 1fr; }
      .pro-cta { flex-direction: column; align-items: flex-start; }
      .intel form { flex-direction: column; }
      .intel button { padding: 14px 0; }
    }
"""


# Lightweight tab toggle — no framework. Toggle active class on tabs +
# data-status attribute on grid items.
JS_TABS = ""  # unused — tabs removed in v2 redesign



def e(s):
    """HTML-escape, treating None as empty string."""
    return html.escape(str(s) if s is not None else '', quote=True)


def render_firm_meta(firm):
    """Render the 'Founded · HQ · Active in X markets' meta row."""
    items = []
    founded = firm.get('founded')
    if founded:
        items.append(f'<div class="item"><span class="item-lbl">Founded</span><span>{e(founded)}</span></div>')
    hq = (firm.get('hq') or '').strip()
    if hq:
        items.append(f'<div class="item"><span class="item-lbl">HQ</span><span>{e(hq)}</span></div>')
    return '\n        '.join(items)


def render_stats(stats):
    """4-card aggregate stats grid."""
    avg_years = stats['avg_years']
    avg_str = f"{avg_years:.1f} yr" if avg_years is not None else '—'
    avg_sub = (
        f"from {stats['duration_sample_size']} project"
        f"{'s' if stats['duration_sample_size'] != 1 else ''} with start + delivery dates"
        if stats['duration_sample_size'] > 0 else 'Need more start-date data'
    )
    return f"""
    <div class="stats">
      <div class="stat-card">
        <div class="stat-val accent">{stats['total']}</div>
        <div class="stat-lbl">Projects on TMW</div>
        <div class="stat-sub">{stats['in_progress']} in progress · {stats['completed']} completed</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{fmt_thousands(stats['total_units']) if stats['total_units'] else '—'}</div>
        <div class="stat-lbl">Residential units</div>
        <div class="stat-sub">across all projects</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{fmt_thousands(stats['total_keys']) if stats['total_keys'] else '—'}</div>
        <div class="stat-lbl">Hotel keys</div>
        <div class="stat-sub">across all projects</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{avg_str}</div>
        <div class="stat-lbl">Avg years to delivery</div>
        <div class="stat-sub">{avg_sub}</div>
      </div>
    </div>"""


def render_map_cta(firm_projects, markets):
    """Lightweight CTA pointing back to the live map. On the live site, the
    firm sheet opens over the actual map so a snippet here is redundant; for
    the standalone static page it's a clear path back to the full view."""
    market_count = len(markets)
    if market_count == 0:
        sub_text = 'No mapped locations yet.'
    else:
        sub_text = f"{len(firm_projects)} pin{'s' if len(firm_projects) != 1 else ''} across {market_count} market{'s' if market_count != 1 else ''}"
    return f"""
    <div class="map-cta">
      <div class="map-cta-icon">◉</div>
      <div class="map-cta-body">
        <strong>{e(sub_text)}</strong>
        {f'· {", ".join(e(m) for m in markets[:5])}{"+" if market_count > 5 else ""}' if markets else ''}
      </div>
      <a href="{MAP_URL}" class="btn">Open on Map ↗</a>
    </div>"""


def render_project_card(p):
    """Single project card for the portfolio grid."""
    title = p.get('Title', '')
    slug = slugify(title)
    img = p.get('ImageURL', '')
    city = p.get('City', '')
    types_str = p.get('ProjectType', '')
    first_type = types_str.split(',')[0].strip() if types_str else ''
    preferred = (p.get('PreferredType') or '').strip()
    type_label = preferred or first_type
    status_key = normalize_status(p.get('Delivery', ''))
    status_label, status_color = STATUS_DISPLAY.get(status_key, ('Announced', '#9CA3AF'))
    featured = (p.get('Featured') or '').strip().lower() == 'featured'
    delivery_label = fmt_month_year(p.get('DeliveryDate', ''))

    img_style = f"background-image:url('{e(img)}')" if img else ''
    type_part = f" · {e(type_label)}" if type_label else ''
    star_html = '<div class="proj-featured">★</div>' if featured else ''

    return f"""
        <a class="proj-card" data-status="{e(status_key)}" href="/projects/{e(slug)}/">
          <div class="proj-hero" style="{img_style}">
            {star_html}
            <div class="proj-status"><span class="dot" style="background:{status_color}"></span>{e(status_label)}</div>
          </div>
          <div class="proj-body">
            <div class="proj-title">{e(title)}</div>
            <div class="proj-meta">{e(city or '—')}{type_part}</div>
            <div class="proj-foot">
              <span>Delivery</span>
              <span class="date">{e(delivery_label)}</span>
            </div>
          </div>
        </a>"""


def render_coverage_section(coverage_items):
    if not coverage_items:
        return """
    <section class="coverage-section">
      <div class="section-head"><div class="section-title">Coverage</div></div>
      <div class="empty">No articles linked to this firm's projects yet.</div>
    </section>"""

    items_html = []
    for art in coverage_items:
        date = (art.get('published_at') or '')[:10]
        items_html.append(f"""
        <a class="coverage-item" href="{e(art['url'])}" target="_blank" rel="noopener">
          <div class="coverage-dot"></div>
          <div class="coverage-info">
            <div class="coverage-title">{e(art['title'])}</div>
            <div class="coverage-meta">Mentions <b>{e(art['project_name'])}</b></div>
          </div>
          <div class="coverage-date">{e(date)}</div>
        </a>""")
    return f"""
    <section class="coverage-section">
      <div class="section-head">
        <div class="section-title">Coverage mentioning this firm</div>
      </div>
      <div class="coverage-list">{''.join(items_html)}</div>
    </section>"""


def role_label_for(roles):
    """Human label for a firm that may be an architect, a developer, or both."""
    is_arch = 'architects' in roles
    is_dev = 'developers' in roles
    if is_arch and is_dev:
        return 'Architecture & development firm'
    if is_arch:
        return 'Architecture firm'
    return 'Development firm'


# ─── Helpers for the new firm-page render (market-page parity) ─────
FEATURED_FIRM_GRID = 8

def _firm_top_cities(firm_projects, limit=6):
    """Top cities for this firm by project count."""
    c = collections.Counter((p.get('City') or '').strip() for p in firm_projects if (p.get('City') or '').strip())
    return c.most_common(limit)

def _firm_top_collaborators(firm_projects, current_slug, current_roles):
    """For an architect firm, count developer pairings (and vice versa). If the
    firm is BOTH roles, count the union from the opposite-role column on each
    project. Returns [(name, slug, n), ...] sorted by frequency."""
    # If firm is architect-only, collaborators are developers; vice versa.
    # Dual-role firms see both — we'll pull the OTHER firm regardless of role.
    devs, dev_slugs = _count_firms(firm_projects, 'Developer', 'DeveloperSlugs')
    arches, arch_slugs = _count_firms(firm_projects, 'Architect', 'ArchitectSlugs')
    combined: collections.Counter = collections.Counter()
    slugmap: dict[str, str] = {}
    for name, n in devs.items():
        if dev_slugs.get(name) == current_slug: continue   # skip self
        combined[name] += n; slugmap.setdefault(name, dev_slugs.get(name, ''))
    for name, n in arches.items():
        if arch_slugs.get(name) == current_slug: continue
        combined[name] += n; slugmap.setdefault(name, arch_slugs.get(name, ''))
    return [(name, slugmap.get(name, ''), n) for name, n in combined.most_common(4)]

def _firm_role_eyebrow(roles):
    """Eyebrow label matching the market-page style ('Live · 56 projects tracked'
    becomes 'Architecture firm · 56 projects' here)."""
    is_arch = 'architects' in roles
    is_dev  = 'developers' in roles
    if is_arch and is_dev: return 'Architecture + Development'
    if is_arch:            return 'Architecture firm'
    if is_dev:             return 'Development firm'
    return 'Studio'

def _firm_top_types(firm_projects, limit=3):
    c = collections.Counter((p.get('PreferredType') or '').strip() for p in firm_projects if (p.get('PreferredType') or '').strip())
    return c.most_common(limit)

def render_page(firm, firm_projects, stats, coverage_items):
    """Render one firm page using the market-page visual language.

    `firm` is the merged entry: {slug, name, founded, hq, roles}. Cards,
    timeline, firm bubbles, Intel ask, and Pro CTA mirror the market pages
    exactly so a visitor jumping between /markets/miami-residences/ and
    /firm/arquitectonica/ stays in the same design system.
    """
    roles = firm.get('roles') or []
    title = firm.get('name', firm.get('slug', 'Firm'))
    slug  = firm['slug']

    # Active projects (exclude Now Open from the featured grid + headlines, but
    # keep them in stats/firm scope so the visitor still sees full body of work).
    active = _exclude_completed(firm_projects)
    active_sorted = sorted(
        active,
        key=lambda p: (
            (p.get('Featured') or '').strip().lower() != 'featured',
            -(parse_year(p.get('DeliveryDate', '')) or 0),
            p.get('Title', ''),
        )
    )

    sb = _status_breakdown(firm_projects)
    top_cities = _firm_top_cities(firm_projects)
    top_types  = _firm_top_types(firm_projects)
    collabs    = _firm_top_collaborators(firm_projects, slug, roles)

    role_eyebrow = _firm_role_eyebrow(roles)
    description = (
        f"{title} on {SITE_NAME} — {stats['total']} project"
        f"{'s' if stats['total'] != 1 else ''} tracked, "
        f"{stats['in_progress']} active, {stats['completed']} completed."
    )

    cards_html = '\n'.join(market_card_html(p) for p in active_sorted[:FEATURED_FIRM_GRID])

    # Stats strip — 5 cards (tracked / UC / BG / OS / NO), gold/amber tint as in market pages
    stats_cells = [
        ('', stats['total'], 'Tracked'),
        ('uc', sb['uc'],     'Under Construction'),
        ('bg', sb['bg'],     'Breaking Ground'),
        ('os', sb['os'],     'Opening Soon'),
        ('no', sb['no'],     'Now Open'),
    ]
    stats_html = '\n'.join(
        f'<div class="stat {cls}"><div class="n">{n}</div><div class="l">{lbl}</div></div>'
        for cls, n, lbl in stats_cells
    )

    # Top cities — clickable cards into /markets/<city>/. We don't try to know
    # in this generator which city pages exist; the market generator will 404-
    # avoid by linking back to the map for cities without hubs. The simpler
    # rule: ≥3 projects in a city → link to a market page; else map fallback.
    cities_html = ''.join(
        f'<a class="rel-card" href="{(MARKET_ROOT_URL + "/markets/" + market_slugify(city) + "/") if n >= 3 else (MARKET_ROOT_URL + "/map/?q=" + e(city) + "+" + e(title))}">'
        f'<div class="city">City</div><div class="name">{e(city)}</div><div class="count">{n} project{"s" if n != 1 else ""} →</div></a>'
        for city, n in top_cities
    ) or '<div style="opacity:.55;font-family:var(--mono);font-size:11px">No mapped cities yet.</div>'

    # Collaborators — links to /firm/<other-slug>/. Skip empty-slug entries.
    if collabs:
        collab_html = '\n'.join(
            f'<div class="lead-row"><div class="name">'
            f'{f"<a href=\"{MARKET_ROOT_URL}/firm/{e(s)}/\">{e(name)}</a>" if s else e(name)}'
            f'</div><div class="count">{n} project{"s" if n != 1 else ""}</div></div>'
            for name, s, n in collabs
        )
    else:
        collab_html = '<div class="lead-row" style="opacity:.6">No frequent collaborators yet</div>'

    # Long-tail SEO body copy — dynamic, regenerated each run from current data.
    top_city_phrase = ', '.join(f'<b>{e(c)}</b> ({n})' for c, n in top_cities[:3]) or '—'
    top_type_phrase = ', '.join(f'<b>{e(t)}</b> ({n})' for t, n in top_types[:3]) or '—'
    intro = (
        f'We track <b>{stats["total"]} {role_eyebrow.lower()} project'
        f'{"s" if stats["total"] != 1 else ""}</b> by {e(title)} — '
        f'<b>{sb["uc"]} under construction</b>'
    )
    if sb['bg']: intro += f', <b>{sb["bg"]} breaking ground</b>'
    if sb['an']: intro += f', and <b>{sb["an"]} announced</b>'
    intro += '.'
    body_copy = (
        f'<h2>{e(title)} on {SITE_NAME}</h2>'
        f'<p>{intro} Most active markets: {top_city_phrase}. Specializing in: {top_type_phrase}.</p>'
        f'<h2>How we built this list</h2>'
        f'<p>Every project on this page is on the <a href="{MARKET_ROOT_URL}/map/">Map of Tomorrow</a> — our live database of new and under-construction developments worldwide. Project status, milestones (breaking ground, topping out, opening), and spec changes are sourced from public filings, official announcements, or independent reporting and timestamped. <a href="{MARKET_ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly Slippage Report, the TMW Forecast on every project, and the full firm dataset by city, neighborhood, and project type.</p>'
    )

    canonical = f'{SITE_ORIGIN}/firm/{e(slug)}/'
    og_image = (active_sorted[0].get('ImageURL') if active_sorted else '') or 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_93ffb2f000f94a12aa874fe44153be18~mv2.jpg'

    # Founded / HQ pill row (above the description) — only render if we have one
    meta_pills = []
    if firm.get('founded'): meta_pills.append(f'<span class="meta-pill"><b>Founded</b> {e(firm["founded"])}</span>')
    if firm.get('hq'):       meta_pills.append(f'<span class="meta-pill"><b>HQ</b> {e(firm["hq"])}</span>')
    meta_pills_html = f'<div class="firm-pills">{"".join(meta_pills)}</div>' if meta_pills else ''

    showing_note = f"{min(FEATURED_FIRM_GRID, len(active_sorted))} of {len(active_sorted)} we're watching closely" if len(active_sorted) > FEATURED_FIRM_GRID else f"All {len(active_sorted)} we're watching"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Cache-Control" content="no-cache, must-revalidate">
  <title>{e(title)} | {SITE_NAME}</title>
  <meta name="description" content="{e(description)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="{canonical}">

  <meta property="og:type" content="profile">
  <meta property="og:title" content="{e(title)} | {SITE_NAME}">
  <meta property="og:description" content="{e(description)}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{e(og_image)}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png" type="image/png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

  <style>{FIRM_CSS}</style>
</head>
<body>
  <!-- Universal header injected by /_shared/journal-chrome.js -->

  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">TMW</a><span class="sep">/</span>
      <a href="/firm/">Firms</a><span class="sep">/</span>
      <b>{e(title)}</b>
    </nav>

    <section class="hero">
      <div class="hero-eyebrow">{e(role_eyebrow)} · {stats['total']} project{'s' if stats['total'] != 1 else ''} tracked</div>
      <h1>{e(title)}</h1>
      {meta_pills_html}
      <p class="sub">{intro} Active in <b>{len(stats["markets"])} market{"s" if len(stats["markets"]) != 1 else ""}</b>. Every project below links to a live status page with milestones, renderings, and our <a href="{MARKET_ROOT_URL}/journal/">journal coverage</a>.</p>
    </section>

    <div class="stats" aria-label="Status breakdown">
{stats_html}
    </div>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-eyebrow">Featured projects</div>
          <h2 class="section-title">{e(showing_note)}</h2>
        </div>
        <div class="section-meta"><a class="see-all-pill" href="{MARKET_ROOT_URL}/map/?q={e(title)}">See all {stats['total']} on the map →</a></div>
      </div>
      <div class="grid tmw-project-grid">
{cards_html}
      </div>
    </section>

    <section class="section">
      <div class="leads">
        <div class="lead"><h3>Most active markets</h3>{ ''.join(f'<div class="lead-row"><div class="name">{e(city)}</div><div class="count">{n} project{"s" if n != 1 else ""}</div></div>' for city, n in top_cities[:4]) or '<div class="lead-row" style="opacity:.6">No mapped markets yet</div>' }</div>
        <div class="lead"><h3>Frequent collaborators</h3>{collab_html}</div>
      </div>
    </section>

    <section class="section">
      <div class="intel" data-intel-firm="{e(title)}">
        <div class="intel-eyebrow">TMW Intelligence</div>
        <h2>Ask anything about {e(title)}.</h2>
        <form id="firm-intel-form" autocomplete="off">
          <input id="firm-intel-input" name="q" type="text" placeholder="e.g. {e(title)} under construction in Miami" autocomplete="off" readonly>
          <button type="submit">Ask</button>
        </form>
        <div class="ex">
          Try:
          <span class="intel-chip" data-q="what is breaking ground in 2026?">what's breaking ground in 2026?</span>
          <span class="intel-chip" data-q="tallest tower in pipeline">tallest tower in pipeline</span>
          <span class="intel-chip" data-q="most active city">most active city</span>
        </div>
      </div>
    </section>

    <article class="copy">
{body_copy}
    </article>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-eyebrow">Where they're active</div>
          <h2 class="section-title">Markets {e(title)} is shaping</h2>
        </div>
        <div class="section-meta"><a href="{MARKET_ROOT_URL}/markets/">All markets →</a></div>
      </div>
      <div class="related">
{cities_html}
      </div>
    </section>

{render_coverage_section_new(coverage_items)}

    <div class="pro-cta">
      <div class="l">
        Get the full {e(title)} dataset, weekly Slippage Report, and the TMW Forecast on every project.
        <em>The part of Pro that pays for itself.</em>
        <i>Markets of Tomorrow Pro · $24/mo</i>
      </div>
      <button class="go" id="firm-pro-cta">Go Pro →</button>
    </div>
  </div>

  <script src="/_shared/journal-chrome.js" defer></script>
  <script src="/_shared/journal-dock.js" defer></script>
  <script src="/_shared/journal-search-core.js" defer></script>
  <script src="/_shared/journal-search-overlay.js" defer></script>
  <script src="/_shared/tmw-lightbox.js" defer></script>
  <script>
    // Same Intel ask wiring as the market pages. The overlay opens with the
    // firm name pre-filled so parseSmartQuery routes architect/developer
    // filtering automatically — a search for "tallest tower in pipeline"
    // from /firm/arquitectonica/ becomes "Arquitectonica tallest tower in
    // pipeline" which the parser narrows to projects whose Architect contains
    // "Arquitectonica".
    document.addEventListener('DOMContentLoaded', function () {{
      var box = document.querySelector('.intel');
      if (!box) return;
      var firmName = box.getAttribute('data-intel-firm') || '';

      function trackBeacon(q) {{
        try {{ window.tmwFunnelTrack && window.tmwFunnelTrack('intel_query', {{ source: 'firm_page', firm: firmName, q: (q || '').slice(0, 80) }}); }} catch (_){{}}
      }}
      function openSuggestionsWith() {{
        trackBeacon('');
        if (window.tmwOverlay && window.tmwOverlay.openWithPrefix) window.tmwOverlay.openWithPrefix(firmName);
        else if (window.tmwOverlay) window.tmwOverlay.open(firmName);
        else window.location = '{MARKET_ROOT_URL}/?q=' + encodeURIComponent(firmName);
      }}
      function openSearchWith(q) {{
        var full = firmName ? (firmName + (q ? ' ' + q : '')) : q;
        trackBeacon(q);
        if (window.tmwOverlay) window.tmwOverlay.open(full);
        else window.location = '{MARKET_ROOT_URL}/?q=' + encodeURIComponent(full);
      }}

      var input = document.getElementById('firm-intel-input');
      if (input) {{
        input.addEventListener('click', function (e) {{ e.preventDefault(); openSuggestionsWith(); }});
        input.addEventListener('focus', function (e) {{ e.preventDefault(); openSuggestionsWith(); input.blur(); }});
      }}
      var f = document.getElementById('firm-intel-form');
      if (f) f.addEventListener('submit', function (e) {{ e.preventDefault(); openSearchWith(((input && input.value) || '').trim()); }});
      Array.prototype.forEach.call(document.querySelectorAll('.intel-chip'), function (chip) {{
        chip.style.cursor = 'pointer';
        chip.addEventListener('click', function () {{ openSearchWith(chip.getAttribute('data-q') || chip.textContent.trim()); }});
      }});

      var go = document.getElementById('firm-pro-cta');
      if (go) go.addEventListener('click', function () {{
        try {{ window.tmwFunnelTrack && window.tmwFunnelTrack('go_pro_clicked', {{ source: 'firm_page', firm: firmName, path: location.pathname }}); }} catch (_){{}}
        if (window.tmwShowPaywall) window.tmwShowPaywall({{ source: 'firm_page' }});
        else window.location = '{MARKET_ROOT_URL}/map/?upgrade=1';
      }});
    }});
  </script>
</body>
</html>
"""


def render_coverage_section_new(coverage_items):
    """Coverage panel styled to match the market-page section shell."""
    if not coverage_items:
        return ''
    items_html = '\n'.join(
        f'<a class="coverage-item" href="{e(art["url"])}" target="_blank" rel="noopener">'
        f'<div class="coverage-dot"></div>'
        f'<div class="coverage-info"><div class="coverage-title">{e(art["title"])}</div>'
        f'<div class="coverage-meta">Mentions <b>{e(art["project_name"])}</b></div></div>'
        f'<div class="coverage-date">{e((art.get("published_at") or "")[:10])}</div></a>'
        for art in coverage_items
    )
    return f"""
    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-eyebrow">In our coverage</div>
          <h2 class="section-title">Recent journal posts</h2>
        </div>
      </div>
      <div class="coverage-list">
{items_html}
      </div>
    </section>"""


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

ROLE_SLUG_FIELD = {'architects': 'ArchitectSlugs', 'developers': 'DeveloperSlugs'}


def build_merged_firms(firms):
    """Collapse the architects[] + developers[] lists into one registry keyed by
    slug. A firm that appears under both roles (e.g. Gensler) becomes a single
    entry with roles=['architects','developers'] so it renders one unified page
    instead of overwriting itself. Slug is the merge key — verified collision-
    free across roles (no two distinct firms share a slug)."""
    merged = {}  # slug -> {slug, name, founded, hq, roles:[...]}
    for role in ('architects', 'developers'):
        for firm in firms.get(role) or []:
            slug = (firm.get('slug') or '').strip()
            if not slug:
                continue
            entry = merged.get(slug)
            if entry is None:
                entry = {'slug': slug, 'name': '', 'founded': None, 'hq': None, 'roles': []}
                merged[slug] = entry
            if role not in entry['roles']:
                entry['roles'].append(role)
            # Fill metadata from whichever role first carries it.
            if not entry['name'] and firm.get('name'):
                entry['name'] = firm.get('name')
            if not entry['founded'] and firm.get('founded'):
                entry['founded'] = firm.get('founded')
            if not entry['hq'] and firm.get('hq'):
                entry['hq'] = firm.get('hq')
    return merged


def projects_for_merged_firm(entry, projects):
    """Union of projects across all of the firm's roles, deduped by title slug."""
    seen = set()
    out = []
    for role in entry['roles']:
        for p in projects_for_firm(entry['slug'], ROLE_SLUG_FIELD[role], projects):
            key = slugify(p.get('Title', '')) or id(p)
            if key in seen:
                continue
            seen.add(key)
            out.append(p)
    return out


def main():
    print("Loading inputs...")
    projects = load_json(PROJECTS_FLAT)
    firms = load_json(FIRMS_FLAT)
    # articles.json is project_slug -> [article_obj]. Missing file is non-fatal
    # — pages just render with no coverage section content.
    articles_archive = load_json(ARTICLES_JSON, default={})
    print(f"  ✓ {len(projects)} projects, "
          f"{len(firms.get('architects', []))} architects, "
          f"{len(firms.get('developers', []))} developers, "
          f"{sum(len(v) for v in articles_archive.values() if isinstance(v, list))} article archive entries")

    merged = build_merged_firms(firms)
    dual = [s for s, e in merged.items() if len(e['roles']) > 1]
    print(f"  ✓ {len(merged)} unique firms ({len(dual)} are both architect + developer)")

    written = 0
    skipped = 0
    dual_written = 0
    print("\nGenerating firm pages → journal/firm/<slug>/ ...")
    for slug, entry in merged.items():
        firm_projects = projects_for_merged_firm(entry, projects)
        if not firm_projects:
            skipped += 1
            continue
        agg = aggregate_stats(firm_projects)
        coverage = coverage_for_firm(firm_projects, articles_archive)
        page_html = render_page(entry, firm_projects, agg, coverage)

        out_dir = os.path.join(OUTPUT_ROOT, slug)
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(page_html)
        written += 1
        if len(entry['roles']) > 1:
            dual_written += 1

    print(f"  ✓ Wrote {written} firm pages ({dual_written} unified dual-role)")
    print(f"Skipped {skipped} firms with zero referenced projects.")


if __name__ == '__main__':
    main()
