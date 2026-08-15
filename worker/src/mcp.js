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
import { ONTOLOGY } from './ontology.js';
import { getGoogleAccessToken, signPayload, previewSecret, ensureCarouselTable, ensureContactsTable, ensureCampaignsTable, ensureDesignsTable, ensureUniqueDesignSlug, fableGenerate, fableLastError, handleReviseFeedback, handleMediaRenameFolder, assembleBrain, brainWrite, brainRelevantNotes, brainNoteVectors, retireBrandNotes, lintCanon, critiqueDraft, rejectedTopics, topicRejected, getFingerprint, voiceScore, fingerprintSpecText, articleExemplars, turingJudge, repairTruncatedJson, genVoiceScore, factVerify, classifyStoryType } from './index.js';
// Studio-admin read bridge: the connector reuses the SAME handler functions the
// Access-gated admin pages hit, so the numbers can never drift from the Studio.
import { handlePeople, handleTrendingSearches, handleSubStatus, handleAdminMemberHistory, handleAdminDeepCredits, handleFunnelStats, handleSubscriptions, handleAdminCategories, handleSocialAccountsList, handleFollowersGet, handleBrainProposed, handlePlacementStats, handleIntelStats, handleIntelRules, handleIntelExemplars, handleMarketsFollowed, handleAdminGiveawaysList, handleAdminFlowsList, handleAdminProIncome, handleEmailStats, handleDailyPulse } from './index.js';

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
      src: 'https://media.oftmw.com/wix/ca3b83_247de859635d486f9fee7c9b7261dae2~mv2.jpg',
      mimeType: 'image/jpeg',
      sizes: ['1080x1080'],
    },
  ],
};
const DEFAULT_PROTOCOL = '2025-06-18';
const PROJECTS_URL = 'https://www.oftmw.com/map/projects-flat.json';
const ARTICLES_URL = 'https://www.oftmw.com/map/articles.json';

