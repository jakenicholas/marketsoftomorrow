#!/usr/bin/env python3
"""
TMW Market Pages Generator — SEO programmatic pages
=====================================================

Reads projects-flat.json (the same data fetch_projects.py produces) and
emits one HTML page per market slice:

  /markets/<city-slug>-<type-slug>/    e.g. /markets/miami-residences/
  /markets/<city-slug>/                e.g. /markets/west-palm-beach/
  /markets/by-type/<type-slug>/        e.g. /markets/by-type/hotel/
  /markets/                            hub linking everything

Thresholds:
  - city × type: ≥3 projects
  - city only:   ≥5 projects
  - type only:   always (12 types)

Within each page, projects are sorted:
  1. Featured first (the "Featured" column from the sheet, value == "Featured")
  2. Then by status priority (Under Construction → Breaking Ground → Opening
     Soon → Now Open → Announced)
  3. Then by Title alphabetically as a stable tiebreaker

Each generated page:
  - Uses the universal /_shared/journal-chrome.js header
  - Wires /_shared/tmw-lightbox.js so project images zoom on click
  - Fires funnel beacons via window.tmwFunnelTrack (loaded transitively)
  - Includes JSON-LD CollectionPage + BreadcrumbList + ItemList for SERP
  - Cross-links to adjacent markets in the same city or type for interlink

Hooked into .github/workflows/generate-pages.yml as a separate step after
generate_pages.py so it always runs against the freshest projects-flat.json.

Run locally:  python3 generate_market_pages.py
"""
from __future__ import annotations
import json, os, re, html, collections, datetime, sys

# Reuse the project page's timeline + delivery formatters so every card on a
# market page mirrors the project page's hero panel exactly. generate_pages.py
# guards its main() under __name__ == '__main__', so importing it here is safe.
from generate_pages import (
    progress_bar_html,
    format_delivery_display,
    _format_time_to_delivery,
)

ROOT_URL   = "https://www.oftmw.com"
SITE_NAME  = "Markets of Tomorrow"
OUTPUT_DIR = "journal/markets"
DEFAULT_IMAGE = "https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_93ffb2f000f94a12aa874fe44153be18~mv2.jpg"

# Status priority (lower = higher on the page)
STATUS_PRIORITY = {
    'Under Construction': 0,
    'Breaking Ground':    1,
    'Opening Soon':       2,
    'Now Open':           3,
    'Announced':          4,
}
STATUS_COLOR = {
    'Under Construction': '#FFB45E',
    'Breaking Ground':    '#FFD300',
    'Opening Soon':       '#C4B5FD',
    'Now Open':           '#1FDF67',
    'Announced':          '#9AA39C',
}
STATUS_CSS_CLASS = {
    'Under Construction': 'pill-uc',
    'Breaking Ground':    'pill-bg',
    'Opening Soon':       'pill-os',
    'Now Open':           'pill-no',
    'Announced':          'pill-an',
}

CITY_TYPE_MIN = 3
CITY_MIN      = 3            # lowered from 5 so smaller-but-real cities (Aventura, Tokyo, etc.) get hubs
FEATURED_GRID_TARGET = 8     # cards are now 2-column with full timelines, so fewer per page

# ─── Type label tweaks for natural English SEO H1s ───────────────────
TYPE_PHRASING = {
    'Residences':   'Luxury Condos & Residences',
    'Hotel':        'Luxury Hotels',
    'Mixed-Use':    'Mixed-Use Developments',
    'Entertainment':'Entertainment Districts',
    'Office':       'Office Developments',
    'Golf':         'Golf Clubs & Communities',
    'Stadium':      'Stadiums & Arenas',
    'Park':         'Parks & Public Spaces',
    'Travel':       'Airports & Travel Hubs',
    'Museum':       'Museums & Cultural Venues',
    'Education':    'Campuses & Education',
    'Resort':       'Resorts',
}

# ─── Utilities ─────────────────────────────────────────────────────────
def slugify(s: str) -> str:
    s = (s or '').strip().lower()
    s = re.sub(r"[^a-z0-9\s-]", '', s)
    s = re.sub(r"[\s-]+", '-', s).strip('-')
    return s

def esc(s: str) -> str:
    return html.escape(str(s or ''), quote=True)

def is_featured(p: dict) -> bool:
    return str(p.get('Featured', '') or '').strip().lower() in {'featured','true','1','yes','y'}

def status_rank(p: dict) -> int:
    return STATUS_PRIORITY.get((p.get('Delivery') or '').strip(), 99)

def has_image(p: dict) -> bool:
    return bool((p.get('ImageURL') or '').strip())

def project_image(p: dict) -> str:
    return (p.get('ImageURL') or '').strip() or DEFAULT_IMAGE

def short_developer(p: dict) -> str:
    """First developer name from a comma list, trimmed for card display."""
    dev = (p.get('Developer') or '').split(',')[0].strip()
    return dev or '—'

def short_architect(p: dict) -> str:
    arch = (p.get('Architect') or '').split(',')[0].strip()
    return arch or ''

def status_pill(p: dict) -> str:
    d = (p.get('Delivery') or 'Announced').strip()
    cls = STATUS_CSS_CLASS.get(d, 'pill-an')
    return f'<span class="card-status-pill {cls}">{esc(d)}</span>'

# ─── Sorting (Featured-first, then status, then title) ──────────────
def sort_projects(projects: list[dict]) -> list[dict]:
    return sorted(
        projects,
        key=lambda p: (
            0 if is_featured(p) else 1,
            status_rank(p),
            (p.get('Title') or '').lower(),
        ),
    )

# ─── Bucket builders ──────────────────────────────────────────────────
def bucket_projects(projects: list[dict]):
    by_city_type: dict[tuple[str,str], list[dict]] = collections.defaultdict(list)
    by_city:      dict[str, list[dict]]            = collections.defaultdict(list)
    by_type:      dict[str, list[dict]]            = collections.defaultdict(list)
    for p in projects:
        city = (p.get('City') or '').strip()
        ptype = (p.get('PreferredType') or '').strip()
        if city and ptype: by_city_type[(city, ptype)].append(p)
        if city:           by_city[city].append(p)
        if ptype:          by_type[ptype].append(p)
    return by_city_type, by_city, by_type

# ─── Page render helpers ──────────────────────────────────────────────
FEAT_STAR_SVG = (
    '<svg viewBox="0 0 24 24" aria-hidden="true">'
    '<path d="M12 2.5l2.95 6.55 7.18.75-5.35 4.82 1.55 7.05L12 18l-6.33 3.67 1.55-7.05L1.87 9.8l7.18-.75L12 2.5z"/>'
    '</svg>'
)

# ─── Per-firm bubble (mirrors the project page's .pp-firm) ───────────
def _firm_bubble(label: str, names_str: str, slugs_str: str) -> str:
    """Render one firm card (DEVELOPER or ARCHITECT). Takes the comma-separated
    names + slugs from the sheet, links to the first firm's /firm/<slug>/
    page when a slug exists. Matches the project page's .pp-firm class so
    the same CSS rules apply."""
    name = (names_str or '').split(',')[0].strip()
    if not name:
        return (
            f'<div class="pp-firm pp-firm-empty"><div class="k">{esc(label)}</div>'
            f'<div class="v" style="opacity:.45">—</div></div>'
        )
    slug = (slugs_str or '').split(',')[0].strip()
    inner = (
        f'<div class="k">{esc(label)}</div>'
        f'<div class="v">{esc(name)}</div>'
        f'<span class="go">View firm profile →</span>'
    )
    if slug:
        return f'<a class="pp-firm" href="{ROOT_URL}/firm/{esc(slug)}/">{inner}</a>'
    # No slug — render as a non-link card to keep the visual grid intact.
    return f'<div class="pp-firm">{inner}</div>'

def _mini_stat(label: str, value: str) -> str:
    if not value:
        return ''
    return f'<div class="pp-mini"><div class="v">{esc(value)}</div><div class="k">{esc(label)}</div></div>'

def _last_verified(p: dict) -> str:
    """Format the UpdatedAt timestamp as 'Jun 10, 2026'."""
    raw = (p.get('UpdatedAt') or '').strip()
    if not raw: return ''
    try:
        if raw.isdigit():
            dt = datetime.datetime.fromtimestamp(int(raw), datetime.timezone.utc)
        else:
            dt = datetime.datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return dt.strftime('%b %-d, %Y')
    except Exception:
        return raw[:10]

