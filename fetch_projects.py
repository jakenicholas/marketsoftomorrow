#!/usr/bin/env python3
"""
TMW Projects Fetcher + Flattener
---------------------------------
Step 0 of the nightly/hourly map pipeline.

Fetches data/projects.json from the private tmw-data repo (via GitHub API
authenticated with TMW_DATA_TOKEN) and writes projects-flat.json to the
local repo root. The flat file matches the CSV column shape the rest of
the pipeline (generate_pages.py, generate_pulse.py, generate_intel.py,
index.html) already expects -- so each downstream consumer changes only
the fetch step, not the parsing step.

This file is the single source of truth for the rich-JSON -> CSV-shape
schema translation. Update it here if the tmw-data JSON schema ever
changes.

Required environment variables (set in GitHub Actions secrets):
  TMW_DATA_TOKEN  - GitHub PAT with repo:read scope on tmw-data

Output: projects-flat.json (JSON array of CSV-shaped dicts)

Run: python3 fetch_projects.py
"""

import json
import os
import sys
import urllib.request
import urllib.error

# --- CONFIG -----------------------------------------------------------------
# Private repo location. The Contents API returns the file content (base64-
# encoded for binary, raw for text-ish responses when Accept header is set
# to application/vnd.github.raw). We use raw so we get the file bytes
# directly without a base64 decode step.
TMW_DATA_OWNER = 'jakenicholas'
TMW_DATA_REPO = 'tmw-data'
TMW_DATA_REF = 'main'  # branch

PROJECTS_PATH = 'data/projects.json'
ARCHITECTS_PATH = 'data/architects.json'
DEVELOPERS_PATH = 'data/developers.json'

OUTPUT_PATH = 'projects-flat.json'
OUTPUT_FIRMS_PATH = 'firms-flat.json'  # raw architect + developer records for firm pages

TOKEN = os.environ.get('TMW_DATA_TOKEN', '').strip()
if not TOKEN:
    print("ERROR: TMW_DATA_TOKEN environment variable is required.", file=sys.stderr)
    print("Generate a PAT at github.com/settings/tokens with `repo` read scope", file=sys.stderr)
    print("on the private tmw-data repo, then add it as a workflow secret.", file=sys.stderr)
    sys.exit(1)


# --- STATUS MAPPING ---------------------------------------------------------
# tmw-data uses lowercase slug-like status values. Map them to the
# human-readable strings the rest of the pipeline already recognizes
# (see normalize_status() in generate_pulse.py for the canonical buckets).
STATUS_MAP = {
    'open':             'Now Open',
    'coming-soon':      'Opening Soon',
    'construction':     'Under Construction',
    'breaking-ground':  'Breaking Ground',
    'announced':        'Announced',
}

def map_status(raw: str) -> str:
    """tmw-data status -> CSV-shape Delivery string."""
    key = (raw or '').strip().lower()
    if key in STATUS_MAP:
        return STATUS_MAP[key]
    # Fallback: title-case the raw value so unknown statuses are still
    # human-readable. The downstream normalize_status() will bucket them
    # to 'announced' if it can't recognize them.
    return (raw or '').replace('-', ' ').title()


# --- SLUG -> DISPLAY NAME ---------------------------------------------------
# Architect/developer display names come from tmw-data's architects.json and
# developers.json (which carry the canonical names like 'Robert A.M. Stern
# Architects' or 'Foster + Partners' with proper punctuation). We build a
# slug->name dict at startup and pass it to flatten().
#
# Only fall back to unslug() if a slug isn't in the lookup (defensive — would
# indicate stale project data referencing a deleted firm). Acronyms then come
# out as 'Ramsa' which is ugly, hence the lookup.
def unslug(slug: str) -> str:
    """Best-effort kebab-case slug -> display name conversion (fallback only)."""
    if not slug:
        return ''
    parts = slug.replace('-', ' ').split()
    out = []
    small = {'and', 'of', 'the', 'a', 'an', 'in', 'on', 'at', 'for'}
    for i, w in enumerate(parts):
        if i > 0 and w.lower() in small:
            out.append(w.lower())
        else:
            out.append(w.capitalize())
    return ' '.join(out)