// Project lifecycle order + milestone phases — inherited from THE ONTOLOGY
// (ontology.js, the single source for structural rules). "coming-soon" sits
// just before "open" = under construction and opening within ~6–7 months
// (TMW's definition of "soon"), NOT a pre-construction sales phase. A
// hand-written copy of this order in a tool description once drifted from the
// enforced order — never restate it; render from ONTOLOGY.
const STATUS_ORDER = ONTOLOGY.statuses.order;
const BANNED_SOURCE_DOMAINS = (ONTOLOGY.writes && ONTOLOGY.writes.banned_source_domains) || [];
function statusRank(s) { const i = STATUS_ORDER.indexOf(String(s || '').toLowerCase()); return i < 0 ? 0 : i; }
const MILESTONE_PHASES = ONTOLOGY.milestones.phases;

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
    description: 'List article drafts (status=draft) waiting in the Studio — BOTH the "AI" tab and the human "Drafts" tab (each row carries `tab` and, when the draft is about a tracked project, `project_slug`). Call this FIRST when picking a story to write: if a draft already covers the same project (matching project_slug) or the same story, do NOT write another — a duplicate draft is the #1 failure. generate_article_draft also hard-refuses a second draft on an already-drafted project.',
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
        body_markdown: { type: 'string', description: 'Article body in Markdown. Supports: # / ## / ### headings, paragraphs, **bold**, *italic*, [links](url), `- ` bullet lists, and IMAGES via ![alt](url) -- a paragraph that is JUST an image becomes a <figure>, and ![alt](url "caption text") adds a <figcaption>. Use real image URLs (R2 / official press kit URLs), never link a website as if it were an image. Use AT MOST 10 images per article (any beyond the first 10 are dropped automatically). Avoid em dashes (—) in the prose; use commas or periods instead.' },
        excerpt: { type: 'string', description: '1–2 sentence summary (optional; auto-derived if omitted)' },
        category: { type: 'string', description: 'Optional — must be an EXISTING category label (call search_posts/list_posts to see what exists). New/unknown labels are NOT created here; they are dropped and the post saves uncategorized. Categories are created only in the Studio Categories tab.' },
        cover_image: { type: 'string', description: 'Absolute cover image URL (optional)' },
        linked_project: { type: 'string', description: 'Slug of the Map of Tomorrow project this article covers — embeds the live project card (status, intel, stats) in the post, exactly like the Studio "linked project" picker. Use the slug from search_projects. Always set this when the article is about a tracked project.' },
        post_type:   { type: 'string', enum: ['Editorial', 'Barter', 'Potential Barter', 'Partner', 'Paid'], description: 'Editorial/commercial classification (Monday-replacement). Default Editorial.' },
        income:      { type: 'number', description: 'Dollar amount captured for the post (paid/barter/partner). Omit for Editorial. When campaign_id is set the worker auto-fills this from the campaign math.' },
        contact_id:  { type: 'string', description: 'Studio contact id (from list_contacts) — the PR/brand contact tied to this post.' },
        project_slug:{ type: 'string', description: 'Map of Tomorrow project slug this post should be linked to in the dashboard (separate from the in-body embed — `linked_project` controls the embed; `project_slug` is the structured link the dashboard groups posts by).' },
        campaign_id: { type: 'string', description: 'Campaign id (from list_campaigns) — links this post to a multi-month commitment. When set, income is auto-derived from the campaign\'s total_income / planned_posts unless an explicit `income` is also passed.' },
        source:      { type: 'string', enum: ['ai', 'human'], description: 'Provenance tag. DEFAULTS to "ai": every draft created through this connector (the routine AND interactive Studio-connector sessions) is machine-drafted, so it files under the Studio "AI" tab for review. Only pass "human" to deliberately file a connector draft as a human Drafts-tab post (rare). Truly hand-authored posts come through the Studio editor, not this tool.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'write_article_and_post',
    description: 'ONE step for "write an article and build/create a post": creates a journal ARTICLE draft AND a carousel POST design draft in the Studio, then reports BOTH so you can tell the user when both are done. You supply the article body (body_markdown) and the carousel slide copy (slides); photos from a media FOLDER are sprinkled into the article body AND placed behind the design slides. Nothing publishes — both are drafts. Use this whenever the user asks for an article and a post together. (For just one, use create_post_draft or create_design_draft.)',
    inputSchema: {
      type: 'object',
      properties: {
        title:         { type: 'string', description: 'Shared title for the article and the design.' },
        body_markdown: { type: 'string', description: 'Article body in Markdown (same syntax as create_post_draft). Folder photos are auto-inserted between paragraphs; you may also place ![alt](url) yourself. Articles use AT MOST 10 images (folder pull + any you place is capped at 10). Avoid em dashes (—) in the prose; use commas or periods instead.' },
        slides: {
          type: 'array',
          description: 'Carousel slides for the design — one per slide: { text, template?, image?, tagline? }. Same shape as create_design_draft.',
          items: {
            type: 'object',
            properties: {
              text:     { type: 'string', description: 'Headline copy for this slide.' },
              template: { type: 'string', enum: ['centered_top','centered_bottom','left_top','left_bottom','right_top','right_bottom','first_bl','first_tl','first_tr','photo_full'], description: 'Layout. Default centered_top.' },
              image:    { type: 'string', description: 'Explicit photo URL — overrides the folder photo for this slide.' },
              tagline:  { type: 'string', description: 'Override the "MARKETS OF TOMORROW" tagline (rare).' },
              location: { type: 'string', description: 'City for the cover slide\'s location pin (e.g. "Miami", "West Palm Beach"). Set this on the first/cover slide (first_bl/first_tl/first_tr) so the pin shows the project\'s city instead of the placeholder.' },
            },
            required: ['text'],
          },
        },
        caption:        { type: 'string', description: 'Instagram caption for the carousel post.' },
        folder:         { type: 'string', description: 'Media-library folder holding the photos to use in BOTH the article and the post (newest-first). The first photo becomes the article cover unless cover_image is set.' },
        excerpt:        { type: 'string', description: 'Article summary (optional; auto-derived).' },
        category:       { type: 'string', description: 'Optional — must be an EXISTING category label. New/unknown labels are NOT created; they are dropped and the post saves uncategorized. Create categories in the Studio Categories tab only.' },
        cover_image:    { type: 'string', description: 'Explicit article cover URL (optional; defaults to the folder\'s first photo).' },
        linked_project: { type: 'string', description: 'Map of Tomorrow project slug to embed in the article (optional).' },
        post_type:      { type: 'string', enum: ['Editorial', 'Barter', 'Potential Barter', 'Partner', 'Paid'], description: 'Article classification (default Editorial).' },
        project_slug:   { type: 'string', description: 'Dashboard project link for the article (optional).' },
        campaign_id:    { type: 'string', description: 'Campaign id to link the article to (optional).' },
        location: { type: 'string', description: 'The project CITY (e.g. "Lake Anna, Virginia") — fills the design cover slide\'s location pin automatically. Set whenever the post is about a place.' },
        account_handle: { type: 'string', description: 'Carousel account handle, default "floridaoftomorrow".' },
        account_name:   { type: 'string', description: 'Carousel display name, default "FLORIDAOFTOMORROW".' },
      },
      required: ['title', 'slides'],
    },
  },
  {
    name: 'generate_article_draft',
    description: 'WRITE a full journal article DRAFT with Fable 5, grounded in the SHARED TMW brain — the house voice (brand brain), the intelligence engine\'s learned editorial rules, banked evergreen knowledge, and the real projects/articles closest to the topic. Use this to author a new on-brand article from a topic/brief without hand-writing the body: it generates the title, body (Markdown), and excerpt in TMW\'s voice, pulls photos from a media folder if given, links a Map project if given, and saves a DRAFT (source=ai, in the studio AI tab). Never publishes. Returns the slug + Studio edit URL. Follow with revise_article_draft to refine, or create_design_draft / write_article_and_post to build the carousel.',
    inputSchema: {
      type: 'object',
      properties: {
        topic:          { type: 'string', description: 'What the article is about — a headline, a development, or a brief (e.g. "Aman\'s new Miami Beach residences break ground"). The more specific, the better.' },
        angle:          { type: 'string', description: 'Optional editorial angle / what to emphasize (e.g. "why this signals the branded-residence boom in South Florida").' },
        place:          { type: 'string', description: 'Optional city/region for grounding (e.g. "Miami Beach") — sharpens the shared-brain retrieval.' },
        facts:          { type: 'string', description: 'Optional verified facts/quotes/source notes to ground the piece. The model must NOT invent numbers, dates, prices, or firm names beyond what you provide here + what it already knows to be true.' },
        folder:         { type: 'string', description: 'Optional media-library folder — photos (newest-first) are sprinkled into the body and the first becomes the cover.' },
        cover_image:    { type: 'string', description: 'Optional explicit cover URL.' },
        category:       { type: 'string', description: 'Optional — must be an EXISTING category label. New/unknown labels are NOT created; they are dropped and the post saves uncategorized. Create categories in the Studio Categories tab only.' },
        linked_project: { type: 'string', description: 'Optional Map of Tomorrow project slug to embed as a live card.' },
        post_type:      { type: 'string', enum: ['Editorial', 'Barter', 'Potential Barter', 'Partner', 'Paid'], description: 'Article classification (default Editorial).' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'revise_article_draft',
    description: 'EDIT/REWRITE an existing journal article DRAFT with Fable 5, grounded in the SHARED TMW brain (house voice + learned rules + knowledge). Give it a slug and a plain-English instruction ("tighten the intro", "make it more hype", "cut to 500 words", "lead with the architect") and it rewrites the body in TMW\'s voice and saves it back to the DRAFT. Drafts only; never publishes. NOTE: this does a full-body rewrite from the text — for surgical changes to a body with galleries/figures/embeds you want to preserve byte-for-byte, use edit_post_draft instead. Returns the Studio edit URL.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:        { type: 'string', description: 'Slug of the draft to revise.' },
        instruction: { type: 'string', description: 'Plain-English editing instruction for how to rewrite the article.' },
        place:       { type: 'string', description: 'Optional city/region to sharpen shared-brain grounding.' },
      },
      required: ['slug', 'instruction'],
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
        body_markdown: { type: 'string', description: 'Replacement body in Markdown. Same syntax as create_post_draft: headings, **bold**, *italic*, [links](url), `- ` lists, and IMAGES via ![alt](url) (or ![alt](url "caption") for a captioned figure). Use real image URLs, not website links. Use AT MOST 10 images per article (extras are dropped automatically). Avoid em dashes (—) in the prose; use commas or periods instead.' },
        excerpt: { type: 'string' },
        category: { type: 'string', description: 'Re-categorize into an EXISTING category label only. New/unknown labels are ignored (the post keeps its current categories); categories are created in the Studio Categories tab only.' },
        cover_image: { type: 'string' },
        linked_project: { type: 'string', description: 'Slug of the Map of Tomorrow project to link — embeds the live project card (added once if not already present). Use to connect an existing draft to its project.' },
        post_type:   { type: 'string', enum: ['Editorial', 'Barter', 'Potential Barter', 'Partner', 'Paid'] },
        income:      { type: 'number' },
        contact_id:  { type: 'string' },
        project_slug:{ type: 'string' },
        campaign_id: { type: 'string', description: 'Campaign id to link this draft to. Auto-fills income from campaign split unless explicit `income` is passed.' },
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

  {
    name: 'create_design_draft',
    description: 'Create a NEW carousel DESIGN draft in the Studio "Design" editor — typesets carousel slide copy onto branded TMW templates (correct fonts, FLORIDA OF TMW logo, gradient) with a photo behind each slide, ready to review and export to PNG / push to Carousels. Make ONE design slide per carousel slide: the slide text becomes the headline and a photo sits behind it. Photos are pulled from a media FOLDER in upload order (one per slide, newest first) unless a slide passes its own image URL. Find folders with list_media_folders / list_media first. Default layout is centered_top (centered headline at the top over the photo). Returns the design slug + Studio edit URL — nothing publishes. ⚠️ Only for a brand-NEW design. If a design already exists for this post (you have its slug, or find it with list_design_drafts), EDIT it with update_design_draft instead of creating a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: 'Design name shown in the editor (e.g. the post topic).' },
        caption: { type: 'string', description: 'Instagram caption for the whole carousel (shared across the deck).' },
        folder:  { type: 'string', description: 'Media-library folder to pull slide photos from, newest-first, one per slide. Omit only if every slide passes its own image.' },
        slides: {
          type: 'array',
          description: 'Ordered carousel slides — one design slide each. Each: { text, template?, image?, tagline? }.',
          items: {
            type: 'object',
            properties: {
              text:     { type: 'string', description: 'Headline copy for this slide.' },
              template: { type: 'string', enum: ['centered_top','centered_bottom','left_top','left_bottom','right_top','right_bottom','first_bl','first_tl','first_tr','photo_full'], description: 'Layout. Default centered_top. Use first_bl/first_tl/first_tr for a cover (title + location pin); photo_full for an image-only slide.' },
              image:    { type: 'string', description: 'Explicit photo URL (R2/CDN). Overrides the folder photo for this slide.' },
              tagline:  { type: 'string', description: 'Override the "MARKETS OF TOMORROW" tagline (rare).' },
              location: { type: 'string', description: 'City for the cover slide\'s location pin (e.g. "Miami", "West Palm Beach"). Set this on the first/cover slide (first_bl/first_tl/first_tr) so the pin shows the project\'s city instead of the placeholder.' },
            },
            required: ['text'],
          },
        },
        location: { type: 'string', description: 'The project CITY (e.g. "Miami", "Lake Anna, Virginia"). Set this whenever the post is about a place — it fills the cover slide\'s location pin automatically, so you don\'t need a per-slide location. Set it once here.' },
        account_handle: { type: 'string', description: 'Account handle without @, default "floridaoftomorrow".' },
        account_name:   { type: 'string', description: 'Display name, default "FLORIDAOFTOMORROW".' },
      },
      required: ['slides'],
    },
  },
  {
    name: 'list_design_drafts',
    description: 'List existing Design drafts (newest first) so you can OPEN one and edit it with update_design_draft instead of creating a duplicate. Returns each design\'s slug, title, slide_count, and Studio edit URL. Use this when continuing work on a post that already has a design.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status. Default "draft".' },
        limit:  { type: 'number', description: 'Max rows (1–100, default 25).' },
      },
    },
  },
  {
    name: 'get_design',
    description: 'Read one Design draft\'s current content by slug — its title, caption, account, and every slide (index, template, text, tagline, image). Call this BEFORE update_design_draft so you edit from the real current state instead of guessing.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'The design slug (from list_design_drafts or a create_design_draft result).' } },
      required: ['slug'],
    },
  },
  {
    name: 'update_design_draft',
    description: 'OPEN an existing Design draft and EDIT it in place — no new design is created. Use this (not create_design_draft) whenever you\'re iterating on a post that already has a design. Patches whatever you pass: caption, title, account. Pass a `slides` array to REPLACE the slides (same shape as create_design_draft — { text, template?, image?, tagline? } each, photos auto-filled from `folder` when no image given); omit `slides` to keep the current ones. Call get_design first to see what\'s there. Drafts only; returns the Studio edit URL.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:    { type: 'string', description: 'The design to edit (from list_design_drafts or a create result).' },
        title:   { type: 'string', description: 'New design name (optional).' },
        caption: { type: 'string', description: 'New Instagram caption for the carousel (optional).' },
        folder:  { type: 'string', description: 'Media folder to pull slide photos from when replacing slides without explicit images (optional).' },
        slides: {
          type: 'array',
          description: 'REPLACES all slides when provided (omit to keep current). One entry per slide: { text, template?, image?, tagline? } — same as create_design_draft.',
          items: {
            type: 'object',
            properties: {
              text:     { type: 'string', description: 'Headline copy for this slide.' },
              template: { type: 'string', enum: ['centered_top','centered_bottom','left_top','left_bottom','right_top','right_bottom','first_bl','first_tl','first_tr','photo_full'], description: 'Layout. Default centered_top.' },
              image:    { type: 'string', description: 'Explicit photo URL (overrides the folder photo for this slide).' },
              tagline:  { type: 'string', description: 'Override the tagline (rare).' },
              location: { type: 'string', description: 'City for the cover slide\'s location pin (first_bl/first_tl/first_tr).' },
            },
            required: ['text'],
          },
        },
        location: { type: 'string', description: 'The project CITY for the cover slide\'s location pin (auto-applied to the first_* slide). Set once instead of per-slide.' },
        account_handle: { type: 'string', description: 'Account handle without @ (optional).' },
        account_name:   { type: 'string', description: 'Display name (optional).' },
      },
      required: ['slug'],
    },
  },

  // ── Media ──────────────────────────────────────────────────────────────────
  {
    name: 'upload_photo',
    description: 'Upload a photo (or video) into the Studio media library by URL. Fetches source_url, stores it in R2, and indexes it in the chosen folder so it shows up in the Studio media picker. Returns the permanent public URL. Use list_media_folders to see folders, or just pass any folder name (created if new). HI-RES ONLY: an IMAGE whose longer side is under 1200px is REJECTED — pass a full-resolution source, not a thumbnail (video is exempt).',
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
    name: 'scrape_website_images',
    description: 'Gather a property\'s imagery into the Studio media library under a PROJECT folder, so it can be pulled into a journal article AND the Carousel Design editor. Scrapes one or more page URLs (<img> largest srcset, <picture>/<source>, lazy data-src, OG/Twitter cards, CSS background-images; skips tiny icons/SVGs). TMW\'s publication runs on RESORT-SPACE imagery — building & amenity photos / RENDERINGS showing what the spaces look like (rooms, villas, suites, pools, lobby, spa, restaurants, exterior, aerial) — NOT lifestyle/people shots. So it SCORES every image and saves resort-space shots first, and when a site is thin on them it can WEB-SEARCH (search_web) for more source pages (official gallery, press kits, Condé Nast/Travel+Leisure/AD/dezeen) and scrape those too. Returns per-category counts so you know your coverage. HI-RES ONLY: images whose longer side is under 1200px are automatically SKIPPED (low-res thumbnails are never saved), so target official press kits / full-resolution galleries; if a page yields too few, web-search for hi-res sources. USE THIS when the user drops a website link and says "save images" / "grab the photos", or asks to make sure there are enough resort/building/rendering images.',
    inputSchema: {
      type: 'object',
      properties: {
        url:          { type: 'string', description: 'Primary page to scrape (the hotel\'s gallery / homepage). Optional if you pass urls[] or search_web:true.' },
        urls:         { type: 'array', items: { type: 'string' }, description: 'Additional source pages to scrape into the same folder (e.g. press-kit + review-article pages you found).' },
        project:      { type: 'string', description: 'Project / hotel name — images land in media folder "Projects / <project>".' },
        folder:       { type: 'string', description: 'Override the destination folder (default "Projects / <project>").' },
        search_web:   { type: 'boolean', description: 'Web-search for MORE resort-space source pages and scrape them too. Default behavior (omit) = auto: only searches when fewer than ensure_space resort-space images were found. true = always; false = never.' },
        search_query: { type: 'string', description: 'Override the web-search query (default: the project name + resort-space terms).' },
        ensure_space: { type: 'integer', description: 'Target number of resort-SPACE (building/amenity/rendering) images before stopping the web search (default 6).' },
        limit:        { type: 'integer', description: 'Max images to save total (default 30, max 60).' },
        min_kb:       { type: 'integer', description: 'Skip images smaller than this many KB (default 8) to drop icons / pixels.' },
      },
      required: ['project'],
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
    description: 'Propose a NEW Map of Tomorrow project as a DRAFT. The draft is queued for human review in the TMW Studio map admin at https://admin.oftmw.com/map/ → "Drafts" tab, where it appears immediately as a "CLAUDE DRAFT". It is NOT on the live map until someone reviews and promotes it from that Drafts tab. (Implementation detail, not a separate system: that admin reads its queue directly from tmw-data/data/drafts.json — this is the CURRENT review queue, not a legacy path. Never tell the user the draft went somewhere the admin cannot see it.) Provide what you know; lat/lng are needed before it can be placed (you can geocode on review). PHOTOS (one call does it all): pass image URLs in `images` and they are auto-saved to R2 in the media folder "Projects / <name>" AND attached to this draft — no separate upload_photo. If you omit `images`, the draft first auto-pulls any prior scrape_website_images run from that folder, and if there is still nothing it AUTO-SCRAPES photos itself — first from the project\'s `website`, then a web-search by name — so a lone create_map_draft call still lands renderings. Auto-scraped shots are best-effort (web sources can be wrong-building) so eyeball them in the Drafts tab. The response\'s `images` field reports how many landed and via which path (added / pulled / scraped).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project name (stored as "name"; slug is derived from it)' },
        status: { type: 'string', enum: ['announced', 'breaking-ground', 'construction', 'coming-soon', 'open'], description: 'Project status (default "announced")' },
        city: { type: 'string' },
        neighborhood: { type: 'string', description: 'Neighborhood / submarket / district (e.g. "Design District", "Northwood", "Brickell", "Wynwood"). Powers neighborhood-level search & filtering — set it whenever the source names one.' },
        address: { type: 'string', description: 'STREET address line — street number + street name only (e.g. "1428 Brickell Avenue"), NOT the city/zip/country. Stored as the project\'s structured street field AND used to help geocoding. Put the town/city in `city`, the zip in `postal_code`, the nation in `country`.' },
        postal_code: { type: 'string', description: 'ZIP / postal code (e.g. "33131", "518000", "SW1A 1AA"). Structured address field.' },
        country: { type: 'string', description: 'Country name, spelled out (e.g. "United States", "China", "Italy"). Structured address field — set it on EVERY project, US and international, so country-level search & full addresses work.' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        description: { type: 'string', description: 'Short 1–2 sentence summary' },
        description_long: { type: 'string', description: 'Full descriptive paragraph' },
        types: { type: 'array', items: { type: 'string' }, description: 'Project types — use ONLY the EXISTING TMW vocabulary (call list_project_types to see it; e.g. Residences, Estates, Hotel, Resort, Mixed-Use, Entertainment, Eateries, Retail, Office, Park, Marina, Golf, Cultural, Museum, Stadium, Education, Healthcare, Airport). Do NOT invent new tags: a destination resort property is "Resort" and a city hotel is "Hotel" (they are distinct categories), condos/apartments (a multi-unit building) are "Residences", but single-family homes / houses / townhomes / villas are "Estates" (NOT Residences), restaurants are "Eateries". Common synonyms are auto-mapped; anything unrecognized is dropped and reported back.' },
        preferred_type: { type: 'string', description: 'The single primary type (must be from the same existing vocabulary; defaults to the first of types).' },
        architects: { type: 'array', items: { type: 'string' }, description: 'Architect firm names. Each is matched against the firm registry (punctuation-insensitive) and bound to the canonical slug so established firms attach in the admin picker; names with no match are CREATED as new registry records (so they bind too). Use the real firm name (e.g. "Spina O\'Rourke + Partners"); search_firms can confirm existing ones first.' },
        developers: { type: 'array', items: { type: 'string' }, description: 'Developer firm names — matched to the firm registry like architects; existing firms bind to the picker and brand-new ones are created as registry records automatically.' },
        website: { type: 'string', description: 'Official project website' },
        units: { type: 'integer', description: 'RESIDENTIAL unit count (condos / apartments / townhomes). Use for residential & mixed-use — NOT for hotel rooms (use keys for those).' },
        keys: { type: 'integer', description: 'HOTEL/RESORT room (key) count. Use for hotels & resorts — NOT residential units. A property with both (branded residences over a hotel) can set both units AND keys.' },
        floors: { type: 'integer', description: 'Floor / story count (tower height proxy).' },
        gfa_sqft: { type: 'integer', description: 'GROSS FLOOR AREA — total BUILT square feet across the whole project (a district = sum of its buildings). This is the "how big is this development" number that powers "biggest projects" ranking. Capture the STATED figure whenever a source gives one ("a 1.2-million-square-foot tower", "2.5M sq ft mixed-use"); set gfa_source:"stated". If none is stated, ESTIMATE it as max(units×1265, floors×20000, acres×43560×0.1) and set gfa_source:"estimated". A tall tower on a small lot should still be large (floors×20000).' },
        gfa_source: { type: 'string', enum: ['stated', 'estimated'], description: '"stated" if gfa_sqft came from a source, "estimated" if you derived it from floors/units/acreage.' },
        start_date: { type: 'string', description: 'Construction start / GROUNDBREAKING date — year ("2027") or ISO ("2027-06"). Capture it whenever a source gives it (e.g. "broke ground in 2025"). Set start_speculative when it is a TMW estimate rather than developer-committed.' },
        delivery_date: { type: 'string', description: 'Completion / OPENING date (when it delivers or opens) — year or ISO. Capture it whenever a source gives it (e.g. "opening 2027", "completed 2026"). Set delivery_speculative when it is a TMW estimate.' },
        start_speculative: { type: 'boolean', description: 'True if start_date is a TMW estimate (not developer-committed) — checks the "TMW estimate" box on the start date.' },
        delivery_speculative: { type: 'boolean', description: 'True if delivery_date is a TMW estimate — checks the "TMW estimate" box on the delivery date.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Image URLs (hero / renders). These are AUTO-SAVED to R2 in the project media folder "Projects / <name>" AND attached to the draft — one call does both, no separate upload_photo needed (hi-res only; low-res is skipped). If you already ran scrape_website_images for this project, you can OMIT images and the draft auto-pulls the newest photos from that same folder.' },
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
        borough: { type: 'string', description: 'Borough / sub-locality shown as the displayed location instead of the city (e.g. "Brooklyn", "Manhattan", "Queens"). NYC boroughs auto-derive from coordinates; set this only to override or for a non-NYC sub-locality. The City field is unchanged.' },
        street: { type: 'string', description: 'STREET address line only — street number + name (e.g. "1428 Brickell Avenue"). Structured address field.' },
        postal_code: { type: 'string', description: 'ZIP / postal code. Structured address field.' },
        country: { type: 'string', description: 'Country name, spelled out (e.g. "United States", "China"). Structured address field.' },
        start_date: { type: 'string', description: 'Construction-start / groundbreaking year or date' },
        start_speculative: { type: 'boolean', description: 'True if start_date is an estimate' },
        delivery_date: { type: 'string', description: 'Completion / OPENING year or date' },
        delivery_speculative: { type: 'boolean', description: 'True if delivery_date is an estimate' },
        units: { type: 'integer', description: 'RESIDENTIAL unit count (condos/apartments) — NOT hotel rooms' },
        floors: { type: 'integer', description: 'Floor / story count' },
        keys: { type: 'integer', description: 'HOTEL/RESORT room (key) count — NOT residential units' },
        gfa_sqft: { type: 'integer', description: 'GROSS FLOOR AREA — total BUILT square feet (powers "biggest projects" ranking). Prefer a STATED figure from a source; else estimate max(units×1265, floors×20000, acres×43560×0.1).' },
        gfa_source: { type: 'string', enum: ['stated', 'estimated'], description: '"stated" or "estimated" — how gfa_sqft was obtained.' },
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
          description: 'Map of field → NEW value. Only include fields that should change. Allowed keys: name, status, city, neighborhood, street (street address line), postal_code (zip), country (spelled-out nation), latitude, longitude, website, units, floors, keys, gfa_sqft (GROSS FLOOR AREA — total BUILT square feet; the "how big is this development" number that powers "biggest projects" ranking — capture a STATED figure when a source gives one, else ESTIMATE max(units×1265, floors×20000, acres×43560×0.1)), gfa_source ("stated" or "estimated"), start_date, delivery_date, description, description_long, types (array — FULL replacement list of type tags, normalized against the canonical vocabulary), preferred_type (single canonical tag — most often "Mixed-Use" when re-classifying multi-use projects).',
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
    name: 'correct_project_history',
    description: 'CORRECT or DELETE an entry in a project\'s dossier timeline (status_history) — the ONLY way to fix a milestone that was logged WRONG. update_project_status can add/advance/correct-status but can NEVER remove a milestone, so false, mis-dated, or duplicated milestones need this. Use it to: DELETE a milestone that never happened; EDIT a milestone that was dated to the article\'s publish date so it reflects the real event date (or a vague label like "Spring 2026" when the exact date is unknown); or remove a duplicate. Identify the project by slug and the entry by its phase (e.g. "going-vertical", "financing", or a coarse status like "construction"); when a project has more than one entry for that phase, ALSO pass match_effective_date and/or match_source_url to disambiguate. Writes to the live map (rebuilds ~1h; git history = audit trail). Always pass reason.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Project slug (from search_projects / list_projects_due).' },
        action: { type: 'string', enum: ['delete', 'edit'], description: 'delete = remove the entry entirely; edit = rewrite its effective_date and/or note.' },
        phase: { type: 'string', description: 'Which timeline entry to fix. For a fine milestone use the phase: financing, going-vertical, halfway, topping-out, tenant, tco, move-in, bookings. For a coarse status transition use the target status: announced, breaking-ground, construction, coming-soon, open.' },
        match_effective_date: { type: 'string', description: 'The CURRENT effective_date of the entry — pass it to disambiguate when the project has multiple entries for the same phase (e.g. two "going-vertical" logs).' },
        match_source_url: { type: 'string', description: 'The source_url of the entry — another disambiguator.' },
        new_effective_date: { type: 'string', description: 'action:edit only — the CORRECTED event date. YYYY / YYYY-MM / YYYY-MM-DD, or a vague label ("Spring 2026", "Mid 2026", "Late 2026", "Q2 2026") when the exact date is unknown. NEVER the article publish date.' },
        new_note: { type: 'string', description: 'action:edit only — an optional corrected one-line note.' },
        reason: { type: 'string', description: 'Why this correction is being made (required) — cite what was wrong, e.g. "logged May 2026 from a progress-update article, but the tower went vertical earlier; source gives no exact date".' },
      },
      required: ['slug', 'action', 'phase', 'reason'],
    },
  },
  {
    name: 'update_project_status',
    description: 'Update a Map of Tomorrow project from a credible web source — advance its lifecycle status AND/OR update its construction-start / completion dates. Status order is ' + STATUS_ORDER.join(' → ') + ' (coming-soon = under construction and opening within ~6-7 months, NOT a pre-construction phase); status normally moves FORWARD only. When advancing status AND logging milestones across separate calls, set or re-assert the status LAST — a same-project milestone call can revert a just-applied advance — the ONE exception is correction:true, which walks an OVER-STATED status back when credible current sources show the recorded phase is wrong (e.g. wrongly marked under-construction but it has not broken ground → set new_status "announced" + correction:true). Dates can change in either direction (delays are common) and auto-apply when a source states a new one — even with NO status change (e.g. a project still "construction" whose opening slips a year). mode "apply" writes to the LIVE map (rebuilds within ~1h) and records the source in status_history (git history = audit trail). ALWAYS pass effective_date when a source states WHEN a milestone happened (e.g. "broke ground Sept 3 2025") — it dates the dossier timeline to the real event, not our discovery date. For FINER phases between the coarse statuses (financing/loan closed, going vertical, halfway, topped out, tenant announced, TCO, resident move-in, hotel bookings open) pass `milestone` (with effective_date + source_url) to log them to the dossier WITHOUT changing status. For a `financing` milestone, ALSO pass `loan_amount` (e.g. "$323.8M") and `lender` (e.g. "Bank OZK") whenever the source states them — they are stored structurally to power the "Follow the Money" intelligence. mode "propose" queues a STATUS change for one-tap human review (ambiguous/thin/multi-step) — dates always auto-apply regardless of mode. It also fills/corrects factual SPEC fields — units (residential count), floors (stories), keys (hotel rooms), and gfa_sqft (GROSS FLOOR AREA / total built sq ft — the "how big" number that powers biggest-projects ranking; capture a stated figure or estimate it) — which auto-apply like dates (many projects are missing these). Always pass source_url. Pass new_status only when the status actually advances; omit it for a date-only or spec-only update. IMPOSSIBLE DATES: when a recorded date is logically impossible for the project\'s own status/scale (e.g. a 47-story tower still pre-construction recorded as delivering next year, or a past construction-start on a project that has not broken ground), FIX it with date_correction:true — clear_start_date/clear_delivery_date to blank it, start_speculative/delivery_speculative (on their own) to flag an existing date as a TMW estimate, or a new start_date/delivery_date + *_speculative to replace it with a realistic estimate. With date_correction:true a `note` explaining WHY stands in for source_url (the project\'s own state is the proof). Use it only for logically-impossible dates, never to overwrite a plausible one without a source.',
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
        start_speculative: { type: 'boolean', description: 'True if start_date is a TMW estimate, not developer-committed. Can be set on its own (no new start_date) to flag an EXISTING date as an estimate — pair with date_correction:true + a note.' },
        delivery_speculative: { type: 'boolean', description: 'True if delivery_date is a TMW estimate. Can be set on its own (no new delivery_date) to flag an EXISTING date as an estimate — pair with date_correction:true + a note.' },
        clear_start_date: { type: 'boolean', description: 'Set TRUE to CLEAR (blank) a wrong/impossible recorded construction-start date — e.g. a project recorded as started in a PAST year that is still pre-construction. A DATE CORRECTION (pair with date_correction:true + a note); no source_url needed.' },
        clear_delivery_date: { type: 'boolean', description: 'Set TRUE to CLEAR (blank) an impossible recorded delivery/opening date — e.g. a 47-story tower not yet under construction recorded as delivering next year. A DATE CORRECTION (pair with date_correction:true + a note); no source_url needed.' },
        date_correction: { type: 'boolean', description: 'Set TRUE for a self-evident DATE FIX derived from the project\'s OWN state rather than a new external source — clearing an impossible date (clear_start_date/clear_delivery_date), flagging an existing date as a TMW estimate (start_speculative/delivery_speculative on their own), or replacing an impossible date with a realistic estimate (start_date/delivery_date + *_speculative). With date_correction:true a `note` explaining WHY (e.g. "47-story tower still pre-construction, so 2026 delivery is impossible") stands in for source_url. Use ONLY when the recorded dates are logically impossible given the project\'s status/scale — not to overwrite a plausible date without a source.' },
        effective_date: { type: 'string', description: 'When the milestone ACTUALLY happened in the real world — NOT today, and NOT the article\'s publish date. e.g. "broke ground Sept 3, 2025" → "2025-09-03". CRITICAL: the publish date is NOT the event date — a June 2026 article reporting a tower "has gone vertical" usually means it happened MONTHS earlier; date it to when it actually occurred, never to when the article ran. If the source does NOT state the exact date/month, DO NOT guess a precise month and DO NOT fall back to the publish date — pass a VAGUE label instead: "Spring 2026", "Mid 2026", "Late 2026", "Early 2027", or "Q2 2026". Precise forms YYYY / YYYY-MM / YYYY-MM-DD are for when the source actually gives that precision. Powers the dossier timeline. If omitted on a status advance, it falls back to start_date/delivery_date. ALSO pass it with `milestone`.' },
        milestone: { type: 'string', enum: MILESTONE_PHASES, description: 'Log a FINER construction-phase event to the dossier timeline WITHOUT changing the lifecycle status. Use for phases between the coarse statuses: financing (loan/construction financing closed), going-vertical (superstructure rising above grade), halfway (≈50% complete), topping-out (final beam/roof structure complete), tenant (an anchor/retail/office tenant announced), tco (Temporary Certificate of Occupancy issued), move-in (residents begin moving in), bookings (the reservations/sales-launch slot — for a HOTEL taking reservations OR a RESIDENTIAL project launching condo sales; the dossier auto-labels it "Bookings open" for hotels and "Sales launched" for residences by building type, so pick the milestone by what actually happened, not by the label). Pair with effective_date (when it happened) + source_url. The coarse statuses themselves — announced, broke ground, grand opening — go via new_status, not here. A milestone-only call is valid (omit new_status).' },
        loan_amount: { type: 'string', description: 'FINANCING milestone only (milestone:"financing") — the loan / capital-raise size exactly as reported, e.g. "$323.8M", "401M", "1.2B". Stored as a structured figure (millions) on the entry so the Intelligence "Follow the Money" surfaces read a real number instead of parsing the note. Always pass it when the source states an amount.' },
        lender: { type: 'string', description: 'FINANCING milestone only — the lender / capital provider, e.g. "Bank OZK", "Northwind Group", "Madison Realty Capital". Powers the lender league table. Pass the senior/primary lender when several are named.' },
        units: { type: 'integer', description: 'Residential unit count — fill/correct when a credible source states it (auto-applies; many projects are missing this)' },
        floors: { type: 'integer', description: 'Floor / story count — fill/correct from a credible source (auto-applies)' },
        keys: { type: 'integer', description: 'Hotel key (room) count — fill/correct from a credible source for hotels/resorts (auto-applies)' },
        gfa_sqft: { type: 'integer', description: 'GROSS FLOOR AREA — total BUILT square feet across the whole project (auto-applies like units/floors; the "how big is this development" number that powers "biggest projects" ranking, and most projects are missing it). Capture the STATED figure whenever a source gives one ("a 1.2-million-square-foot tower", "2.5M sq ft mixed-use") and set gfa_source:"stated". If none is stated, ESTIMATE it as max(units×1265, floors×20000, acres×43560×0.1) and set gfa_source:"estimated" (a tall tower on a small lot should still be large — floors×20000).' },
        gfa_source: { type: 'string', enum: ['stated', 'estimated'], description: '"stated" if gfa_sqft came from a source, "estimated" if you derived it from floors/units/acreage. Defaults to "stated" when gfa_sqft is provided without it.' },
        neighborhood: { type: 'string', description: 'Neighborhood / submarket / district the project sits in (e.g. "Design District", "Northwood", "Brickell", "Wynwood", "Edgewater"). Auto-applies like specs. Fill it whenever you can identify it from the source/address — it powers neighborhood-level search & filtering. Use the canonical local name, not a street.' },
        borough: { type: 'string', description: 'Borough / sub-locality shown as the displayed location instead of the city (e.g. "Brooklyn", "Manhattan"). NYC boroughs auto-derive from coordinates; set this only to override. City is unchanged.' },
        street: { type: 'string', description: 'STREET address line — street number + street name only (e.g. "1428 Brickell Avenue"), NOT the city/zip/country. Auto-applies like specs. Backfill it whenever a credible source gives the address — most projects are missing it, and it powers full-address answers. Put the town/city in the record\'s existing city, the zip in postal_code, the nation in country.' },
        postal_code: { type: 'string', description: 'ZIP / postal code (e.g. "33131", "518000", "SW1A 1AA"). Auto-applies like specs. Backfill from a credible source.' },
        country: { type: 'string', description: 'Country name, spelled out (e.g. "United States", "China", "Italy"). Auto-applies like specs. Backfill on EVERY project, US and international — it powers country-level search and full addresses.' },
        types: { type: 'array', items: { type: 'string' }, description: 'FULL replacement list of project type tags (auto-applies). Use to re-classify — most commonly to promote a multi-use project to Mixed-Use, or to add a Retail tag to a project that had Eateries. Pass the WHOLE list (not a diff); pre-existing tags not in this array are removed. Tags are normalized against the existing vocabulary and unrecognized tags are dropped — never coin new ones. CLASSIFICATION RULE: Resort always wins (preferred_type=Resort, no Mixed-Use). Otherwise, if 2+ types from {Residences, Office, Hotel, Retail, Cultural, Education, Entertainment, Stadium, Hospital, Travel} are present, the project IS Mixed-Use (add "Mixed-Use" to types AND set preferred_type="Mixed-Use"). Hospitality with amenities only (Hotel + Eateries/Park/Marina) stays Hotel — restaurants are amenities, not separate primary uses.' },
        preferred_type: { type: 'string', description: 'Single primary type the dossier should treat as canonical. Auto-applies. Use alongside `types` when promoting to Mixed-Use (set preferred_type:"Mixed-Use"). Falls through if unrecognized.' },
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
  {
    name: 'list_content_gaps',
    description: 'The CONTENT-GAP backlog — what people actually ASK Onyx (TMW Intelligence) where our coverage is thin or empty. Reads the real search/answer logs and returns `gaps` (queries asked repeatedly but with little or no matching coverage — PRIORITIZE these when choosing what to WRITE in daily-articles or what to SCOUT in project-discovery) and `demand` (the most-asked queries overall, whatever the coverage). Call this at the START of a content run so real audience demand steers the topic picks instead of guessing. No admin token needed. ALSO returns do_not_cover: draft topics the human editor REJECTED (deleted) in the last ~4 months — never draft these stories or close variants; generate_article_draft will refuse them.',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Look-back window in days (default 30, max 120).' }, limit: { type: 'number', description: 'Max gaps to return (default 25).' } } },
  },

  // ── Brand brain (shared house style / taste, updates for both accounts) ──────
  {
    name: 'get_brand_brain',
    description: 'Read the shared Markets of Tomorrow "brand brain" — the house style the team teaches over time. CALL THIS FIRST before writing or critiquing any post, carousel, caption, headline, or article. Returns the curated CANON playbook (always applies) plus pool notes retrieved by relevance to your topic — ALWAYS pass topic with a short description of what you are about to write (e.g. "carousel for a Nashville hotel opening") so the right house notes surface. Pass all:true ONLY when managing the brain (lists every note with ids for remove_brand_note).',
    inputSchema: { type: 'object', properties: {
      topic: { type: 'string', description: 'What you are about to write — a short phrase; drives relevance retrieval of house notes' },
      all: { type: 'boolean', description: 'Management view: return every active note with ids/tiers/scopes' },
    } },
  },
  {
    name: 'merge_media_folders',
    description: 'Merge one media folder INTO another: every image (and every sub-folder) under `from` moves to `to`, and `from` disappears. Use it when the same project ended up with two folders (for example "Projects / Martis Camp" and "Projects / Martis Camp Tahoe"). Keep the more specific, canonical project name as `to`. This is a real move, not a copy, and it cannot be auto-undone, so be sure the two folders are genuinely the same project before merging: near-identical names can still be different developments (a hotel and its residences, a district and a tower inside it).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Folder to empty and remove (full path, e.g. "Projects / Martis Camp").' },
        to: { type: 'string', description: 'Folder to keep (full path, e.g. "Projects / Martis Camp Tahoe").' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'teach_from_rewrite',
    description: 'THE STRONGEST WAY TO TEACH THE HOUSE VOICE. Use this the moment the human rewrites a draft by hand, or pastes their own version and says "this is what I want". It (1) saves their version as the draft body, and (2) banks the before/after as an EDIT PAIR in the shared learning loop — the same pipeline the publish-time learner uses, embedded so every future article generation retrieves it by topic relevance and sees it under "THE EDITOR\'S HAND". This is far more durable than a text note, because the model learns from the actual prose delta rather than a description of it. ALWAYS follow this call with 2-3 record_preference notes stating the SPECIFIC, reusable lessons from the diff (for example: "open on the category claim and the stakes before any spec", "never signpost with a line telling the reader what to think"), so the lesson also lands as an explicit rule. If the piece later gets published, pin it with pin_voice_exemplar so it becomes a gold-standard reference.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug of the draft the human rewrote.' },
        rewrite_markdown: { type: 'string', description: "The human's version of the article, in Markdown. Saved as the new draft body." },
        note: { type: 'string', description: 'Optional one-line summary of what they changed and why (goes on the learning record).' },
      },
      required: ['slug', 'rewrite_markdown'],
    },
  },
  {
    name: 'pin_voice_exemplar',
    description: 'Pin (or unpin) a PUBLISHED article as a GOLD-STANDARD voice exemplar. Pinned pieces are injected verbatim into every future article-writing prompt with the instruction to match their voice, rhythm, structure, and how they open and land — they are the single highest-leverage voice control in the system, ahead of any rule text. Pin the pieces that best represent how TMW should read. Only published posts count (drafts are ignored by the exemplar retriever).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug of the PUBLISHED post to pin.' },
        on: { type: 'boolean', description: 'true to pin (default), false to unpin.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'record_preference',
    description: 'Add a learning to the shared brand brain so it updates for BOTH accounts immediately. Use whenever someone expresses a like, dislike, rule, voice/tone note, structure preference, topic interest, or names a good example. Keep each note to one crisp, reusable REUSABLE-CRAFT sentence — never project-specific facts, bug reports, or data gaps (those get scope data/bug/ops and stay out of writing prompts). BEFORE adding a rule that changes an existing one, retire the old note with remove_brand_note instead of stacking a correction on top.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['like', 'dislike', 'rule', 'voice', 'structure', 'topic', 'avoid', 'example'], description: 'What kind of guidance this is' },
        note: { type: 'string', description: 'One crisp, reusable sentence of guidance' },
        category: { type: 'string', description: 'Optional grouping, e.g. "carousel", "article", "headline", "general"' },
        context: { type: 'string', description: 'Optional: a post slug, example snippet, or the reason behind it' },
        by: { type: 'string', description: 'Who said it, if known (e.g. "Jake", "wife")' },
        scope: { type: 'string', enum: ['voice', 'data', 'bug', 'ops'], description: 'Purpose routing (default auto): voice = house style used in writing prompts; data = dataset correction; bug = system issue; ops = tool how-to' },
      },
      required: ['kind', 'note'],
    },
  },
  {
    name: 'remove_brand_note',
    description: 'Retire one note from the brand brain by its id (from get_brand_brain) — use when a preference changes or a note was wrong.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_brain_notes',
    description: 'Read the raw brand-brain notes WITH THEIR IDS, page by page — what consolidation works from. get_brand_brain gives the assembled picture; this gives the inventory. Filter by tier (pool is the only one automation may touch: canon, format and editor are off limits), scope (voice notes are the ones that actually reach writing prompts), or a text query. Returns id, kind, note, scope, tier, created_at, retrievals (how often relevance has pulled it) so you can spot dead weight.',
    inputSchema: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['pool', 'canon', 'format', 'editor'], description: 'Default pool.' },
        scope: { type: 'string', enum: ['voice', 'data', 'bug', 'ops'], description: 'Default voice (the notes that reach writing prompts).' },
        q: { type: 'string', description: 'Optional text filter on the note body.' },
        never_retrieved: { type: 'boolean', description: 'Only notes relevance has never pulled — the likeliest dead weight.' },
        limit: { type: 'number', description: 'Default 200, max 500.' },
        offset: { type: 'number', description: 'For paging through the full pool.' },
      },
    },
  },
  {
    name: 'consolidate_brain_notes',
    description: 'THE COMPRESSION TOOL: write ONE consolidated principle and retire the notes it absorbs, atomically, in a single call. This is how the brain gets smaller and sharper instead of just bigger. Use it for every cluster in a consolidation pass: never record_preference the principle and then retire the originals separately, because a failure between the two halves leaves the pool bloated. Only pool-tier notes can be absorbed; canon, format and editor ids are ignored. The originals are ARCHIVED, not deleted, so the change is reversible.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The consolidated principle: imperative, specific enough to change a draft, the way a senior editor would say it out loud.' },
        retire_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the pool notes this principle absorbs.' },
        kind: { type: 'string', enum: ['like', 'dislike', 'rule', 'voice', 'structure', 'topic', 'avoid', 'example'], description: 'Default rule.' },
        evidence: { type: 'string', description: 'Optional: what the cluster was about, contradictions resolved, and how.' },
      },
      required: ['note', 'retire_ids'],
    },
  },
  {
    name: 'retire_brain_notes',
    description: 'Retire MANY brand-brain notes at once by id (archived, not deleted, so it is reversible). For clearing dead weight in bulk during a consolidation pass: exact duplicates, stale one-offs about a single article, notes that contradict canon, and non-craft notes (bug reports, data gaps) that are sitting at scope voice and leaking into writing prompts. Pool tier only.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string', description: 'One line on why, for the audit log.' },
      },
      required: ['ids'],
    },
  },

  // ── Contacts (Monday.com replacement) ───────────────────────────────────────
  // Lightweight CRM of the PR/brand contacts behind each post. One contact per
  // post (posts.contact_id). Tags are free-form (Travel/Real Estate/Hospitality/
  // Wellness are the seed chips); "connected posts" is computed live from
  // posts.contact_id, so we never duplicate.
  {
    name: 'list_contacts',
    description: 'List Studio contacts (brand owners, PR reps, agency leads) — the Monday.com Contact column replacement. Returns name, email, company, tags, and a live post count per contact. Filter by a tag chip (Travel/Real Estate/Hospitality/Wellness/etc) or free-text on name/email/company. For looking up a single contact by id (with their full connected-post list), use get_contact.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text match against name, email, or company (case-insensitive substring)' },
        tag:   { type: 'string', description: 'Filter to contacts carrying this tag (exact, case-sensitive)' },
        limit: { type: 'integer', description: 'Max results (default 100, max 500)' },
        offset:{ type: 'integer', description: 'Pagination offset' },
      },
    },
  },
  {
    name: 'search_contacts',
    description: 'Alias for list_contacts with the free-text query promoted to first-class — use this when you have a name/email/company fragment and want the matching contact(s). Identical return shape.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text match against name, email, company' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_contact',
    description: 'Get a single Studio contact by id, including every post connected to them (posts.contact_id reverse lookup). Returns the contact record + the list of {slug, title, post_type, income, date, status} for each connected post — the same data the admin Contacts page renders.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_contact',
    description: 'Create a new Studio contact in the Monday-replacement CRM. Use when assigning a contact to a post and the person is not already in the system (the post editor surfaces this as an inline "+ Create new contact"). Returns the new id so the caller can immediately set posts.contact_id to it.',
    inputSchema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Full name (required)' },
        email:   { type: 'string', description: 'Primary email' },
        company: { type: 'string', description: 'Company / agency the contact represents' },
        phone:   { type: 'string', description: 'Optional phone number' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'Free-form tags — seed chips are Travel, Real Estate, Hospitality, Wellness. Pass as a string array (or a comma-separated string).' },
        notes:   { type: 'string', description: 'Optional free-form notes about the relationship' },
        featured:{ type: 'boolean', description: 'Mark as a featured contact (gold star, pinned to the top of the rolodex).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update fields on an existing Studio contact. Only the keys you pass change; tags pass FULL replacement (omit to leave tags as-is, pass [] to clear).',
    inputSchema: {
      type: 'object',
      properties: {
        id:      { type: 'string', description: 'Contact id' },
        name:    { type: 'string' },
        email:   { type: 'string' },
        company: { type: 'string' },
        phone:   { type: 'string' },
        tags:    { type: 'array', items: { type: 'string' }, description: 'FULL replacement list of tags' },
        notes:   { type: 'string' },
        featured:{ type: 'boolean', description: 'Toggle the featured-contact (gold star) flag.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_contact',
    description: 'Delete a Studio contact. Any posts that reference this contact_id are detached (their contact_id is set to NULL — the post itself is untouched). Cannot be undone; use only when the contact was a duplicate or was created in error.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },

  // ── Campaigns ───────────────────────────────────────────────────────────────
  // Multi-month commitments with a client (e.g. "Ponce Park Coral Gables — 10-
  // month Gold campaign, $18,750, 5 deliverables"). Each post can link to a
  // campaign; income on the post is auto-derived from the campaign math.
  {
    name: 'list_campaigns',
    description: 'List Studio campaigns (multi-month client commitments — paid editorial, partnership packages). Returns id, name, tier (Gold/Platinum/Custom), status (live/ended), start/end dates, total income, monthly recurring income, planned post count, live post count, and the contact id behind each. Filter by status to see only live deals; free-text q matches on name + notes.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['live','ended'], description: 'Only return campaigns at this lifecycle' },
        query:  { type: 'string', description: 'Free-text match against campaign name/notes' },
        limit:  { type: 'integer', description: 'Max results (default 50, max 200)' },
        offset: { type: 'integer' },
      },
    },
  },
  {
    name: 'get_campaign',
    description: 'Get one Studio campaign by id, including every post linked to it (campaigns.campaign_id reverse lookup). Returns the campaign record + the connected-posts list ({slug, title, post_type, income, date, status}) — same data the admin Campaigns page renders.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_campaign',
    description: 'Create a new Studio campaign. Name is required; everything else is optional and editable later. When total_income and planned_posts are both set, linking a post to this campaign auto-fills the post.income to total_income / planned_posts.',
    inputSchema: {
      type: 'object',
      properties: {
        name:            { type: 'string', description: 'Display name, e.g. "Ponce Park Coral Gables"' },
        contact_id:      { type: 'string', description: 'Lead PR/brand contact (from list_contacts)' },
        project_slug:    { type: 'string', description: 'Optional Map of Tomorrow project the campaign promotes' },
        tier:            { type: 'string', description: 'Gold / Platinum / Custom / etc — free-form so new tiers don\'t need schema changes' },
        status:          { type: 'string', enum: ['live','ended'], description: 'Default "live"' },
        start_date:      { type: 'integer', description: 'Campaign start (unix seconds)' },
        end_date:        { type: 'integer', description: 'Campaign end (unix seconds). Omit for ongoing.' },
        total_income:    { type: 'number',  description: 'Lump-sum value for the whole campaign' },
        monthly_income:  { type: 'number',  description: 'Recurring rate for "$/mo" campaigns' },
        planned_posts:   { type: 'integer', description: 'Deliverable count — used to split total_income across posts on link' },
        notes:           { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_campaign',
    description: 'Update fields on an existing campaign. Only the keys you pass change. If total_income or planned_posts changes, the worker re-spreads income across every linked post.',
    inputSchema: {
      type: 'object',
      properties: {
        id:             { type: 'string' },
        name:           { type: 'string' },
        contact_id:     { type: 'string' },
        project_slug:   { type: 'string' },
        tier:           { type: 'string' },
        status:         { type: 'string', enum: ['live','ended'] },
        start_date:     { type: 'integer' },
        end_date:       { type: 'integer' },
        total_income:   { type: 'number' },
        monthly_income: { type: 'number' },
        planned_posts:  { type: 'integer' },
        notes:          { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_campaign',
    description: 'Delete a Studio campaign. Any posts linked to it are detached (campaign_id set NULL and income cleared) but the posts themselves stay. Cannot be undone.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'link_post_to_campaign',
    description: 'Link an existing post to a campaign. Sets posts.campaign_id and, if the campaign has total_income + planned_posts, auto-fills the post.income to total_income / planned_posts. Use this when a published article is part of a paid editorial commitment.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        post_id:     { type: 'string', description: 'The post id (from list_posts / search_posts)' },
      },
      required: ['campaign_id', 'post_id'],
    },
  },

  // ── Studio admin (read-only) ────────────────────────────────────────────────
  // Full read parity with the backend admin studio: flows ledger, subscriptions,
  // members, funnel, placements, galleries, giveaways, intel, social, brain.
  // Every tool reuses the exact handler its Studio page calls — same numbers.
  {
    name: 'list_flows',
    description: 'The Flows ledger — every income/offer/expense row the Studio Flows page shows: kind (incoming/offer), date, amount, description, party (the client), paid_by, category, status, type, star, notes, expenses, invoice/received dates, location. Optional year filter; response includes the list of years with data. The monthly TMW Pro gross rollup rows are automated — never suggest adding Pro income manually.',
    inputSchema: { type: 'object', properties: { year: { type: 'integer', description: 'e.g. 2026 — omit for all years' } } },
  },
  {
    name: 'get_pro_income',
    description: 'Monthly TMW Pro gross income series straight from Stripe charges (the same series the Flows page auto-rolls up). Returns one bucket per month.',
    inputSchema: { type: 'object', properties: { months: { type: 'integer', description: 'How many months back (default 12, max 24)' } } },
  },
  {
    name: 'list_subscriptions',
    description: 'Live Memberstack subscription snapshot — paying vs free counts, monthly vs yearly, auto-discovered price tiers with member counts, trialing members. The source of truth behind the Analytics page revenue/MRR tiles.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_people',
    description: 'The member registry (Analytics "People" table): every member with email, name, plan, member number, first/last seen and event counts. Large — use limit/offset and prefer get_member_profile for one person.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Max members returned (default 100)' }, offset: { type: 'integer' }, q: { type: 'string', description: 'Case-insensitive filter on email/name' } } },
  },
  {
    name: 'get_member_profile',
    description: 'Everything the Studio knows about one member: live Stripe subscription status (trialing/active/canceled, period end) plus full subscription + invoice history by email; pass member_id too for their Onyx Deep credit status. Use for "what happened with <email>" support questions.',
    inputSchema: { type: 'object', properties: { email: { type: 'string' }, member_id: { type: 'string', description: 'Memberstack id — adds Deep-credit status' } }, required: ['email'] },
  },
  {
    name: 'get_funnel_stats',
    description: 'Signup/conversion funnel events bucketed by ISO week (funnel:* event rollup — gate shown, account created, go-pro shown, checkout clicks…). The Analytics conversion view. weeks defaults to 12.',
    inputSchema: { type: 'object', properties: { weeks: { type: 'integer', description: '1–52, default 12' } } },
  },
  {
    name: 'get_placements',
    description: 'First-party placement tracking stats — impressions + clicks for banner ads, Partners of Tomorrow, and newsletter creatives (the /track + /r + /px beacons), per placement id. The Studio Placements tab data.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', description: 'Window in days' } } },
  },
  {
    name: 'list_galleries',
    description: 'Client photo galleries (gallery.oftmw.com) — every gallery incl. unlisted/private: slug, title, subtitle, category, location, visibility, PIN-protected flag, image count, timestamps. These are the client-facing deliverable galleries.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_gallery_downloads',
    description: 'The gallery download log — who (email) downloaded from which client gallery, when, from where. Filter by gallery slug or free-text q on email/title.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer', description: 'Default 200, max 1000' } } },
  },
  {
    name: 'list_giveaways',
    description: 'Studio giveaways — every configured giveaway with its settings and status (the admin Giveaways page list).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_categories',
    description: 'The canonical journal category list (the Studio Categories tab) — the ONLY place categories are minted. Use to check exact category spelling before writing posts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_intel_pulse',
    description: 'Onyx / TMW Intelligence usage stats — query volume, answer coverage, deep-search usage over time (the Intelligence tab "Pulse" view).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_intel_teaching',
    description: 'The LIVE Onyx teaching state — learned rules + gold exemplars the intel-review loop maintains (the Intelligence tab "Teach" view). Read-only here; edits go through the Studio.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_trending_searches',
    description: 'Trending Onyx searches (the homepage Live Board "trending" feed) — what members are asking right now.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_markets_followed',
    description: 'Which Focus Markets members follow — per-market follower counts from market_followed events.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_social_overview',
    description: 'Social distribution state: the connected social accounts roster (7 accounts × 6 platforms) + follower-count snapshots per account over time (the Studio Followers page).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_email_stats',
    description: 'Email operations rollup for the morning brief: wall-hit/blast automation sends (24h + 7d by kind and mode, pending quota-errored sends, live flag, launch-blast report), the latest Resend newsletter broadcasts (id/status/sent_at), and the newsletter\'s first-party placement performance (views/clicks per creative, last 7 days). One call answers "how many automated emails went out and how did the newsletter do".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_daily_pulse',
    description: 'Today-so-far activity pulse (local-midnight window via off = minutes behind UTC, e.g. 240 for ET): total site visitors (with the signed-in members listed by email), free accounts created today (who + when), and automated upgrade emails sent today (who, which wall, status). Powers the Morning Desk headline.',
    inputSchema: { type: 'object', properties: { off: { type: 'integer', description: 'Timezone offset in minutes behind UTC (ET = 240; default 0 = UTC midnight)' } } },
  },
  {
    name: 'list_brain_proposals',
    description: 'Shared-brain proposals awaiting human review (the /brain/proposed queue) — learning-loop notes captured from edits and routines that Jake approves/rejects in the Brain page.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function iso(ts) { return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null; }
function parseJSON(s, fallback) { try { return JSON.parse(s); } catch (_) { return fallback; } }

// Category firewall for the connector: NO post-writing MCP tool may mint a NEW
// category. New categories are created deliberately by Jake in the Studio
// Categories tab only. Given a candidate label, return it verbatim if it
// already exists on some post (case-insensitive), else '' (→ save uncategorized).
// Fails OPEN only on a DB error (returns the label) so a transient failure never
// silently drops a legit existing category.
async function knownCategoryOrBlank(env, cat) {
  const c = String(cat || '').trim();
  if (!c) return '';
  try {
    const rows = (await env.DB.prepare("SELECT DISTINCT categories FROM posts WHERE categories IS NOT NULL AND categories != '' AND categories != '[]' LIMIT 3000").all()).results || [];
    const known = new Set();
    for (const r of rows) { try { (JSON.parse(r.categories) || []).forEach(x => { if (x) known.add(String(x).toLowerCase()); }); } catch (_) {} }
    return known.has(c.toLowerCase()) ? c : '';
  } catch (_) { return c; }
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'untitled';
}

// Sprinkle image URLs through a Markdown body — one ![](url) figure spread evenly
// between paragraphs (skips inserting right after a heading).
// Hard cap on images per article. Keeps the first MAX markdown image tokens
// (![alt](url), incl. the captioned ![alt](url "cap") form) in document order
// and strips the rest, so no article body ever ships more than MAX images —
// whether they came from the model's markdown or the folder auto-sprinkle.
const MAX_ARTICLE_IMAGES = 10;
function capArticleImages(md) {
  if (!md) return md;
  let n = 0;
  return String(md).replace(/!\[[^\]]*\]\([^)]*\)/g, (m) => (++n <= MAX_ARTICLE_IMAGES ? m : ''));
}

