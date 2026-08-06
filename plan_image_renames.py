#!/usr/bin/env python3
"""
plan_image_renames.py — DRY RUN. Derives SEO-friendly R2 keys for every project
image from page info (city folder + project-slug filename) and writes a review
map. Touches NOTHING in R2 or D1 — it only reads projects-flat.json and emits
image-rename-map.json for approval before any server-side copy/D1 update runs.

New key scheme:  <city-slug>/<project-slug>[-N].<ext>
  e.g.  wix/ca3b83_00b60a…~mv2.jpeg  ->  west-palm-beach/mr-c-residences.jpeg
The <ext> is preserved from the original; multi-image projects get -2, -3, …;
projects with no city fall under misc/. Only images already hosted on our R2
public base are mapped (external URLs and the shared default are skipped).
"""
import json, re, sys, collections

MEDIA_PUBLIC_BASE = "https://media.oftmw.com"
DEFAULT_IMAGE = "https://media.oftmw.com/wix/ca3b83_93ffb2f000f94a12aa874fe44153be18~mv2.jpg"
IMG_FIELDS = ['ImageURL', 'Image2', 'Image3', 'Image4', 'Image5']
VALID_EXT = {'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'}


def slugify(s: str) -> str:
    s = (s or '').lower().strip()
    s = re.sub(r"['’]", '', s)          # drop apostrophes so "mr. c's" -> "mr-cs"
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return re.sub(r'-{2,}', '-', s).strip('-')


def ext_of(url: str) -> str:
    tail = url.split('?')[0].split('#')[0].rsplit('/', 1)[-1]
    ext = tail.rsplit('.', 1)[-1].lower() if '.' in tail else ''
    return ext if ext in VALID_EXT else 'jpg'


def main():
    with open('projects-flat.json', encoding='utf-8') as f:
        projects = json.load(f)

    mapping = []          # [{project, slug, city, field, old_url, old_key, new_key, new_url}]
    used_keys = {}        # new_key -> project slug (collision guard)
    stats = collections.Counter()
    skipped_missing_city = set()

    for p in projects:
        slug = (p.get('Slug') or slugify(p.get('Title') or '')).strip()
        if not slug:
            continue
        city_slug = slugify(p.get('City') or '') or 'misc'
        if city_slug == 'misc':
            skipped_missing_city.add(slug)
        n = 0
        for field in IMG_FIELDS:
            url = (p.get(field) or '').strip()
            if not url or not url.startswith(MEDIA_PUBLIC_BASE) or url == DEFAULT_IMAGE:
                continue
            n += 1
            ext = ext_of(url)
            suffix = '' if n == 1 else f'-{n}'
            new_key = f"{city_slug}/{slug}{suffix}.{ext}"
            # collision guard (slugs are unique, so this is belt-and-suspenders)
            dis = 1
            base_key = new_key
            while new_key in used_keys and used_keys[new_key] != slug:
                dis += 1
                new_key = base_key.rsplit('.', 1)[0] + f'-{dis}.' + ext
            used_keys[new_key] = slug
            old_key = url[len(MEDIA_PUBLIC_BASE):].lstrip('/')
            mapping.append({
                'project': p.get('Title', ''), 'slug': slug, 'city': p.get('City', ''),
                'field': field, 'old_url': url, 'old_key': old_key,
                'new_key': new_key, 'new_url': f"{MEDIA_PUBLIC_BASE}/{new_key}",
            })
            stats['mapped'] += 1
            stats[f'ext:{ext}'] += 1

    with open('image-rename-map.json', 'w', encoding='utf-8') as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    print(f"projects scanned      : {len(projects)}")
    print(f"images mapped         : {stats['mapped']}")
    print(f"projects w/o city     : {len(skipped_missing_city)} (folder 'misc/')")
    print("by extension          : " + ", ".join(f"{k[4:]}={v}" for k, v in sorted(stats.items()) if k.startswith('ext:')))
    print(f"\nwrote image-rename-map.json ({len(mapping)} entries)\n")

    wpb = [m for m in mapping if slugify(m['city']) == 'west-palm-beach']
    print(f"--- West Palm Beach sample ({len(wpb)} images) ---")
    for m in wpb[:14]:
        print(f"  {m['old_key'][:46]:46}  ->  {m['new_key']}")


if __name__ == '__main__':
    main()
