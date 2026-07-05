#!/usr/bin/env python3
"""
apply_image_renames.py — copies mapped R2 objects to their SEO keyword keys in
the tmw-media bucket (wrangler --remote), KEEPING every original (never deletes).
Reads image-rename-map.json. Idempotent: skips any image whose new URL already
resolves, so it's safe to re-run / resume. Writes image-rename-done.json listing
the entries whose new key is confirmed live (consumed by the reference rewrite).

  python3 apply_image_renames.py --city west-palm-beach            # dry run
  python3 apply_image_renames.py --city west-palm-beach --execute  # do the copy
  python3 apply_image_renames.py --execute                         # ALL cities
"""
import json, subprocess, argparse, tempfile, os, re, urllib.request, collections, sys

BASE   = "https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev"
BUCKET = "tmw-media"
CT = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
      'webp': 'image/webp', 'avif': 'image/avif', 'gif': 'image/gif'}


def slugify(s: str) -> str:
    s = (s or '').lower().strip()
    s = re.sub(r"['’]", '', s)
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return re.sub(r'-{2,}', '-', s).strip('-')


def url_ok(u: str) -> bool:
    # r2.dev 403s the default python-urllib UA, so send a browser UA.
    try:
        req = urllib.request.Request(u, method='HEAD', headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status == 200
    except Exception:
        return False


def wr(args):
    return subprocess.run(['npx', 'wrangler'] + args, capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--city', help='city slug filter, e.g. west-palm-beach')
    ap.add_argument('--execute', action='store_true', help='actually copy (default: dry run)')
    ap.add_argument('--limit', type=int)
    a = ap.parse_args()

    m = json.load(open('image-rename-map.json', encoding='utf-8'))
    if a.city:
        cs = a.city.lower()
        m = [x for x in m if slugify(x['city']) == cs or x['new_key'].startswith(cs + '/')]
    if a.limit:
        m = m[:a.limit]

    st = collections.Counter()
    done, errors = [], []
    total = len(m)
    print(f"{'EXECUTE' if a.execute else 'DRY RUN'} — {total} images"
          + (f" in {a.city}" if a.city else " (all cities)"), flush=True)

    for i, e in enumerate(m, 1):
        if url_ok(e['new_url']):
            st['skip_exists'] += 1; done.append(e)
            if i % 20 == 0: print(f"  {i}/{total} …", flush=True)
            continue
        if not a.execute:
            st['would_copy'] += 1
            continue
        ext = e['new_key'].rsplit('.', 1)[-1].lower()
        ct  = CT.get(ext, 'image/jpeg')
        tf  = tempfile.NamedTemporaryFile(delete=False, suffix='.' + ext).name
        try:
            g = wr(['r2', 'object', 'get', f"{BUCKET}/{e['old_key']}", '--file', tf, '--remote'])
            if os.path.getsize(tf) == 0:
                st['get_fail'] += 1
                errors.append({'new_key': e['new_key'], 'old_key': e['old_key'],
                               'stage': 'get', 'msg': (g.stderr or g.stdout)[-160:]})
                continue
            p = wr(['r2', 'object', 'put', f"{BUCKET}/{e['new_key']}", '--file', tf,
                    '--content-type', ct, '--remote'])
            if 'Upload complete' in (p.stdout + p.stderr):
                st['copied'] += 1; done.append(e)
            else:
                st['put_fail'] += 1
                errors.append({'new_key': e['new_key'], 'stage': 'put', 'msg': (p.stderr or p.stdout)[-160:]})
        finally:
            try: os.unlink(tf)
            except OSError: pass
        if i % 10 == 0:
            print(f"  {i}/{total}  copied={st['copied']} skip={st['skip_exists']} err={st['get_fail']+st['put_fail']}", flush=True)

    json.dump(done, open('image-rename-done.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    if errors:
        json.dump(errors, open('image-rename-errors.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print(f"\nDONE — copied={st['copied']} already-live={st['skip_exists']} "
          f"get_fail={st['get_fail']} put_fail={st['put_fail']}")
    print(f"  {len(done)} images confirmed live → image-rename-done.json"
          + (f" · {len(errors)} errors → image-rename-errors.json" if errors else ""))


if __name__ == '__main__':
    main()
