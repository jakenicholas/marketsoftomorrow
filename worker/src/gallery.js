// In-house image galleries — the Pixieset replacement for gallery.oftmw.com.
// build-stamp: gallery-v1
//
// This module owns everything served on the gallery.oftmw.com hostname:
//   • a public portfolio index (the public galleries)
//   • a per-gallery page (server-rendered, dark/glass to match /media/licensing)
//   • thumbnail resizing (Cloudflare image transforms, graceful fallback)
//   • PIN-gated original downloads (Pixieset-style: browse free, PIN unlocks)
//
// It also exposes admin routes (/admin/galleries…) consumed by the Studio
// gallery manager at journal/studio/galleries.html. Those are token-gated by
// the same requireAdminToken guard the rest of the worker uses, so they are
// reachable on ANY host (the studio calls the workers.dev origin).
//
// Storage model:
//   galleries        — one row per gallery (slug, title, visibility, pin…)
//   gallery_images   — ordered membership: which media.key belongs to which
//                      gallery, with per-image caption + sort order. The image
//                      bytes live in R2 (bucket `MEDIA`) exactly like every
//                      other uploaded asset; we only add the membership index.
//
// The worker stays the single origin: R2 is private and served by
// handleMediaServe, so downloads must flow through here anyway — which makes a
// same-origin PIN token the simplest, most robust gate.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

