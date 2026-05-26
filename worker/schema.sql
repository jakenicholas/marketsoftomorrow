-- D1 schema for identified-user events from map.oftmw.com.
-- build-stamp: studio-v1 (+ posts, + media, + sync_state)
--
-- Philosophy: anonymous traffic stays in GA4 (it's good at that). This table
-- only stores events from logged-in Memberstack members, so volume is tiny,
-- privacy is clean, and we can answer "what did THIS person do" — which GA4
-- refuses to answer at low traffic due to its data-thresholding privacy floor.

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,           -- unix seconds, server-side stamp
  client_ts    INTEGER,                    -- unix seconds, browser stamp (may be skewed)
  member_id    TEXT    NOT NULL,           -- Memberstack member id
  email        TEXT,                       -- member email at time of event
  member_name  TEXT,
  plan         TEXT,                       -- 'paid' | 'free' | 'anonymous'
  event_name   TEXT    NOT NULL,           -- 'project_click', 'watchlist_add', ...
  session_id   TEXT,                       -- per-tab session id (rotates on tab close)
  path         TEXT,                       -- window.location.pathname
  referrer     TEXT,
  user_agent   TEXT,
  props_json   TEXT                        -- JSON blob of event-specific properties
);

-- Indexes tuned for the dashboard queries we run:
CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_member_ts ON events(member_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_name_ts   ON events(event_name, ts DESC);

-- ---------------------------------------------------------------------------
-- iconic_lists: server-side storage for the curated ranking pages
-- (Iconic Golf, Iconic Restaurants, Iconic Hotels…). One row per list,
-- editable from the page itself when the editor presents a valid bearer
-- token. The 'data' column is the full JSON document the page renders.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS iconic_lists (
  slug         TEXT    PRIMARY KEY,           -- e.g. 'golf', 'restaurants'
  data         TEXT    NOT NULL,              -- JSON document, see /list handler
  updated_at   INTEGER NOT NULL,              -- unix seconds
  updated_by   TEXT                           -- optional admin label
);

-- ---------------------------------------------------------------------------
-- posts: every article on the journal lives here. Initially backfilled
-- from Wix via the Headless Blog API (1,377 articles), then Studio
-- (/journal/studio/) writes new posts here directly. Wix is the
-- source of truth ONLY until the migration completes.
--
-- `wix_id` lets the importer re-sync idempotently — running sync twice
-- updates existing rows instead of duplicating. `wix_url` preserves the
-- legacy oftmw.com/post/<slug> URL so Cloudflare can 301-redirect old
-- inbound links after cutover.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id                TEXT    PRIMARY KEY,      -- 'wix-<wixId>' for imported, 'tmw-<uuid>' for native
  slug              TEXT    NOT NULL UNIQUE,
  title             TEXT    NOT NULL,
  excerpt           TEXT,                     -- 1-2 sentence summary (for cards/SEO)
  body_html         TEXT    NOT NULL,         -- cleaned/sanitized HTML the article page renders
  cover_image       TEXT,                     -- absolute URL (Wix CDN or our R2)
  cover_image_alt   TEXT,
  categories        TEXT    DEFAULT '[]',     -- JSON array: ["Florida","Golf",...]
  tags              TEXT    DEFAULT '[]',     -- JSON array
  author_name       TEXT,
  author_id         TEXT,                     -- wix memberId or our user id
  status            TEXT    NOT NULL DEFAULT 'published',   -- 'draft' | 'published' | 'scheduled'
  published_at      INTEGER,                  -- unix seconds; null for drafts
  reading_time_min  INTEGER,                  -- estimated, computed on write
  seo_title         TEXT,
  seo_description   TEXT,
  wix_id            TEXT,                     -- original Wix post id for re-sync
  wix_url           TEXT,                     -- original oftmw.com/post/<slug>
  body_source       TEXT    DEFAULT 'wix-import',  -- 'wix-import' | 'studio' | 'wix-scrape'
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE        INDEX IF NOT EXISTS idx_posts_slug         ON posts(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_wix_id       ON posts(wix_id)         WHERE wix_id IS NOT NULL;
CREATE        INDEX IF NOT EXISTS idx_posts_pub          ON posts(status, published_at DESC);
CREATE        INDEX IF NOT EXISTS idx_posts_author       ON posts(author_id, published_at DESC);

-- Lightweight key-value table for sync state (resume cursors, last-run
-- timestamps). Lets the importer pick up where it left off if interrupted.
CREATE TABLE IF NOT EXISTS sync_state (
  key       TEXT    PRIMARY KEY,
  value     TEXT,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- media: every image (or future video/file) uploaded through Studio gets a
-- row here. The object itself lives in R2; this table is just the index
-- (for the media library UI, search, and reverse-lookup from a URL).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
  key          TEXT    PRIMARY KEY,    -- R2 object key, e.g. "2026/05/abc-photo.jpg"
  filename     TEXT    NOT NULL,        -- original upload filename
  mime_type    TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  alt_text     TEXT,
  caption      TEXT,
  uploaded_by  TEXT,
  uploaded_at  INTEGER NOT NULL,
  url          TEXT    NOT NULL         -- public CDN URL (r2.dev or custom)
);

CREATE INDEX IF NOT EXISTS idx_media_uploaded ON media(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_filename ON media(filename);

-- A view of the most recent event per member, for the People list.
-- We define it as a view (not a materialized table) so it's always fresh
-- and we never have to write a backfill job.
CREATE VIEW IF NOT EXISTS member_summary AS
SELECT
  member_id,
  MAX(email)        AS email,
  MAX(member_name)  AS member_name,
  MAX(plan)         AS plan,
  MAX(ts)           AS last_seen_ts,
  MIN(ts)           AS first_seen_ts,
  COUNT(*)          AS event_count
FROM events
GROUP BY member_id;
