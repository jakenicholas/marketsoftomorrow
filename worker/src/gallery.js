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
      pin_hash          TEXT,                              -- null = no download PIN
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

// ── PIN tokens — a short signed grant that the download route checks ─────────
async function mintPinToken(slug, deps, env) {
  return deps.signPayload({ g: slug, s: 'dl', exp: nowSec() + 86400 }, pinSecret(env));
}
async function pinTokenValid(token, slug, deps, env) {
  if (!token) return false;
  const obj = await deps.verifyPayload(token, pinSecret(env));
  return !!(obj && obj.s === 'dl' && obj.g === slug);
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

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,600;9..144,900&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">`;

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
.logo{display:flex;align-items:center;gap:9px;text-decoration:none}
.logo .hex{width:20px;height:20px;flex:0 0 auto}
.logo .nm{font-family:var(--serif);font-weight:600;font-size:17px;color:#fff;letter-spacing:-.01em}
.logo .nm b{color:var(--green)}
.nav-right{display:flex;align-items:center;gap:18px}
.nav-link{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute2);text-decoration:none;transition:color .2s;white-space:nowrap}
.nav-link:hover{color:var(--cream)}
.nav-cta{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;color:var(--ink);background:var(--green);padding:9px 15px;border-radius:999px;text-decoration:none;font-weight:700;text-transform:uppercase;transition:transform .2s,background .2s;white-space:nowrap}
.nav-cta:hover{background:var(--green-soft);transform:translateY(-1px)}
footer{border-top:1px solid var(--hair);margin-top:90px;padding:34px 0 60px}
footer .wrap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;color:var(--mute)}
footer a{color:var(--green);text-decoration:none}
@media(max-width:640px){.nav-link{display:none}}
`;

const HEX_SVG = `<svg class="hex" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polygon points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/></svg>`;

function navHTML(activeCta) {
  return `<nav><div class="wrap">
    <a class="logo" href="/">${HEX_SVG}<span class="nm">Markets of <b>Tomorrow</b></span></a>
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
function renderIndexHTML(galleries) {
  const cards = galleries.map(g => {
    const cover = g.cover_key
      ? `<img loading="lazy" src="/thumb/${keyToPath(g.cover_key)}?w=900" alt="${esc(g.title)}">`
      : `<div class="noimg"></div>`;
    const meta = [g.category, g.location].filter(Boolean).map(esc).join(' &middot; ');
    const lock = g.pin_hash ? `<span class="lock" title="Download PIN required">&#128274;</span>` : '';
    return `<a class="card" href="/g/${esc(g.slug)}">
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
.hero{padding:150px 0 40px;text-align:center}
.hero h1{font-size:clamp(44px,7vw,86px);font-weight:900;letter-spacing:-.03em;color:#fff;margin:14px 0 0}
.hero p{font-family:var(--serif);font-style:italic;font-weight:300;font-size:clamp(17px,2.2vw,25px);color:var(--cream);max-width:30ch;margin:22px auto 0;text-wrap:balance}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;padding:40px 0 10px}
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
.empty{padding:80px 0;text-align:center;color:var(--mute2)}
.empty p{margin-top:16px;font-size:17px}.empty a{color:var(--green);text-decoration:none}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.grid{grid-template-columns:1fr}}
</style></head><body>
${navHTML()}
<header class="hero"><div class="wrap">
  <div class="eyebrow">Markets of Tomorrow &middot; Visual Portfolio</div>
  <h1>The Work</h1>
  <p>Photography &amp; film for the hotels, resorts, and golf courses defining luxury travel.</p>
</div></header>
<main class="wrap">
  ${galleries.length ? `<div class="grid">${cards}</div>` : empty}
</main>
${footerHTML()}
</body></html>`;
}

// Per-gallery page — server-rendered grid + lightbox + PIN download flow.
function renderGalleryHTML(g, images) {
  const noindex = g.visibility !== 'public'
    ? `<meta name="robots" content="noindex,nofollow,noarchive">` : '';
  const meta = [g.category, g.location].filter(Boolean).map(esc).join(' &middot; ');
  const pinRequired = !!g.pin_hash;
  const downloadEnabled = g.download_enabled !== 0;

  // Inline the image list so the page renders in one request.
  const data = JSON.stringify({
    slug: g.slug,
    pinRequired,
    downloadEnabled,
    images: images.map(im => ({
      key: im.key, caption: im.caption || '', alt: im.alt_text || g.title,
      w: im.width || 0, h: im.height || 0, filename: im.filename || '',
    })),
  }).replace(/</g, '\\u003c');

  const tiles = images.map((im, i) => {
    const ratio = (im.width && im.height) ? (im.height / im.width) : 0.7;
    return `<button class="tile" data-i="${i}" style="--r:${ratio}" aria-label="View photo ${i + 1}">
      <img loading="lazy" src="/thumb/${keyToPath(im.key)}?w=700" alt="${esc(im.alt_text || g.title)}">
    </button>`;
  }).join('');

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
.ghead{padding:140px 0 30px}
.back{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute2);text-decoration:none}
.back:hover{color:var(--cream)}
.ghead h1{font-size:clamp(36px,5.5vw,68px);font-weight:900;letter-spacing:-.03em;color:#fff;margin:18px 0 0}
.ghead .sub{font-family:var(--serif);font-weight:300;font-style:italic;font-size:clamp(16px,2vw,22px);color:var(--cream);margin-top:16px;max-width:54ch}
.ghead .gmeta{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin-top:18px;display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.ghead .gmeta .dot{opacity:.4}
.gactions{display:flex;gap:12px;margin-top:26px;flex-wrap:wrap}
.btn{font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;padding:11px 18px;border-radius:999px;border:1px solid var(--hair2);background:rgba(255,255,255,.04);color:var(--cream);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;transition:background .2s,transform .2s,border-color .2s}
.btn:hover{background:rgba(255,255,255,.08);transform:translateY(-1px)}
.btn.primary{background:var(--green);color:var(--ink);border-color:var(--green)}
.btn.primary:hover{background:var(--green-soft)}
.btn.gold{border-color:rgba(230,197,116,.4);color:var(--gold-soft)}
.btn .ic{width:15px;height:15px}
/* masonry via CSS columns */
.masonry{column-count:4;column-gap:14px;padding:26px 0 0}
.tile{display:block;width:100%;margin:0 0 14px;padding:0;border:0;background:var(--panel);border-radius:12px;overflow:hidden;cursor:zoom-in;break-inside:avoid;position:relative;line-height:0}
.tile img{width:100%;height:auto;display:block;transition:transform .5s cubic-bezier(.22,1,.36,1),opacity .4s}
.tile:hover img{transform:scale(1.04)}
@media(max-width:1100px){.masonry{column-count:3}}
@media(max-width:760px){.masonry{column-count:2}}
@media(max-width:460px){.masonry{column-count:1}}
/* lightbox */
.lb{position:fixed;inset:0;z-index:100;background:rgba(5,6,5,.96);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center}
.lb.open{display:flex}
.lb img{max-width:92vw;max-height:84vh;object-fit:contain;border-radius:6px;box-shadow:0 30px 90px rgba(0,0,0,.6)}
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
.modal-card input:focus{border-color:var(--green)}
.modal-card .err{color:#ff6b6b;font-size:12.5px;font-family:var(--mono);min-height:18px;margin-top:10px}
.modal-card .row{display:flex;gap:10px;margin-top:16px}
.modal-card .row .btn{flex:1;justify-content:center}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--panel2);border:1px solid var(--hair2);color:var(--cream);padding:12px 20px;border-radius:999px;font-family:var(--mono);font-size:12px;letter-spacing:.04em;opacity:0;pointer-events:none;transition:opacity .3s,transform .3s;z-index:130}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.licstrip{margin-top:60px;border:1px solid rgba(230,197,116,.3);background:linear-gradient(180deg,rgba(230,197,116,.06),rgba(230,197,116,.02));border-radius:18px;padding:30px 34px;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}
.licstrip .lt{font-family:var(--serif);font-size:clamp(19px,2vw,26px);color:#fff;max-width:42ch}
.licstrip .lt b{color:var(--gold-soft)}
.empty2{padding:60px 0;color:var(--mute2);font-size:16px}
</style></head><body>
${navHTML()}
<header class="ghead"><div class="wrap">
  <a class="back" href="/">&larr;&nbsp;All galleries</a>
  <h1>${esc(g.title)}</h1>
  ${g.subtitle ? `<div class="sub">${esc(g.subtitle)}</div>` : ''}
  <div class="gmeta">
    ${meta ? `<span>${meta}</span><span class="dot">&bull;</span>` : ''}
    <span>${images.length} photo${images.length === 1 ? '' : 's'}</span>
    ${pinRequired ? `<span class="dot">&bull;</span><span>&#128274; PIN to download</span>` : ''}
  </div>
  ${images.length && downloadEnabled ? `<div class="gactions">
    <button class="btn primary" id="dlAll"><svg class="ic" viewBox="0 0 16 16" fill="none"><path d="M8 1v9m0 0L4.5 6.5M8 10l3.5-3.5M2 13.5h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Download all</button>
    <a class="btn gold" href="https://www.oftmw.com/media/licensing/">License this work</a>
  </div>` : ''}
</div></header>
<main class="wrap">
  ${images.length ? `<div class="masonry" id="grid">${tiles}</div>` : `<div class="empty2">No photos in this gallery yet.</div>`}
  <div class="licstrip">
    <div class="lt">Found a frame you love? <b>License it</b> for your website, campaign, or full buyout.</div>
    <a class="btn gold" href="https://www.oftmw.com/media/licensing/#cta">See licensing &amp; rights</a>
  </div>
</main>
${footerHTML()}

<div class="lb" id="lb">
  <div class="lb-x" id="lbX" role="button" aria-label="Close">&times;</div>
  <div class="lb-dl" id="lbDl" role="button" aria-label="Download" title="Download">&#11015;</div>
  <div class="lb-prev" id="lbPrev" role="button" aria-label="Previous">&#8249;</div>
  <div class="lb-next" id="lbNext" role="button" aria-label="Next">&#8250;</div>
  <img id="lbImg" alt="">
  <div class="lb-cap" id="lbCap"></div>
</div>

<div class="modal" id="pinModal">
  <div class="modal-card">
    <span class="eyebrow">Protected download</span>
    <h3>Enter the gallery PIN</h3>
    <p>This gallery's downloads are PIN-protected. Enter the PIN shared with you to unlock full-resolution files.</p>
    <input id="pinInput" inputmode="numeric" autocomplete="off" placeholder="••••" maxlength="12">
    <div class="err" id="pinErr"></div>
    <div class="row">
      <button class="btn" id="pinCancel">Cancel</button>
      <button class="btn primary" id="pinGo">Unlock</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const G = ${data};
const tokenKey = 'tmw_gpin_' + G.slug;
function getToken(){ try{return sessionStorage.getItem(tokenKey)||'';}catch(_){return '';} }
function setToken(t){ try{sessionStorage.setItem(tokenKey,t);}catch(_){} }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2600); }

/* ---- Lightbox ---- */
const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');
let cur=-1;
function show(i){
  if(i<0||i>=G.images.length)return; cur=i; const im=G.images[i];
  lbImg.src='/thumb/'+im.key.split('/').map(encodeURIComponent).join('/')+'?w=2200';
  lbImg.alt=im.alt||''; lbCap.textContent=(im.caption||'')+'  '+(i+1)+' / '+G.images.length;
  lb.classList.add('open'); document.body.style.overflow='hidden';
}
function close(){ lb.classList.remove('open'); document.body.style.overflow=''; cur=-1; }
document.getElementById('grid')&&document.getElementById('grid').addEventListener('click',e=>{
  const t=e.target.closest('.tile'); if(t)show(+t.dataset.i);
});
document.getElementById('lbX').onclick=close;
document.getElementById('lbPrev').onclick=()=>show((cur-1+G.images.length)%G.images.length);
document.getElementById('lbNext').onclick=()=>show((cur+1)%G.images.length);
lb.addEventListener('click',e=>{ if(e.target===lb)close(); });
addEventListener('keydown',e=>{
  if(!lb.classList.contains('open'))return;
  if(e.key==='Escape')close();
  if(e.key==='ArrowLeft')show((cur-1+G.images.length)%G.images.length);
  if(e.key==='ArrowRight')show((cur+1)%G.images.length);
});
document.getElementById('lbDl').onclick=()=>{ if(cur>=0)requestDownload([G.images[cur]]); };

/* ---- Download + PIN flow ---- */
let pending=null;
function dlUrl(im){
  const t=getToken();
  return '/dl/'+G.slug+'/'+im.key.split('/').map(encodeURIComponent).join('/')+(t?('?t='+encodeURIComponent(t)):'');
}
async function doDownloads(list){
  for(const im of list){
    const a=document.createElement('a'); a.href=dlUrl(im); a.download=im.filename||'';
    document.body.appendChild(a); a.click(); a.remove();
    await new Promise(r=>setTimeout(r,400)); // stagger so the browser queues each
  }
  toast(list.length>1?('Downloading '+list.length+' photos…'):'Downloading…');
}
async function requestDownload(list){
  if(!G.downloadEnabled){ toast('Downloads are disabled for this gallery'); return; }
  if(G.pinRequired && !getToken()){ pending=list; openPin(); return; }
  // verify token still valid by attempting; if 401, prompt
  if(G.pinRequired){
    try{
      const probe=await fetch(dlUrl(list[0]),{method:'HEAD'});
      if(probe.status===401){ pending=list; openPin(); return; }
    }catch(_){}
  }
  doDownloads(list);
}
const dlAllBtn=document.getElementById('dlAll');
if(dlAllBtn)dlAllBtn.onclick=()=>requestDownload(G.images);

/* ---- PIN modal ---- */
const modal=document.getElementById('pinModal'),pinInput=document.getElementById('pinInput'),pinErr=document.getElementById('pinErr');
function openPin(){ pinErr.textContent=''; pinInput.value=''; modal.classList.add('open'); setTimeout(()=>pinInput.focus(),50); }
function closePin(){ modal.classList.remove('open'); }
document.getElementById('pinCancel').onclick=closePin;
modal.addEventListener('click',e=>{ if(e.target===modal)closePin(); });
pinInput.addEventListener('keydown',e=>{ if(e.key==='Enter')submitPin(); });
document.getElementById('pinGo').onclick=submitPin;
async function submitPin(){
  const pin=pinInput.value.trim(); if(!pin){pinErr.textContent='Enter the PIN';return;}
  pinErr.textContent='Checking…';
  try{
    const r=await fetch('/api/gallery/'+G.slug+'/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
    const j=await r.json();
    if(r.ok&&j.token){ setToken(j.token); closePin(); const list=pending||G.images; pending=null; doDownloads(list); }
    else{ pinErr.textContent=j.error==='wrong_pin'?'Incorrect PIN — try again':'Could not verify PIN'; }
  }catch(_){ pinErr.textContent='Network error — try again'; }
}
</script>
</body></html>`;
}

// ===========================================================================
// PUBLIC API + ASSET ROUTES
// ===========================================================================

async function apiVerifyPin(request, env, slug, deps, origin) {
  const g = await getGallery(env, slug);
  if (!g) return deps.json({ error: 'not_found' }, { status: 404 }, env, origin);
  if (!g.pin_hash) return deps.json({ ok: true, token: await mintPinToken(slug, deps, env) }, {}, env, origin);
  let body;
  try { body = await request.json(); } catch { return deps.json({ error: 'bad_request' }, { status: 400 }, env, origin); }
  const pin = String(body.pin || '').trim();
  if (!pin) return deps.json({ error: 'bad_request' }, { status: 400 }, env, origin);
  const h = await hashPin(pin, slug);
  if (h !== g.pin_hash) return deps.json({ error: 'wrong_pin' }, { status: 403 }, env, origin);
  return deps.json({ ok: true, token: await mintPinToken(slug, deps, env) }, {}, env, origin);
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

// /dl/<slug>/<key> — PIN-gated original download (Content-Disposition attachment)
async function serveDownload(request, env, slug, key, url, deps, origin) {
  const g = await getGallery(env, slug);
  if (!g) return new Response('not found', { status: 404 });
  if (g.download_enabled === 0) return deps.json({ error: 'downloads_disabled' }, { status: 403 }, env, origin);
  // Membership check — only serve keys that belong to this gallery.
  const member = await env.DB.prepare('SELECT media_key FROM gallery_images WHERE gallery_slug=?1 AND media_key=?2')
    .bind(slug, key).first();
  if (!member) return new Response('not found', { status: 404 });

  if (g.pin_hash) {
    const token = url.searchParams.get('t') || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!(await pinTokenValid(token, slug, deps, env))) {
      return deps.json({ error: 'pin_required' }, { status: 401 }, env, origin);
    }
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

async function adminListGalleries(request, env, deps, origin) {
  const r = await env.DB.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_slug=g.slug) AS image_count
    FROM galleries g ORDER BY g.sort_order ASC, g.updated_at DESC
  `).all();
  const items = (r.results || []).map(g => ({ ...g, has_pin: !!g.pin_hash, pin_hash: undefined }));
  return deps.json({ items }, {}, env, origin);
}

async function adminGetGallery(request, env, slug, deps, origin) {
  const g = await getGallery(env, slug);
  if (!g) return deps.json({ error: 'not_found' }, { status: 404 }, env, origin);
  const images = await getGalleryImages(env, slug);
  return deps.json({ gallery: { ...g, has_pin: !!g.pin_hash, pin_hash: undefined }, images }, {}, env, origin);
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
  let pinHash = existing ? existing.pin_hash : null;
  if (b.pin === '' || b.pin === null) pinHash = null;
  else if (typeof b.pin === 'string' && b.pin.trim()) pinHash = await hashPin(b.pin.trim(), slug);

  await env.DB.prepare(`
    INSERT INTO galleries (slug,title,subtitle,description,cover_key,visibility,category,location,pin_hash,download_enabled,sort_order,shot_date,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)
    ON CONFLICT(slug) DO UPDATE SET
      title=?2, subtitle=?3, description=?4, cover_key=?5, visibility=?6,
      category=?7, location=?8, pin_hash=?9, download_enabled=?10,
      sort_order=?11, shot_date=?12, updated_at=?13
  `).bind(
    slug, title, b.subtitle || null, b.description || null, b.cover_key || (existing && existing.cover_key) || null,
    visibility, b.category || null, b.location || null, pinHash, downloadEnabled,
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
  // "Gallery context" = we're serving the public gallery surface. True on the
  // real gallery.oftmw.com host, or under a /gallery/* prefix on workers.dev
  // (so the whole thing is testable before the DNS cutover). Admin routes are
  // NOT gated by this — the Studio calls them on the workers.dev origin.
  const galleryContext = url.hostname === 'gallery.oftmw.com'
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
    const m = path.match(/^\/api\/gallery\/([a-z0-9-]+)\/pin\/?$/);
    if (m && method === 'POST') return apiVerifyPin(request, env, m[1], deps, origin);
  }

  // ---- Assets ----
  {
    const m = path.match(/^\/thumb\/(.+)$/);
    if (m && (method === 'GET' || method === 'HEAD')) {
      return serveThumb(request, env, decodeURIComponent(m[1]), url, deps);
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
             (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_slug=galleries.slug) AS image_count
      FROM galleries WHERE visibility='public' ORDER BY sort_order ASC, updated_at DESC
    `).all();
    return htmlResponse(renderIndexHTML(r.results || []), { cache: 'public, max-age=120' });
  }
  {
    const m = path.match(/^\/g\/([a-z0-9-]+)\/?$/);
    if (m && method === 'GET') {
      const g = await getGallery(env, m[1]);
      if (!g) return htmlResponse(render404(), { status: 404, cache: 'no-store' });
      const images = await getGalleryImages(env, m[1]);
      return htmlResponse(renderGalleryHTML(g, images), {
        cache: g.visibility === 'public' ? 'public, max-age=120' : 'private, no-store',
      });
    }
  }

  return null; // not a gallery route → fall through to the main dispatcher
}

function render404() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — Markets of Tomorrow</title>${FONTS}<style>${BASE_CSS}.x{min-height:80vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px}.x h1{font-size:64px;font-weight:900}.x a{color:var(--green);text-decoration:none;font-family:var(--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase}</style></head><body>${navHTML()}<div class="x"><div class="eyebrow">404</div><h1>Gallery not found</h1><a href="/">&larr; Back to the portfolio</a></div></body></html>`;
}
