// Map of Tomorrow analytics worker.
// build-stamp: studio-v1 (posts + media + sync)
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

import { handleMcp, autoPromoteOpenedProjects } from './mcp.js';
import { handleOAuth } from './oauth.js';
import { handleGallery } from './gallery.js';

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

function corsHeaders(env, origin) {
  const allowList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  // Echo the origin back if it's allowed, otherwise fall back to the canonical
  // primary origin (so requests from curl / Postman that don't send Origin
  // still work). We deliberately never emit '*' here: a disallowed browser
  // origin will see an ACAO that doesn't match its own origin and the browser
  // will block the response, which is the behavior we want. (Auth, not CORS,
  // is the real access control — see requireAdminToken on the read endpoints.)
  const ok = allowList.includes(origin)
    || /^https:\/\/([a-z0-9-]+\.)*pages\.dev$/i.test(origin)   // Cloudflare Pages previews + deploys
    || /^https:\/\/([a-z0-9-]+\.)*oftmw\.com$/i.test(origin);  // any oftmw.com subdomain
  const allow = ok ? origin : (allowList[0] || 'https://map.oftmw.com');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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

export async function getGoogleAccessToken(env) {
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
  // Admin-gated: this forwards arbitrary report queries to the GA4 Data API
  // using our service-account token. Unauthenticated, it was a public read
  // proxy for ALL of the property's analytics. Only analytics.html calls it,
  // and it now sends Authorization: Bearer <ADMIN_TOKEN>.
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;

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
//
// SECURITY NOTE: the X-Ingest-Token is sent by every visitor's browser
// (it ships in public index.html source), so it is NOT a real secret — treat
// it as a soft speed-bump against trivial scripted spam, not as auth. Two
// things make this acceptable:
//   1. Blast radius is tiny. A forged request can only INSERT an analytics
//      row; it cannot read any member data — every read endpoint now requires
//      ADMIN_TOKEN (see requireAdminToken / ADMIN_READ_PATHS).
//   2. Defense-in-depth Origin check below rejects browser-based cross-site
//      forgery (it is best-effort: non-browser clients can omit/spoof Origin).
// If event spam ever becomes a real problem, add a Turnstile token or a
// per-IP/member rate limit (KV or Durable Object) rather than leaning on the
// shared token.
async function handleEventIngest(req, env, origin) {
  const headerToken = req.headers.get('X-Ingest-Token') || '';
  const tokenOk = !!env.EVENT_INGEST_TOKEN && headerToken === env.EVENT_INGEST_TOKEN;

  // Accept EITHER a token-authenticated server post OR a first-party browser
  // beacon (a trusted Origin). Browsers can't forge the Origin header, so a
  // trusted-origin request can only come from our own oftmw.com pages — that
  // lets the journal + media-kit identify logged-in members without shipping the
  // ingest secret into public JS. Server-to-server (blank Origin) needs the token.
  const reqOrigin = req.headers.get('Origin') || '';
  const allowList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const originOk = !!reqOrigin && (allowList.includes(reqOrigin)
    || /^https:\/\/([a-z0-9-]+\.)*pages\.dev$/i.test(reqOrigin)
    || /^https:\/\/([a-z0-9-]+\.)*oftmw\.com$/i.test(reqOrigin));

  if (!tokenOk && !originOk) {
    return json({ error: 'unauthorized' }, { status: 401 }, env, origin);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, { status: 400 }, env, origin); }

  if (!body.member_id || !body.event_name) {
    return json({ error: 'member_id and event_name are required' }, { status: 400 }, env, origin);
  }

  // Cloudflare auto-populates request.cf on incoming requests with the visitor's
  // edge-derived geography. Merge those into the event's props so the Studio
  // can display "Brooklyn, NY, US" on each activity row without a separate IP
  // lookup. Best-effort: cf can be absent during local dev / preview.
  const cf = req.cf || {};
  const geoProps = {};
  if (cf.city) geoProps.city = String(cf.city).slice(0, 60);
  if (cf.region) geoProps.region = String(cf.region).slice(0, 60);
  if (cf.regionCode) geoProps.regionCode = String(cf.regionCode).slice(0, 8);
  if (cf.country) geoProps.country = String(cf.country).slice(0, 4);
  const mergedProps = (body.props || Object.keys(geoProps).length) ? { ...(body.props || {}), ...geoProps } : null;

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
      mergedProps ? JSON.stringify(mergedProps) : null,
    ).run();
  } catch (e) {
    return json({ error: 'DB insert failed: ' + e.message }, { status: 500 }, env, origin);
  }

  return json({ ok: true }, {}, env, origin);
}

// /intel-thread — device-to-device TMW Intelligence chat resume for logged-in
// members. GET ?member_id=mem_… returns the saved query list; POST { member_id,
// qs:[…] } upserts it. First-party only (trusted Origin, same gate as /event);
// only real Memberstack accounts (mem_*) get a row, so anon/bot traffic never
// writes. Stores just the query strings (answers replay + re-cache on the new
// device) — small, and not sensitive.
async function handleIntelThread(request, env, origin, url) {
  const reqOrigin = request.headers.get('Origin') || '';
  const allowList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const originOk = !!reqOrigin && (allowList.includes(reqOrigin)
    || /^https:\/\/([a-z0-9-]+\.)*pages\.dev$/i.test(reqOrigin)
    || /^https:\/\/([a-z0-9-]+\.)*oftmw\.com$/i.test(reqOrigin));
  if (!originOk) return json({ error: 'unauthorized' }, { status: 401 }, env, origin);

  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS intel_threads (member_id TEXT PRIMARY KEY, thread_json TEXT, updated_at INTEGER)').run(); } catch (_) {}

  if (request.method === 'GET') {
    const memberId = url.searchParams.get('member_id') || '';
    if (memberId.indexOf('mem_') !== 0) return json({ ok: true, qs: [], ts: 0 }, {}, env, origin);
    let row = null;
    try { row = await env.DB.prepare('SELECT thread_json, updated_at FROM intel_threads WHERE member_id = ?').bind(memberId).first(); } catch (_) {}
    let qs = [];
    try { if (row && row.thread_json) qs = JSON.parse(row.thread_json); } catch (_) {}
    return json({ ok: true, qs: Array.isArray(qs) ? qs : [], ts: (row && row.updated_at) || 0 }, {}, env, origin);
  }

  // POST — upsert (last write wins; the most-recently-active device is truth).
  let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
  const memberId = String(body.member_id || '');
  if (memberId.indexOf('mem_') !== 0) return json({ ok: true, skipped: 'not a member account' }, {}, env, origin);
  const qs = Array.isArray(body.qs)
    ? body.qs.filter(q => typeof q === 'string' && q.trim()).map(q => q.slice(0, 200)).slice(-12)
    : [];
  const ts = Date.now();
  try {
    if (qs.length) await env.DB.prepare('INSERT OR REPLACE INTO intel_threads (member_id, thread_json, updated_at) VALUES (?,?,?)').bind(memberId, JSON.stringify(qs), ts).run();
    else await env.DB.prepare('DELETE FROM intel_threads WHERE member_id = ?').bind(memberId).run();
  } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
  return json({ ok: true, ts }, {}, env, origin);
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

// ---------------------------------------------------------------------------
// GET /subscriptions — Memberstack subscription analytics for the map
// dashboard's revenue tiles. Memberstack runs paid plans on top of Stripe and
// exposes an Admin REST API (base https://admin.memberstack.com, auth via the
// `X-API-KEY: sk_...` header). We pull every plan (for price + billing cadence)
// and every member (for active plan connections), then aggregate:
//   - paying / free subscriber counts
//   - monthly vs yearly active-subscription counts ("purchase tendencies")
//   - MRR (each active paid sub normalized to a monthly amount)
//   - all-time income — ESTIMATED. Memberstack's Admin API has no
//     transactions/invoices endpoint, so true historical revenue lives in
//     Stripe. We approximate lifetime billed from *current* paying members as
//     (monthly amount × months since the member was created). This excludes
//     churned members and is intentionally labeled an estimate in the UI.
//
// Requires the MEMBERSTACK_SECRET_KEY secret (wrangler secret put). When it's
// absent we return { configured:false } so the UI can show a setup hint rather
// than erroring. Field shapes vary across Memberstack accounts, so every read
// below is defensive; pass ?debug=1 to echo a raw plan + connection sample for
// calibration against live data.
// ---------------------------------------------------------------------------
const MS_API = 'https://admin.memberstack.com';

function msHeaders(env) {
  return { 'X-API-KEY': env.MEMBERSTACK_SECRET_KEY, 'Content-Type': 'application/json' };
}

// Normalize a money amount to major units (dollars). Memberstack usually
// reports amounts in major units already (e.g. 25 for $25), but some payloads
// use Stripe-style minor units (cents). Guard: treat a large whole number as
// cents only when it's an exact integer ≥ 1000 (i.e. ≥ $1000 would be unusual
// for a sub price but $10.00 = 1000 cents is common).
function msAmount(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0;
  if (Number.isInteger(n) && n >= 1000) return n / 100;
  return n;
}

// Map any Memberstack interval representation to a per-month multiplier and a
// coarse 'monthly'|'yearly'|'other' bucket. Handles string ("MONTHLY"),
// nested ({ type:'month', count:1 }), and Stripe-ish ({ interval:'year' }).
// Derive billing cadence from a planConnection.payment object. Memberstack's
// payment object has NO interval field — the cadence lives in the priceId slug
// (e.g. "prc_annual-9i2e0eab", "prc_monthly-86u0uyc"). We parse that, and fall
// back to the gap between lastBillingDate/nextBillingDate (unix seconds) when
// the slug isn't descriptive. Returns a coarse bucket + a factor that converts
// the charge amount to a monthly-equivalent (for MRR).
function msPaymentCadence(payment) {
  const pid = String(payment.priceId || payment.priceName || payment.price || '').toLowerCase();
  if (/annual|yearly|year|yr|12mo/.test(pid)) return { bucket: 'yearly',  perMonthFactor: 1 / 12 };
  if (/month|monthly|\bmo\b|30day/.test(pid)) return { bucket: 'monthly', perMonthFactor: 1 };
  if (/quarter|3mo|90day/.test(pid))          return { bucket: 'other',   perMonthFactor: 1 / 3 };
  if (/week|weekly/.test(pid))                return { bucket: 'other',   perMonthFactor: 52 / 12 };
  // Fallback: infer from the spacing of the billing dates.
  const last = Number(payment.lastBillingDate), next = Number(payment.nextBillingDate);
  if (last && next && next > last) {
    const days = (next - last) / 86400;
    if (days > 300) return { bucket: 'yearly',  perMonthFactor: 1 / 12 };
    if (days > 75)  return { bucket: 'other',   perMonthFactor: 1 / 3 };
    if (days > 20)  return { bucket: 'monthly', perMonthFactor: 1 };
    return { bucket: 'other', perMonthFactor: 52 / 12 };
  }
  return { bucket: 'other', perMonthFactor: 0 };
}

async function msFetchAllMembers(env) {
  const out = [];
  let after = null, guard = 0;
  do {
    const u = new URL(`${MS_API}/members`);
    u.searchParams.set('limit', '100');
    if (after) u.searchParams.set('after', after);
    const r = await fetch(u.toString(), { headers: msHeaders(env) });
    if (!r.ok) throw new Error(`Memberstack /members ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = await r.json();
    const data = body.data || body.members || (Array.isArray(body) ? body : []);
    out.push(...data);
    // Pagination shapes: { hasNextPage, endCursor } or { totalCount, ... }.
    after = body.hasNextPage ? (body.endCursor || body.lastKey || null) : null;
    if (!after && body.totalCount && out.length < body.totalCount && data.length) {
      after = data[data.length - 1]?.id || null; // best-effort cursor fallback
    }
  } while (after && ++guard < 200);
  return out;
}

// Set of every Memberstack member email (normalized), cached 120s so submit-
// time existence checks don't page the Admin API on each call. New signups
// self-heal within 2 min; the create-password step's 'exists' error is the
// final backstop.
async function msMemberEmailSet(env) {
  const cache = caches.default;
  const cacheKey = new Request('https://email-status.tmw.internal/ms-emails');
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return new Set(await hit.json());
  } catch { /* fall through to refetch */ }
  const members = await msFetchAllMembers(env);
  // Admin-API member shape varies; check the known email locations so a schema
  // quirk doesn't silently empty the set (which would make every lookup miss).
  const emails = members
    .map(m => String(
      (m.auth && m.auth.email) || m.email ||
      (m.customFields && (m.customFields.email || m.customFields['email-address'])) || ''
    ).trim().toLowerCase())
    .filter(Boolean);
  try {
    await cache.put(cacheKey, new Response(JSON.stringify(emails), {
      headers: { 'Cache-Control': 'max-age=120', 'Content-Type': 'application/json' },
    }));
  } catch { /* best-effort cache */ }
  return new Set(emails);
}

// POST /email-status { email } -> { ok, account }. Lets every email-capture
// form recognize an address that already has a Memberstack account and route
// the visitor to LOGIN instead of re-subscribing the same email forever.
// Returns account-existence ONLY (a boolean) — no plan, name, or other PII.
// "Subscribed but no account yet" is a separate state the subscribe worker
// reports via already_subscribed. Fails OPEN (account:false) so a lookup error
// never blocks a genuine signup.
async function handleEmailStatus(request, env, origin) {
  if (!env.MEMBERSTACK_SECRET_KEY) return json({ ok: false, account: false, reason: 'unconfigured' }, {}, env, origin);
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 1) return json({ ok: false, account: false }, {}, env, origin);
  try {
    const set = await msMemberEmailSet(env);
    return json({ ok: true, account: set.has(email) }, {}, env, origin);
  } catch {
    return json({ ok: false, account: false }, {}, env, origin);
  }
}

// ── Stripe — authoritative income (Memberstack bills through Stripe) ──────────
// When STRIPE_SECRET_KEY is set we pull real money from Stripe instead of
// estimating: MRR from active subscriptions (annual plans amortized to a monthly
// figure so a $90/yr payer counts as $7.50/mo, not $90 this month), and actual
// collected revenue (all-time + this calendar year) from succeeded charges minus
// refunds. Requires a restricted Stripe key with read access to subscriptions +
// charges. Paginated; charge history is capped at 30 pages (3,000 charges).
async function stripeGet(env, path) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  if (!r.ok) throw new Error('Stripe ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}
function stripePerMonth(amount, interval, count) {
  const c = count || 1;
  if (interval === 'year')  return amount / (12 * c);
  if (interval === 'month') return amount / c;
  if (interval === 'week')  return (amount * 52 / 12) / c;
  if (interval === 'day')   return (amount * 365 / 12) / c;
  return 0;
}
async function fetchStripeIncome(env) {
  let mrr = 0, monthly = 0, yearly = 0, other = 0, paying = 0;
  const currencies = new Set();
  // Active subscriptions → MRR + cadence split.
  const trialStarts = [];   // new trial signups → activity feed (no charge exists yet)
  let after = null, guard = 0;
  do {
    // status=all (not just 'active') so 14-day-TRIAL subscribers — status
    // 'trialing' — are counted too. New Pro plans launched with a free trial
    // create trialing subs that the old status=active query dropped entirely,
    // so they stayed invisible on the analytics Pro tab for the whole trial.
    // expand customer so trial signups can be named in the activity feed.
    const page = await stripeGet(env, '/subscriptions?status=all&limit=100&expand[]=data.items.data.price&expand[]=data.customer' + (after ? '&starting_after=' + after : ''));
    for (const sub of (page.data || [])) {
      // Count current subscribers: active + trialing (committed, card on file).
      // Skip canceled / incomplete / incomplete_expired / unpaid.
      if (sub.status !== 'active' && sub.status !== 'trialing') continue;
      paying++;
      let subBucket = null, subAmt = 0, subCur = 'usd';
      for (const it of (sub.items && sub.items.data || [])) {
        const price = it.price || {};
        const amt = (price.unit_amount || 0) / 100 * (it.quantity || 1);
        subAmt += amt; subCur = (price.currency || 'usd').toLowerCase();
        currencies.add(subCur);
        const iv = price.recurring && price.recurring.interval;
        const ivc = (price.recurring && price.recurring.interval_count) || 1;
        mrr += stripePerMonth(amt, iv, ivc);
        if (iv === 'year') subBucket = 'yearly'; else if (iv === 'month' && subBucket !== 'yearly') subBucket = 'monthly';
      }
      if (subBucket === 'yearly') yearly++; else if (subBucket === 'monthly') monthly++; else other++;
      // A trial sub has no Stripe charge yet ($0), so it never reaches the
      // charge-based feed below. Capture it as a "started trial" activity item.
      if (sub.status === 'trialing') {
        const cust = (sub.customer && typeof sub.customer === 'object') ? sub.customer : {};
        trialStarts.push({
          name: String(cust.name || '').trim(),
          email: String(cust.email || '').trim(),
          amount: 0,            // $0 during trial — the real monthly/annual charge
          currency: subCur,     // lands in the charge-based feed when the first payment goes through
          created: sub.created,
          trial: true,
        });
      }
    }
    after = page.has_more ? page.data[page.data.length - 1].id : null;
  } while (after && ++guard < 50);

  // Succeeded charges → actual collected revenue (gross) + Stripe fees, so we can
  // show revenue (before fees) and income (after fees). Expand the balance
  // transaction to read the processing fee Stripe took on each charge.
  const yearStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
  let allTime = 0, allFee = 0, yearInc = 0, yearFee = 0, after2 = null, cg = 0, truncated = false;
  const purchases = [];                 // most-recent succeeded charges (who + when)
  const PURCHASES_MAX = 25;
  do {
    const page = await stripeGet(env, '/charges?limit=100&expand[]=data.balance_transaction' + (after2 ? '&starting_after=' + after2 : ''));
    for (const c of (page.data || [])) {
      if (c.status !== 'succeeded' || !c.paid) continue;
      const gross = ((c.amount || 0) - (c.amount_refunded || 0)) / 100;   // revenue (customer paid, less refunds)
      const fee = ((c.balance_transaction && c.balance_transaction.fee) || 0) / 100;
      allTime += gross; allFee += fee;
      if (c.created >= yearStart) { yearInc += gross; yearFee += fee; }
      // Activity feed: capture who paid + when, newest first (charges list is
      // already date-desc). Name/email come from billing_details + receipt_email,
      // which are default charge fields — no `expand` needed, so this adds no
      // latency to the existing charge pull.
      if (purchases.length < PURCHASES_MAX) {
        const bd = c.billing_details || {};
        purchases.push({
          name: (bd.name || '').trim(),
          email: (bd.email || c.receipt_email || '').trim(),
          amount: Math.round((c.amount || 0) / 100 * 100) / 100,
          refunded: !!c.refunded || (c.amount_refunded || 0) > 0,
          currency: (c.currency || 'usd').toLowerCase(),
          created: c.created,
        });
      }
    }
    after2 = page.has_more ? page.data[page.data.length - 1].id : null;
    if (++cg >= 30) { truncated = !!after2; break; }
  } while (after2);
  const feeRate = allTime > 0 ? allFee / allTime : 0;   // effective fee % (for netting the run-rate)

  // Activity feed = succeeded charges + trial signups (which carry no charge),
  // newest first, capped — so a brand-new trial shows up immediately.
  const recentFeed = purchases.concat(trialStarts)
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, PURCHASES_MAX);

  return {
    fees_all_time: Math.round(allFee * 100) / 100,
    fees_year: Math.round(yearFee * 100) / 100,
    fee_rate: Math.round(feeRate * 10000) / 10000,
    all_time_net: Math.round((allTime - allFee) * 100) / 100,
    year_net: Math.round((yearInc - yearFee) * 100) / 100,
    mrr: Math.round(mrr * 100) / 100,
    arr: Math.round(mrr * 12 * 100) / 100,
    all_time_income: Math.round(allTime * 100) / 100,
    year_income: Math.round(yearInc * 100) / 100,
    paying_subscribers: paying,
    monthly_subscriptions: monthly,
    yearly_subscriptions: yearly,
    other_subscriptions: other,
    currency: currencies.size === 1 ? [...currencies][0] : (currencies.size ? 'mixed' : 'usd'),
    income_truncated: truncated,
    recent_purchases: recentFeed,
  };
}

// GET /funnel-stats?weeks=12 — article-to-Pro funnel by week.
// Reads the `events` table for event_name LIKE 'funnel:%' (the funnel
// beacon prefix journal-auth.js writes), buckets by ISO week, and
// returns per-week counts of each stage. Admin-gated via ADMIN_READ_PATHS
// in the dispatcher. Powers the Funnel tile on admin.oftmw.com/analytics.
//
// Response shape:
//   {
//     weeks: [
//       { week: "2026-23", week_start: "2026-06-08", events: {
//           subscribe_article: 142, free_account_created: 58,
//           profile_completed: 41, go_pro_clicked: 7, go_pro_skipped: 31,
//           pro_upgrade_paid: 2
//       } },
//       ...
//     ],
//     totals: { ...same shape, summed across the window },
//     window_days: 84
//   }
//
// Note on pro_upgrade_paid: this is the only stage NOT sourced from the
// /event beacons — it's pulled live from Stripe `/subscriptions` so we
// can show historical Pro upgrades even before the beacons captured
// anything. start_date (sub creation) is the "became Pro" timestamp.
async function handleFunnelStats(env, origin, url) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  const weeks = Math.min(Math.max(parseInt(url.searchParams.get('weeks') || '12', 10), 1), 52);
  const windowSec = weeks * 7 * 86400;
  const cutoff = Math.floor(Date.now() / 1000) - windowSec;

  // Pull only funnel:* events in the window. The events.ts is a unix
  // seconds int; strftime('%Y-%W', ts, 'unixepoch') gives an ISO week
  // bucket key ("2026-23"). Group server-side so we transfer a tiny
  // result set instead of every raw event row.
  const rs = await env.DB.prepare(
    `SELECT strftime('%Y-%W', ts, 'unixepoch') AS wk,
            event_name,
            COUNT(*) AS c
     FROM events
     WHERE ts >= ?1 AND event_name LIKE 'funnel:%'
     GROUP BY wk, event_name`
  ).bind(cutoff).all();
  const rows = rs.results || [];

  // Pivot to { weekKey -> { stage -> count } }
  const byWeek = new Map();
  const beaconStages = ['subscribe_article','free_account_created','profile_completed','go_pro_clicked','go_pro_skipped'];
  const stages = [...beaconStages, 'pro_upgrade_paid'];
  const emptyBucket = () => stages.reduce((o, s) => (o[s] = 0, o), {});
  const totals = emptyBucket();
  // Track WHERE subscribes come from (article funnel vs the /markets/ funnel)
  // so the analytics tile can show the market pages' contribution.
  let subArticle = 0, subMarket = 0;
  for (const r of rows) {
    let stage = String(r.event_name || '').replace(/^funnel:/, '');
    if (stage === 'subscribe_article') subArticle += Number(r.c) || 0;
    if (stage === 'subscribe_market')  subMarket  += Number(r.c) || 0;
    // Market-page signups roll up into the same top-of-funnel Subscribe stage.
    if (stage === 'subscribe_market') stage = 'subscribe_article';
    if (!beaconStages.includes(stage)) continue;
    let bucket = byWeek.get(r.wk);
    if (!bucket) { bucket = emptyBucket(); byWeek.set(r.wk, bucket); }
    bucket[stage] += Number(r.c) || 0;
    totals[stage] += Number(r.c) || 0;
  }

  // Backfill pro_upgrade_paid from Stripe. start_date (or created as fallback)
  // is the authoritative "this customer activated a paid subscription"
  // moment. We bucket by the same ISO-week math the series builder uses
  // below so keys line up. Failure here is silent — funnel-stats still
  // returns the beacon data with pro_upgrade_paid=0 if Stripe is down.
  if (env.STRIPE_SECRET_KEY) {
    try {
      let after = null, guard = 0;
      do {
        const page = await stripeGet(env, '/subscriptions?status=all&limit=100' + (after ? '&starting_after=' + after : ''));
        for (const sub of (page.data || [])) {
          const created = sub.start_date || sub.created;
          if (!created || created < cutoff) continue;
          const d = new Date(created * 1000);
          const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
          const dayNum = (tmp.getUTCDay() + 6) % 7;
          tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
          const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
          const wkNum = 1 + Math.round(((tmp - firstThursday) / 86400000 - 3 + (firstThursday.getUTCDay() + 6) % 7) / 7);
          const wkKey = `${tmp.getUTCFullYear()}-${String(wkNum).padStart(2, '0')}`;
          let bucket = byWeek.get(wkKey);
          if (!bucket) { bucket = emptyBucket(); byWeek.set(wkKey, bucket); }
          bucket.pro_upgrade_paid += 1;
          totals.pro_upgrade_paid += 1;
        }
        after = page.has_more ? page.data[page.data.length - 1].id : null;
      } while (after && ++guard < 50);
    } catch (e) {
      totals._stripe_error = String(e.message || e).slice(0, 120);
    }
  }

  // Build the contiguous weekly series (oldest -> newest) so the tile
  // can plot bars without filling gaps client-side. Use Monday-of-week
  // as the human-friendly week_start label.
  function isoMondayOf(year, weekNum) {
    // Jan 4 is always in ISO week 1 by definition; walk to the Monday.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Mon = new Date(jan4);
    week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
    const monday = new Date(week1Mon);
    monday.setUTCDate(week1Mon.getUTCDate() + (weekNum - 1) * 7);
    return monday.toISOString().slice(0, 10);
  }
  const today = new Date();
  const series = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 7 * 86400 * 1000);
    const year = d.getUTCFullYear();
    const tmp = new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (tmp.getUTCDay() + 6) % 7;
    tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
    const wkNum = 1 + Math.round(((tmp - firstThursday) / 86400000 - 3 + (firstThursday.getUTCDay() + 6) % 7) / 7);
    const wkKey = `${tmp.getUTCFullYear()}-${String(wkNum).padStart(2, '0')}`;
    series.push({
      week: wkKey,
      week_start: isoMondayOf(tmp.getUTCFullYear(), wkNum),
      events: byWeek.get(wkKey) || emptyBucket(),
    });
  }

  return json({
    weeks: series,
    totals,
    sources: { subscribe: { article: subArticle, market: subMarket } },
    window_days: weeks * 7,
  }, {}, env, origin);
}

async function handleSubscriptions(env, origin, url) {
  if (!env.MEMBERSTACK_SECRET_KEY) {
    return json({ configured: false, reason: 'MEMBERSTACK_SECRET_KEY not set' }, {}, env, origin);
  }
  const debug = url && url.searchParams.get('debug') === '1';
  let members = [];
  try {
    members = await msFetchAllMembers(env);
  } catch (e) {
    return json({ configured: true, error: String(e.message || e) }, { status: 502 }, env, origin);
  }
  // Memberstack's Admin REST API has no list-plans endpoint, so price + cadence
  // come straight from each member's planConnections[].payment (priceId names
  // the interval; amount is in major currency units; free plans have payment=null).
  const plansError = 'no /plans endpoint — deriving from planConnections.payment';

  const nowMs = Date.now();
  const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.4375;
  let paying = 0, free = 0, monthlyCount = 0, yearlyCount = 0, otherCount = 0;
  let mrr = 0, allTimeEstimate = 0;
  const currencies = new Set();

  for (const m of members) {
    const conns = m.planConnections || m.planConnection || [];
    let memberPays = false;
    for (const c of (Array.isArray(conns) ? conns : [])) {
      const active = c.active === true || /^(active|trialing|past_due)$/i.test(String(c.status || ''));
      if (!active) continue;
      // A paid subscription is a non-FREE connection carrying a payment object.
      const pay = c.payment;
      const isPaid = !!pay && String(c.type || '').toUpperCase() !== 'FREE';
      if (!isPaid) continue;
      memberPays = true;

      const amount = msAmount(pay.amount ?? pay.unitAmount);          // major units (e.g. 90)
      const cad = msPaymentCadence(pay);                              // bucket + monthly factor
      const perMonth = amount * cad.perMonthFactor;
      currencies.add(String(pay.currency || 'usd').toLowerCase());
      if (cad.bucket === 'yearly') yearlyCount++;
      else if (cad.bucket === 'monthly') monthlyCount++;
      else otherCount++;
      mrr += perMonth || 0;

      // All-time income estimate: amount × billing cycles charged so far. Uses
      // the member's account age as the subscription lifetime (Memberstack has
      // no charge-history API), with a 1-cycle floor (their first charge).
      const createdMs = Date.parse(m.createdAt || m.created_at || '') || nowMs;
      const monthsSince = Math.max(0, (nowMs - createdMs) / MS_PER_MONTH);
      let cycles = 1;
      if (cad.bucket === 'yearly')       cycles = Math.floor(monthsSince / 12) + 1;
      else if (cad.bucket === 'monthly') cycles = Math.floor(monthsSince) + 1;
      allTimeEstimate += amount * Math.max(1, cycles);
    }
    if (memberPays) paying++; else free++;
  }

  const resp = {
    configured: true,
    members_total: members.length,
    paying_subscribers: paying,
    free_subscribers: free,
    monthly_subscriptions: monthlyCount,
    yearly_subscriptions: yearlyCount,
    other_subscriptions: otherCount,
    mrr: Math.round(mrr * 100) / 100,
    arr: Math.round(mrr * 12 * 100) / 100,
    all_time_income_estimate: Math.round(allTimeEstimate * 100) / 100,
    currency: currencies.size === 1 ? [...currencies][0] : (currencies.size ? 'mixed' : 'usd'),
    income_source: 'estimate',
    updated_at: Math.floor(nowMs / 1000),
  };

  // If Stripe is wired up, replace the estimated money with authoritative Stripe
  // figures (real MRR with annual amortized, actual collected all-time/this-year).
  if (env.STRIPE_SECRET_KEY) {
    try {
      const s = await fetchStripeIncome(env);
      resp.mrr = s.mrr;
      resp.arr = s.arr;
      resp.all_time_income = s.all_time_income;     // gross revenue (customer paid, less refunds)
      resp.year_income = s.year_income;
      resp.all_time_net = s.all_time_net;           // income after Stripe fees
      resp.year_net = s.year_net;
      resp.fees_all_time = s.fees_all_time;
      resp.fees_year = s.fees_year;
      resp.fee_rate = s.fee_rate;
      resp.paying_subscribers = s.paying_subscribers;
      resp.monthly_subscriptions = s.monthly_subscriptions;
      resp.yearly_subscriptions = s.yearly_subscriptions;
      resp.other_subscriptions = s.other_subscriptions;
      resp.currency = s.currency;
      resp.income_source = 'stripe';
      resp.income_truncated = s.income_truncated;
      resp.recent_purchases = s.recent_purchases;
    } catch (e) {
      resp.stripe_error = String(e.message || e);   // keep Memberstack estimates as fallback
    }
  }
  if (debug) {
    // Dump real plan connections (no email/PII) so we can calibrate the
    // amount/interval parser against the actual Memberstack shape.
    const withConns = members.filter(m => (m.planConnections || []).length);
    resp._debug = {
      plans_error: plansError,
      member_keys: members[0] ? Object.keys(members[0]) : [],
      sample_connections: withConns.slice(0, 6).map(m => ({
        createdAt: m.createdAt || m.created_at || null,
        planConnections: m.planConnections,
      })),
    };
  }
  return json(resp, {}, env, origin);
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
  const limit  = clampInt(url.searchParams.get('limit'), 50, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 5000000);
  // Optional event-type filter (the Studio "All Activity" chips). Comma list,
  // e.g. ?events=search,intel_query. Filtering server-side keeps pagination and
  // totals correct. Default: everything except the noisy watchlist snapshots.
  const evParam = (url.searchParams.get('events') || '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);
  let where, binds;
  if (evParam.length) {
    // A chip filter is active — show the raw rows for exactly those event
    // types so the chip count/labels are accurate (no collapsing).
    where = `ev.event_name IN (${evParam.map(() => '?').join(',')})`;
    binds = evParam.slice();
  } else {
    // Default feed — strip the noise that made one user action look like several
    // rows ("double querying"):
    //   • watchlist_snapshot — state-sync, fires every page load
    //   • intel_answer — system bookkeeping for the nightly review (member
    //     'system:smart-answer'); the user's own intel_query already represents
    //     the ask, and the answer log has its own /intel-answers view
    //   • funnel:%  — funnel-analysis beacons (read separately by the Funnel tile)
    //   • the redundant 'search' half of a smart query: when an intelligence ask
    //     logged both a 'search' and an 'intel_query' for the same visitor + query
    //     within ~2 min, suppress the 'search' so one ask = one row. Plain nav
    //     searches that never triggered Intelligence still show.
    where = `ev.event_name NOT IN ('watchlist_snapshot','intel_answer')
      AND ev.event_name NOT LIKE 'funnel:%'
      AND NOT (ev.event_name = 'search' AND EXISTS (
        SELECT 1 FROM events iq
        WHERE iq.event_name = 'intel_query'
          AND iq.member_id = ev.member_id
          AND json_extract(iq.props_json, '$.q') = json_extract(ev.props_json, '$.q')
          AND ABS(iq.ts - ev.ts) <= 120))`;
    binds = [];
  }
  const rs = await env.DB.prepare(
    `SELECT ev.ts, ev.member_id, ev.email, ev.member_name, ev.plan, ev.event_name, ev.path, ev.props_json
     FROM events ev
     WHERE ${where}
     ORDER BY ev.ts DESC
     LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();
  // Total only when asked (the paginated "All Activity" view) — keeps the live
  // feed's cheap query unchanged. Same WHERE so pagination math stays correct.
  let total = null;
  if (url.searchParams.get('total') === '1') {
    const t = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events ev WHERE ${where}`
    ).bind(...binds).first();
    total = (t && t.n) || 0;
  }
  return json({ rows: rs.results || [], total }, {}, env, origin);
}

// GET /journal-event-trend — daily counts of journal engagement events over the
// last N days (default 28), zero-filled, for the Studio's trend sparklines.
// search + intel_query live ONLY in this D1 store (they beacon /event, not GA4),
// so the analytics page can't chart them via GA — this is their data source.
// Returns { days: ['YYYY-MM-DD', …], search: [n…], intel: [n…], total: [n…] }
// with one entry per calendar day (UTC), oldest → newest, so the client can
// render bars directly without filling gaps.
async function handleJournalEventTrend(env, origin, url) {
  const days = clampInt(url.searchParams.get('days'), 28, 1, 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rs = await env.DB.prepare(
    `SELECT date(ts, 'unixepoch') AS day, event_name AS ev, COUNT(*) AS n
     FROM events
     WHERE event_name IN ('search', 'intel_query') AND ts >= ?
     GROUP BY day, ev`
  ).bind(since).all();
  // Build the zero-filled day axis (UTC) ending today, then fold counts in.
  const byDay = new Map(); // 'YYYY-MM-DD' -> { search, intel }
  const axis = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date((Math.floor(Date.now() / 1000) - i * 86400) * 1000);
    const key = d.toISOString().slice(0, 10);
    axis.push(key); byDay.set(key, { search: 0, intel: 0 });
  }
  for (const row of (rs.results || [])) {
    const slot = byDay.get(row.day); if (!slot) continue;
    if (row.ev === 'search') slot.search = row.n; else if (row.ev === 'intel_query') slot.intel = row.n;
  }
  const search = axis.map(k => byDay.get(k).search);
  const intel  = axis.map(k => byDay.get(k).intel);
  const total  = axis.map((k, i) => search[i] + intel[i]);
  return json({ days: axis, search, intel, total }, {}, env, origin);
}

// GET /intel-queries — paginated log of searches across the network, newest
// first: TMW Intelligence smart-answer queries (event_name 'intel_query') AND
// plain "normal" searches (event_name 'search' — the universal nav search bar
// and the map search). Returns total + the requested page so the Studio can
// page through without losing history. props_json carries { q | search_term,
// results, pro, kind, target, search_location }. Each item gets a `type`
// ('intel' | 'search') so the Studio can label them.
async function handleIntelQueries(env, origin, url) {
  const limit  = clampInt(url.searchParams.get('limit'), 25, 1, 100);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1000000);
  const tot = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE event_name IN ('intel_query','search')`
  ).first();
  const rs = await env.DB.prepare(
    `SELECT ts, member_id, member_name, plan, event_name, props_json
     FROM events WHERE event_name IN ('intel_query','search')
     ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  const items = (rs.results || []).map(row => {
    let p = {};
    try { if (row.props_json) p = JSON.parse(row.props_json); } catch {}
    const isIntel = row.event_name === 'intel_query';
    return {
      ts: row.ts,
      member_id: row.member_id,
      member_name: row.member_name || null,
      plan: row.plan || null,
      type: isIntel ? 'intel' : 'search',
      // normal searches store the typed text as q (nav bar) or search_term (map)
      query: p.q || p.search_term || '',
      results: (p.results != null ? p.results : null),
      pro: !!p.pro,
      // search-only context: what they jumped to + where they searched from
      target: p.target || null,
      target_kind: p.kind || null,
      source: p.search_location || null,
    };
  });
  return json({ total: (tot && tot.n) || 0, limit, offset, items }, {}, env, origin);
}

// GET /search-gaps — demand-ranked queries the search/intel system probably
// failed on. Three buckets, all rolled up into one feed:
//
//   • no_results   — events where the client explicitly logged results = 0.
//                    The cleanest signal: we had nothing to show. Firms,
//                    projects, and places to add next.
//   • question     — natural-language queries (start with what/why/how/who/
//                    when/where/which OR contain "?"). Basic text search
//                    isn't built for these; even if it returned something,
//                    the user probably wanted Ask TMW. Worth surfacing
//                    regardless of result count.
//   • low_results  — queries with 1-2 marginal matches. Likely-but-not-
//                    definite gaps. Surfaced last.
//
// Each item carries a `kind` so the Studio can label the row. Partner
// spotlights (which carry a `partner` prop) are excluded — they aren't gaps.
// GET /intel-selftest — the daily search-health trend, logged by the intel-review
// routine's proactive self-test (it runs generated queries against the live
// database and records queries/clean/gaps/health_pct per run). Powers the Search
// Health tab in Studio. Admin-gated via ADMIN_READ_PATHS.
async function handleIntelSelftest(env, origin, url) {
  const limit = clampInt(url.searchParams.get('limit'), 30, 1, 120);
  let runs = [];
  try {
    const rs = await env.DB.prepare(
      `SELECT ts, props_json FROM events WHERE event_name = 'intel_selftest'
       ORDER BY ts DESC LIMIT ?`
    ).bind(limit).all();
    runs = (rs.results || []).map(r => {
      let p = {}; try { p = JSON.parse(r.props_json || '{}'); } catch {}
      return {
        ts: r.ts,
        queries: p.queries != null ? p.queries : null,
        clean: p.clean != null ? p.clean : null,
        gaps: p.gaps != null ? p.gaps : null,
        health_pct: p.health_pct != null ? p.health_pct : null,
        report: Array.isArray(p.report) ? p.report.slice(0, 40) : null,  // per-query: what tested + output
      };
    }).filter(r => r.queries != null);
  } catch (e) { /* table/shape issue → empty */ }
  return json({ latest: runs[0] || null, runs: runs.map(r => ({ ts: r.ts, queries: r.queries, clean: r.clean, gaps: r.gaps, health_pct: r.health_pct })), latest_report: runs[0] ? runs[0].report : null }, {}, env, origin);
}

// POST /intel-feedback { feedback, query? } — the editor's feedback from the
// Search Health card. Claude triages it: an editorial RULE is appended to the
// live answer prompt IMMEDIATELY (so the next answer follows it); a DATA or
// SEARCH-LOGIC issue is logged for the discovery routine / an engineer. Either
// way the raw feedback is saved. This is the human-in-the-loop "reiterate".
async function handleIntelFeedback(req, env, origin) {
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;
  let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
  const feedback = String((b && b.feedback) || '').trim().slice(0, 1000);
  const query = String((b && b.query) || '').trim().slice(0, 200);
  if (!feedback) return json({ error: 'feedback required' }, { status: 400 }, env, origin);

  let verdict = { type: 'note', rule: null, note: feedback };
  if (env.ANTHROPIC_API_KEY) {
    try {
      const sys = 'You triage an editor\'s feedback about TMW Intelligence (a real-estate development search). Respond with ONLY JSON: '
        + '{"type":"rule"|"data"|"logic","rule":"<one imperative sentence, ≤25 words, ONLY when type=rule>","note":"<concise restatement>"}. '
        + 'type=rule = editorial voice/ranking/framing guidance applicable to the answer prompt (e.g. "Lead with the soonest opening date", "Never feature a project that opened over a year ago"). '
        + 'type=data = a specific project/place is missing or mis-tagged in the database. '
        + 'type=logic = the search returned wrong/incomplete results or mis-parsed a query (a code bug). '
        + 'The rule must be concrete, non-contradictory, and must never make the model invent facts.';
      const usr = (query ? ('Query under review: "' + query + '"\n') : '') + 'Editor feedback: "' + feedback + '"';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: SMART_ANSWER_MODEL, max_tokens: 300, system: sys, messages: [{ role: 'user', content: usr }] }),
      });
      if (r.ok) {
        const d = await r.json();
        const txt = (d.content && d.content[0] && d.content[0].text) || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { const p = JSON.parse(m[0]); if (p && p.type) verdict = { type: p.type, rule: p.rule || null, note: p.note || feedback }; }
      }
    } catch (e) { /* fall through to a plain logged note */ }
  }

  let applied = 'logged', liveRule = null;
  if (verdict.type === 'rule' && verdict.rule) {
    try {
      const rr = await env.DB.prepare(`SELECT props_json FROM events WHERE event_name='intel_rules' ORDER BY ts DESC LIMIT 1`).first();
      let rules = []; if (rr && rr.props_json) { const pj = JSON.parse(rr.props_json); if (Array.isArray(pj.rules)) rules = pj.rules; }
      const nrm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!rules.some(x => nrm(x) === nrm(verdict.rule))) rules.push(verdict.rule);
      rules = rules.slice(-20);
      await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?,?,?,?)`)
        .bind(Math.floor(Date.now() / 1000), 'system:intel-feedback', 'intel_rules',
              JSON.stringify({ rules, note: 'editor feedback ' + new Date().toISOString().slice(0, 10) })).run();
      applied = 'rule'; liveRule = verdict.rule;
    } catch (e) { applied = 'logged'; }
  }
  // DATA feedback ("X is missing", "add Brooklyn projects") → enqueue it where
  // the tmw-project-discovery routine actually looks: a `search_feedback` event
  // flagged needs_discovery (down vote + 0 results + 'empty'), carrying the
  // editor's note so the discovery hint reflects exactly what was asked.
  if (verdict.type === 'data') {
    try {
      await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?,?,?,?)`)
        .bind(Math.floor(Date.now() / 1000), 'system:intel-feedback', 'search_feedback',
              JSON.stringify({ q: (query || feedback).slice(0, 160), rating: 'down', results: 0, result_kind: 'empty', editor_note: feedback })).run();
      applied = 'discovery';
    } catch (e) {}
  }
  try {
    await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?,?,?,?)`)
      .bind(Math.floor(Date.now() / 1000), 'system:intel-feedback', 'intel_feedback',
            JSON.stringify({ feedback, query: query || null, type: verdict.type, note: verdict.note, applied })).run();
  } catch (e) {}

  const message = (applied === 'rule')
    ? ('Applied as a live house rule — every answer follows it now: “' + liveRule + '”')
    : (applied === 'discovery')
      ? 'Queued for the project-discovery routine — it will research projects to add (runs 9am & 9pm).'
      : (verdict.type === 'logic')
        ? 'Logged as a search-logic bug for an engineer to fix.'
        : 'Noted — saved for the next review pass.';
  return json({ ok: true, type: verdict.type, applied, rule: liveRule, message }, {}, env, origin);
}

