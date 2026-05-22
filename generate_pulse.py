#!/usr/bin/env python3
"""
TMW Pulse Generator
Builds pulse.json -- a unified activity feed combining:
  1. RSS articles from oftmw.com (with punchy truncated titles)
  2. Map status changes (diff against previous run's snapshot)
  3. New projects added to the map

Run: python3 generate_pulse.py
Output: ./pulse.json + ./.pulse-snapshot.json (state file for diffing)

Designed to run AFTER generate_pages.py in the same GitHub Actions run.
"""

import csv, html, io, json, os, re, sys, urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

# --- CONFIG -----------------------------------------------------------------
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1qwU7ykIDUrtPlIQu-qk2FIJwiz-WWg5caq02ja30sgM/export?format=csv&gid=0"
RSS_URL = "https://www.oftmw.com/blog-feed.xml"
SITE_URL = "https://map.oftmw.com"

# Output files
PULSE_JSON = "pulse.json"
SNAPSHOT_JSON = ".pulse-snapshot.json"  # internal state file for diffing

# How many events to keep in the public feed
MAX_EVENTS = 50
# How many RSS articles to consider per run
MAX_RSS_ITEMS = 100      # how many RSS items to consider per run (feed may return fewer)
# Hard cap on truncated title length
TITLE_CHAR_CAP = 50

# --- TITLE TRUNCATION -------------------------------------------------------
# Pattern: "[Subject] [verb] [optional contextual qualifier]"
# Strategy:
#   1. Cut at first comma (handles ~60% cleanly)
#   2. Strip trailing prepositional qualifiers if still too long
#   3. Strip filler prefixes ("A first look at", "Inside" stays)
#   4. Hard cap at TITLE_CHAR_CAP, fall back to subject + verb only

# Filler adjectives/adverbs that add nothing -- strip wherever they appear
FILLER_WORDS = [
    r'\bhighly anticipated\s+',
    r'\bmassive\s+(?=\$)',           # "massive $750M expansion"  "$750M expansion"
    r'\ball-time\s+',
    r'\bfirst-ever\s+',
    r'\bbrand[- ]new\s+',
    r'\bofficially\s+',
    r'\bnewly\s+',
    r'\biconic\s+(?=debut|landmark)',
    r'\bdesign[- ]driven\s+',
    r'\bdesign[- ]forward\s+',
    r'\bultra[- ]luxury\s+',
    r'\bworld[- ]class\s+',
]

# Prepositional cuts to try (most aggressive last)
TRAILING_PREP_PATTERNS = [
    r'\s+for\s+a\s+single\s+night.*$',
    r'\s+for\s+a\s+single\s+\w+.*$',
    r'\s+is\s+taking\s+over\s+.+\s+for\s+.+$',
    r'\s+by\s+the\s+\d{4}.*$',
    r'\s+with\s+new\s+luxury\s+\w+\s*$',
    r'\s+with\s+new\s+\w+\s*$',
    r'\s+rooted\s+in\s+.+$',
    r'\s+that\s+will\s+.+$',
    r'\s+to\s+its\s+mega\s+\w+\s*$',
    r'\s+on\s+\$[\d.]+\s+(?:million|billion)\s+\w+\s*$',  # "...on $750 million expansion"
    r'\s+on\s+(?:Lower|Upper|the)\s+.+$',
    r'\s+in\s+[A-Z][\w\s]+\s+(?:Hill|Country|County|District|Valley|Bay|Beach|Coast|Heights|Park)\s*$',  # "in Texas Hill Country"
    r'\s+and\s+\w+\s+(?=in\s+\w+)',  # "ranch resort and residences in Texas"  "ranch resort in Texas"
]

# Filler prefixes to strip / replace
FILLER_PREFIXES = [
    (r'^A first look (?:inside|at)\s+', 'First look: '),
    (r'^A first look\s+', 'First look: '),
]

# Inserted clauses (between commas) that describe the subject -- strip them
# e.g., "Anantara, the White Lotus-backed luxury hotel, is launching..."
INSERTED_CLAUSE_PATTERN = re.compile(
    r'^(?P<subject>[A-Z][\w\s&\']+?),\s+(?:the|one of|an?)\s+[^,]+,\s+(?P<rest>.+)$'
)

# "X agent, Name Name, joins Y"  "Name Name joins Y"
# More generally: "[role] [comma] [Proper Name] [comma] [verb phrase]"
PERSON_ROLE_PATTERN = re.compile(
    r'^[\w\s]+?\s+(?:agent|broker|chef|architect|developer|designer|founder|CEO|president),\s+'
    r'(?P<name>[A-Z][\w\.\']+(?:\s+[A-Z][\w\.\']+)+),\s+(?P<rest>.+)$'
)