def card_html(p: dict) -> str:
    title = esc(p.get('Title') or '')
    slug  = (p.get('Slug') or slugify(p.get('Title') or '')).strip()
    img   = esc(project_image(p))
    city  = esc((p.get('City') or '').strip())
    neigh = (p.get('Neighborhood') or '').strip()
    loc_line = f'{city} · {esc(neigh)}' if neigh else city
    cap   = esc(f"{p.get('Title','')} · {p.get('City','')}")
    featured = is_featured(p)
    featured_attrs = ' data-featured="1"' if featured else ''
    feat_badge = f'<span class="card-feat-badge" aria-label="Featured project">{FEAT_STAR_SVG}</span>' if featured else ''

    # Construction timeline + mini stats — shape mirrors the project page hero
    # panel exactly so the data presented here matches the source of truth.
    delivery       = (p.get('Delivery') or '').strip()
    delivery_date  = (p.get('DeliveryDate') or '').strip()
    start_date     = (p.get('StartDate') or '').strip()
    timeline_html  = progress_bar_html(delivery, delivery_date, start_date)
    last_verified  = _last_verified(p)
    last_v_html = (
        '<div class="card-verified"><span class="card-v-ico"><svg viewBox="0 0 100 100"><polygon class="card-v-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/></svg></span>'
        f'<span>Last verified {esc(last_verified)}</span></div>'
    ) if last_verified else ''

    # Mini stats — start year / completion year / units / floors. Omit any
    # missing field rather than render a "—" placeholder so cards with rich
    # data feel rich and cards without don't shout about gaps.
    def _year(s):
        m = re.match(r'^(\d{4})', s or '')
        return m.group(1) if m else ''
    minis = ''.join([
        _mini_stat('Start',      _year(start_date)),
        _mini_stat('Completion', _year(delivery_date) or format_delivery_display(delivery_date or delivery)),
        _mini_stat('Units',      str(p.get('Units') or '').strip()),
        _mini_stat('Floors',     str(p.get('Floors') or '').strip()),
    ])
    minis_html = f'<div class="pp-minis">{minis}</div>' if minis else ''

    # Developer + Architect bubbles
    firms_html = (
        '<div class="pp-firms">'
        + _firm_bubble('Developer', p.get('Developer', ''), p.get('DeveloperSlugs', ''))
        + _firm_bubble('Architect', p.get('Architect', ''), p.get('ArchitectSlugs', ''))
        + '</div>'
    )

    return (
        f'<a class="card{" featured" if featured else ""}" href="{ROOT_URL}/projects/{esc(slug)}/"{featured_attrs}>\n'
        f'  <div class="card-img" data-lightbox-src="{img}" data-lightbox-caption="{cap}" style="background-image:url(\'{img}\')">{feat_badge}</div>\n'
        f'  <div class="card-body">\n'
        f'    <div class="card-title">{title}</div>\n'
        f'    <div class="card-loc">{loc_line}</div>\n'
        f'    {last_v_html}\n'
        f'    {timeline_html}\n'
        f'    {minis_html}\n'
        f'    {firms_html}\n'
        f'  </div>\n'
        f'</a>'
    )

def stats_strip_html(projects: list[dict]) -> str:
    counts = collections.Counter((p.get('Delivery') or 'Unknown').strip() for p in projects)
    cells = [('Tracked', len(projects), '')]
    for s in ['Under Construction', 'Breaking Ground', 'Opening Soon', 'Now Open']:
        cells.append((s, counts.get(s, 0), {'Under Construction':'uc','Breaking Ground':'bg','Opening Soon':'os','Now Open':'no'}[s]))
    return '\n'.join(
        f'<div class="stat {cls}"><div class="n">{n}</div><div class="l">{label}</div></div>'
        for label, n, cls in cells
    )

def _count_firms(projects: list[dict], name_field: str, slug_field: str) -> tuple[collections.Counter, dict[str,str]]:
    """Tally how many projects each firm appears on, and remember its slug.

    `Developer` and `Architect` columns are comma-separated lists; `*Slugs`
    are the matched slugs at the same indices. We pair them positionally so
    the firm card can link straight to /firm/<slug>/."""
    counts: collections.Counter = collections.Counter()
    slug_map: dict[str, str] = {}
    for p in projects:
        names = [n.strip() for n in (p.get(name_field) or '').split(',') if n.strip()]
        slugs = [s.strip() for s in (p.get(slug_field) or '').split(',')]
        for i, name in enumerate(names):
            counts[name] += 1
            if i < len(slugs) and slugs[i]:
                slug_map.setdefault(name, slugs[i])
    return counts, slug_map

def top_firms_html(projects: list[dict]) -> str:
    devs,   dev_slugs  = _count_firms(projects, 'Developer', 'DeveloperSlugs')
    arches, arch_slugs = _count_firms(projects, 'Architect', 'ArchitectSlugs')

    def firm_row(name: str, slug_map: dict[str,str], n: int) -> str:
        slug = slug_map.get(name)
        link = f'<a href="{ROOT_URL}/firm/{esc(slug)}/">{esc(name)}</a>' if slug else esc(name)
        return f'<div class="lead-row"><div class="name">{link}</div><div class="count">{n} project{"s" if n != 1 else ""}</div></div>'

    dev_rows  = ''.join(firm_row(n, dev_slugs, c)  for n, c in devs.most_common(4)) or '<div class="lead-row" style="opacity:.6">No developer data yet</div>'
    arch_rows = ''.join(firm_row(n, arch_slugs, c) for n, c in arches.most_common(4)) or '<div class="lead-row" style="opacity:.6">No architect data yet</div>'
    return (
        '<div class="leads">\n'
        f'  <div class="lead"><h3>Most active developers</h3>{dev_rows}</div>\n'
        f'  <div class="lead"><h3>Most active architects</h3>{arch_rows}</div>\n'
        '</div>'
    )

def schema_jsonld(title: str, desc: str, url: str, items: list[dict], crumbs: list[tuple[str,str|None]]) -> str:
    item_list = [
        {
            "@type": "ListItem",
            "position": i + 1,
            "url": f"{ROOT_URL}/projects/{(it.get('Slug') or '').strip()}/",
            "name": it.get('Title') or '',
        }
        for i, it in enumerate(items[:10])
    ]
    crumb_list = []
    for i, (name, link) in enumerate(crumbs):
        node = {"@type": "ListItem", "position": i + 1, "name": name}
        if link: node["item"] = link
        crumb_list.append(node)
    payload = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": title,
        "description": desc,
        "url": url,
        "publisher": {"@type": "Organization", "name": SITE_NAME, "url": ROOT_URL},
        "mainEntity": {"@type": "ItemList", "numberOfItems": len(items), "itemListElement": item_list},
        "breadcrumb": {"@type": "BreadcrumbList", "itemListElement": crumb_list},
    }
    return json.dumps(payload, ensure_ascii=False)

