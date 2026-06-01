/*
  OAuth 2.1 (authorization-code + PKCE + Dynamic Client Registration) for the
  Studio MCP server, so claude.ai's "Add custom connector" flow can authorize.

  Flow:
    1. Claude GETs /mcp → 401 with WWW-Authenticate pointing at the resource
       metadata (see mcp.js).
    2. Claude reads /.well-known/oauth-protected-resource → /.well-known/oauth-
       authorization-server, then DCR-registers at /register.
    3. Claude opens /authorize in the user's browser → we show a password gate.
       On the right password we mint a short-lived code (bound to the client +
       PKCE challenge) and redirect back.
    4. Claude POSTs /token with the code + PKCE verifier → we return an
       access_token (and refresh_token).
    5. /mcp accepts that access_token (or the static STUDIO_MCP_TOKEN used by
       Claude Desktop).

  Storage: three small D1 tables. Passwordless clients (PKCE public clients) —
  the human gate is the shared STUDIO_AUTH_PASSWORD secret.
*/

const CODE_TTL = 600;              // 10 min
const ACCESS_TTL = 60 * 60 * 24 * 30;   // 30 days
const REFRESH_TTL = 60 * 60 * 24 * 180; // 180 days

function issuer(url) { return url.origin; }
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randToken(n = 32) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
async function sha256b64url(s) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }

async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, redirect_uris TEXT, name TEXT, created_at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS oauth_codes (code TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, code_challenge TEXT, scope TEXT, expires_at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS oauth_tokens (token TEXT PRIMARY KEY, kind TEXT, client_id TEXT, scope TEXT, expires_at INTEGER)'),
  ]);
}

