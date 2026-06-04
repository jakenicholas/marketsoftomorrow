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

import html
import json
import os
import re
import statistics
import sys
from collections import defaultdict


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

CSS = """
  :root {
    --accent: #1FDF67;
    --warn: #FFD300;
    --orange: #FF9500;
    --blue: #4DABFF;
    --intel: #A78BFA;
    --bg: #0a0a0a;
    --surface: #141414;
    --surface-2: #1a1a1a;
    --surface-3: #222;
    --line: rgba(255,255,255,0.08);
    --line-strong: rgba(255,255,255,0.14);
    --text: #fff;
    --text-mute: rgba(255,255,255,0.62);
    --text-faint: rgba(255,255,255,0.4);
    /* Tokens the shared chrome (header/dock/auth) expects. Mirrors the rest of
       the journal so the universal header paints identically here. */
    --ink: #070807; --ink-2: #0d0f0e;
    --hair: rgba(255,255,255,.08); --hair-2: rgba(255,255,255,.14);
    --white: #fff; --cream: #ECEAE5; --mute: #9AA39C; --mute-2: #C2C9C3;
    --green: #1FDF67;
    --gold: #e6c574; --gold-soft: #f0d68a;
    --mono: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { background: var(--ink); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; min-height: 100vh; }
  button, input, select { font-family: inherit; }
  a { color: inherit; text-decoration: none; }

  /* Full-page layout: the shared chrome header (journal-chrome.js) sits at the
     top of <body> and stays visible; the firm content flows beneath it in a
     centered column — no floating sheet, no "modal over the map" gradient. */
  .firm-page { position: relative; max-width: 1200px; margin: 0 auto;
    padding: 28px 40px 90px; }
  @media (max-width: 700px) { .firm-page { padding: 18px 20px 70px; } }

  /* Close (×) — returns the visitor to the page they came from. Anchored to the
     top-right of the content, just under the global header. */
  .firm-close { position: absolute; top: 20px; right: 40px; z-index: 5;
    width: 38px; height: 38px; background: var(--surface);
    border: 1px solid var(--line-strong); border-radius: 11px; color: #fff;
    font-size: 20px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, border-color 0.12s; }
  .firm-close:hover { background: var(--surface-3); border-color: rgba(255,255,255,0.3); }
  @media (max-width: 700px) { .firm-close { top: 12px; right: 20px; width: 34px; height: 34px; } }

  .firm-head { padding: 28px 0 28px; }
  .firm-role { font-size: 11px; color: var(--text-faint); font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.1em; }
  .firm-name { font-size: 56px; font-weight: 800; letter-spacing: -0.025em;
    line-height: 1.0; margin: 8px 0 16px;
    background: linear-gradient(180deg, #fff 0%, rgba(255,255,255,0.6) 100%);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
  .firm-meta { display: flex; gap: 18px; flex-wrap: wrap;
    color: var(--text-mute); font-size: 13px; }
  .firm-meta .item { display: flex; align-items: center; gap: 7px; }
  .firm-meta .item-lbl { color: var(--text-faint); font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px; margin: 28px 0 40px; }
  .stat-card { background: var(--surface); border: 1px solid var(--line);
    border-radius: 14px; padding: 18px 20px; }
  .stat-val { font-size: 32px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.05;
    font-variant-numeric: tabular-nums; }
  .stat-val.accent { color: var(--accent); }
  .stat-lbl { font-size: 11px; color: var(--text-faint); font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.07em; margin-top: 8px; }
  .stat-sub { font-size: 11px; color: var(--text-mute); margin-top: 2px; }

  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); margin-bottom: 28px; }
  .tab { padding: 12px 18px; background: transparent; border: none;
    color: var(--text-mute); font-size: 13px; font-weight: 600; cursor: pointer;
    border-bottom: 2px solid transparent; display: flex; align-items: center; gap: 8px; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .tab .count { font-size: 10px; color: var(--text-faint); background: var(--surface-3);
    padding: 1px 7px; border-radius: 100px; font-weight: 700; }
  .tab.active .count { color: var(--accent); background: rgba(31,223,103,0.12); }

  /* "Open on Map" CTA — replaces the faux-map snippet (the real map is the
     background on the live site; on the standalone page we just link out). */
  .map-cta { background: var(--surface); border: 1px solid var(--line);
    border-radius: 12px; padding: 16px 20px; margin-bottom: 28px;
    display: flex; align-items: center; gap: 14px; }
  .map-cta-icon { width: 36px; height: 36px; border-radius: 10px;
    background: rgba(31,223,103,0.1); border: 1px solid rgba(31,223,103,0.25);
    color: var(--accent); display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0; }
  .map-cta-body { flex: 1; font-size: 12.5px; color: var(--text-mute); line-height: 1.5; }
  .map-cta .btn { padding: 8px 14px; background: var(--accent); color: #000;
    font-size: 12px; font-weight: 700; border-radius: 8px; flex-shrink: 0; }
  .map-cta .btn:hover { background: #2BE875; }

  .section-head { display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 14px; }
  .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--text-faint); }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px; margin-bottom: 40px; }
  .proj-card { background: var(--surface); border: 1px solid var(--line);
    border-radius: 12px; overflow: hidden; cursor: pointer; transition: all 0.18s;
    display: block; color: inherit; text-decoration: none; }
  .proj-card:hover { border-color: var(--line-strong); transform: translateY(-2px);
    box-shadow: 0 12px 30px rgba(0,0,0,0.4); }
  .proj-hero { aspect-ratio: 16/10;
    background: linear-gradient(135deg, var(--surface-2), var(--surface-3));
    background-size: cover; background-position: center; position: relative; }
  .proj-status { position: absolute; bottom: 8px; left: 8px;
    background: rgba(0,0,0,0.78); border: 1px solid rgba(255,255,255,0.15);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    padding: 3px 9px; border-radius: 100px; font-size: 9.5px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em; color: #fff;
    display: flex; align-items: center; gap: 5px; }
  .proj-status .dot { width: 6px; height: 6px; border-radius: 50%; }
  .proj-featured { position: absolute; top: 8px; right: 8px;
    background: rgba(255,211,0,0.18); border: 1px solid rgba(255,211,0,0.4);
    width: 22px; height: 22px; border-radius: 6px; display: flex;
    align-items: center; justify-content: center; color: var(--warn); font-size: 11px;
    backdrop-filter: blur(8px); }
  .proj-body { padding: 12px 14px 14px; }
  .proj-title { font-size: 14px; font-weight: 700; line-height: 1.25;
    overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .proj-meta { font-size: 11.5px; color: var(--text-mute); margin-top: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-foot { font-size: 11px; color: var(--text-faint); margin-top: 7px;
    padding-top: 7px; border-top: 1px solid var(--line); display: flex;
    justify-content: space-between; }
  .proj-foot .date { color: var(--text); font-weight: 600; }

  .coverage-section { margin: 40px 0 80px; }
  .coverage-list { display: flex; flex-direction: column; gap: 8px; }
  .coverage-item { display: grid; grid-template-columns: auto 1fr auto;
    gap: 14px; padding: 14px 16px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 10px; align-items: center;
    transition: border-color 0.15s; cursor: pointer; color: inherit;
    text-decoration: none; }
  .coverage-item:hover { border-color: var(--line-strong); }
  .coverage-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .coverage-info { min-width: 0; }
  .coverage-title { font-size: 13px; font-weight: 600; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .coverage-meta { font-size: 11px; color: var(--text-faint); margin-top: 3px; }
  .coverage-meta b { color: var(--accent); font-weight: 700; }
  .coverage-date { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums;
    white-space: nowrap; }

  .empty { padding: 40px 20px; text-align: center; color: var(--text-faint); font-size: 12.5px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }

  @media (max-width: 700px) {
    .firm-name { font-size: 36px; }
    .map-snippet { grid-template-columns: 1fr; }
  }
"""

