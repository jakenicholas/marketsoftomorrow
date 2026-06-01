#!/usr/bin/env python3
"""
Refresh cityStateMap.json — the city -> state/region label map the live map uses
for its search autocomplete ("Miami · FL").

Why this exists: the map USED to reverse-geocode every city on every page load
(~111 cities x every visitor = ~450k Mapbox geocoding requests/month, the entire
Mapbox bill). Now the map loads this precomputed file and does ZERO geocoding.

This script keeps that file fresh INCREMENTALLY: it only geocodes cities that
aren't already in cityStateMap.json, so a brand-new project in a brand-new city
costs exactly ONE geocoding request; every existing city is never re-geocoded.
Cities no longer present in any project are pruned.

Run it in the build pipeline right after fetch_projects.py (which writes
projects-flat.json). When a project is saved, the map admin fires the
`rebuild-map` workflow, so a new city is added within ~1-2 minutes automatically.
"""
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.join(ROOT, "projects-flat.json")
OUT = os.path.join(ROOT, "cityStateMap.json")
INDEX = os.path.join(ROOT, "index.html")


def mapbox_token():
    # Prefer an explicit secret; otherwise reuse the public token already baked
    # into the live map (index.html) so no new secret is required.
    tok = os.environ.get("MAPBOX_TOKEN")
    if tok:
        return tok.strip()
    try:
        html = open(INDEX, encoding="utf-8").read()
        m = re.search(r"mapboxgl\.accessToken\s*=\s*['\"](pk\.[A-Za-z0-9._-]+)['\"]", html)
        if m:
            return m.group(1)
    except Exception:
        pass
    return ""


def load_json(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def reverse_geocode(lng, lat, token):
    url = (
        f"https://api.mapbox.com/geocoding/v5/mapbox.places/"
        f"{lng},{lat}.json?types=region&access_token={token}"
    )
    try:
        raw = subprocess.run(
            ["curl", "-s", "-m", "15", url], capture_output=True, text=True
        ).stdout
        data = json.loads(raw)
        feat = (data.get("features") or [None])[0]
        if not feat:
            return ""
        code = (feat.get("properties") or {}).get("short_code") or ""
        state = re.sub(r"^US-", "", code, flags=re.I).upper()  # "US-FL" -> "FL"
        return state or feat.get("text", "")
    except Exception:
        return ""


def main():
    rows = load_json(PROJECTS, [])
    if isinstance(rows, dict):
        rows = rows.get("projects") or rows.get("rows") or []
    existing = load_json(OUT, {})
    token = mapbox_token()
    if not token:
        print("city-states: no Mapbox token found; leaving cityStateMap.json unchanged", file=sys.stderr)
        return 0

    # One representative coordinate per unique city.
    city_coord = {}
    for r in rows:
        c = (r.get("City") or "").strip()
        if not c or c in city_coord:
            continue
        try:
            city_coord[c] = (float(r["Longitude"]), float(r["Latitude"]))
        except Exception:
            pass

    # Keep only cities still present in the data; carry their existing labels.
    out = {c: s for c, s in existing.items() if c in city_coord}
    new_cities = [c for c in city_coord if c not in out]

    geocoded = failed = 0
    for c in new_cities:
        lng, lat = city_coord[c]
        state = reverse_geocode(lng, lat, token)
        if state:
            out[c] = state
            geocoded += 1
        else:
            failed += 1
        time.sleep(0.04)

    pruned = len(existing) - len([c for c in existing if c in city_coord])
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(
        f"city-states: {len(out)} cities total | {geocoded} newly geocoded | "
        f"{failed} failed | {pruned} pruned"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