// TRAILING BOILERPLATE. 602 published pieces end with Wix-era CTA lines
// ("Sign up for Florida of Tomorrow's free newsletter below..."), which also
// carry the retired "of Tomorrow" branding. The writer learns them from the
// corpus, so we strip them from what we teach AND from what we ship.
const CTA_RE = /(sign\s*up|subscribe|join\s+(our|the)|follow\s+us|our\s+free\s+newsletter|free\s+newsletter|newsletter\s+below|stay\s+in\s+the\s+know|never\s+miss|for\s+the\s+latest\s+(real\s+estate\s+)?news)/i;
function stripTrailingCta(md) {
  let blocks = String(md || '').split(/\n\s*\n/);
  for (let guard = 0; guard < 4; guard++) {
    while (blocks.length && !String(blocks[blocks.length - 1]).trim()) blocks.pop();
    const last = String(blocks[blocks.length - 1] || '').trim();
    if (!last) break;
    const plain = last.replace(/<[^>]*>/g, ' ').replace(/[*_#>]/g, ' ').trim();
    // Only a SHORT trailing block that reads like a call to action goes.
    if (plain.length <= 320 && CTA_RE.test(plain)) { blocks.pop(); continue; }
    break;
  }
  return blocks.join('\n\n');
}
// An article ENDS ON PROSE, never on a photo (Jake 2026-08-12). Drops any
// trailing image-only blocks left by the model or by an older sprinkle.
function endOnProse(md) {
  const isImageOnly = (b) => {
    const t = String(b || '').trim();
    if (!t) return false;
    return /^!\[[^\]]*\]\([^)]*\)$/.test(t) || /^<figure[\s\S]*<\/figure>$/i.test(t) || /^<img\b[^>]*>$/i.test(t);
  };
  const blocks = String(md || '').split(/\n\s*\n/);
  while (blocks.length && (!String(blocks[blocks.length - 1]).trim() || isImageOnly(blocks[blocks.length - 1]))) blocks.pop();
  return blocks.join('\n\n');
}
// Final gate for any article body we write.
function finishArticleBody(md) { return endOnProse(stripTrailingCta(endOnProse(md))); }

