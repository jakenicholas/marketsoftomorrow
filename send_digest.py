#!/usr/bin/env python3
"""
send_digest.py — Creates Resend broadcast DRAFTS (one per audience) for human review.

Reads:
  - newsletter/digest-latest.html
  - newsletter/digest-subject.txt

Creates one draft per audience ID listed in RESEND_AUDIENCE_IDS (comma-separated).
Does NOT auto-send. You review each draft in Resend and hit Send manually.

Required env vars:
  - RESEND_API_KEY
  - RESEND_AUDIENCE_IDS  (comma-separated audience IDs, e.g. "aud_111,aud_222,aud_333")
  - RESEND_FROM          (e.g. "Markets of Tomorrow <media@marketsoftomorrow.com>")

Optional env vars:
  - RESEND_AUDIENCE_LABELS  (comma-separated labels matching audience IDs order,
                             e.g. "Readers,Map" — used as internal broadcast names
                             so you can tell drafts apart in the Resend dashboard)

Run: python3 send_digest.py
"""

import json, os, sys, urllib.request, urllib.error
from datetime import datetime, timezone

OUT_HTML    = "newsletter/digest-latest.html"
OUT_SUBJECT = "newsletter/digest-subject.txt"

API_KEY      = os.environ.get("RESEND_API_KEY", "").strip()
AUDIENCE_IDS = os.environ.get("RESEND_AUDIENCE_IDS", "").strip()
AUDIENCE_LABELS = os.environ.get("RESEND_AUDIENCE_LABELS", "").strip()
SENDER       = os.environ.get("RESEND_FROM", "").strip()

# Backward compatibility: support old single-ID secret name if present
if not AUDIENCE_IDS:
    AUDIENCE_IDS = os.environ.get("RESEND_AUDIENCE_ID", "").strip()

def fail(msg, code=1):
    print(f"[err] {msg}", file=sys.stderr)
    sys.exit(code)

def create_broadcast(api_key, audience_id, sender, subject, html, name=None):
    """Create a single Resend broadcast draft. Returns broadcast_id or None."""
    payload_dict = {
        "audience_id": audience_id,
        "from":        sender,
        "subject":     subject,
        "html":        html,
    }
    if name:
        payload_dict["name"] = name
    payload = json.dumps(payload_dict).encode("utf-8")

    req = urllib.request.Request(
        "https://api.resend.com/broadcasts",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type":  "application/json",
            "User-Agent":    "TMW-Newsletter/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
            return data.get("id")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        print(f"[err]   API {e.code}: {body}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[err]   request failed: {e}", file=sys.stderr)
        return None

def main():
    # Validate env
    missing = [k for k, v in {
        "RESEND_API_KEY":      API_KEY,
        "RESEND_AUDIENCE_IDS": AUDIENCE_IDS,
        "RESEND_FROM":         SENDER,
    }.items() if not v]
    if missing:
        fail(f"missing env vars: {', '.join(missing)}")

    # Validate inputs exist
    if not os.path.exists(OUT_HTML):
        fail(f"{OUT_HTML} not found — run generate_digest.py first")
    if not os.path.exists(OUT_SUBJECT):
        fail(f"{OUT_SUBJECT} not found — run generate_digest.py first")

    with open(OUT_HTML) as f:    html    = f.read()
    with open(OUT_SUBJECT) as f: subject = f.read().strip()

    if not html.strip(): fail(f"{OUT_HTML} is empty")
    if not subject:      fail(f"{OUT_SUBJECT} is empty")

    # Parse audience IDs (comma-separated, strip whitespace)
    audience_ids = [a.strip() for a in AUDIENCE_IDS.split(",") if a.strip()]
    if not audience_ids:
        fail("no audience IDs found in RESEND_AUDIENCE_IDS")

    # Parse labels — match positionally to audience IDs (e.g. "Readers,Map")
    labels = [l.strip() for l in AUDIENCE_LABELS.split(",") if l.strip()] if AUDIENCE_LABELS else []
    today_label = datetime.now(timezone.utc).strftime("%b %d")

    print(f"[info] subject:   {subject}")
    print(f"[info] html size: {len(html):,} chars")
    print(f"[info] from:      {SENDER}")
    print(f"[info] audiences: {len(audience_ids)} target(s)")
    print()

    successes, failures = 0, 0
    for i, audience_id in enumerate(audience_ids, 1):
        # Build internal label for this broadcast
        if i - 1 < len(labels):
            broadcast_name = f"{labels[i-1]} · {today_label}"
        else:
            broadcast_name = f"Audience {i} · {today_label}"

        print(f"[{i}/{len(audience_ids)}] {broadcast_name}")
        print(f"        audience: {audience_id}")
        broadcast_id = create_broadcast(API_KEY, audience_id, SENDER, subject, html, name=broadcast_name)
        if broadcast_id:
            print(f"        ✓ draft created: {broadcast_id}")
            print(f"        ✓ review at: https://resend.com/broadcasts/{broadcast_id}")
            successes += 1
        else:
            print(f"        ✗ failed")
            failures += 1
        print()

    print(f"[done] {successes} draft(s) created, {failures} failed")

    # Exit with error if any failed (so the workflow shows red)
    if failures > 0:
        sys.exit(1)

if __name__ == "__main__":
    main()
