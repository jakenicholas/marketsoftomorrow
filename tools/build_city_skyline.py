#!/usr/bin/env python3
"""build_city_skyline.py — a real city for the Future Skyline's far zooms.

WHY THIS EXISTS: mapbox-streets-v8 carries almost no building geometry below
zoom 15. Measured, per Manhattan tile: z13 -> 9 buildings, z14 -> 50,
z15 -> 1376. So from z11-15 our pipeline towers stand on an empty grid with no
city around them, which is what makes the zoomed-out 3D look wrong. GL cannot
"underzoom" (it will not fetch z15 tiles to draw at z12), so the only fix is to
harvest the tall buildings ourselves, once, and ship them as our own layer.

Reads the SAME tiles the basemap draws from, so the silhouettes line up exactly
when the real building layer takes over at z15.

Each building is stored as an oriented box — [lng, lat, w, l, bearing, height] —
which is indistinguishable from its true footprint at the zooms this renders at
and keeps the payload small.

  python3 tools/build_city_skyline.py [--dry] [--min-height 60]
"""
import argparse, json, math, os, pathlib, re, subprocess, sys, time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
ROOT = pathlib.Path(__file__).resolve().parent.parent
FLAT = ROOT / "journal/map/projects-flat.json"
OUT  = ROOT / "journal/map/city-skyline.json"

CLUSTER_DEG = 0.10        # ~11 km: group projects into markets
PAD_DEG     = 0.008       # ~900 m of context around a market's projects
WORKERS     = 8
Z = 15

def tile_budget(n):
    """A market earns coverage by how much of our pipeline sits in it: a
    30-project metro needs a skyline, a one-project town needs its block."""
    return 80 if n >= 20 else 40 if n >= 8 else 18 if n >= 3 else 8

def tilexy(z, lat, lng):
    n = 2 ** z
    return (int((lng + 180.0) / 360.0 * n),
            int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n))

def load_markets():
    data = json.loads(FLAT.read_text())
    recs = data if isinstance(data, list) else data.get("projects", data)
    pts = []
    for p in recs:
        try:
            lat, lng = float(p.get("Latitude")), float(p.get("Longitude"))
        except (TypeError, ValueError):
            continue
        if lat or lng: pts.append((lat, lng))
    groups = {}
    for lat, lng in pts:
        groups.setdefault((round(lat / CLUSTER_DEG), round(lng / CLUSTER_DEG)), []).append((lat, lng))
    out = []
    for key, g in groups.items():
        lats = [p[0] for p in g]; lngs = [p[1] for p in g]
        out.append({"n": len(g),
                    "bbox": (min(lats) - PAD_DEG, min(lngs) - PAD_DEG,
                             max(lats) + PAD_DEG, max(lngs) + PAD_DEG)})
    out.sort(key=lambda m: -m["n"])
    return out

def tiles_for(bbox, budget):
    s, w, n, e = bbox
    x0, y0 = tilexy(Z, n, w)
    x1, y1 = tilexy(Z, s, e)
    ts = [(x, y) for x in range(min(x0, x1), max(x0, x1) + 1)
                 for y in range(min(y0, y1), max(y0, y1) + 1)]
    if len(ts) > budget:                     # keep the centre of the market
        cx = (min(x0, x1) + max(x0, x1)) / 2; cy = (min(y0, y1) + max(y0, y1)) / 2
        ts.sort(key=lambda t: (t[0] - cx) ** 2 + (t[1] - cy) ** 2)
        ts = ts[:budget]
    return ts

