#!/usr/bin/env python3
"""
resolve_place_context.py — Phase 1 of Location Caliber.

Builds journal/map/place-context.json: one cached, derived record per live
project holding (a) the Mapbox-resolved canonical address / neighborhood /
snapped point, (b) the access slots buyers price in (airport, FBO, rail,
marina) with real travel minutes, and (c) marquee anchors GEO-JOINED FROM OUR
OWN DATA (iconic lists + tracked projects) — never generic POIs.

Design rules (agreed 2026-08-06):
  - DERIVED FILE ONLY. Never mutates projects.json / projects-flat.json. A
    geocode that moves a pin >150m is flagged status="review" and the official
    coordinates are kept; the proposed point is stored for the Studio to apply.
  - First-party anchors only. Mapbox supplies geometry (geocode + routing),
    never taste.
  - Resumable + cheap: records fresher than MAX_AGE_DAYS are skipped unless
    --force / --slugs. Whole 939-project backfill ≈ ~10 calls/project.

Usage:
  MAPBOX_TOKEN=... python3 resolve_place_context.py [--limit N] [--slugs a,b]
                                                    [--force] [--dry-run]
Inputs:  journal/map/projects-flat.json, worker /list/{golf,hotels,restaurants}
Output:  journal/map/place-context.json   (also the iconic-list geocode cache)
"""

import argparse, json, math, os, sys, time
import requests

ROOT          = os.path.dirname(os.path.abspath(__file__))
PROJECTS_PATH = os.path.join(ROOT, "journal", "map", "projects-flat.json")
OUT_PATH      = os.path.join(ROOT, "journal", "map", "place-context.json")
WORKER        = "https://tmw.jake-ab7.workers.dev"
TOKEN         = os.environ.get("MAPBOX_TOKEN", "").strip()

MAX_AGE_DAYS   = 25          # refresh cadence guard (monthly cron re-runs stale)
REVIEW_DELTA_M = 150         # pin moves beyond this are review-flagged, not applied
RATE_SLEEP     = 0.13        # ~8 req/s, well under Mapbox limits
SCHEMA_V       = 1

# Access slots: fixed slots, locally resolved. cap_km drops a slot rather than
# show an absurd value ("FBO · 4 hours" helps nobody).
SLOTS = [
    # (slot, kind, query/category ids to try in order, cap_km, label)
    ("airport", "category", ["airport"],                    160, "Airport"),
    ("fbo",     "forward",  ["FBO", "private jet terminal"], 60, "Private aviation · FBO"),
    ("rail",    "category", ["railway_station", "train_station"], 30, "Rail"),
    ("marina",  "category", ["marina"],                      30, "Marina"),
]

LIST_SLUGS = {"golf": "iconic_golf", "hotels": "iconic_hotels", "restaurants": "iconic_dining"}
ANCHOR_LIST_KM, ANCHOR_PROJ_KM, ANCHOR_CAP = 20.0, 4.0, 6

MI_COUNTRIES = {"united states", "usa", "us"}

ISO2 = {"united states": "us", "usa": "us", "united kingdom": "gb", "uk": "gb",
        "mexico": "mx", "canada": "ca", "italy": "it", "france": "fr", "spain": "es",
        "portugal": "pt", "greece": "gr", "japan": "jp", "united arab emirates": "ae",
        "saudi arabia": "sa", "qatar": "qa", "australia": "au", "brazil": "br",
        "bahamas": "bs", "switzerland": "ch", "austria": "at", "germany": "de"}


def hav_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def mb_get(url, params, tries=3):
    params = dict(params, access_token=TOKEN)
    for i in range(tries):
        time.sleep(RATE_SLEEP)
        try:
            r = requests.get(url, params=params, timeout=20)
            if r.status_code == 429:
                time.sleep(2 * (i + 1)); continue
            if r.ok:
                return r.json()
            if r.status_code in (401, 403):
                sys.exit(f"[fatal] Mapbox auth failed ({r.status_code}) — check MAPBOX_TOKEN")
            return None
        except requests.RequestException:
            time.sleep(1 + i)
    return None


# ── Geocoding (resolution) ──────────────────────────────────────────────────

def geocode(q, proximity=None, types=None, country=None):
    p = {"q": q, "limit": 1, "language": "en"}
    if proximity: p["proximity"] = f"{proximity[1]},{proximity[0]}"      # lng,lat
    if types:     p["types"] = types
    if country:   p["country"] = country
    j = mb_get("https://api.mapbox.com/search/geocode/v6/forward", p)
    feats = (j or {}).get("features") or []
    return feats[0] if feats else None