# ─── Page templates ───────────────────────────────────────────────────
def render_page(
    *,
    h1: str,
    title_tag: str,
    meta_desc: str,
    canonical_path: str,        # eg /markets/miami-residences/
    breadcrumbs: list[tuple[str, str|None]],
    eyebrow: str,
    intro_html: str,            # serif sub paragraph
    projects: list[dict],       # sorted (featured-first)
    total_count: int,           # total tracked in bucket (not just shown)
    related_cities: list[tuple[str,str,int,str]],  # (eyebrow, name, count, href)
    more_types: list[tuple[str,str,int,str]],      # same shape, optional
    map_search: str,            # for the Intel ask form (query prefix)
    intel_city: str,            # city to pre-filter overlay results
    intel_type: str,            # type to pre-filter overlay results
    body_copy_html: str,        # long-tail SEO prose
) -> str:
    canonical = ROOT_URL + canonical_path
    og_image = project_image(projects[0]) if projects else DEFAULT_IMAGE
    crumbs_html = ' <span class="sep">/</span> '.join(
        f'<a href="{esc(link)}">{esc(name)}</a>' if link else f'<b>{esc(name)}</b>'
        for name, link in breadcrumbs
    )
    ld = schema_jsonld(title_tag.split(' | ')[0], meta_desc, canonical, projects, breadcrumbs)
    cards_html = '\n'.join(card_html(p) for p in projects[:FEATURED_GRID_TARGET])
    firms_html = top_firms_html(projects)
    stats_html = stats_strip_html(projects)
    related_html = ''.join(
        f'<a class="rel-card" href="{esc(href)}"><div class="city">{esc(eyebrow)}</div><div class="name">{esc(name)}</div><div class="count">{n} tracked →</div></a>'
        for eyebrow, name, n, href in related_cities
    ) or '<div style="opacity:.55;font-family:var(--mono);font-size:11px">More markets coming.</div>'
    more_types_html = ''.join(
        f'<a class="rel-card" href="{esc(href)}"><div class="city">{esc(eyebrow)}</div><div class="name">{esc(name)}</div><div class="count">{n} tracked →</div></a>'
        for eyebrow, name, n, href in more_types
    )
    # Only render the "More project types" section when we have something to put in it
    more_types_section = (
        '    <section class="section">\n'
        '      <div class="section-head">\n'
        '        <div>\n'
        '          <div class="section-eyebrow">Same city, different category</div>\n'
        f'          <h2 class="section-title">More project types{f" in {esc(intel_city)}" if intel_city else ""}</h2>\n'
        '        </div>\n'
        '      </div>\n'
        f'      <div class="related">\n{more_types_html}\n      </div>\n'
        '    </section>\n'
    ) if more_types else ''
    showing_note = f'12 of {total_count} we\'re watching closely' if total_count > FEATURED_GRID_TARGET else f'All {total_count} we\'re watching'
    see_all_link = f'<a href="{ROOT_URL}/map/?q={esc(map_search)}">See all {total_count} on the map →</a>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Cache-Control" content="no-cache, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <title>{esc(title_tag)}</title>
  <meta name="description" content="{esc(meta_desc)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="{esc(canonical)}">

  <meta property="og:type" content="website">
  <meta property="og:title" content="{esc(title_tag.split(' | ')[0])}">
  <meta property="og:description" content="{esc(meta_desc)}">
  <meta property="og:url" content="{esc(canonical)}">
  <meta property="og:image" content="{esc(og_image)}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png" type="image/png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

  <script type="application/ld+json">{ld}</script>

  <style>
    :root {{
      --ink:#0d0d0d; --panel:#141714;
      --hair:rgba(255,255,255,.08); --hair-2:rgba(255,255,255,.14);
      --white:#fff; --cream:#ECEAE5; --mute:#9AA39C; --mute2:#9AA39C; --mute-2:#C2C9C3;
      --green:#1FDF67; --gold:#FFD300; --amber:#FFB45E;
      --purple:#A78BFA; --purple-bright:#C4B5FD; --purple-glow:#B9A6FF;
      --ink-2:#0d0f0e; --glass:rgba(20,23,20,.6);
      --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      --serif:'Fraunces',Georgia,serif;
      --mono:'JetBrains Mono','SF Mono',ui-monospace,monospace;
    }}
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ background: var(--ink); color: var(--cream); font-family: var(--sans); -webkit-font-smoothing:antialiased; line-height:1.55; }}
    body::before {{ content:""; position:fixed; inset:0; z-index:0; pointer-events:none;
      background:
        radial-gradient(820px 540px at 76% -6%, rgba(167,139,250,.10), transparent 60%),
        radial-gradient(700px 480px at 4% 58%, rgba(255,211,0,.04), transparent 60%);
    }}
    a {{ color: inherit; text-decoration: none; }}
    .wrap {{ position:relative; z-index:1; max-width: 1200px; margin: 0 auto; padding: 0 24px; }}

    /* Breadcrumb */
    .crumbs {{ padding: 22px 0 0; font-family: var(--mono); font-size: 11px; letter-spacing:.1em; text-transform:uppercase; color: var(--mute); }}
    .crumbs a:hover {{ color: var(--white); }}
    .crumbs .sep {{ opacity: .4; margin: 0 8px; }}
    .crumbs b {{ color: var(--purple-bright); font-weight: 500; }}

    /* Hero */
    .hero {{ padding: 30px 0 38px; border-bottom:1px solid var(--hair); }}
    .hero-eyebrow {{ font-family:var(--mono); font-size:10.5px; letter-spacing:.2em; text-transform:uppercase; color:var(--purple-bright); margin-bottom:18px; display:inline-flex; align-items:center; gap:9px; }}
    .hero-eyebrow::before {{ content:""; width:6px; height:6px; border-radius:50%; background:var(--purple); box-shadow:0 0 10px var(--purple); }}
    .hero h1 {{ font-family:var(--serif); font-size:clamp(36px, 5.4vw, 64px); line-height:1.04; font-weight:500; letter-spacing:-.022em; color:var(--white); max-width:20ch; }}
    .hero .sub {{ font-family:var(--serif); font-style:italic; font-weight:300; font-size:20px; color:var(--mute-2); margin-top:18px; line-height:1.5; max-width:62ch; }}
    .hero .sub b {{ font-style:normal; font-weight:500; color:var(--white); }}
    .hero .sub a {{ color:var(--purple-bright); text-decoration:underline; text-underline-offset:3px; text-decoration-thickness:1px; }}

    /* Stats */
    .stats {{ display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; padding: 32px 0; border-bottom:1px solid var(--hair); }}
    .stat {{ background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; padding: 18px; }}
    .stat .n {{ font-family:var(--serif); font-size: 32px; font-weight: 500; letter-spacing:-.018em; color: var(--white); line-height: 1; }}
    .stat .l {{ font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color: var(--mute); margin-top: 10px; }}
    .stat.uc .n {{ color: var(--amber); }}
    .stat.bg .n {{ color: var(--gold); }}
    .stat.os .n {{ color: var(--purple-bright); }}
    .stat.no .n {{ color: var(--green); }}

    /* Sections */
    .section {{ padding: 46px 0; border-bottom:1px solid var(--hair); }}
    .section-head {{ display:flex; align-items:baseline; justify-content:space-between; gap:24px; margin-bottom: 22px; flex-wrap: wrap; }}
    .section-title {{ font-family:var(--serif); font-size: 28px; line-height: 1.15; font-weight: 500; letter-spacing:-.018em; color: var(--white); }}
    .section-eyebrow {{ font-family:var(--mono); font-size:10px; letter-spacing:.2em; text-transform:uppercase; color: var(--purple-bright); margin-bottom: 8px; font-weight:600; }}
    .section-meta {{ font-family:var(--mono); font-size: 11px; letter-spacing:.12em; text-transform:uppercase; color: var(--mute); }}
    .section-meta a {{ color: var(--purple-bright); text-decoration: underline; text-underline-offset:3px; }}

    /* Project grid — 2 columns desktop, 1 column mobile. Each card now
       includes title, location, last-verified row, the full construction
       timeline, mini stats, and developer/architect bubbles — matching the
       project page hero panel so visitors get the same context inline. */
    .grid.tmw-project-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; }}
    .card {{ display:block; background:#111; border-radius:14px; overflow:hidden; transition: transform .15s, border-color .15s; border:1px solid transparent; position:relative; }}
    .card:hover {{ transform: translateY(-2px); border-color: rgba(167,139,250,.3); }}
    .card.featured {{ box-shadow: 0 0 0 1px rgba(255,211,0,.32), 0 8px 24px rgba(255,211,0,.06); }}
    /* Smaller, square gold badge with star — matches map marker style */
    .card-feat-badge {{ position:absolute; top:10px; right:10px; z-index:2; width:22px; height:22px; border-radius:5px; background:var(--gold); display:inline-flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,.4); }}
    .card-feat-badge svg {{ width:12px; height:12px; fill:#0a0a0a; }}
    .card-img {{ height: 220px; background-size: cover; background-position: center; position: relative; }}
    .card-img::after {{ content:""; position:absolute; inset:0; background:linear-gradient(180deg, transparent 60%, rgba(0,0,0,.45) 100%); }}
    .card-body {{ padding: 18px 20px 20px; }}
    .card-title {{ font-family: var(--serif); font-size: 22px; font-weight: 500; letter-spacing:-.014em; line-height: 1.2; color: var(--white); margin-bottom: 6px; }}
    /* City/firm/location body font matches the map's body font (Inter regular) */
    .card-loc {{ font-family: var(--sans); font-size: 13px; color: var(--mute-2); margin-bottom: 14px; }}
    .card-verified {{ display:flex; align-items:center; gap:8px; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,.5); margin-bottom: 12px; padding: 8px 0; border-top:1px solid var(--hair); border-bottom:1px solid var(--hair); }}
    .card-v-ico {{ width:14px; height:14px; display:inline-block; }}
    .card-v-ico svg {{ width:100%; height:100%; }}

    /* Construction timeline (ported verbatim from generate_pages.py's
       project page hero panel — same look, same data) */
    .pm-tl {{ margin-bottom: 14px; }}
    .pm-tl-date {{ text-align: right; font-family: var(--mono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.5); margin-bottom: 8px; }}
    .pm-tl-meter {{ position: relative; height: 11px; border-radius: 999px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,0.55); }}
    .pm-tl-grad {{ position: absolute; inset: 0; background: linear-gradient(90deg, #3a2f6b, #7C5CE0 38%, #A78BFA 64%, #1FDF67); }}
    .pm-tl-empty {{ position: absolute; top: 0; bottom: 0; right: 0; background: #0d0f0e; box-shadow: inset 2px 0 3px rgba(0,0,0,0.6); }}
    .pm-tl-knob {{ position: absolute; top: 50%; transform: translate(-50%,-50%); background: #fff; color: #0a0a0a; font-size: 9.5px; font-weight: 800; padding: 4px 9px; border-radius: 999px; white-space: nowrap; z-index: 2; font-family: var(--sans); box-shadow: 0 2px 6px rgba(0,0,0,.5); }}
    .pm-tl-stages {{ display: flex; gap: 3px; margin-top: 10px; }}
    .pm-tl-stage {{ flex: 1; font-size: 7.5px; letter-spacing: 0.02em; text-transform: uppercase; color: rgba(255,255,255,0.2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; font-family: var(--sans); }}
    .pm-tl-stage:first-child {{ text-align: left; }}
    .pm-tl-stage:last-child {{ text-align: right; }}
    .pm-tl-stage.done {{ color: rgba(255,255,255,0.5); }}

    /* Mini stats grid (Start / Completion / Units / Floors) */
    .pp-minis {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 6px; margin-top: 14px; margin-bottom: 14px; }}
    .pp-mini {{ padding: 10px 11px; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; overflow: hidden; }}
    .pp-mini .v {{ font-family: var(--sans); font-size: 15px; font-weight: 800; letter-spacing: -.02em; color: var(--white); white-space: nowrap; }}
    .pp-mini .k {{ font-family: var(--mono); font-size: 8px; letter-spacing: .07em; text-transform: uppercase; color: rgba(255,255,255,.4); margin-top: 5px; white-space: nowrap; }}

    /* Developer & architect bubbles (mirrors project page .pp-firms) */
    .pp-firms {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }}
    .pp-firm {{ background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 13px 14px; text-decoration: none; color: inherit; display: block; transition: border-color .15s; }}
    .pp-firm:hover {{ border-color: rgba(31,223,103,.35); }}
    .pp-firm .k {{ font-family: var(--mono); font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.4); }}
    .pp-firm .v {{ font-family: var(--sans); font-size: 15px; font-weight: 700; color: var(--white); margin-top: 4px; line-height: 1.25; }}
    .pp-firm .go {{ display: inline-block; margin-top: 7px; font-family: var(--mono); font-size: 9.5px; letter-spacing: .07em; color: var(--green); font-weight: 600; }}
    .pp-firm-empty {{ cursor: default; }}
    .pp-firm-empty:hover {{ border-color: rgba(255,255,255,.08); }}

    /* Firm panels */
    .leads {{ display:grid; grid-template-columns: 1fr 1fr; gap: 14px; }}
    .lead {{ background: rgba(167,139,250,.04); border: 1px solid rgba(167,139,250,.22); border-radius: 14px; padding: 22px 24px; }}
    .lead h3 {{ font-family: var(--mono); font-size: 10.5px; letter-spacing: .18em; text-transform: uppercase; color: var(--purple-bright); margin-bottom: 18px; font-weight: 700; }}
    .lead-row {{ display:flex; justify-content: space-between; align-items: baseline; padding: 12px 0; border-top: 1px solid rgba(255,255,255,.05); }}
    .lead-row:first-of-type {{ border-top: 0; padding-top: 4px; }}
    .lead-row .name {{ font-family: var(--serif); font-size: 19px; font-weight: 500; color: var(--white); letter-spacing:-.012em; }}
    .lead-row .name a {{ color: var(--white); }}
    .lead-row .name a:hover {{ color: var(--purple-bright); text-decoration: underline; text-underline-offset:3px; }}
    .lead-row .count {{ font-family: var(--mono); font-size: 12px; color: var(--mute); }}

    /* Intel ask */
    .intel {{ background: linear-gradient(120deg, rgba(167,139,250,.10), rgba(255,211,0,.03)); border: 1px solid rgba(167,139,250,.32); border-radius: 18px; padding: 32px; }}
    .intel-eyebrow {{ font-family: var(--mono); font-size: 10.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--purple-bright); margin-bottom: 14px; font-weight:600; display:inline-flex; align-items:center; gap:8px; }}
    .intel-eyebrow::before {{ content:""; width:6px; height:6px; border-radius:50%; background:var(--purple); box-shadow:0 0 10px var(--purple); }}
    .intel h2 {{ font-family: var(--serif); font-size: 28px; line-height: 1.2; font-weight: 500; letter-spacing:-.018em; color: var(--white); max-width: 28ch; }}
    .intel .ex {{ font-family:var(--mono); font-size: 11px; letter-spacing:.06em; color: var(--mute); margin-top: 16px; line-height: 1.9; }}
    /* Try-chip font matches the map's body font (Inter), per UX feedback —
       the chip is a query the user might tap, not a label, so it shouldn't
       read as monospaced metadata. */
    .intel .ex span {{ display:inline-block; padding: 6px 12px; margin: 4px 6px 4px 0; background: rgba(255,255,255,.04); border: 1px solid var(--hair); border-radius: 999px; font-family: var(--sans); font-size: 13px; letter-spacing: 0; text-transform: none; color: var(--cream); }}
    .intel form {{ display:flex; gap: 10px; margin-top: 22px; }}
    .intel input {{ flex: 1; background: rgba(0,0,0,.4); border: 1px solid rgba(167,139,250,.32); border-radius: 10px; padding: 14px 18px; font-family: var(--sans); font-size: 15px; color: var(--white); cursor: pointer; }}
    .intel input:focus {{ outline: 0; border-color: var(--purple-bright); }}
    .intel input::placeholder {{ color: var(--mute); opacity: .9; }}
    .intel button {{ font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; padding: 0 24px; border-radius: 10px; background: var(--purple); color: #0a0a0a; border: 0; cursor:pointer; }}
    .intel .intel-chip {{ cursor: pointer; transition: background .15s, border-color .15s; }}
    .intel .intel-chip:hover {{ background: rgba(167,139,250,.12); border-color: rgba(167,139,250,.4); color: var(--white); }}

    /* Related */
    .related {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }}
    .rel-card {{ background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; padding: 18px 20px; transition: border-color .15s, transform .15s; display:block; }}
    .rel-card:hover {{ border-color: rgba(167,139,250,.4); transform: translateY(-2px); }}
    .rel-card .city {{ font-family: var(--mono); font-size: 10px; letter-spacing:.14em; text-transform: uppercase; color: var(--mute); }}
    .rel-card .name {{ font-family: var(--serif); font-size: 20px; font-weight: 500; letter-spacing:-.015em; color: var(--white); margin-top: 6px; line-height: 1.2; }}
    .rel-card .count {{ font-family: var(--mono); font-size: 11px; color: var(--purple-bright); margin-top: 8px; }}

    /* Pro CTA */
    .pro-cta {{ margin-top: 38px; padding: 32px; background: linear-gradient(120deg, rgba(255,211,0,.08), rgba(167,139,250,.04)); border: 1px solid rgba(255,211,0,.32); border-radius: 18px; display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }}
    .pro-cta .l {{ font-family: var(--serif); font-size: 19px; line-height: 1.4; color: var(--white); max-width: 50ch; font-weight: 500; }}
    .pro-cta .l em {{ font-style: italic; color: var(--gold); font-weight: 400; }}
    .pro-cta .l i {{ display:block; font-style:normal; font-family: var(--mono); font-size: 10.5px; letter-spacing:.16em; text-transform: uppercase; color: var(--mute); margin-top: 6px; font-weight: 600; }}
    .pro-cta .go {{ font-family: var(--mono); font-size: 12px; letter-spacing:.12em; text-transform: uppercase; font-weight: 700; padding: 14px 24px; border-radius: 10px; background: var(--gold); color: #0a0a0a; white-space:nowrap; border:0; cursor:pointer; }}

    /* Long-tail body */
    .copy {{ padding: 46px 0; font-family: var(--serif); font-size: 17px; line-height: 1.7; color: var(--mute-2); max-width: 72ch; font-weight: 300; }}
    .copy h2 {{ font-size: 26px; font-weight: 500; letter-spacing:-.018em; color: var(--white); margin: 30px 0 12px; line-height: 1.2; }}
    .copy h2:first-child {{ margin-top: 0; }}
    .copy p {{ margin-bottom: 16px; }}
    .copy a {{ color: var(--purple-bright); text-decoration: underline; text-underline-offset:3px; }}
    .copy b {{ font-weight: 500; color: var(--cream); }}

    @media (max-width: 760px) {{
      .wrap {{ padding: 0 18px; }}
      .stats {{ grid-template-columns: repeat(2, 1fr); }}
      .leads {{ grid-template-columns: 1fr; }}
      .pro-cta {{ flex-direction: column; align-items: flex-start; }}
      .intel form {{ flex-direction: column; }}
      .intel button {{ padding: 14px 0; }}
    }}
  </style>
</head>
<body>
  <!-- Universal header injected by /_shared/journal-chrome.js -->

  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">{crumbs_html}</nav>

    <section class="hero">
      <div class="hero-eyebrow">{esc(eyebrow)}</div>
      <h1>{esc(h1)}</h1>
      <p class="sub">{intro_html}</p>
    </section>

    <div class="stats" aria-label="Status breakdown">
{stats_html}
    </div>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-eyebrow">Featured projects</div>
          <h2 class="section-title">{esc(showing_note)}</h2>
        </div>
        <div class="section-meta">{see_all_link}</div>
      </div>
      <div class="grid tmw-project-grid">
{cards_html}
      </div>
    </section>

    <section class="section">
{firms_html}
    </section>

    <section class="section">
      <div class="intel" data-intel-city="{esc(intel_city)}" data-intel-type="{esc(intel_type)}">
        <div class="intel-eyebrow">TMW Intelligence</div>
        <h2>Ask anything about this market.</h2>
        <form id="market-intel-form" autocomplete="off">
          <input id="market-intel-input" name="q" type="text" placeholder="e.g. {esc(map_search)} under construction" autocomplete="off" readonly>
          <button type="submit">Ask</button>
        </form>
        <div class="ex">
          Try:
          <span class="intel-chip" data-q="what's breaking ground in 2026?">what's breaking ground in 2026?</span>
          <span class="intel-chip" data-q="tallest tower in pipeline">tallest tower in pipeline</span>
          <span class="intel-chip" data-q="most active firm">most active firm</span>
        </div>
      </div>
    </section>

    <article class="copy">
{body_copy_html}
    </article>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-eyebrow">Nearby + adjacent</div>
          <h2 class="section-title">Related markets</h2>
        </div>
        <div class="section-meta"><a href="{ROOT_URL}/markets/">All markets →</a></div>
      </div>
      <div class="related">
{related_html}
      </div>
    </section>

{more_types_section}

    <div class="pro-cta">
      <div class="l">
        Get the full dataset for this market, weekly Slippage Report, and the TMW Forecast on every project.
        <em>The part of Pro that pays for itself.</em>
        <i>Markets of Tomorrow Pro · $24/mo</i>
      </div>
      <button class="go" id="market-pro-cta">Go Pro →</button>
    </div>
  </div>

  <!-- Auth modal + funnel beacon helper (journal-auth.js loads transitively via journal-chrome.js).
       journal-search-core.js carries parseSmartQuery so the overlay can parse the
       city/type prefix we feed it from this page. journal-search-overlay.js exposes
       window.tmwOverlay.open(query) which the Intelligence ask box calls below. -->
  <script src="/_shared/journal-chrome.js" defer></script>
  <script src="/_shared/journal-dock.js" defer></script>
  <script src="/_shared/journal-search-core.js" defer></script>
  <script src="/_shared/journal-search-overlay.js" defer></script>
  <script src="/_shared/tmw-lightbox.js" defer></script>
  <script>
    // Wires the Intelligence ask box + suggestion chips to the universal
    // overlay loaded by /_shared/journal-search-overlay.js. Every query is
    // prefixed with the page's market context (city + type) so the overlay's
    // parseSmartQuery picks them up as structured filters automatically —
    // a search for "what's breaking ground in 2026" from West Palm Beach
    // Residences becomes "West Palm Beach Residences what's breaking ground
    // in 2026", which the parser routes to {{ city: WPB, type: Residences,
    // milestone: BG, year: 2026 }}.
    //
    // The input itself is readonly so the click handler always wins over
    // text entry — the overlay IS the input. Closing the overlay returns
    // the user to the same market page (no navigation happens).
    document.addEventListener('DOMContentLoaded', function () {{
      var intelBox = document.querySelector('.intel');
      if (!intelBox) return;
      var city = intelBox.getAttribute('data-intel-city') || '';
      var type = intelBox.getAttribute('data-intel-type') || '';
      var prefix = (city + ' ' + type).trim();

      // Two ways to open the overlay from this page:
      //   - openSuggestionsWith(): clicking the input drops the user into the
      //     starter (suggestions) state with the market name pre-filled —
      //     they can type their own question with the filter implicit.
      //   - openSearchWith(q): submitting the form OR clicking a try-chip
      //     fires a real search with the market + question both included.
      // Both versions fall back to deep-linking /?q= if the overlay script
      // hasn't booted yet (defer load + slow connections).
      function trackBeacon(q) {{
        try {{ window.tmwFunnelTrack && window.tmwFunnelTrack('intel_query', {{ source: 'market_page', city: city, type: type, q: (q || '').slice(0, 80) }}); }} catch (_){{}}
      }}
      function openSuggestionsWith() {{
        trackBeacon('');
        if (window.tmwOverlay && typeof window.tmwOverlay.openWithPrefix === 'function') {{
          window.tmwOverlay.openWithPrefix(prefix);
        }} else if (window.tmwOverlay && typeof window.tmwOverlay.open === 'function') {{
          window.tmwOverlay.open(prefix);
        }} else {{
          window.location = '{ROOT_URL}/?q=' + encodeURIComponent(prefix);
        }}
      }}
      function openSearchWith(q) {{
        var full = prefix ? (prefix + (q ? ' ' + q : '')) : q;
        trackBeacon(q);
        if (window.tmwOverlay && typeof window.tmwOverlay.open === 'function') {{
          window.tmwOverlay.open(full);
        }} else {{
          window.location = '{ROOT_URL}/?q=' + encodeURIComponent(full);
        }}
      }}

      // Clicking / focusing the input → suggestions panel with prefix in box.
      var input = document.getElementById('market-intel-input');
      if (input) {{
        input.addEventListener('click', function (e) {{ e.preventDefault(); openSuggestionsWith(); }});
        input.addEventListener('focus', function (e) {{ e.preventDefault(); openSuggestionsWith(); input.blur(); }});
      }}
      // Form submit (Enter or "Ask" button) — runs the search.
      var f = document.getElementById('market-intel-form');
      if (f) f.addEventListener('submit', function (e) {{
        e.preventDefault();
        openSearchWith(((input && input.value) || '').trim());
      }});
      // Try-chip click → real search with the chip text + market prefix.
      Array.prototype.forEach.call(document.querySelectorAll('.intel-chip'), function (chip) {{
        chip.style.cursor = 'pointer';
        chip.addEventListener('click', function () {{ openSearchWith(chip.getAttribute('data-q') || chip.textContent.trim()); }});
      }});

      // Pro CTA → fire funnel beacon, then open the paywall (or fall back to
      // the upgrade URL if journal-paywall.js hasn't loaded yet).
      var go = document.getElementById('market-pro-cta');
      if (go) go.addEventListener('click', function () {{
        try {{ window.tmwFunnelTrack && window.tmwFunnelTrack('go_pro_clicked', {{ source: 'market_page', path: location.pathname }}); }} catch (_){{}}
        if (window.tmwShowPaywall) window.tmwShowPaywall({{ source: 'market_page' }});
        else window.location = '{ROOT_URL}/map/?upgrade=1';
      }});
    }});
  </script>
</body>
</html>
"""

# ─── Page-specific copy generation ────────────────────────────────────
def _status_breakdown(projects: list[dict]) -> dict[str, int]:
    c = collections.Counter((p.get('Delivery') or '').strip() for p in projects)
    return {
        'uc': c.get('Under Construction', 0),
        'bg': c.get('Breaking Ground', 0),
        'os': c.get('Opening Soon', 0),
        'no': c.get('Now Open', 0),
        'an': c.get('Announced', 0),
    }

def _top_developer(projects: list[dict]) -> tuple[str|None, int]:
    devs, _ = _count_firms(projects, 'Developer', 'DeveloperSlugs')
    return devs.most_common(1)[0] if devs else (None, 0)

def city_type_intro(city: str, ptype: str, projects: list[dict], top_arch: str|None) -> tuple[str, str]:
    """ALL numbers in body copy are computed from the current `projects` slice
    so a sheet edit (project added, status changed, etc.) refreshes them on
    the next hourly generator run."""
    s = _status_breakdown(projects)
    n_total = len(projects)
    intro = (
        f'We\'re tracking <b>{n_total} new {ptype.lower()} developments</b> across {city} right now — '
        f'with <b>{s["uc"]} under construction</b>'
    )
    if s['bg']: intro += f', <b>{s["bg"]} breaking ground</b>'
    if s['an']: intro += f', and <b>{s["an"]} just announced</b>'
    intro += '.'
    if top_arch:
        intro += f' The cycle is anchored by <b>{esc(top_arch)}</b>, leading firm by project count in this market.'
    intro += f' Every project links to a live status page with milestones, renderings, and our <a href="{ROOT_URL}/journal/">journal coverage</a>.'

    top_dev, top_dev_n = _top_developer(projects)
    dev_line = (
        f'Most active developer in this market: <b>{esc(top_dev)}</b> with <b>{top_dev_n} project{"s" if top_dev_n != 1 else ""}</b>.'
        if top_dev else ''
    )
    open_count = s['os'] + s['no']
    open_line = (
        f'<b>{open_count} project{"s" if open_count != 1 else ""}</b> are at the finish line — opening soon or already delivered.'
        if open_count else ''
    )
    long_copy = (
        f'<h2>What\'s happening in {esc(city)} {ptype.lower()} right now</h2>'
        f'<p>{intro}</p>'
        + (f'<p>{dev_line} {open_line}</p>' if (dev_line or open_line) else '')
        + f'<h2>How we built this list</h2>'
          f'<p>Every project on this page is on the <a href="{ROOT_URL}/map/">Map of Tomorrow</a> — our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes (breaking ground, topping out, opening) are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly Slippage Report and the full dataset by phase, neighborhood, and architect.</p>'
    )
    return intro, long_copy

def city_intro(city: str, projects: list[dict], top_types: list[tuple[str,int]]) -> tuple[str, str]:
    s = _status_breakdown(projects)
    n_total = len(projects)
    types_phrase = ', '.join(f'<b>{esc(t)}</b> ({n})' for t, n in top_types[:3])
    intro = (
        f'We\'re tracking <b>{n_total} new developments</b> in {city} across every category — '
        f'including {types_phrase}. Every project below links to a live status page with milestones, renderings, '
        f'and our <a href="{ROOT_URL}/journal/">journal coverage</a>.'
    )
    status_line = (
        f'Right now: <b>{s["uc"]} under construction</b>, <b>{s["bg"]} breaking ground</b>, <b>{s["os"]} opening soon</b>, '
        f'and <b>{s["an"]} newly announced</b>.'
    )
    top_dev, top_dev_n = _top_developer(projects)
    dev_line = (
        f'Most active developer across the {esc(city)} pipeline: <b>{esc(top_dev)}</b> with <b>{top_dev_n} project{"s" if top_dev_n != 1 else ""}</b>.'
        if top_dev else ''
    )
    long_copy = (
        f'<h2>The {esc(city)} pipeline</h2>'
        f'<p>{intro}</p>'
        f'<p>{status_line}</p>'
        + (f'<p>{dev_line}</p>' if dev_line else '')
        + f'<h2>How we built this list</h2>'
          f'<p>Every project on this page is on the <a href="{ROOT_URL}/map/">Map of Tomorrow</a> — our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly Slippage Report and the full dataset by phase, neighborhood, architect, and developer.</p>'
    )
    return intro, long_copy

def type_intro(ptype: str, projects: list[dict], top_cities: list[tuple[str,int]]) -> tuple[str, str]:
    s = _status_breakdown(projects)
    n_total = len(projects)
    cities_phrase = ', '.join(f'<b>{esc(c)}</b> ({n})' for c, n in top_cities[:3])
    intro = (
        f'We\'re tracking <b>{n_total} new {ptype.lower()} developments</b> worldwide — '
        f'with the deepest pipelines in {cities_phrase}.'
    )
    status_line = (
        f'<b>{s["uc"]} under construction</b>, <b>{s["bg"]} breaking ground</b>, '
        f'<b>{s["os"]} opening soon</b>, and <b>{s["no"]} already open</b> in the dataset.'
    )
    long_copy = (
        f'<h2>The global {ptype.lower()} pipeline</h2>'
        f'<p>{intro}</p>'
        f'<p>{status_line}</p>'
        f'<h2>How we built this list</h2>'
        f'<p>Every project on this page is on the <a href="{ROOT_URL}/map/">Map of Tomorrow</a>, our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly Slippage Report and the full filterable dataset.</p>'
    )
    return intro, long_copy

# ─── Build the index hub at /markets/ ────────────────────────────────
def render_hub(city_type_pairs, city_pages, type_pages):
    """Index page at /markets/index.html. The old "By city × category" section
    is replaced by an in-page filter calculator — user picks a city + category
    + status, the page hot-swaps to show what we track for that combination
    (and links to the dedicated landing page when one exists). Falls back to
    a flat city + category browse below for direct navigation.

    All option lists + the city×type lookup table are baked into the page at
    generation time, so the calculator runs entirely client-side with zero
    fetches and stays accurate the moment the generator runs."""
    # JSON lookup: { "miami|residences": { url: "/markets/...", n: 69 }, ... }
    ct_lookup = {
        f'{slugify(c)}|{slugify(t)}': {
            'url':  f'/markets/{slugify(c)}-{slugify(t)}/',
            'n':    n,
            'city': c,
            'type': t,
        }
        for (c, t, n) in city_type_pairs
    }
    city_lookup = {slugify(c): {'url': f'/markets/{slugify(c)}/', 'n': n, 'city': c} for (c, n) in city_pages}
    type_lookup = {slugify(t): {'url': f'/markets/by-type/{slugify(t)}/', 'n': n, 'type': t} for (t, n) in type_pages}

    # Options sorted by project count (highest = most relevant first)
    city_opts = sorted({c for (c, _, _) in city_type_pairs} | {c for (c, _) in city_pages})
    type_opts = sorted({t for (_, t, _) in city_type_pairs} | {t for (t, _) in type_pages})

    city_options_html = ''.join(f'<option value="{esc(slugify(c))}">{esc(c)}</option>' for c in city_opts)
    type_options_html = ''.join(f'<option value="{esc(slugify(t))}">{esc(t)}</option>' for t in type_opts)

    city_html = ''.join(
        f'<a class="rel-card" href="{ROOT_URL}/markets/{slugify(c)}/"><div class="city">All categories</div><div class="name">{esc(c)}</div><div class="count">{n} tracked →</div></a>'
        for (c, n) in city_pages
    )
    type_html = ''.join(
        f'<a class="rel-card" href="{ROOT_URL}/markets/by-type/{slugify(t)}/"><div class="city">Worldwide</div><div class="name">{esc(t)}</div><div class="count">{n} tracked →</div></a>'
        for (t, n) in type_pages
    )
    canonical = f'{ROOT_URL}/markets/'
    crumbs = [('TMW', '/'), ('Markets', None)]
    crumbs_html = ' <span class="sep">/</span> '.join(
        f'<a href="{esc(link)}">{esc(name)}</a>' if link else f'<b>{esc(name)}</b>'
        for name, link in crumbs
    )
    total_links = len(city_type_pairs) + len(city_pages) + len(type_pages)

    # Serialize lookups for the client-side filter
    lookups_json = json.dumps({
        'cityType': ct_lookup,
        'city':     city_lookup,
        'type':     type_lookup,
    }, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>All Markets | {SITE_NAME}</title>
  <meta name="description" content="Browse every market we track on the Map of Tomorrow — filter by city, category, or status to find the projects in your pipeline. {total_links} live landing pages.">
  <link rel="canonical" href="{canonical}">
  <meta name="robots" content="index, follow">
  <link rel="icon" href="https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {{ --ink:#0d0d0d; --hair:rgba(255,255,255,.08); --white:#fff; --cream:#ECEAE5; --mute:#9AA39C; --mute-2:#C2C9C3; --purple:#A78BFA; --purple-bright:#C4B5FD; --gold:#FFD300;
      --sans:'Inter',-apple-system,sans-serif; --serif:'Fraunces',Georgia,serif; --mono:'JetBrains Mono',ui-monospace,monospace; }}
    *,*::before,*::after {{ box-sizing:border-box; margin:0; padding:0; }}
    body {{ background:var(--ink); color:var(--cream); font-family:var(--sans); line-height:1.55; }}
    body::before {{ content:""; position:fixed; inset:0; z-index:0; pointer-events:none;
      background: radial-gradient(820px 540px at 76% -6%, rgba(167,139,250,.10), transparent 60%); }}
    a {{ color:inherit; text-decoration:none; }}
    .wrap {{ position:relative; z-index:1; max-width:1200px; margin:0 auto; padding:0 24px; }}
    .crumbs {{ padding:22px 0 0; font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute); }}
    .crumbs .sep {{ opacity:.4; margin:0 8px; }}
    .crumbs b {{ color:var(--purple-bright); }}
    .hero {{ padding:30px 0 38px; border-bottom:1px solid var(--hair); }}
    .hero h1 {{ font-family:var(--serif); font-size:clamp(40px,5.4vw,64px); line-height:1.04; font-weight:500; letter-spacing:-.022em; color:var(--white); max-width:20ch; }}
    .hero .sub {{ font-family:var(--serif); font-style:italic; font-weight:300; font-size:20px; color:var(--mute-2); margin-top:18px; line-height:1.5; max-width:62ch; }}
    .section {{ padding:46px 0; border-bottom:1px solid var(--hair); }}
    .section h2 {{ font-family:var(--serif); font-size:28px; font-weight:500; letter-spacing:-.018em; color:var(--white); margin-bottom:22px; }}
    .section-eyebrow {{ font-family:var(--mono); font-size:10.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--purple-bright); margin-bottom:8px; font-weight:600; }}
    .related {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:10px; }}
    .rel-card {{ background:rgba(255,255,255,.02); border:1px solid var(--hair); border-radius:12px; padding:18px 20px; display:block; transition:border-color .15s, transform .15s; }}
    .rel-card:hover {{ border-color:rgba(167,139,250,.4); transform:translateY(-2px); }}
    .rel-card .city {{ font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); }}
    .rel-card .name {{ font-family:var(--serif); font-size:18px; font-weight:500; color:var(--white); margin-top:6px; line-height:1.2; }}
    .rel-card .count {{ font-family:var(--mono); font-size:11px; color:var(--purple-bright); margin-top:8px; }}

    /* ── Filter calculator ───────────────────────────────────────── */
    .mc-box {{ background: linear-gradient(120deg, rgba(167,139,250,.10), rgba(255,211,0,.03)); border: 1px solid rgba(167,139,250,.30); border-radius: 18px; padding: 28px 30px; }}
    .mc-row {{ display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 12px; align-items: end; }}
    .mc-field label {{ display:block; font-family: var(--mono); font-size: 10px; letter-spacing:.14em; text-transform: uppercase; color: var(--purple-bright); margin-bottom: 8px; font-weight: 600; }}
    .mc-field select,
    .mc-field input {{ width: 100%; background: rgba(0,0,0,.45); border: 1px solid rgba(167,139,250,.32); border-radius: 10px; padding: 14px 16px; font-family: var(--sans); font-size: 15px; color: var(--white); appearance: none; cursor: pointer; }}
    .mc-field select:focus, .mc-field input:focus {{ outline: 0; border-color: var(--purple-bright); }}
    .mc-go {{ font-family: var(--mono); font-size: 11px; letter-spacing:.12em; text-transform: uppercase; font-weight: 700; padding: 14px 22px; border-radius: 10px; background: var(--purple); color: #0a0a0a; border: 0; cursor: pointer; white-space: nowrap; }}
    .mc-go[disabled] {{ background: rgba(255,255,255,.1); color: var(--mute); cursor: not-allowed; }}
    .mc-result {{ margin-top: 22px; padding: 22px 24px; background: rgba(0,0,0,.35); border: 1px solid var(--hair); border-radius: 12px; display: none; }}
    .mc-result.show {{ display: block; }}
    .mc-result .head {{ font-family: var(--mono); font-size: 10px; letter-spacing:.18em; text-transform: uppercase; color: var(--mute); margin-bottom: 8px; }}
    .mc-result .big {{ font-family: var(--serif); font-size: 32px; line-height: 1.15; color: var(--white); letter-spacing:-.018em; font-weight: 500; }}
    .mc-result .big b {{ color: var(--gold); }}
    .mc-result .cta {{ display: inline-block; margin-top: 14px; padding: 12px 20px; background: var(--gold); color: #0a0a0a; font-family: var(--mono); font-size: 11px; letter-spacing:.12em; text-transform: uppercase; font-weight: 700; border-radius: 10px; }}
    .mc-result .ghost {{ display:inline-block; margin-left: 10px; font-family: var(--mono); font-size: 10.5px; letter-spacing:.12em; text-transform: uppercase; color: var(--purple-bright); }}
    @media (max-width: 720px) {{ .mc-row {{ grid-template-columns: 1fr; }} }}
  </style>
</head><body>
  <div class="wrap">
    <nav class="crumbs">{crumbs_html}</nav>
    <section class="hero">
      <h1>Every market we track.</h1>
      <p class="sub">{total_links} live landing pages across {SITE_NAME}, built from our database of new developments. Filter below or browse by city or category.</p>
    </section>

    <section class="section">
      <div class="section-eyebrow">Market calculator</div>
      <h2>Build your own market view.</h2>
      <div class="mc-box">
        <form id="mc-form" class="mc-row">
          <div class="mc-field">
            <label for="mc-city">City</label>
            <select id="mc-city">
              <option value="">Any city</option>
              {city_options_html}
            </select>
          </div>
          <div class="mc-field">
            <label for="mc-type">Category</label>
            <select id="mc-type">
              <option value="">Any category</option>
              {type_options_html}
            </select>
          </div>
          <div class="mc-field">
            <label for="mc-year">Delivery by</label>
            <select id="mc-year">
              <option value="">Any time</option>
              <option value="2026">By end of 2026</option>
              <option value="2027">By end of 2027</option>
              <option value="2028">By end of 2028</option>
              <option value="2030">By end of 2030</option>
            </select>
          </div>
          <button type="submit" class="mc-go" id="mc-go">Show me →</button>
        </form>
        <div id="mc-result" class="mc-result" aria-live="polite"></div>
      </div>
    </section>

    <section class="section">
      <h2>Browse by city</h2>
      <div class="related">{city_html}</div>
    </section>
    <section class="section">
      <h2>Browse by category</h2>
      <div class="related">{type_html}</div>
    </section>
  </div>
  <script id="mc-data" type="application/json">{lookups_json}</script>
  <script>
    (function() {{
      var data = JSON.parse(document.getElementById('mc-data').textContent);
      var $city = document.getElementById('mc-city');
      var $type = document.getElementById('mc-type');
      var $year = document.getElementById('mc-year');
      var $result = document.getElementById('mc-result');
      var $form = document.getElementById('mc-form');

      function fmtYearTail(y) {{
        return y ? ' delivering by end of ' + y : '';
      }}

      function compute() {{
        var c = $city.value, t = $type.value, y = $year.value;
        if (c && t) {{
          var ent = data.cityType[c + '|' + t];
          if (ent) return {{ found: true, n: ent.n, city: ent.city, type: ent.type, url: ent.url, label: ent.city + ' · ' + ent.type, hasPage: true }};
          return {{ found: false, label: c + ' · ' + t, urlMap: '/map/?q=' + encodeURIComponent((data.city[c] && data.city[c].city || c) + ' ' + (data.type[t] && data.type[t].type || t)) }};
        }}
        if (c) {{
          var ec = data.city[c];
          if (ec) return {{ found: true, n: ec.n, city: ec.city, label: ec.city, url: ec.url, hasPage: true }};
        }}
        if (t) {{
          var et = data.type[t];
          if (et) return {{ found: true, n: et.n, type: et.type, label: et.type, url: et.url, hasPage: true }};
        }}
        return null;
      }}

      function render() {{
        var r = compute();
        if (!r) {{
          $result.classList.remove('show');
          return;
        }}
        $result.classList.add('show');
        var y = $year.value;
        if (r.found) {{
          $result.innerHTML =
            '<div class="head">Tracking</div>' +
            '<div class="big"><b>' + r.n + '</b> project' + (r.n === 1 ? '' : 's') + ' in <b>' + r.label + '</b>' + fmtYearTail(y) + '.</div>' +
            (r.hasPage ? '<a class="cta" href="' + r.url + '">Open ' + r.label + ' →</a>' : '') +
            '<a class="ghost" href="/map/?q=' + encodeURIComponent(r.label + (y ? (' ' + y) : '')) + '">Refine on map →</a>';
        }} else {{
          $result.innerHTML =
            '<div class="head">No landing page yet</div>' +
            '<div class="big">We track fewer than 3 projects in <b>' + r.label + '</b> right now — not enough for a dedicated page.</div>' +
            '<a class="cta" href="' + r.urlMap + '">See what we have on the map →</a>';
        }}
      }}

      [$city, $type, $year].forEach(function(el) {{ el.addEventListener('change', render); }});
      $form.addEventListener('submit', function(e) {{ e.preventDefault(); render(); }});
    }})();
  </script>
  <script src="/_shared/journal-chrome.js" defer></script>
  <script src="/_shared/journal-dock.js" defer></script>
</body></html>
"""

# ─── Driver ───────────────────────────────────────────────────────────
def main():
    print("Loading projects-flat.json...")
    try:
        projects = json.load(open('projects-flat.json', encoding='utf-8'))
    except FileNotFoundError:
        print("  ✗ projects-flat.json not found. Run fetch_projects.py first.")
        sys.exit(1)
    print(f"  ✓ Loaded {len(projects)} projects")

    by_city_type, by_city, by_type = bucket_projects(projects)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    pages_written = []
    generated_paths: list[str] = []        # for sitemap

    # ─── 1. City × Type pages ────────────────────────────────────────
    city_type_pairs_for_hub: list[tuple[str,str,int]] = []
    n_ct = 0
    for (city, ptype), bucket in by_city_type.items():
        if len(bucket) < CITY_TYPE_MIN: continue
        bucket = sort_projects(bucket)
        slug = f"{slugify(city)}-{slugify(ptype)}"
        path = f"{OUTPUT_DIR}/{slug}/"
        os.makedirs(path, exist_ok=True)

        # Top architect (excluding ties) for the intro paragraph
        arch_counter = collections.Counter()
        for p in bucket:
            for a in (p.get('Architect') or '').split(','):
                a = a.strip()
                if a: arch_counter[a] += 1
        top_arch = arch_counter.most_common(1)[0][0] if arch_counter else None
        intro, long_copy = city_type_intro(city, ptype, bucket, top_arch)

        type_label = TYPE_PHRASING.get(ptype, ptype + 's')
        h1 = f"New {city} {type_label}"
        title_tag = f"{len(bucket)} New {city} {type_label} | {SITE_NAME}"
        _sb = _status_breakdown(bucket)
        meta_desc = f"We're tracking {len(bucket)} new {ptype.lower()} developments in {city} — {_sb['uc']} under construction, plus {_sb['bg']} breaking ground and {_sb['an']} announced. Live status, architects, developers."

        crumbs = [('TMW','/'), ('Markets','/markets/'), (city, f'/markets/{slugify(city)}/' if len(by_city.get(city, [])) >= CITY_MIN else None), (ptype, None)]

        # "Related markets" = other CITIES with the SAME project type (these
        # are the real comparables — Miami Residences ↔ WPB Residences ↔
        # Fort Lauderdale Residences, etc.). Falls back to the top-N city
        # hubs by total project count if too few same-type peers exist.
        related_cities: list[tuple[str,str,int,str]] = []
        for (c, t), b in by_city_type.items():
            if t == ptype and c != city and len(b) >= CITY_TYPE_MIN:
                related_cities.append(('CITY', f'{c} · {t}', len(b), f'/markets/{slugify(c)}-{slugify(t)}/'))
        related_cities.sort(key=lambda x: -x[2])
        if len(by_type.get(ptype, [])) >= CITY_TYPE_MIN:
            related_cities.append(('WORLDWIDE', ptype, len(by_type[ptype]), f'/markets/by-type/{slugify(ptype)}/'))
        related_cities = related_cities[:6]

        # "More project types in {city}" = same city, different category.
        more_types: list[tuple[str,str,int,str]] = []
        for (c, t), b in by_city_type.items():
            if c == city and t != ptype and len(b) >= CITY_TYPE_MIN:
                more_types.append((city.upper(), t, len(b), f'/markets/{slugify(c)}-{slugify(t)}/'))
        more_types.sort(key=lambda x: -x[2])
        if len(by_city.get(city, [])) >= CITY_MIN:
            more_types.append((city.upper(), 'All categories', len(by_city[city]), f'/markets/{slugify(city)}/'))
        more_types = more_types[:6]

        html_out = render_page(
            h1=h1, title_tag=title_tag, meta_desc=meta_desc,
            canonical_path=f'/markets/{slug}/',
            breadcrumbs=crumbs, eyebrow=f'Live · {len(bucket)} projects tracked',
            intro_html=intro, projects=bucket, total_count=len(bucket),
            related_cities=related_cities, more_types=more_types,
            map_search=f'{city} {ptype}',
            intel_city=city, intel_type=ptype,
            body_copy_html=long_copy,
        )
        open(os.path.join(path, 'index.html'), 'w', encoding='utf-8').write(html_out)
        pages_written.append(f'{slug}/index.html')
        generated_paths.append(f'/markets/{slug}/')
        city_type_pairs_for_hub.append((city, ptype, len(bucket)))
        n_ct += 1

    # ─── 2. City hub pages ───────────────────────────────────────────
    city_pages_for_hub: list[tuple[str,int]] = []
    n_city = 0
    for city, bucket in by_city.items():
        if len(bucket) < CITY_MIN: continue
        bucket_sorted = sort_projects(bucket)
        # Top types in this city
        type_counter = collections.Counter((p.get('PreferredType') or '').strip() for p in bucket if (p.get('PreferredType') or '').strip())
        intro, long_copy = city_intro(city, bucket, type_counter.most_common(3))
        h1 = f"New Developments in {city}"
        title_tag = f"{len(bucket)} New Developments in {city} | {SITE_NAME}"
        meta_desc = f"Every new development we're tracking in {city} — {len(bucket)} projects across {len(type_counter)} categories."
        crumbs = [('TMW','/'), ('Markets','/markets/'), (city, None)]

        # "Related markets" = OTHER CITIES, ranked by total project count.
        # Other cities are the real peers when you're already viewing a
        # whole-city hub. Capped at 6 — the strongest comparables.
        related_cities: list[tuple[str,str,int,str]] = []
        for other_city, other_bucket in by_city.items():
            if other_city == city or len(other_bucket) < CITY_MIN: continue
            related_cities.append(('CITY', other_city, len(other_bucket), f'/markets/{slugify(other_city)}/'))
        related_cities.sort(key=lambda x: -x[2])
        related_cities = related_cities[:6]

        # "More project types in {city}" = the categories list that used
        # to be the only related section.
        more_types: list[tuple[str,str,int,str]] = []
        for (c, t), b in by_city_type.items():
            if c == city and len(b) >= CITY_TYPE_MIN:
                more_types.append((city.upper(), t, len(b), f'/markets/{slugify(c)}-{slugify(t)}/'))
        more_types.sort(key=lambda x: -x[2])
        more_types = more_types[:6]

        html_out = render_page(
            h1=h1, title_tag=title_tag, meta_desc=meta_desc,
            canonical_path=f'/markets/{slugify(city)}/',
            breadcrumbs=crumbs, eyebrow=f'Live · {len(bucket)} projects tracked',
            intro_html=intro, projects=bucket_sorted, total_count=len(bucket),
            related_cities=related_cities, more_types=more_types,
            map_search=city, intel_city=city, intel_type='',
            body_copy_html=long_copy,
        )
        path = f"{OUTPUT_DIR}/{slugify(city)}/"
        os.makedirs(path, exist_ok=True)
        open(os.path.join(path, 'index.html'), 'w', encoding='utf-8').write(html_out)
        pages_written.append(f'{slugify(city)}/index.html')
        generated_paths.append(f'/markets/{slugify(city)}/')
        city_pages_for_hub.append((city, len(bucket)))
        n_city += 1

    # ─── 3. Type hub pages ───────────────────────────────────────────
    type_pages_for_hub: list[tuple[str,int]] = []
    n_type = 0
    for ptype, bucket in by_type.items():
        if not ptype: continue
        bucket_sorted = sort_projects(bucket)
        city_counter = collections.Counter((p.get('City') or '').strip() for p in bucket if (p.get('City') or '').strip())
        intro, long_copy = type_intro(ptype, bucket, city_counter.most_common(3))
        type_label = TYPE_PHRASING.get(ptype, ptype + 's')
        h1 = f"New {type_label} Worldwide"
        title_tag = f"{len(bucket)} New {type_label} | {SITE_NAME}"
        meta_desc = f"Every {ptype.lower()} development we're tracking worldwide — {len(bucket)} projects across {len(city_counter)} cities."
        crumbs = [('TMW','/'), ('Markets','/markets/'), ('By type','/markets/'), (ptype, None)]

        # "Related markets" = the top CITIES for this type — these ARE the
        # peer cities for a global-by-type page.
        related_cities: list[tuple[str,str,int,str]] = []
        for (c, t), b in by_city_type.items():
            if t == ptype and len(b) >= CITY_TYPE_MIN:
                related_cities.append(('CITY', f'{c} · {t}', len(b), f'/markets/{slugify(c)}-{slugify(t)}/'))
        related_cities.sort(key=lambda x: -x[2])
        related_cities = related_cities[:6]

        # Type-only pages don't get a "More project types" section — they're
        # already a single-type view, so passing [] hides that block.
        html_out = render_page(
            h1=h1, title_tag=title_tag, meta_desc=meta_desc,
            canonical_path=f'/markets/by-type/{slugify(ptype)}/',
            breadcrumbs=crumbs, eyebrow=f'Live · {len(bucket)} projects worldwide',
            intro_html=intro, projects=bucket_sorted, total_count=len(bucket),
            related_cities=related_cities, more_types=[],
            map_search=ptype, intel_city='', intel_type=ptype,
            body_copy_html=long_copy,
        )
        path = f"{OUTPUT_DIR}/by-type/{slugify(ptype)}/"
        os.makedirs(path, exist_ok=True)
        open(os.path.join(path, 'index.html'), 'w', encoding='utf-8').write(html_out)
        pages_written.append(f'by-type/{slugify(ptype)}/index.html')
        generated_paths.append(f'/markets/by-type/{slugify(ptype)}/')
        type_pages_for_hub.append((ptype, len(bucket)))
        n_type += 1

    # ─── 4. Hub /markets/index.html ──────────────────────────────────
    city_type_pairs_for_hub.sort(key=lambda x: -x[2])
    city_pages_for_hub.sort(key=lambda x: -x[1])
    type_pages_for_hub.sort(key=lambda x: -x[1])
    hub = render_hub(city_type_pairs_for_hub, city_pages_for_hub, type_pages_for_hub)
    open(os.path.join(OUTPUT_DIR, 'index.html'), 'w', encoding='utf-8').write(hub)
    generated_paths.append('/markets/')

    # ─── 5. Write a manifest the workflow can sitemap-include ────────
    with open(os.path.join(OUTPUT_DIR, '.urls.json'), 'w', encoding='utf-8') as f:
        json.dump({'urls': generated_paths, 'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}, f, indent=2)

    print(f"  ✓ {n_ct} city×type pages")
    print(f"  ✓ {n_city} city hubs")
    print(f"  ✓ {n_type} type hubs")
    print(f"  ✓ 1 markets/ index")
    print(f"  → wrote .urls.json manifest with {len(generated_paths)} URLs")

if __name__ == '__main__':
    main()
