"""County reverse-geocoding for projects-flat.json.

We only store lat/lng per project. This stamps a `County` + `CountyState` on each
US project by a one-time point lookup against the US Census, via the free FCC
Area API (no key). Results are cached to county-cache.json so the build only ever
geocodes BRAND-NEW coordinates — there is no per-query call and, after the first
run, effectively no per-build network either. International projects (outside the
US Census) simply get an empty County and fall back to city-level handling.

Usage:
  python geocode_counties.py        # refresh the cache + stamp the committed
                                    # projects-flat.json copies (run after a fetch)
  from geocode_counties import enrich; enrich(flat)   # inline, in fetch_projects
"""
import json
import os
import time
import urllib.parse
import urllib.request

CACHE_PATH = 'county-cache.json'
FCC_URL = 'https://geo.fcc.gov/api/census/area'


def _key(lat, lon):
    return f"{round(float(lat), 4)},{round(float(lon), 4)}"


def _load_cache(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _geocode(lat, lon, timeout=8):
    """Return (county_name, state_code) for a point, or ('', '') on any miss/error."""
    try:
        qs = urllib.parse.urlencode({'lat': lat, 'lon': lon, 'censusYear': 2020, 'format': 'json'})
        with urllib.request.urlopen(f"{FCC_URL}?{qs}", timeout=timeout) as r:
            data = json.load(r)
        for row in (data.get('results') or []):
            cn = (row.get('county_name') or '').strip()
            if cn:
                return cn, (row.get('state_code') or '').strip()
    except Exception:
        pass
    return '', ''


def enrich(flat, cache_path=CACHE_PATH, sleep=0.1, verbose=True):
    """Stamp County + CountyState onto each row of `flat` (list of project dicts),
    using the cache and geocoding only coordinates we haven't seen. Best-effort:
    a network failure leaves a row's County empty, never raises."""
    cache = _load_cache(cache_path)
    new = 0
    for p in flat:
        lat, lon = p.get('Latitude'), p.get('Longitude')
        if not lat or not lon:
            p['County'] = ''
            p['CountyState'] = ''
            continue
        try:
            k = _key(lat, lon)
        except Exception:
            p['County'] = ''
            p['CountyState'] = ''
            continue
        if k not in cache:
            cn, sc = _geocode(lat, lon)
            cache[k] = {'county': cn, 'state': sc}
            new += 1
            if sleep:
                time.sleep(sleep)
        ent = cache.get(k) or {}
        p['County'] = ent.get('county', '') or ''
        p['CountyState'] = ent.get('state', '') or ''
    if new:
        try:
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump(cache, f, ensure_ascii=False, indent=0, sort_keys=True)
        except Exception:
            pass
    if verbose:
        stamped = sum(1 for p in flat if p.get('County'))
        print(f"  ✓ Counties: {stamped}/{len(flat)} stamped ({new} newly geocoded)")
    return flat


def main():
    for path in ['projects-flat.json', 'journal/map/projects-flat.json']:
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as f:
            flat = json.load(f)
        enrich(flat)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(flat, f, indent=2, ensure_ascii=False)
        print(f"  ✓ Wrote {path}")


if __name__ == '__main__':
    main()
