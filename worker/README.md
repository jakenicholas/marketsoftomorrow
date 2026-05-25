# TMW analytics worker

Cloudflare Worker behind `analytics.html`. Does two things:

1. **Talks to the Google Analytics Data API** using a service-account JWT.
   This replaces the old API-key approach that returned 401 (GA4 Data API
   does not accept API keys at all — only OAuth2 bearer tokens).
2. **Receives identified-user events** from `map.oftmw.com` and stores them
   in Cloudflare D1 so the dashboard can answer per-member questions GA4
   refuses to answer at low volume.

---

## One-time setup

You have to do these steps once. They involve Google Cloud and Cloudflare web
UIs that I can't drive for you — once they're done, the worker code handles
the rest.

### 1. Google Cloud — create a service account for GA4 access

1. Go to <https://console.cloud.google.com/> and either pick an existing
   project or create a new one called e.g. `tmw-analytics`.
2. Enable the **Google Analytics Data API**:
   <https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com>
   → click **Enable**.
3. Go to **IAM & Admin → Service Accounts**:
   <https://console.cloud.google.com/iam-admin/serviceaccounts>
   → **Create service account**.
   - Name: `tmw-analytics-reader`
   - No roles needed (GA4 grants its own permissions in step 5).
   - Skip the "grant users access" step.
4. Click into the new service account → **Keys** tab → **Add key → Create new
   key → JSON**. A `.json` file downloads. **Keep this file** — you'll paste
   its contents into a Cloudflare secret in step 7. Do NOT commit it.
5. Copy the service account's email address (looks like
   `tmw-analytics-reader@tmw-analytics.iam.gserviceaccount.com`).

### 2. GA4 — grant the service account read access to the property

1. Go to <https://analytics.google.com/> → **Admin** (bottom-left gear).
2. Pick the **Map of Tomorrow** property (ID `336842761`).
3. **Property Access Management** → **+** → **Add users**.
4. Paste the service account email from step 1.5.
5. Role: **Viewer** is enough. Uncheck "Notify new users by email" (the
   service account has no inbox).
6. Save.

### 3. Cloudflare — install Wrangler and log in

```bash
npm install -g wrangler
wrangler login    # opens browser, asks you to authorize
```

### 4. Create the D1 database

```bash
cd worker
wrangler d1 create tmw_events
```

Output looks like:

```
✅ Successfully created DB 'tmw_events' in region ...
[[d1_databases]]
binding = "DB"
database_name = "tmw_events"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy that `database_id` and paste it into [`wrangler.toml`](./wrangler.toml)
replacing `REPLACE_ME_AFTER_CREATING_D1`.

### 5. Apply the schema

```bash
wrangler d1 execute tmw_events --remote --file=./schema.sql
```

You should see something like `🚣 Executed 4 commands`.

### 6. Generate an ingest token

This is a shared secret. The map sends it as a header with every event POST,
the worker rejects events without it. Pick any long random string — easiest:

```bash
openssl rand -hex 32
```

Save the output somewhere — you'll need it for both the worker secret AND
the `index.html` change in step 9.

### 7. Set the worker secrets

```bash
wrangler secret put GA_SERVICE_ACCOUNT_JSON
# When prompted, paste the ENTIRE contents of the JSON file from step 1.4
# (one line, paste, hit enter). Then Ctrl-D on its own line on macOS/Linux,
# or Ctrl-Z then Enter on Windows.

wrangler secret put EVENT_INGEST_TOKEN
# Paste the random string from step 6.
```

### 8. Deploy the worker

```bash
wrangler deploy
```

Output ends with the URL. It should be `https://tmw.<your-subdomain>.workers.dev`
— matching the `WORKER_URL` already hardcoded in `analytics.html` and (in
step 9) in `index.html`.

> If your subdomain doesn't match `jakenicholas23` (the existing one), edit
> `WORKER_URL` in `analytics.html` and `WORKER_URL` in the new `track()`
> helper block in `index.html` to match.

### 9. Add the ingest token to `index.html`

In `index.html`, find the block beginning `// ─── Map of Tomorrow event ingest`
and replace `REPLACE_WITH_EVENT_INGEST_TOKEN` with the string from step 6.

(Yes, this token is going into client-side code — it's not a strong secret,
it's a rate-limit / drive-by-spam filter. The real defense against abuse is
that we also write the User-Agent and IP-derived data and could rotate the
token if someone scrapes it.)

### 10. Verify

- Open `https://tmw.<your-subdomain>.workers.dev/health` — should return
  `{"ok":true,"ts":...}`.
- Open `analytics.html` — the GA4 cards (Active Right Now, 7-day views,
  events table, sources, countries) should populate. If they error, the
  error message now comes through verbatim from GA4 so you can see exactly
  what permission is missing.
- Log into `map.oftmw.com`, click a couple of projects, then open
  `analytics.html` again — the new **People** / **Activity** / **Watchlist**
  sections should show your test session.

---

## Ongoing maintenance

- **Re-deploy after code changes:** `wrangler deploy` from this directory.
- **Inspect D1 directly:** `wrangler d1 execute tmw_events --remote --command "SELECT * FROM events ORDER BY ts DESC LIMIT 20"`
- **Reset D1 (nukes all event data):** `wrangler d1 execute tmw_events --remote --command "DELETE FROM events"`
- **Rotate the ingest token:** `wrangler secret put EVENT_INGEST_TOKEN` (paste new value), update `index.html` to match, redeploy worker, push site.
- **Rotate the service account key:** create a new key in GCP, `wrangler secret put GA_SERVICE_ACCOUNT_JSON` with the new JSON, delete the old key in GCP.

---

## How the auth actually works (for future-you debugging at 1am)

API keys don't work for the GA4 Data API. Period. The Worker therefore:

1. On first request, parses the service-account JSON from `GA_SERVICE_ACCOUNT_JSON`.
2. Builds a JWT claiming `iss=<sa-email>`, `aud=oauth2.googleapis.com/token`,
   `scope=analytics.readonly`, expires in 1 hour.
3. Signs the JWT with the service account's RSA private key using
   `crypto.subtle.sign` (RSASSA-PKCS1-v1_5, SHA-256).
4. POSTs the JWT to Google's token endpoint
   (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`).
5. Gets back a 1-hour bearer token, caches it in a module-global so the
   isolate doesn't re-sign on every request.
6. Calls `analyticsdata.googleapis.com/v1beta/properties/<id>:runReport` with
   `Authorization: Bearer <token>`.

If you see 401 from the GA4 call (not the token call), the most common cause
is forgetting step 2 of the setup — the service account needs to be added as
a Viewer on the GA4 property itself, not just on the GCP project.
