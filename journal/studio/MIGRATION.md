# Wix → D1 Migration Runbook

End-to-end: pull all 1,377 Wix Blog articles into our D1 database via the Wix Headless API, then point the article page at D1 as the canonical source. Wix gets decommissioned once `body_source = 'wix-import'` rows are verified.

This is **safe to re-run** — the worker upserts by `wix_id`, so the same article never gets duplicated.

---

## 1. Generate a Wix API key

1. Open **Wix Studio → Account Settings → API Keys** ([direct link](https://manage.wix.com/account/api-keys)).
2. Click **Generate API Key**. Name it `tmw-blog-migration`.
3. Permissions: enable **Blog → Read Posts**, and optionally **Members → Read Members** (so the importer can resolve author names from `memberId`).
4. Copy the key (looks like a long JWT). **Save it somewhere safe — Wix only shows it once.**

### Also note your Wix site ID + account ID

- **Site ID** — in Wix Studio → your site → **Settings → General → Site ID** (UUID format).
- **Account ID** — Wix Account dashboard → **Account Settings → General** (some endpoints need it; others don't).

---

## 2. Set worker secrets

From the repo root:

```bash
cd worker

wrangler secret put WIX_API_KEY        # paste the key from step 1
wrangler secret put WIX_SITE_ID        # paste the site UUID
wrangler secret put WIX_ACCOUNT_ID     # optional but recommended

# If you don't already have an admin token, generate one and set it:
openssl rand -hex 32 | tee /tmp/admin-token.txt
wrangler secret put ADMIN_TOKEN        # paste the value from /tmp/admin-token.txt
```

---

## 3. Apply the new D1 schema

The migration adds two tables: `posts` and `sync_state`. Apply them remotely:

```bash
wrangler d1 execute tmw_events --remote --file=./schema.sql
```

The schema is idempotent (`CREATE TABLE IF NOT EXISTS`) — safe to re-run.

---

## 4. Deploy the worker

```bash
wrangler deploy
```

Sanity check:

```bash
# Should return {"items":[], "total":0, ...} on a fresh DB
curl https://tmw.jake-ab7.workers.dev/posts
```

---

## 5. Run the sync

Open the admin page in your browser:

```
https://map.oftmw.com/journal/studio/sync.html
```

Steps:

1. Paste the admin token into the **Admin Token** field (saved to localStorage).
2. Leave **Batch Size** at 50 (smaller batches = safer; bigger = faster).
3. Click **Start sync**.
4. The page POSTs to `/admin/sync-wix?limit=50&offset=0` in a loop, incrementing the offset each batch. Progress bar + ETA update live. The log shows every batch's `+N new, +M updated, K failed`.

Expected wall time for 1,377 posts at batch=50:
- ~28 batches × ~1.5s per batch (Wix API + Ricos convert + D1 upsert) = **~45 seconds**

If the page crashes or you close it, just reopen, paste the **Start Offset** number from the last successful batch, and click Start again.

---

## 6. Verify

```bash
# How many made it in?
curl https://tmw.jake-ab7.workers.dev/posts | jq '.total'
# Expected: ~1377

# Spot check a known post
curl https://tmw.jake-ab7.workers.dev/posts/by-slug/inside-puakea-golf-course-one-of-kauai-s-most-distinctive-and-most-fun-rounds | jq '.post | {title, author_name, published_at, body_source, body_html: (.body_html|length)}'
```

Visit a post in your browser:

```
https://map.oftmw.com/journal/post/?slug=inside-puakea-golf-course-one-of-kauai-s-most-distinctive-and-most-fun-rounds
```

It should now load from D1 instantly (no scrape).

---

## 7. Incremental re-sync

Whenever you publish a new article on Wix while you still use it as the editor:

- Re-run the same sync from the admin page. The first batch picks up the newest posts. Existing rows update their `updated_at`; only the new posts insert.
- Or just run **offset = 0, batchSize = 50** for one batch — that's enough to catch the latest 50.

When you're confident the migration is complete and start writing in `/journal/studio/` instead, you can stop syncing entirely.

---

## 8. Roll back (if anything goes wrong)

```bash
# Wipe just the posts table (keeps iconic_lists, events, etc.)
wrangler d1 execute tmw_events --remote --command="DELETE FROM posts; DELETE FROM sync_state WHERE key='wix-last-offset';"
```

Then re-run the sync from scratch. Your article page degrades to the Wix scrape fallback while the table is empty.

---

## What got imported per post

Each `posts` row has:

| Field | Source |
|---|---|
| `id` | `'wix-' + wixPostId` |
| `slug` | Wix post slug (lowercased) |
| `title` | Wix title |
| `excerpt` | Wix excerpt |
| `body_html` | `ricosToHtml(post.richContent)` — clean semantic HTML, no Wix classes/styles |
| `cover_image` | Wix cover media URL (full-size, blur-thumbnails rewritten) |
| `categories` | JSON array of category labels |
| `tags` | JSON array of tag labels |
| `author_name` | Looked up from Wix Members API via `memberId` |
| `status` | `'published'` |
| `published_at` | Wix `firstPublishedDate` as unix seconds |
| `wix_id` | Wix post ID — used for upsert idempotency |
| `wix_url` | `https://www.oftmw.com/post/<slug>` — for legacy redirects |
| `body_source` | `'wix-import'` |
| `reading_time_min` | Computed from word count |
| `seo_title`, `seo_description` | From Wix `seoData` |

---

## Architecture decisions, briefly

- **Why D1 (not R2/KV)?** Posts need queries (by slug, by category, paginated). D1 (SQLite) handles all of this with proper indexes. Free tier covers our load (~1,400 rows, ~70MB total).
- **Why upsert by `wix_id`?** Idempotency. The slug can change in Wix; the Wix ID can't.
- **Why scrape-fallback in the article page?** Migration safety net. If a single article fails to import, the page degrades to the (slower, fragile) HTML scrape until you fix it.
- **Why not use R2 for images yet?** Wix CDN is free + fast. Migrating 1,400 hero images + thousands of body images is its own project. We keep Wix CDN URLs in `body_html` until R2 is ready.
- **Studio editor for new posts** lives at `/journal/studio/` — being built in the next pass. Hand-written posts go straight into D1 via `POST /posts` (admin-gated).
