#!/usr/bin/env python3
"""
rewrite_image_refs.py — repoints image URLs from their old R2 hash keys to the
new SEO keyword keys, using image-rename-done.json (only images already confirmed
LIVE at the new key). Text-level replace, so it catches the URL wherever it
appears (images arrays, ImageURL/Image2.. fields, embeds).

Targets both the SOURCE OF TRUTH and the local generated file:
  - tmw-data/data/projects.json   (must be committed+pushed to the tmw-data repo,
                                    or the next fetch_projects run reverts it)
  - projects-flat.json            (local — for the immediate page regenerate)

  python3 rewrite_image_refs.py            # dry run (counts)
  python3 rewrite_image_refs.py --write
"""
import json, argparse, os

TARGETS = ['tmw-data/data/projects.json', 'projects-flat.json']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    a = ap.parse_args()

    done = json.load(open('image-rename-done.json', encoding='utf-8'))
    pairs = [(e['old_url'], e['new_url']) for e in done if e['old_url'] != e['new_url']]
    # longest old_url first avoids any partial-substring overlap
    pairs.sort(key=lambda x: len(x[0]), reverse=True)
    print(f"{len(pairs)} url pairs from image-rename-done.json")

    for path in TARGETS:
        if not os.path.exists(path):
            print(f"  SKIP (missing): {path}")
            continue
        txt = open(path, encoding='utf-8').read()
        n = 0
        for old, new in pairs:
            c = txt.count(old)
            if c:
                txt = txt.replace(old, new)
                n += c
        if a.write:
            open(path, 'w', encoding='utf-8').write(txt)
        print(f"  {'wrote' if a.write else 'would replace'} {n:5} occurrences in {path}")

    if not a.write:
        print("\n(dry run — re-run with --write to apply)")


if __name__ == '__main__':
    main()
