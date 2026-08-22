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
import json, os, re, html, collections, datetime, sys, urllib.parse
from tmw_search_bar import MC_SEARCH_CSS, mc_search_html_for, mc_search_js_for

# Reuse the project page's timeline + delivery formatters so every card on a
# market page mirrors the project page's hero panel exactly. generate_pages.py
# guards its main() under __name__ == '__main__', so importing it here is safe.
from generate_pages import (
    progress_bar_html,
    format_delivery_display,
    _format_time_to_delivery,
)
# Atlas Intelligence — Surface C (supply pressure). Imported so market pages
# and atlas-intel.json can never disagree on a score.
from generate_atlas_intel import compute_all as compute_atlas_intel
from generate_pages import atlas_intel_section_html as onyx_project_card, ATLAS_PROJ_PUBLIC as ONYX_PUB

ROOT_URL   = "https://www.oftmw.com"
SITE_NAME  = "Markets of Tomorrow"
OUTPUT_DIR = "journal/markets"
DEFAULT_IMAGE = "https://media.oftmw.com/wix/ca3b83_93ffb2f000f94a12aa874fe44153be18~mv2.jpg"

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

# ── Recency window ── Market + firm pages only surface projects that OPENED in
# the last 12 months; once a 'Now Open' project is 12+ months past its opening
# date it ages off both pages. Non-open projects and opens we can't date (or that
# are dated in the future) are always kept.
def project_open_date(p):
    """Best-effort LATEST-plausible opening date from DeliveryDate (bare year →
    Dec 31, YYYY-MM → month end). Returns a datetime.date, or None if undatable."""
    import calendar
    s = str(p.get('DeliveryDate') or '').strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    if m:
        try: return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError: pass
    m = re.match(r'^(\d{4})-(\d{2})$', s)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        if 1 <= mo <= 12:
            return datetime.date(y, mo, calendar.monthrange(y, mo)[1])
    m = re.search(r'(19|20)\d{2}', s)
    if m:
        try: return datetime.date(int(m.group(0)), 12, 31)
        except ValueError: pass
    return None

