#!/usr/bin/env python3
"""
build_skyline_massings.py — multi-piece massing specs for the Future Skyline.

Project descriptions already encode massing ("66-story South Tower ...
34-story North Tower ... shared podium", "two 30-story towers"). This pass
parses them and lays the pieces out on the project's real parcel (from
skyline-footprints.json), producing podium + tower extrusions the map can
render with true bases and heights.

Output journal/map/skyline-massings.json:
  slug -> [ {"ring": [[lng,lat],...], "base": m, "top": m}, ... ]
A massing spec OVERRIDES the single-footprint render for that project.
Only multi-tower (or tower+podium) projects get a spec — single towers are
already right. Hand-edit any entry to override the parser; re-runs keep
edits only if you protect them (parser output is regenerated wholesale).

Run: python3 tools/build_skyline_massings.py
"""
import json, math, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FLAT = ROOT / "journal/map/projects-flat.json"
FOOT = ROOT / "journal/map/skyline-footprints.json"
OUT  = ROOT / "journal/map/skyline-massings.json"

FLOOR_M = 3.35
NUM = {"two": 2, "twin": 2, "three": 3, "four": 4}

def parse_text(t):
    """Return (tower_floor_list, podium_floors) parsed from one text."""
    t = re.sub(r"[‐-―]", "-", str(t or "").lower())
    towers = []
    # "two 30-story towers" / "twin 24-storey towers" — consume so the
    # single-tower pattern below can't double count the same span.
    def eat(m):
        towers.extend([int(m.group(2))] * NUM[m.group(1)])
        return " "
    t = re.sub(r"\b(two|twin|three|four)\s+(\d{1,3})[- ]stor(?:y|ey|ies)\s+towers?", eat, t)
    # "towers rising 30 and 40 stories" / "towers of 26 and 32 stories"
    def eat2(m):
        towers.extend([int(m.group(1)), int(m.group(2))])
        return " "
    t = re.sub(r"towers[^.]{0,50}?\b(\d{1,3})\s+and\s+(\d{1,3})[- ]stor(?:y|ey|ies)", eat2, t)
    # "66-story south tower", "34-story residential tower"
    for m in re.finditer(r"\b(\d{1,3})[- ]stor(?:y|ey|ies)\s+(?:[a-z]+\s+){0,2}tower", t):
        towers.append(int(m.group(1)))
    podium = 0
    m = re.search(r"\b(\d{1,2})[- ]stor(?:y|ey|ies)\s+(?:[a-z]+\s+){0,2}podium", t)
    if m:
        podium = int(m.group(1))
    towers = [v for v in towers if 3 <= v <= 130]
    return towers, podium

def metres(lat0):
    return 111320.0, 111320.0 * math.cos(math.radians(lat0))

def ring_metrics(ring):
    """centroid, principal bearing (deg cw from N of longest edge, mod 180),
    and extents (L along axis, W across) in metres."""
    lat0 = ring[0][1]
    mlat, mlng = metres(lat0)
    cx = sum(p[0] for p in ring[:-1]) / (len(ring) - 1)
    cy = sum(p[1] for p in ring[:-1]) / (len(ring) - 1)
    best, brg = 0, 0.0
    for i in range(len(ring) - 1):
        dx = (ring[i+1][0] - ring[i][0]) * mlng
        dy = (ring[i+1][1] - ring[i][1]) * mlat
        if dx*dx + dy*dy > best:
            best, brg = dx*dx + dy*dy, math.degrees(math.atan2(dx, dy)) % 180
    ur = math.radians(brg)
    ux, uy = math.sin(ur), math.cos(ur)          # along axis (east, north)
    vx, vy = -uy, ux                              # across
    us, vs = [], []
    for p in ring[:-1]:
        ex, ey = (p[0] - cx) * mlng, (p[1] - cy) * mlat
        us.append(ex*ux + ey*uy); vs.append(ex*vx + ey*vy)
    return (cx, cy), brg, (max(us) - min(us)), (max(vs) - min(vs))

def area_m2(ring):
    lat0 = ring[0][1]
    mlat, mlng = metres(lat0)
    pts = [((x - ring[0][0]) * mlng, (y - ring[0][1]) * mlat) for x, y in ring]
    return abs(sum(pts[i][0]*pts[i+1][1] - pts[i+1][0]*pts[i][1] for i in range(len(pts)-1))) / 2

def contains(ring, lng, lat):
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]; x2, y2 = ring[i+1]
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside

