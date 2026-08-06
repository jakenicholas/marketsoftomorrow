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
import json, subprocess, argparse, tempfile, os, re, urllib.request, collections, sys, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE   = "https://media.oftmw.com"
BUCKET = "tmw-media"
CT = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
      'webp': 'image/webp', 'avif': 'image/avif', 'gif': 'image/gif'}
# Long immutable cache so browsers/CDN keep images (matches the originals). WITHOUT
# this the copies had no Cache-Control, so mobile re-downloaded every image on
# every view → black blanks. Keyword keys are content-unique, so immutable is safe.
CACHE_CONTROL = 'public, max-age=31536000, immutable'


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
    ap.add_argument('--workers', type=int, default=10, help='parallel copies (default 10)')
    ap.add_argument('--force', action='store_true', help='re-put even if the new key already exists (e.g. to set Cache-Control)')
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
    lock = threading.Lock()
    n_seen = [0]
    print(f"{'EXECUTE' if a.execute else 'DRY RUN'} — {total} images"
          + (f" in {a.city}" if a.city else " (all cities)")
          + (f" · {a.workers} workers" if a.execute else ""), flush=True)

    def handle(e):
        # Idempotent: skip anything already live at the new key (unless --force,
        # used to re-put existing objects with the Cache-Control header).
        if not a.force and url_ok(e['new_url']):
            return ('skip_exists', e, None)
        if not a.execute:
            return ('would_copy', e, None)
        ext = e['new_key'].rsplit('.', 1)[-1].lower()
        ct  = CT.get(ext, 'image/jpeg')
        tf  = tempfile.NamedTemporaryFile(delete=False, suffix='.' + ext).name
        try:
            g = wr(['r2', 'object', 'get', f"{BUCKET}/{e['old_key']}", '--file', tf, '--remote'])
            if os.path.getsize(tf) == 0:
                return ('get_fail', e, (g.stderr or g.stdout)[-160:])
            p = wr(['r2', 'object', 'put', f"{BUCKET}/{e['new_key']}", '--file', tf,
                    '--content-type', ct, '--cache-control', CACHE_CONTROL, '--remote'])
            if 'Upload complete' in (p.stdout + p.stderr):
                return ('copied', e, None)
            return ('put_fail', e, (p.stderr or p.stdout)[-160:])
        finally:
            try: os.unlink(tf)
            except OSError: pass

    with ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        futs = [ex.submit(handle, e) for e in m]
        for fut in as_completed(futs):
            status, e, msg = fut.result()
            with lock:
                st[status] += 1
                if status in ('copied', 'skip_exists'):
                    done.append(e)
                elif status in ('get_fail', 'put_fail'):
                    errors.append({'new_key': e['new_key'], 'old_key': e['old_key'], 'stage': status, 'msg': msg})
                n_seen[0] += 1
                if n_seen[0] % 25 == 0:
                    print(f"  {n_seen[0]}/{total}  copied={st['copied']} skip={st['skip_exists']} "
                          f"err={st['get_fail']+st['put_fail']}", flush=True)

    json.dump(done, open('image-rename-done.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    if errors:
        json.dump(errors, open('image-rename-errors.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print(f"\nDONE — copied={st['copied']} already-live={st['skip_exists']} "
          f"get_fail={st['get_fail']} put_fail={st['put_fail']}")
    print(f"  {len(done)} images confirmed live → image-rename-done.json"
          + (f" · {len(errors)} errors → image-rename-errors.json" if errors else ""))


if __name__ == '__main__':
    main()