# "X is planning a Y that..."  "X plans a Y" (drop relative clause)
PLANNING_PATTERN = re.compile(r'^(.+?)\s+is\s+planning\s+(.+?)\s+that\s+.+$')

def punchify(title: str) -> str:
    """Apply truncation rules to make an RSS title punchy for Pulse."""
    if not title:
        return ''
    t = title.strip()

    # Step 1: Person role pattern ("Miami agent, Luis Gonell, joins X"  "Luis Gonell joins X")
    m = PERSON_ROLE_PATTERN.match(t)
    if m:
        t = f"{m.group('name')} {m.group('rest')}"

    # Step 2: Inserted descriptor clauses ("Anantara, the X-backed Y, is launching...")
    m = INSERTED_CLAUSE_PATTERN.match(t)
    if m:
        t = f"{m.group('subject')} {m.group('rest')}"

    # Step 3: "X is planning Y that will..."  "X plans Y"
    m = PLANNING_PATTERN.match(t)
    if m:
        t = f"{m.group(1)} plans {m.group(2)}"

    # Step 4: Strip filler adjectives/adverbs anywhere in the string
    for pattern in FILLER_WORDS:
        t = re.sub(pattern, '', t, flags=re.IGNORECASE)

    # Step 5: Tighten common verb phrases (do this BEFORE comma cut so "is launching its first U.S. property in Miami"
    # collapses to "launches U.S. property in Miami" and we can keep the place)
    verb_tightenings = [
        (r'\bis launching its first\b', 'launches'),
        (r'\bis launching\b', 'launches'),
        (r'\bhas just unveiled\b', 'unveils'),
        (r'\bhas officially set\b', 'sets'),
        (r'\bhas officially opened\b', 'opens'),
        (r'\bhas officially landed\b', 'lands'),
        (r'\bhas officially broken ground\b', 'breaks ground'),
        (r'\bhave officially broken ground\b', 'break ground'),
        (r'\bhas made its\b', 'makes its'),
        (r'\bis taking over\b', 'takes over'),
        (r'\bis set to make its\b', 'will make its'),
        (r'\bis bringing\b', 'brings'),
        (r'\bbreaks its\b', 'breaks'),                   # "breaks its tourism record"  "breaks tourism record"
    ]
    for pattern, replacement in verb_tightenings:
        t = re.sub(pattern, replacement, t, flags=re.IGNORECASE)

    # Step 6: Cut at first comma if it produces a meaningful result
    if ',' in t:
        before_comma = t.split(',')[0].strip()
        if len(before_comma.split()) >= 3 and len(before_comma) >= 15:
            t = before_comma

    # Step 7: Strip filler prefixes
    for pattern, replacement in FILLER_PREFIXES:
        if re.match(pattern, t, re.IGNORECASE):
            t = re.sub(pattern, replacement, t, count=1, flags=re.IGNORECASE)
            break

    # Step 8: If still too long, strip trailing prepositional/relative qualifiers
    if len(t) > TITLE_CHAR_CAP:
        for pattern in TRAILING_PREP_PATTERNS:
            new_t = re.sub(pattern, '', t, flags=re.IGNORECASE)
            if new_t != t and len(new_t) >= 15:
                t = new_t.strip()
                if len(t) <= TITLE_CHAR_CAP:
                    break

    # Step 9: Drop leading "The " if it pushes us over the cap and the result is unambiguous
    if len(t) > TITLE_CHAR_CAP and t.lower().startswith('the '):
        candidate = t[4:]
        if len(candidate) <= TITLE_CHAR_CAP:
            t = candidate

    # Step 10: Hard cap -- ellipsize at word boundary as last resort
    if len(t) > TITLE_CHAR_CAP:
        truncated = t[:TITLE_CHAR_CAP].rsplit(' ', 1)[0]
        t = truncated + '...'

    # Cleanup
    t = re.sub(r'\s+', ' ', t).strip()
    t = re.sub(r'[,;:\-]+$', '', t).strip()

    return t