// ── schema bootstrap (matches the inline CREATE-TABLE-IF-NOT-EXISTS pattern
//    the worker already uses for media_folders / post views) ─────────────────
let _galleryTablesReady = false;
async function ensureGalleryTables(env) {
  if (_galleryTablesReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS galleries (
      slug              TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      subtitle          TEXT,
      description       TEXT,
      cover_key         TEXT,
      visibility        TEXT NOT NULL DEFAULT 'unlisted',  -- 'public' | 'unlisted'
      category          TEXT,
      location          TEXT,
      pin_hash          TEXT,                              -- null = no PIN
      pin               TEXT,                              -- plaintext PIN, admin-visible only
      download_enabled  INTEGER NOT NULL DEFAULT 1,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      shot_date         INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS gallery_images (
      gallery_slug  TEXT NOT NULL,
      media_key     TEXT NOT NULL,
      caption       TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (gallery_slug, media_key)
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gallery_images_slug ON gallery_images(gallery_slug, sort_order)`).run();
  // Lead capture: one row each time a visitor unlocks downloads with their email.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS gallery_downloads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL,
      gallery_slug  TEXT NOT NULL,
      gallery_title TEXT,
      created_at    INTEGER NOT NULL,
      user_agent    TEXT,
      country       TEXT
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gdl_created ON gallery_downloads(created_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gdl_slug ON gallery_downloads(gallery_slug, created_at DESC)`).run();
  // Migration: add the plaintext PIN column to pre-existing galleries tables.
  try { await env.DB.prepare(`ALTER TABLE galleries ADD COLUMN pin TEXT`).run(); } catch (_) { /* already exists */ }
  _galleryTablesReady = true;
}

// ── small helpers ───────────────────────────────────────────────────────────
function nowSec() { return Math.floor(Date.now() / 1000); }
function clampI(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pinSecret(env) { return env.SESSION_SECRET || env.ADMIN_TOKEN || 'tmw-gallery-fallback'; }

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPin(pin, slug) { return sha256hex(`${slug}:${pin}`); }

// Master PIN — unlocks (view + download) on EVERY gallery. Overridable via env.
function masterPin(env) { return String(env.MASTER_GALLERY_PIN || '2332'); }
// True when `input` satisfies a gallery's PIN: the gallery's own PIN or the
// master PIN. (Only meaningful when the gallery has a PIN set.)
async function pinOK(input, g, env) {
  const pin = String(input || '').trim();
  if (!pin) return false;
  if (pin === masterPin(env)) return true;
  if (!g.pin_hash) return true;
  return (await hashPin(pin, g.slug)) === g.pin_hash;
}

// ── View grant — a signed cookie that lets a visitor SEE a PIN-gated gallery
//    (separate from the download token). Minted by the /g/<slug> POST gate. ──
function viewCookieName(slug) { return 'tmwgv_' + slug; }
async function mintViewToken(slug, deps, env) {
  return deps.signPayload({ g: slug, s: 'view', exp: nowSec() + 30 * 86400 }, pinSecret(env));
}
async function viewTokenValid(token, slug, deps, env) {
  if (!token) return false;
  const obj = await deps.verifyPayload(token, pinSecret(env));
  return !!(obj && obj.s === 'view' && obj.g === slug);
}
function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('='); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function htmlResponse(html, init = {}) {
  return new Response(html, {
    status: init.status || 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': init.cache || 'public, max-age=60',
      ...(init.headers || {}),
    },
  });
}

// Normalize the media key so it round-trips cleanly through path segments.
function keyToPath(key) { return key.split('/').map(encodeURIComponent).join('/'); }

// ── Download tokens — a short signed grant (carries the captured email) that
//    the /dl route checks. Minted by /unlock after email (+ PIN) is provided. ─
async function mintDlToken(slug, email, deps, env) {
  return deps.signPayload({ g: slug, s: 'dl', e: email || '', exp: nowSec() + 86400 }, pinSecret(env));
}
async function dlTokenValid(token, slug, deps, env) {
  if (!token) return false;
  const obj = await deps.verifyPayload(token, pinSecret(env));
  return !!(obj && obj.s === 'dl' && obj.g === slug);
}
function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
}

// ── data access ─────────────────────────────────────────────────────────────
async function getGallery(env, slug) {
  return env.DB.prepare('SELECT * FROM galleries WHERE slug = ?1').bind(slug).first();
}
async function getGalleryImages(env, slug) {
  const r = await env.DB.prepare(`
    SELECT gi.media_key AS key, gi.caption, gi.sort_order,
           m.width, m.height, m.alt_text, m.filename, m.mime_type
    FROM gallery_images gi
    LEFT JOIN media m ON m.key = gi.media_key
    WHERE gi.gallery_slug = ?1
    ORDER BY gi.sort_order ASC, gi.created_at ASC
  `).bind(slug).all();
  return r.results || [];
}

// ===========================================================================
// PUBLIC PAGES
// ===========================================================================

// Shared <head> bits included by every gallery page (index, gallery, 404) — so
// the TMW favicon + fonts apply to current and future pages automatically.
const FAVICON = `<link rel="icon" type="image/png" href="https://www.oftmw.com/media/img/83809b6809e2.png"><link rel="apple-touch-icon" href="https://www.oftmw.com/media/img/83809b6809e2.png">`;
const FONTS = `${FAVICON}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,600;9..144,900&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">`;

const BASE_CSS = `
:root{
  --green:#1FDF67;--green-soft:#42EB81;--gold:#e6c574;--gold-soft:#f0d68a;
  --purple:#A78BFA;--purple-glow:#B9A6FF;
  --ink:#070807;--panel:#141714;--panel2:#1a1d1a;
  --hair:rgba(255,255,255,.08);--hair2:rgba(255,255,255,.14);
  --white:#fff;--cream:#ECEAE5;--mute:#9AA39C;--mute2:#C2C9C3;
  --sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  --serif:'Fraunces',Georgia,serif;--mono:'JetBrains Mono',ui-monospace,monospace;
  --glass:blur(16px) saturate(1.4);
}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:var(--ink);color:var(--cream);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.5;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(900px 600px at 78% -8%,rgba(31,223,103,.08),transparent 60%),
            radial-gradient(800px 700px at -10% 30%,rgba(111,168,255,.05),transparent 55%),
            radial-gradient(720px 520px at 6% 92%,rgba(230,197,116,.06),transparent 60%)}
.wrap{position:relative;z-index:1;max-width:1320px;margin:0 auto;padding:0 28px}
a{color:inherit}
.eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--green);font-weight:500}
h1,h2,h3{font-family:var(--serif);font-weight:600;letter-spacing:-.01em;line-height:1.05;color:var(--white)}
nav{position:fixed;top:0;left:0;right:0;z-index:50;padding:14px 0;background:rgba(7,8,7,.6);backdrop-filter:var(--glass);-webkit-backdrop-filter:var(--glass);border-bottom:1px solid var(--hair)}
nav .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px}
/* animated logo lockup — matches /media/licensing exactly */
.tmw-logo-lockup{display:flex;align-items:center;gap:8px;text-decoration:none}
.tmw-hex-badge{flex:0 0 auto;width:21px;height:21px}
.tmw-hex-badge svg{width:100%;height:100%;display:block;overflow:visible}
.tmw-hex-spinner{transform-origin:50% 50%;animation:tmw-hardspin 4.2s cubic-bezier(.16,1,.3,1) infinite}
@keyframes tmw-hardspin{0%{transform:rotate(0)}55%{transform:rotate(810deg)}70%{transform:rotate(900deg)}100%{transform:rotate(1080deg)}}
.tmw-hex-core{animation:tmw-hexpulse 4.2s ease-in-out infinite;transform-origin:50% 50%}
@keyframes tmw-hexpulse{0%,45%{stroke:var(--purple);filter:drop-shadow(0 0 0 rgba(167,139,250,0))}70%{stroke:var(--purple-glow);filter:drop-shadow(0 0 6px rgba(185,166,255,.9))}100%{stroke:var(--purple);filter:drop-shadow(0 0 0 rgba(167,139,250,0))}}
.tmw-hex-ring{transform-origin:50% 50%;animation:tmw-ring 4.2s ease-out infinite}
@keyframes tmw-ring{0%,60%{transform:scale(1);opacity:0}72%{opacity:.55}100%{transform:scale(1.7);opacity:0}}
.tmw-wordmark{flex:0 1 auto;width:92px;height:auto}
.tmw-wordmark svg{width:100%;height:auto;display:block}
.tmw-wordmark .wm-fill{fill:#fff}
.tmw-sweep{animation:tmw-sweep 4.2s ease-in-out infinite}
@keyframes tmw-sweep{0%,60%{transform:translateX(-40%);opacity:0}68%{opacity:1}100%{transform:translateX(140%);opacity:0}}
@media (prefers-reduced-motion: reduce){.tmw-hex-spinner{animation:tmw-fadespin 6s ease-in-out infinite}@keyframes tmw-fadespin{0%,100%{transform:rotate(0)}50%{transform:rotate(180deg)}}.tmw-sweep,.tmw-hex-ring{animation:none;opacity:0}}
.nav-right{display:flex;align-items:center;gap:18px}
.nav-link{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute2);text-decoration:none;transition:color .2s;white-space:nowrap}
.nav-link:hover{color:var(--cream)}
/* gold-glow CTA — matches the selected location filter pill (.pill.on) */
.nav-cta{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;padding:8px 15px;border-radius:999px;border:1px solid rgba(230,197,116,.34);background:rgba(230,197,116,.10);color:var(--gold-soft);text-decoration:none;white-space:nowrap;text-shadow:0 0 14px rgba(230,197,116,.5),0 0 3px rgba(230,197,116,.32);box-shadow:0 0 18px rgba(230,197,116,.16);transition:all .2s}
.nav-cta:hover{background:rgba(230,197,116,.16);border-color:rgba(230,197,116,.5);transform:translateY(-1px)}
footer{border-top:1px solid var(--hair);margin-top:90px;padding:34px 0 60px}
footer .wrap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;color:var(--mute)}
footer a{color:var(--green);text-decoration:none}
@media(max-width:640px){.nav-link{display:none}}
`;

// Full animated logo lockup (hex badge + wordmark), identical to /media/licensing.
const LOGO_LOCKUP = `<div class="tmw-hex-badge" aria-hidden="true"><svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon class="tmw-hex-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/><g class="tmw-hex-spinner"><polygon class="tmw-hex-core" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/></g></svg></div><div class="tmw-wordmark" aria-hidden="true"><svg viewBox="100 60 900 410" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tmw-sweepgrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#A78BFA" stop-opacity="0"/><stop offset="50%" stop-color="#B9A6FF" stop-opacity="1"/><stop offset="100%" stop-color="#A78BFA" stop-opacity="0"/></linearGradient><clipPath id="tmw-wmclip"><path d="M233.5,220.4l1.1-105.9-.4-.4-30.2,106.3h-23.9l-30.6-107.2,1.1,107.2h-33.3V79h46.4l28.1,93.1h.4l27.7-93.1h46.6v141.4h-33.3Z"/><path d="M383.6,220.4l-6.9-20.5h-49.1l-7.5,20.5h-38.8l56.8-141.4h28.5l56.2,141.4h-39.2ZM352.6,123.1l-.6-.2-14.5,48.4h29.6l-14.5-48.2Z"/><path d="M504.9,220.4l-32.7-45.7h-.4v45.7h-34.6V79h46.3c14.7,0,26,1.9,33.4,5.2,15.3,6.9,26,23.5,26,43.6s-13.4,40.7-35.2,44.5l38.4,48.2h-41.3ZM485.3,150.1c14.3,0,23.1-6.7,23.1-20.3s-9.2-19.1-22.7-19.1h-13.8v39.4h13.4Z"/><path d="M641,220.4l-38.6-61.2h-.4v61.2h-36.1V79h36.1v63.6h.4l39.9-63.6h37.8l-46.8,70.5,49.9,70.9h-42.2Z"/><path d="M697.2,220.4V79h78.6v31.7h-44v22h42.6v31.7h-42.6v24.3h44v31.7h-78.6Z"/><path d="M815.1,220.4v-109.7h-27.9v-31.7h91.7v31.7h-27.7v109.7h-36.1Z"/><path d="M948.9,120.3c-1.5-10.1-5.7-13.8-12.8-13.8s-12.4,4.8-12.4,11.1,7.6,12.2,23.1,18.9c31.2,13.4,39,24.7,39,43.2,0,27.3-18.7,43.4-49.3,43.4s-51-16.1-51-46.4v-3.1h35.9c.2,11.7,5.9,19.3,14.9,19.3s13.6-5.9,13.6-13.6c0-11.3-15.7-16.2-28.5-21.4-23.1-9.4-33.6-21.6-33.6-39.9s23.3-41.7,49.3-41.7,17.6,2.1,25,5.9c15.1,7.8,22.4,19.1,22.6,38h-35.7Z"/><path d="M333.7,452.5v-169.1h-43v-48.9h141.4v48.9h-42.7v169.1h-55.7Z"/><path d="M633.3,452.5l1.8-163.2-.6-.6-46.5,163.8h-36.8l-47.1-165.3,1.8,165.3h-51.3v-218h71.6l43.3,143.5h.6l42.7-143.5h71.9v218h-51.3Z"/><path d="M881.6,452.5l-32.7-141.1h-.6l-32.7,141.1h-50.4l-56.3-218h56.6l29.2,141.7h.6l32.1-141.7h42.7l31.5,142.3h.6l29.8-142.3h56.3l-57.7,218h-48.9Z"/><path d="M111.8,281.1c0-27.9,20.1-48.8,47.4-48.8s47.6,20.3,47.6,46.1-20.7,47.3-46.5,47.3-48.5-18-48.5-44.6ZM183.8,279.2c0-14.1-10.1-26.6-24.6-26.6s-24.4,12-24.4,26.3,10.1,26.8,24.8,26.8,24.2-12,24.2-26.4Z"/><path d="M219.2,324.1v-90h49.1v20.2h-27.1v15.3h26.2v20.2h-26.2v34.3h-22Z"/></clipPath></defs><g class="wm-fill"><path d="M233.5,220.4l1.1-105.9-.4-.4-30.2,106.3h-23.9l-30.6-107.2,1.1,107.2h-33.3V79h46.4l28.1,93.1h.4l27.7-93.1h46.6v141.4h-33.3Z"/><path d="M383.6,220.4l-6.9-20.5h-49.1l-7.5,20.5h-38.8l56.8-141.4h28.5l56.2,141.4h-39.2ZM352.6,123.1l-.6-.2-14.5,48.4h29.6l-14.5-48.2Z"/><path d="M504.9,220.4l-32.7-45.7h-.4v45.7h-34.6V79h46.3c14.7,0,26,1.9,33.4,5.2,15.3,6.9,26,23.5,26,43.6s-13.4,40.7-35.2,44.5l38.4,48.2h-41.3ZM485.3,150.1c14.3,0,23.1-6.7,23.1-20.3s-9.2-19.1-22.7-19.1h-13.8v39.4h13.4Z"/><path d="M641,220.4l-38.6-61.2h-.4v61.2h-36.1V79h36.1v63.6h.4l39.9-63.6h37.8l-46.8,70.5,49.9,70.9h-42.2Z"/><path d="M697.2,220.4V79h78.6v31.7h-44v22h42.6v31.7h-42.6v24.3h44v31.7h-78.6Z"/><path d="M815.1,220.4v-109.7h-27.9v-31.7h91.7v31.7h-27.7v109.7h-36.1Z"/><path d="M948.9,120.3c-1.5-10.1-5.7-13.8-12.8-13.8s-12.4,4.8-12.4,11.1,7.6,12.2,23.1,18.9c31.2,13.4,39,24.7,39,43.2,0,27.3-18.7,43.4-49.3,43.4s-51-16.1-51-46.4v-3.1h35.9c.2,11.7,5.9,19.3,14.9,19.3s13.6-5.9,13.6-13.6c0-11.3-15.7-16.2-28.5-21.4-23.1-9.4-33.6-21.6-33.6-39.9s23.3-41.7,49.3-41.7,17.6,2.1,25,5.9c15.1,7.8,22.4,19.1,22.6,38h-35.7Z"/><path d="M333.7,452.5v-169.1h-43v-48.9h141.4v48.9h-42.7v169.1h-55.7Z"/><path d="M633.3,452.5l1.8-163.2-.6-.6-46.5,163.8h-36.8l-47.1-165.3,1.8,165.3h-51.3v-218h71.6l43.3,143.5h.6l42.7-143.5h71.9v218h-51.3Z"/><path d="M881.6,452.5l-32.7-141.1h-.6l-32.7,141.1h-50.4l-56.3-218h56.6l29.2,141.7h.6l32.1-141.7h42.7l31.5,142.3h.6l29.8-142.3h56.3l-57.7,218h-48.9Z"/><path d="M111.8,281.1c0-27.9,20.1-48.8,47.4-48.8s47.6,20.3,47.6,46.1-20.7,47.3-46.5,47.3-48.5-18-48.5-44.6ZM183.8,279.2c0-14.1-10.1-26.6-24.6-26.6s-24.4,12-24.4,26.3,10.1,26.8,24.8,26.8,24.2-12,24.2-26.4Z"/><path d="M219.2,324.1v-90h49.1v20.2h-27.1v15.3h26.2v20.2h-26.2v34.3h-22Z"/></g><g clip-path="url(#tmw-wmclip)"><rect class="tmw-sweep" x="100" y="60" width="240" height="410" fill="url(#tmw-sweepgrad)"/></g></svg></div>`;

// White lock icon (PIN indicator).
const LOCK_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

// Download icon — shared by "Download all" and the lightbox download button.
const DL_ICON = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1v9m0 0L4.5 6.5M8 10l3.5-3.5M2 13.5h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function navHTML(base, activeCta) {
  return `<nav><div class="wrap">
    <a class="tmw-logo-lockup" href="${base}/" aria-label="Markets of Tomorrow">${LOGO_LOCKUP}</a>
    <div class="nav-right">
      <a class="nav-link" href="https://www.oftmw.com/media/">Media Kit</a>
      <a class="nav-link" href="https://www.oftmw.com/media/licensing/">Licensing</a>
      <a class="nav-cta" href="${activeCta || 'https://www.oftmw.com/media/licensing/#cta'}">Request a quote</a>
    </div>
  </div></nav>`;
}

function footerHTML() {
  return `<footer><div class="wrap">
    <div>Markets of Tomorrow &middot; Visual Portfolio &middot; West Palm Beach, FL</div>
    <div><a href="https://www.oftmw.com/media/">Media Kit</a> &middot; <a href="https://www.oftmw.com/media/licensing/">Licensing &amp; Rights</a> &middot; <a href="https://www.instagram.com/marketsoftomorrow" target="_blank" rel="noopener">@marketsoftomorrow</a></div>
  </div></footer>`;
}

// Portfolio index — the public galleries, as a cover-image grid.
function renderIndexHTML(galleries, base) {
  const cards = galleries.map(g => {
    const coverKey = g.cover_key || g.first_key;  // fall back to the first photo
    const cover = coverKey
      ? `<img loading="eager" decoding="async" src="${base}/thumb/${keyToPath(coverKey)}?w=900" alt="${esc(g.title)}">`
      : `<div class="noimg"></div>`;
    const meta = [g.category, g.location].filter(Boolean).map(esc).join(' &middot; ');
    const lock = g.pin_hash ? `<span class="lock" title="Download PIN required">${LOCK_SVG}</span>` : '';
    return `<a class="card" href="${base}/g/${esc(g.slug)}">
      <div class="card-img">${cover}${lock}<span class="count">${g.image_count || 0} photos</span></div>
      <div class="card-body">
        <div class="card-title">${esc(g.title)}</div>
        ${meta ? `<div class="card-meta">${meta}</div>` : ''}
      </div>
    </a>`;
  }).join('');

  const empty = `<div class="empty"><div class="eyebrow">Portfolio</div><p>New work is being added. Check back shortly &mdash; or <a href="https://www.oftmw.com/media/licensing/#cta">commission a shoot</a>.</p></div>`;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Portfolio &mdash; Markets of Tomorrow</title>
<meta name="description" content="World-class hospitality, resort, and golf photography and film by Markets of Tomorrow.">
<meta property="og:title" content="Markets of Tomorrow — Visual Portfolio">
<meta property="og:type" content="website">
${FONTS}
<style>${BASE_CSS}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;padding:112px 0 10px}
.card{text-decoration:none;display:block;border-radius:16px;overflow:hidden;background:rgba(255,255,255,.03);border:1px solid var(--hair);transition:transform .35s cubic-bezier(.22,1,.36,1),border-color .35s}
.card:hover{transform:translateY(-4px);border-color:var(--hair2)}
.card-img{position:relative;aspect-ratio:4/3;overflow:hidden;background:var(--panel)}
.card-img img{width:100%;height:100%;object-fit:cover;transition:transform .6s cubic-bezier(.22,1,.36,1)}
.card:hover .card-img img{transform:scale(1.05)}
.card-img .noimg{width:100%;height:100%;background:linear-gradient(135deg,var(--panel),var(--panel2))}
.card-img .count{position:absolute;left:12px;bottom:12px;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--cream);background:rgba(7,8,7,.6);backdrop-filter:blur(8px);padding:5px 9px;border-radius:999px}
.card-img .lock{position:absolute;right:12px;top:12px;font-size:14px;background:rgba(7,8,7,.6);backdrop-filter:blur(8px);width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:999px}
.card-body{padding:16px 18px 20px}
.card-title{font-family:var(--serif);font-weight:600;font-size:20px;color:#fff;letter-spacing:-.01em}
.card-meta{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin-top:7px}
.empty{padding:160px 0 80px;text-align:center;color:var(--mute2)}
.empty p{margin-top:16px;font-size:17px}.empty a{color:var(--green);text-decoration:none}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.grid{grid-template-columns:1fr}}
</style></head><body>
${navHTML(base)}
<main class="wrap">
  ${galleries.length ? `<div class="grid">${cards}</div>` : empty}