// True if the bearer is the static Desktop token OR a live OAuth access token.
export async function isAuthorized(token, env) {
  if (!token) return false;
  if (env.STUDIO_MCP_TOKEN && token === env.STUDIO_MCP_TOKEN) return true;
  if (!env.DB) return false;
  try {
    await ensureTables(env);
    const row = await env.DB.prepare("SELECT expires_at FROM oauth_tokens WHERE token = ?1 AND kind = 'access'").bind(token).first();
    return !!(row && row.expires_at > Math.floor(Date.now() / 1000));
  } catch (_) { return false; }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function loginPage(params, error) {
  const hidden = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'response_type', 'resource']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] || '')}">`).join('');
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Studio</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#070807;color:#ECEAE5;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:380px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:34px 28px;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.hex{width:30px;height:30px;margin:0 auto 16px;display:block}
h1{font-family:'Fraunces',Georgia,serif;font-size:23px;font-weight:600;text-align:center;margin-bottom:6px}
p{color:#9AA39C;font-size:13px;text-align:center;margin-bottom:22px;line-height:1.5}
label{display:block;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#C2C9C3;margin-bottom:8px}
input[type=password]{width:100%;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:13px 14px;color:#fff;font-size:15px;outline:none}
input[type=password]:focus{border-color:#1FDF67}
button{width:100%;margin-top:18px;background:#1FDF67;color:#06210f;border:0;border-radius:10px;padding:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:ui-monospace,monospace;letter-spacing:.06em}
button:hover{background:#42EB81}.err{background:rgba(255,93,93,.12);border:1px solid rgba(255,93,93,.3);color:#ff8a8a;font-size:12.5px;padding:10px 12px;border-radius:8px;margin-bottom:16px;text-align:center}
.foot{margin-top:18px;text-align:center;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.1em;color:#6b726c}
</style></head><body><form class="card" method="POST" action="/authorize">
<svg class="hex" viewBox="0 0 100 100"><polygon points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="8" stroke-linejoin="round"/></svg>
<h1>Connect to Studio</h1><p>Markets of Tomorrow — authorize Claude to access your Studio.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<label>Access password</label>
<input type="password" name="password" autofocus autocomplete="current-password" placeholder="••••••••">
${hidden}<button type="submit">Authorize</button>
<div class="foot">${esc(params.client_id || '')}</div>
</form></body></html>`, { status: error ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Main entry — returns a Response for any OAuth path, or null if not ours.
export async function handleOAuth(request, env, url) {
  const path = url.pathname;
  const iss = issuer(url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' } });
  }

  // ── Discovery ──────────────────────────────────────────────────────────
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    return jsonResp({ resource: iss + '/mcp', authorization_servers: [iss], bearer_methods_supported: ['header'] });
  }
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
    return jsonResp({
      issuer: iss,
      authorization_endpoint: iss + '/authorize',
      token_endpoint: iss + '/token',
      registration_endpoint: iss + '/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  }

  // ── Dynamic Client Registration ────────────────────────────────────────
  if (path === '/register' && request.method === 'POST') {
    if (!env.DB) return jsonResp({ error: 'server_error' }, 500);
    await ensureTables(env);
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (!redirects.length) return jsonResp({ error: 'invalid_redirect_uri', error_description: 'redirect_uris required' }, 400);
    const clientId = 'tmw-' + randToken(16);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('INSERT INTO oauth_clients (client_id, redirect_uris, name, created_at) VALUES (?1,?2,?3,?4)')
      .bind(clientId, JSON.stringify(redirects), String(body.client_name || 'MCP Client').slice(0, 120), now).run();
    return jsonResp({
      client_id: clientId,
      client_id_issued_at: now,
      redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: body.client_name || 'MCP Client',
    }, 201);
  }

  // ── Authorization ──────────────────────────────────────────────────────
  if (path === '/authorize') {
    if (!env.DB) return new Response('server not configured', { status: 500 });
    await ensureTables(env);

    let params;
    if (request.method === 'POST') {
      const form = await request.formData();
      params = Object.fromEntries([...form.entries()]);
    } else {
      params = Object.fromEntries([...url.searchParams.entries()]);
    }

    const client = await env.DB.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ?1').bind(params.client_id || '').first();
    if (!client) return new Response('unknown client_id', { status: 400 });
    const allowed = JSON.parse(client.redirect_uris || '[]');
    if (!allowed.includes(params.redirect_uri)) return new Response('redirect_uri not registered', { status: 400 });
    if ((params.code_challenge_method || 'S256') !== 'S256' || !params.code_challenge) {
      return new Response('PKCE S256 required', { status: 400 });
    }

    if (request.method === 'GET') return loginPage(params);

    // POST — verify the password gate.
    if (!env.STUDIO_AUTH_PASSWORD) return loginPage(params, 'Server password not configured.');
    if ((params.password || '') !== env.STUDIO_AUTH_PASSWORD) return loginPage(params, 'Wrong password. Try again.');

    const code = randToken(24);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(code, params.client_id, params.redirect_uri, params.code_challenge, params.scope || 'mcp', now + CODE_TTL).run();
    const redir = new URL(params.redirect_uri);
    redir.searchParams.set('code', code);
    if (params.state) redir.searchParams.set('state', params.state);
    return new Response(null, { status: 302, headers: { Location: redir.toString(), 'Cache-Control': 'no-store' } });
  }

  // ── Token ──────────────────────────────────────────────────────────────
  if (path === '/token' && request.method === 'POST') {
    if (!env.DB) return jsonResp({ error: 'server_error' }, 500);
    await ensureTables(env);
    const form = await request.formData();
    const grant = form.get('grant_type');
    const now = Math.floor(Date.now() / 1000);

    if (grant === 'authorization_code') {
      const code = form.get('code') || '';
      const verifier = form.get('code_verifier') || '';
      const redirectUri = form.get('redirect_uri') || '';
      const row = await env.DB.prepare('SELECT client_id, redirect_uri, code_challenge, scope, expires_at FROM oauth_codes WHERE code = ?1').bind(code).first();
      if (!row) return jsonResp({ error: 'invalid_grant' }, 400);
      await env.DB.prepare('DELETE FROM oauth_codes WHERE code = ?1').bind(code).run();   // single-use
      if (row.expires_at < now) return jsonResp({ error: 'invalid_grant', error_description: 'code expired' }, 400);
      if (row.redirect_uri !== redirectUri) return jsonResp({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
      if (!verifier || (await sha256b64url(verifier)) !== row.code_challenge) return jsonResp({ error: 'invalid_grant', error_description: 'PKCE failed' }, 400);

      const access = randToken(32), refresh = randToken(32);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO oauth_tokens (token, kind, client_id, scope, expires_at) VALUES (?1,'access',?2,?3,?4)").bind(access, row.client_id, row.scope, now + ACCESS_TTL),
        env.DB.prepare("INSERT INTO oauth_tokens (token, kind, client_id, scope, expires_at) VALUES (?1,'refresh',?2,?3,?4)").bind(refresh, row.client_id, row.scope, now + REFRESH_TTL),
      ]);
      return jsonResp({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: row.scope });
    }

    if (grant === 'refresh_token') {
      const rt = form.get('refresh_token') || '';
      const row = await env.DB.prepare("SELECT client_id, scope, expires_at FROM oauth_tokens WHERE token = ?1 AND kind = 'refresh'").bind(rt).first();
      if (!row || row.expires_at < now) return jsonResp({ error: 'invalid_grant' }, 400);
      const access = randToken(32);
      await env.DB.prepare("INSERT INTO oauth_tokens (token, kind, client_id, scope, expires_at) VALUES (?1,'access',?2,?3,?4)").bind(access, row.client_id, row.scope, now + ACCESS_TTL).run();
      return jsonResp({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, scope: row.scope });
    }

    return jsonResp({ error: 'unsupported_grant_type' }, 400);
  }

  return null;   // not an OAuth path
}
