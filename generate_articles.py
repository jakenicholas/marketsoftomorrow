#!/usr/bin/env python3
"""
generate_articles.py — pre-render one static HTML page per journal article.

WHY: journal/post/index.html is a single-page app that fetches the article
from the worker and renders it client-side. Social scrapers (Facebook,
LinkedIn, Slack, iMessage, Twitter/X) and some crawlers do NOT run JS, so the
JS-injected <title>/OG/JSON-LD never appears for them — link previews are blank
and SEO is weak. This script bakes the real <head> (title, description,
canonical, Open Graph, Twitter, NewsArticle JSON-LD) AND the article body into
a static file per post, served at a clean path URL:

    /journal/post/<slug>/index.html   →   https://…/journal/post/<slug>/

The page still ships the full SPA script, so in a browser it progressively
enhances (galleries, responsive images, "Read next"). A window.__PRERENDERED__
flag tells the bootstrap to skip the re-fetch/re-render and just hydrate.

The legacy ?slug= SPA (journal/post/index.html) stays as a working fallback;
its canonical now points at the path-based page so there's one canonical/post.

SOURCE: worker /posts (slug list) + /posts/by-slug/<slug> (full body + SEO).
Run locally or from CI (generate-pages.yml). Flip BASE after the domain move.

    python3 generate_articles.py            # all posts
    python3 generate_articles.py --limit 5  # quick smoke test (first N)
"""
import json, os, re, subprocess, sys, html, datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE   = "https://map.oftmw.com"        # ← flip to https://www.oftmw.com after the domain move
WORKER = "https://tmw.jake-ab7.workers.dev"
TEMPLATE_PATH = "journal/post/index.html"
OUT_ROOT = "journal/post"
PUBLISHER_LOGO = "https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png"

# ── Exact template substrings we swap (kept in sync with journal/post/index.html) ──
T_TITLE   = "<title>Loading article — Markets of Tomorrow</title>"
T_DESC    = '<meta id="meta-description" name="description" content="">'
T_OG_T    = '<meta id="og-title" property="og:title" content="">'
T_OG_D    = '<meta id="og-description" property="og:description" content="">'
T_OG_I    = '<meta id="og-image" property="og:image" content="">'
T_CATROW  = '<div class="cat-row" id="cat-row"></div>'
T_H1      = '<h1 id="article-title"><span class="skel-block" style="display:inline-block; height:54px; width:80%"></span></h1>'
T_DECK    = '<p class="deck" id="article-deck"></p>'
T_AUTHOR  = '<span id="article-author">—</span>'
T_DATE    = '<span id="article-date">—</span>'
T_COVER   = '<img class="article-cover-img skel-block" id="article-cover-img" alt="" loading="eager">'
T_BODY    = (
    '<div class="article-body-content" id="article-body-content">\n'
    '        <p><span class="skel-block" style="display:block; height:18px; width:96%; margin-bottom:14px"></span>'
    '<span class="skel-block" style="display:block; height:18px; width:92%; margin-bottom:14px"></span>'
    '<span class="skel-block" style="display:block; height:18px; width:88%"></span></p>\n'
    '      </div>'
)
T_DATA_ANCHOR = '<script src="/journal/post/post.js" defer></script>'


def sh(cmd):
    return subprocess.check_output(cmd, timeout=90)


def fetch_slugs():
    raw = sh(["curl", "-s", f"{WORKER}/posts?limit=1500&status=published"])
    return [it["slug"] for it in json.loads(raw).get("items", []) if it.get("slug")]


def fetch_post(slug):
    raw = sh(["curl", "-s", f"{WORKER}/posts/by-slug/{slug}"])
    data = json.loads(raw)
    return data.get("post")


def esc(s):
    return html.escape(str(s or ""), quote=True)


def long_date(post):
    iso = post.get("published_iso")
    ts = post.get("published_at")
    try:
        if iso:
            d = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        elif ts:
            d = datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc)
        else:
            return ""
        return d.strftime("%B ") + str(d.day) + d.strftime(", %Y")
    except Exception:
        return ""


def clean_cats(cats):
    out = []
    for c in (cats or []):
        if re.search(r"markets of tomorrow|of tomorrow", c, re.I):
            continue
        out.append(c)
    return out