# --- RSS PARSING ------------------------------------------------------------
def fetch_rss():
    """Fetch and parse oftmw.com RSS. Returns list of article dicts.

    Each article dict includes both the headline (`title_full`) and a
    cleaned plain-text version of the article body (`body`) so the matcher
    can search both. The body is best-effort: Wix RSS may or may not serve
    the full article text in <content:encoded>; if not, we fall back to
    <description> (typically an excerpt). Either way the field exists so
    downstream code can search it without conditionals.
    """
    try:
        req = urllib.request.Request(RSS_URL, headers={'User-Agent': 'TMW-Pulse/1.0'})
        with urllib.request.urlopen(req, timeout=20) as resp:
            xml_text = resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f"   RSS fetch failed: {e}", file=sys.stderr)
        return []

    try:
        root = ET.fromstring(xml_text)
    except Exception as e:
        print(f"   RSS parse failed: {e}", file=sys.stderr)
        return []

    # The <content:encoded> element lives in the standard RSS content
    # namespace. ElementTree needs the full URI to find it.
    CONTENT_NS = '{http://purl.org/rss/1.0/modules/content/}encoded'

    articles = []
    for item in root.findall('.//item')[:MAX_RSS_ITEMS]:
        title_el = item.find('title')
        link_el = item.find('link')
        date_el = item.find('pubDate')
        guid_el = item.find('guid')
        desc_el = item.find('description')
        content_el = item.find(CONTENT_NS)

        # Image from <enclosure url="...">
        enclosure = item.find('enclosure')
        image_url = enclosure.get('url') if enclosure is not None else None

        # Categories -- useful for matching to map projects later
        categories = [c.text for c in item.findall('category') if c.text]

        if title_el is None or title_el.text is None:
            continue

        title = title_el.text.strip()
        try:
            pub_dt = parsedate_to_datetime(date_el.text) if date_el is not None and date_el.text else None
            pub_iso = pub_dt.astimezone(timezone.utc).isoformat() if pub_dt else None
        except Exception:
            pub_iso = None

        # Body extraction: prefer the full article from <content:encoded>,
        # fall back to <description>. Strip HTML tags, decode HTML
        # entities (so "R&amp;B" ‚Üí "R&B" before matching), then collapse
        # whitespace. Without the entity decode, project names with
        # special chars like "R&B Sports Center" or "Spina O'Rourke"
        # never match articles that mention them in the body ‚Äî Wix
        # serves CDATA-wrapped HTML where "&" is literally "&amp;".
        raw_body = ''
        if content_el is not None and content_el.text:
            raw_body = content_el.text
        elif desc_el is not None and desc_el.text:
            raw_body = desc_el.text
        body_text = re.sub(r'<[^>]+>', ' ', raw_body)
        body_text = html.unescape(body_text)
        body_text = re.sub(r'\s+', ' ', body_text).strip()
        # Decode the title too ‚Äî XML parsers usually decode &amp; in
        # plain elements, but CDATA-wrapped titles (some Wix feeds use
        # them) survive as &amp;. Belt-and-suspenders.
        title = html.unescape(title)

        # Use the article's public URL as the canonical guid. The backfill
        # script (which hits the Wix REST API) does the same, so the same
        # article from either source dedupes cleanly in the archive merge.
        link_text = link_el.text.strip() if link_el is not None and link_el.text else ''
        canonical_guid = link_text or (guid_el.text if guid_el is not None and guid_el.text else title)

        articles.append({
            'guid': canonical_guid[:256],
            'title_full': title,
            'title': punchify(title),
            'link': link_text,
            'image': image_url,
            'description': (desc_el.text or '').strip() if desc_el is not None else '',
            'body': body_text,
            'categories': categories,
            'published_at': pub_iso,
        })

    return articles

# --- MAP DATA (JSON) + STATUS DIFF ------------------------------------------
def fetch_csv_projects():
    """Read projects-flat.json (written by fetch_projects.py) and return
    a dict keyed by slug, mirroring the shape this function returned when
    it read CSV from Google Sheets directly. Function name kept for
    minimal blast radius -- everywhere downstream that calls this is
    unchanged.
    """
    try:
        with open('projects-flat.json', 'r', encoding='utf-8') as f:
            rows = json.load(f)
    except FileNotFoundError:
        print(f"   projects-flat.json not found. Run fetch_projects.py first.", file=sys.stderr)
        return {}
    except json.JSONDecodeError as e:
        print(f"   projects-flat.json wasn't valid JSON: {e}", file=sys.stderr)
        return {}

    projects = {}
    for row in rows:
        title = (row.get('Project Name') or row.get('Title') or row.get('title') or '').strip()
        if not title:
            continue
        slug = slugify(title)
        projects[slug] = {
            'slug': slug,
            'title': title,
            'city': (row.get('City') or row.get('city') or '').strip(),
            'delivery': (row.get('Delivery') or row.get('delivery') or '').strip(),
            # The flat schema's image column is "ImageURL" (matching
            # generate_pages.py). Fall back to lowercase variants for safety.
            'image': (row.get('ImageURL') or row.get('Image') or row.get('image') or '').strip(),
        }
    return projects

def slugify(title):
    """Match Python slugify in generate_pages.py for consistency."""
    s = (title or '').lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s-]+', '-', s).strip('-')
    return s