</main>
${footerHTML()}
</body></html>`;
}

// Per-gallery page — server-rendered grid + lightbox + PIN download flow.
function renderGalleryHTML(g, images, base) {
  const noindex = g.visibility !== 'public'
    ? `<meta name="robots" content="noindex,nofollow,noarchive">` : '';
  const meta = [g.category, g.location].filter(Boolean).map(esc).join(' &middot; ');
  const pinRequired = !!g.pin_hash;
  const downloadEnabled = g.download_enabled !== 0;

  // Split into photos and videos by mime type. The Videos tab only renders when
  // at least one video is present.
  const isVid = (im) => (im.mime_type || '').startsWith('video/');
  const photos = images.filter(im => !isVid(im));
  const videos = images.filter(isVid);

  const itemJson = (im) => ({
    key: im.key, caption: im.caption || '', alt: im.alt_text || g.title,
    filename: im.filename || '', type: isVid(im) ? 'video' : 'image',
  });
  // Inline both lists so the page renders in one request.
  const data = JSON.stringify({
    slug: g.slug, pinRequired, downloadEnabled,
    photos: photos.map(itemJson),
    videos: videos.map(itemJson),
  }).replace(/</g, '\\u003c');

  const photoTile = (im, i) => {
    // Eager-load the first screenful so thumbnails appear immediately; lazy for
    // the rest. srcset+sizes keeps tiles crisp on Retina without over-fetching.
    const load = i < 8 ? 'eager' : 'lazy';
    const tp = `${base}/thumb/${keyToPath(im.key)}`;
    const srcset = `${tp}?w=700 700w, ${tp}?w=1100 1100w, ${tp}?w=1500 1500w, ${tp}?w=2000 2000w`;
    return `<button class="tile" data-set="photo" data-i="${i}" aria-label="View photo ${i + 1}">
      <img loading="${load}" decoding="async" src="${tp}?w=1100" srcset="${srcset}" sizes="(max-width:480px) 92vw, (min-width:2000px) 30vw, 45vw" alt="${esc(im.alt_text || g.title)}">
    </button>`;
  };
  const videoTile = (im, i) => {
    // Cropped first-frame preview + play badge. preload=metadata stays light
    // (Range-served); #t=0.1 nudges the browser to paint an actual frame.
    const vp = `${base}/v/${keyToPath(im.key)}`;
    return `<button class="tile vid" data-set="video" data-i="${i}" aria-label="Play video ${i + 1}">
      <video src="${vp}#t=0.1" preload="metadata" muted playsinline tabindex="-1"></video>
      <span class="play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
    </button>`;
  };
  const photoTiles = photos.map(photoTile).join('');
  const videoTiles = videos.map(videoTile).join('');
  const hasMedia = photos.length + videos.length > 0;

  const ogImg = g.cover_key || (images[0] && images[0].key);

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(g.title)} &mdash; Markets of Tomorrow</title>
<meta name="description" content="${esc(g.subtitle || g.description || g.title)}">
${noindex}
${ogImg ? `<meta property="og:image" content="https://gallery.oftmw.com/thumb/${keyToPath(ogImg)}?w=1200">` : ''}
<meta property="og:title" content="${esc(g.title)} — Markets of Tomorrow">
${FONTS}
<style>${BASE_CSS}
/* hero cover banner — the first image with a title + button overlay */
.hero{position:relative;min-height:88vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden}
.hero-bg{position:absolute;inset:0;z-index:0;background:linear-gradient(135deg,var(--panel),var(--panel2))}
.hero-bg img{width:100%;height:100%;object-fit:cover;object-position:center}
.hero-bg::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 95% at 50% 34%,rgba(7,8,7,.26),rgba(7,8,7,.55) 82%),linear-gradient(180deg,rgba(7,8,7,.5),transparent 26%,transparent 52%,var(--ink))}
.hero-inner{position:relative;z-index:2;max-width:1000px;padding:90px 28px 0}
.hero-eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold-soft);text-shadow:0 0 18px rgba(230,197,116,.4);margin-bottom:20px}
.hero h1{font-family:var(--sans);font-weight:600;font-size:clamp(40px,7.5vw,96px);letter-spacing:.04em;text-transform:uppercase;line-height:1.02;color:#fff;text-shadow:0 4px 60px rgba(0,0,0,.5)}
.hero-sub{font-family:var(--mono);font-weight:400;font-size:clamp(11px,1.1vw,13px);letter-spacing:.18em;text-transform:uppercase;color:var(--cream);margin-top:18px;text-shadow:0 2px 20px rgba(0,0,0,.5)}
.hero-btn{margin-top:34px;font-family:var(--mono);font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:600;padding:15px 34px;border-radius:0;border:1px solid rgba(255,255,255,.6);background:transparent;color:#fff;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;gap:9px;transition:all .2s}
.hero-btn:hover{background:#fff;color:#0a0a0a;border-color:#fff}
.hero-scroll{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);z-index:2;color:rgba(255,255,255,.7);animation:herobob 2.2s ease-in-out infinite}
.hero-scroll svg{width:26px;height:26px}
@keyframes herobob{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(7px)}}
@media(prefers-reduced-motion:reduce){.hero-scroll{animation:none}}
/* sub-bar above the grid: back + meta on the left, Download-all on the right */
#photos{scroll-margin-top:70px}
.gsub{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:34px 0 0}
.gsub-left{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.back{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute2);text-decoration:none}
.back:hover{color:var(--cream)}
.gmeta{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.gmeta .dot{opacity:.4}
.btn{font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;padding:11px 18px;border-radius:999px;border:1px solid var(--hair2);background:rgba(255,255,255,.04);color:var(--cream);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;transition:background .2s,transform .2s,border-color .2s}
.btn:hover{background:rgba(255,255,255,.08);transform:translateY(-1px)}
.btn.primary{background:var(--green);color:var(--ink);border-color:var(--green)}
.btn.primary:hover{background:var(--green-soft)}
.btn.gold{border-color:rgba(230,197,116,.4);color:var(--gold-soft)}
.btn .ic{width:15px;height:15px}
/* uniform grid — large, wide, square-edged tiles, all cropped to one height.
   2 columns by default, 3 on wide screens, 1 on narrow phones. Fixed
   aspect-ratio gives each tile a definite height so images reserve space and
   actually load (lazy images with no height never trigger). */
.masonry{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;padding:24px 0 0}
@media(min-width:2000px){.masonry{grid-template-columns:repeat(3,1fr)}}
@media(max-width:480px){.masonry{grid-template-columns:1fr}}
.tile{display:block;width:100%;margin:0;padding:0;border:0;border-radius:0;overflow:hidden;cursor:zoom-in;background:var(--panel);position:relative;line-height:0;aspect-ratio:3/2}
.tile img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s cubic-bezier(.22,1,.36,1)}
.tile:hover img{transform:scale(1.04)}
/* video tiles — cropped first frame + play badge (same size as photos) */
.tile.vid video{width:100%;height:100%;object-fit:cover;display:block;background:#000;pointer-events:none}
.tile .play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.tile .play svg{width:54px;height:54px;color:#fff;opacity:.92;filter:drop-shadow(0 2px 12px rgba(0,0,0,.55));transition:transform .25s}
.tile.vid:hover .play svg{transform:scale(1.1)}
/* Photos / Videos tabs */
.gtabs{display:flex;gap:0;padding:30px 0 0}
.gtab{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--mute);background:none;border:0;border-bottom:2px solid transparent;padding:8px 2px 12px;margin-right:26px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:color .2s,border-color .2s}
.gtab span{font-size:10px;opacity:.6}
.gtab:hover{color:var(--cream)}
.gtab.on{color:#fff;border-color:#fff}
.masonry.tabpane{padding-top:18px}
.masonry[hidden]{display:none}  /* author rule must beat .masonry{display:grid} for the hidden pane */
/* lightbox */
.lb{position:fixed;inset:0;z-index:100;background:rgba(5,6,5,.96);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center}
.lb.open{display:flex}
.lb img{max-width:92vw;max-height:84vh;object-fit:contain;border-radius:6px;box-shadow:0 30px 90px rgba(0,0,0,.6)}
.lb video{max-width:92vw;max-height:84vh;background:#000;box-shadow:0 30px 90px rgba(0,0,0,.6)}
.lb-cap{position:fixed;left:0;right:0;bottom:22px;text-align:center;font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--mute2);padding:0 20px}
.lb-x,.lb-prev,.lb-next,.lb-dl{position:fixed;background:rgba(255,255,255,.07);border:1px solid var(--hair2);color:var(--cream);width:46px;height:46px;border-radius:999px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;transition:background .2s}
.lb-x:hover,.lb-prev:hover,.lb-next:hover,.lb-dl:hover{background:rgba(255,255,255,.16)}
.lb-x{top:20px;right:20px}.lb-dl{top:20px;right:78px;font-size:15px}
.lb-prev{left:20px;top:50%;transform:translateY(-50%)}
.lb-next{right:20px;top:50%;transform:translateY(-50%)}
@media(max-width:640px){.lb-prev,.lb-next{display:none}}
/* PIN modal */
.modal{position:fixed;inset:0;z-index:120;background:rgba(5,6,5,.8);backdrop-filter:blur(10px);display:none;align-items:center;justify-content:center;padding:20px}
.modal.open{display:flex}
.modal-card{background:var(--panel);border:1px solid var(--hair2);border-radius:18px;padding:34px 32px;max-width:380px;width:100%;text-align:center;box-shadow:0 30px 90px rgba(0,0,0,.6)}
.modal-card .eyebrow{display:block;margin-bottom:10px}
.modal-card h3{font-size:24px;margin-bottom:8px}
.modal-card p{color:var(--mute2);font-size:14px;margin-bottom:20px}
.modal-card input{width:100%;text-align:center;font-family:var(--mono);font-size:22px;letter-spacing:.3em;padding:14px;border-radius:12px;border:1px solid var(--hair2);background:var(--ink);color:#fff;outline:none}
.modal-card input.email{font-family:var(--sans);font-size:15px;letter-spacing:.01em}
.modal-card input:focus{border-color:var(--green)}
.modal-card .err{color:#ff6b6b;font-size:12.5px;font-family:var(--mono);min-height:18px;margin-top:10px}
.modal-card .row{display:flex;gap:10px;margin-top:16px}
.modal-card .row .btn{flex:1;justify-content:center}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--panel2);border:1px solid var(--hair2);color:var(--cream);padding:12px 20px;border-radius:999px;font-family:var(--mono);font-size:12px;letter-spacing:.04em;opacity:0;pointer-events:none;transition:opacity .3s,transform .3s;z-index:130}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.licstrip{margin-top:30px;border:1px solid rgba(230,197,116,.3);background:linear-gradient(180deg,rgba(230,197,116,.06),rgba(230,197,116,.02));border-radius:18px;padding:24px 30px;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}
.licstrip .lt{font-family:var(--serif);font-size:clamp(18px,1.9vw,24px);color:#fff;max-width:46ch}
.licstrip .lt b{color:var(--gold-soft)}
.empty2{padding:60px 0;color:var(--mute2);font-size:16px}
/* wide content wrap so images fill ~90% of the screen */
.gwrap{position:relative;z-index:1;width:90%;max-width:1800px;margin:0 auto}
/* header row: title block left, Download-all top-right */
.ghead-top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;flex-wrap:wrap}
.ghead-info{flex:1;min-width:0}
/* plain Download-all — white text + icon, no bg, no border */
.dl-all{flex:0 0 auto;background:none;border:0;color:#fff;font-family:var(--mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;padding:6px 2px;transition:opacity .2s}
.dl-all:hover{opacity:.65}
.dl-all svg{width:15px;height:15px}
.lb-dl svg{width:18px;height:18px}
</style></head><body>
${navHTML(base)}
<header class="hero">
  <div class="hero-bg">${ogImg ? `<img loading="eager" src="${base}/thumb/${keyToPath(ogImg)}?w=2000" alt="${esc(g.title)}">` : ''}</div>
  <div class="hero-inner">
    ${meta ? `<div class="hero-eyebrow">${meta}</div>` : ''}
    <h1>${esc(g.title)}</h1>
    ${g.subtitle ? `<div class="hero-sub">${esc(g.subtitle)}</div>` : ''}
    ${images.length ? `<a class="hero-btn" href="#photos">View gallery</a>` : ''}
  </div>
  ${images.length ? `<a class="hero-scroll" href="#photos" aria-label="View gallery"><svg viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ''}
