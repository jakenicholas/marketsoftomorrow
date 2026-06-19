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
STATE_MIN     = 5            # threshold for /markets/<state>/ rollup pages — keeps SEO quality high
COUNTRY_MIN   = 1            # threshold for /markets/<country>/ rollup pages — show every country we track

# "Cities" whose value in the City field is actually a country name. These
# get their own page like any other city hub (the threshold logic still
# applies) but on the /markets/ hub they're surfaced under a separate
# "Browse by country" rail rather than mixed in with real cities. Lets us
# present Saudi Arabia next to Bahamas instead of next to Miami.
COUNTRY_CITIES: set[str] = {
    'Saudi Arabia',
    'Bahamas',
    'UAE',
    'Belize',
    'Singapore',
    'Turks and Caicos',
}
FEATURED_GRID_TARGET = 8     # cards are now 2-column with full timelines, so fewer per page

# ─── Soft paywall ───────────────────────────────────────────────────
# Market + firm pages are the source of truth for a market/firm's projects.
# We render EVERY active project card into the HTML (great for SEO — unique
# content + internal links to project/firm pages), show the first
# PAYWALL_FREE_N free, and visually lock the rest behind a "Go Pro" gate.
# Unlock is pure CSS reacting to the `html.tmw-paid` class that journal-auth.js
# sets for paid members. Schema.org paywall markup (isAccessibleForFree:false
# + hasPart cssSelector) tells Google the gating is intentional, not cloaking.
PAYWALL_FREE_N = 6

PAYWALL_CSS = """
    /* ── Soft paywall: locked project cards (in-DOM for SEO, blurred for free) ── */
    .tmw-locked { position: relative; margin-top: 14px; }
    .tmw-locked-grid {
      filter: blur(8px) saturate(.75); opacity: .55; pointer-events: none; user-select: none;
      max-height: 300px; overflow: hidden;
      -webkit-mask-image: linear-gradient(180deg,#000 0%,#000 32%,transparent 100%);
              mask-image: linear-gradient(180deg,#000 0%,#000 32%,transparent 100%);
    }
    /* Locked cards stay in the DOM (SEO) but are skipped by the renderer until
       scrolled near — defers their offscreen background-image loads so big
       rollup pages don't pay a Core Web Vitals tax. Safe for indexing:
       content-visibility:auto content is still parsed/rendered for crawlers. */
    .tmw-locked-grid .card { content-visibility: auto; contain-intrinsic-size: 0 560px; }
    .tmw-gate { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .tmw-gate-inner {
      text-align: center; max-width: 460px;
      background: linear-gradient(180deg, rgba(22,20,32,.9), rgba(16,15,24,.97));
      border: 1px solid rgba(167,139,250,.34); border-radius: 20px;
      padding: 30px 34px; box-shadow: 0 24px 70px rgba(0,0,0,.55);
      backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
    }
    .tmw-gate-badge {
      display: inline-block; font-family: var(--mono); font-size: 10px; letter-spacing: .16em;
      text-transform: uppercase; color: #0a0a0a; background: var(--gold);
      padding: 4px 10px; border-radius: 999px; font-weight: 700; margin-bottom: 14px;
    }
    .tmw-gate-title { font-family: var(--serif); font-size: 25px; font-weight: 500; letter-spacing: -.016em; color: var(--white); line-height: 1.15; margin: 0 0 8px; }
    .tmw-gate-sub { font-family: var(--sans); font-size: 13.5px; line-height: 1.5; color: var(--mute-2); margin: 0 0 20px; }
    .tmw-gate-cta {
      font-family: var(--sans); font-size: 14px; font-weight: 700; cursor: pointer;
      color: #0a0a0a; background: var(--gold); border: none; border-radius: 999px;
      padding: 13px 28px; transition: transform .12s, box-shadow .12s, background .12s;
      box-shadow: 0 6px 22px rgba(230,197,116,.32);
    }
    .tmw-gate-cta:hover { transform: translateY(-1px); background: var(--gold-soft, #f0d68a); box-shadow: 0 10px 28px rgba(230,197,116,.45); }
    /* Purple "Unlock all N" pill — twin of the gold see-all pill */
    .see-all-pill.gopro-pill { color: var(--purple-soft); border-color: rgba(167,139,250,.5); background: rgba(167,139,250,.08); }
    .see-all-pill.gopro-pill:hover { background: rgba(167,139,250,.16); border-color: rgba(167,139,250,.75); box-shadow: 0 0 22px rgba(167,139,250,.3); }
    /* Free vs paid copy swaps */
    .tmw-paid-only { display: none; }
    /* Paid unlock — CSS reacts to journal-auth.js's html.tmw-paid class */
    html.tmw-paid .tmw-locked-grid { filter: none; opacity: 1; pointer-events: auto; user-select: auto; max-height: none; overflow: visible; -webkit-mask-image: none; mask-image: none; }
    html.tmw-paid .tmw-gate { display: none; }
    html.tmw-paid .gopro-pill { display: none; }
    html.tmw-paid .tmw-free-only { display: none; }
    html.tmw-paid .tmw-paid-only { display: inline; }
"""

# Early inline (blocking, in <head>) — adds tmw-paid from the cached auth state
# BEFORE first paint so returning Pro members never flash the locked state.
PAYWALL_HEAD = (
    "<script>try{if(localStorage.getItem('tmw_auth_state')==='pro')"
    "document.documentElement.classList.add('tmw-paid');}catch(e){}</script>"
)

# Delegated click handler for every [data-gopro] affordance (gate CTA + pill).
PAYWALL_BODY_JS = """  <script>
    (function () {
      function goPro() {
        try { window.tmwFunnelTrack && window.tmwFunnelTrack('go_pro_clicked', { source: 'page_paywall', path: location.pathname }); } catch (e) {}
        if (window.tmwShowPaywall) window.tmwShowPaywall({ source: 'page_paywall' });
        else window.location = 'https://www.oftmw.com/map/?upgrade=1';
      }
      document.addEventListener('click', function (e) {
        var el = e.target.closest && e.target.closest('[data-gopro]');
        if (!el) return;
        e.preventDefault();
        goPro();
      });
    })();
  </script>"""

# Schema.org paywalled-content markup (Google-sanctioned, avoids cloaking flags).
PAYWALL_JSONLD = (
    '<script type="application/ld+json">'
    '{"@context":"https://schema.org","@type":"WebPage","isAccessibleForFree":false,'
    '"hasPart":{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".tmw-locked"}}'
    '</script>'
)


def paywall_grid(cards, total, root_url, free_n=PAYWALL_FREE_N):
    """Build the project grid with a soft paywall.

    `cards` is the list of FULLY-rendered card HTML strings (all active
    projects, already sorted). Returns (grid_html, note_html, pill_html,
    locked_count). The locked cards stay in the DOM (SEO) but are blurred and
    non-interactive until `html.tmw-paid` unlocks them via CSS.
    """
    free_cards = cards[:free_n]
    locked_cards = cards[free_n:]
    locked = len(locked_cards)
    grid = '<div class="grid tmw-project-grid">\n' + '\n'.join(free_cards) + '\n      </div>'
    if locked:
        grid += (
            f'\n      <div class="tmw-locked" data-locked-count="{locked}">'
            '\n        <div class="grid tmw-project-grid tmw-locked-grid">\n'
            + '\n'.join(locked_cards) +
            '\n        </div>'
            '\n        <div class="tmw-gate"><div class="tmw-gate-inner">'
            '<span class="tmw-gate-badge">★ TMW Pro</span>'
            f'<h3 class="tmw-gate-title">Unlock all {total} projects</h3>'
            f'<p class="tmw-gate-sub">Free shows the first {free_n}. Go Pro to see all {total} — '
            'live status, delivery dates, units and the developer &amp; architect on every one.</p>'
            '<button type="button" class="tmw-gate-cta" data-gopro>Go Pro to unlock &rarr;</button>'
            '</div></div>'
            '\n      </div>'
        )
        note = (f'<span class="tmw-free-only">{free_n} of {total} — <em>Go Pro for all</em></span>'
                f'<span class="tmw-paid-only">All {total} we’re watching</span>')
        pill = (f'<a class="see-all-pill gopro-pill" data-gopro href="{root_url}/map/?upgrade=1">'
                f'Unlock all {total} &rarr;</a>')
    else:
        note = f'All {total} we’re watching'
        pill = ''
    return grid, note, pill, locked

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
# Type tags that have been retired platform-wide and must never surface as a
# browsable category, even if a stray record still carries them. "Spa" is an
# amenity, not a development category — it was removed from the database, and
# this filter guarantees it never reappears on the site if re-tagged.
RETIRED_TYPES = {'spa'}

def _project_tags(p: dict) -> list[str]:
    """Return the canonical category tags for a project. Uses ProjectType
    (the comma-separated multi-tag field) so a mixed-use project like
    Cabot Revelstoke (Resort + Hotel + Residences + Entertainment)
    appears in EVERY category hub it actually belongs in, not just under
    its lone PreferredType sub-label ('Golf Resort'). Falls back to
    PreferredType only when ProjectType is empty. Retired types are dropped."""
    raw = (p.get('ProjectType') or '').strip()
    tags = [t.strip() for t in raw.split(',') if t.strip()]
    if not tags:
        pt = (p.get('PreferredType') or '').strip()
        if pt: tags = [pt]
    return [t for t in tags if t.lower() not in RETIRED_TYPES]

def bucket_projects(projects: list[dict]):
    by_city_type: dict[tuple[str,str], list[dict]] = collections.defaultdict(list)
    by_city:      dict[str, list[dict]]            = collections.defaultdict(list)
    by_type:      dict[str, list[dict]]            = collections.defaultdict(list)
    for p in projects:
        city = (p.get('City') or '').strip()
        if city: by_city[city].append(p)
        # A project with multiple tags appears in EVERY type and city×type
        # bucket it belongs to. Dedup-by-reference happens naturally because
        # each bucket gets its own append; downstream renderers don't need
        # to know about multi-listing.
        for tag in _project_tags(p):
            by_type[tag].append(p)
            if city: by_city_type[(city, tag)].append(p)
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

    # Card is a <div>, not <a> — because the firm bubbles inside are <a>
    # tags (links to /firm/<slug>/), and HTML disallows nested interactive
    # elements. Browsers silently break the outer <a> when they encounter
    # the inner one, which collapses our whole card layout. Wrap just the
    # image + title + meta + timeline in a single <a> (.card-link) and
    # keep the firms as separate sibling links.
    return (
        f'<div class="card{" featured" if featured else ""}"{featured_attrs}>\n'
        f'  <a class="card-link" href="{ROOT_URL}/projects/{esc(slug)}/" aria-label="Open {title}">\n'
        f'    <div class="card-img" style="background-image:url(\'{img}\')">{feat_badge}</div>\n'
        f'    <div class="card-body">\n'
        f'      <div class="card-title">{title}</div>\n'
        f'      <div class="card-loc">{loc_line}</div>\n'
        f'      {last_v_html}\n'
        f'      {timeline_html}\n'
        f'      {minis_html}\n'
        f'    </div>\n'
        f'  </a>\n'
        f'  <div class="card-firms-wrap">{firms_html}</div>\n'
        f'</div>'
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

# ─── SEO helpers (used by both market pages and firm pages) ──────────
# Common pattern: title tags + meta descriptions need year + scale to
# rank for the long-tail ("new miami condos 2026", "luxury condos
# under construction in miami"). Body copy needs FAQs to capture the
# "People also ask" panel + featured snippets.

CURRENT_YEAR = datetime.datetime.now(datetime.timezone.utc).year

def _safe_int(v) -> int:
    """Pull a clean integer out of the sheet's free-form Units/Floors fields."""
    try:
        return int(str(v).replace(',', '').strip().split()[0])
    except (ValueError, AttributeError, IndexError):
        return 0

def by_the_numbers(projects: list[dict]) -> dict:
    """Compute hard scale stats for the 'By the numbers' content block —
    total units, hotel keys, tallest tower, total floors, average size,
    earliest delivery year. Skips zero / missing values."""
    units  = [_safe_int(p.get('Units'))  for p in projects]
    keys   = [_safe_int(p.get('Keys'))   for p in projects]
    floors = [_safe_int(p.get('Floors')) for p in projects]
    units_nz  = [u for u in units  if u > 0]
    keys_nz   = [k for k in keys   if k > 0]
    floors_nz = [f for f in floors if f > 0]
    delivery_years = sorted({int(m.group(1)) for p in projects if (m := re.match(r'^(\d{4})', (p.get('DeliveryDate') or '').strip()))})
    return {
        'total_units': sum(units_nz),
        'total_keys':  sum(keys_nz),
        'total_floors': sum(floors_nz),
        'tallest_floors': max(floors_nz) if floors_nz else 0,
        'tallest_project': max(projects, key=lambda p: _safe_int(p.get('Floors')), default=None) if floors_nz else None,
        'avg_units': round(sum(units_nz) / len(units_nz)) if units_nz else 0,
        'avg_floors': round(sum(floors_nz) / len(floors_nz), 1) if floors_nz else 0,
        'earliest_delivery': delivery_years[0] if delivery_years else None,
        'latest_delivery':   delivery_years[-1] if delivery_years else None,
        'n_with_units': len(units_nz),
        'n_with_floors': len(floors_nz),
    }

def faq_section_html(items: list[tuple[str, str]]) -> str:
    """Visible FAQ section. items = [(question, answer_html), ...]."""
    if not items: return ''
    qa = ''.join(
        f'<details class="faq-q"><summary>{esc(q)}</summary><div class="faq-a">{a}</div></details>'
        for q, a in items
    )
    return (
        '    <section class="section">\n'
        '      <div class="section-head">\n'
        '        <div>\n'
        '          <div class="section-eyebrow">Common questions</div>\n'
        '          <h2 class="section-title">Frequently asked</h2>\n'
        '        </div>\n'
        '      </div>\n'
        f'      <div class="faq">{qa}</div>\n'
        '    </section>\n'
    )

def faq_jsonld(items: list[tuple[str, str]]) -> str:
    """FAQPage JSON-LD for SERP capture. items = [(q, a_html), ...].
    Strips tags from answers since schema.org expects plain text."""
    if not items: return ''
    payload = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        'mainEntity': [
            {
                '@type': 'Question',
                'name': q,
                'acceptedAnswer': {'@type': 'Answer', 'text': re.sub(r'<[^>]+>', '', a).strip()},
            }
            for q, a in items
        ],
    }
    return f'<script type="application/ld+json">{json.dumps(payload, ensure_ascii=False)}</script>'

