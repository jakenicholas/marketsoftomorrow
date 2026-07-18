#!/usr/bin/env python3
"""
Atlas Intelligence — projection model (proj-psf-v1)
===================================================

Turns collected raw inputs (§2a of the build spec) into the modeled fields
(§2b): projected PSF at delivery with a confidence band, comp set, absorption
pace, sell-out months, and bear/base/bull scenario objects.

Brand rules enforced here:
  - `list_psf_observed` feeds the model and is NEVER copied into model output.
    Comp rows expose a comp's MODELED current PSF (rounded to $10), labeled
    modeled — not its raw asking price.
  - No projection is produced with fewer than MIN_COMPS comparables — the
    caller renders the "modeling in progress" empty state instead (§0.2).

Model v1 (transparent, tunables below):
  comp_base_psf   = median of comp observed PSF, each appreciated from its
                    observation vintage to today at APPR_BASE
  proj_psf        = comp_base_psf appreciated to the delivery date
  band            = ±10% (±8% with 6+ comps)
  absorption      = actual pace when pct_sold+launch known, else the comp-set
                    median pace scaled to the project's unit count
  scenarios       = base/bull/bear on appreciation + pace multipliers
  confidence      = high: 6+ comps AND (pct_sold or 5+ comps month-dated)
                    medium: 3-5 comps · low: never rendered (empty state)
"""
from __future__ import annotations
import datetime, math

MIN_COMPS   = 3
MAX_COMPS   = 6
COMP_MILES  = 9.0     # comp search radius
APPR = {"base": 0.07, "bull": 0.11, "bear": 0.03}   # annual comp appreciation
PACE_MULT = {"base": 1.0, "bull": 1.45, "bear": 0.70}
SCENARIO_ASSUMPTIONS = {
    "base": {"rate": "Hold, easing into '27", "supply": None, "demand": "Steady",  "appr": "+7% / yr"},
    "bull": {"rate": "Cuts begin H1 '27",     "supply": None, "demand": "Strong",  "appr": "+11% / yr"},
    "bear": {"rate": "Higher for longer",     "supply": None, "demand": "Soft",    "appr": "+3% / yr"},
}
DEFAULT_PACE_PER_100 = 2.6   # units/month per 100 units when no comp pace exists


