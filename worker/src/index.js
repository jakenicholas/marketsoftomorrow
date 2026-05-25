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
async function handlePeople(env, origin, url) {
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
  const rs = await env.DB.prepare(
    `SELECT member_id, email, member_name, plan, last_seen_ts, first_seen_ts, event_count
     FROM member_summary
     ORDER BY last_seen_ts DESC
     LIMIT ?`
  ).bind(limit).all();
  return json({ rows: rs.results || [] }, {}, env, origin);
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

// GET /watchlist — how many times each project was added to the watchlist.
// The map fires this as event_name = 'favorite_added' with a 'project_slug'
// property (see index.html toggleFavorite). We net out adds vs removes per
// (member, project) so a user who toggles a project off doesn't keep counting.
// Done in JS rather than SQL because D1's SQLite json_extract behavior isn't
// portable enough to rely on for production queries.
async function handleWatchlist(env, origin, url) {
  const days = clampInt(url.searchParams.get('days'), 28, 1, 365);
  const sinceTs = Math.floor(Date.now() / 1000) - (days * 86400);
  const rs = await env.DB.prepare(
    `SELECT event_name, props_json, member_id, email, ts
     FROM events
     WHERE event_name IN ('favorite_added','favorite_removed') AND ts >= ?
     ORDER BY ts ASC`
  ).bind(sinceTs).all();

  // (project, member) → current state (1 = on watchlist, 0 = off). Replay the
  // event stream so the final tally reflects what's actually watchlisted now.
  const state    = new Map(); // key `${project}::${member}` → 0/1
  const lastSeen = new Map(); // project → most recent add ts
  const adders   = new Map(); // project → Set(member_id) currently watching
  const addCount = new Map(); // project → total add events (raw popularity)

  for (const row of (rs.results || [])) {
    let props = {};
    try { if (row.props_json) props = JSON.parse(row.props_json); } catch {}
    const project = props.project_slug || props.project_name || props.title || '(unknown)';
    const key = project + '::' + (row.member_id || 'anon');

    if (row.event_name === 'favorite_added') {
      state.set(key, 1);
      addCount.set(project, (addCount.get(project) || 0) + 1);
      if (!adders.has(project)) adders.set(project, new Set());
      adders.get(project).add(row.member_id || 'anon');
      if (!lastSeen.has(project) || lastSeen.get(project) < row.ts) lastSeen.set(project, row.ts);
    } else { // favorite_removed
      state.set(key, 0);
    }
  }

  // Now count members whose final state is 1 for each project.
  const currentWatchers = new Map(); // project → Set(member_id)
  for (const [key, on] of state.entries()) {
    if (!on) continue;
    const sep = key.lastIndexOf('::');
    const project = key.slice(0, sep);
    const member  = key.slice(sep + 2);
    if (!currentWatchers.has(project)) currentWatchers.set(project, new Set());
    currentWatchers.get(project).add(member);
  }

  const allProjects = new Set([...addCount.keys(), ...currentWatchers.keys()]);
  const out = Array.from(allProjects).map(p => ({
    project: p,
    total_adds: addCount.get(p) || 0,
    current_watchers: (currentWatchers.get(p) || new Set()).size,
    last_add_ts: lastSeen.get(p) || 0,
  }))
  .sort((a, b) => b.current_watchers - a.current_watchers || b.total_adds - a.total_adds)
  .slice(0, 50);

  return json({ rows: out }, {}, env, origin);
}

// GET /activity — live feed: most recent N events across all members.
async function handleActivity(env, origin, url) {
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
  const rs = await env.DB.prepare(
    `SELECT ts, member_id, email, member_name, plan, event_name, path, props_json
     FROM events
     ORDER BY ts DESC
     LIMIT ?`
  ).bind(limit).all();
  return json({ rows: rs.results || [] }, {}, env, origin);
}

function clampInt(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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
      if (request.method === 'GET' && url.pathname === '/timeline') {
        return await handleTimeline(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/watchlist') {
        return await handleWatchlist(env, origin, url);
      }
      if (request.method === 'GET' && url.pathname === '/activity') {
        return await handleActivity(env, origin, url);
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