async function handleSearchGaps(env, origin, url) {
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const rs = await env.DB.prepare(
    `SELECT TRIM(LOWER(json_extract(props_json,'$.q'))) AS q,
            COUNT(*) AS n,
            MAX(ts) AS last_ts,
            MIN(CAST(json_extract(props_json,'$.results') AS INTEGER)) AS min_results,
            MAX(CAST(json_extract(props_json,'$.results') AS INTEGER)) AS max_results
     FROM events
     WHERE event_name IN ('intel_query','search')
       AND json_extract(props_json,'$.partner') IS NULL
       AND json_extract(props_json,'$.q') IS NOT NULL
       AND TRIM(json_extract(props_json,'$.q')) <> ''
       AND (
         json_extract(props_json,'$.results') = 0
         OR INSTR(json_extract(props_json,'$.q'), '?') > 0
         OR LOWER(TRIM(json_extract(props_json,'$.q'))) GLOB 'what *'
         OR LOWER(TRIM(json_extract(props_json,'$.q'))) GLOB 'why *'
         OR LOWER(TRIM(json_extract(props_json,'$.q'))) GLOB 'how *'
         OR LOWER(TRIM(json_extract(props_json,'$.q'))) GLOB 'when *'
         OR LOWER(TRIM(json_extract(props_json,'$.q'))) GLOB 'where *'
         OR LOWER(TRIM(json_extract(props_json,'$.q'))) GLOB 'who *'
         OR LOWER(TRIM(json_extract(props_json,'$.q'))) GLOB 'which *'
         OR LOWER(TRIM(json_extract(props_json,'$.q'))) GLOB 'whose *'
         OR (CAST(json_extract(props_json,'$.results') AS INTEGER) > 0
             AND CAST(json_extract(props_json,'$.results') AS INTEGER) <= 2)
       )
     GROUP BY q
     LIMIT ?`
  ).bind(limit).all();
  const QUESTION_RE = /^(what|why|how|when|where|who|which|whose)\s|\?/i;
  const items = (rs.results || []).map(r => {
    const isZero = (r.min_results === 0 || r.max_results === 0);
    const isQuestion = QUESTION_RE.test(String(r.q || ''));
    let kind = 'low_results';
    if (isZero) kind = 'no_results';
    else if (isQuestion) kind = 'question';
    return { query: r.q, count: r.n, last_ts: r.last_ts, kind, min_results: r.min_results, max_results: r.max_results };
  });
  // Rank: no_results first (highest-confidence gap), then questions
  // (natural-language demand), then low_results. Within each bucket, more
  // popular first, then most recent.
  const kindRank = { no_results: 0, question: 1, low_results: 2 };
  items.sort((a, b) => {
    const k = (kindRank[a.kind] || 9) - (kindRank[b.kind] || 9);
    if (k) return k;
    if (b.count !== a.count) return b.count - a.count;
    return (b.last_ts || 0) - (a.last_ts || 0);
  });
  return json({ items }, {}, env, origin);
}

// GET /search-feedback — rolls up the thumbs up/down votes the lightbox
// overlay collects (event_name = 'search_feedback'). Returns three things
// the admin tile needs:
//
//   • totals: total up + down across the lookback window, plus a
//     promoter-style sentiment score (up - down)
//   • by_query: each distinct query with up/down counts, last vote ts,
//     average result size, dominant result_kind. Sorted: thumbs-down
//     queries first (highest priority for editorial follow-up), then
//     thumbs-up by count, then alphabetic. Queries that explicitly
//     signal a database gap (down vote + 0 results) are flagged with
//     needs_discovery=true so the dashboard can call them out.
//   • recent: the 50 most-recent feedback rows, raw — for an inline
//     audit feed under the rollup. Includes member_name where set so
//     editors can DM follow-up questions.
//
// 30-day default window; ?days=N to widen or narrow.
async function handleSearchFeedback(env, origin, url) {
  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;

  const rs = await env.DB.prepare(
    `SELECT ts, member_id, member_name, plan, props_json
     FROM events
     WHERE event_name = 'search_feedback'
       AND ts >= ?
     ORDER BY ts DESC`
  ).bind(sinceTs).all();

  const rows = rs.results || [];
  const byQuery = new Map(); // q-lower -> aggregate row
  const recent = [];
  let totalUp = 0, totalDown = 0;

  for (const r of rows) {
    let props = {};
    try { if (r.props_json) props = JSON.parse(r.props_json); } catch {}
    const q = String(props.q || '').trim();
    if (!q) continue;
    const rating = props.rating === 'up' ? 'up' : props.rating === 'down' ? 'down' : null;
    if (!rating) continue;
    const results = +props.results || 0;
    const kind = String(props.result_kind || '').slice(0, 20);

    if (rating === 'up') totalUp++; else totalDown++;

    const key = q.toLowerCase();
    let agg = byQuery.get(key);
    if (!agg) {
      agg = {
        query: q, up: 0, down: 0, last_ts: 0,
        result_sum: 0, result_n: 0, kinds: {},
      };
      byQuery.set(key, agg);
    }
    agg[rating]++;
    if (r.ts > agg.last_ts) agg.last_ts = r.ts;
    agg.result_sum += results;
    agg.result_n++;
    agg.kinds[kind] = (agg.kinds[kind] || 0) + 1;

    if (recent.length < 50) {
      recent.push({
        ts: r.ts, member_id: r.member_id, member_name: r.member_name,
        plan: r.plan, query: q, rating, results, result_kind: kind,
      });
    }
  }

  const by_query = Array.from(byQuery.values()).map(a => {
    // Pick the most common result_kind for this query (its "typical" shape).
    let dominantKind = '', dominantN = 0;
    for (const k in a.kinds) { if (a.kinds[k] > dominantN) { dominantKind = k; dominantN = a.kinds[k]; } }
    const avgResults = a.result_n ? Math.round(a.result_sum / a.result_n) : 0;
    // Discovery candidate: at least one thumbs-down AND the dominant
    // outcome was empty (zero results, or 'empty'/'question' kind with
    // avg=0). These are the gaps worth handing to project discovery.
    const needsDiscovery = a.down >= 1 && (avgResults === 0 || dominantKind === 'empty');
    return {
      query: a.query,
      up: a.up, down: a.down,
      net: a.up - a.down,
      last_ts: a.last_ts,
      avg_results: avgResults,
      dominant_kind: dominantKind,
      needs_discovery: needsDiscovery,
    };
  });
  // Sort: needs_discovery first, then by total volume desc, then alpha.
  by_query.sort((a, b) => {
    if (a.needs_discovery !== b.needs_discovery) return a.needs_discovery ? -1 : 1;
    const va = a.up + a.down, vb = b.up + b.down;
    if (vb !== va) return vb - va;
    return a.query.localeCompare(b.query);
  });

  return json({
    totals: {
      up: totalUp,
      down: totalDown,
      net: totalUp - totalDown,
      total: totalUp + totalDown,
      days,
    },
    by_query,
    recent,
  }, {}, env, origin);
}

// GET /search-feedback/discoveries — the tmw-project-discovery Claude
// Code routine reads this. Returns the queries that need discovery work
// and HAVEN'T been processed yet, in a format the routine can directly
// loop over: { query, source, down, up, last_ts, hint } where hint is a short
// natural-language brief the routine can drop straight into its prompt
// ("the database is missing projects in X"). Three feeder lanes, merged +
// deduped: (1) reader_flag — a reader thumbs-down on an empty result (may
// carry an editor note); (2) reader_search — ANY reader/intel search that
// returned zero results (no down-vote needed — the automatic lane); and
// (3) daily_audit — the latest twice-daily search-audit's zero-result
// queries. So every zero-result query, from a reader or our own AI audit,
// auto-queues for discovery to research projects there on the next run.
//
// "Not processed" = no `discovery_processed` event has been logged for
// that exact query (case-insensitive). Lookback window matches the
// rollup endpoint (?days=30 default). Pending count caps at 50 so a
// single routine run can finish in a reasonable time.
async function handleDiscoveryQueue(env, origin, url) {
  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;

  // Pull all search_feedback rows in the window.
  const fb = await env.DB.prepare(
    `SELECT ts, member_id, props_json
     FROM events
     WHERE event_name = 'search_feedback' AND ts >= ?
     ORDER BY ts DESC`
  ).bind(sinceTs).all();

  // Pull every discovery_processed query so we can exclude them.
  const proc = await env.DB.prepare(
    `SELECT LOWER(TRIM(json_extract(props_json,'$.q'))) AS q
     FROM events
     WHERE event_name = 'discovery_processed'`
  ).all();
  const processed = new Set();
  for (const r of (proc.results || [])) {
    if (r.q) processed.add(r.q);
  }

  // Aggregate by query, same logic as /search-feedback rollup but tighter:
  // we only care about queries flagged needs_discovery.
  const byQuery = new Map();
  for (const r of (fb.results || [])) {
    let p = {};
    try { if (r.props_json) p = JSON.parse(r.props_json); } catch {}
    const q = String(p.q || '').trim();
    if (!q) continue;
    if (processed.has(q.toLowerCase())) continue;
    const rating = p.rating === 'up' ? 'up' : p.rating === 'down' ? 'down' : null;
    if (!rating) continue;
    const results = +p.results || 0;
    const kind = String(p.result_kind || '');
    const key = q.toLowerCase();
    let a = byQuery.get(key);
    if (!a) {
      a = { query: q, up: 0, down: 0, last_ts: 0, result_sum: 0, result_n: 0, kinds: {}, editor_note: null };
      byQuery.set(key, a);
    }
    if (p.editor_note && !a.editor_note) a.editor_note = String(p.editor_note).slice(0, 300);
    a[rating]++;
    if (r.ts > a.last_ts) a.last_ts = r.ts;
    a.result_sum += results;
    a.result_n++;
    a.kinds[kind] = (a.kinds[kind] || 0) + 1;
  }

  // AUTO signals — zero-result queries that did NOT need a human thumbs-down.
  // This is the automatic coverage-gap lane: every query that returned nothing
  // flows to discovery on its own. Two sources, both deduped against the
  // feedback rows above AND the processed set:
  //   (2) reader_search — any reader/intel search that came back with 0 results.
  //   (3) daily_audit   — the latest twice-daily search audit's 0-result queries.
  // The routine still DB-checks each (a live match = search-index bug, not a
  // missing-coverage gap), so feeding it more candidates is safe.
  function _autoAdd(rawQ, ts, source) {
    let q = String(rawQ || '').trim();
    if (!q || q.length < 4 || q.length > 160) return;   // skip junk / overlong
    const key = q.toLowerCase();
    if (processed.has(key)) return;
    let a = byQuery.get(key);
    if (!a) {
      a = { query: q, up: 0, down: 0, last_ts: 0, result_sum: 0, result_n: 0, kinds: {}, editor_note: null, auto: 0, searches: 0, fromAudit: false, source: source };
      byQuery.set(key, a);
    }
    a.auto = (a.auto || 0) + 1;
    if (source === 'reader_search') a.searches = (a.searches || 0) + 1;
    if (source === 'daily_audit') a.fromAudit = true;
    a.result_n++;   // result_sum += 0 → average stays 0 (it's a zero-result query)
    if (ts > a.last_ts) a.last_ts = ts;
  }
  try {
    const sr = await env.DB.prepare(
      `SELECT ts, props_json FROM events
       WHERE event_name IN ('intel_query','search') AND ts >= ?
         AND CAST(json_extract(props_json,'$.results') AS INTEGER) = 0
       ORDER BY ts DESC LIMIT 3000`
    ).bind(sinceTs).all();
    for (const r of (sr.results || [])) {
      let p = {}; try { if (r.props_json) p = JSON.parse(r.props_json); } catch {}
      if (p.partner) continue;   // partner spotlights aren't gaps
      _autoAdd(p.q || p.search_term, r.ts, 'reader_search');
    }
  } catch (e) { /* tolerate a missing column / shape and keep the other lanes */ }
  try {
    const st = await env.DB.prepare(
      `SELECT ts, props_json FROM events WHERE event_name = 'intel_selftest'
       ORDER BY ts DESC LIMIT 1`
    ).first();
    if (st && st.props_json) {
      let sp = {}; try { sp = JSON.parse(st.props_json); } catch {}
      const rep = Array.isArray(sp.report) ? sp.report : [];
      for (const e of rep) { if (e && (e.n === 0 || e.n === '0')) _autoAdd(e.q, st.ts, 'daily_audit'); }
    }
  } catch (e) { /* tolerate */ }

  // Discovery candidates: at least one thumbs-down AND avg results == 0
  // OR dominant kind == 'empty'. Same heuristic as the rollup endpoint's
  // needs_discovery flag.
  const items = [];
  byQuery.forEach(function (a) {
    let dom = '', domN = 0;
    for (const k in a.kinds) { if (a.kinds[k] > domN) { dom = k; domN = a.kinds[k]; } }
    const avg = a.result_n ? Math.round(a.result_sum / a.result_n) : 0;
    // Qualify a zero/empty-result query when the signal is deliberate enough:
    //   • a reader thumbs-DOWN (a.down) — one is enough, it's an explicit flag;
    //   • the daily audit flagged it (a.fromAudit) — curated, not random;
    //   • a reader SEARCH that recurred 2+ times (a.searches >= 2) — real demand,
    //     not a one-off typo/fat-finger. A single ad-hoc search is ignored.
    const qualifies = a.down >= 1 || a.fromAudit || (a.searches || 0) >= 2;
    const needs = qualifies && (avg === 0 || dom === 'empty');
    if (!needs) return;
    // Hint: a plain-English brief the discovery routine drops into its prompt.
    // Names the signal source so the LLM has context without re-deriving it.
    const who = a.down >= 1 ? 'A reader flagged'
      : a.fromAudit ? 'The daily search audit ran'
      : 'Readers searched';
    const hint = (a.editor_note ? ('EDITOR REQUEST: ' + a.editor_note + ' ') : '')
      + who + ' "' + a.query + '" and the database returned '
      + (avg === 0 ? 'zero results' : ('only ' + avg + ' marginal result' + (avg === 1 ? '' : 's')))
      + (a.auto > 1 ? (' (' + a.auto + '×)') : '')
      + '. ' + (a.editor_note ? 'Act on the editor request above. ' : '')
      + 'First confirm the gap is real: search_projects on the place + type — a live match means a SEARCH-INDEX/relevance bug to report (create nothing), not missing coverage. '
      + 'Otherwise identify the place + project type and research on-brand candidate projects to stage there as map drafts.';
    items.push({
      query: a.query,
      up: a.up,
      down: a.down,
      last_ts: a.last_ts,
      avg_results: avg,
      dominant_kind: dom,
      source: (a.down >= 1 ? 'reader_flag' : a.fromAudit ? 'daily_audit' : 'reader_search'),
      hint: hint,
    });
  });
  // Strongest signal first: human down-votes, then most-recent.
  items.sort(function (a, b) {
    if ((b.down || 0) !== (a.down || 0)) return (b.down || 0) - (a.down || 0);
    return (b.last_ts || 0) - (a.last_ts || 0);
  });

  return json({
    items: items.slice(0, limit),
    total_pending: items.length,
    days: days,
  }, {}, env, origin);
}

// POST /search-feedback/discoveries/mark — the tmw-project-discovery
// routine calls this when it's done working a query so it doesn't get
// returned again on the next poll. Body: { queries: ["query 1", ...] }.
// We log one `discovery_processed` event per query (so /discoveries can
// exclude them on subsequent reads) plus the optional `result` field
// for an audit trail of what the routine did.
async function handleDiscoveryMark(req, env, origin) {
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, { status: 400 }, env, origin); }
  const queries = Array.isArray(body && body.queries) ? body.queries : [];
  if (!queries.length) return json({ error: 'queries[] required' }, { status: 400 }, env, origin);

  const result = body && typeof body.result === 'string' ? body.result.slice(0, 600) : null;
  const draftsCreated = body && Array.isArray(body.drafts_created) ? body.drafts_created : null;
  const nowSec = Math.floor(Date.now() / 1000);
  let marked = 0;

  for (const raw of queries) {
    const q = String(raw || '').trim();
    if (!q) continue;
    try {
      await env.DB.prepare(
        `INSERT INTO events (ts, member_id, event_name, props_json)
         VALUES (?, ?, ?, ?)`
      ).bind(
        nowSec,
        'system:tmw-project-discovery',
        'discovery_processed',
        JSON.stringify({
          q: q.slice(0, 200),
          result: result,
          drafts_created: draftsCreated,
        })
      ).run();
      marked++;
    } catch (e) { /* keep going on per-row failure */ }
  }
  return json({ ok: true, marked }, {}, env, origin);
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

