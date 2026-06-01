#!/usr/bin/env python3
"""
generate_journal_sitemap.py — sitemap.xml + robots.txt for the JOURNAL site
(www.oftmw.com), where the journal is served at the domain root and articles
live at /post/<slug>/ (matching the original Wix URLs). Output goes inside
journal/ so it's served at www.oftmw.com/sitemap.xml after the Cloudflare Pages
deploy (publish dir = journal/).

  python3 generate_journal_sitemap.py
"""
import json, subprocess, datetime, html

BASE   = "https://www.oftmw.com"
WORKER = "https://tmw.jake-ab7.workers.dev"
OUT_DIR = "journal"

def fetch_posts():
    raw = subprocess.check_output(["curl", "-s", f"{WORKER}/posts?limit=2000&status=published"], timeout=90)
    return json.loads(raw).get("items", [])

def iso(ts):
    if not ts:
        return None
    try:
        return datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return str(ts)[:10]

def url_tag(loc, lastmod=None, priority="0.6", changefreq="weekly"):
    s = f"  <url>\n    <loc>{html.escape(loc)}</loc>\n"
    if lastmod:
        s += f"    <lastmod>{lastmod}</lastmod>\n"
    s += f"    <changefreq>{changefreq}</changefreq>\n    <priority>{priority}</priority>\n  </url>\n"
    return s

def main():
    posts = fetch_posts()
    today = datetime.date.today().strftime("%Y-%m-%d")
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    out.append(url_tag(f"{BASE}/", today, "1.0", "daily"))
    for p in ("golf", "restaurants", "hotels"):
        out.append(url_tag(f"{BASE}/{p}/", today, "0.8", "weekly"))
    out.append(url_tag(f"{BASE}/media/", today, "0.6", "monthly"))
    out.append(url_tag(f"{BASE}/search/", today, "0.4", "monthly"))
    for it in posts:
        slug = it.get("slug")
        if not slug:
            continue
        # lastmod = last edit (updated_at) so edited posts get recrawled; fall
        # back to first-publish if updated_at is somehow missing.
        lastmod = iso(it.get("updated_at") or it.get("published_at"))
        out.append(url_tag(f"{BASE}/post/{slug}/", lastmod, "0.7", "monthly"))
    out.append('</urlset>\n')
    with open(f"{OUT_DIR}/sitemap.xml", "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    with open(f"{OUT_DIR}/robots.txt", "w", encoding="utf-8") as f:
        f.write("User-agent: *\nAllow: /\n\nSitemap: " + BASE + "/sitemap.xml\n")
    print(f"journal/sitemap.xml: {len(posts)} articles + 5 core pages")

if __name__ == "__main__":
    main()
