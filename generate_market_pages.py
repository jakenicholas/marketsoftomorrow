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
CITY_MIN      = 5
FEATURED_GRID_TARGET = 12   # how many cards we show in the featured grid

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
def card_html(p: dict) -> str:
    title = esc(p.get('Title') or '')
    slug  = (p.get('Slug') or slugify(p.get('Title') or '')).strip()
    img   = esc(project_image(p))
    neigh = esc((p.get('Neighborhood') or p.get('City') or '').strip())
    dev   = esc(short_developer(p))
    arch  = esc(short_architect(p))
    cap   = esc(f"{p.get('Title','')} · {p.get('City','')}")
    meta_parts = []
    if dev and dev != '—': meta_parts.append(f'<span>By <b>{dev}</b></span>')
    if arch: meta_parts.append(f'<span>·</span><span>{arch}</span>')
    meta = ''.join(meta_parts) or '<span style="opacity:.6">Coming soon</span>'
    pill = status_pill(p)
    featured_flag = ' data-featured="1"' if is_featured(p) else ''
    return (
        f'<a class="card{" featured" if is_featured(p) else ""}" href="{ROOT_URL}/projects/{esc(slug)}/"{featured_flag}>\n'
        f'  <div class="card-img" data-lightbox-src="{img}" data-lightbox-caption="{cap}" style="background-image:url(\'{img}\')">{pill}</div>\n'
        f'  <div class="card-body">\n'
        f'    <div class="card-title">{title}</div>\n'
        f'    <div class="card-neigh">{neigh}</div>\n'
        f'    <div class="card-meta">{meta}</div>\n'
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

def top_firms_html(projects: list[dict]) -> str:
    devs = collections.Counter()
    arches = collections.Counter()
    dev_slugs: dict[str,str] = {}
    arch_slugs: dict[str,str] = {}
    for p in projects:
        for nm, slug in zip(
            [(p.get('Developer') or '').split(',')],
            [(p.get('DeveloperSlugs') or '').split(',')]):
            for i, n in enumerate(nm[0]):
                n = n.strip()
                if not n: continue
                devs[n] += 1
                if i < len(slug[0]) and slug[0][i].strip():
                    dev_slugs.setdefault(n, slug[0][i].strip())
        for nm, slug in zip(
            [(p.get('Architect') or '').split(',')],
            [(p.get('ArchitectSlugs') or '').split(',')]):
            for i, n in enumerate(nm[0]):
                n = n.strip()
                if not n: continue
                arches[n] += 1
                if i < len(slug[0]) and slug[0][i].strip():
                    arch_slugs.setdefault(n, slug[0][i].strip())

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
    related_links: list[tuple[str,str,int,str]],  # (city, name, count, href)
    map_search: str,            # for the Intel ask form
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
        f'<a class="rel-card" href="{esc(href)}"><div class="city">{esc(city)}</div><div class="name">{esc(name)}</div><div class="count">{n} tracked →</div></a>'
        for city, name, n, href in related_links
    ) or '<div style="opacity:.55;font-family:var(--mono);font-size:11px">More markets coming.</div>'
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

    /* Project grid — same card system the article + projects pages use */
    .grid.tmw-project-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }}
    .card {{ display:block; background:#111; border-radius:12px; overflow:hidden; transition: transform .15s, border-color .15s; border:1px solid transparent; position:relative; }}
    .card:hover {{ transform: translateY(-2px); border-color: rgba(167,139,250,.3); }}
    .card.featured {{ box-shadow: 0 0 0 1px rgba(255,211,0,.32), 0 8px 24px rgba(255,211,0,.06); }}
    .card.featured::before {{ content:"⭐ Featured"; position:absolute; top:10px; right:10px; z-index:2; font-family:var(--mono); font-size:9.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:#0a0a0a; background:var(--gold); padding:4px 9px; border-radius:5px; }}
    .card-img {{ height: 180px; background-size: cover; background-position: center; position: relative; }}
    .card-img::after {{ content:""; position:absolute; inset:0; background:linear-gradient(180deg, transparent 55%, rgba(0,0,0,.55) 100%); }}
    .card-status-pill {{ position: absolute; top: 10px; left: 10px; z-index:2; padding: 4px 9px; border-radius: 4px; font-family:var(--mono); font-size:9.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; background: rgba(0,0,0,.6); backdrop-filter: blur(6px); }}
    .pill-uc {{ color: var(--amber); }}
    .pill-bg {{ color: var(--gold); }}
    .pill-os {{ color: var(--purple-bright); }}
    .pill-no {{ color: var(--green); }}
    .pill-an {{ color: var(--mute); }}
    .card-body {{ padding: 14px 16px 16px; }}
    .card-title {{ font-family: var(--serif); font-size: 17px; font-weight: 500; letter-spacing:-.012em; line-height: 1.25; color: var(--white); margin-bottom: 4px; }}
    .card-neigh {{ font-family:var(--mono); font-size: 10.5px; letter-spacing:.1em; text-transform:uppercase; color: var(--mute); }}
    .card-meta {{ display:flex; gap:14px; margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.05); font-family:var(--mono); font-size:10px; letter-spacing:.04em; color: var(--mute); flex-wrap:wrap; }}
    .card-meta span b {{ color: var(--cream); font-weight: 500; }}

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
    .intel .ex {{ font-family:var(--mono); font-size: 11px; letter-spacing:.06em; color: var(--mute); margin-top: 16px; line-height: 1.8; }}
    .intel .ex span {{ display:inline-block; padding: 5px 11px; margin: 4px 6px 4px 0; background: rgba(255,255,255,.04); border: 1px solid var(--hair); border-radius: 999px; }}
    .intel form {{ display:flex; gap: 10px; margin-top: 22px; }}
    .intel input {{ flex: 1; background: rgba(0,0,0,.4); border: 1px solid rgba(167,139,250,.32); border-radius: 10px; padding: 14px 18px; font-family: var(--sans); font-size: 15px; color: var(--white); }}
    .intel input:focus {{ outline: 0; border-color: var(--purple-bright); }}
    .intel button {{ font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; padding: 0 24px; border-radius: 10px; background: var(--purple); color: #0a0a0a; border: 0; cursor:pointer; }}

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
      <div class="intel">
        <div class="intel-eyebrow">TMW Intelligence</div>
        <h2>Ask anything about this market.</h2>
        <form id="market-intel-form" autocomplete="off">
          <input name="q" type="text" placeholder="e.g. {esc(map_search)} under construction" autocomplete="off">
          <button type="submit">Ask</button>
        </form>
        <div class="ex">Try: <span>what's breaking ground in 2026?</span> <span>tallest tower in pipeline</span> <span>most active firm</span></div>
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

    <div class="pro-cta">
      <div class="l">
        Get the full dataset for this market, weekly Slippage Report, and the TMW Forecast on every project.
        <em>The part of Pro that pays for itself.</em>
        <i>Markets of Tomorrow Pro · $24/mo</i>
      </div>
      <button class="go" id="market-pro-cta">Go Pro →</button>
    </div>
  </div>

  <!-- Auth modal + funnel beacon helper (journal-auth.js loads transitively via journal-chrome.js) -->
  <script src="/_shared/journal-chrome.js" defer></script>
  <script src="/_shared/journal-dock.js" defer></script>
  <script src="/_shared/tmw-lightbox.js" defer></script>
  <script>
    // Intel ask → fire intel_query funnel beacon, then redirect to /map/?q=…
    document.addEventListener('DOMContentLoaded', function () {{
      var f = document.getElementById('market-intel-form');
      if (f) f.addEventListener('submit', function (e) {{
        e.preventDefault();
        var q = (f.q.value || '').trim();
        if (!q) return;
        try {{ window.tmwFunnelTrack && window.tmwFunnelTrack('intel_query', {{ source: 'market_page', q: q.slice(0, 80) }}); }} catch (_){{}}
        window.location = '{ROOT_URL}/map/?q=' + encodeURIComponent(q);
      }});
      // Pro CTA → fire go_pro_clicked beacon, then open the paywall (or fall back to upgrade URL).
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
def city_type_intro(city: str, ptype: str, n_total: int, n_uc: int, top_arch: str | None) -> tuple[str, str]:
    type_label = TYPE_PHRASING.get(ptype, ptype + 's')
    intro = (
        f'We\'re tracking <b>{n_total} new {ptype.lower()} developments</b> across {city} right now — '
        f'with <b>{n_uc} under construction</b> and more breaking ground this cycle.'
    )
    if top_arch:
        intro += f' The cycle is anchored by <b>{esc(top_arch)}</b>, leading firm by project count in this market.'
    intro += f' Every project links to a live status page with milestones, renderings, and our <a href="{ROOT_URL}/journal/">journal coverage</a>.'
    long_copy = (
        f'<h2>What\'s happening in {esc(city)} {ptype.lower()} right now</h2>'
        f'<p>{intro}</p>'
        f'<h2>How we built this list</h2>'
        f'<p>Every project on this page is on the <a href="{ROOT_URL}/map/">Map of Tomorrow</a> — our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes (breaking ground, topping out, opening) are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly slippage forecasts and the full dataset by phase, neighborhood, and architect.</p>'
    )
    return intro, long_copy

def city_intro(city: str, n_total: int, top_types: list[tuple[str,int]]) -> tuple[str, str]:
    types_phrase = ', '.join(f'<b>{esc(t)}</b> ({n})' for t, n in top_types[:3])
    intro = (
        f'We\'re tracking <b>{n_total} new developments</b> in {city} across every category — '
        f'including {types_phrase}. Every project below links to a live status page with milestones, renderings, '
        f'and our <a href="{ROOT_URL}/journal/">journal coverage</a>.'
    )
    long_copy = (
        f'<h2>The {esc(city)} pipeline</h2>'
        f'<p>{intro}</p>'
        f'<h2>How we built this list</h2>'
        f'<p>Every project on this page is on the <a href="{ROOT_URL}/map/">Map of Tomorrow</a> — our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly slippage forecasts and the full dataset by phase, neighborhood, architect, and developer.</p>'
    )
    return intro, long_copy

def type_intro(ptype: str, n_total: int, top_cities: list[tuple[str,int]]) -> tuple[str, str]:
    type_label = TYPE_PHRASING.get(ptype, ptype + 's')
    cities_phrase = ', '.join(f'<b>{esc(c)}</b> ({n})' for c, n in top_cities[:3])
    intro = (
        f'We\'re tracking <b>{n_total} new {ptype.lower()} developments</b> worldwide — '
        f'with the deepest pipelines in {cities_phrase}.'
    )
    long_copy = (
        f'<h2>The global {ptype.lower()} pipeline</h2>'
        f'<p>{intro}</p>'
        f'<h2>How we built this list</h2>'
        f'<p>Every project on this page is on the <a href="{ROOT_URL}/map/">Map of Tomorrow</a>, our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly Slippage Report and the full filterable dataset.</p>'
    )
    return intro, long_copy

# ─── Build the index hub at /markets/ ────────────────────────────────
def render_hub(city_type_pairs, city_pages, type_pages):
    """Index page at /markets/index.html linking every generated market page."""
    ct_html = ''.join(
        f'<a class="rel-card" href="{ROOT_URL}/markets/{slugify(c)}-{slugify(t)}/"><div class="city">{esc(c)}</div><div class="name">{esc(t)}</div><div class="count">{n} tracked →</div></a>'
        for (c, t, n) in city_type_pairs
    )
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
    return f"""<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>All Markets | {SITE_NAME}</title>
  <meta name="description" content="Browse every market we track on the Map of Tomorrow — by city, by project type, or by city × category. {total_links} live landing pages.">
  <link rel="canonical" href="{canonical}">
  <meta name="robots" content="index, follow">
  <link rel="icon" href="https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {{ --ink:#0d0d0d; --hair:rgba(255,255,255,.08); --white:#fff; --cream:#ECEAE5; --mute:#9AA39C; --mute-2:#C2C9C3; --purple:#A78BFA; --purple-bright:#C4B5FD;
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
    .related {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:10px; }}
    .rel-card {{ background:rgba(255,255,255,.02); border:1px solid var(--hair); border-radius:12px; padding:18px 20px; display:block; transition:border-color .15s, transform .15s; }}
    .rel-card:hover {{ border-color:rgba(167,139,250,.4); transform:translateY(-2px); }}
    .rel-card .city {{ font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); }}
    .rel-card .name {{ font-family:var(--serif); font-size:18px; font-weight:500; color:var(--white); margin-top:6px; line-height:1.2; }}
    .rel-card .count {{ font-family:var(--mono); font-size:11px; color:var(--purple-bright); margin-top:8px; }}
  </style>
</head><body>
  <div class="wrap">
    <nav class="crumbs">{crumbs_html}</nav>
    <section class="hero">
      <h1>Every market we track.</h1>
      <p class="sub">{total_links} live landing pages across {SITE_NAME}, built from our database of new developments — by city, by category, or by both.</p>
    </section>
    <section class="section">
      <h2>By city × category</h2>
      <div class="related">{ct_html}</div>
    </section>
    <section class="section">
      <h2>By city</h2>
      <div class="related">{city_html}</div>
    </section>
    <section class="section">
      <h2>By category</h2>
      <div class="related">{type_html}</div>
    </section>
  </div>
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

        n_uc = sum(1 for p in bucket if (p.get('Delivery') or '').strip() == 'Under Construction')
        # Top architect (excluding ties) for the intro paragraph
        arch_counter = collections.Counter()
        for p in bucket:
            for a in (p.get('Architect') or '').split(','):
                a = a.strip()
                if a: arch_counter[a] += 1
        top_arch = arch_counter.most_common(1)[0][0] if arch_counter else None
        intro, long_copy = city_type_intro(city, ptype, len(bucket), n_uc, top_arch)

        type_label = TYPE_PHRASING.get(ptype, ptype + 's')
        h1 = f"New {city} {type_label}"
        title_tag = f"{len(bucket)} New {city} {type_label} | {SITE_NAME}"
        meta_desc = f"We're tracking {len(bucket)} new {ptype.lower()} developments in {city} — {n_uc} under construction, plus more breaking ground and announced. Live status, architects, developers."

        crumbs = [('TMW','/'), ('Markets','/markets/'), (city, f'/markets/{slugify(city)}/' if len(by_city.get(city, [])) >= CITY_MIN else None), (ptype, None)]

        # Related links: same city other types + same type other cities + city hub + type hub
        rel: list[tuple[str,str,int,str]] = []
        for (c, t), b in by_city_type.items():
            if (c == city and t != ptype and len(b) >= CITY_TYPE_MIN):
                rel.append((c, t, len(b), f'/markets/{slugify(c)}-{slugify(t)}/'))
        for (c, t), b in by_city_type.items():
            if (t == ptype and c != city and len(b) >= CITY_TYPE_MIN):
                rel.append((c, t, len(b), f'/markets/{slugify(c)}-{slugify(t)}/'))
        rel = rel[:5]
        if len(by_city.get(city, [])) >= CITY_MIN:
            rel.append((city, 'All categories', len(by_city[city]), f'/markets/{slugify(city)}/'))
        rel.append(('Worldwide', ptype, len(by_type.get(ptype, [])), f'/markets/by-type/{slugify(ptype)}/'))

        html_out = render_page(
            h1=h1, title_tag=title_tag, meta_desc=meta_desc,
            canonical_path=f'/markets/{slug}/',
            breadcrumbs=crumbs, eyebrow=f'Live · {len(bucket)} projects tracked',
            intro_html=intro, projects=bucket, total_count=len(bucket),
            related_links=rel,
            map_search=f'{city} {ptype}', body_copy_html=long_copy,
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
        intro, long_copy = city_intro(city, len(bucket), type_counter.most_common(3))
        h1 = f"New Developments in {city}"
        title_tag = f"{len(bucket)} New Developments in {city} | {SITE_NAME}"
        meta_desc = f"Every new development we're tracking in {city} — {len(bucket)} projects across {len(type_counter)} categories."
        crumbs = [('TMW','/'), ('Markets','/markets/'), (city, None)]
        rel: list[tuple[str,str,int,str]] = []
        for (c, t), b in by_city_type.items():
            if c == city and len(b) >= CITY_TYPE_MIN:
                rel.append((c, t, len(b), f'/markets/{slugify(c)}-{slugify(t)}/'))
        rel = rel[:6]
        html_out = render_page(
            h1=h1, title_tag=title_tag, meta_desc=meta_desc,
            canonical_path=f'/markets/{slugify(city)}/',
            breadcrumbs=crumbs, eyebrow=f'Live · {len(bucket)} projects tracked',
            intro_html=intro, projects=bucket_sorted, total_count=len(bucket),
            related_links=rel, map_search=city, body_copy_html=long_copy,
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
        intro, long_copy = type_intro(ptype, len(bucket), city_counter.most_common(3))
        type_label = TYPE_PHRASING.get(ptype, ptype + 's')
        h1 = f"New {type_label} Worldwide"
        title_tag = f"{len(bucket)} New {type_label} | {SITE_NAME}"
        meta_desc = f"Every {ptype.lower()} development we're tracking worldwide — {len(bucket)} projects across {len(city_counter)} cities."
        crumbs = [('TMW','/'), ('Markets','/markets/'), ('By type','/markets/'), (ptype, None)]
        rel: list[tuple[str,str,int,str]] = []
        for (c, t), b in by_city_type.items():
            if t == ptype and len(b) >= CITY_TYPE_MIN:
                rel.append((c, t, len(b), f'/markets/{slugify(c)}-{slugify(t)}/'))
        rel = rel[:6]
        html_out = render_page(
            h1=h1, title_tag=title_tag, meta_desc=meta_desc,
            canonical_path=f'/markets/by-type/{slugify(ptype)}/',
            breadcrumbs=crumbs, eyebrow=f'Live · {len(bucket)} projects worldwide',
            intro_html=intro, projects=bucket_sorted, total_count=len(bucket),
            related_links=rel, map_search=ptype, body_copy_html=long_copy,
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
