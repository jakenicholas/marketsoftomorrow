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

import json, os, re, sys, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

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

# Journal posts now come from our own Worker API (the old Wix blog-feed.xml is
# dead after the migration off Wix). Articles live at www.oftmw.com/post/<slug>/.
POSTS_API     = "https://tmw.jake-ab7.workers.dev/posts?limit=50&status=published"
SITE_URL      = "https://map.oftmw.com"
TMW_URL       = "https://www.oftmw.com"
LOGO_URL      = "https://static.wixstatic.com/media/ca3b83_e80e88810ca942459bfaa140e9fc2267~mv2.png"
# Fallback only — the real image is set per-issue via an `image:` line in
# app_updates.md. Served from R2 (not the Worker) to avoid its request limit
# on a mass send.
APP_IMAGE_URL = "https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/2026/06/c67f4529eec9-map-of-tomorrow-june-9.gif"

LOOKBACK_DAYS    = 7
MIN_MAP_ITEMS    = 8   # Keep the "New on the map" grid full (4+4) so banner ads
                       # don't stack; backfill older events on quiet weeks.
FLORIDA_LIMIT    = 5   # Articles in Florida section
MORE_MKTS_LIMIT  = 3   # Articles in More Markets section
# Legacy single-tag check, kept as one of several signals below.
FLORIDA_CATEGORY = "Florida of Tomorrow"
# main_category values that identify a Florida region. Newer articles
# carry a region name here (e.g. "The Palm Beaches", "Broward") and
# DON'T necessarily tag the "Florida of Tomorrow" brand category in
# their categories array, so the old single-tag check missed them and
# dumped Florida news into "More Markets". Match on these too.
FLORIDA_REGION_MAINS = {
    "Florida", "Florida of Tomorrow",
    "The Palm Beaches", "Palm Beach", "Palm Beaches",
    "Broward", "Fort Lauderdale", "Greater Fort Lauderdale",
    "Miami", "Miami-Dade", "Miami Dade",
    "Tampa", "Tampa Bay",
    "Orlando", "Central Florida",
    "Jacksonville", "Northeast Florida",
    "Naples", "Sarasota", "Southwest Florida",
    "Treasure Coast", "Space Coast", "Florida Keys",
    "St. Petersburg", "Saint Petersburg",
}

# ─── HELPERS ─────────────────────────────────────────────────────────────────
def slugify(title):
    s = (title or "").lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    return re.sub(r'[\s-]+', '-', s).strip('-')

def clean_event_title(title):
    """Remove event-action suffixes from a project title.
    Used both for display and for slug generation."""
    if not title: return ""
    s = title.strip()
    # Common suffixes that get appended in pulse events
    suffixes_lower = [
        " added to the map",
        " was added to the map",
        " has been added to the map",
        " is now open",
        " now open",
        " update",
        " status changed",
        " stage changed",
    ]
    s_lower = s.lower()
    for suffix in suffixes_lower:
        if s_lower.endswith(suffix):
            s = s[:-len(suffix)]
            break
    return s.strip()

def map_slug(title):
    """Slug used in map URLs — alphanumeric only, no hyphens or spaces."""
    s = (title or "").lower()
    return re.sub(r'[^a-z0-9]', '', s)

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

def cap_tracking_subtitle(s, budget=30):
    """Keep the grouped-tracking tile's name list on ONE line in the email card:
    fit names within ~budget chars, then a recomputed "+N more" tail. Robust to
    the pre-joined 'A, B, C +13 more' string already stored in pulse.json, so a
    long batch can't stretch the fixed-height card out of the two-column grid."""
    if not s:
        return s
    s = s.strip()
    m = re.search(r'\s*\+\s*(\d+)\s+more\s*$', s)
    extra = int(m.group(1)) if m else 0
    names_part = (s[:m.start()] if m else s).rstrip().rstrip(',')
    names = [n.strip() for n in names_part.split(',') if n.strip()]
    shown, used = [], 0
    for nm in names:
        add = len(nm) + (2 if shown else 0)   # +2 for the ", " separator
        if shown and used + add > budget:
            break
        shown.append(nm); used += add
    total_more = extra + (len(names) - len(shown))
    out = ', '.join(shown)
    if total_more:
        out += f" +{total_more} more"
    return out