// Idempotently decodeURIComponent — handles single-, double-, even triple-
// encoded URL params. Stops when one more pass would be a no-op or throws.
// Safety capped at 5 passes so a malformed input can't loop forever.
function fullyDecodeSlug(s) {
  if (typeof s !== 'string') return '';
  let cur = s;
  for (let i = 0; i < 5; i++) {
    if (!/\%[0-9A-Fa-f]{2}/.test(cur)) break;
    let next;
    try { next = decodeURIComponent(cur); } catch { break; }
    if (next === cur) break;
    cur = next;
  }
  return cur;
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

// GET /post-categories — the category master for the studio multi-select.
// Union of the Wix blog taxonomy + every category already used on a post, so
// "add new category" (saved on a post) shows up here on the next load.
async function handlePostCategories(env, origin) {
  const set = new Set();
  try {
    const m = await fetchWixCategoryMap(env);
    for (const v of Object.values(m)) if (v) set.add(v);
  } catch (e) {}
  try {
    const rows = await env.DB.prepare(
      "SELECT DISTINCT categories FROM posts WHERE categories IS NOT NULL AND categories != '' AND categories != '[]' LIMIT 3000"
    ).all();
    for (const r of (rows.results || [])) for (const c of safeJsonArray(r.categories)) if (c) set.add(c);
    const mc = await env.DB.prepare(
      "SELECT DISTINCT main_category FROM posts WHERE main_category IS NOT NULL AND main_category != ''"
    ).all();
    for (const r of (mc.results || [])) if (r.main_category) set.add(r.main_category);
  } catch (e) {}
  const categories = [...set].sort((a, b) => a.localeCompare(b));
  return json({ categories }, { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' } }, env, origin);
}

async function handlePostsList(req, env, origin, url) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  // Cap at 1500 — enough to feed the journal home grid the full archive in one
  // shot (~1,377 total posts; the home shows the most-recent slice with
  // client-side pagination + filter pills computed from what's loaded).
  const limit  = clampInt(url.searchParams.get('limit'), 50, 1, 1500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 10000);
  const status = url.searchParams.get('status') || 'published';
  const category = url.searchParams.get('category');
  const q = (url.searchParams.get('q') || '').trim();
  const postType   = url.searchParams.get('post_type');
  const contactId  = url.searchParams.get('contact_id');
  const projectSlug = url.searchParams.get('project_slug');

  // status=published is public; anything else requires admin auth
  if (status !== 'published') {
    const denied = await requireAdminToken(req, env, origin);
    if (denied) return denied;
  }
  // The Monday-replacement filters are admin-only — they expose paid/income data.
  if (postType || contactId || projectSlug) {
    const denied = await requireAdminToken(req, env, origin);
    if (denied) return denied;
    await ensureContactsTable(env);
  }

  const where = ['status = ?1'];
  const params = [status];
  let p = 2;
  if (category) { where.push(`categories LIKE ?${p}`); params.push('%"' + category + '"%'); p++; }
  if (postType)   { where.push(`post_type    = ?${p}`); params.push(postType);    p++; }
  if (contactId)  { where.push(`contact_id   = ?${p}`); params.push(contactId);   p++; }
  if (projectSlug){ where.push(`project_slug = ?${p}`); params.push(projectSlug); p++; }
  if (q) {
    // Tokenized search: each meaningful word (>=3 chars, max 8) must appear in
    // the title, excerpt, OR body. Searching body_html lets the spotlight
    // overlay surface articles that only mention a term deep in the body
    // (e.g. "miami design district" -> the Kengo Kuma piece), not just ones
    // with it in the title/excerpt. Callers should pass already-cleaned terms.
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3).slice(0, 8);
    if (words.length) {
      for (const w of words) {
        where.push(`(LOWER(title) LIKE ?${p} OR LOWER(excerpt) LIKE ?${p} OR LOWER(body_html) LIKE ?${p})`);
        params.push('%' + w + '%'); p++;
      }
    } else {
      where.push(`(title LIKE ?${p} OR excerpt LIKE ?${p})`); params.push('%' + q + '%'); p++;
    }
  }
  const whereSql = where.join(' AND ');

  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM posts WHERE ${whereSql}`).bind(...params).first();
  const rows  = await env.DB.prepare(`
    SELECT id, slug, title, excerpt, cover_image, cover_image_alt, categories, tags,
           author_name, status, published_at, updated_at, reading_time_min, wix_url, featured, main_category,
           post_type, income, contact_id, project_slug
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

// Secret for signing draft-preview tokens (reuses the gallery/session secret).
// Exported so mcp.js can mint carousel preview URLs without re-implementing the JWT.
export function previewSecret(env) { return env.SESSION_SECRET || env.ADMIN_TOKEN || 'tmw-preview-fallback'; }

// GET /preview-token?slug=<slug> (admin) → a signed, 60-day, slug-scoped token
// the Studio embeds in the client preview link (/post/?slug=…&pt=<token>).
async function handlePreviewToken(req, env, origin, url) {
  const slug = fullyDecodeSlug(url.searchParams.get('slug') || '');
  if (!slug) return json({ error: 'slug required' }, { status: 400 }, env, origin);
  const token = await signPayload(
    { slug, t: 'preview', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60 },
    previewSecret(env),
  );
  return json({ token, url: 'https://www.oftmw.com/post/?slug=' + encodeURIComponent(slug) + '&pt=' + encodeURIComponent(token) }, {}, env, origin);
}

async function handlePostsBySlug(req, env, origin, slug) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  // Idempotently decode URL-encoded chars. Some inbound URLs are
  // double-encoded (e.g. %25C3%25A9 = encoded %C3%A9 = encoded é) and
  // a single decode leaves them still in encoded form, causing the DB
  // lookup to miss. Loop until the value stops changing.
  slug = fullyDecodeSlug(slug);
  // Permit non-ASCII Unicode letters in slugs (Wix allows them).
  if (!slug || slug.length > 250 || /[<>"'`\s]/.test(slug)) {
    return json({ error: 'invalid slug' }, { status: 400 }, env, origin);
  }
  const row = await env.DB
    .prepare(`SELECT * FROM posts WHERE slug = ?1 LIMIT 1`)
    .bind(slug).first();
  if (!row) return json({ error: 'post not found in DB', slug }, { status: 404 }, env, origin);
  // Drafts are visible to (a) an authenticated admin, or (b) anyone holding a
  // valid signed preview token for this slug — the "send to a client" link.
  // The token is unguessable, slug-scoped, and expiring → link-only, not indexable.
  if (row.status !== 'published') {
    let previewOk = false;
    try {
      const pt = new URL(req.url).searchParams.get('preview') || '';
      if (pt) {
        const obj = await verifyPayload(pt, previewSecret(env));
        previewOk = !!(obj && obj.t === 'preview' && obj.slug === slug);
      }
    } catch (_) {}
    if (!previewOk) {
      const denied = await requireAdminToken(req, env, origin);
      if (denied) return json({ error: 'post not yet published' }, { status: 404 }, env, origin);
    }
  }
  return json(
    { post: rowToPostFull(row) },
    { headers: { 'Cache-Control': row.status === 'published' ? 'public, max-age=60, s-maxage=120' : 'no-store' } },
    env, origin,
  );
}

// Resolve a single post by its primary id (e.g. "wix-7656dd47-..."). The admin
// post editor needs this: there are 1400+ posts, so listing-and-matching by id
// can't reliably reach old ones. Same auth model as by-slug — published is
// public; drafts require an admin token.
async function handlePostsById(req, env, origin, id) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  id = fullyDecodeSlug(id);
  if (!id || id.length > 250 || /[<>"'`\s]/.test(id)) {
    return json({ error: 'invalid id' }, { status: 400 }, env, origin);
  }
  const row = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?1 LIMIT 1`).bind(id).first();
  if (!row) return json({ error: 'post not found in DB', id }, { status: 404 }, env, origin);
  if (row.status !== 'published') {
    const denied = await requireAdminToken(req, env, origin);
    if (denied) return json({ error: 'post not yet published' }, { status: 404 }, env, origin);
  }
  return json(
    { post: rowToPostFull(row) },
    { headers: { 'Cache-Control': row.status === 'published' ? 'public, max-age=60, s-maxage=120' : 'no-store' } },
    env, origin,
  );
}

// Wix categories were not migrated, so the posts table has none. Derive a
// primary "category" (a region/location first, then a vertical) from the
// title + excerpt at read-time so every consumer — the gold tile label, the
// home region filters, the pre-rendered article pages — has something to show.
// No DB mutation; pure function over the row.
const CATEGORY_RULES = [
  ['Florida',    /\b(miami|palm beach|west palm|orlando|tampa|jacksonville|sarasota|naples|fort lauderdale|boca raton|delray|brickell|wynwood|doral|kissimmee|fort myers|gainesville|tallahassee|broward|coral gables|aventura|key west|florida|edgewater)\b/i],
  ['New York',   /\b(new york|nyc|manhattan|brooklyn|hamptons|hudson yards|queens|the bronx|long island|tribeca|soho|hudson valley)\b/i],
  ['Tennessee',  /\b(nashville|memphis|knoxville|tennessee|chattanooga)\b/i],
  ['Caribbean',  /\b(bahamas|turks|caicos|jamaica|cayman|bvi|antigua|barbados|aruba|st\.? barts|st\.? barth|puerto rico|dominican|caribbean|nevis|anguilla|bermuda|virgin islands|grenada|st\.? lucia)\b/i],
  ['Rockies',    /\b(aspen|vail|jackson hole|telluride|park city|colorado|utah|wyoming|montana|big sky|breckenridge|steamboat|deer valley)\b/i],
  ['Europe',     /\b(london|paris|milan|rome|madrid|barcelona|lisbon|monaco|ibiza|mykonos|santorini|amsterdam|berlin|europe|italy|france|spain|portugal|greece|switzerland|swiss|vienna|venice|florence|tuscany|cotswolds|riviera)\b/i],
  ['Hawaii',     /\b(hawaii|maui|kauai|oahu|honolulu|lanai|big island|waikiki|wailea)\b/i],
  ['California', /\b(los angeles|california|san francisco|beverly hills|malibu|napa|palm springs|la quinta|newport beach|san diego|montecito|santa monica|west hollywood)\b/i],
  ['Texas',      /\b(texas|austin|dallas|houston|san antonio|fort worth)\b/i],
  ['Carolinas',  /\b(charleston|carolina|asheville|kiawah|charlotte|raleigh)\b/i],
  ['Arizona',    /\b(arizona|scottsdale|phoenix|sedona)\b/i],
  ['Las Vegas',  /\b(las vegas|vegas|nevada)\b/i],
  ['Georgia',    /\b(atlanta|georgia|savannah)\b/i],
  ['Mexico',     /\b(mexico|cabo|tulum|los cabos|riviera maya|cancun)\b/i],
  ['Middle East',/\b(dubai|abu dhabi|saudi|qatar|doha|riyadh|red sea)\b/i],
  ['Asia',       /\b(tokyo|japan|singapore|hong kong|bangkok|bali|thailand|seoul|kyoto)\b/i],
];
const VERTICAL_RULES = [
  ['Golf',        /\b(golf|fairway|tee time|country club|nicklaus|hanse|links)\b/i],
  ['Restaurants', /\b(restaurant|dining|chef|michelin|cuisine|menu|tasting|culinary|eatery|cocktail|steakhouse|omakase)\b/i],
  ['Hotels',      /\b(hotel|resort|hospitality|suite|lodge|ritz|four seasons|aman|rosewood|mandarin oriental|st\.? regis)\b/i],
  ['Real Estate', /\b(residence|condo|tower|development|penthouse|high-rise|mixed-use|groundbreaking|breaks ground|waterfront)\b/i],
];
function deriveCategories(title, excerpt) {
  const hay = (title || '') + ' ' + (excerpt || '');
  const region = (CATEGORY_RULES.find(([, rx]) => rx.test(hay)) || [])[0];
  const vert   = (VERTICAL_RULES.find(([, rx]) => rx.test(hay)) || [])[0];
  const cats = [];
  if (region) cats.push(region);
  if (vert && vert !== region) cats.push(vert);
  return cats.length ? cats : ['Markets'];
}

function rowToPostSummary(r) {
  let categories = safeJsonArray(r.categories);
  if (!categories.length) categories = deriveCategories(r.title, r.excerpt);
  // Displayed gold label: the post's chosen main_category, else the most
  // specific of its categories.
  const main_category = r.main_category || pickMainCategory(categories) || null;
  return {
    main_category,
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt || '',
    cover_image: wixImagesToR2(r.cover_image),
    cover_image_alt: r.cover_image_alt,
    categories,
    tags: safeJsonArray(r.tags),
    author_name: r.author_name,
    status: r.status,
    published_at: r.published_at,
    published_iso: r.published_at ? new Date(r.published_at * 1000).toISOString() : null,
    updated_at: r.updated_at,
    reading_time_min: r.reading_time_min,
    wix_url: r.wix_url,
    featured: r.featured ? 1 : 0,
    // Monday.com replacement fields — surface on every post payload so the
    // dashboard list views (and the editor sidebar) can render them without
    // a second fetch.
    post_type:    r.post_type    || 'Editorial',
    income:       r.income == null ? null : Number(r.income),
    contact_id:   r.contact_id   || null,
    project_slug: r.project_slug || null,
    campaign_id:  r.campaign_id  || null,
  };
}

// GET /coverage-links — every PUBLISHED post with a human-set project_slug (the
// manual article→project links set in the Studio post editor). The hourly build
// (generate_pulse.py) unions these into articles.json so manual links surface in
// "Coverage on TMW" on every surface — even when the project name isn't in the
// article text. Public + read-only (all published-post data is already public).
async function handleCoverageLinks(env, origin) {
  const rows = await env.DB.prepare(
    `SELECT slug, title, cover_image, published_at, project_slug
       FROM posts
      WHERE project_slug IS NOT NULL AND project_slug != ''
        AND status = 'published'`
  ).all();
  const links = [];
  for (const r of (rows.results || [])) {
    if (!r.slug || !r.project_slug) continue;
    links.push({
      project_slug: r.project_slug,
      slug: r.slug,
      title: r.title || '',
      image: wixImagesToR2(r.cover_image) || '',
      published_at: r.published_at ? new Date(r.published_at * 1000).toISOString() : '',
      link: 'https://www.oftmw.com/post/' + r.slug,
    });
  }
  return json({ links }, { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' } }, env, origin);
}

// GET /corpus?limit=&offset= — the full published-post corpus (slug, title,
// excerpt, image, published_at) for the article→project matcher. Paginated so
// the build can page through all ~1,400 posts and match every one, instead of
// only the ~100-item RSS window. Public + read-only.
async function handleCorpus(env, origin, url) {
  const limit  = clampInt(url.searchParams.get('limit'), 1000, 1, 2000);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
  const rows = await env.DB.prepare(
    `SELECT slug, title, excerpt, cover_image, published_at, body_html
       FROM posts
      WHERE status = 'published' AND slug IS NOT NULL AND slug != ''
      ORDER BY published_at DESC
      LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  const posts = [];
  for (const r of (rows.results || [])) {
    // Strip HTML + collapse whitespace; cap the body so the matcher has the
    // lede/first section (where projects + firms are named) without shipping
    // multi-MB of markup per post.
    const body = (r.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
    posts.push({
      slug: r.slug,
      title: r.title || '',
      excerpt: r.excerpt || '',
      body,
      image: wixImagesToR2(r.cover_image) || '',
      published_at: r.published_at ? new Date(r.published_at * 1000).toISOString() : '',
      link: 'https://www.oftmw.com/post/' + r.slug,
    });
  }
  return json({ posts, limit, offset, count: posts.length }, { headers: { 'Cache-Control': 'public, max-age=600, s-maxage=600' } }, env, origin);
}
// Serve every migrated Wix image from our own R2 (the originals were copied to
// /media/wix/<file>), so the live site has no static.wixstatic.com dependency.
// Strips Wix CDN transform suffixes (…~mv2.jpg/v1/fill/…) back to the original.
const WIX_IMG_RE = /https?:\/\/static\.wixstatic\.com\/media\/([^\/\s"')?]+)(?:\/[^\s"')]*)?/gi;
// Public R2 base (r2.dev) — images serve straight from R2, bypassing the Worker.
const R2_PUBLIC_BASE = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev';
function wixImagesToR2(s) {
  if (!s) return s;
  // Also re-point any older worker-served /media URLs to the public R2 base.
  return String(s)
    .replace(WIX_IMG_RE, R2_PUBLIC_BASE + '/wix/$1')
    .replace(/https?:\/\/tmw\.jake-ab7\.workers\.dev\/media\//gi, R2_PUBLIC_BASE + '/');
}

function rowToPostFull(r) {
  return Object.assign(rowToPostSummary(r), {
    body_html: wixImagesToR2(r.body_html),
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

// Wix Blog categories are referenced by id on each post (categoryIds). Fetch
// the id→label map once so the sync can resolve real category names.
async function fetchWixCategoryMap(env) {
  const map = {};
  try {
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const res = await fetch('https://www.wixapis.com/blog/v3/categories?paging.limit=100&paging.offset=' + offset, {
        headers: {
          'Authorization': env.WIX_API_KEY,
          'wix-site-id':   env.WIX_SITE_ID,
          ...(env.WIX_ACCOUNT_ID ? { 'wix-account-id': env.WIX_ACCOUNT_ID } : {}),
        },
      });
      if (!res.ok) break;
      const d = await res.json();
      const cats = d.categories || [];
      for (const c of cats) if (c && c.id) map[c.id] = c.label || c.title || c.name || '';
      if (cats.length < 100) break;
      offset += cats.length;
    }
  } catch (e) {}
  return map;
}

// Map Wix author names to the canonical studio display names.
function canonicalAuthor(name) {
  const k = String(name || '').trim().toLowerCase();
  const map = {
    'kait': 'Kait Nicholas',
    'kait nicholas': 'Kait Nicholas',
    'jake': 'Jake Nicholas',
    'jake nicholas': 'Jake Nicholas',
  };
  return map[k] || name;
}

// The displayed "main category" is the most specific one — i.e. the first that
// is NOT a broad "… of Tomorrow" filter tag. Falls back to the first category.
function pickMainCategory(cats) {
  if (!cats || !cats.length) return null;
  // "… of Tomorrow" tags are filter-only — never the displayed main category.
  return cats.find(c => !/of tomorrow$/i.test(String(c).trim())) || null;
}

async function handleWixSync(req, env, origin, url) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  const denied = await requireAdminToken(req, env, origin);   // accepts GitHub session OR ADMIN_TOKEN
  if (denied) return denied;
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
  const catMap   = await fetchWixCategoryMap(env);   // id → label, for resolving post categoryIds

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

      // Author name (best-effort), canonicalized to the studio display names.
      let authorName = null;
      if (wp.memberId) authorName = await resolveAuthor(wp.memberId);
      if (!authorName) authorName = 'Markets of Tomorrow';
      authorName = canonicalAuthor(authorName);

      // Resolve Wix categoryIds → real labels via the category map.
      const cats = Array.isArray(wp.categoryIds)
        ? wp.categoryIds.map(id => catMap[id]).filter(Boolean)
        : [];
      const mainCategory = pickMainCategory(cats);
      const tags = [];
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
        main_category:   mainCategory,
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
            wix_url = ?16, body_source = ?17, updated_at = ?18, main_category = ?19
          WHERE wix_id = ?20
        `).bind(
          row.slug, row.title, row.excerpt, row.body_html,
          row.cover_image, row.cover_image_alt, row.categories, row.tags,
          row.author_name, row.author_id, row.status, row.published_at,
          row.reading_time_min, row.seo_title, row.seo_description,
          row.wix_url, row.body_source, row.updated_at, row.main_category, wp.id,
        ).run();
        updated++;
      } else {
        await env.DB.prepare(`
          INSERT INTO posts (
            id, slug, title, excerpt, body_html, cover_image, cover_image_alt,
            categories, tags, author_name, author_id, status, published_at,
            reading_time_min, seo_title, seo_description, wix_id, wix_url,
            body_source, created_at, updated_at, main_category
          ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
        `).bind(
          row.id, row.slug, row.title, row.excerpt, row.body_html,
          row.cover_image, row.cover_image_alt, row.categories, row.tags,
          row.author_name, row.author_id, row.status, row.published_at,
          row.reading_time_min, row.seo_title, row.seo_description,
          row.wix_id, row.wix_url, row.body_source, row.created_at, row.updated_at,
          row.main_category,
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
  // Idempotently decode URL-encoded chars (e.g. %C3%A9 → é, and the
  // double-encoded %25C3%25A9 → %C3%A9 → é) so the Wix slug filter
  // matches what's actually stored.
  slug = fullyDecodeSlug(slug);

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
// Resolve a raw Wix URL-ish value: if it's a real http(s) URL pass through,
// if it's a wix:image:// URI extract the media id, otherwise assume it's a
// bare media id and prepend the CDN host. Wix is inconsistent — they
// sometimes use the field name `url` for what is actually just a media id
// (see GALLERY items in production).
function resolveWixMediaValue(v) {
  if (typeof v !== 'string' || !v) return '';
  if (v.startsWith('http://') || v.startsWith('https://')) return v;
  const m = v.match(/wix:image:\/\/v1\/([^/]+)\//);
  if (m) return `https://static.wixstatic.com/media/${m[1]}`;
  // Bare media id like 5e6308_xxx~mv2.jpeg or ca3b83_yyy~mv2.png
  if (/^[a-f0-9]+_[a-f0-9]+~mv2\.[a-z0-9]+$/i.test(v)) {
    return `https://static.wixstatic.com/media/${v}`;
  }
  // Fallback: assume bare id even without the ~mv2 suffix
  if (!v.includes('/') && !v.includes(' ')) {
    return `https://static.wixstatic.com/media/${v}`;
  }
  return '';
}

function wixMediaToPublicUrl(image) {
  if (!image) return '';
  if (typeof image === 'string') return resolveWixMediaValue(image);
  // 1. Flat URL
  if (typeof image.url === 'string' && image.url) return resolveWixMediaValue(image.url);
  // 2. Ricos: image.src is an object with `url` (which may actually be a bare id, hence resolveWixMediaValue)
  if (image.src && typeof image.src === 'object' && typeof image.src.url === 'string') {
    return resolveWixMediaValue(image.src.url);
  }
  // 2b. Ricos: image.src.id — bare media id
  if (image.src && typeof image.src === 'object' && typeof image.src.id === 'string') {
    return resolveWixMediaValue(image.src.id);
  }
  // 3. image.src as a string (wix-URI or http URL)
  if (typeof image.src === 'string' && image.src) return resolveWixMediaValue(image.src);
  // 4. Bare media id at top level
  if (typeof image.id === 'string' && image.id) return resolveWixMediaValue(image.id);
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
    case 'PARAGRAPH': {
      // Wix uses empty PARAGRAPHs as block-spacing between figures/etc.
      // Our CSS already spaces sibling blocks, so emit nothing if a
      // paragraph has no meaningful content. This kills the cosmetic
      // <p></p> gaps that otherwise stack between every image.
      const inner = ricosChildren(node);
      const meaningful = inner.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').trim();
      if (!meaningful) return '';
      return `<p>${inner}</p>`;
    }
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
      const slides = items.map(it => {
        const candidate = (it.image && it.image.media) || it.image || it;
        const url = wixMediaToPublicUrl(candidate);
        if (!url) return '';
        const alt = it.altText || it.title || '';
        const caption = it.title && it.title.trim() ? `<div class="tmw-gallery-caption">${escHtml(it.title)}</div>` : '';
        return `<div class="tmw-gallery-slide"><img src="${escAttr(url)}" alt="${escAttr(alt)}" loading="lazy">${caption}</div>`;
      }).filter(Boolean);
      if (!slides.length) return '';
      const nav = slides.length > 1 ? `
        <button class="tmw-gallery-arrow prev" aria-label="Previous image">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 8H3M7 4L3 8l4 4"/></svg>
        </button>
        <button class="tmw-gallery-arrow next" aria-label="Next image">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
        </button>
        <div class="tmw-gallery-counter">1 / ${slides.length}</div>
      ` : '';
      return `<figure class="tmw-gallery" data-gallery><div class="tmw-gallery-track">${slides.join('')}</div>${nav}</figure>`;
    }
    case 'HTML': {
      // Prefer the iframe URL form when present (YouTube/Vimeo/etc.)
      if (node.htmlData && node.htmlData.url) {
        const url = node.htmlData.url;
        const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
        if (RICOS_IFRAME_ALLOWED.some(h => host === h || host.endsWith('.' + h))) {
          return `<figure><iframe src="${escAttr(url)}" loading="lazy" allowfullscreen></iframe></figure>`;
        }
      }
      // Raw HTML embeds: aggressively strip Wix-pro-gallery init blobs.
      // These are <style>...</style> + <script>...</script> blocks that
      // configure the Wix-side gallery widget — useless on our site and
      // their contents leak as visible text once the sanitizer runs.
      const raw = (node.htmlData && node.htmlData.html) || '';
      if (raw && typeof raw === 'string') {
        let clean = raw
          .replace(/<script\b[\s\S]*?<\/script>/gi, '')
          .replace(/<style\b[\s\S]*?<\/style>/gi, '')
          .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
          .replace(/\s+on[a-z]+="[^"]*"/gi, '');
        // After stripping: if there's no visible content AND no media tags
        // left, drop the whole node so it doesn't leave an empty block.
        const visible = clean.replace(/<[^>]+>/g, '').trim();
        if (!visible && !/<(img|iframe|video|audio|picture)\b/i.test(clean)) return '';
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
  slug = fullyDecodeSlug(slug);
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
// Post write endpoints — Studio creates/edits/publishes posts here. All
// admin-gated. Native posts get id like 'tmw-<random>'; Wix imports
// keep their 'wix-<id>' so re-syncs don't collide.
// ---------------------------------------------------------------------------

async function handlePostsCreate(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }

  const title = (body.title || '').toString().trim() || 'Untitled draft';
  const slug  = ensureUniqueSlug(env, body.slug || slugify(title), null);
  const now   = Math.floor(Date.now() / 1000);
  const id    = body.id || ('tmw-' + cryptoRandomId(12));

  await ensureContactsTable(env); // also bootstraps the new posts columns

  const row = normalizePost({
    id, slug: await slug, title,
    excerpt: (body.excerpt || '').toString(),
    body_html: (body.body_html || '').toString(),
    cover_image: (body.cover_image || '').toString(),
    cover_image_alt: (body.cover_image_alt || '').toString(),
    categories: jsonArrayOrEmpty(body.categories),
    tags:       jsonArrayOrEmpty(body.tags),
    author_name: (body.author_name || 'Markets of Tomorrow').toString(),
    author_id:   body.author_id || null,
    status: (body.status === 'published' ? 'published' : 'draft'),
    published_at: body.status === 'published' ? now : null,
    seo_title: body.seo_title || null,
    seo_description: body.seo_description || null,
    wix_id: null, wix_url: null,
    body_source: 'studio',
    created_at: now, updated_at: now,
    reading_time_min: estimateReadingMinutes((body.body_html || '').toString()),
  });
  const postType    = normalizePostType(body.post_type);
  const income      = body.income == null || body.income === '' ? null : Number(body.income);
  const contactId   = body.contact_id || null;
  const projectSlug = body.project_slug ? String(body.project_slug).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160) : null;

  try {
    await env.DB.prepare(`
      INSERT INTO posts (
        id, slug, title, excerpt, body_html, cover_image, cover_image_alt,
        categories, tags, author_name, author_id, status, published_at,
        reading_time_min, seo_title, seo_description, wix_id, wix_url,
        body_source, post_type, income, contact_id, project_slug,
        created_at, updated_at
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)
    `).bind(
      row.id, row.slug, row.title, row.excerpt, row.body_html, row.cover_image, row.cover_image_alt,
      row.categories, row.tags, row.author_name, row.author_id, row.status, row.published_at,
      row.reading_time_min, row.seo_title, row.seo_description, row.wix_id, row.wix_url,
      row.body_source, postType, income, contactId, projectSlug,
      row.created_at, row.updated_at,
    ).run();
  } catch (e) {
    return json({ error: 'insert failed', detail: e.message || String(e) }, { status: 500 }, env, origin);
  }
  const fresh = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?1`).bind(row.id).first();
  return json({ ok: true, post: rowToPostFull(fresh) }, {}, env, origin);
}

const POST_TYPE_ENUM = new Set(['Editorial','Barter','Potential Barter','Partner','Paid']);
function normalizePostType(v) {
  if (v == null || v === '') return 'Editorial';
  const s = String(v).trim();
  if (POST_TYPE_ENUM.has(s)) return s;
  // Case-insensitive match for tolerance — e.g. 'paid' → 'Paid'.
  for (const t of POST_TYPE_ENUM) if (t.toLowerCase() === s.toLowerCase()) return t;
  return 'Editorial';
}

async function handlePostsUpdate(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }

  const existing = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?1`).bind(id).first();
  if (!existing) return json({ error: 'post not found', id }, { status: 404 }, env, origin);

  await ensureContactsTable(env); // also bootstraps the new posts columns

  // Field-by-field merge: only update keys present in the request body.
  const patch = {};
  for (const k of ['title','excerpt','body_html','cover_image','cover_image_alt',
                   'author_name','author_id','status','seo_title','seo_description']) {
    if (k in body) patch[k] = body[k];
  }
  if ('categories' in body) patch.categories = JSON.stringify(asStringArray(body.categories));
  if ('tags'       in body) patch.tags       = JSON.stringify(asStringArray(body.tags));
  if ('featured'   in body) patch.featured   = body.featured ? 1 : 0;
  if ('main_category' in body) patch.main_category = body.main_category ? String(body.main_category) : null;
  if ('published_at'  in body) patch.published_at  = body.published_at ? Number(body.published_at) : null;
  if ('post_type'    in body) patch.post_type    = normalizePostType(body.post_type);
  if ('income'       in body) patch.income       = body.income === '' || body.income == null ? null : Number(body.income);
  if ('contact_id'   in body) patch.contact_id   = body.contact_id || null;
  if ('project_slug' in body) patch.project_slug = body.project_slug ? String(body.project_slug).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160) : null;
  if ('campaign_id'  in body) {
    await ensureCampaignsTable(env);
    patch.campaign_id = body.campaign_id || null;
    // When linking via PATCH (and the caller didn't supply an explicit income),
    // derive the per-post split from the campaign so the link flow is
    // single-step. Caller can still send income to override.
    if (patch.campaign_id && !('income' in body)) {
      const c = await env.DB.prepare(`SELECT total_income, planned_posts FROM campaigns WHERE id = ?1`).bind(patch.campaign_id).first();
      const per = campaignIncomePerPost(c);
      if (per != null) patch.income = per;
    }
    // Unlinking clears any campaign-derived income unless caller overrides.
    if (patch.campaign_id == null && !('income' in body)) patch.income = null;
  }
  if ('slug'       in body && body.slug && body.slug !== existing.slug) {
    patch.slug = await ensureUniqueSlug(env, slugify(body.slug), id);
  }
  // Publishing now? Set published_at if going draft→published (unless the
  // editor supplied an explicit date in this request).
  if (patch.status === 'published' && existing.status !== 'published' && !existing.published_at && !('published_at' in body)) {
    patch.published_at = Math.floor(Date.now() / 1000);
  }
  if ('body_html' in patch) {
    patch.reading_time_min = estimateReadingMinutes(patch.body_html || '');
  }
  patch.updated_at = Math.floor(Date.now() / 1000);

  // Build UPDATE statement
  const keys = Object.keys(patch);
  if (!keys.length) return json({ ok: true, post: rowToPostFull(existing), note: 'no changes' }, {}, env, origin);
  const setSql = keys.map((k, i) => `${k} = ?${i+1}`).join(', ');
  const args   = keys.map(k => patch[k]);
  args.push(id);
  try {
    await env.DB.prepare(`UPDATE posts SET ${setSql} WHERE id = ?${keys.length+1}`).bind(...args).run();
  } catch (e) {
    return json({ error: 'update failed', detail: e.message || String(e) }, { status: 500 }, env, origin);
  }
  const updated = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?1`).bind(id).first();
  return json({ ok: true, post: rowToPostFull(updated) }, {}, env, origin);
}

async function handlePostsDelete(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  const r = await env.DB.prepare(`DELETE FROM posts WHERE id = ?1`).bind(id).run();
  return json({ ok: true, id, deleted: r.meta && r.meta.changes ? r.meta.changes : 0 }, {}, env, origin);
}

async function handlePostsPublish(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`UPDATE posts SET status='published', published_at=COALESCE(published_at, ?1), updated_at=?1 WHERE id=?2`).bind(now, id).run();
  const updated = await env.DB.prepare(`SELECT * FROM posts WHERE id = ?1`).bind(id).first();
  if (!updated) return json({ error: 'post not found' }, { status: 404 }, env, origin);
  return json({ ok: true, post: rowToPostFull(updated) }, {}, env, origin);
}

// ─── Social-media carousels ─────────────────────────────────────────────────
// Instagram-style post drafts you stage in the Studio, then share with a
// client via a signed preview URL (https://tmw.<worker>/c/<slug>?preview=<jwt>).
// Same shape as the article-draft "Copy client link" flow, but the public
// preview page is Worker-rendered (no separate static site) so a fresh
// deploy works immediately. Slides are stored as a JSON array; media is
// uploaded through the existing /admin/upload (images) and
// /admin/upload-multipart (large videos) endpoints, so this feature reuses
// the existing R2 + media-table indexing.
// Exported so mcp.js can lazily ensure the carousels table before its tools run.
export async function ensureCarouselTable(env) {
  if (!env.DB) return;
  // Idempotent — first request after deploy creates the table.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS carousels (
      id              TEXT    PRIMARY KEY,
      slug            TEXT    NOT NULL UNIQUE,
      caption         TEXT,
      account_handle  TEXT    NOT NULL DEFAULT 'floridaoftomorrow',
      account_name    TEXT    NOT NULL DEFAULT 'FLORIDAOFTOMORROW',
      account_avatar  TEXT,
      slides          TEXT    NOT NULL DEFAULT '[]',
      status          TEXT    NOT NULL DEFAULT 'draft',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_carousels_slug    ON carousels(slug)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_carousels_updated ON carousels(updated_at DESC)`),
  ]);
}

// ─── Contacts + post-extension bootstrap ───────────────────────────────────
// Same self-bootstrap pattern as carousels: idempotent CREATE/ALTER on first
// request. The ALTER calls add the new Editorial/Paid/Contact tracking columns
// to the existing posts table; each is wrapped so a re-run is a no-op once
// the column exists. Mirrors gallery.js's `pin` column add.
export async function ensureContactsTable(env) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      email       TEXT,
      company     TEXT,
      phone       TEXT,
      tags        TEXT    DEFAULT '[]',
      notes       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_contacts_name    ON contacts(name)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_contacts_email   ON contacts(email)   WHERE email IS NOT NULL`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company) WHERE company IS NOT NULL`),
  ]);
  // Add the "featured" column (top-of-rolodex marker). Idempotent — duplicate
  // ADD throws on D1 and we silently swallow it.
  try { await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN featured INTEGER DEFAULT 0`).run(); } catch (_) {}
  try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_contacts_featured ON contacts(featured) WHERE featured = 1`).run(); } catch (_) {}
  // Posts table extensions — Monday.com sheet replacement fields. Try/catch
  // each so a re-run silently no-ops once the column exists (D1 returns an
  // error on duplicate-column ADD).
  for (const sql of [
    `ALTER TABLE posts ADD COLUMN post_type    TEXT DEFAULT 'Editorial'`,
    `ALTER TABLE posts ADD COLUMN income       REAL`,
    `ALTER TABLE posts ADD COLUMN contact_id   TEXT`,
    `ALTER TABLE posts ADD COLUMN project_slug TEXT`,
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (_) { /* already exists */ }
  }
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_posts_contact   ON posts(contact_id)   WHERE contact_id   IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_posts_project   ON posts(project_slug) WHERE project_slug IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_posts_type_date ON posts(post_type, published_at DESC)`,
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }
}

// ─── Campaigns ──────────────────────────────────────────────────────────
// Multi-month commitments with a client (e.g. "Ponce Park Coral Gables —
// 10-month Gold campaign, $18,750, 5 deliverables"). Each post can link to
// one campaign via posts.campaign_id; income is auto-derived from
// total_income / planned_posts on link/unlink.
//
// status: 'live' (in progress) | 'ended' (wrapped). Tier is free-form to
// accept Gold / Platinum / Custom / future tiers without schema churn.
// monthly_income is the recurring rate for "$/mo" campaigns; total_income
// is the lump-sum value (use whichever was negotiated).
export async function ensureCampaignsTable(env) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaigns (
      id              TEXT    PRIMARY KEY,
      slug            TEXT,
      name            TEXT    NOT NULL,
      contact_id      TEXT,
      project_slug    TEXT,
      tier            TEXT,
      status          TEXT    NOT NULL DEFAULT 'live',
      start_date      INTEGER,
      end_date        INTEGER,
      total_income    REAL,
      monthly_income  REAL,
      planned_posts   INTEGER,
      notes           TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_campaigns_status      ON campaigns(status, start_date DESC)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_campaigns_contact     ON campaigns(contact_id)   WHERE contact_id IS NOT NULL`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_campaigns_project     ON campaigns(project_slug) WHERE project_slug IS NOT NULL`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_campaigns_name        ON campaigns(name)`),
  ]);
  // Extend posts with campaign_id (idempotent — silently no-ops after first run).
  try { await env.DB.prepare(`ALTER TABLE posts ADD COLUMN campaign_id TEXT`).run(); } catch (_) {}
  try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_posts_campaign ON posts(campaign_id) WHERE campaign_id IS NOT NULL`).run(); } catch (_) {}
}

function rowToCampaign(r, postCount) {
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug || '',
    name: r.name || '',
    contact_id:   r.contact_id   || null,
    project_slug: r.project_slug || null,
    tier:   r.tier   || null,
    status: r.status || 'live',
    start_date: r.start_date || null,
    end_date:   r.end_date   || null,
    total_income:   r.total_income   == null ? null : Number(r.total_income),
    monthly_income: r.monthly_income == null ? null : Number(r.monthly_income),
    planned_posts:  r.planned_posts  == null ? null : Number(r.planned_posts),
    notes: r.notes || '',
    post_count: typeof postCount === 'number' ? postCount : null,
    income_per_post: (r.total_income != null && r.planned_posts ? Number(r.total_income) / Number(r.planned_posts) : null),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Income math runs both on /campaigns mutation (re-spread the income across
// linked posts when total_income or planned_posts changes) and on link/unlink.
function campaignIncomePerPost(c) {
  if (!c) return null;
  const total = c.total_income == null ? null : Number(c.total_income);
  const n = c.planned_posts == null ? null : Number(c.planned_posts);
  if (total == null || !n || n <= 0) return null;
  // Round to cents to avoid 0.000000001 drift across many splits.
  return Math.round((total / n) * 100) / 100;
}

async function recalcCampaignPostIncomes(env, campaignId) {
  const c = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(campaignId).first();
  const per = campaignIncomePerPost(c);
  // When per is null we still PATCH so removing planned_posts clears income
  // on linked posts. Null splits clear the income field.
  await env.DB.prepare(`UPDATE posts SET income = ?1, updated_at = ?2 WHERE campaign_id = ?3`)
    .bind(per, Math.floor(Date.now() / 1000), campaignId).run();
}

async function handleCampaignsList(req, env, origin, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureCampaignsTable(env);
  const limit  = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
  const status = url.searchParams.get('status');
  const q      = (url.searchParams.get('q') || '').trim().toLowerCase();
  const where = []; const params = []; let p = 1;
  if (status) { where.push(`status = ?${p}`); params.push(status); p++; }
  if (q)      { where.push(`(LOWER(name) LIKE ?${p} OR LOWER(notes) LIKE ?${p})`); params.push('%'+q+'%'); p++; }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM campaigns ${whereSql}`).bind(...params).first();
  // Sort: live first (by most-recent start), then ended (also recent-first).
  const rows = (await env.DB.prepare(
    `SELECT * FROM campaigns ${whereSql}
     ORDER BY CASE WHEN status='live' THEN 0 ELSE 1 END, COALESCE(start_date, created_at) DESC
     LIMIT ${limit} OFFSET ${offset}`
  ).bind(...params).all()).results || [];
  // Bulk post-count lookup (chunk to avoid D1's 100-placeholder cap).
  let counts = {};
  const CHUNK = 90;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const placeholders = slice.map((_, j) => `?${j+1}`).join(',');
    const cRows = (await env.DB.prepare(
      `SELECT campaign_id, COUNT(*) AS c FROM posts WHERE campaign_id IN (${placeholders}) GROUP BY campaign_id`
    ).bind(...slice.map(r => r.id)).all()).results || [];
    for (const cr of cRows) counts[cr.campaign_id] = cr.c;
  }
  return json(
    { items: rows.map(r => rowToCampaign(r, counts[r.id] || 0)), total: total ? total.c : 0, limit, offset, hasMore: offset + rows.length < (total ? total.c : 0) },
    {}, env, origin,
  );
}

async function handleCampaignGet(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureCampaignsTable(env);
  const row = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
  if (!row) return json({ error: 'campaign not found' }, { status: 404 }, env, origin);
  const posts = (await env.DB.prepare(
    `SELECT id, slug, title, post_type, income, published_at, status
     FROM posts WHERE campaign_id = ?1 ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 500`
  ).bind(id).all()).results || [];
  return json({ campaign: rowToCampaign(row, posts.length), posts }, {}, env, origin);
}

const CAMPAIGN_WRITABLE = ['name','contact_id','project_slug','tier','status','start_date','end_date','total_income','monthly_income','planned_posts','notes','slug'];

async function handleCampaignsCreate(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureCampaignsTable(env);
  let body; try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const name = (body.name || '').toString().trim();
  if (!name) return json({ error: 'name is required' }, { status: 400 }, env, origin);
  const now = Math.floor(Date.now() / 1000);
  const id = body.id || ('cmp-' + cryptoRandomId(12));
  const cols = ['id', 'name', 'status', 'created_at', 'updated_at'];
  const vals = [id, name, body.status === 'ended' ? 'ended' : 'live', now, now];
  for (const k of CAMPAIGN_WRITABLE) {
    if (k === 'name' || k === 'status') continue;
    if (k in body) { cols.push(k); vals.push(body[k] === '' ? null : body[k]); }
  }
  const placeholders = vals.map((_, i) => `?${i+1}`).join(',');
  try {
    await env.DB.prepare(`INSERT INTO campaigns (${cols.join(', ')}) VALUES (${placeholders})`).bind(...vals).run();
  } catch (e) {
    return json({ error: 'insert failed', detail: e.message || String(e) }, { status: 500 }, env, origin);
  }
  const row = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
  return json({ ok: true, campaign: rowToCampaign(row, 0) }, {}, env, origin);
}

async function handleCampaignsUpdate(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureCampaignsTable(env);
  const existing = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
  if (!existing) return json({ error: 'campaign not found' }, { status: 404 }, env, origin);
  let body; try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const patch = {};
  for (const k of CAMPAIGN_WRITABLE) {
    if (k in body) patch[k] = body[k] === '' ? null : body[k];
  }
  if (!Object.keys(patch).length) return json({ ok: true, campaign: rowToCampaign(existing), note: 'no changes' }, {}, env, origin);
  patch.updated_at = Math.floor(Date.now() / 1000);
  const keys = Object.keys(patch);
  const setSql = keys.map((k, i) => `${k} = ?${i+1}`).join(', ');
  const args = keys.map(k => patch[k]); args.push(id);
  await env.DB.prepare(`UPDATE campaigns SET ${setSql} WHERE id = ?${keys.length+1}`).bind(...args).run();
  // If income or split-count changed, re-spread across linked posts.
  if ('total_income' in patch || 'planned_posts' in patch) {
    await recalcCampaignPostIncomes(env, id);
  }
  const updated = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
  return json({ ok: true, campaign: rowToCampaign(updated) }, {}, env, origin);
}

async function handleCampaignsDelete(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureCampaignsTable(env);
  // Detach posts first — keeps the posts intact, just clears the campaign
  // link + per-split income.
  await env.DB.prepare(`UPDATE posts SET campaign_id = NULL, income = NULL WHERE campaign_id = ?1`).bind(id).run();
  const r = await env.DB.prepare(`DELETE FROM campaigns WHERE id = ?1`).bind(id).run();
  return json({ ok: true, id, deleted: r.meta && r.meta.changes ? r.meta.changes : 0 }, {}, env, origin);
}

async function handleCampaignLinkPost(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureCampaignsTable(env);
  let body; try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const postId = (body.post_id || '').toString().trim();
  if (!postId) return json({ error: 'post_id is required' }, { status: 400 }, env, origin);
  const campaign = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
  if (!campaign) return json({ error: 'campaign not found' }, { status: 404 }, env, origin);
  const post = await env.DB.prepare(`SELECT id FROM posts WHERE id = ?1`).bind(postId).first();
  if (!post) return json({ error: 'post not found' }, { status: 404 }, env, origin);
  const per = campaignIncomePerPost(campaign);
  await env.DB.prepare(`UPDATE posts SET campaign_id = ?1, income = ?2, updated_at = ?3 WHERE id = ?4`)
    .bind(id, per, Math.floor(Date.now() / 1000), postId).run();
  return json({ ok: true, post_id: postId, campaign_id: id, income_per_post: per }, {}, env, origin);
}

async function handleCampaignUnlinkPost(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureCampaignsTable(env);
  let body; try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const postId = (body.post_id || '').toString().trim();
  if (!postId) return json({ error: 'post_id is required' }, { status: 400 }, env, origin);
  await env.DB.prepare(`UPDATE posts SET campaign_id = NULL, income = NULL, updated_at = ?1 WHERE id = ?2 AND campaign_id = ?3`)
    .bind(Math.floor(Date.now() / 1000), postId, id).run();
  return json({ ok: true, post_id: postId, campaign_id: id }, {}, env, origin);
}

