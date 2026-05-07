#!/usr/bin/env python3
"""
generate_digest.py — Renders the weekly newsletter HTML.

Reads:
  - pulse.json
  - newsletter/app_updates.md
  - newsletter/ads.json

Writes:
  - newsletter/digest-latest.html
  - newsletter/digest-subject.txt
  - newsletter/digest-archive/YYYY-MM-DD.html
"""

import json, os, re, sys, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from jinja2 import Environment, FileSystemLoader, select_autoescape
from premailer import Premailer

# ─── CONFIG ──────────────────────────────────────────────────────────────────
PULSE_PATH    = "pulse.json"
UPDATES_PATH  = "newsletter/app_updates.md"
ADS_PATH      = "newsletter/ads.json"
TEMPLATE_PATH = "newsletter/digest_template.html"

OUT_HTML      = "newsletter/digest-latest.html"
OUT_SUBJECT   = "newsletter/digest-subject.txt"
ARCHIVE_DIR   = "newsletter/digest-archive"

RSS_URL       = "https://www.oftmw.com/blog-feed.xml"
SITE_URL      = "https://map.oftmw.com"
TMW_URL       = "https://www.oftmw.com"
LOGO_URL      = "https://static.wixstatic.com/media/ca3b83_e80e88810ca942459bfaa140e9fc2267~mv2.png"
APP_IMAGE_URL = "https://static.wixstatic.com/media/ca3b83_653622edfc9f4e6b86432f9412ed5843~mv2.jpg"

LOOKBACK_DAYS    = 7
FLORIDA_LIMIT    = 5   # Articles in Florida section
MORE_MKTS_LIMIT  = 3   # Articles in More Markets section
FLORIDA_CATEGORY = "Florida of Tomorrow"

# ─── HELPERS ─────────────────────────────────────────────────────────────────
def slugify(title):
    s = (title or "").lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    return re.sub(r'[\s-]+', '-', s).strip('-')

def stage_color(delivery):
    d = (delivery or "").lower()
    if "now open" in d or "opening soon" in d: return "#1FDF67"
    if "under construction" in d:              return "#FF9500"
    if "breaking ground" in d:                 return "#FFD300"
    return "#999999"

def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "TMW-Digest/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="ignore")

def clean_wix_image_url(url):
    """Strip Wix's image transformation path so we get the original full-quality image.
    Example: ...mv2.jpg/v1/fit/w_1000,h_1000,al_c,q_80/file.png → ...mv2.jpg
    """
    if not url: return ""
    # Match Wix CDN transformation suffix
    m = re.match(r'(https?://static\.wixstatic\.com/media/[^/]+\.(jpg|jpeg|png|webp|gif))', url)
    if m: return m.group(1)
    return url

def load_pulse():
    if not os.path.exists(PULSE_PATH):
        print(f"[err] {PULSE_PATH} not found — run generate_pulse.py first", file=sys.stderr)
        return {"events": []}
    with open(PULSE_PATH) as f:
        return json.load(f)

def filter_recent(events, days=LOOKBACK_DAYS):
    if not events: return []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    for e in events:
        ts = e.get("timestamp") or e.get("date") or ""
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt >= cutoff:
                out.append(e)
        except (ValueError, AttributeError):
            out.append(e)
    return out

def group_events(events):
    map_items = []
    for e in events:
        etype = (e.get("type") or "").lower()
        proj = e.get("project") or {}
        title = proj.get("title") or e.get("title") or ""
        if not title: continue

        slug = slugify(title)
        ts = e.get("timestamp") or e.get("date") or ""
        base = {
            "title": title,
            "city":  proj.get("city") or e.get("city") or "",
            "image": proj.get("image") or proj.get("imageUrl") or e.get("image") or "",
            "url":   f"{SITE_URL}/projects/{slug}/",
            "_ts":   ts,
        }

        if "status" in etype or "change" in etype or "update" in etype:
            from_stage = e.get("from") or e.get("previousStage") or ""
            to_stage   = e.get("to")   or e.get("currentStage")  or proj.get("delivery") or ""
            map_items.append({
                **base,
                "from_stage": from_stage,
                "to_stage":   to_stage,
                "stage_color": stage_color(to_stage),
                "stage_label": to_stage,
            })
        else:
            delivery = proj.get("delivery") or e.get("delivery") or ""
            map_items.append({
                **base,
                "from_stage": "",
                "to_stage":   "",
                "stage_color": stage_color(delivery),
                "stage_label": delivery or "Announced",
            })
    map_items.sort(key=lambda x: x.get("_ts", ""), reverse=True)
    return map_items