def by_the_numbers_html(btn: dict, ptype: str|None = None) -> str:
    """Visual 'By the numbers' block for the long-tail content area.
    Skips cells whose underlying field is empty."""
    cells = []
    if btn['total_units']:
        cells.append(('Total residential units', f'{btn["total_units"]:,}', f'across {btn["n_with_units"]} project{"s" if btn["n_with_units"] != 1 else ""} with unit data'))
    if btn['total_keys']:
        cells.append(('Total hotel keys', f'{btn["total_keys"]:,}', 'across tracked hotels'))
    if btn['tallest_floors']:
        tp = btn['tallest_project']
        sub = f'{esc(tp["Title"])}, {esc(tp.get("City",""))}' if tp else ''
        cells.append(('Tallest in pipeline', f'{btn["tallest_floors"]} floors', sub))
    if btn['avg_floors']:
        cells.append(('Avg height', f'{btn["avg_floors"]} floors', f'mean of {btn["n_with_floors"]} known'))
    if btn['earliest_delivery'] and btn['latest_delivery']:
        if btn['earliest_delivery'] == btn['latest_delivery']:
            cells.append(('Delivery window', str(btn['earliest_delivery']), 'all projects same year'))
        else:
            cells.append(('Delivery window', f'{btn["earliest_delivery"]}–{btn["latest_delivery"]}', 'first to last expected delivery'))
    if not cells: return ''
    cells_html = '\n'.join(
        f'<div class="btn-cell"><div class="btn-val">{val}</div><div class="btn-lbl">{esc(lbl)}</div><div class="btn-sub">{sub}</div></div>'
        for lbl, val, sub in cells
    )
    return (
        '    <section class="section">\n'
        '      <div class="section-head">\n'
        '        <div>\n'
        '          <div class="section-eyebrow">By the numbers</div>\n'
        f'          <h2 class="section-title">The scale of the pipeline</h2>\n'
        '        </div>\n'
        '      </div>\n'
        f'      <div class="btn-grid">{cells_html}</div>\n'
        '    </section>\n'
    )

def website_jsonld() -> str:
    """WebSite JSON-LD with SearchAction so Google can grant a sitelinks
    searchbox. Bind only on hub pages."""
    payload = {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        'name':   SITE_NAME,
        'url':    ROOT_URL,
        'potentialAction': {
            '@type': 'SearchAction',
            'target': {'@type': 'EntryPoint', 'urlTemplate': f'{ROOT_URL}/?q={{search_term_string}}'},
            'query-input': 'required name=search_term_string',
        },
    }
    return f'<script type="application/ld+json">{json.dumps(payload, ensure_ascii=False)}</script>'

def place_jsonld(city: str, region: str|None = None) -> str:
    """Place schema for city hubs — feeds the knowledge graph."""
    payload = {
        '@context': 'https://schema.org',
        '@type':    'Place',
        'name':     city,
    }
    if region:
        payload['address'] = {'@type': 'PostalAddress', 'addressRegion': region}
    return f'<script type="application/ld+json">{json.dumps(payload, ensure_ascii=False)}</script>'

def _enriched_meta(base_desc: str, projects: list[dict], total_count: int) -> str:
    """Enrich a meta description with concrete numbers so it pulls more
    clicks from the SERP."""
    btn = by_the_numbers(projects)
    parts = [base_desc]
    if btn['total_units']:
        parts.append(f'{btn["total_units"]:,} total residential units')
    if btn['tallest_floors'] >= 30:
        parts.append(f'tallest at {btn["tallest_floors"]} floors')
    if btn['earliest_delivery'] and btn['latest_delivery'] and btn['earliest_delivery'] != btn['latest_delivery']:
        parts.append(f'delivering {btn["earliest_delivery"]}–{btn["latest_delivery"]}')
    return '. '.join(parts) + '.' if not parts[-1].endswith('.') else ' '.join(parts)


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
        # Breadcrumb `item` MUST be an absolute URL — Google rejects relative
        # paths with "Invalid URL in field id (in itemListElement.item)". The
        # last crumb (current page, link=None) uses the page's own canonical.
        item = link or (url if i == len(crumbs) - 1 else None)
        if item:
            node["item"] = item if item.startswith("http") else ROOT_URL + item
        crumb_list.append(node)
    payload = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": title,
        "description": desc,
        "url": url,
        "datePublished": "2026-06-01",
        "dateModified": datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d'),
        "publisher": {"@type": "Organization", "name": SITE_NAME, "url": ROOT_URL},
        "mainEntity": {"@type": "ItemList", "numberOfItems": len(items), "itemListElement": item_list},
        "breadcrumb": {"@type": "BreadcrumbList", "itemListElement": crumb_list},
    }
    return json.dumps(payload, ensure_ascii=False)

# ─── Page templates ───────────────────────────────────────────────────
def _exclude_completed(projects: list[dict]) -> list[dict]:
    """Drop Delivery='Now Open' from the bucket. Used everywhere we want
    the 'projects we're tracking closely' framing — completed projects
    are done; we're not watching them anymore. Stats strip + body copy
    still get the full bucket so visitors can see total scope."""
    return [p for p in projects if (p.get('Delivery') or '').strip() != 'Now Open']

