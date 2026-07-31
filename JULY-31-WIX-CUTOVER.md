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

### CAPTURED Wix DNS snapshot — 2026-07-31 (the master list to rebuild in Cloudflare)

Apex `oftmw.com` is on **GitHub Pages** (the 185.199.x IPs), NOT Wix — so the apex "rehost" is smaller than assumed.

RECREATE EXACTLY (live infra):
- A ×4  `oftmw.com` → 185.199.108.153 / .109.153 / .110.153 / .111.153  (GitHub Pages) — Cloudflare **grey/DNS-only**
- CNAME `www` → marketsoftomorrow.pages.dev   — add as a Pages **custom domain** (proxied)
- CNAME `admin` → tmw-admin.pages.dev          — Pages custom domain (proxied) + Access
- CNAME `gallery` → tmw-gallery.pages.dev       — Pages custom domain (proxied)
- CNAME `map` → jakenicholas.github.io          — **grey/DNS-only** (GitHub Pages SSL)
- MX ×5 `oftmw.com` → aspmx / alt1–4.aspmx.l.google.com (10/20/30/40/50)  (Google Workspace — inbound mail, critical)
- TXT `oftmw.com` → `v=spf1 include:_spf.google.com ~all`
- TXT `oftmw.com` → both `google-site-verification=…` values
- TXT `resend._domainkey` → `p=MIGfMA0GCSqGSIb3D…` (Resend DKIM, already staged)
- TXT `send` → `v=spf1 include:amazonses.com ~all` (Resend SPF, already staged)
- TXT `_github-pages-challenge-…` → `9acf641b126dce6648cf7f…` (apex/map GH Pages verification)

ADD at cutover (new):
- MX `send` → `feedback-smtp.us-east-1.amazonses.com` **pri 10** (Resend return-path — the one missing piece)
- TXT `_dmarc` → `v=DMARC1; p=none; rua=mailto:media@oftmw.com` (replaces the Wix DMARC CNAME)

DROP (Wix legacy — verify the ⚠ two before dropping):
- CNAME `_dmarc` → _dmarc.wixemails.com (replaced by the DMARC TXT above)
- CNAME `s1._domainkey`, `s2._domainkey` (Wix mail DKIM — safe if no mail sends via Wix)
- ⚠ CNAME `sel1._domainkey` (NOT a Wix selector — confirm no live ESP signs with it, then drop)
- CNAME `en`, `es` → cdn1.wixdns.net (old Wix multilingual site)
- ⚠ CNAME `sg` → …ascend… (Wix Ascend email marketing — drop unless still used)
- NS `ns6/ns7.wixdns.net` → replaced by Cloudflare's two nameservers at the registrar

Two Cloudflare gotchas: (1) www/admin/gallery must be registered as **Custom Domains inside their Pages projects**, not just raw CNAMEs to *.pages.dev (else a proxied record 404s + no cert). (2) `map` + the apex A records stay **grey-cloud** — GitHub Pages serves its own SSL; proxying breaks it.

## Phase B — Domain + DNS move (July 31+)

- [ ] At Wix: **unlock the domain** + get the **auth/EPP transfer code**.
- [ ] **Transfer `oftmw.com` → GoDaddy (registrar).** Decision: registrar stays at
      GoDaddy, DNS runs on Cloudflare (registrar and DNS are separate — this is a
      standard, supported split). Initiate the transfer at GoDaddy with the Wix
      EPP/auth code. Transfers take a few days; the domain keeps resolving throughout.
- [ ] **Add `oftmw.com` as a zone in Cloudflare** → let it scan/import records →
      **manually verify** every record from the Phase A snapshot copied (esp. MX + TXT).
- [ ] **At GoDaddy, change nameservers → the two Cloudflare NS** (the actual DNS
      cutover). Wait for propagation. ⚠️ After this, manage ALL DNS records in the
      Cloudflare dashboard — GoDaddy's DNS panel goes inert (editing it does nothing).
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
- [ ] **Retire `map.oftmw.com` off GitHub Pages → Cloudflare Pages, then make
      `marketsoftomorrow` PRIVATE.** Goal: protect source/IP from being copied
      (`tmw-admin` + `tmw-data` are ALREADY private; `marketsoftomorrow` is the
      last public one only because GitHub Pages serves the live map from it).
      **ORDER MATTERS — do NOT flip private first:** GitHub Pages won't serve a
      private repo on a non-Pro plan, so the gap would take `map.oftmw.com`
      down. Steps: (1) stand up the marketsoftomorrow build on **Cloudflare
      Pages** (serves private repos), point the `map.oftmw.com` DNS at it, and
      verify it loads; (2) update the `generate-pages.yml` Action — it deploys
      via `actions/deploy-pages` (GitHub Pages), which stops working once
      private, so re-point the build/deploy at Cloudflare Pages (or have CF
      Pages build on push); (3) only then set repo visibility to private.
      Note: this hides SOURCE/history, not the published JSON (the live site
      still serves projects-flat.json etc. publicly — that's by design).

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