</header>
<div class="gwrap" id="photos">
  <div class="gsub">
    <div class="gsub-left">
      <a class="back" href="${base}/">&larr;&nbsp;All galleries</a>
      <span class="gmeta">
        ${photos.length ? `<span>${photos.length} photo${photos.length === 1 ? '' : 's'}</span>` : ''}
        ${videos.length ? `${photos.length ? '<span class="dot">&bull;</span>' : ''}<span>${videos.length} video${videos.length === 1 ? '' : 's'}</span>` : ''}
        ${pinRequired ? `<span class="dot">&bull;</span><span style="display:inline-flex;align-items:center;gap:6px">${LOCK_SVG} PIN to download</span>` : ''}
      </span>
    </div>
    ${hasMedia && downloadEnabled ? `<button class="dl-all" id="dlAll">${DL_ICON}Download all</button>` : ''}
  </div>
  <div class="licstrip">
    <div class="lt">Found a frame you love? <b>License it</b> for your website, campaign, or full buyout.</div>
    <a class="btn gold" href="https://www.oftmw.com/media/licensing/">See licensing &amp; rights</a>
  </div>
  ${hasMedia ? `
    ${videos.length ? `<div class="gtabs" role="tablist">
      ${photos.length ? `<button class="gtab on" data-tab="photo">Photos <span>${photos.length}</span></button>` : ''}
      <button class="gtab ${photos.length ? '' : 'on'}" data-tab="video">Videos <span>${videos.length}</span></button>
    </div>` : ''}
    ${photos.length ? `<div class="masonry tabpane" data-pane="photo">${photoTiles}</div>` : ''}
    ${videos.length ? `<div class="masonry tabpane" data-pane="video"${photos.length ? ' hidden' : ''}>${videoTiles}</div>` : ''}
  ` : `<div class="empty2">No media in this gallery yet.</div>`}