def normalize_status(s: str) -> str:
    """Bucket the freeform delivery field into a canonical status key."""
    d = (s or '').lower().strip()
    for key in ['now open', 'opening soon', 'under construction', 'breaking ground', 'announced']:
        if key in d:
            return key
    return 'announced'

STATUS_LABELS = {
    'announced': 'Announced',
    'breaking ground': 'Breaking Ground',
    'under construction': 'Under Construction',
    'opening soon': 'Opening Soon',
    'now open': 'Now Open',
}

# --- ARTICLE  PROJECT MATCHING ---------------------------------------------
def _project_name_variants(name: str) -> list:
    """Return the project name + likely common variants for matching.

    Articles routinely drop the leading article ('The Nora District' becomes
    'Nora District' in body copy), and sometimes use the abbreviated proper
    noun alone ('The Nora District' becomes 'Nora' on second reference). We
    return:
      - the full name (always)
      - the name with leading 'the ' stripped (if applicable, and 4+ chars
        remaining)
    All variants are lowercased and filtered to 4+ chars to keep the false
    positive floor in line with the rest of the matcher.
    """
    variants = []
    if not name:
        return variants
    lower = name.lower().strip()
    if len(lower) >= 4:
        variants.append(lower)
    # Strip leading definite article
    if lower.startswith('the '):
        stripped = lower[4:].strip()
        if len(stripped) >= 4 and stripped not in variants:
            variants.append(stripped)
    return variants


def _project_matches_text(name: str, text_lower: str) -> bool:
    """Word-boundary match of `name` (and its variants) against `text_lower`.
    Both inputs are already lowercased by the caller.

    Defensive: re-runs html.unescape() on the text so any HTML entity
    that slipped past the body extractor (e.g. "&amp;" ‚Üí "&", "&#39;"
    ‚Üí "'") still matches project names containing those characters.
    Without this, "R&B Sports Center" never matches an article whose
    HTML body has "R&amp;B Sports Center"."""
    if not text_lower:
        return False
    # Cheap defensive entity decode; idempotent on already-decoded text.
    if '&' in text_lower:
        text_lower = html.unescape(text_lower)
    for variant in _project_name_variants(name):
        pattern = r'(?:^|\W)' + re.escape(variant) + r'(?:\W|$)'
        if re.search(pattern, text_lower):
            return True
    return False


def match_article_to_project(article: dict, projects: dict) -> str | None:
    """Try to find a matching project slug for an article. Returns slug or None.

    Used to attach a single project to a pulse event (the news feed).
    Strategy: try title-only first (highest confidence -- the article is
    *about* the project). If no title match, fall back to body match so
    articles that mention the project in the lede but not the headline
    still surface as pulse events. Without the fallback, an article like
    "West Palm Beach's newest development takes shape" wouldn't link to
    The Nora District even when the body talks about nothing else.

    Matches against both the full project name AND the article-stripped
    variant so 'Nora District' in an article body links back to a project
    titled 'The Nora District' in the sheet. See _project_name_variants.

    Picks the longest-named matching project first to reduce false
    positives from short names showing up inside longer names (e.g.
    'Aman' inside 'Aman Miami Beach').
    """
    title_lower = (article.get('title_full') or '').lower()
    body_lower = (article.get('body') or '').lower()
    if not title_lower and not body_lower:
        return None

    # Longest first so 'Aman Miami Beach' wins over 'Aman'
    sorted_projects = sorted(projects.values(), key=lambda p: -len(p['title']))

    # Pass 1: title match (high confidence)
    for p in sorted_projects:
        if _project_matches_text(p['title'], title_lower):
            return p['slug']

    # Pass 2: body match (lower confidence, but better than dropping the
    # event).
    for p in sorted_projects:
        if _project_matches_text(p['title'], body_lower):
            return p['slug']

    return None

def match_article_to_all_projects(article: dict, projects: dict) -> list:
    """Find every project mentioned in an article's title OR body.

    Used to populate the Coverage section. A single article may discuss
    several projects (a market roundup, an architect feature, etc.), and
    each project's modal should list every article that mentions it -- even
    when the project name only appears in the body, not the headline.

    Uses the same variant-aware matcher as match_article_to_project so
    "Nora District" in an article body resolves to a project titled "The
    Nora District" in the sheet. Project titles shorter than 4 characters
    are filtered out inside _project_name_variants to keep the noise floor
    low.
    """
    title_lower = (article.get('title_full') or '').lower()
    body_lower = (article.get('body') or '').lower()
    if not title_lower and not body_lower:
        return []

    matches = []
    sorted_projects = sorted(projects.values(), key=lambda p: -len(p['title']))
    for p in sorted_projects:
        if (_project_matches_text(p['title'], title_lower) or
            _project_matches_text(p['title'], body_lower)):
            matches.append(p['slug'])
    return matches

