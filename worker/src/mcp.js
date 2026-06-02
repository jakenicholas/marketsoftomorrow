/*
  TMW "Studio" — remote MCP server (Model Context Protocol over Streamable HTTP).

  Lets Claude (Desktop via token auth; claude.ai via OAuth) run the Studio
  remotely. READ everything, and WRITE only safe, reviewable artifacts:
    • Journal:  read posts/drafts/views; create + edit article DRAFTS (never publishes)
    • Media:    upload photos (by URL) into folders; create + list folders; list media
    • Lists:    read/list the studio lists (clients, iconic rankings…); add rows; replace
    • Map:      create + list MAP DRAFTS (staged in D1 for a human to promote — never live)
    • Analytics: audience stats (members/events), per-post views, GA4 journal engagement

  Everything a write-tool produces is a DRAFT or a list edit a human can see and
  undo in the Studio — nothing here publishes to the live journal or live map.

  Transport: a minimal, stateless JSON-RPC 2.0 handler. Each POST /mcp carries
  one JSON-RPC message; we answer inline as application/json. No SSE/Durable
  Object needed because every tool call is a self-contained request/response.

  Auth: Authorization: Bearer <token> — either the static Desktop token
  (STUDIO_MCP_TOKEN) or a live OAuth access token (claude.ai). See oauth.js.
*/

import { isAuthorized } from './oauth.js';
import { getGoogleAccessToken } from './index.js';

// serverInfo per the MCP `Implementation` shape. `title`/`websiteUrl`/`icons`
// were added in spec 2025-11-25 (SEP-973). Clients that support icons (e.g.
// Claude Desktop) show the TMW logo now; claude.ai ignores it today (open
// request: anthropics/claude-ai-mcp#152) but will pick it up automatically when
// that ships — no server change needed then.
const SERVER_INFO = {
  name: 'tmw-studio',
  title: 'Markets of Tomorrow Studio',
  version: '1.0.0',
  websiteUrl: 'https://www.oftmw.com',
  icons: [
    {
      src: 'https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_247de859635d486f9fee7c9b7261dae2~mv2.jpg',
      mimeType: 'image/jpeg',
      sizes: ['1080x1080'],
    },
  ],
};
const DEFAULT_PROTOCOL = '2025-06-18';
const PROJECTS_URL = 'https://map.oftmw.com/projects-flat.json';
const ARTICLES_URL = 'https://map.oftmw.com/articles.json';