def render_page(
    *,
    h1: str,
    title_tag: str,
    meta_desc: str,
    canonical_path: str,        # eg /markets/miami-residences/
    breadcrumbs: list[tuple[str, str|None]],
    eyebrow: str,
    intro_html: str,            # serif sub paragraph
    projects: list[dict],       # FULL bucket (all statuses, for stats + intel context)
    related_cities: list[tuple[str,str,int,str]],  # (eyebrow, name, count, href)
    more_types: list[tuple[str,str,int,str]],      # same shape, optional
    map_search: str,            # for the Intel ask form (query prefix)
    intel_city: str,            # city to pre-filter overlay results
    intel_type: str,            # type to pre-filter overlay results
    body_copy_html: str,        # long-tail SEO prose
    faqs: list[tuple[str, str]] = None,  # [(question, answer_html), ...] — both displayed + emitted as FAQPage JSON-LD
    extra_jsonld: str = '',     # additional schema.org blocks (Place, etc.)
    status_sections: str = '',  # H2 sub-sections by status, exact-match search phrases
) -> str:
    faqs = faqs or []
    canonical = ROOT_URL + canonical_path
    og_image = project_image(projects[0]) if projects else DEFAULT_IMAGE
    crumbs_html = ' <span class="sep">/</span> '.join(
        f'<a href="{esc(link)}">{esc(name)}</a>' if link else f'<b>{esc(name)}</b>'
        for name, link in breadcrumbs
    )
    ld = schema_jsonld(title_tag.split(' | ')[0], meta_desc, canonical, projects, breadcrumbs)
    faq_ld = faq_jsonld(faqs)
    btn = by_the_numbers(projects)
    btn_html = by_the_numbers_html(btn)
    faq_html_section = faq_section_html(faqs)
    # Visible "Last updated" line — trust + freshness signal Google rewards.
    # Date is the generation timestamp; pages rebuild hourly so this stays
    # current to within the hour.
    today = datetime.datetime.now(datetime.timezone.utc).strftime('%B %-d, %Y')
    # The featured "X of Y we're watching closely" grid hides Now Open —
    # they're delivered, not being tracked. Stats strip + most-active-firm
    # panels keep the full bucket so the total scope is still visible.
    # The page is the source of truth — render EVERY tracked project so the
    # grid/paywall counts match the "N tracked" headline stat. Now Open projects
    # sort to the end (stable sort keeps the existing featured-first order) so the
    # free six are the active, in-the-news ones.
    grid_projects = sorted(projects, key=lambda p: (p.get('Delivery') or '').strip() == 'Now Open')
    total_count = len(grid_projects)
    all_cards = [card_html(p) for p in grid_projects]
    grid_html, paywall_note, gopro_pill, locked_n = paywall_grid(all_cards, total_count, ROOT_URL)
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
    # The page itself is now the destination. When projects are locked, the
    # header pill becomes the purple "Unlock all N" Go-Pro CTA; small markets
    # that fit under the free cap keep the quiet "see on the map" link.
    see_all_link = gopro_pill if locked_n else (
        f'<a class="see-all-pill" href="{ROOT_URL}/map/?q={esc(map_search)}">See all {total_count} on the map →</a>'
    )
    # Early anti-flash unlock + (when locked) Schema.org paywall markup.
    paywall_head = PAYWALL_HEAD + (PAYWALL_JSONLD if locked_n else '')

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
  <link rel="icon" type="image/svg+xml" href="/media/img/favicon.svg">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

  <script type="application/ld+json">{ld}</script>
  {faq_ld}
  {extra_jsonld}
  {paywall_head}

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
    .hero-eyebrow::before {{ content:""; width:6px; height:6px; border-radius:50%; background:var(--purple); box-shadow:0 0 10px var(--purple); flex:none; }}
    /* Middot separator between the live count and the Updated date. On mobile
       (see media query) the date drops to its own line and this is hidden. */
    .hero-eyebrow .he-updated::before {{ content:"·"; margin-right:9px; }}
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
    /* "See all # on the map" — gold-bordered pill with a soft glow, lifted
       above the section-meta default underline. Matches the gold accent we
       reserve for paid-tier signals so it reads as a Pro-quality affordance. */
    .section-meta a.see-all-pill {{
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 999px;
      background: rgba(255,211,0,.06); color: var(--gold);
      border: 1px solid rgba(255,211,0,.45);
      box-shadow: 0 0 14px rgba(255,211,0,.18), inset 0 0 12px rgba(255,211,0,.05);
      font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em;
      text-transform: uppercase; text-decoration: none; font-weight: 700;
      transition: background .15s, box-shadow .15s, border-color .15s;
    }}
    .section-meta a.see-all-pill:hover {{
      background: rgba(255,211,0,.12);
      border-color: rgba(255,211,0,.7);
      box-shadow: 0 0 22px rgba(255,211,0,.32), inset 0 0 14px rgba(255,211,0,.08);
    }}

    /* Project grid — 2 columns desktop, 1 column mobile. Each card now
       includes title, location, last-verified row, the full construction
       timeline, mini stats, and developer/architect bubbles — matching the
       project page hero panel so visitors get the same context inline. */
    .grid.tmw-project-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; }}
    /* Card is now a vertical-stack container <div>. The clickable area is
       .card-link (image + body), with the firm-bubble row as a sibling
       below so the firm <a> tags don't get nested inside the card <a>. */
    .card {{ display: flex; flex-direction: column; background:#111; border-radius:14px; overflow:hidden; transition: transform .15s, border-color .15s; border:1px solid transparent; position:relative; }}
    .card:hover {{ transform: translateY(-2px); border-color: rgba(167,139,250,.3); }}
    /* No gold-glow border on featured cards — the corner star badge is
       the only featured cue. Border-only featured projects were reading
       as the same visual weight as the active hover state. */
    .card-link {{ display: block; text-decoration: none; color: inherit; }}
    .card-firms-wrap {{ padding: 0 20px 20px; }}
    /* Smaller, square gold badge with star — matches map marker style */
    .card-feat-badge {{ position:absolute; top:10px; right:10px; z-index:2; width:22px; height:22px; border-radius:5px; background:var(--gold); display:inline-flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,.4); }}
    .card-feat-badge svg {{ width:12px; height:12px; fill:#0a0a0a; }}
    .card-img {{ height: 220px; background-size: cover; background-position: center; position: relative; }}
    .card-img::after {{ content:""; position:absolute; inset:0; background:linear-gradient(180deg, transparent 60%, rgba(0,0,0,.45) 100%); }}
    .card-body {{ padding: 18px 20px 4px; }}
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
    /* "View firm profile" — matches the project page's .pp-firm .go
       (Inter, default body font, not mono) so the bubble UI reads the
       same here as on the project page itself. */
    .pp-firm .go {{ display: inline-block; margin-top: 7px; font-family: var(--sans); font-size: 11px; color: var(--green); }}
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

    /* By-the-numbers — concrete scale grid for SEO + at-a-glance scanning */
    .btn-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }}
    .btn-cell {{ background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; padding: 22px 22px; }}
    .btn-cell .btn-val {{ font-family: var(--serif); font-size: 30px; font-weight: 500; letter-spacing:-.018em; color: var(--white); line-height: 1; }}
    .btn-cell .btn-lbl {{ font-family: var(--mono); font-size: 10px; letter-spacing:.14em; text-transform: uppercase; color: var(--purple-bright); margin-top: 10px; font-weight: 600; }}
    .btn-cell .btn-sub {{ font-family: var(--sans); font-size: 12.5px; color: var(--mute); margin-top: 6px; line-height: 1.4; }}

    /* Status-grouped sub-sections — H2 headings ARE the search queries we
       want to rank for ("X condos under construction in Miami", etc.).
       Each block lists 5 real projects to make the keyword phrase
       substantive rather than spam. */
    .status-stack {{ display: flex; flex-direction: column; gap: 28px; }}
    .status-block {{ background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 14px; padding: 22px 26px; }}
    .status-block .status-h {{ font-family: var(--serif); font-size: 22px; font-weight: 500; letter-spacing:-.015em; color: var(--white); line-height: 1.2; margin-bottom: 14px; }}
    .status-block .status-list {{ list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }}
    .status-block .status-list li {{ font-family: var(--sans); font-size: 14.5px; color: var(--mute-2); line-height: 1.55; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.05); }}
    .status-block .status-list li:first-child {{ border-top: 0; padding-top: 0; }}
    .status-block .status-list a {{ color: var(--white); text-decoration: none; transition: color .15s; }}
    .status-block .status-list a:hover {{ color: var(--purple-bright); text-decoration: underline; text-underline-offset: 3px; }}
    .status-block .status-more {{ font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; margin-top: 16px; }}
    /* Purple twin of .see-all-pill (the gold hero pill) — same shape/glow,
       purple accent. Arrow lives at the END of the label ("...on the map →"). */
    .status-block .status-more a {{
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 999px;
      background: rgba(167,139,250,.07); color: var(--purple-bright);
      border: 1px solid rgba(167,139,250,.45);
      box-shadow: 0 0 14px rgba(167,139,250,.18), inset 0 0 12px rgba(167,139,250,.05);
      font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em;
      text-transform: uppercase; text-decoration: none; font-weight: 700;
      transition: background .15s, box-shadow .15s, border-color .15s;
    }}
    .status-block .status-more a:hover {{
      background: rgba(167,139,250,.13);
      border-color: rgba(167,139,250,.7);
      box-shadow: 0 0 22px rgba(167,139,250,.32), inset 0 0 14px rgba(167,139,250,.08);
    }}

    /* FAQ — collapsible Q&A for SERP capture + on-page depth */
    .faq {{ display: flex; flex-direction: column; gap: 8px; max-width: 78ch; }}
    .faq-q {{ background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; transition: border-color .15s; }}
    .faq-q[open] {{ border-color: rgba(167,139,250,.32); background: rgba(167,139,250,.04); }}
    .faq-q summary {{ list-style: none; padding: 18px 22px; cursor: pointer; font-family: var(--serif); font-size: 18px; font-weight: 500; letter-spacing:-.01em; color: var(--white); display: flex; justify-content: space-between; align-items: center; gap: 16px; }}
    .faq-q summary::after {{ content: "+"; font-family: var(--sans); font-size: 22px; color: var(--purple-bright); flex: 0 0 auto; transition: transform .2s; line-height: 1; }}
    .faq-q[open] summary::after {{ content: "−"; }}
    .faq-q summary::-webkit-details-marker {{ display: none; }}
    .faq-a {{ padding: 0 22px 22px; font-family: var(--sans); font-size: 14.5px; line-height: 1.6; color: var(--mute-2); }}
    .faq-a a {{ color: var(--purple-bright); text-decoration: underline; text-underline-offset:3px; }}
    .faq-a b {{ color: var(--cream); font-weight: 600; }}

    @media (max-width: 760px) {{
      .wrap {{ padding: 0 18px; }}
      .stats {{ grid-template-columns: repeat(2, 1fr); }}
      .leads {{ grid-template-columns: 1fr; }}
      .pro-cta {{ flex-direction: column; align-items: flex-start; }}
      .intel form {{ flex-direction: column; }}
      .intel button {{ padding: 14px 0; }}
      /* Keep "Live · # projects tracked" on one line and drop the Updated
         date onto its own line below it. */
      .hero-eyebrow {{ display: flex; flex-wrap: wrap; row-gap: 6px; }}
      .hero-eyebrow .he-updated {{ flex-basis: 100%; }}
      .hero-eyebrow .he-updated::before {{ content: none; margin-right: 0; }}
    }}
{PAYWALL_CSS}
  </style>
</head>
<body>
  <!-- Universal header injected by /_shared/journal-chrome.js -->

  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">{crumbs_html}</nav>

    <section class="hero">
      <div class="hero-eyebrow"><span class="he-live">{esc(eyebrow)}</span><time class="he-updated" datetime="{datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')}">Updated {today}</time></div>
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
          <h2 class="section-title">{paywall_note}</h2>
        </div>
        <div class="section-meta">{see_all_link}</div>
      </div>
      {grid_html}
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

{btn_html}
{status_sections}
{faq_html_section}

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
        Get the full dataset for this market and the TMW Forecast on every project.
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
      // Inline "Pro members" links (methodology copy) open the same paywall.
      Array.prototype.forEach.call(document.querySelectorAll('a.pro-link'), function (el) {{
        el.addEventListener('click', function (ev) {{
          if (!window.tmwShowPaywall) return;   // paywall JS not loaded → href fallback
          ev.preventDefault();
          try {{ window.tmwFunnelTrack && window.tmwFunnelTrack('go_pro_clicked', {{ source: 'methodology_link', path: location.pathname }}); }} catch (_){{}}
          window.tmwShowPaywall({{ source: 'methodology_link' }});
        }});
      }});
    }});
  </script>
{PAYWALL_BODY_JS}
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

# ─── Type-synonym vocabulary for SEO ──────────────────────────────────
# Each PreferredType maps to natural-language variations real visitors
# search ("Miami condos" + "Miami towers" + "Miami high-rises" + ...).
# Generators sprinkle them across H2 headings, FAQ phrasing, and body
# copy so the same page ranks for many variations of the same intent.
TYPE_SYNONYMS: dict[str, list[tuple[str, str]]] = {
    'Residences': [
        ('condo',       'condos'),
        ('tower',       'towers'),
        ('high-rise',   'high-rises'),
        ('residence',   'residences'),
        ('luxury condo','luxury condos'),
        ('residential development', 'residential developments'),
        ('condominium', 'condominiums'),
        ('apartment',   'apartments'),
    ],
    'Hotel': [
        ('hotel',         'hotels'),
        ('luxury hotel',  'luxury hotels'),
        ('boutique hotel','boutique hotels'),
        ('resort hotel',  'resort hotels'),
    ],
    'Mixed-Use': [
        ('mixed-use development',  'mixed-use developments'),
        ('mixed-use tower',        'mixed-use towers'),
        ('mixed-use district',     'mixed-use districts'),
    ],
    'Office': [
        ('office tower',     'office towers'),
        ('office building',  'office buildings'),
        ('office development','office developments'),
        ('commercial tower', 'commercial towers'),
    ],
    'Entertainment': [
        ('entertainment district','entertainment districts'),
        ('entertainment venue',   'entertainment venues'),
        ('arena',                 'arenas'),
        ('theater',               'theaters'),
    ],
    'Stadium': [
        ('stadium',         'stadiums'),
        ('arena',           'arenas'),
        ('sports venue',    'sports venues'),
        ('ballpark',        'ballparks'),
    ],
    'Park': [
        ('park',          'parks'),
        ('public space',  'public spaces'),
        ('green space',   'green spaces'),
    ],
    'Golf': [
        ('golf club',     'golf clubs'),
        ('golf course',   'golf courses'),
        ('country club',  'country clubs'),
        ('private club',  'private clubs'),
    ],
    'Museum': [
        ('museum',          'museums'),
        ('cultural venue',  'cultural venues'),
        ('gallery',         'galleries'),
        ('arts venue',      'arts venues'),
    ],
    'Education': [
        ('school',          'schools'),
        ('campus',          'campuses'),
        ('university building','university buildings'),
    ],
    'Travel': [
        ('airport',         'airports'),
        ('transit hub',     'transit hubs'),
        ('station',         'stations'),
    ],
    'Resort': [
        ('resort',        'resorts'),
        ('luxury resort', 'luxury resorts'),
        ('beach resort',  'beach resorts'),
        ('mountain resort','mountain resorts'),
    ],
}

def _type_keywords(ptype: str) -> tuple[str, str, list[tuple[str,str]]]:
    """Return (primary_singular, primary_plural, all_variations) for a type."""
    variations = TYPE_SYNONYMS.get(ptype, [(ptype.lower().rstrip('s'), ptype.lower())])
    primary_singular, primary_plural = variations[0]
    return primary_singular, primary_plural, variations

# ─── Status-grouped sub-section renderer ─────────────────────────────
# Every market page now carries H2 sub-sections with exact-match search
# phrases. Each section shows real projects so the heading isn't bare
# keyword stuffing.
STATUS_QUERY_VERBS = {
    'Under Construction': 'under construction',
    'Breaking Ground':    'breaking ground',
    'Opening Soon':       'opening soon',
    'Announced':          'announced',
    'Now Open':           'now open',
}

def _singularize(plural: str) -> str:
    """Best-effort singular form for counts of 1. Falls back to the plural
    when no obvious singular exists (mixed-use developments → mixed-use
    development; condos → condo; high-rises → high-rise)."""
    for s, p in TYPE_SYNONYMS.get('Residences', []) + [(s, p) for variants in TYPE_SYNONYMS.values() for s, p in variants]:
        if p == plural: return s
    if plural.endswith('es') and plural[-3] in 'sxz': return plural[:-2]
    if plural.endswith('s'): return plural[:-1]
    return plural