def sb_forward(q, proximity=None):
    """POI lookup via Search Box (Geocoding v6 has no poi type). Returns a
    geocode-shaped dict: {name, lat, lng, mapbox_id, full_address} or None."""
    p = {"q": q, "limit": 1, "language": "en", "types": "poi"}
    if proximity: p["proximity"] = f"{proximity[1]},{proximity[0]}"
    j = mb_get("https://api.mapbox.com/search/searchbox/v1/forward", p)
    feats = (j or {}).get("features") or []
    if not feats: return None
    f = feats[0]
    c = (f.get("geometry") or {}).get("coordinates") or []
    if len(c) != 2: return None
    props = f.get("properties") or {}
    return {"name": props.get("name"), "lat": c[1], "lng": c[0],
            "mapbox_id": props.get("mapbox_id"),
            "full_address": props.get("full_address") or props.get("place_formatted")}


def resolve_project(p):
    """Canonical address + neighborhood + proposed point for one project."""
    lat, lng = float(p.get("Latitude") or 0), float(p.get("Longitude") or 0)
    street, city = (p.get("Street") or "").strip(), (p.get("City") or "").strip()
    country = (p.get("Country") or "").strip()
    iso = ISO2.get(country.lower())
    prox = (lat, lng) if lat and lng else None

    out = {"canonical": None, "neighborhood": (p.get("Neighborhood") or "").strip() or None,
           "mapbox_id": None, "confidence": 0.3,
           "point": {"lat": lat, "lng": lng, "status": "kept"},
           "proposed_point": None, "delta_m": None}

    feat = None
    if street and city:
        feat = geocode(f"{street}, {city}, {country}".strip(", "),
                       proximity=prox, types="address", country=iso)
    if not feat:  # no street (resorts/clubs) → the project itself as a POI (Search Box)
        poi = sb_forward(f"{p.get('Title','')}, {city}, {country}".strip(", "), proximity=prox)
        if poi:
            delta = hav_km(lat, lng, poi["lat"], poi["lng"]) * 1000 if (lat and lng) else None
            # A POI "match" far from our curated pin is a WRONG PLACE (name
            # collision), not a better location — reject it, don't review-flag.
            if delta is not None and delta > 2500:
                return out
            out["canonical"] = poi["full_address"]
            out["mapbox_id"] = poi["mapbox_id"]
            out["confidence"] = 0.75
            if delta is None:
                out["point"] = {"lat": poi["lat"], "lng": poi["lng"], "status": "snapped"}
            else:
                out["delta_m"] = round(delta)
                if delta <= REVIEW_DELTA_M:
                    out["point"] = {"lat": poi["lat"], "lng": poi["lng"], "status": "snapped"}
                else:
                    out["proposed_point"] = {"lat": poi["lat"], "lng": poi["lng"]}
                    out["point"]["status"] = "review"
        return out
    if not feat:
        return out

    props = feat.get("properties") or {}
    coords = props.get("coordinates") or {}
    glat, glng = coords.get("latitude"), coords.get("longitude")
    ctx = props.get("context") or {}

    out["canonical"] = props.get("full_address") or props.get("place_formatted")
    out["mapbox_id"] = props.get("mapbox_id")
    hood = (ctx.get("neighborhood") or {}).get("name")
    if hood and not out["neighborhood"]:
        out["neighborhood"] = hood                       # fill blanks, never overwrite curation
    acc = (coords.get("accuracy") or "").lower()
    conf = {"rooftop": .95, "parcel": .95, "point": .9}.get(acc, .7 if acc else .6)
    m = ((props.get("match_code") or {}).get("confidence") or "").lower()
    if m == "exact": conf = min(.98, conf + .05)
    out["confidence"] = round(conf, 2)

    if glat and glng and lat and lng:
        delta = hav_km(lat, lng, glat, glng) * 1000
        out["delta_m"] = round(delta)
        if delta <= REVIEW_DELTA_M:
            out["point"] = {"lat": glat, "lng": glng, "status": "snapped"}
        else:                                            # too big a move — human eyes first
            out["proposed_point"] = {"lat": glat, "lng": glng}
            out["point"]["status"] = "review"
    elif glat and glng:
        out["point"] = {"lat": glat, "lng": glng, "status": "snapped"}
    return out


# ── Access slots ────────────────────────────────────────────────────────────

