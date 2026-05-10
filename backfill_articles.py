#!/usr/bin/env python3
"""
TMW Articles Backfill
---------------------
One-time script: pulls every published Wix blog post via the official Wix Blog
REST API, matches each article (title + body) to projects on the Map of
Tomorrow, and writes the full coverage archive to articles.json.

Unlike generate_pulse.py (which uses RSS, capped at ~25 items), this hits
the authenticated REST API and paginates through ALL ~1,300 articles.

Usage (locally or in GitHub Actions):
    WIX_API_KEY="IST.xxx" WIX_SITE_ID="xxx-xxx-xxx" python3 backfill_articles.py

The script will OVERWRITE articles.json with the full backfill. Run it once,
then commit articles.json. The hourly generate_pulse.py will keep adding
new articles on top.
"""

import csv
import io
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

# --- CONFIG -----------------------------------------------------------------
WIX_API_KEY = os.environ.get('WIX_API_KEY', '').strip()
WIX_SITE_ID = os.environ.get('WIX_SITE_ID', '').strip()
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1qwU7ykIDUrtPlIQu-qk2FIJwiz-WWg5caq02ja30sgM/export?format=csv&gid=0"
ARTICLES_JSON = 'articles.json'
WIX_LIST_URL = "https://www.wixapis.com/blog/v3/posts"
PAGE_SIZE = 100   # max allowed
MAX_PER_PROJECT = 50

if not WIX_API_KEY or not WIX_SITE_ID:
    print("ERROR: WIX_API_KEY and WIX_SITE_ID environment variables are required.", file=sys.stderr)
    print("Set them via the GitHub Actions secrets or your shell environment.", file=sys.stderr)
    sys.exit(1)


# --- HELPERS ----------------------------------------------------------------
def slugify(title):
    """Match the Python slugify in generate_pulse.py / generate_pages.py."""
    s = (title or '').lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s-]+', '-', s).strip('-')
    return s


def http_get_json(url, headers):
    """GET a URL and parse JSON response. Raises on HTTP error."""
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8', errors='replace'))


