#!/usr/bin/env python3
"""
build_skyline_footprints.py — real building footprints for the Future Skyline.

For every pipeline project with floors data, finds the actual OSM building
polygon on the site (OSM is the source of Mapbox's building layer, so these
footprints align with the rendered streets and gray 3D city by construction).

Output journal/map/skyline-footprints.json, keyed by project Slug:
  slug -> [[lng,lat], ...]      real footprint ring (closed), OR
  slug -> [deg, lng, lat]       no usable polygon; street-grid bearing of the
                                nearest building + its centroid as a LAND
                                ANCHOR for the fallback rect (a building
                                centroid can't be in the water; for
                                redevelopment sites the rejected old building
                                IS the site, so its centroid is the position).
Projects absent from the file get an axis-aligned fallback in the map.

Re-run whenever a batch of new towers lands: python3 tools/build_skyline_footprints.py
"""
import json, math, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FLAT = ROOT / "journal/map/projects-flat.json"
OUT  = ROOT / "journal/map/skyline-footprints.json"
OVERPASS = "https://overpass-api.de/api/interpreter"

CHUNK = 40          # projects per Overpass query
RADIUS = 120        # metres searched around each pin
MATCH_NEAR = 15     # metres: nearest-building match threshold when pin isn't inside one
MIN_AREA = 250      # m²: ignore sheds/kiosks
MAX_AREA = 25000    # m²: ignore district-scale polygons (multi-block construction landuse)
MAX_RING_PTS = 32
# Known-bad OSM matches (wrong building): never store a ring for these; the
# Studio massing editor owns their geometry.
BLOCKLIST = {'10-cityplace'}

def load_projects():
    data = json.loads(FLAT.read_text())
    recs = data if isinstance(data, list) else data.get("projects", data)
    out = []
    for p in recs:
        # Every pipeline pin gets a 3D form now (stadiums, bridges, museums,
        # parks included), so every project with coordinates needs a footprint.
        lat, lng = p.get("Latitude"), p.get("Longitude")
        if not lat or not lng:
            continue
        try:
            fl = int("".join(c for c in str(p.get("Floors", "")) if c.isdigit()) or 0)
        except ValueError:
            fl = 0
        try:
            gfa = float(p.get("GfaSqFt") or 0)
        except (TypeError, ValueError):
            gfa = 0
        try:
            out.append({"slug": p.get("Slug", ""), "lat": float(lat), "lng": float(lng),
                        "gfa": gfa, "fl": fl})
        except (TypeError, ValueError):
            continue
    return [p for p in out if p["slug"] and p["slug"] not in BLOCKLIST]

def overpass(points):
    # buildings + the civic forms that aren't tagged building: stadium bowls,
    # bridge decks, race tracks. One union query per chunk.
    clauses = "".join(
        f"way(around:{RADIUS},{p['lat']:.6f},{p['lng']:.6f})[building];"
        f"way(around:{RADIUS},{p['lat']:.6f},{p['lng']:.6f})[\"man_made\"=\"bridge\"];"
        f"way(around:{RADIUS},{p['lat']:.6f},{p['lng']:.6f})[\"leisure\"~\"^(stadium|sports_centre|track)$\"];"
        f"way(around:{RADIUS},{p['lat']:.6f},{p['lng']:.6f})[\"landuse\"=\"construction\"];"
        for p in points)
    query = f"[out:json][timeout:120];({clauses});out geom qt;"
    for attempt in range(3):
        r = subprocess.run(
            ["curl", "-s", "-m", "120", "--data-urlencode", f"data={query}", OVERPASS],
            capture_output=True, text=True)
        try:
            return json.loads(r.stdout)["elements"]
        except (json.JSONDecodeError, KeyError):
            print(f"  [warn] overpass attempt {attempt+1} failed ({r.stdout[:80]!r}), retrying in 20s")
            time.sleep(20)
    return []

def metres(lat0):
    return 111320.0, 111320.0 * math.cos(math.radians(lat0))

def ring_of(way):
    g = way.get("geometry") or []
    ring = [(n["lon"], n["lat"]) for n in g]
    if len(ring) < 4 or ring[0] != ring[-1]:
        return None
    return ring

def area_m2(ring):
    lat0 = ring[0][1]
    mlat, mlng = metres(lat0)
    pts = [((x - ring[0][0]) * mlng, (y - ring[0][1]) * mlat) for x, y in ring]
    s = sum(pts[i][0] * pts[i+1][1] - pts[i+1][0] * pts[i][1] for i in range(len(pts) - 1))
    return abs(s) / 2