# Lightweight tab toggle — no framework. Toggle active class on tabs +
# data-status attribute on grid items.
JS_TABS = """
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      const active = t.dataset.tab;
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.proj-card').forEach(c => {
        const isOpen = c.dataset.status === 'open';
        const show = active === 'all' || (active === 'in-progress' && !isOpen) || (active === 'completed' && isOpen);
        c.style.display = show ? '' : 'none';
      });
    });
  });
"""


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


def render_page(firm, firm_projects, stats, coverage_items):
    """Render the full HTML for one firm page.

    `firm` is a merged entry: {slug, name, founded, hq, roles:[...]} where
    `roles` is a subset of {'architects','developers'} — a firm that is both
    renders one unified page.
    """
    roles = firm.get('roles') or []
    role_label = role_label_for(roles)
    title = firm.get('name', firm.get('slug', 'Firm'))

    # Page <title> + meta description for SEO
    description = (
        f"{title} on Map of Tomorrow — {stats['total']} project"
        f"{'s' if stats['total'] != 1 else ''} tracked, including "
        f"{stats['in_progress']} in progress and {stats['completed']} completed."
    )

    # Sort portfolio: featured first, then by delivery_date desc
    sorted_projects = sorted(
        firm_projects,
        key=lambda p: (
            (p.get('Featured') or '').strip().lower() != 'featured',
            -(parse_year(p.get('DeliveryDate', '')) or 0),
            p.get('Title', ''),
        )
    )

    project_cards_html = '\n'.join(render_project_card(p) for p in sorted_projects)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="{e(description)}">