def status_sections_html(projects: list[dict], type_plural: str, location_phrase: str,
                        list_label: str = 'in') -> str:
    by_status = collections.defaultdict(list)
    for p in projects:
        d = (p.get('Delivery') or '').strip()
        if d in STATUS_QUERY_VERBS:
            by_status[d].append(p)

    for s in by_status:
        by_status[s].sort(key=lambda p: (0 if is_featured(p) else 1, (p.get('Title') or '').lower()))

    sections = []
    order = ['Under Construction', 'Breaking Ground', 'Opening Soon', 'Announced', 'Now Open']
    is_worldwide = list_label == 'worldwide'
    for status in order:
        bucket = by_status.get(status, [])
        if not bucket: continue
        n = len(bucket)
        # Singularize when n == 1 so the heading reads naturally
        # ("1 condo under construction" not "1 condos under construction").
        type_label = _singularize(type_plural) if n == 1 else type_plural
        verb = STATUS_QUERY_VERBS[status]
        # H2 phrasing — these ARE the search queries we want to rank for.
        # When the page is the global by-type hub, the "location" is the
        # word "worldwide" — used directly, NOT as a prepositional object.
        if is_worldwide:
            if status == 'Announced':
                h2 = f'{n} {type_label} just announced worldwide'
            elif status == 'Now Open':
                h2 = f'{n} {type_label} now open worldwide'
            else:
                h2 = f'{n} {type_label} {verb} worldwide'
        else:
            if status == 'Announced':
                h2 = f'{n} {type_label} just announced for {location_phrase}'
            elif status == 'Now Open':
                h2 = f'{n} {type_label} now open in {location_phrase}'
            else:
                h2 = f'{n} {type_label} {verb} {list_label} {location_phrase}'
        sample = bucket[:5]
        items = ''.join(
            f'<li><a href="{ROOT_URL}/projects/{esc(p.get("Slug",""))}/"><b>{esc(p.get("Title",""))}</b></a>'
            + (f' — {esc(p.get("City",""))}' if p.get('City') and list_label == 'worldwide' else '')
            + (f' · {_safe_int(p.get("Floors"))} floors' if _safe_int(p.get('Floors')) else '')
            + (f' · {_safe_int(p.get("Units")):,} units' if _safe_int(p.get('Units')) else '')
            + '</li>'
            for p in sample
        )
        more_link = ''
        if n > 5:
            more_link = f'<p class="status-more"><a href="{ROOT_URL}/map/?q={esc(location_phrase)}+{esc(verb)}">See all {n} on the map →</a></p>'
        sections.append(
            f'<section class="status-block">'
            f'<h2 class="status-h">{esc(h2)}</h2>'
            f'<ul class="status-list">{items}</ul>'
            f'{more_link}'
            f'</section>'
        )
    if not sections: return ''
    pipeline_label = 'global' if is_worldwide else esc(location_phrase)
    return (
        '    <section class="section status-pipeline">\n'
        '      <div class="section-head">\n'
        '        <div>\n'
        '          <div class="section-eyebrow">Pipeline by status</div>\n'
        f'          <h2 class="section-title">The {pipeline_label} pipeline, status by status</h2>\n'
        '        </div>\n'
        '      </div>\n'
        '      <div class="status-stack">\n'
        + '\n'.join(sections) +
        '      </div>\n'
        '    </section>\n'
    )

# ─── FAQ generators ────────────────────────────────────────────────────
# Q&A items are pulled directly from the data set so answers stay accurate
# every hourly run. Each generator returns a list of (question, answer_html)
# tuples — page render code splats them into both the visible FAQ section
# and the FAQPage JSON-LD.

def faqs_city_type(city: str, ptype: str, projects: list[dict]) -> list[tuple[str, str]]:
    """12+ Q&A items per page, covering every typical search-intent
    variation: "what's coming to", "what's under construction in",
    "what's opening soon in", "what's just announced for", "tallest X in",
    "who is building", "where are the most X", "best new X", etc.
    Synonyms (condos / towers / high-rises / residences) rotate through
    so the page ranks for all of them."""
    sb = _status_breakdown(projects)
    btn = by_the_numbers(projects)
    devs, dev_slugs = _count_firms(projects, 'Developer', 'DeveloperSlugs')
    arches, arch_slugs = _count_firms(projects, 'Architect', 'ArchitectSlugs')
    n_total = len(projects)
    sing, plur, variants = _type_keywords(ptype)
    # Pull two more synonyms for variety in question phrasing
    syn1 = variants[1] if len(variants) > 1 else (sing, plur)
    syn2 = variants[2] if len(variants) > 2 else (sing, plur)
    qa: list[tuple[str, str]] = []

    # Q1 — overall pipeline (most common search intent)
    pipe_parts = []
    if sb['uc']:  pipe_parts.append(f'<b>{sb["uc"]} under construction</b>')
    if sb['bg']:  pipe_parts.append(f'<b>{sb["bg"]} breaking ground</b>')
    if sb['os']:  pipe_parts.append(f'<b>{sb["os"]} opening soon</b>')
    if sb['an']:  pipe_parts.append(f'<b>{sb["an"]} announced</b>')
    if sb['no']:  pipe_parts.append(f'<b>{sb["no"]} already delivered</b>')
    pipe_str = ', '.join(pipe_parts) or 'no active tracking right now'
    qa.append((
        f'What new {plur} are coming to {city}?',
        f'We track <b>{n_total} new {plur} development{"s" if n_total != 1 else ""}</b> in {esc(city)} — {pipe_str}. Status is sourced from public filings, official announcements, and on-the-ground reporting; we update the live map within hours of confirming a change.',
    ))

    # Q2 — Under construction (high-value search)
    if sb['uc']:
        qa.append((
            f'How many {syn1[1]} are under construction in {city}?',
            f'<b>{sb["uc"]} {plur}</b> are currently under construction in {esc(city)}. View the live status on each in the pipeline grid above — every project links to a page with construction milestones, renderings, and our journal coverage.',
        ))

    # Q3 — Opening soon (high-intent buyer search)
    if sb['os']:
        qa.append((
            f'What {plur} are opening soon in {city}?',
            f'<b>{sb["os"]} {plur}</b> are flagged Opening Soon — meaning their expected opening is within ~7 months. Pro members get our weekly Slippage Report which flags every project whose forecast moved this week.',
        ))

    # Q4 — Just announced (early-stage research search)
    if sb['an']:
        qa.append((
            f'What {plur} have just been announced for {city}?',
            f'<b>{sb["an"]} {plur}</b> are in the announced phase in {esc(city)} — meaning a developer has publicly committed but construction has not yet begun. These are the earliest signals of where the next cycle is heading.',
        ))

    # Q5 — Breaking ground
    if sb['bg']:
        qa.append((
            f'What {syn2[1]} are breaking ground in {city}?',
            f'<b>{sb["bg"]} {plur}</b> are at the breaking-ground phase — site work and foundations have begun. This is the first visible signal of construction activity.',
        ))

    # Q6 — Tallest project
    if btn['tallest_project']:
        tp = btn['tallest_project']
        units_blurb = ''
        u = _safe_int(tp.get('Units'))
        if u: units_blurb = f', with {u:,} units'
        qa.append((
            f'What is the tallest new {sing} planned in {city}?',
            f'<b>{esc(tp["Title"])}</b> at <b>{btn["tallest_floors"]} floors</b>{units_blurb}. Status: {esc(tp.get("Delivery","Announced"))}. <a href="{ROOT_URL}/projects/{esc(tp.get("Slug",""))}/">See the full project page →</a>',
        ))

    # Q7 — Top developer
    if devs:
        top_dev_name, top_dev_n = devs.most_common(1)[0]
        ds = dev_slugs.get(top_dev_name, '')
        link = f'<a href="{ROOT_URL}/firm/{esc(ds)}/">{esc(top_dev_name)}</a>' if ds else f'<b>{esc(top_dev_name)}</b>'
        qa.append((
            f'Who is building the most new {plur} in {city}?',
            f'{link} leads {city} {plur} with <b>{top_dev_n} active project{"s" if top_dev_n != 1 else ""}</b>. See every {esc(top_dev_name)} project on TMW for status, milestones, and renderings.',
        ))

    # Q8 — Top architect
    if arches:
        top_arch_name, top_arch_n = arches.most_common(1)[0]
        as_ = arch_slugs.get(top_arch_name, '')
        link = f'<a href="{ROOT_URL}/firm/{esc(as_)}/">{esc(top_arch_name)}</a>' if as_ else f'<b>{esc(top_arch_name)}</b>'
        qa.append((
            f'Which architects are designing new {plur} in {city}?',
            f'{link} is the architect of record on <b>{top_arch_n} {city} {plur.lower()} project{"s" if top_arch_n != 1 else ""}</b> — the most of any firm in this market.',
        ))

    # Q9 — Total residential scale
    if btn['total_units']:
        qa.append((
            f'How many total new residential units are being added in {city}?',
            f'Across the active {city} {plur.lower()} pipeline, the developments we track will add <b>{btn["total_units"]:,} units</b>. Pro members get unit counts by neighborhood and the per-project breakdown.',
        ))

    # Q10 — Delivery window
    if btn['earliest_delivery'] and btn['latest_delivery']:
        if btn['earliest_delivery'] == btn['latest_delivery']:
            window = f'all currently expected in <b>{btn["earliest_delivery"]}</b>'
        else:
            window = f'delivery dates run from <b>{btn["earliest_delivery"]}</b> through <b>{btn["latest_delivery"]}</b>'
        qa.append((
            f'When will the next wave of {city} {plur} deliver?',
            f'Across the active pipeline, {window}. Individual delivery dates shift constantly — Pro members get our weekly Slippage Report flagging which projects have slipped this week.',
        ))

    # Q11 — Biggest by units
    units_proj = max((p for p in projects), key=lambda p: _safe_int(p.get('Units')), default=None)
    if units_proj and _safe_int(units_proj.get('Units')):
        n_units = _safe_int(units_proj.get('Units'))
        qa.append((
            f'What is the biggest {sing} planned in {city} by unit count?',
            f'<b>{esc(units_proj["Title"])}</b> with <b>{n_units:,} units</b> is the largest by residential unit count in our {city} dataset. <a href="{ROOT_URL}/projects/{esc(units_proj.get("Slug",""))}/">See the project →</a>',
        ))

    # Q12 — Featured / most-watched
    featured = [p for p in projects if is_featured(p)]
    if featured:
        names = ', '.join(f'<b>{esc(p["Title"])}</b>' for p in featured[:5])
        qa.append((
            f'What are the most-watched new {plur} in {city}?',
            f'Our editors flag the highest-profile projects as Featured. The current {city} Featured set: {names}. Each is marked with a gold star in the pipeline grid above.',
        ))

    # Q13 — Update cadence
    qa.append((
        f'How often is the {city} {plur} data updated?',
        f'Hourly. Our cron pipeline pulls fresh project data every hour and regenerates this page (and every market and firm page) from the source-of-truth database. A status change confirmed today shows up within ~60 minutes.',
    ))

    return qa[:13]

def faqs_city(city: str, projects: list[dict]) -> list[tuple[str, str]]:
    """Same expanded coverage for whole-city pages — no type filter, so
    questions hit broader patterns: 'new developments in X', 'projects
    coming to X', 'best new construction in X', 'X biggest projects', etc."""
    sb = _status_breakdown(projects)
    btn = by_the_numbers(projects)
    devs, dev_slugs = _count_firms(projects, 'Developer', 'DeveloperSlugs')
    type_counter = collections.Counter((p.get('PreferredType') or '').strip() for p in projects if (p.get('PreferredType') or '').strip())
    n_total = len(projects)
    qa: list[tuple[str, str]] = []

    qa.append((
        f'What new developments are coming to {city}?',
        f'<b>{n_total} new development{"s" if n_total != 1 else ""}</b> across <b>{len(type_counter)} categor{"ies" if len(type_counter) != 1 else "y"}</b> — {sb["uc"]} under construction, {sb["bg"]} breaking ground, {sb["os"]} opening soon, and {sb["an"]} just announced. See the live map for every project.',
    ))

    if sb['uc']:
        qa.append((
            f'What is under construction in {city}?',
            f'<b>{sb["uc"]} project{"s" if sb["uc"] != 1 else ""}</b> are currently under construction in {esc(city)} across every category we track. Each links to a live status page with milestones, renderings, and journal coverage.',
        ))

    if sb['os']:
        qa.append((
            f'What projects are opening soon in {city}?',
            f'<b>{sb["os"]} project{"s" if sb["os"] != 1 else ""}</b> in the {city} pipeline are flagged Opening Soon — meaning expected opening within ~7 months. Pro members get weekly delivery updates on each.',
        ))

    if sb['an']:
        qa.append((
            f'What projects have just been announced for {city}?',
            f'<b>{sb["an"]} project{"s" if sb["an"] != 1 else ""}</b> are in the announced phase for {esc(city)} — meaning a developer has publicly committed but construction has not yet begun.',
        ))

    if type_counter:
        types_phrase = ', '.join(f'<b>{esc(t)}</b> ({n})' for t, n in type_counter.most_common(3))
        qa.append((
            f'What kinds of new projects are being built in {city}?',
            f'The {city} pipeline is dominated by {types_phrase}. Each category has its own dedicated landing page — explore the "More project types in {city}" section above.',
        ))

    if devs:
        top_dev_name, top_dev_n = devs.most_common(1)[0]
        ds = dev_slugs.get(top_dev_name, '')
        link = f'<a href="{ROOT_URL}/firm/{esc(ds)}/">{esc(top_dev_name)}</a>' if ds else f'<b>{esc(top_dev_name)}</b>'
        qa.append((
            f'Who is the biggest developer in {city}?',
            f'{link} leads {city} with <b>{top_dev_n} active project{"s" if top_dev_n != 1 else ""}</b> across categories. Their firm page shows every market they\'re building in.',
        ))

    if btn['tallest_project']:
        tp = btn['tallest_project']
        qa.append((
            f'What is the tallest project planned in {city}?',
            f'<b>{esc(tp["Title"])}</b> at <b>{btn["tallest_floors"]} floors</b> — currently {esc(tp.get("Delivery", "Announced"))}. <a href="{ROOT_URL}/projects/{esc(tp.get("Slug", ""))}/">Open the project page →</a>',
        ))

    if btn['total_units']:
        qa.append((
            f'How many residential units are being added across {city}?',
            f'Across the active {city} pipeline, the developments we track will add <b>{btn["total_units"]:,} residential units</b>. Pro members get the unit count by neighborhood and project type.',
        ))

    if btn['earliest_delivery'] and btn['latest_delivery']:
        if btn['earliest_delivery'] != btn['latest_delivery']:
            qa.append((
                f'When will the next wave of {city} projects open?',
                f'Delivery dates across the active {city} pipeline run from <b>{btn["earliest_delivery"]}</b> through <b>{btn["latest_delivery"]}</b>. Pro members get our weekly Slippage Report flagging which projects have slipped this week.',
            ))

    featured = [p for p in projects if is_featured(p)]
    if featured:
        names = ', '.join(f'<b>{esc(p["Title"])}</b>' for p in featured[:5])
        qa.append((
            f'What are the most-watched new projects in {city}?',
            f'Our editors flag the highest-profile projects as Featured. The current {city} Featured set: {names}. Each is marked with a gold star in the pipeline grid above.',
        ))

    qa.append((
        f'How often is the {city} development data updated?',
        f'Hourly. Our map and every market page (including this one) rebuild from our database every hour, so a status change confirmed today shows up here within ~60 minutes. Editorial follow-ups land in the journal within the day.',
    ))

    return qa[:13]