// ── Tool catalog ────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_posts',
    description: 'Search/list journal articles in the Studio (D1). Filter by free-text query, status (published|draft|scheduled), or category. Paginated via offset. Returns slug, title, status, date, category and total view count. For pulling the WHOLE corpus, use list_posts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against title + excerpt' },
        status: { type: 'string', enum: ['published', 'draft', 'scheduled'], description: 'Filter by post status' },
        category: { type: 'string', description: 'Filter by a category label' },
        limit: { type: 'integer', description: 'Max results (default 20, max 100)' },
        offset: { type: 'integer', description: 'Pagination offset (default 0)' },
      },
    },
  },
  {
    name: 'list_posts',
    description: 'Bulk-list journal posts as compact rows (slug, title, date, status, category, reading time, views, short excerpt) — built for pulling the WHOLE corpus to learn the house style. Paginated: returns total, hasMore, and nextOffset; default 100, up to 500 per call (so the full archive is usually one or two calls). Filter by status/category. Then deep-read any single post with get_post.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['published', 'draft', 'scheduled'], description: 'Filter by post status' },
        category: { type: 'string', description: 'Filter by a category label' },
        limit: { type: 'integer', description: 'Per page (default 100, max 500)' },
        offset: { type: 'integer', description: 'Pagination offset — pass nextOffset from the previous call' },
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
    name: 'search_firms',
    description: 'Search architect AND developer firms across Map of Tomorrow projects in one call (by name substring), with project counts. Use when you are not sure whether a firm is an architect or a developer.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Firm name substring' },
        role: { type: 'string', enum: ['architect', 'developer', 'both'], description: 'Which side to search (default both)' },
        limit: { type: 'integer', description: 'Max per role (default 25, max 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_lists',
    description: 'Search rows ACROSS the studio lists (the client wall + iconic rankings). Matches the query against each row’s full contents; optionally limit to one list by slug. Use to check whether something is already listed, or find which list a name lives in.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to find within list rows (name, location, industry, etc.)' },
        slug: { type: 'string', description: 'Limit the search to one list (e.g. "clients")' },
        limit: { type: 'integer', description: 'Max matches (default 30, max 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_media',
    description: 'Search the Studio media library by filename, alt text, or caption (optionally within one folder). Returns public URLs. (list_media browses by folder; this searches by text.)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text matched against filename, alt, and caption' },
        folder: { type: 'string', description: 'Limit to one folder' },
        limit: { type: 'integer', description: 'Max results (default 40, max 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_articles',
    description: 'Search Map of Tomorrow article coverage — which journal articles are linked to which map projects. Pass a project slug to get that project’s articles, or a query to match article titles across all projects.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text matched against article titles' },
        project: { type: 'string', description: 'A project slug — returns all articles linked to it' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50)' },
      },
    },
  },
  {
    name: 'create_post_draft',
    description: 'Create a NEW journal article DRAFT in the Studio (status=draft — it does NOT publish). Returns the draft id, slug, and the Studio edit URL so a human can review, finish, and publish it. If the article is about a Map of Tomorrow project, pass linked_project to embed the live project card.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article headline' },
        body_markdown: { type: 'string', description: 'Article body in Markdown (headings, paragraphs, **bold**, *italic*, [links](url), - lists)' },
        excerpt: { type: 'string', description: '1–2 sentence summary (optional; auto-derived if omitted)' },
        category: { type: 'string', description: 'Primary category label (optional)' },
        cover_image: { type: 'string', description: 'Absolute cover image URL (optional)' },
        linked_project: { type: 'string', description: 'Slug of the Map of Tomorrow project this article covers — embeds the live project card (status, intel, stats) in the post, exactly like the Studio "linked project" picker. Use the slug from search_projects. Always set this when the article is about a tracked project.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_post_draft',
    description: 'Edit an existing journal article DRAFT (only status=draft — refuses to touch published/scheduled posts). Update any of title, body, excerpt, category, cover image. Returns the Studio edit URL.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug of the draft to edit' },
        title: { type: 'string' },
        body_markdown: { type: 'string', description: 'Replacement body in Markdown' },
        excerpt: { type: 'string' },
        category: { type: 'string' },
        cover_image: { type: 'string' },
        linked_project: { type: 'string', description: 'Slug of the Map of Tomorrow project to link — embeds the live project card (added once if not already present). Use to connect an existing draft to its project.' },
      },
      required: ['slug'],
    },
  },

  // ── Media ──────────────────────────────────────────────────────────────────
  {
    name: 'upload_photo',
    description: 'Upload a photo (or video) into the Studio media library by URL. Fetches source_url, stores it in R2, and indexes it in the chosen folder so it shows up in the Studio media picker. Returns the permanent public URL. Use list_media_folders to see folders, or just pass any folder name (created if new).',
    inputSchema: {
      type: 'object',
      properties: {
        source_url: { type: 'string', description: 'Public http(s) URL of the image/video to import' },
        folder: { type: 'string', description: 'Destination folder name (created if it does not exist). Omit for "Unfiled".' },
        alt: { type: 'string', description: 'Alt text (accessibility / SEO)' },
        caption: { type: 'string', description: 'Caption (optional)' },
        filename: { type: 'string', description: 'Override the stored filename (optional; derived from the URL otherwise)' },
      },
      required: ['source_url'],
    },
  },
  {
    name: 'create_media_folder',
    description: 'Create a media folder in the Studio library (so photos can be uploaded into it). Optionally star it as a favorite so it sorts first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name' },
        favorite: { type: 'boolean', description: 'Pin to the top of the folder list' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_media_folders',
    description: 'List Studio media folders with the number of assets in each (favorites first).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_media',
    description: 'List/search uploaded media in the Studio library. Filter by folder and/or free-text (filename + alt). Returns public URLs, folders, alt/caption.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Limit to one folder' },
        query: { type: 'string', description: 'Free text matched against filename + alt' },
        limit: { type: 'integer', description: 'Max results (default 40, max 100)' },
      },
    },
  },

  // ── Lists (client wall, iconic rankings…) ──────────────────────────────────
  {
    name: 'list_lists',
    description: 'List the Studio lists that have saved rows, with item counts. Examples: "clients" (the client/partner wall shown on the journal + media kit) and the iconic ranking lists (e.g. hotels, restaurants, golf).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_list',
    description: 'Read one Studio list by slug (e.g. "clients") — returns its title and the full array of item rows so you can see the existing schema before adding to it.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
  {
    name: 'add_to_list',
    description: 'Append one row to a Studio list (creates the list if it does not exist yet). The item is a free-form object — match the existing rows\' shape (call get_list first). For "clients" use {name, logo, industries, location, active}. Edits go live on the journal/media-kit immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'List slug, e.g. "clients"' },
        item: { type: 'object', description: 'The row to add (object). e.g. {"name":"Acme","logo":"https://…","location":"Miami, FL","active":true}' },
        position: { type: 'string', enum: ['top', 'bottom'], description: 'Where to insert (default bottom)' },
        title: { type: 'string', description: 'Set the list title (only used when first creating the list)' },
      },
      required: ['slug', 'item'],
    },
  },
  {
    name: 'update_list',
    description: 'Replace the entire array of rows for a Studio list (full overwrite — use add_to_list for a single append). Preserves the existing title unless you pass a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        items: { type: 'array', description: 'The complete new array of row objects', items: { type: 'object' } },
        title: { type: 'string' },
      },
      required: ['slug', 'items'],
    },
  },

  // ── Map drafts ─────────────────────────────────────────────────────────────
  {
    name: 'create_map_draft',
    description: 'Propose a NEW Map of Tomorrow project as a DRAFT. The draft is queued for human review in the TMW Studio map admin at https://admin.oftmw.com/map/ → "Drafts" tab, where it appears immediately as a "CLAUDE DRAFT". It is NOT on the live map until someone reviews and promotes it from that Drafts tab. (Implementation detail, not a separate system: that admin reads its queue directly from tmw-data/data/drafts.json — this is the CURRENT review queue, not a legacy path. Never tell the user the draft went somewhere the admin cannot see it.) Provide what you know; lat/lng are needed before it can be placed (you can geocode on review).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project name (stored as "name"; slug is derived from it)' },
        status: { type: 'string', enum: ['announced', 'breaking-ground', 'construction', 'coming-soon', 'open'], description: 'Project status (default "announced")' },
        city: { type: 'string' },
        address: { type: 'string', description: 'Street address — captured in source_note to help geocoding' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        description: { type: 'string', description: 'Short 1–2 sentence summary' },
        description_long: { type: 'string', description: 'Full descriptive paragraph' },
        types: { type: 'array', items: { type: 'string' }, description: 'Project types from the controlled vocab: Residences, Hotel, Mixed-Use, Entertainment, Eateries, Retail, Office, Park, Marina, Golf, Resort, Cultural, Museum, Stadium, Education, Healthcare, Spa, Travel, Airport, Opera House, Hospital' },
        preferred_type: { type: 'string', description: 'The single primary type (defaults to the first of types)' },
        architects: { type: 'array', items: { type: 'string' }, description: 'Architect firm names. Each is matched against the firm registry (punctuation-insensitive) and bound to the canonical slug so established firms attach in the admin picker; names with no match are CREATED as new registry records (so they bind too). Use the real firm name (e.g. "Spina O\'Rourke + Partners"); search_firms can confirm existing ones first.' },
        developers: { type: 'array', items: { type: 'string' }, description: 'Developer firm names — matched to the firm registry like architects; existing firms bind to the picker and brand-new ones are created as registry records automatically.' },
        website: { type: 'string', description: 'Official project website' },
        units: { type: 'integer' },
        floors: { type: 'integer' },
        start_date: { type: 'string', description: 'Construction start date — year ("2027") or ISO ("2027-06"). Set start_speculative when it is a TMW estimate rather than developer-committed.' },
        delivery_date: { type: 'string', description: 'Expected completion/delivery date — year or ISO. Set delivery_speculative when it is a TMW estimate.' },
        start_speculative: { type: 'boolean', description: 'True if start_date is a TMW estimate (not developer-committed) — checks the "TMW estimate" box on the start date.' },
        delivery_speculative: { type: 'boolean', description: 'True if delivery_date is a TMW estimate — checks the "TMW estimate" box on the delivery date.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Image URLs (hero / renders)' },
        source_note: { type: 'string', description: 'Where this came from — e.g. the TMW article URL or press source' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_map_drafts',
    description: 'List the pending Map of Tomorrow project drafts awaiting review in the TMW Studio map admin (https://admin.oftmw.com/map/ → "Drafts" tab), newest first. (Source: tmw-data/data/drafts.json, which that admin reads directly — same queue, not a legacy file.)',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Max results (default 50)' } } },
  },

  // ── Analytics ──────────────────────────────────────────────────────────────
  {
    name: 'get_audience_stats',
    description: 'Audience analytics from the first-party event store: total/paid/free members, members active right now and in the last 7 days, event volume (today / 7d / prior 7d / all-time), and the most common event names.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_journal_analytics',
    description: 'Journal engagement from GA4 over the last N days (default 28): counts for the custom journal events (jrn_partner, jrn_share, jrn_post_open, jrn_outbound, jrn_map, jrn_mediakit) and newsletter signups (subscribe_home, subscribe_article), plus the top events overall.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', description: 'Look-back window in days (default 28, max 365)' } } },
  },

  // ── Brand brain (shared house style / taste, updates for both accounts) ──────
  {
    name: 'get_brand_brain',
    description: 'Read the shared Markets of Tomorrow "brand brain" — the house style and accumulated taste the team teaches over time: voice, rules, structure, topics to lean into, things to avoid, and example posts that worked. CALL THIS FIRST before writing or critiquing any post, carousel, caption, headline, or article so the output matches the brand. Returns a ready-to-use markdown playbook plus the structured notes (with ids). It is the SAME brain for every connected account, so it reflects what either person has taught it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'record_preference',
    description: 'Add a learning to the shared brand brain so it updates for BOTH accounts immediately. Use whenever someone expresses a like, dislike, rule, voice/tone note, structure preference, topic interest, or names a good example. Keep each note to one crisp, reusable sentence. Do this proactively as you learn what they like/dislike.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['like', 'dislike', 'rule', 'voice', 'structure', 'topic', 'avoid', 'example'], description: 'What kind of guidance this is' },
        note: { type: 'string', description: 'One crisp, reusable sentence of guidance' },
        category: { type: 'string', description: 'Optional grouping, e.g. "carousel", "article", "headline", "general"' },
        context: { type: 'string', description: 'Optional: a post slug, example snippet, or the reason behind it' },
        by: { type: 'string', description: 'Who said it, if known (e.g. "Jake", "wife")' },
      },
      required: ['kind', 'note'],
    },
  },
  {
    name: 'remove_brand_note',
    description: 'Retire one note from the brand brain by its id (from get_brand_brain) — use when a preference changes or a note was wrong.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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

let _articlesCache = null;
async function loadArticles() {
  if (_articlesCache) return _articlesCache;
  const r = await fetch(ARTICLES_URL, { cf: { cacheTtl: 60 } });
  if (!r.ok) throw new Error('articles feed ' + r.status);
  const data = await r.json();
  _articlesCache = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  return _articlesCache;
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

// Must match index.js's list-slug guard so MCP writes hit the same rows the
// page editors do (clients, hotels, restaurants, golf, …).
const LIST_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Same R2 key shape as the upload handler: YYYY/MM/<rand>-<safe-name>.
function buildMediaKey(filename) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const hash = [...rand].map((b) => b.toString(16).padStart(2, '0')).join('');
  const safe = String(filename || 'upload')
    .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'upload';
  return `${yyyy}/${mm}/${hash}-${safe}`;
}

async function ensureMediaFoldersTable(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS media_folders (name TEXT PRIMARY KEY, favorite INTEGER DEFAULT 0, created_at INTEGER)').run();
}
async function ensureBrandNotesTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS brand_notes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, category TEXT, note TEXT NOT NULL, context TEXT, created_by TEXT, created_at INTEGER, active INTEGER DEFAULT 1)'
  ).run();
}