<title>{e(title)} · Map of Tomorrow</title>
<link rel="canonical" href="{SITE_ORIGIN}/firm/{e(firm['slug'])}/">
<meta property="og:title" content="{e(title)} on Map of Tomorrow">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{SITE_ORIGIN}/firm/{e(firm['slug'])}/">
<meta property="og:type" content="profile">
<style>{CSS}</style>
</head>
<body>

<!-- The shared chrome (journal-chrome.js) injects the universal site header at
     the top of <body> and the footer at the bottom; the firm content sits in a
     full-width page between them. -->
<div class="firm-page">

  <!-- × returns the visitor to the page they came from (see tmwFirmBack). -->
  <button class="firm-close" type="button" aria-label="Go back" onclick="tmwFirmBack()">×</button>

  <div class="firm-head">
    <div class="firm-role">{role_label}</div>
    <h1 class="firm-name">{e(title)}</h1>
    <div class="firm-meta">
        {render_firm_meta(firm)}
        {f'<div class="item"><span class="item-lbl">Active in</span><span>{len(stats["markets"])} market{"s" if len(stats["markets"]) != 1 else ""}</span></div>' if stats['markets'] else ''}
    </div>
  </div>

  {render_stats(stats)}

  {render_map_cta(firm_projects, stats['markets'])}

  <div class="tabs">
    <button class="tab active" data-tab="all">All projects <span class="count">{stats['total']}</span></button>
    <button class="tab" data-tab="in-progress">In progress <span class="count">{stats['in_progress']}</span></button>
    <button class="tab" data-tab="completed">Completed <span class="count">{stats['completed']}</span></button>
  </div>

  <div class="section-head">
    <div class="section-title">Portfolio</div>
  </div>

  <div class="grid">{project_cards_html}</div>

  {render_coverage_section(coverage_items)}

</div>

<script>{JS_TABS}
// × → return to wherever the visitor came from (their last view). If the page
// was opened directly (no in-site history, e.g. a Google result or fresh tab),
// fall back to the live map.
function tmwFirmBack(){{
  if (window.history.length > 1) {{ history.back(); }}
  else {{ window.location.href = '{MAP_URL}'; }}
}}
</script>

<!-- Universal site chrome: header + footer + auth (same as every journal page). -->
<script src="/_shared/journal-chrome.js" defer></script>
<script src="/_shared/journal-dock.js" defer></script>

</body>
</html>
"""


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
