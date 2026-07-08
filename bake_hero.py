#!/usr/bin/env python3
"""
bake_hero.py — bake the homepage featured-story HERO into journal/index.html at
build time.

WHY: the hero used to render a "Loading the latest story…" placeholder and get
filled by client JS after a /posts round-trip. That (a) delayed the hero, (b)
caused the mobile layout shift (the placeholder→real-content swap grew the card),
and (c) hid the LCP image from the HTML (JS set the src, so the browser couldn't
preload it). Baking the real headline/summary/link/image straight into the markup
fixes all three: instant hero, no placeholder, no shift, preloadable LCP image.

SELECTION mirrors the client exactly (journal/index.html):
    HERO_ITEM = ALL_ITEMS.find(it => it.featured) || ALL_ITEMS[0]
i.e. the most-recent FEATURED published post, else the newest — but restricted
to posts whose static /post/<slug>/index.html exists in THIS build, so the hero
never links to a page that hasn't deployed yet (no 404). Runs AFTER
generate_articles.py (the page dirs must exist). Idempotent; safe to re-run.

The client's renderFeatured() skips a baked hero (href != "#"), so nothing swaps.

Run: python3 bake_hero.py
"""
import html
import json
import os
import re
import subprocess

WORKER = "https://tmw.jake-ab7.workers.dev"
INDEX = "journal/index.html"
POST_DIR = "journal/post"
R2_HOST = "pub-7da0281887564d10a10107987c7c6c0c.r2.dev"


def thumb(url, w):
    """Pre-generated small WEBP for an R2 image (see generate_thumbnails.py);
    else the url unchanged."""
    if not url or R2_HOST not in url:
        return url
    clean = url.split("?", 1)[0]
    if not re.search(r"\.(jpe?g|png|webp)$", clean, re.I):
        return url
    return re.sub(r"\.[A-Za-z0-9]+$", f"_{w}.webp", clean)


def sh(cmd):
    return subprocess.check_output(cmd, timeout=60).decode("utf-8", "replace")


def fetch_top():
    # ungated=1 so we see a just-published post; then require its page to exist on
    # disk (built this run) so the hero can never point at a not-yet-deployed 404.
    raw = sh(["curl", "-s", f"{WORKER}/posts?limit=60&status=published&ungated=1"])
    items = json.loads(raw).get("items", [])
    live = [it for it in items
            if it.get("slug") and os.path.isfile(os.path.join(POST_DIR, it["slug"], "index.html"))]
    if not live:
        return None
    return next((it for it in live if it.get("featured")), live[0])


def bake(post):
    src = open(INDEX, encoding="utf-8").read()
    slug = post["slug"]
    title = (post.get("title") or "").strip()
    summary = (post.get("excerpt") or "").strip()
    image = (post.get("cover_image") or "").strip()
    link = "/post/" + slug + "/"
    ta, te = html.escape(title, quote=True), html.escape(title)
    se = html.escape(summary)
    ia, la = html.escape(image, quote=True), html.escape(link, quote=True)

    out = src
    # Hero image — eager + high fetch priority so it's the discoverable LCP image.
    # Serve the small WEBP thumbs (_800 as src, _400/_800 srcset) so the LCP is a
    # ~60KB image instead of the full ~700KB original; onerror restores the full
    # original once if a thumb is missing.
    t4, t8 = thumb(image, 400), thumb(image, 800)
    if t8 != image:
        t4a, t8a = html.escape(t4, quote=True), html.escape(t8, quote=True)
        hero_img = (f'<img id="hero-img" src="{t8a}" srcset="{t4a} 400w, {t8a} 800w" '
                    f'sizes="(max-width:900px) 100vw, 1100px" '
                    f'''onerror="this.onerror=null;this.srcset='';this.src='{ia}'" '''
                    f'alt="{ta}" fetchpriority="high" decoding="async">')
    else:
        hero_img = f'<img id="hero-img" src="{ia}" alt="{ta}" fetchpriority="high" decoding="async">'
    out = re.sub(r'<img id="hero-img"[^>]*>', hero_img, out, count=1)
    # Headline link (href + text).
    out = re.sub(r'<a id="hero-link" href="[^"]*">.*?</a>',
                 f'<a id="hero-link" href="{la}">{te}</a>',
                 out, count=1, flags=re.S)
    # Summary paragraph.
    out = re.sub(r'(<p class="sc-desc" id="hero-summary">).*?(</p>)',
                 lambda m: m.group(1) + se + m.group(2), out, count=1, flags=re.S)
    # "Read more" CTA href.
    out = re.sub(r'(<a href=")[^"]*(" class="sc-more" id="hero-cta">)',
                 lambda m: m.group(1) + la + m.group(2), out, count=1)

    if out == src:
        print("[bake_hero] no hero elements matched — index.html markup changed? skipped")
        return False
    with open(INDEX, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"[bake_hero] baked hero → {title[:64]}  ({link})")
    return True


def main():
    try:
        post = fetch_top()
    except Exception as e:
        print(f"[bake_hero] fetch failed ({e}) — leaving the hero as-is")
        return
    if not post:
        print("[bake_hero] no live post found — leaving the placeholder")
        return
    bake(post)


if __name__ == "__main__":
    main()
