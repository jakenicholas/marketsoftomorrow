#!/usr/bin/env python3
"""
update_media_library.py — updates the D1 media-library rows IN PLACE so each
image's catalog entry points at its new keyword key/url. Keeps folder, filename,
alt_text, caption untouched — so your Studio library looks identical (same
folders, same names), just with a cleaner underlying URL and NO duplicate entry.

Reads image-rename-done.json. Idempotent (re-running is a no-op for rows already
updated). Runs in chunks via `wrangler d1 execute --remote --file`.

  python3 update_media_library.py            # dry run — writes the .sql, no exec
  python3 update_media_library.py --write     # apply
"""
import json, subprocess, argparse, os, math


def esc(s: str) -> str:
    return str(s).replace("'", "''")


def run_sql(path: str):
    return subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'tmw_events', '--remote', '--file', path],
        capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--chunk', type=int, default=400)
    a = ap.parse_args()

    done = json.load(open('image-rename-done.json', encoding='utf-8'))
    stmts = []
    for e in done:
        if e['old_key'] == e['new_key']:
            continue
        # Only move the row if the OLD key still exists (idempotent) and don't
        # clobber a row that somehow already sits at the new key.
        stmts.append(
            f"UPDATE media SET key='{esc(e['new_key'])}', url='{esc(e['new_url'])}' "
            f"WHERE key='{esc(e['old_key'])}' "
            f"AND NOT EXISTS (SELECT 1 FROM media m2 WHERE m2.key='{esc(e['new_key'])}');")

    print(f"{len(stmts)} media rows to repoint")
    if not stmts:
        return
    if not a.write:
        open('update_media.sql', 'w', encoding='utf-8').write('\n'.join(stmts))
        print("wrote update_media.sql (dry run — re-run with --write to apply)")
        return

    chunks = math.ceil(len(stmts) / a.chunk)
    ok = 0
    for i in range(chunks):
        part = stmts[i * a.chunk:(i + 1) * a.chunk]
        fn = f'.update_media_{i}.sql'
        open(fn, 'w', encoding='utf-8').write('\n'.join(part))
        r = run_sql(fn)
        os.unlink(fn)
        tag = 'ok' if r.returncode == 0 else 'ERR'
        if r.returncode == 0:
            ok += len(part)
        else:
            print(f"  chunk {i+1}/{chunks} {tag}: {(r.stderr or r.stdout)[-300:]}")
        print(f"  chunk {i+1}/{chunks} · {tag} · {ok}/{len(stmts)} rows", flush=True)
    print(f"DONE — {ok}/{len(stmts)} media rows repointed")


if __name__ == '__main__':
    main()