function sprinkleImagesIntoMarkdown(md, images) {
  if (images && images.length > MAX_ARTICLE_IMAGES) images = images.slice(0, MAX_ARTICLE_IMAGES);
  const base = stripTrailingCta(String(md || ''));
  if (!images || !images.length) return endOnProse(base);
  const blocks = base.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return '';
  // Legal slots are BETWEEN blocks only, never after the last one, and never
  // right before a heading (that would orphan the heading from its section).
  // Overflow images are DROPPED rather than dumped at the end, which is what
  // used to leave articles finishing on a photo.
  const slots = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    if (/^#{1,3}\s/.test(blocks[i + 1] || '')) continue;
    slots.push(i);
  }
  const use = Math.min(images.length, slots.length);
  const chosen = new Map();
  for (let k = 0; k < use; k++) {
    // Spread evenly across the available gaps.
    const at = slots[Math.min(slots.length - 1, Math.round(((k + 1) * slots.length) / (use + 1)))];
    if (!chosen.has(at)) chosen.set(at, images[k]);
  }
  // Any image whose slot collided lands in the next free gap.
  let next = 0;
  for (let k = chosen.size; k < use; k++) {
    while (next < slots.length && chosen.has(slots[next])) next++;
    if (next >= slots.length) break;
    chosen.set(slots[next], images[k]);
  }
  const out = [];
  blocks.forEach((b, i) => { out.push(b); if (chosen.has(i)) out.push(`![](${chosen.get(i)})`); });
  return endOnProse(out.join('\n\n'));
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
// Per Jake: keep em dashes out of article copy — swap them for commas (safety net;
// the tool also instructs the model to avoid them). Leaves unspaced en dashes
// (number ranges like 2020–2024) alone.
function deDash(s) {
  return String(s || '')
    .replace(/\s*—\s*/g, ', ')      // em dash (—), spaced or not → comma
    .replace(/(\S)\s+–\s+(\S)/g, '$1, $2')  // spaced en dash used as an em dash → comma
    .replace(/,\s*,/g, ',')         // tidy any doubled commas
    .replace(/,\s*([.!?;:])/g, '$1');       // ", ." → "."
}

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

// ── Internal auto-linking ────────────────────────────────────────────────
// "If we have a project, firm, or place in the database, use that hyperlink
// instead of an external URL." Deterministic post-pass over generated article
// Markdown (never trust the author model to know slugs):
//   pass 1 — existing [anchor](external) links whose anchor text IS a tracked
//            entity get their URL rewritten to the internal page; attribution
//            links ("The Real Deal") match nothing and survive untouched.
//   pass 2 — the first plain-text mention of each tracked entity becomes a
//            link. Longest names first so "Waldorf Astoria Residences Miami"
//            wins before "Miami", capped so articles never read link-stuffed.
//            Headings, image lines, and existing links are left alone.
const FIRMS_INDEX_URL = 'https://www.oftmw.com/map/firms-flat.json';
const MARKETS_INDEX_URL = 'https://www.oftmw.com/markets-index.json';
let _linkEntsCache = null;
// Who is driving this MCP request — 'claude-code-routine' (static token) or
// 'studio-connector' (OAuth). Set per-request in handleMcp; read by the
// voice-gate scorecard events.
let _mcpActor = 'studio-connector';
async function loadLinkEntities() {
  if (_linkEntsCache) return _linkEntsCache;
  const j = (u) => fetch(u, { cf: { cacheTtl: 3600 } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [projects, firms, mkts] = await Promise.all([loadProjects().catch(() => []), j(FIRMS_INDEX_URL), j(MARKETS_INDEX_URL)]);
  const ents = [];
  const seen = new Set();
  const push = (name, url) => {
    const key = String(name || '').trim().toLowerCase();
    if (key.length < 4 || seen.has(key)) return;   // too-short names false-match everywhere
    seen.add(key);
    ents.push({ name: String(name).trim(), url });
  };
  // Priority on name collisions: projects, then firms, then markets.
  for (const p of projects || []) if (p.Title && p.Slug) push(p.Title, 'https://www.oftmw.com/projects/' + p.Slug + '/');
  for (const role of ['architects', 'developers']) {
    for (const f of (firms && firms[role]) || []) {
      if (f.name && f.slug && (f.project_count || 0) >= 1) push(f.name, 'https://www.oftmw.com/firm/' + f.slug + '/');
    }
  }
  for (const [city, slug] of Object.entries(mkts || {})) push(city, 'https://www.oftmw.com/markets/' + slug + '/');
  ents.sort((a, b) => b.name.length - a.name.length);   // longest first
  _linkEntsCache = ents;
  return ents;
}
function autoLinkInternalMd(md, ents) {
  let text = String(md || '');
  const report = { rewritten: 0, added: 0 };
  const lcAll = text.toLowerCase();
  const cands = (ents || []).filter((e) => lcAll.includes(e.name.toLowerCase()));
  if (!cands.length) return { md: text, report };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // pass 1 — rewrite external links whose anchor text is a tracked entity
  const byName = new Map(cands.map((e) => [e.name.toLowerCase(), e]));
  text = text.replace(/(!?)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, bang, anchor, url) => {
    if (bang) return m;                          // images untouched
    if (/oftmw\.com/i.test(url)) return m;       // already internal
    const ent = byName.get(anchor.trim().toLowerCase());
    if (!ent) return m;
    report.rewritten++;
    return '[' + anchor + '](' + ent.url + ')';
  });
  // pass 2 — link the first plain-text mention of each entity
  const CAP = 8;
  for (const ent of cands) {
    if (report.added >= CAP) break;
    if (text.toLowerCase().includes('](' + ent.url.toLowerCase())) continue;   // already links there
    // Single-word names must match case EXACTLY: the firm "Elevated" once
    // linked the adjective "elevated" mid-sentence. Multi-word names are
    // unambiguous enough to stay case-insensitive.
    const oneWord = !/\s/.test(ent.name.trim());
    const re = new RegExp('(^|[^\\w\\[\\]])(' + esc(ent.name) + ')(?![\\w\\]])', oneWord ? '' : 'i');
    const lines = text.split('\n');
    let done = false;
    for (let i = 0; i < lines.length && !done; i++) {
      if (/^\s*#/.test(lines[i]) || /^\s*!\[/.test(lines[i])) continue;   // headings + image lines
      const parts = lines[i].split(/(!?\[[^\]]*\]\([^)]*\))/);
      for (let s = 0; s < parts.length && !done; s++) {
        if (/^!?\[/.test(parts[s])) continue;    // inside an existing link/image
        const m = parts[s].match(re);
        if (m) {
          const idx = m.index + m[1].length;
          parts[s] = parts[s].slice(0, idx) + '[' + m[2] + '](' + ent.url + ')' + parts[s].slice(idx + m[2].length);
          done = true; report.added++;
          lines[i] = parts.join('');
        }
      }
    }
    if (done) text = lines.join('\n');
  }
  return { md: text, report };
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

// Deterministic DUPLICATE gate for create_map_draft. Returns the live project a
// candidate draft would duplicate (with a reason), else null. Deliberately
// STRICTER than match_project's "strong" verdict: blocking a draft is cheap (the
// discovery routine just skips it and reports), whereas a duplicate draft is a
// manual chore the editor must catch by hand. Three ways to be a duplicate:
//   1. Exact slug collision — same slugified name (near-certain dup; the signal
//      scoreMatch never checked, which let "One Park Sarasota" / "Palazzo at
//      Bayfront" slip through).
//   2. Same city AND (brand-core containment OR name closely matches) — catches
//      "Park Place Nashville" vs an existing "Park Place" in Nashville when the
//      draft carried no website/coords for scoreMatch to anchor on.
//   3. scoreMatch's own "strong" verdict (decisive website host / geo proximity).
// The same-city clause keeps common names apart across markets ("Park Place"
// Nashville vs Miami never collide).
function findLiveDuplicate(cand, candSlug, projects) {
  if (candSlug) {
    for (const p of projects) {
      const pSlug = String(p.Slug || '').trim() || slugify(String(p.Title || ''));
      if (pSlug && pSlug === candSlug) return { project: p, reason: `same slug "${candSlug}"` };
    }
  }
  let best = null;
  for (const p of projects) {
    const m = scoreMatch(cand, p);
    let sameCity = false;
    if (cand.city && p.City) {
      const cc = normName(cand.city), pc = normName(p.City);
      sameCity = !!(cc && pc && (cc === pc || cc.includes(pc) || pc.includes(cc)));
    }
    // Name similarity with the CITY name stripped from both titles first — a
    // draft that embeds its city ("Park Place Nashville") must compare on "park
    // place", not let the shared "nashville" token match every Nashville project
    // ("Nobu Hotel Nashville"). Jaccard, not brand-subset: brand cores can reduce
    // to just a city token (park+place are both generic stopwords), which is
    // exactly what over-matched before.
    const cityStrip = new Set([...nameTokens(cand.city || ''), ...nameTokens(p.City || '')]);
    const cTok = nameTokens(cand.name).filter((t) => !cityStrip.has(t));
    const pTok = nameTokens(p.Title).filter((t) => !cityStrip.has(t));
    const jac = jaccard(cTok, pTok);
    const isDup = m.verdict === 'strong' || (sameCity && cTok.length && pTok.length && jac >= 0.6);
    if (isDup && (!best || m.score > best.score)) {
      best = {
        project: p,
        score: m.score,
        reason: m.verdict === 'strong' ? (m.reasons.join('; ') || 'strong match') : 'same city + name closely matches',
      };
    }
  }
  return best;
}

// Drafts that are staged but not yet promoted are INVISIBLE to findLiveDuplicate,
// which only ever saw the live map. That is why the discovery routine re-drafted
// the same project on every run (three identical "Jumeirah Residences Emirates
// Towers" drafts inside four days): a staged draft is not live, so the gate kept
// passing. Shape a drafts.json entry like a live project so the SAME matcher can
// gate draft-vs-draft with identical rules.
function draftsAsProjects(drafts) {
  return (Array.isArray(drafts) ? drafts : []).map((d) => {
    const x = (d && d.data) || {};
    return {
      Title: x.name || '',
      Slug: x.slug || '',
      City: x.city || '',
      Latitude: x.lat,
      Longitude: x.lng,
      OfficialWebsite: x.official_website || '',
      __draft_id: (d && d.draft_id) || '',
    };
  }).filter((p) => p.Title || p.Slug);
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

// ── Website image scraping (for scrape_website_images) ───────────────────────
// Resort SPACE = building / amenity / rendering imagery (what the publication runs
// on); LIFESTYLE = people / activities (nice-to-have, not the focus).
const SPACE_RE = /(villa|suite|room|residence|penthouse|pool|lobby|spa|restaurant|dining|bar|lounge|exterior|facade|aerial|drone|render|rendering|beach|resort|amenit|architect|terrace|balcony|ocean|seaview|view|wellness|golf|reception|building|interior|bedroom|bathroom|kitchen|deck|rooftop|courtyard|garden|entrance|lobby|suite)/i;
const LIFE_RE  = /(people|person|couple|family|guest|portrait|lifestyle|polo|zipline|horse|riding|yoga|surf|hik|adventure|activit|chef|staff|woman|man|child|kid|wedding|event|party|cocktail|drink|dish|food|plate)/i;
function scoreImageUrl(u) {
  const s = (() => { try { return decodeURIComponent(u).toLowerCase(); } catch { return String(u).toLowerCase(); } })();
  let sc = 0; if (SPACE_RE.test(s)) sc += 2; if (LIFE_RE.test(s)) sc -= 2;
  return { score: sc, cat: sc > 0 ? 'space' : sc < 0 ? 'lifestyle' : 'other' };
}
// Pull candidate image URLs out of one page via HTMLRewriter.
async function extractPageImages(pageUrl) {
  let base; try { base = new URL(pageUrl); } catch { return []; }
  const found = new Set();
  const add = (u) => { if (!u) return; u = String(u).trim(); if (!u || /^data:/i.test(u)) return; try { found.add(new URL(u, base).toString()); } catch (_) {} };
  const bestSrcset = (ss) => { let best = null, bw = -1; String(ss).split(',').forEach((p) => { const parts = p.trim().split(/\s+/); const u = parts[0]; const w = parseInt((parts[1] || '0').replace(/[^\d]/g, '')) || 0; if (u && w >= bw) { bw = w; best = u; } }); return best; };
  let res; try { res = await fetch(pageUrl, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (TMW Studio image scraper)' } }); } catch (_) { return []; }
  if (!res.ok) return [];
  const rw = new HTMLRewriter()
    .on('img', { element(el) { const ss = el.getAttribute('srcset'); if (ss) add(bestSrcset(ss)); else add(el.getAttribute('src'));
      ['data-src', 'data-lazy-src', 'data-original'].forEach((a) => add(el.getAttribute(a)));
      const dss = el.getAttribute('data-srcset'); if (dss) add(bestSrcset(dss)); } })
    .on('source', { element(el) { const ss = el.getAttribute('srcset'); if (ss) add(bestSrcset(ss)); else add(el.getAttribute('src')); } })
    .on('meta', { element(el) { const p = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase(); if (p === 'og:image' || p === 'og:image:url' || p === 'twitter:image' || p === 'twitter:image:src') add(el.getAttribute('content')); } })
    .on('link', { element(el) { if ((el.getAttribute('rel') || '').toLowerCase() === 'image_src') add(el.getAttribute('href')); } })
    .on('[style]', { element(el) { const s = el.getAttribute('style') || ''; const m = s.match(/url\((['"]?)([^'")]+)\1\)/i); if (m) add(m[2]); } });
  try { await rw.transform(res).text(); } catch (_) {}
  return [...found];
}
// Ask Claude (web_search) for more SOURCE PAGES likely to hold resort-space imagery.
async function webSearchSourcePages(env, query, max) {
  if (!env.ANTHROPIC_API_KEY) return [];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
        messages: [{ role: 'user', content:
          'Find web pages with PHOTOS or RENDERINGS of a resort property\'s SPACES — guest rooms / villas / suites, pools, lobby, spa, restaurants & bars, building exterior / facade, aerial / drone shots, and architectural renderings (NOT lifestyle/people shots). Search for: "' + query + '". '
          + 'Prefer the official hotel site gallery & press kit and reputable travel/design publications (Condé Nast, Travel+Leisure, Architectural Digest, dezeen, etc.). '
          + 'Return ONLY a JSON array (no prose, no markdown) of up to ' + max + ' page URLs most likely to contain such imagery, best first.' }],
      }),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const txt = (d.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    const m = txt.match(/\[[\s\S]*\]/); if (!m) return [];
    let arr; try { arr = JSON.parse(m[0]); } catch { return []; }
    return (Array.isArray(arr) ? arr : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, max);
  } catch (_) { return []; }
}
// Fetch one image URL, validate, store in R2 + index in media. Returns {url,...} or {skip}.
// Read pixel dimensions from an image's header (no decode) for the common raster
// formats. Returns {w,h} or null if the format can't be measured. Used to enforce
// the hi-res floor on scraped imagery.
function imageDims(buf) {
  try {
    const b = new Uint8Array(buf); const dv = new DataView(buf);
    // PNG — IHDR width@16 / height@20 (big-endian).
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { w: dv.getUint32(16), h: dv.getUint32(20) };
    // GIF — width@6 / height@8 (little-endian, 16-bit).
    if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    // WebP — RIFF….WEBP + VP8 / VP8L / VP8X.
    if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (fmt === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3FFF, h: dv.getUint16(28, true) & 0x3FFF };
      if (fmt === 'VP8L') { const w = 1 + (((b[22] & 0x3F) << 8) | b[21]); const h = 1 + (((b[24] & 0x0F) << 10) | (b[23] << 2) | ((b[22] & 0xC0) >> 6)); return { w, h }; }
      if (fmt === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    // JPEG — scan SOF markers for the frame dimensions.
    if (b.length >= 4 && b[0] === 0xFF && b[1] === 0xD8) {
      let off = 2;
      while (off + 9 < b.length) {
        if (b[off] !== 0xFF) { off++; continue; }
        let marker = b[off + 1]; while (marker === 0xFF && off + 1 < b.length) { off++; marker = b[off + 1]; }
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) { if (off + 9 <= b.length) return { h: dv.getUint16(off + 5), w: dv.getUint16(off + 7) }; break; }
        const len = dv.getUint16(off + 2); if (len < 2) break; off += 2 + len;
      }
    }
  } catch (_) {}
  return null;
}
// Hi-res floor for scraped imagery: the SHORTER side must be >= this many pixels,
// so BOTH dimensions are genuinely hi-res (a 2000x700 banner is rejected, not
// squeaked through on its long edge). Print/hero quality only.
const MIN_IMG_PX = 1200;
async function storeScrapedImage(env, src, folder, project, minBytes) {
  const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };
  try {
    const r = await fetch(src, { redirect: 'follow' });
    if (!r.ok) return { skip: 'http ' + r.status };
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\//.test(ct) || /svg/.test(ct)) return { skip: 'not a raster image' };
    const buf = await r.arrayBuffer();
    if (buf.byteLength < minBytes) return { skip: 'too small' };
    if (buf.byteLength > 25 * 1024 * 1024) return { skip: 'too large' };
    // HI-RES ONLY — the SHORTER side must be >= 1200px (measured from the header),
    // so both dimensions are hi-res. Unmeasurable formats fall back to byte-size.
    const _dim = imageDims(buf);
    if (_dim && Math.min(_dim.w || 0, _dim.h || 0) < MIN_IMG_PX) return { skip: 'low-res ' + (_dim.w || 0) + 'x' + (_dim.h || 0) };
    let fname = ''; try { fname = decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); } catch (_) {}
    fname = (fname || 'image').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
    if (EXT[ct] && !/\.[a-z0-9]{2,4}$/i.test(fname)) fname += EXT[ct];
    const key = buildMediaKey(fname);
    await env.MEDIA.put(key, buf, { httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000, immutable' }, customMetadata: { filename: fname, folder } });
    const publicBase = (env.MEDIA_PUBLIC_BASE || '').replace(/\/+$/, '');
    const purl = publicBase ? `${publicBase}/${key}` : '';
    const ts = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO media (key, filename, mime_type, size_bytes, alt_text, caption, uploaded_by, uploaded_at, url, folder)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
       ON CONFLICT(key) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type, size_bytes=excluded.size_bytes, url=excluded.url, folder=excluded.folder`
    ).bind(key, fname, ct, buf.byteLength, project, null, 'studio-mcp', ts, purl, folder).run();
    return { url: purl, filename: fname, size_bytes: buf.byteLength };
  } catch (e) { return { skip: (e && e.message) || 'error' }; }
}

// Resolve a map draft's images so create_map_draft reliably does BOTH jobs at
// once — file the photos in the project's media folder AND attach them to the
// draft. For each passed URL: one already in our R2 is kept (and re-filed under
// the project folder if it was loose); an external URL is fetched + stored in R2
// under "Projects / <name>" (permanent, shows in the Studio picker). When NO
// images are passed, auto-pull a prior scrape from that same folder so a
// scrape_website_images run isn't left orphaned. Returns { urls, folder, added,
// pulled, skipped }.
// Auto-scrape a few good images for a project into its media folder — the same
// pipeline scrape_website_images uses, so create_map_draft can do end-to-end
// (scrape → file → attach) in ONE call like the discovery routine does across
// steps. Website-first (the correct-project source, low pollution risk), then a
// web-search-by-name fallback. Best-effort: returns the R2 urls it filed.
async function autoScrapeImages(env, project, folder, website, want) {
  if (!env || !env.MEDIA || !env.DB) return [];
  const out = [], seen = new Set(), minBytes = 8 * 1024;
  const ingest = async (cands) => {
    const ranked = [...new Set(cands)].filter((u) => !seen.has(u)).map((u) => ({ u, ...scoreImageUrl(u) })).sort((a, b) => b.score - a.score);
    for (const c of ranked) {
      if (out.length >= want) break;
      seen.add(c.u);
      try { const res = await storeScrapedImage(env, c.u, folder, project, minBytes); if (res && res.url) out.push(res.url); } catch (_) {}
    }
  };
  // 1) the project's OWN website (correct-project, least pollution)
  if (website && /^https?:\/\//i.test(website)) { try { await ingest(await extractPageImages(website)); } catch (_) {} }
  // 2) still thin → web-search by name for source pages (renderings/exterior/aerial)
  if (out.length < want && env.ANTHROPIC_API_KEY) {
    try {
      const pages = await webSearchSourcePages(env, project + ' building rendering exterior facade aerial photos', 6);
      const cands = [];
      for (const p of pages) { if (p === website) continue; try { cands.push(...await extractPageImages(p)); } catch (_) {} }
      await ingest(cands);
    } catch (_) {}
  }
  return out;
}
async function ingestDraftImages(env, name, images, website) {
  const folder = ('Projects / ' + String(name || '').trim()).slice(0, 160);
  const passed = (Array.isArray(images) ? images : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8);
  if (!env || !env.MEDIA || !env.DB) return { urls: passed.slice(0, 6), folder, added: 0, pulled: 0, scraped: 0, skipped: [] };
  const base = (env.MEDIA_PUBLIC_BASE || '').replace(/\/+$/, '');
  const ts = Math.floor(Date.now() / 1000);
  try { await ensureMediaFoldersTable(env); await env.DB.prepare('INSERT OR IGNORE INTO media_folders (name, favorite, created_at) VALUES (?1,0,?2)').bind(folder, ts).run(); } catch (_) {}
  const urls = []; const skipped = []; let added = 0, pulled = 0, scraped = 0;
  for (const u of passed) {
    if (base && u.indexOf(base + '/') === 0) {
      // already in R2 — make sure it's filed under this project's folder, keep it.
      try { await env.DB.prepare("UPDATE media SET folder=?1 WHERE url=?2 AND (folder IS NULL OR folder='' OR folder='Unfiled')").bind(folder, u).run(); } catch (_) {}
      urls.push(u); continue;
    }
    const res = await storeScrapedImage(env, u, folder, name, 0);   // caller chose these; honor only the hi-res gate
    if (res && res.url) { urls.push(res.url); added++; }
    else skipped.push({ url: u, reason: (res && res.skip) || 'error' });
  }
  // Nothing usable passed → auto-pull whatever a prior scrape already put in the folder.
  if (!urls.length) {
    try {
      const rows = (await env.DB.prepare("SELECT url FROM media WHERE folder=?1 AND url IS NOT NULL AND url<>'' ORDER BY uploaded_at DESC LIMIT 6").bind(folder).all()).results || [];
      for (const r of rows) { urls.push(String(r.url)); pulled++; }
    } catch (_) {}
  }
  // STILL nothing (no urls passed, no prior scrape) → AUTO-SCRAPE now, so a single
  // create_map_draft call ends up with photos like the discovery routine's flow.
  if (!urls.length) {
    try {
      const got = await autoScrapeImages(env, name, folder, website, 5);
      for (const u of got) { urls.push(u); scraped++; }
    } catch (_) {}
  }
  return { urls: urls.slice(0, 6), folder, added, pulled, scraped, skipped };
}
async function ensureBrandNotesTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS brand_notes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, category TEXT, note TEXT NOT NULL, context TEXT, created_by TEXT, created_at INTEGER, active INTEGER DEFAULT 1, scope TEXT DEFAULT 'voice', tier TEXT DEFAULT 'pool')"
  ).run();
  // tiering migration for pre-existing tables (no-ops once applied)
  try { await env.DB.prepare("ALTER TABLE brand_notes ADD COLUMN scope TEXT DEFAULT 'voice'").run(); } catch (_) {}
  try { await env.DB.prepare("ALTER TABLE brand_notes ADD COLUMN tier TEXT DEFAULT 'pool'").run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE brand_notes ADD COLUMN retrievals INTEGER DEFAULT 0').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE brand_notes ADD COLUMN violations INTEGER DEFAULT 0').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE brand_notes ADD COLUMN last_retrieved_at INTEGER').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE brand_notes ADD COLUMN last_violated_at INTEGER').run(); } catch (_) {}
}

// Misfiled-note router: bug reports / data corrections / tool how-tos are real
// learnings but do NOT belong in writing prompts — scope them out of 'voice'.
function classifyNoteScope(note) {
  const n = String(note || '');
  if (/^(SEARCH BUG|AUDIT|BUG:)/i.test(n) || /HARNESS BUG/i.test(n)) return 'bug';
  if (/^DATA[:( ]/.test(n) || /^DATA GAP/i.test(n)) return 'data';
  if (/(edit_post_draft|create_carousel_draft|update_carousel_draft|create_map_draft|update_project_status|upload_photo|media browser|^Post-building setup)/i.test(n)) return 'ops';
  return 'voice';
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
  resorts: 'Resort', hotels: 'Hotel', 'boutique-hotel': 'Hotel', inn: 'Hotel',
  condominium: 'Residences', condominiums: 'Residences', condo: 'Residences', condos: 'Residences',
  apartment: 'Residences', apartments: 'Residences', residence: 'Residences', residential: 'Residences',
  multifamily: 'Residences', housing: 'Residences',
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
  airports: 'Airport',
  entertainment: 'Entertainment',
  'mixed use': 'Mixed-Use', mixeduse: 'Mixed-Use', 'mixed-use-development': 'Mixed-Use',
  estate: 'Estates', estates: 'Estates', 'single-family': 'Estates', 'single family': 'Estates',
  'single-family-home': 'Estates', 'single-family-homes': 'Estates', house: 'Estates', houses: 'Estates',
  townhouse: 'Estates', townhouses: 'Estates', townhome: 'Estates', townhomes: 'Estates',
  villa: 'Estates', villas: 'Estates',
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
// Resolve a requested media folder against what already exists, so a second
// folder is never created for a project we already have. Exact-normalized
// matches ("Martis Camp" vs "martis camp.") are REUSED silently. Near matches
// ("Martis Camp" vs "Martis Camp Tahoe") are NOT auto-merged, because
// "Waldorf Astoria" and "Waldorf Astoria Miami" are genuinely different
// projects; instead we report them so the caller can merge deliberately with
// merge_media_folders.
const _normFolder = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
async function resolveMediaFolder(env, requested) {
  const want = String(requested || '').trim();
  const out = { folder: want, reused: false, near: [] };
  if (!want || !env.DB) return out;
  let names = [];
  try {
    const a = (await env.DB.prepare('SELECT DISTINCT folder AS name FROM media WHERE folder IS NOT NULL AND folder != ""').all()).results || [];
    const b = (await env.DB.prepare('SELECT name FROM media_folders').all()).results || [];
    names = [...new Set([...a, ...b].map((r) => String(r.name || '')).filter(Boolean))];
  } catch (_) { return out; }
  const nWant = _normFolder(want);
  for (const n of names) {
    if (n === want) { out.folder = n; out.reused = true; return out; }
    if (_normFolder(n) === nWant) { out.folder = n; out.reused = true; return out; }
  }
  // Near matches: same parent, and one leaf is a whole-token prefix of the other.
  const leafOf = (x) => String(x).split(' / ').pop();
  const parentOf = (x) => String(x).split(' / ').slice(0, -1).join(' / ');
  const wLeaf = _normFolder(leafOf(want)).split(' ').filter(Boolean);
  for (const n of names) {
    if (parentOf(n) !== parentOf(want)) continue;
    const nLeaf = _normFolder(leafOf(n)).split(' ').filter(Boolean);
    if (nLeaf.length < 2 || wLeaf.length < 2) continue;
    const short = nLeaf.length <= wLeaf.length ? nLeaf : wLeaf;
    const long  = nLeaf.length <= wLeaf.length ? wLeaf : nLeaf;
    if (short.every((t, i) => long[i] === t)) out.near.push(n);
  }
  return out;
}

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
              cover_image, seo_title, seo_description, body_html, reading_time_min,
              post_type, income, contact_id, project_slug, campaign_id
       FROM posts WHERE slug = ?1 LIMIT 1`
    ).bind(String(args.slug).toLowerCase()).first();
    if (!r) throw new Error('no post with slug "' + args.slug + '"');
    const views = await viewsForSlugs(env, [r.slug]);
    let body = r.body_html || '';
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
      post_type:    r.post_type    || 'Editorial',
      income:       r.income == null ? null : Number(r.income),
      contact_id:   r.contact_id   || null,
      project_slug: r.project_slug || null,
      campaign_id:  r.campaign_id  || null,
      body_html: body, body_truncated: truncated,
    };
  },

  async list_post_drafts(args, env) {
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 100);
    const rows = (await env.DB.prepare(
      `SELECT slug, title, excerpt, project_slug, body_html, source, updated_at FROM posts WHERE status='draft' ORDER BY updated_at DESC LIMIT ${limit}`
    ).all()).results || [];
    return { count: rows.length, drafts: rows.map((r) => {
      // Which project this draft covers — the structured column, else the in-body
      // project-card embed. This is the key the daily-articles routine dedups on
      // (an existing draft on the same project means DON'T write another).
      let proj = r.project_slug || '';
      if (!proj) { const m = String(r.body_html || '').match(/data-project=["']([a-z0-9-]+)["']/); if (m) proj = m[1]; }
      return { slug: r.slug, title: r.title, excerpt: r.excerpt || '', project_slug: proj || undefined,
        tab: r.source === 'ai' ? 'AI' : 'Drafts', updated: iso(r.updated_at),
        edit_url: 'https://admin.oftmw.com/post.html?id=&slug=' + r.slug };
    }) };
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

  async create_design_draft(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureDesignsTable(env);
    const ALLOWED = new Set(['centered_top','centered_bottom','left_top','left_bottom','right_top','right_bottom','first_bl','first_tl','first_tr','photo_full']);
    const inSlides = Array.isArray(args.slides) ? args.slides : [];
    if (!inSlides.length) throw new Error('slides is required (one entry per carousel slide)');
    // Pull the folder's photos (newest first) to assign one per slide when no explicit image is given.
    let folderImages = [];
    if (args.folder) {
      const rows = await env.DB.prepare(
        `SELECT url FROM media WHERE folder = ?1 AND (mime_type LIKE 'image/%' OR mime_type IS NULL) ORDER BY uploaded_at DESC`
      ).bind(String(args.folder)).all();
      folderImages = (rows.results || []).map((r) => r.url).filter(Boolean);
    }
    // Build LIGHTWEIGHT seed slides — the Design editor materializes each from its
    // locked template on load (single source of truth for fonts/positions/logo).
    let photoIdx = 0;
    // Top-level location → the project city for the cover pin. Applied to any
    // first_* (cover) slide that doesn't carry its own location, so the agent
    // sets it ONCE instead of remembering a per-slide field.
    const coverLoc = (args.location != null) ? String(args.location).slice(0, 60) : null;
    const slides = inSlides.slice(0, 20).map((s) => {
      const template = (s && ALLOWED.has(s.template)) ? s.template : 'centered_top';
      const seed = {};
      if (s && s.text != null)     seed.headline = String(s.text).slice(0, 800);
      if (s && s.tagline != null)  seed.tagline  = String(s.tagline).slice(0, 200);
      if (s && s.location != null) seed.location = String(s.location).slice(0, 60);   // cover-slide pin text (the project city)
      else if (coverLoc && /^first_/.test(template)) seed.location = coverLoc;
      // first_* cover slides get a background photo too (they were excluded before).
      const img = (s && s.image) ? String(s.image) : (template === 'photo_full' || /^(centered|left|right|first)_/.test(template) ? folderImages[photoIdx++] : undefined);
      if (img) seed.image = img;
      return { template, _seed: seed };
    });
    const caption = String(args.caption || '').slice(0, 4000);
    const title   = String(args.title || caption || 'Carousel design').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Carousel design';
    const account = {
      handle: (args.account_handle || 'floridaoftomorrow').toString().replace(/^@/, '').slice(0, 64),
      name:   (args.account_name   || 'FLORIDAOFTOMORROW').toString().slice(0, 80),
      avatar: null,
    };
    const doc = { caption, account, slides, carousel_slug: null };
    const slug = await ensureUniqueDesignSlug(env, title, null);
    const id   = 'dsgn-' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14));
    const now  = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO designs (id, slug, title, doc_json, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?5)`
    ).bind(id, slug, title, JSON.stringify(doc).slice(0, 2_000_000), now).run();
    const withPhotos = slides.filter((s) => s._seed.image).length;
    return {
      ok: true, id, slug, status: 'draft',
      slide_count: slides.length,
      slides_with_photos: withPhotos,
      title,
      edit_url: 'https://admin.oftmw.com/design.html?slug=' + encodeURIComponent(slug),
      note: 'Saved as a Design DRAFT. Open edit_url in the Studio Design editor — the slides build onto the locked TMW templates (fonts, logo, gradient). '
        + (args.folder ? (folderImages.length ? `Pulled ${withPhotos} photo(s) from folder "${args.folder}".` : `Folder "${args.folder}" had no images — add photos in the editor.`) : 'No folder given — add photos per slide in the editor.')
        + ' From there: tweak text/photos, then Download PNGs or Send to Carousels.',
    };
  },

  // List existing design drafts so you can OPEN + edit one instead of making a new
  // one. Returns slug + slide_count + edit URL for each, newest first.
  async list_design_drafts(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureDesignsTable(env);
    const status = (args && args.status) ? String(args.status) : 'draft';
    const limit = Math.min(Math.max(parseInt(args && args.limit, 10) || 25, 1), 100);
    const rows = await env.DB.prepare(
      'SELECT slug, title, doc_json, status, updated_at FROM designs WHERE status = ?1 ORDER BY updated_at DESC LIMIT ?2'
    ).bind(status, limit).all();
    const designs = (rows.results || []).map((r) => {
      let d = {}; try { d = JSON.parse(r.doc_json || '{}'); } catch (_) {}
      return {
        slug: r.slug, title: r.title, status: r.status,
        slide_count: Array.isArray(d.slides) ? d.slides.length : 0,
        updated_at: r.updated_at,
        edit_url: 'https://admin.oftmw.com/design.html?slug=' + encodeURIComponent(r.slug),
      };
    });
    return { ok: true, count: designs.length, designs };
  },

  // Read one design's current content (per-slide template/text/tagline/image)
  // BEFORE editing it, so you know exactly what's there.
  async get_design(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureDesignsTable(env);
    const slug = String((args && args.slug) || '').trim();
    if (!slug) throw new Error('slug is required (from list_design_drafts or a create_design_draft result)');
    const row = await env.DB.prepare('SELECT slug, title, doc_json, status, updated_at FROM designs WHERE slug = ?1').bind(slug).first();
    if (!row) throw new Error('No design with slug "' + slug + '". Use list_design_drafts to find it.');
    let doc = {}; try { doc = JSON.parse(row.doc_json || '{}'); } catch (_) {}
    const slides = (Array.isArray(doc.slides) ? doc.slides : []).map((s, i) => ({
      index: i,
      template: s && s.template,
      text:    (s && s._seed && s._seed.headline) || '',
      tagline: (s && s._seed && s._seed.tagline) || '',
      image:   (s && s._seed && s._seed.image) || '',
    }));
    return {
      ok: true, slug: row.slug, title: row.title, status: row.status,
      caption: doc.caption || '', account: doc.account || null,
      slide_count: slides.length, slides,
      edit_url: 'https://admin.oftmw.com/design.html?slug=' + encodeURIComponent(row.slug),
    };
  },

  // OPEN an existing design draft and EDIT it in place — no new design created.
  // Patches caption / title / account when given; replaces the slides when a
  // `slides` array is passed (same shape as create_design_draft), keeping them
  // otherwise. Drafts only.
  async update_design_draft(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureDesignsTable(env);
    const slug = String((args && args.slug) || '').trim();
    if (!slug) throw new Error('slug is required (the design to edit — from list_design_drafts or a create result)');
    const row = await env.DB.prepare('SELECT id, slug, title, doc_json, status FROM designs WHERE slug = ?1').bind(slug).first();
    if (!row) throw new Error('No design draft with slug "' + slug + '". Use list_design_drafts to find it.');
    if (row.status && row.status !== 'draft') throw new Error('Design "' + slug + '" is ' + row.status + ' — only drafts can be edited.');
    let doc = {}; try { doc = JSON.parse(row.doc_json || '{}'); } catch (_) {}
    if (!doc || typeof doc !== 'object') doc = {};
    doc.account = doc.account || { handle: 'floridaoftomorrow', name: 'FLORIDAOFTOMORROW', avatar: null };
    if (args.caption != null)        doc.caption = String(args.caption).slice(0, 4000);
    if (args.account_handle != null) doc.account.handle = String(args.account_handle).replace(/^@/, '').slice(0, 64);
    if (args.account_name != null)   doc.account.name = String(args.account_name).slice(0, 80);
    let title = row.title;
    if (args.title != null && String(args.title).trim()) title = String(args.title).replace(/\s+/g, ' ').trim().slice(0, 120);
    // Replace the slides only when provided (same lightweight-seed shape as create).
    if (Array.isArray(args.slides)) {
      if (!args.slides.length) throw new Error('slides, when provided, must have at least one entry (omit slides to keep the current ones).');
      const ALLOWED = new Set(['centered_top','centered_bottom','left_top','left_bottom','right_top','right_bottom','first_bl','first_tl','first_tr','photo_full']);
      let folderImages = [];
      if (args.folder) {
        const fr = await env.DB.prepare(
          `SELECT url FROM media WHERE folder = ?1 AND (mime_type LIKE 'image/%' OR mime_type IS NULL) ORDER BY uploaded_at DESC`
        ).bind(String(args.folder)).all();
        folderImages = (fr.results || []).map((r) => r.url).filter(Boolean);
      }
      let photoIdx = 0;
      const coverLoc = (args.location != null) ? String(args.location).slice(0, 60) : null;
      doc.slides = args.slides.slice(0, 20).map((s) => {
        const template = (s && ALLOWED.has(s.template)) ? s.template : 'centered_top';
        const seed = {};
        if (s && s.text != null)     seed.headline = String(s.text).slice(0, 800);
        if (s && s.tagline != null)  seed.tagline  = String(s.tagline).slice(0, 200);
        if (s && s.location != null) seed.location = String(s.location).slice(0, 60);   // cover-slide pin text (the project city)
        else if (coverLoc && /^first_/.test(template)) seed.location = coverLoc;
        const img = (s && s.image) ? String(s.image) : (template === 'photo_full' || /^(centered|left|right|first)_/.test(template) ? folderImages[photoIdx++] : undefined);
        if (img) seed.image = img;
        return { template, _seed: seed };
      });
    }
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('UPDATE designs SET title = ?2, doc_json = ?3, updated_at = ?4 WHERE slug = ?1')
      .bind(slug, title, JSON.stringify(doc).slice(0, 2_000_000), now).run();
    return {
      ok: true, slug, status: 'draft', title,
      slide_count: Array.isArray(doc.slides) ? doc.slides.length : 0,
      edit_url: 'https://admin.oftmw.com/design.html?slug=' + encodeURIComponent(slug),
      note: 'Updated the EXISTING design draft in place — no new design created. Open edit_url to review in the Studio Design editor.',
    };
  },

  async write_article_and_post(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    if (!args.title || !String(args.title).trim()) throw new Error('title is required');
    if (!Array.isArray(args.slides) || !args.slides.length) throw new Error('slides is required (the carousel post copy)');
    // Shared folder photos (newest-first) → article body + design slides.
    let images = [];
    if (args.folder) {
      const rows = await env.DB.prepare(
        `SELECT url FROM media WHERE folder = ?1 AND (mime_type LIKE 'image/%' OR mime_type IS NULL) ORDER BY uploaded_at DESC`
      ).bind(String(args.folder)).all();
      images = (rows.results || []).map((r) => r.url).filter(Boolean).slice(0, MAX_ARTICLE_IMAGES);
    }
    // 1) ARTICLE — cover = first photo (unless given); the rest sprinkle through the body.
    const cover    = args.cover_image || images[0] || undefined;
    const bodyImgs = args.cover_image ? images : images.slice(1);
    const body     = sprinkleImagesIntoMarkdown(args.body_markdown || '', bodyImgs);
    const article  = await IMPL.create_post_draft({
      title: args.title, body_markdown: body, excerpt: args.excerpt, category: args.category,
      cover_image: cover, linked_project: args.linked_project, post_type: args.post_type,
      project_slug: args.project_slug, campaign_id: args.campaign_id,
    }, env);
    // 2) POST design — slides + the same folder.
    const design = await IMPL.create_design_draft({
      title: args.title, caption: args.caption, folder: args.folder, slides: args.slides,
      location: args.location,
      account_handle: args.account_handle, account_name: args.account_name,
    }, env);
    return {
      ok: true,
      article: { slug: article.slug, edit_url: article.edit_url },
      design:  { slug: design.slug, slide_count: design.slide_count, edit_url: design.edit_url },
      photos_used: images.length,
      note: `✅ Both drafts created.\n• ARTICLE draft → ${article.edit_url}\n• POST design (${design.slide_count} slides) → ${design.edit_url}\n`
        + (images.length ? `Used ${images.length} photo(s) from folder "${args.folder}" across both.` : (args.folder ? `Folder "${args.folder}" had no photos yet — add them and they'll appear in the editors.` : 'No folder given — add photos in each editor.'))
        + ' Both are drafts; review/finish in the Studio. Tell the user both are ready.',
    };
  },

  // THE VOICE GATE — every AI article must pass two objective tests before it
  // reaches the human editor: (1) voiceScore, the deterministic grade against
  // the measured voice fingerprint; (2) turingJudge, an adversarial "spot the
  // AI among real TMW articles" discriminator. Failures feed ONE targeted
  // revision (the caller's `rewrite`), then re-test. The report ships in the
  // tool result so the caller sees exactly what was caught and fixed.
  async _runVoiceGate(env, { text, topic = '', place = '', excludeSlugs = [], slug = '', rewrite }) {
    const gate = { scored: false };
    // Judge on PLAIN prose — markdown syntax (links, #headers) would be a
    // giveaway against the plain-text real articles and teach nothing.
    const plain = (s) => String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '');
    try {
      const fp = await getFingerprint(env);
      let vio = fp ? voiceScore(plain(text), fp) : [];
      let jury = [];
      try {
        const pool = await articleExemplars(env, { topic, place, limit: 6, perChars: 2600 });
        jury = pool.filter(a => !excludeSlugs.includes(a.slug)).slice(0, 2);
      } catch (_) {}
      const jud = await turingJudge(env, { draft: plain(text), real: jury });
      gate.scored = true;
      gate.initial = { spec_violations: vio, turing: jud.judged ? (jud.caught ? 'caught (' + jud.confidence + ')' : 'passed') : 'skipped', tells: jud.tells || [] };
      let out = text;
      if ((vio.length || (jud.judged && jud.caught)) && typeof rewrite === 'function') {
        const problems = vio.map(v => 'SPEC: ' + v).concat((jud.tells || []).map(t => 'TELL (a forensic judge spotted this as AI-written): ' + t));
        const revised = await rewrite(problems, fp ? fingerprintSpecText(fp) : '');
        if (revised && revised.trim()) {
          out = revised; gate.revised = true;
          const vio2 = fp ? voiceScore(plain(out), fp) : [];
          const jud2 = await turingJudge(env, { draft: plain(out), real: jury });
          gate.final = { spec_violations: vio2, turing: jud2.judged ? (jud2.caught ? 'caught (' + jud2.confidence + ')' : 'passed') : 'skipped', tells: jud2.tells || [] };
        }
      }
      const f = gate.final || gate.initial;
      gate.passed = !f.spec_violations.length && f.turing !== 'caught (high)' && !String(f.turing).startsWith('caught');
      gate.score = genVoiceScore(gate.initial.turing, gate.initial.spec_violations.length);
      // Persist the verdict against the slug — powers the Turing pass-rate
      // series (brain page) and the per-article scorecard (post editor).
      try {
        await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?,?,?,?)`)
          .bind(Math.floor(Date.now() / 1000), String(slug || 'voice-gate'), 'voice_gate', JSON.stringify({
            kind: 'revise', actor: _mcpActor, slug: String(slug || ''), topic: String(topic || '').slice(0, 140),
            score: gate.score,
            first_turing: gate.initial.turing, first_violations: gate.initial.spec_violations.length,
            notes: {
              tells: (gate.initial.tells || []).slice(0, 5).map((t) => String(t).slice(0, 220)),
              spec: (gate.initial.spec_violations || []).slice(0, 6).map((v) => String(v).slice(0, 160)),
            },
            final_turing: f.turing, final_violations: f.spec_violations.length,
            revised: !!gate.revised, passed: gate.passed,
          })).run();
      } catch (_) {}
      return { text: out, gate };
    } catch (_) { return { text, gate }; }
  },

  // Write a full article draft with Fable 5, grounded in the SHARED TMW brain.
  async generate_article_draft(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const topic = String(args.topic || '').trim();
    if (!topic) throw new Error('topic is required');
    // Editorial rejection memory: if the editor deleted a draft on this story
    // in the last ~4 months, refuse — pick a DIFFERENT story instead.
    // Match on the TOPIC only, never the angle: the angle is editorial prose
    // ("America's best destination golf course") and its generic words are what
    // produced false rejections. The topic carries the project name, which is
    // the signal that actually identifies a story.
    const rej = await topicRejected(env, topic);
    if (rej) throw new Error('TOPIC REJECTED BY EDITOR: a draft on this story ("' + rej.title + '") was deleted on ' + new Date(rej.rejected_at * 1000).toISOString().slice(0, 10) + ' — it is suppressed until ' + new Date(rej.until * 1000).toISOString().slice(0, 10) + '. Do NOT redraft it or a close variant; choose a different story.');
    // ── DUPLICATE-DRAFT GUARD (the #1 failure mode). If a draft on the SAME
    // tracked project already sits in EITHER tab (AI or human Drafts), refuse —
    // a second draft on a project we've already drafted is a duplicate, no matter
    // the angle. This is airtight (exact project match, no false positives); the
    // nuanced "published recently unless it's genuinely major fresh news" call
    // stays with the routine. A same-project draft found here means: refine that
    // draft instead, or pick a different project.
    const guardSlug = String(args.linked_project || args.project_slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (guardSlug) {
      try {
        const drs = (await env.DB.prepare(
          "SELECT slug, title, project_slug, body_html, source FROM posts WHERE status='draft' ORDER BY updated_at DESC LIMIT 200"
        ).all()).results || [];
        const embed = new RegExp('data-project=["\']' + guardSlug + '["\']');
        const dup = drs.find((r) => String(r.project_slug || '').toLowerCase() === guardSlug || embed.test(String(r.body_html || '')));
        if (dup) throw new Error('DUPLICATE DRAFT EXISTS: "' + dup.title + '" (' + (dup.source === 'ai' ? 'AI' : 'Drafts') + ' tab) already covers this project (' + guardSlug + '). Do NOT write a second draft — refine that one with revise_article_draft, or choose a different project.');
      } catch (e) {
        if (String(e.message || '').startsWith('DUPLICATE DRAFT')) throw e;
        // A DB read hiccup must never block a legitimate first draft.
      }
    }
    // ── GENRE ROUTING: decide WHAT KIND of story this is before anything else.
    // The fingerprint carries a skeleton per genre; knowing the genre lets us
    // inject that ONE skeleton, pull same-genre exemplars, and judge candidates
    // against the right shape instead of a generic "good prose" bar.
    const st = await classifyStoryType(env, {
      topic, angle: String(args.angle || ''), facts: String(args.facts || ''),
    }).catch(() => ({ type: '', skeleton: '' }));
    const brain = await assembleBrain(env, { topic, place: String(args.place || ''), surface: 'article', storyType: st.type || '' });
    // ── THE DATABASE DOSSIER: our own tracked data is AUTHORITATIVE and free —
    // the subject project's full record, the local pipeline, and the developer's
    // track record. Feeds the writer (dense proprietary specifics, sprinkled
    // naturally — exactly what real TMW articles have and generic AI copy lacks)
    // AND the fact-checker (claims matching the dossier verify without a web
    // search). Built from projects-flat, cached per request.
    let dbDossier = '';
    try {
      const all = await loadProjects();
      const lp = args.linked_project ? all.find((x) => String(x.Slug || '') === String(args.linked_project)) : null;
      const card = (p) => [
        p.Title, p.City, p.ProjectType || p.PreferredType || '',
        p.Floors ? p.Floors + ' floors' : '', p.Units ? p.Units + ' units' : '',
        (p.GFA || p.gfa_sqft) ? Number(p.GFA || p.gfa_sqft).toLocaleString('en-US') + ' sq ft GFA' : '',
        p.Developer ? 'Developer: ' + p.Developer : '', p.Architect ? 'Architect: ' + p.Architect : '',
        'Status: ' + (p.Delivery || p.DeliveryDate || 'unknown'),
        String(p.Description || '').replace(/\s+/g, ' ').slice(0, 200),
      ].filter(Boolean).join(' · ');
      const parts = [];
      if (lp) parts.push('THE SUBJECT PROJECT (our authoritative record — these specifics override anything else):\n' + card(lp));
      const city = String((lp && lp.City) || args.place || '').toLowerCase();
      if (city) {
        const near = all.filter((x) => x !== lp && String(x.City || '').toLowerCase() === city).slice(0, 8);
        if (near.length) parts.push('THE LOCAL PIPELINE (tracked projects in the same market — sprinkle these specifics naturally where they add context, never force them):\n' + near.map(card).join('\n'));
      }
      const dev = lp && String(lp.Developer || '').split(/[,;]/)[0].trim();
      if (dev && dev.length > 3) {
        const track = all.filter((x) => x !== lp && String(x.Developer || '').toLowerCase().includes(dev.toLowerCase())).slice(0, 5);
        if (track.length) parts.push('THE DEVELOPER\'S TRACK RECORD (other ' + dev + ' projects we track):\n' + track.map(card).join('\n'));
      }
      dbDossier = parts.join('\n\n');
    } catch (_) {}
    const sys = [
      'You are the senior staff writer for Markets of Tomorrow (TMW), a real-estate development media brand. Write ONE on-brand journal article.',
      brain.text || '',
      dbDossier ? 'TMW DATABASE DOSSIER (proprietary, authoritative for every project listed):\n' + dbDossier : '',
      'OUTPUT: return ONLY a JSON object (no prose, no markdown fences): {"title":"<headline>","excerpt":"<SEO dek, see below>","body_markdown":"<the full article in Markdown>","claims":[<see below>]}.',
      'THE EXCERPT IS THE SEO META DESCRIPTION — it is what Google shows under the headline and the single thing that decides whether a stranger clicks through, so it is never an afterthought and never optional. Write 1 to 2 COMPLETE sentences, 150 to 200 characters, ending in a period; never a fragment, never cut off mid-thought. Front-load what people actually search: the project or brand name, the city or neighborhood, and what it IS (condominium, hotel, golf club), then the strongest specific (unit count, architect, opening year). Active voice, no clickbait, and do not restate the headline word for word.',
      'CLAIMS LEDGER (required): list EVERY factual assertion the article makes — statuses, dates, numbers, prices, names, attributions — as {"claim":"<the assertion, one line>","type":"status"|"date"|"number"|"name"|"other","source":"facts"|"database"|"model"}. "facts" = stated in the provided facts; "database" = from the related-projects context above; "model" = from your own knowledge. BE HONEST about "model" — those get fact-checked against the live web, and a false "facts" tag is worse than an honest "model" tag.',
      'RULES: Write in TMW\'s voice per the brand brain above — hooky, confident, concrete, forward-looking. Do NOT invent facts, numbers, dates, prices, unit counts, or firm names beyond the facts provided and what is genuinely, verifiably known. NEVER fabricate a quotation or attribute words to any person, team, or company: include quoted speech ONLY if it appears verbatim in the provided facts. Avoid em dashes (use commas or periods). Strong hook, scannable structure, no corporate/press-release tone. Do not embed images (they are inserted separately). LINKS: only add external links for source attribution (publications, official announcements); NEVER link a project, firm, or city name to an external site — mentions of tracked projects, firms, and markets are auto-linked to their oftmw.com pages after generation. HOW IT ENDS: land on a real closing PARAGRAPH, forward-looking, in your own prose. NEVER end with a call to action, a newsletter or subscribe pitch, a follow-us line, or any sign-off boilerplate (our older archive is full of "Sign up for ... free newsletter below" endings; that branding is retired and they must never be reproduced). NEVER end on an image either: photos belong between paragraphs, and the last thing a reader sees is your conclusion.',
      // BINDING + LAST. The learned house rules used to sit mid-prompt, where the
      // generic "strong hook" advice below them and the per-take hints above them
      // quietly outvoted the editor's actual instructions. Recency matters: they
      // go last, restated as non-negotiable, with an explicit self-check.
      brain.voice ? 'THE HOUSE RULES BELOW ARE BINDING. They were written by the editor after real edits to real pieces, and they OUTRANK every other instruction in this prompt, including the generic advice above and any per-take hint. If a hint or a habit conflicts with one of these, the house rule wins. Before you output, re-read them and check your opening line, your structure, and your ending against them one by one:\n' + brain.voice : '',
    ].filter(Boolean).join('\n\n');
    const usr = [
      'TOPIC: ' + topic,
      // The genre and its measured skeleton lead the brief: shape first, then
      // the specifics. Without this the writer had to infer the form from eight
      // options in the spec, which is how announcements came back shaped like
      // first-looks and vice versa.
      st.type ? ('STORY TYPE: ' + st.type + (st.skeleton ? '\nSTRUCTURE THIS PIECE AS: ' + st.skeleton : '')) : '',
      args.angle ? 'ANGLE: ' + String(args.angle) : '',
      args.facts ? 'VERIFIED FACTS / SOURCE NOTES (ground the piece in these; do not contradict or exceed them):\n' + String(args.facts) : '',
    ].filter(Boolean).join('\n\n');
    // ── BEST-OF-3 (rejection sampling, the pre-RLHF move): three drafts in
    // PARALLEL (same wall clock as one), then an editor-judge picks whichever
    // reads most like our published work. Selection substitutes for training:
    // sampling variance becomes the search space instead of a coin flip. Light
    // per-take hints decorrelate the drafts without touching fact discipline.
    // Take hints decorrelate the drafts, but they must NEVER dictate the opening:
    // the old hints ("open on the most concrete fact", "open on the actor") told
    // two of every three candidates to violate the banked house opening rule, so
    // the judge was picking from a search space that was mostly off-voice. That
    // was the generator quietly diluting the editor's rules. They now vary the
    // THROUGH-LINE only, and each defers explicitly to the house rules.
    const HINT_TAIL = ' Follow the binding house rules exactly, especially how a piece opens and how it lands; this hint only shapes the through-line and never overrides them.';
    const TAKE_HINTS = [
      '',
      '\n\nFOR THIS TAKE: build the piece around what this changes for the market around it.' + HINT_TAIL,
      '\n\nFOR THIS TAKE: build the piece around the ambition of the thing itself, what it will actually be like.' + HINT_TAIL,
    ];
    const parseGen = (raw) => {
      if (!raw) return null;
      let g = null;
      const m = raw.match(/\{[\s\S]*\}/); if (m) { try { g = JSON.parse(m[0]); } catch (_) {} }
      if (!g) g = repairTruncatedJson(raw);   // salvage a max_tokens-truncated article
      return (g && g.body_markdown) ? g : null;
    };
    // 9000, up from 4200: a rich evergreen feature (a golf-and-ski community with
    // amenities, real estate AND a full claims ledger for every fact) overran the
    // old budget, so all three takes came back as truncated JSON and the run died
    // with a generic "no usable article". You only pay for tokens produced.
    const GEN_TOKENS = 9000;
    const rawDraws = await Promise.all(TAKE_HINTS.map((h) =>
      fableGenerate(env, { system: sys, user: usr + h, maxTokens: GEN_TOKENS }).catch(() => '')
    ));
    let draws = rawDraws.map(parseGen).filter(Boolean);
    const spoke = rawDraws.filter((r) => r && r.trim()).length;   // did the API answer at all?
    // The simultaneous burst can rate-limit siblings (observed: 1 of 3 landing).
    // One sequential top-up after the burst clears keeps the pick meaningful.
    if (draws.length === 1) {
      const extra = parseGen(await fableGenerate(env, { system: sys, user: usr + TAKE_HINTS[1], maxTokens: GEN_TOKENS }).catch(() => ''));
      if (extra) draws.push(extra);
    }
    // Nothing landed. Before giving up, try ONCE sequentially: the usual cause is
    // transient overload on the parallel burst, which a lone retry clears.
    if (!draws.length) {
      const solo = parseGen(await fableGenerate(env, { system: sys, user: usr, maxTokens: GEN_TOKENS }).catch(() => ''));
      if (solo) draws = [solo];
    }
    if (!draws.length) {
      // Say WHICH failure this was, so the human is not guessing.
      const why = spoke
        ? spoke + ' model repl' + (spoke === 1 ? 'y' : 'ies') + ' came back but none parsed as a usable article (the JSON was truncated or malformed)'
        : ('the author model never answered: ' + (fableLastError() || 'unknown reason'));
      throw new Error('generation failed — ' + why + '. Try again; if it repeats, write the body manually with create_post_draft.');
    }
    let gen = draws[0];
    let bestOf = { candidates: draws.length, picked: 0 };
    if (draws.length > 1) {
      try {
        const fp0 = await getFingerprint(env);
        const gold = (brain.articleExemplars && brain.articleExemplars[0]) || null;
        // The judge USED to score only "reads like our published work" from the
        // fingerprint + one gold piece, never seeing the editor's banked rules —
        // so a candidate that broke an explicit house rule could still win. Rule
        // adherence is now the first, decisive test.
        const pickSys = 'You are the executive editor of Markets of Tomorrow. Pick which candidate article reads MOST like our published work: judge prose (rhythm, ledes, how it lands, concreteness), not topic. Facts are identical across candidates; ignore factual differences. Output ONLY JSON: {"pick":<0-based index>,"why":"<one short sentence>"}.'
          + (st.type ? '\n\nTHIS ASSIGNMENT IS A "' + st.type + '" STORY. The winner must follow that shape: ' + (st.skeleton || '') : '')
          + (brain.voice ? '\n\nHOUSE RULES (DECISIVE — check these FIRST). Any candidate that breaks one of these, especially in how it opens or how it ends, LOSES to one that follows them, even if its prose is otherwise nicer:\n' + brain.voice : '')
          + (fp0 ? '\n\nMEASURED HOUSE SPEC:\n' + fingerprintSpecText(fp0) : '')
          + (gold ? '\n\nREAL PUBLISHED REFERENCE:\n' + gold.body.slice(0, 1800) : '');
        const pickUsr = draws.map((g, i) => `CANDIDATE ${i}: ${g.title}\n${String(g.body_markdown).slice(0, 2400)}`).join('\n\n════════\n\n');
        const v = parseLLMJson(await fableGenerate(env, { system: pickSys, user: pickUsr, maxTokens: 250 }));
        if (v && typeof v.pick === 'number' && draws[v.pick]) { gen = draws[v.pick]; bestOf = { candidates: draws.length, picked: v.pick, why: String(v.why || '').slice(0, 200) }; }
      } catch (_) { /* keep draws[0] */ }
    }
    // ── UNIFIED QA PASS: canon lint (deterministic) + fingerprint score
    // (deterministic) + brain critique ∥ adversarial Turing judge (parallel) →
    // ONE combined fix → one re-test. Parallelizing the two model calls and
    // merging what used to be two separate rewrite cycles keeps the whole
    // pipeline inside connector timeouts. Runs BEFORE auto-linking (judges
    // plain prose; links would be a giveaway).
    let styleReport = { lint_fixed: 0, critique_fixed: 0, remaining: [] };
    let voiceGate = null;
    try {
      const plain = (s) => String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '');
      const fp = await getFingerprint(env);
      const usedSlugs = (brain.articleExemplars || []).map((a) => a.slug);
      let jury = [];
      try { jury = (await articleExemplars(env, { topic, place: String(args.place || ''), limit: 6, perChars: 2600 })).filter((a) => !usedSlugs.includes(a.slug)).slice(0, 2); } catch (_) {}
      const lint1 = lintCanon({ title: gen.title || '', body: gen.body_markdown, excerpt: gen.excerpt || '', kind: 'article' });
      const vio1 = fp ? voiceScore(plain(gen.body_markdown), fp) : [];
      const [crit1, jud1] = await Promise.all([
        critiqueDraft(env, { title: gen.title || '', excerpt: gen.excerpt || '', body: gen.body_markdown, brainText: brain.text || '' }).catch(() => []),
        turingJudge(env, { draft: plain(gen.body_markdown), real: jury }).catch(() => ({ judged: false })),
      ]);
      voiceGate = { initial: { spec_violations: vio1, turing: jud1.judged ? (jud1.caught ? 'caught (' + jud1.confidence + ')' : 'passed') : 'skipped', tells: jud1.tells || [] } };
      const problems = lint1.map((w) => w.issue)
        .concat(crit1.map((v) => (v.rule ? v.rule + ': ' : '') + v.violation))
        .concat(vio1.map((v) => 'SPEC: ' + v))
        .concat((jud1.tells || []).map((t) => 'TELL (a forensic judge spotted this as AI-written): ' + t));
      if (problems.length) {
        const fixSys = 'You are the senior staff editor for Markets of Tomorrow. Our QA flagged the draft below (style violations, measured-spec misses, and/or a forensic judge identified it as AI-written). Rewrite so a reader could not tell it from our published work — fix EVERY listed problem, change nothing else. Preserve every fact, number, name, date, and price exactly. Avoid em dashes. Return ONLY JSON: {"title":"...","excerpt":"...","body_markdown":"..."}.'
          + (fp ? '\n\nMEASURED HOUSE SPEC:\n' + fingerprintSpecText(fp) : '');
        const fixUsr = 'PROBLEMS TO FIX:\n- ' + problems.join('\n- ') + '\n\nARTICLE JSON:\n' + JSON.stringify({ title: gen.title, excerpt: gen.excerpt, body_markdown: gen.body_markdown });
        const fixedRaw = await fableGenerate(env, { system: fixSys, user: fixUsr, maxTokens: GEN_TOKENS });
        let fixed = null;
        const fm = fixedRaw && fixedRaw.match(/\{[\s\S]*\}/);
        if (fm) { try { fixed = JSON.parse(fm[0]); } catch (_) {} }
        if (!fixed && fixedRaw) fixed = repairTruncatedJson(fixedRaw);
        if (fixed && fixed.body_markdown) {
          fixed.claims = fixed.claims || gen.claims;   // fix passes must not drop the claims ledger
          gen = fixed; voiceGate.revised = true;
          styleReport.lint_fixed = lint1.length; styleReport.critique_fixed = crit1.length;
          // Re-test the revision: deterministic re-score + one re-judge.
          let vio2 = fp ? voiceScore(plain(gen.body_markdown), fp) : [];
          let jud2 = await turingJudge(env, { draft: plain(gen.body_markdown), real: jury }).catch(() => ({ judged: false }));
          // ── SECOND PASS. The re-test used to be terminal: whatever it found,
          // the draft shipped. Now a draft that STILL fails gets one more
          // targeted fix against only what remains, then a final re-score. Two
          // passes is the cap (a third rarely moves the needle and always costs).
          const still2 = vio2.map((v) => 'SPEC: ' + v)
            .concat(((jud2.tells || [])).map((t) => 'TELL: ' + t))
            .concat(lintCanon({ title: gen.title || '', body: gen.body_markdown, excerpt: gen.excerpt || '', kind: 'article' }).map((w) => w.issue));
          if (still2.length) {
            const fixUsr3 = 'STILL BROKEN AFTER ONE REVISION, fix exactly these and nothing else:\n- ' + still2.join('\n- ')
              + '\n\nARTICLE JSON:\n' + JSON.stringify({ title: gen.title, excerpt: gen.excerpt, body_markdown: gen.body_markdown });
            const raw3 = await fableGenerate(env, { system: fixSys, user: fixUsr3, maxTokens: GEN_TOKENS }).catch(() => '');
            let fixed3 = null;
            const m3 = raw3 && raw3.match(/\{[\s\S]*\}/);
            if (m3) { try { fixed3 = JSON.parse(m3[0]); } catch (_) {} }
            if (!fixed3 && raw3) fixed3 = repairTruncatedJson(raw3);
            if (fixed3 && fixed3.body_markdown) {
              fixed3.claims = fixed3.claims || gen.claims;
              gen = fixed3; voiceGate.revised_twice = true;
              vio2 = fp ? voiceScore(plain(gen.body_markdown), fp) : [];
              jud2 = await turingJudge(env, { draft: plain(gen.body_markdown), real: jury }).catch(() => ({ judged: false }));
            }
          }
          voiceGate.final = { spec_violations: vio2, turing: jud2.judged ? (jud2.caught ? 'caught (' + jud2.confidence + ')' : 'passed') : 'skipped', tells: jud2.tells || [] };
        }
        styleReport.remaining = lintCanon({ title: gen.title || '', body: gen.body_markdown, excerpt: gen.excerpt || '', kind: 'article' }).map((w) => w.issue);
      }
      const fRep = voiceGate.final || voiceGate.initial;
      voiceGate.passed = !fRep.spec_violations.length && !String(fRep.turing).startsWith('caught');
      voiceGate.score = genVoiceScore(voiceGate.initial.turing, voiceGate.initial.spec_violations.length);
      voiceGate.critique_notes = crit1.map((v) => (v.rule ? v.rule + ': ' : '') + v.violation).slice(0, 5);
    } catch (_) {}
    // ── THE FACT GATE: every claim the writer tagged as its own knowledge,
    // plus all status/date claims, gets verified — source notes first, live
    // web search for the rest. Contradicted claims trigger ONE correction pass
    // (e.g. "debuts in Portugal" → "opens in October", with the source). The
    // full ledger persists per-slug and renders on the post editor's scorecard,
    // so the human fact-check collapses to scanning the unverified rows.
    let factReport = null;
    try {
      const allClaims = (Array.isArray(gen.claims) ? gen.claims : [])
        .filter((c) => c && c.claim).slice(0, 18)
        .map((c) => ({ claim: String(c.claim).slice(0, 220), type: ['status', 'date', 'number', 'name', 'other'].includes(c.type) ? c.type : 'other', source: ['facts', 'database', 'model'].includes(c.source) ? c.source : 'model' }));
      // Deterministic opening-status guard: our own database knows whether the
      // linked project is open. A pre-opening project asserted as open is a
      // mechanical violation — no AI judgment involved.
      let projStatus = '', projTitle = '';
      if (args.linked_project) {
        try { const p = (await loadProjects()).find((x) => String(x.Slug || '') === String(args.linked_project)); if (p) { projStatus = String(p.Delivery || p.DeliveryDate || ''); projTitle = String(p.Title || ''); } } catch (_) {}
      }
      // Positive list of pre-opening lifecycle statuses — a bare /open/ test
      // would false-clear "Opening Soon" and "Coming Soon".
      const preOpen = /announced|under construction|coming soon|opening soon|planned|proposed|development|pre-?construction/i.test(projStatus);
      const OPEN_ASSERT = /\b(now open|has opened|have opened|opened its doors|is open|officially opened|welcom(es|ing) (its first )?guests)\b/i;
      // Named-subject phrasing: the body may LEGITIMATELY call another project
      // open (e.g. the brand's earlier building) — the verifier must judge
      // whether the open-assertion is about THE SUBJECT, not just anywhere.
      const statusViolation = (preOpen && OPEN_ASSERT.test(gen.body_markdown))
        ? 'Our database has "' + (projTitle || 'the subject project') + '" as "' + projStatus + '" (NOT open). The draft asserts something is open — if that assertion is about ' + (projTitle || 'the subject project') + ' itself, this is contradicted (correct the tense to future); if it is about a DIFFERENT project that really is open, this is verified.' : null;
      // Database-tagged claims are risky too now that the dossier makes them
      // FREE to check (the verifier resolves them against the notes, no web
      // spend) — a claim mistagged "database" no longer sails through green.
      const risky = allClaims.filter((c) => c.source === 'model' || c.source === 'database' || c.type === 'status' || c.type === 'date');
      let verdicts = [];
      if (risky.length || statusViolation) {
        const notes = String(args.facts || '') + (dbDossier ? '\n\nTMW DATABASE (authoritative for every tracked project below — claims matching it are verified, source "TMW database", no web search needed):\n' + dbDossier : '');
        verdicts = await factVerify(env, { claims: risky, facts: notes, extra: statusViolation || '' });
      }
      const bad = verdicts.filter((v) => v.verdict === 'contradicted');
      const unsup = verdicts.filter((v) => v.verdict === 'unsupported');
      // ONE combined pass: correct what's provably wrong, and CUT what could not
      // be verified even after searching — an unprovable assertion doesn't ship.
      // (This is the 99%-green policy: yellow survives only when the verifier
      // itself failed, never as a routine "check by hand" state.)
      let removedSet = new Set();
      if (bad.length || unsup.length) {
        const fixSys2 = 'You are the senior staff editor for Markets of Tomorrow. The fact-checker reviewed the draft below. (1) Correct EXACTLY the listed ERRORS using the verified facts given (fix tense too: not-yet-open properties are "will open"/"is slated to open", never "debuts"/"is open"). (2) REMOVE each listed UNVERIFIABLE assertion — delete or rewrite the sentence so the unprovable part is gone; keep the prose flowing naturally around the cut. Change nothing else. Return ONLY JSON: {"title":"...","excerpt":"...","body_markdown":"..."}.';
        const fixUsr2 = (bad.length ? 'ERRORS (with the verified correction):\n- ' + bad.map((v) => `"${v.claim}" is WRONG → ${v.note}${v.source ? ' (source: ' + v.source + ')' : ''}`).join('\n- ') + '\n\n' : '')
          + (unsup.length ? 'UNVERIFIABLE (searched, could not confirm — remove from the draft):\n- ' + unsup.map((v) => `"${v.claim}"${v.note ? ' (' + v.note + ')' : ''}`).join('\n- ') + '\n\n' : '')
          + 'DRAFT JSON:\n' + JSON.stringify({ title: gen.title, excerpt: gen.excerpt, body_markdown: gen.body_markdown });
        const fRaw = await fableGenerate(env, { system: fixSys2, user: fixUsr2, maxTokens: GEN_TOKENS });
        const g3 = parseGen(fRaw);
        if (g3) { g3.claims = gen.claims; gen = g3; removedSet = new Set(unsup.map((v) => v.claim)); }
      }
      const grounded = allClaims.filter((c) => c.source === 'facts' || c.source === 'database').length;
      const nVerified = verdicts.filter((v) => v.verdict === 'verified').length;
      factReport = {
        claims: allClaims.length, checked: verdicts.length,
        verified: nVerified,
        unsupported: unsup.length - removedSet.size,
        removed: removedSet.size,
        corrected: bad.length,
        // Coverage = share of claims that are grounded, web-verified, corrected,
        // or excised. 100% = nothing in the draft rests on an unchecked guess.
        coverage_pct: allClaims.length ? Math.round(100 * Math.min(allClaims.length, grounded + nVerified + bad.length + removedSet.size) / allClaims.length) : null,
        status_guard: statusViolation ? 'tripped' : (preOpen ? 'clean' : 'n/a'),
        ledger: allClaims.map((c) => {
          const v = verdicts.find((x) => x.claim === c.claim);
          let verdict = v ? v.verdict : (c.source === 'facts' ? 'grounded' : c.source === 'database' ? 'grounded-db' : 'unchecked');
          if (v && removedSet.has(v.claim) && v.verdict === 'unsupported') verdict = 'removed';
          return { ...c, verdict, src: v ? v.source : '', note: v ? v.note : '' };
        }),
      };
    } catch (_) {}
    // Internal auto-linking: tracked projects/firms/markets link to their
    // oftmw.com pages (external URLs on those anchors get rewritten too) —
    // keeps readers on-site. Runs AFTER the style-fix cycle so links survive.
    let linkReport = { rewritten: 0, added: 0 };
    try {
      const al = autoLinkInternalMd(gen.body_markdown, await loadLinkEntities());
      gen.body_markdown = al.md; linkReport = al.report;
    } catch (_) {}
    let images = [];
    if (args.folder) {
      const rows = await env.DB.prepare(`SELECT url FROM media WHERE folder = ?1 AND (mime_type LIKE 'image/%' OR mime_type IS NULL) ORDER BY uploaded_at DESC`).bind(String(args.folder)).all();
      images = (rows.results || []).map((r) => r.url).filter(Boolean).slice(0, MAX_ARTICLE_IMAGES);
    }
    const cover = args.cover_image || images[0] || undefined;
    const bodyImgs = args.cover_image ? images : images.slice(1);
    const body = sprinkleImagesIntoMarkdown(String(gen.body_markdown), bodyImgs);
    const title = String(gen.title || topic).slice(0, 200);
    const article = await IMPL.create_post_draft({
      title, body_markdown: body, excerpt: gen.excerpt ? String(gen.excerpt) : undefined,
      category: args.category, cover_image: cover, linked_project: args.linked_project,
      post_type: args.post_type, source: 'ai',
    }, env);
    // Log which brain notes were in this draft's prompt — closes the efficacy
    // loop: captureEditLesson reads this to mark violated-despite-injected.
    try {
      await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?,?,?,?)`)
        .bind(Math.floor(Date.now() / 1000), article.slug, 'brain_injected', JSON.stringify({ ids: brain.injected_ids || [] })).run();
    } catch (_) {}
    // Persist the fact ledger against the slug — the "source notes with proof"
    // the post editor renders so a human fact-check is a scan, not a re-report.
    if (factReport && factReport.ledger && factReport.ledger.length) {
      try {
        await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?,?,?,?)`)
          .bind(Math.floor(Date.now() / 1000), article.slug, 'fact_ledger', JSON.stringify({
            slug: article.slug, actor: _mcpActor,
            claims: factReport.claims, checked: factReport.checked, verified: factReport.verified,
            unsupported: factReport.unsupported, removed: factReport.removed, corrected: factReport.corrected,
            coverage_pct: factReport.coverage_pct, status_guard: factReport.status_guard,
            ledger: factReport.ledger,
          })).run();
      } catch (_) {}
    }
    // Persist the voice-gate verdict AGAINST THE SLUG (member_id) — powers both
    // the Turing pass-rate series (brain page) and the per-article scorecard in
    // the post editor, with the actual tells/violations as reviewable notes.
    if (voiceGate && voiceGate.initial) {
      try {
        await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?,?,?,?)`)
          .bind(Math.floor(Date.now() / 1000), article.slug, 'voice_gate', JSON.stringify({
            kind: 'generate', actor: _mcpActor, slug: article.slug, topic: topic.slice(0, 140),
            score: voiceGate.score,
            first_turing: voiceGate.initial.turing, first_violations: voiceGate.initial.spec_violations.length,
            notes: {
              tells: (voiceGate.initial.tells || []).slice(0, 5).map((t) => String(t).slice(0, 220)),
              spec: (voiceGate.initial.spec_violations || []).slice(0, 6).map((v) => String(v).slice(0, 160)),
              critique: (voiceGate.critique_notes || []).map((c) => String(c).slice(0, 200)),
            },
            final_turing: (voiceGate.final || voiceGate.initial).turing,
            final_violations: (voiceGate.final || voiceGate.initial).spec_violations.length,
            revised: !!voiceGate.revised, passed: voiceGate.passed,
          })).run();
      } catch (_) {}
    }
    return {
      ok: true, slug: article.slug, edit_url: article.edit_url, title,
      grounded_in: { voice: !!brain.voice, fingerprint: !!brain.fingerprint, gold_exemplars: (brain.articleExemplars || []).map((a) => a.slug), learned_rules: brain.rules.length, knowledge: brain.knowledge.length, related: brain.facts.length, story_type: st.type || 'unresolved', story_type_via: st.how || '' },
      best_of: bestOf,
      style_check: styleReport,
      voice_gate: voiceGate,
      fact_check: factReport ? { claims: factReport.claims, web_checked: factReport.checked, verified: factReport.verified, unsupported: factReport.unsupported, removed_unverifiable: factReport.removed, corrected: factReport.corrected, coverage_pct: factReport.coverage_pct, status_guard: factReport.status_guard } : null,
      internal_links: linkReport,
      photos_used: images.length,
      note: 'Article draft written with Fable 5, grounded in the shared TMW brain and passed through the voice gate (fingerprint spec + adversarial Turing judge). Review/finish in the Studio AI tab: ' + article.edit_url,
    };
  },

  // Rewrite a draft with Fable 5 per a plain-English instruction, grounded in the shared brain.
  async revise_article_draft(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const slug = String(args.slug || '').trim().toLowerCase();
    const instruction = String(args.instruction || '').trim();
    if (!slug) throw new Error('slug is required');
    if (!instruction) throw new Error('instruction is required');
    const row = await env.DB.prepare('SELECT id, title, status, body_html FROM posts WHERE slug = ?1').bind(slug).first();
    if (!row) throw new Error('no post with slug "' + slug + '"');
    if (row.status !== 'draft') throw new Error('refusing to revise a ' + row.status + ' post — only drafts are editable remotely');
    const current = stripHtml(row.body_html || '');
    if (!current.trim()) throw new Error('draft has no body text to revise');
    const brain = await assembleBrain(env, { topic: String(row.title || ''), place: String(args.place || ''), surface: 'article' });
    const sys = [
      'You are the senior staff editor for Markets of Tomorrow (TMW). Revise the article below per the instruction, keeping it on-brand.',
      brain.text || '',
      'OUTPUT: return ONLY the revised, COMPLETE article as Markdown — no JSON, no fences, no commentary.',
      'RULES: Preserve every fact from the original (do NOT invent or drop verified facts, numbers, dates, prices, or firm names). NEVER fabricate a quotation or attribute words to anyone. TMW voice per the brand brain. Avoid em dashes. Return the whole article, not a diff.',
      // Binding + last, same as the generator: the editor's banked rules must not
      // be outvoted by the generic guidance that follows them.
      brain.voice ? 'THE HOUSE RULES BELOW ARE BINDING and outrank every other instruction here. Before you output, check the opening line, the structure, and the ending against them one by one:\n' + brain.voice : '',
    ].filter(Boolean).join('\n\n');
    const usr = 'INSTRUCTION: ' + instruction + '\n\nCURRENT ARTICLE:\n' + current;
    const revised = await fableGenerate(env, { system: sys, user: usr, maxTokens: 3500 });
    if (!revised || !revised.trim()) throw new Error('revision failed — the editor model returned nothing. Try again or edit manually.');
    let revBody = revised.trim();
    // ── THE VOICE GATE (same as generate): fingerprint + Turing judge → one fix.
    let voiceGate = null;
    try {
      const usedSlugs = (brain.articleExemplars || []).map((a) => a.slug);
      const gateRes = await IMPL._runVoiceGate(env, {
        text: revBody, topic: String(row.title || ''), place: String(args.place || ''), excludeSlugs: usedSlugs, slug,
        rewrite: async (problems, spec) => {
          const rSys = 'You are the senior staff editor for Markets of Tomorrow. Our voice QA flagged the revised article below. Rewrite it so a reader could not tell it from our published work — fix EVERY listed problem. Preserve every fact, number, name, date, and price exactly. Keep the earlier instruction applied: "' + instruction.slice(0, 200) + '". Avoid em dashes. Return ONLY the complete article as Markdown, no commentary.' + (spec ? '\n\nMEASURED HOUSE SPEC:\n' + spec : '');
          const raw2 = await fableGenerate(env, { system: rSys, user: 'PROBLEMS TO FIX:\n- ' + problems.join('\n- ') + '\n\nARTICLE:\n' + revBody, maxTokens: 3600 });
          return raw2 && raw2.trim() ? raw2.trim() : null;
        },
      });
      revBody = gateRes.text; voiceGate = gateRes.gate;
    } catch (_) {}
    // Re-apply internal auto-linking: the revise input is stripHtml'd (links
    // are lost), so tracked projects/firms/markets get re-linked on-site here.
    try { revBody = autoLinkInternalMd(revBody, await loadLinkEntities()).md; } catch (_) {}
    const res = await IMPL.update_post_draft({ slug, body_markdown: revBody }, env);
    const lintR = lintCanon({ title: String(row.title || ''), body: revBody, excerpt: 'x', kind: 'article' });
    return { ok: true, slug, edit_url: res.edit_url, grounded_in: { voice: !!brain.voice, fingerprint: !!brain.fingerprint, gold_exemplars: (brain.articleExemplars || []).map((a) => a.slug), learned_rules: brain.rules.length }, voice_gate: voiceGate, style_warnings: lintR.length ? lintR : undefined, note: 'Draft revised with Fable 5 per: "' + instruction.slice(0, 120) + '", then passed through the voice gate. Review in the Studio.' };
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
    let bodyHtml = mdToHtml(capArticleImages(finishArticleBody(deDash(args.body_markdown || ''))));
    const linkedSlug = args.linked_project ? String(args.linked_project).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160) : '';
    if (linkedSlug && !/class=["']tmw-(project-card|map-embed)["']/.test(bodyHtml)) {
      bodyHtml += `\n<div class="tmw-project-card" data-project="${linkedSlug}"></div>`;
    }
    const text = stripHtml(bodyHtml);
    // The fallback used to be a hard text.slice(0,180), which is exactly how a
    // dek like "…private gardens Just 25 residences make up the e" reached the
    // live meta description: cut mid-word, no terminal period. Fall back to whole
    // sentences instead, and never end on a fragment.
    const excerptFallback = (t) => {
      const s = String(t || '').replace(/\s+/g, ' ').trim();
      if (s.length <= 200) return s;
      const window = s.slice(0, 200);
      const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
      if (stop > 80) return window.slice(0, stop + 1).trim();
      const sp = window.lastIndexOf(' ');
      return window.slice(0, sp > 80 ? sp : 200).replace(/[,;:\-\s]+$/, '') + '.';
    };
    const excerpt = deDash((args.excerpt && String(args.excerpt).trim()) || excerptFallback(text));
    // No connector path (routine OR interactive Studio connector session) may mint
    // a NEW category — regardless of source. If the passed category isn't already
    // on an existing post, drop it and save uncategorized. New categories are
    // created deliberately in the Studio Categories tab only.
    const _cat = await knownCategoryOrBlank(env, args.category);
    const categories = _cat ? JSON.stringify([_cat]) : '[]';
    const reading = Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 200));
    const now = Math.floor(Date.now() / 1000);
    await ensureContactsTable(env);
    await ensureCampaignsTable(env);
    const postType    = normalizePostTypeMcp(args.post_type);
    let   income      = args.income == null || args.income === '' ? null : Number(args.income);
    const contactId   = args.contact_id || null;
    const projSlugMcp = args.project_slug ? String(args.project_slug).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160) : null;
    const campaignId  = args.campaign_id || null;
    // Every connector-created draft is machine-drafted → default 'ai' (Studio "AI"
    // tab). Covers the daily-articles routine, generate_article_draft,
    // write_article_and_post, and direct create_post_draft in an interactive
    // Studio-connector session. Only an explicit source:'human' opts out.
    const sourceMcp   = args.source === 'human' ? null : 'ai';
    // Snapshot the ORIGINAL body so publish-time can diff it against the
    // human-edited final and learn from every edit (the connector learning loop).
    // Every real article is connector-written then edited by hand, so we snapshot
    // any substantial body regardless of the source tag — not just source='ai'.
    const aiOriginal  = (bodyHtml && stripHtml(bodyHtml).length > 300) ? bodyHtml : null;
    // If linking to a campaign and no explicit income given, auto-derive split.
    if (campaignId && income == null) {
      const c = await env.DB.prepare(`SELECT total_income, planned_posts FROM campaigns WHERE id = ?1`).bind(campaignId).first();
      const per = mcpCampaignIncomePerPost(c);
      if (per != null) income = per;
    }
    await env.DB.prepare(
      `INSERT INTO posts (id, slug, title, excerpt, seo_description, body_html, cover_image, categories, tags,
                          author_name, status, published_at, reading_time_min, body_source,
                          post_type, income, contact_id, project_slug, campaign_id, source, ai_original_html, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, '[]', ?8, 'draft', NULL, ?9, 'studio-mcp', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)`
    ).bind(id, slug, title, excerpt, bodyHtml, args.cover_image || null, categories, 'Jake Nicholas', reading, postType, income, contactId, projSlugMcp, campaignId, sourceMcp, aiOriginal, now).run();   // seo_description mirrors excerpt (?4)
    const lint = lintCanon({ title, body: String(args.body_markdown || ''), excerpt: String(args.excerpt || ''), kind: 'article' });
    return {
      ok: true, id, slug, status: 'draft', linked_project: linkedSlug || undefined,
      edit_url: 'https://admin.oftmw.com/post.html?id=' + id,
      style_warnings: lint.length ? lint : undefined,
      note: 'Saved as a DRAFT. Review/finish it in the Studio, then publish from there.' + (linkedSlug ? ' Project card embedded for "' + linkedSlug + '".' : '') + (lint.length ? ' STYLE WARNINGS (canon violations — fix them with update_post_draft): ' + lint.map((w) => w.issue).join(' | ') : ''),
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
    let finalBody = (args.body_markdown != null) ? mdToHtml(capArticleImages(finishArticleBody(deDash(args.body_markdown)))) : null;
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
    // Excerpt (explicit, or derived from a body rewrite) — also mirrors into the SEO meta description.
    let effExcerpt = (args.excerpt != null) ? deDash(String(args.excerpt))
                   : (derivedExcerpt && args.body_markdown != null) ? deDash(derivedExcerpt) : null;
    if (effExcerpt != null) {
      sets.push(`excerpt = ?${p++}`); params.push(effExcerpt);
      sets.push(`seo_description = ?${p++}`); params.push(effExcerpt);
    }
    if (args.category != null) {
      // Same firewall as create: only re-categorize into an EXISTING category.
      // If the label is new/unknown, leave the post's categories untouched rather
      // than mint a new taxonomy entry (or wipe the existing one).
      const _known = await knownCategoryOrBlank(env, args.category);
      if (_known) { sets.push(`categories = ?${p++}`); params.push(JSON.stringify([_known])); }
    }
    if (args.cover_image != null) { sets.push(`cover_image = ?${p++}`); params.push(String(args.cover_image)); }
    if (args.post_type != null)    { sets.push(`post_type = ?${p++}`);    params.push(normalizePostTypeMcp(args.post_type)); }
    if ('income'      in args)     { sets.push(`income = ?${p++}`);       params.push(args.income == null || args.income === '' ? null : Number(args.income)); }
    if ('contact_id'  in args)     { sets.push(`contact_id = ?${p++}`);   params.push(args.contact_id || null); }
    if ('project_slug' in args)    { sets.push(`project_slug = ?${p++}`); params.push(args.project_slug ? String(args.project_slug).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 160) : null); }
    if ('campaign_id' in args)     {
      await ensureCampaignsTable(env);
      const cid = args.campaign_id || null;
      sets.push(`campaign_id = ?${p++}`); params.push(cid);
      // Auto-fill income from campaign math when linking and no explicit income was passed.
      if (cid && !('income' in args)) {
        const c = await env.DB.prepare(`SELECT total_income, planned_posts FROM campaigns WHERE id = ?1`).bind(cid).first();
        const per = mcpCampaignIncomePerPost(c);
        if (per != null) { sets.push(`income = ?${p++}`); params.push(per); }
      }
      // Unlink → clear income unless caller overrode.
      if (cid == null && !('income' in args)) { sets.push(`income = ?${p++}`); params.push(null); }
    }
    if (!sets.length) throw new Error('nothing to update — pass at least one of title/body_markdown/excerpt/category/cover_image/linked_project/post_type/income/contact_id/project_slug/campaign_id');
    sets.push(`updated_at = ?${p++}`); params.push(Math.floor(Date.now() / 1000));
    params.push(slug);
    await env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE slug = ?${p}`).bind(...params).run();
    const lintU = args.body_markdown ? lintCanon({ title: String(args.title || ''), body: String(args.body_markdown), excerpt: String(args.excerpt || 'x'), kind: 'article' }) : [];
    return { ok: true, slug, status: 'draft', linked_project: linkedSlug || undefined, edit_url: 'https://admin.oftmw.com/post.html?id=' + row.id, style_warnings: lintU.length ? lintU : undefined };
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
    // HI-RES ONLY for images — the longer side must be >= 1200px (keeps the routines'
    // scraped/pulled imagery high-resolution; low-res thumbnails are rejected). Video exempt.
    if (/^image\//.test(ct) && !/svg/.test(ct)) {
      const _d = imageDims(buf);
      if (_d && Math.max(_d.w || 0, _d.h || 0) < MIN_IMG_PX) {
        throw new Error('image too low-res (' + (_d.w || 0) + 'x' + (_d.h || 0) + '); need at least ' + MIN_IMG_PX + 'px on the longer side — use a full-resolution source.');
      }
    }

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

  async scrape_website_images(args, env) {
    if (!env.MEDIA || !env.DB) throw new Error('media storage not configured');
    const project = String(args.project || '').trim().slice(0, 120);
    if (!project) throw new Error('project name is required');
    const wantFolder = (String(args.folder || '').trim() || ('Projects / ' + project)).slice(0, 160);
    const _fr = await resolveMediaFolder(env, wantFolder);
    const folder = _fr.folder;
    const limit   = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 60);
    const minBytes = Math.max(0, (parseInt(args.min_kb, 10) || 8)) * 1024;
    const wantSpace = Math.max(0, parseInt(args.ensure_space, 10) || 6);   // target # of resort-SPACE images
    const webMode = args.search_web; // true = always web-search; false = never; undefined/'auto' = only if space-thin

    // Primary source pages (url + urls[]), https only, deduped.
    const pages = [...new Set([String(args.url || ''), ...(Array.isArray(args.urls) ? args.urls : [])]
      .map((s) => String(s || '').trim()).filter((s) => /^https?:\/\//i.test(s)))];
    if (!pages.length && webMode !== true) throw new Error('provide a url (or urls[]), or set search_web:true with a project name');

    const ts = Math.floor(Date.now() / 1000);
    try { await ensureMediaFoldersTable(env); await env.DB.prepare('INSERT OR IGNORE INTO media_folders (name, favorite, created_at) VALUES (?1, 0, ?2)').bind(folder, ts).run(); } catch (_) {}

    const saved = [], skipped = []; const seen = new Set(); const counts = { space: 0, lifestyle: 0, other: 0 };
    // Store SPACE-first up to the limit; tag each with its guessed category.
    async function ingest(urls) {
      const ranked = urls.filter((u) => !seen.has(u)).map((u) => ({ u, ...scoreImageUrl(u) })).sort((a, b) => b.score - a.score);
      for (const c of ranked) {
        if (saved.length >= limit) break;
        seen.add(c.u);
        const res = await storeScrapedImage(env, c.u, folder, project, minBytes);
        if (res.skip) { skipped.push({ url: c.u, reason: res.skip }); continue; }
        saved.push({ url: res.url, filename: res.filename, category: c.cat }); counts[c.cat]++;
      }
    }

    // 1) primary pages
    let primaryCands = [];
    for (const p of pages) primaryCands.push(...await extractPageImages(p));
    primaryCands = [...new Set(primaryCands)];
    await ingest(primaryCands);

    // 2) supplement from the web when resort-SPACE coverage is thin (or always, if asked).
    let webPages = [];
    const needMore = counts.space < wantSpace && saved.length < limit;
    if (env.ANTHROPIC_API_KEY && webMode !== false && (webMode === true || needMore)) {
      const q = String(args.search_query || '').trim()
        || (project + ' resort hotel renderings photos — guest rooms villas suites pool lobby spa restaurant exterior facade aerial');
      webPages = await webSearchSourcePages(env, q, 8);
      let webCands = [];
      for (const p of webPages) { if (pages.includes(p)) continue; webCands.push(...await extractPageImages(p)); }
      webCands = [...new Set(webCands)];
      // bias web ingest toward SPACE shots: drop obvious lifestyle when we already have plenty
      await ingest(webCands.filter((u) => counts.space < wantSpace ? scoreImageUrl(u).cat !== 'lifestyle' : true));
      if (saved.length < limit) await ingest(webCands);   // backfill with whatever's left
    }

    return {
      ok: true, project, folder,
      folder_reused: _fr.reused || undefined,
      // A near-duplicate is reported, never silently merged: "Waldorf Astoria"
      // and "Waldorf Astoria Miami" can be different projects, so the call is
      // the caller's to make with merge_media_folders.
      near_duplicate_folders: _fr.near.length ? _fr.near : undefined,
      duplicate_warning: _fr.near.length
        ? 'HEADS UP: "' + folder + '" looks like a duplicate of ' + _fr.near.map((n) => '"' + n + '"').join(', ')
          + '. If it is the same project, merge them now with merge_media_folders({from,to}) and tell the human which way you merged. If they are genuinely different projects, say so and carry on.'
        : undefined,
      sources: pages, web_sources: webPages,
      saved: saved.length, by_category: counts, skipped: skipped.length,
      images: saved.map((s) => s.url),
      note: saved.length
        ? `Saved ${saved.length} image(s) to "${folder}" (${counts.space} resort-space, ${counts.lifestyle} lifestyle, ${counts.other} other)`
          + (webPages.length ? `, ${webPages.length} of them supplemented from web search` : '') + '. '
          + (counts.space < wantSpace ? `Heads up: only ${counts.space} clear resort-space (building/amenity/rendering) shot(s) — the rest may be lifestyle or unlabeled. Consider re-running with search_web:true or pointing url at the hotel's gallery/press page. ` : '')
          + `Pull this folder into an article (write_article_and_post / create_design_draft) or the Design editor's media picker.`
        : `No images saved — sources had no usable images (too small / non-image / unreachable). Try the hotel's gallery page, set search_web:true, or lower min_kb.`,
    };
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
      borough: String(args.borough || ''),
      // Structured street address — street line + zip + country (city lives above,
      // US state auto-derives from lat/lng). Powers full-address answers + country search.
      street: String(args.address || args.street || ''),
      postal_code: String(args.postal_code || args.zip || ''),
      country: String(args.country || ''),
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
      // Gross Floor Area (total BUILT sq ft) — the project's overall SCALE, used to
      // rank "biggest" searches. gfa_source: 'stated' (a source gave the number) or
      // 'estimated' (derived from floors/units/acreage).
      gfa_sqft: num(args.gfa_sqft),
      gfa_source: args.gfa_source ? String(args.gfa_source) : (num(args.gfa_sqft) != null ? 'stated' : null),
    };
    // (images are ingested into the project media folder after the dedup gate below)
    // Dates (optional). The admin reads start_date/delivery_date + their
    // *_speculative flags — set the flag when it's a TMW estimate vs a
    // developer-committed date.
    if (args.start_date) data.start_date = String(args.start_date);
    if (args.delivery_date) data.delivery_date = String(args.delivery_date);
    if (args.start_speculative) data.start_speculative = true;
    if (args.delivery_speculative) data.delivery_speculative = true;

    // DEDUP GATE — never draft a project that's already on the live map. The
    // editor should not have to vet every discovery draft for duplicates, and the
    // routine's own match_project pre-check is easy to skip or under-match. Block
    // an exact-slug collision or a confident name/geo match; the caller should use
    // propose_project_edit against the existing slug instead.
    const liveProjects = await loadProjects();
    const dupDeveloper = Array.isArray(args.developers) ? args.developers.join(', ') : String(args.developers || '');
    const dup = findLiveDuplicate(
      { name: title, website: data.official_website, city: data.city, developer: dupDeveloper, lat: data.lat, lng: data.lng },
      data.slug, liveProjects,
    );
    if (dup) {
      const ex = dup.project;
      throw new Error(
        `Already on the live map as "${ex.Title}" (slug ${ex.Slug || slugify(String(ex.Title || ''))}${ex.City ? ', ' + ex.City : ''}) — ${dup.reason}. `
        + `Not creating a duplicate draft. If a source corrects a field on the existing project, use propose_project_edit against that slug; otherwise skip it.`,
      );
    }
    // SECOND HALF OF THE GATE — the same test against drafts already STAGED.
    // The live check above can only ever pass for an un-promoted project, so
    // without this the routine re-drafts the same discovery every single run.
    const candForDup = { name: title, website: data.official_website, city: data.city, developer: dupDeveloper, lat: data.lat, lng: data.lng };
    const stagedDuplicate = (list) => findLiveDuplicate(candForDup, data.slug, draftsAsProjects(list));
    const stagedDupError = (sd) => {
      const ex = sd.project;
      return new Error(
        `Already staged as a draft: "${ex.Title}"${ex.City ? ' (' + ex.City + ')' : ''}${ex.__draft_id ? ' — draft ' + ex.__draft_id : ''} — ${sd.reason}. `
        + `Not creating a second draft of the same project. Review, edit or promote the existing draft in the Studio (admin.oftmw.com/map/?drafts) instead.`,
      );
    };
    {
      // Checked here, BEFORE the image ingestion below, so a duplicate costs no
      // scraping and the routine gets a clean, actionable error.
      const { text: stagedText } = await ghGetFile(env, GH_DRAFTS_PATH);
      let staged = [];
      if (stagedText) { try { staged = JSON.parse(stagedText); } catch (_) { staged = []; } }
      const sdup = stagedDuplicate(staged);
      if (sdup) throw stagedDupError(sdup);
    }

    // Images — file them in the project's media folder AND attach to the draft in
    // one step: passed external URLs are fetched into R2 under "Projects / <name>";
    // ones already in R2 are kept; if none were passed, auto-pull a prior scrape;
    // if there's still nothing, AUTO-SCRAPE the project's website (then web-search
    // by name) so a lone create_map_draft call still lands photos.
    let imgReport = { urls: [], folder: null, added: 0, pulled: 0, scraped: 0, skipped: [] };
    try {
      imgReport = await ingestDraftImages(env, title, args.images, data.official_website);
      if (imgReport.urls.length) data.images = imgReport.urls;
    } catch (_) {
      if (Array.isArray(args.images) && args.images.length) data.images = args.images.map(String);
    }

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
      // Authoritative duplicate check against the file we are about to write:
      // a parallel run (the routine fans out) can stage the same project between
      // the early gate above and this write, which the early check cannot see.
      const raceDup = stagedDuplicate(drafts);
      if (raceDup) throw stagedDupError(raceDup);

      // Sequence from the MAX existing number for today, not the COUNT. Counting is
      // fragile: if any earlier draft was deleted, count+1 can land on an id that
      // still exists (e.g. 10 drafts remain but the highest is 020 → count+1=011,
      // already taken) — two drafts then share a draft_id and the admin shows one
      // when you open the other. Max+1 is monotonic and deletion-proof; the while
      // loop is a belt-and-suspenders guard against any residual collision.
      const idsToday = new Set(drafts.map((d) => String(d && d.draft_id || '')).filter((id) => id.startsWith(stamp)));
      let maxSeq = 0;
      for (const id of idsToday) { const n = parseInt(id.slice(stamp.length + 1), 10); if (!isNaN(n) && n > maxSeq) maxSeq = n; }
      let seqNum = maxSeq + 1;
      while (idsToday.has(`${stamp}-${String(seqNum).padStart(3, '0')}`)) seqNum++;
      draft_id = `${stamp}-${String(seqNum).padStart(3, '0')}`;
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
    const imgCount = (data.images || []).length;
    const imgSrc = imgReport.scraped ? imgReport.scraped + ' auto-scraped from the web' + (data.official_website ? ' (website first)' : '')
      : imgReport.added ? imgReport.added + ' newly saved to R2' + (imgReport.pulled ? ', ' + imgReport.pulled + ' pulled from a prior scrape' : '')
      : imgReport.pulled ? imgReport.pulled + ' pulled from a prior scrape' : '';
    const imgNote = imgCount
      ? ' Photos: ' + imgCount + ' attached to the draft and filed in media folder "' + imgReport.folder + '"'
        + (imgSrc ? ' (' + imgSrc + ')' : '')
        + (imgReport.scraped ? ' — auto-scraped, so eyeball them in the Drafts tab and swap any wrong-building shots' : '')
        + (imgReport.skipped && imgReport.skipped.length ? '. Skipped ' + imgReport.skipped.length + ' (low-res/unfetchable): ' + imgReport.skipped.map((s) => s.reason).join(', ') : '') + '.'
      : ' No photos found — auto-scrape came up empty (no website images + web search thin). Run scrape_website_images with project:"' + data.name + '" pointed at a known gallery/press page (or pass images:[...]) and they auto-file into "' + imgReport.folder + '" and attach here.';
    return {
      ok: true, draft_id, created_by: 'claude-studio', status: data.status, project: data, needs_coords: needsCoords,
      admin_url: MAP_ADMIN_URL,
      firms: { architects: archRes.report, developers: devRes.report },
      firms_created: createdFirms,
      types: data.types,
      types_dropped: typeRes.dropped,
      images: { count: imgCount, folder: imgReport.folder, added: imgReport.added, pulled: imgReport.pulled, scraped: imgReport.scraped, skipped: imgReport.skipped },
      note: 'Queued for review — open the TMW Studio map admin at ' + MAP_ADMIN_URL + ' and click the "Drafts" tab; "' + data.name + '" is there now as a CLAUDE DRAFT. Review and promote it from that tab to put it on the live map — it is NOT live yet. (Stored in ' + ghRepo(env) + '/' + GH_DRAFTS_PATH + ', which that admin reads directly.)'
        + imgNote
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
      if (args.borough != null) { data.borough = String(args.borough).trim(); changed.push('borough'); }
      if (args.street != null && String(args.street).trim() !== '') { data.street = String(args.street).trim(); changed.push('street'); }
      if (args.postal_code != null && String(args.postal_code).trim() !== '') { data.postal_code = String(args.postal_code).trim(); changed.push('postal_code'); }
      if (args.country != null && String(args.country).trim() !== '') { data.country = String(args.country).trim(); changed.push('country'); }
      if (args.start_date != null && String(args.start_date) !== '') { data.start_date = String(args.start_date); changed.push('start_date'); }
      if (args.start_speculative != null) data.start_speculative = !!args.start_speculative;
      if (args.delivery_date != null && String(args.delivery_date) !== '') { data.delivery_date = String(args.delivery_date); changed.push('delivery_date'); }
      if (args.delivery_speculative != null) data.delivery_speculative = !!args.delivery_speculative;
      if (args.units != null && num(args.units) != null) { data.units = num(args.units); changed.push('units'); }
      if (args.floors != null && num(args.floors) != null) { data.floors = num(args.floors); changed.push('floors'); }
      if (args.keys != null && num(args.keys) != null) { data.keys = num(args.keys); changed.push('keys'); }
      if (args.gfa_sqft != null && num(args.gfa_sqft) != null) { data.gfa_sqft = num(args.gfa_sqft); data.gfa_source = args.gfa_source ? String(args.gfa_source) : 'stated'; changed.push('gfa_sqft'); }
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
    const ALLOWED = new Set(['name', 'status', 'city', 'neighborhood', 'street', 'postal_code', 'country', 'lat', 'lng', 'official_website',
      'units', 'floors', 'keys', 'gfa_sqft', 'gfa_source', 'start_date', 'delivery_date', 'description', 'description_long',
      'types', 'preferred_type']);
    // Types / preferred_type need vocabulary normalization (drop unrecognized
    // tags) before they land in the proposal — same canon as create_map_draft +
    // update_project_status — so a reviewer doesn't see an out-of-vocab tag.
    let canonTypes = null;
    const needCanon = ('types' in changesIn) || ('preferred_type' in changesIn);
    if (needCanon) canonTypes = await loadCanonTypes();

    // Resolve the live record (best-effort) to populate each change's `from`.
    // Display-only — the admin re-reads live projects.json when applying.
    const all = await loadProjects();
    const live = all.find((p) => (p.Slug || slugify(p.Title)) === slug);
    const fromVal = (k) => {
      if (!live) return null;
      const m = {
        name: live.Title, status: live.Status || live.Delivery || '', city: live.City,
        neighborhood: live.Neighborhood, street: live.Street, postal_code: live.PostalCode, country: live.Country,
        lat: live.Latitude, lng: live.Longitude, official_website: live.OfficialWebsite,
        units: live.Units, floors: live.Floors, keys: live.Keys, gfa_sqft: live.GfaSqFt, start_date: live.StartDate,
        delivery_date: live.DeliveryDate, description: live.Description, description_long: live.DescriptionLong,
        types: splitList(live.ProjectType), preferred_type: live.PreferredType,
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
      else if (k === 'units' || k === 'floors' || k === 'keys' || k === 'gfa_sqft') to = (v == null || v === '' || isNaN(parseInt(v, 10))) ? null : parseInt(v, 10);
      else if (k === 'types') to = (Array.isArray(v) ? resolveTypes(v, canonTypes).types : []);
      else if (k === 'preferred_type') to = (v == null ? null : (normType(v, canonTypes) || null));
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
      instructions: 'BACKFILL FIRST. For any project in this batch with history_len:0 (the sweep has never logged a single sourced event for it), your FIRST job is to backfill at least one entry — the original announcement. Web-search "<name> <city> announced" / "<name> developer announces" / search_articles for our own coverage. Find the earliest credible source that announced the project (oftmw.com PREFERRED — call search_articles by slug first). Then call update_project_status with backfill:true, new_status:"announced", effective_date = the actual announcement date from the article body, source_url, note = a one-line headline-style summary. backfill:true logs the entry to status_history WITHOUT changing current status, so a 14 ROC currently at breaking-ground can still get its announcement entry filled in. After backfill, also look for any subsequent milestones (broke-ground, topped-out, etc.) that should be logged — same backfill:true pattern, one call per past milestone. THEN do the normal forward sweep: web-search for recent news (last 6 months) — if a CREDIBLE source shows it reached a LATER status, call update_project_status (no backfill flag) with mode "apply" for a clear single-step advance, "propose" if ambiguous/thin/multi-step. ALWAYS pass effective_date = the real-world date the milestone HAPPENED — never the article\'s publish date. An article published June 2026 saying a tower "has gone vertical" almost never means it went vertical IN June; the event usually predates the coverage. If the source does not state the actual date/month, DO NOT guess a month and DO NOT use the publish date — pass a VAGUE label instead ("Spring 2026", "Mid 2026", "Late 2026", "Q2 2026"). Use a precise YYYY-MM-DD / YYYY-MM only when the source actually gives it. If a milestone was already logged WRONG (false, mis-dated to a publish date, or duplicated), fix it with correct_project_history (delete or edit) — update_project_status can only add/advance, not remove. Sanity-check current status against reality: if a project is recorded at a later phase than credible sources support — e.g. marked "construction" yet nothing shows ground has broken — CORRECT it via update_project_status with the earlier new_status and correction:true (cite source + note why). PHASE MILESTONES: pass `milestone` = one of financing, going-vertical, halfway, topping-out, tenant, tco, move-in, bookings — ALWAYS with effective_date + source_url. For a `financing` milestone, ALSO pass loan_amount (e.g. "$323.8M") + lender (e.g. "Bank OZK") from the source so the figure is captured structurally for Follow the Money. The coarse anchors — announced, broke ground, grand opening — go via new_status (with backfill:true if past) instead. Never skip a project with history_len:0 even if you find no recent news — backfill its announcement first.',
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
    // Editorially BANNED sources — never citable in the dossier. Same
    // deterministic-guard pattern as the category firewall: enforced on the
    // write path, not left to routine-prompt goodwill.
    if (sourceUrl) {
      const bad = BANNED_SOURCE_DOMAINS.find((d) => { try { return new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '').endsWith(d); } catch (_) { return false; } });
      if (bad) throw new Error('source_url domain "' + bad + '" is NOT an approved cited source (editorially banned). Cite a different credible source for this update — or, if the event is only reported there, skip it.');
    }
    // A self-evident DATE CORRECTION (clearing/estimating an impossible date from the
    // project's own state) needs no external article — but MUST carry a note.
    const dateCorrection = args.date_correction === true;
    const noteTrim = String(args.note || '').trim();
    if (!sourceUrl && !(dateCorrection && noteTrim)) {
      throw new Error('source_url is required — cite where the update came from. (For a self-evident date fix — clearing an impossible date or flagging one as a TMW estimate from the project\'s own status — pass date_correction:true with a note instead.)');
    }
    const mode = (String(args.mode || 'apply').toLowerCase() === 'propose') ? 'propose' : 'apply';
    const clean = (v) => (v == null ? '' : String(v).trim());
    const newStart = clean(args.start_date);
    const newDelivery = clean(args.delivery_date);
    const clearStart = args.clear_start_date === true;
    const clearDelivery = args.clear_delivery_date === true;
    // The real-world date a milestone occurred (event date), distinct from the
    // `at` record/discovery timestamp. Drives the dossier timeline.
    const effectiveDate = clean(args.effective_date);
    const VAGUE_EFFECTIVE = /^(early|mid|late|spring|summer|fall|autumn|winter|q[1-4]|h[12])[\s-]?\d{4}$/i;
    if (effectiveDate && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(effectiveDate) && !VAGUE_EFFECTIVE.test(effectiveDate)) {
      throw new Error('effective_date must be the real-world EVENT date — YYYY, YYYY-MM, YYYY-MM-DD, or (when the exact date is unknown) a vague label like "Spring 2026", "Mid 2026", "Late 2026", or "Q2 2026". NEVER pass the article\'s publish date: a June 2026 article about a March 2026 event is dated to March (or "Spring 2026" if the month is unclear), not June.');
    }
    // Finer construction-phase milestone (logged to the dossier timeline; does
    // NOT change the lifecycle status). Pass effective_date for its event date.
    const milestone = String(args.milestone || '').toLowerCase().trim();
    if (milestone && !MILESTONE_PHASES.includes(milestone)) {
      throw new Error('milestone must be one of: ' + MILESTONE_PHASES.join(', '));
    }
    // Structured financing capture (used only on a `financing` milestone) — stored
    // on the entry so "Follow the Money" reads a real figure, not parsed prose.
    const loanAmount = (function (v) {
      if (v == null || v === '') return null;
      if (typeof v === 'number') return isFinite(v) ? Math.round(v * 100) / 100 : null;
      const m = String(v).match(/([\d,]+(?:\.\d+)?)\s*(b|bn|billion)?/i);
      if (!m) return null;
      let n = parseFloat(m[1].replace(/,/g, ''));
      if (!isFinite(n)) return null;
      if (m[2]) n *= 1000;                 // billions → millions
      if (n >= 1e6) n = n / 1e6;           // looks like raw dollars → millions ("$600,000,000" → 600)
      if (!(n > 0 && n <= 50000)) return null;   // implausible for a single loan (> $50B) — reject
      return Math.round(n * 100) / 100;    // stored in $millions
    })(args.loan_amount);
    const lenderName = clean(args.lender);
    // Factual spec fields the agent fills/corrects when it finds them (auto-apply).
    const numOrNull = (v) => { if (v == null || v === '') return null; const n = parseInt(v, 10); return isNaN(n) ? null : n; };
    const NUM_FIELDS = [
      { arg: 'units',    field: 'units',    label: 'units' },
      { arg: 'floors',   field: 'floors',   label: 'floors (stories)' },
      { arg: 'keys',     field: 'keys',     label: 'keys' },
      { arg: 'gfa_sqft', field: 'gfa_sqft', label: 'GFA (sq ft)' },
    ];
    const numWanted = NUM_FIELDS.map((f) => ({ ...f, val: numOrNull(args[f.arg]) })).filter((f) => f.val != null);
    // Neighborhood / submarket — a free-text spec field that auto-applies like
    // units/floors (many projects are missing it; it powers neighborhood search).
    const nbhdWanted = (args.neighborhood != null && String(args.neighborhood).trim() !== '') ? String(args.neighborhood).trim() : null;
    // Structured street-address fields — street line, zip, country. Free-text spec
    // fields that auto-apply like neighborhood (most projects are missing them;
    // they power full-address answers + country-level search).
    const STR_FIELDS = [
      { arg: 'street',      field: 'street' },
      { arg: 'postal_code', field: 'postal_code' },
      { arg: 'country',     field: 'country' },
    ];
    const strWanted = STR_FIELDS
      .map((f) => ({ ...f, val: (args[f.arg] != null && String(args[f.arg]).trim() !== '') ? String(args[f.arg]).trim() : null }))
      .filter((f) => f.val != null);
    // Project types + preferred_type — re-classification (e.g. promoting
    // multi-use hotels to Mixed-Use, or auto-tagging Mixed-Use when the sweep
    // sees both Residences + Office on a record). Auto-applies like specs.
    // Pass the FULL replacement list in `types`; null/omit leaves it unchanged.
    const typesProvided = Array.isArray(args.types);
    let typesWanted = null, preferredWanted = null;
    if (typesProvided || args.preferred_type) {
      const canonTypes = await loadCanonTypes();
      if (typesProvided) {
        const res = resolveTypes(args.types, canonTypes);
        typesWanted = res.types;
      }
      if (args.preferred_type != null && String(args.preferred_type).trim() !== '') {
        preferredWanted = normType(args.preferred_type, canonTypes);
      }
    }

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
      // DATE CORRECTIONS: clear an impossible date, or flag an existing one as a
      // TMW estimate (spec-only, no new value).
      const startCleared = clearStart && !!clean(p.start_date);
      const deliveryCleared = clearDelivery && !!clean(p.delivery_date);
      const startSpecOnly = !newStart && !clearStart && args.start_speculative === true && !p.start_speculative && !!clean(p.start_date);
      const deliverySpecOnly = !newDelivery && !clearDelivery && args.delivery_speculative === true && !p.delivery_speculative && !!clean(p.delivery_date);
      const numChanged = numWanted.filter((u) => u.val !== numOrNull(p[u.field]));
      const nbhdChanged = nbhdWanted != null && nbhdWanted !== String(p.neighborhood || '');
      const strChanged = strWanted.filter((u) => u.val !== String(p[u.field] || ''));
      // Types / preferred_type re-classification (e.g. promoting Hotel + Residences
      // to Mixed-Use). Compare current vs requested as sets; only mark changed when
      // the actual set differs so an idempotent re-call doesn't churn the timeline.
      const currentTypes = Array.isArray(p.types) ? p.types.slice() : [];
      const typesChanged = typesWanted != null && (
        currentTypes.length !== typesWanted.length ||
        !currentTypes.every((t) => typesWanted.indexOf(t) >= 0)
      );
      const preferredChanged = preferredWanted != null && preferredWanted !== String(p.preferred_type || '');
      // A milestone is always a new dated event to log (idempotency isn't
      // enforced — the same phase can legitimately recur with a corrected date;
      // humans can prune dupes in the Studio milestones editor).
      const milestoneAdded = !!milestone;
      const anyExtra = startChanged || deliveryChanged || startCleared || deliveryCleared || startSpecOnly || deliverySpecOnly || numChanged.length > 0 || nbhdChanged || strChanged.length > 0 || typesChanged || preferredChanged || milestoneAdded || isBackfill;

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
        // When a project OPENS, the opening date IS the completion date — sync
        // delivery_date to it so the radar/card shows the real month, not a stale
        // year-only or future estimate. Only when the opening date is concrete and
        // at least as precise as what's there (never downgrade a day-precise date).
        if (newStatus === 'open' && !newDelivery && statusEffective && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(statusEffective)) {
          const curD = clean(p.delivery_date);
          const curConcrete = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(curD || '');
          if (statusEffective !== curD && (!curConcrete || statusEffective.length >= (curD || '').length)) {
            p.delivery_date = statusEffective;
            p.delivery_speculative = false;
            changes.push(`delivery→${statusEffective} (opened)`);
          }
        }
      }
      if (startChanged) {
        const old = clean(p.start_date) || null;
        p.start_date = newStart;
        if (args.start_speculative) p.start_speculative = true;
        p.status_history.push({ ...base, type: 'date', field: 'start_date', from: old, to: newStart, ...(dateCorrection ? { correction: true } : {}) });
        changes.push(`start ${old || '—'}→${newStart}${dateCorrection ? ' (est.)' : ''}`);
      }
      if (deliveryChanged) {
        const old = clean(p.delivery_date) || null;
        p.delivery_date = newDelivery;
        if (args.delivery_speculative) p.delivery_speculative = true;
        p.status_history.push({ ...base, type: 'date', field: 'delivery_date', from: old, to: newDelivery, ...(dateCorrection ? { correction: true } : {}) });
        changes.push(`delivery ${old || '—'}→${newDelivery}${dateCorrection ? ' (est.)' : ''}`);
      }
      // Date CLEARS — blank a wrong/impossible recorded date (project hasn't reached
      // that phase). Logged as a correction to the dossier.
      if (startCleared) {
        const old = clean(p.start_date) || null;
        p.start_date = ''; delete p.start_speculative;
        p.status_history.push({ ...base, type: 'date', field: 'start_date', from: old, to: null, correction: true });
        changes.push(`start ${old || '—'}→cleared`);
      }
      if (deliveryCleared) {
        const old = clean(p.delivery_date) || null;
        p.delivery_date = ''; delete p.delivery_speculative;
        p.status_history.push({ ...base, type: 'date', field: 'delivery_date', from: old, to: null, correction: true });
        changes.push(`delivery ${old || '—'}→cleared`);
      }
      // Flag an EXISTING (unchanged) date as a TMW estimate.
      if (startSpecOnly) {
        p.start_speculative = true;
        p.status_history.push({ ...base, type: 'date', field: 'start_date', spec: true, correction: true });
        changes.push('start → TMW estimate');
      }
      if (deliverySpecOnly) {
        p.delivery_speculative = true;
        p.status_history.push({ ...base, type: 'date', field: 'delivery_date', spec: true, correction: true });
        changes.push('delivery → TMW estimate');
      }
      for (const u of numChanged) {
        const old = numOrNull(p[u.field]);
        p[u.field] = u.val;
        p.status_history.push({ ...base, type: 'field', field: u.field, from: old, to: u.val });
        changes.push(`${u.label} ${old == null ? '—' : old}→${u.val}`);
      }
      // GFA carries a companion source flag (stated vs estimated) like create_map_draft.
      if (numChanged.some((u) => u.field === 'gfa_sqft')) {
        p.gfa_source = args.gfa_source ? String(args.gfa_source) : 'stated';
      }
      if (nbhdChanged) {
        const old = String(p.neighborhood || '') || null;
        p.neighborhood = nbhdWanted;
        p.status_history.push({ ...base, type: 'field', field: 'neighborhood', from: old, to: nbhdWanted });
        changes.push(`neighborhood ${old || '—'}→${nbhdWanted}`);
      }
      for (const u of strChanged) {
        const old = String(p[u.field] || '') || null;
        p[u.field] = u.val;
        p.status_history.push({ ...base, type: 'field', field: u.field, from: old, to: u.val });
        changes.push(`${u.field} ${old || '—'}→${u.val}`);
      }
      if (typesChanged) {
        const old = currentTypes;
        p.types = typesWanted.slice();
        p.status_history.push({ ...base, type: 'field', field: 'types', from: old, to: typesWanted });
        changes.push(`types [${old.join(', ') || '—'}]→[${typesWanted.join(', ')}]`);
      }
      if (preferredChanged) {
        const old = String(p.preferred_type || '') || null;
        p.preferred_type = preferredWanted;
        p.status_history.push({ ...base, type: 'field', field: 'preferred_type', from: old, to: preferredWanted });
        changes.push(`preferred_type ${old || '—'}→${preferredWanted}`);
      }
      if (milestoneAdded) {
        // A finer construction-phase event for the dossier (does not touch status).
        // A `financing` milestone also carries a structured loan_amount ($M) + lender
        // when provided, so the Intelligence surfaces don't have to parse the note.
        const finExtra = {};
        if (milestone === 'financing') {
          if (loanAmount != null) finExtra.loan_amount = loanAmount;
          if (lenderName) finExtra.lender = lenderName;
        }
        p.status_history.push({ ...base, type: 'milestone', phase: milestone, ...(effectiveDate ? { effective_date: effectiveDate } : {}), ...finExtra });
        changes.push(`milestone: ${milestone}${finExtra.loan_amount != null ? ' $' + finExtra.loan_amount + 'M' : ''}${effectiveDate ? ' @ ' + effectiveDate : ''}`);
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

  // Correct or DELETE a status_history entry — the only way to fix a milestone
  // logged wrong (false / mis-dated to a publish date / duplicated). Pairs with
  // the sweep (update_project_status), which can add/advance but never remove.
  async correct_project_history(args, env) {
    const slug = String(args.slug || '').trim();
    const action = String(args.action || '').toLowerCase().trim();
    const phase = String(args.phase || '').toLowerCase().trim();
    const reason = String(args.reason || '').trim();
    if (!slug) throw new Error('slug is required');
    if (action !== 'delete' && action !== 'edit') throw new Error('action must be "delete" or "edit"');
    if (!phase) throw new Error('phase is required (the phase/status of the entry to fix)');
    if (!reason) throw new Error('reason is required');
    const matchEff = String(args.match_effective_date || '').trim();
    const matchSrc = String(args.match_source_url || '').trim();
    const newEff = String(args.new_effective_date || '').trim();
    const VAGUE = /^(early|mid|late|spring|summer|fall|autumn|winter|q[1-4]|h[12])[\s-]?\d{4}$/i;
    if (action === 'edit' && newEff && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(newEff) && !VAGUE.test(newEff)) {
      throw new Error('new_effective_date must be YYYY, YYYY-MM, YYYY-MM-DD, or a vague label ("Spring 2026", "Mid 2026", "Q2 2026") — never an article publish date.');
    }
    const isEntry = (h) => {
      if (!h || typeof h !== 'object') return false;
      const t = h.type;
      const phaseMatch = (t === 'milestone' && String(h.phase || '').toLowerCase() === phase)
        || (t !== 'milestone' && t !== 'date' && t !== 'field' && String(h.to || '').toLowerCase() === phase);
      if (!phaseMatch) return false;
      if (matchEff && String(h.effective_date || '').trim() !== matchEff) return false;
      if (matchSrc && String(h.source_url || '').trim() !== matchSrc) return false;
      return true;
    };
    for (let attempt = 0; ; attempt++) {
      const { sha, projects } = await readProjectsFile(env);
      const p = projects.find((x) => x && x.slug === slug);
      if (!p) throw new Error('No project with slug "' + slug + '" in projects.json');
      const hist = Array.isArray(p.status_history) ? p.status_history : [];
      const matches = hist.filter(isEntry);
      if (!matches.length) {
        const avail = hist.filter((h) => h && (h.type === 'milestone' || (h.type !== 'date' && h.type !== 'field')))
          .map((h) => (h.type === 'milestone' ? h.phase : ('->' + (h.to || ''))) + (h.effective_date ? '@' + h.effective_date : ''));
        return { ok: false, error: 'No status_history entry matched phase "' + phase + '"' + (matchEff ? ' @ ' + matchEff : '') + (matchSrc ? ' from ' + matchSrc : '') + '.', available_entries: avail };
      }
      let changed = 0;
      if (action === 'delete') {
        p.status_history = hist.filter((h) => !matches.includes(h));
        changed = matches.length;
      } else {
        const nowIso = new Date().toISOString();
        for (const h of matches) {
          if (newEff) h.effective_date = newEff;
          if (args.new_note != null) h.note = String(args.new_note);
          h.corrected_at = nowIso; h.corrected_reason = reason;
          changed++;
        }
      }
      const msg = p.name + ': ' + action + ' ' + changed + ' history entr' + (changed === 1 ? 'y' : 'ies') + ' (' + phase + ') - ' + reason.slice(0, 90) + ' (auto)';
      try {
        await ghPutFile(env, GH_PROJECTS_PATH, serializeProjects(projects), sha, msg);
      } catch (e) { if (e && e.status === 409 && attempt < 4) continue; throw e; }
      return { ok: true, action, slug, name: p.name, phase, entries_affected: changed, note: 'Live map rebuilds within ~1h; git history is the audit trail.' };
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

  // The content-gap backlog — what people ask Onyx where our coverage is thin.
  // Aggregates the intel_answer + search_feedback event logs so a content routine
  // can steer topic picks by real demand instead of guessing. Part of the shared
  // learning loop (question → content).
  async list_content_gaps(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const days = Math.min(Math.max(parseInt(args.days, 10) || 30, 1), 120);
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 100);
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    let rows = [];
    try {
      rows = (await env.DB.prepare(
        `SELECT ts, event_name, props_json FROM events WHERE event_name IN ('intel_answer','search_feedback') AND ts >= ?1 ORDER BY ts ASC`
      ).bind(since).all()).results || [];
    } catch (_) { rows = []; }
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const agg = new Map();   // normalized query → rollup
    for (const r of rows) {
      let p; try { p = JSON.parse(r.props_json); } catch { continue; }
      const key = norm(p.q); if (!key || key.length < 3) continue;
      let e = agg.get(key);
      if (!e) { e = { query: p.q, asked: 0, cov_sum: 0, cov_n: 0, empty: 0, last: 0, place: p.place || '' }; agg.set(key, e); }
      e.asked++; e.last = Math.max(e.last, r.ts);
      if (r.event_name === 'intel_answer') { const c = Number(p.count); if (Number.isFinite(c)) { e.cov_sum += c; e.cov_n++; } }
      if (r.event_name === 'search_feedback' && (p.result_kind === 'empty' || Number(p.results) === 0)) e.empty++;
      if (p.place && !e.place) e.place = p.place;
    }
    const list = [...agg.values()].map((e) => ({
      query: e.query, times_asked: e.asked,
      coverage: e.cov_n ? Math.round((e.cov_sum / e.cov_n) * 10) / 10 : null,
      empty_results: e.empty > 0, last_asked: iso(e.last), place: e.place || undefined,
    }));
    // Gaps = asked repeatedly but thin/empty coverage; rank by demand then thinness.
    const gaps = list
      .filter((x) => x.empty_results || (x.coverage != null && x.coverage <= 2))
      .sort((a, b) => (b.times_asked - a.times_asked) || ((a.coverage == null ? 0 : a.coverage) - (b.coverage == null ? 0 : b.coverage)))
      .slice(0, limit);
    const demand = [...list].sort((a, b) => b.times_asked - a.times_asked).slice(0, Math.min(15, limit));
    const do_not_cover = await rejectedTopics(env);
    return {
      do_not_cover: do_not_cover.length ? do_not_cover.map((r) => ({ title: r.title, rejected: new Date(r.rejected_at * 1000).toISOString().slice(0, 10), suppressed_until: new Date(r.until * 1000).toISOString().slice(0, 10) })) : undefined,
      range_days: days, total_queries_seen: list.length, gap_count: gaps.length,
      gaps, demand,
      how_to_use: 'gaps = topics people ASK Onyx about where our coverage is thin or empty — prioritize these when choosing what to WRITE (daily-articles) or SCOUT (project-discovery). demand = the most-asked queries overall. Use real audience demand to steer topic picks; still apply the on-brand/luxury quality bar.',
    };
  },

  // ── Brand brain ─────────────────────────────────────────────────────────────
  async get_brand_brain(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureBrandNotesTable(env);
    // Full-dump escape hatch for brain MANAGEMENT (finding note ids to retire).
    if (args && args.all) {
      const rows = (await env.DB.prepare(
        'SELECT id, kind, category, note, context, created_by, created_at, scope, tier FROM brand_notes WHERE active = 1 ORDER BY tier DESC, created_at ASC'
      ).all()).results || [];
      return {
        count: rows.length,
        notes: rows.map((r) => ({ id: r.id, tier: r.tier, scope: r.scope, kind: r.kind, category: r.category || '', note: r.note, context: r.context || '', by: r.created_by || '', when: iso(r.created_at) })),
        how_to_use: 'Management view. tier=canon rows are the always-on constitution; pool rows load by relevance. Retire outdated notes with remove_brand_note.',
      };
    }
    // Default: the curated CANON (always) + pool notes relevant to args.topic.
    const canon = (await env.DB.prepare(
      "SELECT id, kind, category, note FROM brand_notes WHERE active = 1 AND tier='canon' ORDER BY id ASC"
    ).all()).results || [];
    const SECTIONS = [
      { title: 'Voice & identity', kinds: ['voice'] },
      { title: 'Rules', kinds: ['rule'] },
      { title: 'Structure & format', kinds: ['structure'] },
      { title: 'Lean into (topics & likes)', kinds: ['like', 'topic'] },
      { title: 'Avoid', kinds: ['dislike', 'avoid'] },
      { title: 'Examples that worked', kinds: ['example'] },
    ];
    let md = '# Markets of Tomorrow — Brand Brain (canon)\n';
    const used = new Set();
    for (const s of SECTIONS) {
      const items = canon.filter((r) => s.kinds.includes(r.kind));
      if (!items.length) continue;
      md += `\n## ${s.title}\n`;
      for (const r of items) { used.add(r.id); md += `- ${r.note}\n`; }
    }
    for (const r of canon.filter((r) => !used.has(r.id))) md += `- [${r.kind}] ${r.note}\n`;
    if (!canon.length) md += '\n_(canon empty — teach it with record_preference)_\n';
    const topic = String((args && args.topic) || '').trim();
    let relevant = topic ? await brainRelevantNotes(env, topic, 8) : [];
    if (!relevant.length) {
      relevant = (((await env.DB.prepare(
        "SELECT kind, note FROM brand_notes WHERE active = 1 AND tier='pool' AND scope='voice' ORDER BY created_at DESC LIMIT 10"
      ).all()).results) || []).map((r) => ({ kind: r.kind, note: r.note }));
    }
    if (relevant.length) {
      md += '\n## Relevant house notes' + (topic ? ` (for: ${topic})` : ' (latest)') + '\n';
      for (const r of relevant) md += `- [${r.kind}] ${r.note}\n`;
    }
    const c = await env.DB.prepare("SELECT COUNT(*) c FROM brand_notes WHERE active = 1").first();
    return {
      playbook: md,
      canon_count: canon.length,
      pool_total: (c ? c.c : 0) - canon.length,
      how_to_use: 'The canon is the constitution — always apply it. The relevant notes are pool learnings matched to your topic; pass topic (e.g. "carousel for a Nashville hotel opening") to retrieve the right ones. Pass all:true only to manage/retire notes.',
    };
  },

  // Teach the house voice from a real human rewrite. Reuses the SAME learning
  // pipeline the in-editor Polish chat uses (handleReviseFeedback signal:'manual'),
  // so the pair is banked as an event AND embedded for topic-relevant retrieval.
  async merge_media_folders(args, env) {
    const from = String(args.from || '').trim();
    const to = String(args.to || '').trim();
    if (!from || !to) throw new Error('from and to are both required');
    if (from === to) throw new Error('from and to are the same folder');
    // rename-folder IS a merge when the target already exists: it moves the
    // media rows and every descendant path, then carries the registration over.
    const req = new Request('https://tmw.jake-ab7.workers.dev/admin/media/rename-folder', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (env.ADMIN_TOKEN || ''), 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    const r = bridgeJson(await handleMediaRenameFolder(req, env, BRIDGE_ORIGIN));
    const d = await r;
    return { ok: true, from, to, items_moved: (d && d.items_moved) || 0,
      note: '"' + from + '" is gone; its images now live in "' + to + '".' };
  },
  async teach_from_rewrite(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const slug = String(args.slug || '').trim().toLowerCase();
    const rewrite = String(args.rewrite_markdown || '').trim();
    if (!slug) throw new Error('slug is required');
    if (!rewrite) throw new Error('rewrite_markdown is required');
    const row = await env.DB.prepare('SELECT id, title, status, body_html FROM posts WHERE slug = ?1').bind(slug).first();
    if (!row) throw new Error('no post with slug "' + slug + '"');
    const before = String(row.body_html || '');
    // Save the human's version as the draft body (drafts only; guarded downstream).
    let saved = null;
    try { saved = await IMPL.update_post_draft({ slug, body_markdown: rewrite }, env); }
    catch (e) { throw new Error('could not save the rewrite: ' + (e && e.message ? e.message : e)); }
    // Bank the before -> after pair into the shared learning loop.
    let learned = null;
    try {
      const req = new Request('https://tmw.jake-ab7.workers.dev/admin/revise-feedback', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (env.ADMIN_TOKEN || ''), 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, signal: 'manual', before, after: rewrite, instruction: String(args.note || 'human rewrite'), summary: String(args.note || '') }),
      });
      learned = await bridgeJson(await handleReviseFeedback(req, env, BRIDGE_ORIGIN));
    } catch (e) { learned = { error: String(e && e.message || e) }; }
    return {
      ok: true, slug, title: row.title || '', status: row.status,
      saved_to_draft: !!saved, learning: learned,
      edit_url: 'https://admin.oftmw.com/post.html?id=' + row.id,
      next: 'Now call record_preference 2-3 times with the SPECIFIC reusable lessons from this rewrite (what to do, not what happened). If this piece gets published, pin_voice_exemplar it so it becomes a gold-standard reference for every future article.',
      note: 'The edit pair stores the opening ~600 characters of each version, which is where the lede lesson lives.',
    };
  },
  async pin_voice_exemplar(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const slug = String(args.slug || '').trim().toLowerCase();
    if (!slug) throw new Error('slug is required');
    const on = args.on === false ? 0 : 1;
    const row = await env.DB.prepare('SELECT id, title, status FROM posts WHERE slug = ?1').bind(slug).first();
    if (!row) throw new Error('no post with slug "' + slug + '"');
    if (on && row.status !== 'published') throw new Error('"' + (row.title || slug) + '" is a ' + row.status + '. Only PUBLISHED posts can be gold-standard exemplars — publish it first, then pin it.');
    await env.DB.prepare('UPDATE posts SET voice_exemplar = ?1 WHERE slug = ?2').bind(on, slug).run();
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE status='published' AND voice_exemplar=1").first();
    return { ok: true, slug, title: row.title || '', pinned: !!on, total_pinned: n ? n.c : null,
      note: 'Pinned articles are injected into every future article-writing prompt as the voice to match.' };
  },
  async list_brain_notes(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureBrandNotesTable(env);
    const tier = ['pool', 'canon', 'format', 'editor'].includes(String(args.tier || '')) ? String(args.tier) : 'pool';
    const scope = ['voice', 'data', 'bug', 'ops'].includes(String(args.scope || '')) ? String(args.scope) : 'voice';
    const limit = Math.min(500, Math.max(1, parseInt(args.limit, 10) || 200));
    const offset = Math.max(0, parseInt(args.offset, 10) || 0);
    const where = ['active = 1', 'tier = ?1', 'scope = ?2'];
    const binds = [tier, scope];
    if (args.q) { binds.push('%' + String(args.q).toLowerCase() + '%'); where.push('LOWER(note) LIKE ?' + binds.length); }
    if (args.never_retrieved) where.push('COALESCE(retrievals,0) = 0');
    binds.push(limit, offset);
    const rows = ((await env.DB.prepare(
      `SELECT id, kind, note, scope, tier, category, created_at, COALESCE(retrievals,0) retrievals
       FROM brand_notes WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`
    ).bind(...binds).all()).results) || [];
    const total = await env.DB.prepare(`SELECT COUNT(*) c FROM brand_notes WHERE active=1 AND tier=?1 AND scope=?2`).bind(tier, scope).first();
    return { items: rows, count: rows.length, total: (total && total.c) || 0, tier, scope, offset, note: 'Consolidate a cluster with consolidate_brain_notes (one principle + the ids it absorbs, atomic). Bulk-clear dead weight with retire_brain_notes.' };
  },

  async consolidate_brain_notes(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureBrandNotesTable(env);
    const note = String(args.note || '').trim();
    if (!note) throw new Error('note is required');
    const ids = (Array.isArray(args.retire_ids) ? args.retire_ids : []).map((x) => String(x)).filter(Boolean);
    if (!ids.length) throw new Error('retire_ids is required — a consolidation that absorbs nothing is just another note; use record_preference for that.');
    // Pool only: canon/format/editor are sealed against automation.
    const safe = ((await env.DB.prepare(
      `SELECT id FROM brand_notes WHERE active=1 AND tier='pool' AND id IN (${ids.map((_, i) => '?' + (i + 1)).join(',')})`
    ).bind(...ids.slice(0, 200)).all()).results || []).map((r) => r.id);
    const refused = ids.filter((i) => !safe.includes(i));
    const kind = ['like', 'dislike', 'rule', 'voice', 'structure', 'topic', 'avoid', 'example'].includes(String(args.kind || '')) ? String(args.kind) : 'rule';
    const res = await brainWrite(env, {
      type: 'merge', kind, note, source: _mcpActor || 'consolidation',
      evidence: String(args.evidence || '').slice(0, 1200) || ('absorbs ' + safe.length + ' notes'),
      retire_ids: safe,
    });
    const after = await env.DB.prepare(`SELECT COUNT(*) c FROM brand_notes WHERE active=1 AND tier='pool' AND scope='voice'`).first();
    return {
      ok: !!(res && (res.applied || res.proposed)), applied: !!(res && res.applied),
      absorbed: safe.length, refused: refused.length ? refused : undefined,
      voice_pool_now: (after && after.c) || null,
      note: res && res.applied ? 'Applied: the principle is live and the ' + safe.length + ' originals are archived.' : 'Queued (daily budget reached); it applies on the next hourly pass.',
    };
  },

  async retire_brain_notes(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureBrandNotesTable(env);
    const ids = (Array.isArray(args.ids) ? args.ids : []).map((x) => String(x)).filter(Boolean).slice(0, 200);
    if (!ids.length) throw new Error('ids is required');
    const safe = ((await env.DB.prepare(
      `SELECT id FROM brand_notes WHERE active=1 AND tier='pool' AND id IN (${ids.map((_, i) => '?' + (i + 1)).join(',')})`
    ).bind(...ids).all()).results || []).map((r) => r.id);
    if (safe.length) await retireBrandNotes(env, safe);
    try {
      await env.DB.prepare(`INSERT INTO events (ts, member_id, event_name, props_json) VALUES (?,?,?,?)`)
        .bind(Math.floor(Date.now() / 1000), _mcpActor || 'consolidation', 'brain_auto',
          JSON.stringify({ type: 'retire', retired: safe.length, reason: String(args.reason || '').slice(0, 300) })).run();
    } catch (_) {}
    const after = await env.DB.prepare(`SELECT COUNT(*) c FROM brand_notes WHERE active=1 AND tier='pool' AND scope='voice'`).first();
    return { ok: true, retired: safe.length, skipped: ids.length - safe.length, voice_pool_now: (after && after.c) || null };
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
    // Route by purpose: only scope='voice' notes ever reach writing prompts.
    const SCOPES = ['voice', 'data', 'bug', 'ops'];
    const scope = SCOPES.includes(String(args.scope || '').toLowerCase()) ? String(args.scope).toLowerCase() : classifyNoteScope(note);
    await env.DB.prepare(
      "INSERT INTO brand_notes (id, kind, category, note, context, created_by, created_at, active, scope, tier) VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,'pool')"
    ).bind(id, kind, String(args.category || '').slice(0, 60) || null, note.slice(0, 2000), String(args.context || '').slice(0, 500) || null, String(args.by || 'studio').slice(0, 40), now, scope).run();
    // Embed immediately so relevance retrieval sees it without waiting for the daily pass.
    try { await brainNoteVectors(env, [{ id, kind, note: note.slice(0, 2000), context: args.context, scope }]); } catch (_) {}
    const c = await env.DB.prepare('SELECT COUNT(*) c FROM brand_notes WHERE active = 1').first();
    return { ok: true, id, kind, scope, note, brain_size: c ? c.c : null, msg: scope === 'voice' ? 'Recorded to the shared brand brain — retrievable by every connected account immediately.' : `Recorded with scope="${scope}" — kept out of writing prompts (it is a ${scope} note, not house voice).` };
  },

  async remove_brand_note(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureBrandNotesTable(env);
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id is required (from get_brand_brain)');
    await retireBrandNotes(env, [id]);   // deactivates AND drops the vector so retrieval can't resurface it
    return { ok: true, id, removed: true };
  },

  // ── Contacts (Monday-replacement CRM) ────────────────────────────────────
  async list_contacts(args, env) { return mcpListContacts(args, env); },
  async search_contacts(args, env) { return mcpListContacts({ query: args.query, limit: args.limit }, env); },
  async get_contact(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureContactsTable(env);
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id is required');
    const row = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?1`).bind(id).first();
    if (!row) throw new Error('no contact with id "' + id + '"');
    const posts = (await env.DB.prepare(
      `SELECT slug, title, post_type, income, published_at, status
       FROM posts WHERE contact_id = ?1 ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 500`
    ).bind(id).all()).results || [];
    return { contact: mcpContactRow(row, posts.length), posts: posts.map((p) => ({
      slug: p.slug, title: p.title, post_type: p.post_type || 'Editorial',
      income: p.income == null ? null : Number(p.income),
      date: iso(p.published_at), status: p.status,
    })) };
  },
  async create_contact(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureContactsTable(env);
    const name = String(args.name || '').trim();
    if (!name) throw new Error('name is required');
    const id = 'cnt-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    const tagsJson = JSON.stringify(mcpNormalizeContactTags(args.tags));
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO contacts (id, name, email, company, phone, tags, notes, featured, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
    ).bind(id, name, args.email || null, args.company || null, args.phone || null, tagsJson, args.notes || null, args.featured ? 1 : 0, now).run();
    const row = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?1`).bind(id).first();
    return { ok: true, contact: mcpContactRow(row, 0), note: 'Wire this contact to a post by setting contact_id="' + id + '" on update_post_draft.' };
  },
  async update_contact(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureContactsTable(env);
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id is required');
    const existing = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?1`).bind(id).first();
    if (!existing) throw new Error('no contact with id "' + id + '"');
    const sets = []; const params = []; let p = 1;
    for (const k of ['name','email','company','phone','notes']) {
      if (args[k] != null) { sets.push(`${k} = ?${p++}`); params.push(args[k] === '' ? null : String(args[k])); }
    }
    if (Array.isArray(args.tags) || typeof args.tags === 'string') {
      sets.push(`tags = ?${p++}`); params.push(JSON.stringify(mcpNormalizeContactTags(args.tags)));
    }
    if (typeof args.featured === 'boolean') {
      sets.push(`featured = ?${p++}`); params.push(args.featured ? 1 : 0);
    }
    if (!sets.length) throw new Error('nothing to update — pass at least one of name/email/company/phone/tags/notes/featured');
    sets.push(`updated_at = ?${p++}`); params.push(Math.floor(Date.now() / 1000));
    params.push(id);
    await env.DB.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?${p}`).bind(...params).run();
    const updated = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?1`).bind(id).first();
    return { ok: true, contact: mcpContactRow(updated) };
  },
  async delete_contact(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureContactsTable(env);
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id is required');
    // Detach from posts first so we don't leave dangling refs.
    await env.DB.prepare(`UPDATE posts SET contact_id = NULL WHERE contact_id = ?1`).bind(id).run();
    const r = await env.DB.prepare(`DELETE FROM contacts WHERE id = ?1`).bind(id).run();
    return { ok: true, id, deleted: r.meta && r.meta.changes ? r.meta.changes : 0 };
  },

  // ── Campaigns ────────────────────────────────────────────────────────────
  async list_campaigns(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureCampaignsTable(env);
    const limit  = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
    const q      = (args.query || '').trim().toLowerCase();
    const status = (args.status || '').trim();
    const where = []; const params = []; let p = 1;
    if (status) { where.push(`status = ?${p}`); params.push(status); p++; }
    if (q)      { where.push(`(LOWER(name) LIKE ?${p} OR LOWER(notes) LIKE ?${p})`); params.push('%'+q+'%'); p++; }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = await env.DB.prepare(`SELECT COUNT(*) c FROM campaigns ${whereSql}`).bind(...params).first();
    const rows = (await env.DB.prepare(
      `SELECT * FROM campaigns ${whereSql}
       ORDER BY CASE WHEN status='live' THEN 0 ELSE 1 END, COALESCE(start_date, created_at) DESC
       LIMIT ${limit} OFFSET ${offset}`
    ).bind(...params).all()).results || [];
    let counts = {};
    if (rows.length) {
      const placeholders = rows.map((_, i) => `?${i+1}`).join(',');
      const cRows = (await env.DB.prepare(
        `SELECT campaign_id, COUNT(*) c FROM posts WHERE campaign_id IN (${placeholders}) GROUP BY campaign_id`
      ).bind(...rows.map(r => r.id)).all()).results || [];
      for (const cr of cRows) counts[cr.campaign_id] = cr.c;
    }
    return {
      count: rows.length,
      total: total ? total.c : 0,
      campaigns: rows.map((r) => mcpCampaignRow(r, counts[r.id] || 0)),
    };
  },
  async get_campaign(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureCampaignsTable(env);
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id is required');
    const row = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
    if (!row) throw new Error('no campaign with id "' + id + '"');
    const posts = (await env.DB.prepare(
      `SELECT slug, title, post_type, income, published_at, status
       FROM posts WHERE campaign_id = ?1 ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 500`
    ).bind(id).all()).results || [];
    return { campaign: mcpCampaignRow(row, posts.length), posts: posts.map((p) => ({
      slug: p.slug, title: p.title, post_type: p.post_type || 'Editorial',
      income: p.income == null ? null : Number(p.income),
      date: iso(p.published_at), status: p.status,
    })) };
  },
  async create_campaign(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureCampaignsTable(env);
    const name = String(args.name || '').trim();
    if (!name) throw new Error('name is required');
    const id = 'cmp-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO campaigns (id, name, contact_id, project_slug, tier, status,
                              start_date, end_date, total_income, monthly_income,
                              planned_posts, notes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`
    ).bind(
      id, name,
      args.contact_id || null, args.project_slug || null,
      args.tier || null, args.status === 'ended' ? 'ended' : 'live',
      args.start_date == null ? null : Math.floor(Number(args.start_date)),
      args.end_date   == null ? null : Math.floor(Number(args.end_date)),
      args.total_income   == null ? null : Number(args.total_income),
      args.monthly_income == null ? null : Number(args.monthly_income),
      args.planned_posts  == null ? null : Math.floor(Number(args.planned_posts)),
      args.notes || null, now,
    ).run();
    const row = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
    return { ok: true, campaign: mcpCampaignRow(row, 0) };
  },
  async update_campaign(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureCampaignsTable(env);
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id is required');
    const existing = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
    if (!existing) throw new Error('no campaign with id "' + id + '"');
    const sets = []; const params = []; let p = 1;
    const fields = ['name','contact_id','project_slug','tier','status','start_date','end_date','total_income','monthly_income','planned_posts','notes'];
    for (const k of fields) {
      if (args[k] != null) { sets.push(`${k} = ?${p++}`); params.push(args[k] === '' ? null : args[k]); }
    }
    if (!sets.length) throw new Error('nothing to update');
    sets.push(`updated_at = ?${p++}`); params.push(Math.floor(Date.now() / 1000));
    params.push(id);
    await env.DB.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?${p}`).bind(...params).run();
    // Income reshuffles if either of these changed.
    if ('total_income' in args || 'planned_posts' in args) {
      const fresh = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
      const per = mcpCampaignIncomePerPost(fresh);
      await env.DB.prepare(`UPDATE posts SET income = ?1, updated_at = ?2 WHERE campaign_id = ?3`)
        .bind(per, Math.floor(Date.now() / 1000), id).run();
    }
    const updated = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(id).first();
    return { ok: true, campaign: mcpCampaignRow(updated) };
  },
  async delete_campaign(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureCampaignsTable(env);
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id is required');
    await env.DB.prepare(`UPDATE posts SET campaign_id = NULL, income = NULL WHERE campaign_id = ?1`).bind(id).run();
    const r = await env.DB.prepare(`DELETE FROM campaigns WHERE id = ?1`).bind(id).run();
    return { ok: true, id, deleted: r.meta && r.meta.changes ? r.meta.changes : 0 };
  },
  async link_post_to_campaign(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    await ensureCampaignsTable(env);
    const campaignId = String(args.campaign_id || '').trim();
    const postId     = String(args.post_id     || '').trim();
    if (!campaignId || !postId) throw new Error('campaign_id and post_id are required');
    const campaign = await env.DB.prepare(`SELECT * FROM campaigns WHERE id = ?1`).bind(campaignId).first();
    if (!campaign) throw new Error('no campaign with id "' + campaignId + '"');
    const post = await env.DB.prepare(`SELECT id FROM posts WHERE id = ?1`).bind(postId).first();
    if (!post) throw new Error('no post with id "' + postId + '"');
    const per = mcpCampaignIncomePerPost(campaign);
    await env.DB.prepare(`UPDATE posts SET campaign_id = ?1, income = ?2, updated_at = ?3 WHERE id = ?4`)
      .bind(campaignId, per, Math.floor(Date.now() / 1000), postId).run();
    return { ok: true, campaign_id: campaignId, post_id: postId, income_per_post: per };
  },

  // ── Studio admin (read-only) ──────────────────────────────────────────────
  // These reuse the EXACT handler each admin page calls (imported from
  // index.js), so connector numbers can never drift from the Studio. The MCP
  // layer already authenticated the caller as the Studio admin; handlers that
  // self-gate get a synthetic request carrying the worker's own admin bearer.
  async list_flows(args, env) {
    const u = new URL('https://x/admin/flows' + (args.year ? '?year=' + encodeURIComponent(args.year) : ''));
    return bridgeJson(await handleAdminFlowsList(env, BRIDGE_ORIGIN, u));
  },
  async get_pro_income(args, env) {
    const u = new URL('https://x/admin/pro-income?months=' + (parseInt(args.months, 10) || 12));
    return bridgeJson(await handleAdminProIncome(env, BRIDGE_ORIGIN, u));
  },
  async list_subscriptions(args, env) {
    return bridgeJson(await handleSubscriptions(env, BRIDGE_ORIGIN, new URL('https://x/subscriptions')));
  },
  async list_people(args, env) {
    const data = await bridgeJson(await handlePeople(env, BRIDGE_ORIGIN, new URL('https://x/people')));
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const q = String(args.q || '').trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
    const filtered = q ? rows.filter((r) => (String(r.email || '') + ' ' + String(r.member_name || r.name || '')).toLowerCase().includes(q)) : rows;
    return { total: filtered.length, offset, limit, rows: filtered.slice(offset, offset + limit) };
  },
  async get_member_profile(args, env) {
    const email = String(args.email || '').trim().toLowerCase();
    if (!email) throw new Error('email is required');
    const out = { email };
    try {
      out.subscription = await bridgeJson(await handleSubStatus(bridgeReq(env, '/sub-status?email=' + encodeURIComponent(email)), env, BRIDGE_ORIGIN, new URL('https://x/sub-status?email=' + encodeURIComponent(email))));
    } catch (e) { out.subscription_error = String(e.message || e); }
    try {
      out.history = await bridgeJson(await handleAdminMemberHistory(bridgeReq(env, '/admin/member-history?email=' + encodeURIComponent(email)), env, BRIDGE_ORIGIN, new URL('https://x/admin/member-history?email=' + encodeURIComponent(email))));
    } catch (e) { out.history_error = String(e.message || e); }
    const member = String(args.member_id || '').trim();
    if (member) {
      try {
        out.deep_credits = await bridgeJson(await handleAdminDeepCredits(bridgeReq(env, '/admin/deep-credits?member_id=' + encodeURIComponent(member)), env, BRIDGE_ORIGIN));
      } catch (e) { out.deep_credits_error = String(e.message || e); }
    }
    return out;
  },
  async get_funnel_stats(args, env) {
    const u = new URL('https://x/funnel-stats?weeks=' + (parseInt(args.weeks, 10) || 12));
    return bridgeJson(await handleFunnelStats(env, BRIDGE_ORIGIN, u));
  },
  async get_placements(args, env) {
    const qs = args.days ? '?days=' + encodeURIComponent(parseInt(args.days, 10)) : '';
    return bridgeJson(await handlePlacementStats(bridgeReq(env, '/placements' + qs), env, BRIDGE_ORIGIN));
  },
  async list_galleries(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const r = await env.DB.prepare(`
      SELECT g.slug, g.title, g.subtitle, g.category, g.location, g.visibility,
             CASE WHEN g.pin_hash IS NULL OR g.pin_hash = '' THEN 0 ELSE 1 END AS pin_protected,
             g.created_at, g.updated_at,
             (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_slug = g.slug) AS image_count
      FROM galleries g ORDER BY g.updated_at DESC`).all();
    return { galleries: r.results || [] };
  },
  async list_gallery_downloads(args, env) {
    if (!env.DB) throw new Error('D1 not configured');
    const slug = String(args.slug || '').trim();
    const q = String(args.q || '').trim();
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 200, 1), 1000);
    const where = []; const params = [];
    if (slug) { where.push(`gallery_slug = ?${params.length + 1}`); params.push(slug); }
    if (q)    { where.push(`(email LIKE ?${params.length + 1} OR gallery_title LIKE ?${params.length + 1})`); params.push('%' + q + '%'); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = await env.DB.prepare(`SELECT COUNT(*) c FROM gallery_downloads ${whereSql}`).bind(...params).first();
    const rows = await env.DB.prepare(`SELECT id, email, gallery_slug, gallery_title, created_at, country FROM gallery_downloads ${whereSql} ORDER BY created_at DESC LIMIT ${limit}`).bind(...params).all();
    return { items: rows.results || [], total: total ? total.c : 0 };
  },
  async list_giveaways(args, env) {
    return bridgeJson(await handleAdminGiveawaysList(env, BRIDGE_ORIGIN));
  },
  async list_categories(args, env) {
    return bridgeJson(await handleAdminCategories(bridgeReq(env, '/admin/categories'), env, BRIDGE_ORIGIN));
  },
  async get_intel_pulse(args, env) {
    return bridgeJson(await handleIntelStats(bridgeReq(env, '/intel-stats'), env, BRIDGE_ORIGIN));
  },
  async get_intel_teaching(args, env) {
    const out = {};
    try { out.rules = await bridgeJson(await handleIntelRules(bridgeReq(env, '/intel-rules'), env, BRIDGE_ORIGIN)); }
    catch (e) { out.rules_error = String(e.message || e); }
    try { out.exemplars = await bridgeJson(await handleIntelExemplars(bridgeReq(env, '/intel-exemplars'), env, BRIDGE_ORIGIN)); }
    catch (e) { out.exemplars_error = String(e.message || e); }
    return out;
  },
  async get_trending_searches(args, env) {
    return bridgeJson(await handleTrendingSearches(env, BRIDGE_ORIGIN));
  },
  async get_markets_followed(args, env) {
    return bridgeJson(await handleMarketsFollowed(bridgeReq(env, '/admin/markets-followed'), env, BRIDGE_ORIGIN));
  },
  async get_social_overview(args, env) {
    const out = {};
    try { out.accounts = await bridgeJson(await handleSocialAccountsList(bridgeReq(env, '/social-accounts'), env, BRIDGE_ORIGIN)); }
    catch (e) { out.accounts_error = String(e.message || e); }
    try { out.followers = await bridgeJson(await handleFollowersGet(bridgeReq(env, '/followers'), env, BRIDGE_ORIGIN)); }
    catch (e) { out.followers_error = String(e.message || e); }
    return out;
  },
  async get_email_stats(args, env) {
    return bridgeJson(await handleEmailStats(bridgeReq(env, '/admin/email-stats'), env, BRIDGE_ORIGIN));
  },
  async get_daily_pulse(args, env) {
    const off = parseInt(args.off, 10) || 0;
    const u = new URL('https://x/admin/daily-pulse?off=' + off);
    return bridgeJson(await handleDailyPulse(bridgeReq(env, '/admin/daily-pulse?off=' + off), env, BRIDGE_ORIGIN, u));
  },
  async list_brain_proposals(args, env) {
    return bridgeJson(await handleBrainProposed(bridgeReq(env, '/brain/proposed'), env, BRIDGE_ORIGIN));
  },
};

// ── The Studio agent surface, shared ────────────────────────────────────────
// The in-admin ONYX chat (/admin/onyx-chat) runs this EXACT tool catalog and
// these EXACT implementations — the same ones claude.ai drives over MCP. That
// is deliberate: it is the only way the admin writer and a claude.ai session
// can never drift apart. Adding a tool here lights it up on both surfaces at
// once. `studioToolDefs()` hands out Anthropic-shaped defs (input_schema
// instead of MCP's inputSchema); `studioCallTool` is the one dispatch path.
export function studioToolDefs() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}
export async function studioCallTool(name, args, env) {
  const impl = IMPL[name];
  if (!impl) throw new Error('Unknown tool: ' + name);
  return await impl(args || {}, env);
}
// Onyx runs as its own actor so per-article scorecards attribute correctly.
export function setStudioActor(label) { _mcpActor = String(label || 'studio-connector'); }
// Fresh per-request caches (handleMcp does this too; the Onyx loop needs it).
export function resetStudioCaches() { _projectsCache = null; _articlesCache = null; _firmRegCache = null; }

// ── Studio-admin bridge helpers ─────────────────────────────────────────────
const BRIDGE_ORIGIN = 'https://www.oftmw.com';
// Synthetic GET carrying the worker's own admin bearer, so self-gating
// handlers (requireAdminToken) accept the already-authenticated MCP caller.
function bridgeReq(env, path) {
  return new Request('https://tmw.jake-ab7.workers.dev' + path, { headers: { Authorization: 'Bearer ' + (env.ADMIN_TOKEN || '') } });
}
async function bridgeJson(resp) {
  let data = null;
  try { data = await resp.json(); } catch (_) {}
  if (!resp.ok) throw new Error('admin read failed (HTTP ' + resp.status + ')' + (data && data.error ? ': ' + data.error : ''));
  return data;
}

function mcpCampaignIncomePerPost(c) {
  if (!c) return null;
  const total = c.total_income == null ? null : Number(c.total_income);
  const n = c.planned_posts == null ? null : Number(c.planned_posts);
  if (total == null || !n || n <= 0) return null;
  return Math.round((total / n) * 100) / 100;
}
function mcpCampaignRow(r, postCount) {
  return {
    id: r.id, name: r.name || '',
    contact_id: r.contact_id || null, project_slug: r.project_slug || null,
    tier: r.tier || null, status: r.status || 'live',
    start_date: r.start_date || null, end_date: r.end_date || null,
    start: iso(r.start_date), end: iso(r.end_date),
    total_income:   r.total_income   == null ? null : Number(r.total_income),
    monthly_income: r.monthly_income == null ? null : Number(r.monthly_income),
    planned_posts:  r.planned_posts  == null ? null : Number(r.planned_posts),
    notes: r.notes || '',
    post_count: typeof postCount === 'number' ? postCount : null,
    income_per_post: mcpCampaignIncomePerPost(r),
    created: iso(r.created_at), updated: iso(r.updated_at),
  };
}

// ── Post-type normalization (Monday.com replacement vocabulary) ──────────
const POST_TYPE_ENUM_MCP = new Set(['Editorial','Barter','Potential Barter','Partner','Paid']);
function normalizePostTypeMcp(v) {
  if (v == null || v === '') return 'Editorial';
  const s = String(v).trim();
  if (POST_TYPE_ENUM_MCP.has(s)) return s;
  for (const t of POST_TYPE_ENUM_MCP) if (t.toLowerCase() === s.toLowerCase()) return t;
  return 'Editorial';
}

// ── Contacts helpers (shared by list/search/get/create/update) ───────────
function mcpNormalizeContactTags(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
function mcpContactRow(r, postCount) {
  let tags = [];
  try { tags = JSON.parse(r.tags || '[]'); if (!Array.isArray(tags)) tags = []; } catch (_) {}
  return {
    id: r.id, name: r.name || '', email: r.email || '', company: r.company || '',
    phone: r.phone || '', tags, notes: r.notes || '',
    featured: r.featured ? 1 : 0,
    post_count: typeof postCount === 'number' ? postCount : null,
    created: iso(r.created_at), updated: iso(r.updated_at),
  };
}
async function mcpListContacts(args, env) {
  if (!env.DB) throw new Error('D1 not configured');
  await ensureContactsTable(env);
  const limit  = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
  const q   = (args.query || '').trim().toLowerCase();
  const tag = (args.tag   || '').trim();
  const where = []; const params = []; let p = 1;
  if (q)   { where.push(`(LOWER(name) LIKE ?${p} OR LOWER(email) LIKE ?${p} OR LOWER(company) LIKE ?${p})`); params.push('%'+q+'%'); p++; }
  if (tag) { where.push(`tags LIKE ?${p}`); params.push('%"'+tag+'"%'); p++; }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = await env.DB.prepare(`SELECT COUNT(*) c FROM contacts ${whereSql}`).bind(...params).first();
  const rows  = (await env.DB.prepare(
    `SELECT id, name, email, company, phone, tags, notes, created_at, updated_at
     FROM contacts ${whereSql} ORDER BY LOWER(name) ASC LIMIT ${limit} OFFSET ${offset}`
  ).bind(...params).all()).results || [];
  let counts = {};
  if (rows.length) {
    const placeholders = rows.map((_, i) => `?${i+1}`).join(',');
    const cRows = (await env.DB.prepare(
      `SELECT contact_id, COUNT(*) c FROM posts WHERE contact_id IN (${placeholders}) GROUP BY contact_id`
    ).bind(...rows.map((r) => r.id)).all()).results || [];
    for (const cr of cRows) counts[cr.contact_id] = cr.c;
  }
  return {
    count: rows.length,
    total: total ? total.c : 0,
    contacts: rows.map((r) => mcpContactRow(r, counts[r.id] || 0)),
  };
}

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

// Compute the LAST day of a stored delivery_date period — YYYY-MM-DD stays as-is,
// YYYY-MM expands to that month's last day, YYYY expands to Dec 31. Used by the
// daily auto-promote tick to decide whether the stated delivery date has FULLY
// passed (we don't flip a project to Now Open in the middle of a stated month
// or year — we wait until the whole period has lapsed).
function deliveryPeriodEnd(dd) {
  const s = String(dd || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return s + '-' + String(last).padStart(2, '0');
  }
  if (/^\d{4}$/.test(s)) return s + '-12-31';
  return null;
}

// Daily auto-promote: any project with status='coming-soon' whose delivery_date
// period has fully passed gets flipped to 'open'. Mirrors what a human running
// update_project_status would do — sets status, appends a status_history entry
// (with effective_date = the stated delivery date so the dossier timeline lines
// up), and writes projects.json back with one commit covering all promotions.
// Flips on the stated opening date REGARDLESS of delivery_speculative — the date
// is set for a reason, so when it passes the marker must change (per product
// decision). Each flip cites a matching TMW article if one exists, else the
// project's official website, so 'Now Open' always links to something verifiable.
// Propagation to the live map is via the hourly generate-pages rebuild.
//
// Called from the worker cron via maybeAutoPromoteOpenings() in index.js, which
// throttles it to once per day using metaGet/metaSet (same pattern as the Wix
// view backfill).
export async function autoPromoteOpenedProjects(env) {
  requireGhToken(env);
  const todayIso = new Date().toISOString().slice(0, 10);

  // Newest published TMW article per project → the "Now open, see coverage" link.
  // When a project has no matching article, we fall back to its official website
  // so the flipped marker always cites SOMETHING the reader can open.
  const coverageBySlug = new Map();
  try {
    if (env.DB) {
      const cov = await env.DB.prepare(
        `SELECT slug, published_at, project_slug FROM posts
          WHERE project_slug IS NOT NULL AND project_slug != '' AND status = 'published'`
      ).all();
      for (const r of (cov.results || [])) {
        if (!r.slug || !r.project_slug) continue;
        const key = String(r.project_slug).toLowerCase();
        const prev = coverageBySlug.get(key);
        if (!prev || (r.published_at || 0) > (prev.pub || 0)) {
          coverageBySlug.set(key, { link: 'https://www.oftmw.com/post/' + r.slug, pub: r.published_at || 0 });
        }
      }
    }
  } catch (_) {}

  for (let attempt = 0; ; attempt++) {
    const { sha, projects } = await readProjectsFile(env);
    const nowIso = new Date().toISOString();
    const promoted = [];

    for (const p of projects) {
      if (!p || String(p.status || '').toLowerCase() !== 'coming-soon') continue;
      const dd = String(p.delivery_date || '').trim();
      if (!dd) continue;
      const cutoff = deliveryPeriodEnd(dd);
      if (!cutoff || cutoff >= todayIso) continue;

      // Cite a real TMW article if we cover this project, else its official website,
      // so the flipped 'Now Open' marker always links to something to verify against.
      const cov = coverageBySlug.get(String(p.slug || '').toLowerCase());
      const link = (cov && cov.link) || p.official_website || '';
      const note = cov ? `Now open — delivery ${dd} passed (coverage on TMW)`
        : (p.official_website ? `Now open — delivery ${dd} passed (official site)`
        : `Now open — delivery date ${dd} has passed`);

      const from = p.status;
      p.status = 'open';
      if (!Array.isArray(p.status_history)) p.status_history = [];
      p.status_history.push({
        at: nowIso,
        source_url: link || 'tmw://auto-promote',
        from, to: 'open',
        effective_date: dd,
        note,
      });
      p.status_checked_at = nowIso;
      promoted.push({ slug: p.slug, name: p.name, delivery_date: dd });
    }

    if (!promoted.length) return { ok: true, promoted: 0, slugs: [] };

    const summary = promoted.length === 1
      ? `Auto-promote: ${promoted[0].name} → open (delivery ${promoted[0].delivery_date} passed)`
      : `Auto-promote: ${promoted.length} projects → open (delivery dates passed)`;

    try {
      await ghPutFile(env, GH_PROJECTS_PATH, serializeProjects(projects), sha, summary);
    } catch (e) {
      if (e && e.status === 409 && attempt < 4) continue;
      throw e;
    }
    return { ok: true, promoted: promoted.length, slugs: promoted.map((p) => p.slug), date: todayIso };
  }
}

// One-time reconciliation: for every OPENED project, make delivery_date match the
// real opening date recorded in its dossier (the latest status_history to:'open'
// with a concrete effective_date). Fixes projects opened with a vaguer/stale
// delivery_date (year-only or a future estimate) so the radar shows the month.
// Never downgrades a more-precise existing date.
export async function syncOpenDeliveryDates(env) {
  requireGhToken(env);
  const concrete = (s) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(s || ''));
  for (let attempt = 0; ; attempt++) {
    const { sha, projects } = await readProjectsFile(env);
    const fixed = [];
    for (const p of projects) {
      if (!p || String(p.status || '').toLowerCase() !== 'open') continue;
      const hist = Array.isArray(p.status_history) ? p.status_history : [];
      let openDate = '';
      for (let i = hist.length - 1; i >= 0; i--) {
        const e = hist[i];
        if (e && String(e.to || '').toLowerCase() === 'open' && concrete(e.effective_date)) { openDate = String(e.effective_date); break; }
      }
      if (!openDate) continue;
      const cur = String(p.delivery_date || '').trim();
      if (cur === openDate) continue;
      // Adopt the opening date unless the current one is already MORE precise.
      if (concrete(cur) && cur.length > openDate.length) continue;
      p.delivery_date = openDate;
      p.delivery_speculative = false;
      fixed.push({ slug: p.slug, from: cur || '—', to: openDate });
    }
    if (!fixed.length) return { ok: true, fixed: 0 };
    try {
      await ghPutFile(env, GH_PROJECTS_PATH, serializeProjects(projects), sha, `Backfill: sync ${fixed.length} opened projects' delivery_date to their real opening date`);
    } catch (e) { if (e && e.status === 409 && attempt < 4) continue; throw e; }
    return { ok: true, fixed: fixed.length, sample: fixed.slice(0, 12) };
  }
}