def group_events(events):
    """Build map_items list from pulse.json events.
    Pulse events use these fields (with fallbacks for older data):
      - project_title  → clean name without event suffix
      - project_slug   → URL-safe slug
      - link           → full pre-built URL to the project on the map
      - city, image, timestamp
    """
    map_items = []
    track_acc = None   # all grouped "newly tracking" events merge into ONE compiled tile
    for e in events:
        etype = (e.get("type") or "").lower()

        # Skip article events (those come from RSS separately)
        if etype == "article":
            continue

        # Prefer the clean project_title; fall back to cleaning the event title
        title = e.get("project_title") or clean_event_title(e.get("title") or "")
        if not title:
            # Fallback for very old data with project sub-object
            proj = e.get("project") or {}
            title = clean_event_title(proj.get("title") or "")
        if not title:
            continue

        # Prefer the pre-built link from pulse.json; fall back to building one
        url = e.get("link")
        if url:
            # Add fullscreen=true if not already in URL (for fullscreen project view)
            if "fullscreen=" not in url:
                separator = "&" if "?" in url else "?"
                url = f"{url}{separator}fullscreen=true"
        else:
            mslug = map_slug(title)
            url = f"{SITE_URL}/?fullscreen=true&project={mslug}"

        # City: top-level field first, then project sub-object
        proj = e.get("project") or {}
        city = e.get("city") or proj.get("city") or ""

        # Image: top-level first, then project sub-object
        image = e.get("image") or proj.get("image") or proj.get("imageUrl") or ""
        # Strip Wix transformation suffixes
        image = clean_wix_image_url(image)

        ts = e.get("timestamp") or e.get("date") or ""

        # Merge ALL grouped "newly tracking" events into ONE compiled tile — a
        # batch per pulse run otherwise shows as several near-identical
        # "Tracking N more projects" cards. Accumulate the total count + a few
        # example names + the first image; the single tile is built after the loop.
        psl = (e.get("project_slug") or proj.get("slug") or "").strip().lower()
        if etype == "tracking" and not psl:
            cnt_m  = re.search(r'(\d+)', title or "")
            csub   = (city or "").strip()
            tail_m = re.search(r'\s*\+\s*\d+\s+more\s*$', csub)
            names_part = (csub[:tail_m.start()] if tail_m else csub).rstrip().rstrip(",")
            names = [n.strip() for n in names_part.split(",") if n.strip()]
            if track_acc is None:
                track_acc = {"count": 0, "names": [], "image": "", "url": url, "ts": ts}
            track_acc["count"] += int(cnt_m.group(1)) if cnt_m else 0
            track_acc["names"].extend(names)
            if not track_acc["image"] and image:
                track_acc["image"] = image
            if ts > track_acc["ts"]:
                track_acc["ts"] = ts
            continue

        # Normalize the grouped "newly tracking" tile. The source generator now
        # emits "Tracking N more projects" + a one-line name list, but older
        # events already sitting in pulse.json still carry the old "Now tracking
        # N new projects" copy and a long, card-breaking subtitle — fix them here
        # so any digest built from existing data renders correctly.
        if etype == "tracking":
            mt = re.match(r'(?i)^now tracking (\d+) new projects$', (title or "").strip())
            if mt:
                title = f"Tracking {mt.group(1)} more projects"
            city = cap_tracking_subtitle(city)

        # Dedup identity: collapse multiple events for the SAME project down to
        # just the most recent (map_items is sorted newest-first below, so the
        # first one we keep wins). Grouped "newly tracking" tiles cover many
        # projects at once and have no single slug → never deduped.
        psl = (e.get("project_slug") or proj.get("slug") or "").strip().lower()
        dedup_key = None if (etype == "tracking" and not psl) else (psl or (title or "").strip().lower())

        base = {
            "title": title,
            "city":  city,
            "image": image,
            "url":   url,
            "_ts":   ts,
            "_key":  dedup_key,
        }

        if "status" in etype or "change" in etype or "update" in etype:
            from_stage = e.get("from") or e.get("previousStage") or ""
            to_stage   = e.get("to")   or e.get("currentStage")  or proj.get("delivery") or e.get("tag") or ""
            map_items.append({
                **base,
                "from_stage": from_stage,
                "to_stage":   to_stage,
                "stage_color": stage_color(to_stage),
                "stage_label": to_stage,
            })
        else:
            delivery = proj.get("delivery") or e.get("delivery") or e.get("tag") or ""
            map_items.append({
                **base,
                "from_stage": "",
                "to_stage":   "",
                "stage_color": stage_color(delivery),
                "stage_label": delivery or "Announced",
            })
    # Build the single compiled "Tracking N more projects" tile from the batch.
    if track_acc and track_acc["count"] > 0:
        total = track_acc["count"]
        shown, used = [], 0
        for nm in track_acc["names"]:
            add = len(nm) + (2 if shown else 0)
            if shown and used + add > 30:
                break
            shown.append(nm); used += add
        remaining = total - len(shown)
        sub = ", ".join(shown) + (f" +{remaining} more" if remaining > 0 else "")
        map_items.append({
            "title": f"Tracking {total} more projects",
            "city":  sub,
            "image": track_acc["image"],
            "url":   track_acc["url"],
            "_ts":   track_acc["ts"],
            "_key":  None,
            "from_stage": "", "to_stage": "",
            "stage_color": stage_color("Tracking"),
            "stage_label": "Tracking",
        })

    map_items.sort(key=lambda x: x.get("_ts", ""), reverse=True)
    # Keep only the most recent event per project (don't show the same project
    # twice). Tiles with _key=None (grouped tracking) are always kept.
    deduped, seen = [], set()
    for it in map_items:
        k = it.get("_key")
        if k is not None:
            if k in seen:
                continue
            seen.add(k)
        deduped.append(it)
    return deduped