function rowToContact(r, postCount) {
  if (!r) return null;
  let tags = [];
  try { tags = JSON.parse(r.tags || '[]'); if (!Array.isArray(tags)) tags = []; } catch { tags = []; }
  return {
    id: r.id,
    name: r.name || '',
    email: r.email || '',
    company: r.company || '',
    phone: r.phone || '',
    tags,
    notes: r.notes || '',
    featured: r.featured ? 1 : 0,
    post_count: typeof postCount === 'number' ? postCount : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function normalizeContactTags(v) {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

async function handleContactsList(req, env, origin, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureContactsTable(env);
  const limit  = clampInt(url.searchParams.get('limit'), 200, 1, 1000);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
  const q        = (url.searchParams.get('q') || '').trim().toLowerCase();
  const tag      = (url.searchParams.get('tag') || '').trim();
  const featured = url.searchParams.get('featured');
  const sort     = (url.searchParams.get('sort') || '').trim();   // 'name' | 'featured' | 'recent'
  const where = []; const params = []; let p = 1;
  if (q)   { where.push(`(LOWER(name) LIKE ?${p} OR LOWER(email) LIKE ?${p} OR LOWER(company) LIKE ?${p})`); params.push('%'+q+'%'); p++; }
  if (tag) { where.push(`tags LIKE ?${p}`); params.push('%"'+tag+'"%'); p++; }
  if (featured === '1' || featured === 'true') where.push(`featured = 1`);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // Default sort: featured at top, then alphabetical. Callers can override
  // with sort=name (purely alphabetical) or sort=recent.
  let orderSql = 'featured DESC, LOWER(name) ASC';
  if (sort === 'name')    orderSql = 'LOWER(name) ASC';
  if (sort === 'recent')  orderSql = 'updated_at DESC';
  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM contacts ${whereSql}`).bind(...params).first();
  const rows  = (await env.DB.prepare(
    `SELECT id, name, email, company, phone, tags, notes, featured, created_at, updated_at
     FROM contacts ${whereSql} ORDER BY ${orderSql} LIMIT ${limit} OFFSET ${offset}`
  ).bind(...params).all()).results || [];
  // Bulk post-count lookup so the list view can show "12 posts" per contact
  // without N+1 queries. D1 caps a prepared statement at ~100 placeholders,
  // so chunk the IN clause when callers paginate beyond that.
  let counts = {};
  const CHUNK = 90;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const placeholders = slice.map((_, j) => `?${j+1}`).join(',');
    const cRows = (await env.DB.prepare(
      `SELECT contact_id, COUNT(*) AS c FROM posts WHERE contact_id IN (${placeholders}) GROUP BY contact_id`
    ).bind(...slice.map(r => r.id)).all()).results || [];
    for (const cr of cRows) counts[cr.contact_id] = cr.c;
  }
  return json(
    { items: rows.map(r => rowToContact(r, counts[r.id] || 0)), total: total ? total.c : 0, limit, offset, hasMore: offset + rows.length < (total ? total.c : 0) },
    {}, env, origin,
  );
}

async function handleContactGet(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureContactsTable(env);
  const row = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?1`).bind(id).first();
  if (!row) return json({ error: 'contact not found' }, { status: 404 }, env, origin);
  const posts = (await env.DB.prepare(
    `SELECT slug, title, post_type, income, published_at, status
     FROM posts WHERE contact_id = ?1 ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 500`
  ).bind(id).all()).results || [];
  return json({ contact: rowToContact(row, posts.length), posts }, {}, env, origin);
}

async function handleContactsCreate(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureContactsTable(env);
  let body; try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const name = (body.name || '').toString().trim();
  if (!name) return json({ error: 'name is required' }, { status: 400 }, env, origin);
  const now = Math.floor(Date.now() / 1000);
  const id = body.id || ('cnt-' + cryptoRandomId(12));
  const tagsJson = JSON.stringify(normalizeContactTags(body.tags));
  const featured = body.featured ? 1 : 0;
  try {
    await env.DB.prepare(
      `INSERT INTO contacts (id, name, email, company, phone, tags, notes, featured, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
    ).bind(id, name, body.email || null, body.company || null, body.phone || null, tagsJson, body.notes || null, featured, now).run();
  } catch (e) {
    return json({ error: 'insert failed', detail: e.message || String(e) }, { status: 500 }, env, origin);
  }
  const row = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?1`).bind(id).first();
  return json({ ok: true, contact: rowToContact(row, 0) }, {}, env, origin);
}

async function handleContactsUpdate(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureContactsTable(env);
  const existing = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?1`).bind(id).first();
  if (!existing) return json({ error: 'contact not found' }, { status: 404 }, env, origin);
  let body; try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const patch = {};
  for (const k of ['name','email','company','phone','notes']) if (k in body) patch[k] = body[k];
  if ('tags' in body) patch.tags = JSON.stringify(normalizeContactTags(body.tags));
  if ('featured' in body) patch.featured = body.featured ? 1 : 0;
  if (!Object.keys(patch).length) return json({ ok: true, contact: rowToContact(existing), note: 'no changes' }, {}, env, origin);
  patch.updated_at = Math.floor(Date.now() / 1000);
  const keys = Object.keys(patch);
  const setSql = keys.map((k, i) => `${k} = ?${i+1}`).join(', ');
  const args = keys.map(k => patch[k]); args.push(id);
  await env.DB.prepare(`UPDATE contacts SET ${setSql} WHERE id = ?${keys.length+1}`).bind(...args).run();
  const updated = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?1`).bind(id).first();
  return json({ ok: true, contact: rowToContact(updated) }, {}, env, origin);
}

async function handleContactsDelete(req, env, origin, id) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureContactsTable(env);
  // Detach from any posts so we don't leave dangling FKs. Posts stay; the
  // contact slot just empties — the editor will show "(no contact)".
  await env.DB.prepare(`UPDATE posts SET contact_id = NULL WHERE contact_id = ?1`).bind(id).run();
  const r = await env.DB.prepare(`DELETE FROM contacts WHERE id = ?1`).bind(id).run();
  return json({ ok: true, id, deleted: r.meta && r.meta.changes ? r.meta.changes : 0 }, {}, env, origin);
}

// /companies — distinct company values across the contacts table with a
// per-company contact count. Drives the autocomplete on every company input
// in the admin so people don't fork "LDPR" vs "LD PR" vs "Ldpr" on every
// new contact.
async function handleCompaniesList(req, env, origin, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  await ensureContactsTable(env);
  const q     = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = clampInt(url.searchParams.get('limit'), 20, 1, 200);
  const where = ['company IS NOT NULL AND company != \'\''];
  const params = []; let p = 1;
  if (q) { where.push(`LOWER(company) LIKE ?${p}`); params.push('%' + q + '%'); p++; }
  const rows = (await env.DB.prepare(
    `SELECT company, COUNT(*) AS c FROM contacts WHERE ${where.join(' AND ')}
     GROUP BY LOWER(company) ORDER BY c DESC, LOWER(company) ASC LIMIT ${limit}`
  ).bind(...params).all()).results || [];
  return json(
    { items: rows.map(r => ({ company: r.company, contact_count: r.c })) },
    {}, env, origin,
  );
}

function rowToCarousel(r) {
  if (!r) return null;
  let slides = [];
  try { slides = JSON.parse(r.slides || '[]'); if (!Array.isArray(slides)) slides = []; } catch { slides = []; }
  return {
    id: r.id,
    slug: r.slug,
    caption: r.caption || '',
    account_handle: r.account_handle || 'floridaoftomorrow',
    account_name:   r.account_name   || 'FLORIDAOFTOMORROW',
    account_avatar: r.account_avatar || null,
    slides,
    status: r.status || 'draft',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function normalizeSlides(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const s of input) {
    if (!s || typeof s !== 'object') continue;
    const url = String(s.url || '').trim();
    if (!url) continue;
    const type = (s.type === 'video') ? 'video' : 'image';
    const slide = { type, url };
    if (s.poster) slide.poster = String(s.poster);
    if (s.alt)    slide.alt    = String(s.alt).slice(0, 500);
    out.push(slide);
    if (out.length >= 20) break; // Instagram caps at 10; we allow 20 for staging headroom
  }
  return out;
}

async function ensureUniqueCarouselSlug(env, base, ignoreId) {
  let slug = (slugify(base || 'carousel') || 'carousel').slice(0, 100);
  let n = 0;
  while (true) {
    const candidate = n === 0 ? slug : `${slug}-${n}`;
    const row = await env.DB.prepare(`SELECT id FROM carousels WHERE slug = ?1 LIMIT 1`).bind(candidate).first();
    if (!row || (ignoreId && row.id === ignoreId)) return candidate;
    n++;
    if (n > 50) return `${slug}-${cryptoRandomId(4)}`;
  }
}

async function handleCarouselsList(req, env, origin, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureCarouselTable(env);
  const limit  = Math.min(Math.max(parseInt(url.searchParams.get('limit')  || '50', 10), 1), 200);
  const status = url.searchParams.get('status'); // optional filter
  const sql = status
    ? `SELECT * FROM carousels WHERE status = ?1 ORDER BY updated_at DESC LIMIT ?2`
    : `SELECT * FROM carousels ORDER BY updated_at DESC LIMIT ?1`;
  const stmt = status
    ? env.DB.prepare(sql).bind(status, limit)
    : env.DB.prepare(sql).bind(limit);
  const { results } = await stmt.all();
  return json({ items: (results || []).map(rowToCarousel), count: (results || []).length }, {}, env, origin);
}

async function handleCarouselsCreate(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureCarouselTable(env);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const id   = 'crsl-' + cryptoRandomId(12);
  const now  = Math.floor(Date.now() / 1000);
  const slug = await ensureUniqueCarouselSlug(env, body.slug || body.caption || ('carousel-' + cryptoRandomId(4)), null);
  const slides  = JSON.stringify(normalizeSlides(body.slides || []));
  const caption = (body.caption || '').toString().slice(0, 4000);
  const accountHandle = (body.account_handle || 'floridaoftomorrow').toString().replace(/^@/, '').slice(0, 64);
  const accountName   = (body.account_name   || 'FLORIDAOFTOMORROW').toString().slice(0, 80);
  const accountAvatar = body.account_avatar ? String(body.account_avatar) : null;
  try {
    await env.DB.prepare(
      `INSERT INTO carousels (id, slug, caption, account_handle, account_name, account_avatar, slides, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?8)`
    ).bind(id, slug, caption, accountHandle, accountName, accountAvatar, slides, now).run();
  } catch (e) {
    return json({ error: 'insert failed', detail: e.message || String(e) }, { status: 500 }, env, origin);
  }
  const row = await env.DB.prepare(`SELECT * FROM carousels WHERE id = ?1`).bind(id).first();
  return json({ ok: true, carousel: rowToCarousel(row) }, {}, env, origin);
}

async function handleCarouselsBySlug(req, env, origin, slug) {
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureCarouselTable(env);
  slug = fullyDecodeSlug(slug);
  const row = await env.DB.prepare(`SELECT * FROM carousels WHERE slug = ?1 LIMIT 1`).bind(slug).first();
  if (!row) return json({ error: 'carousel not found', slug }, { status: 404 }, env, origin);
  // Drafts visible to (a) admin OR (b) holder of a valid signed preview token.
  let previewOk = false;
  try {
    const pt = new URL(req.url).searchParams.get('preview') || '';
    if (pt) {
      const obj = await verifyPayload(pt, previewSecret(env));
      previewOk = !!(obj && obj.t === 'carousel' && obj.slug === slug);
    }
  } catch (_) {}
  if (!previewOk) {
    const denied = await requireAdminToken(req, env, origin);
    if (denied) return denied;
  }
  return json({ carousel: rowToCarousel(row) }, { headers: { 'Cache-Control': 'no-store' } }, env, origin);
}

async function handleCarouselsUpdate(req, env, origin, slug) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureCarouselTable(env);
  slug = fullyDecodeSlug(slug);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const existing = await env.DB.prepare(`SELECT * FROM carousels WHERE slug = ?1`).bind(slug).first();
  if (!existing) return json({ error: 'carousel not found', slug }, { status: 404 }, env, origin);

  const sets = [], params = []; let p = 1;
  if ('caption'        in body) { sets.push(`caption = ?${p++}`);        params.push(String(body.caption || '').slice(0, 4000)); }
  if ('account_handle' in body) { sets.push(`account_handle = ?${p++}`); params.push(String(body.account_handle || 'floridaoftomorrow').replace(/^@/, '').slice(0, 64)); }
  if ('account_name'   in body) { sets.push(`account_name   = ?${p++}`); params.push(String(body.account_name   || 'FLORIDAOFTOMORROW').slice(0, 80)); }
  if ('account_avatar' in body) { sets.push(`account_avatar = ?${p++}`); params.push(body.account_avatar ? String(body.account_avatar) : null); }
  if ('slides'         in body) { sets.push(`slides         = ?${p++}`); params.push(JSON.stringify(normalizeSlides(body.slides))); }
  if ('status'         in body) { sets.push(`status         = ?${p++}`); params.push(body.status === 'archived' ? 'archived' : 'draft'); }
  if ('slug'           in body && body.slug && body.slug !== existing.slug) {
    const newSlug = await ensureUniqueCarouselSlug(env, body.slug, existing.id);
    sets.push(`slug = ?${p++}`); params.push(newSlug);
  }
  if (!sets.length) return json({ ok: true, carousel: rowToCarousel(existing), note: 'no changes' }, {}, env, origin);
  sets.push(`updated_at = ?${p++}`); params.push(Math.floor(Date.now() / 1000));
  params.push(existing.id);
  await env.DB.prepare(`UPDATE carousels SET ${sets.join(', ')} WHERE id = ?${p}`).bind(...params).run();
  const updated = await env.DB.prepare(`SELECT * FROM carousels WHERE id = ?1`).bind(existing.id).first();
  return json({ ok: true, carousel: rowToCarousel(updated) }, {}, env, origin);
}

async function handleCarouselsDelete(req, env, origin, slug) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureCarouselTable(env);
  slug = fullyDecodeSlug(slug);
  const r = await env.DB.prepare(`DELETE FROM carousels WHERE slug = ?1`).bind(slug).run();
  return json({ ok: true, slug, deleted: r.meta && r.meta.changes ? r.meta.changes : 0 }, {}, env, origin);
}

// GET /carousel-preview-token?slug=<slug> (admin) → signed 60-day token used
// in the public share URL (/c/<slug>?preview=<token>). Same pattern as the
// article-draft /preview-token endpoint, just with t:'carousel' so the two
// token types aren't interchangeable.
async function handleCarouselPreviewToken(req, env, origin, url) {
  const slug = fullyDecodeSlug(url.searchParams.get('slug') || '');
  if (!slug) return json({ error: 'slug required' }, { status: 400 }, env, origin);
  const token = await signPayload(
    { slug, t: 'carousel', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60 },
    previewSecret(env),
  );
  const workerHost = new URL(req.url).origin;
  return json({
    token,
    url: `${workerHost}/c/${encodeURIComponent(slug)}?preview=${encodeURIComponent(token)}`,
  }, {}, env, origin);
}