def nearest_place(kind, queries, lat, lng, cap_km):
    for q in queries:
        if kind == "category":
            j = mb_get(f"https://api.mapbox.com/search/searchbox/v1/category/{q}",
                       {"proximity": f"{lng},{lat}", "limit": 3, "language": "en"})
        else:
            j = mb_get("https://api.mapbox.com/search/searchbox/v1/forward",
                       {"q": q, "proximity": f"{lng},{lat}", "limit": 3,
                        "language": "en", "types": "poi"})
        feats = (j or {}).get("features") or []
        best = None
        for f in feats:
            c = (f.get("geometry") or {}).get("coordinates") or []
            if len(c) != 2: continue
            d = hav_km(lat, lng, c[1], c[0])
            if d > cap_km: continue
            name = ((f.get("properties") or {}).get("name")) or ""
            # airports: prefer an International in the top results over a strip field
            score = d - (25 if ("international" in name.lower()) else 0)
            if best is None or score < best[0]:
                best = (score, name, c[1], c[0], d)
        if best:
            return {"name": best[1], "lat": best[2], "lng": best[3], "dist_km": round(best[4], 2)}
    return None


def travel_minutes(lat1, lng1, lat2, lng2, straight_km):
    profile = "walking" if straight_km <= 1.4 else "driving"
    j = mb_get(f"https://api.mapbox.com/directions/v5/mapbox/{profile}/"
               f"{lng1},{lat1};{lng2},{lat2}", {"overview": "false"})
    routes = (j or {}).get("routes") or []
    if not routes:
        return None, None
    return max(1, round(routes[0]["duration"] / 60)), ("Walk" if profile == "walking" else "Drive")


def build_access(lat, lng):
    out = []
    for slot, kind, queries, cap_km, label in SLOTS:
        hit = nearest_place(kind, queries, lat, lng, cap_km)
        if not hit: continue
        mins, mode = travel_minutes(lat, lng, hit["lat"], hit["lng"], hit["dist_km"])
        if mins is None: continue
        out.append({"slot": slot, "label": label, "name": hit["name"],
                    "minutes": mins, "mode": mode, "dist_km": hit["dist_km"]})
    return out


# ── First-party anchors (the signal) ────────────────────────────────────────

def load_list_places(cache):
    """Iconic list items, geocoded once and cached inside the output file."""
    places = []
    for lslug, prov in LIST_SLUGS.items():
        try:
            doc = requests.get(f"{WORKER}/list/{lslug}", timeout=20).json()
            doc = doc.get("data") or doc          # worker wraps the list under `data`
        except Exception:
            print(f"[warn] could not load /list/{lslug}"); continue
        items = doc.get("items") or []
        if not items:
            print(f"[warn] /list/{lslug}: 0 items — shape change?")
        for it in items:
            key = f"{lslug}/{it.get('id') or it.get('name')}"
            got = cache.get(key)
            if not got or not got.get("lat"):
                q = f"{it.get('name','')}, {it.get('location','')}"
                poi = sb_forward(q)               # POIs live in Search Box, not v6
                if poi:
                    got = {"name": it.get("name"), "location": it.get("location"),
                           "lat": poi["lat"], "lng": poi["lng"]}
                else:                             # fallback: place-level geocode
                    feat = geocode(q)
                    c = ((feat or {}).get("properties") or {}).get("coordinates") or {}
                    got = {"name": it.get("name"), "location": it.get("location"),
                           "lat": c.get("latitude"), "lng": c.get("longitude")}
                cache[key] = got
            if got.get("lat"):
                places.append({**got, "provenance": prov, "ref": key})
    return places


def build_anchors(p, projects, list_places):
    lat, lng = float(p.get("Latitude") or 0), float(p.get("Longitude") or 0)
    if not (lat and lng): return []
    cands, seen = [], set()

    for lp in list_places:                                   # iconic lists, wide radius
        d = hav_km(lat, lng, lp["lat"], lp["lng"])
        if d > ANCHOR_LIST_KM: continue
        n = lp["name"].strip().lower()
        if n in seen: continue
        seen.add(n)
        cands.append({"name": lp["name"], "type": lp["location"], "dist_km": round(d, 2),
                      "provenance": lp["provenance"], "ref": lp["ref"]})

    me, my_parent = p.get("Slug"), p.get("ParentSlug") or None
    for q in projects:                                       # tracked projects, tight radius
        if q.get("Slug") == me: continue
        if my_parent and (q.get("Slug") == my_parent or q.get("ParentSlug") == my_parent): continue
        qlat, qlng = float(q.get("Latitude") or 0), float(q.get("Longitude") or 0)
        if not (qlat and qlng): continue
        d = hav_km(lat, lng, qlat, qlng)
        if d > ANCHOR_PROJ_KM: continue
        n = (q.get("Title") or "").strip().lower()
        if not n or n in seen: continue
        seen.add(n)
        cands.append({"name": q.get("Title"), "type": q.get("PreferredType") or q.get("ProjectType") or "Development",
                      "dist_km": round(d, 2), "provenance": "tracked_project", "ref": q.get("Slug")})

    cands.sort(key=lambda a: a["dist_km"])
    return cands[:ANCHOR_CAP]


# ── Record assembly ─────────────────────────────────────────────────────────