def rect_ring(center, w, l, bearing):
    """w across, l along bearing (deg cw from N), centred on (lng,lat)."""
    mlat, mlng = metres(center[1])
    ur = math.radians(bearing)
    ux, uy = math.sin(ur), math.cos(ur)
    vx, vy = -uy, ux
    pts = []
    for su, sv in ((-1,-1),(1,-1),(1,1),(-1,1)):
        ex = su*(l/2)*ux + sv*(w/2)*vx
        ey = su*(l/2)*uy + sv*(w/2)*vy
        pts.append([round(center[0] + ex/mlng, 6), round(center[1] + ey/mlat, 6)])
    pts.append(pts[0])
    return pts

def main():
    data = json.loads(FLAT.read_text())
    recs = data if isinstance(data, list) else data.get("projects", data)
    foot = json.loads(FOOT.read_text()) if FOOT.exists() else {}
    out = {}
    for p in recs:
        slug = p.get("Slug", "")
        lat, lng = p.get("Latitude"), p.get("Longitude")
        if not slug or not lat or not lng:
            continue
        # Parse each text separately (long description repeats the short one —
        # concatenating would double count); keep the richest parse.
        towers, podium = [], 0
        for src in (p.get("DescriptionLong"), p.get("Description"), p.get("ConfigSummary")):
            tw, po = parse_text(src)
            if len(tw) > len(towers):
                towers = tw
            podium = podium or po
        towers = sorted(towers, reverse=True)[:3]
        if len(towers) < 2 and not (towers and podium):
            continue                                # single towers are already right
        try:
            gfa = float(p.get("GfaSqFt") or 0)
        except (TypeError, ValueError):
            gfa = 0
        center = (float(lng), float(lat))
        fp = foot.get(slug)
        # Shared tower plate from GFA spread over total floors (typical twin
        # towers share a plate size); sensible default when GFA is unknown.
        plate = max(400, min(2200, (gfa * 0.0929) / max(1, sum(towers)))) if gfa > 0 else 850
        k = len(towers)
        if isinstance(fp, list) and len(fp) > 3:
            ring = [list(x) for x in fp]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            (cx, cy), brg, L, W = ring_metrics(ring)
            parcel = ring
            parcel_area = area_m2(ring)
        else:
            brg = 0
            if isinstance(fp, (int, float)):
                brg = fp
            elif isinstance(fp, list) and len(fp) == 3 and not isinstance(fp[0], list):
                brg = fp[0]
                center = (fp[1], fp[2])          # land anchor: nearest building's centroid
            parcel_area = max(2.2 * plate * k, 1600)
            W = math.sqrt(parcel_area / 1.6); L = W * 1.6
            cx, cy = center
            parcel = rect_ring(center, W, L, brg)
        pieces = []
        base = 0
        if podium:
            pieces.append({"ring": parcel, "base": 0, "top": round(podium * FLOOR_M)})
            base = round(podium * FLOOR_M)
        elif parcel_area >= 2 * plate * k:
            # No stated podium but the parcel dwarfs the tower plates: a low
            # plinth shows the true site coverage under the towers.
            pieces.append({"ring": parcel, "base": 0, "top": 7})
        # Tower plates along the parcel's long axis.
        w = math.sqrt(plate / 1.3); l = w * 1.3
        l = min(l, 0.42 * L) if L > 0 else l
        w = min(w, 0.80 * W) if W > 0 else w
        offs = {1: [0], 2: [-0.24, 0.24], 3: [-0.3, 0, 0.3]}[k]
        mlat, mlng = metres(cy)
        ur = math.radians(brg)
        ux, uy = math.sin(ur), math.cos(ur)
        for fl, off in zip(towers, offs):
            top = round(fl * FLOOR_M)
            if top <= base:
                continue
            c = (cx, cy)
            for frac in (1.0, 0.5, 0.0):
                cand = (cx + off * frac * L * ux / mlng, cy + off * frac * L * uy / mlat)
                if contains(parcel, cand[0], cand[1]):
                    c = cand
                    break
            pieces.append({"ring": rect_ring(c, w, l, brg), "base": base, "top": top})
        if len(pieces) >= 2:
            out[slug] = pieces
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(out)} multi-piece massings written to {OUT} ({OUT.stat().st_size // 1024} KB)")
    for s in list(out)[:12]:
        print(" ", s, "->", len(out[s]), "pieces,",
              " + ".join(f"{pc['base']}-{pc['top']}m" for pc in out[s]))

if __name__ == "__main__":
    main()