// ─── Design docs (Studio "Design" editor) ──────────────────────────────────
// The editable SOURCE for branded carousel graphics: per-slide template +
// draggable text boxes + image placement. The rendered PNGs get pushed into the
// `carousels` table for client review. Self-bootstraps like the carousels table.
export async function ensureDesignsTable(env) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS designs (
      id          TEXT    PRIMARY KEY,
      slug        TEXT    NOT NULL UNIQUE,
      title       TEXT    NOT NULL DEFAULT 'Untitled design',
      doc_json    TEXT    NOT NULL DEFAULT '{}',
      status      TEXT    NOT NULL DEFAULT 'draft',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_designs_slug    ON designs(slug)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_designs_updated ON designs(updated_at DESC)`),
  ]);
}

function rowToDesign(r) {
  if (!r) return null;
  let doc = {};
  try { doc = JSON.parse(r.doc_json || '{}'); if (!doc || typeof doc !== 'object') doc = {}; } catch { doc = {}; }
  return {
    id: r.id,
    slug: r.slug,
    title: r.title || 'Untitled design',
    doc,
    status: r.status || 'draft',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function ensureUniqueDesignSlug(env, base, ignoreId) {
  let slug = (slugify(base || 'design') || 'design').slice(0, 100);
  let n = 0;
  while (true) {
    const candidate = n === 0 ? slug : `${slug}-${n}`;
    const row = await env.DB.prepare(`SELECT id FROM designs WHERE slug = ?1 LIMIT 1`).bind(candidate).first();
    if (!row || (ignoreId && row.id === ignoreId)) return candidate;
    n++;
    if (n > 50) return `${slug}-${cryptoRandomId(4)}`;
  }
}

async function handleDesignsList(req, env, origin, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureDesignsTable(env);
  const limit  = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 200);
  const status = url.searchParams.get('status');
  const stmt = status
    ? env.DB.prepare(`SELECT * FROM designs WHERE status = ?1 ORDER BY updated_at DESC LIMIT ?2`).bind(status, limit)
    : env.DB.prepare(`SELECT * FROM designs ORDER BY updated_at DESC LIMIT ?1`).bind(limit);
  const { results } = await stmt.all();
  return json({ items: (results || []).map(rowToDesign), count: (results || []).length }, {}, env, origin);
}

async function handleDesignsCreate(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureDesignsTable(env);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const id    = 'dsgn-' + cryptoRandomId(12);
  const now   = Math.floor(Date.now() / 1000);
  const title = (body.title || 'Untitled design').toString().slice(0, 200);
  const slug  = await ensureUniqueDesignSlug(env, body.slug || title || ('design-' + cryptoRandomId(4)), null);
  const doc   = JSON.stringify((body.doc && typeof body.doc === 'object') ? body.doc : {}).slice(0, 2_000_000);
  try {
    await env.DB.prepare(
      `INSERT INTO designs (id, slug, title, doc_json, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?5)`
    ).bind(id, slug, title, doc, now).run();
  } catch (e) {
    return json({ error: 'insert failed', detail: e.message || String(e) }, { status: 500 }, env, origin);
  }
  const row = await env.DB.prepare(`SELECT * FROM designs WHERE id = ?1`).bind(id).first();
  return json({ ok: true, design: rowToDesign(row) }, {}, env, origin);
}

async function handleDesignsBySlug(req, env, origin, slug) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureDesignsTable(env);
  slug = fullyDecodeSlug(slug);
  const row = await env.DB.prepare(`SELECT * FROM designs WHERE slug = ?1 LIMIT 1`).bind(slug).first();
  if (!row) return json({ error: 'design not found', slug }, { status: 404 }, env, origin);
  return json({ design: rowToDesign(row) }, { headers: { 'Cache-Control': 'no-store' } }, env, origin);
}

async function handleDesignsUpdate(req, env, origin, slug) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureDesignsTable(env);
  slug = fullyDecodeSlug(slug);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const existing = await env.DB.prepare(`SELECT * FROM designs WHERE slug = ?1`).bind(slug).first();
  if (!existing) return json({ error: 'design not found', slug }, { status: 404 }, env, origin);
  const sets = [], params = []; let p = 1;
  if ('title'  in body) { sets.push(`title    = ?${p++}`); params.push(String(body.title || 'Untitled design').slice(0, 200)); }
  if ('doc'    in body) { sets.push(`doc_json = ?${p++}`); params.push(JSON.stringify((body.doc && typeof body.doc === 'object') ? body.doc : {}).slice(0, 2_000_000)); }
  if ('status' in body) { sets.push(`status   = ?${p++}`); params.push(body.status === 'archived' ? 'archived' : 'draft'); }
  if ('slug'   in body && body.slug && body.slug !== existing.slug) {
    const newSlug = await ensureUniqueDesignSlug(env, body.slug, existing.id);
    sets.push(`slug = ?${p++}`); params.push(newSlug);
  }
  if (!sets.length) return json({ ok: true, design: rowToDesign(existing), note: 'no changes' }, {}, env, origin);
  sets.push(`updated_at = ?${p++}`); params.push(Math.floor(Date.now() / 1000));
  params.push(existing.id);
  await env.DB.prepare(`UPDATE designs SET ${sets.join(', ')} WHERE id = ?${p}`).bind(...params).run();
  const updated = await env.DB.prepare(`SELECT * FROM designs WHERE id = ?1`).bind(existing.id).first();
  return json({ ok: true, design: rowToDesign(updated) }, {}, env, origin);
}

async function handleDesignsDelete(req, env, origin, slug) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureDesignsTable(env);
  slug = fullyDecodeSlug(slug);
  const r = await env.DB.prepare(`DELETE FROM designs WHERE slug = ?1`).bind(slug).run();
  return json({ ok: true, slug, deleted: r.meta && r.meta.changes ? r.meta.changes : 0 }, {}, env, origin);
}

// GET /img?u=<url> — same-origin image proxy with permissive CORS, so the
// Design editor can rasterize R2 photos to PNG via html-to-image without canvas
// tainting (pub-*.r2.dev doesn't send Access-Control-Allow-Origin). Restricted
// to our own image hosts so it can't be used as an open proxy.
async function handleImageProxy(req, env, origin, url) {
  const target = url.searchParams.get('u') || '';
  let u;
  try { u = new URL(target); } catch { return json({ error: 'bad url' }, { status: 400 }, env, origin); }
  const host = u.hostname.toLowerCase();
  const ok = /\.r2\.dev$/.test(host) || /(^|\.)oftmw\.com$/.test(host) || /(^|\.)workers\.dev$/.test(host) || /(^|\.)r2\.cloudflarestorage\.com$/.test(host);
  if (u.protocol !== 'https:' || !ok) return json({ error: 'host not allowed' }, { status: 403 }, env, origin);
  let upstream;
  try { upstream = await fetch(u.toString(), { cf: { cacheTtl: 3600, cacheEverything: true } }); }
  catch (e) { return json({ error: 'fetch failed', detail: String(e) }, { status: 502 }, env, origin); }
  if (!upstream.ok) return json({ error: 'upstream ' + upstream.status }, { status: upstream.status }, env, origin);
  const ct = upstream.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//i.test(ct)) return json({ error: 'not an image' }, { status: 415 }, env, origin);
  return new Response(upstream.body, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

// GET /c/<slug>?preview=<token> — public Instagram-style preview page.
// Self-contained HTML+CSS+JS so a deploy needs no extra static assets.
async function handleCarouselPublic(req, env, slug) {
  if (!env.DB) return new Response('not configured', { status: 500 });
  await ensureCarouselTable(env);
  slug = fullyDecodeSlug(slug);
  const row = await env.DB.prepare(`SELECT * FROM carousels WHERE slug = ?1`).bind(slug).first();
  if (!row) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  // Same gate as the JSON endpoint: admin OR valid preview token.
  let previewOk = false;
  try {
    const pt = new URL(req.url).searchParams.get('preview') || '';
    if (pt) {
      const obj = await verifyPayload(pt, previewSecret(env));
      previewOk = !!(obj && obj.t === 'carousel' && obj.slug === slug);
    }
  } catch (_) {}
  if (!previewOk) {
    // Admins viewing without a token should be allowed too (so the Studio
    // editor's "Open preview" button works without minting a token first).
    const admin = await requireAdminToken(req, env, '');
    if (admin) {
      return new Response(
        'This carousel preview link is private. Re-open it from the Studio "Copy client link" button.',
        { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }
  }
  const c = rowToCarousel(row);
  return new Response(renderCarouselHtml(c), {
    status: 200,
    headers: {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // noindex/nofollow — these are private client previews, not public posts.
      'X-Robots-Tag':  'noindex, nofollow, noarchive',
    },
  });
}

function renderCarouselHtml(c) {
  const escHtml = (s) => String(s || '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
  const slides = c.slides || [];
  const handle = c.account_handle || 'floridaoftomorrow';
  const name   = c.account_name   || handle.toUpperCase();
  const avatar = c.account_avatar || '';
  const caption = c.caption || '';
  // Build slide HTML — each slide is a square (1:1) tile.
  const slideHtml = slides.map((s, i) => {
    if (s.type === 'video') {
      const poster = s.poster ? ` poster="${escHtml(s.poster)}"` : '';
      return `<div class="slide" data-i="${i}"><video src="${escHtml(s.url)}"${poster} muted playsinline loop ${i===0?'autoplay':''}></video></div>`;
    }
    return `<div class="slide" data-i="${i}"><img src="${escHtml(s.url)}" alt="${escHtml(s.alt || '')}" loading="${i===0?'eager':'lazy'}"></div>`;
  }).join('');
  const dots = slides.length > 1
    ? `<div class="dots">${slides.map((_, i) => `<span class="dot${i===0?' on':''}" data-i="${i}"></span>`).join('')}</div>`
    : '';
  const avatarHtml = avatar
    ? `<img class="avatar" src="${escHtml(avatar)}" alt="">`
    : `<div class="avatar avatar-fallback">${escHtml((handle[0] || 'F').toUpperCase())}</div>`;
  // Render the full caption verbatim — newlines become <br>.
  const captionEscaped = escHtml(caption).replace(/\n/g, '<br>');
  // Profile chrome: handle links out to the real Instagram profile, and the
  // top-right glyph is the Instagram logo (was three "more" dots).
  const igProfileUrl = `https://instagram.com/${encodeURIComponent(handle)}`;
  // The page is intentionally minimal — just the post card, centered on a
  // dark backdrop so the carousel itself reads exactly like an Instagram post.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" type="image/png" href="https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png">
<link rel="apple-touch-icon" href="https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png">
<title>${escHtml(name)} — carousel preview</title>
<style>
  :root { --fg:#fff; --mute:rgba(255,255,255,.62); --line:rgba(255,255,255,.10); --bg:#0b0e0c; --card:#000; --accent:#A78BFA; }
  *,*::before,*::after { box-sizing:border-box }
  html,body { margin:0; padding:0; background:var(--bg); color:var(--fg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
    -webkit-font-smoothing:antialiased; min-height:100vh }
  .wrap { display:flex; flex-direction:column; align-items:center; padding:40px 16px 80px; gap:24px }
  .tmw-badge { font-size:11px; font-weight:600; letter-spacing:.18em; color:var(--mute); text-transform:uppercase }
  .tmw-badge b { color:var(--fg) }
  .card { width:100%; max-width:470px; background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden; }
  /* Header */
  .head { display:flex; align-items:center; gap:11px; padding:12px 14px; }
  .avatar { width:36px; height:36px; border-radius:50%; flex:0 0 auto; object-fit:cover;
    background:linear-gradient(135deg,#fbbf24 0%,#ec4899 35%,#a855f7 65%,#3b82f6 100%); padding:2px; }
  .avatar.avatar-fallback { display:flex; align-items:center; justify-content:center;
    font-weight:700; font-size:14px; color:#fff; padding:0 }
  .head-meta { flex:1; min-width:0; display:flex; align-items:center; line-height:1.2 }
  .head-name { font-weight:700; font-size:14px; letter-spacing:.02em; color:var(--fg); text-decoration:none }
  .head-name:hover { text-decoration:underline }
  /* Top-right Instagram glyph — links to the real profile at instagram.com/<handle>. */
  .ig-link { color:var(--fg); padding:6px; line-height:0; opacity:.95; display:flex; transition:opacity .15s }
  .ig-link:hover { opacity:1 }
  .ig-link svg { width:22px; height:22px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  /* Carousel — 4:5 portrait (Instagram's tallest supported ratio) so 1500x1883
     source images fill the frame without cropping. Square images get a small
     vertical crop, same as Instagram does.

     Layout: track stays at 100% of the carousel. Each slide is flex-basis
     100% with no shrink, so they line up at 0%, 100%, 200% … and overflow
     horizontally; the carousel's overflow:hidden clips the ones off-screen.
     Advancing is translateX(-i * 100%) on the track. (Earlier we made the
     track n*100% wide and slides flex 100% — that made each slide n* the
     carousel width and the carousel just showed slivers of the first image.) */
  .carousel { position:relative; aspect-ratio:4/5; background:#000; overflow:hidden; }
  .track { display:flex; height:100%; width:100%; transition:transform .35s cubic-bezier(.4,.2,.2,1); will-change:transform; }
  .slide { flex:0 0 100%; min-width:100%; width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#000 }
  .slide img, .slide video { width:100%; height:100%; object-fit:cover; display:block; }
  .arrow { position:absolute; top:50%; transform:translateY(-50%); width:30px; height:30px; border-radius:50%;
    background:rgba(0,0,0,.55); border:none; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center;
    backdrop-filter:blur(8px); transition:opacity .15s, background .15s; z-index:3; }
  .arrow:hover { background:rgba(0,0,0,.75) }
  .arrow.left  { left:10px }
  .arrow.right { right:10px }
  .arrow:disabled { opacity:0; pointer-events:none }
  .arrow svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; }
  .count { position:absolute; top:12px; right:12px; padding:4px 9px; border-radius:999px;
    background:rgba(0,0,0,.55); color:#fff; font-size:12px; font-weight:600; backdrop-filter:blur(8px); z-index:3; }
  /* Dots */
  .dots { display:flex; justify-content:center; gap:4px; padding:9px 0 4px; }
  .dot { width:6px; height:6px; border-radius:50%; background:rgba(255,255,255,.32); transition:background .2s, transform .2s }
  .dot.on { background:var(--accent); transform:scale(1.15) }
  /* Action row */
  .actions { display:flex; align-items:center; gap:14px; padding:6px 14px 4px; }
  .actions .icon { color:var(--fg); padding:4px 0; line-height:0 }
  .actions .icon svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .actions .spacer { flex:1 }
  /* Caption -- full text, no truncation. */
  .body { padding:4px 14px 16px; font-size:13.5px; line-height:1.45; color:var(--fg); white-space:normal; word-wrap:break-word; }
  .body .h { font-weight:700; margin-right:6px; color:var(--fg); text-decoration:none }
  .body .h:hover { text-decoration:underline }
  /* Empty state */
  .empty { display:flex; align-items:center; justify-content:center; color:var(--mute); font-size:13px; padding:40px 16px; text-align:center }
  @media (max-width:520px) { .wrap { padding:18px 12px 60px } .card { border-radius:10px } }
</style>
</head>
<body>
<div class="wrap">
  <div class="tmw-badge">A <b>MARKETS OF TOMORROW</b> CAROUSEL PREVIEW</div>
  <div class="card">
    <div class="head">
      <a href="${escHtml(igProfileUrl)}" target="_blank" rel="noopener" aria-label="Open ${escHtml(handle)} on Instagram" style="display:flex; text-decoration:none">${avatarHtml}</a>
      <div class="head-meta">
        <a class="head-name" href="${escHtml(igProfileUrl)}" target="_blank" rel="noopener">${escHtml(handle)}</a>
      </div>
      <a class="ig-link" href="${escHtml(igProfileUrl)}" target="_blank" rel="noopener" aria-label="Open ${escHtml(handle)} on Instagram">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>
      </a>
    </div>
    <div class="carousel">
      ${slides.length === 0 ? '<div class="empty">No slides yet — add media in the Studio editor.</div>' : ''}
      ${slides.length > 0 ? `<div class="track">${slideHtml}</div>` : ''}
      ${slides.length > 1 ? `<div class="count"><span id="count-now">1</span>/${slides.length}</div>` : ''}
      ${slides.length > 1 ? '<button class="arrow left"  type="button" aria-label="Previous" disabled><svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg></button>' : ''}
      ${slides.length > 1 ? '<button class="arrow right" type="button" aria-label="Next"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></button>' : ''}
    </div>
    ${dots}
    <div class="actions">
      <span class="icon" aria-label="Like"><svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></span>
      <span class="icon" aria-label="Comment"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>
      <span class="icon" aria-label="Share"><svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></span>
      <span class="spacer"></span>
      <span class="icon" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></span>
    </div>
    ${caption ? `<div class="body"><a class="h" href="${escHtml(igProfileUrl)}" target="_blank" rel="noopener">${escHtml(handle)}</a>${captionEscaped}</div>` : ''}
  </div>
</div>
<script>
(function(){
  var track = document.querySelector('.track');
  var slides = track ? track.querySelectorAll('.slide') : [];
  var n = slides.length;
  var i = 0;
  var dotsEls = document.querySelectorAll('.dot');
  var countNow = document.getElementById('count-now');
  var left  = document.querySelector('.arrow.left');
  var right = document.querySelector('.arrow.right');
  function go(k){
    i = Math.max(0, Math.min(n-1, k));
    // Track is one carousel-width wide; each slide is the same width and
    // overflows to the right. Advance by full carousel-widths -> translate
    // the track by -i*100%. (Matches the slide layout in the CSS comment.)
    if (track) track.style.transform = 'translateX(' + (-i * 100) + '%)';
    dotsEls.forEach(function(d, j){ d.classList.toggle('on', j===i); });
    if (countNow) countNow.textContent = String(i+1);
    if (left)  left.disabled  = (i === 0);
    if (right) right.disabled = (i === n-1);
    // Pause non-active videos to save bandwidth.
    slides.forEach(function(s, j){
      var v = s.querySelector('video'); if (!v) return;
      if (j === i) { try { v.play(); } catch(_){} } else { try { v.pause(); } catch(_){} }
    });
  }
  if (left)  left.addEventListener('click', function(){ go(i-1); });
  if (right) right.addEventListener('click', function(){ go(i+1); });
  dotsEls.forEach(function(d){ d.addEventListener('click', function(){ go(parseInt(d.dataset.i,10)||0); }); });
  // Keyboard nav (arrow keys).
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowLeft')  go(i-1);
    if (e.key === 'ArrowRight') go(i+1);
  });
  // Touch swipe.
  var x0 = null;
  var car = document.querySelector('.carousel');
  if (car) {
    car.addEventListener('touchstart', function(e){ x0 = e.touches[0].clientX; }, {passive:true});
    car.addEventListener('touchend',   function(e){
      if (x0 == null) return;
      var dx = (e.changedTouches[0].clientX - x0);
      if (Math.abs(dx) > 30) go(i + (dx < 0 ? 1 : -1));
      x0 = null;
    }, {passive:true});
  }
  // (Full caption is rendered verbatim — no truncation/more-toggle.)
  // The empty no-op block below is kept so the surrounding script structure
  // stays unchanged; remove on next refactor.
  {
  }
})();
</script>
</body>
</html>`;
}

// --- helpers for posts CRUD ---

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200) || ('post-' + cryptoRandomId(6));
}

async function ensureUniqueSlug(env, base, excludingId) {
  let candidate = base;
  let suffix = 2;
  while (true) {
    const hit = await env.DB.prepare(`SELECT id FROM posts WHERE slug = ?1 AND (?2 IS NULL OR id != ?2) LIMIT 1`).bind(candidate, excludingId).first();
    if (!hit) return candidate;
    candidate = `${base}-${suffix++}`;
    if (suffix > 50) return `${base}-${cryptoRandomId(4)}`;
  }
}

function cryptoRandomId(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

function jsonArrayOrEmpty(v) { return JSON.stringify(asStringArray(v)); }
function asStringArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function normalizePost(r) {
  // Ensures the JSON-text columns are strings and required fields have defaults
  r.categories = typeof r.categories === 'string' ? r.categories : JSON.stringify(r.categories || []);
  r.tags       = typeof r.tags       === 'string' ? r.tags       : JSON.stringify(r.tags       || []);
  return r;
}

// ---------------------------------------------------------------------------
// /admin/migrate-images — pull a batch of posts, find every external image
// URL in body_html + cover_image, fetch each one, upload to R2, rewrite all
// references. Skips URLs already in media_map so we never upload the same
// Wix image twice across the archive.
//
// Request:
//   POST /admin/migrate-images?limit=10&offset=0
//   Authorization: Bearer <ADMIN_TOKEN>
//
// Response:
//   { batch: {postsProcessed, imagesUploaded, imagesReused, rewritesApplied, errors[]},
//     offset, nextOffset, total, done }
// ---------------------------------------------------------------------------

async function handleMigrateImages(req, env, origin, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.MEDIA) return json({ error: 'R2 not configured' }, { status: 500 }, env, origin);
  if (!env.DB)    return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  if (!env.MEDIA_PUBLIC_BASE) return json({ error: 'MEDIA_PUBLIC_BASE not set' }, { status: 500 }, env, origin);

  // Process fewer posts per batch since each one might do multiple R2 uploads.
  const limit  = clampInt(url.searchParams.get('limit'), 10, 1, 30);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) c FROM posts`).first();
  const total    = totalRow ? totalRow.c : 0;

  const posts = await env.DB.prepare(`
    SELECT id, slug, body_html, cover_image FROM posts
    ORDER BY id LIMIT ${limit} OFFSET ${offset}
  `).all();

  const stats = { postsProcessed: 0, imagesUploaded: 0, imagesReused: 0, rewritesApplied: 0, errors: [] };
  const publicBase = env.MEDIA_PUBLIC_BASE.replace(/\/+$/, '');

  for (const p of (posts.results || [])) {
    try {
      const urlsInPost = collectExternalImageUrls(p.body_html || '', p.cover_image || '');
      if (!urlsInPost.size) { stats.postsProcessed++; continue; }

      // For each unique URL in this post, look up or create an R2 copy
      const urlMap = new Map(); // sourceUrl -> r2Url
      for (const srcUrl of urlsInPost) {
        // Check if we've already migrated it
        const existing = await env.DB.prepare(`SELECT r2_url FROM media_map WHERE source_url = ?1`).bind(srcUrl).first();
        if (existing && existing.r2_url) {
          urlMap.set(srcUrl, existing.r2_url);
          stats.imagesReused++;
          continue;
        }
        // Fetch from Wix CDN
        let res;
        try { res = await fetch(srcUrl, { cf: { cacheTtl: 86400 } }); }
        catch (e) { stats.errors.push({ post: p.slug, url: srcUrl, error: 'fetch ' + (e.message || '') }); continue; }
        if (!res.ok) { stats.errors.push({ post: p.slug, url: srcUrl, error: 'fetch ' + res.status }); continue; }
        const buf = await res.arrayBuffer();
        const mimeType = res.headers.get('content-type') || guessMimeFromName(srcUrl) || 'image/jpeg';
        if (buf.byteLength > 25 * 1024 * 1024) {
          stats.errors.push({ post: p.slug, url: srcUrl, error: 'too large ' + buf.byteLength }); continue;
        }
        // Derive a clean key from the original URL (preserve the Wix media id)
        const key = deriveKeyFromWixUrl(srcUrl, mimeType);
        try {
          await env.MEDIA.put(key, buf, {
            httpMetadata: { contentType: mimeType, cacheControl: 'public, max-age=31536000, immutable' },
            customMetadata: { source: srcUrl, migrated_at: String(Date.now()) },
          });
        } catch (e) {
          stats.errors.push({ post: p.slug, url: srcUrl, error: 'R2 put ' + (e.message || '') }); continue;
        }
        const newUrl = publicBase + '/' + key;
        // Record in media_map for future posts
        try {
          await env.DB.prepare(`
            INSERT INTO media_map (source_url, r2_url, r2_key, size_bytes, mime_type, migrated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(source_url) DO UPDATE SET r2_url=excluded.r2_url, r2_key=excluded.r2_key, migrated_at=excluded.migrated_at
          `).bind(srcUrl, newUrl, key, buf.byteLength, mimeType, Math.floor(Date.now()/1000)).run();
        } catch (e) { /* non-fatal; URL still in urlMap */ }
        // Also register in the regular media table so it shows up in the library
        try {
          await env.DB.prepare(`
            INSERT INTO media (key, filename, mime_type, size_bytes, uploaded_by, uploaded_at, url)
            VALUES (?1, ?2, ?3, ?4, 'wix-migration', ?5, ?6)
            ON CONFLICT(key) DO NOTHING
          `).bind(key, key.split('/').pop(), mimeType, buf.byteLength, Math.floor(Date.now()/1000), newUrl).run();
        } catch {}
        urlMap.set(srcUrl, newUrl);
        stats.imagesUploaded++;
      }

      // Now rewrite body_html + cover_image with the new URLs
      let newBody  = p.body_html || '';
      let newCover = p.cover_image || '';
      let rewrites = 0;
      for (const [src, r2] of urlMap.entries()) {
        if (src === r2) continue;
        const before = newBody;
        newBody = newBody.split(src).join(r2);
        if (newBody !== before) rewrites += (before.match(new RegExp(escapeRegex(src), 'g')) || []).length;
        if (newCover === src) { newCover = r2; rewrites++; }
      }
      if (rewrites > 0) {
        await env.DB.prepare(`UPDATE posts SET body_html = ?1, cover_image = ?2, updated_at = ?3 WHERE id = ?4`)
          .bind(newBody, newCover, Math.floor(Date.now() / 1000), p.id).run();
        stats.rewritesApplied += rewrites;
      }
      stats.postsProcessed++;
    } catch (e) {
      stats.errors.push({ post: p.slug, error: e.message || String(e) });
    }
  }

  const nextOffset = offset + (posts.results || []).length;
  return json({ batch: stats, offset, nextOffset, total, done: nextOffset >= total }, {}, env, origin);
}

// Find every external image URL in a post's body + cover.
function collectExternalImageUrls(bodyHtml, coverUrl) {
  const set = new Set();
  if (coverUrl && /^https?:\/\/(static|video)\.wixstatic\.com\//i.test(coverUrl)) set.add(coverUrl);
  // Match <img src="..."> tags inside body_html
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(bodyHtml || '')) !== null) {
    const u = m[1];
    if (/^https?:\/\/(static|video)\.wixstatic\.com\//i.test(u)) set.add(u);
  }
  return set;
}

// Build a stable R2 key from a Wix URL. Preserve the Wix media id so we can
// reverse-lookup later if needed; suffix with proper extension.
function deriveKeyFromWixUrl(srcUrl, mimeType) {
  const idMatch = srcUrl.match(/static\.wixstatic\.com\/media\/([^/?#]+)/i);
  const wixId = idMatch ? idMatch[1] : ('legacy-' + cryptoRandomId(8));
  // Wix IDs like "ca3b83_abc~mv2.jpeg" already contain the extension; use it.
  // If not, derive from mime.
  const hasExt = /\.[a-z]{2,5}$/i.test(wixId);
  const ext = hasExt ? '' : ('.' + (({
    'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif','image/gif':'gif',
    'video/mp4':'mp4','video/webm':'webm',
  })[mimeType] || 'bin'));
  return 'wix-migrate/' + wixId + ext;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// /admin/migrate-wix-media — pull the ENTIRE Wix Media Manager into the studio.
//
// Driven by a client loop that follows the returned `nextCursor` until done.
// Two modes:
//   mode=index → register every file in the `media` table pointing at its
//                existing public static.wixstatic.com URL. No byte copy, so it
//                is fast and makes the studio fully browsable immediately.
//   mode=copy  → fetch each file's bytes from the public Wix CDN, store them in
//                R2, and repoint the media row at the worker-served /media/<key>
//                URL so we own the asset (independent of Wix).
//
// Enumeration uses the Wix Media Manager List Files API with folder recursion
// (permission MEDIA.SITE_MEDIA_FILES_LIST, granted by the "Media Manager – Read"
// API-key role) — NOT Query File Descriptors, whose permission the API-Keys UI
// doesn't surface.
//
//   GET  /admin/migrate-wix-media?count=1                       -> { total }
//   POST /admin/migrate-wix-media?mode=index&limit=200&cursor=
//   POST /admin/migrate-wix-media?mode=copy&limit=30&cursor=
//   -> { mode, processed, indexed, copied, skipped, errors[], nextCursor, done, total }
// ---------------------------------------------------------------------------

async function queryWixFiles(env, cursor, limit) {
  const body = { query: { cursorPaging: cursor ? { limit, cursor } : { limit } } };
  const res = await fetch('https://www.wixapis.com/site-media/v1/files/query', {
    method: 'POST',
    headers: {
      'Authorization': env.WIX_API_KEY,
      'wix-site-id':   env.WIX_SITE_ID,
      'Content-Type':  'application/json',
      ...(env.WIX_ACCOUNT_ID ? { 'wix-account-id': env.WIX_ACCOUNT_ID } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error('Wix query ' + res.status + ' ' + (res.statusText || '') + ': ' + (txt || '(empty body)').slice(0, 400));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// We enumerate via the List Files API (permission MEDIA.SITE_MEDIA_FILES_LIST,
// which the standard "Media Manager – Read" API-key role grants) instead of
// Query File Descriptors (whose permission the API-Keys UI doesn't expose).
// List Files is folder-scoped, so we recurse: list folders once, then page
// through each folder. Folder position + per-folder cursor are carried in an
// opaque base64 cursor between batches.
function wixHeaders(env) {
  return {
    'Authorization': env.WIX_API_KEY,
    'wix-site-id':   env.WIX_SITE_ID,
    ...(env.WIX_ACCOUNT_ID ? { 'wix-account-id': env.WIX_ACCOUNT_ID } : {}),
  };
}

async function wixListAllFolderIds(env) {
  const ids = [];
  let cursor = null, guard = 0;
  do {
    const u = 'https://www.wixapis.com/site-media/v1/folders?paging.limit=100'
      + (cursor ? '&paging.cursor=' + encodeURIComponent(cursor) : '');
    const res = await fetch(u, { headers: wixHeaders(env) });
    if (!res.ok) {
      const t = await res.text();
      const e = new Error('Wix folders ' + res.status + ' ' + (res.statusText || '') + ': ' + (t || '(empty)').slice(0, 300));
      e.status = res.status; throw e;
    }
    const d = await res.json();
    for (const f of (d.folders || [])) if (f.id) ids.push(f.id);
    const nc = d.nextCursor;            // { cursors: { next }, hasNext } — NOT a string
    cursor = (nc && nc.hasNext && nc.cursors && nc.cursors.next) ? nc.cursors.next : null;
    guard++;
  } while (cursor && guard < 25);
  return ids;
}

async function wixListFilesPage(env, parentFolderId, fileCursor, limit) {
  const u = 'https://www.wixapis.com/site-media/v1/files?paging.limit=' + (limit || 100)
    + '&parentFolderId=' + encodeURIComponent(parentFolderId)
    + (fileCursor ? '&paging.cursor=' + encodeURIComponent(fileCursor) : '');
  const res = await fetch(u, { headers: wixHeaders(env) });
  if (!res.ok) {
    const t = await res.text();
    const e = new Error('Wix files ' + res.status + ' ' + (res.statusText || '') + ': ' + (t || '(empty)').slice(0, 300));
    e.status = res.status; throw e;
  }
  const d = await res.json();
  const nc = d.nextCursor;              // { cursors: { next }, hasNext } — NOT a string
  const next = (nc && nc.hasNext && nc.cursors && nc.cursors.next) ? nc.cursors.next : null;
  return { files: d.files || [], next };
}

// One page of a folder's direct subfolders (for recursive tree crawl).
async function wixListSubfoldersPage(env, parentFolderId, cursor) {
  const u = 'https://www.wixapis.com/site-media/v1/folders?paging.limit=100'
    + '&parentFolderId=' + encodeURIComponent(parentFolderId)
    + (cursor ? '&paging.cursor=' + encodeURIComponent(cursor) : '');
  const res = await fetch(u, { headers: wixHeaders(env) });
  if (!res.ok) {
    const t = await res.text();
    const e = new Error('Wix subfolders ' + res.status + ' ' + (res.statusText || '') + ': ' + (t || '(empty)').slice(0, 300));
    e.status = res.status; throw e;
  }
  const d = await res.json();
  const nc = d.nextCursor;
  const next = (nc && nc.hasNext && nc.cursors && nc.cursors.next) ? nc.cursors.next : null;
  return { folders: d.folders || [], next };
}

function encState(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))); }
function decState(s) { try { return JSON.parse(decodeURIComponent(escape(atob(s)))); } catch { return null; } }

function mediaTypeToMime(t) {
  return ({ IMAGE: 'image/jpeg', VIDEO: 'video/mp4', VECTOR: 'image/svg+xml', DOCUMENT: 'application/pdf' })[t] || null;
}

// Stable R2 key from a Wix media URL — preserve the Wix media id so a later
// copy pass overwrites the same key the index pass registered.
function deriveKeyFromWixMediaUrl(srcUrl, displayName, mimeType) {
  let m = srcUrl.match(/static\.wixstatic\.com\/media\/([^/?#]+)/i);
  if (m) return 'wix/' + m[1];
  m = srcUrl.match(/video\.wixstatic\.com\/video\/([^/?#]+)/i);
  if (m) {
    const id = m[1].replace(/\/.*$/, '');
    const ext = (mimeType || '').includes('webm') ? '.webm' : '.mp4';
    return 'wix/video/' + id + ext;
  }
  const safe = (displayName || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'file';
  return 'wix/other/' + cryptoRandomId(6) + '-' + safe;
}

// ── Reusable migration steps (shared by the HTTP handler and the cron driver).
// Both are bounded + idempotent so they're safe to call repeatedly and resume
// after any interruption. ────────────────────────────────────────────────────

// Copy ONE bounded batch of still-on-Wix media rows into R2 and repoint the
// rows at /media/<key>. A copied row's url no longer matches the filter, so
// successive calls naturally continue where the last left off (zero Wix calls,
// no cursor needed). Returns { processed, copied, errors, remaining }.
async function migrateCopyBatch(env, limit, publicBase, ts) {
  const stats = { processed: 0, copied: 0, errors: [] };
  const rows = await env.DB.prepare(
    "SELECT key, url FROM media WHERE url LIKE '%wixstatic.com/%' LIMIT ?1"
  ).bind(limit).all();
  const list = rows.results || [];

  // Fetch the Wix bytes → R2 for one row, then RETURN the DB statements (don't
  // await them here). The whole wave's writes are flushed in a single DB.batch()
  // below — one D1 round-trip per wave instead of two per file, which is the
  // real throughput lever (the fetch+put are I/O the wave already overlaps).
  const copyOne = async (r) => {
    stats.processed++;
    try {
      const res = await fetch(r.url, { cf: { cacheTtl: 86400 } });
      if (!res.ok || !res.body) { stats.errors.push({ file: r.key, error: 'fetch ' + res.status }); return null; }
      const ct = res.headers.get('content-type') || guessMimeFromName(r.key) || 'application/octet-stream';
      const clen = parseInt(res.headers.get('content-length') || '0', 10) || null;
      // STREAM the response body straight into R2 — never buffer the whole file.
      // Critical: the media set runs up to ~5MB+ per image; buffering with
      // arrayBuffer() across the wave's concurrency blew the Worker's 128MB cap
      // and OOM-killed the entire tick (no commit, lock left dangling). Streaming
      // keeps memory flat regardless of file size.
      await env.MEDIA.put(r.key, res.body, {
        httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: { source: r.url, migrated_at: String(Date.now()) },
      });
      // Repoint the media row at its R2 URL. Return the statement (don't await)
      // so the whole wave flushes in one DB.batch(). NOTE: we deliberately do
      // NOT write media_map here — that table isn't present in this D1, and the
      // source→R2 mapping is fully recoverable from media (key encodes the Wix
      // id; R2 customMetadata.source holds the original URL).
      return env.DB.prepare("UPDATE media SET url=?1, mime_type=?2, size_bytes=?3, uploaded_by='wix-migrate' WHERE key=?4")
        .bind(publicBase + '/' + r.key, ct, clen, r.key);
    } catch (e) { stats.errors.push({ file: r.key, error: (e.message || String(e)).slice(0, 160) }); return null; }
  };

  // Process the batch in bounded-concurrency waves, flushing each wave's DB
  // writes in ONE batch. Concurrency is kept modest because each in-flight item
  // streams a (possibly multi-MB) file — too many at once risks memory pressure.
  const CONC = 6;
  for (let i = 0; i < list.length; i += CONC) {
    const results = await Promise.all(list.slice(i, i + CONC).map(copyOne));
    const writes = results.filter(Boolean);
    if (writes.length) {
      try { await env.DB.batch(writes); stats.copied += writes.length; }
      catch (e) { stats.errors.push({ file: 'batch', error: (e.message || String(e)).slice(0, 160) }); }
    }
  }
  const remRow = await env.DB.prepare("SELECT COUNT(*) c FROM media WHERE url LIKE '%wixstatic.com/%'").first();
  stats.remaining = remRow ? remRow.c : 0;
  return stats;
}

// Crawl ONE pending Wix folder: enqueue its subfolders and index its files at
// their static.wixstatic.com URLs. Tiny cursors live in the wix_crawl queue so
// this is fully resumable. seedIfEmpty inserts the media-root row when the queue
// is empty (HTTP fresh-run passes true; the cron passes false so it never
// restarts a finished crawl). Returns { processed, indexed, skipped,
// foldersRemaining, didWork }.
async function migrateIndexFolder(env, ts, limit, seedIfEmpty) {
  const stats = { processed: 0, indexed: 0, skipped: 0 };
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wix_crawl (
    folder_id TEXT PRIMARY KEY, subs_done INTEGER DEFAULT 0, sub_cursor TEXT,
    files_done INTEGER DEFAULT 0, file_cursor TEXT, path TEXT )`).run();
  if (seedIfEmpty) {
    const any = await env.DB.prepare('SELECT 1 FROM wix_crawl LIMIT 1').first();
    if (!any) await env.DB.prepare("INSERT INTO wix_crawl (folder_id, path) VALUES ('media-root', '')").run();
  }
  const inserts = [];
  const F = await env.DB.prepare(
    'SELECT folder_id, subs_done, sub_cursor, files_done, file_cursor, path FROM wix_crawl WHERE subs_done=0 OR files_done=0 ORDER BY rowid LIMIT 1'
  ).first();
  if (F) {
    let subCursor = F.sub_cursor || null, subsDone = F.subs_done;
    let fileCursor = F.file_cursor || null, filesDone = F.files_done;
    let wixCalls = 0;
    // 1) enqueue this folder's subfolders (bounded)
    while (!subsDone && wixCalls < 10) {
      const sent = subCursor;
      const page = await wixListSubfoldersPage(env, F.folder_id, sent); wixCalls++;
      for (const sf of page.folders) {
        if (sf.id) {
          const childPath = ((F.path || '').trim() ? (F.path + ' / ') : '') + (sf.displayName || sf.id);
          inserts.push(env.DB.prepare('INSERT OR IGNORE INTO wix_crawl (folder_id, path) VALUES (?1, ?2)').bind(sf.id, childPath));
        }
      }
      subCursor = page.next;
      if (!subCursor || subCursor === sent) subsDone = 1;
    }
    // 2) index this folder's files (bounded)
    while (!filesDone && wixCalls < 26 && stats.indexed < 300) {
      const sent = fileCursor;
      const page = await wixListFilesPage(env, F.folder_id, sent, limit); wixCalls++;
      for (const f of page.files) {
        stats.processed++;
        const src = f.url || '';
        if (!src || !/^https?:\/\//i.test(src)) { stats.skipped++; continue; }
        const mimeType = guessMimeFromName(f.displayName || '') || mediaTypeToMime(f.mediaType) || 'application/octet-stream';
        const key = deriveKeyFromWixMediaUrl(src, f.displayName, mimeType);
        const sizeBytes = Number(f.sizeInBytes || 0) || null;
        const folder = (F.path || '').trim() ? F.path : 'Media Root';
        inserts.push(env.DB.prepare(`INSERT INTO media (key, filename, mime_type, size_bytes, uploaded_by, uploaded_at, url, folder)
          VALUES (?1,?2,?3,?4,'wix-index',?5,?6,?7)
          ON CONFLICT(key) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type, size_bytes=excluded.size_bytes, folder=excluded.folder`)
          .bind(key, f.displayName || key.split('/').pop(), mimeType, sizeBytes, ts, src, folder));
        stats.indexed++;
      }
      fileCursor = page.next;
      if (!fileCursor || fileCursor === sent) filesDone = 1;
    }
    // 3) persist folder progress (delete when fully done so COUNT == remaining)
    if (subsDone && filesDone) {
      inserts.push(env.DB.prepare('DELETE FROM wix_crawl WHERE folder_id=?1').bind(F.folder_id));
    } else {
      inserts.push(env.DB.prepare('UPDATE wix_crawl SET subs_done=?1, sub_cursor=?2, files_done=?3, file_cursor=?4 WHERE folder_id=?5')
        .bind(subsDone ? 1 : 0, subCursor, filesDone ? 1 : 0, fileCursor, F.folder_id));
    }
  }
  if (inserts.length) await env.DB.batch(inserts);
  const remRow = await env.DB.prepare('SELECT COUNT(*) c FROM wix_crawl WHERE subs_done=0 OR files_done=0').first();
  stats.foldersRemaining = remRow ? remRow.c : 0;
  stats.didWork = !!F;
  return stats;
}

// Background migration driver — invoked by the cron trigger (see scheduled()).
// Takes the browser out of the loop: drains the index queue, then copies bytes
// into R2 server-side, fully resumable, until nothing remains. A soft lock in
// sync_state stops overlapping ticks; sync_state migrate_auto='0' pauses it; on
// completion it sets migrate_auto='0' so future ticks short-circuit cheaply.
async function migrationTick(env) {
  if (!env.DB) return { skipped: 'no-db' };
  const now = Math.floor(Date.now() / 1000);

  const auto = await env.DB.prepare("SELECT value FROM sync_state WHERE key='migrate_auto'").first();
  if (auto && auto.value === '0') return { paused: true };

  // soft lock so two ticks don't copy the same rows. Short TTL (45s) because the
  // copy loop is wall-clock-boxed to ~20s and releases on exit — so even if a
  // tick were ever killed, the next minute's fire still runs (no wasted minute).
  const lock = await env.DB.prepare("SELECT updated_at FROM sync_state WHERE key='migrate_lock'").first();
  if (lock && lock.updated_at && (now - lock.updated_at) < 45) return { locked: true };
  await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('migrate_lock','running',?1) ON CONFLICT(key) DO UPDATE SET value='running', updated_at=?1").bind(now).run();

  const out = { indexedFolders: 0, indexed: 0, copied: 0, foldersRemaining: null, remaining: null };
  try {
    // 1) COPY bytes into R2 — the bulk of the work, and the priority. Done in
    // concurrent waves, looped under a wall-clock deadline so each tick does as
    // much as it reliably can and ALWAYS returns cleanly (releasing the lock)
    // before any platform time limit could kill it mid-flight. While files
    // remain, the whole invocation goes here (index is deferred below).
    let remaining = null;
    const COPY_DEADLINE_MS = 20000;
    const startMs = Date.now();
    if (env.MEDIA && env.MEDIA_PUBLIC_BASE && !/REPLACE-WITH/.test(env.MEDIA_PUBLIC_BASE)) {
      const publicBase = env.MEDIA_PUBLIC_BASE.replace(/\/+$/, '');
      let batches = 0;
      while (Date.now() - startMs < COPY_DEADLINE_MS) {
        const s = await migrateCopyBatch(env, 24, publicBase, now);
        out.copied += s.copied;
        remaining = s.remaining;
        batches++;
        if (s.remaining === 0 || s.processed === 0) break;
      }
      out.copyBatches = batches;
    }
    out.remaining = remaining;
    out.copyMs = Date.now() - startMs;

    // 2) INDEX — only once copy is fully drained. The remaining crawl folders
    // surface almost no new files but cost ~36 Wix calls each, so we keep them
    // out of the hot copy path and finish the tree only after R2 is caught up.
    let foldersRemaining = null;
    if ((remaining === 0 || remaining === null) && env.WIX_API_KEY && env.WIX_SITE_ID) {
      const has = await env.DB.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='wix_crawl'").first();
      if (has && has.c) {
        foldersRemaining = 0;
        for (let i = 0; i < 12; i++) {
          const s = await migrateIndexFolder(env, now, 100, false); // never re-seed
          foldersRemaining = s.foldersRemaining;
          if (!s.didWork) break;
          out.indexedFolders++; out.indexed += s.indexed;
          if (s.foldersRemaining === 0) break;
        }
      }
    }
    out.foldersRemaining = foldersRemaining;

    // 3) auto-pause once everything is copied AND the index tree is fully drained
    if (remaining === 0) {
      const fp = await env.DB.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='wix_crawl'").first();
      let pending = 0;
      if (fp && fp.c) {
        const p = await env.DB.prepare('SELECT COUNT(*) c FROM wix_crawl WHERE subs_done=0 OR files_done=0').first();
        pending = p ? p.c : 0;
      }
      if (pending === 0) {
        await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('migrate_auto','0',?1) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=?1").bind(now).run();
        out.complete = true;
      }
    }
  } catch (e) {
    out.error = (e.message || String(e)).slice(0, 200);
  } finally {
    // release the lock (stamp 0 so the next cron tick runs immediately)
    await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('migrate_lock','idle',0) ON CONFLICT(key) DO UPDATE SET value='idle', updated_at=0").run();
  }
  console.log('migrationTick ' + JSON.stringify(out));
  return out;
}

async function handleMigrateWixMedia(req, env, origin, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.WIX_API_KEY || !env.WIX_SITE_ID) {
    return json({ error: 'WIX_API_KEY and WIX_SITE_ID secrets must be set' }, { status: 500 }, env, origin);
  }
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);

  // Reachability probe — confirms the worker's Wix key can List Files. A global
  // total isn't cheap with List Files, so we just confirm access here; the
  // running total accrues during the index pass.
  if (url.searchParams.get('count') === '1') {
    try {
      await wixListFilesPage(env, 'media-root', null, 1);
      return json({ total: null, reachable: true }, {}, env, origin);
    } catch (e) {
      return json({ error: e.message, status: e.status || 502 }, { status: e.status === 403 ? 403 : 502 }, env, origin);
    }
  }

  // Lightweight progress snapshot — lets the studio watch the cron-driven
  // migration without making copy/index calls itself.
  if (url.searchParams.get('status') === '1') {
    const row = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM media) media_total,
      (SELECT COUNT(*) FROM media WHERE url LIKE '%wixstatic.com/%') remaining,
      (SELECT COUNT(*) FROM media WHERE uploaded_by='wix-migrate') copied,
      (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='wix_crawl') has_crawl`).first();
    let foldersPending = 0;
    if (row && row.has_crawl) {
      const f = await env.DB.prepare('SELECT COUNT(*) c FROM wix_crawl WHERE subs_done=0 OR files_done=0').first();
      foldersPending = f ? f.c : 0;
    }
    const autoRow = await env.DB.prepare("SELECT value FROM sync_state WHERE key='migrate_auto'").first();
    const lockRow = await env.DB.prepare("SELECT updated_at FROM sync_state WHERE key='migrate_lock'").first();
    return json({
      media_total: (row && row.media_total) || 0,
      copied: (row && row.copied) || 0,
      remaining: (row && row.remaining) || 0,
      foldersPending,
      auto: !autoRow || autoRow.value !== '0',
      lastTickAt: (lockRow && lockRow.updated_at) || null,
      done: foldersPending === 0 && ((row && row.remaining) || 0) === 0,
    }, {}, env, origin);
  }

  // Toggle the background cron driver: ?auto=on resumes (and re-arms after a
  // completed run), ?auto=off pauses it.
  const autoParam = (url.searchParams.get('auto') || '').toLowerCase();
  if (autoParam === 'on' || autoParam === 'off') {
    const v = autoParam === 'off' ? '0' : '1';
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('migrate_auto',?1,?2) ON CONFLICT(key) DO UPDATE SET value=?1, updated_at=?2").bind(v, now).run();
    return json({ auto: v === '1' }, {}, env, origin);
  }

  const mode = (url.searchParams.get('mode') || 'index').toLowerCase();
  const hasCursor = !!url.searchParams.get('cursor');  // runner omits cursor on a run's first call
  const ts = Math.floor(Date.now() / 1000);

  // ── COPY: own the bytes. Walk media rows still hosted on Wix, pull each into
  // R2, repoint the row at /media/<key>. Driven off the table the index pass
  // populated, so it needs zero Wix calls and is fully resumable. ──────────────
  if (mode === 'copy') {
    if (!env.MEDIA) return json({ error: 'R2 not configured' }, { status: 500 }, env, origin);
    if (!env.MEDIA_PUBLIC_BASE || /REPLACE-WITH/.test(env.MEDIA_PUBLIC_BASE)) {
      return json({ error: 'MEDIA_PUBLIC_BASE not configured' }, { status: 500 }, env, origin);
    }
    const limit = clampInt(url.searchParams.get('limit'), 20, 1, 40);
    const publicBase = env.MEDIA_PUBLIC_BASE.replace(/\/+$/, '');
    const s = await migrateCopyBatch(env, limit, publicBase, ts);
    return json({ mode, processed: s.processed, indexed: 0, copied: s.copied, skipped: 0, errors: s.errors,
      remaining: s.remaining, total: null, done: s.remaining === 0, nextCursor: s.remaining ? 'go' : null }, {}, env, origin);
  }

  // ── INDEX: recursively crawl the whole Wix folder tree via List Files. A D1
  // table (wix_crawl) holds the folder queue so cursors stay tiny; each call
  // processes one folder (bounded). Resets on a run's first call (no cursor) so
  // the schema is rebuilt; resumes otherwise. ─────────────────────────────────
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 100);
  // Drop the ephemeral crawl queue on a fresh run so it always recreates with
  // the current schema (CREATE TABLE IF NOT EXISTS won't add new columns to a
  // pre-existing table — which is what broke the folder-path migration).
  if (!hasCursor) await env.DB.prepare('DROP TABLE IF EXISTS wix_crawl').run();
  let s;
  try {
    s = await migrateIndexFolder(env, ts, limit, true);
  } catch (e) {
    return json({ error: e.message, status: e.status || 502 }, { status: e.status === 403 ? 403 : 502 }, env, origin);
  }
  const done = s.foldersRemaining === 0;
  return json({ mode, processed: s.processed, indexed: s.indexed, copied: 0, skipped: s.skipped, errors: [],
    foldersRemaining: s.foldersRemaining, total: null, done, nextCursor: done ? null : 'go' }, {}, env, origin);
}

// ---------------------------------------------------------------------------
// /admin/upload — accept an image upload via multipart/form-data, store
// the object in R2, register a row in the media table, return the public
// CDN URL the editor pastes into a post.
//
// Request:
//   POST /admin/upload
//   Authorization: Bearer <ADMIN_TOKEN>
//   Content-Type: multipart/form-data
//   form fields: file (required), alt (optional), caption (optional)
//
// Response:
//   { ok: true, key, url, filename, size_bytes, mime_type }
// ---------------------------------------------------------------------------

async function handleUpload(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.MEDIA) {
    return json({ error: 'R2 bucket not configured — add the MEDIA binding in wrangler.toml' }, { status: 500 }, env, origin);
  }
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);

  let form;
  try { form = await req.formData(); }
  catch (e) { return json({ error: 'expected multipart/form-data', detail: e.message }, { status: 400 }, env, origin); }

  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.arrayBuffer) {
    return json({ error: 'file field is required and must be a File' }, { status: 400 }, env, origin);
  }
  const alt     = (form.get('alt')     || '').toString().slice(0, 500);
  const caption = (form.get('caption') || '').toString().slice(0, 1000);
  const folder  = (form.get('folder')  || '').toString().slice(0, 120);

  // Build a clean R2 key: YYYY/MM/<short-hash>-<safe-filename>
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const slugHash = [...rand].map(b => b.toString(16).padStart(2, '0')).join('');
  const safeName = (file.name || 'upload')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'upload';
  const key = `${yyyy}/${mm}/${slugHash}-${safeName}`;

  // Hard limit on file size — R2 itself accepts up to 5GB but Workers
  // have a request-body cap and we don't want runaway uploads.
  const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return json({ error: 'file too large', maxBytes: MAX_BYTES, gotBytes: buf.byteLength }, { status: 413 }, env, origin);
  }

  const mimeType = file.type || guessMimeFromName(file.name) || 'application/octet-stream';

  // Push to R2
  try {
    await env.MEDIA.put(key, buf, {
      httpMetadata: { contentType: mimeType, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { filename: file.name || '', alt, caption },
    });
  } catch (e) {
    return json({ error: 'R2 upload failed', detail: e.message || String(e) }, { status: 500 }, env, origin);
  }

  const publicBase = (env.MEDIA_PUBLIC_BASE || '').replace(/\/+$/, '');
  const url = publicBase ? `${publicBase}/${key}` : '';

  // Register in D1
  const ts = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`
      INSERT INTO media (key, filename, mime_type, size_bytes, alt_text, caption, uploaded_by, uploaded_at, url, folder)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
      ON CONFLICT(key) DO UPDATE SET
        filename=excluded.filename, mime_type=excluded.mime_type, size_bytes=excluded.size_bytes,
        alt_text=excluded.alt_text, caption=excluded.caption, url=excluded.url, folder=excluded.folder
    `).bind(
      key, file.name || '', mimeType, buf.byteLength,
      alt || null, caption || null, 'studio', ts, url, folder || '',
    ).run();
  } catch (e) {
    // R2 upload succeeded but DB index failed — log but still return the URL
    console.warn('[upload] R2 ok, D1 index failed:', e.message);
  }

  return json({
    ok: true, key, url, filename: file.name, size_bytes: buf.byteLength, mime_type: mimeType, uploaded_at: ts,
  }, {}, env, origin);
}

// ---------------------------------------------------------------------------
// Large-file (video) uploads via R2 multipart. A Worker can't accept a 700MB
// request body, so the browser slices the file into parts and uploads each as
// its own request; R2 stitches them on complete. The studio drives this for
// any file too big for the single-shot /admin/upload path.
//   POST /admin/upload-multipart/create   {filename, contentType, folder}
//        → { key, uploadId }
//   PUT  /admin/upload-multipart/part?key=&uploadId=&part=N   body=<chunk>
//        → { partNumber, etag }
//   POST /admin/upload-multipart/complete {key, uploadId, parts, filename, contentType, folder, size}
//        → { ok, key, url, mime_type, size_bytes }
//   POST /admin/upload-multipart/abort    {key, uploadId}
// ---------------------------------------------------------------------------
function buildMediaKey(filename) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const slugHash = [...rand].map(b => b.toString(16).padStart(2, '0')).join('');
  const safeName = (filename || 'upload')
    .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'upload';
  return `${yyyy}/${mm}/${slugHash}-${safeName}`;
}

async function handleMultipartUpload(req, env, origin, action, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.MEDIA) return json({ error: 'R2 not configured' }, { status: 500 }, env, origin);
  if (!env.DB)    return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);

  try {
    if (action === 'create') {
      const b = await req.json();
      const filename = String(b.filename || 'upload').slice(0, 200);
      const contentType = String(b.contentType || guessMimeFromName(filename) || 'application/octet-stream');
      const key = buildMediaKey(filename);
      const mpu = await env.MEDIA.createMultipartUpload(key, {
        httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: { filename, folder: String(b.folder || '').slice(0, 120) },
      });
      return json({ ok: true, key: mpu.key, uploadId: mpu.uploadId, contentType }, {}, env, origin);
    }

    if (action === 'part') {
      const key = url.searchParams.get('key');
      const uploadId = url.searchParams.get('uploadId');
      const partNumber = parseInt(url.searchParams.get('part'), 10);
      if (!key || !uploadId || !(partNumber >= 1)) {
        return json({ error: 'key, uploadId and part are required' }, { status: 400 }, env, origin);
      }
      const mpu = env.MEDIA.resumeMultipartUpload(key, uploadId);
      const uploaded = await mpu.uploadPart(partNumber, await req.arrayBuffer());
      return json({ ok: true, partNumber: uploaded.partNumber, etag: uploaded.etag }, {}, env, origin);
    }

    if (action === 'complete') {
      const b = await req.json();
      const key = String(b.key || '');
      const uploadId = String(b.uploadId || '');
      const parts = Array.isArray(b.parts)
        ? b.parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })).sort((a, c) => a.partNumber - c.partNumber)
        : [];
      if (!key || !uploadId || !parts.length) {
        return json({ error: 'key, uploadId and parts are required' }, { status: 400 }, env, origin);
      }
      const mpu = env.MEDIA.resumeMultipartUpload(key, uploadId);
      const obj = await mpu.complete(parts);
      const filename = String(b.filename || key.split('/').pop());
      const mimeType = String(b.contentType || guessMimeFromName(filename) || 'application/octet-stream');
      const size = Number(b.size) || (obj && obj.size) || 0;
      const folder = String(b.folder || '').slice(0, 120);
      const publicBase = (env.MEDIA_PUBLIC_BASE || '').replace(/\/+$/, '');
      const mediaUrl = publicBase ? `${publicBase}/${key}` : '';
      const ts = Math.floor(Date.now() / 1000);
      try {
        await env.DB.prepare(`
          INSERT INTO media (key, filename, mime_type, size_bytes, alt_text, caption, uploaded_by, uploaded_at, url, folder)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
          ON CONFLICT(key) DO UPDATE SET
            filename=excluded.filename, mime_type=excluded.mime_type, size_bytes=excluded.size_bytes, url=excluded.url, folder=excluded.folder
        `).bind(key, filename, mimeType, size, null, null, 'studio', ts, mediaUrl, folder).run();
      } catch (e) { console.warn('[multipart] R2 ok, D1 index failed:', e.message); }
      return json({ ok: true, key, url: mediaUrl, filename, mime_type: mimeType, size_bytes: size, uploaded_at: ts }, {}, env, origin);
    }

    if (action === 'abort') {
      const b = await req.json().catch(() => ({}));
      const key = String(b.key || ''); const uploadId = String(b.uploadId || '');
      if (key && uploadId) { try { await env.MEDIA.resumeMultipartUpload(key, uploadId).abort(); } catch (_) {} }
      return json({ ok: true }, {}, env, origin);
    }

    return json({ error: 'unknown multipart action' }, { status: 400 }, env, origin);
  } catch (e) {
    return json({ error: 'multipart upload failed', detail: e.message || String(e) }, { status: 500 }, env, origin);
  }
}

async function handleMediaList(req, env, origin, url) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);

  // Folder index — derived folders (from media.folder) merged with registered
  // folders (media_folders: favorites + empty folders). Favorites sort first.
  if (url.searchParams.get('folders') === '1') {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS media_folders (name TEXT PRIMARY KEY, favorite INTEGER DEFAULT 0, created_at INTEGER)`).run();
    const derived = await env.DB.prepare(
      "SELECT COALESCE(NULLIF(folder,''),'Unfiled') AS folder, COUNT(*) AS count FROM media GROUP BY COALESCE(NULLIF(folder,''),'Unfiled')"
    ).all();
    const registered = await env.DB.prepare("SELECT name, favorite FROM media_folders").all();
    const map = new Map();
    for (const r of (derived.results || [])) map.set(r.folder, { folder: r.folder, count: r.count, favorite: 0 });
    for (const r of (registered.results || [])) {
      const e = map.get(r.name) || { folder: r.name, count: 0, favorite: 0 };
      e.favorite = r.favorite ? 1 : 0;
      map.set(r.name, e);
    }
    const folders = [...map.values()].sort((a, b) =>
      (b.favorite - a.favorite) || a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' })
    );
    const totalRow = await env.DB.prepare('SELECT COUNT(*) c FROM media').first();
    return json({ folders, total: totalRow ? totalRow.c : 0 }, {}, env, origin);
  }

  const limit  = clampInt(url.searchParams.get('limit'), 60, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
  const q      = (url.searchParams.get('q') || '').trim();
  const folder = (url.searchParams.get('folder') || '').trim();

  const where = []; const params = [];
  if (q)      { where.push(`(filename LIKE ?${params.length+1} OR alt_text LIKE ?${params.length+1})`); params.push('%' + q + '%'); }
  if (folder) { where.push(`folder = ?${params.length+1}`); params.push(folder); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = await env.DB.prepare(`SELECT COUNT(*) c FROM media ${whereSql}`).bind(...params).first();
  const rows  = await env.DB.prepare(`
    SELECT key, filename, mime_type, size_bytes, width, height, alt_text, caption, uploaded_at, url, folder
    FROM media ${whereSql}
    ORDER BY uploaded_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `).bind(...params).all();

  return json({
    items: rows.results || [],
    total: total ? total.c : 0,
    limit, offset,
    hasMore: offset + (rows.results || []).length < (total ? total.c : 0),
  }, {}, env, origin);
}

// POST /admin/media/folders {name}        — create an (empty) folder
// PATCH /admin/media/folders {name, favorite} — star/unstar a folder
async function handleMediaFolders(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS media_folders (name TEXT PRIMARY KEY, favorite INTEGER DEFAULT 0, created_at INTEGER)`).run();
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const name = String(body.name || '').trim();
  // Allow apostrophes / quotes / & etc — D1 binds are parameterized so SQL
  // injection isn't a risk, and the admin UI renders folder names via
  // textContent so XSS-via-storage isn't either. Block only chars that
  // would actually break path-string handling or hint at a script tag
  // hidden in the name (control chars, angle brackets, backslash). 200
  // char ceiling matches handleMediaRenameFolder's limit.
  if (!name || name.length > 200 || /[<>\\\x00-\x1f\x7f]/.test(name)) return json({ error: 'invalid folder name' }, { status: 400 }, env, origin);
  const now = Math.floor(Date.now() / 1000);
  if (req.method === 'POST') {
    await env.DB.prepare(`INSERT OR IGNORE INTO media_folders (name, favorite, created_at) VALUES (?1, 0, ?2)`).bind(name, now).run();
    return json({ ok: true, name }, {}, env, origin);
  }
  if (req.method === 'PATCH') {
    const fav = body.favorite ? 1 : 0;
    await env.DB.prepare(`INSERT INTO media_folders (name, favorite, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO UPDATE SET favorite = ?2`).bind(name, fav, now).run();
    return json({ ok: true, name, favorite: fav }, {}, env, origin);
  }
  return json({ error: 'method not allowed' }, { status: 405 }, env, origin);
}

async function handleMediaDelete(req, env, origin, key) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.MEDIA || !env.DB) return json({ error: 'storage not configured' }, { status: 500 }, env, origin);
  try { await env.MEDIA.delete(key); } catch (e) { console.warn('R2 delete failed', e); }
  try { await env.DB.prepare('DELETE FROM media WHERE key = ?1').bind(key).run(); }
  catch (e) { return json({ error: 'DB delete failed', detail: e.message }, { status: 500 }, env, origin); }
  return json({ ok: true, key }, {}, env, origin);
}

