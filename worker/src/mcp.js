/*
  TMW "Studio" — remote MCP server (Model Context Protocol over Streamable HTTP).

  Lets Claude (Desktop now via token auth; claude.ai once OAuth is layered on)
  query the Studio and push DRAFTS:
    • read journal posts, drafts, view counts
    • read Map of Tomorrow projects, project types, architects, developers
    • create an article DRAFT (status=draft — never publishes anything live)

  Transport: a minimal, stateless JSON-RPC 2.0 handler. Each POST /mcp carries
  one JSON-RPC message; we answer inline as application/json. No SSE/Durable
  Object needed because every tool call is a self-contained request/response.

  Auth (phase A): Authorization: Bearer <STUDIO_MCP_TOKEN>. Phase B wraps this
  in the OAuth flow claude.ai's custom-connector UI requires.
*/

import { isAuthorized } from './oauth.js';

const SERVER_INFO = { name: 'tmw-studio', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const PROJECTS_URL = 'https://map.oftmw.com/projects-flat.json';

// ── Tool catalog ────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_posts',
    description: 'Search/list journal articles in the Studio (D1). Filter by free-text query, status (published|draft|scheduled), or category. Returns slug, title, status, date, category and total view count.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against title + excerpt' },
        status: { type: 'string', enum: ['published', 'draft', 'scheduled'], description: 'Filter by post status' },
        category: { type: 'string', description: 'Filter by a category label' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50)' },
      },
    },
  },
  {
    name: 'get_post',
    description: 'Get one journal article in full by its slug — title, excerpt, status, categories, SEO, view count, and the article HTML body.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
  {
    name: 'list_post_drafts',
    description: 'List article drafts (status=draft) waiting in the Studio.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Max results (default 50)' } } },
  },
  {
    name: 'get_post_views',
    description: 'Get view counts. With a slug → that post’s total plus the Wix-historical and new first-party breakdown. Without → the top posts by total views.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, limit: { type: 'integer', description: 'Top-N when no slug (default 20)' } } },
  },
  {
    name: 'search_projects',
    description: 'Search Map of Tomorrow projects. Filter by free-text query (title/city/description), city, project type, architect, or developer.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        city: { type: 'string' },
        type: { type: 'string', description: 'Project type substring, e.g. "Hotel"' },
        architect: { type: 'string' },
        developer: { type: 'string' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50)' },
      },
    },
  },
  {
    name: 'list_project_types',
    description: 'List the distinct Map of Tomorrow project types in use, with a count of projects per type.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_architects',
    description: 'List architect firms across Map of Tomorrow projects (optionally filtered by name), with project counts.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'Default 50' } } },
  },
  {
    name: 'list_developers',
    description: 'List developer firms across Map of Tomorrow projects (optionally filtered by name), with project counts.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'Default 50' } } },
  },
  {
    name: 'create_post_draft',
    description: 'Create a NEW journal article DRAFT in the Studio (status=draft — it does NOT publish). Returns the draft id, slug, and the Studio edit URL so a human can review, finish, and publish it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article headline' },
        body_markdown: { type: 'string', description: 'Article body in Markdown (headings, paragraphs, **bold**, *italic*, [links](url), - lists)' },
        excerpt: { type: 'string', description: '1–2 sentence summary (optional; auto-derived if omitted)' },
        category: { type: 'string', description: 'Primary category label (optional)' },
        cover_image: { type: 'string', description: 'Absolute cover image URL (optional)' },
      },
      required: ['title'],
    },
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function iso(ts) { return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null; }
function parseJSON(s, fallback) { try { return JSON.parse(s); } catch (_) { return fallback; } }

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'untitled';
}