def tier_of(access, anchors):
    if len(anchors) >= 3: return "established_enclave"
    air = next((a for a in access if a["slot"] == "airport"), None)
    if air and air["minutes"] <= 20: return "access_led"
    return "emerging"


def build_record(p, projects, list_places):
    res = resolve_project(p)
    lat, lng = res["point"]["lat"], res["point"]["lng"]
    access  = build_access(lat, lng) if (lat and lng) else []
    anchors = build_anchors(p, projects, list_places)
    country = (p.get("Country") or "").strip().lower()
    return {
        "schema": SCHEMA_V, "resolved_at": int(time.time()),
        "confidence": res["confidence"],
        "coverage": "full" if len(anchors) >= 2 else ("access-only" if access else "thin"),
        "override": None,
        "address": {"line": (p.get("Street") or "").strip() or None,
                    "city": p.get("City"), "country": p.get("Country"),
                    "canonical": res["canonical"]},
        "neighborhood": res["neighborhood"],
        "point": res["point"], "proposed_point": res["proposed_point"],
        "delta_m": res["delta_m"], "building_id": res["mapbox_id"],
        "access": access, "anchors": anchors,
        "tier": tier_of(access, anchors),
        "units": "mi" if country in MI_COUNTRIES else "km",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--slugs", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not TOKEN:
        sys.exit("[fatal] MAPBOX_TOKEN is not set")

    projects = json.load(open(PROJECTS_PATH))
    if not isinstance(projects, list):
        projects = projects.get("projects") or projects.get("items") or []
    print(f"[info] {len(projects)} live projects")

    out = {"_meta": {}, "_lists": {}, "projects": {}}
    if os.path.exists(OUT_PATH):
        try: out = json.load(open(OUT_PATH))
        except Exception: pass
    out.setdefault("_lists", {}); out.setdefault("projects", {})

    list_places = load_list_places(out["_lists"])
    print(f"[info] {len(list_places)} iconic-list anchors geocoded (cached)")

    only = {s.strip() for s in args.slugs.split(",") if s.strip()}
    now, fresh_cutoff = time.time(), time.time() - MAX_AGE_DAYS * 86400
    todo = []
    for p in projects:
        slug = p.get("Slug")
        if not slug: continue
        if only and slug not in only: continue
        old = out["projects"].get(slug)
        if old and not args.force and not only and old.get("resolved_at", 0) > fresh_cutoff:
            continue
        todo.append(p)
    if args.limit: todo = todo[:args.limit]
    print(f"[info] resolving {len(todo)} projects (~{len(todo)*10} Mapbox calls)")

    review, done = [], 0
    for p in todo:
        slug = p.get("Slug")
        try:
            rec = build_record(p, projects, list_places)
        except Exception as e:
            print(f"[warn] {slug}: {type(e).__name__}: {e}"); continue
        out["projects"][slug] = rec
        if rec["point"]["status"] == "review":
            review.append((slug, rec["delta_m"]))
        done += 1
        if done % 10 == 0: print(f"[info] {done}/{len(todo)} …")

    out["_meta"] = {"schema": SCHEMA_V, "generated_at": int(now),
                    "projects": len(out["projects"]), "review_flagged": len(review)}

    # Coverage report — the number that answers "will random cities hold up?"
    by_cov, by_market = {}, {}
    for slug, r in out["projects"].items():
        by_cov[r["coverage"]] = by_cov.get(r["coverage"], 0) + 1
        mk = (r["address"].get("city") or "?")
        m = by_market.setdefault(mk, {"n": 0, "full": 0, "anchors": 0, "access": 0})
        m["n"] += 1; m["anchors"] += len(r["anchors"]); m["access"] += len(r["access"])
        if r["coverage"] == "full": m["full"] += 1
    print("\n[report] coverage:", by_cov)
    worst = sorted(by_market.items(), key=lambda kv: kv[1]["full"] / max(1, kv[1]["n"]))[:12]
    print("[report] thinnest markets (full/total · avg anchors · avg access slots):")
    for mk, m in worst:
        print(f"  {mk:28s} {m['full']}/{m['n']} · {m['anchors']/m['n']:.1f} · {m['access']/m['n']:.1f}")
    if review:
        print(f"[report] {len(review)} pins flagged for review (moved >{REVIEW_DELTA_M}m):")
        for slug, d in review[:15]: print(f"  {slug}  Δ{d}m")

    if args.dry_run:
        print("[dry-run] not writing"); return
    json.dump(out, open(OUT_PATH, "w"), separators=(",", ":"))
    print(f"[ok] wrote {os.path.relpath(OUT_PATH, ROOT)} ({os.path.getsize(OUT_PATH)//1024} KB)")


if __name__ == "__main__":
    main()