def _miles(lat1, lng1, lat2, lng2):
    try:
        lat1, lng1, lat2, lng2 = map(float, (lat1, lng1, lat2, lng2))
    except (TypeError, ValueError):
        return None
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _median(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n: return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _ym_to_date(s, day=15):
    if not s: return None
    s = str(s).strip()
    try:
        if len(s) == 4: return datetime.date(int(s), 12, 15)     # year-only → late-year
        y, m = s.split("-")[:2]
        return datetime.date(int(y), int(m), day)
    except Exception:
        return None


def _years_between(d1, d2):
    return max(0.0, (d2 - d1).days / 365.25)


def _quarter_label(d):
    return f"Q{(d.month - 1)//3 + 1} {d.year}" if d else None


def actual_pace(raw):
    """Observed units/month from pct_sold + launch date, else None."""
    pct, launch = raw.get("pct_sold"), _ym_to_date(raw.get("sales_launch_date"), 1)
    units = raw.get("unit_count")
    asof = _ym_to_date(raw.get("pct_sold_asof")) or datetime.date.today()
    if pct is None or not launch or not units: return None
    months = max(1.0, (asof - launch).days / 30.44)
    return (float(pct) / 100.0 * int(units)) / months


def build_projection(slug, raw, all_raw, geo, today=None):
    """raw = this project's §2a inputs; all_raw = {slug: raw} for comp search;
    geo = {slug: {lat, lng, city, title, delivery, status}} from projects-flat."""
    today = today or datetime.date.today()
    me = geo.get(slug) or {}
    my_psf = raw.get("list_psf_observed")

    # ── comp set: nearest observed-PSF projects within COMP_MILES ──
    cands = []
    for cslug, craw in all_raw.items():
        if cslug == slug: continue
        cpsf = craw.get("list_psf_observed")
        if not cpsf: continue
        cg = geo.get(cslug) or {}
        d = _miles(me.get("lat"), me.get("lng"), cg.get("lat"), cg.get("lng"))
        if d is None or d > COMP_MILES: continue
        cands.append((d, cslug, craw, cg))
    cands.sort(key=lambda x: x[0])
    comps = cands[:MAX_COMPS]
    if len(comps) < MIN_COMPS:
        return None   # empty state — never a naked number

    # ── comp base PSF, appreciated from each comp's vintage to today ──
    adj = []
    for d, cslug, craw, cg in comps:
        vintage = _ym_to_date(craw.get("pct_sold_asof")) or _ym_to_date(craw.get("sales_launch_date"), 1) or today
        yrs = _years_between(vintage, today)
        adj.append(float(craw["list_psf_observed"]) * ((1 + APPR["base"]) ** yrs))
    comp_base = _median(adj)

    delivery = _ym_to_date(raw.get("delivery_est")) or _ym_to_date(me.get("delivery"))
    yrs_out = _years_between(today, delivery) if delivery else 1.5

    band_pct = 0.08 if len(comps) >= 6 else 0.10
    units = raw.get("unit_count")
    pace_actual = actual_pace(raw)
    comp_paces = [p for p in (actual_pace(c[2]) for c in comps) if p]
    # pace scales with project size: comp median pace per-100-units × my units
    pace_base = pace_actual
    pace_modeled = False
    if pace_base is None:
        pace_modeled = True
        if comp_paces and units:
            per100 = _median([p / max(1, int((c[2].get("unit_count") or 100))) * 100
                              for p, c in zip(comp_paces, comps)])
            pace_base = per100 / 100.0 * int(units)
        elif units:
            pace_base = DEFAULT_PACE_PER_100 / 100.0 * int(units)

    month_dated = sum(1 for _, _, c, _ in comps
                      if c.get("pct_sold_asof") or c.get("sales_launch_date"))
    if len(comps) >= 6 and (raw.get("pct_sold") is not None or month_dated >= 5):
        confidence = "high"
    else:
        confidence = "medium"

    scenarios = {}
    for s in ("base", "bull", "bear"):
        psf = comp_base * ((1 + APPR[s]) ** yrs_out)
        pace = (pace_base or 0) * PACE_MULT[s]
        remaining = None
        if units:
            sold = (raw.get("pct_sold") or 0) / 100.0 * int(units)
            remaining = max(0, int(units) - sold)
        sellout = round(remaining / pace) if (remaining and pace) else None
        a = dict(SCENARIO_ASSUMPTIONS[s])
        scenarios[s] = {
            "psf": round(psf / 10) * 10,
            "band": [round(psf * (1 - band_pct) / 10) * 10, round(psf * (1 + band_pct) / 10) * 10],
            "pace": round(pace, 1) if pace else None,
            "sellout_months": sellout,
            "assumptions": a,
        }

    base = scenarios["base"]
    delta_vs_launch = None
    if my_psf:
        delta_vs_launch = round((base["psf"] / float(my_psf) - 1) * 100)
        # Observed PSFs are entry/mid estimates from different vintages; a
        # delta beyond ±35% says the basis is unreliable (ultra-premium
        # outlier vs comp median, or stale launch pricing) — suppress rather
        # than render a misleading number (§0.2: no naked numbers).
        if abs(delta_vs_launch) > 35:
            delta_vs_launch = None

    comp_rows = []
    for d, cslug, craw, cg in comps:
        vintage = _ym_to_date(craw.get("pct_sold_asof")) or _ym_to_date(craw.get("sales_launch_date"), 1) or today
        yrs = _years_between(vintage, today)
        modeled_now = round(float(craw["list_psf_observed"]) * ((1 + APPR["base"]) ** yrs) / 10) * 10
        pct = craw.get("pct_sold")
        status = craw.get("sales_status") or ""
        smeta = ("sold out" if status == "delivered" or (pct or 0) >= 97
                 else f"{round(pct)}% sold" if pct is not None else (status or "selling"))
        comp_rows.append({
            "slug": cslug, "title": (cg.get("title") or cslug),
            "miles": round(d, 1), "meta": smeta, "psf_modeled": modeled_now,
        })

    return {
        "model": "proj-psf-v1",
        "proj_psf_delivery": base["psf"],
        "proj_psf_band": base["band"],
        "band_pct": band_pct,
        "delta_vs_launch_pct": delta_vs_launch,
        "delivery_label": _quarter_label(delivery),
        "confidence": confidence,
        "comp_count": len(comps),
        "comp_set": [c["slug"] for c in comp_rows],
        "comps": comp_rows,
        "absorption_pace": round(pace_base, 1) if pace_base else None,
        "absorption_modeled": pace_modeled,
        "sellout_months": base["sellout_months"],
        "unit_count": units,
        "scenarios": scenarios,
        "proj_psf_source": "modeled",
        "computed_at": today.isoformat(),
    }