function mdToHtml(md) {
  if (!md) return '<p></p>';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`);
  return String(md).replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => {
    b = b.trim(); if (!b) return '';
    const h = b.match(/^(#{1,3})\s+(.*)$/);
    if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    if (/^[-*]\s+/.test(b)) {
      const items = b.split('\n').map((l) => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
      return '<ul>' + items.map((i) => `<li>${inline(i)}</li>`).join('') + '</ul>';
    }
    return `<p>${inline(b.replace(/\n/g, ' '))}</p>`;
  }).filter(Boolean).join('\n');
}

function stripHtml(html) { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

let _projectsCache = null;
async function loadProjects() {
  if (_projectsCache) return _projectsCache;
  const r = await fetch(PROJECTS_URL, { cf: { cacheTtl: 60 } });
  if (!r.ok) throw new Error('projects feed ' + r.status);
  const data = await r.json();
  _projectsCache = Array.isArray(data) ? data : [];
  return _projectsCache;
}

function projectSummary(p) {
  return {
    title: p.Title, city: p.City, type: p.ProjectType || p.PreferredType || '',
    architect: p.Architect || '', developer: p.Developer || '',
    delivery: p.Delivery || p.DeliveryDate || '', units: p.Units || '', floors: p.Floors || '',
    website: p.OfficialWebsite || '', description: p.Description || '',
  };
}

// Split a comma/semicolon/"&"-joined firm or type list into clean tokens.
function splitList(s) {
  return String(s || '').split(/\s*[,;]\s*|\s+&\s+/).map((x) => x.trim()).filter(Boolean);
}

// ── Tool implementations ────────────────────────────────────────────────────
const IMPL = {
  async search_posts(args, env) {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
    const where = [], params = []; let p = 1;
    if (args.status) { where.push(`status = ?${p++}`); params.push(String(args.status)); }
    if (args.category) { where.push(`categories LIKE ?${p++}`); params.push('%"' + args.category + '"%'); }
    if (args.query) { where.push(`(title LIKE ?${p} OR excerpt LIKE ?${p})`); params.push('%' + args.query + '%'); p++; }
    const sql = `SELECT slug, title, excerpt, status, published_at, categories, main_category
                 FROM posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ${limit}`;
    const rows = (await env.DB.prepare(sql).bind(...params).all()).results || [];
    const slugs = rows.map((r) => r.slug);
    const views = await viewsForSlugs(env, slugs);
    return {
      count: rows.length,
      posts: rows.map((r) => ({
        slug: r.slug, title: r.title, status: r.status, date: iso(r.published_at),
        category: r.main_category || (parseJSON(r.categories, [])[0] || ''),
        views: views[r.slug] || 0,
        excerpt: r.excerpt || '',
      })),
    };
  },

  async get_post(args, env) {
    if (!args.slug) throw new Error('slug is required');
    const r = await env.DB.prepare(
      `SELECT slug, title, excerpt, status, published_at, categories, tags, author_name,
              cover_image, seo_title, seo_description, body_html, reading_time_min
       FROM posts WHERE slug = ?1 LIMIT 1`
    ).bind(String(args.slug).toLowerCase()).first();
    if (!r) throw new Error('no post with slug "' + args.slug + '"');
    const views = await viewsForSlugs(env, [r.slug]);
    let body = r.body_html || '';
    const truncated = body.length > 24000;
    if (truncated) body = body.slice(0, 24000) + '\n<!-- …truncated… -->';
    return {
      slug: r.slug, title: r.title, status: r.status, date: iso(r.published_at),
      excerpt: r.excerpt || '', categories: parseJSON(r.categories, []), tags: parseJSON(r.tags, []),
      author: r.author_name || '', cover_image: r.cover_image || '',
      seo_title: r.seo_title || '', seo_description: r.seo_description || '',
      reading_time_min: r.reading_time_min || null, views: views[r.slug] || 0,
      body_html: body, body_truncated: truncated,
    };
  },

  async list_post_drafts(args, env) {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 100);
    const rows = (await env.DB.prepare(
      `SELECT slug, title, excerpt, updated_at FROM posts WHERE status='draft' ORDER BY updated_at DESC LIMIT ${limit}`
    ).all()).results || [];
    return { count: rows.length, drafts: rows.map((r) => ({ slug: r.slug, title: r.title, excerpt: r.excerpt || '', updated: iso(r.updated_at), edit_url: 'https://admin.oftmw.com/post.html?id=&slug=' + r.slug })) };
  },

  async get_post_views(args, env) {
    if (args.slug) {
      const r = await env.DB.prepare('SELECT slug, views, wix_views FROM post_views WHERE slug = ?1').bind(String(args.slug).toLowerCase()).first();
      if (!r) return { slug: args.slug, total: 0, live: 0, wix: 0, note: 'no views recorded yet' };
      return { slug: r.slug, total: (r.views || 0) + (r.wix_views || 0), live: r.views || 0, wix: r.wix_views || 0 };
    }
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
    const rows = (await env.DB.prepare('SELECT slug, views, wix_views FROM post_views').all()).results || [];
    const ranked = rows.map((r) => ({ slug: r.slug, total: (r.views || 0) + (r.wix_views || 0), live: r.views || 0, wix: r.wix_views || 0 }))
      .sort((a, b) => b.total - a.total).slice(0, limit);
    return { top: ranked };
  },

  async search_projects(args, env) {
    const all = await loadProjects();
    const q = (args.query || '').toLowerCase();
    const city = (args.city || '').toLowerCase();
    const type = (args.type || '').toLowerCase();
    const arch = (args.architect || '').toLowerCase();
    const dev = (args.developer || '').toLowerCase();
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
    const hit = all.filter((p) => {
      if (q && !((p.Title || '') + ' ' + (p.City || '') + ' ' + (p.Description || '')).toLowerCase().includes(q)) return false;
      if (city && !(p.City || '').toLowerCase().includes(city)) return false;
      if (type && !((p.ProjectType || '') + ' ' + (p.PreferredType || '')).toLowerCase().includes(type)) return false;
      if (arch && !(p.Architect || '').toLowerCase().includes(arch)) return false;
      if (dev && !(p.Developer || '').toLowerCase().includes(dev)) return false;
      return true;
    });
    return { count: hit.length, showing: Math.min(hit.length, limit), projects: hit.slice(0, limit).map(projectSummary) };
  },

  async list_project_types() {
    const all = await loadProjects();
    const counts = new Map();
    for (const p of all) for (const t of splitList(p.ProjectType)) counts.set(t, (counts.get(t) || 0) + 1);
    return { types: [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count) };
  },

  async list_architects(args) {
    return firmList(await loadProjects(), 'Architect', args);
  },
  async list_developers(args) {
    return firmList(await loadProjects(), 'Developer', args);
  },

  async create_post_draft(args, env) {
    if (!args.title || !String(args.title).trim()) throw new Error('title is required');
    const title = String(args.title).trim();
    let slug = slugify(title);
    // Ensure unique slug.
    const exists = await env.DB.prepare('SELECT 1 FROM posts WHERE slug = ?1 LIMIT 1').bind(slug).first();
    if (exists) slug = (slug + '-' + Math.random().toString(36).slice(2, 6)).slice(0, 160);
    const id = 'tmw-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    const bodyHtml = mdToHtml(args.body_markdown || '');
    const text = stripHtml(bodyHtml);
    const excerpt = (args.excerpt && String(args.excerpt).trim()) || text.slice(0, 180);
    const categories = args.category ? JSON.stringify([String(args.category)]) : '[]';
    const reading = Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 200));
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO posts (id, slug, title, excerpt, body_html, cover_image, categories, tags,
                          author_name, status, published_at, reading_time_min, body_source, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', ?8, 'draft', NULL, ?9, 'studio-mcp', ?10, ?10)`
    ).bind(id, slug, title, excerpt, bodyHtml, args.cover_image || null, categories, 'Claude (Studio)', reading, now).run();
    return {
      ok: true, id, slug, status: 'draft',
      edit_url: 'https://admin.oftmw.com/post.html?id=' + id,
      note: 'Saved as a DRAFT. Review/finish it in the Studio, then publish from there.',
    };
  },
};