// Rename a media FOLDER (and its descendants). Folders are " / "-separated path
// strings on media.folder, so renaming "A / B" → "A / C" rewrites that exact
// folder plus every "A / B / …" descendant prefix. Merges if the target exists.
//   POST /admin/media/rename-folder { from, to }
async function handleMediaRenameFolder(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  let b; try { b = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const from = String(b.from || '').trim();
  const to   = String(b.to   || '').trim();
  // Same relaxed validation as create — apostrophes / quotes legal,
  // control + angle + backslash blocked. See handleMediaFolders for rationale.
  if (!from || !to || to.length > 200 || /[<>\\\x00-\x1f\x7f]/.test(to)) return json({ error: 'invalid folder names' }, { status: 400 }, env, origin);
  if (from === to) return json({ ok: true, items_moved: 0 }, {}, env, origin);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS media_folders (name TEXT PRIMARY KEY, favorite INTEGER DEFAULT 0, created_at INTEGER)`).run();
  let moved = 0;
  const r1 = await env.DB.prepare('UPDATE media SET folder = ?1 WHERE folder = ?2').bind(to, from).run();
  moved += (r1 && r1.meta && r1.meta.changes) || 0;
  // descendants — rewrite the "from / " prefix to "to / " (escape LIKE wildcards in `from`)
  const likeFrom = from.replace(/[\\%_]/g, '\\$&') + ' / %';
  const r2 = await env.DB.prepare("UPDATE media SET folder = ?1 || substr(folder, ?2) WHERE folder LIKE ?3 ESCAPE '\\'")
    .bind(to, from.length + 1, likeFrom).run();
  moved += (r2 && r2.meta && r2.meta.changes) || 0;
  // carry the folder registration (favorite / empty-folder) over to the new name
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO media_folders (name, favorite, created_at) SELECT ?1, favorite, created_at FROM media_folders WHERE name = ?2').bind(to, from).run();
    await env.DB.prepare('DELETE FROM media_folders WHERE name = ?1').bind(from).run();
  } catch {}
  return json({ ok: true, from, to, items_moved: moved }, {}, env, origin);
}

// Rename a media FILE's display name. The R2 key + public URL stay the same so
// existing references never break — only the stored `filename` changes.
//   POST /admin/media/rename-file { key, filename }
async function handleMediaRenameFile(req, env, origin) {
  const authCheck = await requireAdminToken(req, env, origin);
  if (authCheck) return authCheck;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  let b; try { b = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const key = String(b.key || '').trim();
  const filename = String(b.filename || '').trim().slice(0, 200);
  if (!key || !filename) return json({ error: 'key and filename required' }, { status: 400 }, env, origin);
  const r = await env.DB.prepare('UPDATE media SET filename = ?1 WHERE key = ?2').bind(filename, key).run();
  if (!(r && r.meta && r.meta.changes)) return json({ error: 'not found' }, { status: 404 }, env, origin);
  return json({ ok: true, key, filename }, {}, env, origin);
}

// ---------------------------------------------------------------------------
// GET /media/<key> — public asset serving straight from R2. This keeps the
// bucket PRIVATE (no r2.dev public access) while still giving every object a
// stable public URL that <img>/<video> tags and the studio can use. Honors
// Range requests so videos seek correctly.
// ---------------------------------------------------------------------------

async function handleMediaServe(req, env, key) {
  if (!env.MEDIA) return new Response('media not configured', { status: 500 });

  const rangeHeader = req.headers.get('range');
  let object;
  try {
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      const range = {};
      if (m && m[1] !== '') range.offset = parseInt(m[1], 10);
      if (m && m[2] !== '') {
        const end = parseInt(m[2], 10);
        range.length = end - (range.offset || 0) + 1;
      }
      object = await env.MEDIA.get(key, Object.keys(range).length ? { range } : undefined);
    } else {
      object = await env.MEDIA.get(key);
    }
  } catch (e) {
    return new Response('error', { status: 500 });
  }
  if (!object) return new Response('not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  if (!headers.has('cache-control')) headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('access-control-allow-origin', '*');
  headers.set('accept-ranges', 'bytes');

  if (req.method === 'HEAD') {
    headers.set('content-length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  if (rangeHeader && object.range) {
    const start = object.range.offset || 0;
    const len = object.range.length != null ? object.range.length : (object.size - start);
    headers.set('content-range', `bytes ${start}-${start + len - 1}/${object.size}`);
    headers.set('content-length', String(len));
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

// ── Auth: GitHub-OAuth session tokens (HMAC-signed) + ADMIN_TOKEN fallback ───
// A studio user logs in with GitHub (handleAuthLogin/Callback); the worker mints
// a signed session token the pages send as `Authorization: Bearer <session>`.
// The raw ADMIN_TOKEN secret still works too, for scripts/migrations.
function b64url(bytes) {
  const a = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
// Exported so mcp.js can mint carousel preview URLs alongside the worker routes.
export async function signPayload(obj, secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload));
  return payload + '.' + b64url(sig);
}
async function verifyPayload(token, secret) {
  if (!token || token.indexOf('.') < 0 || !secret) return null;
  const [payload, sig] = token.split('.');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), new TextEncoder().encode(payload)); } catch { return null; }
  if (!ok) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (obj.exp && obj.exp < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch { return null; }
}
function ghAllowed(env, login) {
  const allow = (env.GITHUB_ALLOWED_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return allow.length === 0 || allow.includes((login || '').toLowerCase());
}

// Reusable admin guard — accepts a valid GitHub session OR the ADMIN_TOKEN.
// Returns null if authorized, or a 401 Response. ASYNC: `await requireAdminToken(...)`.
async function requireAdminToken(req, env, origin) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token) {
    if (env.SESSION_SECRET) {
      const s = await verifyPayload(token, env.SESSION_SECRET);
      if (s && s.u && ghAllowed(env, s.u)) return null;
    }
    if (env.ADMIN_TOKEN && constantTimeEqual(token, env.ADMIN_TOKEN)) return null;
  }
  return json({ error: 'unauthorized' }, { status: 401 }, env, origin);
}

// GET /admin/auth/login?redirect=<page> — kick off GitHub OAuth.
async function handleAuthLogin(env, url) {
  if (!env.GITHUB_CLIENT_ID || !env.SESSION_SECRET) return new Response('GitHub OAuth not configured on the worker.', { status: 500 });
  const redirect = url.searchParams.get('redirect') || 'https://admin.oftmw.com/';
  const state = await signPayload({ r: redirect, exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  const gh = new URL('https://github.com/login/oauth/authorize');
  gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  gh.searchParams.set('redirect_uri', url.origin + '/admin/auth/callback');
  gh.searchParams.set('scope', 'read:user');
  gh.searchParams.set('state', state);
  gh.searchParams.set('allow_signup', 'false');
  return Response.redirect(gh.toString(), 302);
}

// GET /admin/auth/callback — exchange code, verify the GitHub user, mint a
// session, and bounce back to the originating page with #tmw_session=<token>.
async function handleAuthCallback(env, url) {
  const code = url.searchParams.get('code');
  const st = await verifyPayload(url.searchParams.get('state'), env.SESSION_SECRET);
  if (!code || !st || !st.r) return new Response('Invalid OAuth state.', { status: 400 });
  let accessToken;
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: url.origin + '/admin/auth/callback' }),
    });
    accessToken = (await r.json()).access_token;
  } catch { return new Response('OAuth exchange failed.', { status: 502 }); }
  if (!accessToken) return new Response('OAuth exchange failed (no token).', { status: 401 });
  let login = '';
  try {
    const u = await (await fetch('https://api.github.com/user', { headers: { 'Authorization': 'Bearer ' + accessToken, 'User-Agent': 'tmw-studio', 'Accept': 'application/json' } })).json();
    login = u.login || '';
  } catch { return new Response('Could not read GitHub user.', { status: 502 }); }
  if (!login || !ghAllowed(env, login)) {
    return new Response('Not authorized: ' + (login || 'unknown GitHub account') + ' is not on the allow-list.', { status: 403 });
  }
  const session = await signPayload({ u: login, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }, env.SESSION_SECRET);
  const dest = st.r + (st.r.includes('#') ? '&' : '#') + 'tmw_session=' + encodeURIComponent(session);
  return Response.redirect(dest, 302);
}

// GET /admin/auth/me — who is the bearer? (for the page to show login state)
async function handleAuthMe(req, env, origin) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token && env.SESSION_SECRET) {
    const s = await verifyPayload(token, env.SESSION_SECRET);
    if (s && s.u && ghAllowed(env, s.u)) return json({ user: s.u, via: 'github' }, {}, env, origin);
  }
  if (token && env.ADMIN_TOKEN && constantTimeEqual(token, env.ADMIN_TOKEN)) return json({ user: 'admin token', via: 'token' }, {}, env, origin);
  return json({ error: 'unauthenticated' }, { status: 401 }, env, origin);
}

function guessMimeFromName(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    pdf: 'application/pdf',
  })[ext] || '';
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

// ── Brand brain (shared house-style notes) — admin read/write. The Studio MCP
// connector reads/writes this same brand_notes table via get_brand_brain /
// record_preference, so the Studio UI and Claude stay in sync. ───────────────
const BRAIN_KINDS = ['like', 'dislike', 'rule', 'voice', 'structure', 'topic', 'avoid', 'example'];
async function ensureBrandNotes(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS brand_notes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, category TEXT, note TEXT NOT NULL, context TEXT, created_by TEXT, created_at INTEGER, active INTEGER DEFAULT 1)'
  ).run();
}
async function handleBrainGet(req, env, origin) {
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureBrandNotes(env);
  const rows = (await env.DB.prepare(
    'SELECT id, kind, category, note, context, created_by, created_at FROM brand_notes WHERE active = 1 ORDER BY created_at ASC'
  ).all()).results || [];
  return json({ count: rows.length, notes: rows }, {}, env, origin);
}
async function handleBrainPost(req, env, origin) {
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureBrandNotes(env);
  let b; try { b = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const kind = String(b.kind || '').trim().toLowerCase();
  if (!BRAIN_KINDS.includes(kind)) return json({ error: 'kind must be one of: ' + BRAIN_KINDS.join(', ') }, { status: 400 }, env, origin);
  const note = String(b.note || '').trim();
  if (!note) return json({ error: 'note is required' }, { status: 400 }, env, origin);
  const category = String(b.category || '').slice(0, 60) || null;
  const context = String(b.context || '').slice(0, 500) || null;
  if (b.id) {
    await env.DB.prepare('UPDATE brand_notes SET kind = ?1, category = ?2, note = ?3, context = ?4 WHERE id = ?5')
      .bind(kind, category, note.slice(0, 2000), context, String(b.id)).run();
    return json({ ok: true, id: b.id, updated: true }, {}, env, origin);
  }
  const id = 'bn-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO brand_notes (id, kind, category, note, context, created_by, created_at, active) VALUES (?1,?2,?3,?4,?5,?6,?7,1)')
    .bind(id, kind, category, note.slice(0, 2000), context, String(b.by || 'studio').slice(0, 40), now).run();
  return json({ ok: true, id }, {}, env, origin);
}
async function handleBrainDelete(req, env, origin, id) {
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureBrandNotes(env);
  await env.DB.prepare('UPDATE brand_notes SET active = 0 WHERE id = ?1').bind(String(id)).run();
  return json({ ok: true, id, removed: true }, {}, env, origin);
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
// First-party post view counter — a number we fully own (no GA undercount,
// no Wix black box). The journal post page beacons POST /view {slug} once per
// load; we validate the slug is a real post + filter obvious bots, then bump a
// per-slug counter in D1. GET /post-views returns the full {slug: count} map
// for the studio's Posts column. Both are public (view counts aren't sensitive).
// ---------------------------------------------------------------------------
const POST_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,160}$/;
const VIEW_BOT_RE  = /bot|crawl|spider|slurp|facebookexternalhit|bingpreview|preview|headless|lighthouse|pingdom|monitor|curl|wget|python-requests|axios|node-fetch/i;

async function ensurePostViewsTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS post_views (slug TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0, wix_views INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)'
  ).run();
  // Existing tables (pre wix_views) get the column added; ignore "already exists".
  try { await env.DB.prepare('ALTER TABLE post_views ADD COLUMN wix_views INTEGER NOT NULL DEFAULT 0').run(); } catch (_) {}
}

// Tiny key/value store for run-once / last-run bookkeeping (Wix backfill clock).
async function metaGet(env, key) {
  try { const r = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(key).first(); return r ? r.value : null; }
  catch (_) { return null; }
}
async function metaSet(env, key, value) {
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)').run();
    await env.DB.prepare('INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(key, String(value)).run();
  } catch (_) {}
}

// Snapshot each post's historical Wix view count into post_views.wix_views.
// The reported total per post is wix_views (frozen-ish baseline, refreshed
// daily) + views (our live first-party counter). New posts that never lived on
// Wix have wix_views = 0, so their total is purely our counter.
async function backfillWixViews(env) {
  if (!env.DB || !env.WIX_API_KEY || !env.WIX_SITE_ID) return { ok: false, reason: 'not configured' };
  await ensurePostViewsTable(env);
  const wixUrl = 'https://www.wixapis.com/blog/v3/posts/query';
  const limit = 100;
  let offset = 0, scanned = 0, withViews = 0, pages = 0;
  while (pages < 60) {
    const res = await fetch(wixUrl, {
      method: 'POST',
      headers: {
        'Authorization': env.WIX_API_KEY, 'wix-site-id': env.WIX_SITE_ID, 'Content-Type': 'application/json',
        ...(env.WIX_ACCOUNT_ID ? { 'wix-account-id': env.WIX_ACCOUNT_ID } : {}),
      },
      body: JSON.stringify({ query: { paging: { limit, offset }, sort: [{ fieldName: 'firstPublishedDate', order: 'DESC' }] }, fieldsets: ['URL', 'METRICS'] }),
    });
    if (!res.ok) break;
    const data = await res.json();
    const posts = data.posts || [];
    if (!posts.length) break;
    const now = Math.floor(Date.now() / 1000);
    const stmts = [];
    for (const wp of posts) {
      const slug = (wp.slug || '').toLowerCase().trim();
      const m = wp.metrics || {};
      const v = parseInt((m.views != null ? m.views : (m.viewCount != null ? m.viewCount : 0)), 10) || 0;
      scanned++;
      if (!slug) continue;
      if (v > 0) withViews++;
      stmts.push(env.DB.prepare(
        'INSERT INTO post_views (slug, views, wix_views, updated_at) VALUES (?1, 0, ?2, ?3) ' +
        'ON CONFLICT(slug) DO UPDATE SET wix_views = ?2, updated_at = ?3'
      ).bind(slug, v, now));
    }
    if (stmts.length) await env.DB.batch(stmts);
    pages++;
    offset += limit;
    if (posts.length < limit) break;
    const total = data.metaData && data.metaData.total;
    if (typeof total === 'number' && offset >= total) break;
  }
  await metaSet(env, 'wix_views_last_backfill', Math.floor(Date.now() / 1000));
  return { ok: true, scanned, withViews, pages };
}

// Cron-driven: claim the daily slot first (so a slow/failed run doesn't retry
// every minute), then refresh the Wix baseline. Self-seeds within ~1 min of deploy.
async function maybeBackfillWixViews(env) {
  try {
    const last = parseInt(await metaGet(env, 'wix_views_last_backfill') || '0', 10) || 0;
    const now = Math.floor(Date.now() / 1000);
    if (now - last < 86400) return;
    await metaSet(env, 'wix_views_last_backfill', now);   // claim before running
    await backfillWixViews(env);
  } catch (_) {}
}

// Daily sweep: flip Opening Soon → Now Open for any project whose stated
// delivery date has fully passed. Same lock/claim pattern as the Wix view
// backfill (24h throttle via metaGet/metaSet) — claim BEFORE running so
// an overlapping tick can't double-write projects.json.
async function maybeAutoPromoteOpenings(env) {
  try {
    const last = parseInt(await metaGet(env, 'auto_promote_openings_last') || '0', 10) || 0;
    const now = Math.floor(Date.now() / 1000);
    if (now - last < 86400) return;
    await metaSet(env, 'auto_promote_openings_last', now);
    await autoPromoteOpenedProjects(env);
  } catch (_) {}
}

async function handleBackfillWixViews(req, env, origin) {
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;
  const r = await backfillWixViews(env);
  return json(r, {}, env, origin);
}

async function handlePostView(req, env, origin) {
  // Always 204 (a beacon ignores the body); failures are silent so a bad
  // request never costs the visitor anything.
  const ok = () => new Response(null, { status: 204, headers: corsHeaders(env, origin) });
  if (!env.DB) return ok();

  const ua = (req.headers.get('User-Agent') || '');
  if (!ua || VIEW_BOT_RE.test(ua)) return ok();

  let slug = '';
  try {
    const txt = await req.text();
    if (txt) { try { slug = (JSON.parse(txt).slug || '').toString(); } catch (_) { slug = ''; } }
  } catch (_) {}
  slug = slug.trim().toLowerCase();
  if (!POST_SLUG_RE.test(slug)) return ok();

  try {
    await ensurePostViewsTable(env);
    // Only count real posts so the table stays clean + un-inflatable by junk slugs.
    const exists = await env.DB.prepare('SELECT 1 FROM posts WHERE slug = ?1 LIMIT 1').bind(slug).first();
    if (exists) {
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        'INSERT INTO post_views (slug, views, updated_at) VALUES (?1, 1, ?2) ' +
        'ON CONFLICT(slug) DO UPDATE SET views = views + 1, updated_at = ?2'
      ).bind(slug, now).run();
    }
  } catch (_) {}
  return ok();
}

async function handlePostViews(env, origin) {
  if (!env.DB) return json({ views: {} }, {}, env, origin);
  try {
    await ensurePostViewsTable(env);
    const rows = await env.DB.prepare('SELECT slug, views, wix_views FROM post_views').all();
    const views = {}, breakdown = {};
    for (const r of (rows.results || [])) {
      const live = r.views || 0, wix = r.wix_views || 0;
      views[r.slug] = live + wix;          // combined total (Wix baseline + our counter)
      breakdown[r.slug] = { live, wix };
    }
    return json(
      { views, breakdown, count: Object.keys(views).length },
      { headers: { 'Cache-Control': 'public, max-age=15, s-maxage=30' } },
      env, origin,
    );
  } catch (e) {
    return json({ views: {}, error: String(e && e.message || e) }, {}, env, origin);
  }
}

// ---------------------------------------------------------------------------
// Journal "active now" — first-party heartbeat. Every open journal page pings
// POST /journal-ping {sid} every ~60s; GET /journal-active counts distinct
// sessions seen in the last 5 minutes. (GA4 realtime can't be filtered to the
// journal host, so we own this the same way as the post-view counter.)
// ---------------------------------------------------------------------------
async function ensureJournalActiveTable(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS journal_active (sid TEXT PRIMARY KEY, ts INTEGER, path TEXT, title TEXT)').run();
  try { await env.DB.prepare('ALTER TABLE journal_active ADD COLUMN path TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE journal_active ADD COLUMN title TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE journal_active ADD COLUMN member_id TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE journal_active ADD COLUMN member_name TEXT').run(); } catch (_) {}
  // Geo columns, derived from request.cf on each ping. Lets the Studio render
  // "Brooklyn, NY, US" on each live presence row.
  try { await env.DB.prepare('ALTER TABLE journal_active ADD COLUMN city TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE journal_active ADD COLUMN region TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE journal_active ADD COLUMN country TEXT').run(); } catch (_) {}
}

async function handleJournalPing(req, env, origin) {
  const ok = () => new Response(null, { status: 204, headers: corsHeaders(env, origin) });
  if (!env.DB) return ok();
  const ua = (req.headers.get('User-Agent') || '');
  if (!ua || VIEW_BOT_RE.test(ua)) return ok();
  let sid = '', path = '', title = '', memberId = '', memberName = '';
  try {
    const t = await req.text();
    if (t) { try { const o = JSON.parse(t); sid = (o.sid || '').toString(); path = (o.path || '').toString().slice(0, 300); title = (o.title || '').toString().slice(0, 300); memberId = (o.member_id || '').toString().slice(0, 80); memberName = (o.member_name || '').toString().slice(0, 120); } catch (_) {} }
  } catch (_) {}
  sid = sid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!sid) return ok();
  // Cloudflare auto-populates request.cf with edge-derived geography.
  const cf = req.cf || {};
  const city    = cf.city       ? String(cf.city).slice(0, 60)    : '';
  const region  = cf.regionCode ? String(cf.regionCode).slice(0, 8)
                                : (cf.region ? String(cf.region).slice(0, 60) : '');
  const country = cf.country    ? String(cf.country).slice(0, 4)  : '';
  try {
    await ensureJournalActiveTable(env);
    const now = Math.floor(Date.now() / 1000);
    // Keep an existing member identity if a later ping arrives without one (the
    // member resolves a beat after the first anonymous ping). Same idea for geo:
    // if cf is somehow blank on this ping, don't clobber the previously-stored
    // geo for the session.
    await env.DB.prepare(
      'INSERT INTO journal_active (sid, ts, path, title, member_id, member_name, city, region, country) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ' +
      'ON CONFLICT(sid) DO UPDATE SET ts = ?2, path = ?3, title = ?4, ' +
      'member_id = COALESCE(NULLIF(?5, \'\'), member_id), ' +
      'member_name = COALESCE(NULLIF(?6, \'\'), member_name), ' +
      'city = COALESCE(NULLIF(?7, \'\'), city), ' +
      'region = COALESCE(NULLIF(?8, \'\'), region), ' +
      'country = COALESCE(NULLIF(?9, \'\'), country)'
    ).bind(sid, now, path, title, memberId || null, memberName || null, city || null, region || null, country || null).run();
  } catch (_) {}
  return ok();
}

async function handleJournalActive(env, origin) {
  if (!env.DB) return json({ active: 0, feed: [] }, {}, env, origin);
  try {
    await ensureJournalActiveTable(env);
    const now = Math.floor(Date.now() / 1000);
    const cut = now - 300;
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM journal_active WHERE ts > ?1').bind(cut).first();
    const rows = await env.DB.prepare('SELECT ts, path, title, member_name, city, region, country FROM journal_active WHERE ts > ?1 ORDER BY ts DESC LIMIT 40').bind(cut).all();
    const reads = (rows.results || []).map(r => ({
      path: r.path || '',
      title: r.title || '',
      member_name: r.member_name || null,
      city: r.city || null,
      region: r.region || null,
      country: r.country || null,
      ago: Math.max(0, now - (r.ts || now)),
    }));
    // Fold in the last-5-min interaction events (searches, TMW Intelligence
    // queries, project opens, subscribes…) so the live feed reflects EVERYTHING
    // happening now, not just page reads. page_view is excluded — reads already
    // come from journal_active above, so including it would double-list them.
    // Event rows carry geo inside props_json (merged at /event ingest), so we
    // hoist those keys onto the feed item for symmetry with the reads rows.
    let evItems = [];
    try {
      const ev = await env.DB.prepare(
        `SELECT ts, member_name, event_name, path, props_json
         FROM events
         WHERE ts > ?1 AND event_name NOT IN ('page_view','watchlist_snapshot','intel_answer')
           AND event_name NOT LIKE 'funnel:%'
         ORDER BY ts DESC LIMIT 40`
      ).bind(cut).all();
      evItems = (ev.results || []).map(r => {
        let p = {}; try { if (r.props_json) p = JSON.parse(r.props_json); } catch (_) {}
        return {
          event_name: r.event_name,
          props_json: r.props_json || null,
          path: r.path || '',
          member_name: r.member_name || null,
          city: p.city || null,
          region: p.regionCode || p.region || null,
          country: p.country || null,
          ago: Math.max(0, now - (r.ts || now)),
        };
      });
      // Collapse the redundant 'search' half of a smart query (mirrors the
      // /activity feed): drop a 'search' item when an 'intel_query' for the same
      // query is present in this batch, so one ask shows as one live row.
      const intelQs = new Set(
        evItems.filter(e => e.event_name === 'intel_query')
          .map(e => { try { return (JSON.parse(e.props_json || '{}').q) || ''; } catch (_) { return ''; } })
          .filter(Boolean)
      );
      evItems = evItems.filter(e => {
        if (e.event_name !== 'search') return true;
        let q = ''; try { q = (JSON.parse(e.props_json || '{}').q) || ''; } catch (_) {}
        return !(q && intelQs.has(q));
      });
    } catch (_) {}
    const feed = reads.concat(evItems).sort((a, b) => a.ago - b.ago).slice(0, 40);
    try { await env.DB.prepare('DELETE FROM journal_active WHERE ts < ?1').bind(now - 3600).run(); } catch (_) {}
    return json({ active: cnt ? cnt.c : 0, feed }, { headers: { 'Cache-Control': 'no-store' } }, env, origin);
  } catch (e) {
    return json({ active: 0, feed: [] }, {}, env, origin);
  }
}

// ---------------------------------------------------------------------------
// TMW Intelligence — smart-search answer synthesis (Phase 2 of smart search)
// ---------------------------------------------------------------------------
// The /search/ page parses a natural-language query into structured criteria
// and resolves it against the project DB *client-side* (deterministic, no LLM).
// It then POSTs the resolved, VERIFIED facts here; we ask Claude to turn them
// into a 1-2 sentence editorial answer. Claude is told to use ONLY the facts
// given — every number/name stays DB-derived, so the prose can't hallucinate.
// Answers are cached per normalized query signature (24h) so repeats are free.
// Graceful degradation: any failure (no key, API error, bad input) returns
// { answer: null } with 200, and the page keeps its deterministic answer.
const SMART_ANSWER_MODEL = 'claude-sonnet-4-6';   // chosen for cost/quality balance on this public endpoint

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Log one TMW Intelligence answer (query + answer + signals digest) for the
// nightly intel-review routine. Deduped to at most one row per query per 6h so
// popular cache-HIT queries don't flood the log. Best-effort; never throws.
async function logIntelAnswer(env, q, answer, compact) {
  if (!env || !env.DB || !answer) return;
  try {
    let dup = false;
    try {
      const recent = await env.DB.prepare(
        `SELECT 1 FROM events WHERE event_name = 'intel_answer' AND ts >= ?
         AND json_extract(props_json, '$.q') = ? LIMIT 1`
      ).bind(Math.floor(Date.now() / 1000) - 6 * 3600, q).first();
      dup = !!recent;
    } catch { dup = false; }
    if (dup) return;
    const digest = {
      q, answer,
      place: compact.place || null,
      count: compact.count,
      soonest: compact.soonest || null,
      dominant_type: compact.dominant_type || null,
      flagships: (compact.flagships || []).map(f => ({ name: f.name, type: f.type })),
      top: (compact.top || []).slice(0, 8).map(t => t.name),
    };
    await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?, ?, ?, ?)`)
      .bind(Math.floor(Date.now() / 1000), 'system:smart-answer', 'intel_answer', JSON.stringify(digest)).run();
  } catch { /* best-effort */ }
}

// Grab a readable window of body text around the first topic cue so the model
// sees the RELEVANT paragraph (e.g. the restaurant buried mid-article), not the lede.
function topicSnippet(text, re) {
  if (!text) return '';
  const m = re.exec(text);
  if (!m) return text.slice(0, 420);
  const i = Math.max(0, m.index - 170);
  return (i > 0 ? '…' : '') + text.slice(i, i + 500).trim() + '…';
}

// Pull candidate journal posts for a TOPIC answer straight from D1, matching the
// place across title / excerpt / FULL BODY. This is the key to "see everything":
// a restaurant opening buried in paragraph 4 of a HOTEL post (which carries no
// food category and wouldn't survive the client's title/category filter) is
// still found here, and the model gets the actual body snippet to reason over.
// Returns slim fact rows (blurb = body snippet) + a docs map for hero rendering.
async function retrieveTopicCandidates(env, placeTerms, topic) {
  const terms = (placeTerms || [])
    .map(t => String(t || '').toLowerCase().trim())
    .filter(t => t.length >= 3).slice(0, 10);
  if (!terms.length) return { top: [], docs: {} };
  const ors = terms.map((_, i) =>
    `(LOWER(title) LIKE ?${i + 1} OR LOWER(excerpt) LIKE ?${i + 1} OR LOWER(body_html) LIKE ?${i + 1})`).join(' OR ');
  const params = terms.map(t => '%' + t + '%');
  const rs = await env.DB.prepare(
    `SELECT slug, title, excerpt, cover_image, body_html, published_at
     FROM posts WHERE status = 'published' AND (${ors})
     ORDER BY published_at DESC LIMIT 40`
  ).bind(...params).all();
  const rows = rs.results || [];
  const isFoodTopic = /food|dining|drink|restaurant/i.test(String(topic || ''));
  const DINING = /(restaurant|dining|eatery|steakhouse|michelin|trattoria|osteria|izakaya|omakase|tasting menu|cocktail|wine bar|food hall|brasserie|\bchef\b|\bmenu\b|cuisine)/i;
  const top = [], docs = {};
  for (const r of rows) {
    const body = htmlToText(r.body_html || '');
    const hay = (r.title || '') + ' ' + (r.excerpt || '') + ' ' + body;
    // For a dining topic keep only posts that actually discuss dining anywhere in
    // the body — so we surface the hotel post WITH a restaurant, not every hotel post.
    if (isFoodTopic && !DINING.test(hay)) continue;
    const snippet = topicSnippet(body, isFoodTopic ? DINING : /\S/) || (r.excerpt || '').slice(0, 300);
    top.push({
      id: r.slug, name: r.title || '', city: '', status: 'Article', type: topic || 'Journal',
      delivery: r.published_at ? new Date(r.published_at * 1000).toISOString().slice(0, 10) : '',
      district: false, blurb: snippet.slice(0, 700),
    });
    docs[r.slug] = {
      slug: r.slug, title: r.title || '', image: wixImagesToR2(r.cover_image) || '',
      excerpt: (r.excerpt || '').slice(0, 240),
      published_iso: r.published_at ? new Date(r.published_at * 1000).toISOString() : '',
      link: 'https://www.oftmw.com/post/' + (r.slug || '') + '/',
    };
    if (top.length >= 12) break;
  }
  return { top, docs };
}