def contains(ring, lng, lat):
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]; x2, y2 = ring[i+1]
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside

def dist_m(ring, lng, lat):
    mlat, mlng = metres(lat)
    return min(math.hypot((x - lng) * mlng, (y - lat) * mlat) for x, y in ring)

def longest_edge_bearing(ring):
    mlat, mlng = metres(ring[0][1])
    best, bearing = 0, 0.0
    for i in range(len(ring) - 1):
        dx = (ring[i+1][0] - ring[i][0]) * mlng
        dy = (ring[i+1][1] - ring[i][1]) * mlat
        d = dx*dx + dy*dy
        if d > best:
            best, bearing = d, math.degrees(math.atan2(dx, dy))
    return int(round(bearing)) % 90   # grid-symmetric

def is_ring(v):
    return isinstance(v, list) and v and isinstance(v[0], (list, tuple))

def centroid(ring):
    n = len(ring) - 1
    return (round(sum(p[0] for p in ring[:-1]) / n, 6),
            round(sum(p[1] for p in ring[:-1]) / n, 6))

def plausible(area, gfa, fl):
    """Reject footprints wildly larger than the plate the project's own
    GFA/floors imply — those are the OLD building on a redevelopment site
    (a low curved hotel slab extruded to 66 floors looks absurd)."""
    if gfa > 0 and fl >= 8:
        implied = (gfa * 0.0929) / fl
        return area <= max(3 * implied, 4500)
    return True

def decimate(ring):
    if len(ring) <= MAX_RING_PTS:
        return ring
    step = (len(ring) - 1) / (MAX_RING_PTS - 1)
    keep = [ring[int(round(i * step))] for i in range(MAX_RING_PTS - 1)]
    keep.append(ring[0])
    return keep

def main():
    projects = load_projects()
    # Incremental: keep existing real rings, re-query bearing-only and missing
    # slugs (the broadened tags can upgrade a bearing to a real footprint).
    result = {}
    if OUT.exists():
        result = json.loads(OUT.read_text())
        byslug = {p["slug"]: p for p in projects}
        dropped = 0
        for slug, v in list(result.items()):
            pr = byslug.get(slug)
            if is_ring(v) and pr and not plausible(area_m2([tuple(x) for x in v]), pr["gfa"], pr["fl"]):
                r0 = [tuple(x) for x in v]
                result[slug] = [longest_edge_bearing(r0), *centroid(r0)]
                dropped += 1
        if dropped:
            print(f"guard downgraded {dropped} implausible rings (old-building footprints) to bearings")
        solved = {s for s, v in result.items() if is_ring(v)}
        projects = [p for p in projects if p["slug"] not in solved]
    print(f"{len(projects)} projects to query ({len(result)} entries carried over)")
    for ci in range(0, len(projects), CHUNK):
        chunk = projects[ci:ci + CHUNK]
        print(f"chunk {ci//CHUNK + 1}/{(len(projects)+CHUNK-1)//CHUNK}: querying {len(chunk)} sites ...")
        ways = overpass(chunk)
        rings = []
        for w in ways:
            r = ring_of(w)
            if r:
                rings.append((r, area_m2(r)))
        print(f"  {len(rings)} building polygons returned")
        for p in chunk:
            lng, lat = p["lng"], p["lat"]
            near = [(r, a) for r, a in rings if dist_m(r, lng, lat) <= RADIUS + 50]
            containing = sorted((x for x in near if MIN_AREA <= x[1] <= MAX_AREA
                                 and plausible(x[1], p["gfa"], p["fl"]) and contains(x[0], lng, lat)),
                                key=lambda x: x[1])
            if containing:
                ring = containing[0][0]
            else:
                cand = sorted(((r, a, dist_m(r, lng, lat)) for r, a in near
                               if MIN_AREA <= a <= MAX_AREA and plausible(a, p["gfa"], p["fl"])),
                              key=lambda x: x[2])
                ring = cand[0][0] if cand and cand[0][2] <= MATCH_NEAR else None
                if ring is None:
                    if cand:
                        result[p["slug"]] = [longest_edge_bearing(cand[0][0]), *centroid(cand[0][0])]
                    continue
            result[p["slug"]] = [[round(x, 6), round(y, 6)] for x, y in decimate(ring)]
        time.sleep(3)
    footprints = sum(1 for v in result.values() if is_ring(v))
    bearings = len(result) - footprints
    print(f"\n{footprints} real footprints, {bearings} bearing-only, "
          f"{len(projects) - len(result)} no data (axis-aligned fallback)")
    OUT.write_text(json.dumps(result, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")

if __name__ == "__main__":
    main()
