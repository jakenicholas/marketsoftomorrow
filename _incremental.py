#!/usr/bin/env python3
"""
Incremental-build helper for the map/pages pipeline.

On a project-save rebuild (repository_dispatch: rebuild-map) the workflow sets
TMW_INCREMENTAL=true. In that mode the page generators only re-render the items
that actually changed vs the previously committed projects-flat.json — the whole
DB no longer gets rebuilt on every single project save.

When TMW_INCREMENTAL is unset/false (the hourly + manual full runs) every helper
returns "full build" sentinels, so those runs behave exactly as before.

The previous state comes from `git show HEAD:projects-flat.json` (the last
committed snapshot). If git/history isn't available for any reason we fall back
to a full build — never a partial one on a bad diff.
"""

import os
import json
import subprocess


def is_incremental():
    return os.environ.get('TMW_INCREMENTAL', '').strip().lower() in ('1', 'true', 'yes')


def _row_key(r):
    # Stable identity for a project row: curated Slug if present, else Title.
    return (r.get('Slug') or '').strip() or (r.get('Title') or '').strip()


def previous_projects():
    """Prior committed projects-flat.json as a list, or None if unavailable."""
    try:
        r = subprocess.run(['git', 'show', 'HEAD:projects-flat.json'],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0 or not r.stdout.strip():
            return None
        data = json.loads(r.stdout)
        return data if isinstance(data, list) else None
    except Exception:
        return None


def changed_and_removed(new_rows):
    """
    Returns (changed_rows, removed_rows):
      - changed_rows: list of NEW row dicts that were added or edited since the
        last commit. None  => full build (incremental off / diff unavailable).
      - removed_rows: list of OLD row dicts that no longer exist (for cleanup).
    """
    if not is_incremental():
        return None, []
    old = previous_projects()
    if old is None:
        return None, []
    old_by = {_row_key(r): r for r in old if (r.get('Title') or '').strip()}
    new_by = {_row_key(r): r for r in new_rows if (r.get('Title') or '').strip()}
    changed = [v for k, v in new_by.items() if old_by.get(k) != v]
    removed = [old_by[k] for k in (set(old_by) - set(new_by))]
    return changed, removed


def expand_families(seed_slugs, rows):
    """
    Grow a set of changed row-Slugs to include each one's family (parent +
    children + siblings), since a project page cross-references its family. Keyed
    on the hierarchy Slug field (ParentSlug points at a Slug).
    """
    seed = set(s for s in seed_slugs if s)
    by_slug = {}
    kids_by_parent = {}
    for r in rows:
        s = (r.get('Slug') or '').strip()
        if s:
            by_slug[s] = r
        p = (r.get('ParentSlug') or '').strip()
        if p:
            kids_by_parent.setdefault(p, []).append(s)
    out = set(seed)
    for s in list(seed):
        r = by_slug.get(s)
        if not r:
            continue
        parent = (r.get('ParentSlug') or '').strip()
        if parent:
            out.add(parent)
            out.update(kids_by_parent.get(parent, []))   # siblings
        out.update(kids_by_parent.get(s, []))            # children
    return out
