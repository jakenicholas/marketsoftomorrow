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

import csv, io, json, os, re, sys, urllib.request
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
MAX_RSS_ITEMS = 20
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
    """Fetch and parse oftmw.com RSS. Returns list of article dicts."""
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

    articles = []
    for item in root.findall('.//item')[:MAX_RSS_ITEMS]:
        title_el = item.find('title')
        link_el = item.find('link')
        date_el = item.find('pubDate')
        guid_el = item.find('guid')
        desc_el = item.find('description')

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

        articles.append({
            'guid': (guid_el.text if guid_el is not None and guid_el.text else title)[:128],
            'title_full': title,
            'title': punchify(title),
            'link': link_el.text.strip() if link_el is not None and link_el.text else '',
            'image': image_url,
            'description': (desc_el.text or '').strip() if desc_el is not None else '',
            'categories': categories,
            'published_at': pub_iso,
        })

    return articles

# --- MAP DATA (CSV) + STATUS DIFF -------------------------------------------
def fetch_csv_projects():
    """Fetch the Google Sheet CSV and return a dict keyed by slug."""
    try:
        req = urllib.request.Request(SHEET_CSV_URL, headers={'User-Agent': 'TMW-Pulse/1.0'})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f"   CSV fetch failed: {e}", file=sys.stderr)
        return {}

    reader = csv.DictReader(io.StringIO(data))
    projects = {}
    for row in reader:
        title = (row.get('Project Name') or row.get('Title') or row.get('title') or '').strip()
        if not title:
            continue
        slug = slugify(title)
        projects[slug] = {
            'slug': slug,
            'title': title,
            'city': (row.get('City') or row.get('city') or '').strip(),
            'delivery': (row.get('Delivery') or row.get('delivery') or '').strip(),
            'image': (row.get('Image') or row.get('image') or '').strip(),
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
def match_article_to_project(article: dict, projects: dict) -> str | None:
    """Try to find a matching project slug for an article. Returns slug or None."""
    title_lower = article['title_full'].lower()
    # Try exact project name match first (longest first to avoid substring misfires)
    sorted_projects = sorted(projects.values(), key=lambda p: -len(p['title']))
    for p in sorted_projects:
        if len(p['title']) < 5:
            continue
        if p['title'].lower() in title_lower:
            return p['slug']
    return None

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
    return {
        'id': f"article-{article['guid']}",
        'type': 'article',
        'tag': 'On TMW',
        'title': article['title'],
        'title_full': article['title_full'],
        'project_slug': matched_slug,
        'city': '',
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
    print(" Fetching map CSV...")
    current_projects = fetch_csv_projects()
    print(f"   {len(current_projects)} projects loaded")

    # 3. Fetch RSS articles
    print(" Fetching RSS feed...")
    articles = fetch_rss()
    print(f"   {len(articles)} articles parsed")

    # 4. Diff projects to detect status changes + new additions
    new_events = []

    # Skip diff events on first run -- would generate noise (every project would be "new")
    if not is_first_run:
        for slug, project in current_projects.items():
            new_status = normalize_status(project['delivery'])
            prev = prev_projects.get(slug)
            if prev is None:
                # New project added since last run
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
    all_events = list(by_id.values())
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

    # 8. Save snapshot for next run
    save_snapshot(current_projects, seen_guids)
    print(f"   Wrote {SNAPSHOT_JSON}")

    print(" Done.")

if __name__ == '__main__':
    main()