</div>
${footerHTML()}

<div class="lb" id="lb">
  <div class="lb-x" id="lbX" role="button" aria-label="Close">&times;</div>
  <div class="lb-dl" id="lbDl" role="button" aria-label="Download" title="Download">${DL_ICON}</div>
  <div class="lb-prev" id="lbPrev" role="button" aria-label="Previous">&#8249;</div>
  <div class="lb-next" id="lbNext" role="button" aria-label="Next">&#8250;</div>
  <img id="lbImg" alt="">
  <video id="lbVid" controls playsinline preload="auto" style="display:none"></video>
  <div class="lb-cap" id="lbCap"></div>
</div>

<div class="modal" id="dlModal">
  <div class="modal-card">
    <span class="eyebrow">Download</span>
    <h3>Enter your email to download</h3>
    <p>Add your email to download${pinRequired ? ', plus the gallery PIN shared with you' : ''}. We'll remember it on this device.</p>
    <form id="dlForm" novalidate style="margin:0">
      <input id="emailInput" class="email" type="email" name="email" inputmode="email" autocomplete="email" placeholder="you@email.com">
      ${pinRequired ? `<input id="pinInput" name="pin" inputmode="numeric" autocomplete="off" placeholder="Gallery PIN" maxlength="12" style="margin-top:10px">` : ''}
      <div class="err" id="dlErr"></div>
      <div class="row">
        <button class="btn" id="dlCancel" type="button">Cancel</button>
        <button class="btn primary" id="dlGo" type="submit">Download</button>
      </div>
    </form>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const G = ${data};
const BASE = ${JSON.stringify(base)};
const tokenKey = 'tmw_gpin_' + G.slug;
function getToken(){ try{return sessionStorage.getItem(tokenKey)||'';}catch(_){return '';} }
function setToken(t){ try{sessionStorage.setItem(tokenKey,t);}catch(_){} }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600); }

const enc=k=>k.split('/').map(encodeURIComponent).join('/');
function items(set){ return set==='video'?G.videos:G.photos; }

/* ---- Tabs ---- */
let curSet = G.photos.length ? 'photo' : 'video';
document.querySelectorAll('.gtab').forEach(b=>b.onclick=()=>{
  curSet=b.dataset.tab;
  document.querySelectorAll('.gtab').forEach(x=>x.classList.toggle('on',x===b));
  document.querySelectorAll('[data-pane]').forEach(p=>p.hidden=(p.dataset.pane!==curSet));
});

/* ---- Lightbox ---- */
const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbVid=document.getElementById('lbVid'),lbCap=document.getElementById('lbCap');
let lbSet='photo',cur=-1;
function show(set,i){
  const list=items(set); if(i<0||i>=list.length)return; lbSet=set; cur=i; const im=list[i];
  if(im.type==='video'){
    lbImg.style.display='none'; lbImg.removeAttribute('src');
    lbVid.style.display=''; lbVid.src=BASE+'/v/'+enc(im.key); lbVid.play().catch(()=>{});
  }else{
    lbVid.pause(); lbVid.removeAttribute('src'); lbVid.style.display='none';
    lbImg.style.display=''; lbImg.src=BASE+'/thumb/'+enc(im.key)+'?w=2200'; lbImg.alt=im.alt||'';
  }
  lbCap.textContent=(im.caption||'')+'  '+(i+1)+' / '+list.length;
  lb.classList.add('open'); document.body.style.overflow='hidden';
}
function close(){ lb.classList.remove('open'); document.body.style.overflow=''; cur=-1; lbVid.pause(); lbVid.removeAttribute('src'); }
function step(d){ const list=items(lbSet); if(list.length)show(lbSet,(cur+d+list.length)%list.length); }
document.getElementById('photos').addEventListener('click',e=>{
  const t=e.target.closest('.tile'); if(t)show(t.dataset.set,+t.dataset.i);
});
document.getElementById('lbX').onclick=close;
document.getElementById('lbPrev').onclick=()=>step(-1);
document.getElementById('lbNext').onclick=()=>step(1);
lb.addEventListener('click',e=>{ if(e.target===lb)close(); });
addEventListener('keydown',e=>{
  if(!lb.classList.contains('open'))return;
  if(e.key==='Escape')close();
  if(e.key==='ArrowLeft')step(-1);
  if(e.key==='ArrowRight')step(1);
});
document.getElementById('lbDl').onclick=()=>{ if(cur>=0)requestDownload([items(lbSet)[cur]]); };

/* ---- Download + email/PIN flow ---- */
const emailKey='tmw_gemail';
function getEmail(){ try{return localStorage.getItem(emailKey)||'';}catch(_){return '';} }
function setEmail(v){ try{localStorage.setItem(emailKey,v);}catch(_){} }
let pending=null;
function dlUrl(im){
  const t=getToken();
  return BASE+'/dl/'+G.slug+'/'+enc(im.key)+(t?('?t='+encodeURIComponent(t)):'');
}
async function doDownloads(list){
  for(const im of list){
    const a=document.createElement('a'); a.href=dlUrl(im); a.download=im.filename||'';
    document.body.appendChild(a); a.click(); a.remove();
    await new Promise(r=>setTimeout(r,500)); // stagger so the browser queues each
  }
  toast(list.length>1?('Downloading '+list.length+' files…'):'Downloading…');
}
async function tokenStillValid(im){
  try{ const probe=await fetch(dlUrl(im),{method:'HEAD'}); return probe.status!==401; }catch(_){ return true; }
}
async function requestDownload(list){
  if(!G.downloadEnabled){ toast('Downloads are disabled for this gallery'); return; }
  if(!list||!list.length)return;
  if(getToken() && await tokenStillValid(list[0])){ doDownloads(list); return; }
  pending=list; openDl();
}
const dlAllBtn=document.getElementById('dlAll');
if(dlAllBtn)dlAllBtn.onclick=()=>requestDownload(items(curSet));