def fetch_projects_from_sheet():
    """Read the Google Sheet CSV and return a dict of {slug: title}."""
    print(f"Fetching project sheet...")
    req = urllib.request.Request(SHEET_CSV_URL, headers={'User-Agent': 'TMW-Backfill/1.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        content = resp.read().decode('utf-8', errors='replace')
    rows = list(csv.DictReader(io.StringIO(content)))
    projects = {}
    for row in rows:
        title = (row.get('Title') or '').strip()
        if not title:
            continue
        slug = slugify(title)
        if not slug:
            continue
        projects[slug] = {
            'slug': slug,
            'title': title,
            'image': (row.get('ImageURL') or row.get('Image') or '').strip(),
        }
    print(f"   {len(projects)} projects loaded")
    return projects


def extract_text_from_rich_content(rich):
    """The Wix Blog API returns rich content as a structured object.

    Walk the node tree and concatenate all text spans into a single string
    we can search for project names. Defensive: tolerate missing keys, mixed
    block types, and unexpected shapes.
    """
    if not rich:
        return ''
    out = []
    def walk(node):
        if isinstance(node, dict):
            # Text leaves: {"type": "TEXT", "textData": {"text": "..."}}
            text_data = node.get('textData')
            if isinstance(text_data, dict):
                t = text_data.get('text')
                if t:
                    out.append(t)
            # Recurse into children / nodes
            for key in ('nodes', 'children'):
                children = node.get(key)
                if isinstance(children, list):
                    for child in children:
                        walk(child)
        elif isinstance(node, list):
            for item in node:
                walk(item)
    walk(rich)
    return ' '.join(out)


def extract_post_image(post):
    """Try multiple shapes for the cover image URL Wix returns."""
    media = post.get('media') or {}
    # Newer responses: media.wixMedia.image
    wix_media = media.get('wixMedia') or {}
    image = wix_media.get('image') or {}
    if isinstance(image, dict):
        # A wix media descriptor can be a wix:image://... URI or a public URL
        url = image.get('url') or ''
        if url:
            return url
        wix_uri = image.get('id') or ''
        if wix_uri.startswith('wix:image://'):
            # Strip prefix and turn into a static URL
            # Format: wix:image://v1/<hash>~mv2.jpg/filename.jpg#originWidth=...
            tail = wix_uri[len('wix:image://v1/'):]
            slash = tail.find('/')
            if slash > 0:
                tail = tail[:slash]
            return f"https://static.wixstatic.com/media/{tail}"
    # Older shape: media.url or media.thumbnailUrl
    if media.get('url'):
        return media['url']
    return ''


def fetch_all_wix_posts():
    """Paginate through every published post on the Wix blog. Returns a list."""
    headers = {
        'Authorization': WIX_API_KEY,
        'wix-site-id': WIX_SITE_ID,
        'Content-Type': 'application/json',
    }
    posts = []
    offset = 0
    print(f"Fetching all blog posts from Wix API...")
    while True:
        # fieldsets options used here:
        #   CONTENT_TEXT -- adds the read-only `contentText` field (plain
        #                   text body, up to 400k chars). Easiest to search.
        #   URL          -- adds the canonical post URL so we can link to it.
        # Sending multiple values via repeated query keys (Wix's convention).
        params = [
            ('paging.limit', PAGE_SIZE),
            ('paging.offset', offset),
            ('fieldsets', 'CONTENT_TEXT'),
            ('fieldsets', 'URL'),
        ]
        url = f"{WIX_LIST_URL}?{urllib.parse.urlencode(params)}"
        try:
            data = http_get_json(url, headers)
        except urllib.error.HTTPError as e:
            body = ''
            try:
                body = e.read().decode('utf-8', errors='replace')[:500]
            except Exception:
                pass
            print(f"   HTTP {e.code} on offset {offset}: {body}", file=sys.stderr)
            if e.code in (401, 403):
                print("   Authentication error -- verify WIX_API_KEY and WIX_SITE_ID", file=sys.stderr)
                sys.exit(2)
            # On 5xx or rate limit: brief retry, then give up cleanly
            if e.code in (429, 500, 502, 503, 504):
                print("   Sleeping 5s and retrying once...", file=sys.stderr)
                time.sleep(5)
                try:
                    data = http_get_json(url, headers)
                except Exception as e2:
                    print(f"   Retry failed: {e2}", file=sys.stderr)
                    break
            else:
                break
        page = data.get('posts') or []
        if not page:
            break
        posts.extend(page)
        # Diagnostic: how many posts in this page have actual body text?
        with_body = sum(1 for p in page if (p.get('contentText') or '').strip())
        print(f"   offset={offset}: got {len(page)} posts ({with_body} with body text). Total so far: {len(posts)}")
        # Pagination: if fewer than PAGE_SIZE, we're done
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        # Defensive cap so this never runs forever
        if offset >= 5000:
            print("   Hit 5000-post safety cap, stopping pagination", file=sys.stderr)
            break
        # Be polite -- Wix rate limits aren't documented but a small sleep
        # avoids hammering their API.
        time.sleep(0.25)
    print(f"Total posts fetched: {len(posts)}")
    return posts


def article_dict_from_post(post):
    """Normalize a Wix post object into the shape articles.json expects."""
    title = post.get('title') or ''
    # First-published-date is the most reliable timestamp; fall back to lastPublishedDate
    published_at = post.get('firstPublishedDate') or post.get('lastPublishedDate') or ''
    # Public URL: prefer the API's url.base + url.path if URL fieldset is present
    url_obj = post.get('url') or {}
    if isinstance(url_obj, dict):
        base = url_obj.get('base') or 'https://www.oftmw.com'
        path = url_obj.get('path') or ''
        link = f"{base}{path}" if path else (base or '')
    else:
        slug = post.get('slug') or ''
        link = f"https://www.oftmw.com/post/{slug}" if slug else ''
    # Body: contentText is plain text, no walking needed
    body = (post.get('contentText') or '').strip()
    # Image
    image = extract_post_image(post)
    return {
        'guid': post.get('id') or post.get('slug') or title,
        'title': title,
        'title_full': title,
        'body': body,
        'link': link,
        'image': image,
        'published_at': published_at,
    }


def match_article_to_all_projects(article, projects):
    """Same matcher as generate_pulse.py: word-boundary match in title or body."""
    title_lower = (article.get('title_full') or '').lower()
    body_lower = (article.get('body') or '').lower()
    matches = []
    sorted_projects = sorted(projects.values(), key=lambda p: -len(p['title']))
    for p in sorted_projects:
        name = p['title']
        if len(name) < 5:
            continue
        pattern = r'(?:^|\W)' + re.escape(name.lower()) + r'(?:\W|$)'
        if re.search(pattern, title_lower) or re.search(pattern, body_lower):
            matches.append(p['slug'])
    return matches


def build_archive(articles, projects):
    """Group matched articles by project slug. Sorted newest-first, capped."""
    archive = {}
    matched = 0
    total_assignments = 0
    for art in articles:
        slugs = match_article_to_all_projects(art, projects)
        if not slugs:
            continue
        matched += 1
        entry = {
            'guid': art.get('guid'),
            'title': art.get('title'),
            'link': art.get('link'),
            'image': art.get('image'),
            'published_at': art.get('published_at'),
        }
        for slug in slugs:
            archive.setdefault(slug, []).append(entry)
            total_assignments += 1
    # Sort newest first within each project + cap depth
    for slug, entries in archive.items():
        entries.sort(key=lambda e: e.get('published_at') or '', reverse=True)
        archive[slug] = entries[:MAX_PER_PROJECT]
    print(f"Matching: {matched} articles matched, {total_assignments} project-article links across {len(archive)} projects")
    return archive


# --- MAIN -------------------------------------------------------------------
def main():
    print("TMW Articles Backfill")
    print("=" * 60)
    projects = fetch_projects_from_sheet()
    posts = fetch_all_wix_posts()
    if not posts:
        print("No posts returned -- aborting without overwriting articles.json", file=sys.stderr)
        sys.exit(3)
    articles = [article_dict_from_post(p) for p in posts]
    # Quick body diagnostic
    with_body = sum(1 for a in articles if (a.get('body') or '').strip())
    print(f"Body-content stats: {with_body}/{len(articles)} have body text")
    archive = build_archive(articles, projects)
    # Write
    with open(ARTICLES_JSON, 'w', encoding='utf-8') as f:
        json.dump(archive, f, indent=2, ensure_ascii=False)
    total_entries = sum(len(v) for v in archive.values())
    print(f"Wrote {ARTICLES_JSON}: {total_entries} article entries across {len(archive)} projects")
    print("Done.")


if __name__ == '__main__':
    main()
