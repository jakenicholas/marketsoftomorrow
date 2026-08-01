#!/usr/bin/env python3
"""
Atlas Intelligence — data layer (Phase 1: supply pressure)
==========================================================

Computes the per-market SUPPLY PRESSURE surface (Atlas Intelligence spec §2/§3
Surface C) from pipeline data we already carry in projects-flat.json:

  journal/map/atlas-intel.json
    {
      generated_at, model, version,
      markets:  { <city-slug>: { score, level, windows[], ... } },
      projects: { <project-slug>: { market, half, score, level } }
    }

Design rules baked in (spec §0):
  - Provenance on every figure: a delivery dated only to a year, or flagged
    DeliverySpeculative, counts as "estimated"; month-dated counts "confirmed".
  - display_mode "public" on every field in this file — supply pressure is the
    public-safe surface (no pricing values live here). Pricing/velocity fields
    (§2a) arrive with the backfill phase and will carry "pro" display modes.
  - No listing prices anywhere in this layer.

Score model (supply-pressure-v1) — tunables below, deliberately transparent:
  A = near-term project density   min(1, projects_delivering_24mo / 8)
  B = near-term unit volume       min(1, units_delivering_24mo / 1500)
  C = window concentration        (max half-year window units / windowed units)
                                  damped by pipeline size min(1, units/600)
  score = round(100 * (0.42*A + 0.40*B + 0.18*C))
  0-39 Balanced · 40-69 Elevated · 70-100 Saturated

Run:  python3 generate_atlas_intel.py
Hooked into the pages workflow before generate_market_pages.py (which imports
compute_all() directly so pages and JSON can never disagree).
"""
from __future__ import annotations
import json, re, datetime, collections

MODEL_VERSION = "supply-pressure-v1"

# Forward pipeline = everything not yet open. Open/complete inventory is the
# market's standing stock, not incoming supply.
FORWARD_STATUSES = {"Announced", "Breaking Ground", "Under Construction", "Opening Soon"}

# Tunables (documented in module docstring)
P24_CEIL   = 8      # projects delivering within 24 months that maxes component A
U24_CEIL   = 1500   # units delivering within 24 months that maxes component B
CONC_DAMP  = 600    # pipeline units at which concentration carries full weight
W_PROJECTS, W_UNITS, W_CONC = 0.42, 0.40, 0.18
WINDOW_HALVES = 6   # forward half-year windows (36 months)
MIN_PIPELINE  = 2   # markets below this many forward projects get no score
SERIES_HALVES = 10  # horizon for the forward score trajectory (5 years)
SERIES_LOOK   = 4   # 24-month (4-half) lookahead re-applied at each point

LEVELS = [(40, "Balanced"), (70, "Elevated"), (101, "Saturated")]


def slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s-]+", "-", s).strip("-")
    return s


def inventory_of(p: dict) -> int:
    """Sellable inventory: residential units, else hotel keys."""
    for field in ("Units", "Keys"):
        raw = str(p.get(field) or "").replace(",", "").strip()
        if raw.isdigit() and int(raw) > 0:
            return int(raw)
    return 0


def delivery_half(p: dict):
    """(year, half:1|2, estimated:bool) from DeliveryDate 'YYYY-MM' | 'YYYY'.

    Year-only dates land in H2 (deliveries slip late, not early) and are
    flagged estimated, as is anything DeliverySpeculative.
    """
    raw = str(p.get("DeliveryDate") or "").strip()
    spec = str(p.get("DeliverySpeculative") or "").strip() in ("1", "true", "True")
    m = re.match(r"^(\d{4})-(\d{1,2})$", raw)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        return y, (1 if mo <= 6 else 2), spec
    m = re.match(r"^(\d{4})$", raw)
    if m:
        return int(m.group(1)), 2, True
    return None


def _half_label(y: int, h: int) -> str:
    return f"{y}H{h}"


def _halves_from(today: datetime.date, n: int):
    y, h = today.year, (1 if today.month <= 6 else 2)
    out = []
    for _ in range(n):
        out.append((y, h))
        y, h = (y, 2) if h == 1 else (y + 1, 1)
    return out


def level_of(score: int) -> str:
    for ceil, name in LEVELS:
        if score < ceil:
            return name
    return "Saturated"