/* ---- Download modal: email (always) + PIN (when required) ---- */
const modal=document.getElementById('dlModal'),emailInput=document.getElementById('emailInput'),pinInput=document.getElementById('pinInput'),dlErr=document.getElementById('dlErr');
function openDl(){ dlErr.textContent=''; emailInput.value=getEmail(); if(pinInput)pinInput.value=''; modal.classList.add('open'); setTimeout(()=>{ ((getEmail()&&pinInput)?pinInput:emailInput).focus(); },50); }
function closeDl(){ modal.classList.remove('open'); }
document.getElementById('dlCancel').onclick=closeDl;
modal.addEventListener('click',e=>{ if(e.target===modal)closeDl(); });
// Submit via the <form> so Enter and the Download button both go through native
// form submission. On iOS Safari, an autofilled value isn't exposed to JS until
// the field gets a gesture — but a real form submit commits it, and FormData
// then reads it reliably. (A button .onclick read .value too early → empty →
// the "Enter a valid email" false negative on autofilled emails.)
document.getElementById('dlForm').addEventListener('submit',e=>{ e.preventDefault(); submitDl(); });
async function submitDl(){
  let email='', pin='';
  try{ const fd=new FormData(document.getElementById('dlForm')); email=String(fd.get('email')||''); pin=String(fd.get('pin')||''); }catch(_){}
  email=(email||emailInput.value||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ dlErr.textContent='Enter a valid email'; emailInput.focus(); return; }
  pin=(pin||(pinInput?pinInput.value:'')||'').trim();
  if(G.pinRequired && !pin){ dlErr.textContent='Enter the gallery PIN'; pinInput.focus(); return; }
  dlErr.textContent='Checking…';
  try{
    const r=await fetch(BASE+'/api/gallery/'+G.slug+'/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,pin})});
    const j=await r.json();
    if(r.ok&&j.token){ setToken(j.token); setEmail(email); closeDl(); const list=pending||items(curSet); pending=null; doDownloads(list); }
    else if(j.error==='wrong_pin'){ dlErr.textContent='Incorrect PIN — try again'; }
    else if(j.error==='bad_email'){ dlErr.textContent='Enter a valid email'; }
    else{ dlErr.textContent='Could not verify — try again'; }
  }catch(_){ dlErr.textContent='Network error — try again'; }
}
</script>
</body></html>`;
}

// ===========================================================================
// PUBLIC API + ASSET ROUTES
// ===========================================================================

// POST /api/gallery/<slug>/unlock {email, pin} — capture the visitor's email
// (required for every download), verify the PIN when the gallery has one, log
// the lead, and mint a download token.
async function apiUnlock(request, env, slug, deps, origin) {
  const g = await getGallery(env, slug);
  if (!g) return deps.json({ error: 'not_found' }, { status: 404 }, env, origin);
  let body;
  try { body = await request.json(); } catch { return deps.json({ error: 'bad_request' }, { status: 400 }, env, origin); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!validEmail(email)) return deps.json({ error: 'bad_email' }, { status: 400 }, env, origin);

  if (g.pin_hash) {
    const pin = String(body.pin || '').trim();
    if (!pin) return deps.json({ error: 'pin_required' }, { status: 403 }, env, origin);
    if (!(await pinOK(pin, g, env))) return deps.json({ error: 'wrong_pin' }, { status: 403 }, env, origin);
  }

  // Log the lead (best-effort; never block the download on a logging failure).
  try {
    await env.DB.prepare(
      'INSERT INTO gallery_downloads (email, gallery_slug, gallery_title, created_at, user_agent, country) VALUES (?1,?2,?3,?4,?5,?6)'
    ).bind(
      email, slug, g.title || null, nowSec(),
      (request.headers.get('user-agent') || '').slice(0, 300),
      request.headers.get('cf-ipcountry') || null,
    ).run();
  } catch (e) { console.warn('[gallery] download log failed:', e.message); }

  return deps.json({ ok: true, token: await mintDlToken(slug, email, deps, env) }, {}, env, origin);
}

// /thumb/<key>?w=&q= — resized via Cloudflare image transforms; if the zone
// doesn't have transforms enabled, the original flows through unchanged.
async function serveThumb(request, env, key, url, deps) {
  const w = clampI(url.searchParams.get('w'), 800, 80, 2600);
  const q = clampI(url.searchParams.get('q'), 82, 40, 95);
  const raw = `${url.origin}/media/${keyToPath(key)}`;
  try {
    const resized = await fetch(raw, {
      cf: { image: { width: w, quality: q, fit: 'scale-down', format: 'auto' }, cacheEverything: true, cacheTtl: 31536000 },
    });
    if (resized.ok) {
      const h = new Headers(resized.headers);
      h.set('access-control-allow-origin', '*');
      if (!h.has('cache-control')) h.set('cache-control', 'public, max-age=31536000, immutable');
      return new Response(resized.body, { status: resized.status, headers: h });
    }
  } catch (_) { /* fall through to original */ }
  return deps.handleMediaServe(request, env, key);
}

// /dl/<slug>/<key> — original download (Content-Disposition attachment), gated
// by the download token from /unlock — so every download has a captured email.
async function serveDownload(request, env, slug, key, url, deps, origin) {
  const g = await getGallery(env, slug);
  if (!g) return new Response('not found', { status: 404 });
  if (g.download_enabled === 0) return deps.json({ error: 'downloads_disabled' }, { status: 403 }, env, origin);
  // Membership check — only serve keys that belong to this gallery.
  const member = await env.DB.prepare('SELECT media_key FROM gallery_images WHERE gallery_slug=?1 AND media_key=?2')
    .bind(slug, key).first();
  if (!member) return new Response('not found', { status: 404 });

  // Email gate: a valid /unlock token is required for ALL downloads now.
  const token = url.searchParams.get('t') || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await dlTokenValid(token, slug, deps, env))) {
    return deps.json({ error: 'email_required' }, { status: 401 }, env, origin);
  }

  if (!env.MEDIA) return new Response('media not configured', { status: 500 });
  const object = await env.MEDIA.get(key);
  if (!object) return new Response('not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const filename = (key.split('/').pop() || 'photo').replace(/"/g, '');
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
  headers.set('Access-Control-Allow-Origin', '*');
  if (request.method === 'HEAD') {
    headers.set('content-length', String(object.size));
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { headers });
}

// ===========================================================================
// ADMIN ROUTES (token-gated; called by the Studio gallery manager)
// ===========================================================================

// GET /admin/gallery-downloads?slug=&q=&limit= — download/lead history
async function adminListDownloads(request, env, url, deps, origin) {
  const slug = (url.searchParams.get('slug') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();
  const limit = clampI(url.searchParams.get('limit'), 200, 1, 1000);
  const where = []; const params = [];
  if (slug) { where.push(`gallery_slug = ?${params.length + 1}`); params.push(slug); }
  if (q)    { where.push(`(email LIKE ?${params.length + 1} OR gallery_title LIKE ?${params.length + 1})`); params.push('%' + q + '%'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = await env.DB.prepare(`SELECT COUNT(*) c FROM gallery_downloads ${whereSql}`).bind(...params).first();
  const rows = await env.DB.prepare(`
    SELECT id, email, gallery_slug, gallery_title, created_at, user_agent, country
    FROM gallery_downloads ${whereSql} ORDER BY created_at DESC LIMIT ${limit}
  `).bind(...params).all();
  return deps.json({ items: rows.results || [], total: total ? total.c : 0 }, {}, env, origin);
}

async function adminListGalleries(request, env, deps, origin) {
  const r = await env.DB.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_slug=g.slug) AS image_count
    FROM galleries g ORDER BY g.sort_order ASC, g.updated_at DESC
  `).all();
  // Admin is token-gated, so the plaintext PIN is safe to return here (never on
  // the public surface). `pin` lets the Studio keep the PIN visible/editable.
  const items = (r.results || []).map(g => ({ ...g, has_pin: !!g.pin_hash, pin: g.pin || '', pin_hash: undefined }));
  return deps.json({ items }, {}, env, origin);
}

async function adminGetGallery(request, env, slug, deps, origin) {
  const g = await getGallery(env, slug);
  if (!g) return deps.json({ error: 'not_found' }, { status: 404 }, env, origin);
  const images = await getGalleryImages(env, slug);
  return deps.json({ gallery: { ...g, has_pin: !!g.pin_hash, pin: g.pin || '', pin_hash: undefined }, images }, {}, env, origin);
}

