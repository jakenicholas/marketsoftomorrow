# In-house image galleries — gallery.oftmw.com (Pixieset replacement)

This is the runbook for the in-house gallery system that replaces Pixieset at
`gallery.oftmw.com`. Code lives in `worker/src/gallery.js`; the admin UI is the
Studio page at `journal/studio/galleries.html`.

## What it does

- **Public portfolio** at `gallery.oftmw.com/` — your `public` galleries as a
  cover grid.
- **Per-gallery pages** at `gallery.oftmw.com/g/<slug>` — server-rendered
  masonry + lightbox, in the same dark/glass design as `/media/licensing`.
- **Download PIN** (Pixieset-style) — set a per-gallery PIN; visitors browse
  freely but must enter the PIN to download full-resolution originals.
- **Public vs unlisted** — `public` galleries show in the portfolio index;
  `unlisted` galleries are reachable only by direct link (and PIN) — for
  delivering a shoot to a single client. Unlisted pages are `noindex`.
- **Licensing integration** — every gallery page links to
  `https://www.oftmw.com/media/licensing/` ("License this work"), and the
  licensing/media-kit "Portfolio" links resolve here.

Images are stored in the existing private R2 bucket (`tmw-media`) and served by
the worker — `gallery_images` is just the ordered membership index. Nothing new
to provision storage-wise.

## How the routing works

`handleGallery()` (called first in the worker's `fetch`) serves:

| Surface        | On `gallery.oftmw.com`            | On `tmw.jake-ab7.workers.dev` (pre-cutover testing) |
|----------------|-----------------------------------|------------------------------------------------------|
| Portfolio      | `GET /`                           | `GET /gallery/`                                      |
| Gallery page   | `GET /g/<slug>`                   | `GET /gallery/g/<slug>`                              |
| Thumbnails     | `GET /thumb/<key>?w=&q=`          | `GET /gallery/thumb/<key>?w=`                        |
| Download (PIN) | `GET /dl/<slug>/<key>?t=<token>`  | `GET /gallery/dl/<slug>/<key>?t=`                    |
| Verify PIN     | `POST /api/gallery/<slug>/pin`    | `GET /gallery/api/...`                               |
| Admin API      | `*/admin/galleries*` (any host — used by Studio)                         |

Admin routes are token-gated by the same `requireAdminToken` guard the rest of
the worker uses (GitHub session **or** `ADMIN_TOKEN`). Public routes are only
served in "gallery context" (the gallery host or a `/gallery/*` prefix), so they
never shadow the map/journal routes.

## Deploy

The tables self-bootstrap, so deploy is just:

```bash
cd worker
wrangler deploy
```

Test before cutover (no DNS change needed) at:

```
https://tmw.jake-ab7.workers.dev/gallery/
https://tmw.jake-ab7.workers.dev/gallery/g/<slug>
```

Create your first gallery in Studio → **Galleries** (`/studio/galleries.html`):
set a title, choose Public/Unlisted, optionally set a download PIN, then
drag-drop photos. Use the tile hover actions to set a cover, reorder by drag,
and remove. Hit **View live ↗** to preview.

## Cutover: point gallery.oftmw.com at the worker

`gallery.oftmw.com` currently CNAMEs to Pixieset. To serve the in-house gallery:

1. **Remove the Pixieset DNS record** for `gallery` in the `oftmw.com` zone
   (Cloudflare dashboard → DNS).
2. **Add a Custom Domain on the worker:** Workers & Pages → `tmw` → Settings →
   Domains & Routes → **Add → Custom Domain** → `gallery.oftmw.com`. Cloudflare
   creates the proxied DNS record and routes the host to the worker.
3. Visit `https://gallery.oftmw.com/` — the portfolio should render.

No code change is needed for cutover; the worker already branches on the
`gallery.oftmw.com` hostname.

## Thumbnails (recommended, optional)

`/thumb/<key>?w=…` resizes via Cloudflare image transformations and **falls
back to the original** if transformations aren't enabled — so it works either
way, but enabling them makes galleries much lighter. Enable once per zone:
Cloudflare dashboard → `oftmw.com` zone → **Images → Transformations** → enable
"Resize images from this zone." (Originals stay capped at 25 MB on upload.)

## Notes / limits

- Upload cap is 25 MB/file (the worker's existing `/admin/upload` limit). Fine
  for web-delivery JPEGs; raw/TIFF delivery is out of scope.
- "Download all" triggers per-file downloads client-side (staggered). There is
  no server-side ZIP in v1.
- Deleting a gallery removes the gallery + its ordering only; the underlying
  photos stay in the media library.
- The PIN gates **downloads**, not viewing (matches Pixieset). For a fully
  private client gallery, keep it `unlisted` (link-only, noindex) **and** set a
  PIN.