def compute_all(projects: list[dict], today: datetime.date | None = None) -> dict:
    today = today or datetime.date.today()
    horizon = _halves_from(today, WINDOW_HALVES)
    horizon_idx = {yh: i for i, yh in enumerate(horizon)}

    by_city: dict[str, list[dict]] = collections.defaultdict(list)
    for p in projects:
        if (p.get("Delivery") or "").strip() not in FORWARD_STATUSES:
            continue
        city = (p.get("City") or "").strip()
        if not city:
            continue
        by_city[city].append(p)

    markets, proj_out = {}, {}
    for city, plist in by_city.items():
        if len(plist) < MIN_PIPELINE:
            continue
        cslug = slugify(city)
        windows = [{"half": _half_label(y, h), "projects": 0, "units": 0} for (y, h) in horizon]
        undated, estimated_dated, dated = 0, 0, 0
        with_inv = 0
        p24 = u24 = 0
        total_units = 0
        later = {"projects": 0, "units": 0}   # dated beyond the horizon

        for p in plist:
            inv = inventory_of(p)
            total_units += inv
            if inv:
                with_inv += 1
            dh = delivery_half(p)
            if not dh:
                undated += 1
            else:
                y, h, est = dh
                dated += 1
                if est:
                    estimated_dated += 1
                idx = horizon_idx.get((y, h))
                if idx is None:
                    if (y, h) > horizon[-1]:
                        later["projects"] += 1
                        later["units"] += inv
                    else:  # past-dated but still not open → counts nearest window
                        idx = 0
                if idx is not None:
                    windows[idx]["projects"] += 1
                    windows[idx]["units"] += inv
                    if idx < 4:  # first four halves ≈ 24 months
                        p24 += 1
                        u24 += inv

        windowed_units = sum(w["units"] for w in windows)
        conc = (max(w["units"] for w in windows) / windowed_units) if windowed_units else 0.0
        a = min(1.0, p24 / P24_CEIL)
        b = min(1.0, u24 / U24_CEIL)
        c = conc * min(1.0, total_units / CONC_DAMP)
        score = round(100 * (W_PROJECTS * a + W_UNITS * b + W_CONC * c))
        score = max(0, min(100, score))

        # Forward trajectory: the SAME score model evaluated at each half-year
        # reference point, sliding the 24-month (4-half) lookahead across a
        # longer horizon. It's an honest forward view of how saturation evolves
        # given the known delivery schedule (it climbs as a wave of deliveries
        # approaches and eases after it lands), not reconstructed history. Point
        # zero is pinned to the published headline score so "now" always agrees.
        horizon_s = _halves_from(today, SERIES_HALVES)
        hidx_s = {yh: i for i, yh in enumerate(horizon_s)}
        sw_u = [0] * SERIES_HALVES
        sw_p = [0] * SERIES_HALVES
        for p in plist:
            dh = delivery_half(p)
            if not dh:
                continue
            yy, hh, _ = dh
            idx = hidx_s.get((yy, hh))
            if idx is None:
                if (yy, hh) > horizon_s[-1]:
                    continue
                idx = 0  # past-dated but not open → nearest window
            sw_u[idx] += inventory_of(p)
            sw_p[idx] += 1
        series = []
        for j in range(0, SERIES_HALVES - SERIES_LOOK + 1):
            seg_u = sw_u[j:j + SERIES_LOOK]
            seg_p = sw_p[j:j + SERIES_LOOK]
            uj, pj = sum(seg_u), sum(seg_p)
            concj = (max(seg_u) / uj) if uj else 0.0
            aj = min(1.0, pj / P24_CEIL)
            bj = min(1.0, uj / U24_CEIL)
            cj = concj * min(1.0, total_units / CONC_DAMP)
            sj = max(0, min(100, round(100 * (W_PROJECTS * aj + W_UNITS * bj + W_CONC * cj))))
            series.append({"half": _half_label(*horizon_s[j]), "score": sj})
        if series:
            series[0]["score"] = score

        dated_share = dated / len(plist)
        inv_share = with_inv / len(plist)
        if dated_share >= 0.75 and inv_share >= 0.6 and len(plist) >= 4:
            confidence = "high"
        elif dated_share < 0.5 or len(plist) < 3:
            confidence = "low"
        else:
            confidence = "medium"

        # Geography for filter-aware + globally-diverse rendering: state code
        # for US markets (CountyState), country otherwise.
        st_c = collections.Counter((p.get("CountyState") or "").strip() for p in plist if (p.get("CountyState") or "").strip())
        co_c = collections.Counter((p.get("Country") or "").strip() for p in plist if (p.get("Country") or "").strip())
        state = st_c.most_common(1)[0][0] if st_c else ""
        country = co_c.most_common(1)[0][0] if co_c else ""
        region = state if country == "United States" and state else (country or city)

        markets[cslug] = {
            "city": city,
            "state": state,
            "country": country,
            "region": region,
            "score": score,
            "level": level_of(score),
            "pipeline_projects": len(plist),
            "pipeline_units": total_units,
            "delivering_24mo": {"projects": p24, "units": u24},
            "windows": windows,
            "score_series": series,
            "later": later,
            "undated_projects": undated,
            "confidence": confidence,
            "provenance": {
                "supply_source": "pipeline",
                "dated_share": round(dated_share, 2),
                "estimated_share": round((estimated_dated / dated), 2) if dated else 1.0,
            },
            "display_mode": "public",
        }

        for p in plist:
            dh = delivery_half(p)
            proj_out[p.get("Slug") or slugify(p.get("Title") or "")] = {
                "market": cslug,
                "half": _half_label(dh[0], dh[1]) if dh else None,
                "estimated": (dh[2] if dh else True),
                "score": score,
                "level": level_of(score),
                "display_mode": "public",
            }

    return {
        "generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": MODEL_VERSION,
        "thresholds": {"balanced_below": 40, "elevated_below": 70},
        "markets": markets,
        "projects": proj_out,
    }


def main():
    # Root copy first — in the pages workflow it's the freshly-fetched data
    # (the journal/map/ copy is refreshed later, at commit time).
    import os
    src = "projects-flat.json" if os.path.exists("projects-flat.json") else "journal/map/projects-flat.json"
    projects = json.load(open(src))
    out = compute_all(projects)
    for path in ("journal/map/atlas-intel.json",):
        with open(path, "w") as f:
            json.dump(out, f, separators=(",", ":"))
    top = sorted(out["markets"].items(), key=lambda kv: -kv[1]["score"])[:12]
    print(f"atlas-intel: {len(out['markets'])} markets, {len(out['projects'])} pipeline projects")
    for slug, m in top:
        print(f"  {m['score']:>3} {m['level']:<10} {m['city']:<28} "
              f"{m['pipeline_projects']}p/{m['pipeline_units']}u · 24mo {m['delivering_24mo']['projects']}p/{m['delivering_24mo']['units']}u · conf {m['confidence']}")


if __name__ == "__main__":
    main()
