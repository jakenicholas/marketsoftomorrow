# July 31 — Wix Cutover Checklist (go fully Wix-free)

The domain `oftmw.com` is registered/locked in Wix until **2026-07-31**. Until then,
Wix is still the **registrar + DNS + apex homepage host** — deleting the account
would take the whole ecosystem down. Images/SVGs are already 100% on R2 (r2.dev).

Goal on/after July 31: move the domain + DNS off Wix, stand up `media.oftmw.com`,
rehost the apex homepage, then delete Wix.

---

## Phase A — Prep NOW (before July 31, non-destructive)

- [ ] **Snapshot ALL current Wix DNS records** (screenshot + export): A / AAAA / CNAME /
      MX / TXT / SRV / NS. This is the master list everything else is verified against.
- [ ] **Find where email lives** (the MX + SPF/DKIM/DMARC TXT records). ⚠️ #1 thing
      people break in a DNS move. If it's Google Workspace / another provider, note
      every record exactly. If email is *Wix-hosted*, it must be migrated to a real
      provider BEFORE deleting Wix or email dies.
- [ ] **Inventory subdomains + targets** (confirmed so far):
      - `oftmw.com` (apex) → **Wix site** (needs a new home — see Phase C)
      - `www.oftmw.com` → Cloudflare-proxied
      - `map.oftmw.com` → GitHub Pages (CNAME)
      - `gallery.oftmw.com` → Cloudflare Pages
      - `admin.oftmw.com` → Cloudflare Pages + Access
      - any others (mail, links, etc.)
- [ ] **Decide the apex `oftmw.com` homepage fate**: rebuild as a Cloudflare Page,
      redirect to the journal, or a simple landing. (Whatever it is, it can't stay on Wix.)
- [ ] **Lower DNS TTLs** on records you'll move (to ~300s) a day before cutover for fast rollback.

## Phase B — Domain + DNS move (July 31+)

- [ ] At Wix: **unlock the domain** + get the **auth/EPP transfer code**.
- [ ] **Transfer `oftmw.com` → Cloudflare Registrar** (or keep registrar, just change
      nameservers — but full transfer is cleanest to leave Wix). Transfers take a few
      days; the domain keeps resolving throughout.
- [ ] **Add `oftmw.com` as a zone in Cloudflare** → let it scan/import records →
      **manually verify** every record from the Phase A snapshot copied (esp. MX + TXT).
- [ ] **Point nameservers at Cloudflare** (the actual cutover). Wait for propagation.
- [ ] **Verify before declaring done:**
      - [ ] www / map / gallery / admin all resolve + load
      - [ ] **Send + receive a test email** (both directions)
      - [ ] Studio (admin.oftmw.com) + Access still work
      - [ ] Memberstack subscriptions/login still work (check its required DNS/verification records)

## Phase C — media.oftmw.com + apex + image re-point

- [ ] **R2 custom domain:** Cloudflare → R2 → `tmw-media` → Settings → Custom Domains →
      connect `media.oftmw.com` (now possible since the zone is on Cloudflare).
- [ ] **Re-point all images** `pub-7da0281887564d10a10107987c7c6c0c.r2.dev` → `media.oftmw.com`:
      one find/replace across the same surfaces we just migrated:
      - data files (tmw-data + marketsoftomorrow JSON/HTML/XML) — ~2,400 files
      - D1 `media` table `url` column (`UPDATE media SET url = REPLACE(...)`)
      - worker `R2_PUBLIC_BASE` + `MEDIA_PUBLIC_BASE` (wrangler.toml) → redeploy
      - frontend JS (`project-card.js`, `journal-dock.js`, `post.js`), generators
        (`generate_pulse.py`, `generate_pages.py`, `backfill_articles.py`, `generate_articles.py`)
      - This kills the r2.dev rate-limit concern for good.
- [ ] **Rehost the apex homepage** off Wix (Cloudflare Page / redirect).

## Phase D — Decommission Wix

- [ ] Let everything run **24–48h** post-cutover with zero issues.
- [ ] Confirm: domain transferred out, DNS on Cloudflare, email working, apex rehosted,
      images on media.oftmw.com, nothing 404ing.
- [ ] **Then delete the Wix account.**

## Reference — what's ALREADY off Wix (done June 2026)
- All `static.wixstatic.com/media` images → R2 (gap-filled to 100% first, 52 images recovered)
- All `/shapes/` SVGs (header logo `TMW_Logos-16`, 8 partner logos) → R2
- ~21k URL rewrites across 2,400+ files; D1 `media` table (15,376 rows); serve-time rewrite
- Images bypass the Worker (r2.dev) — fixed the daily-request limit too
- Journal runs on D1/Worker, not the Wix Blog (blog-feed.xml already 404)