async function adminCreateOrUpdate(request, env, deps, origin, existingSlug) {
  let b;
  try { b = await request.json(); } catch { return deps.json({ error: 'bad_request' }, { status: 400 }, env, origin); }
  const slug = String((existingSlug || b.slug) || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return deps.json({ error: 'invalid_slug', detail: 'lowercase letters, numbers, hyphens' }, { status: 400 }, env, origin);
  const title = String(b.title || '').trim();
  if (!title) return deps.json({ error: 'title_required' }, { status: 400 }, env, origin);

  const now = nowSec();
  const visibility = b.visibility === 'public' ? 'public' : 'unlisted';
  const downloadEnabled = b.download_enabled === false ? 0 : 1;
  const existing = await getGallery(env, slug);

  // PIN handling: b.pin === '' clears, undefined/null leaves as-is, a string sets.
  // Store both the hash (for verification) and the plaintext (admin-visible).
  let pinHash = existing ? existing.pin_hash : null;
  let pinPlain = existing ? (existing.pin || null) : null;
  if (b.pin === '' || b.pin === null) { pinHash = null; pinPlain = null; }
  else if (typeof b.pin === 'string' && b.pin.trim()) { pinPlain = b.pin.trim(); pinHash = await hashPin(pinPlain, slug); }

  await env.DB.prepare(`
    INSERT INTO galleries (slug,title,subtitle,description,cover_key,visibility,category,location,pin_hash,pin,download_enabled,sort_order,shot_date,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)
    ON CONFLICT(slug) DO UPDATE SET
      title=?2, subtitle=?3, description=?4, cover_key=?5, visibility=?6,
      category=?7, location=?8, pin_hash=?9, pin=?10, download_enabled=?11,
      sort_order=?12, shot_date=?13, updated_at=?14
  `).bind(
    slug, title, b.subtitle || null, b.description || null, b.cover_key || (existing && existing.cover_key) || null,
    visibility, b.category || null, b.location || null, pinHash, pinPlain, downloadEnabled,
    Number.isFinite(b.sort_order) ? b.sort_order : (existing ? existing.sort_order : 0),
    Number.isFinite(b.shot_date) ? b.shot_date : (existing ? existing.shot_date : null),
    now,
  ).run();

  return deps.json({ ok: true, slug, has_pin: !!pinHash }, {}, env, origin);
}

async function adminDeleteGallery(request, env, slug, deps, origin) {
  await env.DB.prepare('DELETE FROM gallery_images WHERE gallery_slug=?1').bind(slug).run();
  await env.DB.prepare('DELETE FROM galleries WHERE slug=?1').bind(slug).run();
  return deps.json({ ok: true, slug }, {}, env, origin);
}

// POST /admin/galleries/<slug>/images  body: { add:[keys], remove:[keys], order:[keys], captions:{key:cap}, cover:key }
async function adminEditImages(request, env, slug, deps, origin) {
  const g = await getGallery(env, slug);
  if (!g) return deps.json({ error: 'not_found' }, { status: 404 }, env, origin);
  let b;
  try { b = await request.json(); } catch { return deps.json({ error: 'bad_request' }, { status: 400 }, env, origin); }
  const now = nowSec();

  if (Array.isArray(b.add)) {
    // append after the current max sort_order
    const maxRow = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),-1) m FROM gallery_images WHERE gallery_slug=?1').bind(slug).first();
    let so = (maxRow ? maxRow.m : -1) + 1;
    for (const key of b.add) {
      if (typeof key !== 'string' || !key) continue;
      await env.DB.prepare('INSERT OR IGNORE INTO gallery_images (gallery_slug,media_key,sort_order,created_at) VALUES (?1,?2,?3,?4)')
        .bind(slug, key, so++, now).run();
    }
  }
  if (Array.isArray(b.remove)) {
    for (const key of b.remove) {
      await env.DB.prepare('DELETE FROM gallery_images WHERE gallery_slug=?1 AND media_key=?2').bind(slug, key).run();
    }
  }
  if (Array.isArray(b.order)) {
    let so = 0;
    for (const key of b.order) {
      await env.DB.prepare('UPDATE gallery_images SET sort_order=?3 WHERE gallery_slug=?1 AND media_key=?2').bind(slug, key, so++).run();
    }
  }
  if (b.captions && typeof b.captions === 'object') {
    for (const [key, cap] of Object.entries(b.captions)) {
      await env.DB.prepare('UPDATE gallery_images SET caption=?3 WHERE gallery_slug=?1 AND media_key=?2').bind(slug, key, String(cap || '').slice(0, 600)).run();
    }
  }
  if (typeof b.cover === 'string' && b.cover) {
    await env.DB.prepare('UPDATE galleries SET cover_key=?2, updated_at=?3 WHERE slug=?1').bind(slug, b.cover, now).run();
  }
  await env.DB.prepare('UPDATE galleries SET updated_at=?2 WHERE slug=?1').bind(slug, now).run();

  const images = await getGalleryImages(env, slug);
  return deps.json({ ok: true, images }, {}, env, origin);
}

// ===========================================================================
// DISPATCHER
// ===========================================================================
//
// Returns a Response if it handled the request, or null to let the main worker
// dispatcher take over (used for /admin/galleries on the gallery host, /media,
// /health, etc.). `deps` carries the shared helpers from index.js so this
// module needs no circular import.

export async function handleGallery(request, env, url, origin, deps) {
  if (!env.DB) return null;
  await ensureGalleryTables(env);

  const method = request.method;
  // Are we serving the real gallery host? True directly on gallery.oftmw.com, or
  // when a Cloudflare Pages proxy forwards for it (DNS lives at Wix, so the
  // public host is fronted by a Pages proxy that sets X-Forwarded-Host — see
  // tmw-gallery). On the gallery host we emit clean root-relative URLs (base='').
  const fwdHost = request.headers.get('x-forwarded-host') || '';
  const onGalleryHost = url.hostname === 'gallery.oftmw.com' || fwdHost === 'gallery.oftmw.com';
  // "Gallery context" = we're serving the public gallery surface. True on the
  // gallery host, or under a /gallery/* prefix on workers.dev (testable before
  // cutover). Admin routes are NOT gated by this — the Studio calls /admin/* on
  // the workers.dev origin.
  const galleryContext = onGalleryHost
    || url.pathname === '/gallery' || url.pathname.startsWith('/gallery/');

  // Normalize a /gallery prefix so the same routes work on workers.dev.
  let path = url.pathname;
  if (path === '/gallery') path = '/';
  else if (path.startsWith('/gallery/')) path = path.slice('/gallery'.length);

  // ---- Admin (token-gated) — reachable on any host ----
  if (path === '/admin/galleries') {
    const denied = await deps.requireAdminToken(request, env, origin);
    if (denied) return denied;
    if (method === 'GET')  return adminListGalleries(request, env, deps, origin);
    if (method === 'POST') return adminCreateOrUpdate(request, env, deps, origin, null);
  }
  if (path === '/admin/gallery-downloads' && method === 'GET') {
    const denied = await deps.requireAdminToken(request, env, origin);
    if (denied) return denied;
    return adminListDownloads(request, env, url, deps, origin);
  }
  {
    const m = path.match(/^\/admin\/galleries\/([a-z0-9-]+)\/images\/?$/);
    if (m && method === 'POST') {
      const denied = await deps.requireAdminToken(request, env, origin);
      if (denied) return denied;
      return adminEditImages(request, env, m[1], deps, origin);
    }
  }
  {
    const m = path.match(/^\/admin\/galleries\/([a-z0-9-]+)\/?$/);
    if (m) {
      const denied = await deps.requireAdminToken(request, env, origin);
      if (denied) return denied;
      if (method === 'GET')    return adminGetGallery(request, env, m[1], deps, origin);
      if (method === 'PATCH' || method === 'POST') return adminCreateOrUpdate(request, env, deps, origin, m[1]);
      if (method === 'DELETE') return adminDeleteGallery(request, env, m[1], deps, origin);
    }
  }

  // Everything below is the public gallery surface — only on the gallery host
  // (or /gallery/* on workers.dev). Off-context requests fall through to the
  // main worker dispatcher so map/journal routes are never shadowed.
  if (!galleryContext) return null;

  // URL prefix for all in-page links/assets: '' on the real gallery host (direct
  // or via the Pages proxy), '/gallery' when testing under the prefix on
  // workers.dev. Keeps thumbnails, downloads, and nav links resolving on both.
  const base = onGalleryHost ? '' : '/gallery';

  // ---- Public API ----
  if (path === '/api/galleries' && method === 'GET') {
    const r = await env.DB.prepare(`
      SELECT slug,title,subtitle,cover_key,category,location,pin_hash,
             (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_slug=galleries.slug) AS image_count
      FROM galleries WHERE visibility='public' ORDER BY sort_order ASC, updated_at DESC
    `).all();
    const items = (r.results || []).map(g => ({ ...g, pin_hash: g.pin_hash ? 1 : 0 }));
    return deps.json({ items }, {}, env, origin);
  }
  {
    const m = path.match(/^\/api\/gallery\/([a-z0-9-]+)\/(unlock|pin)\/?$/);
    if (m && method === 'POST') return apiUnlock(request, env, m[1], deps, origin);
  }

  // ---- Assets ----
  {
    const m = path.match(/^\/thumb\/(.+)$/);
    if (m && (method === 'GET' || method === 'HEAD')) {
      return serveThumb(request, env, decodeURIComponent(m[1]), url, deps);
    }
  }
  {
    // /v/<key> — stream a video for in-gallery playback (Range-aware via
    // handleMediaServe, so seeking works). Viewing is open like thumbnails;
    // the explicit download stays PIN-gated through /dl.
    const m = path.match(/^\/v\/(.+)$/);
    if (m && (method === 'GET' || method === 'HEAD')) {
      return deps.handleMediaServe(request, env, decodeURIComponent(m[1]));
    }
  }
  {
    const m = path.match(/^\/dl\/([a-z0-9-]+)\/(.+)$/);
    if (m && (method === 'GET' || method === 'HEAD')) {
      return serveDownload(request, env, m[1], decodeURIComponent(m[2]), url, deps, origin);
    }
  }

  // ---- Public pages ----
  if (path === '/' && method === 'GET') {
    const r = await env.DB.prepare(`
      SELECT slug,title,subtitle,cover_key,category,location,pin_hash,
             (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_slug=galleries.slug) AS image_count,
             (SELECT gi.media_key FROM gallery_images gi WHERE gi.gallery_slug=galleries.slug ORDER BY gi.sort_order ASC, gi.created_at ASC LIMIT 1) AS first_key
      FROM galleries WHERE visibility='public' ORDER BY sort_order ASC, updated_at DESC
    `).all();
    return htmlResponse(renderIndexHTML(r.results || [], base), { cache: 'public, max-age=120' });
  }
  {
    const m = path.match(/^\/g\/([a-z0-9-]+)\/?$/);
    if (m && method === 'GET') {
      const g = await getGallery(env, m[1]);
      if (!g) return htmlResponse(render404(base), { status: 404, cache: 'no-store' });
      // PIN gate: a gallery with a PIN must be unlocked (valid view cookie) before
      // any photos are rendered. Keeps the gate page free of image keys.
      if (g.pin_hash) {
        const tok = parseCookies(request)[viewCookieName(m[1])];
        if (!(await viewTokenValid(tok, m[1], deps, env))) {
          // Pass the first few images for a blurred, non-interactive preview on
          // the gate (originals + full set stay locked behind the PIN).
          const allImgs = await getGalleryImages(env, m[1]);
          return htmlResponse(renderGateHTML(g, base, {
            error: url.searchParams.get('e') === '1',
            preview: allImgs.slice(0, 6),
            total: allImgs.length,
          }), { status: 200, cache: 'private, no-store' });
        }
      }
      const images = await getGalleryImages(env, m[1]);
      return htmlResponse(renderGalleryHTML(g, images, base), {
        cache: (g.visibility === 'public' && !g.pin_hash) ? 'public, max-age=120' : 'private, no-store',
      });
    }
    if (m && method === 'POST') {
      // Gate submission: verify the PIN (gallery PIN or master), set a signed
      // view cookie, and redirect back to the gallery. Wrong PIN → ?e=1.
      const slug = m[1];
      const g = await getGallery(env, slug);
      if (!g || !g.pin_hash) return new Response(null, { status: 303, headers: { Location: `${base}/g/${slug}` } });
      let pin = '';
      try { const form = await request.formData(); pin = String(form.get('pin') || '').trim(); } catch (_) {}
      if (!(await pinOK(pin, g, env))) {
        return new Response(null, { status: 303, headers: { Location: `${base}/g/${slug}?e=1`, 'Cache-Control': 'no-store' } });
      }
      const tok = await mintViewToken(slug, deps, env);
      const cookie = `${viewCookieName(slug)}=${encodeURIComponent(tok)}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`;
      return new Response(null, { status: 303, headers: { Location: `${base}/g/${slug}`, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } });
    }
  }

  return null; // not a gallery route → fall through to the main dispatcher
}

