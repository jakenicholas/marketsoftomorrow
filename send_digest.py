#!/usr/bin/env python3
"""
send_digest.py — Creates a Resend broadcast draft from the rendered newsletter.

Reads:
  - newsletter/digest-latest.html       (the rendered HTML)
  - newsletter/digest-subject.txt       (auto-generated subject from generate_digest.py)

Sends to:
  - The audience specified by RESEND_AUDIENCE_ID env var (Readers Subscribers)

Subject format:
  "May 12 - {auto-generated subject}"
  Date is the current Tuesday in "Month Day" format.

Env vars (set in GitHub Actions secrets):
  - RESEND_API_KEY       Your Resend API key
  - RESEND_AUDIENCE_ID   The audience UUID to send to (Readers Subscribers)
  - RESEND_FROM          Sender, e.g. "Markets of Tomorrow <media@marketsoftomorrow.com>"
"""

import os, sys, time
from datetime import datetime, timezone
from pathlib import Path

import requests

# ─── CONFIG ──────────────────────────────────────────────────────────────────
API_KEY     = os.environ.get("RESEND_API_KEY", "").strip()
AUDIENCE_ID = os.environ.get("RESEND_AUDIENCE_ID", "").strip()
FROM_ADDR   = os.environ.get("RESEND_FROM", "Markets of Tomorrow <media@marketsoftomorrow.com>").strip()

HTML_PATH    = "newsletter/digest-latest.html"
SUBJECT_PATH = "newsletter/digest-subject.txt"

BASE_URL = "https://api.resend.com"

# ─── HELPERS ─────────────────────────────────────────────────────────────────
def fail(msg):
    print(f"\n[err] {msg}", file=sys.stderr)
    sys.exit(1)

def date_prefix():
    """Return 'Month Day' (e.g. 'May 12') for today in UTC."""
    return datetime.now(timezone.utc).strftime("%B %-d")  # %-d strips leading zero

def headers():
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type":  "application/json",
        "User-Agent":    "TMW-Digest-Sender/2.0",
    }

# ─── MAIN ────────────────────────────────────────────────────────────────────
def main():
    # ── 1. Validate env ──────────────────────────────────────────────────────
    if not API_KEY:     fail("RESEND_API_KEY env var is not set")
    if not AUDIENCE_ID: fail("RESEND_AUDIENCE_ID env var is not set")

    # If the audience ID accidentally has a comma (from old multi-audience setup),
    # take only the first ID
    if "," in AUDIENCE_ID:
        AUDIENCE_ID_CLEAN = AUDIENCE_ID.split(",")[0].strip()
        print(f"[info] RESEND_AUDIENCE_ID had multiple values, using first: {AUDIENCE_ID_CLEAN}")
    else:
        AUDIENCE_ID_CLEAN = AUDIENCE_ID

    # ── 2. Read inputs ───────────────────────────────────────────────────────
    if not Path(HTML_PATH).exists():
        fail(f"{HTML_PATH} not found — run generate_digest.py first")
    if not Path(SUBJECT_PATH).exists():
        fail(f"{SUBJECT_PATH} not found — run generate_digest.py first")

    html        = Path(HTML_PATH).read_text(encoding="utf-8")
    base_subject = Path(SUBJECT_PATH).read_text(encoding="utf-8").strip()

    if not html:          fail(f"{HTML_PATH} is empty")
    if not base_subject:  fail(f"{SUBJECT_PATH} is empty")

    # ── 3. Build final subject with date prefix ──────────────────────────────
    final_subject = f"{date_prefix()} - {base_subject}"

    print(f"[info] subject: {final_subject}")
    print(f"[info] html length: {len(html):,} chars")
    print(f"[info] audience id: {AUDIENCE_ID_CLEAN}")
    print(f"[info] from: {FROM_ADDR}")
    print()

    # ── 4. Create broadcast draft ────────────────────────────────────────────
    payload = {
        "audience_id": AUDIENCE_ID_CLEAN,
        "from":        FROM_ADDR,
        "subject":     final_subject,
        "html":        html,
    }

    print(f"[create] POST /broadcasts ...")
    r = requests.post(f"{BASE_URL}/broadcasts", headers=headers(), json=payload, timeout=60)

    if not r.ok:
        print(f"[err] HTTP {r.status_code}: {r.text[:500]}", file=sys.stderr)
        sys.exit(1)

    data = r.json()
    broadcast_id = data.get("id", "?")
    print(f"[ok] broadcast draft created: {broadcast_id}")
    print()
    print(f"[done] Review and send at: https://resend.com/broadcasts/{broadcast_id}")

if __name__ == "__main__":
    main()