function firmList(all, field, args) {
  const q = (args && args.query || '').toLowerCase();
  const limit = Math.min(Math.max(parseInt(args && args.limit, 10) || 50, 1), 200);
  const counts = new Map();
  for (const p of all) for (const f of splitList(p[field])) counts.set(f, (counts.get(f) || 0) + 1);
  let list = [...counts.entries()].map(([name, count]) => ({ name, count }));
  if (q) list = list.filter((x) => x.name.toLowerCase().includes(q));
  list.sort((a, b) => b.count - a.count);
  return { count: list.length, [field.toLowerCase() + 's']: list.slice(0, limit) };
}

async function viewsForSlugs(env, slugs) {
  const out = {};
  if (!slugs.length) return out;
  try {
    const rows = (await env.DB.prepare('SELECT slug, views, wix_views FROM post_views').all()).results || [];
    const map = {};
    for (const r of rows) map[r.slug] = (r.views || 0) + (r.wix_views || 0);
    for (const s of slugs) out[s] = map[s] || 0;
  } catch (_) {}
  return out;
}

// ── JSON-RPC / MCP transport ────────────────────────────────────────────────
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function dispatch(msg, env) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'Markets of Tomorrow Studio. Read journal posts/drafts/views and Map of Tomorrow projects; create article DRAFTS (never publishes). Drafts land in the Studio for human review.',
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const impl = IMPL[name];
    if (!impl) return rpcResult(id, { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true });
    try {
      const result = await impl(args, env);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + (e && e.message || String(e)) }], isError: true });
    }
  }
  // Unknown method.
  if (id === undefined || id === null) return null;   // it was a notification
  return rpcError(id, -32601, 'Method not found: ' + method);
}

const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
};

export async function handleMcp(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: MCP_CORS });

  // Accept either the static Desktop token (STUDIO_MCP_TOKEN) or a live OAuth
  // access token (claude.ai). The 401 points Claude at the resource metadata so
  // its custom-connector flow can discover the OAuth endpoints.
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!(await isAuthorized(token, env))) {
    const rm = new URL(request.url).origin + '/.well-known/oauth-protected-resource';
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${rm}"`, ...MCP_CORS },
    });
  }

  if (request.method === 'GET') {
    // Stateless server: no server→client SSE stream to open.
    return new Response('Method Not Allowed', { status: 405, headers: MCP_CORS });
  }

  let payload;
  try { payload = await request.json(); }
  catch (_) { return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), { status: 400, headers: { 'Content-Type': 'application/json', ...MCP_CORS } }); }

  _projectsCache = null;   // fresh per request

  const batch = Array.isArray(payload);
  const msgs = batch ? payload : [payload];
  const responses = [];
  for (const m of msgs) {
    const r = await dispatch(m, env);
    if (r) responses.push(r);
  }
  // All notifications → 202 with no body.
  if (!responses.length) return new Response(null, { status: 202, headers: MCP_CORS });
  const body = batch ? responses : responses[0];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...MCP_CORS } });
}