// PIN entry gate — shown instead of the gallery when a PIN is set and the
// visitor hasn't unlocked it yet. Deliberately renders NO image keys. Submits
// a plain form POST to the same URL; the server sets the view cookie.
function renderGateHTML(g, base, opts = {}) {
  const meta = [g.category, g.location].filter(Boolean).map(esc).join(' &middot; ');
  const err = opts.error ? `<div class="gate-err">Incorrect PIN — try again.</div>` : '';
  // Blurred, non-interactive teaser of the first few images — enough to entice
  // without exposing the set. Low-res (w=500) + heavy CSS blur, pointer-events
  // off, not draggable, no link/lightbox. Full-res originals stay /dl-gated.
  const previewImgs = (opts.preview || []).slice(0, 6);
  const total = opts.total || previewImgs.length;
  const previewHTML = previewImgs.length ? (
    `<div class="gate-preview-tag">Preview &middot; ${previewImgs.length} of ${total}</div>` +
    `<div class="gate-preview" aria-hidden="true">` +
    previewImgs.map(im => `<img src="${base}/thumb/${keyToPath(im.key)}?w=500" alt="" loading="lazy" decoding="async" draggable="false" oncontextmenu="return false">`).join('') +
    `</div>`
  ) : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>${esc(g.title)} — Private gallery</title>${FONTS}
<style>${BASE_CSS}
.gate{position:relative;min-height:82vh;display:flex;align-items:center;justify-content:center;padding:24px;overflow:hidden}
.gate-preview{position:absolute;inset:0;z-index:0;display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:1fr;gap:8px;padding:8px;pointer-events:none;user-select:none;-webkit-user-select:none}
.gate-preview img{width:100%;height:100%;object-fit:cover;border-radius:10px;filter:blur(11px) brightness(.6) saturate(1.05);transform:scale(1.06);-webkit-user-drag:none}
.gate-preview::after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse 62% 72% at 50% 50%,rgba(8,8,8,.92) 0%,rgba(8,8,8,.78) 45%,rgba(8,8,8,.5) 100%)}
.gate-preview-tag{position:absolute;z-index:1;top:18px;left:50%;transform:translateX(-50%);font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--mute2);background:rgba(8,8,8,.5);border:1px solid var(--hair);padding:5px 12px;border-radius:999px;pointer-events:none}
@media(max-width:560px){.gate-preview{grid-template-columns:repeat(2,1fr)}}
.gate-card{position:relative;z-index:2;background:var(--panel);border:1px solid var(--hair2);border-radius:18px;padding:34px 30px;max-width:380px;width:100%;text-align:center;box-shadow:0 30px 90px rgba(0,0,0,.6)}
.gate-card .lock{display:flex;justify-content:center;margin-bottom:14px;color:var(--green)}
.gate-card h1{font-size:23px;margin-bottom:6px}
.gate-card .meta{color:var(--mute2);font-size:12.5px;font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px}
.gate-card p{color:var(--mute2);font-size:14px;margin-bottom:20px}
.gate-card input{width:100%;text-align:center;font-family:var(--mono);font-size:22px;letter-spacing:.3em;padding:14px;border-radius:12px;border:1px solid var(--hair2);background:var(--ink);color:#fff;outline:none}
.gate-card input:focus{border-color:var(--green)}
.gate-err{color:#ff6b6b;font-size:12.5px;font-family:var(--mono);min-height:18px;margin-top:10px}
.gate-card button{width:100%;margin-top:16px;padding:14px;border-radius:12px;border:none;background:var(--green);color:#04210f;font-family:var(--mono);font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px;cursor:pointer}
.gate-card button:hover{filter:brightness(1.05)}
.gate-card .home{display:inline-block;margin-top:16px;color:var(--mute2);text-decoration:none;font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase}
</style></head><body>${navHTML(base || '')}
<div class="gate">${previewHTML}<div class="gate-card">
  <div class="lock">${LOCK_SVG}</div>
  ${meta ? `<div class="meta">${meta}</div>` : ''}
  <h1>${esc(g.title)}</h1>
  <p>This gallery is private. Enter the PIN shared with you to view it.</p>
  <form method="POST" action="${base}/g/${esc(g.slug)}" novalidate>
    <input name="pin" inputmode="numeric" autocomplete="off" autofocus placeholder="Gallery PIN" maxlength="12" aria-label="Gallery PIN">
    ${err}
    <button type="submit">View gallery</button>
  </form>
  <a class="home" href="${base || ''}/">&larr; All galleries</a>
</div></div></body></html>`;
}

function render404(base) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — Markets of Tomorrow</title>${FONTS}<style>${BASE_CSS}.x{min-height:80vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px}.x h1{font-size:64px;font-weight:900}.x a{color:var(--green);text-decoration:none;font-family:var(--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase}</style></head><body>${navHTML(base || '')}<div class="x"><div class="eyebrow">404</div><h1>Gallery not found</h1><a href="${base || ''}/">&larr; Back to the portfolio</a></div></body></html>`;
}