async function handleSmartAnswer(request, env, origin) {
  const fail = (reason) => json({ answer: null, reason }, {}, env, origin);
  let body;
  try { body = await request.json(); } catch { return fail('bad_json'); }
  if (!body || typeof body !== 'object') return fail('bad_body');

  // Minimal validation — this endpoint spends money, so reject anything that
  // isn't a real resolved smart query coming from the search page.
  const q = String(body.q || '').slice(0, 200).trim();
  const facts = (body.facts && typeof body.facts === 'object') ? body.facts : null;
  // Conversation history (prior turns) for follow-up resolution — sanitized +
  // capped to the last 3 {q, answer} pairs. Empty on a fresh thread.
  const history = Array.isArray(body.history)
    ? body.history.slice(-3).map(t => ({ q: String((t && t.q) || '').slice(0, 200), answer: String((t && t.answer) || '').slice(0, 1200) })).filter(t => t.q && t.answer)
    : [];
  const count = Number(facts && facts.count) || 0;
  // Valid if we have development-project facts OR an iconic editorial list. The
  // latter lets a curation query ("best golf in california") answer purely from
  // the iconic list even when zero pipeline projects match.
  const hasIconic = !!(facts && facts.iconic && Array.isArray(facts.iconic.items) && facts.iconic.items.length);
  const hasProjects = !!(facts && Array.isArray(facts.top) && facts.top.length && count >= 1);
  if (!q || !facts || (!hasProjects && !hasIconic)) return fail('no_facts');

  if (!env.ANTHROPIC_API_KEY) return fail('no_key');

  // Compact + cap the facts so the prompt stays small and the cache key stable.
  const compact = {
    query: q,
    criteria: facts.criteria || {},
    count: count,
    sort: facts.sort || null,
    topic: facts.topic ? String(facts.topic).slice(0, 40) : null,
    place_terms: Array.isArray(facts.placeTerms) ? facts.placeTerms.slice(0, 10).map(t => String(t || '').slice(0, 40)) : null,
    place: facts.place || null,
    tallest: facts.tallest || null,
    largest: facts.largest || null,
    residences_total: facts.residencesTotal || null,
    first_delivery: facts.firstDelivery || null,
    top: facts.top.slice(0, 12).map(p => ({
      id: String(p.id || '').slice(0, 100),
      name: String(p.name || '').slice(0, 80),
      city: String(p.city || '').slice(0, 60),
      status: String(p.status || '').slice(0, 40),
      type: String(p.type || '').slice(0, 40),
      floors: p.floors || null,
      units: p.units || null,
      delivery: String(p.delivery || '').slice(0, 16),
      district: !!p.district,
      blurb: String(p.blurb || '').slice(0, 160),
      update: String(p.update || '').slice(0, 220),
    })),
    dominant_type: facts.dominantType ? {
      type: String(facts.dominantType.type || '').slice(0, 40),
      count: Number(facts.dominantType.count) || null,
      of: Number(facts.dominantType.of) || null,
      scope: String(facts.dominantType.scope || '').slice(0, 16) || null,
    } : null,
    soonest: facts.soonest ? {
      name: String(facts.soonest.name || '').slice(0, 80),
      delivery: String(facts.soonest.delivery || '').slice(0, 16),
      urgency: String(facts.soonest.urgency || '').slice(0, 24),
      status: String(facts.soonest.status || '').slice(0, 24),
    } : null,
    flagships: Array.isArray(facts.flagships) ? facts.flagships.slice(0, 3).map(f => ({
      name: String(f.name || '').slice(0, 80),
      type: String(f.type || '').slice(0, 40),
      district: !!f.district,
      blurb: String(f.blurb || '').slice(0, 200),
    })) : null,
    // "Most active firm/developer/architect" ranking, when the query asked for it.
    firm_ranking: (facts.firmRanking && typeof facts.firmRanking === 'object') ? {
      scope: String(facts.firmRanking.scope || '').slice(0, 16),
      developers: Array.isArray(facts.firmRanking.topDevelopers) ? facts.firmRanking.topDevelopers.slice(0, 5)
        .map(d => ({ name: String(d.name || '').slice(0, 80), projects: Number(d.projects) || 0 })) : [],
      architects: Array.isArray(facts.firmRanking.topArchitects) ? facts.firmRanking.topArchitects.slice(0, 5)
        .map(a => ({ name: String(a.name || '').slice(0, 80), projects: Number(a.projects) || 0 })) : [],
    } : null,
    // Iconic editorial list (curated, existing venues with descriptions).
    iconic: hasIconic ? {
      kind: String(facts.iconic.kind || '').slice(0, 16),
      count: Number(facts.iconic.count) || facts.iconic.items.length,
      items: facts.iconic.items.slice(0, 6).map(it => ({
        name: String(it.name || '').slice(0, 80),
        location: String(it.location || '').slice(0, 60),
        architect: String(it.architect || '').slice(0, 60),
        year: String(it.year || '').slice(0, 10),
        description: String(it.description || '').slice(0, 280),
      })),
    } : null,
  };

  // Learned editorial rules — written by the nightly intel-review routine so the
  // model improves as we critique past answers. Best-effort; optional.
  let learnedRules = [];
  try {
    const rr = await env.DB.prepare(
      `SELECT props_json FROM events WHERE event_name = 'intel_rules' ORDER BY ts DESC LIMIT 1`
    ).first();
    if (rr && rr.props_json) {
      const pj = JSON.parse(rr.props_json);
      if (Array.isArray(pj.rules)) learnedRules = pj.rules.filter(r => typeof r === 'string').slice(0, 25);
    }
  } catch { /* rules are optional */ }

  // Golden exemplars — a few approved answers the intel-review routine kept, fed
  // as few-shot STYLE guides (voice + structure, not facts). Best-effort; optional.
  let learnedExemplars = [];
  try {
    const er = await env.DB.prepare(
      `SELECT props_json FROM events WHERE event_name = 'intel_exemplars' ORDER BY ts DESC LIMIT 1`
    ).first();
    if (er && er.props_json) {
      const pj = JSON.parse(er.props_json);
      if (Array.isArray(pj.exemplars)) learnedExemplars = pj.exemplars.filter(e => e && e.query && e.answer).slice(0, 3);
    }
  } catch { /* exemplars are optional */ }

  const sig = await sha256Hex(SMART_ANSWER_MODEL + '|' + JSON.stringify(compact) + '|' + JSON.stringify(learnedRules) + '|' + JSON.stringify(learnedExemplars) + '|' + JSON.stringify(history));
  const cache = caches.default;
  const cacheKey = new Request('https://smart-answer.tmw.internal/' + sig, { method: 'GET' });
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const data = await hit.json();
      // Capture cache HITS too — otherwise popular repeat queries (which answer
      // from cache) never get logged and the review routine sees "no traffic".
      await logIntelAnswer(env, q, data.answer, compact);
      return json({ answer: data.answer, hero: data.hero || null, heroDoc: data.heroDoc || null, cached: true }, {}, env, origin);
    }
  } catch { /* cache miss path */ }

  // Topic answers: swap the client's thin (title/excerpt) candidates for
  // body-comprehending ones pulled from D1, so the model reads full article
  // bodies and can surface a venue mentioned deep inside an off-topic post
  // (e.g. a new restaurant inside a hotel write-up). Falls back to client facts.
  let heroDocs = {};
  if (compact.topic && env.DB && compact.place_terms && compact.place_terms.length) {
    try {
      const r = await retrieveTopicCandidates(env, compact.place_terms, compact.topic);
      if (r && r.top && r.top.length) { compact.top = r.top; heroDocs = r.docs || {}; }
    } catch { /* fall back to client-provided facts */ }
  }

  // JOURNAL-topic answers (e.g. food & drink) are synthesized from our ARTICLE
  // coverage, not the project database — TMW doesn't track restaurants as
  // projects. Switch to a journal-editor voice and point the reader at what
  // we've actually published.
  // The model also picks the single best item to feature as the headline ("hero")
  // card, so the UI's hero matches our editorial lead instead of a blunt keyword
  // rank. Appended to BOTH the journal and project system prompts.
  const HERO_DIRECTIVE =
    'AFTER the prose, on its own final line, output exactly: HERO: <id> — where <id> is the `id` of the single ' +
    'item in `top` to feature as the headline card: the FRESHEST, most relevant story for the query, NOT merely ' +
    'the most famous. Treat each item\'s `delivery` value as its recency (publish or opening date); for ' +
    '"new"/"opening"/"coming"/"latest" queries the most recently published or soonest-opening venue should win. ' +
    'Strongly prefer a brand-new or independent opening over an older, established, or chain venue even if the ' +
    'latter is splashier — e.g. a national steakhouse chain must NOT outrank a just-opened local debut, and a ' +
    'venue that has been open a while must NOT outrank one that opened in the last few weeks. Use "HERO: NONE" ' +
    'only if no single item is a strong standalone feature. Output nothing after that line.';
  let system = compact.topic ?
    ('You are TMW Intelligence, the editorial voice of Markets of Tomorrow. The query is about ' +
     compact.topic.toUpperCase() + ', which we cover in our JOURNAL — these `top` items are ARTICLES we have ' +
     'published (name = headline, blurb = excerpt, delivery = publish date), NOT database projects. Write a ' +
     'tight, insightful answer (1-3 sentences) that orients the reader to our coverage like an editor: the ' +
     'freshest / most notable openings or stories' + (compact.place ? ' in ' + String(compact.place).slice(0,60) : '') +
     ', named specifically.\n\n' +
     'Hard rules:\n' +
     '- Use ONLY the article facts provided (headlines + excerpts). Never invent a venue, dish, date, or place.\n' +
     '- These are ARTICLES, not buildings — never call them "projects", never mention floors/units/keys or a ' +
     'construction pipeline, and never say "tracked in our database".\n' +
     '- Refer to places/venues by name exactly as they appear in the headlines/excerpts.\n' +
     '- If the coverage is thin, say what we have plainly. Confident, concrete, editorial. No preamble, no ' +
     'markdown, no bullets, no lists. Output only the answer prose.') :
    'You are TMW Intelligence, the analyst voice of Markets of Tomorrow — a real-estate development ' +
    'intelligence publication with sharp editorial instincts. You are given a search query and a set of ' +
    'VERIFIED facts from our project database. Write a tight, insightful answer (1-3 sentences) that reads ' +
    'like a knowledgeable analyst briefing an editor — not a database readout.\n\n' +
    'PRE-RANKED LIST — READ FIRST: the `top` list is ALREADY ordered by our editorial priority — Featured ' +
    '(our pick) → Coming Soon → Recently Opened (last ~6 months) → Under Construction → Breaking Ground → ' +
    'Announced. `top[0]` is the intended LEAD and is the hero card the reader sees beside your answer — OPEN ' +
    'your answer on it (named, with its status), so the prose and the hero agree. Bring in `top[1]`/`top[2]` ' +
    'as supporting context. NEVER lead with a merely-ANNOUNCED or long-open project ahead of an earlier ' +
    'coming-soon / under-construction one — a far-off announcement ("may not even happen") is the weakest ' +
    'lead, not the headline. The rules below refine HOW to frame each, but do not override this order:\n' +
    '1. MOMENTUM — a project that just OPENED, just hit a major milestone (topped out / now selling), or is ' +
    'actively UNDER CONSTRUCTION is real, happening news; lead with these. They outrank anything not yet started.\n' +
    '2. IMMINENCE — an opening within the next few months (`soonest`) is a strong lead — but ONLY if it matches ' +
    'the query (right type AND place). Name it and its urgency.\n' +
    '3. TRANSFORMATION — a district-scale / mega project can be the lead, BUT honor its real status: if it is ' +
    'under construction, frame it as actively reshaping the area; if it is only ANNOUNCED / PROPOSED / ' +
    'pre-construction, frame it as PLANNED or PROPOSED ("a proposed 1,145-unit redevelopment"), NEVER as already ' +
    'underway ("remaking X into Y"). A huge but un-started project is NOT the lead over projects with real momentum. ' +
    'Pull scale specifics (acreage, cost, tower count) ONLY from that project\'s `blurb`.\n' +
    '4. PATTERN — if `dominant_type` shows the set leans one way, say so ("hotel-led", "mostly residential").\n' +
    '5. SCOPE — ground it with the count ("N tracked across {place}").\n\n' +
    'For a CITY or REGION query (a `place` is set), weave these into a short editorial OVERVIEW: how many we ' +
    'track, what the pipeline leans toward, the nearest-term opening, and the project(s) bringing the biggest ' +
    'change. Do not just name the single top match.\n\n' +
    'FIRM QUERIES: when `firm_ranking` is present, the ask is which FIRMS are most active — answer with the firms, ' +
    'not a project tour. Honor `firm_ranking.scope`: "developer" → name the single most active developer; ' +
    '"architect" → the most active architect; "both" → name the most active developer AND the most active ' +
    'architect (one of each). Use the names and `projects` counts from `firm_ranking.developers` / ' +
    '`firm_ranking.architects` (already ranked, most-active first). Lead with those firms by name; you may add a ' +
    'short line of supporting context (a notable project they\'re behind, or the pipeline lean). Never omit one of ' +
    'the two when scope is "both".\n\n' +
    'Hard rules:\n' +
    '- Use ONLY the facts provided. Never invent or infer a number, name, date, status, or place not present. ' +
    'Figures are verified, not generated.\n' +
    '- Pull descriptive specifics (cost, acreage, scale) ONLY from a project\'s `blurb`; never invent them.\n' +
    '- DOSSIER AWARENESS: a project may carry an `update` — the freshest SOURCED development from its dossier ' +
    '(e.g. "broke ground June 8, 2026; completion late 2027"). When present it is the most current, concrete fact ' +
    'we have — prefer it for specifics (recent milestone, exact date, latest count) and let it sharpen the lead. ' +
    'It is verified like every other fact: cite it, never contradict or embellish it.\n' +
    '- If there is only ONE result, state it plainly — no "tallest / largest / most".\n' +
    '- TYPE FIDELITY: a typed query (e.g. "condos") must feature only projects of that `type`. Never headline an ' +
    'off-type project (single-family houses, a hotel, etc.) even if it opens soonest.\n' +
    '- STATUS HONESTY: match your verbs to each project\'s `status`/`delivery`. Announced / proposed / future-dated ' +
    '= not yet built — say "planned"/"proposed", never present-tense "is remaking/building/opening". Reserve active, ' +
    'happening language for under-construction or already-open projects.\n' +
    '- DISTRICT HORIZON: a result with `district:true` is a multi-component master plan that delivers in ' +
    'PHASES over many years (its components open on a rolling schedule). Never treat a district\'s single ' +
    'delivery date as the whole development finishing then — describe it as phased / built out over time, or ' +
    'cite the specific component that is opening if the facts name one. A district can still be the lead per ' +
    'rule 3, but frame its timeline as phased, not a single completion.\n' +
    '- Only assert a construction milestone if the facts explicitly say so.\n' +
    '- Never say "on the map" — TMW coverage is a DATABASE of developments. Say "we track", "tracked", or "in our database".\n' +
    '- Confident, concrete, editorial. No hype-for-hype, no preamble ("Based on…"), no markdown, no bullets, ' +
    'no lists. Refer to projects by name exactly as given. Output only the answer prose.' +
    (learnedRules.length ? '\n\nLearned house rules (from editor review of past answers — apply these too):\n'
      + learnedRules.map(r => '- ' + r).join('\n') : '') +
    (learnedExemplars.length ? '\n\nExamples of excellent TMW answers — match their VOICE and STRUCTURE (how they '
      + 'lead and frame), but NEVER reuse their specific projects, numbers, or places:\n'
      + learnedExemplars.map((ex, i) => (i + 1) + '. Q: "' + ex.query + '" -> ' + ex.answer).join('\n') : '');
  // ICONIC curation queries ("best golf in florida", "good hotels in california"):
  // weave the editorial iconic picks (existing celebrated venues, with their own
  // descriptions) together with whatever is NEW in the pipeline.
  if (compact.iconic && compact.iconic.items && compact.iconic.items.length) {
    system += '\n\nICONIC EDITORIAL LIST — THIS IS THE HEART OF THE ANSWER: `iconic` is TMW\'s curated ranking of the most iconic '
      + compact.iconic.kind + ' for this query — EXISTING, celebrated venues (NOT pipeline projects), each carrying its own editorial `description`. '
      + 'Structure the answer in two beats: (1) ONLY IF `top` actually has development projects, open by noting briefly what is NEW or COMING'
      + (compact.place ? ' in ' + String(compact.place).slice(0, 60) : '') + ' — name the soonest / most notable with its status (e.g. a course or hotel opening soon); '
      + '(2) THEN spotlight the 2-3 best iconic picks in `iconic` order, naming each and what sets it apart, drawing specifics ONLY from its `description`. '
      + 'The iconic picks are the payoff — give them the most room. '
      + 'CRITICAL: if `top` is empty, just OPEN DIRECTLY on the top iconic pick — do NOT announce or explain the absence of pipeline projects. NEVER write phrases like '
      + '"no new pipeline projects", "nothing surfacing", "the field belongs to the iconic tier", or any meta-comment about what is or isn\'t in the pipeline. The reader '
      + 'never needs to hear about projects that don\'t exist; lead straight into the iconic venues as the natural answer. '
      + 'Treat `iconic` descriptions as verified facts; never invent. These iconic venues already EXIST and are celebrated — never call them "planned", '
      + '"proposed", "in the pipeline", or "tracked in our database"; reserve that language for the `top` development projects only.';
  }
  system += '\n\n' + HERO_DIRECTIVE;
  // Conversation mode: the current query may be a follow-up to the prior turns
  // (provided as earlier messages). Resolve implicit references against them.
  if (history.length) {
    system = 'This is a MULTI-TURN conversation — earlier turns appear as prior messages. The current query may be a FOLLOW-UP; '
      + 'resolve its pronouns and implicit places/types against the conversation (e.g. after "best hotels", "what about Miami?" means Miami hotels). '
      + 'Answer ONLY the new turn from its verified facts; don\'t repeat the previous answer.\n\n' + system;
  }

  let answer = null;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: SMART_ANSWER_MODEL,
        max_tokens: 700,   // was 320 — a region overview ran long and got cut mid-sentence
        system,
        messages: history.flatMap(t => ([
          { role: 'user', content: t.q },
          { role: 'assistant', content: t.answer },
        ])).concat([{ role: 'user', content: 'Query and verified facts (JSON):\n' + JSON.stringify(compact) }]),
      }),
    });
    if (!resp.ok) return fail('api_' + resp.status);
    const data = await resp.json();
    const block = Array.isArray(data.content) ? data.content.find(b => b.type === 'text') : null;
    answer = block && typeof block.text === 'string' ? block.text.trim() : null;
  } catch {
    return fail('fetch_error');
  }
  if (!answer) return fail('empty');

  // Pull the trailing "HERO: <id>" line the model appends and strip it from the
  // user-facing prose. hero = the chosen feature id (or null for NONE/absent).
  let hero = null;
  const hm = answer.match(/(?:^|\n)[ \t]*HERO:[ \t]*([^\n]+?)[ \t]*$/i);
  if (hm) {
    hero = /^none$/i.test(hm[1].trim()) ? null : hm[1].trim();
    answer = answer.slice(0, hm.index).trim();
  }
  if (!answer) return fail('empty');
  const heroDoc = (hero && heroDocs[hero]) ? heroDocs[hero] : null;

  // Cache the synthesized answer + hero pick for 24h, keyed by the fact signature.
  try {
    await cache.put(cacheKey, new Response(JSON.stringify({ answer, hero, heroDoc }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
    }));
  } catch { /* caching is best-effort */ }

  // Capture Q→A + the signals we had so the nightly intel-review routine can
  // critique sufficiency and learn. Deduped + best-effort; never blocks.
  await logIntelAnswer(env, q, answer, compact);

  return json({ answer, hero, heroDoc }, {}, env, origin);
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

// GET /intel-answers — recent TMW Intelligence answers (query + synthesized
// answer + the signals we had at the time), newest first. Feeds the nightly
// intel-review routine that critiques sufficiency and learns. Admin-only.
async function handleIntelAnswers(env, origin, url) {
  if (!env.DB) return json({ items: [] }, {}, env, origin);
  const limit = clampInt(url.searchParams.get('limit'), 60, 1, 200);
  const hours = clampInt(url.searchParams.get('hours'), 48, 0, 24 * 60);
  const minTs = hours ? (Math.floor(Date.now() / 1000) - hours * 3600) : 0;
  const rs = await env.DB.prepare(
    `SELECT ts, props_json FROM events WHERE event_name = 'intel_answer' AND ts >= ?
     ORDER BY ts DESC LIMIT ?`
  ).bind(minTs, limit).all();
  const items = (rs.results || []).map(r => {
    let p = {}; try { if (r.props_json) p = JSON.parse(r.props_json); } catch {}
    return { ts: r.ts, ...p };
  });
  return json({ total: items.length, items }, {}, env, origin);
}

// /intel-rules — GET the learned editorial rules injected into the smart-answer
// prompt; POST { rules:[..], note } replaces them (the nightly intel-review
// routine writes here). GET is admin-gated via ADMIN_READ_PATHS; POST gates here.
async function handleIntelRules(request, env, origin) {
  if (request.method === 'POST') {
    const denied = await requireAdminToken(request, env, origin);
    if (denied) return denied;
    let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
    const rules = Array.isArray(body && body.rules)
      ? body.rules.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim().slice(0, 300)).slice(0, 25)
      : null;
    if (!rules) return json({ error: 'rules array required' }, { status: 400 }, env, origin);
    try {
      await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?, ?, ?, ?)`)
        .bind(Math.floor(Date.now() / 1000), 'system:intel-review', 'intel_rules',
              JSON.stringify({ rules, note: String((body && body.note) || '').slice(0, 200) })).run();
    } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
    return json({ ok: true, count: rules.length }, {}, env, origin);
  }
  let rules = [];
  try {
    const rr = await env.DB.prepare(`SELECT props_json FROM events WHERE event_name = 'intel_rules' ORDER BY ts DESC LIMIT 1`).first();
    if (rr && rr.props_json) { const pj = JSON.parse(rr.props_json); if (Array.isArray(pj.rules)) rules = pj.rules; }
  } catch {}
  return json({ rules }, {}, env, origin);
}

// /intel-exemplars — GET the golden-answer exemplars fed as few-shot style
// guides into the smart-answer prompt; POST { exemplars:[{query,answer}], note }
// replaces them (the intel-review routine writes here). GET admin-gated via
// ADMIN_READ_PATHS; POST gates here.
async function handleIntelExemplars(request, env, origin) {
  if (request.method === 'POST') {
    const denied = await requireAdminToken(request, env, origin);
    if (denied) return denied;
    let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
    const exemplars = Array.isArray(body && body.exemplars)
      ? body.exemplars
          .filter(e => e && typeof e.query === 'string' && typeof e.answer === 'string' && e.query.trim() && e.answer.trim())
          .map(e => ({ query: e.query.trim().slice(0, 160), answer: e.answer.trim().slice(0, 600) }))
          .slice(0, 5)
      : null;
    if (!exemplars) return json({ error: 'exemplars array required' }, { status: 400 }, env, origin);
    try {
      await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?, ?, ?, ?)`)
        .bind(Math.floor(Date.now() / 1000), 'system:intel-review', 'intel_exemplars',
              JSON.stringify({ exemplars, note: String((body && body.note) || '').slice(0, 200) })).run();
    } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
    return json({ ok: true, count: exemplars.length }, {}, env, origin);
  }
  let exemplars = [];
  try {
    const rr = await env.DB.prepare(`SELECT props_json FROM events WHERE event_name = 'intel_exemplars' ORDER BY ts DESC LIMIT 1`).first();
    if (rr && rr.props_json) { const pj = JSON.parse(rr.props_json); if (Array.isArray(pj.exemplars)) exemplars = pj.exemplars; }
  } catch {}
  return json({ exemplars }, {}, env, origin);
}

// ── Member gamification — XP / levels / stats (Phase 1) ──────────────────────
// XP is computed live from the event log (the events table is the ledger); no
// member XP column or migration needed. Writes ride normal events.
const GAME_LEVELS = [
  { lvl: 1, tier: 'Reader', xp: 0 }, { lvl: 2, tier: 'Member', xp: 300 },
  { lvl: 3, tier: 'Local', xp: 900 }, { lvl: 4, tier: 'Insider', xp: 1800 },
  { lvl: 5, tier: 'Tastemaker', xp: 3000 }, { lvl: 6, tier: 'Curator', xp: 5500 },
  { lvl: 7, tier: 'Authority', xp: 10000 }, { lvl: 8, tier: 'Luminary', xp: 18000 },
];
function levelForXp(xp) { let c = GAME_LEVELS[0]; for (const L of GAME_LEVELS) { if (xp >= L.xp) c = L; } return c; }
function _gameStreak(daySet) {
  if (!daySet.size) return 0;
  const today = Math.floor(Date.now() / 1000 / 86400);
  if (!daySet.has(today) && !daySet.has(today - 1)) return 0;
  let d = daySet.has(today) ? today : today - 1, s = 0;
  while (daySet.has(d)) { s++; d--; } return s;
}
function _reachStr(n) { n = Number(n) || 0; return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n); }

// Member registry — sequential member numbers, assigned once per member_id.
// The founder email is always #001; everyone else takes the next number from
// #002 up (so #001 stays reserved). Founding status = the first 50.
const FOUNDER_EMAIL = 'jakenicholas.mgmt@gmail.com';
async function ensureMembersTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS members (
    member_id TEXT PRIMARY KEY, email TEXT, member_no INTEGER,
    joined_at INTEGER, founding INTEGER DEFAULT 0, market TEXT)`).run();
}
async function ensureMemberRecord(env, memberId, email, joinedTs) {
  // Anonymous, logged-out visitors carry an `anon:<device-id>` id. They must
  // NOT consume a member number — only real Memberstack accounts (`mem_*`) get
  // a registry seat. (Anon visitors were silently burning founding numbers.)
  if (!memberId || String(memberId).indexOf('anon:') === 0) return null;
  try { await ensureMembersTable(env); } catch { return null; }
  try {
    let row = await env.DB.prepare('SELECT member_no, joined_at, founding, market FROM members WHERE member_id = ?').bind(memberId).first();
    if (row) return row;
    // Only a real Memberstack account (mem_*) earns a NEW registry seat. Bots,
    // crawlers, and server-side callers (e.g. /smart-answer traffic with a stray
    // id) must NOT consume a founding number — they were silently burning the
    // first 50 seats. People get a founding number only by creating an account.
    if (String(memberId).indexOf('mem_') !== 0) return null;
    let no;
    if (email && email.toLowerCase() === FOUNDER_EMAIL) no = 1;
    else { const mx = await env.DB.prepare('SELECT MAX(member_no) AS m FROM members').first(); no = Math.max(1, (mx && mx.m) || 1) + 1; }
    const joined = joinedTs || Math.floor(Date.now() / 1000);
    await env.DB.prepare('INSERT OR IGNORE INTO members (member_id, email, member_no, joined_at, founding, market) VALUES (?,?,?,?,?,?)')
      .bind(memberId, email || null, no, joined, no <= 50 ? 1 : 0, null).run();
    row = await env.DB.prepare('SELECT member_no, joined_at, founding, market FROM members WHERE member_id = ?').bind(memberId).first();
    return row || { member_no: no, joined_at: joined, founding: no <= 50 ? 1 : 0, market: null };
  } catch { return null; }
}

// Admin: assign / swap member registry numbers. (Registry rows often have a
// null email — it's only backfilled from a member's events — so number lookups
// are the reliable key.)
//   GET  ?number=N         → inspect the row at #N (dry run)
//   GET  ?email=…          → inspect row(s) for that email
//   POST { from, to, email? } → SWAP #from and #to (the row at #from lands on
//                            #to). Optional email is stamped on the row that
//                            ends at #to (handy to backfill a null-email row).
//   POST { email, number } → assign #number to the member with that email,
//                            swapping with the current holder.
// `founding` (member_no <= 50) is recomputed for every moved row. D1 batch =
// atomic. Admin-token gated; #001 stays the founder.
// GET /m/<no> — public membership verification page. The QR code on the
// member card encodes this URL, so scanning a card lands here and confirms the
// holder is a genuine Markets of TMW member. No PII is shown — only the public
// facts (member number, founding status, join year). Returns 404-styled page
// for numbers we don't have on file. Optional ?t=<sig> is accepted for a future
// signed/expiring token (verified when present) but not yet required.
async function handleMemberVerify(env, url) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const no = parseInt(url.pathname.split('/')[2] || '0', 10);
  let row = null, name = null;
  try {
    if (env.DB && no > 0) {
      row = await env.DB.prepare('SELECT member_id, member_no, joined_at, founding FROM members WHERE member_no = ?')
        .bind(no).first();
      if (row && row.member_id) {
        const nm = await env.DB.prepare(
          'SELECT member_name FROM events WHERE member_id = ? AND member_name IS NOT NULL AND member_name != "" ORDER BY ts DESC LIMIT 1'
        ).bind(row.member_id).first();
        if (nm && nm.member_name) name = nm.member_name;
      }
    }
  } catch (_) { row = null; }

  // Optional signed token: if a ?t= is supplied, verify it; an invalid token
  // downgrades the page to "unverified" even if the number exists, so a forged
  // token can't pass. Absent token = legacy/plain link, still allowed for now.
  let tokenState = 'none';
  const t = url.searchParams.get('t');
  if (t) {
    const secret = previewSecret(env);
    const payload = await verifyPayload(t, secret).catch(() => null);
    tokenState = payload && Number(payload.no) === no ? 'valid' : 'invalid';
  }

  const ok = !!row && tokenState !== 'invalid';
  const noStr = String(no || 0).padStart(3, '0');
  const founding = row ? (row.founding ? true : no <= 50) : false;
  let year = null;
  try { if (row && row.joined_at) year = new Date(row.joined_at).getFullYear(); } catch (_) {}
  // Founder/early rows can carry an epoch-0 join date (→ 1970); fall back to the
  // launch year so the verify page matches the card's "SINCE 2026".
  if (!year || year < 2025) year = 2026;
  const line = ok
    ? `MEMBER No.&nbsp;${noStr} &middot; SINCE ${year}`
    : 'This membership could not be verified.';
  const statusWord = ok ? 'VERIFIED' : 'NOT FOUND';
  const accent = ok ? '#34d27b' : '#e0696a';

  // Faint full-page market-code field — the same texture as the member card,
  // dropped behind everything at very low opacity.
  const BG = ['LAX','WPB','LON','MIA','NYC','TYO','CHI','SLC','AUS','BNA','PAR','DXB','HKG','SIN','MIL','ASP','SFO','BOS','SEA','DFW','ATL','DEN','LAS','GVA','ZRH','MAD','ROM','SYD','DOH','SJD','JFK','LHR','CDG','HND','ORD','PBI','NAS','PHX','SAN','AUH','IST','BCN','VCE','MUC','AMS','VIE','CPH','DUB','MEX','SCL','BOM','DEL','BKK','ICN','PEK','MEL','CPT','TLV','RUH','JED','YYZ','YVR','HNL','MCO','NCE','LIS','ATH','PRG','KEF','NAP','MNL'];
  let bgSeed = 7; const bgRnd = () => { bgSeed = (bgSeed * 1103515245 + 12345) & 0x7fffffff; return bgSeed / 0x7fffffff; };
  let bg = '';
  for (let r = 0; r < 60; r++) { let ln = ''; for (let c = 0; c < 46; c++) ln += BG[Math.floor(bgRnd() * BG.length)] + ' '; bg += ln + '\n'; }

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${ok ? 'Member No. ' + noStr : 'Membership'} &middot; Markets of TMW</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;position:relative;overflow:hidden;
  background:repeating-linear-gradient(122deg,rgba(255,255,255,.012) 0 1px,transparent 1px 3px),radial-gradient(120% 130% at 30% 0%,#161618 0%,#0a0a0c 55%,#050506 100%);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#ECEAE5}
.bg{position:fixed;inset:-2% -2% auto -2%;margin:0;z-index:0;pointer-events:none;white-space:pre;overflow:hidden;
  font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;line-height:1.7;letter-spacing:.5px;color:rgba(228,230,234,.04)}
.card{position:relative;z-index:1;overflow:hidden;width:100%;max-width:420px;text-align:center;background:rgba(9,9,11,.92);
  border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:38px 30px;
  box-shadow:0 24px 70px rgba(0,0,0,.65),inset 0 0 80px rgba(0,0,0,.6)}
.card::before{content:"";position:absolute;top:-35%;left:-95%;width:75%;height:170%;z-index:3;pointer-events:none;transform:skewX(-20deg);filter:blur(13px);background:linear-gradient(90deg,transparent,rgba(255,255,255,.04) 28%,rgba(255,255,255,.18) 50%,rgba(255,255,255,.04) 72%,transparent);animation:cardGlare 7s ease-in-out infinite}
@keyframes cardGlare{0%{left:-95%}40%{left:155%}100%{left:155%}}
.logo{height:34px;margin:0 auto 22px;display:block;filter:brightness(0) invert(1)}
.status{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:700;
  letter-spacing:.28em;color:${accent};margin-bottom:18px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:${accent};margin-right:8px;vertical-align:middle}
.name{font-family:Georgia,'Times New Roman',serif;font-size:40px;font-weight:600;line-height:1.05;color:#fff;letter-spacing:.01em;margin:0 0 8px}
.sub{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#9AA39C;margin-bottom:24px}
.pill{display:inline-block;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:700;
  letter-spacing:.24em;color:#e6c574;background:transparent;border:1px solid rgba(230,197,116,.55);border-radius:9px;padding:8px 18px}
.foot{margin-top:26px;font-size:12px;color:#6b6f74}
.foot a{color:#e6c574;text-decoration:none}
</style></head>
<body>
  <pre class="bg" aria-hidden="true">${bg}</pre>
  <div class="card">
    <img class="logo" src="https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/other/16f511-MARKETSOFTMW.svg" alt="Markets of TMW">
    <div class="status"><span class="dot"></span>${statusWord}</div>
    ${ok ? `<div class="name">${name ? esc(name) : 'No.&nbsp;' + noStr}</div>` : `<div class="name" style="font-size:30px">&mdash;</div>`}
    <div class="sub">${line}</div>
    ${ok ? '<span class="pill">PRO</span>' : ''}
    <div class="foot">${ok ? 'A verified member of <a href="https://oftmw.com">Markets of Tomorrow</a>.' : 'Visit <a href="https://oftmw.com">oftmw.com</a> to learn more.'}</div>
  </div>
</body></html>`;

  return new Response(page, {
    status: ok ? 200 : 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// GET /admin/markets-followed — distinct members following each Focus Market,
// aggregated from `market_followed` events. NOTE: follows are append-only (the
// client fires market_followed on follow but there's no market_unfollowed
// event), so this is "members who have followed each market," not a net-current
// count. Powers the analytics "Members by Market" breakdown.
async function handleMarketsFollowed(req, env, origin) {
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  const rows = (await env.DB.prepare(
    "SELECT member_id, props_json FROM events WHERE event_name = 'market_followed'"
  ).all()).results || [];
  // Canonicalize stray / legacy market slugs onto their real Focus Market.
  // Some market_followed events carry a project-ish slug instead of the market
  // itself (e.g. "miami-beach-residences" should count as Miami Beach). Fold
  // them in here so the breakdown shows clean markets. Extend as needed.
  const MARKET_ALIAS = { 'miami-beach-residences': 'miami-beach' };
  const byMarket = new Map(); // market slug -> Set(member_id)
  for (const r of rows) {
    if (!r.member_id) continue;
    let p = {}; try { p = JSON.parse(r.props_json || '{}'); } catch { /* skip */ }
    const raw = String(p.market || '').trim().toLowerCase();
    if (!raw) continue;
    const m = MARKET_ALIAS[raw] || raw;
    if (!byMarket.has(m)) byMarket.set(m, new Set());
    byMarket.get(m).add(r.member_id);
  }
  const markets = [...byMarket.entries()]
    .map(([market, set]) => ({ market, followers: set.size }))
    .sort((a, b) => b.followers - a.followers);
  return json({
    markets,
    total_markets: markets.length,
    total_follows: markets.reduce((s, m) => s + m.followers, 0),
  }, {}, env, origin);
}

async function handleMemberNumber(req, env, origin, url) {
  const denied = await requireAdminToken(req, env, origin);
  if (denied) return denied;
  if (!env.DB) return json({ error: 'D1 not configured' }, { status: 500 }, env, origin);
  await ensureMembersTable(env);
  const COLS = 'member_id, email, member_no, founding, joined_at';
  const byNo = (n) => env.DB.prepare(`SELECT ${COLS} FROM members WHERE member_no = ?`).bind(n).first();
  const byId = (id) => env.DB.prepare(`SELECT ${COLS} FROM members WHERE member_id = ?`).bind(id).first();
  const fnd = (n) => (n <= 50 ? 1 : 0);

  if (req.method !== 'POST') {
    // ?list=1 → registry overview: what's taken, what's open, where new numbers start.
    if (url.searchParams.get('list') || url.searchParams.get('summary')) {
      const rows = (await env.DB.prepare('SELECT member_no, email, member_id FROM members ORDER BY member_no ASC').all()).results || [];
      const taken = rows.map(r => r.member_no).filter(n => Number.isInteger(n));
      const set = new Set(taken);
      const max = taken.length ? Math.max(...taken) : 0;
      const openBelowMax = [], foundingOpen = [];
      for (let i = 1; i <= max; i++) if (!set.has(i)) openBelowMax.push(i);
      for (let i = 1; i <= 50; i++) if (!set.has(i)) foundingOpen.push(i);
      return json({
        mode: 'list',
        total_members: rows.length,
        highest_assigned: max,
        next_auto_assigned: max + 1,        // new signups get MAX(member_no)+1
        founding_threshold: 50,             // member_no <= 50 = Founding Member
        founding_taken: taken.filter(n => n <= 50).length,
        founding_open: foundingOpen,        // free numbers within #001–#050
        open_below_max: openBelowMax,       // gaps you could hand-assign
        placeholders: rows.filter(r => !r.email).map(r => ({ member_no: r.member_no, member_id: r.member_id })),
        roster: rows.map(r => ({ member_no: r.member_no, email: r.email || null, member_id: r.member_id })),
        occupied: taken
      }, {}, env, origin);
    }
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    const n = url.searchParams.get('number');
    const number = (n != null) ? parseInt(n, 10) : null;
    const byEmail = email ? ((await env.DB.prepare(`SELECT ${COLS} FROM members WHERE LOWER(email) = ? ORDER BY member_no ASC`).bind(email).all()).results || []) : [];
    return json({ mode: 'inspect', email: email || null, number: (number >= 1) ? number : null,
      by_email: byEmail, at_number: (number >= 1) ? (await byNo(number)) : null }, {}, env, origin);
  }

  let body; try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, { status: 400 }, env, origin); }
  const from = (body.from != null) ? parseInt(body.from, 10) : null;
  const to = (body.to != null) ? parseInt(body.to, 10) : null;
  const stampEmail = body.email ? String(body.email).trim().toLowerCase() : null;

  // ── Mode 0: delete a junk row by number (frees that seat). Safe by default —
  //    refuses a row that has an email (a real member) unless { force:true }.
  if (body.delete_number != null) {
    const dn = parseInt(body.delete_number, 10);
    if (!(dn >= 1)) return json({ error: 'delete_number must be >= 1' }, { status: 400 }, env, origin);
    const row = await byNo(dn);
    if (!row) return json({ error: `no member at #${dn}` }, { status: 404 }, env, origin);
    if (row.email && !body.force) return json({ error: `#${dn} belongs to a real member (${row.email}); pass force:true to delete anyway`, row }, { status: 409 }, env, origin);
    await env.DB.prepare('DELETE FROM members WHERE member_no = ?').bind(dn).run();
    return json({ ok: true, deleted: row, note: 'seat freed — the auto-assigner never backfills gaps, so it stays open until you hand-assign it' }, {}, env, origin);
  }

  // ── Mode 1: direct number swap (#from ↔ #to) ──
  if (from >= 1 && to >= 1) {
    if (from === to) return json({ error: 'from and to are the same' }, { status: 400 }, env, origin);
    const rowFrom = await byNo(from);
    const rowTo = await byNo(to);
    if (!rowFrom) return json({ error: `no member at #${from}` }, { status: 404 }, env, origin);
    const before = { from: rowFrom, to: rowTo || null };
    const stmts = [
      stampEmail
        ? env.DB.prepare('UPDATE members SET member_no = ?, founding = ?, email = ? WHERE member_id = ?').bind(to, fnd(to), stampEmail, rowFrom.member_id)
        : env.DB.prepare('UPDATE members SET member_no = ?, founding = ? WHERE member_id = ?').bind(to, fnd(to), rowFrom.member_id),
    ];
    if (rowTo) stmts.push(env.DB.prepare('UPDATE members SET member_no = ?, founding = ? WHERE member_id = ?').bind(from, fnd(from), rowTo.member_id));
    await env.DB.batch(stmts);
    return json({ ok: true, swapped: !!rowTo, before,
      after: { at_to: await byId(rowFrom.member_id), at_from: rowTo ? await byId(rowTo.member_id) : null } }, {}, env, origin);
  }

  // ── Mode 2: assign #number to the member with this email ──
  const email = body.email ? String(body.email).trim().toLowerCase() : '';
  const number = (body.number != null) ? parseInt(body.number, 10) : null;
  if (!email || !(number >= 1)) return json({ error: 'provide { from, to } to swap numbers, or { email, number } to assign' }, { status: 400 }, env, origin);
  let target = await env.DB.prepare(`SELECT ${COLS} FROM members WHERE LOWER(email) = ? ORDER BY member_no ASC`).bind(email).first();
  // Not in the registry yet (e.g. they've never opened their account, so no seat
  // was auto-assigned). Look the account up in Memberstack by email and mint a
  // seat for it, then proceed — so you can hand-assign a number sight-unseen.
  if (!target) {
    let all = [];
    try { all = await msFetchAllMembers(env); } catch (e) {
      return json({ error: 'not in registry and Memberstack lookup failed: ' + (e && e.message || e), email }, { status: 502 }, env, origin);
    }
    const hit = all.find(m => String(
      (m.auth && m.auth.email) || m.email ||
      (m.customFields && (m.customFields.email || m.customFields['email-address'])) || ''
    ).trim().toLowerCase() === email);
    if (!hit) return json({ error: 'no member with that email in the registry or Memberstack', email }, { status: 404 }, env, origin);
    await ensureMemberRecord(env, hit.id, email, null);
    target = await byId(hit.id);
  }
  if (!target) return json({ error: 'could not create a registry seat for that member', email }, { status: 500 }, env, origin);
  if (target.member_no === number) return json({ ok: true, noop: true, message: 'already #' + number, target }, {}, env, origin);
  const holder = await byNo(number);
  const before = { target, holder: holder || null };
  const targetOld = target.member_no;
  const stmts = [env.DB.prepare('UPDATE members SET member_no = ?, founding = ? WHERE member_id = ?').bind(number, fnd(number), target.member_id)];
  if (holder) stmts.push(env.DB.prepare('UPDATE members SET member_no = ?, founding = ? WHERE member_id = ?').bind(targetOld, fnd(targetOld), holder.member_id));
  await env.DB.batch(stmts);
  return json({ ok: true, swapped: !!holder, before,
    after: { target: await byId(target.member_id), holder: holder ? await byId(holder.member_id) : null } }, {}, env, origin);
}