def faqs_type(ptype: str, projects: list[dict]) -> list[tuple[str, str]]:
    """Type-hub FAQs covering ALL global-by-type search variations:
    'cities with the most condos', 'where are the most luxury hotels',
    'tallest stadium', etc. Uses the same synonym vocabulary."""
    sb = _status_breakdown(projects)
    btn = by_the_numbers(projects)
    city_counter = collections.Counter((p.get('City') or '').strip() for p in projects if (p.get('City') or '').strip())
    devs, dev_slugs = _count_firms(projects, 'Developer', 'DeveloperSlugs')
    arches, arch_slugs = _count_firms(projects, 'Architect', 'ArchitectSlugs')
    n_total = len(projects)
    sing, plur, variants = _type_keywords(ptype)
    qa: list[tuple[str, str]] = []

    if city_counter:
        cities_phrase = ', '.join(f'<b>{esc(c)}</b> ({n})' for c, n in city_counter.most_common(5))
        qa.append((
            f'Which cities have the most new {plur}?',
            f'The deepest {plur.lower()} pipelines are in {cities_phrase}. We track <b>{n_total} {plur.lower()} project{"s" if n_total != 1 else ""}</b> total across <b>{len(city_counter)} cities</b>.',
        ))

    qa.append((
        f'How many new {plur} are under construction worldwide?',
        f'<b>{sb["uc"]} {plur}</b> are currently under construction worldwide. Plus <b>{sb["bg"]} breaking ground</b>, <b>{sb["os"]} opening soon</b>, and <b>{sb["an"]} announced</b> in the global pipeline.',
    ))

    if sb['os']:
        qa.append((
            f'What new {plur} are opening soon worldwide?',
            f'<b>{sb["os"]} {plur}</b> are flagged Opening Soon — meaning expected opening within ~7 months. Browse each individually in the pipeline grid above.',
        ))

    if sb['an']:
        qa.append((
            f'What {plur} have just been announced for {CURRENT_YEAR}?',
            f'<b>{sb["an"]} {plur}</b> are in the announced phase across our global dataset. Each links to a live status page that updates as construction begins.',
        ))

    if btn['tallest_project']:
        tp = btn['tallest_project']
        qa.append((
            f'What is the tallest new {sing} in the global pipeline?',
            f'<b>{esc(tp["Title"])}</b> in <b>{esc(tp.get("City", ""))}</b> at <b>{btn["tallest_floors"]} floors</b>. <a href="{ROOT_URL}/projects/{esc(tp.get("Slug", ""))}/">See the project →</a>',
        ))

    if devs:
        top_dev_name, top_dev_n = devs.most_common(1)[0]
        ds = dev_slugs.get(top_dev_name, '')
        link = f'<a href="{ROOT_URL}/firm/{esc(ds)}/">{esc(top_dev_name)}</a>' if ds else f'<b>{esc(top_dev_name)}</b>'
        qa.append((
            f'Who is the most active developer in {plur} worldwide?',
            f'{link} leads the {plur.lower()} category with <b>{top_dev_n} active project{"s" if top_dev_n != 1 else ""}</b>. Their firm page shows every market they\'re building in.',
        ))

    if arches:
        top_arch_name, top_arch_n = arches.most_common(1)[0]
        as_ = arch_slugs.get(top_arch_name, '')
        link = f'<a href="{ROOT_URL}/firm/{esc(as_)}/">{esc(top_arch_name)}</a>' if as_ else f'<b>{esc(top_arch_name)}</b>'
        qa.append((
            f'Who designs the most new {plur}?',
            f'{link} is the architect of record on <b>{top_arch_n} {plur.lower()} project{"s" if top_arch_n != 1 else ""}</b> in our global dataset.',
        ))

    if btn['total_units']:
        qa.append((
            f'How many total residential units are coming online in new {plur}?',
            f'Across the active global {plur.lower()} pipeline, the developments we track will add <b>{btn["total_units"]:,} residential units</b>.',
        ))

    if btn['earliest_delivery'] and btn['latest_delivery'] and btn['earliest_delivery'] != btn['latest_delivery']:
        qa.append((
            f'When will the next wave of new {plur} deliver?',
            f'Delivery dates across the active global pipeline run from <b>{btn["earliest_delivery"]}</b> through <b>{btn["latest_delivery"]}</b>. Pro members get our weekly Slippage Report flagging which projects have slipped this week.',
        ))

    qa.append((
        f'How often is the {plur} development data updated?',
        f'Hourly. Our cron pipeline pulls fresh project data every hour and regenerates every market page. A status change confirmed today shows up within ~60 minutes.',
    ))

    return qa[:10]


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
    intro += f' Every project links to a live status page with milestones, renderings, and our <a href="{ROOT_URL}/">journal coverage</a>.'

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
          f'<p>Every project on this page is from our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes (breaking ground, topping out, opening) are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1" class="pro-link">Pro members</a> get full access to TMW Intelligence&rsquo;s prediction modeling, Atlas data compilation, Pulse notifications, personalized notifications, comparison view, watchlists, and more.</p>'
    )
    return intro, long_copy

def city_intro(city: str, projects: list[dict], top_types: list[tuple[str,int]]) -> tuple[str, str]:
    s = _status_breakdown(projects)
    n_total = len(projects)
    types_phrase = ', '.join(f'<b>{esc(t)}</b> ({n})' for t, n in top_types[:3])
    intro = (
        f'We\'re tracking <b>{n_total} new developments</b> in {city} across every category — '
        f'including {types_phrase}. Every project below links to a live status page with milestones, renderings, '
        f'and our <a href="{ROOT_URL}/">journal coverage</a>.'
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
          f'<p>Every project on this page is from our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes (breaking ground, topping out, opening) are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1" class="pro-link">Pro members</a> get full access to TMW Intelligence&rsquo;s prediction modeling, Atlas data compilation, Pulse notifications, personalized notifications, comparison view, watchlists, and more.</p>'
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
        f'<p>Every project on this page is from our live database of new and under-construction developments worldwide. We add a project only after we can confirm it from a public filing, an official announcement, or independent reporting; status changes (breaking ground, topping out, opening) are sourced the same way and timestamped. <a href="{ROOT_URL}/map/?upgrade=1" class="pro-link">Pro members</a> get full access to TMW Intelligence&rsquo;s prediction modeling, Atlas data compilation, Pulse notifications, personalized notifications, comparison view, watchlists, and more.</p>'
    )
    return intro, long_copy

# ─── Build the index hub at /markets/ ────────────────────────────────
def render_html_sitemap(out_path: str, city_pages, type_pages, state_pages, city_type_pairs) -> None:
    """User-facing sitemap at /sitemap/ — flat list of every market URL we
    generate, grouped by category. Provides users an alternative way to
    browse the site and gives Google one more in-graph path to every leaf
    page (HTML sitemaps still help crawlability)."""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    canonical = f'{ROOT_URL}/sitemap/'
    def _section(title: str, items: list[tuple[str, str]]) -> str:
        if not items: return ''
        rows = ''.join(f'<li><a href="{esc(url)}">{esc(name)}</a></li>' for url, name in items)
        return (
            f'<section class="sitemap-section">'
            f'<h2>{esc(title)}</h2>'
            f'<ul class="sitemap-list">{rows}</ul>'
            f'</section>'
        )

    state_items = [(f'/markets/{slugify(s)}/', f'{s} — {n} projects') for s, n in state_pages]
    city_items  = [(f'/markets/{slugify(c)}/', f'{c} — {n} projects') for c, n in city_pages]
    type_items  = [(f'/markets/by-type/{slugify(t)}/', f'{t} (worldwide) — {n} projects') for t, n in type_pages]
    ct_items    = [(f'/markets/{slugify(c)}-{slugify(t)}/', f'{c} · {t} — {n} projects') for c, t, n in city_type_pairs]

    page = f"""<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sitemap — Every Page on {SITE_NAME}</title>
  <meta name="description" content="Full sitemap of every market, state, category, and city page on Markets of Tomorrow. {len(state_pages) + len(city_pages) + len(type_pages) + len(city_type_pairs)} landing pages — find what you need fast.">
  <link rel="canonical" href="{canonical}">
  <meta name="robots" content="index, follow">
  <link rel="icon" type="image/svg+xml" href="/media/img/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {{ --ink:#0d0d0d; --hair:rgba(255,255,255,.08); --white:#fff; --cream:#ECEAE5; --mute:#9AA39C; --mute-2:#C2C9C3; --purple:#A78BFA; --purple-bright:#C4B5FD;
      --sans:'Inter',-apple-system,sans-serif; --serif:'Fraunces',Georgia,serif; --mono:'JetBrains Mono',ui-monospace,monospace; }}
    *,*::before,*::after {{ box-sizing:border-box; margin:0; padding:0; }}
    body {{ background:var(--ink); color:var(--cream); font-family:var(--sans); line-height:1.55; }}
    body::before {{ content:""; position:fixed; inset:0; z-index:0; pointer-events:none;
      background: radial-gradient(820px 540px at 76% -6%, rgba(167,139,250,.10), transparent 60%); }}
    a {{ color:inherit; text-decoration:none; }}
    .wrap {{ position:relative; z-index:1; max-width:1200px; margin:0 auto; padding:0 24px 90px; }}
    .crumbs {{ padding:22px 0 0; font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute); }}
    .crumbs .sep {{ opacity:.4; margin:0 8px; }}
    .crumbs b {{ color:var(--purple-bright); }}
    .hero {{ padding:30px 0 38px; border-bottom:1px solid var(--hair); }}
    .hero h1 {{ font-family:var(--serif); font-size:clamp(40px,5.4vw,64px); line-height:1.04; font-weight:500; letter-spacing:-.022em; color:var(--white); max-width:20ch; }}
    .hero .sub {{ font-family:var(--serif); font-style:italic; font-weight:300; font-size:18px; color:var(--mute-2); margin-top:18px; max-width:62ch; }}
    .sitemap-section {{ padding:34px 0; border-bottom:1px solid var(--hair); }}
    .sitemap-section h2 {{ font-family:var(--serif); font-size:26px; font-weight:500; letter-spacing:-.018em; color:var(--white); margin-bottom:18px; }}
    .sitemap-list {{ list-style:none; padding:0; columns:2; column-gap:30px; }}
    @media (max-width: 760px) {{ .sitemap-list {{ columns:1; }} }}
    .sitemap-list li {{ font-family:var(--sans); font-size:14px; padding:5px 0; break-inside:avoid; }}
    .sitemap-list a {{ color:var(--purple-bright); text-decoration:underline; text-underline-offset:3px; }}
    .sitemap-list a:hover {{ color:var(--white); }}
  </style>
</head><body>
  <div class="wrap">
    <nav class="crumbs"><a href="/">TMW</a><span class="sep">/</span><b>Sitemap</b></nav>
    <section class="hero">
      <h1>Every page we publish.</h1>
      <p class="sub">A flat index of every market, state, category, and city we generate. Use this to jump straight to any landing page — or to discover combinations you haven't seen yet.</p>
    </section>
{_section("By state / region", state_items)}
{_section("By city", city_items)}
{_section("By category (worldwide)", type_items)}
{_section("By city × category", ct_items)}
  </div>
  <script src="/_shared/journal-chrome.js" defer></script>
  <script src="/_shared/journal-dock.js" defer></script>
</body></html>
"""
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(page)