def lookup_name(slug: str, name_map: dict) -> str:
    """slug -> canonical display name, with unslug() fallback if not found."""
    if not slug:
        return ''
    return name_map.get(slug) or unslug(slug)


# --- TRANSFORMATION ---------------------------------------------------------
def _latest_update(record: dict) -> str:
    """Public "Last verified" stamp (ISO string) — the most recent time the
    project's data was checked or changed by the Studio/Claude flow. Takes the
    newest of status_checked_at and any status_history[].at. '' if none."""
    times = [str(record.get('status_checked_at') or '')]
    times += [str(h['at']) for h in (record.get('status_history') or [])
              if isinstance(h, dict) and h.get('at')]
    times = [t for t in times if t]
    return max(times) if times else ''


def flatten(record: dict, architect_names: dict, developer_names: dict) -> dict:
    """
    Convert a single tmw-data JSON record into the CSV-shape dict the
    existing pipeline expects. Keys mirror the Google Sheet column headers
    that generate_pages.py / generate_pulse.py / generate_intel.py read
    from row.get().

    Schema mapping (JSON key -> CSV-shape key):
      name                -> Title
      city                -> City
      lat                 -> Latitude
      lng                 -> Longitude
      description         -> Description
      description_long    -> DescriptionLong
      status              -> Delivery (via STATUS_MAP)
      delivery_date       -> DeliveryDate
      start_date          -> StartDate
      types[]             -> ProjectType (comma-joined)
      preferred_type      -> PreferredType
      architect_slugs[]   -> Architect (canonical name from architects.json, comma-joined)
                          -> ArchitectSlugs (slug list, comma-joined) — used by firm-page generator
      developer_slugs[]   -> Developer (canonical name from developers.json, comma-joined)
                          -> DeveloperSlugs (slug list, comma-joined) — used by firm-page generator
      featured            -> Featured ("Featured" or "")
      official_website    -> OfficialWebsite
      images[0..4]        -> ImageURL, Image2..Image5
      keys                -> Keys (hotel-room count, blank if absent) — TMW Intelligence scale signal
      units               -> Units (residential unit count, blank if absent) — TMW Intelligence scale signal
      floors              -> Floors (tower height proxy, blank if absent)
      (no source)         -> Price (empty; existing code handles blanks)
    """
    images = record.get('images') or []
    types = record.get('types') or []
    arch_slugs = record.get('architect_slugs') or []
    dev_slugs = record.get('developer_slugs') or []

    # Coordinate fields: existing code reads them as strings and coerces
    # with `+p.Longitude` in JS / similar in Python. Stringify defensively
    # so a missing lat/lng comes through as '' rather than 'None'.
    lat = record.get('lat')
    lng = record.get('lng')
    lat_str = '' if lat is None else str(lat)
    lng_str = '' if lng is None else str(lng)

    # Scale fields — stringify integers, leave blank if missing. TMW Intelligence
    # uses these to score comparables by scale similarity (keys for hotels, units
    # for residential, floors as a tower-height proxy).
    def _num_str(v):
        if v is None or v == '':
            return ''
        try:
            return str(int(v))
        except (TypeError, ValueError):
            return ''

    return {
        'Title':           record.get('name', '') or '',
        # Canonical slug straight from projects.json — do NOT re-derive it from
        # the title downstream. ~6% of projects (and most RENAMED ones) carry a
        # slug unrelated to their current name (e.g. "Dutchman's Pipe" →
        # "inscription-west-palm-beach"). Carrying it lets the worker's
        # match_project / propose_project_edit reference the exact live record.
        'Slug':            record.get('slug', '') or '',
        'City':            record.get('city', '') or '',
        'Neighborhood':    record.get('neighborhood', '') or '',
        'Latitude':        lat_str,
        'Longitude':       lng_str,
        'Description':     record.get('description', '') or '',
        'DescriptionLong': record.get('description_long', '') or '',
        'Delivery':        map_status(record.get('status', '')),
        'DeliveryDate':    record.get('delivery_date', '') or '',
        'StartDate':       record.get('start_date', '') or '',
        'ProjectType':     ', '.join(types),
        'PreferredType':   record.get('preferred_type', '') or '',
        'Architect':       ', '.join(lookup_name(s, architect_names) for s in arch_slugs),
        'ArchitectSlugs':  ', '.join(arch_slugs),
        'Developer':       ', '.join(lookup_name(s, developer_names) for s in dev_slugs),
        'DeveloperSlugs':  ', '.join(dev_slugs),
        'Featured':        'Featured' if record.get('featured') else '',
        'OfficialWebsite': record.get('official_website', '') or '',
        'ImageURL':        images[0] if len(images) >= 1 else '',
        'Image2':          images[1] if len(images) >= 2 else '',
        'Image3':          images[2] if len(images) >= 3 else '',
        'Image4':          images[3] if len(images) >= 4 else '',
        'Image5':          images[4] if len(images) >= 5 else '',
        'Keys':            _num_str(record.get('keys')),
        'Units':           _num_str(record.get('units')),
        'Floors':          _num_str(record.get('floors')),
        # Optional one-line nuance fields — render when present, hidden otherwise.
        # `config_summary`  describes physical layout (multi-tower / multi-building)
        # `delivery_phases` describes staggered openings (phase 1 / phase 2 / etc)
        # Floors/DeliveryDate stay the canonical sortable numbers — these strings
        # add prose context the structured fields can't capture without ballooning
        # the schema.
        'ConfigSummary':   (record.get('config_summary') or '').strip(),
        'DeliveryPhases':  (record.get('delivery_phases') or '').strip(),
        # Flag: this project represents a district umbrella (Miami Worldcenter,
        # Wynwood Plaza, etc) — multiple buildings under one branded
        # development with shared retail/streetscapes. Districts have their
        # own delivery (when the public realm completes) but excluding them
        # from intel comparable pools prevents them from biasing other
        # projects' time-to-completion estimates. Read in generate_intel.py
        # by build_complete_index() which filters districts out of the
        # comparables index.
        'IsDistrict':       '1' if record.get('is_district') else '',
        # Per-date "TMW estimate" flags. Set independently in admin so a
        # project can have a developer-confirmed groundbreaking but a TMW-
        # guessed completion (or vice-versa). Drives the EST badge + softens
        # TMW Intelligence confidence in generate_intel.py.
        #
        # Back-compat: an older single `dates_speculative` flag flipped BOTH.
        # If a project still has only that legacy field set, treat it as
        # "both estimated" so the prior intent isn't silently dropped.
        'StartSpeculative':    '1' if (record.get('start_speculative')    or record.get('dates_speculative')) else '',
        'DeliverySpeculative': '1' if (record.get('delivery_speculative') or record.get('dates_speculative')) else '',
        # Aggregate flag (true when either date is speculative). Convenience
        # for the popup/modal "EST" badge — saves the frontend from OR-ing
        # the two granular fields. Granular ones still emitted above for
        # finer-grained handling in TMW Intelligence.
        'DatesSpeculative':    '1' if (record.get('start_speculative')
                                       or record.get('delivery_speculative')
                                       or record.get('dates_speculative')) else '',
        # Price isn't in the tmw-data schema yet. Existing _parse_price()
        # handles blank values gracefully (returns 0), so emitting '' is
        # safe. When tmw-data adds a price field, map it here.
        'Price':           '',
        # Public "Updated" stamp — latest change/verify time (ISO 8601 UTC).
        # Rendered above the timeline on project pages + the map modal.
        'UpdatedAt':       _latest_update(record),
        # Full sourced change log (status + date/spec edits). Carries each
        # entry's effective_date (when the milestone actually happened) so the
        # project-page dossier timeline can show event dates, not discovery dates.
        'StatusHistory':    record.get('status_history') or [],
    }