async function computeMemberGameStats(env, memberId) {
  const rs = await env.DB.prepare(
    `SELECT event_name, ts, member_name, email, path, props_json FROM events WHERE member_id = ? LIMIT 20000`
  ).bind(memberId).all();
  const rows = rs.results || [];
  const arts = new Set(), saved = new Set(), markets = new Set(), days = new Set();
  let visits = 0, reach = 0, shares = 0, feedback = 0, intel = 0, cSub = 0, cAcc = 0, comments = 0, name = null, email = null, earliest = null;
  for (const r of rows) {
    let p = {}; try { if (r.props_json) p = JSON.parse(r.props_json); } catch {}
    if (r.member_name && !name) name = r.member_name;
    if (r.email && !email) email = r.email;
    if (r.ts) { days.add(Math.floor(r.ts / 86400)); if (earliest === null || r.ts < earliest) earliest = r.ts; }
    const path = r.path || '';
    switch (r.event_name) {
      case 'page_view': if (/^\/(journal\/)?post\//.test(path)) arts.add(path.replace(/\/+$/, '')); break;
      case 'favorite_added': saved.add(p.slug || p.project_slug || path || ('f' + saved.size)); break;
      case 'favorite_removed': saved.delete(p.slug || p.project_slug || path); break;
      case 'market_followed': if (p.market) markets.add(String(p.market).toLowerCase()); break;
      case 'partner_checkin': visits++; break;
      case 'share_posted': shares++; reach += Number(p.reach) || 0; break;
      case 'article_feedback': feedback++; break;
      case 'comment_posted': comments++; break;
      case 'contribution': cSub++; if (p.status === 'accepted') cAcc++; break;
      case 'contribution_accepted': cAcc++; break;
      case 'intel_query': intel++; break;
    }
  }
  const streak = _gameStreak(days);
  const a = arts.size, sv = saved.size, mk = markets.size;
  let xp = a * 10 + sv * 5 + mk * 25 + visits * 500 + shares * 50 + feedback * 20 + comments * 10 + intel * 2 + cSub * 25 + cAcc * 150 + streak * 10;
  xp += Math.floor(streak / 7) * 50;   // +50 bonus for every full week kept
  const rec = await ensureMemberRecord(env, memberId, email, earliest);
  // achievements — unlock + bonus XP
  const ach = {
    founding: !!(rec && rec.founding),
    reader: a >= 30,
    globetrotter: mk >= 5,
    tastemaker: reach >= 50000,
    centurion: visits >= 25,
    contributor: cAcc >= 1
  };
  xp += (ach.founding ? 100 : 0) + (ach.globetrotter ? 150 : 0) + (ach.centurion ? 250 : 0) + (ach.tastemaker ? 300 : 0) + (ach.contributor ? 200 : 0);
  const lvl = levelForXp(xp);
  return { name, xp, level: lvl.lvl, tier: lvl.tier,
    memberNo: rec ? rec.member_no : null,
    since: (rec && rec.joined_at) ? new Date(rec.joined_at * 1000).getUTCFullYear() : null,
    founding: !!(rec && rec.founding), market: (rec && rec.market) || null, achievements: ach,
    stats: { articles: a, markets: mk, visits, reach: _reachStr(reach), streak, saved: sv, comments } };
}

// GET /member-lists?id= — a member's watchlist (tracked projects) + saved/read
// articles, for the account dashboard tabs. Computed from their event log.
async function handleMemberLists(env, origin, url) {
  if (!env.DB) return json({ watchlist: [], saved: [] }, {}, env, origin);
  const id = String(url.searchParams.get('id') || '').slice(0, 120);
  if (!id) return json({ error: 'id required' }, { status: 400 }, env, origin);
  try {
    const rs = await env.DB.prepare(`SELECT event_name, ts, path, props_json FROM events WHERE member_id = ? ORDER BY ts DESC LIMIT 5000`).bind(id).all();
    const rows = rs.results || [];
    let watch = null; const favs = new Set(), removed = new Set(), arts = [], seen = new Set();
    for (const r of rows) {
      let p = {}; try { if (r.props_json) p = JSON.parse(r.props_json); } catch {}
      if (r.event_name === 'watchlist_snapshot' && !watch) {
        const list = p.slugs || p.watchlist || p.projects || p.items;
        if (Array.isArray(list)) watch = list.map(x => typeof x === 'string' ? { slug: x } : { slug: x.slug || x.Slug, title: x.title || x.Title, city: x.city || x.City }).filter(x => x.slug);
      }
      if (r.event_name === 'favorite_added') { const s = p.slug || p.project_slug; if (s) favs.add(s); }
      if (r.event_name === 'favorite_removed') { const s = p.slug || p.project_slug; if (s) removed.add(s); }
      if (r.event_name === 'page_view') {
        const path = r.path || '';
        if (/^\/(journal\/)?post\//.test(path)) {
          const slug = path.replace(/\/+$/, '').replace(/^.*\/post\//, '');
          if (slug && slug.indexOf('/') < 0 && !seen.has(slug) && arts.length < 40) { seen.add(slug); arts.push({ slug, title: p.title || null, ts: r.ts }); }
        }
      }
    }
    if (!watch) watch = [...favs].filter(s => !removed.has(s)).map(s => ({ slug: s }));
    return json({ watchlist: watch || [], saved: arts }, {}, env, origin);
  } catch (e) { return json({ error: 'lists: ' + e.message }, { status: 500 }, env, origin); }
}

// GET /member-stats?id=<memberId> — a member's own XP/level/stats for the account
// dashboard. Public-by-id (non-sensitive gamification data); session-bind later.
async function handleMemberStats(env, origin, url) {
  if (!env.DB) return json({ error: 'no db' }, { status: 500 }, env, origin);
  const id = String(url.searchParams.get('id') || '').slice(0, 120);
  if (!id) return json({ error: 'id required' }, { status: 400 }, env, origin);
  try { return json(await computeMemberGameStats(env, id), {}, env, origin); }
  catch (e) { return json({ error: 'stats: ' + e.message }, { status: 500 }, env, origin); }
}

// POST /article-feedback { member_id, slug, note, member_name? } — a member's
// private note on an article (editorial signal + XP). Logged as an event.
async function handleArticleFeedback(request, env, origin) {
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
  const id = String((b && b.member_id) || '').slice(0, 120), slug = String((b && b.slug) || '').slice(0, 200), note = String((b && b.note) || '').trim().slice(0, 2000);
  if (!id || !slug || note.length < 2) return json({ error: 'member_id, slug, note required' }, { status: 400 }, env, origin);
  try {
    await env.DB.prepare(`INSERT INTO events (ts, member_id, member_name, event_name, path, props_json) VALUES (?,?,?,?,?,?)`)
      .bind(Math.floor(Date.now() / 1000), id, (b && b.member_name) || null, 'article_feedback', '/post/' + slug, JSON.stringify({ slug, note })).run();
  } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
  return json({ ok: true, xp: 20 }, {}, env, origin);
}

// POST /contribution { member_id, type:'edit'|'add', target?, payload, member_name? }
// — a member's suggested DB edit/addition. Lands as a pending event for review.
async function handleContribution(request, env, origin) {
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
  const id = String((b && b.member_id) || '').slice(0, 120), type = ((b && b.type) === 'add' ? 'add' : 'edit');
  const payload = String((b && (b.payload || b.note)) || '').trim().slice(0, 4000), target = String((b && b.target) || '').slice(0, 200);
  if (!id || payload.length < 3) return json({ error: 'member_id and payload required' }, { status: 400 }, env, origin);
  try {
    await env.DB.prepare(`INSERT INTO events (ts, member_id, member_name, event_name, props_json) VALUES (?,?,?,?,?)`)
      .bind(Math.floor(Date.now() / 1000), id, (b && b.member_name) || null, 'contribution', JSON.stringify({ type, target, payload, status: 'pending' })).run();
  } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
  return json({ ok: true, status: 'pending', xp: type === 'add' ? 50 : 25 }, {}, env, origin);
}

// ── Article comments — Reader-level (lvl≥2) members publish; everyone reads ──
function ensureCommentsTable(env) {
  return env.DB.prepare(`CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_slug TEXT, member_id TEXT, member_name TEXT, body TEXT, ts INTEGER, status TEXT DEFAULT 'visible')`).run();
}
// GET /comments?post=<slug> — visible comments for a post, newest first. Public.
async function handleGetComments(env, origin, url) {
  if (!env.DB) return json({ comments: [] }, {}, env, origin);
  const slug = String(url.searchParams.get('post') || '').slice(0, 200);
  if (!slug) return json({ error: 'post required' }, { status: 400 }, env, origin);
  try {
    await ensureCommentsTable(env);
    const rs = await env.DB.prepare(`SELECT id, member_name, body, ts FROM comments WHERE post_slug = ? AND status = 'visible' ORDER BY ts DESC LIMIT 200`).bind(slug).all();
    return json({ comments: (rs.results || []).map(r => ({ id: r.id, name: r.member_name || 'Member', body: r.body, ts: r.ts })) }, {}, env, origin);
  } catch (e) { return json({ error: 'comments: ' + e.message }, { status: 500 }, env, origin); }
}
// POST /comment { member_id, post, body, member_name? } — publish a comment.
// Server gate: Reader level (lvl≥2) — open to ANY member, free or paid. XP is
// earned from activity by everyone, so a free account can climb to Reader.
async function handlePostComment(request, env, origin) {
  if (!env.DB) return json({ error: 'no db' }, { status: 500 }, env, origin);
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
  const id = String((b && b.member_id) || '').slice(0, 120);
  const slug = String((b && b.post) || '').slice(0, 200);
  const body = String((b && b.body) || '').replace(/[<>]/g, '').trim().slice(0, 1500);
  const name = String((b && b.member_name) || '').trim().slice(0, 80) || null;
  if (!id || !slug || body.length < 2) return json({ error: 'member_id, post, body required' }, { status: 400 }, env, origin);
  try {
    await ensureCommentsTable(env);
    let lvl = 1; try { const st = await computeMemberGameStats(env, id); lvl = (st && st.level) || 1; } catch {}
    if (lvl < 2) return json({ error: 'level', message: 'Reach Reader level to comment.' }, { status: 403 }, env, origin);
    const ts = Math.floor(Date.now() / 1000);
    const res = await env.DB.prepare(`INSERT INTO comments (post_slug, member_id, member_name, body, ts, status) VALUES (?,?,?,?,?, 'visible')`).bind(slug, id, name, body, ts).run();
    try { await env.DB.prepare(`INSERT INTO events (ts, member_id, member_name, event_name, path, props_json) VALUES (?,?,?,?,?,?)`).bind(ts, id, name, 'comment_posted', '/post/' + slug, JSON.stringify({ slug })).run(); } catch {}
    const cid = (res && res.meta && res.meta.last_row_id) || null;
    return json({ ok: true, comment: { id: cid, name: name || 'Member', body, ts } }, {}, env, origin);
  } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
}

// ═══════════════════════ GIVEAWAYS ═══════════════════════
// Public: list active giveaways + enter (free-member-gated, client-side).
// Admin: CRUD + entry export. Entrants are added to the Resend newsletter
// audience (RESEND_AUDIENCE_ID) — entering grows the list. Best-effort: a
// Resend failure never blocks the recorded entry.
const GIVEAWAY_R2 = 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/';
async function ensureGiveawayTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS giveaways (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, prize TEXT, sponsor TEXT, image TEXT,
    status TEXT NOT NULL DEFAULT 'active', sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS giveaway_entries (
    id TEXT PRIMARY KEY, giveaway_id TEXT NOT NULL, member_id TEXT, email TEXT NOT NULL,
    name TEXT, created_at INTEGER NOT NULL)`).run();
  // One entry per email per giveaway (case-insensitive via stored lowercase email).
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gvwy_entry_uniq ON giveaway_entries(giveaway_id, email)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gvwy_entry_gid ON giveaway_entries(giveaway_id)`).run();
  // Seed the two launch giveaways once (real media reused from the site). Editable
  // in the Studio Giveaways tab afterward; INSERT OR IGNORE keeps edits sticky.
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT OR IGNORE INTO giveaways (id,title,prize,sponsor,image,status,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind('gv-field-of-greens-50', 'Field of Greens', '$50 Gift Card', 'Field of Greens', GIVEAWAY_R2 + 'ca3b83_2e0943a14bc14c03b1c73af9ea4af442~mv2.jpeg', 'active', 10, now, now).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO giveaways (id,title,prize,sponsor,image,status,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind('gv-locos-100', 'Loco Taqueria & Oyster Bar', '$100 Gift Card', 'Loco Taqueria & Oyster Bar', GIVEAWAY_R2 + 'ca3b83_00ef66d49f2944ec803dde9525ba3fa3~mv2.jpg', 'active', 20, now, now).run();
}

// Best-effort: add an entrant's email to the Resend newsletter audience.
async function addToResendAudience(env, email, name) {
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID || !email) return;
  const parts = String(name || '').trim().split(/\s+/);
  const first = parts.shift() || '';
  const last = parts.join(' ');
  try {
    await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, first_name: first, last_name: last, unsubscribed: false }),
    });
    // 200 (added) / 409 / 422 (already a contact) are all fine — never throw.
  } catch (_) { /* best-effort — entry already recorded */ }
}

function giveawayRow(g, entries) {
  return { id: g.id, title: g.title, prize: g.prize || '', sponsor: g.sponsor || '', image: g.image || '', status: g.status, sort: g.sort, entries: entries || 0 };
}

// GET /giveaways — public list of ACTIVE giveaways (with live entry counts).
async function handleGiveawaysList(env, origin) {
  if (!env.DB) return json({ giveaways: [] }, {}, env, origin);
  try {
    await ensureGiveawayTables(env);
    const rs = await env.DB.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id = g.id) AS entries
       FROM giveaways g WHERE g.status = 'active' ORDER BY g.sort ASC, g.created_at ASC`).all();
    return json({ giveaways: (rs.results || []).map(g => giveawayRow(g, g.entries)) }, {}, env, origin);
  } catch (e) { return json({ error: 'giveaways: ' + e.message }, { status: 500 }, env, origin); }
}

// POST /giveaway-enter { giveaway_id, member_id, email, name? } — record an entry.
// Requires a member_id (a free account); the page gates this behind auth. One
// entry per email per giveaway. Adds the email to the Resend newsletter audience.
async function handleGiveawayEnter(request, env, origin) {
  if (!env.DB) return json({ error: 'no db' }, { status: 500 }, env, origin);
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
  const gid = String((b && b.giveaway_id) || '').slice(0, 120);
  const mid = String((b && b.member_id) || '').slice(0, 120);
  const email = String((b && b.email) || '').trim().toLowerCase().slice(0, 200);
  const name = String((b && b.name) || '').trim().slice(0, 120) || null;
  if (!gid || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'giveaway_id and a valid email are required' }, { status: 400 }, env, origin);
  if (!mid) return json({ error: 'account', message: 'Create a free account to enter.' }, { status: 403 }, env, origin);
  try {
    await ensureGiveawayTables(env);
    const gv = await env.DB.prepare(`SELECT id, title, status FROM giveaways WHERE id = ?`).bind(gid).first();
    if (!gv) return json({ error: 'not_found', message: 'That giveaway no longer exists.' }, { status: 404 }, env, origin);
    if (gv.status !== 'active') return json({ error: 'closed', message: 'This giveaway has closed.' }, { status: 409 }, env, origin);
    const now = Math.floor(Date.now() / 1000);
    const res = await env.DB.prepare(`INSERT OR IGNORE INTO giveaway_entries (id, giveaway_id, member_id, email, name, created_at) VALUES (?,?,?,?,?,?)`)
      .bind('ge-' + crypto.randomUUID(), gid, mid, email, name, now).run();
    const already = !(res && res.meta && res.meta.changes);
    if (!already) {
      try { await env.DB.prepare(`INSERT INTO events (ts, member_id, member_name, email, event_name, path, props_json) VALUES (?,?,?,?,?,?,?)`)
        .bind(now, mid, name, email, 'giveaway_entry', '/giveaways', JSON.stringify({ giveaway_id: gid, title: gv.title })).run(); } catch {}
      await addToResendAudience(env, email, name);
    }
    return json({ ok: true, already, title: gv.title }, {}, env, origin);
  } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
}

// ── Admin giveaway management (token-gated) ──
async function handleAdminGiveawaysList(env, origin) {
  try {
    await ensureGiveawayTables(env);
    const rs = await env.DB.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id = g.id) AS entries
       FROM giveaways g ORDER BY g.sort ASC, g.created_at ASC`).all();
    return json({ giveaways: (rs.results || []).map(g => giveawayRow(g, g.entries)) }, {}, env, origin);
  } catch (e) { return json({ error: 'giveaways: ' + e.message }, { status: 500 }, env, origin); }
}
async function handleAdminGiveawaySave(request, env, origin) {
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, { status: 400 }, env, origin); }
  const title = String((b && b.title) || '').trim().slice(0, 160);
  if (!title) return json({ error: 'title required' }, { status: 400 }, env, origin);
  const prize = String((b && b.prize) || '').trim().slice(0, 160);
  const sponsor = String((b && b.sponsor) || '').trim().slice(0, 160);
  const image = String((b && b.image) || '').trim().slice(0, 600);
  const status = ((b && b.status) === 'archived') ? 'archived' : 'active';
  const sort = Number.isFinite(+(b && b.sort)) ? Math.round(+b.sort) : 0;
  const now = Math.floor(Date.now() / 1000);
  try {
    await ensureGiveawayTables(env);
    let id = String((b && b.id) || '').slice(0, 120);
    if (id) {
      await env.DB.prepare(`UPDATE giveaways SET title=?, prize=?, sponsor=?, image=?, status=?, sort=?, updated_at=? WHERE id=?`)
        .bind(title, prize, sponsor, image, status, sort, now, id).run();
    } else {
      id = 'gv-' + crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO giveaways (id,title,prize,sponsor,image,status,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(id, title, prize, sponsor, image, status, sort, now, now).run();
    }
    return json({ ok: true, id }, {}, env, origin);
  } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
}
async function handleAdminGiveawayDelete(env, origin, id) {
  try {
    await ensureGiveawayTables(env);
    await env.DB.prepare(`DELETE FROM giveaway_entries WHERE giveaway_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM giveaways WHERE id = ?`).bind(id).run();
    return json({ ok: true }, {}, env, origin);
  } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
}
async function handleAdminGiveawayEntries(env, origin, id) {
  try {
    await ensureGiveawayTables(env);
    const rs = await env.DB.prepare(`SELECT email, name, member_id, created_at FROM giveaway_entries WHERE giveaway_id = ? ORDER BY created_at DESC LIMIT 5000`).bind(id).all();
    return json({ entries: rs.results || [] }, {}, env, origin);
  } catch (e) { return json({ error: 'db: ' + e.message }, { status: 500 }, env, origin); }
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }

    // Studio MCP server (Claude connector) — self-authenticating (bearer token).
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
      return await handleMcp(request, env);
    }
    // OAuth endpoints for the claude.ai custom-connector flow (DCR + PKCE).
    if (url.pathname.startsWith('/.well-known/oauth') || url.pathname === '/.well-known/openid-configuration'
        || url.pathname === '/register' || url.pathname === '/authorize' || url.pathname === '/token') {
      const r = await handleOAuth(request, env, url);
      if (r) return r;
    }

    try {
      // ── In-house image galleries (gallery.oftmw.com) ─────────────────────
      // Serves the public portfolio + per-gallery pages + PIN-gated downloads
      // on the gallery host, and the admin gallery API on any host. Returns
      // null for non-gallery routes so the rest of this dispatcher still runs.
      {
        const gdeps = { json, requireAdminToken, signPayload, verifyPayload, handleMediaServe };
        const gr = await handleGallery(request, env, url, origin, gdeps);
        if (gr) return gr;
      }

      // ── Public member-card verification (the QR target on the card) ──────
      if (request.method === 'GET' && /^\/m\/\d{1,6}$/.test(url.pathname)) {
        return await handleMemberVerify(env, url);
      }

      // ── GitHub-OAuth login (public — these mint/verify the session) ──────
      if (request.method === 'GET' && url.pathname === '/admin/auth/login')    return await handleAuthLogin(env, url);
      if (request.method === 'GET' && url.pathname === '/admin/auth/callback') return await handleAuthCallback(env, url);
      if (request.method === 'GET' && url.pathname === '/admin/auth/me')       return await handleAuthMe(request, env, origin);

      // ── Admin-gated analytics reads ──────────────────────────────────
      // These endpoints expose member PII (email, name, plan) and per-person
      // behavioral history, plus aggregate click/watchlist analytics. They are
      // consumed ONLY by analytics.html, which sends Authorization: Bearer
      // <ADMIN_TOKEN>. Before this gate they were world-readable from any
      // origin. Public content endpoints (/blog, /posts, /post/:slug,
      // /list/:slug GET, /health) are intentionally NOT in this set, and the
      // admin WRITE endpoints (/admin/*, POST/PATCH/DELETE on /posts, /list)
      // already enforce the token inside their own handlers.
      const ADMIN_READ_PATHS = new Set([
        '/people', '/stats', '/member', '/timeline',
        '/watchlist', '/projects', '/activity', '/subscriptions', '/intel-queries', '/search-gaps',
        '/search-feedback', '/search-feedback/discoveries',
        '/intel-selftest',
        '/funnel-stats',
        '/intel-answers', '/intel-rules', '/intel-exemplars',
      ]);
      if (request.method === 'GET' && ADMIN_READ_PATHS.has(url.pathname)) {
        const denied = await requireAdminToken(request, env, origin);
        if (denied) return denied;
      }

      // Back-compat: POST / with { endpoint, body } → GA4 proxy.
      if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '')) {
        return await handleGAProxy(request, env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/event') {
        return await handleEventIngest(request, env, origin);
      }
      // Device-to-device TMW Intelligence chat resume (logged-in members).
      if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/intel-thread') {
        return await handleIntelThread(request, env, origin, url);
      }
      // First-party post view counter (public): beacon in, count map out.
      if (request.method === 'POST' && url.pathname === '/view') {
        return await handlePostView(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/post-views') {
        return await handlePostViews(env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/coverage-links') {
        return await handleCoverageLinks(env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/corpus') {
        return await handleCorpus(env, origin, url);
      }
      // Journal "active now" heartbeat (public): ping in, 5-min session count out.
      if (request.method === 'POST' && url.pathname === '/journal-ping') {
        return await handleJournalPing(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/journal-active') {
        return await handleJournalActive(env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/admin/backfill-wix-views') {
        return await handleBackfillWixViews(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/people') {
        return await handlePeople(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/stats') {
        return await handleStats(env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/funnel-stats') {
        return await handleFunnelStats(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/subscriptions') {
        return await handleSubscriptions(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/member') {
        return await handleMember(env, origin, url);
      }
      if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/admin/member-number') {
        return await handleMemberNumber(request, env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/admin/markets-followed') {
        return await handleMarketsFollowed(request, env, origin);
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
      if (request.method === 'GET' && url.pathname === '/journal-event-trend') {
        return await handleJournalEventTrend(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/search-gaps') {
        return await handleSearchGaps(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/intel-selftest') {
        return await handleIntelSelftest(env, origin, url);
      }
      if (request.method === 'POST' && url.pathname === '/intel-feedback') {
        return await handleIntelFeedback(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/search-feedback') {
        return await handleSearchFeedback(env, origin, url);
      }
      // GET /search-feedback/discoveries — pending discovery queue for the
      // tmw-project-discovery Claude Code routine. Admin-only.
      if (request.method === 'GET' && url.pathname === '/search-feedback/discoveries') {
        return await handleDiscoveryQueue(env, origin, url);
      }
      // POST /search-feedback/discoveries/mark — mark queries as processed
      // so the routine doesn't re-run them. Admin-only (token in header).
      if (request.method === 'POST' && url.pathname === '/search-feedback/discoveries/mark') {
        return await handleDiscoveryMark(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/intel-queries') {
        return await handleIntelQueries(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/intel-answers') {
        return await handleIntelAnswers(env, origin, url);
      }
      if (url.pathname === '/intel-rules') {
        return await handleIntelRules(request, env, origin);
      }
      if (url.pathname === '/intel-exemplars') {
        return await handleIntelExemplars(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/member-stats') {
        return await handleMemberStats(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/member-lists') {
        return await handleMemberLists(env, origin, url);
      }
      if (request.method === 'POST' && url.pathname === '/article-feedback') {
        return await handleArticleFeedback(request, env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/contribution') {
        return await handleContribution(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/comments') {
        return await handleGetComments(env, origin, url);
      }
      if (request.method === 'POST' && url.pathname === '/comment') {
        return await handlePostComment(request, env, origin);
      }
      // ── Giveaways: public list + enter ──
      if (request.method === 'GET' && url.pathname === '/giveaways') {
        return await handleGiveawaysList(env, origin);
      }
      if (request.method === 'POST' && url.pathname === '/giveaway-enter') {
        return await handleGiveawayEnter(request, env, origin);
      }
      // ── Giveaways: admin (token-gated) ──
      if (url.pathname === '/admin/giveaways') {
        const denied = await requireAdminToken(request, env, origin);
        if (denied) return denied;
        if (request.method === 'GET')  return await handleAdminGiveawaysList(env, origin);
        if (request.method === 'POST') return await handleAdminGiveawaySave(request, env, origin);
      }
      {
        const gm = url.pathname.match(/^\/admin\/giveaways\/([^/]+)(\/entries)?$/);
        if (gm) {
          const denied = await requireAdminToken(request, env, origin);
          if (denied) return denied;
          if (gm[2] && request.method === 'GET')    return await handleAdminGiveawayEntries(env, origin, decodeURIComponent(gm[1]));
          if (!gm[2] && request.method === 'DELETE') return await handleAdminGiveawayDelete(env, origin, decodeURIComponent(gm[1]));
        }
      }
      if (request.method === 'GET' && url.pathname === '/blog') {
        return await handleBlog(env, origin, url);
      }
      // /posts — D1-backed canonical posts table (post-migration source).
      if (request.method === 'GET' && url.pathname === '/posts') {
        return await handlePostsList(request, env, origin, url);
      }
      // /smart-answer — TMW Intelligence prose for the smart-search page.
      // POST { q, facts } → { answer }. Always 200; { answer: null } on any
      // failure so the page falls back to its deterministic answer.
      if (request.method === 'POST' && url.pathname === '/smart-answer') {
        return await handleSmartAnswer(request, env, origin);
      }
      // /email-status — does this email already have a Memberstack account?
      // POST { email } -> { ok, account }. Lets every email form route a known
      // address to LOGIN instead of re-subscribing it. Fails open to account:false.
      if (request.method === 'POST' && url.pathname === '/email-status') {
        return await handleEmailStatus(request, env, origin);
      }
      if (request.method === 'GET' && url.pathname === '/post-categories') {
        return await handlePostCategories(env, origin);
      }
      {
        const m = url.pathname.match(/^\/posts\/by-slug\/([^/]+)\/?$/);
        if (m && request.method === 'GET') return await handlePostsBySlug(request, env, origin, m[1]);
      }
      {
        const m = url.pathname.match(/^\/posts\/by-id\/([^/]+)\/?$/);
        if (m && request.method === 'GET') return await handlePostsById(request, env, origin, m[1]);
      }
      // /preview-token — admin mints a signed client-preview link for a draft.
      if (request.method === 'GET' && url.pathname === '/preview-token') {
        const denied = await requireAdminToken(request, env, origin);
        if (denied) return denied;
        return await handlePreviewToken(request, env, origin, url);
      }
      // ── Social carousels ─────────────────────────────────────────────
      // Admin CRUD (gated), token-minting endpoint, and the public
      // Instagram-style /c/<slug> share page (which is gated INSIDE the
      // handler so an unauthenticated client can hit it with a valid
      // preview token — same flow as article-draft previews).
      if (request.method === 'GET'  && url.pathname === '/carousels') return await handleCarouselsList(request, env, origin, url);
      if (request.method === 'POST' && url.pathname === '/carousels') return await handleCarouselsCreate(request, env, origin);
      if (request.method === 'GET'  && url.pathname === '/carousel-preview-token') {
        const denied = await requireAdminToken(request, env, origin);
        if (denied) return denied;
        return await handleCarouselPreviewToken(request, env, origin, url);
      }
      {
        const m = url.pathname.match(/^\/carousels\/by-slug\/([^/]+)\/?$/);
        if (m) {
          if (request.method === 'GET')    return await handleCarouselsBySlug (request, env, origin, m[1]);
          if (request.method === 'PATCH')  return await handleCarouselsUpdate (request, env, origin, m[1]);
          if (request.method === 'DELETE') return await handleCarouselsDelete (request, env, origin, m[1]);
        }
      }
      // Same-origin image proxy (Design editor PNG export — admin only)
      if (request.method === 'GET' && url.pathname === '/img') {
        const denied = await requireAdminToken(request, env, origin);
        if (denied) return denied;
        return await handleImageProxy(request, env, origin, url);
      }
      // Design docs (Studio "Design" editor — admin only)
      if (request.method === 'GET'  && url.pathname === '/designs') return await handleDesignsList(request, env, origin, url);
      if (request.method === 'POST' && url.pathname === '/designs') return await handleDesignsCreate(request, env, origin);
      {
        const m = url.pathname.match(/^\/designs\/by-slug\/([^/]+)\/?$/);
        if (m) {
          if (request.method === 'GET')    return await handleDesignsBySlug (request, env, origin, m[1]);
          if (request.method === 'PATCH')  return await handleDesignsUpdate (request, env, origin, m[1]);
          if (request.method === 'DELETE') return await handleDesignsDelete (request, env, origin, m[1]);
        }
      }
      // Public preview page — /c/<slug>?preview=<token>
      {
        const m = url.pathname.match(/^\/c\/([^/]+)\/?$/);
        if (m && request.method === 'GET') return await handleCarouselPublic(request, env, m[1]);
      }
      // /admin/sync-wix — batched migration importer (admin-only)
      if (request.method === 'POST' && url.pathname === '/admin/sync-wix') {
        return await handleWixSync(request, env, origin, url);
      }
      // /admin/upload — image upload to R2 (admin-only)
      if (request.method === 'POST' && url.pathname === '/admin/upload') {
        return await handleUpload(request, env, origin);
      }
      // /admin/upload-multipart/* — large-file (video) upload via R2 multipart
      {
        const m = url.pathname.match(/^\/admin\/upload-multipart\/(create|part|complete|abort)$/);
        if (m && (request.method === 'POST' || request.method === 'PUT')) {
          return await handleMultipartUpload(request, env, origin, m[1], url);
        }
      }
      // /admin/migrate-images — bulk pull Wix CDN URLs into R2 (admin-only)
      if (request.method === 'POST' && url.pathname === '/admin/migrate-images') {
        return await handleMigrateImages(request, env, origin, url);
      }
      // /admin/migrate-wix-media — pull the entire Wix Media Manager (admin-only)
      if (url.pathname === '/admin/migrate-wix-media' && (request.method === 'GET' || request.method === 'POST')) {
        return await handleMigrateWixMedia(request, env, origin, url);
      }
      // /media/:key — public R2 asset serving (bucket stays private)
      {
        const m = url.pathname.match(/^\/media\/(.+)$/);
        if (m && (request.method === 'GET' || request.method === 'HEAD')) {
          return await handleMediaServe(request, env, decodeURIComponent(m[1]));
        }
      }
      // /admin/media/folders — create / favorite a folder (admin-only)
      if (url.pathname === '/admin/media/folders' && (request.method === 'POST' || request.method === 'PATCH')) {
        return await handleMediaFolders(request, env, origin);
      }
      // /admin/media/rename-folder — rename a folder + its descendants (admin-only)
      if (url.pathname === '/admin/media/rename-folder' && request.method === 'POST') {
        return await handleMediaRenameFolder(request, env, origin);
      }
      // /admin/media/rename-file — rename a file's display name (admin-only)
      if (url.pathname === '/admin/media/rename-file' && request.method === 'POST') {
        return await handleMediaRenameFile(request, env, origin);
      }
      // /admin/media — list/delete uploaded media (admin-only)
      if (request.method === 'GET' && url.pathname === '/admin/media') {
        return await handleMediaList(request, env, origin, url);
      }
      {
        const m = url.pathname.match(/^\/admin\/media\/(.+)$/);
        if (m && request.method === 'DELETE') {
          return await handleMediaDelete(request, env, origin, decodeURIComponent(m[1]));
        }
      }
      // Post CRUD — admin write side
      if (request.method === 'POST' && url.pathname === '/posts') {
        return await handlePostsCreate(request, env, origin);
      }
      {
        const m = url.pathname.match(/^\/posts\/([^/]+)\/publish\/?$/);
        if (m && request.method === 'POST') return await handlePostsPublish(request, env, origin, m[1]);
      }
      {
        const m = url.pathname.match(/^\/posts\/([^/]+)\/?$/);
        if (m) {
          if (request.method === 'PATCH')  return await handlePostsUpdate(request, env, origin, m[1]);
          if (request.method === 'DELETE') return await handlePostsDelete(request, env, origin, m[1]);
        }
      }
      // /admin/wix-debug/:slug — dump raw Wix response for one post so we
      // can see the actual richContent shape. Admin-only.
      {
        const m = url.pathname.match(/^\/admin\/wix-debug\/([^/]+)\/?$/);
        if (m && request.method === 'GET') {
          return await handleWixDebug(request, env, origin, m[1]);
        }
      }
      // /contacts — Monday-replacement CRM. Admin-only on every verb; no
      // public read path. The admin UI at admin.oftmw.com/contacts.html
      // drives the list + filter + edit flows; the post editor's Contact
      // picker hits GET /contacts?q=… for autocomplete and POST /contacts
      // for inline "create new".
      if (url.pathname === '/contacts' || url.pathname === '/contacts/') {
        if (request.method === 'GET')  return await handleContactsList(request, env, origin, url);
        if (request.method === 'POST') return await handleContactsCreate(request, env, origin);
      }
      // /companies — distinct company values across contacts (with counts),
      // for the company-field autocomplete on every contact form.
      if (url.pathname === '/companies' || url.pathname === '/companies/') {
        if (request.method === 'GET') return await handleCompaniesList(request, env, origin, url);
      }
      {
        const m = url.pathname.match(/^\/contacts\/([^/]+)\/?$/);
        if (m) {
          if (request.method === 'GET')    return await handleContactGet(request, env, origin, m[1]);
          if (request.method === 'PATCH')  return await handleContactsUpdate(request, env, origin, m[1]);
          if (request.method === 'DELETE') return await handleContactsDelete(request, env, origin, m[1]);
        }
      }
      // /campaigns — multi-month commitments. CRUD + link/unlink-post for the
      // editor sidebar. Admin-only on every verb.
      if (url.pathname === '/campaigns' || url.pathname === '/campaigns/') {
        if (request.method === 'GET')  return await handleCampaignsList(request, env, origin, url);
        if (request.method === 'POST') return await handleCampaignsCreate(request, env, origin);
      }
      {
        const m = url.pathname.match(/^\/campaigns\/([^/]+)\/link-post\/?$/);
        if (m && request.method === 'POST') return await handleCampaignLinkPost(request, env, origin, m[1]);
      }
      {
        const m = url.pathname.match(/^\/campaigns\/([^/]+)\/unlink-post\/?$/);
        if (m && request.method === 'POST') return await handleCampaignUnlinkPost(request, env, origin, m[1]);
      }
      {
        const m = url.pathname.match(/^\/campaigns\/([^/]+)\/?$/);
        if (m) {
          if (request.method === 'GET')    return await handleCampaignGet(request, env, origin, m[1]);
          if (request.method === 'PATCH')  return await handleCampaignsUpdate(request, env, origin, m[1]);
          if (request.method === 'DELETE') return await handleCampaignsDelete(request, env, origin, m[1]);
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
      // /brain — shared brand-brain notes (admin read/write; same brand_notes
      // table the MCP connector uses, so the Studio UI and Claude stay in sync).
      if (url.pathname === '/brain' || url.pathname === '/brain/') {
        if (request.method === 'GET')  return await handleBrainGet(request, env, origin);
        if (request.method === 'POST') return await handleBrainPost(request, env, origin);
      }
      {
        const m = url.pathname.match(/^\/brain\/([^/]+)\/?$/);
        if (m && request.method === 'DELETE') return await handleBrainDelete(request, env, origin, decodeURIComponent(m[1]));
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

  // Cron trigger (see [triggers] in wrangler.toml). Drives the Wix → R2 media
  // migration server-side so it no longer depends on a browser tab staying open
  // — fully resumable, self-pacing, and auto-pauses when everything is copied.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(migrationTick(env));
    ctx.waitUntil(maybeBackfillWixViews(env));   // refresh Wix view baseline ~daily
    ctx.waitUntil(maybeAutoPromoteOpenings(env)); // flip Opening Soon → Now Open for past-due projects
  },
};