// ── Map drafts → tmw-data/data/drafts.json via the GitHub Contents API ───────
// Map drafts live in the tmw-data repo. The TMW Studio map admin at
// admin.oftmw.com/map/ reads this file DIRECTLY (via its /api/gh proxy) and
// renders every entry under its "Drafts" tab — so writing here IS writing to
// the admin's review queue, not a disconnected/legacy data file. The worker
// writes with a fine-grained PAT in the GH_TOKEN secret. Repo/branch/path are
// overridable via env.
const MAP_ADMIN_URL = 'https://admin.oftmw.com/map/';
const GH_DRAFTS_PATH = 'data/drafts.json';
function ghRepo(env)   { return env.GH_DRAFTS_REPO || 'jakenicholas/tmw-data'; }
function ghBranch(env) { return env.GH_DRAFTS_BRANCH || 'main'; }
function ghHeaders(env) {
  return {
    Authorization: 'Bearer ' + env.GH_TOKEN,
    'User-Agent': 'tmw-studio',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
// UTF-8-safe base64 (GitHub returns/expects base64; descriptions carry em-dashes, $, …).
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function requireGhToken(env) {
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is not set on the worker. Add a fine-grained PAT for ' + ghRepo(env) + ' (Contents: read+write), then `cd worker && npx wrangler secret put GH_TOKEN`.');
}
async function ghGetFile(env, path) {
  const url = `https://api.github.com/repos/${ghRepo(env)}/contents/${path}?ref=${encodeURIComponent(ghBranch(env))}`;
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (r.status === 404) return { sha: null, text: null };
  if (!r.ok) throw new Error('GitHub read failed (HTTP ' + r.status + '): ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  return { sha: data.sha, text: b64decodeUtf8(data.content) };
}
async function ghPutFile(env, path, contentStr, sha, message) {
  const body = { message, content: b64encodeUtf8(contentStr), branch: ghBranch(env) };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${ghRepo(env)}/contents/${path}`, {
    method: 'PUT', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = new Error('GitHub write failed (HTTP ' + r.status + '): ' + (await r.text()).slice(0, 200));
    e.status = r.status; // 409 = stale sha (concurrent write) — callers may retry
    throw e;
  }
  return await r.json();
}

// ── Firm registry → resolve architect/developer names to canonical slugs ─────
// The admin form's architect/developer pickers bind on the EXACT slug from
// tmw-data's firm registry (data/architects.json + data/developers.json).
// Naively slugifying a name can miss the canonical slug — e.g. "Spina O'Rourke
// + Partners" slugifies to "spina-o-rourke-partners" but the registry slug is
// "spina-orourke-partners" — so the established firm wouldn't attach. We load
// the registry and match on a punctuation-insensitive normalized name, falling
// back to slugify() only for genuinely new firms.
let _firmRegCache = null;
function normFirmName(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ''); }
async function loadFirmRegistry(env) {
  if (_firmRegCache) return _firmRegCache;
  const reg = { architects: new Map(), developers: new Map() };
  for (const [role, path] of [['architects', 'data/architects.json'], ['developers', 'data/developers.json']]) {
    try {
      const { text } = await ghGetFile(env, path);
      const arr = text ? JSON.parse(text) : [];
      for (const f of (Array.isArray(arr) ? arr : [])) {
        if (f && f.slug && f.name) reg[role].set(normFirmName(f.name), { slug: f.slug, name: f.name });
      }
    } catch (_) { /* registry unavailable — resolveFirms will fall back to slugify */ }
  }
  _firmRegCache = reg;
  return _firmRegCache;
}
// Resolve firm names to canonical slugs; report which matched an existing firm.
function resolveFirms(names, regMap) {
  const slugs = [], report = [];
  for (const raw of (Array.isArray(names) ? names : [])) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const hit = regMap.get(normFirmName(name));
    const slug = hit ? hit.slug : slugify(name);
    if (slug) { slugs.push(slug); report.push({ name, slug, existing: !!hit }); }
  }
  return { slugs, report };
}

// Create brand-new firms (existing:false) as real records in the registry file
// so they bind in the admin picker and aren't silently dropped. The admin's
// chip picker only renders firms it finds in architects.json/developers.json —
// an unknown slug shows nothing and is NOT created on publish — so staging a
// slug on the draft isn't enough; the firm record must exist. Mirrors the
// registry's record shape, dedupes by slug, retries on a 409 sha conflict.
async function ensureFirms(env, role, report) {
  const fresh = (report || []).filter((f) => f && !f.existing && f.slug);
  if (!fresh.length) return [];
  const path = role === 'architects' ? 'data/architects.json' : 'data/developers.json';
  for (let attempt = 0; ; attempt++) {
    const { sha, text } = await ghGetFile(env, path);
    let arr = [];
    if (text) { try { arr = JSON.parse(text); } catch (_) { throw new Error(path + ' is not valid JSON — refusing to overwrite'); } }
    if (!Array.isArray(arr)) arr = [];
    const have = new Set(arr.map((f) => f && f.slug));
    const created = [];
    for (const f of fresh) {
      if (have.has(f.slug)) continue;
      arr.push({ slug: f.slug, name: f.name, project_count: 0, hq: null, founded: null, bio_md_slug: f.slug });
      have.add(f.slug);
      created.push(f.slug);
    }
    if (!created.length) return []; // someone else already added them
    try {
      await ghPutFile(env, path, JSON.stringify(arr, null, 2) + '\n', sha, `Studio: register ${created.length} ${role} — ${created.join(', ')}`);
      return created;
    } catch (e) {
      if (e && e.status === 409 && attempt < 4) continue;
      throw e;
    }
  }
}

// ── Tool implementations ────────────────────────────────────────────────────
const IMPL = {
  async search_posts(args, env) {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
    const where = [], params = []; let p = 1;
    if (args.status) { where.push(`status = ?${p++}`); params.push(String(args.status)); }
    if (args.category) { where.push(`categories LIKE ?${p++}`); params.push('%"' + args.category + '"%'); }
    if (args.query) { where.push(`(title LIKE ?${p} OR excerpt LIKE ?${p})`); params.push('%' + args.query + '%'); p++; }
    const sql = `SELECT slug, title, excerpt, status, published_at, categories, main_category
                 FROM posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = (await env.DB.prepare(sql).bind(...params).all()).results || [];
    const slugs = rows.map((r) => r.slug);
    const views = await viewsForSlugs(env, slugs);
    return {
      count: rows.length, offset,
      posts: rows.map((r) => ({
        slug: r.slug, title: r.title, status: r.status, date: iso(r.published_at),
        category: r.main_category || (parseJSON(r.categories, [])[0] || ''),
        views: views[r.slug] || 0,
        excerpt: r.excerpt || '',
      })),
    };
  },

  async list_posts(args, env) {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
    const where = [], params = []; let p = 1;
    if (args.status) { where.push(`status = ?${p++}`); params.push(String(args.status)); }
    if (args.category) { where.push(`categories LIKE ?${p++}`); params.push('%"' + args.category + '"%'); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const totalRow = await env.DB.prepare(`SELECT COUNT(*) c FROM posts ${whereSql}`).bind(...params).first();
    const total = totalRow ? totalRow.c : 0;
    const rows = (await env.DB.prepare(
      `SELECT slug, title, excerpt, status, published_at, main_category, categories, reading_time_min
       FROM posts ${whereSql} ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ${limit} OFFSET ${offset}`
    ).bind(...params).all()).results || [];
    const views = await viewsForSlugs(env, rows.map((r) => r.slug));
    const hasMore = offset + rows.length < total;
    return {
      total, offset, count: rows.length, hasMore, nextOffset: hasMore ? offset + rows.length : null,
      posts: rows.map((r) => ({
        slug: r.slug, title: r.title, date: iso(r.published_at), status: r.status,
        category: r.main_category || (parseJSON(r.categories, [])[0] || ''),
        reading_time_min: r.reading_time_min || null, views: views[r.slug] || 0,
        excerpt: (r.excerpt || '').slice(0, 160),
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

  async search_firms(args) {
    const q = String(args.query || '').trim().toLowerCase();
    if (!q) throw new Error('query is required');
    const role = String(args.role || 'both').toLowerCase();
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 100);
    const all = await loadProjects();
    const build = (field) => {
      const counts = new Map();
      for (const p of all) for (const f of splitList(p[field])) counts.set(f, (counts.get(f) || 0) + 1);
      return [...counts.entries()]
        .filter(([name]) => name.toLowerCase().includes(q))
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    };
    const out = { query: args.query };
    if (role === 'architect' || role === 'both') out.architects = build('Architect');
    if (role === 'developer' || role === 'both') out.developers = build('Developer');
    return out;
  },

  async search_lists(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const q = String(args.query || '').trim().toLowerCase();
    if (!q) throw new Error('query is required');
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 100);
    const onlySlug = String(args.slug || '').trim().toLowerCase();
    let rows;
    if (onlySlug) {
      if (!LIST_SLUG_RE.test(onlySlug)) throw new Error('invalid list slug');
      rows = (await env.DB.prepare('SELECT slug, data FROM iconic_lists WHERE slug = ?1').bind(onlySlug).all()).results || [];
    } else {
      rows = (await env.DB.prepare('SELECT slug, data FROM iconic_lists').all()).results || [];
    }
    const matches = [];
    for (const r of rows) {
      const doc = parseJSON(r.data, {});
      const items = Array.isArray(doc.items) ? doc.items : [];
      items.forEach((item, index) => {
        if (JSON.stringify(item).toLowerCase().includes(q)) matches.push({ list: r.slug, list_title: doc.title || '', index, item });
      });
    }
    return { query: args.query, count: matches.length, showing: Math.min(matches.length, limit), matches: matches.slice(0, limit) };
  },

  async search_media(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const q = String(args.query || '').trim();
    if (!q) throw new Error('query is required');
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 40, 1), 100);
    const folder = String(args.folder || '').trim();
    const where = ['(filename LIKE ?1 OR alt_text LIKE ?1 OR caption LIKE ?1)'];
    const params = ['%' + q + '%'];
    if (folder) { where.push(`folder = ?${params.length + 1}`); params.push(folder); }
    const rows = (await env.DB.prepare(
      `SELECT key, filename, mime_type, size_bytes, alt_text, caption, uploaded_at, url, folder
       FROM media WHERE ${where.join(' AND ')} ORDER BY uploaded_at DESC LIMIT ${limit}`
    ).bind(...params).all()).results || [];
    return {
      query: q, count: rows.length,
      items: rows.map((r) => ({ key: r.key, url: r.url, filename: r.filename, folder: r.folder || '(unfiled)', alt: r.alt_text || '', caption: r.caption || '', mime_type: r.mime_type, size_bytes: r.size_bytes, uploaded: iso(r.uploaded_at) })),
    };
  },

  async search_articles(args) {
    const map = await loadArticles();
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
    const project = String(args.project || '').trim().toLowerCase();
    const q = String(args.query || '').trim().toLowerCase();
    if (project) {
      const arts = map[project] || [];
      return { project, count: arts.length, articles: arts.slice(0, limit) };
    }
    if (!q) throw new Error('pass a project slug, or a query that matches article titles');
    const hits = [];
    for (const [slug, arts] of Object.entries(map)) {
      for (const a of (arts || [])) {
        if (String(a.title || '').toLowerCase().includes(q)) hits.push({ project: slug, title: a.title, link: a.link, published_at: a.published_at });
      }
    }
    hits.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
    return { query: args.query, count: hits.length, showing: Math.min(hits.length, limit), articles: hits.slice(0, limit) };
  },

  async create_post_draft(args, env) {
    if (!args.title || !String(args.title).trim()) throw new Error('title is required');
    const title = String(args.title).trim();
    let slug = slugify(title);
    // Ensure unique slug.
    const exists = await env.DB.prepare('SELECT 1 FROM posts WHERE slug = ?1 LIMIT 1').bind(slug).first();
    if (exists) slug = (slug + '-' + Math.random().toString(36).slice(2, 6)).slice(0, 160);
    const id = 'tmw-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    let bodyHtml = mdToHtml(args.body_markdown || '');
    const linkedSlug = args.linked_project ? String(args.linked_project).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160) : '';
    if (linkedSlug && !/class=["']tmw-(project-card|map-embed)["']/.test(bodyHtml)) {
      bodyHtml += `\n<div class="tmw-project-card" data-project="${linkedSlug}"></div>`;
    }
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
      ok: true, id, slug, status: 'draft', linked_project: linkedSlug || undefined,
      edit_url: 'https://admin.oftmw.com/post.html?id=' + id,
      note: 'Saved as a DRAFT. Review/finish it in the Studio, then publish from there.' + (linkedSlug ? ' Project card embedded for "' + linkedSlug + '".' : ''),
    };
  },

  async update_post_draft(args, env) {
    const slug = String(args.slug || '').trim().toLowerCase();
    if (!slug) throw new Error('slug is required');
    const row = await env.DB.prepare('SELECT id, status, body_html FROM posts WHERE slug = ?1').bind(slug).first();
    if (!row) throw new Error('no post with slug "' + slug + '"');
    if (row.status !== 'draft') throw new Error('refusing to edit a ' + row.status + ' post via MCP — only drafts are editable remotely');
    const sets = [], params = []; let p = 1;
    if (args.title != null) { sets.push(`title = ?${p++}`); params.push(String(args.title)); }

    // Body: rebuild from markdown if given; otherwise start from the stored body
    // so we can inject a project-card link without a full rewrite.
    let finalBody = (args.body_markdown != null) ? mdToHtml(args.body_markdown) : null;
    const derivedExcerpt = (args.body_markdown != null) ? stripHtml(finalBody).slice(0, 180) : null;
    const linkedSlug = args.linked_project ? String(args.linked_project).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160) : '';
    if (linkedSlug) {
      let base = finalBody != null ? finalBody : (row.body_html || '');
      if (!/class=["']tmw-(project-card|map-embed)["']/.test(base)) base += `\n<div class="tmw-project-card" data-project="${linkedSlug}"></div>`;
      finalBody = base;
    }
    if (finalBody != null) {
      sets.push(`body_html = ?${p++}`); params.push(finalBody);
      if (args.body_markdown != null) { sets.push(`reading_time_min = ?${p++}`); params.push(Math.max(1, Math.round(stripHtml(finalBody).split(/\s+/).filter(Boolean).length / 200))); }
    }
    if (args.excerpt != null) { sets.push(`excerpt = ?${p++}`); params.push(String(args.excerpt)); }
    else if (derivedExcerpt && args.body_markdown != null) { sets.push(`excerpt = ?${p++}`); params.push(derivedExcerpt); }
    if (args.category != null) { sets.push(`categories = ?${p++}`); params.push(JSON.stringify([String(args.category)])); }
    if (args.cover_image != null) { sets.push(`cover_image = ?${p++}`); params.push(String(args.cover_image)); }
    if (!sets.length) throw new Error('nothing to update — pass at least one of title/body_markdown/excerpt/category/cover_image/linked_project');
    sets.push(`updated_at = ?${p++}`); params.push(Math.floor(Date.now() / 1000));
    params.push(slug);
    await env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE slug = ?${p}`).bind(...params).run();
    return { ok: true, slug, status: 'draft', linked_project: linkedSlug || undefined, edit_url: 'https://admin.oftmw.com/post.html?id=' + row.id };
  },

  // ── Media ──────────────────────────────────────────────────────────────────
  async upload_photo(args, env) {
    if (!env.MEDIA) throw new Error('R2 media bucket not configured');
    if (!env.DB) throw new Error('D1 not configured');
    const src = String(args.source_url || '').trim();
    if (!/^https?:\/\//i.test(src)) throw new Error('source_url must be a public http(s) URL');
    const folder = String(args.folder || '').slice(0, 120);
    const alt = String(args.alt || '').slice(0, 500);
    const caption = String(args.caption || '').slice(0, 1000);

    const res = await fetch(src, { redirect: 'follow' });
    if (!res.ok) throw new Error('could not fetch source_url (HTTP ' + res.status + ')');
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\//.test(ct) && !/^video\//.test(ct)) {
      throw new Error('source_url is not an image or video (content-type: ' + (ct || 'unknown') + ')');
    }
    const buf = await res.arrayBuffer();
    const MAX = 25 * 1024 * 1024;
    if (buf.byteLength > MAX) throw new Error('file too large (' + buf.byteLength + ' bytes; 25MB max for URL import)');

    let fname = String(args.filename || '').trim();
    if (!fname) { try { fname = decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); } catch (_) {} }
    if (!fname) fname = 'upload';
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'video/mp4': '.mp4' }[ct];
    if (ext && !/\.[a-z0-9]{2,4}$/i.test(fname)) fname += ext;

    const key = buildMediaKey(fname);
    await env.MEDIA.put(key, buf, {
      httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { filename: fname, alt, caption, folder },
    });
    const publicBase = (env.MEDIA_PUBLIC_BASE || '').replace(/\/+$/, '');
    const url = publicBase ? `${publicBase}/${key}` : '';
    const ts = Math.floor(Date.now() / 1000);
    if (folder) { try { await ensureMediaFoldersTable(env); await env.DB.prepare('INSERT OR IGNORE INTO media_folders (name, favorite, created_at) VALUES (?1, 0, ?2)').bind(folder, ts).run(); } catch (_) {} }
    await env.DB.prepare(
      `INSERT INTO media (key, filename, mime_type, size_bytes, alt_text, caption, uploaded_by, uploaded_at, url, folder)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
       ON CONFLICT(key) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type,
         size_bytes=excluded.size_bytes, alt_text=excluded.alt_text, caption=excluded.caption,
         url=excluded.url, folder=excluded.folder`
    ).bind(key, fname, ct, buf.byteLength, alt || null, caption || null, 'studio-mcp', ts, url, folder || '').run();
    return { ok: true, key, url, folder: folder || '(unfiled)', mime_type: ct, size_bytes: buf.byteLength };
  },

  async create_media_folder(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const name = String(args.name || '').trim();
    if (!name || name.length > 120 || /[<>"'\\]/.test(name)) throw new Error('invalid folder name');
    await ensureMediaFoldersTable(env);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('INSERT OR IGNORE INTO media_folders (name, favorite, created_at) VALUES (?1, ?2, ?3)').bind(name, args.favorite ? 1 : 0, now).run();
    if (args.favorite) await env.DB.prepare('UPDATE media_folders SET favorite = 1 WHERE name = ?1').bind(name).run();
    return { ok: true, name, favorite: args.favorite ? 1 : 0 };
  },

  async list_media_folders(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureMediaFoldersTable(env);
    const derived = (await env.DB.prepare(
      "SELECT COALESCE(NULLIF(folder,''),'Unfiled') AS folder, COUNT(*) AS count FROM media GROUP BY COALESCE(NULLIF(folder,''),'Unfiled')"
    ).all()).results || [];
    const registered = (await env.DB.prepare('SELECT name, favorite FROM media_folders').all()).results || [];
    const map = new Map();
    for (const r of derived) map.set(r.folder, { folder: r.folder, count: r.count, favorite: 0 });
    for (const r of registered) { const e = map.get(r.name) || { folder: r.name, count: 0, favorite: 0 }; e.favorite = r.favorite ? 1 : 0; map.set(r.name, e); }
    const folders = [...map.values()].sort((a, b) => (b.favorite - a.favorite) || a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' }));
    const totalRow = await env.DB.prepare('SELECT COUNT(*) c FROM media').first();
    return { folders, total: totalRow ? totalRow.c : 0 };
  },

  async list_media(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 40, 1), 100);
    const q = String(args.query || '').trim();
    const folder = String(args.folder || '').trim();
    const where = [], params = [];
    if (q)      { where.push(`(filename LIKE ?${params.length + 1} OR alt_text LIKE ?${params.length + 1})`); params.push('%' + q + '%'); }
    if (folder) { where.push(`folder = ?${params.length + 1}`); params.push(folder); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = await env.DB.prepare(`SELECT COUNT(*) c FROM media ${whereSql}`).bind(...params).first();
    const rows = (await env.DB.prepare(
      `SELECT key, filename, mime_type, size_bytes, alt_text, caption, uploaded_at, url, folder
       FROM media ${whereSql} ORDER BY uploaded_at DESC LIMIT ${limit}`
    ).bind(...params).all()).results || [];
    return {
      total: total ? total.c : 0, count: rows.length,
      items: rows.map((r) => ({ key: r.key, url: r.url, filename: r.filename, folder: r.folder || '(unfiled)', alt: r.alt_text || '', caption: r.caption || '', mime_type: r.mime_type, size_bytes: r.size_bytes, uploaded: iso(r.uploaded_at) })),
    };
  },

  // ── Lists ──────────────────────────────────────────────────────────────────
  async list_lists(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const rows = (await env.DB.prepare('SELECT slug, data, updated_at, updated_by FROM iconic_lists ORDER BY slug').all()).results || [];
    return {
      count: rows.length,
      lists: rows.map((r) => { const d = parseJSON(r.data, {}); return { slug: r.slug, title: d.title || '', items: Array.isArray(d.items) ? d.items.length : 0, updated: iso(r.updated_at), updated_by: r.updated_by || '' }; }),
      note: 'Known lists include "clients" (the partner/client wall on the journal + media kit) and the iconic ranking lists (e.g. hotels, restaurants, golf). A list with no saved rows yet simply will not appear here until first written.',
    };
  },

  async get_list(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const slug = String(args.slug || '').trim().toLowerCase();
    if (!LIST_SLUG_RE.test(slug)) throw new Error('invalid list slug');
    const row = await env.DB.prepare('SELECT data, updated_at, updated_by FROM iconic_lists WHERE slug = ?1').bind(slug).first();
    if (!row) return { slug, exists: false, title: '', items: [], note: 'No saved rows yet for this list — add_to_list will create it.' };
    const d = parseJSON(row.data, {});
    const items = Array.isArray(d.items) ? d.items : [];
    return { slug, exists: true, title: d.title || '', count: items.length, items, updated: iso(row.updated_at), updated_by: row.updated_by || '' };
  },

  async add_to_list(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const slug = String(args.slug || '').trim().toLowerCase();
    if (!LIST_SLUG_RE.test(slug)) throw new Error('invalid list slug');
    let item = args.item;
    if (typeof item === 'string') { try { item = JSON.parse(item); } catch (_) { item = { name: item }; } }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('item must be an object, e.g. {"name":"…"}');
    const row = await env.DB.prepare('SELECT data FROM iconic_lists WHERE slug = ?1').bind(slug).first();
    const doc = row ? parseJSON(row.data, {}) : {};
    if (!Array.isArray(doc.items)) doc.items = [];
    if (args.title && !doc.title) doc.title = String(args.title);
    if (args.position === 'top') doc.items.unshift(item); else doc.items.push(item);
    const serialized = JSON.stringify(doc);
    if (serialized.length > 1_000_000) throw new Error('list too large (1MB max)');
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO iconic_lists (slug, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(slug) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(slug, serialized, now, 'Claude (Studio MCP)').run();
    return { ok: true, slug, items: doc.items.length, added: item, note: 'Live consumers (journal wall / media kit) read this list directly, so the change is visible immediately.' };
  },

  async update_list(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const slug = String(args.slug || '').trim().toLowerCase();
    if (!LIST_SLUG_RE.test(slug)) throw new Error('invalid list slug');
    let items = args.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { throw new Error('items must be a JSON array'); } }
    if (!Array.isArray(items)) throw new Error('items must be an array of row objects');
    let title = args.title != null ? String(args.title) : null;
    if (title == null) { const row = await env.DB.prepare('SELECT data FROM iconic_lists WHERE slug = ?1').bind(slug).first(); title = (row ? parseJSON(row.data, {}) : {}).title || ''; }
    const serialized = JSON.stringify({ title, items });
    if (serialized.length > 1_000_000) throw new Error('list too large (1MB max)');
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO iconic_lists (slug, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(slug) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(slug, serialized, now, 'Claude (Studio MCP)').run();
    return { ok: true, slug, items: items.length };
  },

  // ── Map drafts (→ tmw-data/data/drafts.json) ────────────────────────────────
  async create_map_draft(args, env) {
    requireGhToken(env);
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required');
    const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
    const types = Array.isArray(args.types) ? args.types.map((t) => String(t).trim()).filter(Boolean) : [];

    // Resolve architect/developer names to the registry's canonical slugs so
    // established firms attach in the admin picker (not duplicate slugs), and
    // create any brand-new firms as real registry records so they bind too.
    const registry = await loadFirmRegistry(env);
    const archRes = resolveFirms(args.architects, registry.architects);
    const devRes = resolveFirms(args.developers, registry.developers);
    const createdArch = await ensureFirms(env, 'architects', archRes.report);
    const createdDev = await ensureFirms(env, 'developers', devRes.report);
    const createdSet = new Set([...createdArch, ...createdDev]);
    for (const f of [...archRes.report, ...devRes.report]) {
      if (createdSet.has(f.slug)) { f.created = true; f.existing = true; } // now a real registry record
    }

    const data = {
      slug: slugify(title),
      name: title,
      status: String(args.status || 'announced'),
      city: String(args.city || ''),
      lat: num(args.latitude),
      lng: num(args.longitude),
      types,
      preferred_type: String(args.preferred_type || types[0] || ''),
      description: String(args.description || ''),
      description_long: String(args.description_long || args.description || ''),
      architect_slugs: archRes.slugs,
      developer_slugs: devRes.slugs,
      official_website: String(args.website || ''),
      units: num(args.units),
      floors: num(args.floors),
    };
    if (Array.isArray(args.images) && args.images.length) data.images = args.images.map(String);
    // Dates (optional). The admin reads start_date/delivery_date + their
    // *_speculative flags — set the flag when it's a TMW estimate vs a
    // developer-committed date.
    if (args.start_date) data.start_date = String(args.start_date);
    if (args.delivery_date) data.delivery_date = String(args.delivery_date);
    if (args.start_speculative) data.start_speculative = true;
    if (args.delivery_speculative) data.delivery_speculative = true;

    const isoNow = new Date().toISOString();
    const stamp = isoNow.slice(0, 10);
    const sourceParts = [];
    if (args.source_note) sourceParts.push(String(args.source_note));
    if (args.address) sourceParts.push('Address: ' + String(args.address));
    const source_note = sourceParts.join(' — ');

    // Read-modify-write the shared drafts.json with optimistic-locking retry:
    // if two create_map_draft calls race, the second PUT gets a 409 (stale sha),
    // so we re-read the latest file, re-derive the dated draft_id/seq, and retry —
    // no draft is dropped or clobbered.
    let draft_id, entry;
    for (let attempt = 0; ; attempt++) {
      const { sha, text } = await ghGetFile(env, GH_DRAFTS_PATH);
      let drafts = [];
      if (text) { try { drafts = JSON.parse(text); } catch (_) { throw new Error('drafts.json is not valid JSON — refusing to overwrite'); } }
      if (!Array.isArray(drafts)) drafts = [];

      const seq = String(drafts.filter((d) => String(d && d.draft_id || '').startsWith(stamp)).length + 1).padStart(3, '0');
      draft_id = `${stamp}-${seq}`;
      entry = { draft_id, created_at: isoNow, created_by: 'claude-studio', source_note, data };
      drafts.push(entry);
      try {
        await ghPutFile(env, GH_DRAFTS_PATH, JSON.stringify(drafts, null, 2) + '\n', sha, `Studio draft: ${data.name} (${draft_id})`);
        break;
      } catch (e) {
        if (e && e.status === 409 && attempt < 4) continue; // stale sha — re-read and retry
        throw e;
      }
    }

    const needsCoords = data.lat == null || data.lng == null;
    const createdFirms = [...createdArch, ...createdDev];
    return {
      ok: true, draft_id, created_by: 'claude-studio', status: data.status, project: data, needs_coords: needsCoords,
      admin_url: MAP_ADMIN_URL,
      firms: { architects: archRes.report, developers: devRes.report },
      firms_created: createdFirms,
      note: 'Queued for review — open the TMW Studio map admin at ' + MAP_ADMIN_URL + ' and click the "Drafts" tab; "' + data.name + '" is there now as a CLAUDE DRAFT. Review and promote it from that tab to put it on the live map — it is NOT live yet. (Stored in ' + ghRepo(env) + '/' + GH_DRAFTS_PATH + ', which that admin reads directly.)'
        + (archRes.report.length || devRes.report.length
            ? ' All architects/developers are now real registry records, so they bind in the admin picker'
              + (createdFirms.length ? ' (newly created firms: ' + createdFirms.join(', ') + ')' : ' (all matched existing firms)') + '.'
              + ' If the admin is already open, reload it to see the new firms.'
            : '')
        + (needsCoords ? ' Add lat/lng before it can be placed.' : ''),
    };
  },

  async list_map_drafts(args, env) {
    requireGhToken(env);
    const { text } = await ghGetFile(env, GH_DRAFTS_PATH);
    let drafts = [];
    if (text) { try { drafts = JSON.parse(text); } catch (_) {} }
    if (!Array.isArray(drafts)) drafts = [];
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200);
    const recent = drafts.slice().reverse().slice(0, limit);
    return {
      count: drafts.length, showing: recent.length, repo: ghRepo(env) + '/' + GH_DRAFTS_PATH,
      admin_url: MAP_ADMIN_URL,
      note: 'These are pending in the TMW Studio map admin → ' + MAP_ADMIN_URL + ' "Drafts" tab, awaiting human review/promotion.',
      drafts: recent.map((d) => ({
        draft_id: d.draft_id, name: d.data && d.data.name, city: d.data && d.data.city,
        status: d.data && d.data.status, created_at: d.created_at, created_by: d.created_by,
        source_note: d.source_note, project: d.data,
      })),
    };
  },

  // ── Analytics ──────────────────────────────────────────────────────────────
  async get_audience_stats(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const rows = (await env.DB.prepare('SELECT member_id, plan, ts, event_name FROM events').all()).results || [];
    const nowSec = Math.floor(Date.now() / 1000), day = 86400, fiveMinAgo = nowSec - 300;
    const planTs = new Map(), memberPlans = new Map(), nameCounts = new Map();
    const active7d = new Set(), activeNow = new Set();
    let eventsToday = 0, events7d = 0, eventsPrev7d = 0;
    for (const r of rows) {
      if (!planTs.has(r.member_id) || planTs.get(r.member_id) < r.ts) { planTs.set(r.member_id, r.ts); memberPlans.set(r.member_id, r.plan); }
      const age = nowSec - r.ts;
      if (age < day) eventsToday++;
      if (age < 7 * day) { events7d++; active7d.add(r.member_id); } else if (age < 14 * day) eventsPrev7d++;
      if (r.ts >= fiveMinAgo) activeNow.add(r.member_id);
      if (r.event_name) nameCounts.set(r.event_name, (nameCounts.get(r.event_name) || 0) + 1);
    }
    let paid = 0, free = 0;
    for (const p of memberPlans.values()) { if (p === 'paid') paid++; else free++; }
    return {
      members_total: memberPlans.size, members_paid: paid, members_free: free,
      active_now: activeNow.size, active_members_7d: active7d.size,
      events_today: eventsToday, events_last_7d: events7d, events_prev_7d: eventsPrev7d, events_total: rows.length,
      top_events: [...nameCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 15),
    };
  },

  async get_journal_analytics(args, env) {
    if (!env.GA_SERVICE_ACCOUNT_JSON || !env.GA4_PROPERTY_ID) throw new Error('GA4 not configured on the worker (GA_SERVICE_ACCOUNT_JSON / GA4_PROPERTY_ID)');
    const days = Math.min(Math.max(parseInt(args.days, 10) || 28, 1), 365);
    const token = await getGoogleAccessToken(env);
    const reqBody = {
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: { filter: { fieldName: 'hostName', stringFilter: { matchType: 'CONTAINS', value: 'oftmw.com' } } },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    };
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA4_PROPERTY_ID}:runReport`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody),
    });
    if (!r.ok) throw new Error('GA4 report failed (HTTP ' + r.status + '): ' + (await r.text()).slice(0, 300));
    const data = await r.json();
    const all = (data.rows || []).map((row) => ({ event: row.dimensionValues[0].value, count: Number(row.metricValues[0].value || 0), users: Number(row.metricValues[1].value || 0) }));
    const journal = all.filter((e) => /^jrn_|^subscribe_/.test(e.event));
    return { range_days: days, journal_events: journal, journal_total: journal.reduce((s, e) => s + e.count, 0), top_events: all.slice(0, 40) };
  },

  // ── Brand brain ─────────────────────────────────────────────────────────────
  async get_brand_brain(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureBrandNotesTable(env);
    const rows = (await env.DB.prepare(
      'SELECT id, kind, category, note, context, created_by, created_at FROM brand_notes WHERE active = 1 ORDER BY created_at ASC'
    ).all()).results || [];
    const SECTIONS = [
      { title: 'Voice & identity', kinds: ['voice'] },
      { title: 'Rules', kinds: ['rule'] },
      { title: 'Structure & format', kinds: ['structure'] },
      { title: 'Lean into (topics & likes)', kinds: ['like', 'topic'] },
      { title: 'Avoid', kinds: ['dislike', 'avoid'] },
      { title: 'Examples that worked', kinds: ['example'] },
    ];
    const used = new Set();
    let md = '# Markets of Tomorrow — Brand Brain\n';
    for (const s of SECTIONS) {
      const items = rows.filter((r) => s.kinds.includes(r.kind));
      if (!items.length) continue;
      md += `\n## ${s.title}\n`;
      for (const r of items) { used.add(r.id); md += `- ${r.note}${r.context ? ` _(${r.context})_` : ''}\n`; }
    }
    const other = rows.filter((r) => !used.has(r.id));
    if (other.length) { md += '\n## Other\n'; for (const r of other) md += `- [${r.kind}] ${r.note}\n`; }
    if (!rows.length) md += '\n_(empty — teach it with record_preference)_\n';
    return {
      playbook: md,
      count: rows.length,
      last_updated: rows.length ? iso(rows[rows.length - 1].created_at) : null,
      notes: rows.map((r) => ({ id: r.id, kind: r.kind, category: r.category || '', note: r.note, context: r.context || '', by: r.created_by || '', when: iso(r.created_at) })),
      how_to_use: 'This is the shared house style for Markets of Tomorrow. Apply the playbook to any post/carousel/caption/article you write or critique. When anyone expresses a new like/dislike/rule, call record_preference so it updates for everyone.',
    };
  },

  async record_preference(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureBrandNotesTable(env);
    const kind = String(args.kind || '').trim().toLowerCase();
    const ALLOWED = ['like', 'dislike', 'rule', 'voice', 'structure', 'topic', 'avoid', 'example'];
    if (!ALLOWED.includes(kind)) throw new Error('kind must be one of: ' + ALLOWED.join(', '));
    const note = String(args.note || '').trim();
    if (!note) throw new Error('note is required');
    const id = 'bn-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO brand_notes (id, kind, category, note, context, created_by, created_at, active) VALUES (?1,?2,?3,?4,?5,?6,?7,1)'
    ).bind(id, kind, String(args.category || '').slice(0, 60) || null, note.slice(0, 2000), String(args.context || '').slice(0, 500) || null, String(args.by || 'studio').slice(0, 40), now).run();
    const c = await env.DB.prepare('SELECT COUNT(*) c FROM brand_notes WHERE active = 1').first();
    return { ok: true, id, kind, note, brain_size: c ? c.c : null, msg: 'Recorded to the shared brand brain — visible to every connected account immediately.' };
  },

  async remove_brand_note(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureBrandNotesTable(env);
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id is required (from get_brand_brain)');
    await env.DB.prepare('UPDATE brand_notes SET active = 0 WHERE id = ?1').bind(id).run();
    return { ok: true, id, removed: true };
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
      instructions: 'Markets of Tomorrow Studio — run the studio remotely. Before writing or critiquing any post, carousel, caption, headline, or article, call get_brand_brain to load the shared house style; record new likes/dislikes/rules with record_preference so taste stays in sync across every connected account. Read journal posts/drafts/views, Map of Tomorrow projects, media, lists, and analytics. Write only reviewable artifacts: create/edit article DRAFTS, upload photos into media folders, create folders, add to or replace studio lists (e.g. the client wall), and stage MAP DRAFTS for review (they appear in the TMW Studio map admin at https://admin.oftmw.com/map/ under the "Drafts" tab — that admin reads the draft queue directly, so a created map draft is immediately visible there for a human to review and promote). Nothing here publishes to the live journal or live map — drafts wait for a human to promote.',
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
  _articlesCache = null;
  _firmRegCache = null;

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
