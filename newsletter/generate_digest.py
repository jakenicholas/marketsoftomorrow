#!/usr/bin/env python3
"""
generate_digest.py — Renders the weekly newsletter HTML.

Reads:
  - pulse.json (output of generate_pulse.py — single source of truth for events)
  - newsletter/app_updates.md (manual log of what shipped this week)
  - newsletter/ads.json (banner ads to insert into 6 slots)

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
LOGO_URL      = "https://static.wixstatic.com/media/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png"

LOOKBACK_DAYS = 7

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
    new_projects, status_changes = [], []
    for e in events:
        etype = (e.get("type") or "").lower()
        proj = e.get("project") or {}
        title = proj.get("title") or e.get("title") or ""
        if not title: continue

        slug = slugify(title)
        base = {
            "title": title,
            "city":  proj.get("city") or e.get("city") or "",
            "image": proj.get("image") or proj.get("imageUrl") or e.get("image") or "",
            "url":   f"{SITE_URL}/projects/{slug}/",
        }

        if "new" in etype or "added" in etype or "announced" in etype:
            delivery = proj.get("delivery") or e.get("delivery") or ""
            new_projects.append({
                **base,
                "stage_color": stage_color(delivery),
                "stage_label": delivery or "Announced",
            })
        elif "status" in etype or "change" in etype or "update" in etype:
            from_stage = e.get("from") or e.get("previousStage") or ""
            to_stage   = e.get("to")   or e.get("currentStage")  or proj.get("delivery") or ""
            status_changes.append({
                **base,
                "from_stage": from_stage,
                "to_stage":   to_stage,
                "stage_color": stage_color(to_stage),
            })
    return new_projects, status_changes

def load_articles(limit=3):
    try:
        xml = fetch(RSS_URL)
        root = ET.fromstring(xml)
    except Exception as e:
        print(f"[warn] RSS unavailable: {e}", file=sys.stderr)
        return []
    out = []
    for it in root.findall(".//item")[:limit]:
        title = (it.findtext("title") or "").strip()
        link  = (it.findtext("link")  or "").strip()
        desc  = (it.findtext("description") or "").strip()
        img_match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', desc)
        image = img_match.group(1) if img_match else ""
        summary = re.sub(r"<[^>]+>", "", desc).strip()
        summary = re.sub(r"\s+", " ", summary)[:160]
        if summary and len(summary) == 160: summary += "…"
        out.append({"title": title, "link": link, "image": image, "summary": summary})
    return out

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
    """Load ads.json. Returns dict with slot1-slot6 keys (None for empty slots)."""
    slots = {f"slot{i}": None for i in range(1, 7)}
    if not os.path.exists(ADS_PATH):
        print(f"[info] no {ADS_PATH} — running with no ads")
        return slots
    try:
        with open(ADS_PATH) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"[warn] {ADS_PATH} is invalid JSON: {e} — running with no ads", file=sys.stderr)
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
    filled = sum(1 for v in slots.values() if v)
    print(f"[info] {filled} ad slot(s) filled")
    return slots

def build_subject(new_projects, status_changes, articles, app_updates):
    for c in status_changes:
        to = (c.get("to_stage") or "").lower()
        if "now open" in to or "opening soon" in to:
            return f"{c['title']} is opening"
        if "under construction" in to:
            return f"{c['title']} broke ground"
    if len(new_projects) >= 3:
        return f"{len(new_projects)} new projects on the map"
    if new_projects:
        first = new_projects[0]
        if first.get("city"):
            return f"New: {first['title']} in {first['city']}"
        return f"New: {first['title']}"
    if app_updates and app_updates["bullets"]:
        first_bullet = app_updates["bullets"][0]
        if len(first_bullet) > 60:
            first_bullet = first_bullet[:57] + "…"
        return first_bullet
    if articles:
        return articles[0]["title"][:80]
    return f"The Weekly · {datetime.now(timezone.utc).strftime('%B %d')}"

def build_preheader(new_projects, status_changes, articles):
    bits = []
    if articles:        bits.append(f"{len(articles)} stories")
    if new_projects:    bits.append(f"{len(new_projects)} new")
    if status_changes:  bits.append(f"{len(status_changes)} updates")
    if not bits:        return "This week on the map of tomorrow."
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

    new_projects, status_changes = group_events(recent)
    articles    = load_articles(limit=3)
    app_updates = load_app_updates()
    ads         = load_ads()

    print(f"[info] new={len(new_projects)} status={len(status_changes)} articles={len(articles)} app_updates={'yes' if app_updates else 'no'}")

    if not (new_projects or status_changes or articles or app_updates):
        print("[info] nothing to publish — skipping")
        return

    subject   = build_subject(new_projects, status_changes, articles, app_updates)
    preheader = build_preheader(new_projects, status_changes, articles)
    print(f"[info] subject: {subject}")

    env = Environment(
        loader=FileSystemLoader(os.path.dirname(TEMPLATE_PATH) or "."),
        autoescape=select_autoescape(["html", "xml"]),
    )
    template = env.get_template(os.path.basename(TEMPLATE_PATH))
    raw_html = template.render(
        subject=subject, preheader=preheader, week_label=week_label,
        new_projects=new_projects, status_changes=status_changes,
        articles=articles, app_updates=app_updates, ads=ads,
        site_url=SITE_URL, tmw_url=TMW_URL, logo_url=LOGO_URL,
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
