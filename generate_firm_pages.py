#!/usr/bin/env python3
"""
generate_firm_pages.py -- Firm profile page generator.

Reads firms-flat.json (architects + developers, written by fetch_projects.py),
projects-flat.json (the canonical project list with ArchitectSlugs/DeveloperSlugs
columns), and articles.json (per-project coverage archive from generate_pulse.py).
Writes one static HTML page per firm:

  /architects/<slug>/index.html
  /developers/<slug>/index.html

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

OUTPUT_ROOT = '.'  # writes architects/<slug>/index.html, developers/<slug>/index.html

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
  }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; min-height: 100vh; }
  button, input, select { font-family: inherit; }
  a { color: inherit; text-decoration: none; }

  /* Sheet aesthetic: padded from viewport edges (left/right/top), rounded
     corners on top, full-height bottom — feels like a modal pinned to the
     bottom of the viewport. On the live site this same look appears as an
     SPA modal over the map; here on the standalone static page we use a
     deep dark gradient as a stand-in for "map behind". */
  body { background: radial-gradient(ellipse at top, #0e1a14 0%, #050505 60%); }
  .sheet { background: var(--bg); border: 1px solid var(--line); border-bottom: none;
    border-radius: 18px 18px 0 0; max-width: 1200px;
    margin: 40px 24px 0; min-height: calc(100vh - 40px);
    box-shadow: 0 -20px 60px rgba(0,0,0,0.5);
    position: relative; overflow: hidden; }
  @media (min-width: 1248px) { .sheet { margin-left: auto; margin-right: auto; } }
  @media (max-width: 700px) { .sheet { margin: 60px 0 0; border-radius: 18px 18px 0 0; } }

  .sheet-handle { width: 36px; height: 4px; background: rgba(255,255,255,0.2);
    border-radius: 2px; margin: 10px auto 0; }

  .sheet-close { position: fixed; top: 56px; right: 36px; z-index: 50;
    width: 36px; height: 36px; background: rgba(20,20,20,0.92);
    border: 1px solid rgba(255,255,255,0.14); border-radius: 11px; color: #fff;
    font-size: 20px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    transition: background 0.12s, border-color 0.12s; }
  .sheet-close:hover { background: rgba(40,40,40,0.95); border-color: rgba(255,255,255,0.25); }
  @media (max-width: 700px) { .sheet-close { top: 76px; right: 16px; } }

  .page { padding: 32px 40px 80px; }
  @media (max-width: 700px) { .page { padding: 24px 20px 60px; } }

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

  footer { padding: 40px 28px; border-top: 1px solid var(--line);
    color: var(--text-faint); font-size: 11px; text-align: center; }
  footer a { color: var(--text-mute); }

  @media (max-width: 700px) {
    .firm-name { font-size: 36px; }
    .map-snippet { grid-template-columns: 1fr; }
    .topbar { padding: 14px 16px; }
    .page { padding: 0 16px; }
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


def render_map_cta(firm_projects, markets, firm_slug, role):
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
      <a href="/{role}/{e(firm_slug)}/" class="btn">Open on Map ↗</a>
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


def render_page(firm, role, firm_projects, stats, coverage_items):
    """Render the full HTML for one firm page."""
    role_label = 'Architecture firm' if role == 'architects' else 'Development firm'
    role_breadcrumb = 'Architects' if role == 'architects' else 'Developers'
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
<link rel="canonical" href="https://map.oftmw.com/{role}/{e(firm['slug'])}/">
<meta property="og:title" content="{e(title)} on Map of Tomorrow">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="https://map.oftmw.com/{role}/{e(firm['slug'])}/">
<meta property="og:type" content="profile">
<style>{CSS}</style>
</head>
<body>

<!-- Close button — sits over the sheet's rounded top-right corner. On the live
     site this same UI appears as an SPA modal where this button triggers
     history.back(); here on the standalone page it returns to the map. -->
<a href="/" class="sheet-close" aria-label="Close">×</a>

<div class="sheet">
  <div class="sheet-handle"></div>
  <div class="page">

  <div class="firm-head">
    <div class="firm-role">{role_label}</div>
    <h1 class="firm-name">{e(title)}</h1>
    <div class="firm-meta">
        {render_firm_meta(firm)}
        {f'<div class="item"><span class="item-lbl">Active in</span><span>{len(stats["markets"])} market{"s" if len(stats["markets"]) != 1 else ""}</span></div>' if stats['markets'] else ''}
    </div>
  </div>

  {render_stats(stats)}

  {render_map_cta(firm_projects, stats['markets'], firm['slug'], role)}

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
</div>

<footer style="text-align:center; padding: 32px 28px 80px; color: var(--text-faint); font-size: 11px;">
  Map of Tomorrow · Independent index of the construction pipeline ·
  <a href="https://oftmw.com" style="color: var(--text-mute);">oftmw.com</a>
</footer>

<script>{JS_TABS}</script>

</body>
</html>
"""


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

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

    stats_per_role = {'architects': 0, 'developers': 0, 'skipped_no_projects': 0}

    for role, slug_field, dir_name in [
        ('architects', 'ArchitectSlugs', 'architects'),
        ('developers', 'DeveloperSlugs', 'developers'),
    ]:
        print(f"\nGenerating {role} pages...")
        firm_list = firms.get(role) or []
        for firm in firm_list:
            firm_slug = (firm.get('slug') or '').strip()
            if not firm_slug:
                continue
            firm_projects = projects_for_firm(firm_slug, slug_field, projects)
            if not firm_projects:
                stats_per_role['skipped_no_projects'] += 1
                continue
            agg = aggregate_stats(firm_projects)
            coverage = coverage_for_firm(firm_projects, articles_archive)
            page_html = render_page(firm, role, firm_projects, agg, coverage)

            out_dir = os.path.join(OUTPUT_ROOT, dir_name, firm_slug)
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, 'index.html')
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(page_html)
            stats_per_role[role] += 1

        print(f"  ✓ Wrote {stats_per_role[role]} {role} pages")

    print(f"\nSkipped {stats_per_role['skipped_no_projects']} firms with zero referenced projects.")
    total = stats_per_role['architects'] + stats_per_role['developers']
    print(f"Total firm pages: {total}")


if __name__ == '__main__':
    main()
