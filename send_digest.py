#!/usr/bin/env python3
"""
send_digest.py — Creates a Resend broadcast DRAFT for human review.

Reads:
  - newsletter/digest-latest.html  (rendered by generate_digest.py)
  - newsletter/digest-subject.txt  (subject line)

Does NOT auto-send. Creates a draft in Resend and emails the operator.
You review in Resend dashboard, edit if needed, hit send manually.

Required env vars:
  - RESEND_API_KEY
  - RESEND_AUDIENCE_ID  (the audience to send to)
  - RESEND_FROM         (e.g. "Markets of Tomorrow <media@marketsoftomorrow.com>")

Run: python3 send_digest.py
"""

import json, os, sys, urllib.request, urllib.error

OUT_HTML    = "newsletter/digest-latest.html"
OUT_SUBJECT = "newsletter/digest-subject.txt"

API_KEY  = os.environ.get("RESEND_API_KEY", "").strip()
AUDIENCE = os.environ.get("RESEND_AUDIENCE_ID", "").strip()
SENDER   = os.environ.get("RESEND_FROM", "").strip()

def fail(msg, code=1):
    print(f"[err] {msg}", file=sys.stderr)
    sys.exit(code)

def main():
    # Validate env
    missing = [k for k, v in {
        "RESEND_API_KEY":     API_KEY,
        "RESEND_AUDIENCE_ID": AUDIENCE,
        "RESEND_FROM":        SENDER,
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

    if not html.strip():    fail(f"{OUT_HTML} is empty")
    if not subject:         fail(f"{OUT_SUBJECT} is empty")

    print(f"[info] subject: {subject}")
    print(f"[info] html size: {len(html):,} chars")
    print(f"[info] from: {SENDER}")
    print(f"[info] audience: {AUDIENCE}")

    # Create Resend broadcast as draft (no scheduled_at = stays in draft)
    payload = json.dumps({
        "audience_id": AUDIENCE,
        "from":        SENDER,
        "subject":     subject,
        "html":        html,
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.resend.com/broadcasts",
        data=payload,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type":  "application/json",
            "User-Agent":    "TMW-Newsletter/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
            broadcast_id = data.get("id", "(unknown)")
            print(f"[ok] draft created: {broadcast_id}")
            print(f"[ok] review at: https://resend.com/broadcasts/{broadcast_id}")
            print("[info] review in Resend dashboard, then hit Send manually")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        fail(f"Resend API error {e.code}: {body}")
    except Exception as e:
        fail(f"Resend request failed: {e}")

if __name__ == "__main__":
    main()