# --- FETCH ------------------------------------------------------------------
def fetch_data_file(path: str) -> list:
    """GET a file from tmw-data via GitHub API. Returns parsed JSON.

    Used for projects.json, architects.json, developers.json. All three are
    JSON arrays of records, so the return type is uniformly `list`.
    """
    url = (
        f"https://api.github.com/repos/{TMW_DATA_OWNER}/{TMW_DATA_REPO}/"
        f"contents/{path}?ref={TMW_DATA_REF}"
    )
    req = urllib.request.Request(url, headers={
        # `application/vnd.github.raw` gives us the file body directly --
        # no base64 wrapper to decode. This works for files up to 100MB.
        'Accept': 'application/vnd.github.raw',
        'Authorization': f'Bearer {TOKEN}',
        'User-Agent': 'TMW-Map-Pipeline/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', errors='replace')
        except Exception:
            pass
        print(f"ERROR: GitHub API returned {e.code} for {path}: {e.reason}", file=sys.stderr)
        if body:
            print(f"Response body: {body[:500]}", file=sys.stderr)
        if e.code == 401:
            print("Token is invalid or expired. Regenerate the PAT.", file=sys.stderr)
        elif e.code == 404:
            print(f"File not found: {path}. Check owner/repo/path constants.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: fetch failed for {path}: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        parsed = json.loads(data)
    except json.JSONDecodeError as e:
        print(f"ERROR: {path} wasn't valid JSON: {e}", file=sys.stderr)
        print(f"First 200 chars: {data[:200]}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(parsed, list):
        print(f"ERROR: expected a JSON array in {path}, got {type(parsed).__name__}", file=sys.stderr)
        sys.exit(1)

    return parsed


def build_name_map(records: list, label: str) -> dict:
    """Build slug -> display name lookup from a tmw-data records list."""
    out = {}
    for r in records:
        if not isinstance(r, dict):
            continue
        slug = (r.get('slug') or '').strip()
        name = (r.get('name') or '').strip()
        if slug and name:
            out[slug] = name
    print(f"  ✓ Loaded {len(out)} {label} name(s)")
    return out


# --- MAIN -------------------------------------------------------------------
def main():
    print("Fetching from tmw-data...")
    records = fetch_data_file(PROJECTS_PATH)
    print(f"  ✓ Fetched {len(records)} projects")
    architect_records = fetch_data_file(ARCHITECTS_PATH)
    developer_records = fetch_data_file(DEVELOPERS_PATH)

    architect_names = build_name_map(architect_records, 'architect')
    developer_names = build_name_map(developer_records, 'developer')

    print("Flattening to CSV-shape schema...")
    flat = []
    skipped = 0
    for r in records:
        if not isinstance(r, dict):
            skipped += 1
            continue
        if not (r.get('name') or '').strip():
            # Skip records without a title -- mirrors the existing
            # `if r.get('Title','').strip()` filter in generate_pages.py.
            skipped += 1
            continue
        flat.append(flatten(r, architect_names, developer_names))
    print(f"  ✓ Flattened {len(flat)} records ({skipped} skipped)")

    print(f"Writing {OUTPUT_PATH}...")
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(flat, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Wrote {OUTPUT_PATH}")

    # Also write the raw architect + developer records so the firm-page
    # generator (generate_firm_pages.py) doesn't have to re-fetch them.
    firms_payload = {
        'architects': architect_records,
        'developers': developer_records,
    }
    print(f"Writing {OUTPUT_FIRMS_PATH}...")
    with open(OUTPUT_FIRMS_PATH, 'w', encoding='utf-8') as f:
        json.dump(firms_payload, f, indent=2, ensure_ascii=False)
    print(f"  ✓ Wrote {OUTPUT_FIRMS_PATH} "
          f"({len(architect_records)} architects, {len(developer_records)} developers)")

    # Diagnostics: distribution of mapped statuses so a status-mapping
    # regression is visible in workflow logs without having to diff the
    # output file by hand.
    status_counts = {}
    for r in flat:
        status_counts[r['Delivery']] = status_counts.get(r['Delivery'], 0) + 1
    print("Status distribution:")
    for st, n in sorted(status_counts.items(), key=lambda x: -x[1]):
        print(f"  {n:4d}  {st}")

    print(" Done.")

if __name__ == '__main__':
    main()