# --- ARTICLES ARCHIVE -------------------------------------------------------
# A persistent map of project_slug -> list of articles that mention the
# project. Used by the Project Modal's "Coverage on TMW" section. Survives
# across runs even when articles fall off the RSS feed (which only holds
# ~20 most recent items).
ARTICLES_JSON = 'articles.json'

def load_articles_archive() -> dict:
    """Load the existing articles archive. Returns {} if missing."""
    try:
        with open(ARTICLES_JSON, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _reassign_orphan_slugs(archive: dict, projects: dict) -> dict:
    """Walk archive entries under slugs that aren't in the current projects
    dict (i.e. orphaned -- usually because a project was renamed in the
    sheet, changing its slug). Re-run the matcher against each orphan
    article's title + body and move it to the matching current slug.

    This makes renames self-healing: rename 'Ponce Park Residences' to
    'Ponce Park' in the sheet, and the next pulse run automatically
    relocates all the old Ponce-Park articles from the dead
    ponce-park-residences slug to the new ponce-park slug.

    Articles that don't match any current project after re-evaluation
    are dropped (the slug truly orphaned -- project was deleted or
    renamed to something no longer detectable).
    """
    current_slugs = set(projects.keys())
    orphan_slugs = [s for s in list(archive.keys()) if s not in current_slugs]
    if not orphan_slugs:
        return archive

    print(f"   Reassigning orphan slugs: found {len(orphan_slugs)} -> {orphan_slugs[:5]}{'...' if len(orphan_slugs) > 5 else ''}")
    reassigned = 0
    dropped = 0
    for orphan in orphan_slugs:
        for entry in archive[orphan]:
            # Synthesize an article-shaped dict so we can re-use the
            # word-boundary variant matcher exactly as RSS articles use it.
            pseudo_article = {
                'title':      entry.get('title') or '',
                'title_full': entry.get('title') or '',
                'body':       '',  # we don't have body in archive entries
            }
            matches = match_article_to_all_projects(pseudo_article, projects)
            if not matches:
                dropped += 1
                continue
            for new_slug in matches:
                existing = archive.setdefault(new_slug, [])
                # Skip if this entry already lives under the new slug
                if any(e.get('guid') == entry.get('guid') or
                       (e.get('link') and e.get('link') == entry.get('link'))
                       for e in existing):
                    continue
                existing.append(entry)
                reassigned += 1
        # Drop the orphan slug entirely after we've redistributed its entries
        del archive[orphan]

    print(f"   Reassigned: {reassigned} entries moved, {dropped} dropped (no match)")
    return archive


def update_articles_archive(articles: list, projects: dict) -> dict:
    """Merge current RSS articles into the archive, preserving existing entries.

    For each fresh article matched to one or more projects, append (or update)
    that article entry under each project's slug. Dedupe by article guid so a
    re-run doesn't create duplicates. Sort each project's list newest first.
    """
    archive = load_articles_archive()

    # Self-heal renamed projects: any archive entries under a slug that
    # no longer exists in the current sheet get re-evaluated against the
    # current project list and moved to the matching slug. Without this,
    # renaming "Ponce Park Residences" to "Ponce Park" leaves all the
    # old articles stranded under the dead ponce-park-residences slug
    # forever.
    archive = _reassign_orphan_slugs(archive, projects)

    # Diagnostics: track how many of this run's articles matched at least
    # one project. Logs help debug "why is articles.json so small?" issues.
    matched_count = 0
    unmatched_titles = []

    for article in articles:
        guid = article.get('guid') or article.get('link') or ''
        if not guid:
            continue
        slugs = match_article_to_all_projects(article, projects)
        if not slugs:
            # Save up to 5 unmatched headlines for the log -- helps eyeball
            # whether matches should have been found
            if len(unmatched_titles) < 5:
                unmatched_titles.append(article.get('title_full', '')[:80])
            continue
        matched_count += 1
        entry = {
            'guid': guid,
            'title': article.get('title_full') or article.get('title') or '',
            'link': article.get('link') or '',
            'image': article.get('image') or '',
            'published_at': article.get('published_at') or '',
        }
        for slug in slugs:
            existing = archive.setdefault(slug, [])
            # Replace by guid if present, else append
            existing = [e for e in existing if e.get('guid') != guid]
            existing.append(entry)
            archive[slug] = existing

    print(f"   Matching diagnostic: {matched_count}/{len(articles)} RSS articles matched to >= 1 project")
    if unmatched_titles:
        print("   Sample of unmatched headlines (these contained no project name in title or body):")
        for t in unmatched_titles:
            print(f"     - {t}")

    # Sort each project's articles newest first, dedupe by link (catching
    # any cross-source duplicates with different guids), and cap to a
    # reasonable depth so the JSON doesn't grow unbounded over years.
    MAX_PER_PROJECT = 50
    for slug, entries in archive.items():
        # Dedupe by canonical link. If two entries share a link, keep the
        # newest published_at -- which gives us the latest title/image data.
        by_link = {}
        for e in entries:
            link = (e.get('link') or '').strip()
            key = link or e.get('guid') or ''
            if not key:
                continue
            existing = by_link.get(key)
            if existing is None:
                by_link[key] = e
            else:
                # Keep the entry with the newer published_at
                new_ts = e.get('published_at') or ''
                old_ts = existing.get('published_at') or ''
                if new_ts > old_ts:
                    by_link[key] = e
        deduped = list(by_link.values())
        deduped.sort(key=lambda e: e.get('published_at') or '', reverse=True)
        archive[slug] = deduped[:MAX_PER_PROJECT]
    return archive

def save_articles_archive(archive: dict):
    with open(ARTICLES_JSON, 'w', encoding='utf-8') as f:
        json.dump(archive, f, indent=2, ensure_ascii=False)

# --- EVENT BUILDERS ---------------------------------------------------------
def build_status_change_event(slug, project, prev_status, new_status):
    return {
        'id': f"status-{slug}-{new_status.replace(' ', '-')}",
        'type': 'status_change',
        'tag': STATUS_LABELS.get(new_status, new_status.title()),
        'title': f"{project['title']}  {STATUS_LABELS.get(new_status, new_status.title())}",
        'project_slug': slug,
        'project_title': project['title'],
        'city': project['city'],
        'image': project.get('image') or '',
        'link': f"{SITE_URL}/?project={re.sub(r'[^a-z0-9]', '', project['title'].lower())}",
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }

def build_new_project_event(slug, project):
    return {
        'id': f"new-{slug}",
        'type': 'new_project',
        'tag': 'New on Map',
        'title': f"{project['title']} added to the map",
        'project_slug': slug,
        'project_title': project['title'],
        'city': project['city'],
        'image': project.get('image') or '',
        'link': f"{SITE_URL}/?project={re.sub(r'[^a-z0-9]', '', project['title'].lower())}",
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }

def build_article_event(article, matched_slug):
    # The Pulse drawer renders e.city as the gray location text on every
    # row. Articles don't have a city; instead, surface the article's
    # primary Wix category (e.g. "Hospitality", "Residential") so the row
    # has a meaningful secondary label that visually matches the city
    # text on map-update rows. First non-empty category wins; fallback
    # is empty (drawer hides the line gracefully).
    primary_category = ''
    cats = article.get('categories') or []
    for c in cats:
        if c and c.strip():
            primary_category = c.strip()
            break

    return {
        'id': f"article-{article['guid']}",
        'type': 'article',
        'tag': 'On TMW',
        'title': article['title'],
        'title_full': article['title_full'],
        'project_slug': matched_slug,
        # Re-using the 'city' field for category text is a small abuse of
        # the schema but keeps the frontend renderer dead simple -- the
        # template just reads e.city and the drawer doesn't need to know
        # whether the value came from a CSV city or a Wix category. If a
        # future renderer needs to differentiate, e.type='article' is the
        # signal.
        'city': primary_category,
        'image': article.get('image') or '',
        'link': article['link'],
        'timestamp': article.get('published_at') or datetime.now(timezone.utc).isoformat(),
    }

# --- SNAPSHOT (STATE) MANAGEMENT --------------------------------------------
def load_snapshot():
    """Load previous run's snapshot for diffing."""
    if not os.path.exists(SNAPSHOT_JSON):
        return {'projects': {}, 'seen_article_guids': []}
    try:
        with open(SNAPSHOT_JSON, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"  ! Snapshot read error (treating as empty): {e}", file=sys.stderr)
        return {'projects': {}, 'seen_article_guids': []}

def save_snapshot(projects, seen_article_guids):
    """Persist current state for the next run to diff against."""
    snapshot = {
        'projects': {
            slug: {'status': normalize_status(p['delivery']), 'title': p['title']}
            for slug, p in projects.items()
        },
        'seen_article_guids': list(seen_article_guids)[-200:],  # cap memory
        'last_run': datetime.now(timezone.utc).isoformat(),
    }
    with open(SNAPSHOT_JSON, 'w', encoding='utf-8') as f:
        json.dump(snapshot, f, indent=2)

def load_existing_pulse():
    """Load existing pulse.json so we can preserve prior events."""
    if not os.path.exists(PULSE_JSON):
        return []
    try:
        with open(PULSE_JSON, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get('events', [])
    except Exception:
        return []

# --- MAIN -------------------------------------------------------------------
def main():
    print(" TMW Pulse Generator starting...")

    # 1. Load previous state
    snapshot = load_snapshot()
    prev_projects = snapshot.get('projects', {})
    seen_guids = set(snapshot.get('seen_article_guids', []))
    is_first_run = len(prev_projects) == 0

    # 2. Fetch current map data
    print(" Loading map data from projects-flat.json...")
    current_projects = fetch_csv_projects()
    print(f"   {len(current_projects)} projects loaded")

    # 3. Fetch RSS articles
    print(" Fetching RSS feed...")
    articles = fetch_rss()
    print(f"   {len(articles)} articles parsed from RSS feed")

    # Diagnostics: how many articles have body content (helps confirm
    # whether <content:encoded> is being served by Wix). If most articles
    # have body=='', the feed only serves headlines + excerpts.
    with_body = sum(1 for a in articles if (a.get('body') or '').strip())
    avg_body_len = (sum(len((a.get('body') or '')) for a in articles) // max(1, len(articles)))
    print(f"   Body-content stats: {with_body}/{len(articles)} articles have body text, avg length {avg_body_len} chars")
    if articles:
        sample = articles[0]
        print(f"   First article preview: '{sample.get('title_full','')[:80]}'")
        print(f"   First article body preview: '{(sample.get('body') or '')[:120]}...'")

    # 4. Diff projects to detect status changes + new additions
    new_events = []

    # Identify previous slugs that are no longer in current projects --
    # candidates for being renames rather than deletions. Used below to
    # match against current-slug "new" entries by title variant. Without
    # this, renaming "Ponce Park Residences" -> "Ponce Park" makes every
    # pulse run emit a spurious "Ponce Park added to the map" event,
    # because the slug genuinely is new even though the project isn't.
    current_slug_set = set(current_projects.keys())
    orphan_prev_slugs = {
        slug: prev for slug, prev in prev_projects.items()
        if slug not in current_slug_set
    }

    def _norm_title(t):
        # Lowercase + collapse whitespace + strip leading "the "; same
        # spirit as _project_name_variants used by article matching.
        t = (t or '').lower().strip()
        t = re.sub(r'\s+', ' ', t)
        if t.startswith('the '):
            t = t[4:]
        return t

    # Build a lookup of "current title (normalized) -> orphan prev entry"
    # so we can check whether a "new" slug is actually a rename of an
    # orphan. We match on title because slug is exactly what changed.
    orphan_by_title = {}
    for orphan_slug, orphan_prev in orphan_prev_slugs.items():
        norm = _norm_title(orphan_prev.get('title', ''))
        if norm:
            orphan_by_title.setdefault(norm, []).append((orphan_slug, orphan_prev))

    # Skip diff events on first run -- would generate noise (every project would be "new")
    if not is_first_run:
        for slug, project in current_projects.items():
            new_status = normalize_status(project['delivery'])
            prev = prev_projects.get(slug)

            if prev is None:
                # Slug is not in previous snapshot. Could be: (a) genuinely
                # new project, or (b) the same project under a renamed slug.
                # Detect rename by matching current title against orphan
                # prev titles (variant-aware: "Ponce Park" matches a prior
                # "Ponce Park Residences" because both normalize to share
                # the leading words; we use loose containment to catch
                # shortening renames in either direction).
                curr_norm = _norm_title(project['title'])
                rename_match = None
                # Exact normalized hit
                if curr_norm in orphan_by_title:
                    rename_match = orphan_by_title[curr_norm][0]
                else:
                    # Loose containment: current title contained in an
                    # orphan title (e.g. "Ponce Park" inside "Ponce Park
                    # Residences"), or vice versa. Match the orphan whose
                    # title shares the most words with current.
                    for orphan_norm, candidates in orphan_by_title.items():
                        if curr_norm and orphan_norm and (
                            curr_norm in orphan_norm or orphan_norm in curr_norm
                        ):
                            rename_match = candidates[0]
                            break

                if rename_match is not None:
                    # Rename detected. Treat as if the slug existed all
                    # along, with the orphan's previous status. Emit a
                    # status-change event ONLY if the status actually
                    # changed; otherwise emit nothing (silent rename).
                    _, orphan_prev = rename_match
                    prev_status = orphan_prev.get('status', 'announced')
                    if new_status != prev_status:
                        new_events.append(build_status_change_event(slug, project, prev_status, new_status))
                        print(f"   STATUS (via rename): {project['title']}: {prev_status} {new_status}")
                    else:
                        print(f"   RENAME (silent): {orphan_prev.get('title','?')} -> {project['title']}")
                else:
                    # Truly new project
                    new_events.append(build_new_project_event(slug, project))
                    print(f"  + NEW: {project['title']}")
            else:
                prev_status = prev.get('status', 'announced')
                if new_status != prev_status:
                    new_events.append(build_status_change_event(slug, project, prev_status, new_status))
                    print(f"   STATUS: {project['title']}: {prev_status}  {new_status}")
    else:
        print("  ! First run -- skipping project diff (would generate noise)")

    # 5. Add unseen articles
    for article in articles:
        if article['guid'] in seen_guids:
            continue
        matched_slug = match_article_to_project(article, current_projects)
        new_events.append(build_article_event(article, matched_slug))
        seen_guids.add(article['guid'])
        match_note = f"  matched to {matched_slug}" if matched_slug else ""
        print(f"   ARTICLE: {article['title']}{match_note}")

    print(f" {len(new_events)} new events this run")

    # 6. Merge with existing pulse, dedupe by id, sort by timestamp desc, cap
    existing_events = load_existing_pulse()
    by_id = {e['id']: e for e in existing_events}
    for e in new_events:
        by_id[e['id']] = e

    # Backfill: any existing event missing an image gets one filled in from
    # the current project data (if available). This handles events that were
    # emitted before the ImageURL column lookup was fixed -- without this they
    # would forever show the empty placeholder thumb.
    for ev_id, ev in by_id.items():
        if ev.get('image'):
            continue
        slug = ev.get('project_slug')
        if slug and slug in current_projects:
            project_image = current_projects[slug].get('image') or ''
            if project_image:
                ev['image'] = project_image

    # Backfill: any existing ARTICLE event without a 'city' value gets one
    # filled in from the article's first Wix category. Articles emitted
    # before the build_article_event change had city='' which made the
    # Pulse drawer omit the gray location line. By matching on link
    # (canonical URL = stable across runs), we can retroactively populate
    # the category for events still sitting in pulse.json. Articles that
    # are no longer in the current RSS window (older than ~25 most recent)
    # can't be backfilled this way, but new events will be correct from
    # build_article_event onwards so the feed self-heals over time.
    articles_by_link = {a.get('link'): a for a in articles if a.get('link')}
    for ev in by_id.values():
        if ev.get('type') != 'article': continue
        if ev.get('city'): continue
        match = articles_by_link.get(ev.get('link') or '')
        if not match: continue
        cats = match.get('categories') or []
        for c in cats:
            if c and c.strip():
                ev['city'] = c.strip()
                break

    # Secondary dedupe pass for article events: collapse duplicates that share
    # the same link but have different ids. This happens when the guid format
    # changes between runs (e.g. the recent switch from RSS <guid> UUIDs to
    # canonical URLs as the article guid). Without this pass, the same news
    # article shows up twice in pulse.json with two different `article-*` ids.
    seen_article_links = {}
    deduped_events = []
    for ev in by_id.values():
        if ev.get('type') == 'article':
            link = (ev.get('link') or '').strip()
            if link:
                prior = seen_article_links.get(link)
                if prior is None:
                    seen_article_links[link] = ev
                    deduped_events.append(ev)
                else:
                    # Keep whichever has the newer timestamp (data is more
                    # likely fresh); discard the older duplicate.
                    if (ev.get('timestamp') or '') > (prior.get('timestamp') or ''):
                        # Replace the prior entry in deduped_events with ev
                        for i, prev in enumerate(deduped_events):
                            if prev is prior:
                                deduped_events[i] = ev
                                break
                        seen_article_links[link] = ev
                continue
        deduped_events.append(ev)

    all_events = deduped_events
    all_events.sort(key=lambda e: e.get('timestamp') or '', reverse=True)
    all_events = all_events[:MAX_EVENTS]

    # 7. Write pulse.json
    output = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'event_count': len(all_events),
        'events': all_events,
    }
    with open(PULSE_JSON, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"   Wrote {PULSE_JSON} ({len(all_events)} events)")

    # 8. Update the articles archive (project_slug -> list of articles).
    # Used by the Project Modal "Coverage on TMW" section. We re-scan every
    # current RSS article (not just unseen ones) and merge into the archive
    # by guid so newly-added projects retroactively pick up older coverage.
    archive = update_articles_archive(articles, current_projects)
    save_articles_archive(archive)
    coverage_total = sum(len(v) for v in archive.values())
    print(f"   Wrote {ARTICLES_JSON} ({coverage_total} article entries across {len(archive)} projects)")

    # 9. Save snapshot for next run
    save_snapshot(current_projects, seen_guids)
    print(f"   Wrote {SNAPSHOT_JSON}")

    print(" Done.")

if __name__ == '__main__':
    main()