def build_page(template, post):
    slug = post["slug"]
    title = post.get("title") or ""
    seo_title = post.get("seo_title") or title
    summary = post.get("excerpt") or ""
    seo_desc = post.get("seo_description") or summary
    cover = post.get("cover_image") or ""
    author = post.get("author_name") or "Markets of Tomorrow"
    cats = clean_cats(post.get("categories"))
    body = post.get("body_html") or ("<p>" + esc(summary) + "</p>")
    url = f"{BASE}/journal/post/{slug}/"
    date_str = long_date(post)
    iso = post.get("published_iso") or ""

    page = template

    # ── HEAD: title + meta swaps ──
    page = page.replace(T_TITLE, f"<title>{esc(seo_title)} — Markets of Tomorrow</title>")
    page = page.replace(T_DESC, f'<meta id="meta-description" name="description" content="{esc(seo_desc)}">')
    page = page.replace(T_OG_T, f'<meta id="og-title" property="og:title" content="{esc(title)}">')
    page = page.replace(T_OG_D, f'<meta id="og-description" property="og:description" content="{esc(seo_desc)}">')
    page = page.replace(T_OG_I, f'<meta id="og-image" property="og:image" content="{esc(cover)}">')

    # ── HEAD: extra SEO tags injected before </head> ──
    jsonld = {
        "@context": "https://schema.org", "@type": "NewsArticle",
        "headline": title, "description": seo_desc,
        "image": [cover] if cover else None,
        "datePublished": iso or None,
        "dateModified": post.get("updated_iso") or iso or None,
        "author": {"@type": "Person", "name": author} if author else {"@type": "Organization", "name": "Markets of Tomorrow"},
        "publisher": {"@type": "Organization", "name": "Markets of Tomorrow",
                      "logo": {"@type": "ImageObject", "url": PUBLISHER_LOGO}},
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
    }
    jsonld = {k: v for k, v in jsonld.items() if v is not None}
    jsonld_str = json.dumps(jsonld, ensure_ascii=False).replace("</", "<\\/")
    head_extra = (
        f'<link rel="canonical" href="{esc(url)}">\n'
        f'<meta property="og:url" content="{esc(url)}">\n'
        f'<meta property="og:site_name" content="Markets of Tomorrow">\n'
        + (f'<meta property="article:published_time" content="{esc(iso)}">\n' if iso else "")
        + f'<meta name="twitter:title" content="{esc(seo_title)}">\n'
        f'<meta name="twitter:description" content="{esc(seo_desc)}">\n'
        + (f'<meta name="twitter:image" content="{esc(cover)}">\n' if cover else "")
        + f'<script type="application/ld+json" id="article-jsonld">{jsonld_str}</script>\n'
        "</head>"
    )
    page = page.replace("</head>", head_extra, 1)

    # ── BODY: bake the rendered article into the skeleton ──
    pills = "".join(f'<span class="cat">{esc(c)}</span>' for c in cats[:4])
    page = page.replace(T_CATROW, f'<div class="cat-row" id="cat-row">{pills}</div>')

    page = page.replace(T_H1, f'<h1 id="article-title">{esc(title)}</h1>')

    deck = re.sub(r"\s+", " ", summary).strip()
    if deck and 30 < len(deck) < 240:
        page = page.replace(T_DECK, f'<p class="deck" id="article-deck">{esc(deck)}</p>')
    else:
        page = page.replace(T_DECK, '<p class="deck" id="article-deck" style="display:none"></p>')

    page = page.replace(T_AUTHOR, f'<span id="article-author">{esc(author)}</span>')
    page = page.replace(T_DATE, f'<span id="article-date">{esc(date_str)}</span>')

    if cover:
        page = page.replace(T_COVER,
            f'<img class="article-cover-img" id="article-cover-img" src="{esc(cover)}" alt="{esc(title)}" loading="eager">')
    else:
        page = page.replace(T_COVER,
            '<img class="article-cover-img" id="article-cover-img" alt="" loading="eager" style="display:none">')

    page = page.replace(T_BODY, f'<div class="article-body-content" id="article-body-content">{body}</div>')

    # ── window.__POST__ data block (runs before the main inline script) ──
    post_data = {
        "slug": slug, "title": title, "image": cover, "summary": summary,
        "categories": cats, "author": author,
        "pubDate": post.get("published_iso") or date_str, "published_iso": iso,
        "link": post.get("wix_url") or url,
    }
    data_json = json.dumps(post_data, ensure_ascii=False).replace("</", "<\\/")
    # Inline data block runs before the deferred post.js (window.__POST__ must
    # exist when the bootstrap fires).
    data_block = (
        f"<script>window.__PRERENDERED__=1;window.__POST__={data_json};</script>\n"
        '<script src="/journal/post/post.js" defer></script>'
    )
    page = page.replace(T_DATA_ANCHOR, data_block, 1)

    return page


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    with open(TEMPLATE_PATH, encoding="utf-8") as f:
        template = f.read()

    # Sanity: every marker must exist exactly once, else a template edit
    # silently broke the pre-render. Fail loud rather than ship blank pages.
    markers = [T_TITLE, T_DESC, T_OG_T, T_OG_D, T_OG_I, T_CATROW,
               T_H1, T_DECK, T_AUTHOR, T_DATE, T_COVER, T_BODY, T_DATA_ANCHOR]
    missing = [m[:40] for m in markers if template.count(m) != 1]
    if missing:
        print("ERROR: template markers missing/duplicated — pre-render aborted:")
        for m in missing:
            print("   •", m)
        sys.exit(1)

    slugs = fetch_slugs()
    if limit:
        slugs = slugs[:limit]
    print(f"Pre-rendering {len(slugs)} articles → {OUT_ROOT}/<slug>/index.html")

    def fetch(slug):
        try:
            return slug, fetch_post(slug)
        except Exception as e:
            return slug, ("ERR:" + str(e))

    posts = {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        for fut in as_completed([ex.submit(fetch, s) for s in slugs]):
            slug, post = fut.result()
            posts[slug] = post

    written, skipped = 0, []
    for slug in slugs:
        post = posts.get(slug)
        if not isinstance(post, dict):
            skipped.append((slug, post if isinstance(post, str) else "no post"))
            continue
        try:
            page = build_page(template, post)
        except Exception as e:
            skipped.append((slug, "build:" + str(e)))
            continue
        out_dir = os.path.join(OUT_ROOT, slug)
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as f:
            f.write(page)
        written += 1

    print(f"✓ wrote {written} article pages")
    if skipped:
        print(f"⚠ skipped {len(skipped)}:")
        for slug, why in skipped[:20]:
            print(f"   • {slug}: {why}")


if __name__ == "__main__":
    main()
