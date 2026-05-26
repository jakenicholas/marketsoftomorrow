// Map of Tomorrow analytics worker.
//
// Two responsibilities:
//   1. Authenticate to the Google Analytics Data API using a service-account
//      JWT (because the API rejects api-key auth — that's the 401 we kept
//      hitting). The dashboard at analytics.html keeps its existing call
//      shape and routes through here.
//   2. Receive identified-user events from index.html and persist them to
//      Cloudflare D1. Then serve dashboard queries (people list, member
//      timelines, watchlist rankings, activity feed) over those rows.
//
// Why a service account and not OAuth2 user auth?
//   Workers are server-side; there's no human present to consent. The service
//   account acts as a non-human principal granted read-only access to one
//   specific GA4 property. The README walks through the GCP-side setup.

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

function corsHeaders(env, origin) {
  const allowList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  // Echo the origin back if it's allowed, otherwise pick the first allowed
  // entry (so requests from curl / Postman that don't send Origin still work).
  const allow = allowList.includes(origin) ? origin : (allowList[0] || '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Ingest-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, init = {}, env, origin) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(env, origin),
      ...(init.headers || {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Google service-account JWT mint  →  OAuth2 access token  →  call GA4 Data API
// ---------------------------------------------------------------------------
//
// We sign a short JWT with the service account's RSA private key, exchange it
// at Google's token endpoint for a 1-hour bearer token, and cache that token
// in module-global state so we don't re-sign on every request inside the same
// Worker isolate. Workers reuse isolates across requests, so this cache is
// genuinely useful — typically 1 mint per ~50 minutes per region.

let _cachedToken = null;        // { token: string, expiresAt: number(ms) }

async function getGoogleAccessToken(env) {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresAt > now + 60_000) {
    return _cachedToken.token;
  }

  if (!env.GA_SERVICE_ACCOUNT_JSON) {
    throw new Error('GA_SERVICE_ACCOUNT_JSON secret is not set. Run `wrangler secret put GA_SERVICE_ACCOUNT_JSON`.');
  }

  let sa;
  try {
    sa = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error('GA_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message);
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key.');
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat,
    exp,
  };

  const enc = (obj) => b64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = enc(header) + '.' + enc(payload);

  const key = await importPkcs8(sa.private_key);
  const sigBuf = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = signingInput + '.' + b64urlBytes(new Uint8Array(sigBuf));

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error('Google token exchange failed (' + tokenRes.status + '): ' + text);
  }
  const tokenJson = await tokenRes.json();

  _cachedToken = {
    token: tokenJson.access_token,
    expiresAt: now + (tokenJson.expires_in * 1000),
  };
  return _cachedToken.token;
}

// PEM → CryptoKey for RS256 signing. Strips the BEGIN/END lines, base64-decodes
// the body, imports it as a PKCS#8 RSA private key.
async function importPkcs8(pemString) {
  const pemContents = pemString
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binaryDer = b64ToBytes(pemContents);
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function b64urlBytes(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// Back-compat with the existing analytics.html which does:
//   fetch(WORKER_URL, { method: 'POST', body: JSON.stringify({ endpoint: ':runReport', body: {...} }) })
//
// We forward to the GA4 Data API with a fresh bearer token. The `endpoint` is
// either ':runReport' or ':runRealtimeReport' — anything else is rejected so
// the worker can't be used to call arbitrary Google APIs.
async function handleGAProxy(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, { status: 400 }, env, origin); }

  const allowedEndpoints = new Set([':runReport', ':runRealtimeReport']);
  if (!allowedEndpoints.has(body.endpoint)) {
    return json({ error: 'Unsupported endpoint: ' + body.endpoint }, { status: 400 }, env, origin);
  }

  let token;
  try { token = await getGoogleAccessToken(env); }
  catch (e) { return json({ error: e.message }, { status: 500 }, env, origin); }

  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${env.GA4_PROPERTY_ID}${body.endpoint}`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body.body || {}),
  });
  const respText = await upstream.text();
  // Pass GA's response through verbatim, including its error shape, so the
  // dashboard's existing error display keeps working.
  return new Response(respText, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(env, origin),
    },
  });
}

// POST /event — write one identified-user event row to D1.
// Requires X-Ingest-Token header matching EVENT_INGEST_TOKEN secret (so
// random people can't write spam rows into your DB).
async function handleEventIngest(req, env, origin) {
  const headerToken = req.headers.get('X-Ingest-Token') || '';
  if (!env.EVENT_INGEST_TOKEN || headerToken !== env.EVENT_INGEST_TOKEN) {
    return json({ error: 'unauthorized' }, { status: 401 }, env, origin);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, { status: 400 }, env, origin); }

  if (!body.member_id || !body.event_name) {
    return json({ error: 'member_id and event_name are required' }, { status: 400 }, env, origin);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO events
       (ts, client_ts, member_id, email, member_name, plan, event_name,
        session_id, path, referrer, user_agent, props_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      nowSec,
      body.client_ts || null,
      String(body.member_id),
      body.email || null,
      body.member_name || null,
      body.plan || null,
      String(body.event_name),
      body.session_id || null,
      body.path || null,
      body.referrer || null,
      req.headers.get('User-Agent') || null,
      body.props ? JSON.stringify(body.props) : null,
    ).run();
  } catch (e) {
    return json({ error: 'DB insert failed: ' + e.message }, { status: 500 }, env, origin);
  }

  return json({ ok: true }, {}, env, origin);
}

// GET /people — list of identified members, most recently active first.
// Returns rich per-member stats (sessions, active_days) computed from the
// raw events table. Cheap at low volume; if rows ever exceed ~10k we'd
// move sessions/active_days to a precomputed table.
async function handlePeople(env, origin, url) {
  const rs = await env.DB.prepare(
    `SELECT member_id, email, member_name, plan, ts
     FROM events
     ORDER BY member_id ASC, ts DESC`
  ).all();

  // Walk rows, group by member, compute stats in one pass.
  const members = new Map();
  for (const row of (rs.results || [])) {
    let m = members.get(row.member_id);
    if (!m) {
      m = {
        member_id: row.member_id,
        email: row.email,
        member_name: row.member_name,
        plan: row.plan,
        timestamps: [],
      };
      members.set(row.member_id, m);
    }
    // Latest values for email/name/plan win (the newest event for the
    // member, since the SELECT is member ASC + ts DESC, so the first
    // row for each member is its most recent event).
    if (m.timestamps.length === 0) {
      m.email = row.email;
      m.member_name = row.member_name;
      m.plan = row.plan;
    }
    m.timestamps.push(row.ts);
  }

  const out = Array.from(members.values()).map(m => {
    const ts = m.timestamps; // already in DESC order
    const stats = computeMemberStats(ts);
    return {
      member_id: m.member_id,
      email: m.email,
      member_name: m.member_name,
      plan: m.plan,
      event_count: ts.length,
      last_seen_ts: ts[0],
      first_seen_ts: ts[ts.length - 1],
      sessions: stats.sessions,
      active_days: stats.activeDays,
    };
  }).sort((a, b) => b.last_seen_ts - a.last_seen_ts);

  return json({ rows: out }, {}, env, origin);
}

// Session boundary: 30 minutes of inactivity ends a session.
// Active day: distinct UTC day with at least one event.
// Both metrics expect timestamps in DESC order (newest first).
function computeMemberStats(timestampsDesc) {
  if (!timestampsDesc.length) return { sessions: 0, activeDays: 0 };
  const days = new Set();
  let sessions = 1;
  for (let i = 0; i < timestampsDesc.length; i++) {
    days.add(Math.floor(timestampsDesc[i] / 86400));
    if (i > 0 && (timestampsDesc[i - 1] - timestampsDesc[i]) > 1800) sessions++;
  }
  return { sessions, activeDays: days.size };
}

// GET /stats — high-level dashboard counters in one round trip.
// Powers the four hero cards at the top of the dashboard.
async function handleStats(env, origin) {
  const rs = await env.DB.prepare(
    `SELECT member_id, plan, ts, event_name FROM events`
  ).all();
  const rows = rs.results || [];

  const memberPlans = new Map(); // member_id -> latest known plan
  const nowSec = Math.floor(Date.now() / 1000);
  const day = 86400;
  let eventsToday = 0;
  let eventsLast7d = 0;
  let eventsPrev7d = 0;
  const activeMembers7d = new Set();

  // First pass: pick most-recent plan per member. Rows aren't sorted, so
  // we need to track timestamps to know which plan value is "latest."
  const planTs = new Map(); // member_id -> latest ts seen
  for (const r of rows) {
    if (!planTs.has(r.member_id) || planTs.get(r.member_id) < r.ts) {
      planTs.set(r.member_id, r.ts);
      memberPlans.set(r.member_id, r.plan);
    }
    const age = nowSec - r.ts;
    if (age < day) eventsToday++;
    if (age < 7 * day) { eventsLast7d++; activeMembers7d.add(r.member_id); }
    else if (age < 14 * day) eventsPrev7d++;
  }

  let paidMembers = 0, freeMembers = 0;
  for (const plan of memberPlans.values()) {
    if (plan === 'paid') paidMembers++;
    else freeMembers++;
  }

  // Active members in the last 5 minutes (replaces the GA4 realtime card,
  // which can't be filtered by hostname). This is identified-member only —
  // exactly what we want for a "who's on map.oftmw.com right now" signal
  // in a dashboard focused on logged-in users.
  const fiveMinAgo = nowSec - 300;
  const activeNow = new Set();
  for (const r of rows) {
    if (r.ts >= fiveMinAgo) activeNow.add(r.member_id);
  }

  // Use snapshot-aware computation (covers backlogged watchlists too).
  const perMember = await computeWatchlists(env);
  const activeProjects = new Set();
  let totalActive = 0;
  for (const m of perMember.values()) {
    totalActive += m.current.size;
    for (const p of m.current) activeProjects.add(p);
  }

  return json({
    members_total: memberPlans.size,
    members_paid: paidMembers,
    members_free: freeMembers,
    active_now: activeNow.size,
    active_members_7d: activeMembers7d.size,
    events_today: eventsToday,
    events_last_7d: eventsLast7d,
    events_prev_7d: eventsPrev7d,
    events_total: rows.length,
    watchlist_unique_projects: activeProjects.size,
    watchlist_total_active: totalActive,
  }, {}, env, origin);
}

// GET /member?id=... — full profile + timeline + computed analytics for a
// single member. Powers the click-to-drill-in modal in the dashboard.
async function handleMember(env, origin, url) {
  const memberId = url.searchParams.get('id');
  if (!memberId) return json({ error: 'id required' }, { status: 400 }, env, origin);

  const rs = await env.DB.prepare(
    `SELECT ts, event_name, path, props_json, email, member_name, plan
     FROM events
     WHERE member_id = ?
     ORDER BY ts DESC`
  ).bind(memberId).all();
  const events = rs.results || [];

  if (!events.length) {
    return json({ profile: null, stats: null, timeline: [] }, {}, env, origin);
  }

  // Profile = most recent values (events are DESC, so events[0] is newest)
  const profile = {
    member_id: memberId,
    email: events[0].email,
    member_name: events[0].member_name,
    plan: events[0].plan,
  };

  const timestamps = events.map(e => e.ts);
  const stats = computeMemberStats(timestamps);

  // Top projects: rank by project-touching event count (clicks + views +
  // detail opens + favorites). Use project_slug if present, else project_name.
  const projectEvents = ['project_click', 'project_view', 'project_detail_open', 'favorite_added', 'intel_view'];
  const projectCounts = new Map();
  for (const e of events) {
    if (!projectEvents.includes(e.event_name)) continue;
    let props = {};
    try { if (e.props_json) props = JSON.parse(e.props_json); } catch {}
    const name = props.project_name || props.project_slug || props.title;
    if (!name) continue;
    projectCounts.set(name, (projectCounts.get(name) || 0) + 1);
  }
  const topProjects = Array.from(projectCounts.entries())
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Daily activity, last 30 days (oldest → newest for chart left-to-right)
  const nowDay = Math.floor(Date.now() / 1000 / 86400);
  const daily = Array(30).fill(0);
  for (const e of events) {
    const d = Math.floor(e.ts / 86400);
    const offset = nowDay - d;
    if (offset >= 0 && offset < 30) daily[29 - offset]++;
  }

  // Current watchlist for this member: snapshot baseline + subsequent
  // add/remove events. We walk this member's events ASC; a watchlist_snapshot
  // resets the baseline, favorite_added/_removed mutate it.
  const watchState = new Map(); // project -> last touch ts (or null if removed)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    let props = {};
    try { if (e.props_json) props = JSON.parse(e.props_json); } catch {}
    if (e.event_name === 'watchlist_snapshot') {
      // Reset to baseline from Memberstack at the time of snapshot.
      const slugs = (props.watchlist_slugs || '').split(',').map(s => s.trim()).filter(Boolean);
      watchState.clear();
      for (const s of slugs) watchState.set(s, e.ts);
      continue;
    }
    if (e.event_name === 'favorite_added') {
      const project = props.project_slug || props.project_name || props.title;
      if (project) watchState.set(project, e.ts);
    } else if (e.event_name === 'favorite_removed') {
      const project = props.project_slug || props.project_name || props.title;
      if (project) watchState.delete(project);
    }
  }
  const watchlist = Array.from(watchState.entries())
    .map(([project, added_ts]) => ({ project, added_ts }))
    .sort((a, b) => b.added_ts - a.added_ts);

  return json({
    profile,
    stats: {
      event_count: events.length,
      sessions: stats.sessions,
      active_days: stats.activeDays,
      first_seen_ts: events[events.length - 1].ts,
      last_seen_ts: events[0].ts,
    },
    top_projects: topProjects,
    watchlist,
    daily_counts: daily,
    // Hide watchlist_snapshot from the user-facing timeline — it's a
    // state-sync event, not a user action. The watchlist itself is rendered
    // separately above.
    timeline: events
      .filter(e => e.event_name !== 'watchlist_snapshot')
      .slice(0, 200)
      .map(e => ({
        ts: e.ts,
        event_name: e.event_name,
        path: e.path,
        props_json: e.props_json,
      })),
  }, {}, env, origin);
}

// GET /timeline?member_id=... — every event for one member, newest first.
async function handleTimeline(env, origin, url) {
  const memberId = url.searchParams.get('member_id');
  if (!memberId) return json({ error: 'member_id required' }, { status: 400 }, env, origin);
  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 2000);
  const rs = await env.DB.prepare(
    `SELECT ts, event_name, path, props_json
     FROM events
     WHERE member_id = ?
     ORDER BY ts DESC
     LIMIT ?`
  ).bind(memberId, limit).all();
  return json({ rows: rs.results || [] }, {}, env, origin);
}

// Compute current watchlist state per member, using snapshot events as the
// baseline plus any favorite_added/_removed events after the snapshot.
//
// This is what fixes the "I have watchlists from before tracking started
// and they're not showing up" problem — the map.oftmw.com side now emits
// a `watchlist_snapshot` event on every page load with the full current
// Memberstack list, so we can rebuild authoritative state from any point.
//
// Returns:
//   Map<member_id, { current: Set<project>, addEventsByProject: Map<project,count>,
//                    lastTouchByProject: Map<project, ts> }>
async function computeWatchlists(env) {
  const rs = await env.DB.prepare(
    `SELECT event_name, props_json, member_id, ts
     FROM events
     WHERE event_name IN ('watchlist_snapshot','favorite_added','favorite_removed')
     ORDER BY member_id ASC, ts ASC`
  ).all();

  const perMember = new Map(); // member_id -> { current, addEventsByProject, lastTouchByProject, snapshotSeen }
  for (const row of (rs.results || [])) {
    let m = perMember.get(row.member_id);
    if (!m) {
      m = { current: new Set(), addEventsByProject: new Map(), lastTouchByProject: new Map(), snapshotSeen: false };
      perMember.set(row.member_id, m);
    }
    let props = {};
    try { if (row.props_json) props = JSON.parse(row.props_json); } catch {}

    if (row.event_name === 'watchlist_snapshot') {
      // Snapshot replaces baseline. Newer snapshots win because rows are ASC.
      const slugs = (props.watchlist_slugs || '').split(',').map(s => s.trim()).filter(Boolean);
      m.current = new Set(slugs);
      for (const s of slugs) {
        if (!m.lastTouchByProject.has(s)) m.lastTouchByProject.set(s, row.ts);
      }
      m.snapshotSeen = true;
      continue;
    }

    const project = props.project_slug || props.project_name || props.title;
    if (!project) continue;

    if (row.event_name === 'favorite_added') {
      m.current.add(project);
      m.addEventsByProject.set(project, (m.addEventsByProject.get(project) || 0) + 1);
      m.lastTouchByProject.set(project, row.ts);
    } else { // favorite_removed
      m.current.delete(project);
      m.lastTouchByProject.set(project, row.ts);
    }
  }
  return perMember;
}

// GET /watchlist — currently-watched projects ranked by # of members watching.
// Now includes backlogged watchlists thanks to watchlist_snapshot events.
async function handleWatchlist(env, origin, url) {
  const perMember = await computeWatchlists(env);

  const watchers   = new Map(); // project -> Set(member_id) currently watching
  const totalAdds  = new Map(); // project -> total favorite_added events tracked
  const lastTouch  = new Map(); // project -> most recent add/snapshot ts

  for (const [memberId, m] of perMember.entries()) {
    for (const project of m.current) {
      if (!watchers.has(project)) watchers.set(project, new Set());
      watchers.get(project).add(memberId);
    }
    for (const [project, count] of m.addEventsByProject.entries()) {
      totalAdds.set(project, (totalAdds.get(project) || 0) + count);
    }
    for (const [project, ts] of m.lastTouchByProject.entries()) {
      if (!lastTouch.has(project) || lastTouch.get(project) < ts) lastTouch.set(project, ts);
    }
  }

  const allProjects = new Set([...watchers.keys(), ...totalAdds.keys()]);
  const out = Array.from(allProjects).map(p => ({
    project: p,
    current_watchers: (watchers.get(p) || new Set()).size,
    total_adds: totalAdds.get(p) || 0,
    last_touch_ts: lastTouch.get(p) || 0,
  }))
  .filter(r => r.current_watchers > 0 || r.total_adds > 0)
  .sort((a, b) => b.current_watchers - a.current_watchers || b.total_adds - a.total_adds)
  .slice(0, 50);

  return json({ rows: out }, {}, env, origin);
}

// GET /activity — live feed: most recent N events across all members.
// Excludes 'watchlist_snapshot' (fires every page load, would flood the feed)
// since it's a state-sync mechanism, not a user-visible action.
async function handleActivity(env, origin, url) {
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
  const rs = await env.DB.prepare(
    `SELECT ts, member_id, email, member_name, plan, event_name, path, props_json
     FROM events
     WHERE event_name != 'watchlist_snapshot'
     ORDER BY ts DESC
     LIMIT ?`
  ).bind(limit).all();
  return json({ rows: rs.results || [] }, {}, env, origin);
}

// GET /projects — most-clicked projects across multiple time windows.
// Aggregates `project_click` events from identified members (the only ones
// stored in D1). For each project we return click counts for today, 7d,
// 30d, 90d, and all-time, plus the last-click timestamp.
//
// "Today" is rolling 24 hours, not calendar day — matches how the rest of
// the dashboard does time bucketing ("5d ago" not "Tuesday").
async function handleProjects(env, origin, url) {
  const limit  = clampInt(url.searchParams.get('limit'), 50, 1, 500);
  const events = (url.searchParams.get('events') || 'project_click')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Build a parameterized IN clause safely.
  const placeholders = events.map(() => '?').join(',');
  const rs = await env.DB.prepare(
    `SELECT ts, props_json
     FROM events
     WHERE event_name IN (${placeholders})
     ORDER BY ts DESC`
  ).bind(...events).all();

  const nowSec = Math.floor(Date.now() / 1000);
  const day    = 86400;
  const cToday = nowSec - day;
  const c7d    = nowSec - 7 * day;
  const c30d   = nowSec - 30 * day;
  const c90d   = nowSec - 90 * day;

  const projects = new Map(); // project_name -> aggregate row
  for (const row of (rs.results || [])) {
    let props = {};
    try { if (row.props_json) props = JSON.parse(row.props_json); } catch {}
    const name = props.project_name || props.title || props.project_slug;
    if (!name) continue;

    let p = projects.get(name);
    if (!p) {
      p = {
        project: name,
        city: props.project_city || null,
        featured: !!props.project_featured,
        total: 0, today: 0, last_7d: 0, last_30d: 0, last_90d: 0,
        last_click_ts: 0,
      };
      projects.set(name, p);
    }
    p.total++;
    if (row.ts >= cToday) p.today++;
    if (row.ts >= c7d)    p.last_7d++;
    if (row.ts >= c30d)   p.last_30d++;
    if (row.ts >= c90d)   p.last_90d++;
    if (row.ts > p.last_click_ts) p.last_click_ts = row.ts;
  }

  const out = Array.from(projects.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  return json({ rows: out }, {}, env, origin);
}

function clampInt(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// /blog — proxy the Wix blog RSS feed and reshape it into clean JSON.
// Cached at the edge for 30s so publishing → live takes ~30 sec, not minutes.
// ---------------------------------------------------------------------------

async function handleBlog(env, origin, url) {
  const feedUrl = env.BLOG_FEED_URL || 'https://www.oftmw.com/blog-feed.xml';
  const limit   = clampInt(url.searchParams.get('limit'), 50, 1, 100);

  const upstream = await fetch(feedUrl, {
    cf: { cacheTtl: 30, cacheEverything: true },
    headers: { 'User-Agent': 'tmw-journal/1.0' },
  });
  if (!upstream.ok) {
    return json({ error: 'feed fetch failed', status: upstream.status }, { status: 502 }, env, origin);
  }
  const xml = await upstream.text();
  const items = parseRssItems(xml).slice(0, limit);

  return json(
    { feedUrl, count: items.length, items, fetchedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=30' } },
    env,
    origin,
  );
}

// Tiny dependency-free RSS 2.0 parser. We only need a handful of fields, so
// regex against the (well-formed) Wix output is fine — no XML parser in
// Workers without adding a dep, and the feed shape is stable.
//
// opts.includeBody = true adds `content_html` (full post body HTML, as Wix
// renders it). This is heavy (~10–40KB per post), so it's opt-in — list
// endpoints leave it off, the /post/:slug endpoint turns it on.
function parseRssItems(xml, opts = {}) {
  const includeBody = !!opts.includeBody;
  const out = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/g;
  const matches = xml.match(itemRe) || [];
  for (const block of matches) {
    const title       = decodeXml(pickTag(block, 'title'));
    const link        = decodeXml(pickTag(block, 'link'));
    const guid        = decodeXml(pickTag(block, 'guid'));
    const pubDate     = pickTag(block, 'pubDate');
    const author      = decodeXml(pickTag(block, 'dc:creator'));
    const descriptionRaw = pickTag(block, 'description');
    const contentRaw  = pickTag(block, 'content:encoded');
    const enclosure   = pickAttr(block, 'enclosure', 'url');

    // Categories — RSS allows many <category> tags per item. Wix wraps each
    // value in CDATA, so unwrap before decoding entities.
    const cats = [];
    const catRe = /<category\b[^>]*>([\s\S]*?)<\/category>/g;
    let m;
    while ((m = catRe.exec(block)) !== null) {
      const raw = m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
      const c = decodeXml(raw).trim();
      if (c) cats.push(c);
    }

    // Strip HTML out of description to get a clean summary card body.
    const description = decodeXml(descriptionRaw);
    const summary = htmlToText(description).slice(0, 240);

    // Wix RSS sometimes only puts the image in <description> as <img src>.
    // Fall back to that if no <enclosure>.
    const image = enclosure || pickImgSrc(description) || pickImgSrc(contentRaw);

    // Slug derived from the /post/<slug> URL pattern Wix uses.
    let slug = '';
    try { slug = new URL(link).pathname.replace(/^\/post\//, '').replace(/^\/+|\/+$/g, ''); } catch {}

    const item = {
      title,
      link,
      slug,
      guid,
      pubDate,
      isoDate: pubDate ? new Date(pubDate).toISOString() : null,
      author,
      categories: cats,
      summary,
      image,
    };
    // contentRaw is already CDATA-stripped by pickTag and contains the
    // literal HTML body — we do NOT decode XML entities here because
    // inside CDATA the body is unencoded. The client sanitizes before
    // rendering.
    if (includeBody) item.content_html = contentRaw;
    out.push(item);
  }
  return out;
}

function pickTag(block, tag) {
  const re = new RegExp('<' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^>]*>([\\s\\S]*?)</' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '>');
  const m = block.match(re);
  if (!m) return '';
  // Unwrap CDATA if present.
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

function pickAttr(block, tag, attr) {
  const re = new RegExp('<' + tag + '\\b[^>]*\\b' + attr + '="([^"]+)"', 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function pickImgSrc(html) {
  if (!html) return '';
  const m = html.match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1] : '';
}

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXml(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// posts table — first-class storage for journal articles.
//
// All 1,377 Wix posts get imported here once via /admin/sync-wix; after
// that, Studio (/journal/studio/) edits this table directly and Wix is
// decommissioned. The article page reads from this table.
// ---------------------------------------------------------------------------

async function handlePostsList(env, origin, url) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  const limit  = clampInt(url.searchParams.get('limit'), 20, 1, 100);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 10000);
  const status = url.searchParams.get('status') || 'published';
  const category = url.searchParams.get('category');
  const q = (url.searchParams.get('q') || '').trim();

  // status=published is public; anything else requires admin token
  if (status !== 'published') {
    if (!checkAdminAuth(env, origin)) return json({ error: 'unauthorized for non-published' }, { status: 401 }, env, origin);
  }

  const where = ['status = ?1'];
  const params = [status];
  let p = 2;
  if (category) { where.push(`categories LIKE ?${p}`); params.push('%"' + category + '"%'); p++; }
  if (q)        { where.push(`(title LIKE ?${p} OR excerpt LIKE ?${p})`); params.push('%' + q + '%'); p++; }
  const whereSql = where.join(' AND ');

  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM posts WHERE ${whereSql}`).bind(...params).first();
  const rows  = await env.DB.prepare(`
    SELECT id, slug, title, excerpt, cover_image, cover_image_alt, categories, tags,
           author_name, status, published_at, reading_time_min, wix_url
    FROM posts WHERE ${whereSql}
    ORDER BY COALESCE(published_at, updated_at) DESC
    LIMIT ${limit} OFFSET ${offset}
  `).bind(...params).all();

  const items = (rows.results || []).map(rowToPostSummary);
  return json(
    { items, total: total ? total.c : 0, limit, offset, hasMore: offset + items.length < (total ? total.c : 0) },
    { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60' } },
    env, origin,
  );
}

async function handlePostsBySlug(env, origin, slug) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  // Decode URL-encoded chars so Unicode slugs (é, à, í, etc.) match what
  // Wix stored in the DB during sync. URLSearchParams in the client
  // gives us the decoded value, but encodeURIComponent re-encodes for
  // transit, so we have to decode here on the worker side.
  try { slug = decodeURIComponent(slug); } catch {}
  // Permit non-ASCII Unicode letters in slugs (Wix allows them).
  if (!slug || slug.length > 250 || /[<>"'`\s]/.test(slug)) {
    return json({ error: 'invalid slug' }, { status: 400 }, env, origin);
  }
  const row = await env.DB
    .prepare(`SELECT * FROM posts WHERE slug = ?1 LIMIT 1`)
    .bind(slug).first();
  if (!row) return json({ error: 'post not found in DB', slug }, { status: 404 }, env, origin);
  // Drafts only visible with admin token
  if (row.status !== 'published' && !checkAdminAuth(env, origin)) {
    return json({ error: 'post not yet published' }, { status: 404 }, env, origin);
  }
  return json(
    { post: rowToPostFull(row) },
    { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=120' } },
    env, origin,
  );
}

function rowToPostSummary(r) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt || '',
    cover_image: r.cover_image,
    cover_image_alt: r.cover_image_alt,
    categories: safeJsonArray(r.categories),
    tags: safeJsonArray(r.tags),
    author_name: r.author_name,
    status: r.status,
    published_at: r.published_at,
    published_iso: r.published_at ? new Date(r.published_at * 1000).toISOString() : null,
    reading_time_min: r.reading_time_min,
    wix_url: r.wix_url,
  };
}
function rowToPostFull(r) {
  return Object.assign(rowToPostSummary(r), {
    body_html: r.body_html,
    author_id: r.author_id,
    seo_title: r.seo_title,
    seo_description: r.seo_description,
    body_source: r.body_source,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}
function safeJsonArray(s) {
  try { const x = JSON.parse(s); return Array.isArray(x) ? x : []; }
  catch { return []; }
}
function checkAdminAuth(env, origin) {
  // Used for read endpoints — admin reads see drafts. (Writes use the
  // existing Authorization: Bearer pattern from handleListPost.)
  // Implemented as a header-check helper; expand if you add cookie auth.
  // We don't have access to the request here, so caller must do their own.
  return false;
}

// ---------------------------------------------------------------------------
// /admin/sync-wix — pull a batch of posts from the Wix Blog REST API,
// convert Ricos body → HTML, upsert into the posts table. Resumable:
// pass ?offset=N to pick up where you left off. The companion admin
// page at /journal/studio/sync.html drives this in a loop until done.
// ---------------------------------------------------------------------------

async function handleWixSync(req, env, origin, url) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  if (!env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN secret not set' }, { status: 500 }, env, origin);
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !constantTimeEqual(token, env.ADMIN_TOKEN)) {
    return json({ error: 'unauthorized' }, { status: 401 }, env, origin);
  }
  if (!env.WIX_API_KEY || !env.WIX_SITE_ID) {
    return json({ error: 'WIX_API_KEY and WIX_SITE_ID secrets must be set' }, { status: 500 }, env, origin);
  }

  const limit  = clampInt(url.searchParams.get('limit'), 50, 1, 100);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);

  // Wix Blog API — POST /blog/v3/posts/query with a JSON body. The plain
  // GET /posts endpoint is protobuf-backed and doesn't accept comma-separated
  // `fieldsets`; the /query endpoint takes a structured JSON body that
  // serializes cleanly.
  // Docs: https://dev.wix.com/docs/rest/business-solutions/blog/blog/posts/query-posts
  const wixUrl = 'https://www.wixapis.com/blog/v3/posts/query';
  const queryBody = {
    query: {
      paging: { limit, offset },
      sort: [{ fieldName: 'firstPublishedDate', order: 'DESC' }],
    },
    fieldsets: ['URL', 'RICH_CONTENT', 'SEO', 'METRICS'],
  };
  const wixRes = await fetch(wixUrl, {
    method: 'POST',
    headers: {
      'Authorization': env.WIX_API_KEY,
      'wix-site-id':   env.WIX_SITE_ID,
      'Content-Type':  'application/json',
      ...(env.WIX_ACCOUNT_ID ? { 'wix-account-id': env.WIX_ACCOUNT_ID } : {}),
    },
    body: JSON.stringify(queryBody),
  });
  if (!wixRes.ok) {
    const body = await wixRes.text();
    return json({ error: 'Wix API error', status: wixRes.status, body: body.slice(0, 500), endpoint: wixUrl }, { status: 502 }, env, origin);
  }
  const wixData = await wixRes.json();
  const wixPosts = wixData.posts || [];
  const total    = wixData.metaData && typeof wixData.metaData.total === 'number' ? wixData.metaData.total : null;

  // Author lookup helper — Wix returns memberId only. Cache resolves in a Map.
  const authorCache = new Map();
  async function resolveAuthor(memberId) {
    if (!memberId) return null;
    if (authorCache.has(memberId)) return authorCache.get(memberId);
    try {
      const r = await fetch(`https://www.wixapis.com/members/v1/members/${memberId}?fieldSet=PUBLIC`, {
        headers: { 'Authorization': env.WIX_API_KEY, 'wix-site-id': env.WIX_SITE_ID },
      });
      if (r.ok) {
        const data = await r.json();
        const name = (data.member && (data.member.profile?.nickname || data.member.contact?.firstName || data.member.profile?.title)) || null;
        authorCache.set(memberId, name);
        return name;
      }
    } catch {}
    authorCache.set(memberId, null);
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  let inserted = 0, updated = 0, failed = 0;
  const errors = [];

  for (const wp of wixPosts) {
    try {
      const slug = (wp.slug || '').toLowerCase().trim();
      if (!slug) { failed++; errors.push({ wixId: wp.id, error: 'no slug' }); continue; }

      // Convert Ricos JSON → HTML
      const bodyHtml = ricosToHtml(wp.richContent || {});
      const reading  = estimateReadingMinutes(bodyHtml);

      // Cover image
      let coverImage = '';
      let coverAlt = '';
      const cm = wp.media && (wp.media.wixMedia?.image || wp.coverMedia?.image);
      if (cm) {
        // Wix image src is e.g. "wix:image://v1/<id>~mv2.jpg/<filename>#..." — we want the public URL
        coverImage = wixMediaToPublicUrl(cm);
        coverAlt   = cm.altText || wp.title || '';
      }

      // Author name (best-effort)
      let authorName = null;
      if (wp.memberId) authorName = await resolveAuthor(wp.memberId);
      if (!authorName) authorName = 'Markets of Tomorrow';

      const cats = Array.isArray(wp.categoryIds) ? [] : []; // category lookup is a separate API; defer to v2
      const tags = Array.isArray(wp.tagIds) ? [] : [];      // ditto
      // For v1, we also pass through Wix's category labels if present in the URL/seo data
      if (Array.isArray(wp.tags)) for (const t of wp.tags) if (t.label) tags.push(t.label);

      const publishedAt = wp.firstPublishedDate ? Math.floor(new Date(wp.firstPublishedDate).getTime() / 1000) : null;
      const wixUrl = wp.url && wp.url.base && wp.url.path
        ? wp.url.base + wp.url.path
        : `https://www.oftmw.com/post/${slug}`;

      const seoTitle       = wp.seoData?.tags?.find(t => t.type === 'title')?.children || wp.title || null;
      const seoDescription = wp.seoData?.tags?.find(t => t.type === 'meta' && t.props?.name === 'description')?.props?.content
                          || wp.excerpt || null;

      const row = {
        id:              'wix-' + wp.id,
        slug,
        title:           wp.title || '(untitled)',
        excerpt:         wp.excerpt || '',
        body_html:       bodyHtml,
        cover_image:     coverImage,
        cover_image_alt: coverAlt,
        categories:      JSON.stringify(cats),
        tags:            JSON.stringify(tags),
        author_name:     authorName,
        author_id:       wp.memberId || null,
        status:          'published',
        published_at:    publishedAt,
        reading_time_min: reading,
        seo_title:       seoTitle,
        seo_description: seoDescription,
        wix_id:          wp.id,
        wix_url:         wixUrl,
        body_source:     'wix-import',
        created_at:      now,
        updated_at:      now,
      };

      // Upsert. Don't bump created_at on update.
      const existing = await env.DB.prepare(`SELECT id, created_at FROM posts WHERE wix_id = ?1`).bind(wp.id).first();
      if (existing) {
        await env.DB.prepare(`
          UPDATE posts SET
            slug = ?1, title = ?2, excerpt = ?3, body_html = ?4,
            cover_image = ?5, cover_image_alt = ?6, categories = ?7, tags = ?8,
            author_name = ?9, author_id = ?10, status = ?11, published_at = ?12,
            reading_time_min = ?13, seo_title = ?14, seo_description = ?15,
            wix_url = ?16, body_source = ?17, updated_at = ?18
          WHERE wix_id = ?19
        `).bind(
          row.slug, row.title, row.excerpt, row.body_html,
          row.cover_image, row.cover_image_alt, row.categories, row.tags,
          row.author_name, row.author_id, row.status, row.published_at,
          row.reading_time_min, row.seo_title, row.seo_description,
          row.wix_url, row.body_source, row.updated_at, wp.id,
        ).run();
        updated++;
      } else {
        await env.DB.prepare(`
          INSERT INTO posts (
            id, slug, title, excerpt, body_html, cover_image, cover_image_alt,
            categories, tags, author_name, author_id, status, published_at,
            reading_time_min, seo_title, seo_description, wix_id, wix_url,
            body_source, created_at, updated_at
          ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
        `).bind(
          row.id, row.slug, row.title, row.excerpt, row.body_html,
          row.cover_image, row.cover_image_alt, row.categories, row.tags,
          row.author_name, row.author_id, row.status, row.published_at,
          row.reading_time_min, row.seo_title, row.seo_description,
          row.wix_id, row.wix_url, row.body_source, row.created_at, row.updated_at,
        ).run();
        inserted++;
      }
    } catch (e) {
      failed++;
      errors.push({ wixId: wp.id, slug: wp.slug, error: (e && e.message) || String(e) });
    }
  }

  // Persist sync progress for resume.
  await env.DB.prepare(`
    INSERT INTO sync_state (key, value, updated_at) VALUES ('wix-last-offset', ?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(String(offset + wixPosts.length), now).run();

  const done = wixPosts.length < limit || (total !== null && offset + wixPosts.length >= total);
  return json({
    batch: { inserted, updated, failed, count: wixPosts.length },
    offset, nextOffset: offset + wixPosts.length,
    total, done,
    errors: errors.slice(0, 10),
  }, {}, env, origin);
}

// /admin/wix-debug/:slug — fetch one post fresh from Wix and dump the raw
// richContent so we can see the actual node + image shape. Admin-gated.
async function handleWixDebug(req, env, origin, slug) {
  // Decode URL-encoded chars (e.g. %C3%A9 → é) so the Wix slug filter
  // matches what's actually stored. Without this, any post with a
  // non-ASCII slug character returns zero matches.
  try { slug = decodeURIComponent(slug); } catch {}

  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !constantTimeEqual(token, env.ADMIN_TOKEN || '')) {
    return json({ error: 'unauthorized' }, { status: 401 }, env, origin);
  }
  if (!env.WIX_API_KEY || !env.WIX_SITE_ID) {
    return json({ error: 'WIX_API_KEY/WIX_SITE_ID not set' }, { status: 500 }, env, origin);
  }

  // Use the same /query endpoint that works for sync, filtered to one slug.
  const wixRes = await fetch('https://www.wixapis.com/blog/v3/posts/query', {
    method: 'POST',
    headers: {
      'Authorization': env.WIX_API_KEY,
      'wix-site-id':   env.WIX_SITE_ID,
      'Content-Type':  'application/json',
      ...(env.WIX_ACCOUNT_ID ? { 'wix-account-id': env.WIX_ACCOUNT_ID } : {}),
    },
    body: JSON.stringify({
      query: {
        filter: { slug: { $eq: slug } },
        paging: { limit: 1 },
      },
      fieldsets: ['URL', 'RICH_CONTENT', 'CONTENT', 'SEO', 'METRICS'],
    }),
  });
  if (!wixRes.ok) {
    return json({ error: 'Wix API error', status: wixRes.status, body: (await wixRes.text()).slice(0, 1000) }, { status: 502 }, env, origin);
  }
  const data = await wixRes.json();
  const post = (data && Array.isArray(data.posts) && data.posts[0]) || {};
  const rc = post.richContent || (post.content && JSON.parse(post.content || '{}')) || null;

  // Summarize node types + spotlight any IMAGE node so we can see its shape
  let nodeTypeCounts = {};
  let firstImageNode = null;
  let firstGalleryNode = null;
  if (rc && Array.isArray(rc.nodes)) {
    const walk = nodes => {
      for (const n of nodes) {
        if (!n || !n.type) continue;
        nodeTypeCounts[n.type] = (nodeTypeCounts[n.type] || 0) + 1;
        if (n.type === 'IMAGE'   && !firstImageNode)   firstImageNode   = n;
        if (n.type === 'GALLERY' && !firstGalleryNode) firstGalleryNode = n;
        if (Array.isArray(n.nodes)) walk(n.nodes);
      }
    };
    walk(rc.nodes);
  }

  return json({
    slug,
    hasRichContent: !!rc,
    nodeTypeCounts,
    firstImageNode,
    firstGalleryNode,
    converterOutput: rc ? ricosToHtml(rc).slice(0, 3000) : null,
    convertedHasImages: rc ? /<img/i.test(ricosToHtml(rc)) : false,
    // First 800 chars of the raw RC as a sanity probe
    richContentSample: rc ? JSON.stringify(rc).slice(0, 800) : null,
  }, {}, env, origin);
}

// Wix media field → public CDN URL.
//
// Wix returns image data in several shapes across endpoints:
//   { url: "https://static.wix..." }                                  // flat
//   { src: { url: "https://static.wix...", width, height } }          // Ricos
//   { src: "wix:image://v1/<hash>~mv2.jpeg/file" }                    // wix-URI string
//   { id:  "ca3b83_<hash>~mv2.jpeg" }                                 // bare media id
//   "ca3b83_<hash>~mv2.jpeg"                                          // raw string
//
// This handles all of them defensively so missing images don't drop
// silently.
function wixMediaToPublicUrl(image) {
  if (!image) return '';
  if (typeof image === 'string') image = { id: image };
  // 1. Flat URL
  if (typeof image.url === 'string' && image.url) return image.url;
  // 2. Ricos: image.src is an object with url
  if (image.src && typeof image.src === 'object' && typeof image.src.url === 'string') {
    return image.src.url;
  }
  // 2b. Ricos (most common shape in production): image.src.id — bare
  // media id that we wrap with the static CDN host. This is the path
  // most Wix posts hit; takes priority over the wix-URI string case.
  if (image.src && typeof image.src === 'object' && typeof image.src.id === 'string') {
    return `https://static.wixstatic.com/media/${image.src.id}`;
  }
  // 3. image.src as a string (wix-URI or http URL)
  if (typeof image.src === 'string' && image.src) {
    if (image.src.startsWith('http')) return image.src;
    const m = image.src.match(/wix:image:\/\/v1\/([^/]+)\//);
    if (m) return `https://static.wixstatic.com/media/${m[1]}`;
  }
  // 4. Bare media id
  if (typeof image.id === 'string' && image.id) {
    return `https://static.wixstatic.com/media/${image.id}`;
  }
  return '';
}

function estimateReadingMinutes(html) {
  if (!html) return 1;
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  return Math.max(1, Math.round(words / 220));
}

// ---------------------------------------------------------------------------
// Ricos → HTML converter
//
// Wix's Ricos format is a tree of nodes: PARAGRAPH, HEADING, IMAGE, etc.
// Each node has typed `*Data` fields and optionally child `nodes`. Text
// nodes carry `decorations` (BOLD, ITALIC, LINK, ...). This walks the
// tree and emits semantic HTML with no Wix-specific classes/styles.
//
// Coverage: PARAGRAPH, HEADING (1-6), BLOCKQUOTE, BULLETED_LIST,
//           ORDERED_LIST, LIST_ITEM, IMAGE (+ caption), VIDEO, DIVIDER,
//           CODE_BLOCK, HTML (sanitized passthrough), EMBED (iframe
//           allowlist), GALLERY (flex grid), TABLE (basic), LINK_PREVIEW.
// Decorations: BOLD, ITALIC, UNDERLINE, LINK. Color/font-size dropped.
// ---------------------------------------------------------------------------

const RICOS_IFRAME_ALLOWED = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be',
  'vimeo.com', 'player.vimeo.com',
  'open.spotify.com', 'spotify.com',
  'instagram.com', 'twitter.com', 'x.com',
];

function ricosToHtml(doc) {
  if (!doc || !Array.isArray(doc.nodes)) return '';
  return doc.nodes.map(n => ricosNodeToHtml(n)).join('');
}

function ricosNodeToHtml(node) {
  if (!node || !node.type) return '';
  switch (node.type) {
    case 'PARAGRAPH':      return `<p>${ricosChildren(node)}</p>`;
    case 'HEADING': {
      const lvl = Math.min(6, Math.max(1, (node.headingData && node.headingData.level) || 2));
      return `<h${lvl}>${ricosChildren(node)}</h${lvl}>`;
    }
    case 'BLOCKQUOTE':     return `<blockquote>${ricosChildren(node)}</blockquote>`;
    case 'BULLETED_LIST':  return `<ul>${ricosChildren(node)}</ul>`;
    case 'ORDERED_LIST':   return `<ol>${ricosChildren(node)}</ol>`;
    case 'LIST_ITEM':      return `<li>${ricosChildren(node)}</li>`;
    case 'DIVIDER':        return `<hr>`;
    case 'CODE_BLOCK':     return `<pre><code>${ricosChildren(node)}</code></pre>`;
    case 'IMAGE': {
      const id = node.imageData && node.imageData.image;
      const url = wixMediaToPublicUrl(id);
      if (!url) return '';
      const captionRaw = node.imageData && node.imageData.caption;
      const alt = (node.imageData && (node.imageData.altText
        || (typeof captionRaw === 'string' ? captionRaw : ''))) || '';
      // Caption may be a plain string OR a Ricos node tree (newer schema).
      // Also support child nodes attached to the IMAGE itself.
      let captionHtml = '';
      if (typeof captionRaw === 'string' && captionRaw.trim()) {
        captionHtml = escHtml(captionRaw);
      } else if (captionRaw && Array.isArray(captionRaw.nodes)) {
        captionHtml = captionRaw.nodes.map(n => ricosNodeToHtml(n)).join('');
      } else if (node.nodes && Array.isArray(node.nodes) && node.nodes.length) {
        captionHtml = ricosChildren(node);
      }
      return `<figure><img src="${escAttr(url)}" alt="${escAttr(alt)}" loading="lazy">${captionHtml ? `<figcaption>${captionHtml}</figcaption>` : ''}</figure>`;
    }
    case 'VIDEO': {
      const vd = node.videoData || {};
      const videoUrl = (vd.video && vd.video.src && vd.video.src.url) || vd.thumbnail?.src?.url || '';
      if (vd.video && vd.video.src && vd.video.src.url && /youtube|vimeo/i.test(vd.video.src.url)) {
        const src = vd.video.src.url;
        const host = (() => { try { return new URL(src).host; } catch { return ''; } })();
        if (RICOS_IFRAME_ALLOWED.some(h => host === h || host.endsWith('.' + h))) {
          return `<figure><iframe src="${escAttr(src)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></figure>`;
        }
      }
      if (videoUrl) return `<figure><video src="${escAttr(videoUrl)}" controls playsinline preload="metadata"></video></figure>`;
      return '';
    }
    case 'GALLERY': {
      const items = (node.galleryData && node.galleryData.items) || [];
      if (!items.length) return '';
      const imgs = items.map(it => {
        // Gallery items can carry the image in a few places depending on
        // Wix's schema rev: it.image, it.image.media, or it itself.
        const candidate = (it.image && it.image.media) || it.image || it;
        const url = wixMediaToPublicUrl(candidate);
        if (!url) return '';
        return `<img src="${escAttr(url)}" alt="" loading="lazy">`;
      }).filter(Boolean).join('');
      if (!imgs) return '';
      return `<figure class="ricos-gallery">${imgs}</figure>`;
    }
    case 'HTML': {
      const raw = (node.htmlData && (node.htmlData.html || node.htmlData.url)) || '';
      // For arbitrary HTML embeds Wix uses, prefer iframe URL if present
      if (node.htmlData && node.htmlData.url) {
        const url = node.htmlData.url;
        const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
        if (RICOS_IFRAME_ALLOWED.some(h => host === h || host.endsWith('.' + h))) {
          return `<figure><iframe src="${escAttr(url)}" loading="lazy" allowfullscreen></iframe></figure>`;
        }
      }
      // Else: passthrough raw HTML, but block <script>/handlers
      if (raw && typeof raw === 'string') {
        const clean = raw.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/\s+on[a-z]+="[^"]*"/gi, '');
        return clean;
      }
      return '';
    }
    case 'EMBED': {
      const url = (node.embedData && node.embedData.src) || '';
      if (!url) return '';
      const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
      if (RICOS_IFRAME_ALLOWED.some(h => host === h || host.endsWith('.' + h))) {
        return `<figure><iframe src="${escAttr(url)}" loading="lazy" allowfullscreen></iframe></figure>`;
      }
      return `<p><a href="${escAttr(url)}" target="_blank" rel="noopener">${escHtml(url)}</a></p>`;
    }
    case 'LINK_PREVIEW': {
      const url = (node.linkPreviewData && node.linkPreviewData.link && node.linkPreviewData.link.url) || '';
      const title = (node.linkPreviewData && node.linkPreviewData.title) || url;
      if (!url) return '';
      return `<p><a href="${escAttr(url)}" target="_blank" rel="noopener">${escHtml(title)}</a></p>`;
    }
    case 'TABLE': {
      const rows = (node.nodes || []).map(rn => `<tr>${(rn.nodes || []).map(cn => `<td>${ricosChildren(cn)}</td>`).join('')}</tr>`).join('');
      return rows ? `<table>${rows}</table>` : '';
    }
    case 'TABLE_ROW':   return `<tr>${ricosChildren(node)}</tr>`;
    case 'TABLE_CELL':  return `<td>${ricosChildren(node)}</td>`;
    case 'TEXT':        return ricosTextNode(node);
    default:
      // Unknown node type — walk children if any so we don't drop content
      return ricosChildren(node);
  }
}

function ricosChildren(node) {
  if (!node || !Array.isArray(node.nodes)) return '';
  return node.nodes.map(n => ricosNodeToHtml(n)).join('');
}

function ricosTextNode(node) {
  const text = (node.textData && node.textData.text) || '';
  if (!text) return '';
  let html = escHtml(text);
  const decos = (node.textData && Array.isArray(node.textData.decorations)) ? node.textData.decorations : [];
  // Apply LINK last (outermost) so other decorations sit inside it
  let link = null;
  for (const d of decos) {
    if (!d || !d.type) continue;
    if (d.type === 'BOLD')      html = `<strong>${html}</strong>`;
    else if (d.type === 'ITALIC')    html = `<em>${html}</em>`;
    else if (d.type === 'UNDERLINE') html = `<u>${html}</u>`;
    else if (d.type === 'LINK')      link = d.linkData && d.linkData.link;
  }
  if (link && link.url) {
    const target = link.target === 'BLANK' ? ' target="_blank" rel="noopener"' : '';
    html = `<a href="${escAttr(link.url)}"${target}>${html}</a>`;
  }
  return html;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escAttr(s) { return escHtml(s); }

// ---------------------------------------------------------------------------
// /post/:slug — return ONE full blog post including the body HTML.
//
// IMPORTANT: Wix's default RSS feed does NOT include <content:encoded>
// (verified against the live feed) — only title/summary/image. So we get
// the body by fetching the live Wix post page and extracting the content
// from Wix's Ricos viewer container (<div data-id="content-viewer">).
//
// This is "server-side scrape" — fragile because Wix can rename their
// internal markers. If they do, this handler returns body_html = null
// and the article page degrades to the RSS summary + "View on Wix" link.
//
// We still hit RSS first for the metadata (title, categories, image,
// author, pubDate) because that's cheap and gives us a 404 path for
// slugs not in the current 20-post window.
// ---------------------------------------------------------------------------

async function handlePost(env, origin, slug) {
  try { slug = decodeURIComponent(slug); } catch {}
  if (!slug || slug.length > 250 || /[<>"'`\s]/.test(slug)) {
    return json({ error: 'invalid slug' }, { status: 400 }, env, origin);
  }
  const feedUrl = env.BLOG_FEED_URL || 'https://www.oftmw.com/blog-feed.xml';
  const postBase = env.POST_BASE_URL || 'https://www.oftmw.com/post/';

  // 1. Pull metadata from RSS
  let item = null;
  try {
    const rssRes = await fetch(feedUrl, {
      cf: { cacheTtl: 60, cacheEverything: true },
      headers: { 'User-Agent': 'tmw-journal/1.0' },
    });
    if (rssRes.ok) {
      const xml = await rssRes.text();
      const items = parseRssItems(xml);
      const slugLc = slug.toLowerCase();
      item = items.find(it =>
        (it.slug && it.slug.toLowerCase() === slugLc) ||
        (it.link && it.link.toLowerCase().endsWith('/' + slugLc))
      ) || null;
    }
  } catch { /* fall through */ }

  // 2. Scrape the live Wix post page for the body
  const postUrl = postBase + slug;
  let bodyHtml = null;
  let scrapeError = null;
  try {
    const pageRes = await fetch(postUrl, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tmw-journal/1.0; +https://www.oftmw.com/)' },
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      bodyHtml = extractWixPostBody(html);
      if (!bodyHtml) scrapeError = 'content-viewer container not found in page';
    } else if (pageRes.status === 404) {
      // No fallback — post genuinely doesn't exist
      return json(
        { error: 'post not found', slug, postUrl },
        { status: 404 }, env, origin,
      );
    } else {
      scrapeError = 'page fetch ' + pageRes.status;
    }
  } catch (e) { scrapeError = e.message || String(e); }

  // 3. If we have neither RSS metadata nor a scraped body, 404
  if (!item && !bodyHtml) {
    return json(
      {
        error: 'post not in current RSS window and page scrape failed',
        slug, postUrl, scrapeError,
        hint: 'Wix only exposes the 20 most-recent posts via RSS, and we couldn\'t pull the page itself.',
      },
      { status: 404 }, env, origin,
    );
  }

  // 4. Synthesize a post object: RSS metadata + scraped body
  const post = item || { slug, link: postUrl, title: '', categories: [], author: '', pubDate: '', summary: '', image: '' };
  post.content_html = bodyHtml;
  post.source_url  = postUrl;
  post.body_source = bodyHtml ? 'wix-scrape' : 'none';
  if (scrapeError) post.scrape_error = scrapeError;

  return json(
    { post, fetchedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' } },
    env, origin,
  );
}

// Extract Wix Ricos viewer body from a server-rendered Wix post page.
// Wix wraps the article body in a <div data-id="content-viewer"> with
// rcv-block-first/last markers inside. We grab the inner HTML of that
// container, then strip Wix-specific class/style/data attributes so our
// own CSS owns the typography.
function extractWixPostBody(html) {
  if (!html) return null;
  // Locate the content-viewer opening tag
  const startMarker = 'data-id="content-viewer"';
  const idx = html.indexOf(startMarker);
  if (idx < 0) return null;
  // Walk back to the start of THAT <div>
  const tagStart = html.lastIndexOf('<div', idx);
  if (tagStart < 0) return null;
  // Find the end of the opening tag
  const openEnd = html.indexOf('>', idx);
  if (openEnd < 0) return null;

  // Now find the matching closing </div> by scanning forward and
  // tracking nesting depth (Wix bodies have nested divs everywhere).
  let depth = 1;
  let i = openEnd + 1;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = i;
  let m, closeAt = -1;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) { closeAt = m.index; break; }
    } else {
      depth++;
    }
  }
  if (closeAt < 0) return null;

  const inner = html.slice(openEnd + 1, closeAt);
  return cleanWixBodyHtml(inner);
}

function cleanWixBodyHtml(html) {
  if (!html) return '';
  let out = html;

  // --- 1. Strip Wix UI chrome that doesn't belong in the body ---
  // Image-expand buttons, icon SVGs, and Wix's "wow-image" wrapper
  // around <img> tags.
  out = out.replace(/<button\b[\s\S]*?<\/button>/gi, '');
  out = out.replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
  // Unwrap <wow-image> ... </wow-image> — keep the inner <img>
  out = out.replace(/<wow-image\b[^>]*>([\s\S]*?)<\/wow-image>/gi, '$1');
  // Generic safety net for any other wow-* custom elements Wix uses
  out = out.replace(/<wow-[a-z-]+\b[^>]*>([\s\S]*?)<\/wow-[a-z-]+>/gi, '$1');

  // --- 2. Rewrite Wix image URLs from blur thumbnails to full size ---
  // Pattern: https://static.wixstatic.com/media/<hash>~mv2.<ext>/v1/.../<hash>~mv2.<ext>
  // The transform path serves a small blurred placeholder for lazy-load;
  // dropping it returns the full original (verified 200 + ~460KB).
  out = out.replace(
    /(https?:\/\/static\.wixstatic\.com\/media\/[^/"'\s]+\.(?:jpe?g|png|webp|gif|avif))\/v1\/[^"'\s)]*/gi,
    '$1',
  );

  // --- 3. Strip Wix-specific attributes that pollute our typography ---
  out = out.replace(/\s+class="[^"]*"/g, '');
  out = out.replace(/\s+style="[^"]*"/g, '');
  out = out.replace(/\s+data-[a-z0-9-]+="[^"]*"/g, '');
  out = out.replace(/\s+id="viewer-[^"]*"/g, '');
  out = out.replace(/\s+id="[a-z0-9]{9,}"/gi, ''); // strip Wix hashed component ids
  out = out.replace(/\s+draggable="[^"]*"/g, '');
  out = out.replace(/\s+role="presentation"/g, '');

  // --- 4. Collapse Wix's deep div nesting wherever possible ---
  for (let pass = 0; pass < 6; pass++) {
    const before = out;
    out = out.replace(/<div>\s*<\/div>/g, '');
    out = out.replace(/<div\s+type="empty-line"><\/div>/g, '');
    out = out.replace(/<div\s+type="paragraph"><\/div>/g, '');
    out = out.replace(/<div\s+type="first"><\/div>/g, '');
    out = out.replace(/<div\s+type="last"><\/div>/g, '');
    // div > div (single child) → div
    out = out.replace(/<div>\s*(<div\b[^>]*>[\s\S]*?<\/div>)\s*<\/div>/g, '$1');
    if (out === before) break;
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// /list/:slug — server-side storage for the iconic-list pages (golf,
// restaurants, hotels…). GET is public + edge-cached briefly; POST requires
// the ADMIN_TOKEN secret in an Authorization: Bearer header.
//
// The full JSON document is stored as-is in `iconic_lists.data` so the page
// is the source of truth for its own schema — we don't need to migrate the
// table every time we add a field to a list.
// ---------------------------------------------------------------------------

const LIST_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

async function handleListGet(env, origin, slug) {
  if (!LIST_SLUG_RE.test(slug)) {
    return json({ error: 'invalid slug' }, { status: 400 }, env, origin);
  }
  if (!env.DB) {
    return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  }

  const row = await env.DB
    .prepare('SELECT data, updated_at, updated_by FROM iconic_lists WHERE slug = ?')
    .bind(slug)
    .first();

  if (!row) {
    // No row yet — return an empty scaffold so the page can render its
    // seed-data fallback. The first save creates the row.
    return json(
      { slug, exists: false, data: null },
      { headers: { 'Cache-Control': 'public, max-age=15, s-maxage=30' } },
      env,
      origin,
    );
  }

  let data;
  try { data = JSON.parse(row.data); }
  catch { return json({ error: 'stored JSON is corrupt' }, { status: 500 }, env, origin); }

  return json(
    { slug, exists: true, data, updatedAt: row.updated_at, updatedBy: row.updated_by },
    { headers: { 'Cache-Control': 'public, max-age=15, s-maxage=30' } },
    env,
    origin,
  );
}

async function handleListPost(req, env, origin, slug) {
  if (!LIST_SLUG_RE.test(slug)) {
    return json({ error: 'invalid slug' }, { status: 400 }, env, origin);
  }
  if (!env.DB) {
    return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  }
  if (!env.ADMIN_TOKEN) {
    return json({ error: 'ADMIN_TOKEN secret not set on worker' }, { status: 500 }, env, origin);
  }

  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !constantTimeEqual(token, env.ADMIN_TOKEN)) {
    return json({ error: 'unauthorized' }, { status: 401 }, env, origin);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid JSON body' }, { status: 400 }, env, origin); }

  // Light shape check so we don't store garbage. Caller can extend.
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
    return json({ error: 'body must be {title, items: [...]}' }, { status: 400 }, env, origin);
  }
  // Size guardrail — Workers + D1 can handle plenty, but a 1MB cap keeps
  // anyone from accidentally pasting a 50MB blob.
  const serialized = JSON.stringify(body);
  if (serialized.length > 1_000_000) {
    return json({ error: 'payload too large (1MB max)' }, { status: 413 }, env, origin);
  }

  const now = Math.floor(Date.now() / 1000);
  const updatedBy = (body.__updatedBy || '').toString().slice(0, 80) || null;
  // Strip the bookkeeping field before persisting so it doesn't pollute the doc.
  if ('__updatedBy' in body) delete body.__updatedBy;
  const cleanSerialized = JSON.stringify(body);

  await env.DB
    .prepare(`
      INSERT INTO iconic_lists (slug, data, updated_at, updated_by)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(slug) DO UPDATE SET
        data       = excluded.data,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `)
    .bind(slug, cleanSerialized, now, updatedBy)
    .run();

  return json({ ok: true, slug, updatedAt: now, updatedBy }, {}, env, origin);
}

// Length-safe compare so timing differences don't leak the token byte-by-byte.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }

    try {
      // Back-compat: POST / with { endpoint, body } → GA4 proxy.
      if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '')) {
        return await handleGAProxy(request, env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/event') {
        return await handleEventIngest(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/people') {
        return await handlePeople(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/stats') {
        return await handleStats(env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/member') {
        return await handleMember(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/timeline') {
        return await handleTimeline(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/watchlist') {
        return await handleWatchlist(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/projects') {
        return await handleProjects(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/activity') {
        return await handleActivity(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/blog') {
        return await handleBlog(env, origin, url);
      }
      // /posts — D1-backed canonical posts table (post-migration source).
      if (request.method === 'GET' && url.pathname === '/posts') {
        return await handlePostsList(env, origin, url);
      }
      {
        const m = url.pathname.match(/^\/posts\/by-slug\/([^/]+)\/?$/);
        if (m && request.method === 'GET') return await handlePostsBySlug(env, origin, m[1]);
      }
      // /admin/sync-wix — batched migration importer (admin-only)
      if (request.method === 'POST' && url.pathname === '/admin/sync-wix') {
        return await handleWixSync(request, env, origin, url);
      }
      // /admin/wix-debug/:slug — dump raw Wix response for one post so we
      // can see the actual richContent shape. Admin-only.
      {
        const m = url.pathname.match(/^\/admin\/wix-debug\/([^/]+)\/?$/);
        if (m && request.method === 'GET') {
          return await handleWixDebug(request, env, origin, m[1]);
        }
      }
      // /post/:slug — LEGACY scrape fallback (kept for backwards compat
      // until all posts are in D1). The article page tries /posts/by-slug
      // first and only falls through here for misses.
      {
        const m = url.pathname.match(/^\/post\/([^/]+)\/?$/);
        if (m && request.method === 'GET') {
          return await handlePost(env, origin, m[1]);
        }
      }
      // /list/:slug — public read, admin-token write. Used by the iconic
      // ranking pages (golf, restaurants, hotels…) for edit-in-page mode.
      {
        const m = url.pathname.match(/^\/list\/([^/]+)\/?$/);
        if (m) {
          const slug = m[1];
          if (request.method === 'GET')  return await handleListGet(env, origin, slug);
          if (request.method === 'POST') return await handleListPost(request, env, origin, slug);
        }
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, ts: Date.now() }, {}, env, origin);
      }
      return json({ error: 'not found', path: url.pathname }, { status: 404 }, env, origin);
    } catch (e) {
      // Catch-all so a thrown error never returns an opaque 1101 to the dashboard.
      return json({ error: e.message || String(e) }, { status: 500 }, env, origin);
    }
  },
};
