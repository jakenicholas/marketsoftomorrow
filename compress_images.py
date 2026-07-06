#!/usr/bin/env python3
"""
compress_images.py — downsizes the OVERSIZED project images the map/popups load
full-res (some are 15-23MB), so pins/tiles load fast. Only touches images over
--threshold; caps the longest edge at --maxdim and re-encodes at web quality,
KEEPING the format. Re-uploads to the SAME keyword key with the immutable cache
header, only when the result is actually smaller. The untouched hash originals
stay in R2 as full-quality fallback, so this is reversible.

  python3 compress_images.py                 # dry run (reports what it would do)
  python3 compress_images.py --execute --workers 8
"""
import json, subprocess, argparse, tempfile, os, io, urllib.request, collections, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from PIL import Image
try:
    import pillow_avif  # noqa: F401  (registers AVIF)
except Exception:
    pass

BUCKET = "tmw-media"
CACHE_CONTROL = 'public, max-age=31536000, immutable'
CT = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
      'webp': 'image/webp', 'avif': 'image/avif'}


def head_size(u):
    try:
        req = urllib.request.Request(u, method='HEAD', headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=20) as r:
            return int(r.headers.get('Content-Length') or 0)
    except Exception:
        return -1


def wr(args):
    return subprocess.run(['npx', 'wrangler'] + args, capture_output=True, text=True)


def encode(im, ext):
    """Re-encode a PIL image to web quality, preserving format. Returns bytes."""
    buf = io.BytesIO()
    ext = ext.lower()
    if ext in ('jpg', 'jpeg'):
        if im.mode not in ('RGB', 'L'):
            im = im.convert('RGB')
        im.save(buf, 'JPEG', quality=85, optimize=True, progressive=True)
    elif ext == 'webp':
        im.save(buf, 'WEBP', quality=82, method=6)
    elif ext == 'avif':
        im.save(buf, 'AVIF', quality=58)
    elif ext == 'png':
        im.save(buf, 'PNG', optimize=True)
    else:
        return None
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--execute', action='store_true')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--maxdim', type=int, default=2000)
    ap.add_argument('--threshold', type=int, default=900 * 1024, help='only process images larger than this (bytes)')
    ap.add_argument('--limit', type=int)
    a = ap.parse_args()

    done = json.load(open('image-rename-done.json', encoding='utf-8'))
    if a.limit:
        done = done[:a.limit]

    st = collections.Counter()
    saved = [0]
    lock = threading.Lock()
    n = [0]
    total = len(done)

    def handle(e):
        key = e['new_key']
        ext = key.rsplit('.', 1)[-1].lower()
        if ext not in CT:
            return ('skip_fmt', 0)
        orig = head_size(e['new_url'])
        if orig <= 0:
            return ('head_fail', 0)
        if orig <= a.threshold:
            return ('skip_small', 0)
        if not a.execute:
            return ('would_process', 0)
        tf = tempfile.NamedTemporaryFile(delete=False, suffix='.' + ext).name
        try:
            g = wr(['r2', 'object', 'get', f"{BUCKET}/{key}", '--file', tf, '--remote'])
            if os.path.getsize(tf) == 0:
                return ('get_fail', 0)
            try:
                im = Image.open(tf)
                im.load()
            except Exception:
                return ('decode_fail', 0)
            w, h = im.size
            if max(w, h) > a.maxdim:
                scale = a.maxdim / max(w, h)
                im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
            data = encode(im, ext)
            if not data or len(data) >= orig:
                return ('no_gain', 0)
            with open(tf, 'wb') as fh:
                fh.write(data)
            p = wr(['r2', 'object', 'put', f"{BUCKET}/{key}", '--file', tf,
                    '--content-type', CT[ext], '--cache-control', CACHE_CONTROL, '--remote'])
            if 'Upload complete' in (p.stdout + p.stderr):
                return ('compressed', orig - len(data))
            return ('put_fail', 0)
        finally:
            try: os.unlink(tf)
            except OSError: pass

    print(f"{'EXECUTE' if a.execute else 'DRY RUN'} — scanning {total} images "
          f"(>{a.threshold//1024}KB, cap {a.maxdim}px)", flush=True)
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for fut in as_completed([ex.submit(handle, e) for e in done]):
            status, sv = fut.result()
            with lock:
                st[status] += 1; saved[0] += sv; n[0] += 1
                if n[0] % 25 == 0:
                    print(f"  {n[0]}/{total}  compressed={st['compressed']} "
                          f"saved={saved[0]//1024//1024}MB", flush=True)
    print(f"\nDONE — compressed={st['compressed']} skip_small={st['skip_small']} "
          f"no_gain={st['no_gain']} fails={st['get_fail']+st['decode_fail']+st['put_fail']+st['head_fail']}")
    print(f"  total saved: {saved[0]//1024//1024} MB")
    print(dict(st))


if __name__ == '__main__':
    main()