def parse_articles_from_api():
    """Fetch the latest published journal posts from the Worker API.
    The API returns items newest-first with categories and full-quality cover
    images already hosted on our own CDN, so no Wix URL cleanup is needed.
    """
    try:
        data = json.loads(fetch(POSTS_API))
    except Exception as e:
        print(f"[warn] posts API unavailable: {e}", file=sys.stderr)
        return []

    out = []
    for it in data.get("items", []):
        title = (it.get("title") or "").strip()
        slug  = (it.get("slug")  or "").strip()
        if not title or not slug:
            continue

        # Canonical journal URL (mirrors the old Wix /post/<slug>/ paths).
        link = f"{TMW_URL}/post/{slug}/"

        image = it.get("cover_image") or ""

        # Summary — collapse whitespace, trim to ~160 chars.
        summary = re.sub(r"\s+", " ", (it.get("excerpt") or "").strip())[:160]
        if summary and len(summary) == 160: summary += "…"

        out.append({
            "title": title,
            "link":  link,
            "image": image,
            "summary": summary,
            "categories":   it.get("categories") or [],
            "main_category": (it.get("main_category") or "").strip(),
            "published_at": it.get("published_at") or 0,   # unix epoch (seconds)
        })
    return out

def is_florida_article(a):
    """A Florida article is one whose main_category names a Florida
    region (Palm Beaches, Broward, Tampa Bay, ...) OR any tag in its
    categories list contains the word 'florida' (case-insensitive) OR
    it carries the legacy 'Florida of Tomorrow' brand tag.

    Previously we only checked the legacy brand tag, so newer Florida
    coverage tagged ['Broward', 'Florida'] (no brand tag) silently
    fell into the More Markets bucket. This is the fix for that.
    """
    if a.get("main_category") in FLORIDA_REGION_MAINS:
        return True
    cats = a.get("categories") or []
    for c in cats:
        cl = (c or "").strip().lower()
        if cl == "florida of tomorrow":
            return True
        if "florida" in cl:
            return True
    return False

def split_articles(articles):
    """Split articles into (florida, more_markets) lists."""
    florida, others = [], []
    for a in articles:
        (florida if is_florida_article(a) else others).append(a)
    return florida[:FLORIDA_LIMIT], others[:MORE_MKTS_LIMIT]

def load_app_updates():
    if not os.path.exists(UPDATES_PATH): return None
    with open(UPDATES_PATH) as f:
        text = f.read().strip()
    if not text: return None
    headline, image, bullets = "", "", []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("# "):
            headline = line[2:].strip()
        elif line.lower().startswith("image:"):           # image: <url>
            image = line.split(":", 1)[1].strip()
        elif line.startswith("!["):                        # markdown ![alt](url)
            m = re.search(r'\((https?://[^)]+)\)', line)
            if m: image = m.group(1)
        elif line and line[0] in "-*•–—":  # accept dash, asterisk, bullet, en/em dash
            bullets.append(line[1:].strip())
    if not bullets: return None
    # Pre-split each bullet on the FIRST em-dash, en-dash, or " - " hyphen
    # into (title, body). This lets the template render each bullet as a
    # purple tile with a bold "feature name" header on top of the
    # supporting copy, instead of a flat white text bullet. Authors don't
    # have to change app_updates.md -- both "X — Y" and "X - Y" work.
    tiles = []
    for b in bullets:
        title, body = b, ""
        for sep in (" — ", " – ", " - "):
            if sep in b:
                parts = b.split(sep, 1)
                title, body = parts[0].strip(), parts[1].strip()
                break
        # Capitalize the body's first letter so descriptions read like
        # proper sentences ("Faster, timeline scrubber..." not "faster,
        # timeline scrubber..."). Only flips alphabetic lowercase — leaves
        # "iPhone"-style intentional lowercase first letters alone (those
        # don't appear in our copy today, but the guard is cheap).
        if body and body[0].islower():
            body = body[0].upper() + body[1:]
        tiles.append({"title": title, "body": body})
    # Image + bullets both come from this one file so a generate always uses the
    # latest of both; fall back to the module default if no image line is given.
    return {"headline": headline or "What's new in the app",
            "image":    image or APP_IMAGE_URL,
            "bullets":  bullets,
            "tiles":    tiles}

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

    # Slots may live under an "ads" wrapper or at the top level (the format
    # this file is hand-edited in each week). Support both.
    ads_data = data.get("ads") or data
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

