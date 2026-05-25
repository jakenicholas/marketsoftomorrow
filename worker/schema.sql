-- D1 schema for identified-user events from map.oftmw.com.
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