def drop_stale_open_projects(projects, months=12, today=None):
    """Remove 'Now Open' projects that opened MORE than `months` ago. Applied once
    at load in the market + firm generators so it propagates to every count, the
    grid, the intro, and the JSON."""
    today = today or datetime.date.today()
    try:
        cutoff = today.replace(year=today.year - (months // 12) - (1 if months % 12 else 0))
    except ValueError:
        cutoff = today.replace(year=today.year - 1, day=28)
    out = []
    for p in projects:
        if (p.get('Delivery') or '').strip() == 'Now Open':
            d = project_open_date(p)
            if d is not None and d < cutoff:
                continue  # opened 12+ months ago → age it off
        out.append(p)
    return out

CITY_TYPE_MIN = 3

# Module-level lookup populated once at the start of each consuming script's
# main() (market pages + firm pages) so card_html can render the "Part of
# <District>" chip on child-component cards without threading the lookup
# through every call site. set_parent_title_lookup() is the public setter.
_PARENT_TITLE_BY_SLUG: dict[str, str] = {}

def set_parent_title_lookup(rows):
    """Caller (market_pages.main / firm_pages.main) invokes this once with the
    full projects-flat rows so card_html can resolve any project's parent
    district title for the chip render."""
    _PARENT_TITLE_BY_SLUG.clear()
    for r in rows:
        sl = ((r.get('Slug') or '')).strip()
        tl = ((r.get('Title') or '')).strip()
        if sl and tl:
            _PARENT_TITLE_BY_SLUG[sl] = tl
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
    html.tmw-paid .pro-cta { display: none; }
    html.tmw-paid .tmw-free-only { display: none; }
    html.tmw-paid .tmw-paid-only { display: inline; }
    .tmw-loadmore { display: block; margin: 20px auto 0; font-family: var(--sans); font-size: 13px; font-weight: 600; color: #B9A6FF; background: rgba(167,139,250,.08); border: 1px solid rgba(167,139,250,.32); border-radius: 999px; padding: 12px 28px; cursor: pointer; transition: background .15s, border-color .15s; }
    .tmw-loadmore:hover { background: rgba(167,139,250,.16); border-color: rgba(167,139,250,.55); }
    /* "Part of <District>" chip — overlaid on .card-img in the bottom-left
       corner so cards stay aligned by default (no body-space reservation
       needed). Lives here in PAYWALL_CSS so BOTH market and firm pages
       (which import PAYWALL_CSS) inherit the rule. Needs .card-img to be
       position:relative — handled by the existing card styles. */
    .card-img { position: relative; overflow: hidden; }
    /* Real, crawlable <img> fills the fixed-height .card-img box exactly like
       the old CSS background did (object-fit:cover, centered). Shared here so
       BOTH market and firm pages render indexable images. */
    .card-img .card-img-el { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }
    .card-parent-chip {
      position: absolute;
      left: 10px;
      bottom: 10px;
      z-index: 2;
      display: inline-flex; align-items: center;
      padding: 4px 9px;
      font-family: var(--sans); font-size: 11px; font-weight: 600;
      color: #C9BBFF;
      background: rgba(20, 17, 36, 0.78);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(167,139,250,0.46);
      border-radius: 6px;
      max-width: calc(100% - 20px);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    }

    /* ── Developer / architect firm PILLS ─ every firm listed as a clickable
       pill; the fitter in PAYWALL_BODY_JS caps each box at two rows and folds
       overflow into a purple "+N more" pill (→ the project page). Shared by the
       market cards AND the firm-page portfolio cards. ── */
    .pp-firm-group { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 13px 14px; }
    .pp-firm-group > .k { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.4); }
    .pp-firm-chips { display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start; gap: 6px; margin-top: 9px; overflow: hidden; }
    .pp-firm-chip { display: inline-flex; align-items: center; max-width: 100%; padding: 6px 11px; border-radius: 999px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.14); font-family: 'Inter', sans-serif; font-size: 12.5px; font-weight: 600; color: #fff; text-decoration: none; line-height: 1; box-sizing: border-box; transition: border-color .15s, background .15s; }
    .pp-firm-chip .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    a.pp-firm-chip::after { content: ""; display: inline-block; vertical-align: middle; flex: 0 0 auto; width: 12px; height: 12px; margin-left: 5px; opacity: .9; background: center/contain no-repeat url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%231FDF67%27%20stroke-width=%272.6%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27M7%207h10v10%27/%3E%3Cpath%20d=%27M7%2017%2017%207%27/%3E%3C/svg%3E"); }
    a.pp-firm-chip:hover { border-color: rgba(31,223,103,.5); background: rgba(31,223,103,.10); }
    .pp-firm-chip.is-plain { color: #C2C9C3; cursor: default; }
    .pp-firm-chip.is-empty { color: #9AA39C; border-style: dashed; cursor: default; }
    .pp-firm-chip.pp-firm-more { color: #B9A6FF; border-color: rgba(167,139,250,.42); background: rgba(167,139,250,.10); }
    a.pp-firm-chip.pp-firm-more::after { opacity: 1; background-image: url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%23B9A6FF%27%20stroke-width=%272.6%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27M7%207h10v10%27/%3E%3Cpath%20d=%27M7%2017%2017%207%27/%3E%3C/svg%3E"); }
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

      // Unlocked (Pro) members: reveal the rest of the grid 6 at a time instead
      // of dumping the whole list. (Non-Pro keep the blurred Go-Pro gate.)
      function setupLoadMore() {
        if (!document.documentElement.classList.contains('tmw-paid')) return;
        var locked = document.querySelector('.tmw-locked');
        if (!locked || locked._lm) return; locked._lm = 1;
        var grid = locked.querySelector('.tmw-locked-grid'); if (!grid) return;
        var gate = locked.querySelector('.tmw-gate'); if (gate) gate.style.display = 'none';
        var cards = Array.prototype.slice.call(grid.children); if (!cards.length) return;
        // Merge the locked cards into the visible grid: two stacked grids can
        // never fill rows across the boundary, so revealed/filtered cards were
        // landing in a lonely second grid instead of completing the row above.
        var mainGrid = null;
        try {
          var sibs = locked.parentNode.querySelectorAll('.grid.tmw-project-grid');
          for (var gi = 0; gi < sibs.length; gi++) if (!sibs[gi].classList.contains('tmw-locked-grid')) { mainGrid = sibs[gi]; break; }
        } catch (e) {}
        if (mainGrid) {
          cards.forEach(function (c) { mainGrid.appendChild(c); });
          locked.style.display = 'none';
        }
        var STEP = 6, shown = 0;
        cards.forEach(function (c) { c.style.display = 'none'; });
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'tmw-loadmore';
        function tick() {
          var end = Math.min(cards.length, shown + STEP);
          for (var i = shown; i < end; i++) cards[i].style.display = '';
          shown = end;
          if (shown >= cards.length) { btn.remove(); }
          else { btn.textContent = 'Load more projects (' + (cards.length - shown) + ' left)'; }
        }
        btn.addEventListener('click', tick);
        locked.parentNode.insertBefore(btn, mainGrid ? mainGrid.nextSibling : locked.nextSibling);
        tick();
        // Filters need every matching card visible at once — batching would
        // strand matches behind repeated "Load more" clicks.
        window._tmwRevealAllCards = function () {
          cards.forEach(function (c) { c.style.display = ''; });
          shown = cards.length;
          try { btn.remove(); } catch (e) {}
        };
        if (window._mkFilterActive) window._tmwRevealAllCards();
      }
      if (document.readyState !== 'loading') setupLoadMore();
      else document.addEventListener('DOMContentLoaded', setupLoadMore);
      // tmw-paid can flip on after auth resolves — retry briefly.
      var _t = 0, _iv = setInterval(function () {
        if (document.documentElement.classList.contains('tmw-paid')) { setupLoadMore(); clearInterval(_iv); }
        if (++_t > 20) clearInterval(_iv);
      }, 400);
    })();

    // ── Firm pills: cap each .pp-firm-chips[data-more] box at two rows and fold
    //    the overflow into a "+N more" pill that links to the project page.
    //    Keeps every card's firm row the same height no matter how many firms
    //    or how long the names are. Detail views omit data-more → show all. ──
    (function () {
      function fitOne(box) {
        var url = box.getAttribute('data-more') || '';
        var old = box.querySelector('.pp-firm-more'); if (old) old.parentNode.removeChild(old);
        var chips = Array.prototype.slice.call(box.children);
        for (var k = 0; k < chips.length; k++) chips[k].style.display = '';
        if (chips.length < 2) return;
        var maxH = (chips[0].offsetHeight * 2) + 8;
        if (box.scrollHeight <= maxH) return;
        var more = document.createElement(url ? 'a' : 'span');
        more.className = 'pp-firm-chip pp-firm-more';
        if (url) more.href = url;
        box.appendChild(more);
        var hidden = 0;
        for (var i = chips.length - 1; i >= 0; i--) {
          chips[i].style.display = 'none';
          hidden++;
          more.textContent = '+' + hidden + ' more';
          if (box.scrollHeight <= maxH) break;
        }
      }
      function fitAll(root) {
        var boxes = Array.prototype.slice.call((root || document).querySelectorAll('.pp-firm-chips[data-more]'));
        // Reset any prior equalisation so heights measure naturally.
        for (var r = 0; r < boxes.length; r++) boxes[r].style.minHeight = '';
        // Cap each box at two rows (folds overflow into "+N more").
        for (var i = 0; i < boxes.length; i++) fitOne(boxes[i]);
        // Equalise EVERY firm box to the tallest one on the page so the
        // developer/architect frames line up the same height tile-to-tile
        // (a 1-firm card's box matches a 2-firm card's box).
        var max = 0;
        for (var m = 0; m < boxes.length; m++) { var h = boxes[m].offsetHeight; if (h > max) max = h; }
        if (max) for (var n = 0; n < boxes.length; n++) boxes[n].style.minHeight = max + 'px';
      }
      window.tmwFitFirmPills = fitAll;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { fitAll(); });
      else fitAll();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitAll(); });
      var _ft; window.addEventListener('resize', function () { clearTimeout(_ft); _ft = setTimeout(function () { fitAll(); }, 150); });
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
    # 'Resort' was retired 2026-06-24 — merged into Hotel.
    # 'Airport' similarly retired — merged into Travel.
    # 'Estates' merged into Residences. 'Eateries' dropped entirely. None of
    # these should appear in data after the migration; defensive normalization
    # lives in fetch_projects.py.
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
    label = 'Recently Opened' if d == 'Now Open' else d
    return f'<span class="card-status-pill {cls}">{esc(label)}</span>'

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
def _firm_bubble(label: str, names_str: str, slugs_str: str, more_url: str = '') -> str:
    """Render one role bubble (DEVELOPER or ARCHITECT) listing EVERY firm as a
    clickable pill (was: only the first firm). Pills wrap; the small fitter in
    PAYWALL_BODY_JS caps the box at two rows and folds any overflow into a
    "+N more" pill that links to more_url (the project page, where all firms are
    always listed in full). Firms with no /firm/ page render as a plain,
    non-clickable pill so every card's firm row stays the same height."""
    names = [n.strip() for n in (names_str or '').split(',') if n.strip()]
    slugs = [s.strip() for s in (slugs_str or '').split(',') if s.strip()]
    lbl = label if label == 'Design' else label + ('s' if len(names) > 1 else '')
    if not names:
        chips = '<span class="pp-firm-chip is-empty"><span class="nm">—</span></span>'
    else:
        parts = []
        for i, nm in enumerate(names):
            slug = slugs[i] if i < len(slugs) else ''
            nm_html = f'<span class="nm">{esc(nm)}</span>'
            if slug:
                parts.append(f'<a class="pp-firm-chip" href="{ROOT_URL}/firm/{esc(slug)}/">{nm_html}</a>')
            else:
                parts.append(f'<span class="pp-firm-chip is-plain">{nm_html}</span>')
        chips = ''.join(parts)
    more_attr = f' data-more="{esc(more_url)}"' if more_url else ''
    return (f'<div class="pp-firm-group"><div class="k">{esc(lbl)}</div>'
            f'<div class="pp-firm-chips"{more_attr}>{chips}</div></div>')

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
    # Filterable status for portfolio tabs (firm pages): completed = Now Open /
    # delivered, everything else = active/in-progress. Inert elsewhere.
    _dlc = (p.get('Delivery') or '').strip().lower()
    _mk_yr = (re.match(r'^(\d{4})', str(p.get('DeliveryDate') or '')) or [None]) and (re.match(r'^(\d{4})', str(p.get('DeliveryDate') or '')).group(1) if re.match(r'^(\d{4})', str(p.get('DeliveryDate') or '')) else '')
    _mk_nb = (p.get('Neighborhood') or '').split(',')[0].strip()
    _mk_st = (p.get('Delivery') or '').strip()
    status_attr = ' data-status="completed"' if ('now open' in _dlc or _dlc in ('open', 'completed', 'delivered')) else ' data-status="active"'
    feat_badge = f'<span class="card-feat-badge" aria-label="Featured project">{FEAT_STAR_SVG}</span>' if featured else ''

    # Construction timeline + mini stats — shape mirrors the project page hero
    # panel exactly so the data presented here matches the source of truth.
    delivery       = (p.get('Delivery') or '').strip()
    delivery_date  = (p.get('DeliveryDate') or '').strip()
    start_date     = (p.get('StartDate') or '').strip()
    timeline_html  = progress_bar_html(delivery, delivery_date, start_date)
    last_verified  = _last_verified(p)
    last_v_html = (
        '<div class="card-verified"><span class="card-v-ico"><svg viewBox="0 0 100 100"><polygon class="card-v-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="7" stroke-linejoin="round"/></svg></span>'
        f'<span>Last verified {esc(last_verified)}</span></div>'
    ) if last_verified else '<div class="card-verified card-verified--empty" aria-hidden="true"></div>'

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
        + _firm_bubble('Developer', p.get('Developer', ''), p.get('DeveloperSlugs', ''), f'{ROOT_URL}/projects/{slug}/')
        + _firm_bubble('Design', p.get('Architect', ''), p.get('ArchitectSlugs', ''), f'{ROOT_URL}/projects/{slug}/')
        + '</div>'
    )

    # Card is a <div>, not <a> — because the firm bubbles inside are <a>
    # tags (links to /firm/<slug>/), and HTML disallows nested interactive
    # elements. Browsers silently break the outer <a> when they encounter
    # the inner one, which collapses our whole card layout. Wrap just the
    # image + title + meta + timeline in a single <a> (.card-link) and
    # keep the firms as separate sibling links.
    # Part-of-district chip — positioned absolute over the .card-img in the
    # bottom-left corner (Jake's spec). No body-space reservation needed
    # anymore since the chip floats over the image; cards stay aligned by
    # default. Standalone projects render no chip at all.
    parent_slug_str = (p.get('ParentSlug') or '').strip()
    parent_title = _PARENT_TITLE_BY_SLUG.get(parent_slug_str, '') if parent_slug_str else ''
    parent_chip_html = (
        f'<span class="card-parent-chip">Part of {esc(parent_title)}</span>'
        if parent_title else ''
    )

    # Keyword-rich ALT so Google Images can index every render and we "own" the
    # city in Images: "<Title> — <Type> in <Location>". Rendered as a REAL <img>
    # (not a CSS background) below — CSS backgrounds are invisible to Google
    # Images, which is why our galleries never ranked despite the assets. The
    # location de-dupes the city so we never emit "Downtown West Palm Beach West
    # Palm Beach" or repeat a city the title already carries (keyword-stuffing).
    _a_title = (p.get('Title') or '').strip()
    _a_city  = (p.get('City') or '').strip()
    _a_neigh = (p.get('Neighborhood') or '').strip()
    _a_type  = (p.get('PreferredType') or (p.get('ProjectType') or '').split(',')[0] or '').strip()
    if _a_neigh and _a_city and _a_city.lower() in _a_neigh.lower():
        _a_loc = _a_neigh
    elif _a_neigh and _a_city:
        _a_loc = f'{_a_neigh}, {_a_city}'
    else:
        _a_loc = _a_neigh or _a_city
    if _a_loc and _a_title.lower().endswith(_a_loc.lower()):
        _a_loc = ''  # title already ends with this exact location
    if _a_type and _a_loc:
        img_alt = esc(f'{_a_title} — {_a_type} in {_a_loc}')
    elif _a_type:
        img_alt = esc(f'{_a_title} — {_a_type}')
    elif _a_loc:
        img_alt = esc(f'{_a_title} — {_a_loc}')
    else:
        img_alt = esc(_a_title)

    return (
        f'<div class="card{" featured" if featured else ""}"{featured_attrs}{status_attr}'
        f' data-mk-yr="{esc(_mk_yr)}" data-mk-nb="{esc(_mk_nb)}" data-mk-st="{esc(_mk_st)}">\n'
        f'  <a class="card-link" href="{ROOT_URL}/projects/{esc(slug)}/" aria-label="Open {title}">\n'
        f'    <div class="card-img"><img class="card-img-el" src="{img}" alt="{img_alt}" loading="lazy" decoding="async">{feat_badge}{parent_chip_html}</div>\n'
        f'    <div class="card-body">\n'
        f'      <div class="card-head">\n'
        f'        <div class="card-title">{title}</div>\n'
        f'        <div class="card-loc">{loc_line}</div>\n'
        f'      </div>\n'
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
    # Lifecycle order left→right: Announced → Under Construction → Opening Soon →
    # Recently Opened (the 'Now Open' bucket, already filtered to the last 12 months).
    for label, key, cls in [
        ('Announced',          'Announced',          'an'),
        ('Under Construction', 'Under Construction', 'uc'),
        ('Opening Soon',       'Opening Soon',       'os'),
        ('Recently Opened',    'Now Open',           'no'),
    ]:
        cells.append((label, counts.get(key, 0), cls))
    ST_VALUE = {'Tracked': '', 'Announced': 'Announced', 'Under Construction': 'Under Construction',
                'Opening Soon': 'Opening Soon', 'Recently Opened': 'Now Open'}
    return '\n'.join(
        f'<div class="stat {cls}" data-mk-stat="{esc(ST_VALUE.get(label, ""))}" role="button" tabindex="0"><div class="n" data-mk-n>{n}</div><div class="l">{label}</div></div>'
        for label, n, cls in cells
    )

# ─── Atlas Intelligence · Surface C — supply pressure (market hero metric) ───
# Copy rules (spec §0): plain market-fact language ("a 53-project pipeline"),
# never machinery words; every card carries a confidence chip; all figures in
# this surface are public-safe (no pricing values).
SUPPLY_LEVEL_COLOR = {'Balanced': '#1FDF67', 'Elevated': '#F5A623', 'Saturated': '#FF5C5C'}

# Public SHAPE metadata for the projection layer (no values — see
# scripts/atlas_backfill.py). Used to decide which markets carry the
# Pro-gated submarket pricing band.
try:
    with open('journal/map/atlas-projections-public.json', encoding='utf-8') as _f:
        _ATLAS_PUB = json.load(_f).get('projects', {})
except Exception:
    _ATLAS_PUB = {}
MARKETS_WITH_PAGES = set()   # filled in main() once city pages are decided
ATLAS_INTEL = None           # set in main(); region modules read it
ATLAS_MODELED_BY_MARKET = collections.Counter(
    v.get('market') for v in _ATLAS_PUB.values() if v.get('modeled') and v.get('market'))

def _fmt_half(half: str) -> str:
    """'2026H2' → 'Late ’26' — halves spelled out, never 'H2' jargon."""
    word = 'Early' if half.endswith('H1') else 'Late'
    return f"{word} ’{half[2:4]}"


US_STATE_NAMES = {'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California','CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia','HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa','KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland','MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming','DC':'Washington DC'}

def _atlas_link_html(m: dict) -> str:
    st = (m.get('state') or '').strip()
    if st and st in US_STATE_NAMES:
        return f'<a class="sp-atlas" href="/atlas/?state={esc(st)}">{esc(US_STATE_NAMES[st])} in the Atlas →</a>'
    return '<a class="sp-atlas" href="/atlas/">Open the Atlas →</a>'

def supply_pressure_html(m: dict | None) -> str:
    if not m:
        return ''
    score, level = m['score'], m['level']
    color = SUPPLY_LEVEL_COLOR.get(level, '#1FDF67')
    # Semicircle gauge: r=52 arc from (8,64) to (112,64), length ≈ π·52.
    arc_len = 3.14159 * 52
    dash = arc_len * max(score, 2) / 100.0
    units_bit = f", delivering {m['pipeline_units']:,} residences and keys" if m['pipeline_units'] else ""
    sub = (f"New-supply concentration over the next 36 months — "
           f"a {m['pipeline_projects']}-project pipeline{units_bit}.")
    windows = [w for w in m['windows']]
    max_u = max([w['units'] for w in windows] + [1])
    bars = []
    for w in windows:
        h = max(6, round(64 * w['units'] / max_u)) if w['units'] else 4
        on = ' on' if w['units'] == max_u and w['units'] else ''
        bars.append(
            f'<div class="sp-win{on}" title="{w["projects"]} projects · {w["units"]:,} units">'
            f'<div class="sp-bar-wrap"><div class="sp-bar" style="height:{h}px"></div></div>'
            f'<div class="sp-win-n">{w["projects"]}</div>'
            f'<div class="sp-win-l">{esc(_fmt_half(w["half"]))}</div>'
            f'</div>'
        )
    extras = []
    if m['later']['projects']:
        _lp = m['later']['projects']
        extras.append(f"{_lp} more " + ('delivers' if _lp == 1 else 'deliver') + " beyond the 36-month horizon")
    if m['undated_projects']:
        _up = m['undated_projects']
        extras.append(f"{_up} " + ('has' if _up == 1 else 'have') + " no public delivery date yet")
    extras_line = ('. '.join(e[0].upper() + e[1:] for e in extras) + '.') if extras else ''
    conf = m['confidence'].capitalize()
    dated_pct = round(m['provenance']['dated_share'] * 100)
    return f'''
    <section class="section sp-mod" id="m-supply" aria-label="Supply pressure">
      <div class="sp-grid">
        <div class="sp-gauge-col">
          <div class="sp-eyebrow">Supply pressure</div>
          <svg class="sp-gauge" viewBox="0 0 120 72" role="img" aria-label="Supply pressure {score} of 100 — {esc(level)}">
            <path d="M 8 64 A 52 52 0 0 1 112 64" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="9" stroke-linecap="round"/>
            <path d="M 8 64 A 52 52 0 0 1 112 64" fill="none" stroke="{color}" stroke-width="9" stroke-linecap="round"
                  stroke-dasharray="{dash:.1f} {arc_len:.1f}"/>
            <text x="60" y="52" text-anchor="middle" class="sp-score">{score}</text>
            <text x="60" y="66" text-anchor="middle" class="sp-level" fill="{color}">{esc(level.upper())}</text>
          </svg>
          <div class="sp-scale"><span>0</span><span>Balanced · Elevated · Saturated</span><span>100</span></div>
        </div>
        <div class="sp-windows-col">
          <div class="sp-sub">{esc(sub)}</div>
          <div class="sp-windows">{''.join(bars)}</div>
          <div class="sp-windows-cap"><b>Projects delivering per six-month window</b> — bar height reflects the residences and keys landing in that window.{(' ' + esc(extras_line)) if extras_line else ''}</div>
        </div>
      </div>
      <div class="sp-foot">
        <span class="sp-conf" data-conf="{esc(m['confidence'])}">Confidence: <em>{esc(conf)}</em> · {dated_pct}% of deliveries dated</span>
        {_atlas_link_html(m)}
      </div>
    </section>'''



def region_markets_html(label: str, cities_in_state, by_city) -> str:
    """Scored market chips for every city in the region that has a page —
    the region rollup's answer to the supply hero."""
    chips = []
    for city, n in cities_in_state.most_common(14):
        cslug = slugify(city)
        has_page = cslug in MARKETS_WITH_PAGES
        mk = ATLAS_INTEL['markets'].get(cslug) if (ATLAS_INTEL and has_page) else None
        href = f'/markets/{cslug}/' if has_page else f'/map/?q={esc(slugify(city).replace("-", "+"))}'
        if mk:
            col = SUPPLY_LEVEL_COLOR.get(mk['level'], '#1FDF67')
            score = f'<b style="color:{col}">{mk["score"]}</b>'
            dot = f'<i style="display:inline-block;width:6px;height:6px;border-radius:50%;background:{col};box-shadow:0 0 8px {col};margin-right:2px"></i>'
        else:
            score, dot = f'<span class="nb-n">{n}</span>', ''
        chips.append(f'<a class="nb-chip" href="{href}" style="text-decoration:none">{dot}{esc(city)} {score}</a>')
    if len(chips) < 2: return ''
    return (f'<section class="section cm-mod" id="m-markets">'
            + _mod_head('The local markets', f'{esc(label)}, <em>market by market</em>',
                        'Every city with a dedicated market page — scored by supply pressure where modeled.')
            + f'<div class="nb-row">{"".join(chips)}</div></section>')

def region_compare_html(label: str, cities_in_state) -> str:
    """Top three scored markets in the region, side by side."""
    if not ATLAS_INTEL: return ''
    rows = []
    for city, _n in cities_in_state.most_common():
        cslug = slugify(city)
        mk = ATLAS_INTEL['markets'].get(cslug)
        if mk and cslug in MARKETS_WITH_PAGES:
            rows.append((cslug, mk))
    rows.sort(key=lambda kv: -kv[1]['score'])
    if len(rows) < 2: return ''
    def peak_of(m):
        ws = [w for w in (m.get('windows') or []) if w['units']]
        if not ws: return '—'
        return _fmt_half(max(ws, key=lambda w: w['units'])['half'])
    cards = ''
    for slug_, m in rows[:3]:
        col = SUPPLY_LEVEL_COLOR.get(m['level'], '#1FDF67')
        dash = 81.7 * max(m['score'], 2) / 100.0
        band = (f'<div class="cmp-r"><span class="k">Median projected</span><span class="v blur cmp-band" data-market="{esc(slug_)}">$•,••• / sq ft</span></div>'
                if ATLAS_MODELED_BY_MARKET.get(slug_, 0) >= 2 else '')
        cards += (f'<a class="cmp-card" href="/markets/{esc(slug_)}/">'
                  f'<div class="cmp-head"><span class="cmp-city">{esc(m["city"])}</span></div>'
                  f'<div class="cmp-score"><svg class="cmp-g" viewBox="0 0 64 38">'
                  f'<path d="M 6 34 A 26 26 0 0 1 58 34" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="5" stroke-linecap="round"/>'
                  f'<path d="M 6 34 A 26 26 0 0 1 58 34" fill="none" stroke="{col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="{dash:.1f} 81.7"/></svg>'
                  f'<span><span class="cmp-num" style="color:{col}">{m["score"]}</span><br>'
                  f'<span class="cmp-lvl" style="color:{col}">{esc(m["level"].upper())}</span></span></div>'
                  f'<div class="cmp-rows">'
                  f'<div class="cmp-r"><span class="k">Pipeline</span><span class="v">{m["pipeline_projects"]} projects · {m["pipeline_units"]:,} units</span></div>'
                  f'<div class="cmp-r"><span class="k">Peak window</span><span class="v">{esc(peak_of(m))}</span></div>'
                  f'{band}</div></a>')
    return (f'<section class="section cm-mod" id="m-neighbors">'
            + _mod_head('How they compare', f'The hottest markets in <em>{esc(label)}</em>',
                        'Supply pressure, pipeline scale and modeled pricing, side by side.')
            + f'<div class="cmp-grid">{cards}</div></section>')

PROJECTS_BY_SLUG = {}   # filled in main()

def onyx_flagship_html(market_slug: str) -> str:
    """City-led projected pricing: the submarket median + band on top, with the
    market's modeled projects as the comparable set below. (Replaces the old
    single-flagship-project card so the headline reads as the CITY, not one
    pet project — the projects now live in the comparable set.)"""
    cands = [(s, v) for s, v in ONYX_PUB.items() if v.get('modeled') and v.get('market') == market_slug]
    if not cands: return ''
    m = (ATLAS_INTEL.get('markets') or {}).get(market_slug) or {}
    band = market_band_html(m)          # the city median + band (Pro-gated, /atlas/market-band)
    if not band: return ''              # needs 2+ modeled projections
    cands.sort(key=lambda kv: ((kv[1].get('confidence') == 'high'), kv[1].get('comp_count', 0)), reverse=True)
    cards = ''
    for s, v in cands:
        p = PROJECTS_BY_SLUG.get(s)
        if not p: continue
        cards += (f'<a class="om-card" data-slug="{esc(s)}" href="/projects/{esc(s)}/">'
                  f'<span class="om-name">{esc(p.get("Title") or s)}</span>'
                  f'<span class="om-meta">{esc(v.get("delivery_label") or "")} · {esc((v.get("confidence") or "").capitalize())} · {v.get("comp_count", 0)} comps</span>'
                  f'<span class="om-psf">$•,•••<i>/ sq ft</i></span></a>')
    comps = (f'<div class="om-more"><div class="om-more-l">Comparable set — the market’s modeled projects</div>'
             f'<div class="om-row">{cards}</div></div>') if cards else ''
    return (f'<section class="section cm-mod mk-cityproj" id="atlasIntel">'
            f'<div class="cm-eyebrow">Projected pricing at delivery</div>'
            f'<div class="cm-title">Where {esc(m.get("city") or market_slug)} <em>prices out</em></div>'
            f'<div class="cm-sub">The submarket median at delivery — and the modeled projects behind it.</div>'
            f'{band}{comps}'
            f'<style>.mk-cityproj .sp-band{{border-top:0;margin-top:14px;padding-top:0}}'
            f'.mk-cityproj .om-more{{margin-top:22px}}</style>'
            f'</section>')


_TOP_CACHE = {}
def city_top(city, bucket):
    key = ('city', city)
    if key not in _TOP_CACHE:
        mods = [
            (('atlasIntel', 'Pricing'), onyx_flagship_html(slugify(city))),
            (('m-neighbors', 'Neighbors'), compare_city_html(city, slugify(city), ATLAS_INTEL)),
            (('m-brands', 'Brands'), brands_html(city, bucket)),
            (('m-openings', 'Openings'), openings_timeline_html(city, bucket)),
            (('m-records', 'Records'), records_html(city, bucket, slugify(city))),
            (('m-areas', 'Areas'), neighborhoods_html(city, bucket)),
            (('m-pulse', 'Pulse'), moved_city_html(city, {city}))]
        rail = market_rail_html(city, slugify(city), ATLAS_INTEL,
            [('m-supply', 'Supply')] + [j for j, h in mods if h] + [('m-projects', 'Projects')])
        _TOP_CACHE[key] = (rail, ''.join(h for _, h in mods))
    return _TOP_CACHE[key]

def citytype_top(city, full_bucket):
    key = ('ct', city)
    if key not in _TOP_CACHE:
        mods = [
            (('m-neighbors', 'Neighbors'), compare_city_html(city, slugify(city), ATLAS_INTEL)),
            (('m-openings', 'Openings'), openings_timeline_html(city, full_bucket)),
            (('m-areas', 'Areas'), neighborhoods_html(city, full_bucket)),
            (('m-pulse', 'Pulse'), moved_city_html(city, {city}))]
        rail = market_rail_html(city, slugify(city), ATLAS_INTEL,
            [('m-supply', 'Supply')] + [j for j, h in mods if h] + [('m-projects', 'Projects')])
        _TOP_CACHE[key] = (rail, ''.join(h for _, h in mods))
    return _TOP_CACHE[key]

def market_rail_html(city: str, market_slug: str, atlas_intel: dict, jumps: list[tuple[str, str]]) -> str:
    """Sticky dashboard rail: market vitals + jump chips + live-filter chips.
    Sticks just below the journal chrome (top set at runtime)."""
    me = (atlas_intel.get('markets') or {}).get(market_slug)
    vitals = ''
    if me:
        col = SUPPLY_LEVEL_COLOR.get(me['level'], '#1FDF67')
        peak = ''
        ws = [w for w in (me.get('windows') or []) if w['units']]
        if ws:
            w = max(ws, key=lambda w: w['units'])
            peak = f" · peak {_fmt_half(w['half'])}"
        vitals = (f'<span class="mkr-vitals"><b style="color:{col}">{me["score"]}</b> {esc(me["level"])}'
                  f' · {me["pipeline_projects"]} projects</span>')
    chips = ''.join(f'<a class="mkr-jump" href="#{jid}" data-jump="{jid}">{esc(label)}</a>' for jid, label in jumps)
    return (f'<div class="mk-rail" id="mkRail">'
            f'{vitals}'
            f'<nav class="mkr-jumps" aria-label="Page sections">{chips}</nav>'
            f'<div class="mkr-filters" id="mkrFilters"></div>'
            f'</div>'
            f'<div class="mk-onyx-kicker"><span class="mk-ok-l"><i></i>Atlas Intelligence</span>'
            f'<span class="mk-ok-chip"><i></i>Powered by Onyx 5</span></div>')

def market_band_html(m: dict) -> str:
    """Submarket median pricing band (Surface A aggregate) — Pro-gated. The
    static page carries the SHAPE only; values arrive from the worker after a
    server-side Memberstack check. Rendered only for markets with 2+ modeled
    project projections."""
    mslug = slugify(m.get('city') or '')
    n = ATLAS_MODELED_BY_MARKET.get(mslug, 0)
    if n < 2:
        return ''
    return f'''
      <div class="sp-band" id="spBand" data-market="{esc(mslug)}">
        <div class="sp-band-head">
          <span class="sp-band-k">Projected pricing · submarket median at delivery</span>
          <span class="sp-band-pill">Onyx Projection</span>
        </div>
        <div class="sp-band-row">
          <span class="sp-band-val" id="spBandVal">$•,•••</span>
          <span class="sp-band-unit">/ sq ft</span>
          <span class="sp-band-range" id="spBandRange">band $•,••• – $•,•••</span>
          <span class="sp-band-n">{n} modeled projects</span>
          <a class="sp-band-cta" id="spBandCta" href="/map/?upgrade=1">Unlock with Pro</a>
        </div>
      </div>
      <style>
        .sp-band{{border-top:1px solid rgba(255,255,255,.07);margin-top:24px;padding-top:22px}}
        .sp-band-head{{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}}
        .sp-band-k{{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.45)}}
        .sp-band-pill{{font-size:10px;font-weight:600;padding:3px 9px;border-radius:999px;background:rgba(167,139,250,.14);color:#A78BFA;border:1px solid rgba(167,139,250,.28)}}
        .sp-band-row{{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}}
        .sp-band-val{{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}}
        .sp-band-unit{{font-size:12px;color:rgba(255,255,255,.5)}}
        .sp-band-range{{font-family:var(--mono);font-size:11.5px;color:rgba(255,255,255,.6)}}
        .sp-band-n{{font-family:var(--mono);font-size:10px;color:rgba(255,255,255,.38)}}
        .sp-band-cta{{margin-left:auto;text-decoration:none;font-size:11.5px;font-weight:700;padding:7px 13px;border-radius:999px;background:#A78BFA;color:#0a0a0a}}
        #spBand.locked .sp-band-val,#spBand.locked .sp-band-range{{filter:blur(7px);user-select:none;opacity:.85}}
        /* Pro-hinted visitors (html.tmw-paid from the head inline) never see blur while the value loads */
        html.tmw-paid #spBand.locked .sp-band-val,html.tmw-paid #spBand.locked .sp-band-range{{filter:none;opacity:.4}}
      </style>
      <script>
      (function(){{
        var el=document.getElementById('spBand'); if(!el) return; el.classList.add('locked');
        function withMember(cb,t){{t=t||0;var ms=window.$memberstackDom;
          if(ms&&ms.getCurrentMember){{ms.getCurrentMember().then(function(r){{cb(r&&r.data);}}).catch(function(){{cb(null);}});return;}}
          if(t>40){{cb(null);return;}} setTimeout(function(){{withMember(cb,t+1);}},500);}}
        withMember(function(mem){{ if(!mem||!mem.id) return;
          fetch('https://tmw.jake-ab7.workers.dev/atlas/market-band',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{market:el.getAttribute('data-market'),member_id:mem.id}})}})
            .then(function(r){{return r.json();}})
            .then(function(j){{ if(!j||!j.found||j.gated) return;
              var money=function(n){{return '$'+Math.round(n).toLocaleString('en-US');}};
              document.getElementById('spBandVal').textContent=money(j.median_psf);
              document.getElementById('spBandRange').textContent='band '+money(j.band[0])+' – '+money(j.band[1]);
              el.classList.remove('locked');
              var c=document.getElementById('spBandCta'); if(c) c.remove();
              try{{if(window.tmwFunnelTrack)window.tmwFunnelTrack('atlas_market_band_pro_view',{{market:el.getAttribute('data-market')}});}}catch(_e){{}}
            }}).catch(function(){{}});
        }});
        try{{if(window.tmwFunnelTrack)window.tmwFunnelTrack('atlas_market_band_view',{{market:el.getAttribute('data-market')}});}}catch(_e){{}}
      }})();
      </script>'''


# ─── City intelligence modules (approved mockups, 2026-07-18) ────────────────
# Seven data-gated modules for city pages. Every module renders ONLY when its
# data is rich enough for the city — small markets stay clean. Split into a
# "motion" cluster (right after the supply hero) and a "context" cluster
# (after the firms panel): moved / openings / neighborhoods up top, brands /
# records / journal / comparison below.
try:
    with open('journal/map/articles.json', encoding='utf-8') as _f:
        ARTICLES_BY_SLUG = json.load(_f)
except Exception:
    ARTICLES_BY_SLUG = {}
try:
    with open('pulse.json', encoding='utf-8') as _f:
        PULSE_EVENTS = json.load(_f).get('events', [])
except Exception:
    PULSE_EVENTS = []

LUXE_BRANDS = ['Mandarin Oriental', 'Ritz-Carlton', 'Ritz Carlton', 'Four Seasons', 'St. Regis', 'Waldorf Astoria',
    'Aman', 'Rosewood', 'Six Senses', 'Cheval Blanc', 'One&Only', 'Raffles', 'Fairmont', 'Peninsula',
    'Shangri-La', 'Park Hyatt', 'Grand Hyatt', 'Andaz', 'Thompson', 'Pendry', 'Viceroy', 'Auberge',
    'Montage', 'Edition', 'Mondrian', 'SLS', 'Delano', 'Faena', 'Standard', 'Kimpton', 'Conrad',
    'JW Marriott', 'W Hotel', 'Nobu', 'Bulgari', 'Baccarat', 'Armani', 'Porsche Design', 'Bentley',
    'Mercedes-Benz', 'Aston Martin', 'Lamborghini', 'Pagani', 'Dolce', 'Missoni', 'Diesel', 'Elle',
    'Karl Lagerfeld', 'Cipriani', 'Casa Tua', 'Mr. C', 'Jean-Georges', 'Major Food', 'Meliá',
    'Palm Tree', 'Kygo', 'Soho House', 'Trump', 'Hard Rock', 'Corinthia', 'Jumeirah', 'Oetker',
    'Regent', 'Langham', 'Sofitel', 'Kempinski', 'Banyan Tree', 'Anantara', 'Alila', '1 Hotel']

MV_TAG_STYLE = {
    'Broke ground':  ('#FFD300', 'rgba(255,211,0,.09)'),
    'Topped out':    ('#FFD300', 'rgba(255,211,0,.09)'),
    'Sales launch':  ('#A78BFA', 'rgba(167,139,250,.14)'),
    'Now open':      ('#1FDF67', 'rgba(31,223,103,.14)'),
    'Opened':        ('#1FDF67', 'rgba(31,223,103,.14)'),
    'Approved':      ('#1FDF67', 'rgba(31,223,103,.14)'),
    'Financing':     ('#e6c574', 'rgba(230,197,116,.1)'),
    'Tracking':      ('#A78BFA', 'rgba(167,139,250,.14)'),
    'Opening soon':  ('#C4B5FD', 'rgba(196,181,253,.12)'),
    'Move-ins':      ('#FFB45E', 'rgba(255,180,94,.09)'),
}

def _mod_head(eyebrow: str, title_html: str, sub: str) -> str:
    return (f'<div class="cm-eyebrow">{esc(eyebrow)}</div>'
            f'<div class="cm-title">{title_html}</div>'
            f'<div class="cm-sub">{esc(sub)}</div>')

def _article_chip(title: str) -> str:
    t = title.lower()
    if re.search(r'restaurant|chef|dining|coffee|donut|bakery|bistro|omakase|steakhouse|cuisine|menu|michelin', t): return 'Food & Drink'
    if re.search(r'hotel|resort|suite|hospitality|rooms|keys', t): return 'Hotels'
    if re.search(r'open|opens|opening|debut|arriv|launch', t): return 'Openings'
    return 'Journal'

def journal_city_html(city: str, projects: list[dict]) -> str:
    arts = []
    for p in projects:
        slug = (p.get('Slug') or '').strip().lower()
        for a in ARTICLES_BY_SLUG.get(slug, []):
            if a.get('title') and a.get('link'):
                arts.append(a)
    seen, uniq = set(), []
    for a in sorted(arts, key=lambda a: a.get('published_at') or '', reverse=True):
        if a['link'] in seen: continue
        seen.add(a['link']); uniq.append(a)
    if len(uniq) < 2: return ''
    cards = []
    for a in uniq[:3]:
        chip = _article_chip(a['title'])
        img = (a.get('image') or '').strip()
        imgs = f'<img src="{esc(img)}" alt="" loading="lazy">' if img else ''
        try:
            d = datetime.datetime.fromisoformat(str(a.get('published_at', '')).replace('Z', '+00:00'))
            ds = d.strftime('%b %-d, %Y')
        except Exception:
            ds = ''
        cards.append(f'<a class="jc-card" href="{esc(a["link"])}">'
                     f'<div class="jc-img">{imgs}<span class="jc-chip">{esc(chip)}</span></div>'
                     f'<div class="jc-body"><div class="jc-title">{esc(a["title"])}</div>'
                     f'<div class="jc-meta">{esc(ds)}</div></div></a>')
    return (f'<section class="section cm-mod" id="m-journal">'
            + _mod_head('From the Journal', f'Our coverage of <em>{esc(city)}</em>',
                        'The latest stories from the projects shaping the city.')
            + f'<div class="jc-grid">{"".join(cards)}</div></section>')

def moved_city_html(label: str, cities: set | None = None) -> str:
    cities = cities or {label}
    now = datetime.datetime.now(datetime.timezone.utc)
    rows = []
    for ev in PULSE_EVENTS:
        if (ev.get('city') or '').strip() not in cities: continue
        try:
            ts = datetime.datetime.fromisoformat(str(ev.get('timestamp', '')).replace('Z', '+00:00'))
        except Exception:
            continue
        if (now - ts).days > 45: continue
        rows.append((ts, ev))
    rows.sort(key=lambda x: x[0], reverse=True)
    if len(rows) < 2: return ''
    out = []
    for ts, ev in rows[:5]:
        tag = (ev.get('tag') or 'Update').strip()
        col, bgc = MV_TAG_STYLE.get(tag, ('#A78BFA', 'rgba(167,139,250,.14)'))
        title = ev.get('title') or ''
        pt = ev.get('project_title') or ''
        if pt and pt in title:
            title_html = esc(title).replace(esc(pt), f'<b>{esc(pt)}</b>', 1)
        else:
            title_html = esc(title)
        link = ev.get('link') or '#'
        out.append(f'<a class="mv-row" href="{esc(link)}">'
                   f'<span class="mv-dot" style="background:{col};box-shadow:0 0 10px {col}66"></span>'
                   f'<span class="mv-what">{title_html}</span>'
                   f'<span class="mv-tag" style="color:{col};background:{bgc}">{esc(tag)}</span>'
                   f'<span class="mv-when">{ts.strftime("%b %-d")}</span></a>')
    return (f'<section class="section cm-mod" id="m-pulse" data-mk-city="{esc("|".join(sorted(cities)))}">'
            + _mod_head('The last 30 days', f'What <em>moved</em> in {esc(label)}',
                        'Milestones logged across the pipeline this month.')
            + f'<div class="mv-list" id="mvList">{"".join(out)}</div></section>')

def openings_timeline_html(city: str, projects: list[dict]) -> str:
    today = datetime.date.today()
    buckets = {}
    for p in projects:
        if (p.get('Delivery') or '').strip() == 'Now Open': continue
        raw = str(p.get('DeliveryDate') or '').strip()
        m = re.match(r'^(\d{4})', raw)
        if not m: continue
        y = int(m.group(1))
        if y < today.year: y = today.year
        key = y if y <= today.year + 3 else 'later'
        b = buckets.setdefault(key, {'projects': 0, 'units': 0, 'lead': None, 'lead_score': -1})
        u = 0
        for fld in ('Units', 'Keys'):
            rawu = str(p.get(fld) or '').replace(',', '').strip()
            if rawu.isdigit(): u = int(rawu); break
        b['projects'] += 1; b['units'] += u
        score = (1000000 if is_featured(p) else 0) + u
        if score > b['lead_score']:
            b['lead_score'] = score
            nb = (p.get('Neighborhood') or '').split(',')[0].strip()
            b['lead'] = (p.get('Title') or '', nb or (f"{u:,} residences" if u else 'marquee arrival'))
    years = [y for y in buckets if y != 'later']
    if len(buckets) < 2 or sum(b['projects'] for b in buckets.values()) < 4: return ''
    peak = max(buckets, key=lambda k: buckets[k]['units'])
    cells = []
    for key in sorted(years) + (['later'] if 'later' in buckets else []):
        b = buckets[key]
        label = f'{key}' if key != 'later' else f'{today.year + 4}+'
        peakc = ' peak' if key == peak else ''
        chip = '<span class="ot-peakchip">Peak</span>' if key == peak else ''
        units_bit = f' · {b["units"]:,} units' if b['units'] else ''
        lead = ''
        if b['lead']:
            lead = f'<div class="ot-lead"><b>{esc(b["lead"][0])}</b>{esc(b["lead"][1])}</div>'
        yr_attr = key if key != 'later' else 'later'
        cells.append(f'<div class="ot-cell{peakc}" data-mk-yr-cell="{yr_attr}" role="button" tabindex="0">{chip}<div class="ot-year">{label}</div>'
                     f'<div class="ot-n"><b>{b["projects"]} project{"s" if b["projects"] != 1 else ""}</b>{units_bit}</div>{lead}</div>')
    return (f'<section class="section cm-mod" id="m-openings">'
            + _mod_head('Delivery horizon', 'What opens <em>when</em>',
                        "The pipeline by expected opening year, with each year's marquee arrival.")
            + f'<div class="ot-row ot-{len(cells)}">{"".join(cells)}</div></section>')

def _uq(s: str) -> str:
    return urllib.parse.quote(str(s or ''))

def neighborhoods_html(city: str, projects: list[dict]) -> str:
    counts = collections.Counter()
    for p in projects:
        if (p.get('Delivery') or '').strip() == 'Now Open': continue
        nb = (p.get('Neighborhood') or '').split(',')[0].strip()
        if nb and nb.lower() != city.lower(): counts[nb] += 1
    chips = [(nb, n) for nb, n in counts.most_common(6) if n >= 2]
    if len(chips) < 2: return ''
    out = ''.join(
        f'<span class="nb-chip" data-mk-nb-chip="{esc(nb)}" role="button" tabindex="0">'
        f'{esc(nb)} <span class="nb-n">{n}</span>'
        f'<a class="nb-go" href="/map/?city={_uq(city)}&nb={_uq(nb)}" title="See {esc(nb)} on the map" aria-label="See {esc(nb)} on the map">↗</a></span>' for nb, n in chips)
    return (f'<section class="section cm-mod" id="m-areas">'
            + _mod_head("Where it's happening", f'{esc(city)}, <em>block by block</em>',
                        'Tap a neighborhood to filter this page — or jump to it on the map.')
            + f'<div class="nb-row">{out}</div></section>')

def brands_html(city: str, projects: list[dict]) -> str:
    found = {}
    for p in projects:
        if (p.get('Delivery') or '').strip() not in ('Announced', 'Breaking Ground', 'Under Construction', 'Opening Soon'):
            continue
        title = p.get('Title') or ''
        for b in LUXE_BRANDS:
            if b.lower() in title.lower() and b not in found:
                yr = (str(p.get('DeliveryDate') or '')[:4]) or ''
                u = 0
                for fld in ('Units', 'Keys'):
                    rawu = str(p.get(fld) or '').replace(',', '').strip()
                    if rawu.isdigit(): u = int(rawu); break
                unit_word = 'keys' if (not str(p.get('Units') or '').strip() and str(p.get('Keys') or '').strip()) else 'residences'
                sub = ' · '.join(x for x in [f'{u:,} {unit_word}' if u else '', yr] if x)
                mono = ''.join(w[0] for w in b.replace('-', ' ').split()[:2]).upper()
                found[b] = (p, sub or 'in the pipeline', mono)
    if len(found) < 2: return ''
    cards = []
    for b, (p, sub, mono) in sorted(found.items(), key=lambda kv: kv[1][0].get('DeliveryDate') or '9999')[:8]:
        href = f'/projects/{esc((p.get("Slug") or "").strip().lower())}/'
        cards.append(f'<a class="br-card" href="{href}"><span class="br-mono">{esc(mono)}</span>'
                     f'<span><span class="br-name">{esc(b)}</span><br><span class="br-sub">{esc(sub)}</span></span></a>')
    return (f'<section class="section cm-mod" id="m-brands">'
            + _mod_head('Brands arriving', "Who's planting a <em>flag</em>",
                        'Hotel and residence brands with projects in the pipeline.')
            + f'<div class="br-row">{"".join(cards)}</div></section>')

def records_html(city: str, projects: list[dict], market_slug: str) -> str:
    fwd = [p for p in projects if (p.get('Delivery') or '').strip() != 'Now Open']
    if len(fwd) < 4: return ''
    def _units(p):
        for fld in ('Units', 'Keys'):
            rawu = str(p.get(fld) or '').replace(',', '').strip()
            if rawu.isdigit(): return int(rawu)
        return 0
    def _floors(p):
        raw = str(p.get('Floors') or '').strip()
        return int(raw) if raw.isdigit() else 0
    cards = []
    tall = max(fwd, key=_floors)
    if _floors(tall):
        cards.append(('Tallest in pipeline', f'{_floors(tall)}<small>floors</small>', tall))
    big = max(fwd, key=_units)
    if _units(big):
        cards.append(('Biggest by units', f'{_units(big):,}<small>units</small>', big))
    today = datetime.date.today()
    dated = []
    for p in fwd:
        m = re.match(r'^(\d{4})(?:-(\d{1,2}))?', str(p.get('DeliveryDate') or ''))
        if not m: continue
        y, mo = int(m.group(1)), int(m.group(2) or 12)
        if datetime.date(y, mo, 28) >= today: dated.append((y, mo, p))
    if dated:
        y, mo, nxt = min(dated, key=lambda t: (t[0], t[1]))
        cards.append(('Next to deliver', f'{"Early" if mo <= 6 else "Late"} ’{str(y)[2:]}', nxt))
    if len(cards) < 3: return ''
    html_cards = ''.join(
        f'<div class="rc-card"><div class="rc-k">{esc(k)}</div><div class="rc-v">{v}</div>'
        f'<div class="rc-s"><b>{esc(p.get("Title") or "")}</b></div></div>' for k, v, p in cards[:3])
    modeled = ATLAS_MODELED_BY_MARKET.get(market_slug, 0)
    if modeled >= 2:
        html_cards += ('<div class="rc-card pro"><div class="rc-k">Median projected pricing<span class="rc-pro-tag">Pro</span></div>'
                       '<div class="rc-v rc-blur" id="rcProVal">$•,•••<small>/ sq ft</small></div>'
                       f'<div class="rc-s">at delivery · across <b>{modeled} modeled projects</b></div></div>')
    return (f'<section class="section cm-mod" id="m-records" data-records-market="{esc(market_slug)}">'
            + _mod_head('Market records', 'The <em>superlatives</em>', "The pipeline's outer edges.")
            + f'<div class="rc-row">{html_cards}</div></section>')

# Broad geographic groups so a market that is the ONLY one in its country
# (e.g. London) compares to real neighbours (Paris, Lisbon) instead of a
# same-score market an ocean away. US markets are omitted on purpose — the state
# is already the neighbour granularity (Florida cities vs Florida cities).
REGION_CONTINENT = {
    'United Kingdom': 'Europe', 'France': 'Europe', 'Spain': 'Europe', 'Italy': 'Europe',
    'Portugal': 'Europe', 'Germany': 'Europe', 'Netherlands': 'Europe', 'Switzerland': 'Europe',
    'Greece': 'Europe', 'Ireland': 'Europe', 'Monaco': 'Europe', 'Austria': 'Europe', 'Belgium': 'Europe',
    'Saudi Arabia': 'Middle East', 'United Arab Emirates': 'Middle East', 'Qatar': 'Middle East',
    'Bahrain': 'Middle East', 'Kuwait': 'Middle East', 'Oman': 'Middle East',
    'China': 'Asia', 'Japan': 'Asia', 'Singapore': 'Asia', 'South Korea': 'Asia', 'Thailand': 'Asia',
    'Hong Kong': 'Asia', 'Vietnam': 'Asia', 'India': 'Asia', 'Indonesia': 'Asia', 'Malaysia': 'Asia',
    'Bahamas': 'Caribbean', 'Turks and Caicos Islands': 'Caribbean', 'Cayman Islands': 'Caribbean',
    'Barbados': 'Caribbean', 'Jamaica': 'Caribbean', 'Dominican Republic': 'Caribbean',
    'Mexico': 'Latin America', 'Brazil': 'Latin America', 'Argentina': 'Latin America', 'Colombia': 'Latin America',
    'Australia': 'Oceania', 'New Zealand': 'Oceania', 'Fiji': 'Oceania',
    'Canada': 'North America',
}

def compare_city_html(city: str, market_slug: str, atlas_intel: dict) -> str:
    me = atlas_intel['markets'].get(market_slug)
    if not me: return ''
    my_region = me.get('region')
    my_cont = REGION_CONTINENT.get(my_region)
    def _elig(s, m):
        return s != market_slug and s in MARKETS_WITH_PAGES and m.get('pipeline_projects', 0) >= 1
    # Tier 1 — same region (US state or country): the tightest neighbours.
    geo = [(s, m) for s, m in atlas_intel['markets'].items()
           if _elig(s, m) and m.get('region') == my_region and m.get('pipeline_projects', 0) >= 4]
    geo.sort(key=lambda kv: -kv[1]['score'])
    # Tier 2 — same continent (only for lone-in-their-country international markets):
    # still a genuine geographic neighbour (London → Paris, Lisbon), just smaller.
    if len(geo) < 2 and my_cont:
        have = {s for s, _ in geo}
        cont = [(s, m) for s, m in atlas_intel['markets'].items()
                if _elig(s, m) and s not in have and m.get('region') != my_region
                and REGION_CONTINENT.get(m.get('region')) == my_cont]
        cont.sort(key=lambda kv: -kv[1]['score'])
        geo += cont[: 2 - len(geo)]
    geographic = len(geo) >= 2
    if geographic:
        peers = geo[:2]
    else:
        # No real neighbours with pages — compare by supply pressure instead, and
        # say so (these are not geographic neighbours).
        have = {s for s, _ in geo}
        extra = [(s, m) for s, m in atlas_intel['markets'].items()
                 if _elig(s, m) and s not in have and m.get('pipeline_projects', 0) >= 6]
        extra.sort(key=lambda kv: abs(kv[1]['score'] - me['score']))
        peers = (geo + extra)[:2]
    if len(peers) < 2: return ''
    def peak_of(m):
        ws = m.get('windows') or []
        if not ws or not any(w['units'] for w in ws): return '—'
        w = max(ws, key=lambda w: w['units'])
        h = w['half']
        return (('Early ' if h.endswith('H1') else 'Late ') + h[:4]) if 'H' in h else h
    def card(slug_, m, self_=False):
        col = SUPPLY_LEVEL_COLOR.get(m['level'], '#1FDF67')
        dash = 81.7 * max(m['score'], 2) / 100.0
        you = '<span class="cmp-you">This page</span>' if self_ else ''
        band = f'<div class="cmp-r"><span class="k">Median projected</span><span class="v blur cmp-band" data-market="{esc(slug_)}">$•,••• / sq ft</span></div>' \
            if ATLAS_MODELED_BY_MARKET.get(slug_, 0) >= 2 else ''
        href = '#' if self_ else f'/markets/{esc(slug_)}/'
        return (f'<a class="cmp-card{" self" if self_ else ""}" href="{href}">'
                f'<div class="cmp-head"><span class="cmp-city">{esc(m["city"])}</span>{you}</div>'
                f'<div class="cmp-score"><svg class="cmp-g" viewBox="0 0 64 38">'
                f'<path d="M 6 34 A 26 26 0 0 1 58 34" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="5" stroke-linecap="round"/>'
                f'<path d="M 6 34 A 26 26 0 0 1 58 34" fill="none" stroke="{col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="{dash:.1f} 81.7"/></svg>'
                f'<span><span class="cmp-num" style="color:{col}">{m["score"]}</span><br>'
                f'<span class="cmp-lvl" style="color:{col}">{esc(m["level"].upper())}</span></span></div>'
                f'<div class="cmp-rows">'
                f'<div class="cmp-r"><span class="k">Pipeline</span><span class="v">{m["pipeline_projects"]} projects · {m["pipeline_units"]:,} units</span></div>'
                f'<div class="cmp-r"><span class="k">Peak window</span><span class="v">{esc(peak_of(m))}</span></div>'
                f'{band}</div></a>')
    cards = card(market_slug, me, True) + ''.join(card(s, m) for s, m in peers[:2])
    title = (f'{esc(city)} vs. <em>the neighbors</em>' if geographic
             else f'{esc(city)} vs. <em>comparable markets</em>')
    sub = ('Supply pressure, pipeline scale and modeled pricing, side by side.' if geographic
           else 'Markets with similar supply pressure, side by side on pipeline scale and modeled pricing.')
    return (f'<section class="section cm-mod" id="m-neighbors">'
            + _mod_head('How it compares', title, sub)
            + f'<div class="cmp-grid">{cards}</div>'
            + f'<div class="cmp-foot">{_atlas_link_html(me)}</div></section>')

CITY_MODULES_JS = """
<script>
(function(){
  function withMember(cb,t){t=t||0;var ms=window.$memberstackDom;
    if(ms&&ms.getCurrentMember){ms.getCurrentMember().then(function(r){cb(r&&r.data);}).catch(function(){cb(null);});return;}
    if(t>40){cb(null);return;} setTimeout(function(){withMember(cb,t+1);},500);}
  function money(n){return '$'+Math.round(n).toLocaleString('en-US');}

  // ── Pro values (comparison bands + records median) ──
  var proEls = document.querySelectorAll('.cmp-band, #rcProVal');
  if (proEls.length) withMember(function(mem){ if(!mem||!mem.id) return;
    var markets = {};
    document.querySelectorAll('.cmp-band').forEach(function(el){ markets[el.getAttribute('data-market')] = 1; });
    var rec = document.querySelector('[data-records-market] #rcProVal');
    var recM = rec ? document.querySelector('[data-records-market]').getAttribute('data-records-market') : null;
    if (recM) markets[recM] = 1;
    document.querySelectorAll('.om-card').forEach(function(card){
      fetch('https://tmw.jake-ab7.workers.dev/atlas/projection-full',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:card.getAttribute('data-slug'),member_id:mem.id})})
        .then(function(r){return r.json();})
        .then(function(j){ if(!j||!j.found||j.gated||!j.model) return;
          var el=card.querySelector('.om-psf');
          el.innerHTML=money(j.model.proj_psf_delivery)+'<i>/ sq ft</i>'; el.classList.add('on');
        }).catch(function(){});
    });
    Object.keys(markets).forEach(function(mk){
      fetch('https://tmw.jake-ab7.workers.dev/atlas/market-band',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market:mk,member_id:mem.id})})
        .then(function(r){return r.json();})
        .then(function(j){ if(!j||!j.found||j.gated) return;
          document.querySelectorAll('.cmp-band[data-market="'+mk+'"]').forEach(function(el){
            el.textContent = money(j.median_psf) + ' / sq ft'; el.classList.remove('blur');
          });
          if (recM === mk && rec) { rec.innerHTML = money(j.median_psf) + '<small>/ sq ft</small>'; rec.classList.remove('rc-blur'); }
        }).catch(function(){});
    });
  });

  // ── Sticky rail: pin under the chrome + active-section highlight ──
  var rail = document.getElementById('mkRail');
  if (rail) {
    function setTop(){ var h = document.querySelector('.tmw-chrome-head'); rail.style.top = ((h ? h.offsetHeight : 0)) + 'px'; }
    function setStuck(){ var h = document.querySelector('.tmw-chrome-head'); var t = (h ? h.offsetHeight : 0); rail.classList.toggle('stuck', rail.getBoundingClientRect().top <= t + 1); }
    setStuck(); window.addEventListener('scroll', setStuck, { passive: true }); window.addEventListener('resize', setStuck);
    setTop(); window.addEventListener('resize', setTop); setTimeout(setTop, 600);
    var jumps = rail.querySelectorAll('.mkr-jump');
    var sections = [];
    jumps.forEach(function(j){ var el = document.getElementById(j.getAttribute('data-jump')); if (el) sections.push([el, j]); });
    if ('IntersectionObserver' in window && sections.length) {
      var current = null;
      var io = new IntersectionObserver(function(entries){
        entries.forEach(function(e){ if (e.isIntersecting) current = e.target; });
        sections.forEach(function(p){ p[1].classList.toggle('on', p[0] === current); });
      }, { rootMargin: '-25% 0px -60% 0px' });
      sections.forEach(function(p){ io.observe(p[0]); });
    }
    jumps.forEach(function(j){ j.addEventListener('click', function(ev){
      var el = document.getElementById(j.getAttribute('data-jump'));
      if (el) { ev.preventDefault(); var top = el.getBoundingClientRect().top + window.scrollY - rail.offsetHeight - 74; window.scrollTo({top: top, behavior: 'smooth'}); }
    }); });
  }

  // ── One filter state: year + neighborhood + status ──
  var F = { yr: null, nb: null, st: null };
  var cards = [].slice.call(document.querySelectorAll('.tmw-project-grid .card'));
  function cardMatch(c){
    if (F.yr) {
      var y = c.getAttribute('data-mk-yr') || '';
      if (F.yr === 'later') { if (!y || parseInt(y, 10) <= (new Date().getFullYear() + 3)) return false; }
      else if (y !== F.yr) return false;
    }
    if (F.nb && (c.getAttribute('data-mk-nb') || '') !== F.nb) return false;
    if (F.st && (c.getAttribute('data-mk-st') || '') !== F.st) return false;
    return true;
  }
  function railChips(){
    var box = document.getElementById('mkrFilters');
    if (!box) return;
    var chips = [];
    if (F.yr) chips.push(['yr', F.yr === 'later' ? (new Date().getFullYear() + 4) + '+' : F.yr]);
    if (F.nb) chips.push(['nb', F.nb]);
    if (F.st) chips.push(['st', F.st === 'Now Open' ? 'Recently opened' : F.st]);
    box.innerHTML = chips.map(function(c){ return '<span class="mkr-fchip" data-mkclear="' + c[0] + '">' + c[1] + '<span class="x">✕</span></span>'; }).join('');
  }
  function apply(){
    var shown = 0;
    // Any active filter reveals the full card set (Pro load-more batching
    // otherwise hides matches until enough "Load more" clicks).
    window._mkFilterActive = !!(F.yr || F.nb || F.st);
    if (window._mkFilterActive && window._tmwRevealAllCards) window._tmwRevealAllCards();
    cards.forEach(function(c){ var ok = cardMatch(c); c.classList.toggle('mk-hide', !ok); if (ok) shown++; });
    // stats strip recount from the full card set
    document.querySelectorAll('.stat[data-mk-stat]').forEach(function(cell){
      var v = cell.getAttribute('data-mk-stat');
      var n = 0;
      cards.forEach(function(c){ if (!cardMatch(c)) return; if (!v || (c.getAttribute('data-mk-st') === v) || (v === 'Now Open' && c.getAttribute('data-mk-st') === 'Now Open')) n++; });
      var el = cell.querySelector('[data-mk-n]'); if (el) el.textContent = n;
      cell.classList.toggle('on', !!F.st && v === F.st);
    });
    document.querySelectorAll('[data-mk-yr-cell]').forEach(function(el){ el.classList.toggle('on', F.yr === el.getAttribute('data-mk-yr-cell')); });
    document.querySelectorAll('[data-mk-nb-chip]').forEach(function(el){ el.classList.toggle('on', F.nb === el.getAttribute('data-mk-nb-chip')); });
    var head = document.querySelector('#m-projects .section-head');
    if (head) {
      var note = document.getElementById('mkShowing');
      var active = F.yr || F.nb || F.st;
      if (active) {
        if (!note) { note = document.createElement('div'); note.id = 'mkShowing'; note.className = 'mk-showing'; head.appendChild(note); }
        note.textContent = 'Showing ' + shown + ' of ' + cards.length + ' — filtered';
      } else if (note) note.remove();
    }
    railChips();
    if ((F.yr || F.nb || F.st) && window.tmwFunnelTrack) { try { tmwFunnelTrack('market_dash_filter', {yr: F.yr, nb: F.nb, st: F.st}); } catch(_e){} }
  }
  document.addEventListener('click', function(ev){
    var t;
    if ((t = ev.target.closest('[data-mk-yr-cell]'))) { F.yr = (F.yr === t.getAttribute('data-mk-yr-cell')) ? null : t.getAttribute('data-mk-yr-cell'); apply(); return; }
    if ((t = ev.target.closest('[data-mk-nb-chip]'))) {
      if (ev.target.closest('.nb-go')) return;   // the map ↗ keeps its link
      F.nb = (F.nb === t.getAttribute('data-mk-nb-chip')) ? null : t.getAttribute('data-mk-nb-chip'); apply(); return;
    }
    if ((t = ev.target.closest('.stat[data-mk-stat]'))) {
      var v = t.getAttribute('data-mk-stat');
      F.st = (!v || F.st === v) ? null : v; apply(); return;
    }
    if ((t = ev.target.closest('[data-mkclear]'))) {
      var k = t.getAttribute('data-mkclear'); F[k] = null; apply(); return;
    }
  });

  // ── Live pulse refresh (module 8): hourly-fresh Moved feed ──
  var mv = document.getElementById('m-pulse');
  if (mv) {
    var mvCities = (mv.getAttribute('data-mk-city') || '').split('|');
    var TAGC = {'Broke ground':'#FFD300','Topped out':'#FFD300','Sales launch':'#A78BFA','Now open':'#1FDF67','Opened':'#1FDF67','Approved':'#1FDF67','Financing':'#e6c574','Tracking':'#A78BFA','Opening soon':'#C4B5FD'};
    function rel(ts){
      var s = (Date.now() - new Date(ts).getTime()) / 1000;
      if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      if (s < 86400 * 14) return Math.round(s / 86400) + 'd ago';
      return new Date(ts).toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
    }
    fetch('/map/pulse.json', {cache: 'no-cache'}).then(function(r){ return r.ok ? r.json() : null; }).then(function(p){
      if (!p || !p.events) return;
      var rows = p.events.filter(function(e){ return mvCities.indexOf(e.city || '') >= 0 && (Date.now() - new Date(e.timestamp).getTime()) < 45 * 86400000; });
      rows.sort(function(a, b){ return new Date(b.timestamp) - new Date(a.timestamp); });
      if (rows.length < 2) return;
      var esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
      document.getElementById('mvList').innerHTML = rows.slice(0, 5).map(function(e){
        var col = TAGC[e.tag] || '#A78BFA';
        var title = esc(e.title || '');
        if (e.project_title && title.indexOf(esc(e.project_title)) >= 0) title = title.replace(esc(e.project_title), '<b>' + esc(e.project_title) + '</b>');
        return '<a class="mv-row" href="' + esc(e.link || '#') + '">'
          + '<span class="mv-dot" style="background:' + col + ';box-shadow:0 0 10px ' + col + '66"></span>'
          + '<span class="mv-what">' + title + '</span>'
          + '<span class="mv-tag" style="color:' + col + ';background:rgba(255,255,255,.05)">' + esc(e.tag || 'Update') + '</span>'
          + '<span class="mv-when">' + rel(e.timestamp) + '</span></a>';
      }).join('');
    }).catch(function(){});
  }
})();
</script>"""

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
        f'  <div class="lead"><h3>Most active design firms</h3>{arch_rows}</div>\n'
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
    rail_html: str = '',        # sticky dashboard rail (sits above the supply hero)
    supply_html: str = '',      # Atlas Intelligence Surface C (city/market pages)
    city_modules_top: str = '',   # moved / openings / neighborhoods (city pages)
    city_modules_mid: str = '',   # brands / records / journal / comparison + Pro JS
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
  <!-- Fraunces self-hosted + preloaded (same as the homepage) — no render-blocking cross-origin fetch for the display font -->
  <link rel="preload" href="/fonts/fraunces-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/fonts/fraunces.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

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
    body {{ background: var(--ink); color: var(--cream); font-family: var(--sans); -webkit-font-smoothing:antialiased; line-height:1.55; overflow-x:hidden; }}
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
    /* Atlas Intelligence · supply pressure */
    .section.sp-mod {{ background:radial-gradient(640px 240px at 12% 0%, rgba(167,139,250,0.10), transparent 60%), rgba(255,255,255,0.03); border:1px solid rgba(167,139,250,0.26); border-radius:16px; padding:30px 38px 24px; margin-top:26px; box-shadow:0 0 44px rgba(167,139,250,0.10), inset 0 0 34px rgba(167,139,250,0.04); }}
    @media (max-width:760px) {{ .section.sp-mod {{ padding:22px 20px 18px; }} }}
    .sp-grid {{ display:grid; grid-template-columns:190px 1fr; gap:36px; align-items:center; }}
    .sp-eyebrow {{ font-family:var(--mono); font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:#A78BFA; margin-bottom:10px; display:flex; align-items:center; gap:8px; }}
    .sp-eyebrow::before {{ content:''; width:6px; height:6px; border-radius:50%; background:#A78BFA; box-shadow:0 0 11px 2px rgba(167,139,250,.8); flex:0 0 auto; }}
    .sp-gauge {{ width:100%; max-width:190px; display:block; }}
    .sp-gauge .sp-score {{ font-size:30px; font-weight:700; fill:#fff; font-variant-numeric:tabular-nums; }}
    .sp-gauge .sp-level {{ font-size:8.5px; letter-spacing:.18em; font-weight:700; }}
    .sp-scale {{ display:flex; justify-content:space-between; font-family:var(--mono); font-size:9px; color:rgba(255,255,255,.35); margin-top:6px; }}
    .sp-sub {{ font-size:14px; line-height:1.55; color:rgba(255,255,255,.78); margin-bottom:14px; max-width:560px; }}
    .sp-windows {{ display:flex; gap:10px; align-items:flex-end; }}
    .sp-win {{ flex:1; text-align:center; min-width:0; }}
    .sp-bar-wrap {{ height:64px; display:flex; align-items:flex-end; justify-content:center; }}
    .sp-bar {{ width:70%; max-width:44px; border-radius:5px 5px 2px 2px; background:rgba(255,255,255,.16); }}
    .sp-win.on .sp-bar {{ background:#A78BFA; }}
    .sp-win-n {{ font-family:var(--sans); font-size:13.5px; font-weight:650; color:#fff; margin-top:7px; font-variant-numeric:tabular-nums; }}
    .sp-win-l {{ font-family:var(--sans); font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:rgba(255,255,255,.45); margin-top:2px; white-space:nowrap; }}
    .sp-windows-cap {{ font-family:var(--sans); font-size:12px; color:rgba(255,255,255,.52); margin-top:11px; line-height:1.5; }}
    .sp-windows-cap b {{ color:rgba(255,255,255,.78); font-weight:600; }}
    .sp-foot {{ display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; border-top:1px solid rgba(255,255,255,.07); margin-top:16px; padding-top:11px; }}
    .sp-conf {{ font-family:var(--serif); font-size:13.5px; font-weight:500; letter-spacing:.01em; color:rgba(255,255,255,.72); border:1px solid rgba(255,255,255,.14); border-radius:999px; padding:6px 15px; }}
    .sp-conf em {{ font-style:italic; }}
    .sp-conf[data-conf="high"] {{ color:#1FDF67; border-color:rgba(31,223,103,.42); background:rgba(31,223,103,.07); box-shadow:0 0 22px rgba(31,223,103,.22), inset 0 0 14px rgba(31,223,103,.06); text-shadow:0 0 12px rgba(31,223,103,.45); }}
    .sp-conf[data-conf="low"] {{ color:#F5A623; border-color:rgba(245,166,35,.4); background:rgba(245,166,35,.06); box-shadow:0 0 18px rgba(245,166,35,.16); }}
    .sp-onyx {{ font-family:var(--mono); font-size:9.5px; letter-spacing:.05em; color:rgba(167,139,250,.9); text-shadow:0 0 12px rgba(167,139,250,.5); }}
    /* More Onyx projections teasers */
    .om-more {{ margin:-6px 0 26px; }}
    .om-more-l {{ font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:rgba(167,139,250,.8); margin:0 0 9px 2px; }}
    .om-row {{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }}
    @media (max-width:800px) {{ .om-row {{ grid-template-columns:1fr; }} }}
    .om-card {{ display:block; text-decoration:none; color:inherit; background:rgba(255,255,255,.03); border:1px solid rgba(167,139,250,.22); border-radius:12px; padding:13px 15px; transition:border-color .15s; }}
    .om-card:hover {{ border-color:rgba(167,139,250,.5); }}
    .om-name {{ display:block; font-weight:600; font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }}
    .om-meta {{ display:block; font-size:10.5px; color:rgba(255,255,255,.45); margin-top:2px; }}
    .om-psf {{ display:block; font-size:17px; font-weight:700; margin-top:7px; filter:blur(6px); opacity:.85; user-select:none; font-variant-numeric:tabular-nums; }}
    .om-psf i {{ font-style:normal; font-size:10px; color:rgba(255,255,255,.45); margin-left:3px; }}
    .om-psf.on {{ filter:none; opacity:1; color:#A78BFA; }}
    html.tmw-paid .om-psf:not(.on) {{ filter:none; opacity:.4; }} /* no blur flash for Pro */
    /* Page-level Atlas Intelligence banner (below the rail, above supply) */
    .mk-onyx-kicker {{ display:flex; align-items:center; gap:12px; padding:26px 2px 2px; }}
    .mk-ok-l {{ display:inline-flex; align-items:center; gap:9px; font-size:11.5px; letter-spacing:.16em; text-transform:uppercase; color:#A78BFA; font-weight:700; }}
    .mk-ok-l i, .mk-ok-chip i {{ width:6px; height:6px; border-radius:50%; background:#A78BFA; box-shadow:0 0 11px 2px rgba(167,139,250,.8); }}
    .mk-ok-chip {{ display:inline-flex; align-items:center; gap:7px; padding:5px 11px; border-radius:999px; background:rgba(167,139,250,.14); border:1px solid rgba(167,139,250,.28); color:#A78BFA; font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; }}
    #atlasIntel .ai-kicker {{ display:none !important; }}
    /* Breathing room between the supply-pressure hero and the projected-pricing card */
    #atlasIntel {{ margin-top:44px; }}
    /* Dashboard rail */
    .mk-rail {{ position:sticky; top:0; z-index:40; display:flex; align-items:center; justify-content:center; gap:14px; flex-wrap:nowrap; margin:0 0 16px;
      width:100vw; margin-left:calc(50% - 50vw);
      background:transparent; border:0; border-bottom:1px solid transparent; border-radius:0; padding:11px 22px;
      transition:background .2s, border-color .2s; overflow-x:auto; scrollbar-width:none; }}
    .mk-rail.stuck {{ background:rgba(7,8,7,.78); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); border-bottom-color:rgba(255,255,255,.09); }}
    .mk-rail::-webkit-scrollbar {{ display:none; }}
    .mkr-vitals {{ flex:0 0 auto; font-size:12.5px; color:rgba(255,255,255,.72); font-variant-numeric:tabular-nums; white-space:nowrap; }}
    .mkr-vitals b {{ font-size:15px; font-weight:700; }}
    .mkr-jumps {{ display:flex; gap:2px; flex:0 0 auto; }}
    .mkr-jump {{ font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:11px; letter-spacing:.14em; text-transform:uppercase; font-weight:700;
      color:rgba(255,255,255,.55); text-decoration:none; padding:8px 14px; border-radius:999px; white-space:nowrap; transition:color .15s, background .15s; }}
    .mkr-jump:hover {{ color:#fff; }}
    .mkr-jump.on {{ background:rgba(230,197,116,.15); color:#f0d68a; }}
    .mkr-filters {{ display:flex; gap:6px; flex:0 0 auto; }}
    .mkr-fchip {{ display:inline-flex; align-items:center; gap:7px; font-size:11.5px; font-weight:650; color:#A78BFA;
      background:rgba(167,139,250,.14); border:1px solid rgba(167,139,250,.4); border-radius:999px; padding:6px 12px;
      cursor:pointer; white-space:nowrap; box-shadow:0 0 14px rgba(167,139,250,.16); }}
    .mkr-fchip .x {{ font-size:10px; opacity:.85; }}
    /* filter controls */
    .stat[data-mk-stat] {{ cursor:pointer; transition:border-color .15s; }}
    .stat.on {{ border-color:rgba(167,139,250,.55) !important; box-shadow:0 0 18px rgba(167,139,250,.14); }}
    .ot-cell[data-mk-yr-cell] {{ cursor:pointer; transition:border-color .15s; }}
    .ot-cell.on {{ border-color:rgba(31,223,103,.55); box-shadow:0 0 20px rgba(31,223,103,.14); }}
    .nb-chip {{ cursor:pointer; }}
    .nb-chip.on {{ border-color:rgba(31,223,103,.55); box-shadow:0 0 16px rgba(31,223,103,.14); }}
    .nb-go {{ margin-left:2px; color:rgba(255,255,255,.4); text-decoration:none; font-size:12px; padding:2px 4px; }}
    .nb-go:hover {{ color:#fff; }}
    .card.mk-hide {{ display:none !important; }}
    .mk-showing {{ font-size:12px; color:rgba(167,139,250,.9); margin-top:6px; font-weight:600; }}
    .sp-atlas, .cmp-foot a {{ font-size:12px; font-weight:700; color:#A78BFA; text-decoration:none; white-space:nowrap; }}
    .sp-atlas:hover, .cmp-foot a:hover {{ text-decoration:underline; }}
    .cmp-foot {{ margin-top:14px; text-align:right; }}
    @media (max-width:760px) {{ .mkr-vitals {{ display:none; }} }}
    /* City intelligence modules */
    .section.cm-mod {{ background:var(--panel,rgba(255,255,255,0.03)); background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:18px; padding:26px 30px; margin-top:26px; }}
    .cm-eyebrow {{ font-size:11px; letter-spacing:.15em; text-transform:uppercase; color:rgba(255,255,255,.38); font-weight:600; margin-bottom:6px; }}
    .cm-title {{ font-family:var(--serif); font-weight:600; font-size:27px; letter-spacing:-.02em; line-height:1.08; margin-bottom:4px; }}
    .cm-title em {{ font-style:italic; color:#A78BFA; }}
    .cm-sub {{ color:rgba(255,255,255,.5); font-size:13.5px; margin-bottom:20px; }}
    .jc-grid {{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }}
    .jc-card {{ background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:13px; overflow:hidden; text-decoration:none; color:inherit; display:block; transition:border-color .15s; }}
    .jc-card:hover {{ border-color:rgba(255,255,255,0.2); }}
    .jc-img {{ height:120px; background:linear-gradient(140deg,#20242b,#14161a); position:relative; overflow:hidden; }}
    .jc-img img {{ width:100%; height:100%; object-fit:cover; display:block; }}
    .jc-chip {{ position:absolute; top:9px; left:9px; font-size:9.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; background:rgba(10,10,10,.78); border:1px solid rgba(255,255,255,.14); border-radius:999px; padding:4px 9px; color:#e6c574; }}
    .jc-body {{ padding:13px 15px 15px; }}
    .jc-title {{ font-family:var(--serif); font-weight:500; font-size:16.5px; line-height:1.25; letter-spacing:-.01em; }}
    .jc-meta {{ color:rgba(255,255,255,.45); font-size:11.5px; margin-top:7px; }}
    .mv-list {{ display:flex; flex-direction:column; }}
    .mv-row {{ display:flex; align-items:center; gap:14px; padding:13px 2px; border-bottom:1px solid rgba(255,255,255,0.07); text-decoration:none; color:inherit; }}
    .mv-row:last-child {{ border-bottom:none; }}
    .mv-dot {{ width:9px; height:9px; border-radius:50%; flex:0 0 auto; }}
    .mv-what {{ font-size:14.5px; font-weight:500; min-width:0; }}
    .mv-what b {{ font-weight:650; }}
    .mv-tag {{ font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; border-radius:6px; padding:3px 8px; flex:0 0 auto; }}
    .mv-when {{ margin-left:auto; color:rgba(255,255,255,.45); font-size:12px; flex:0 0 auto; font-variant-numeric:tabular-nums; }}
    .ot-row {{ display:grid; gap:12px; grid-template-columns:repeat(5,1fr); }}
    .ot-row.ot-4 {{ grid-template-columns:repeat(4,1fr); }} .ot-row.ot-3 {{ grid-template-columns:repeat(3,1fr); }} .ot-row.ot-2 {{ grid-template-columns:repeat(2,1fr); }}
    .ot-cell {{ background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:13px; padding:16px 16px 14px; position:relative; }}
    .ot-cell.peak {{ border-color:rgba(167,139,250,.4); box-shadow:0 0 24px rgba(167,139,250,.12); }}
    .ot-year {{ font-family:var(--serif); font-weight:600; font-size:26px; letter-spacing:-.02em; }}
    .ot-n {{ color:rgba(255,255,255,.5); font-size:12px; margin-top:3px; }}
    .ot-n b {{ color:#fff; font-weight:600; }}
    .ot-lead {{ margin-top:11px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.07); font-size:12px; color:rgba(255,255,255,.5); line-height:1.45; }}
    .ot-lead b {{ color:#fff; font-weight:600; display:block; font-size:12.5px; }}
    .ot-peakchip {{ position:absolute; top:12px; right:12px; font-size:9px; font-weight:700; letter-spacing:.12em; color:#A78BFA; border:1px solid rgba(167,139,250,.35); border-radius:999px; padding:3px 8px; background:rgba(167,139,250,.14); }}
    .nb-row {{ display:flex; flex-wrap:wrap; gap:9px; }}
    .nb-chip {{ display:inline-flex; align-items:center; gap:9px; text-decoration:none; color:inherit; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:999px; padding:9px 8px 9px 16px; font-size:13.5px; font-weight:550; transition:border-color .15s; }}
    .nb-chip:hover {{ border-color:rgba(31,223,103,.45); }}
    .nb-n {{ background:rgba(31,223,103,.12); border:1px solid rgba(31,223,103,.3); color:#1FDF67; border-radius:999px; font-size:11px; font-weight:700; padding:3px 9px; font-variant-numeric:tabular-nums; }}
    .br-row {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }}
    .br-card {{ display:flex; align-items:center; gap:13px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:13px; padding:13px 15px; text-decoration:none; color:inherit; transition:border-color .15s; }}
    .br-card:hover {{ border-color:rgba(230,197,116,.45); }}
    .br-mono {{ width:42px; height:42px; flex:0 0 auto; border-radius:50%; border:1px solid rgba(230,197,116,.4); color:#e6c574; display:flex; align-items:center; justify-content:center; font-family:var(--serif); font-size:16px; font-weight:500; background:rgba(230,197,116,.06); box-shadow:0 0 16px rgba(230,197,116,.1); }}
    .br-name {{ font-size:13.5px; font-weight:600; line-height:1.2; }}
    .br-sub {{ color:rgba(255,255,255,.45); font-size:11px; margin-top:2px; }}
    .rc-row {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }}
    .rc-card {{ background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:13px; padding:16px 17px 14px; }}
    .rc-k {{ font-size:10px; letter-spacing:.13em; text-transform:uppercase; color:rgba(255,255,255,.38); font-weight:650; margin-bottom:8px; }}
    .rc-v {{ font-family:var(--serif); font-weight:600; font-size:24px; letter-spacing:-.02em; }}
    .rc-v small {{ font-size:13px; color:rgba(255,255,255,.5); font-family:var(--sans); font-weight:500; margin-left:3px; }}
    .rc-s {{ color:rgba(255,255,255,.5); font-size:12px; margin-top:4px; }}
    .rc-s b {{ color:#fff; font-weight:550; }}
    .rc-card.pro {{ border-color:rgba(167,139,250,.32); background:radial-gradient(240px 120px at 20% 0%,rgba(167,139,250,.10),transparent 60%),rgba(255,255,255,0.05); }}
    .rc-blur {{ filter:blur(7px); user-select:none; opacity:.85; }}
    html.tmw-paid .rc-blur {{ filter:none; opacity:.4; }} /* no blur flash for Pro */
    .rc-pro-tag {{ float:right; font-size:9px; font-weight:700; letter-spacing:.1em; color:#A78BFA; border:1px solid rgba(167,139,250,.35); border-radius:999px; padding:2px 8px; }}
    .cmp-grid {{ display:grid; grid-template-columns:1.25fr 1fr 1fr; gap:12px; }}
    .cmp-card {{ background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:17px 18px; text-decoration:none; color:inherit; }}
    .cmp-card.self {{ border-color:rgba(167,139,250,.4); box-shadow:0 0 26px rgba(167,139,250,.12); }}
    .cmp-head {{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }}
    .cmp-city {{ font-family:var(--serif); font-weight:600; font-size:18px; letter-spacing:-.015em; }}
    .cmp-you {{ font-size:9px; font-weight:700; letter-spacing:.12em; color:#A78BFA; border:1px solid rgba(167,139,250,.35); border-radius:999px; padding:3px 8px; }}
    .cmp-score {{ display:flex; align-items:center; gap:10px; margin-bottom:12px; }}
    .cmp-g {{ width:52px; height:32px; flex:0 0 auto; }}
    .cmp-num {{ font-size:21px; font-weight:700; font-variant-numeric:tabular-nums; }}
    .cmp-lvl {{ font-size:9.5px; font-weight:700; letter-spacing:.12em; }}
    .cmp-rows {{ display:flex; flex-direction:column; gap:7px; }}
    .cmp-r {{ display:flex; justify-content:space-between; font-size:12.5px; gap:10px; }}
    .cmp-r .k {{ color:rgba(255,255,255,.5); }}
    .cmp-r .v {{ font-weight:600; font-variant-numeric:tabular-nums; text-align:right; }}
    .cmp-r .v.blur {{ filter:blur(6px); user-select:none; opacity:.85; }}
    html.tmw-paid .cmp-r .v.blur {{ filter:none; opacity:.4; }} /* no blur flash for Pro */
    @media (max-width:900px) {{
      .jc-grid,.br-row,.rc-row {{ grid-template-columns:repeat(2,1fr); }}
      .ot-row,.ot-row.ot-4,.ot-row.ot-3 {{ grid-template-columns:repeat(2,1fr); }}
      .cmp-grid {{ grid-template-columns:1fr; }}
      .section.cm-mod {{ padding:20px 18px; }}
    }}
    .stat {{ background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; padding: 18px; }}
    .stat .n {{ font-family:var(--serif); font-size: 32px; font-weight: 500; letter-spacing:-.018em; color: var(--white); line-height: 1; }}
    .stat .l {{ font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color: var(--mute); margin-top: 10px; }}
    .stat.uc .n {{ color: var(--amber); }}
    .stat.bg .n {{ color: var(--gold); }}
    .stat.an .n {{ color: #9AA39C; }}
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
    .card {{ display: flex; flex-direction: column; height:100%; background:#111; border-radius:14px; overflow:hidden; transition: transform .15s, border-color .15s; border:1px solid transparent; position:relative; }}
    .card:hover {{ transform: translateY(-2px); border-color: rgba(167,139,250,.3); }}
    /* No gold-glow border on featured cards — the corner star badge is
       the only featured cue. Border-only featured projects were reading
       as the same visual weight as the active hover state. */
    .card-link {{ display: flex; flex-direction: column; flex: 1 1 auto; text-decoration: none; color: inherit; }}
    /* firm row pinned to the bottom so it lines up across every card in a row */
    .card-firms-wrap {{ padding: 0 20px 20px; margin-top: auto; }}
    /* .card-parent-chip rule moved into PAYWALL_CSS so the firm pages
       inherit it (they only import PAYWALL_CSS, not this local style block).
       Definition lives there now — see line ~172. */
    /* Smaller, square gold badge with star — matches map marker style */
    .card-feat-badge {{ position:absolute; top:10px; right:10px; z-index:2; width:22px; height:22px; border-radius:5px; background:var(--gold); display:inline-flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,.4); }}
    .card-feat-badge svg {{ width:12px; height:12px; fill:#0a0a0a; }}
    .card-img {{ height: 220px; background-size: cover; background-position: center; position: relative; }}
    .card-img::after {{ content:""; position:absolute; inset:0; background:linear-gradient(180deg, transparent 60%, rgba(0,0,0,.45) 100%); }}
    .card-body {{ padding: 18px 20px 4px; }}
    .card-title {{ font-family: var(--serif); font-size: 22px; font-weight: 500; letter-spacing:-.014em; line-height: 1.2; color: var(--white); margin-bottom: 5px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }}
    /* Title + location grouped: location sits directly under the title (not pushed
       down by a reserved 2nd title line). The wrapper carries the alignment reserve
       so everything BELOW (timeline, stats, firms) stays horizontally aligned across
       tiles whether the title is 1 or 2 lines. */
    .card-head {{ min-height: 76px; margin-bottom: 12px; }}
    /* City/firm/location body font matches the map's body font (Inter regular) */
    .card-loc {{ font-family: var(--sans); font-size: 13px; color: var(--mute-2); }}
    .card-verified {{ display:flex; align-items:center; gap:8px; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,.5); margin-bottom: 12px; padding: 8px 0; border-top:1px solid var(--hair); border-bottom:1px solid var(--hair); }}
    /* empty placeholder keeps the meter + tiles aligned across cards that lack a verified date */
    .card-verified--empty {{ border:none; padding:0; height:31px; }}
    .card-v-ico {{ width:14px; height:14px; display:inline-block; }}
    /* Spinning TMW Intelligence hexagon — identical to the individual project pages. */
    .card-v-ico svg {{ width:100%; height:100%; transform-origin:50% 50%; animation: cardVSpin 4.2s cubic-bezier(.16,1,.3,1) infinite; }}
    @keyframes cardVSpin {{ 0% {{ transform: rotate(0deg); }} 55% {{ transform: rotate(810deg); }} 70% {{ transform: rotate(900deg); }} 100% {{ transform: rotate(1080deg); }} }}
    @media (prefers-reduced-motion: reduce) {{ .card-v-ico svg {{ animation: none; }} }}

    /* Construction timeline (ported verbatim from generate_pages.py's
       project page hero panel — same look, same data) */
    .pm-tl {{ margin-bottom: 14px; }}
    .pm-tl-date {{ text-align: right; font-family: var(--mono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.5); margin-bottom: 8px; }}
    .pm-tl-meter {{ position: relative; height: 4px; border-radius: 2px; overflow: hidden; }}
    .pm-tl-grad {{ position: absolute; inset: 0; background: linear-gradient(90deg, #3a2f6b, #7C5CE0 38%, #A78BFA 64%, #1FDF67); }}
    .pm-tl-empty {{ position: absolute; top: 0; bottom: 0; right: 0; background: #0d0f0e; box-shadow: inset 2px 0 3px rgba(0,0,0,0.6); }}
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
    .btn-grid {{ display: flex; flex-wrap: wrap; width: 100%; gap: 10px; }}
    .btn-cell {{ flex: 1 1 150px; min-width: 0; background: rgba(255,255,255,.02); border: 1px solid var(--hair); border-radius: 12px; padding: 22px 22px; }}
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
      .sp-grid {{ grid-template-columns: 1fr; gap: 14px; }}
      .sp-gauge {{ margin: 0 auto; }}
      .sp-windows {{ gap: 6px; }}
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
{rail_html}
{supply_html}
{city_modules_top}

    <section class="section" id="m-projects">
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
{city_modules_mid}

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
        <i>Markets of Tomorrow Pro · $32/mo</i>
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
  <!-- search core + overlay are loaded once (versioned) by journal-dock.js — dropping the
       static include avoids a duplicate download + parse of ~530KB of JS on every page -->
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
        # Resort merged into Hotel (2026-06-24) — these phrases ensure
        # "luxury resort" / "beach resort" queries still surface Hotel-
        # tagged projects (Conrad Tulum, Soho Beach, etc.).
        ('resort',        'resorts'),
        ('luxury resort', 'luxury resorts'),
        ('beach resort',  'beach resorts'),
        ('mountain resort','mountain resorts'),
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
    # Resort retired 2026-06-24 — its synonyms folded into the Hotel entry
    # above. Airport already lives under Travel. Estates retired into the
    # Residences group. Eateries dropped entirely with no merge target.
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
            f'<b>{sb["os"]} {plur}</b> are flagged Opening Soon — meaning their expected opening is within ~7 months.',
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
            f'Across the active pipeline, {window}. Individual delivery dates shift constantly — Pro members get the TMW Forecast on every project as dates move.',
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
                f'Delivery dates across the active {city} pipeline run from <b>{btn["earliest_delivery"]}</b> through <b>{btn["latest_delivery"]}</b>. Pro members get the TMW Forecast on every project as dates move.',
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
            f'Delivery dates across the active global pipeline run from <b>{btn["earliest_delivery"]}</b> through <b>{btn["latest_delivery"]}</b>. Pro members get the TMW Forecast on every project as dates move.',
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
  <!-- Fraunces self-hosted + preloaded (same as the homepage) — no render-blocking cross-origin fetch for the display font -->
  <link rel="preload" href="/fonts/fraunces-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/fonts/fraunces.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
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



def _state_top(state_label, state_slug, bucket, cities_in_state, by_city):
    key = ('state', state_slug)
    if key not in _TOP_CACHE:
        mods = [
            (('m-markets', 'Markets'), region_markets_html(state_label, cities_in_state, by_city)),
            (('m-neighbors', 'Compare'), region_compare_html(state_label, cities_in_state)),
            (('m-brands', 'Brands'), brands_html(state_label, bucket)),
            (('m-openings', 'Openings'), openings_timeline_html(state_label, bucket)),
            (('m-records', 'Records'), records_html(state_label, bucket, state_slug)),
            (('m-pulse', 'Pulse'), moved_city_html(state_label, set(cities_in_state)))]
        rail = market_rail_html(state_label, state_slug, ATLAS_INTEL or {'markets': {}},
            [j for j, h in mods if h] + [('m-projects', 'Projects')])
        _TOP_CACHE[key] = (rail, ''.join(h for _, h in mods))
    return _TOP_CACHE[key]

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
            f'Delivery dates across the active {state_label} pipeline run from <b>{btn["earliest_delivery"]}</b> through <b>{btn["latest_delivery"]}</b>. Individual delivery dates shift constantly — Pro members get the TMW Forecast on every project.',
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
        f'<p>Every project on this page is on the <a href="{ROOT_URL}/map/">Map of Tomorrow</a> — our live database of new and under-construction developments worldwide. Project status, milestones, and spec changes are sourced from public filings, official announcements, or independent reporting and timestamped. <a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get the TMW Forecast on every project and the full {state_label} dataset by phase, neighborhood, and developer.</p>'
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
        rail_html=_state_top(state_label, state_slug, bucket, cities_in_state, by_city)[0],
        city_modules_top=_state_top(state_label, state_slug, bucket, cities_in_state, by_city)[1],
        city_modules_mid=(journal_city_html(state_label, bucket) + CITY_MODULES_JS),
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

    # Market search-bar index — one entry per market landing page.
    places_index = (
        [{'name': c, 'url': f'/markets/{slugify(c)}/', 'n': n, 'kind': 'City'} for (c, n) in city_pages]
        + [{'name': st, 'url': f'/markets/{slugify(st)}/', 'n': n, 'kind': 'State'} for (st, n) in state_pages]
        + [{'name': c, 'url': f'/markets/{slugify(c)}/', 'n': n, 'kind': 'Country'} for (c, n) in country_pages]
    )

    # Serialize lookups for the client-side filter
    lookups_json = json.dumps({
        'cityType': ct_lookup,
        'city':     city_lookup,
        'type':     type_lookup,
        'places':   places_index,
    }, ensure_ascii=False)

    # Typeahead search bar (plain strings — interpolated into the page f-string
    # so the CSS/JS braces never need doubling; see the Jul-4 f-string outage).
    mc_search_css = MC_SEARCH_CSS
    mc_search_html = mc_search_html_for('mcs', 'Search markets — city, state, or country…')
    mc_search_js = mc_search_js_for('mcs', """
      var data = JSON.parse(document.getElementById('mc-data').textContent);
      var ITEMS = (data.places || []).map(function(p){
        return { name: p.name, url: p.url, n: p.n, meta: p.kind + ' · ' + p.n };
      });
      function goItem(it){ location.href = it.url; }
    """)

    # Hub-level FAQs — broader questions about the database itself.
    hub_faqs = [
        ('How many cities does Markets of Tomorrow track?',
         f'We currently track active development projects across <b>{len(city_pages)}+ cities</b> worldwide, with <b>{len(type_pages)} project categories</b>. Every city with at least 3 projects gets its own dedicated landing page.'),
        ('How often is the market data updated?',
         f'Hourly. Our cron pipeline pulls fresh project data from the source-of-truth database every hour, regenerates every market and firm landing page, and updates the live map. A status change confirmed today shows up here within ~60 minutes.'),
        ('Can I filter by city, category, and delivery year?',
         f'Yes — use the calculator above. Pick a city + category + delivery window and we\'ll show you the matching project count and link straight to the dedicated landing page when one exists.'),
        ('What does "Pro" unlock?',
         f'<a href="{ROOT_URL}/map/?upgrade=1">Pro members</a> get the TMW Forecast on every project (statistical delivery prediction with confidence interval) and the full filterable database by phase, neighborhood, architect, and developer.'),
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
  <!-- Fraunces self-hosted + preloaded (same as the homepage) — no render-blocking cross-origin fetch for the display font -->
  <link rel="preload" href="/fonts/fraunces-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/fonts/fraunces.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
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
{mc_search_css}
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
        {mc_search_html}
        <form id="mc-form" class="mc-row">
          <div class="mc-field">
            <select id="mc-city">
              <option value="">Any city</option>
              {city_options_html}
            </select>
          </div>
          <div class="mc-field">
            <select id="mc-type">
              <option value="">Any category</option>
              {type_options_html}
            </select>
          </div>
          <div class="mc-field">
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
  <script>{mc_search_js}</script>
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
        'Riviera Beach': 'https://media.oftmw.com/wix/ca3b83_445dcb51bfab4b5f97729a55a31eca71~mv2.jpg',  # 123 Ocean
        'Palm Beach':    'https://media.oftmw.com/wix/ca3b83_297b07c045bc4d1a9b0fbb166b176dee~mv2.webp',  # Palm Beach Residences
        'Tampa':         'https://media.oftmw.com/wix/ca3b83_849dfca008d048fc8e457d6a3a684df6~mv2.jpg',  # hand-picked Tampa tile
        'New York City': 'https://media.oftmw.com/2026/06/9ed74446045e-A-crop.jpg',  # hand-picked NYC tile
        'Chicago':       'https://media.oftmw.com/wix/ca3b83_e85c6445394e48b481914a1d9ab75215~mv2.jpg',  # hand-picked Chicago tile
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
    _n_before = len(projects)
    projects = drop_stale_open_projects(projects)
    print(f"  ✓ Loaded {_n_before} projects ({_n_before - len(projects)} aged off — opened 12+ months ago)")

    # Populate the slug -> title lookup card_html uses for the
    # "Part of <District>" chip on child-component cards.
    set_parent_title_lookup(projects)

    by_city_type, by_city, by_type = bucket_projects(projects)

    # Atlas Intelligence: one supply-pressure compute for every market, shared
    # by every page in this run (same math that writes atlas-intel.json).
    global ATLAS_INTEL
    ATLAS_INTEL = compute_atlas_intel(projects)
    PROJECTS_BY_SLUG.clear()
    PROJECTS_BY_SLUG.update({(p.get('Slug') or '').strip().lower(): p for p in projects if p.get('Slug')})
    MARKETS_WITH_PAGES.clear()
    MARKETS_WITH_PAGES.update(slugify(c) for c, b in by_city.items() if len(b) >= CITY_MIN)
    def supply_for(city: str) -> str:
        return supply_pressure_html(ATLAS_INTEL['markets'].get(slugify(city)))

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # markets-index.json — { "City": "slug" } for every city that gets a page
    # (>= CITY_MIN projects). Served at /markets-index.json; the Onyx search
    # overlay loads it to hyperlink market names inside an answer without ever
    # linking to a city page that doesn't exist.
    market_index = {city: slugify(city) for city, b in by_city.items() if len(b) >= CITY_MIN}
    with open(os.path.join('journal', 'markets-index.json'), 'w', encoding='utf-8') as f:
        json.dump(market_index, f, ensure_ascii=False)
    print(f"  ✓ markets-index.json: {len(market_index)} linkable city pages")

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
            supply_html=supply_for(city),
            rail_html=citytype_top(city, by_city.get(city, bucket))[0],
            city_modules_top=citytype_top(city, by_city.get(city, bucket))[1],
            city_modules_mid=CITY_MODULES_JS,
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
            supply_html=supply_for(city),
            rail_html=city_top(city, bucket)[0],
            city_modules_top=city_top(city, bucket)[1],
            city_modules_mid=(journal_city_html(city, bucket) + CITY_MODULES_JS),
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
