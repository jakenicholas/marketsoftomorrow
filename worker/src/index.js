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
    'Access-Control-Allow-Headers': 'Content-Type,X-Ingest-Token',
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
// /post/:slug — return ONE full blog post (title, metadata, AND the full
// `content:encoded` body HTML) so the journal can render Wix articles
// without bouncing back to Wix. Limited to whatever's in the current RSS
// window (Wix exposes the most-recent 20 posts).
// ---------------------------------------------------------------------------

async function handlePost(env, origin, slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,200}$/i.test(slug)) {
    return json({ error: 'invalid slug' }, { status: 400 }, env, origin);
  }
  const feedUrl = env.BLOG_FEED_URL || 'https://www.oftmw.com/blog-feed.xml';
  const upstream = await fetch(feedUrl, {
    cf: { cacheTtl: 60, cacheEverything: true },
    headers: { 'User-Agent': 'tmw-journal/1.0' },
  });
  if (!upstream.ok) {
    return json({ error: 'feed fetch failed', status: upstream.status }, { status: 502 }, env, origin);
  }
  const xml = await upstream.text();
  const items = parseRssItems(xml, { includeBody: true });
  // Match either by exact slug field or by the post's URL ending in /<slug>
  const slugLc = slug.toLowerCase();
  const item = items.find(it =>
    (it.slug && it.slug.toLowerCase() === slugLc) ||
    (it.link && it.link.toLowerCase().endsWith('/' + slugLc))
  );
  if (!item) {
    return json(
      {
        error: 'post not found in current RSS window',
        slug,
        hint: 'Wix only exposes the 20 most-recent posts via RSS. For older articles, use the Wix Headless API or keep the legacy URL alive.',
        candidates: items.map(it => it.slug).slice(0, 8),
      },
      { status: 404 },
      env, origin,
    );
  }
  return json(
    { post: item, fetchedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' } },
    env, origin,
  );
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
      // /post/:slug — full single article, including body HTML for the
      // article-page template at /journal/post/?slug=:slug.
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