def render_state_page(state_label: str, state_code: str, bucket: list[dict],
                      by_city: dict, by_city_type: dict, city_to_state: dict) -> str:
    """Generate a /markets/<state>/ rollup page. Aggregates every project
    in the state into one mega-pipeline view, lists the cities with their
    individual market pages, and computes top developers/architects at
    the state level. H1 + FAQ + status-grouped sub-sections all target
    "new developments in <state>" search variants."""
    state_slug = slugify(state_label)
    n_total = len(bucket)
    sb = _status_breakdown(bucket)
    btn = by_the_numbers(bucket)
    # Group bucket into cities, sort by count desc
    cities_in_state = collections.Counter()
    for p in bucket:
        c = (p.get('City') or '').strip()
        if c: cities_in_state[c] += 1
    # Build city cards for "Browse by city in <state>" section
    city_cards: list[tuple[str,str,int,str]] = []
    for city, n in cities_in_state.most_common():
        if len(by_city.get(city, [])) >= CITY_MIN:
            city_cards.append(('CITY', city, n, f'/markets/{slugify(city)}/'))
    city_cards = city_cards[:24]
    related_html = ''.join(
        f'<a class="rel-card" href="{esc(href)}"><div class="city">{esc(label)}</div><div class="name">{esc(name)}</div><div class="count">{n} project{"s" if n != 1 else ""} →</div></a>'
        for label, name, n, href in city_cards
    )
    # Top types in this state
    type_counter = collections.Counter((p.get('PreferredType') or '').strip() for p in bucket if (p.get('PreferredType') or '').strip())
    type_cards: list[tuple[str,str,int,str]] = []
    for ptype, n in type_counter.most_common():
        if n >= 5:
            # Link to the global by-type page since per-state-by-type would dilute
            type_cards.append(('CATEGORY', ptype, n, f'/markets/by-type/{slugify(ptype)}/'))
    type_cards = type_cards[:12]
    type_html = ''.join(
        f'<a class="rel-card" href="{esc(href)}"><div class="city">{esc(label)}</div><div class="name">{esc(name)}</div><div class="count">{n} project{"s" if n != 1 else ""} →</div></a>'
        for label, name, n, href in type_cards
    )

    # FAQs at state level
    devs, dev_slugs = _count_firms(bucket, 'Developer', 'DeveloperSlugs')
    arches, arch_slugs = _count_firms(bucket, 'Architect', 'ArchitectSlugs')
    state_faqs: list[tuple[str, str]] = []
    state_faqs.append((
        f'What new developments are coming to {state_label}?',
        f'We track <b>{n_total} active development{"s" if n_total != 1 else ""}</b> across {state_label} — {sb["uc"]} under construction, {sb["bg"]} breaking ground, {sb["os"]} opening soon, and {sb["an"]} announced. Every city with at least 3 projects has a dedicated landing page (see below).',
    ))
    if sb['uc']:
        state_faqs.append((
            f'How many projects are under construction in {state_label}?',
            f'<b>{sb["uc"]} project{"s" if sb["uc"] != 1 else ""}</b> are currently under construction across {state_label}, ranging from luxury condos to mixed-use districts. Click any city below for the full local pipeline.',
        ))
    if sb['os']:
        state_faqs.append((
            f'What projects are opening soon in {state_label}?',
            f'<b>{sb["os"]} project{"s" if sb["os"] != 1 else ""}</b> are flagged Opening Soon across {state_label} — expected to open within ~7 months.',
        ))
    if cities_in_state:
        top_cities_phrase = ', '.join(f'<b>{esc(c)}</b> ({n})' for c, n in cities_in_state.most_common(3))
        state_faqs.append((
            f'Which {state_label} cities have the most new developments?',
            f'The deepest pipelines are in {top_cities_phrase}. {state_label} has <b>{len(cities_in_state)} cities</b> with active projects in our database.',
        ))
    if devs:
        top_dev_name, top_dev_n = devs.most_common(1)[0]
        ds = dev_slugs.get(top_dev_name, '')
        link = f'<a href="{ROOT_URL}/firm/{esc(ds)}/">{esc(top_dev_name)}</a>' if ds else f'<b>{esc(top_dev_name)}</b>'
        state_faqs.append((
            f'Who is the biggest developer building in {state_label}?',
            f'{link} leads {state_label} with <b>{top_dev_n} active project{"s" if top_dev_n != 1 else ""}</b> across cities.',
        ))
    if arches:
        top_arch_name, top_arch_n = arches.most_common(1)[0]
        as_ = arch_slugs.get(top_arch_name, '')
        link = f'<a href="{ROOT_URL}/firm/{esc(as_)}/">{esc(top_arch_name)}</a>' if as_ else f'<b>{esc(top_arch_name)}</b>'
        state_faqs.append((
            f'Which architects are designing the most new projects in {state_label}?',
            f'{link} is the architect of record on <b>{top_arch_n} {state_label} project{"s" if top_arch_n != 1 else ""}</b> — the most of any firm in the state.',
        ))
    if btn['tallest_project']:
        tp = btn['tallest_project']
        state_faqs.append((
            f'What is the tallest tower being built in {state_label}?',
            f'<b>{esc(tp["Title"])}</b> in <b>{esc(tp.get("City",""))}</b> at <b>{btn["tallest_floors"]} floors</b>. <a href="{ROOT_URL}/projects/{esc(tp.get("Slug",""))}/">See the project →</a>',
        ))
    if btn['total_units']:
        state_faqs.append((
            f'How many new residential units are being added across {state_label}?',
            f'Across the active {state_label} pipeline, the developments we track will add <b>{btn["total_units"]:,} residential units</b> across {n_total} projects.',
        ))
    if btn['earliest_delivery'] and btn['latest_delivery'] and btn['earliest_delivery'] != btn['latest_delivery']:
        state_faqs.append((
            f'When will the next wave of {state_label} projects deliver?',
            f'Delivery dates across the active {state_label} pipeline run from <b>{btn["earliest_delivery"]}</b> through <b>{btn["latest_delivery"]}</b>. Individual delivery dates shift constantly — Pro members get our weekly Slippage Report.',
        ))
    state_faqs.append((
        f'How often is the {state_label} development data updated?',
        f'Hourly. Our cron pipeline pulls fresh data from the source-of-truth database every hour and regenerates this page (and every market and firm page).',
    ))

    # Long-tail body copy
    types_phrase = ', '.join(f'<b>{esc(t)}</b> ({n})' for t, n in type_counter.most_common(3)) or '—'
    cities_phrase_full = ', '.join(f'<a href="/markets/{slugify(c)}/"><b>{esc(c)}</b></a> ({n})' for c, n in cities_in_state.most_common(5)) or '—'
    body_copy = (
        f'<h2>The {esc(state_label)} pipeline</h2>'
        f'<p>We track <b>{n_total} new development{"s" if n_total != 1 else ""}</b> across {state_label} — {sb["uc"]} under construction, {sb["bg"]} breaking ground, {sb["os"]} opening soon, and {sb["an"]} announced. Most active markets: {cities_phrase_full}. Specializing in: {types_phrase}.</p>'
        f'<h2>How we built this list</h2>'
        f'<p>Every project on this page is on the <a href="{ROOT_URL}/map/">Map of Tomorrow</a> — our live database of new and under-construction developments worldwide. Project status, milestones, and spec changes are sourced from public filings, official announcements, or independent reporting and timestamped. <a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly Slippage Report, the TMW Forecast on every project, and the full {state_label} dataset by phase, neighborhood, and developer.</p>'
    )

    intro_html = (
        f'We\'re tracking <b>{n_total} new development{"s" if n_total != 1 else ""}</b> across <b>{state_label}</b> — '
        f'spanning <b>{len(cities_in_state)} cities</b> and <b>{len(type_counter)} project categor{"ies" if len(type_counter) != 1 else "y"}</b>. '
        f'Every city links to a dedicated local market page with the full pipeline.'
    )

    return render_page(
        h1=f'New Developments in {state_label}',
        title_tag=f'{n_total} New Developments in {state_label} ({CURRENT_YEAR}) | {SITE_NAME}',
        meta_desc=' · '.join([
            f'{n_total} new developments across {state_label}',
            f'{sb["uc"]} under construction',
            f'{btn["total_units"]:,} residential units' if btn['total_units'] else '',
            f'tallest at {btn["tallest_floors"]} floors' if btn['tallest_floors'] >= 25 else '',
        ]).replace(' ·  ·', ' ·').strip(' ·')[:280],
        canonical_path=f'/markets/{state_slug}/',
        breadcrumbs=[('TMW','/'), ('Markets','/markets/'), (state_label, None)],
        eyebrow=f'Live · {n_total} projects across {len(cities_in_state)} {state_label} cities',
        intro_html=intro_html,
        projects=bucket,
        related_cities=city_cards[:6],   # top cities as the related-markets section
        more_types=type_cards[:6],       # top types in this state as "More" section
        map_search=state_label,
        intel_city='', intel_type='',     # state-level — no single city/type prefix
        body_copy_html=body_copy,
        faqs=state_faqs[:12],
        status_sections=status_sections_html(bucket, type_plural='projects', location_phrase=state_label),
    )