def parse_articles_from_rss():
    """Parse all articles from RSS with categories and best-quality images."""
    import html  # for unescaping HTML entities like &#38; → &
    try:
        xml = fetch(RSS_URL)
        root = ET.fromstring(xml)
    except Exception as e:
        print(f"[warn] RSS unavailable: {e}", file=sys.stderr)
        return []

    out = []
    for it in root.findall(".//item"):
        title = (it.findtext("title") or "").strip()
        link  = (it.findtext("link")  or "").strip()
        desc  = (it.findtext("description") or "").strip()

        # Decode HTML entities (&#38; → &, &amp; → &, &quot; → ", etc.)
        title = html.unescape(title)
        desc  = html.unescape(desc)

        # Categories — list of all <category> tags
        categories = [c.text.strip() for c in it.findall("category") if c.text]

        # Image — prefer enclosure URL (cleaner), fall back to first <img> in description
        image = ""
        encl = it.find("enclosure")
        if encl is not None and encl.get("url"):
            image = clean_wix_image_url(encl.get("url"))
        if not image:
            img_match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', desc)
            if img_match:
                image = clean_wix_image_url(img_match.group(1))

        # Summary — strip HTML, trim to ~160 chars
        summary = re.sub(r"<[^>]+>", "", desc).strip()
        summary = re.sub(r"\s+", " ", summary)[:160]
        if summary and len(summary) == 160: summary += "…"

        out.append({
            "title": title,
            "link":  link,
            "image": image,
            "summary": summary,
            "categories": categories,
        })
    return out

def split_articles(articles):
    """Split articles into (florida, more_markets) lists.
    Florida = articles tagged 'Florida of Tomorrow'
    More Markets = articles NOT tagged 'Florida of Tomorrow'
    """
    florida, others = [], []
    for a in articles:
        if FLORIDA_CATEGORY in a.get("categories", []):
            florida.append(a)
        else:
            others.append(a)
    return florida[:FLORIDA_LIMIT], others[:MORE_MKTS_LIMIT]

def load_app_updates():
    if not os.path.exists(UPDATES_PATH): return None
    with open(UPDATES_PATH) as f:
        text = f.read().strip()
    if not text: return None
    headline, bullets = "", []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("# "):
            headline = line[2:].strip()
        elif line.startswith("- ") or line.startswith("* "):
            bullets.append(line[2:].strip())
    if not bullets: return None
    return {"headline": headline or "What's new in the app", "bullets": bullets}

def load_ads():
    slots = {f"slot{i}": None for i in range(1, 7)}
    if not os.path.exists(ADS_PATH):
        print(f"[info] no {ADS_PATH} found — running with no ads")
        return slots
    try:
        with open(ADS_PATH) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"[err] {ADS_PATH} is INVALID JSON: {e}", file=sys.stderr)
        return slots

    ads_data = data.get("ads", {})
    for slot_key in slots:
        ad = ads_data.get(slot_key)
        if ad and ad.get("image_url") and ad.get("click_url"):
            slots[slot_key] = {
                "image_url": ad["image_url"],
                "click_url": ad["click_url"],
                "alt_text":  ad.get("alt_text", "Sponsor"),
            }
            print(f"[info]   {slot_key}: {ad.get('alt_text', '?')}")
    filled = sum(1 for v in slots.values() if v)
    print(f"[info] {filled} ad slot(s) filled out of 6")
    return slots

