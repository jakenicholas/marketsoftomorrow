#!/usr/bin/env python3
"""
generate_thumbnails.py — pre-generate small WEBP thumbnails for every project +
article image so the homepage tiles and map pin popups load a ~30KB thumb instead
of the full 300KB-2MB original (the homepage was ~27.8MB of images; a 600w webp is
~18x smaller). Originals stay untouched in R2 as the full-res fallback.

For each source image at  <base>/<path>.<ext>  it writes two derived keys:
    <base>/<path>_400.webp   (1x tiles / popups)
    <base>/<path>_800.webp   (2x retina / larger cards)
The client derives the same URL and falls back to the original on a 404 (so it's
safe to wire the consumers before the backfill finishes).

Idempotent via thumbs-manifest.json (committed): source keys already done are
skipped, so re-runs only process NEW images. Uploads via wrangler (needs
CLOUDFLARE_API_TOKEN); source list from the live projects-flat.json + /posts.

  python3 generate_thumbnails.py                 # process everything not in the manifest
  python3 generate_thumbnails.py --limit 20      # small test batch
  python3 generate_thumbnails.py --workers 8
"""
import argparse
import io
import json
import os
import re
import subprocess
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from PIL import Image

BUCKET = "tmw-media"
PUBLIC_BASE = "https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev"
CACHE_CONTROL = "public, max-age=31536000, immutable"
SIZES = (400, 800)
WORKER = "https://tmw.jake-ab7.workers.dev"
PROJECTS_URL = "https://www.oftmw.com/map/projects-flat.json"
MANIFEST = "thumbs-manifest.json"
UA = {"User-Agent": "Mozilla/5.0"}


def wr(args):
    return subprocess.run(["npx", "wrangler"] + args, capture_output=True, text=True)


def fetch_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def r2_key(url):
    """Public URL → R2 object key. Only our R2 host; else None."""
    if not url or PUBLIC_BASE not in url:
        return None
    key = url.split("?", 1)[0].split(PUBLIC_BASE + "/", 1)[-1]
    return key or None


def thumb_key(key, w):
    base = re.sub(r"\.[a-zA-Z0-9]+$", "", key)   # strip extension
    return f"{base}_{w}.webp"


def collect_sources():
    """Every project + article image URL on our R2 (deduped)."""
    urls = set()
    try:
        rows = fetch_json(PROJECTS_URL)
        rows = rows if isinstance(rows, list) else rows.get("projects", [])
        for p in rows:
            for f in ("ImageURL", "Image2", "Image3", "Image4", "Image5"):
                if p.get(f):
                    urls.add(p[f])
    except Exception as e:
        print(f"  ! projects source failed: {e}")
    try:
        d = fetch_json(f"{WORKER}/posts?limit=1500&status=published&ungated=1")
        for it in d.get("items", []):
            if it.get("cover_image"):
                urls.add(it["cover_image"])
    except Exception as e:
        print(f"  ! posts source failed: {e}")
    # keep only keys on our R2
    keys = {}
    for u in urls:
        k = r2_key(u)
        if k and re.search(r"\.(jpe?g|png|webp)$", k, re.I):
            keys[k] = u
    return keys


def process(key, url):
    """Download original, upload _400/_800 webp thumbs. Returns (key, note)."""
    try:
        raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45).read()
        im = Image.open(io.BytesIO(raw))
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        for w in SIZES:
            if im.size[0] <= w and im.size[1] <= w:
                # never upscale — for a small source, the _w thumb is just the source size
                pass
            t = im.copy()
            t.thumbnail((w, w * 4), Image.LANCZOS)
            buf = io.BytesIO()
            t.save(buf, "WEBP", quality=74, method=6)
            tf = tempfile.NamedTemporaryFile(suffix=".webp", delete=False)
            tf.write(buf.getvalue()); tf.close()
            try:
                p = wr(["r2", "object", "put", f"{BUCKET}/{thumb_key(key, w)}", "--file", tf.name,
                        "--content-type", "image/webp", "--cache-control", CACHE_CONTROL, "--remote"])
                if p.returncode != 0:
                    return key, "upload-fail:" + (p.stderr or "")[:80]
            finally:
                os.unlink(tf.name)
        return key, "ok"
    except Exception as e:
        return key, "err:" + str(e)[:80]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="process at most N new images (0 = all)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    done = set()
    if os.path.exists(MANIFEST):
        try:
            done = set(json.load(open(MANIFEST)))
        except Exception:
            done = set()

    sources = collect_sources()
    # Sorted so runs are DETERMINISTIC (collect_sources builds from a set, whose
    # iteration order is randomized per process) — same batch every time, resumable.
    todo = sorted(((k, u) for k, u in sources.items() if k not in done), key=lambda x: x[0])
    if args.limit:
        todo = todo[:args.limit]
    print(f"sources={len(sources)}  already-done={len(done)}  to-process={len(todo)}")
    if not todo:
        print("nothing to do"); return

    ok, fail = 0, 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for fut in as_completed([ex.submit(process, k, u) for k, u in todo]):
            key, note = fut.result()
            if note == "ok":
                ok += 1; done.add(key)
            else:
                fail += 1; print(f"  ! {key}: {note}")
            if (ok + fail) % 50 == 0:
                print(f"  … {ok} ok, {fail} failed")
                json.dump(sorted(done), open(MANIFEST, "w"))   # periodic checkpoint

    json.dump(sorted(done), open(MANIFEST, "w"))
    print(f"✓ thumbnails: {ok} ok, {fail} failed. Manifest now {len(done)} keys.")


if __name__ == "__main__":
    main()