// Linking a post to a project records the article as a COVERAGE date event on
// that project's dossier (status_history), flagged as a POTENTIAL progress
// update. Coverage events are factual (the article exists and is dated) — they
// are NOT construction milestones, so we never fabricate a phase/topping-out on
// a publish date (the hard invariant). A human/the construction-sweep confirms
// the coverage into a real status advance with the event's true date. Deduped by
// article link, so re-linking is a no-op. Fire-and-forget from the post handlers.
export async function recordArticleCoverage(env, opts) {
  const projectSlug = String((opts && opts.projectSlug) || '').toLowerCase().trim();
  const postSlug = String((opts && opts.postSlug) || '').trim();
  if (!projectSlug || !postSlug) return { ok: false, skipped: 'missing slug' };
  const link = 'https://www.oftmw.com/post/' + postSlug;
  const pubSec = Number(opts && opts.publishedAt) || 0;
  const pubIso = pubSec ? new Date(pubSec * 1000).toISOString() : '';
  const pubYmd = pubIso ? pubIso.slice(0, 10) : '';
  try {
    for (let attempt = 0; ; attempt++) {
      const { sha, projects } = await readProjectsFile(env);
      const p = projects.find((x) => String(x.slug || '').toLowerCase() === projectSlug);
      if (!p) return { ok: false, skipped: 'project not found', projectSlug };
      if (!Array.isArray(p.status_history)) p.status_history = [];
      if (p.status_history.some((e) => e && e.type === 'coverage' && e.source_url === link)) return { ok: true, deduped: true };
      const ev = {
        at: new Date().toISOString(),
        type: 'coverage',
        source_url: link,
        note: String((opts && opts.postTitle) || '').slice(0, 200) || 'TMW coverage',
        potential_progress_update: true,
      };
      if (pubIso) ev.source_published = pubIso;
      if (pubYmd) ev.effective_date = pubYmd;
      p.status_history.push(ev);
      try {
        await ghPutFile(env, GH_PROJECTS_PATH, serializeProjects(projects), sha, `Coverage: ${postSlug} → ${p.name || projectSlug} (potential progress update)`);
      } catch (e) { if (e && e.status === 409 && attempt < 4) continue; throw e; }
      return { ok: true, projectSlug, link };
    }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
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
  // Who is writing? The daily-articles routine authenticates with the static
  // token; interactive claude.ai sessions come through OAuth. Best-effort label
  // for the per-article scorecard (module-level: fine for attribution).
  _mcpActor = (env.STUDIO_MCP_TOKEN && token === env.STUDIO_MCP_TOKEN) ? 'claude-code-routine' : 'studio-connector';
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