def _join_clauses(items):
    """Oxford-comma join: ['a'] -> 'a'; ['a','b'] -> 'a and b';
    ['a','b','c'] -> 'a, b, and c'."""
    items = [i for i in items if i]
    if not items:      return ""
    if len(items) == 1: return items[0]
    if len(items) == 2: return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + ", and " + items[-1]

INTEL_BRIEF_STATUS = "unknown"   # which path the top brief took; embedded as an HTML comment for debugging

def _brief_status(msg, warn=False):
    global INTEL_BRIEF_STATUS
    INTEL_BRIEF_STATUS = msg
    print(("[warn] " if warn else "[info] ") + "intel brief: " + msg, file=sys.stderr)


def llm_intel_brief(map_items, weekly_articles, app_updates):
    """Use Claude to write the 'TMW Intelligence' brief from the week's ACTUAL
    articles + database updates — a concrete 2-sentence summary, not a stat line.
    Returns the brief text, or None to fall back to the heuristic below (no
    ANTHROPIC_API_KEY, SDK missing, or any API error) so a digest build never
    breaks on the LLM call."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        _brief_status("heuristic (ANTHROPIC_API_KEY not set in this job's env)")
        return None
    try:
        import anthropic
    except ImportError:
        _brief_status("heuristic (anthropic SDK not installed)")
        return None

    arts = []
    for a in weekly_articles[:12]:
        t = (a.get("title") or "").strip()
        s = (a.get("summary") or "").strip()
        if t:
            arts.append(f"- {t}" + (f" — {s}" if s else ""))
    ups = []
    for m in map_items[:24]:
        t = (m.get("title") or "").strip()
        if not t:
            continue
        stage = (m.get("to_stage") or m.get("stage_label") or "").strip()
        city  = (m.get("city") or "").strip()
        meta  = " · ".join(x for x in (stage, city) if x)
        ups.append(f"- {t}" + (f" ({meta})" if meta else ""))
    context = ("ARTICLES PUBLISHED THIS WEEK:\n" + ("\n".join(arts) or "(none)") +
               "\n\nDATABASE / MAP UPDATES THIS WEEK:\n" + ("\n".join(ups) or "(none)"))

    system = (
        "You write the short 'TMW Intelligence' brief at the top of the Markets "
        "of Tomorrow newsletter. Markets of Tomorrow tracks luxury and hype real-"
        "estate developments worldwide (towers, hotels, resorts, golf, mixed-use "
        "districts, museums, airports). From the week's journal articles and "
        "database/map updates below, write a concrete brief of AT MOST 2 sentences "
        "(~45 words) that says what actually moved this week: lead with the single "
        "most newsworthy item (an opening, a groundbreaking, a major project), name "
        "specific projects, and note where activity concentrated. Editorial and "
        "confident; specific over generic. No hype filler, no 'this week's brief "
        "covers', no emojis, no exclamation marks. Use ONLY facts present below. "
        "Respond with ONLY the brief itself — no preamble, no quotation marks, no "
        "labels, no reasoning."
    )

    try:
        # max_retries rides out transient 429/5xx/529 with the SDK's exponential
        # backoff before giving up on a model.
        client = anthropic.Anthropic(api_key=api_key, max_retries=6)
    except Exception as e:
        _brief_status(f"heuristic (client init failed: {type(e).__name__}: {e})", warn=True)
        return None

    # Opus first for the best brief; fall back to lighter models when Opus is
    # overloaded (529 is capacity/model-specific — Sonnet/Haiku are usually less
    # loaded). This is an availability fallback for an unattended nightly job, not
    # a default downgrade — Opus stays the primary choice.
    last_err = None
    for model in ("claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"):
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=400,
                system=system,
                messages=[{"role": "user", "content": context}],
            )
            brief = "".join(
                b.text for b in resp.content if getattr(b, "type", "") == "text"
            ).strip().strip('"').strip()
            if brief:
                _brief_status(f"AI-generated ({model}, {len(brief)} chars)")
                return brief
            last_err = "empty response"
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            print(f"[warn] intel brief: {model} failed ({last_err}); trying next model", file=sys.stderr)

    _brief_status(f"heuristic (all models failed; last: {last_err})", warn=True)
    return None


def build_intel_summary(map_items, weekly_articles, app_updates):
    """Build the 'TMW Intelligence' brief that summarizes the whole issue.

    The body prefers an LLM brief (llm_intel_brief, Claude Opus) that actually
    reads the week's articles + updates; it falls back to the data-assembled
    heuristic below when ANTHROPIC_API_KEY isn't set or the call fails, so CI
    never breaks. The stats row (Stories/Updates/Markets) is always data-derived.

    - story_count is the TRUE number of journal posts published in the lookback
      window (not the 8 we trim down to as cards in the email).
    - the body summarizes ALL of the week's stories by where they landed
      (their regions), not just the single lead headline.
    - the middle stat counts database "updates" (map item events).
    Returns {body, stats} or None when there's nothing to summarize.
    """
    story_count = len(weekly_articles)
    new_updates = len(map_items)

    # Distinct markets, in first-seen order, from the database updates.
    cities, seen = [], set()
    for m in map_items:
        c = (m.get("city") or "").strip()
        if c and c.lower() not in seen:
            seen.add(c.lower()); cities.append(c)
    market_count = len(cities)

    def pl(n, s, p): return s if n == 1 else p

    # Summarize the whole set of stories by region (main_category), ranked by
    # how many stories landed there. This represents every article, not just
    # the top one, while staying compact.
    region_counts = {}
    region_order  = []
    for a in weekly_articles:
        r = (a.get("main_category") or "").strip()
        if not r:
            continue
        if r not in region_counts:
            region_counts[r] = 0
            region_order.append(r)
        region_counts[r] += 1
    ranked = sorted(region_order, key=lambda r: (-region_counts[r], region_order.index(r)))

    region_phrase = ""
    if ranked:
        top  = ranked[:4]
        rest = len(ranked) - len(top)
        if rest > 0:
            region_phrase = ", ".join(top) + f", and {rest} more {pl(rest, 'market', 'markets')}"
        else:
            region_phrase = _join_clauses(top)

    clauses = []
    if story_count:
        if region_phrase:
            clauses.append(f"{story_count} new {pl(story_count, 'story', 'stories')} across {region_phrase}")
        else:
            clauses.append(f"{story_count} new {pl(story_count, 'story', 'stories')} from the journal")
    if new_updates:
        clauses.append(f"{new_updates} new database {pl(new_updates, 'update', 'updates')}")

    # The stories clause already contains its own "and" (the region list), so
    # join the two top-level clauses with "alongside" rather than another "and".
    if len(clauses) == 2:
        core = f"{clauses[0]}, alongside {clauses[1]}"
    elif clauses:
        core = clauses[0]
    else:
        core = ""

    if core:
        body = "This week's brief covers " + core + "."
    else:
        body = "Here's what's moving across the map of tomorrow this week."
    if app_updates:
        body += " Plus the latest from TMW Pro."

    # Prefer a real LLM summary of the week's actual stories + updates; the
    # heuristic body above is the fallback when the API key/SDK/call isn't there.
    llm = llm_intel_brief(map_items, weekly_articles, app_updates)
    if llm:
        body = llm

    if not (story_count or new_updates):
        return None

    stats = [
        {"value": str(story_count),  "label": pl(story_count, "Story", "Stories")},
        {"value": str(new_updates),  "label": "Updates"},
        {"value": str(market_count), "label": pl(market_count, "Market", "Markets")},
    ]
    return {"body": body, "stats": stats}

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

    # On a quiet week the strict lookback can leave too few tiles, which breaks
    # the grid layout (banner ads end up stacked). Backfill with the most-recent
    # map events so the section always shows a full grid.
    if len(map_items) < MIN_MAP_ITEMS:
        map_items = group_events(events)[:MIN_MAP_ITEMS]
        print(f"[info] only {len(group_events(recent))} map events in window — backfilled to {len(map_items)}")

    all_articles = parse_articles_from_api()
    print(f"[info] posts API: {len(all_articles)} total articles")
    florida_articles, more_markets_articles = split_articles(all_articles)
    print(f"[info]   florida={len(florida_articles)} more_markets={len(more_markets_articles)}")

    # True count of journal stories published in the lookback window — used for
    # the intel brief's "Stories" stat (independent of the 8 we render as cards).
    week_cutoff_ts = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).timestamp()
    weekly_articles = [a for a in all_articles if (a.get("published_at") or 0) >= week_cutoff_ts]
    print(f"[info]   weekly_articles (last {LOOKBACK_DAYS}d) = {len(weekly_articles)}")

    app_updates = load_app_updates()
    ads         = load_ads()

    print(f"[info] map_items={len(map_items)} app_updates={'yes' if app_updates else 'no'}")

    if not (map_items or florida_articles or more_markets_articles or app_updates):
        print("[info] nothing to publish — skipping")
        return

    subject   = build_subject(map_items, florida_articles, more_markets_articles, app_updates)
    preheader = build_preheader(map_items, florida_articles, more_markets_articles)
    intel     = build_intel_summary(map_items, weekly_articles, app_updates)
    # og:description, twitter:description, and the hidden inbox preheader all use
    # {{ preheader }} — make them the AI 'TMW Intelligence' brief when we have one.
    if intel and intel.get("body"):
        preheader = intel["body"]
    print(f"[info] subject: {subject}")
    print(f"[info] intel summary: {'yes' if intel else 'no'}")

    env = Environment(
        loader=FileSystemLoader(os.path.dirname(TEMPLATE_PATH) or "."),
        autoescape=select_autoescape(["html", "xml"]),
    )
    # Cache-bust the What's-new gif so R2 / CDN edges don't serve a stale
    # copy if the file behind the same URL was just replaced. The user's
    # June 9 issue showed the previous week's gif because the URL hadn't
    # changed but the bytes had -- email clients and the R2 CDN both
    # cached aggressively. A unique ?v= per generate forces a fresh fetch.
    base_image = (app_updates or {}).get("image") or APP_IMAGE_URL
    if base_image:
        sep = '&' if '?' in base_image else '?'
        cache_bust_image = f"{base_image}{sep}v={int(time.time())}"
    else:
        cache_bust_image = base_image

    template = env.get_template(os.path.basename(TEMPLATE_PATH))

    def render_inlined(archive):
        raw = template.render(
            subject=subject, preheader=preheader, week_label=week_label,
            map_items=map_items,
            florida_articles=florida_articles,
            more_markets_articles=more_markets_articles,
            intel=intel,
            app_updates=app_updates, ads=ads,
            site_url=SITE_URL, tmw_url=TMW_URL, logo_url=LOGO_URL,
            app_image_url=cache_bust_image,
            archive=archive,
        )
        return Premailer(raw, keep_style_tags=True, remove_classes=False, strip_important=False).transform()

    # Two builds from the same content:
    #  • EMAIL (archive=False) — what we upload/send via Resend; keeps the dark-
    #    mode media query so it adapts in readers' inboxes.
    #  • ARCHIVE (archive=True) — the web copy we send clients; pinned to the
    #    polished LIGHT/branded design so it looks identical on every device
    #    (the partial dark-mode flip rendered broken in a browser).
    email_html   = render_inlined(archive=False)
    archive_html = render_inlined(archive=True)

    os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
    os.makedirs(ARCHIVE_DIR, exist_ok=True)

    # Debug breadcrumb (committed, so it can be read without CI logs): which path
    # the 'TMW Intelligence' brief took this run. Harmless HTML comment.
    email_html += f"\n<!-- TMW intel-brief: {INTEL_BRIEF_STATUS} -->\n"

    with open(OUT_HTML, "w") as f:    f.write(email_html)
    with open(OUT_SUBJECT, "w") as f: f.write(subject)
    with open(f"{ARCHIVE_DIR}/{today}.html", "w") as f: f.write(archive_html)

    print(f"[ok] wrote {OUT_HTML} (email — dark-mode aware)")
    print(f"[ok] wrote {OUT_SUBJECT}")
    print(f"[ok] archived to {ARCHIVE_DIR}/{today}.html (client copy — always light)")
    print("[done]")

if __name__ == "__main__":
    main()
