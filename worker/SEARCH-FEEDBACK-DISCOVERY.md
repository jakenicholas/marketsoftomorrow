# tmw-project-discovery — Claude Code routine spec

The lightbox overlay's thumbs feedback feeds a discovery queue. This doc
spec's the Claude Code routine that drains the queue, researches missing
projects, and stages them as map drafts via the Studio MCP.

## Data flow

```
overlay (👎)
  ↓ POST /event { event_name:'search_feedback', props:{ q, rating:'down', results, result_kind } }
worker `events` D1 table
  ↓ aggregated by needs_discovery (down vote AND zero results)
worker GET /search-feedback/discoveries
  ↓ Claude Code routine pulls the queue
tmw-project-discovery routine
  ↓ for each query: research + Studio MCP create_map_draft
worker POST /search-feedback/discoveries/mark
  ↓ marks query as processed so the next poll skips it
admin.oftmw.com/map/?drafts → human review → promote to live map
```

## Worker endpoints

### `GET /search-feedback/discoveries`

Admin-only (requires `X-Admin-Token` or GitHub session). Query params:
- `days=30` — feedback window to consider (1-365)
- `limit=50` — cap on returned items per poll (1-200)

Response:
```jsonc
{
  "items": [
    {
      "query": "projects coming to nashville",
      "up": 0,
      "down": 2,
      "last_ts": 1733088000,
      "avg_results": 0,
      "dominant_kind": "empty",
      "hint": "A reader searched \"projects coming to nashville\" and got zero results. Their thumbs-down suggests the project database is missing coverage. Identify the place + project type in the query, then research candidate projects to add as map drafts."
    }
  ],
  "total_pending": 1,
  "days": 30
}
```

Items already marked processed are excluded.

### `POST /search-feedback/discoveries/mark`

Admin-only. Body:
```json
{
  "queries": ["projects coming to nashville", "new towers in austin"],
  "result": "Created 6 map drafts: Vanderbilt, Nashville Yards Phase III, ...",
  "drafts_created": ["draft-uuid-1", "draft-uuid-2"]
}
```

`queries[]` is required; `result` and `drafts_created` are optional audit metadata. Each query becomes a `discovery_processed` row in the `events` table (case-insensitive lookup the next poll uses to skip).

## Claude Code routine config

Save this as `~/.claude/cron/tmw-project-discovery.md` (or `.claude/agents/tmw-project-discovery.md` in this repo):

```markdown
---
schedule: "0 9 * * *"          # daily at 9am ET, after the morning ingest
description: Drain the search-feedback discovery queue. Research missing
  projects flagged by reader thumbs-down votes, stage them as map drafts
  for human review, then mark the queries processed.
---

# tmw-project-discovery

Run this every morning to turn yesterday's thumbs-down search feedback
into map drafts.

## Steps

1. **Pull the queue.** Use `curl` with the admin token:

   ```bash
   curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
     https://tmw.jake-ab7.workers.dev/search-feedback/discoveries?days=14
   ```

   Parse `items[]`. If empty, exit with `No pending discoveries`.

2. **For each item**, run the discovery skill:
   - Read `item.hint` — that's the brief.
   - Parse the place + project type from `item.query`.
   - Web search "{place} {type} development 2025 2026" for candidate
     projects.
   - For each promising candidate (3-8 per query is the target):
     - Call the Studio MCP tool `create_map_draft` with the project
       title, location (lat/lng via `geocode_address`), developer,
       architect, status, delivery date, image URL, source URL.
     - Capture the returned `draft_id`.
   - If no candidates surface after a reasonable search, log the query
     with `result: "No candidates found — query may be too vague."`

3. **Mark every processed query** in one call:

   ```bash
   curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"queries": [...], "result": "...", "drafts_created": [...]}' \
     https://tmw.jake-ab7.workers.dev/search-feedback/discoveries/mark
   ```

4. **Report.** Summarize: queries processed, drafts created, drafts
   per query, any queries that yielded zero candidates.

## Quality bar

- Drafts must include a source URL (news article, press release, official
  developer page) — not just a guess.
- Skip queries that are obviously off-brand (TMW covers the urban South;
  a query like "projects in fairbanks alaska" is fine to mark processed
  with `result: "out of coverage area"`).
- A draft should be the same shape a human editor would create -- title,
  city, type, developer, architect, status, delivery date, hero image,
  one-sentence description.

## Known constraints

- The discovery queue is best-effort — a query that gets zero candidates
  on this run can be re-flagged by a future thumbs-down (it's only marked
  processed for this batch; if it shows up again with new downvotes the
  worker treats it as a fresh signal until 30 days pass).
- Studio MCP tools live behind the OAuth handshake; the routine assumes
  the connector is already authenticated locally.
- Drafts go to `admin.oftmw.com/map/?drafts` for human review. NEVER auto-
  promote — every draft is reviewed before it hits the live map.
```

## Admin dashboard

The existing **Search Feedback** tile in `admin.oftmw.com/analytics.html`
shows the rollup. Queries flagged `needs_discovery` get a red "Needs
project discovery" pill and bubble to the top.

Once the routine marks a query processed, it drops off the discovery
queue (it still appears in the rollup's by_query list, just no longer
fires the red callout in the discovery filter — though the current
admin tile doesn't filter by processed-state yet; that's a follow-up).
