#!/usr/bin/env python3
"""
Regenerate the static client files from the studio's Clients list (D1).

The live surfaces (the universal partners "good company" wall via
journal/_shared/partners.js, and the media kit grid at map.oftmw.com/media) read
the studio list straight from the worker (/list/clients) so studio edits show
up instantly. This script just refreshes the *static* copies that serve as the
no-JS / offline fallback and keep the data in git:

  - journal/clients-data.json : rich mirror (name, logo, industries, location, active)
  - journal/clients.json      : flat active-only list (name, logo) — legacy shape

Fired on save by the studio (repository_dispatch: rebuild-clients). A no-op
until the Clients list has been saved at least once.
"""
import json
import os
import sys
import urllib.request

LIST_URL = "https://tmw.jake-ab7.workers.dev/list/clients"


def fetch():
    req = urllib.request.Request(LIST_URL, headers={"User-Agent": "tmw-generate-clients"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def is_active(c):
    a = c.get("active")
    return not (a is False or a in ("", "0", "false", "no"))


def main():
    try:
        doc = fetch()
    except Exception as e:
        print("fetch /list/clients failed:", e)
        sys.exit(1)

    if not (isinstance(doc, dict) and doc.get("exists") and isinstance(doc.get("data"), dict)):
        print("No Clients list stored yet — nothing to regenerate.")
        return

    items = doc["data"].get("items") or []
    rich, flat = [], []
    for c in items:
        if not isinstance(c, dict):
            continue
        name = (c.get("name") or "").strip()
        logo = (c.get("logo") or "").strip()
        if not (name and logo):
            continue
        ind = c.get("industries")
        if isinstance(ind, list):
            ind = "|".join(str(x).strip() for x in ind if str(x).strip())
        ind = (ind or "").strip()
        active = is_active(c)
        rich.append({
            "name": name,
            "logo": logo,
            "industries": ind,
            "location": (c.get("location") or "").strip(),
            "active": bool(active),
        })
        if active:
            flat.append({"name": name, "logo": logo})

    base = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(base, "journal", "clients-data.json"), "w", encoding="utf-8") as f:
        json.dump(rich, f, ensure_ascii=False, indent=0)
    with open(os.path.join(base, "journal", "clients.json"), "w", encoding="utf-8") as f:
        json.dump(flat, f, ensure_ascii=False)
    print(f"Wrote clients-data.json ({len(rich)}) and clients.json ({len(flat)} active).")


if __name__ == "__main__":
    main()