def build_subject(map_items, florida_articles, more_markets_articles, app_updates):
    for m in map_items:
        to = (m.get("to_stage") or "").lower()
        if "now open" in to or "opening soon" in to:
            return f"{m['title']} is opening"
        if "under construction" in to and m.get("from_stage"):
            return f"{m['title']} broke ground"

    new_only = [m for m in map_items if not m.get("from_stage")]
    if len(new_only) >= 3:
        return f"{len(new_only)} new projects on the map"
    if new_only:
        first = new_only[0]
        if first.get("city"):
            return f"New: {first['title']} in {first['city']}"
        return f"New: {first['title']}"

    if app_updates and app_updates["bullets"]:
        first_bullet = app_updates["bullets"][0]
        if len(first_bullet) > 60:
            first_bullet = first_bullet[:57] + "…"
        return first_bullet

    if florida_articles:
        return florida_articles[0]["title"][:80]
    if more_markets_articles:
        return more_markets_articles[0]["title"][:80]

    return f"The Weekly · {datetime.now(timezone.utc).strftime('%B %d')}"

def build_preheader(map_items, florida_articles, more_markets_articles):
    bits = []
    total_articles = len(florida_articles) + len(more_markets_articles)
    if total_articles: bits.append(f"{total_articles} stories")
    if map_items:      bits.append(f"{len(map_items)} updates")
    if not bits:       return "This week on the map of tomorrow."
    return f"{', '.join(bits)} this week."

# ─── MAIN ────────────────────────────────────────────────────────────────────
def main():
    today      = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    week_label = datetime.now(timezone.utc).strftime("%B %d, %Y")

    print(f"[info] generating digest for {today}")

    pulse  = load_pulse()
    events = pulse.get("events", [])
    print(f"[info] pulse.json: {len(events)} total events")

    recent = filter_recent(events, LOOKBACK_DAYS)
    print(f"[info] {len(recent)} events in last {LOOKBACK_DAYS} days")

    map_items = group_events(recent)

    all_articles = parse_articles_from_rss()
    print(f"[info] RSS: {len(all_articles)} total articles")
    florida_articles, more_markets_articles = split_articles(all_articles)
    print(f"[info]   florida={len(florida_articles)} more_markets={len(more_markets_articles)}")

    app_updates = load_app_updates()
    ads         = load_ads()

    print(f"[info] map_items={len(map_items)} app_updates={'yes' if app_updates else 'no'}")

    if not (map_items or florida_articles or more_markets_articles or app_updates):
        print("[info] nothing to publish — skipping")
        return

    subject   = build_subject(map_items, florida_articles, more_markets_articles, app_updates)
    preheader = build_preheader(map_items, florida_articles, more_markets_articles)
    print(f"[info] subject: {subject}")

    env = Environment(
        loader=FileSystemLoader(os.path.dirname(TEMPLATE_PATH) or "."),
        autoescape=select_autoescape(["html", "xml"]),
    )
    template = env.get_template(os.path.basename(TEMPLATE_PATH))
    raw_html = template.render(
        subject=subject, preheader=preheader, week_label=week_label,
        map_items=map_items,
        florida_articles=florida_articles,
        more_markets_articles=more_markets_articles,
        app_updates=app_updates, ads=ads,
        site_url=SITE_URL, tmw_url=TMW_URL, logo_url=LOGO_URL,
        app_image_url=APP_IMAGE_URL,
    )

    inlined = Premailer(
        raw_html,
        keep_style_tags=True,
        remove_classes=False,
        strip_important=False,
    ).transform()

    os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
    os.makedirs(ARCHIVE_DIR, exist_ok=True)

    with open(OUT_HTML, "w") as f:    f.write(inlined)
    with open(OUT_SUBJECT, "w") as f: f.write(subject)
    with open(f"{ARCHIVE_DIR}/{today}.html", "w") as f: f.write(inlined)

    print(f"[ok] wrote {OUT_HTML}")
    print(f"[ok] wrote {OUT_SUBJECT}")
    print(f"[ok] archived to {ARCHIVE_DIR}/{today}.html")
    print("[done]")

if __name__ == "__main__":
    main()