def render_hub(city_type_pairs, city_pages, type_pages, state_pages=None, country_pages=None):
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
    # State rollup links — only if any state pages were generated.
    state_pages = state_pages or []
    state_cards_html = ''.join(
        f'<a class="rel-card" href="{ROOT_URL}/markets/{slugify(s)}/"><div class="city">All cities + categories</div><div class="name">{esc(s)}</div><div class="count">{n} tracked →</div></a>'
        for (s, n) in state_pages
    )
    state_section_html = (
        '    <section class="section">\n'
        '      <h2>Browse by state / region</h2>\n'
        f'      <div class="related">{state_cards_html}</div>\n'
        '    </section>\n'
    ) if state_cards_html else ''

    # Country links — same shape as cities but surfaced separately so
    # Saudi Arabia / Bahamas / Singapore aren't sandwiched between
    # Miami and Aventura.
    country_pages = country_pages or []
    country_cards_html = ''.join(
        f'<a class="rel-card" href="{ROOT_URL}/markets/{slugify(c)}/"><div class="city">National pipeline</div><div class="name">{esc(c)}</div><div class="count">{n} tracked →</div></a>'
        for (c, n) in country_pages
    )
    country_section_html = (
        '    <section class="section">\n'
        '      <h2>Browse by country</h2>\n'
        f'      <div class="related">{country_cards_html}</div>\n'
        '    </section>\n'
    ) if country_cards_html else ''
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

    # Hub-level FAQs — broader questions about the database itself.
    hub_faqs = [
        ('How many cities does Markets of Tomorrow track?',
         f'We currently track active development projects across <b>{len(city_pages)}+ cities</b> worldwide, with <b>{len(type_pages)} project categories</b>. Every city with at least 3 projects gets its own dedicated landing page.'),
        ('How often is the market data updated?',
         f'Hourly. Our cron pipeline pulls fresh project data from the source-of-truth database every hour, regenerates every market and firm landing page, and updates the live map. A status change confirmed today shows up here within ~60 minutes.'),
        ('Can I filter by city, category, and delivery year?',
         f'Yes — use the calculator above. Pick a city + category + delivery window and we\'ll show you the matching project count and link straight to the dedicated landing page when one exists.'),
        ('What does "Pro" unlock?',
         f'<a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get our weekly Slippage Report, the TMW Forecast on every project (statistical delivery prediction with confidence interval), and the full filterable database by phase, neighborhood, architect, and developer.'),
        ('Is the data sourced or speculative?',
         f'Every project on every page is sourced — added only after we can confirm it from a public filing, an official announcement, or independent reporting. Status changes (breaking ground, topping out, opening) are timestamped to the real-world event date and citation-linked.'),
    ]
    hub_faq_ld = faq_jsonld(hub_faqs)
    hub_faq_section = faq_section_html(hub_faqs)

    return f"""<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>All Markets ({CURRENT_YEAR}) — {total_links}+ Landing Pages | {SITE_NAME}</title>
  <meta name="description" content="Browse every new development we track on the Map of Tomorrow — {len(city_pages)} cities, {len(type_pages)} categories, {total_links} live landing pages. Filter by city, category, or delivery year to find the projects in your pipeline.">
  <link rel="canonical" href="{canonical}">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="website">
  <meta property="og:title" content="All Markets ({CURRENT_YEAR}) | {SITE_NAME}">
  <meta property="og:description" content="{total_links} live landing pages across {len(city_pages)} cities and {len(type_pages)} categories. Filter, browse, and ask anything.">
  <meta property="og:url" content="{canonical}">
  <link rel="icon" type="image/svg+xml" href="/media/img/favicon.svg">
  {website_jsonld()}
  {hub_faq_ld}
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

    /* FAQ — same component as the per-page Q&A so SERP impact accrues to the hub too */
    .faq {{ display: flex; flex-direction: column; gap: 8px; max-width: 78ch; }}
    .faq-q {{ background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; transition: border-color .15s; }}
    .faq-q[open] {{ border-color: rgba(167,139,250,.32); background: rgba(167,139,250,.04); }}
    .faq-q summary {{ list-style: none; padding: 18px 22px; cursor: pointer; font-family: var(--serif); font-size: 18px; font-weight: 500; color: var(--white); display: flex; justify-content: space-between; align-items: center; gap: 16px; letter-spacing:-.01em; }}
    .faq-q summary::after {{ content: "+"; font-family: var(--sans); font-size: 22px; color: var(--purple-bright); flex: 0 0 auto; line-height: 1; }}
    .faq-q[open] summary::after {{ content: "−"; }}
    .faq-q summary::-webkit-details-marker {{ display: none; }}
    .faq-a {{ padding: 0 22px 22px; font-family: var(--sans); font-size: 14.5px; line-height: 1.6; color: var(--mute-2); }}
    .faq-a a {{ color: var(--purple-bright); text-decoration: underline; text-underline-offset:3px; }}
    .faq-a b {{ color: var(--cream); font-weight: 600; }}
    .section-eyebrow {{ font-family: var(--mono); font-size: 10.5px; letter-spacing:.2em; text-transform:uppercase; color: var(--purple-bright); margin-bottom: 8px; font-weight: 600; }}
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
{state_section_html}
{country_section_html}
    <section class="section">
      <h2>Browse by category</h2>
      <div class="related">{type_html}</div>
    </section>

{hub_faq_section}
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
# ─── Featured Markets carousel feed ──────────────────────────────────
# Writes journal/featured-markets.json — a sibling to featured-lists.json —
# so the home page's Featured Lists slider can mix in city market hubs
# alongside the hand-curated journal lists (West Palm Beach Story, Iconic
# Hotels, Iconic Restaurants, etc.). The card schema mirrors featured-lists.json
# so the existing renderer in journal/index.html displays them identically.
#
# Selection rules:
#   - Top 10 cities by total project count, excluding tiny markets (<3)
#   - Image is sourced from the highest-priority project in that city:
#     featured first, then under-construction, then anything with an image
#   - Title alternates between a few naturals so the carousel reads varied
# State abbrev → display label. International "states" (Bahamas, Saudi
# Arabia, etc.) we just label by country directly in cityStateMap.
_STATE_FULL = {
    'FL':'Florida','NY':'New York','TN':'Tennessee','CA':'California','TX':'Texas',
    'IL':'Illinois','GA':'Georgia','NC':'North Carolina','MA':'Massachusetts','UT':'Utah',
    'WA':'Washington','CO':'Colorado','NV':'Nevada','HI':'Hawaii','PA':'Pennsylvania',
    'AZ':'Arizona','OH':'Ohio','MI':'Michigan','MO':'Missouri','OR':'Oregon','VA':'Virginia',
    'MD':'Maryland','SC':'South Carolina','MN':'Minnesota','WI':'Wisconsin','KY':'Kentucky',
    'OK':'Oklahoma','LA':'Louisiana','AL':'Alabama','AR':'Arkansas','MS':'Mississippi',
    'NJ':'New Jersey','CT':'Connecticut','NM':'New Mexico','KS':'Kansas','IA':'Iowa',
    'ME':'Maine','VT':'Vermont','NH':'New Hampshire','RI':'Rhode Island','DE':'Delaware',
    'WV':'West Virginia','AK':'Alaska','MT':'Montana','WY':'Wyoming','ID':'Idaho',
    'ND':'North Dakota','SD':'South Dakota','NE':'Nebraska','IN':'Indiana','DC':'District of Columbia',
}

# ISO 3166-1 alpha-2 → country name. cityStateMap.json stores international
# locations as ISO 3166-2 subdivision codes ("GB-ENG", "JP-13", "AE-DU",
# "SA-07", "BS-NP"); the alpha-2 prefix is the country. US locations are stored
# as bare state abbreviations (FL, NY, …) and roll up to "United States".
ISO2_COUNTRY = {
    'US': 'United States', 'GB': 'United Kingdom', 'JP': 'Japan',
    'AE': 'United Arab Emirates', 'SA': 'Saudi Arabia', 'QA': 'Qatar',
    'BS': 'Bahamas', 'TC': 'Turks and Caicos', 'KY': 'Cayman Islands',
    'SG': 'Singapore', 'TH': 'Thailand', 'MY': 'Malaysia', 'KR': 'South Korea',
    'CN': 'China', 'MX': 'Mexico', 'FR': 'France', 'IT': 'Italy', 'ES': 'Spain',
    'PT': 'Portugal', 'GR': 'Greece', 'CH': 'Switzerland', 'NO': 'Norway',
    'EG': 'Egypt', 'BZ': 'Belize', 'CA': 'Canada', 'AU': 'Australia',
    'AG': 'Antigua and Barbuda', 'SX': 'Sint Maarten', 'AW': 'Aruba',
    'BB': 'Barbados', 'DO': 'Dominican Republic', 'PR': 'Puerto Rico',
    'CR': 'Costa Rica', 'AI': 'Anguilla', 'MT': 'Malta', 'VG': 'British Virgin Islands',
    'MV': 'Maldives', 'ME': 'Montenegro',
}

def _derive_country(raw: str) -> str:
    """Resolve a cityStateMap.json value (US state abbrev, ISO 3166-2 code, or
    a bare country name) to a country name. US states → 'United States';
    'GB-ENG' → 'United Kingdom'; a bare 'Saudi Arabia' stays as-is."""
    raw = (raw or '').strip()
    if not raw: return ''
    if raw in _STATE_FULL: return 'United States'
    if '-' in raw:
        return ISO2_COUNTRY.get(raw.split('-', 1)[0], raw)
    return ISO2_COUNTRY.get(raw, raw)

def _city_region(city: str) -> str:
    """Return a display label for the city's state/region/country, sourced
    from cityStateMap.json. Used as the small subtitle below the city name
    on the Browse-by-Market tiles. Falls back to empty string when the
    city isn't mapped (international cities mostly map to country names
    directly: 'Saudi Arabia' → 'Saudi Arabia')."""
    try:
        with open('cityStateMap.json', encoding='utf-8') as f:
            m = json.load(f)
        raw = (m.get(city) or '').strip()
        if not raw: return ''
        # US states get the country suffix to match the mockup language;
        # international locations resolve their ISO code to a clean country
        # name ("GB-ENG" → "United Kingdom") rather than leaking the raw code.
        if raw in _STATE_FULL:
            return f'{_STATE_FULL[raw]} · USA'
        return _derive_country(raw)
    except (FileNotFoundError, json.JSONDecodeError):
        return ''

def render_featured_markets_json(by_city: dict[str, list[dict]], path: str) -> int:
    # Headline templates rotate by city hash so the same city always gets
    # the same headline (deterministic across runs). Avoids the carousel
    # reading as a single repeated phrase.
    TITLES = [
        "Every project reshaping {city}",
        "Inside the {city} pipeline",
        "What's coming to {city}",
        "The {city} development cycle",
        "Tracking {city}'s next chapter",
    ]
    # Hand-picked tile images for specific markets (override the auto-pick).
    # Keyed by city — use when a particular project's rendering is the one we
    # want to lead with on the homepage tile.
    MARKET_IMAGE_OVERRIDES = {
        'Riviera Beach': 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_445dcb51bfab4b5f97729a55a31eca71~mv2.jpg',  # 123 Ocean
        'Palm Beach':    'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_297b07c045bc4d1a9b0fbb166b176dee~mv2.webp',  # Palm Beach Residences
        'Tampa':         'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_849dfca008d048fc8e457d6a3a684df6~mv2.jpg',  # hand-picked Tampa tile
        'New York City': 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/2026/06/9ed74446045e-A-crop.jpg',  # hand-picked NYC tile
        'Chicago':       'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_e85c6445394e48b481914a1d9ab75215~mv2.jpg',  # hand-picked Chicago tile
    }
    def pick_image(projects: list[dict]) -> str | None:
        # Featured > Under Construction > anything with an image. We want
        # the most photogenic + recognizable rendering, not just "first row".
        def priority(p):
            uc = (p.get('Delivery') or '').strip() == 'Under Construction'
            return (0 if is_featured(p) else 1, 0 if uc else 1, (p.get('Title') or '').lower())
        with_img = [p for p in projects if (p.get('ImageURL') or '').strip()]
        if not with_img: return None
        with_img.sort(key=priority)
        return (with_img[0].get('ImageURL') or '').strip()

    ranked = sorted(
        ((city, len(bucket), bucket) for city, bucket in by_city.items() if len(bucket) >= 3),
        key=lambda r: -r[1]
    )[:10]

    cards = []
    for i, (city, n, bucket) in enumerate(ranked):
        img = MARKET_IMAGE_OVERRIDES.get(city) or pick_image(bucket)
        if not img: continue                    # don't ship a card without a real image
        title_template = TITLES[hash(city) % len(TITLES)]
        cards.append({
            'id':       f'market-{slugify(city)}',
            'title':    title_template.format(city=city),
            'image':    img,
            'location': city,
            'region':   _city_region(city),    # state + country for the tile subtitle
            'count':    n,                     # project count as a clean integer
            'ctaLabel': f'Browse {n} projects',
            'url':      f'/markets/{slugify(city)}/',
            'source':   'market_hub',          # lets the loader tag/track if needed
            'active':   True,
        })

    payload = {
        '_comment': 'Auto-generated by generate_market_pages.py. Top cities pulled from projects-flat.json — same Featured flag logic as the rest of the SEO market pipeline. Edit the curated featured-lists.json for the hand-picked carousel slots.',
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'lists': cards,
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return len(cards)

def render_featured_types_json(by_type: dict[str, list[dict]], path: str) -> int:
    # Top project types by tracked count — sibling to featured-markets.json.
    # Powers the compact "browse by category" teaser row under Browse by Market
    # on the home page (text-only cards; the page shows the top 5 on desktop / 6
    # on mobile). Each links to the worldwide by-type page.
    ranked = sorted(((t, len(b)) for t, b in by_type.items() if t and len(b) >= 1),
                    key=lambda r: -r[1])[:12]
    items = [{
        'label':   t,
        'count':   n,
        'eyebrow': 'Worldwide',
        'url':     f'/markets/by-type/{slugify(t)}/',
    } for t, n in ranked]
    payload = {
        '_comment': 'Auto-generated by generate_market_pages.py. Top project types by tracked count; powers the home-page category teaser row.',
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'types': items,
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return len(items)

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

        # Default plural is `ptype + 's'`, but guard against types that already
        # end in 's' (Residences, Eateries, etc.) — without this they render as
        # "Residencess" / "Eateriess" wherever TYPE_PHRASING has no entry.
        type_label = TYPE_PHRASING.get(ptype, ptype if ptype.endswith('s') else ptype + 's')
        h1 = f"New {city} {type_label}"
        # SEO title: lead with the COUNT (drives CTR), the location, the keyword,
        # and the year so the SERP listing reads as freshly current.
        title_tag = f"{len(bucket)} New {city} {type_label} ({CURRENT_YEAR}) | {SITE_NAME}"
        _sb = _status_breakdown(bucket)
        _btn = by_the_numbers(bucket)
        # Meta desc: stack the most search-relevant facts (count, status, units,
        # height range, delivery window) so the 155-char window pulls more clicks.
        meta_parts = [f"{len(bucket)} new {ptype.lower()} developments in {city}"]
        if _sb['uc']: meta_parts.append(f"{_sb['uc']} under construction")
        if _sb['bg']: meta_parts.append(f"{_sb['bg']} breaking ground")
        if _sb['an']: meta_parts.append(f"{_sb['an']} announced")
        if _btn['total_units']: meta_parts.append(f"{_btn['total_units']:,} total units")
        if _btn['tallest_floors'] >= 25: meta_parts.append(f"tallest at {_btn['tallest_floors']} floors")
        meta_desc = " · ".join(meta_parts)[:280]

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
            intro_html=intro, projects=bucket, related_cities=related_cities, more_types=more_types,
            map_search=f'{city} {ptype}',
            intel_city=city, intel_type=ptype,
            body_copy_html=long_copy,
            faqs=faqs_city_type(city, ptype, bucket),
            extra_jsonld=place_jsonld(city),
            status_sections=status_sections_html(
                bucket,
                type_plural=_type_keywords(ptype)[1],
                location_phrase=city,
            ),
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
        title_tag = f"{len(bucket)} New Developments in {city} ({CURRENT_YEAR}) | {SITE_NAME}"
        _sb = _status_breakdown(bucket)
        _btn = by_the_numbers(bucket)
        meta_parts = [f"{len(bucket)} new developments in {city} across {len(type_counter)} categories"]
        if _sb['uc']: meta_parts.append(f"{_sb['uc']} under construction")
        if _btn['total_units']: meta_parts.append(f"{_btn['total_units']:,} residential units")
        if _btn['tallest_floors'] >= 25: meta_parts.append(f"tallest at {_btn['tallest_floors']} floors")
        meta_desc = " · ".join(meta_parts)[:280]
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
            intro_html=intro, projects=bucket_sorted, related_cities=related_cities, more_types=more_types,
            map_search=city, intel_city=city, intel_type='',
            body_copy_html=long_copy,
            faqs=faqs_city(city, bucket),
            extra_jsonld=place_jsonld(city),
            status_sections=status_sections_html(
                bucket,
                type_plural='projects',
                location_phrase=city,
            ),
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
        # Default plural is `ptype + 's'`, but guard against types that already
        # end in 's' (Residences, Eateries, etc.) — without this they render as
        # "Residencess" / "Eateriess" wherever TYPE_PHRASING has no entry.
        type_label = TYPE_PHRASING.get(ptype, ptype if ptype.endswith('s') else ptype + 's')
        h1 = f"New {type_label} Worldwide"
        title_tag = f"{len(bucket)} New {type_label} Worldwide ({CURRENT_YEAR}) | {SITE_NAME}"
        _sb = _status_breakdown(bucket)
        _btn = by_the_numbers(bucket)
        meta_parts = [f"{len(bucket)} new {ptype.lower()} developments worldwide across {len(city_counter)} cities"]
        if _sb['uc']: meta_parts.append(f"{_sb['uc']} under construction")
        if _btn['total_units']: meta_parts.append(f"{_btn['total_units']:,} residential units")
        if _btn['tallest_floors'] >= 30: meta_parts.append(f"tallest at {_btn['tallest_floors']} floors")
        meta_desc = " · ".join(meta_parts)[:280]
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
            intro_html=intro, projects=bucket_sorted, related_cities=related_cities, more_types=[],
            map_search=ptype, intel_city='', intel_type=ptype,
            body_copy_html=long_copy,
            faqs=faqs_type(ptype, bucket),
            status_sections=status_sections_html(
                bucket,
                type_plural=_type_keywords(ptype)[1],
                location_phrase='worldwide',
                list_label='worldwide',
            ),
        )
        path = f"{OUTPUT_DIR}/by-type/{slugify(ptype)}/"
        os.makedirs(path, exist_ok=True)
        open(os.path.join(path, 'index.html'), 'w', encoding='utf-8').write(html_out)
        pages_written.append(f'by-type/{slugify(ptype)}/index.html')
        generated_paths.append(f'/markets/by-type/{slugify(ptype)}/')
        type_pages_for_hub.append((ptype, len(bucket)))
        n_type += 1

    # ─── 3.5. State/region rollup pages ──────────────────────────────
    # "/markets/<state>/" pages aggregate every city in a state — captures
    # massive search volume that no single-city page can reach ("new
    # developments in Florida", "California condos under construction").
    # Threshold is ≥5 projects per state. International "states" (Bahamas,
    # Saudi Arabia, etc.) get the same treatment since they're already
    # mapped 1:1 to a region label by cityStateMap.json.
    state_pages_written = 0
    state_pages_for_hub: list[tuple[str,int]] = []
    try:
        with open('cityStateMap.json', encoding='utf-8') as f:
            city_to_state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        city_to_state = {}
    if city_to_state:
        by_state: dict[str, list[dict]] = collections.defaultdict(list)
        for p in projects:
            c = (p.get('City') or '').strip()
            st = city_to_state.get(c)
            if st: by_state[st].append(p)
        for state_code, bucket in by_state.items():
            if len(bucket) < STATE_MIN: continue
            # Skip ISO 3166-2 international subdivision codes ("SA-07",
            # "GB-ENG", "AE-DU", "BS-BI", "CN-SH", etc.). The dominant
            # cities in those regions (London, Dubai, Saudi Arabia,
            # Bahamas, Shanghai) already have their own /markets/<city>/
            # pages with the right SEO framing — a state rollup at this
            # level would just compete with the existing city page
            # without adding new ranking signal. US states (FL, NY,
            # TN, etc.) get rollups because they aggregate many distinct
            # well-known cities under one famous state name.
            if '-' in state_code or state_code not in _STATE_FULL:
                continue
            state_label = _STATE_FULL[state_code]
            state_slug  = slugify(state_label)
            bucket_sorted = sort_projects(bucket)
            html_out = render_state_page(
                state_label=state_label,
                state_code=state_code,
                bucket=bucket_sorted,
                by_city=by_city,
                by_city_type=by_city_type,
                city_to_state=city_to_state,
            )
            path = f"{OUTPUT_DIR}/{state_slug}/"
            os.makedirs(path, exist_ok=True)
            open(os.path.join(path, 'index.html'), 'w', encoding='utf-8').write(html_out)
            generated_paths.append(f'/markets/{state_slug}/')
            state_pages_written += 1
            state_pages_for_hub.append((state_label, len(bucket)))

    # ─── 3b. Country rollup pages /markets/<country>/ ────────────────
    # Every project resolves to a country via cityStateMap (US states →
    # "United States"; ISO 3166-2 codes → their country; a bare country name
    # stays as-is). We aggregate ALL projects per country and render one
    # national rollup page per country (reusing the state-page renderer —
    # it's a generic geographic rollup). This is what powers a complete
    # "Browse by country" rail instead of only the handful of cities whose
    # name happens to be a country.
    country_pages_for_hub: list[tuple[str, int]] = []
    if city_to_state:
        by_country: dict[str, list[dict]] = collections.defaultdict(list)
        for p in projects:
            c = (p.get('City') or '').strip()
            raw = (city_to_state.get(c) or '').strip()
            ctry = _derive_country(raw) if raw else _derive_country(c)
            if ctry: by_country[ctry].append(p)
        for country, bucket in by_country.items():
            if len(bucket) < COUNTRY_MIN: continue
            country_slug = slugify(country)
            bucket_sorted = sort_projects(bucket)
            html_out = render_state_page(
                state_label=country,
                state_code=country,
                bucket=bucket_sorted,
                by_city=by_city,
                by_city_type=by_city_type,
                city_to_state=city_to_state,
            )
            path = f"{OUTPUT_DIR}/{country_slug}/"
            os.makedirs(path, exist_ok=True)
            open(os.path.join(path, 'index.html'), 'w', encoding='utf-8').write(html_out)
            generated_paths.append(f'/markets/{country_slug}/')
            country_pages_for_hub.append((country, len(bucket)))

    # ─── 4. Hub /markets/index.html ──────────────────────────────────
    city_type_pairs_for_hub.sort(key=lambda x: -x[2])
    city_pages_for_hub.sort(key=lambda x: -x[1])
    type_pages_for_hub.sort(key=lambda x: -x[1])
    state_pages_for_hub.sort(key=lambda x: -x[1])
    country_pages_for_hub.sort(key=lambda x: -x[1])
    # Pseudo-cities whose name is actually a country (Saudi Arabia, Bahamas,
    # Singapore, …) are now covered by the country rail above, so drop them
    # from the city rail to avoid listing the same place twice.
    city_only_pages_for_hub = [(c, n) for c, n in city_pages_for_hub if c not in COUNTRY_CITIES]
    hub = render_hub(
        city_type_pairs_for_hub,
        city_only_pages_for_hub,
        type_pages_for_hub,
        state_pages_for_hub,
        country_pages=country_pages_for_hub,
    )
    open(os.path.join(OUTPUT_DIR, 'index.html'), 'w', encoding='utf-8').write(hub)
    generated_paths.append('/markets/')

    # ─── 5. Write a manifest the workflow can sitemap-include ────────
    with open(os.path.join(OUTPUT_DIR, '.urls.json'), 'w', encoding='utf-8') as f:
        json.dump({'urls': generated_paths, 'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}, f, indent=2)

    # ─── 6. Cleanup orphan pages from prior runs ─────────────────────
    # When a city gets renamed/merged in the database (e.g. "New York" →
    # "New York City"), the old slug's market page persists on disk
    # because the generator only writes, never deletes. Walk every
    # directory under /markets/ and remove anything not in the generated
    # path set. Without this, search engines keep indexing a stale page
    # and the page itself shows zero matching projects.
    expected_dirs: set[str] = set()
    for url_path in generated_paths:
        # /markets/miami-residences/ → journal/markets/miami-residences
        # /markets/by-type/hotel/    → journal/markets/by-type/hotel
        if url_path.startswith('/markets/'):
            rel = url_path.strip('/').split('/', 1)[1] if '/' in url_path.strip('/') else ''
            if rel:
                expected_dirs.add(os.path.normpath(os.path.join(OUTPUT_DIR, rel)))
    expected_dirs.add(os.path.normpath(OUTPUT_DIR))                            # /markets/ root
    expected_dirs.add(os.path.normpath(os.path.join(OUTPUT_DIR, 'by-type')))   # type hub parent

    n_pruned = 0
    pruned_paths: list[str] = []
    for parent in [OUTPUT_DIR, os.path.join(OUTPUT_DIR, 'by-type')]:
        if not os.path.isdir(parent): continue
        for entry in os.listdir(parent):
            sub = os.path.join(parent, entry)
            if not os.path.isdir(sub): continue
            if os.path.normpath(sub) in expected_dirs: continue
            # Only delete leaves that look like our own output (contain index.html)
            idx = os.path.join(sub, 'index.html')
            if not os.path.isfile(idx): continue
            try:
                os.remove(idx)
                # rmdir only succeeds on empty dirs — safe by design
                os.rmdir(sub)
                pruned_paths.append(sub)
                n_pruned += 1
            except OSError as e:
                print(f'  ! could not prune {sub}: {e}')

    # ─── 7. Featured Markets carousel feed for the journal home ─────
    n_fm = render_featured_markets_json(by_city, 'journal/featured-markets.json')
    n_ft = render_featured_types_json(by_type, 'journal/featured-types.json')
    print(f"  ✓ featured-markets.json ({n_fm} markets) · featured-types.json ({n_ft} types)")

    # ─── 8. HTML sitemap at /sitemap/ (user-facing + crawler hint) ────
    # Single page listing every market, firm, city, state, and project
    # category we generate. Lets users browse the full surface area and
    # gives Google one extra in-graph crawl path to every leaf URL.
    render_html_sitemap(
        out_path='journal/sitemap/index.html',
        city_pages=city_pages_for_hub,
        type_pages=type_pages_for_hub,
        state_pages=state_pages_for_hub,
        city_type_pairs=city_type_pairs_for_hub,
    )
    generated_paths.append('/sitemap/')

    print(f"  ✓ {n_ct} city×type pages")
    print(f"  ✓ {n_city} city hubs")
    print(f"  ✓ {n_type} type hubs")
    print(f"  ✓ {state_pages_written} state/region rollup pages")
    print(f"  ✓ 1 markets/ index")
    print(f"  ✓ {n_fm} featured-market cards for the home carousel")
    if n_pruned:
        print(f"  ✗ pruned {n_pruned} orphan page(s):")
        for p in pruned_paths: print(f"      - {p}")
    print(f"  → wrote .urls.json manifest with {len(generated_paths)} URLs")

if __name__ == '__main__':
    main()