def box_of(ring_ll):
    """oriented bounding box of a footprint: centre, width, length, bearing"""
    lat0 = sum(p[1] for p in ring_ll) / len(ring_ll)
    mlat, mlng = 111320.0, 111320.0 * math.cos(math.radians(lat0))
    cx = sum(p[0] for p in ring_ll) / len(ring_ll)
    cy = sum(p[1] for p in ring_ll) / len(ring_ll)
    pts = [((p[0] - cx) * mlng, (p[1] - cy) * mlat) for p in ring_ll]
    best, brg = 0.0, 0.0
    for i in range(len(pts)):
        ax, ay = pts[i]; bx, by = pts[(i + 1) % len(pts)]
        d = (bx - ax) ** 2 + (by - ay) ** 2
        if d > best: best, brg = d, math.atan2(bx - ax, by - ay)
    ux, uy = math.sin(brg), math.cos(brg)
    us = [x * ux + y * uy for x, y in pts]
    vs = [-x * uy + y * ux for x, y in pts]
    return cx, cy, max(vs) - min(vs), max(us) - min(us), math.degrees(brg) % 180

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--min-height", type=float, default=60.0)
    ap.add_argument("--markets", type=int, default=0, help="limit to the N biggest")
    ap.add_argument("--force-shrink", action="store_true",
                    help="write even if the harvest is far smaller than the file on disk")
    a = ap.parse_args()

    import mvt
    # CI hands the token in; locally fall back to the one the map already ships.
    tok = os.environ.get("MAPBOX_TOKEN", "").strip()
    if not tok:
        tok = re.search(r'pk\.eyJ[A-Za-z0-9._-]+',
                        (ROOT / "journal/map/index.html").read_text()).group(0)

    markets = load_markets()
    if a.markets: markets = markets[:a.markets]
    seen_tiles, plan = set(), []
    for m in markets:
        for t in tiles_for(m["bbox"], tile_budget(m["n"])):
            if t not in seen_tiles:
                seen_tiles.add(t); plan.append(t)
    print(f"{len(markets)} markets, {len(plan)} unique z{Z} tiles to fetch")
    if a.dry: return

    from concurrent.futures import ThreadPoolExecutor
    out, t0, done = {}, time.time(), [0]

    def grab(t):
        x, y = t
        url = (f"https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/{Z}/{x}/{y}"
               f".vector.pbf?access_token={tok}")
        r = subprocess.run(["curl", "-s", "-m", "30", "--compressed",
                            "-H", "Referer: https://oftmw.com/", url],
                           capture_output=True)
        if r.returncode or not r.stdout: return t, []
        try: return t, mvt.read_layer(r.stdout)
        except Exception: return t, []

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
      for (x, y), feats in pool.map(grab, plan):
        done[0] += 1
        if done[0] % 250 == 0:
            print(f"  {done[0]}/{len(plan)} tiles · {len(out)} buildings · "
                  f"{time.time()-t0:.0f}s", flush=True)
        for props, rings, extent in feats:
            h = props.get("height")
            if not isinstance(h, (int, float)) or h < a.min_height: continue
            if str(props.get("extrude", "true")) == "false": continue
            ring = rings[0]
            if len(ring) < 4: continue
            ll = [mvt.to_lnglat(px, py, x, y, Z, extent) for px, py in ring]
            cx, cy, w, l, brg = box_of(ll)
            if w < 6 or l < 6 or w > 400 or l > 400: continue
            key = (round(cx, 5), round(cy, 5))
            if key in out and out[key][5] >= h: continue
            out[key] = [round(cx, 5), round(cy, 5), round(w), round(l),
                        round(brg), round(h)]
    rows = sorted(out.values(), key=lambda r: -r[5])
    # A refresh runs unattended on a schedule. If a bad token, an API outage or
    # a network fault starves the harvest, writing the result would quietly
    # replace a good city with an empty one — so refuse to shrink sharply.
    if OUT.exists():
        try:
            prev = len(json.loads(OUT.read_text()))
        except Exception:
            prev = 0
        if prev and len(rows) < prev * 0.6:
            print(f"ABORT: harvested {len(rows)} buildings vs {prev} on file "
                  f"({len(rows)/prev:.0%}). Refusing to overwrite — rerun or "
                  f"pass --force-shrink if the drop is real.", file=sys.stderr)
            if not a.force_shrink:
                sys.exit(1)
    OUT.write_text(json.dumps(rows, separators=(",", ":")))
    print(f"\n{len(rows)} tall buildings -> {OUT} ({OUT.stat().st_size//1024} KB)")

if __name__ == "__main__":
    main()
