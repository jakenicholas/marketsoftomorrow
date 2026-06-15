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
import { getGoogleAccessToken, signPayload, previewSecret, ensureCarouselTable } from './index.js';

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
      src: 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_247de859635d486f9fee7c9b7261dae2~mv2.jpg',
      mimeType: 'image/jpeg',
      sizes: ['1080x1080'],
    },
  ],
};
const DEFAULT_PROTOCOL = '2025-06-18';
const PROJECTS_URL = 'https://www.oftmw.com/map/projects-flat.json';
const ARTICLES_URL = 'https://www.oftmw.com/map/articles.json';

// Project lifecycle order — status only ever advances along this path. Used by
// the construction-update automation (list_projects_due / update_project_status).
// "coming-soon" sits just before "open" = under construction and opening within
// ~6–7 months (TMW's definition of "soon"), NOT a pre-construction sales phase.
const STATUS_ORDER = ['announced', 'breaking-ground', 'construction', 'coming-soon', 'open'];
function statusRank(s) { const i = STATUS_ORDER.indexOf(String(s || '').toLowerCase()); return i < 0 ? 0 : i; }
// Finer construction-phase milestones — logged to status_history as dated,
// sourced events (type:'milestone') that enrich the dossier WITHOUT changing the
// coarse lifecycle `status`. (announced / breaking-ground / open are captured as
// status transitions via new_status, so they're not repeated here.)
const MILESTONE_PHASES = ['financing', 'going-vertical', 'halfway', 'topping-out', 'tenant', 'tco', 'move-in', 'bookings'];

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
    description: 'Get one journal article in full by its slug — title, excerpt, status, categories, SEO, view count, and the article HTML body. Pass full:true to get the COMPLETE, untruncated body HTML — do this before making precision edits with edit_post_draft so you can copy the exact substrings to target.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, full: { type: 'boolean', description: 'Return the complete body_html untruncated (needed to copy verbatim substrings for edit_post_draft). Default false truncates very long bodies.' } }, required: ['slug'] },
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
    name: 'match_project',
    description: 'Check whether a candidate project is ALREADY on the live Map of Tomorrow — even under a renamed or variant title (e.g. "Kempinski Design Residences" vs an existing "Kempinski Residences"). Deterministically scores the candidate against every live project on website-host equality, geo distance, brand-name overlap, and developer/city agreement, and returns ranked matches each with explicit reasons plus an overall verdict: "strong" (it IS already in the database — propose an EDIT with propose_project_edit, do NOT create a new draft), "possible" (ambiguous — do nothing automated, report it for a human), or "none" (genuinely new — safe to create_map_draft). ALWAYS call this for every candidate before create_map_draft. Pass latitude/longitude (geocode the address first) and the official website when you have them — those make the match decisive.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Candidate project name (required)' },
        website: { type: 'string', description: 'Official website URL, if known — a matching host is the strongest signal' },
        city: { type: 'string' },
        developer: { type: 'string', description: 'Developer name(s)' },
        latitude: { type: 'number', description: 'Geocoded latitude — pass it; proximity is a decisive signal' },
        longitude: { type: 'number', description: 'Geocoded longitude' },
        limit: { type: 'integer', description: 'Max ranked matches to return (default 5, max 20)' },
      },
      required: ['name'],
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
        body_markdown: { type: 'string', description: 'Article body in Markdown. Supports: # / ## / ### headings, paragraphs, **bold**, *italic*, [links](url), `- ` bullet lists, and IMAGES via ![alt](url) -- a paragraph that is JUST an image becomes a <figure>, and ![alt](url "caption text") adds a <figcaption>. Use real image URLs (R2 / official press kit URLs), never link a website as if it were an image.' },
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
    description: 'Edit an existing journal article DRAFT (only status=draft — refuses to touch published/scheduled posts). Update any of title, excerpt, category, cover image, and/or FULL-REPLACE the body from Markdown. ⚠️ body_markdown does a COMPLETE rewrite of the HTML body via Markdown conversion — it FLATTENS rich HTML (embedded <figure>/<figcaption> images, slideshow/grid GALLERIES, project-card embeds) that Markdown cannot represent. For ANY change to a body that contains images/galleries, do NOT pass body_markdown — use edit_post_draft (surgical find/replace) instead. Reserve body_markdown here for plain-text drafts or a deliberate full rewrite. Returns the Studio edit URL.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug of the draft to edit' },
        title: { type: 'string' },
        body_markdown: { type: 'string', description: 'Replacement body in Markdown. Same syntax as create_post_draft: headings, **bold**, *italic*, [links](url), `- ` lists, and IMAGES via ![alt](url) (or ![alt](url "caption") for a captioned figure). Use real image URLs, not website links.' },
        excerpt: { type: 'string' },
        category: { type: 'string' },
        cover_image: { type: 'string' },
        linked_project: { type: 'string', description: 'Slug of the Map of Tomorrow project to link — embeds the live project card (added once if not already present). Use to connect an existing draft to its project.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'edit_post_draft',
    description: 'Make PRECISION, surgical edits to a journal article DRAFT\'s HTML body via literal find/replace — without re-sending or re-rendering the whole article. USE THIS (not update_post_draft) whenever the body has rich HTML to preserve: embedded <figure>/<figcaption> images, slideshow/grid GALLERIES, project-card embeds, custom markup. Everything you don\'t touch stays byte-for-byte intact. Workflow: (1) call get_post {slug, full:true} to read the exact current HTML; (2) copy the precise substring you want to change — verbatim, including tags and whitespace — into `find`; (3) put the new text in `replace`. Each `find` must match EXACTLY ONE place (add surrounding context to disambiguate) or set all:true to replace every occurrence. If any find does NOT match, the ENTIRE call aborts with no write — so a typo can never silently corrupt the post. Multiple edits + append/prepend are applied atomically in order. Drafts only.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug of the draft to edit' },
        edits: {
          type: 'array',
          description: 'Ordered literal find/replace operations on the body HTML; each applies to the result of the previous one. Operate on HTML, not Markdown.',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Exact substring of the CURRENT body HTML to replace — copy it verbatim from get_post {full:true}, with enough surrounding text/tags to be unique.' },
              replace: { type: 'string', description: 'Replacement HTML. Use an empty string to delete the matched text.' },
              all: { type: 'boolean', description: 'Replace EVERY occurrence of find. Default false = find must match exactly once (else the call aborts as ambiguous).' },
            },
            required: ['find', 'replace'],
          },
        },
        append_html: { type: 'string', description: 'Optional raw HTML appended to the END of the body, after all find/replace edits (e.g. a new closing paragraph or figure).' },
        prepend_html: { type: 'string', description: 'Optional raw HTML inserted at the START of the body.' },
      },
      required: ['slug'],
    },
  },

  // ── Social-media carousels ────────────────────────────────────────────────
  // Instagram-style post DRAFTS staged in the Studio for client review. Same
  // "copy client link" pattern as article drafts — drafts have a signed
  // preview URL the human shares with clients; nothing publishes from here.
  {
    name: 'list_carousel_drafts',
    description: 'List the social-media carousel DRAFTS staged in the Studio. Each one is a private Instagram-style post the team is reviewing with a client via a signed preview link. Returns slug, caption, account handle, slide count, and last-updated time.',
    inputSchema: {
      type: 'object',
      properties: {
        limit:  { type: 'integer', description: 'Max results (default 30, max 100)' },
        status: { type: 'string',  description: 'Filter by status: "draft" (default) or "archived"' },
      },
    },
  },
  {
    name: 'get_carousel',
    description: 'Get one social-media carousel DRAFT by its slug. Returns the full caption, account handle/name/avatar, and the ordered slides array (each slide is { type:"image"|"video", url, poster?, alt? }). Use this to read what is staged before update_carousel_draft.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Carousel slug' } },
      required: ['slug'],
    },
  },
  {
    name: 'create_carousel_draft',
    description: 'Create a NEW Instagram-style carousel DRAFT in the Studio (status=draft — it does NOT publish anywhere). Returns the carousel id, slug, the Studio edit URL, and a public client-preview URL (signed, 60-day) you can share with a client. Account defaults to "floridaoftomorrow" / "FLORIDAOFTOMORROW" — override if the post belongs to a different brand. Slide media URLs must already be in R2 (upload via upload_photo first, or upload through the Studio editor).',
    inputSchema: {
      type: 'object',
      properties: {
        caption:        { type: 'string',  description: 'Instagram-style caption (supports newlines, hashtags, @mentions as plain text)' },
        slides: {
          type: 'array',
          description: 'Ordered list of slides. Each entry: { type:"image"|"video", url, poster?, alt? }. URLs must be publicly fetchable (R2 or other CDN).',
          items: {
            type: 'object',
            properties: {
              type:   { type: 'string', enum: ['image', 'video'] },
              url:    { type: 'string' },
              poster: { type: 'string', description: 'Optional poster image URL for video slides' },
              alt:    { type: 'string' },
            },
            required: ['type', 'url'],
          },
        },
        account_handle: { type: 'string', description: 'Account handle without @, default "floridaoftomorrow"' },
        account_name:   { type: 'string', description: 'Bold display name, default "FLORIDAOFTOMORROW"' },
        account_avatar: { type: 'string', description: 'Avatar image URL (R2). Optional — a gradient fallback is shown if omitted.' },
        slug:           { type: 'string', description: 'Custom slug (lowercase a-z 0-9 -). Optional — derived from the caption otherwise.' },
      },
    },
  },
  {
    name: 'update_carousel_draft',
    description: 'Edit an existing carousel DRAFT by slug. Any field passed is replaced (slides is a full replacement of the ordered array). Returns the updated carousel plus the Studio edit URL.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:           { type: 'string', description: 'Slug of the carousel to edit' },
        caption:        { type: 'string' },
        slides:         { type: 'array', description: 'Full replacement of the slides array (omit to leave unchanged). Each: { type, url, poster?, alt? }.', items: { type: 'object' } },
        account_handle: { type: 'string' },
        account_name:   { type: 'string' },
        account_avatar: { type: 'string' },
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
        neighborhood: { type: 'string', description: 'Neighborhood / submarket / district (e.g. "Design District", "Northwood", "Brickell", "Wynwood"). Powers neighborhood-level search & filtering — set it whenever the source names one.' },
        address: { type: 'string', description: 'Street address — captured in source_note to help geocoding' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        description: { type: 'string', description: 'Short 1–2 sentence summary' },
        description_long: { type: 'string', description: 'Full descriptive paragraph' },
        types: { type: 'array', items: { type: 'string' }, description: 'Project types — use ONLY the EXISTING TMW vocabulary (call list_project_types to see it; e.g. Residences, Hotel, Mixed-Use, Entertainment, Eateries, Retail, Office, Park, Marina, Golf, Cultural, Museum, Stadium, Education, Healthcare, Spa, Airport). Do NOT invent new tags: a hotel/resort is "Hotel" (NOT "Resort"), condos/apartments are "Residences", restaurants are "Eateries". Common synonyms are auto-mapped; anything unrecognized is dropped and reported back.' },
        preferred_type: { type: 'string', description: 'The single primary type (must be from the same existing vocabulary; defaults to the first of types).' },
        architects: { type: 'array', items: { type: 'string' }, description: 'Architect firm names. Each is matched against the firm registry (punctuation-insensitive) and bound to the canonical slug so established firms attach in the admin picker; names with no match are CREATED as new registry records (so they bind too). Use the real firm name (e.g. "Spina O\'Rourke + Partners"); search_firms can confirm existing ones first.' },
        developers: { type: 'array', items: { type: 'string' }, description: 'Developer firm names — matched to the firm registry like architects; existing firms bind to the picker and brand-new ones are created as registry records automatically.' },
        website: { type: 'string', description: 'Official project website' },
        units: { type: 'integer', description: 'RESIDENTIAL unit count (condos / apartments / townhomes). Use for residential & mixed-use — NOT for hotel rooms (use keys for those).' },
        keys: { type: 'integer', description: 'HOTEL/RESORT room (key) count. Use for hotels & resorts — NOT residential units. A property with both (branded residences over a hotel) can set both units AND keys.' },
        floors: { type: 'integer', description: 'Floor / story count (tower height proxy).' },
        start_date: { type: 'string', description: 'Construction start / GROUNDBREAKING date — year ("2027") or ISO ("2027-06"). Capture it whenever a source gives it (e.g. "broke ground in 2025"). Set start_speculative when it is a TMW estimate rather than developer-committed.' },
        delivery_date: { type: 'string', description: 'Completion / OPENING date (when it delivers or opens) — year or ISO. Capture it whenever a source gives it (e.g. "opening 2027", "completed 2026"). Set delivery_speculative when it is a TMW estimate.' },
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
  {
    name: 'update_map_draft',
    description: 'Update fields on an EXISTING Map of Tomorrow project DRAFT (in the Drafts queue) — e.g. backfill a missing construction start date, fix a status, or add units/floors. Identify the draft by draft_id (from list_map_drafts) or by its slug. Only the fields you pass are changed; everything else is left as-is. Does NOT publish — the draft stays in the Drafts tab for review.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'Draft id from list_map_drafts (preferred)' },
        slug: { type: 'string', description: 'Project slug (alternative to draft_id)' },
        status: { type: 'string', enum: ['announced', 'breaking-ground', 'construction', 'coming-soon', 'open'] },
        neighborhood: { type: 'string', description: 'Neighborhood / submarket / district (e.g. "Design District", "Northwood", "Brickell"). Powers neighborhood search & filtering.' },
        start_date: { type: 'string', description: 'Construction-start / groundbreaking year or date' },
        start_speculative: { type: 'boolean', description: 'True if start_date is an estimate' },
        delivery_date: { type: 'string', description: 'Completion / OPENING year or date' },
        delivery_speculative: { type: 'boolean', description: 'True if delivery_date is an estimate' },
        units: { type: 'integer', description: 'RESIDENTIAL unit count (condos/apartments) — NOT hotel rooms' },
        floors: { type: 'integer', description: 'Floor / story count' },
        keys: { type: 'integer', description: 'HOTEL/RESORT room (key) count — NOT residential units' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        website: { type: 'string' },
        description: { type: 'string' },
        description_long: { type: 'string' },
        note: { type: 'string', description: 'Optional note appended to the draft source_note' },
      },
    },
  },
  {
    name: 'propose_project_edit',
    description: 'Propose an EDIT to an EXISTING live Map of Tomorrow project as a reviewable proposal — it does NOT touch the live map. Use this (NOT create_map_draft) when match_project returns verdict "strong": the project is already in the database but a source shows a field is wrong or outdated (e.g. it was renamed, units/floors changed, the official website moved, a date shifted). Queues a field-level old→new diff in the TMW Studio map admin → "Proposals" tab, where a human reviews each change and applies it to the live project. Identify the project by target_slug (from match_project / search_projects). NEVER use this to add a brand-new project — that is create_map_draft.',
    inputSchema: {
      type: 'object',
      properties: {
        target_slug: { type: 'string', description: 'Canonical slug of the live project to edit (matches[0].slug from match_project)' },
        target_name: { type: 'string', description: 'The current name of that project, for display' },
        changes: {
          type: 'object',
          description: 'Map of field → NEW value. Only include fields that should change. Allowed keys: name, status, city, neighborhood, latitude, longitude, website, units, floors, start_date, delivery_date, description, description_long.',
        },
        proposal_note: { type: 'string', description: 'Human-readable rationale, e.g. \'"name" needs to be changed per this article I found\'' },
        source_note: { type: 'string', description: 'Source URL / where this came from' },
        match: { type: 'object', description: 'Optional: the match_project result {score, verdict, reasons} for reviewer context' },
      },
      required: ['target_slug', 'changes'],
    },
  },

  // ── Construction-update automation ───────────────────────────────────────────
  {
    name: 'list_projects_due',
    description: 'Get the next rotating batch of ACTIVE Map of Tomorrow projects (status not yet "open") to check for construction updates — oldest-checked first, prioritizing those nearest a milestone (breaking-ground / construction). IMPORTANT: calling this MARKS the returned batch as checked right now, which is how the weekly sweep rotates through all ~360 projects over time — so only call it when you are about to actually web-search the batch you get back. For any project a credible source shows has advanced, call update_project_status.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'How many projects to pull this sweep (default 25, max 60)' } } },
  },
  {
    name: 'update_project_status',
    description: 'Update a Map of Tomorrow project from a credible web source — advance its lifecycle status AND/OR update its construction-start / completion dates. Status order is announced → coming-soon → breaking-ground → construction → open; status normally moves FORWARD only — the ONE exception is correction:true, which walks an OVER-STATED status back when credible current sources show the recorded phase is wrong (e.g. wrongly marked under-construction but it has not broken ground → set new_status "announced" + correction:true). Dates can change in either direction (delays are common) and auto-apply when a source states a new one — even with NO status change (e.g. a project still "construction" whose opening slips a year). mode "apply" writes to the LIVE map (rebuilds within ~1h) and records the source in status_history (git history = audit trail). ALWAYS pass effective_date when a source states WHEN a milestone happened (e.g. "broke ground Sept 3 2025") — it dates the dossier timeline to the real event, not our discovery date. For FINER phases between the coarse statuses (financing/loan closed, going vertical, halfway, topped out, tenant announced, TCO, resident move-in, hotel bookings open) pass `milestone` (with effective_date + source_url) to log them to the dossier WITHOUT changing status. mode "propose" queues a STATUS change for one-tap human review (ambiguous/thin/multi-step) — dates always auto-apply regardless of mode. It also fills/corrects factual SPEC fields — units (residential count), floors (stories), and keys (hotel rooms) — which auto-apply like dates (many projects are missing these). Always pass source_url. Pass new_status only when the status actually advances; omit it for a date-only or spec-only update.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Project slug from list_projects_due / search_projects' },
        new_status: { type: 'string', enum: STATUS_ORDER, description: 'The later status the source supports. OMIT for a date-only update (no status change).' },
        source_url: { type: 'string', description: 'URL of the article / press release / permit showing the update (required)' },
        source_published: { type: 'string', description: 'Publish date of the source (YYYY-MM-DD) if known' },
        note: { type: 'string', description: 'One-line rationale, e.g. "Topped out per SFBJ, 2026-05-12" or "Opening pushed to late 2027 per Gulfshore Life"' },
        mode: { type: 'string', enum: ['apply', 'propose'], description: 'apply = update the live map (confident, well-sourced single-step status milestone). propose = queue the STATUS change for review (ambiguous/thin/multi-step). Default apply. Date changes always auto-apply.' },
        confidence: { type: 'string', enum: ['high', 'low'], description: 'Your confidence in the call' },
        start_date: { type: 'string', description: 'New/confirmed construction start (year or ISO) — updates the date even if status is unchanged' },
        delivery_date: { type: 'string', description: 'New/confirmed completion/opening date (year or ISO) — updates the date even if status is unchanged (catches delays)' },
        start_speculative: { type: 'boolean', description: 'True if start_date is a TMW estimate, not developer-committed' },
        delivery_speculative: { type: 'boolean', description: 'True if delivery_date is a TMW estimate' },
        effective_date: { type: 'string', description: 'When the milestone ACTUALLY happened in the real world (YYYY, YYYY-MM, or YYYY-MM-DD) — NOT today. e.g. a source saying "broke ground Sept 3, 2025" → effective_date "2025-09-03". Powers the project dossier timeline, which must show the event date, not our discovery date. If omitted on a status advance, it falls back to start_date (for breaking-ground/construction) or delivery_date (for coming-soon/open) when those are given. ALSO pass it with `milestone`.' },
        milestone: { type: 'string', enum: MILESTONE_PHASES, description: 'Log a FINER construction-phase event to the dossier timeline WITHOUT changing the lifecycle status. Use for phases between the coarse statuses: financing (loan/construction financing closed), going-vertical (superstructure rising above grade), halfway (≈50% complete), topping-out (final beam/roof structure complete), tenant (an anchor/retail/office tenant announced), tco (Temporary Certificate of Occupancy issued), move-in (residents begin moving in), bookings (hotel reservations open). Pair with effective_date (when it happened) + source_url. The coarse statuses themselves — announced, broke ground, grand opening — go via new_status, not here. A milestone-only call is valid (omit new_status).' },
        units: { type: 'integer', description: 'Residential unit count — fill/correct when a credible source states it (auto-applies; many projects are missing this)' },
        floors: { type: 'integer', description: 'Floor / story count — fill/correct from a credible source (auto-applies)' },
        keys: { type: 'integer', description: 'Hotel key (room) count — fill/correct from a credible source for hotels/resorts (auto-applies)' },
        neighborhood: { type: 'string', description: 'Neighborhood / submarket / district the project sits in (e.g. "Design District", "Northwood", "Brickell", "Wynwood", "Edgewater"). Auto-applies like specs. Fill it whenever you can identify it from the source/address — it powers neighborhood-level search & filtering. Use the canonical local name, not a street.' },
        correction: { type: 'boolean', description: 'Set TRUE only to CORRECT an over-stated status BACKWARD — i.e. the project is recorded at a LATER phase than reality and credible, current sources show it has not reached it (e.g. marked "construction" or "breaking-ground" but it has NOT broken ground → set new_status "announced", correction:true). This is the ONLY case status may move backward. Requires a credible source_url and a note explaining why. Omit/false for all normal forward sweeps.' },
        backfill: { type: 'boolean', description: 'Set TRUE to LOG A PAST status milestone to the dossier timeline WITHOUT changing current status. Used for empty-history projects — e.g. 14 ROC is currently at breaking-ground but its original 2024 announcement was never recorded → call with backfill:true, new_status:"announced", effective_date:"2024-XX-XX", source_url:<announcement source>, note:<headline-style summary>. Requires new_status (the past status being logged) + effective_date (when it actually happened). Append-only — does not modify p.status. The construction sweep uses this to fill in original announcements (and any other past anchors) on projects whose status_history is empty, so every project has at least one sourced entry.' },
      },
      required: ['slug', 'source_url'],
    },
  },
  {
    name: 'geocode_address',
    description: 'Geocode a street address to precise latitude/longitude (~6–7 decimals) for placing a project on the map, via OpenStreetMap. Pass the fullest address you have (street, city, state, zip). Returns { ok, latitude, longitude, display_name } or { ok:false } if no match — then retry with a simpler address.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Full address, e.g. "555 NW South River Dr, Miami, FL 33136"' } },
      required: ['address'],
    },
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
  const esc    = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => s.replace(/"/g, '&quot;');

  // Markdown image syntax: ![alt](url) or ![alt](url "caption text").
  // Was missing from the original converter -- so when the MCP wrote
  // article drafts with images the link regex below would consume the
  // `[alt](url)` portion and leave a bare `!` orphan in front of the
  // resulting <a>. The fix runs this replacement BEFORE the link regex,
  // so images are taken off the table before links are matched.
  const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;

  const inline = (s) => esc(s)
    .replace(IMG_RE, (m, alt, url) =>
      `<img src="${escAttr(url)}" alt="${escAttr(alt)}" loading="lazy">`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${escAttr(u)}">${t}</a>`);

  return String(md).replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => {
    b = b.trim(); if (!b) return '';
    const h = b.match(/^(#{1,3})\s+(.*)$/);
    if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    // Block-level image: a paragraph that is JUST one markdown image
    // (no surrounding text). Render as <figure> matching the same
    // shape published posts already use, so the existing post.css
    // styling (margin, max-width, caption) Just Works.
    const singleImg = b.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/);
    if (singleImg) {
      const alt = escAttr(esc(singleImg[1] || ''));
      const url = escAttr(singleImg[2]);
      const cap = singleImg[3] ? esc(singleImg[3]) : '';
      return `<figure><img src="${url}" alt="${alt}" loading="lazy">${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
    }
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
  const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  return {
    // Canonical slug from the feed (projects.json). Never re-derive from the
    // title — renamed projects carry a slug unrelated to their current name.
    // Fallback to slugify only until projects-flat.json is regenerated with Slug.
    title: p.Title, slug: p.Slug || slugify(p.Title),
    city: p.City, type: p.ProjectType || p.PreferredType || '',
    architect: p.Architect || '', developer: p.Developer || '',
    lat: n(p.Latitude), lng: n(p.Longitude),
    delivery: p.Delivery || p.DeliveryDate || '', units: p.Units || '', floors: p.Floors || '',
    website: p.OfficialWebsite || '', description: p.Description || '',
  };
}

// Split a comma/semicolon/"&"-joined firm or type list into clean tokens.
function splitList(s) {
  return String(s || '').split(/\s*[,;]\s*|\s+&\s+/).map((x) => x.trim()).filter(Boolean);
}

// ── Duplicate detection ─────────────────────────────────────────────────────
// Deterministic matching so the discovery routine reliably recognizes a project
// that is ALREADY on the live map even under a renamed/variant title (e.g.
// "Kempinski Design Residences" vs an existing "Kempinski Residences"). Powers
// the match_project tool. Conservative by design — never declares "strong"
// (i.e. it IS already in the DB) without a decisive corroborator (same website
// host, or geo proximity + a name/brand match). Name overlap alone caps at
// "possible" so two genuinely distinct projects are never auto-merged.

// Hostname of a URL, lowercased, www-stripped. '' when unparseable/empty.
function hostOf(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
}

// Hosts that legitimately serve MANY different projects, so a host match here is
// NOT evidence the two are the same development. Keeps a shared brokerage/social
// link from falsely merging distinct projects.
const GENERIC_HOSTS = new Set([
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'youtube.com',
  'linkedin.com', 'tiktok.com', 'vimeo.com', 'linktr.ee', 'compass.com',
  'douglaselliman.com', 'zillow.com', 'realtor.com', 'sites.google.com',
  'wixsite.com', 'squarespace.com', 'godaddysites.com',
]);

// Normalize a name: lowercase, strip diacritics + punctuation, collapse spaces.
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Generic real-estate / geography words that carry no brand identity. Stripping
// them leaves the "brand core" — "kempinski design residences" and "kempinski
// residences" both reduce to {kempinski}.
const NAME_STOPWORDS = new Set([
  'the', 'at', 'by', 'of', 'and', 'a', 'an',
  'residences', 'residence', 'condos', 'condo', 'condominium', 'condominiums',
  'tower', 'towers', 'hotel', 'resort', 'club', 'spa', 'suites', 'lofts',
  'design', 'designed', 'collection', 'estates', 'villas', 'apartments',
  'project', 'phase', 'building', 'house', 'place', 'park', 'plaza', 'center',
  'north', 'south', 'east', 'west', 'downtown', 'district', 'beach', 'bay',
  'miami', 'palm', 'fort', 'lauderdale', 'boca', 'raton', 'orlando', 'tampa',
  'new', 'expansion', 'renovation',
]);

function nameTokens(s) { return normName(s).split(' ').filter(Boolean); }
function brandTokens(s) {
  return new Set(nameTokens(s).filter((t) => t.length > 1 && !NAME_STOPWORDS.has(t)));
}

// Is set A a non-empty subset of set B (or vice-versa)?
function subsetEither(a, b) {
  if (!a.size || !b.size) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens), b = new Set(bTokens);
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Score a candidate {name, website, city, developer, lat, lng} against one live
// project p (TitleCase flat-feed record). Returns {score, verdict, reasons[]}.
function scoreMatch(cand, p) {
  let score = 0; const reasons = [];
  let decisive = false; // a signal strong enough to anchor a "strong" verdict

  // Website host equality (the single most decisive signal).
  const ch = hostOf(cand.website), ph = hostOf(p.OfficialWebsite);
  if (ch && ph && ch === ph) {
    if (GENERIC_HOSTS.has(ch)) { score += 1; reasons.push(`shared (generic) host ${ch}`); }
    else { score += 5; decisive = true; reasons.push(`same website host ${ch}`); }
  }

  // Geo proximity.
  const clat = cand.lat, clng = cand.lng;
  const plat = (p.Latitude == null || p.Latitude === '') ? NaN : Number(p.Latitude);
  const plng = (p.Longitude == null || p.Longitude === '') ? NaN : Number(p.Longitude);
  let near = false;
  if (clat != null && clng != null && !isNaN(clat) && !isNaN(clng) && !isNaN(plat) && !isNaN(plng)) {
    const d = haversineM(clat, clng, plat, plng);
    if (d < 150) { score += 4; near = true; reasons.push(`${Math.round(d)}m apart`); }
    else if (d < 400) { score += 2; reasons.push(`${Math.round(d)}m apart`); }
  }

  // Brand-core containment.
  const cb = brandTokens(cand.name), pb = brandTokens(p.Title);
  const brandMatch = subsetEither(cb, pb);
  if (brandMatch) { score += 3; reasons.push(`brand core "${[...(cb.size <= pb.size ? cb : pb)].join(' ')}" matches`); }

  // Name-token Jaccard.
  const jac = jaccard(nameTokens(cand.name), nameTokens(p.Title));
  if (jac >= 0.6) { score += 2; reasons.push('name closely matches'); }
  else if (jac >= 0.4) { score += 1; }

  // Developer overlap.
  const cDev = new Set(splitList(cand.developer).flatMap((d) => nameTokens(d)).filter((t) => t.length > 2 && !NAME_STOPWORDS.has(t)));
  const pDev = new Set(splitList(p.Developer).flatMap((d) => nameTokens(d)).filter((t) => t.length > 2 && !NAME_STOPWORDS.has(t)));
  if (cDev.size && pDev.size) { for (const t of cDev) if (pDev.has(t)) { score += 2; reasons.push('same developer'); break; } }

  // City agreement.
  if (cand.city && p.City) {
    const cc = normName(cand.city), pc = normName(p.City);
    if (cc && pc && (cc === pc || cc.includes(pc) || pc.includes(cc))) { score += 1; reasons.push('same city'); }
  }

  // Verdict (conservative): "strong" needs host equality OR (near AND a name match).
  let verdict;
  if (decisive || (near && (brandMatch || jac >= 0.6))) verdict = 'strong';
  else if (score >= 4) verdict = 'possible';
  else verdict = 'none';
  return { score, verdict, reasons };
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
const GH_EDIT_PROPOSALS_PATH = 'data/edit_proposals.json';
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
  // The Contents API only inlines base64 `content` for files up to 1 MiB; for
  // larger files it returns metadata with empty content and encoding "none".
  // projects.json crossed 1 MiB in 2026 — fall back to the Git Blobs API,
  // which serves blobs up to 100 MB. (`data.sha` IS the blob sha for a file.)
  if (data.content && data.encoding === 'base64') {
    return { sha: data.sha, text: b64decodeUtf8(data.content) };
  }
  if (data.sha) {
    const b = await fetch(`https://api.github.com/repos/${ghRepo(env)}/git/blobs/${data.sha}`, { headers: ghHeaders(env) });
    if (!b.ok) throw new Error('GitHub blob read failed (HTTP ' + b.status + '): ' + (await b.text()).slice(0, 200));
    const bd = await b.json();
    return { sha: data.sha, text: b64decodeUtf8(bd.content) };
  }
  return { sha: data.sha || null, text: null };
}
async function ghPutFile(env, path, contentStr, sha, message) {
  // The Contents API write endpoint only reliably handles blobs up to ~1 MiB.
  // For larger files (projects.json) commit via the Git Data API instead.
  if (new TextEncoder().encode(contentStr).length > 1000000) {
    return await ghPutFileLarge(env, path, contentStr, message);
  }
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
// Large-file write (>1 MiB) via the Git Data API: create blob → tree → commit →
// fast-forward the branch ref. The non-forced ref update gives the same
// concurrency safety as the Contents API's sha check — a concurrent commit
// makes the update non-fast-forward (422), surfaced as a 409 for retry parity.
async function ghPutFileLarge(env, path, contentStr, message) {
  const api = `https://api.github.com/repos/${ghRepo(env)}`;
  const branch = ghBranch(env);
  const H = ghHeaders(env);
  const HJ = { ...H, 'Content-Type': 'application/json' };
  const fail = async (label, resp) => {
    const e = new Error('GitHub ' + label + ' failed (HTTP ' + resp.status + '): ' + (await resp.text()).slice(0, 200));
    e.status = resp.status; throw e;
  };
  let resp = await fetch(`${api}/git/ref/heads/${encodeURIComponent(branch)}`, { headers: H });
  if (!resp.ok) await fail('ref read', resp);
  const parentCommit = (await resp.json()).object.sha;
  resp = await fetch(`${api}/git/commits/${parentCommit}`, { headers: H });
  if (!resp.ok) await fail('commit read', resp);
  const baseTree = (await resp.json()).tree.sha;
  resp = await fetch(`${api}/git/blobs`, { method: 'POST', headers: HJ, body: JSON.stringify({ content: b64encodeUtf8(contentStr), encoding: 'base64' }) });
  if (!resp.ok) await fail('blob create', resp);
  const blobSha = (await resp.json()).sha;
  resp = await fetch(`${api}/git/trees`, { method: 'POST', headers: HJ, body: JSON.stringify({ base_tree: baseTree, tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }] }) });
  if (!resp.ok) await fail('tree create', resp);
  const newTree = (await resp.json()).sha;
  resp = await fetch(`${api}/git/commits`, { method: 'POST', headers: HJ, body: JSON.stringify({ message, tree: newTree, parents: [parentCommit] }) });
  if (!resp.ok) await fail('commit create', resp);
  const newCommit = (await resp.json()).sha;
  resp = await fetch(`${api}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', headers: HJ, body: JSON.stringify({ sha: newCommit, force: false }) });
  if (!resp.ok) {
    const e = new Error('GitHub ref update failed (HTTP ' + resp.status + '): ' + (await resp.text()).slice(0, 200));
    e.status = resp.status === 422 ? 409 : resp.status; // non-fast-forward ≈ stale (concurrent write)
    throw e;
  }
  return await resp.json();
}

// ── Project status automation (→ tmw-data/data/projects.json) ────────────────
// The construction-update sweep advances a project's lifecycle status (and dates)
// based on web findings — and can walk an over-stated status BACK via correction:true
// (the one sanctioned regression) when sources show the recorded phase is wrong.
// projects.json is the source of truth the hourly map
// build (fetch_projects.py → projects-flat.json) reads, so a write here lands on
// the live map automatically. The file is `JSON.stringify(data, null, 2)` with NO
// trailing newline — match it exactly so each write is a surgical diff.
const GH_PROJECTS_PATH = 'data/projects.json';
const GH_PROPOSALS_PATH = 'data/status_proposals.json';
function serializeProjects(arr) { return JSON.stringify(arr, null, 2); }
async function readProjectsFile(env) {
  const { sha, text } = await ghGetFile(env, GH_PROJECTS_PATH);
  if (!text) throw new Error('projects.json not found in ' + ghRepo(env));
  let projects;
  try { projects = JSON.parse(text); } catch (_) { throw new Error('projects.json is not valid JSON — refusing to write'); }
  if (!Array.isArray(projects)) throw new Error('projects.json is not an array');
  return { sha, projects };
}
// Append an ambiguous status change to the review queue (status_proposals.json),
// with the same optimistic-locking retry as the drafts writer.
async function appendProposal(env, proposal) {
  for (let attempt = 0; ; attempt++) {
    const { sha, text } = await ghGetFile(env, GH_PROPOSALS_PATH);
    let list = [];
    if (text) { try { list = JSON.parse(text); } catch (_) { list = []; } }
    if (!Array.isArray(list)) list = [];
    list.push(proposal);
    try {
      await ghPutFile(env, GH_PROPOSALS_PATH, JSON.stringify(list, null, 2), sha, `Status proposal: ${proposal.name} ${proposal.from}→${proposal.to} (review)`);
      return list.length;
    } catch (e) { if (e && e.status === 409 && attempt < 4) continue; throw e; }
  }
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
// A slug-like input ("estudio-lamela") → a readable firm name ("Estudio Lamela");
// proper names (with spaces/caps/punctuation) pass through untouched. Keeps new
// registry records from being created with a "weird slug" as their name.
function deslugName(s) {
  const v = String(s || '').trim();
  if (!v) return v;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(v)) {
    return v.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  }
  return v;
}
async function loadFirmRegistry(env) {
  if (_firmRegCache) return _firmRegCache;
  const mk = () => ({ byName: new Map(), bySlug: new Map() });
  const reg = { architects: mk(), developers: mk() };
  for (const [role, path] of [['architects', 'data/architects.json'], ['developers', 'data/developers.json']]) {
    try {
      const { text } = await ghGetFile(env, path);
      const arr = text ? JSON.parse(text) : [];
      for (const f of (Array.isArray(arr) ? arr : [])) {
        if (f && f.slug && f.name) {
          const rec = { slug: f.slug, name: f.name };
          reg[role].byName.set(normFirmName(f.name), rec);
          reg[role].bySlug.set(String(f.slug).toLowerCase(), rec);
        }
      }
    } catch (_) { /* registry unavailable — resolveFirms will fall back to slugify */ }
  }
  _firmRegCache = reg;
  return _firmRegCache;
}
// Resolve firm names to canonical slugs; report which matched an existing firm.
// Matches an existing firm by normalized NAME or by exact SLUG (agents sometimes
// pass a slug) — either way binds to the canonical record. Brand-new firms get a
// cleaned-up name so they're created as proper records, not slug-named junk.
function resolveFirms(names, reg) {
  const byName = (reg && reg.byName) || new Map();
  const bySlug = (reg && reg.bySlug) || new Map();
  const slugs = [], report = [];
  for (const raw of (Array.isArray(names) ? names : [])) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const hit = byName.get(normFirmName(name)) || bySlug.get(slugify(name)) || bySlug.get(name.toLowerCase());
    if (hit) { slugs.push(hit.slug); report.push({ name: hit.name, slug: hit.slug, existing: true }); continue; }
    const cleanName = deslugName(name);
    const slug = slugify(cleanName);
    if (slug) { slugs.push(slug); report.push({ name: cleanName, slug, existing: false }); }
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

// ── Project-type vocabulary → keep the connector on the EXISTING tag set ─────
// New projects must reuse the tags already on the live map, not invent new ones
// (e.g. a resort is "Hotel", not "Resort"). The canonical set is whatever's
// in use on the live map (same source as list_project_types), seeded with the
// core vocab so common tags are always valid. Synonyms fold variants in.
const TYPE_SYNONYMS = {
  resort: 'Hotel', resorts: 'Hotel', hotels: 'Hotel', 'boutique-hotel': 'Hotel', inn: 'Hotel',
  condominium: 'Residences', condominiums: 'Residences', condo: 'Residences', condos: 'Residences',
  apartment: 'Residences', apartments: 'Residences', residence: 'Residences', residential: 'Residences',
  multifamily: 'Residences', townhomes: 'Residences', townhouse: 'Residences', housing: 'Residences',
  restaurant: 'Eateries', restaurants: 'Eateries', dining: 'Eateries', eatery: 'Eateries', 'food-hall': 'Eateries',
  shopping: 'Retail', mall: 'Retail', shops: 'Retail', store: 'Retail', stores: 'Retail',
  offices: 'Office', commercial: 'Office', workplace: 'Office',
  parks: 'Park', 'green-space': 'Park', 'public-space': 'Park', plaza: 'Park',
  marinas: 'Marina',
  'golf-course': 'Golf', golfing: 'Golf',
  museums: 'Museum', gallery: 'Cultural', galleries: 'Cultural', arts: 'Cultural', 'arts-center': 'Cultural', 'cultural-center': 'Cultural',
  arena: 'Stadium', stadiums: 'Stadium', sports: 'Stadium', 'sports-complex': 'Stadium',
  school: 'Education', schools: 'Education', university: 'Education', college: 'Education', academy: 'Education',
  hospital: 'Healthcare', hospitals: 'Healthcare', medical: 'Healthcare', clinic: 'Healthcare',
  wellness: 'Spa', spas: 'Spa',
  airports: 'Airport',
  entertainment: 'Entertainment',
  'mixed use': 'Mixed-Use', mixeduse: 'Mixed-Use', 'mixed-use-development': 'Mixed-Use',
};
async function loadCanonTypes() {
  const canon = new Map(); // lowercase -> canonical casing
  for (const v of new Set(Object.values(TYPE_SYNONYMS))) canon.set(v.toLowerCase(), v);
  try {
    const all = await loadProjects();
    for (const p of all) for (const t of splitList(p.ProjectType)) {
      const k = String(t).trim();
      if (k && !canon.has(k.toLowerCase())) canon.set(k.toLowerCase(), k);
    }
  } catch (_) { /* fall back to the seeded core vocab */ }
  return canon;
}
// Normalize ONE type to its canonical tag, or null if unrecognized (→ dropped).
function normType(raw, canon) {
  const t = String(raw || '').trim(); if (!t) return null;
  const key = t.toLowerCase();
  const syn = TYPE_SYNONYMS[key] || TYPE_SYNONYMS[key.replace(/[\s_]+/g, '-')] || TYPE_SYNONYMS[key.replace(/-/g, ' ')];
  const target = (syn || t).toLowerCase();
  return canon.get(target) || canon.get(key) || null;
}
function resolveTypes(inputTypes, canon) {
  const out = [], dropped = [], seen = new Set();
  for (const raw of (Array.isArray(inputTypes) ? inputTypes : [])) {
    const c = normType(raw, canon);
    if (c) { if (!seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c); } }
    else if (String(raw || '').trim()) dropped.push(String(raw).trim());
  }
  return { types: out, dropped };
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
    // full:true returns the complete body (capped high to avoid pathological
    // payloads) so the model can copy exact substrings for edit_post_draft;
    // the default keeps responses light by truncating long bodies.
    const wantFull = args.full === true || args.full === 'true';
    const LIMIT = wantFull ? 600000 : 24000;
    const truncated = body.length > LIMIT;
    if (truncated) body = body.slice(0, LIMIT) + '\n<!-- …truncated… -->';
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

  // ── Social-media carousels ───────────────────────────────────────────────
  // V1 stores slides as a JSON column on the `carousels` table (auto-created
  // on first request). Preview URLs are signed with the same secret as
  // article drafts but use a distinct t:'carousel' tag so the two token
  // types aren't swappable. The worker host is hardcoded as a fallback — set
  // env.CAROUSEL_PUBLIC_HOST in wrangler.toml if you point a custom domain.
  async list_carousel_drafts(args, env) {
    await ensureCarouselTable(env);
    const limit  = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 100);
    const status = (args.status === 'archived') ? 'archived' : 'draft';
    const rows = (await env.DB.prepare(
      `SELECT slug, caption, account_handle, slides, updated_at FROM carousels WHERE status=?1 ORDER BY updated_at DESC LIMIT ?2`
    ).bind(status, limit).all()).results || [];
    return {
      count: rows.length,
      drafts: rows.map((r) => {
        let slides = []; try { slides = JSON.parse(r.slides || '[]'); } catch (_) {}
        return {
          slug: r.slug,
          caption_preview: (r.caption || '').slice(0, 140),
          account_handle: r.account_handle || 'floridaoftomorrow',
          slide_count: Array.isArray(slides) ? slides.length : 0,
          updated: iso(r.updated_at),
          edit_url: 'https://admin.oftmw.com/carousel.html?slug=' + encodeURIComponent(r.slug),
        };
      }),
    };
  },

  async get_carousel(args, env) {
    if (!args.slug) throw new Error('slug is required');
    await ensureCarouselTable(env);
    const slug = String(args.slug).trim().toLowerCase();
    const row = await env.DB.prepare(`SELECT * FROM carousels WHERE slug = ?1`).bind(slug).first();
    if (!row) throw new Error('no carousel with slug "' + slug + '"');
    let slides = []; try { slides = JSON.parse(row.slides || '[]'); } catch (_) {}
    return {
      slug: row.slug,
      caption: row.caption || '',
      account_handle: row.account_handle || 'floridaoftomorrow',
      account_name:   row.account_name   || 'FLORIDAOFTOMORROW',
      account_avatar: row.account_avatar || null,
      slides: Array.isArray(slides) ? slides : [],
      status: row.status || 'draft',
      edit_url: 'https://admin.oftmw.com/carousel.html?slug=' + encodeURIComponent(row.slug),
    };
  },

  async create_carousel_draft(args, env) {
    await ensureCarouselTable(env);
    const caption = String(args.caption || '').slice(0, 4000);
    // Slug derives from explicit slug → caption → fallback "carousel-XXXX".
    const baseSlug = args.slug ? slugify(String(args.slug)) : (caption ? slugify(caption) : '');
    let slug = (baseSlug || ('carousel-' + Math.random().toString(36).slice(2, 6))).slice(0, 100);
    const exists = await env.DB.prepare(`SELECT 1 FROM carousels WHERE slug = ?1 LIMIT 1`).bind(slug).first();
    if (exists) slug = (slug + '-' + Math.random().toString(36).slice(2, 6)).slice(0, 100);
    const id  = 'crsl-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    const now = Math.floor(Date.now() / 1000);
    // Normalize slides — defense against the model sending half-formed entries.
    const slides = JSON.stringify((Array.isArray(args.slides) ? args.slides : [])
      .filter((s) => s && typeof s === 'object' && s.url)
      .slice(0, 20)
      .map((s) => {
        const out = { type: s.type === 'video' ? 'video' : 'image', url: String(s.url) };
        if (s.poster) out.poster = String(s.poster);
        if (s.alt)    out.alt    = String(s.alt).slice(0, 500);
        return out;
      }));
    const accountHandle = (args.account_handle || 'floridaoftomorrow').toString().replace(/^@/, '').slice(0, 64);
    const accountName   = (args.account_name   || 'FLORIDAOFTOMORROW').toString().slice(0, 80);
    const accountAvatar = args.account_avatar ? String(args.account_avatar) : null;
    await env.DB.prepare(
      `INSERT INTO carousels (id, slug, caption, account_handle, account_name, account_avatar, slides, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?8)`
    ).bind(id, slug, caption, accountHandle, accountName, accountAvatar, slides, now).run();
    const previewHost = (env.CAROUSEL_PUBLIC_HOST || 'https://tmw.jake-ab7.workers.dev').replace(/\/$/, '');
    const token = await signPayload(
      { slug, t: 'carousel', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60 },
      previewSecret(env),
    );
    return {
      ok: true, id, slug, status: 'draft',
      slide_count: JSON.parse(slides).length,
      account_handle: accountHandle,
      edit_url:    'https://admin.oftmw.com/carousel.html?slug=' + encodeURIComponent(slug),
      preview_url: `${previewHost}/c/${encodeURIComponent(slug)}?preview=${encodeURIComponent(token)}`,
      note: 'Saved as a carousel DRAFT. The preview_url is a private signed link (60-day TTL) you can share with a client to review the post. Nothing publishes — only humans push it to Instagram.',
    };
  },

  async update_carousel_draft(args, env) {
    await ensureCarouselTable(env);
    const slug = String(args.slug || '').trim().toLowerCase();
    if (!slug) throw new Error('slug is required');
    const row = await env.DB.prepare(`SELECT id, status FROM carousels WHERE slug = ?1`).bind(slug).first();
    if (!row) throw new Error('no carousel with slug "' + slug + '"');
    if (row.status !== 'draft') throw new Error('refusing to edit a ' + row.status + ' carousel via MCP — only drafts are editable remotely');
    const sets = [], params = []; let p = 1;
    if (args.caption        != null) { sets.push(`caption = ?${p++}`);        params.push(String(args.caption).slice(0, 4000)); }
    if (args.account_handle != null) { sets.push(`account_handle = ?${p++}`); params.push(String(args.account_handle).replace(/^@/, '').slice(0, 64)); }
    if (args.account_name   != null) { sets.push(`account_name   = ?${p++}`); params.push(String(args.account_name).slice(0, 80)); }
    if (args.account_avatar != null) { sets.push(`account_avatar = ?${p++}`); params.push(args.account_avatar ? String(args.account_avatar) : null); }
    if (Array.isArray(args.slides)) {
      const normalized = args.slides
        .filter((s) => s && typeof s === 'object' && s.url)
        .slice(0, 20)
        .map((s) => {
          const out = { type: s.type === 'video' ? 'video' : 'image', url: String(s.url) };
          if (s.poster) out.poster = String(s.poster);
          if (s.alt)    out.alt    = String(s.alt).slice(0, 500);
          return out;
        });
      sets.push(`slides = ?${p++}`); params.push(JSON.stringify(normalized));
    }
    if (!sets.length) throw new Error('nothing to update — pass at least one of caption/slides/account_handle/account_name/account_avatar');
    sets.push(`updated_at = ?${p++}`); params.push(Math.floor(Date.now() / 1000));
    params.push(slug);
    await env.DB.prepare(`UPDATE carousels SET ${sets.join(', ')} WHERE slug = ?${p}`).bind(...params).run();
    const previewHost = (env.CAROUSEL_PUBLIC_HOST || 'https://tmw.jake-ab7.workers.dev').replace(/\/$/, '');
    const token = await signPayload(
      { slug, t: 'carousel', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60 },
      previewSecret(env),
    );
    return {
      ok: true, slug, status: 'draft',
      edit_url:    'https://admin.oftmw.com/carousel.html?slug=' + encodeURIComponent(slug),
      preview_url: `${previewHost}/c/${encodeURIComponent(slug)}?preview=${encodeURIComponent(token)}`,
    };
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

  async match_project(args, env) {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('name is required');
    const cand = {
      name,
      website: String(args.website || ''),
      city: String(args.city || ''),
      developer: String(args.developer || ''),
      lat: args.latitude != null && args.latitude !== '' ? Number(args.latitude) : null,
      lng: args.longitude != null && args.longitude !== '' ? Number(args.longitude) : null,
    };
    const all = await loadProjects();
    const scored = all
      .map((p) => ({ p, ...scoreMatch(cand, p) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 20);
    const matches = scored.slice(0, limit).map(({ p, score, verdict, reasons }) => ({
      ...projectSummary(p), score, verdict, reasons,
    }));

    // Headline verdict = the top match's verdict, with one guard: if the top
    // two are BOTH "strong" and within 2 points, we can't confidently say which
    // existing record it is → downgrade to "possible" so a human decides.
    let verdict = matches.length ? matches[0].verdict : 'none';
    if (verdict === 'strong' && matches.length >= 2
        && matches[1].verdict === 'strong' && (matches[0].score - matches[1].score) <= 2) {
      verdict = 'possible';
    }
    const advice = verdict === 'strong'
      ? 'Already in the database — call propose_project_edit against matches[0].slug for any fields the source corrects; do NOT create_map_draft.'
      : verdict === 'possible'
        ? 'Ambiguous — do NOT create a draft or an edit. Report it in the run digest for a human to check.'
        : 'No live match — safe to create_map_draft.';
    return { candidate: cand, verdict, advice, count: scored.length, matches };
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
    ).bind(id, slug, title, excerpt, bodyHtml, args.cover_image || null, categories, 'Jake Nicholas', reading, now).run();
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

  // Surgical find/replace on a draft's HTML body — preserves galleries/figures
  // that a Markdown round-trip (update_post_draft) would flatten. Validates
  // every `find` against the running body BEFORE writing; any miss aborts the
  // whole call with no DB write, so a bad target never silently corrupts a post.
  async edit_post_draft(args, env) {
    const slug = String(args.slug || '').trim().toLowerCase();
    if (!slug) throw new Error('slug is required');
    const row = await env.DB.prepare('SELECT id, status, body_html FROM posts WHERE slug = ?1').bind(slug).first();
    if (!row) throw new Error('no post with slug "' + slug + '"');
    if (row.status !== 'draft') throw new Error('refusing to edit a ' + row.status + ' post via MCP — only drafts are editable remotely');

    const edits = Array.isArray(args.edits) ? args.edits : [];
    const hasAppend = args.append_html != null && String(args.append_html) !== '';
    const hasPrepend = args.prepend_html != null && String(args.prepend_html) !== '';
    if (!edits.length && !hasAppend && !hasPrepend) {
      throw new Error('nothing to do — pass `edits` (find/replace ops) and/or append_html / prepend_html');
    }

    let body = row.body_html || '';
    const report = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] || {};
      const find = e.find == null ? '' : String(e.find);
      if (!find) throw new Error('edits[' + i + ']: "find" is required and must be non-empty');
      const replace = e.replace == null ? '' : String(e.replace);
      let count = 0, idx = 0;
      while ((idx = body.indexOf(find, idx)) !== -1) { count++; idx += find.length; }
      if (count === 0) throw new Error('edits[' + i + ']: find text not found in the draft body (no changes written). Read the exact HTML with get_post {full:true} and copy the substring verbatim, including tags/whitespace.');
      if (count > 1 && !e.all) throw new Error('edits[' + i + ']: find matches ' + count + ' places (ambiguous). Add surrounding context to make it unique, or set "all": true to replace every occurrence.');
      // Literal replace (NOT String.replace, which would interpret $&/$$ etc.
      // in the replacement — article HTML/prices routinely contain "$").
      if (e.all) {
        body = body.split(find).join(replace);
      } else {
        const at = body.indexOf(find);
        body = body.slice(0, at) + replace + body.slice(at + find.length);
      }
      report.push({ find_preview: find.slice(0, 60) + (find.length > 60 ? '…' : ''), replaced: e.all ? count : 1 });
    }
    if (hasPrepend) body = String(args.prepend_html) + body;
    if (hasAppend) body = body + String(args.append_html);

    const readingTime = Math.max(1, Math.round(stripHtml(body).split(/\s+/).filter(Boolean).length / 200));
    await env.DB.prepare('UPDATE posts SET body_html = ?1, reading_time_min = ?2, updated_at = ?3 WHERE slug = ?4')
      .bind(body, readingTime, Math.floor(Date.now() / 1000), slug).run();
    return {
      ok: true, slug, status: 'draft',
      edits_applied: report,
      prepended: hasPrepend || undefined, appended: hasAppend || undefined,
      body_length: body.length,
      edit_url: 'https://admin.oftmw.com/post.html?id=' + row.id,
    };
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
    // Normalize project types against the EXISTING tag vocabulary (resort→Hotel,
    // condos→Residences, …) and drop anything unrecognized — never coin new tags.
    const canonTypes = await loadCanonTypes();
    const typeRes = resolveTypes(args.types, canonTypes);
    const types = typeRes.types;
    const preferred = (args.preferred_type ? normType(args.preferred_type, canonTypes) : null) || types[0] || '';

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
      neighborhood: String(args.neighborhood || ''),
      lat: num(args.latitude),
      lng: num(args.longitude),
      types,
      preferred_type: preferred,
      description: String(args.description || ''),
      description_long: String(args.description_long || args.description || ''),
      architect_slugs: archRes.slugs,
      developer_slugs: devRes.slugs,
      official_website: String(args.website || ''),
      units: num(args.units),
      keys: num(args.keys),
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
      types: data.types,
      types_dropped: typeRes.dropped,
      note: 'Queued for review — open the TMW Studio map admin at ' + MAP_ADMIN_URL + ' and click the "Drafts" tab; "' + data.name + '" is there now as a CLAUDE DRAFT. Review and promote it from that tab to put it on the live map — it is NOT live yet. (Stored in ' + ghRepo(env) + '/' + GH_DRAFTS_PATH + ', which that admin reads directly.)'
        + (typeRes.dropped.length
            ? ' Note: dropped unrecognized type tag(s) [' + typeRes.dropped.join(', ') + '] — only existing TMW tags are kept (e.g. use "Hotel" not "Resort"). Recorded types: ' + (data.types.join(', ') || '(none)') + '.'
            : '')
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

  async update_map_draft(args, env) {
    requireGhToken(env);
    const draftId = String(args.draft_id || '').trim();
    const slug = String(args.slug || '').trim();
    if (!draftId && !slug) throw new Error('pass draft_id or slug to identify the draft');
    const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
    for (let attempt = 0; ; attempt++) {
      const { sha, text } = await ghGetFile(env, GH_DRAFTS_PATH);
      let drafts = [];
      if (text) { try { drafts = JSON.parse(text); } catch (_) { throw new Error('drafts.json is not valid JSON — refusing to write'); } }
      if (!Array.isArray(drafts)) drafts = [];
      const idx = drafts.findIndex((d) => d && (draftId ? d.draft_id === draftId : (d.data && d.data.slug === slug)));
      if (idx < 0) throw new Error('no draft found for ' + (draftId || slug));
      const d = drafts[idx];
      const data = d.data || (d.data = {});
      const changed = [];
      if (args.status) { data.status = String(args.status); changed.push('status'); }
      if (args.neighborhood != null && String(args.neighborhood).trim() !== '') { data.neighborhood = String(args.neighborhood).trim(); changed.push('neighborhood'); }
      if (args.start_date != null && String(args.start_date) !== '') { data.start_date = String(args.start_date); changed.push('start_date'); }
      if (args.start_speculative != null) data.start_speculative = !!args.start_speculative;
      if (args.delivery_date != null && String(args.delivery_date) !== '') { data.delivery_date = String(args.delivery_date); changed.push('delivery_date'); }
      if (args.delivery_speculative != null) data.delivery_speculative = !!args.delivery_speculative;
      if (args.units != null && num(args.units) != null) { data.units = num(args.units); changed.push('units'); }
      if (args.floors != null && num(args.floors) != null) { data.floors = num(args.floors); changed.push('floors'); }
      if (args.keys != null && num(args.keys) != null) { data.keys = num(args.keys); changed.push('keys'); }
      if (args.latitude != null) { data.lat = Number(args.latitude); changed.push('lat'); }
      if (args.longitude != null) { data.lng = Number(args.longitude); changed.push('lng'); }
      if (args.website) { data.official_website = String(args.website); changed.push('website'); }
      if (args.description) { data.description = String(args.description); changed.push('description'); }
      if (args.description_long) { data.description_long = String(args.description_long); changed.push('description_long'); }
      if (!changed.length && args.note == null) return { ok: false, skipped: 'nothing-to-update', draft_id: d.draft_id, slug: data.slug };
      d.updated_at = new Date().toISOString();
      if (args.note) d.source_note = (d.source_note ? d.source_note + ' — ' : '') + String(args.note);
      try {
        await ghPutFile(env, GH_DRAFTS_PATH, JSON.stringify(drafts, null, 2) + '\n', sha, `Update draft: ${data.name || d.draft_id} (${changed.join(', ') || 'note'})`);
      } catch (e) { if (e && e.status === 409 && attempt < 4) continue; throw e; }
      return { ok: true, draft_id: d.draft_id, slug: data.slug, name: data.name, changed, start_date: data.start_date || null, status: data.status };
    }
  },

  async propose_project_edit(args, env) {
    requireGhToken(env);
    const slug = String(args.target_slug || '').trim();
    if (!slug) throw new Error('target_slug is required');
    const changesIn = (args.changes && typeof args.changes === 'object' && !Array.isArray(args.changes)) ? args.changes : null;
    if (!changesIn) throw new Error('changes is required (a map of field → new value)');

    // MCP-facing names → canonical project.json field names.
    const KEYMAP = { latitude: 'lat', longitude: 'lng', website: 'official_website' };
    const ALLOWED = new Set(['name', 'status', 'city', 'neighborhood', 'lat', 'lng', 'official_website',
      'units', 'floors', 'start_date', 'delivery_date', 'description', 'description_long']);

    // Resolve the live record (best-effort) to populate each change's `from`.
    // Display-only — the admin re-reads live projects.json when applying.
    const all = await loadProjects();
    const live = all.find((p) => (p.Slug || slugify(p.Title)) === slug);
    const fromVal = (k) => {
      if (!live) return null;
      const m = {
        name: live.Title, status: live.Status || live.Delivery || '', city: live.City,
        neighborhood: live.Neighborhood, lat: live.Latitude, lng: live.Longitude, official_website: live.OfficialWebsite,
        units: live.Units, floors: live.Floors, start_date: live.StartDate,
        delivery_date: live.DeliveryDate, description: live.Description, description_long: live.DescriptionLong,
      };
      const v = m[k];
      return (v === undefined || v === '') ? null : v;
    };

    const changes = {};
    for (const [rawK, v] of Object.entries(changesIn)) {
      const k = KEYMAP[rawK] || rawK;
      if (!ALLOWED.has(k)) continue;
      let to = v;
      if (k === 'lat' || k === 'lng') to = (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
      else if (k === 'units' || k === 'floors') to = (v == null || v === '' || isNaN(parseInt(v, 10))) ? null : parseInt(v, 10);
      else to = (v == null) ? null : String(v);
      changes[k] = { from: fromVal(k), to };
    }
    if (!Object.keys(changes).length) throw new Error('no valid fields in changes (allowed: ' + [...ALLOWED].join(', ') + ')');

    const isoNow = new Date().toISOString();
    const stamp = isoNow.slice(0, 10);
    const match = (args.match && typeof args.match === 'object') ? args.match : undefined;
    const target_name = String(args.target_name || (live && live.Title) || slug);

    let proposal_id, entry;
    for (let attempt = 0; ; attempt++) {
      const { sha, text } = await ghGetFile(env, GH_EDIT_PROPOSALS_PATH);
      let proposals = [];
      if (text) { try { proposals = JSON.parse(text); } catch (_) { throw new Error('edit_proposals.json is not valid JSON — refusing to overwrite'); } }
      if (!Array.isArray(proposals)) proposals = [];
      const seq = String(proposals.filter((p) => String(p && p.proposal_id || '').startsWith(stamp)).length + 1).padStart(3, '0');
      proposal_id = `${stamp}-${seq}`;
      entry = {
        proposal_id, kind: 'edit', created_at: isoNow, created_by: 'claude-studio',
        target_slug: slug, target_name, match, changes,
        proposal_note: String(args.proposal_note || ''),
        source_note: String(args.source_note || ''),
      };
      proposals.push(entry);
      try {
        await ghPutFile(env, GH_EDIT_PROPOSALS_PATH, JSON.stringify(proposals, null, 2) + '\n', sha, `Edit proposal: ${target_name} (${proposal_id})`);
        break;
      } catch (e) {
        if (e && e.status === 409 && attempt < 4) continue;
        throw e;
      }
    }

    return {
      ok: true, proposal_id, target_slug: slug, target_name,
      fields: Object.keys(changes), admin_url: MAP_ADMIN_URL,
      found_live: !!live,
      note: 'Queued in the TMW Studio map admin → "Proposals" tab as an EDIT proposal for "' + target_name + '". A human reviews the old→new diff and applies it to the live project — it is NOT live yet. (Stored in ' + ghRepo(env) + '/' + GH_EDIT_PROPOSALS_PATH + ', which that admin reads directly.)'
        + (live ? '' : ' NOTE: no live project currently resolves to slug "' + slug + '" — double-check target_slug from match_project.'),
    };
  },

  // ── Construction-update automation ───────────────────────────────────────────
  async list_projects_due(args, env) {
    requireGhToken(env);
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 25));
    const { sha, projects } = await readProjectsFile(env);
    const active = projects.filter((p) => p && p.slug && statusRank(p.status) < statusRank('open'));
    // Sort priority:
    //   1. EMPTY-HISTORY first — these projects have never had a sourced
    //      milestone logged. They need backfill before any forward sweep
    //      reaches them, otherwise their dossier timeline stays empty
    //      forever even though the sweep keeps stamping status_checked_at.
    //   2. Oldest status_checked_at (round-robin freshness)
    //   3. Tie-break toward projects nearest a milestone (announced last)
    const pri = { 'breaking-ground': 0, 'construction': 1, 'coming-soon': 2, 'announced': 3 };
    const histLen = (p) => (Array.isArray(p.status_history) ? p.status_history.length : 0);
    active.sort((a, b) => {
      const ae = histLen(a) === 0, be = histLen(b) === 0;
      if (ae !== be) return ae ? -1 : 1;
      const ca = a.status_checked_at || '', cb = b.status_checked_at || '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return ((pri[a.status] != null ? pri[a.status] : 9) - (pri[b.status] != null ? pri[b.status] : 9));
    });
    const batch = active.slice(0, limit);
    const slugs = new Set(batch.map((p) => p.slug));
    const nowIso = new Date().toISOString();
    for (const p of projects) if (slugs.has(p.slug)) p.status_checked_at = nowIso;
    const emptyCount = batch.filter((p) => histLen(p) === 0).length;
    await ghPutFile(env, GH_PROJECTS_PATH, serializeProjects(projects), sha, `Status sweep: marked ${batch.length} checked (${emptyCount} empty-history) (${nowIso.slice(0, 10)})`);
    return {
      checked_at: nowIso, batch_size: batch.length, active_total: active.length,
      empty_history_in_batch: emptyCount,
      status_order: STATUS_ORDER,
      instructions: 'BACKFILL FIRST. For any project in this batch with history_len:0 (the sweep has never logged a single sourced event for it), your FIRST job is to backfill at least one entry — the original announcement. Web-search "<name> <city> announced" / "<name> developer announces" / search_articles for our own coverage. Find the earliest credible source that announced the project (oftmw.com PREFERRED — call search_articles by slug first). Then call update_project_status with backfill:true, new_status:"announced", effective_date = the actual announcement date from the article body, source_url, note = a one-line headline-style summary. backfill:true logs the entry to status_history WITHOUT changing current status, so a 14 ROC currently at breaking-ground can still get its announcement entry filled in. After backfill, also look for any subsequent milestones (broke-ground, topped-out, etc.) that should be logged — same backfill:true pattern, one call per past milestone. THEN do the normal forward sweep: web-search for recent news (last 6 months) — if a CREDIBLE source shows it reached a LATER status, call update_project_status (no backfill flag) with mode "apply" for a clear single-step advance, "propose" if ambiguous/thin/multi-step. ALWAYS pass effective_date = the real-world date the milestone happened. Use the most precise grain (day > month > year). Sanity-check current status against reality: if a project is recorded at a later phase than credible sources support — e.g. marked "construction" yet nothing shows ground has broken — CORRECT it via update_project_status with the earlier new_status and correction:true (cite source + note why). PHASE MILESTONES: pass `milestone` = one of financing, going-vertical, halfway, topping-out, tenant, tco, move-in, bookings — ALWAYS with effective_date + source_url. The coarse anchors — announced, broke ground, grand opening — go via new_status (with backfill:true if past) instead. Never skip a project with history_len:0 even if you find no recent news — backfill its announcement first.',
      projects: batch.map((p) => ({
        slug: p.slug, name: p.name, city: p.city || '', status: p.status,
        units: p.units || null, floors: p.floors || null,
        start_date: p.start_date || null, delivery_date: p.delivery_date || null,
        website: p.official_website || '',
        history_len: histLen(p),                                 // 0 → agent must backfill
      })),
    };
  },

  async update_project_status(args, env) {
    requireGhToken(env);
    const slug = String(args.slug || '').trim();
    if (!slug) throw new Error('slug is required');
    const newStatus = String(args.new_status || '').toLowerCase().trim();
    if (newStatus && !STATUS_ORDER.includes(newStatus)) throw new Error('new_status must be one of: ' + STATUS_ORDER.join(', '));
    const sourceUrl = String(args.source_url || '').trim();
    if (!sourceUrl) throw new Error('source_url is required — cite where the update came from');
    const mode = (String(args.mode || 'apply').toLowerCase() === 'propose') ? 'propose' : 'apply';
    const clean = (v) => (v == null ? '' : String(v).trim());
    const newStart = clean(args.start_date);
    const newDelivery = clean(args.delivery_date);
    // The real-world date a milestone occurred (event date), distinct from the
    // `at` record/discovery timestamp. Drives the dossier timeline.
    const effectiveDate = clean(args.effective_date);
    if (effectiveDate && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(effectiveDate)) {
      throw new Error('effective_date must be YYYY, YYYY-MM, or YYYY-MM-DD (the real-world date the milestone occurred)');
    }
    // Finer construction-phase milestone (logged to the dossier timeline; does
    // NOT change the lifecycle status). Pass effective_date for its event date.
    const milestone = String(args.milestone || '').toLowerCase().trim();
    if (milestone && !MILESTONE_PHASES.includes(milestone)) {
      throw new Error('milestone must be one of: ' + MILESTONE_PHASES.join(', '));
    }
    // Factual spec fields the agent fills/corrects when it finds them (auto-apply).
    const numOrNull = (v) => { if (v == null || v === '') return null; const n = parseInt(v, 10); return isNaN(n) ? null : n; };
    const NUM_FIELDS = [
      { arg: 'units',  field: 'units',  label: 'units' },
      { arg: 'floors', field: 'floors', label: 'floors (stories)' },
      { arg: 'keys',   field: 'keys',   label: 'keys' },
    ];
    const numWanted = NUM_FIELDS.map((f) => ({ ...f, val: numOrNull(args[f.arg]) })).filter((f) => f.val != null);
    // Neighborhood / submarket — a free-text spec field that auto-applies like
    // units/floors (many projects are missing it; it powers neighborhood search).
    const nbhdWanted = (args.neighborhood != null && String(args.neighborhood).trim() !== '') ? String(args.neighborhood).trim() : null;

    for (let attempt = 0; ; attempt++) {
      const { sha, projects } = await readProjectsFile(env);
      const p = projects.find((x) => x && x.slug === slug);
      if (!p) throw new Error('No project with slug "' + slug + '" in projects.json');
      const from = String(p.status || '').toLowerCase();
      const nowIso = new Date().toISOString();

      const statusAdvances = !!newStatus && statusRank(newStatus) > statusRank(from);
      const statusRegresses = !!newStatus && statusRank(newStatus) < statusRank(from);
      // The one sanctioned backward move: an EXPLICIT correction of an over-stated
      // status (e.g. wrongly marked "construction" but it hasn't broken ground).
      const isCorrection = statusRegresses && args.correction === true;
      // Backfill mode — log a PAST status event to the dossier timeline
      // WITHOUT touching the current status. For projects whose history
      // is empty: 14 ROC is at breaking-ground today, but its original
      // announcement was never recorded. backfill:true lets the sweep
      // append that past 'announced' entry (with the real announcement
      // date + source_url) so the dossier timeline isn't blank.
      // Requires new_status + effective_date so the entry is well-dated.
      const isBackfill = args.backfill === true;
      if (isBackfill) {
        if (!newStatus) throw new Error('backfill:true requires new_status (the past milestone status)');
        if (!effectiveDate) throw new Error('backfill:true requires effective_date (when the past event happened)');
      }
      const statusChanges = !isBackfill && (statusAdvances || isCorrection);
      const startChanged = !!newStart && newStart !== clean(p.start_date);
      const deliveryChanged = !!newDelivery && newDelivery !== clean(p.delivery_date);
      const numChanged = numWanted.filter((u) => u.val !== numOrNull(p[u.field]));
      const nbhdChanged = nbhdWanted != null && nbhdWanted !== String(p.neighborhood || '');
      // A milestone is always a new dated event to log (idempotency isn't
      // enforced — the same phase can legitimately recur with a corrected date;
      // humans can prune dupes in the Studio milestones editor).
      const milestoneAdded = !!milestone;
      const anyExtra = startChanged || deliveryChanged || numChanged.length > 0 || nbhdChanged || milestoneAdded || isBackfill;

      // A backward status WITHOUT the correction flag is refused — guards against
      // accidental regressions during a normal forward sweep. Backfill bypasses
      // this guard because it doesn't change current status.
      if (!isBackfill && statusRegresses && !isCorrection && !anyExtra) {
        return { ok: false, skipped: 'regression-needs-correction-flag', slug, current_status: from, requested: newStatus, hint: 'To walk a wrongly over-stated status back, pass correction:true. To log a past milestone without changing current status, pass backfill:true with effective_date.' };
      }
      // A status that neither advances nor is a sanctioned correction is refused —
      // but only when no other change rides with it (date/spec-only updates are fine).
      if (!isBackfill && newStatus && !statusChanges && !anyExtra) {
        return { ok: false, skipped: 'not-a-forward-advance', slug, current_status: from, requested: newStatus };
      }
      if (!statusChanges && !anyExtra) {
        return { ok: false, skipped: 'no-change', slug, current_status: from };
      }

      // Status proposals (mode "propose") only apply to STATUS — dates auto-apply.
      if (mode === 'propose' && statusAdvances) {
        p.status_checked_at = nowIso;
        try {
          await ghPutFile(env, GH_PROJECTS_PATH, serializeProjects(projects), sha, `Status check: ${p.name} — ${from}→${newStatus} flagged for review`);
        } catch (e) { if (e && e.status === 409 && attempt < 4) continue; throw e; }
        const queued = await appendProposal(env, {
          slug, name: p.name, from, to: newStatus, source_url: sourceUrl,
          source_published: args.source_published || null, note: String(args.note || ''),
          confidence: String(args.confidence || 'low'), proposed_at: nowIso,
        });
        return { ok: true, mode: 'proposed', slug, name: p.name, from, to: newStatus, review_queue: GH_PROPOSALS_PATH, queue_size: queued };
      }

      // mode apply — write the status advance and/or date change(s) + provenance.
      if (!Array.isArray(p.status_history)) p.status_history = [];
      const changes = [];
      const base = { at: nowIso, source_url: sourceUrl };
      if (args.source_published) base.source_published = String(args.source_published);
      if (args.note) base.note = String(args.note);
      if (statusChanges) {
        // Event date for this transition: explicit effective_date wins; else
        // fall back to the relevant date riding with the advance so the dossier
        // timeline is still correctly dated.
        let statusEffective = effectiveDate;
        if (!statusEffective) {
          if ((newStatus === 'breaking-ground' || newStatus === 'construction') && newStart) statusEffective = newStart;
          else if ((newStatus === 'coming-soon' || newStatus === 'open') && newDelivery) statusEffective = newDelivery;
        }
        p.status = newStatus;
        p.status_history.push({ ...base, from, to: newStatus, ...(statusEffective ? { effective_date: statusEffective } : {}), ...(isCorrection ? { correction: true } : {}) });
        changes.push(`${from}→${newStatus}${isCorrection ? ' (correction)' : ''}`);
      }
      if (startChanged) {
        const old = clean(p.start_date) || null;
        p.start_date = newStart;
        if (args.start_speculative) p.start_speculative = true;
        p.status_history.push({ ...base, type: 'date', field: 'start_date', from: old, to: newStart });
        changes.push(`start ${old || '—'}→${newStart}`);
      }
      if (deliveryChanged) {
        const old = clean(p.delivery_date) || null;
        p.delivery_date = newDelivery;
        if (args.delivery_speculative) p.delivery_speculative = true;
        p.status_history.push({ ...base, type: 'date', field: 'delivery_date', from: old, to: newDelivery });
        changes.push(`delivery ${old || '—'}→${newDelivery}`);
      }
      for (const u of numChanged) {
        const old = numOrNull(p[u.field]);
        p[u.field] = u.val;
        p.status_history.push({ ...base, type: 'field', field: u.field, from: old, to: u.val });
        changes.push(`${u.label} ${old == null ? '—' : old}→${u.val}`);
      }
      if (nbhdChanged) {
        const old = String(p.neighborhood || '') || null;
        p.neighborhood = nbhdWanted;
        p.status_history.push({ ...base, type: 'field', field: 'neighborhood', from: old, to: nbhdWanted });
        changes.push(`neighborhood ${old || '—'}→${nbhdWanted}`);
      }
      if (milestoneAdded) {
        // A finer construction-phase event for the dossier (does not touch status).
        p.status_history.push({ ...base, type: 'milestone', phase: milestone, ...(effectiveDate ? { effective_date: effectiveDate } : {}) });
        changes.push(`milestone: ${milestone}${effectiveDate ? ' @ ' + effectiveDate : ''}`);
      }
      if (isBackfill) {
        // Append a past status entry to the dossier timeline WITHOUT
        // changing current status. Used by the sweep to fill in original
        // announcements (and other past anchors) on projects whose
        // status_history has been empty since they were created.
        p.status_history.push({
          ...base,
          type: 'backfill',
          to: newStatus,                  // the past milestone status being logged
          effective_date: effectiveDate,
        });
        changes.push(`backfill: ${newStatus} @ ${effectiveDate}`);
      }
      p.status_checked_at = nowIso;
      try {
        await ghPutFile(env, GH_PROJECTS_PATH, serializeProjects(projects), sha, `${p.name}: ${changes.join(', ')} (auto)`);
      } catch (e) { if (e && e.status === 409 && attempt < 4) continue; throw e; }
      return { ok: true, mode: 'applied', slug, name: p.name, status: p.status, changes, source_url: sourceUrl, note: 'Live map rebuilds within ~1h; projects.json git history is the audit trail.' };
    }
  },

  // Geocode an address (OpenStreetMap Nominatim) — lets discovery place new
  // projects without the agent shelling out to curl (so no Bash approval).
  async geocode_address(args, env) {
    const q = String(args.address || '').trim();
    if (!q) throw new Error('address is required');
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'User-Agent': 'tmw-map-discovery/1.0 (admin@oftmw.com)', 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('geocoder HTTP ' + r.status);
    let arr; try { arr = await r.json(); } catch (_) { arr = []; }
    if (!Array.isArray(arr) || !arr.length) return { ok: false, address: q, note: 'no match — retry with a simpler address (drop unit/suite, or just street + city)' };
    const hit = arr[0];
    return { ok: true, address: q, latitude: Number(hit.lat), longitude: Number(hit.lon), display_name: hit.display_name };
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
      instructions: 'Markets of Tomorrow Studio — run the studio remotely. Before writing or critiquing any post, carousel, caption, headline, or article, call get_brand_brain to load the shared house style; record new likes/dislikes/rules with record_preference so taste stays in sync across every connected account. Read journal posts/drafts/views, Map of Tomorrow projects, media, lists, and analytics. Write only reviewable artifacts: create/edit article DRAFTS, upload photos into media folders, create folders, add to or replace studio lists (e.g. the client wall), stage MAP DRAFTS for review (they appear in the TMW Studio map admin at https://admin.oftmw.com/map/ under the "Drafts" tab), and stage SOCIAL CAROUSEL DRAFTS (Instagram-style posts the team reviews with clients via a signed preview link — create_carousel_draft returns a private preview_url to share). Nothing here publishes to the live journal, live map, or any social account — drafts wait for a human to promote.',
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
