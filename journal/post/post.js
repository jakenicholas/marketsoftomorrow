// ===================================================================
// Config (paths use absolute /... so they keep working from
// any URL depth, and survive the eventual migration to www.oftmw.com)
// ===================================================================
const WORKER_URL    = 'https://tmw.jake-ab7.workers.dev';
// (Wix RSS/proxy constants removed — TMW is off Wix; posts come from D1 only.)
const ADS_URL       = '/ads.json';
const PULSE_URL     = 'https://www.oftmw.com/map/pulse.json';
const PULSE_NEW_DAYS = 7;
const PULSE_MAX     = 8;
const PLACEMENT     = 'article';
const POST_URL_BASE = '/post/?slug=';
// Signed client-preview token (?pt=…). When present we ask the worker for the
// draft, mark the page noindex, show a DRAFT pill, and — once the post is
// published — redirect to the canonical live article.
const PREVIEW_TOKEN = new URLSearchParams(location.search).get('pt') || '';

document.getElementById('yr').textContent = new Date().getFullYear();

// ===================================================================
// Bootstrap
// ===================================================================
(async function init() {
  hookBannerCollapse();
  loadAndRenderAd();
  loadPulse();
  updateMapCounter();
  hookCopyLink();
  hookFavorite();
  // ── Pre-rendered static page (generate_articles.py) ───────────────
  // For path-based article URLs (/post/<slug>/) the body + SEO
  // <head> are already baked into the HTML so crawlers + social scrapers
  // see real content without running JS. Skip the fetch/render entirely;
  // just run the progressive enhancements on the existing DOM and load
  // the "Read next" rail.
  if (window.__PRERENDERED__ && window.__POST__) {
    const post = window.__POST__;
    const bodyEl = document.getElementById('article-body-content');
    if (bodyEl) { try { upgradeBodyImages(bodyEl); hookGalleries(bodyEl); hookLightbox(bodyEl); } catch (e) {} }
    try { loadReadNext(post, post.slug); } catch (e) {}
    try { initComments(post.slug, post); } catch (e) {}
    trackView(post.slug);
    return;
  }
  // URLSearchParams decodes ONCE, but some inbound URLs are double-
  // encoded (e.g. shared with %25C3%25A9 = encoded %C3%A9 = encoded é).
  // Decode until it stops changing so the worker call hits the DB row
  // cleanly instead of falling back to the legacy scrape.
  let slug = new URLSearchParams(location.search).get('slug') || '';
  for (let i = 0; i < 5 && /\%[0-9A-Fa-f]{2}/.test(slug); i++) {
    try { const d = decodeURIComponent(slug); if (d === slug) break; slug = d; } catch { break; }
  }
  if (!slug) return renderArticleEmpty('No article specified', 'Add ?slug=&lt;post-slug&gt; to the URL.', null);
  await loadArticle(slug);
  trackView(slug);
})();

// First-party view counter — one beacon per page load to the worker. Skips
// headless/bot agents; the worker also validates the slug + filters bots, and
// only counts real posts. Fire-and-forget so it never blocks the page.
function trackView(slug) {
  if (!slug) return;
  try {
    if (navigator.webdriver) return;
    const payload = JSON.stringify({ slug: String(slug) });
    if (navigator.sendBeacon) navigator.sendBeacon(WORKER_URL + '/view', payload);
    else fetch(WORKER_URL + '/view', { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'text/plain' } });
  } catch (e) {}
}

// ===================================================================
// LOAD POST — worker /post/:slug first, RSS fallback if that fails
// ===================================================================
async function loadArticle(slug) {
  try {
    const post = await fetchPost(slug);
    // A client preview link whose post is now published → bounce to the live
    // article (the preview link "clears" itself once the piece goes live).
    if (PREVIEW_TOKEN && post && post.status === 'published') {
      location.replace('/post/' + encodeURIComponent(slug) + '/');
      return;
    }
    renderArticle(post);
    if (post && post.status && post.status !== 'published') { markDraftPreview(); try { initSuggestMode(post); } catch (e) {} }
    loadReadNext(post, slug);
    try { initComments(slug, post); } catch (e) {}
  } catch (err) {
    console.error('[article] load failed:', err);
    var notFound = err && /not found/i.test(err.message || '');
    renderArticleEmpty(
      notFound ? 'Article not found' : 'Couldn\'t load this article',
      notFound ? 'This story isn\'t in our journal. Browse the latest instead.'
               : 'We couldn\'t reach the journal just now — please refresh.',
      null,
      err && err.message
    );
  }
}

// Inject a "DRAFT" gold pill at the top of the article + make the preview page
// non-indexable. Only runs for an unpublished post viewed via a preview link.
function markDraftPreview() {
  try {
    var r = document.querySelector('meta[name="robots"]');
    if (r) r.setAttribute('content', 'noindex, nofollow');
    else { var m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow'; document.head.appendChild(m); }
  } catch (e) {}
  try {
    if (!document.getElementById('draft-pill')) {
      var pill = document.createElement('div');
      pill.id = 'draft-pill';
      pill.innerHTML = '<span class="draft-pill-badge">● Draft</span>' +
        '<span class="draft-pill-note">Private preview — not published. Visible only to people with this link.</span>';
      var catRow = document.getElementById('cat-row');
      if (catRow && catRow.parentNode) catRow.parentNode.insertBefore(pill, catRow);
      else { var root = document.getElementById('article-root'); if (root) root.insertBefore(pill, root.firstChild); }
    }
    if (document.title.indexOf('[DRAFT]') < 0) document.title = '[DRAFT] ' + document.title;
  } catch (e) {}
}

async function fetchPost(slug) {
  // D1-backed /posts/by-slug/:slug is the ONLY source — TMW is fully off Wix.
  // Retry a transient failure a couple times; a real 404 means the post isn't
  // in the DB (no Wix scrape / RSS fallback anymore).
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(WORKER_URL + '/posts/by-slug/' + encodeURIComponent(slug) + (PREVIEW_TOKEN ? '?preview=' + encodeURIComponent(PREVIEW_TOKEN) : ''), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.post) {
          console.log('[article] source: D1 /posts/by-slug ·', data.post.body_source);
          return adaptD1PostShape(data.post);
        }
        break;   // ok but no post → treat as not found
      }
      status = res.status;
      if (res.status === 404) break;   // genuinely not found — don't retry
      console.warn('[article] /posts/by-slug non-ok status:', res.status);
    } catch (e) {
      console.warn('[article] /posts/by-slug failed (attempt ' + (attempt + 1) + ')', e);
    }
    if (attempt < 2) await new Promise(function (r) { setTimeout(r, 500 * (attempt + 1)); });
  }
  throw new Error(status === 404 ? 'Post not found' : 'Couldn\'t load the article');
}

// Normalize D1 post shape (snake_case fields) to the RSS-style shape the
// rest of the page expects. Cheap to do client-side so we don't have to
// touch the renderer.
function adaptD1PostShape(p) {
  return {
    title:        p.title,
    slug:         p.slug,
    link:         '/post/' + encodeURIComponent(p.slug) + '/',   // in-repo canonical (never the old Wix URL)
    summary:      p.excerpt || '',
    image:        p.cover_image || '',
    pubDate:      p.published_iso || (p.published_at ? new Date(p.published_at * 1000).toUTCString() : ''),
    published_iso:p.published_iso || '',
    seo_title:    p.seo_title || '',
    seo_description: p.seo_description || '',
    author:       p.author_name || '',
    author_name:  p.author_name || '',
    categories:   p.categories || [],
    content_html: p.body_html || '',
    source_url:   '',   // was p.wix_url — never surface the old Wix URL
    body_source:  p.body_source || 'd1',
    status:       p.status || '',
  };
}

// ===================================================================
// RSS parser (extended to keep content:encoded)
// ===================================================================
function parseRssXmlFull(xmlText) {
  let doc;
  try { doc = new DOMParser().parseFromString(xmlText, 'application/xml'); }
  catch { return []; }
  if (doc.querySelector('parsererror')) return [];
  return [...doc.querySelectorAll('item')].map(it => {
    const desc = textOf(it, 'description');
    const cats = [...it.querySelectorAll('category')].map(c => (c.textContent || '').trim()).filter(Boolean);
    const enc  = it.querySelector('enclosure');
    const link = textOf(it, 'link');
    let slug = '';
    try { slug = new URL(link).pathname.replace(/^\/post\//, '').replace(/^\/+|\/+$/g, ''); } catch {}
    // content:encoded is namespaced; getElementsByTagNameNS gets it
    const content = it.getElementsByTagName('content:encoded')[0]
                 || it.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0];
    return {
      title:   textOf(it, 'title'),
      link, slug,
      pubDate: textOf(it, 'pubDate'),
      summary: stripHtmlClient(desc).slice(0, 240),
      image:   (enc && enc.getAttribute('url')) || pickImgFromHtml(desc),
      categories: cats,
      author:  (it.getElementsByTagName('dc:creator')[0]?.textContent || '').trim(),
      content_html: content ? content.textContent : '',
    };
  }).filter(it => it.title && it.link);
}
function textOf(el, tag) { const c = el.querySelector(tag); return ((c && c.textContent) || '').trim(); }
function stripHtmlClient(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function pickImgFromHtml(html) { const m = String(html || '').match(/<img[^>]+src="([^"]+)"/i); return m ? m[1] : ''; }

// ===================================================================
// RENDER ARTICLE
// ===================================================================
function ensureMeta(key, content, isProperty) {
  const attr = isProperty ? 'property' : 'name';
  let el = document.head.querySelector('meta[' + attr + '="' + key + '"]');
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute('content', content || '');
}
function ensureLink(rel, href) {
  let el = document.head.querySelector('link[rel="' + rel + '"]');
  if (!el) { el = document.createElement('link'); el.setAttribute('rel', rel); document.head.appendChild(el); }
  el.setAttribute('href', href);
}
function injectArticleJsonLd(post, url, desc) {
  try {
    const old = document.getElementById('article-jsonld'); if (old) old.remove();
    const ld = {
      '@context': 'https://schema.org', '@type': 'NewsArticle',
      headline: post.title || '', description: desc || '',
      image: post.image ? [post.image] : undefined,
      datePublished: post.published_iso || post.pubDate || undefined,
      dateModified: post.updated_iso || post.published_iso || post.pubDate || undefined,
      author: post.author_name
        ? (/^jake nicholas$/i.test(post.author_name)
            ? { '@type': 'Person', name: post.author_name, url: 'https://www.oftmw.com/team', sameAs: ['https://www.oftmw.com/team', 'https://www.linkedin.com/in/jake-nicholas/'] }
            : { '@type': 'Person', name: post.author_name })
        : { '@type': 'Organization', name: 'Markets of Tomorrow' },
      publisher: { '@type': 'Organization', name: 'Markets of Tomorrow', logo: { '@type': 'ImageObject', url: 'https://media.oftmw.com/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png' } },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    };
    const s = document.createElement('script'); s.type = 'application/ld+json'; s.id = 'article-jsonld';
    s.textContent = JSON.stringify(ld);
    document.head.appendChild(s);
  } catch (e) {}
}
function renderArticle(post) {
  // Page metadata
  const seoTitle = post.seo_title || post.title || '';
  const seoDesc  = post.seo_description || post.summary || '';
  document.title = seoTitle + ' — Markets of Tomorrow';
  setMeta('meta-description', 'content', seoDesc);
  setMeta('og-title', 'content', post.title);
  setMeta('og-description', 'content', seoDesc);
  if (post.image) setMeta('og-image', 'content', post.image);
  // ── Canonical + og:url + Twitter + JSON-LD (SEO) ──────────────────
  // Canonical points at the path-based pre-rendered page (the indexed URL),
  // not this ?slug= SPA fallback — keeps crawlers on one canonical per post.
  const canonical = post.slug
    ? (location.origin + '/post/' + encodeURIComponent(post.slug) + '/')
    : (location.origin + location.pathname);
  ensureLink('canonical', canonical);
  ensureMeta('og:url', canonical, true);
  ensureMeta('og:site_name', 'Markets of Tomorrow', true);
  ensureMeta('twitter:title', seoTitle, false);
  ensureMeta('twitter:description', seoDesc, false);
  if (post.image) ensureMeta('twitter:image', post.image, false);
  injectArticleJsonLd(post, canonical, seoDesc);

  // Main category only, as gold-glow text.
  const cats = (post.categories || []).filter(c => !/markets of tomorrow|of tomorrow/i.test(c));
  const mainCat = post.main_category || cats[0] || '';
  const catRow = document.getElementById('cat-row');
  catRow.innerHTML = mainCat ? `<span class="main-cat">${escapeHtml(mainCat)}</span>` : '';

  // Title + deck (deck = derived from summary if it's punchy enough)
  document.getElementById('article-title').textContent = post.title;
  const deckEl = document.getElementById('article-deck');
  const deck = (post.summary || '').replace(/\s+/g, ' ').trim();
  if (deck && deck.length > 30 && deck.length < 240) deckEl.textContent = deck;
  else deckEl.style.display = 'none';

  // Byline — when the author is Jake Nicholas, link the name to /team (plain, no
  // underline or link color) so his articles tie back to his founder entity.
  var _authName = post.author || 'Markets of Tomorrow', _authEl = document.getElementById('article-author');
  if (/^jake nicholas$/i.test(_authName)) {
    _authEl.textContent = '';
    var _al = document.createElement('a');
    _al.href = '/team/'; _al.textContent = _authName;
    _al.style.color = 'inherit'; _al.style.textDecoration = 'none';
    _authEl.appendChild(_al);
  } else {
    _authEl.textContent = _authName;
  }
  document.getElementById('article-date').textContent = post.pubDate ? formatLongDate(post.pubDate) : '';

  // Cover image
  const cover = document.getElementById('article-cover-img');
  if (post.image) {
    cover.src = post.image;
    cover.alt = post.title;
    cover.classList.remove('skel-block');
  } else {
    cover.style.display = 'none';
  }

  // Body — drop the leading copy of the cover image (it's the same file).
  let bodyHtml = post.content_html || '';
  if (post.image && bodyHtml) {
    const re = new RegExp('<figure\\b[^>]*>(?:(?!</figure>).)*?<img\\b[^>]*\\bsrc="' + post.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>.*?</figure>', 'is');
    if (re.test(bodyHtml)) bodyHtml = bodyHtml.replace(re, '');
    else bodyHtml = bodyHtml.replace(new RegExp('<img\\b[^>]*\\bsrc="' + post.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>', 'i'), '');
  }
  const bodyEl = document.getElementById('article-body-content');
  if (!bodyHtml) {
    bodyEl.innerHTML = `<p>${escapeHtml(post.summary || 'No preview available for this story yet.')}</p>`;
  } else {
    bodyEl.innerHTML = sanitizeHtml(bodyHtml);
    upgradeBodyImages(bodyEl);
    hookGalleries(bodyEl);
    hookLightbox(bodyEl);
  }
  // The body (incl. any tmw-project-card embed) is now in the DOM — tell
  // project-card.js to (re)hydrate, since it likely ran before this injection.
  document.dispatchEvent(new CustomEvent('tmw:article-ready'));
}

function renderArticleEmpty(title, msg, legacyUrl, technicalErr) {
  const article = document.getElementById('article-root');
  article.innerHTML = `<div class="art-empty">
    <h2>${escapeHtml(title)}</h2>
    <p>${msg || ''}</p>
    <a class="legacy-link" href="/">Browse the latest
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
    </a>
    ${technicalErr ? `<div class="err">${escapeHtml(technicalErr)}</div>` : ''}
  </div>`;
}

// ===================================================================
// SANITIZER — allowlist tags + attributes, strip scripts/handlers
// ===================================================================
const ALLOWED_TAGS = new Set([
  'p','h1','h2','h3','h4','h5','h6','blockquote','figure','figcaption',
  'a','img','video','iframe','source','picture',
  'ul','ol','li','strong','em','b','i','u','span','br','hr',
  'pre','code','small','sub','sup','table','thead','tbody','tr','td','th',
  'div','section','article',
  // gallery controls (prev/next arrows render as button>svg>path)
  'button','svg','path'
]);
// Tags that get DELETED outright (including all their text/children).
// Distinct from "not allowed" which just unwraps — these would otherwise
// leak their text contents into the article body when unwrapped.
const DROP_TAGS = new Set(['script','style','noscript','meta','link','head','title']);
const ALLOWED_ATTRS = new Set([
  'href','src','srcset','sizes','alt','title','width','height','target','rel','colspan','rowspan',
  'controls','autoplay','muted','playsinline','loop','preload','poster','allow','allowfullscreen',
  'frameborder','loading',
  // svg + button accessibility
  'viewBox','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','d','aria-label','aria-hidden','type'
]);
const ALLOWED_IFRAME_HOSTS = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be',
  'vimeo.com', 'player.vimeo.com',
  'open.spotify.com',
  'instagram.com', 'twitter.com', 'x.com',
  'oftmw.com'   // map.oftmw.com — the linked-project Map of Tomorrow embed
];

function sanitizeHtml(html) {
  const parser = new DOMParser();
  // Wrap in a unique root so we can clearly extract the cleaned innerHTML
  const doc = parser.parseFromString(`<!DOCTYPE html><html><body><div id="__tmwroot">${html}</div></body></html>`, 'text/html');
  const root = doc.getElementById('__tmwroot');
  walk(root);
  return root.innerHTML;
}

function walk(node) {
  // Walk children first so we can safely remove during iteration
  const kids = [...node.children];
  for (const child of kids) walk(child);

  if (node.nodeType !== 1) return;
  const tag = node.tagName.toLowerCase();

  // Hard-DELETE script/style/etc — including their text contents — so
  // Wix's pro-gallery init code doesn't leak into the visible article.
  if (DROP_TAGS.has(tag)) {
    node.parentNode.removeChild(node);
    return;
  }
  // Drop other unknown tags but keep their text (unwrap children)
  if (!ALLOWED_TAGS.has(tag)) {
    while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
    node.parentNode.removeChild(node);
    return;
  }

  // Iframe URL allowlist (embeds only — block trackers/junk)
  if (tag === 'iframe') {
    const src = node.getAttribute('src') || '';
    let ok = false;
    try {
      const host = new URL(src).host.toLowerCase();
      ok = ALLOWED_IFRAME_HOSTS.some(h => host === h || host.endsWith('.' + h));
    } catch { ok = false; }
    if (!ok) { node.parentNode.removeChild(node); return; }
  }

  // Strip attributes that aren't in the allowlist or are dangerous
  [...node.attributes].forEach(attr => {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) { node.removeAttribute(attr.name); return; }
    if (name === 'style') { node.removeAttribute(attr.name); return; }
    if (name === 'class') {
      // Keep only OUR own component classes (tmw-*) plus a small set of
      // direction/state modifiers (prev/next/on/off/active) — drop Wix's
      // hashed class names. Without `prev` and `next`, the gallery's
      // left/right arrow positioning + JS click bindings break.
      const keep = attr.value.split(/\s+/)
        .filter(c => /^tmw-/.test(c) || /^(prev|next|on|off|active)$/.test(c))
        .join(' ');
      if (keep) node.setAttribute('class', keep);
      else node.removeAttribute('class');
      return;
    }
    if (!ALLOWED_ATTRS.has(name) && !name.startsWith('data-')) {
      node.removeAttribute(attr.name);
      return;
    }
    if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
      node.removeAttribute(attr.name);
    }
  });

  // External links: add safe target + rel
  if (tag === 'a') {
    const href = node.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener');
    }
  }
}

function upgradeBodyImages(root) {
  root.querySelectorAll('img').forEach(img => {
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.removeAttribute('width');
    img.removeAttribute('height');
  });
}

// Wire up scroll-snap gallery slideshows after the article body renders.
// Each .tmw-gallery has a horizontal scroll track + prev/next arrows +
// "1 / N" counter. CSS handles snapping; this just adds button clicks
// and keeps the counter in sync as the user scrolls.
function hookGalleries(root) {
  root.querySelectorAll('.tmw-gallery').forEach(g => {
    const track = g.querySelector('.tmw-gallery-track');
    if (!track) return;
    const slides = [...track.children];
    if (!slides.length) return;
    // Inject prev/next arrows + "1 / N" counter when the markup didn't include
    // them (studio-created galleries emit just the track; Wix imports ship the
    // controls). Single-slide galleries get none.
    let prev = g.querySelector('.tmw-gallery-arrow.prev');
    let next = g.querySelector('.tmw-gallery-arrow.next');
    let counter = g.querySelector('.tmw-gallery-counter');
    if (slides.length > 1) {
      if (!prev) { prev = document.createElement('button'); prev.className = 'tmw-gallery-arrow prev'; prev.setAttribute('aria-label', 'Previous'); prev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>'; g.appendChild(prev); }
      if (!next) { next = document.createElement('button'); next.className = 'tmw-gallery-arrow next'; next.setAttribute('aria-label', 'Next'); next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>'; g.appendChild(next); }
      if (!counter) { counter = document.createElement('div'); counter.className = 'tmw-gallery-counter'; g.appendChild(counter); }
    }
    const sync = () => {
      const i = Math.min(slides.length - 1, Math.max(0, Math.round(track.scrollLeft / track.clientWidth)));
      if (counter) counter.textContent = (i + 1) + ' / ' + slides.length;
      if (prev) prev.disabled = i <= 0;
      if (next) next.disabled = i >= slides.length - 1;
    };
    prev?.addEventListener('click', () => track.scrollBy({ left: -track.clientWidth, behavior: 'smooth' }));
    next?.addEventListener('click', () => track.scrollBy({ left:  track.clientWidth, behavior: 'smooth' }));
    track.addEventListener('scroll', sync, { passive: true });
    // Initial sync after layout settles
    requestAnimationFrame(sync);
    setTimeout(sync, 200);
  });
}

// ===================================================================
// LIGHTBOX — click any article image (single or gallery) to view it
// full-screen on a dark backdrop. Gallery images get prev/next arrows +
// a counter; single images just get the close (×). Esc / backdrop / × close.
// ===================================================================
const LB = { items: [], idx: 0, el: null };

function ensureLightbox() {
  if (LB.el) return;
  const el = document.createElement('div');
  el.className = 'tmw-lb';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML =
    '<button class="tmw-lb-close" aria-label="Close">×</button>' +
    '<button class="tmw-lb-arrow prev" aria-label="Previous image"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>' +
    '<img class="tmw-lb-img" alt="">' +
    '<button class="tmw-lb-arrow next" aria-label="Next image"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>' +
    '<div class="tmw-lb-counter"></div>' +
    '<div class="tmw-lb-cap"></div>';
  document.body.appendChild(el);
  LB.el = el;
  LB.img = el.querySelector('.tmw-lb-img');
  LB.prevBtn = el.querySelector('.tmw-lb-arrow.prev');
  LB.nextBtn = el.querySelector('.tmw-lb-arrow.next');
  LB.counter = el.querySelector('.tmw-lb-counter');
  LB.cap = el.querySelector('.tmw-lb-cap');
  el.querySelector('.tmw-lb-close').addEventListener('click', closeLightbox);
  LB.prevBtn.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
  LB.nextBtn.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });
  // Click the dark backdrop (not the image / controls) to close.
  el.addEventListener('click', (e) => { if (e.target === el) closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (!LB.el || !LB.el.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
  });
}

function lbCaptionFor(img) {
  const fig = img.closest('figure');
  if (fig) { const fc = fig.querySelector('figcaption'); if (fc) return (fc.textContent || '').trim(); }
  const slide = img.closest('.tmw-gallery-track > *, .tmw-gallery-grid-item');
  if (slide) { const c = slide.querySelector('.tmw-gallery-caption, figcaption'); if (c) return (c.textContent || '').trim(); }
  return '';
}

function stepLightbox(dir) {
  if (!LB.items.length) return;
  LB.idx = (LB.idx + dir + LB.items.length) % LB.items.length;
  renderLightbox();
}

function renderLightbox() {
  const it = LB.items[LB.idx]; if (!it) return;
  LB.img.src = it.src;
  LB.img.alt = it.caption || '';
  LB.cap.textContent = it.caption || '';
  LB.cap.style.display = it.caption ? '' : 'none';
  const multi = LB.items.length > 1;
  LB.prevBtn.style.display = LB.nextBtn.style.display = LB.counter.style.display = multi ? '' : 'none';
  if (multi) LB.counter.textContent = (LB.idx + 1) + ' / ' + LB.items.length;
}

function openLightbox(items, idx) {
  ensureLightbox();
  LB.items = items; LB.idx = idx;
  renderLightbox();
  LB.el.classList.add('open');
  document.documentElement.style.overflow = 'hidden';
}

function closeLightbox() {
  if (!LB.el) return;
  LB.el.classList.remove('open');
  document.documentElement.style.overflow = '';
}

function hookLightbox(root) {
  if (!root) return;
  const imgs = [...root.querySelectorAll('img')];
  // Include the article cover image too (it lives outside the body).
  const cover = document.getElementById('article-cover-img');
  if (cover && cover.getAttribute('src')) imgs.unshift(cover);
  imgs.forEach((img) => {
    if (img.__lbHooked) return;
    img.__lbHooked = true;
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', (e) => {
      e.preventDefault();
      // Group: all images in the same gallery (slideshow track or grid); else solo.
      const gal = img.closest('.tmw-gallery-track, .tmw-gallery-grid');
      const group = gal ? [...gal.querySelectorAll('img')] : [img];
      const items = group.map((g) => ({ src: g.currentSrc || g.src, caption: lbCaptionFor(g) }));
      const idx = Math.max(0, group.indexOf(img));
      openLightbox(items, idx);
    });
  });
}

// ===================================================================
// READ NEXT — show 3 most-recent OTHER posts, preferring those in the
// SAME category/market (Florida, Hotels, Golf, etc.) as the current
// article. Falls back to any-recent if same-market yields < 3.
// ===================================================================
async function loadReadNext(currentPost, currentSlug) {
  try {
    let items = [];
    // 1. Prefer D1 posts table (migrated articles). Bumped from 10 to 30
    //    so there's enough pool to find 3 same-category matches without
    //    re-querying.
    try {
      const r = await fetch(WORKER_URL + '/posts?limit=30&status=published', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        items = (d.items || []).map(it => ({
          slug: it.slug,
          title: it.title,
          image: it.cover_image,
          pubDate: it.published_iso || (it.published_at ? new Date(it.published_at * 1000).toUTCString() : ''),
          categories: it.categories || [],
          main_category: it.main_category || '',
        }));
      }
    } catch {}
    // D1 is the only source — no Wix /blog or RSS fallback (TMW is off Wix).
    // Pull everything that isn't the current article first, NEWEST FIRST.
    const pool = items.filter(it => it.slug && it.slug !== currentSlug);

    // Build the set of category tokens that mark the current article.
    // Anything an article carries -- main_category OR each tag in
    // categories -- counts as a match signal.
    const curTokens = new Set();
    if (currentPost && currentPost.main_category) curTokens.add(String(currentPost.main_category).toLowerCase());
    if (currentPost && Array.isArray(currentPost.categories)) {
      currentPost.categories.forEach(c => { if (c) curTokens.add(String(c).toLowerCase()); });
    }
    function shareCategory(it) {
      if (!curTokens.size) return false;
      const itTokens = new Set();
      if (it.main_category) itTokens.add(String(it.main_category).toLowerCase());
      (it.categories || []).forEach(c => { if (c) itTokens.add(String(c).toLowerCase()); });
      for (const t of curTokens) if (itTokens.has(t)) return true;
      return false;
    }

    // Same-category first (newest first by pool order), then top up with
    // any other recent post so the section is always full when possible.
    const sameCat = pool.filter(shareCategory).slice(0, 3);
    const others = sameCat.length >= 3
      ? sameCat
      : sameCat.concat(pool.filter(it => !sameCat.includes(it)).slice(0, 3 - sameCat.length));

    if (!others.length) return;
    document.getElementById('read-next').style.display = '';
    document.getElementById('rn-grid').innerHTML = others.map(it => `<a class="rn-card" href="/post/${escapeAttr(it.slug)}/">
      <div class="rn-card-img">${it.image ? `<img src="${escapeAttr(it.image)}" alt="" loading="lazy">` : ''}</div>
      <div class="rn-card-body">
        ${it.pubDate ? `<div class="rn-card-date">${escapeHtml(formatLongDate(it.pubDate))}</div>` : ''}
        <h4 class="rn-card-title">${escapeHtml(it.title)}</h4>
      </div>
    </a>`).join('');
  } catch (e) { console.warn('[read-next] failed', e); }
}

// ===================================================================
// SHARED: banner carousel, pulse ticker, map counter, copy link
// (mirrors the home/golf implementations)
// ===================================================================
function hookBannerCollapse() {
  const banner = document.getElementById('banner-ad');
  if (!banner) return;
  let collapsed = false;
  const onScroll = () => {
    const should = (window.scrollY || 0) > 60;
    if (should !== collapsed) { collapsed = should; banner.classList.toggle('collapsed', collapsed); }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

const CAROUSEL = { slides: [], idx: 0, timer: null, intervalMs: 7000, hover: false };
async function loadAndRenderAd() {
  let data;
  try { const r = await fetch(ADS_URL, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); data = await r.json(); }
  catch { const b = document.getElementById('banner-ad'); if (b) b.style.display = 'none'; return; }
  CAROUSEL.intervalMs = Math.max(3000, (data.rotateSeconds || 7) * 1000);
  const now = new Date();
  CAROUSEL.slides = (data.ads || []).filter(a => {
    if (!a || !a.active) return false;
    if (a.starts && new Date(a.starts) > now) return false;
    if (a.ends && new Date(a.ends) < now) return false;
    const pl = a.placements || ['all'];
    if (!pl.includes('all') && !pl.includes(PLACEMENT)) return false;
    return !!(a.video || a.image);
  });
  for (var _i = CAROUSEL.slides.length - 1; _i > 0; _i--) { var _j = Math.floor(Math.random() * (_i + 1)); var _t = CAROUSEL.slides[_i]; CAROUSEL.slides[_i] = CAROUSEL.slides[_j]; CAROUSEL.slides[_j] = _t; }  // randomize order so each load opens on a different banner
  if (!CAROUSEL.slides.length) { const b = document.getElementById('banner-ad'); if (b) b.style.display = 'none'; return; }
  const track = document.getElementById('fc-track');
  const dots  = document.getElementById('fc-dots');
  track.innerHTML = CAROUSEL.slides.map((s, i) => slideHtml(s, i)).join('');
  dots.innerHTML  = CAROUSEL.slides.map((_, i) => `<button class="fc-dot${i === 0 ? ' on' : ''}" data-idx="${i}" aria-label="Slide ${i+1}"></button>`).join('');
  setSlide(0);
  hookCarousel();
  startCarouselTimer();
}
function slideHtml(s, i) {
  const onCls = i === 0 ? ' on' : '';
  const media = s.video
    ? `<video src="${escapeAttr(s.video)}" ${s.poster ? `poster="${escapeAttr(s.poster)}"` : ''} muted playsinline preload="metadata" ${i === 0 ? 'autoplay' : ''}></video>`
    : `<img src="${escapeAttr(s.image)}" alt="${escapeAttr(s.advertiser || '')}">`;
  return `<a class="fc-slide${onCls}" href="${escapeAttr(s.url || '#')}" target="_blank" rel="noopener sponsored" data-slide-id="${escapeAttr(s.id)}" onclick="logAdClick('${escapeAttr(s.id)}')">${media}</a>`;
}
// First-party click tracking (replaces Linkly) — mirrors the list-page carousels.
window.logAdClick = function (id) {
  try {
    var s = (CAROUSEL.slides || []).find(function (x) { return x && x.id === id; });
    if (window.tmwTrack) window.tmwTrack.click(id, 'ad', (s && s.advertiser) || '');
  } catch (e) {}
};
function setSlide(idx) {
  const slides = document.querySelectorAll('.fc-slide');
  const dots = document.querySelectorAll('.fc-dot');
  const sp = document.getElementById('fc-sponsor');
  if (!slides.length) return;
  CAROUSEL.idx = (idx + slides.length) % slides.length;
  slides.forEach((s, i) => {
    const active = i === CAROUSEL.idx;
    s.classList.toggle('on', active);
    const v = s.querySelector('video');
    if (v) { if (active) { try { v.currentTime = 0; v.play().catch(() => {}); } catch {} } else { try { v.pause(); v.currentTime = 0; } catch {} } }
  });
  dots.forEach((d, i) => d.classList.toggle('on', i === CAROUSEL.idx));
  const cur = CAROUSEL.slides[CAROUSEL.idx];
  if (sp) sp.textContent = cur && cur.advertiser ? 'Sponsored · ' + cur.advertiser : 'Sponsored';
  if (cur && cur.id && window.tmwTrack) window.tmwTrack.view(cur.id, 'ad', cur.advertiser || '');  // impression each time this slide is shown
}
function hookCarousel() {
  const root = document.getElementById('fc');
  document.getElementById('fc-prev')?.addEventListener('click', e => { e.preventDefault(); setSlide(CAROUSEL.idx - 1); startCarouselTimer(); });
  document.getElementById('fc-next')?.addEventListener('click', e => { e.preventDefault(); setSlide(CAROUSEL.idx + 1); startCarouselTimer(); });
  document.getElementById('fc-dots')?.addEventListener('click', e => {
    const b = e.target.closest('.fc-dot'); if (!b) return;
    setSlide(parseInt(b.dataset.idx, 10) || 0); startCarouselTimer();
  });
  root.addEventListener('mouseenter', () => { CAROUSEL.hover = true; stopCarouselTimer(); });
  root.addEventListener('mouseleave', () => { CAROUSEL.hover = false; startCarouselTimer(); });
  root.querySelectorAll('video').forEach(v => v.addEventListener('ended', () => {
    const s = v.closest('.fc-slide');
    if (s && s.classList.contains('on') && !CAROUSEL.hover) { setSlide(CAROUSEL.idx + 1); startCarouselTimer(); }
  }));
}
function startCarouselTimer() {
  if (CAROUSEL.slides.length < 2) return;
  stopCarouselTimer();
  // If the current slide is a VIDEO, let its natural 'ended' event
  // advance the carousel (so the video plays in full -- this is what
  // fixes the 8s Waldorf St. Pete getting cut off mid-playback). The
  // setTimeout below is a safety ceiling: if a video errors out and
  // never fires 'ended' (network stall, decoder failure, etc.) the
  // carousel won't freeze on a single ad forever.
  // IMAGE slides keep the configured rotateSeconds dwell.
  var cur = CAROUSEL.slides[CAROUSEL.idx];
  var isVideo = !!(cur && cur.video);
  var ms = isVideo ? 60000 : CAROUSEL.intervalMs;
  CAROUSEL.timer = setTimeout(function () {
    if (!CAROUSEL.hover) { setSlide(CAROUSEL.idx + 1); startCarouselTimer(); }
  }, ms);
}
function stopCarouselTimer() { if (CAROUSEL.timer) { clearInterval(CAROUSEL.timer); CAROUSEL.timer = null; } }

// Match the Pulse bubble (journal-dock.js) exactly: same undismissed set, same
// count, same titles (additions drop the "added to the map" suffix).
function pulseEid(e) { return e.id != null ? String(e.id) : (e.type + '|' + e.timestamp + '|' + (e.project_slug || e.title || '')); }
// "Now tracking …" (project-added-to-map) events are excluded from the pulse
// ticker entirely — article + status-change activity only.
function pulseNotTracking(e) {
  const t = (e.type || '').toLowerCase();
  if (t === 'new_project' || t === 'tracking') return false;
  const tag = (e.tag || '').toLowerCase();
  return tag.indexOf('new on map') === -1 && tag.indexOf('added') === -1;
}
// Recency window + order match the header bell exactly (journal-dock.js): by
// PUBLISH time (when we logged the item), not the historical milestone date.
const PULSE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
function pulsePub(e) { const t = new Date(e.timestamp || e.event_date || 0).getTime(); return isNaN(t) ? 0 : t; }
function pulseActive(list) {
  let d; try { d = new Set(JSON.parse(localStorage.getItem('tmw_pulse_dismissed') || '[]')); } catch (_) { d = new Set(); }
  const now = Date.now(), cutoff = now - PULSE_WINDOW_MS, upper = now + 2 * 24 * 60 * 60 * 1000;
  return list
    .filter(pulseNotTracking)
    .filter(e => { const t = pulsePub(e); return t >= cutoff && t <= upper; })
    .sort((a, b) => pulsePub(b) - pulsePub(a))
    .slice(0, 30)
    .filter(e => !d.has(pulseEid(e)));
}
function pulseTitle(e) {
  return String((e.type === 'new_project' ? (e.project_title || e.title) : (e.title || e.project_title)) || '').replace(/\s+/g, ' ').trim();
}

// Robust marquee (ported from the homepage): repeat the strip until one unit
// fills the viewport, then duplicate it for a seamless -50% loop, scaling the
// duration to width (~55px/s). Setting the animation INLINE also keeps it moving
// under prefers-reduced-motion — which is what froze the old mobile ticker.
let _pulseStrip = '';
function paintPulseTrack(strip) {
  const track = document.getElementById('ticker-track');
  if (!track || !strip) return;
  _pulseStrip = strip;
  const vp = (track.parentElement && track.parentElement.clientWidth) || window.innerWidth || 600;
  let unit = strip;
  track.style.animation = 'none';
  track.innerHTML = unit;
  let guard = 0;
  while (track.scrollWidth < vp + 40 && guard < 40) { unit += strip; track.innerHTML = unit; guard++; }
  track.innerHTML = unit + unit;
  const half = track.scrollWidth / 2;
  const secs = Math.max(18, Math.round(half / 55));
  void track.offsetWidth;
  track.style.animation = 'tickerScroll ' + secs + 's linear infinite';
}
let _pulseRz;
window.addEventListener('resize', () => { clearTimeout(_pulseRz); _pulseRz = setTimeout(() => { if (_pulseStrip) paintPulseTrack(_pulseStrip); }, 250); });

async function loadPulse() {
  try {
    const r = await fetch(PULSE_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('pulse ' + r.status);
    const d = await r.json();
    const events = (d.events || []).filter(e => e && e.title && e.link);
    if (!events.length) { setPulseBadge(0); return; }
    const active = pulseActive(events);
    setPulseBadge(active.length);
    if (!active.length) return;
    const cell = e => {
      const kind = e.type === 'article' ? 'article' : (e.type === 'status_change' ? 'status' : 'new');
      const age = e.timestamp ? relAge(e.timestamp) : '';
      return `<a class="ticker-item" href="${escapeAttr(e.link)}" target="_blank" rel="noopener">
        <span class="pdot ${kind}"></span>
        <span>${escapeHtml(pulseTitle(e))}</span>
        ${age ? `<span class="tage">${escapeHtml(age)}</span>` : ''}
      </a>`;
    };
    paintPulseTrack(active.slice(0, PULSE_MAX).map(cell).join(''));
  } catch (e) { console.warn('[pulse]', e); setPulseBadge(null); }
}
function setPulseBadge(n) {
  const el = document.getElementById('pulse-newcount');
  if (!el) return;
  if (n === null || n === undefined) { el.textContent = 'Live'; el.classList.remove('has'); return; }
  el.textContent = n + ' NEW';
  el.classList.toggle('has', n > 0);
}
function relAge(iso) {
  const ts = Date.parse(iso); if (!ts) return '';
  const mins = Math.max(1, Math.floor((Date.now() - ts) / 60000));
  if (mins < 60) return mins + 'm';
  if (mins < 60 * 24) return Math.floor(mins / 60) + 'h';
  const d = Math.floor(mins / (60 * 24));
  if (d < 30) return d + 'd';
  return Math.floor(d / 30) + 'mo';
}

async function updateMapCounter() {
  const el = document.getElementById('mc-count-n'); if (!el) return;
  try {
    const r = await fetch(PULSE_URL, { cache: 'no-store' });
    if (!r.ok) throw 0;
    const d = await r.json();
    const s = new Set();
    (d.events || []).forEach(e => { if (e.project_slug) s.add(e.project_slug); });
    el.textContent = (d.project_count || d.tracked || s.size || 387).toLocaleString();
  } catch { el.textContent = '387'; }
}

function hookCopyLink() {
  const btn = document.getElementById('share-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const shareData = { title: document.title, url: location.href };
    // Native share sheet where available (mobile + most modern browsers);
    // fall back to copying the link with a brief check-mark confirmation.
    if (navigator.share) {
      try { await navigator.share(shareData); return; }
      catch (e) { if (e && e.name === 'AbortError') return; /* else fall through to copy */ }
    }
    try {
      await navigator.clipboard.writeText(location.href);
      btn.classList.add('copied');
      btn.setAttribute('title', 'Link copied');
      setTimeout(() => { btn.classList.remove('copied'); btn.setAttribute('title', 'Share'); }, 1600);
    } catch (e) {}
  });
}

// ===================================================================
// FAVORITE button — heart next to Share. Signed-in: saves the article
// slug into Memberstack memberJSON.article_favorites and shows a brief
// "Saved to your favorites" toast; the saved article then appears in
// the new "Articles" tab of the account modal (tmw-auth-modal.js).
// Signed-out: opens the article sign-up modal (the same flow that
// auto-pops after 3s on every article), so the user can create a free
// account before saving anything.
// ===================================================================
function hookFavorite() {
  const shareWrap = document.querySelector('.article-hero .byline .share');
  if (!shareWrap) return;
  // Don't double-inject if init() runs twice (defensive).
  if (shareWrap.querySelector('#fav-btn')) return;

  // Follow-on-Google button — sits LEFT of the heart so the row reads
  // [follow] → [save] → [share] (broadest "subscribe" action first,
  // outward share last). Links to Google's source-preference page,
  // which lets a reader make oftmw.com a preferred source in Search /
  // News surfaces. Opens in a new tab; no auth or JS state to wire.
  // Comment counter — circle showing the live comment count; click jumps to the
  // comments section. (Replaces the old Google-follow "+".)
  const followLink = document.createElement('a');
  followLink.id = 'cmt-count-btn';
  followLink.className = 'share-ico cmt-count-ico';
  followLink.href = '#tmw-cmt';
  followLink.title = 'Jump to comments';
  followLink.setAttribute('aria-label', 'View comments');
  followLink.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
    '</svg>';
  followLink.addEventListener('click', function (e) { e.preventDefault(); var el = document.getElementById('tmw-cmt'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  const btn = document.createElement('button');
  btn.id = 'fav-btn';
  btn.className = 'share-ico fav-ico';
  btn.type = 'button';
  btn.title = 'Save to favorites';
  btn.setAttribute('aria-label', 'Save this article to your favorites');
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>' +
    '</svg>';
  // Insert order: follow (+) → heart → share. Both go BEFORE #share-btn.
  const shareBtn = shareWrap.querySelector('#share-btn');
  if (shareBtn) {
    shareWrap.insertBefore(followLink, shareBtn);
    shareWrap.insertBefore(btn, shareBtn);
  } else {
    shareWrap.appendChild(followLink);
    shareWrap.appendChild(btn);
  }

  // Article slug = last meaningful path segment of /post/<slug>/. Falls
  // back to ?slug= for the SPA case (legacy path).
  function currentSlug() {
    const m = location.pathname.match(/^\/post\/([^\/]+)\/?$/);
    if (m && m[1]) return decodeURIComponent(m[1]);
    const qs = new URLSearchParams(location.search);
    return (qs.get('slug') || '').trim();
  }
  const slug = currentSlug();
  if (!slug) return;

  // Tiny in-page toast. We position it INSIDE .share so it floats above
  // the byline row without needing a fixed-position container.
  function showToast(msg, kind) {
    let host = document.getElementById('fav-toast');
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'fav-toast';
    host.className = 'fav-toast' + (kind === 'err' ? ' err' : '');
    host.textContent = msg;
    document.body.appendChild(host);
    requestAnimationFrame(() => host.classList.add('show'));
    setTimeout(() => {
      host.classList.remove('show');
      setTimeout(() => { if (host.parentNode) host.parentNode.removeChild(host); }, 260);
    }, 1800);
  }

  // Merge-fetch-write (Memberstack updateMemberJSON REPLACES the blob).
  async function saveMemberJson(patch) {
    const ms = window.$memberstackDom;
    if (!ms) return;
    const cur = await ms.getMemberJSON();
    const json = (cur && cur.data && typeof cur.data === 'object') ? cur.data : {};
    for (const k in patch) json[k] = patch[k];
    await ms.updateMemberJSON({ json });
  }

  // Read current saved state once, so the heart loads filled if the
  // article is already a favorite. Non-blocking; on failure we just
  // leave the heart empty.
  let saved = false;
  function paint() { btn.classList.toggle('saved', saved); btn.title = saved ? 'Saved — click to remove' : 'Save to favorites'; }
  (async () => {
    const ms = window.$memberstackDom;
    if (!ms || !ms.getCurrentMember) return;
    try {
      const r = await ms.getCurrentMember();
      if (!r || !r.data) return;
      const got = await ms.getMemberJSON();
      const json = (got && got.data && typeof got.data === 'object') ? got.data : {};
      const favs = Array.isArray(json.article_favorites) ? json.article_favorites : [];
      saved = favs.indexOf(slug) !== -1;
      paint();
    } catch (e) {}
  })();

  btn.addEventListener('click', async () => {
    const ms = window.$memberstackDom;
    // Signed-out -> open the article sign-up modal (same one that auto-
    // pops at 3s). It's a global helper installed by tmw-auth-modal.js.
    let member = null;
    if (ms && ms.getCurrentMember) {
      try { const r = await ms.getCurrentMember(); member = r && r.data; } catch (e) {}
    }
    if (!member) {
      // Prefer the inline article sign-up flow (the same lightbox that
      // auto-pops on every article at 3s — email then password). Falls
      // back to the full account modal, and finally Memberstack's own
      // signup modal if neither is installed.
      if (typeof window.tmwArticleSignup === 'function') {
        window.tmwArticleSignup();
      } else if (typeof window.tmwAuthModal === 'function') {
        window.tmwAuthModal('signup');
      } else if (ms && typeof ms.openModal === 'function') {
        try { ms.openModal('SIGNUP'); } catch (e) {}
      }
      return;
    }
    // Signed-in -> toggle save. Optimistic UI, revert on error.
    const wasSaved = saved;
    saved = !wasSaved;
    paint();
    try {
      const got = await ms.getMemberJSON();
      const json = (got && got.data && typeof got.data === 'object') ? got.data : {};
      const favs = Array.isArray(json.article_favorites) ? json.article_favorites.slice() : [];
      const idx = favs.indexOf(slug);
      if (saved && idx === -1) favs.unshift(slug);   // newest first
      else if (!saved && idx !== -1) favs.splice(idx, 1);
      await saveMemberJson({ article_favorites: favs });
      showToast(saved ? 'Saved to your favorites' : 'Removed from favorites');
      try { if (window.gtag) window.gtag('event', saved ? 'article_favorite' : 'article_unfavorite', { slug }); } catch (_) {}
    } catch (e) {
      saved = wasSaved; paint();
      showToast('Couldn’t save — try again', 'err');
    }
  });
}

// ===================================================================
// Helpers
// ===================================================================
function setMeta(id, attr, val) { const el = document.getElementById(id); if (el && val) el.setAttribute(attr, val); }
function formatLongDate(s) { const d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// ===================================================================
// SUBSCRIBE LIGHTBOX — now the ONE shared funnel (journal-signup-funnel.js),
// loaded site-wide by journal-chrome.js, so articles use the EXACT same popup
// (boxes, 4 steps, IP/beacon wiring) as every other page. The article headline
// + 'subscribe_article' beacon are set via window.TMW_FUNNEL_OPTS in
// journal-chrome.js's contextual block. This shim just routes the heart-button
// (hookFavorite) into that shared funnel, preserving window.tmwArticleSignup.
// ===================================================================
window.tmwArticleSignup = function () {
  function go() {
    var f = window.tmwSignupFunnel;
    if (!f) return;
    var subEmail = null;
    try { subEmail = localStorage.getItem('tmw-sub-email'); } catch (e) {}
    if (subEmail && f.account) {
      try { sessionStorage.removeItem('tmw-acct-skip'); } catch (e) {}
      f.account(subEmail);   // returning subscriber → "add a password" step
    } else if (f.email) {
      f.email();             // first-timer → email capture
    } else if (f.open) {
      f.open();
    }
  }
  if (window.tmwSignupFunnel) { go(); return; }
  // Funnel not up yet — load it (chrome loads it too; the script is a singleton)
  // then fire. Mirrors journal-chrome.js's on-demand funnel loader.
  var existing = document.querySelector('script[data-tmw-funnel-loader]');
  if (existing) { existing.addEventListener('load', go); return; }
  var s = document.createElement('script');
  s.src = '/_shared/journal-signup-funnel.js';
  s.setAttribute('data-tmw-funnel-loader', '');
  s.onload = go;
  document.body.appendChild(s);
};

// ===================================================================
// ARTICLE COMMENTS — everyone reads; any member at Reader level (lvl≥2)
// publish. Self-contained: injects its own CSS + mounts after #read-next.
// ===================================================================
function setCmtCountBtn(n) {
  var b = document.getElementById('cmt-count-btn'); if (!b) return;
  n = n || 0;
  var bd = b.querySelector('.cc-badge');
  if (!bd) { bd = document.createElement('span'); bd.className = 'cc-badge'; b.appendChild(bd); }
  bd.textContent = n;
  bd.style.display = n > 0 ? '' : 'none';
  b.title = n + ' comment' + (n === 1 ? '' : 's');
}
function initComments(slug, post) {
  if (!slug || window.__tmwComments) return; window.__tmwComments = true;
  var WORKER = WORKER_URL;
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
  function ago(ts){var s=Math.floor(Date.now()/1000)-ts;if(s<60)return'just now';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';var d=Math.floor(h/24);if(d<30)return d+'d ago';return new Date(ts*1000).toLocaleDateString();}
  var CSS='.tmw-cmt{max-width:760px;margin:64px auto 64px;padding:42px 26px 0;font-family:Inter,system-ui,sans-serif;color:#ECEAE5;position:relative}'
    +'.tmw-cmt:before{content:"";position:absolute;top:0;left:0;right:0;width:100%;height:1px;background:linear-gradient(90deg,transparent,rgba(167,139,250,.35),rgba(230,197,116,.25),transparent)}'
    +'.tmw-cmt-h{display:flex;align-items:center;gap:11px;font-family:Fraunces,Georgia,serif;font-size:25px;font-weight:600;color:#fff;margin:0 0 22px;letter-spacing:-.01em}'
    +'.tmw-cmt-h #tmw-cmt-n{font-family:JetBrains Mono,monospace;font-size:12px;font-weight:700;letter-spacing:.04em;color:#B9A6FF;background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.28);border-radius:999px;padding:3px 10px;line-height:1}'
    +'.tmw-cmt-box{display:flex;gap:13px;margin-bottom:30px}'
    +'.tmw-cmt-av{width:40px;height:40px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-family:Fraunces,serif;font-weight:600;font-size:15px;background:#15171c;color:#9AA39C;border:1px solid rgba(255,255,255,.08)}'
    +'.tmw-cmt-av.me{background:radial-gradient(circle at 30% 25%,rgba(230,197,116,.30),rgba(230,197,116,.05));color:#e6c574;border-color:rgba(230,197,116,.45);box-shadow:0 0 16px rgba(230,197,116,.22)}'
    +'.tmw-cmt-boxr{flex:1;position:relative;border-radius:16px;background:rgba(255,255,255,.022);border:1px solid rgba(255,255,255,.10);transition:border-color .2s,box-shadow .2s}'
    +'.tmw-cmt-boxr:focus-within{border-color:rgba(167,139,250,.55);box-shadow:0 0 0 1px rgba(167,139,250,.22),0 0 34px rgba(167,139,250,.15)}'
    +'.tmw-cmt-box textarea{width:100%;background:transparent;border:none;color:#ECEAE5;font-family:Inter,sans-serif;font-size:14.5px;line-height:1.55;padding:14px 16px 0;resize:none;min-height:52px;max-height:260px;display:block}'
    +'.tmw-cmt-box textarea:focus{outline:none}.tmw-cmt-box textarea::placeholder{color:#6f766f}'
    +'.tmw-cmt-bar{display:flex;align-items:center;gap:12px;padding:9px 11px 11px}'
    +'.tmw-cmt-bar .pub{font-family:JetBrains Mono,monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#7d8a7f;display:inline-flex;align-items:center;gap:7px}'
    +'.tmw-cmt-bar .pub .dot{width:5px;height:5px;border-radius:50%;background:#1FDF67;box-shadow:0 0 8px #1FDF67}'
    +'.tmw-cmt-msg{margin-left:auto;font-size:12px;color:#9AA39C}'
    +'.tmw-cmt-post{appearance:none;border:none;cursor:pointer;font-family:Inter,sans-serif;font-size:13px;font-weight:600;padding:9px 20px;border-radius:10px;background:linear-gradient(135deg,#f0d68a,#e6c574);color:#4a3708;box-shadow:0 0 18px rgba(230,197,116,.26);transition:transform .15s,box-shadow .2s,opacity .2s}'
    +'.tmw-cmt-msg~.tmw-cmt-post{margin-left:0}.tmw-cmt-bar .pub~.tmw-cmt-post{margin-left:auto}'
    +'.tmw-cmt-post:hover{transform:translateY(-1px);box-shadow:0 0 26px rgba(230,197,116,.45)}'
    +'.tmw-cmt-post:disabled{opacity:.5;cursor:default;box-shadow:none;transform:none}'
    +'.tmw-cmt-list{display:flex;flex-direction:column;gap:13px}'
    +'.tmw-cmt-item{display:flex;gap:13px;padding:15px 16px;border-radius:15px;background:rgba(255,255,255,.018);border:1px solid rgba(255,255,255,.06);transition:border-color .2s,background .2s}'
    +'.tmw-cmt-item:hover{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.03)}'
    +'.tmw-cmt-bd{flex:1;min-width:0}'
    +'.tmw-cmt-meta{display:flex;align-items:center;gap:9px;margin-bottom:5px}'
    +'.tmw-cmt-meta b{font-size:13.5px;font-weight:600;color:#fff}'
    +'.tmw-cmt-meta .t{font-family:JetBrains Mono,monospace;font-size:10px;letter-spacing:.03em;color:#6f766f}'
    +'.tmw-cmt-txt{font-size:14.5px;line-height:1.6;color:#d6d8d2;white-space:pre-wrap;word-wrap:break-word}'
    +'.tmw-cmt-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px;padding:42px 20px 46px;border:1px solid rgba(255,255,255,.07);border-radius:18px;background:radial-gradient(540px 170px at 50% -25%,rgba(167,139,250,.11),transparent),rgba(255,255,255,.012);color:#9AA39C}'
    +'.tmw-cmt-empty .ico{width:52px;height:52px;border-radius:15px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(167,139,250,.18),rgba(230,197,116,.10));color:#B9A6FF;border:1px solid rgba(255,255,255,.08);margin-bottom:14px;box-shadow:0 0 26px rgba(167,139,250,.20)}'
    +'.tmw-cmt-empty .ico svg{width:25px;height:25px}'
    +'.tmw-cmt-empty b{font-family:Fraunces,Georgia,serif;font-size:20px;font-weight:600;color:#fff}'
    +'.tmw-cmt-empty span{font-size:13.5px;max-width:40ch;line-height:1.55}'
    +'.tmw-cmt-loading{font-family:JetBrains Mono,monospace;color:#6f766f;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:14px 2px}'
    +'.tmw-cmt-lock{position:relative;border:1px solid rgba(167,139,250,.22);border-radius:16px;padding:24px;background:radial-gradient(620px 200px at 88% -40%,rgba(167,139,250,.16),transparent),rgba(255,255,255,.02);margin-bottom:30px;overflow:hidden}'
    +'.tmw-cmt-pro{position:absolute;top:18px;right:18px;font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;letter-spacing:.1em;color:#4a3708;background:linear-gradient(135deg,#f0d68a,#e6c574);border-radius:999px;padding:3px 10px;box-shadow:0 0 16px rgba(230,197,116,.3)}'
    +'.tmw-cmt-lt{font-family:Fraunces,serif;font-size:18px;font-weight:600;color:#fff;margin-bottom:6px}'
    +'.tmw-cmt-ls{font-size:13.5px;color:#9AA39C;line-height:1.55;max-width:78%;margin-bottom:16px}'
    +'.tmw-cmt-cta{appearance:none;border:none;cursor:pointer;background:linear-gradient(135deg,#c4b5fd,#A78BFA);color:#1a1340;font-family:Inter,sans-serif;font-size:13px;font-weight:600;padding:10px 20px;border-radius:10px;box-shadow:0 0 20px rgba(167,139,250,.35)}'
    +'.tmw-cmt-cta:hover{box-shadow:0 0 28px rgba(167,139,250,.55)}'
    +'.cmt-count-ico{position:relative;overflow:visible}'
    +'.cc-badge{position:absolute;top:-5px;right:-5px;min-width:17px;height:17px;padding:0 4px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif;font-size:10px;font-weight:700;line-height:1;color:#B9A6FF;background:rgba(167,139,250,.20);border:1px solid rgba(167,139,250,.5);box-shadow:0 0 11px rgba(167,139,250,.55)}';
  if(!document.getElementById('tmw-cmt-css')){var st=document.createElement('style');st.id='tmw-cmt-css';st.textContent=CSS;document.head.appendChild(st);}

  // If a full-bleed project card is the last block of the article, drop its
  // bottom margin so the gap to comments matches articles without a hero card.
  try{ var bc=document.getElementById('article-body-content'); if(bc){ var pcs=bc.querySelectorAll('.tmw-pcard'); if(pcs.length){ var lp=pcs[pcs.length-1], n=lp, trailing=false; while((n=n.nextElementSibling)){ if((n.textContent||'').trim()||(n.querySelector&&n.querySelector('img'))){trailing=true;break;} } if(!trailing) lp.style.marginBottom='0'; } } }catch(e){}

  var wrap=document.createElement('section'); wrap.className='tmw-cmt'; wrap.id='tmw-cmt';
  wrap.innerHTML='<h2 class="tmw-cmt-h">Comments <span id="tmw-cmt-n"></span></h2><div id="tmw-cmt-compose"></div><div id="tmw-cmt-list" class="tmw-cmt-list"><div class="tmw-cmt-loading">Loading comments…</div></div>';
  var rn=document.getElementById('read-next');
  if(rn&&rn.parentNode){ rn.parentNode.insertBefore(wrap, rn); }
  else { var art=document.querySelector('article')||document.getElementById('article-root'); if(art&&art.parentNode){ art.parentNode.insertBefore(wrap, art.nextSibling); } else { document.body.appendChild(wrap); } }
  var listEl=wrap.querySelector('#tmw-cmt-list'), nEl=wrap.querySelector('#tmw-cmt-n'), composeEl=wrap.querySelector('#tmw-cmt-compose');

  function itemHTML(c,when){return '<div class="tmw-cmt-av">'+esc((c.name||'M').slice(0,1).toUpperCase())+'</div><div class="tmw-cmt-bd"><div class="tmw-cmt-meta"><b>'+esc(c.name||'Member')+'</b><span class="t">'+(when||ago(c.ts))+'</span></div><div class="tmw-cmt-txt">'+esc(c.body)+'</div></div>';}
  function setCount(n){ nEl.textContent=n||''; nEl.style.display=n?'':'none'; }
  var EMPTY='<div class="tmw-cmt-empty"><span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span><b>Start the conversation</b><span>Be the first to share a take on this story — your comment is public and joins the conversation.</span></div>';
  function renderList(items){ setCmtCountBtn(items.length); if(!items.length){listEl.innerHTML=EMPTY;setCount(0);return;} setCount(items.length); listEl.innerHTML=items.map(function(c){return '<div class="tmw-cmt-item">'+itemHTML(c)+'</div>';}).join(''); }
  function prepend(c){ var e=listEl.querySelector('.tmw-cmt-empty'); if(e)listEl.innerHTML=''; var div=document.createElement('div'); div.className='tmw-cmt-item'; div.innerHTML=itemHTML(c,'just now'); listEl.insertBefore(div,listEl.firstChild); var _n=listEl.querySelectorAll('.tmw-cmt-item').length; setCount(_n); setCmtCountBtn(_n); }

  fetch(WORKER+'/comments?post='+encodeURIComponent(slug),{cache:'no-store'}).then(function(r){return r.ok?r.json():{comments:[]}}).then(function(d){renderList((d&&d.comments)||[]);}).catch(function(){listEl.innerHTML='<div class="tmw-cmt-empty">Couldn’t load comments.</div>';});

  function lockBox(t,s,cta,act,badge){ composeEl.innerHTML='<div class="tmw-cmt-lock"><span class="tmw-cmt-pro">'+esc(badge||'READER')+'</span><div class="tmw-cmt-lt">'+esc(t)+'</div><div class="tmw-cmt-ls">'+esc(s)+'</div><button class="tmw-cmt-cta" type="button">'+esc(cta)+'</button></div>'; var b=composeEl.querySelector('.tmw-cmt-cta'); if(b&&act)b.addEventListener('click',act); }
  function signUp(){ var m=window.$memberstackDom; if(m&&m.openModal)return m.openModal('SIGNUP'); if(window.tmwAuthModal)return window.tmwAuthModal('signup'); }
  var signedOut='Create a free account and reach Reader level to join the conversation.';

  // Memberstack loads async — poll for it + the member before deciding (never falsely "sign in")
  (function resolveMember(t){ t=t||0;
    var m=window.$memberstackDom;
    if(m&&m.getCurrentMember){
      m.getCurrentMember().then(function(r){
        var mem=r&&r.data;
        if(mem) return gate(mem);
        if(++t<6) return setTimeout(function(){resolveMember(t);},400);
        lockBox('Join the conversation',signedOut,'Create account',signUp);
      }).catch(function(){ if(++t<6) return setTimeout(function(){resolveMember(t);},400); lockBox('Join the conversation',signedOut,'Create account',signUp); });
      return;
    }
    if(++t>40){ lockBox('Join the conversation',signedOut,'Create account',signUp); return; }
    setTimeout(function(){resolveMember(t);},250);
  })();
  function gate(m){
    var cf=m.customFields||{}; var name=((cf['first-name']||'')+' '+(cf['last-name']||'')).trim()||(m.auth&&m.auth.email)||'Member';
    // Commenting is open to ANY member at Reader level (lvl>=2) — not PRO-gated.
    // Everyone earns XP and climbs regardless of plan, so a free account that
    // reaches Reader level can post.
    fetch(WORKER+'/member-stats?id='+encodeURIComponent(m.id),{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(st){
      var lvl=(st&&st.level)||1;
      if(lvl<2){ lockBox('Almost there','Reach Reader level to unlock commenting — keep reading to earn XP.','View your progress',function(){location.href='/account';}); return; }
      showComposer(m.id,name);
    }).catch(function(){ showComposer(m.id,name); });
  }

  function showComposer(id,name){
    composeEl.innerHTML='<div class="tmw-cmt-box"><div class="tmw-cmt-av me">'+esc(name.slice(0,1).toUpperCase())+'</div><div class="tmw-cmt-boxr"><textarea id="tmw-cmt-ta" rows="2" maxlength="1500" placeholder="Share your take…"></textarea><div class="tmw-cmt-bar"><span class="pub"><span class="dot"></span>Public</span><span class="tmw-cmt-msg" id="tmw-cmt-msg"></span><button class="tmw-cmt-post" id="tmw-cmt-post" type="button">Post comment</button></div></div></div>';
    var ta=composeEl.querySelector('#tmw-cmt-ta'),btn=composeEl.querySelector('#tmw-cmt-post'),msg=composeEl.querySelector('#tmw-cmt-msg');
    ta.addEventListener('input',function(){ ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,260)+'px'; if(msg.textContent)msg.textContent=''; });
    btn.addEventListener('click',function(){
      var body=(ta.value||'').trim(); if(body.length<2){ta.focus();return;}
      btn.disabled=true; msg.textContent='Posting…';
      fetch(WORKER+'/comment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({member_id:id,post:slug,body:body,member_name:name})})
        .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
        .then(function(res){ btn.disabled=false; if(res.ok&&res.j&&res.j.comment){prepend(res.j.comment);ta.value='';msg.textContent='';} else {msg.textContent=(res.j&&res.j.message)||'Could not post.';} })
        .catch(function(){ btn.disabled=false; msg.textContent='Could not post.'; });
    });
  }
}

// ============================================================================
// TMW INTELLIGENCE — Onyx AI summary + follow suggestions atop each article.
// Fetches /post-intel (cached server-side), renders a TL;DR + key takeaways,
// and turns the article's named developer/architect/city/project into one-tap
// follow chips (resolved to real slugs, persisted to Memberstack, pre-marked).
// ============================================================================
(function () {
  var WORKER = 'https://tmw.jake-ab7.workers.dev';
  var SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 5.9 5.9 2.3-5.9 2.3L12 18.9l-2.3-5.9L3.8 10.7l5.9-2.3z"/></svg>';
  var HEAD = '<div class="ai-head">' + SPARK + '<span>TMW Intelligence</span><span class="live"><i></i>Onyx 5</span></div>';
  var HEXSPIN = '<span class="ai-ask-hex" aria-hidden="true"><svg viewBox="0 0 100 100">'
    + '<polygon class="tmw-hex-ring" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#B9A6FF" stroke-width="3" stroke-linejoin="round"/>'
    + '<g class="tmw-hex-spinner"><polygon class="tmw-hex-core" points="50,18 77.7,34 77.7,66 50,82 22.3,66 22.3,34" fill="none" stroke="#A78BFA" stroke-width="7" stroke-linejoin="round"/></g>'
    + '</svg></span>';
  // Mount at the top of the hero (title width). The pre-rendered pages don't
  // carry the #article-intel slot, so create + place it there ourselves.
  var old = document.getElementById('article-intel');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var heroWrap = document.querySelector('.article-hero .wrap');
  var bc0 = document.getElementById('article-body-content');
  if (!heroWrap && !(bc0 && bc0.parentNode)) return;
  var host = document.createElement('div');
  host.id = 'article-intel'; host.className = 'article-intel';
  if (heroWrap) {
    var byline = heroWrap.querySelector('.byline');           // sit ABOVE the author/share/heart row
    if (byline) heroWrap.insertBefore(host, byline); else heroWrap.appendChild(host);
  } else bc0.parentNode.insertBefore(host, bc0);
  // Appear INSTANTLY with a skeleton loader; the fetch fills it in (or removes
  // the box if there's no summary for this post).
  host.innerHTML = HEAD + '<div class="ai-skel ai-skel-1"></div><div class="ai-skel ai-skel-2"></div><div class="ai-skel ai-skel-3"></div>';
  function slugOf() {
    var m = location.pathname.match(/^\/post\/([^\/]+)\/?$/);
    if (m && m[1]) return decodeURIComponent(m[1]);
    return (new URLSearchParams(location.search).get('slug') || '').trim();
  }
  var slug = slugOf();
  if (!slug) return;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function slugify(t) { return String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function mapSlug(t) { return String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function ms() { return window.$memberstackDom; }
  // Following from the article builds your Onyx beat — a Pro capability. Non-Pro
  // (signed-out OR free) taps get the Go Pro paywall, not a follow.
  function isPro() { try { return window._isPaidMember === true || (window.__tmwMember && window.__tmwMember.plan === 'paid') || (window.tmwIntel && window.tmwIntel.isPro && window.tmwIntel.isPro()); } catch (e) { return false; } }
  function goPro() {
    try { if (typeof window.tmwShowPaywall === 'function') { window.tmwShowPaywall({ source: 'article_follow' }); return; } } catch (e) {}
    try { if (typeof window.tmwArticleSignup === 'function') { window.tmwArticleSignup(); return; } } catch (e) {}
    try { var m = ms(); if (m && m.openModal) m.openModal('SIGNUP'); } catch (e) {}
  }
  // Open the Onyx / TMW Intelligence overlay with the reader's question (falls
  // back to the homepage ?q= deep-link, which auto-opens the overlay).
  function openOnyx(q, ctx) {
    q = (q || '').trim();
    try { if (window.tmwOverlay && typeof window.tmwOverlay.open === 'function') { window.tmwOverlay.open(q, ctx); return; } } catch (e) {}
    location.href = 'https://www.oftmw.com/?q=' + encodeURIComponent(q) + ((ctx && ctx.slug) ? ('&from=' + encodeURIComponent(ctx.slug)) : '');
  }
  // The article this search was launched from — carried into the overlay so a
  // terse follow-up ("when") resolves against it (chip + Onyx context).
  function articleCtx() {
    var h1 = document.getElementById('article-title');
    var title = h1 ? String(h1.textContent).replace(/\s+/g, ' ').trim() : '';
    var dk = document.getElementById('article-deck');
    var summary = dk ? String(dk.textContent).replace(/\s+/g, ' ').trim() : '';
    if (!summary) { var bc = document.getElementById('article-body-content'); summary = bc ? String(bc.textContent).replace(/\s+/g, ' ').trim() : ''; }
    return { slug: slug, title: title, summary: summary.slice(0, 700) };
  }

  // Entity → followable-slug resolution (firms + projects DB, cached).
  var _firmMap = null, _projArr = null;
  function firmMap() {
    if (_firmMap) return Promise.resolve(_firmMap);
    return fetch('https://www.oftmw.com/map/firms-flat.json').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
      .then(function (d) { var m = {}; ['architects', 'developers'].forEach(function (k) { ((d && d[k]) || []).forEach(function (f) { if (f && f.name && f.slug) m[String(f.name).toLowerCase().trim()] = f.slug; }); }); _firmMap = m; return m; });
  }
  function projArr() {
    if (_projArr) return Promise.resolve(_projArr);
    return fetch('https://www.oftmw.com/map/projects-flat.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }).then(function (a) { _projArr = a; return a; });
  }
  function resolveFollows(ent) {
    return Promise.all([firmMap(), projArr()]).then(function (o) {
      var fm = o[0], pa = o[1], out = [];
      function firmSlug(name) {
        if (!name) return null; var k = String(name).toLowerCase().trim();
        if (fm[k]) return fm[k];
        var hit = Object.keys(fm).find(function (n) { return n === k || (n.length > 4 && (n.indexOf(k) === 0 || k.indexOf(n) === 0)); });
        return hit ? fm[hit] : null;
      }
      if (ent.developer) { var ds = firmSlug(ent.developer); if (ds) out.push({ kind: 'firm', role: 'Developer', name: ent.developer, slug: ds, store: 'firms_followed', href: 'https://www.oftmw.com/firm/' + ds + '/' }); }
      if (ent.architect) { var as = firmSlug(ent.architect); if (as && as !== (out[0] && out[0].slug)) out.push({ kind: 'firm', role: 'Architect', name: ent.architect, slug: as, store: 'firms_followed', href: 'https://www.oftmw.com/firm/' + as + '/' }); }
      if (ent.city) { var cs = slugify(ent.city); if (cs) out.push({ kind: 'market', role: 'City', name: ent.city, slug: cs, store: 'markets_followed', href: 'https://www.oftmw.com/?market=' + encodeURIComponent(cs) }); }
      if (ent.project) {
        var pk = String(ent.project).toLowerCase().trim();
        var p = pa.find(function (x) { return String(x.Title || '').toLowerCase().trim() === pk; })
             || pa.find(function (x) { var t = String(x.Title || '').toLowerCase().trim(); return t && (t.indexOf(pk) >= 0 || pk.indexOf(t) >= 0); });
        if (p) out.push({ kind: 'project', role: 'Project', name: p.Title, slug: slugify(p.Title), store: 'favorites', href: 'https://www.oftmw.com/map/?project=' + mapSlug(p.Title) });
      }
      return out;
    });
  }

  // Member JSON (follow state) — read once, cached.
  var _mjP = null;
  function getMJ() { if (_mjP) return _mjP; _mjP = new Promise(function (res) { var m = ms(); if (m && m.getMemberJSON) m.getMemberJSON().then(function (r) { res((r && r.data) || {}); }).catch(function () { res({}); }); else res({}); }); return _mjP; }
  function beacon(name, props) {
    try { var m = ms(); if (!m || !m.getCurrentMember) return; m.getCurrentMember().then(function (r) { var mem = r && r.data; if (!mem) return; var cf = mem.customFields || {}; var nm = ((cf['first-name'] || '') + ' ' + (cf['last-name'] || '')).trim() || null; var payload = JSON.stringify({ member_id: mem.id, member_name: nm, event_name: name, props: props || {} }); if (navigator.sendBeacon) navigator.sendBeacon(WORKER + '/event', new Blob([payload], { type: 'text/plain' })); else fetch(WORKER + '/event', { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(function () {}); }); } catch (e) {}
  }
  function eventFor(f, added) {
    if (f.kind === 'firm') return [added ? 'firm_followed' : 'firm_unfollowed', { firm: f.slug }];
    if (f.kind === 'market') return [added ? 'market_followed' : 'market_unfollowed', { market: f.slug }];
    return [added ? 'favorite_added' : 'favorite_removed', { project_slug: f.slug }];
  }
  // Post-follow nudge — only after a follow ACTUALLY lands (anon clicks bounce
  // to signup and must never see it).
  function showFollowNudge() {
    var fw = host && host.querySelector('.ai-follows');
    if (!fw || fw.querySelector('.ai-follow-nudge')) return;
    var n = document.createElement('button');
    n.type = 'button'; n.className = 'ai-follow-nudge';
    n.innerHTML = 'Added &mdash; Pro members get the weekly brief when this moves <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    n.addEventListener('click', function () { beacon('follow_nudge_click', { slug: slug }); goPro(); });
    fw.appendChild(n);
  }
  function toggleFollow(f, btn) {
    var m = ms();
    if (!m || !m.getCurrentMember) { if (typeof window.tmwArticleSignup === 'function') window.tmwArticleSignup(); return; }
    m.getCurrentMember().then(function (r) {
      var mem = r && r.data;
      if (!mem) { if (typeof window.tmwArticleSignup === 'function') window.tmwArticleSignup(); else if (m.openModal) m.openModal('SIGNUP'); return; }
      m.getMemberJSON().then(function (g) {
        var j = (g && g.data && typeof g.data === 'object') ? g.data : {};
        var list = Array.isArray(j[f.store]) ? j[f.store].slice() : [];
        var i = list.indexOf(f.slug), added;
        if (i >= 0) { list.splice(i, 1); added = false; } else { list.push(f.slug); added = true; }
        j[f.store] = list;
        btn.classList.toggle('on', added);
        _mjP = Promise.resolve(j);
        m.updateMemberJSON({ json: j }).then(function () { var ev = eventFor(f, added); beacon(ev[0], ev[1]); if (added && !isPro()) showFollowNudge(); }).catch(function () { btn.classList.toggle('on', !added); });
      });
    });
  }

  function render(intel, follows, mj) {
    var takes = (intel.takeaways || []).filter(Boolean);
    // Summary block: the intro paragraph is always shown. The takeaways sit in
    // .ai-sum with the expand caret — on desktop the caret floats to the far
    // right of the last bullet's line; on mobile the bullets are hidden until
    // the caret is expanded (paragraph-only by default).
    var takesHtml = takes.length
      ? '<div class="ai-takes-c"><ul class="ai-takes">' + takes.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>'
      : '';
    var caretHtml = '<button class="ai-expand" type="button" aria-label="Show more" aria-expanded="false">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>';
    var html = HEAD
      + '<p class="ai-tldr">' + esc(intel.tldr) + '</p>'
      + '<div class="ai-sum">' + takesHtml + caretHtml + '</div>';
    // Everything below the summary/takeaways (watchlist + Ask Onyx) is tucked
    // behind a pulsing expand caret so the box sits compact by default.
    var moreInner = '';
    if (follows.length) {
      var plus = '<svg class="ai-f-ic" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
      var check = '<svg class="ai-f-ic" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';
      moreInner += '<div class="ai-follows"><div class="ai-follows-k">Add to your watchlist</div>'
        + follows.map(function (f, idx) {
            var on = (mj[f.store] || []).indexOf(f.slug) >= 0;
            return '<button class="ai-follow' + (on ? ' on' : '') + '" type="button" data-fi="' + idx + '">'
              + (on ? check : plus)
              + '<span class="ai-f-role">' + esc(f.role) + '</span><span class="ai-f-nm">' + esc(f.name) + '</span></button>';
          }).join('') + '</div>';
    }
    // Ask Onyx — answers the reader's question INLINE from THIS article's text
    // (reliable even for projects the map doesn't track), with an escalation link
    // to the full Onyx search for broader questions.
    moreInner += '<div class="ai-ask">' + HEXSPIN
      + '<input class="ai-ask-in" type="text" placeholder="Ask Onyx about this story…" aria-label="Ask Onyx">'
      + '<button class="ai-ask-go" type="button" aria-label="Ask Onyx"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>'
      + '</div><div class="ai-ask-ans" hidden></div>';
    html += '<div class="ai-more"><div class="ai-more-inner">' + moreInner + '</div></div>';
    host.innerHTML = html;
    var expBtn = host.querySelector('.ai-expand');
    if (expBtn) expBtn.addEventListener('click', function () {
      var open = host.classList.toggle('ai-open');
      expBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      // Do NOT auto-focus the ask input — that pops the mobile keyboard on
      // expand. The keyboard should open only when the reader taps Ask Onyx.
    });
    var ain = host.querySelector('.ai-ask-in'), ago = host.querySelector('.ai-ask-go'), ans = host.querySelector('.ai-ask-ans');
    function articleSubject() {
      var e = intel.entities || {}, parts = [];
      if (e.project) parts.push(e.project); else if (e.developer) parts.push(e.developer);
      if (e.city && parts.length) parts.push(e.city);
      var subj = parts.join(' ');
      if (!subj) { var h1 = document.getElementById('article-title'); subj = h1 ? String(h1.textContent).replace(/\s+/g, ' ').trim() : ''; }
      return subj;
    }
    function moreLink() { return '<button class="ai-ask-more" type="button">Explore in Onyx <svg viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8"/></svg></button>'; }
    // Onyx Deep tease under each article answer (non-Pro): the SHAPE of what
    // Deep would have added, never the content — mirrors the overlay tease.
    var DEEP_STAR = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.3 3.3 1.9 5 5.2 5.3-3.3.3-4.9 2-5.2 5.3-.3-3.3-1.9-5-5.2-5.3C10.1 7 11.7 5.3 12 2Z"/><path d="M18.5 13.2c.16 1.8 1.04 2.7 2.85 2.9-1.81.15-2.69 1.05-2.85 2.9-.16-1.85-1.04-2.75-2.85-2.9 1.81-.2 2.69-1.1 2.85-2.9Z"/></svg>';
    function deepTeaseHtml() {
      if (isPro()) return '';
      return '<div class="ai-dt" data-ai-dt>'
        + '<button type="button" class="ai-dt-toggle" aria-expanded="false">'
        +   '<span class="ai-dt-eye">' + DEEP_STAR + ' Onyx Deep <span class="ai-dt-pro">PRO</span></span>'
        +   '<span class="ai-dt-peek">See what the deep read would have added</span>'
        +   '<span class="ai-dt-chev" aria-hidden="true">\u25be</span>'
        + '</button>'
        + '<div class="ai-dt-body" hidden>'
        +   '<div class="ai-dt-sec"><span class="k">01</span>Comparable projects &mdash; how this stacks against the pipeline</div>'
        +   '<div class="ai-dt-bar" style="width:88%"></div><div class="ai-dt-bar" style="width:64%"></div>'
        +   '<div class="ai-dt-sec"><span class="k">02</span>The firm\'s delivery record behind this story</div>'
        +   '<div class="ai-dt-bar" style="width:78%"></div><div class="ai-dt-bar" style="width:52%"></div>'
        +   '<button type="button" class="ai-dt-cta">Go deeper with Onyx Deep \u2192</button>'
        + '</div>'
        + '</div>';
    }
    function wireTease(q) {
      var box = ans.querySelector('[data-ai-dt]'); if (!box) return;
      var tog = box.querySelector('.ai-dt-toggle'), body = box.querySelector('.ai-dt-body');
      tog.addEventListener('click', function () {
        var open = body.hidden;
        body.hidden = !open;
        box.classList.toggle('open', open);
        tog.setAttribute('aria-expanded', String(open));
        if (open && !box.getAttribute('data-seen')) { box.setAttribute('data-seen', '1'); beacon('deep_tease_expand', { q: q, surface: 'article', slug: slug }); }
      });
      var cta = box.querySelector('.ai-dt-cta');
      if (cta) cta.addEventListener('click', function () {
        beacon('deep_tease_click', { q: q, surface: 'article', slug: slug });
        try { if (typeof window.tmwShowPaywall === 'function') { window.tmwShowPaywall('feature:deep'); return; } } catch (e) {}
        goPro();
      });
    }
    // Hydrate the account-bound quota (server truth) so `allowed()` is accurate
    // before the reader's first question — otherwise a free user starts from the
    // optimistic localStorage count.
    try { if (window.tmwIntel && window.tmwIntel.sync) window.tmwIntel.sync(); } catch (e) {}
    var _asking = false;
    function ask() {
      var q = (ain ? ain.value : '').trim();
      if (!q || _asking) return;
      // GATE — identical to the search page (window.tmwIntel): anon gets 2 shared
      // preview questions (per device) then a create-account wall; a free account
      // draws from the SAME server-backed 5/month intel pool; Pro is unlimited.
      // Without this the ask box was ungated — anon could spam it and free
      // questions never counted against the monthly quota.
      var TI = window.tmwIntel;
      if (TI && typeof TI.allowed === 'function' && !TI.allowed(q)) {
        var anon = (typeof TI.signedIn === 'function') && !TI.signedIn();
        var msg = anon
          ? 'Create a free account to keep asking Onyx — <b>5 questions every month</b> across every project, firm, and milestone.'
          : 'You’ve used your <b>5 free Onyx questions</b> this month. Upgrade to Pro for unlimited.';
        var lbl = anon ? 'Create a free account' : 'Upgrade to Pro';
        ans.hidden = false;
        ans.innerHTML = '<div class="ai-ask-a" style="color:#C2C9C3">' + msg
          + '<div style="margin-top:12px"><button type="button" class="ai-ask-gbtn" style="background:linear-gradient(135deg,#B9A6FF,#A78BFA);color:#0a0a0a;border:none;border-radius:10px;padding:9px 18px;font-weight:600;font-size:13.5px;cursor:pointer">' + lbl + '</button></div></div>';
        var gb = ans.querySelector('.ai-ask-gbtn');
        if (gb) gb.addEventListener('click', function () {
          if (anon) { try { if (window.tmwAuthModal) return window.tmwAuthModal('signup'); } catch (e) {} }
          else { try { if (typeof window.tmwShowPaywall === 'function') return window.tmwShowPaywall('feature:intel'); } catch (e) {} }
          try { goPro(); } catch (e) {}
        });
        try { if (TI.track) TI.track(q, { gated: anon ? 'anon' : 'quota', source: 'article' }); } catch (e) {}
        return;
      }
      _asking = true; ans.hidden = false;
      ans.innerHTML = '<div class="ai-ask-loading">' + HEXSPIN + '<span>Onyx is reading the article…</span></div>';
      fetch(WORKER + '/post-ask?slug=' + encodeURIComponent(slug) + '&q=' + encodeURIComponent(q))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          _asking = false;
          if (d && d.ok && d.answer) {
            // Consume one credit only on a real answer — repeats + Pro are no-ops
            // inside count(), and free accounts POST /intel-usage so this question
            // draws from the SAME monthly pool as the search page.
            try { if (TI && TI.count) TI.count(q); } catch (e) {}
            ans.innerHTML = '<div class="ai-ask-a">' + esc(d.answer) + '</div>' + deepTeaseHtml() + '<div class="ai-ask-foot">' + moreLink() + '</div>';
          }
          else ans.innerHTML = '<div class="ai-ask-a">Couldn\'t answer that from the article.</div><div class="ai-ask-foot">' + moreLink() + '</div>';
          wireMore(q); wireTease(q);
        })
        .catch(function () { _asking = false; ans.innerHTML = '<div class="ai-ask-a">Something went wrong.</div><div class="ai-ask-foot">' + moreLink() + '</div>'; wireMore(q); });
    }
    function wireMore(q) {
      var mb = ans.querySelector('.ai-ask-more');
      if (mb) mb.addEventListener('click', function () { var subj = articleSubject(); openOnyx((q && subj) ? (subj + ' — ' + q) : (q || subj), articleCtx()); });
    }
    if (ago) ago.addEventListener('click', ask);
    if (ain) ain.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ask(); } });
    var FOLLOW_STORES = ['firms_followed', 'markets_followed', 'favorites'];
    var FREE_FOLLOW_CAP = 3;
    function flipAndToggle(f, btn){
      var on = btn.classList.contains('on');
      toggleFollow(f, btn);
      var ic = btn.querySelector('.ai-f-ic');
      if (ic) ic.outerHTML = (on
        ? '<svg class="ai-f-ic" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
        : '<svg class="ai-f-ic" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>');
    }
    host.querySelectorAll('.ai-follow').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var f = follows[+btn.getAttribute('data-fi')]; if (!f) return;
        // Free members can build a small watchlist (the on-ramp); the 4th
        // follow is the Pro moment. Unfollowing is always allowed. Anonymous
        // readers land in the free-signup flow inside toggleFollow.
        var unfollow = btn.classList.contains('on');
        if (unfollow || isPro()) { flipAndToggle(f, btn); return; }
        var m = ms();
        if (!m || !m.getMemberJSON) { flipAndToggle(f, btn); return; }   // anon -> signup path
        m.getMemberJSON().then(function (g) {
          var j = (g && g.data && typeof g.data === 'object') ? g.data : {};
          var total = 0;
          FOLLOW_STORES.forEach(function (k) { if (Array.isArray(j[k])) total += j[k].length; });
          if (total >= FREE_FOLLOW_CAP) { beacon('follow_cap_hit', { slug: slug, total: total }); goPro(); return; }
          flipAndToggle(f, btn);
        }).catch(function () { flipAndToggle(f, btn); });   // fail-open
      });
    });
  }

  function drop() { if (host && host.parentNode) host.parentNode.removeChild(host); }
  fetch(WORKER + '/post-intel?slug=' + encodeURIComponent(slug))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (intel) {
      if (!intel || !intel.ok || !intel.tldr) { drop(); return; }
      return Promise.all([resolveFollows(intel.entities || {}), getMJ()]).then(function (o) { render(intel, o[0], o[1]); });
    })
    .catch(function () { drop(); });
})();

// ===================================================================
// CLIENT SUGGEST-EDITS — Google-Docs-style suggestions on the client
// preview link. Anyone with the ?pt= link can select article text (or
// tap a photo) and propose a replacement, identified by a self-asserted
// name + email kept on their device. Highlights render the PROPOSED
// state inline (purple, pencil on hover, click to revise); suggestions
// queue in the worker and the Studio post editor accepts or rejects
// them. The draft itself is never written from here.
// ===================================================================
function initSuggestMode(post) {
  if (!PREVIEW_TOKEN) return;
  var slug = (post && post.slug) || new URLSearchParams(location.search).get('slug') || '';
  if (!slug) return;
  var bodyEl = document.getElementById('article-body-content');
  if (!bodyEl || bodyEl.__sugInit) return;
  bodyEl.__sugInit = 1;

  var PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  var PEN_CURSOR = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' stroke='black' stroke-width='4.4'/><path d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'/></svg>\") 2 20, pointer";

  var css = document.createElement('style');
  css.textContent =
    '#sug-banner{margin:14px 0 6px;padding:11px 16px;border:1px solid rgba(167,139,250,.4);border-radius:12px;background:rgba(167,139,250,.08);font-size:13px;color:#d9d2f5;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-family:Inter,-apple-system,sans-serif}' +
    '#sug-banner b{color:#fff;display:inline-flex;align-items:center;gap:7px}' +
    '#sug-banner b svg{width:13px;height:13px;flex:0 0 auto}' +
    '#sug-banner .sug-who{margin-left:auto;font-size:11.5px;color:#a99fd6}' +
    '#sug-banner .sug-who a{color:#B9A6FF;cursor:pointer;text-decoration:underline}' +
    '#sug-banner .sug-note-btn{font-size:11.5px;color:#B9A6FF;cursor:pointer;text-decoration:underline}' +
    '.sug-chip{position:absolute;z-index:9999;display:inline-flex;align-items:center;gap:7px;background:#1c1530;border:1px solid rgba(167,139,250,.6);color:#fff;border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.5);font-family:Inter,-apple-system,sans-serif;white-space:nowrap}' +
    '.sug-chip svg{width:12px;height:12px;flex:0 0 auto}' +
    '.sug-chip:hover{background:#2a2046}' +
    'mark.tmw-sg{background:rgba(167,139,250,.22);color:inherit;border-bottom:2px solid rgba(167,139,250,.85);cursor:' + PEN_CURSOR + '}' +
    'mark.tmw-sg.acc{background:rgba(31,223,103,.18);border-bottom-color:rgba(31,223,103,.8)}' +
    '.sug-imgpen{position:absolute;z-index:9998;width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(20,16,32,.85);border:1px solid rgba(167,139,250,.6);cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.5);transition:background .15s}' +
    '.sug-imgpen:hover{background:rgba(46,35,78,.95)}' +
    '.sug-imgpen svg{width:16px;height:16px}' +
    '#sug-modal{position:fixed;inset:0;z-index:10000;background:rgba(5,5,8,.72);display:flex;align-items:center;justify-content:center;padding:18px}' +
    '#sug-modal .sug-box{width:min(560px,100%);background:#141018;border:1px solid rgba(167,139,250,.35);border-radius:16px;padding:22px;font-family:Inter,-apple-system,sans-serif;max-height:88vh;overflow:auto}' +
    '#sug-modal h3{margin:0 0 14px;font-size:16px;color:#fff}' +
    '#sug-modal label{display:block;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#9AA39C;margin:12px 0 5px}' +
    '#sug-modal .sug-orig{font-size:13px;color:#c9c2e0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 11px;max-height:110px;overflow:auto;word-break:break-word}' +
    '#sug-modal textarea,#sug-modal input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:9px;color:#fff;font-size:13.5px;padding:9px 11px;font-family:inherit}' +
    '#sug-modal textarea::placeholder,#sug-modal input::placeholder{color:#8b8798;opacity:1}' +
    '#sug-modal textarea{min-height:86px;resize:vertical}' +
    '#sug-modal .sug-row{display:flex;gap:10px;margin-top:18px;justify-content:flex-end}' +
    '#sug-modal button{border:0;border-radius:999px;padding:10px 20px;font-size:12.5px;font-weight:700;cursor:pointer}' +
    '#sug-modal .sug-go{background:#B9A6FF;color:#12091f}' +
    '#sug-modal .sug-x{background:rgba(255,255,255,.08);color:#cfc8e8}' +
    '#sug-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:10001;background:#153a24;border:1px solid rgba(31,223,103,.5);color:#c9f5d8;border-radius:999px;padding:10px 20px;font-size:13px;font-family:Inter,-apple-system,sans-serif}';
  document.head.appendChild(css);

  var IDK = 'tmw_reviewer_id';
  function who() { try { return JSON.parse(localStorage.getItem(IDK) || 'null'); } catch (e) { return null; } }
  function setWho(v) { try { localStorage.setItem(IDK, JSON.stringify(v)); } catch (e) {} }

  // Banner under the draft pill
  var pill = document.getElementById('draft-pill');
  var banner = document.createElement('div');
  banner.id = 'sug-banner';
  function paintBanner() {
    var w = who();
    banner.innerHTML = '<b>' + PEN + 'Suggest edits</b><span>Select any text, or tap a photo, to propose a change.</span>' +
      '<span class="sug-note-btn" id="sugGeneralBtn">+ general note</span>' +
      '<span class="sug-who">Reviewing as <b>' + escapeHtml((w && (w.name || w.email)) || 'Anonymous') + '</b> · <a id="sugWhoBtn">' + (w && w.email ? 'change' : 'add your email') + '</a></span>';
    var wb = banner.querySelector('#sugWhoBtn');
    if (wb) wb.onclick = function () { askWho(function () { paintBanner(); }); };
    var gb = banner.querySelector('#sugGeneralBtn');
    if (gb) gb.onclick = function () { openDialog({ kind: 'note' }); };
  }
  if (pill && pill.parentNode) pill.parentNode.insertBefore(banner, pill.nextSibling);
  else bodyEl.parentNode.insertBefore(banner, bodyEl);
  paintBanner();

  function toast(msg) {
    var t = document.createElement('div'); t.id = 'sug-toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3200);
  }

  // ── identity dialog ──
  function askWho(then) {
    var w = who() || {};
    modal('<h3>Who is suggesting?</h3>' +
      '<label>Name (optional)</label><input id="sgName" value="' + escapeHtml(w.name || '') + '" placeholder="Anonymous">' +
      '<label>Email</label><input id="sgEmail" type="email" value="' + escapeHtml(w.email || '') + '" placeholder="jane@company.com">' +
      '<div class="sug-row"><button class="sug-x" data-x>Cancel</button><button class="sug-go" data-go>Save</button></div>',
      function (box, close) {
        box.querySelector('[data-go]').onclick = function () {
          var em = box.querySelector('#sgEmail').value.trim();
          if (!/@/.test(em)) { box.querySelector('#sgEmail').style.borderColor = '#FF5C5C'; return; }
          setWho({ name: box.querySelector('#sgName').value.trim(), email: em });
          close(); if (then) then();
        };
      });
  }
  function modal(inner, wire) {
    var m = document.createElement('div'); m.id = 'sug-modal';
    m.innerHTML = '<div class="sug-box">' + inner + '</div>';
    function close() { m.remove(); }
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    var x = m.querySelector('[data-x]'); if (x) x.onclick = close;
    document.body.appendChild(m);
    wire(m.querySelector('.sug-box'), close);
    var f = m.querySelector('textarea,input'); if (f) f.focus();
  }

  // ── the suggestion dialog ──
  // opts: { kind: 'text'|'photo'|'note', original, block, range, markEl,
  //         updateId, proposed, note }  (updateId → revising an existing one)
  function openDialog(opts) {
    var w = who();
    if (!w || !w.email) { askWho(function () { openDialog(opts); }); return; }
    var kind = opts.kind || 'text';
    var original = opts.original || '';
    var isNote = kind === 'note';
    var isPhoto = kind === 'photo';
    var title = isNote ? 'General note for the editors' : (isPhoto ? 'Suggest a different photo' : (opts.updateId ? 'Revise this suggestion' : 'Suggest an edit'));
    // The replacement field starts EMPTY with the original as gray placeholder
    // text — type straight over it, nothing to delete. Revising an existing
    // suggestion prefills its current proposal for editing.
    var propVal = opts.updateId ? (opts.proposed || '') : '';
    var propPh = isPhoto ? 'Paste an image URL (https://…)' : escapeHtml(original);
    modal('<h3>' + title + '</h3>' +
      (isNote ? '' :
        '<label>' + (isPhoto ? 'Current photo' : 'Original') + '</label><div class="sug-orig">' + escapeHtml(original) + '</div>' +
        '<label>' + (isPhoto ? 'Replacement image URL' : 'Your suggested replacement') + '</label>' +
        '<textarea id="sgProp" placeholder="' + propPh + '"' + (isPhoto ? ' style="min-height:56px"' : '') + '>' + escapeHtml(propVal) + '</textarea>') +
      '<label>' + (isNote ? 'Your note' : 'Note (optional)') + '</label><textarea id="sgNote" style="min-height:56px" placeholder="' + (isNote ? 'Anything the editors should know…' : 'Why this change?') + '">' + escapeHtml(opts.note || '') + '</textarea>' +
      '<div class="sug-row"><button class="sug-x" data-x>Cancel</button><button class="sug-go" data-go>Send suggestion</button></div>',
      function (box, close) {
        box.querySelector('[data-go]').onclick = function () {
          var propEl = box.querySelector('#sgProp');
          var prop = isNote ? '' : (propEl ? propEl.value.trim() : '');
          var note = box.querySelector('#sgNote').value.trim();
          if (!prop && !note) { close(); return; }
          if (isPhoto && prop && !/^https?:\/\//i.test(prop)) { propEl.style.borderColor = '#FF5C5C'; return; }
          var btn = box.querySelector('[data-go]'); btn.disabled = true; btn.textContent = 'Sending…';
          var payload = { slug: slug, pt: PREVIEW_TOKEN, name: w.name || 'Anonymous', email: w.email, block: opts.block != null ? opts.block : -1, original: original, proposed: prop, note: note };
          if (opts.updateId) payload.update_id = opts.updateId;
          fetch(WORKER_URL + '/draft-suggest', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.ok) {
              var dispName = w.name || 'Anonymous';
              if (opts.fieldEl && opts.block === -4) { paintFieldHero(opts.fieldEl, { id: j.id, original: original, proposed: prop, note: note, name: dispName, status: 'pending' }); }
              else if (opts.fieldEl) { paintFieldText(opts.fieldEl, { id: j.id, original: original, proposed: prop, note: note, name: dispName, status: 'pending', block: opts.fieldCode }); }
              else if (opts.markEl) { decorateMark(opts.markEl, j.id, original, prop, note, dispName); }
              else if (opts.range && !isPhoto) { try { var mk = wrapRange(opts.range, 'pending'); decorateMark(mk, j.id, original, prop, note, dispName); } catch (e) {} }
              toast('Suggestion sent — the editors will review it.');
              close();
            } else { btn.disabled = false; btn.textContent = 'Send suggestion'; toast((j && j.error) || 'Could not send — try again'); }
          }).catch(function () { btn.disabled = false; btn.textContent = 'Send suggestion'; });
        };
      });
  }

  function wrapRange(range, status) {
    var mk = document.createElement('mark');
    mk.className = 'tmw-sg' + (status === 'accepted' ? ' acc' : '');
    range.surroundContents(mk);
    return mk;
  }
  // The highlight shows the PROPOSED text inline (the suggested state of the
  // sentence); the original lives in the tooltip + dataset for revising.
  function decorateMark(mk, id, original, prop, note, name2) {
    if (!mk) return;
    if (prop) mk.textContent = prop;
    mk.dataset.sgId = id || '';
    mk.dataset.sgOrig = original || '';
    mk.dataset.sgProp = prop || '';
    mk.dataset.sgNote = note || '';
    mk.title = (name2 ? name2 + ' suggests this' : 'Suggested') + (original ? ' (was: “' + original + '”)' : '') + ' — click to revise';
  }
  // Click a highlight → reopen the dialog on that suggestion.
  bodyEl.addEventListener('click', function (e) {
    var mk = e.target && e.target.closest && e.target.closest('mark.tmw-sg');
    if (!mk || !mk.dataset.sgId) return;
    e.preventDefault(); e.stopPropagation();
    openDialog({ kind: 'text', original: mk.dataset.sgOrig, proposed: mk.dataset.sgProp, note: mk.dataset.sgNote, updateId: Number(mk.dataset.sgId), markEl: mk });
  }, true);

  // ── selection → floating chip ──
  var chip = null;
  function killChip() { if (chip) { chip.remove(); chip = null; } }
  document.addEventListener('selectionchange', function () {
    setTimeout(function () {
      killChip();
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      var text = sel.toString().replace(/\s+/g, ' ').trim();
      if (text.length < 3 || text.length > 1500) return;
      var r = sel.getRangeAt(0);
      if (!bodyEl.contains(r.commonAncestorContainer)) return;
      if (r.commonAncestorContainer.parentElement && r.commonAncestorContainer.parentElement.closest('mark.tmw-sg')) return;
      var rect = r.getBoundingClientRect();
      chip = document.createElement('div');
      chip.className = 'sug-chip';
      chip.innerHTML = PEN + 'Suggest edit';
      chip.style.left = Math.max(8, rect.left + rect.width / 2 - 60 + window.scrollX) + 'px';
      chip.style.top = (rect.bottom + 8 + window.scrollY) + 'px';
      chip.addEventListener('mousedown', function (e) { e.preventDefault(); });
      chip.onclick = function () {
        var blockEl = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
        while (blockEl && blockEl.parentElement !== bodyEl) blockEl = blockEl.parentElement;
        var block = blockEl ? Array.prototype.indexOf.call(bodyEl.children, blockEl) : -1;
        var keep = r.cloneRange();
        killChip();
        openDialog({ kind: 'text', original: text, block: block, range: keep });
      };
      document.body.appendChild(chip);
    }, 60);
  });

  // ── photos: pencil on hover, click → suggest a replacement URL ──
  var imgPen = null;
  function killImgPen() { if (imgPen) { imgPen.remove(); imgPen = null; } }
  function imgBlockIndex(img) {
    var el = img;
    while (el && el.parentElement !== bodyEl) el = el.parentElement;
    return el ? Array.prototype.indexOf.call(bodyEl.children, el) : -1;
  }
  function openPhotoDialog(img) {
    openDialog({ kind: 'photo', original: img.currentSrc || img.src || '', block: imgBlockIndex(img) });
  }
  bodyEl.addEventListener('mouseover', function (e) {
    var img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (!img) return;
    killImgPen();
    var rect = img.getBoundingClientRect();
    if (rect.width < 80) return;
    imgPen = document.createElement('div');
    imgPen.className = 'sug-imgpen';
    imgPen.innerHTML = PEN;
    imgPen.title = 'Suggest a different photo';
    imgPen.style.position = 'absolute';
    imgPen.style.left = (rect.right - 50 + window.scrollX) + 'px';
    imgPen.style.top = (rect.top + 12 + window.scrollY) + 'px';
    imgPen.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); killImgPen(); openPhotoDialog(img); };
    document.body.appendChild(imgPen);
    img.addEventListener('mouseleave', function h(ev) {
      img.removeEventListener('mouseleave', h);
      setTimeout(function () { if (imgPen && !imgPen.matches(':hover')) killImgPen(); }, 250);
    });
  });
  // Clicking the image itself in suggest mode opens the photo dialog (the
  // lightbox zoom is a reading-mode affordance, not a review one).
  bodyEl.addEventListener('click', function (e) {
    var img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (!img) return;
    e.preventDefault(); e.stopPropagation();
    killImgPen();
    openPhotoDialog(img);
  }, true);

  // ── title / subtitle / hero image: pencil on hover, whole-field edits ──
  // Field suggestions anchor by BLOCK CODE (-2 title, -3 subtitle, -4 hero)
  // instead of a text search; the Studio applies them to the matching field.
  var FIELD_TITLE = -2, FIELD_DECK = -3, FIELD_HERO = -4;
  function paintFieldText(el, sg) {
    if (!el || !sg.proposed) return;
    el.innerHTML = '';
    var mk = document.createElement('mark');
    mk.className = 'tmw-sg' + (sg.status === 'accepted' ? ' acc' : '');
    mk.textContent = sg.proposed;
    decorateMark(mk, sg.id, sg.original, sg.proposed, sg.note, sg.name);
    mk.dataset.sgField = String(sg.block);
    el.appendChild(mk);
  }
  function paintFieldHero(img, sg) {
    if (!img || !sg.proposed) return;
    img.src = sg.proposed;
    img.style.outline = '3px solid rgba(167,139,250,.8)';
    img.dataset.sgId = sg.id; img.dataset.sgOrig = sg.original || '';
    img.dataset.sgProp = sg.proposed; img.dataset.sgNote = sg.note || '';
    img.title = (sg.name || 'A reviewer') + ' suggests this photo — click to revise';
  }
  function fieldEl(code) {
    if (code === FIELD_TITLE) return document.getElementById('article-title');
    if (code === FIELD_DECK) return document.getElementById('article-deck');
    if (code === FIELD_HERO) return document.getElementById('article-cover-img');
    return null;
  }
  function hookField(el, code) {
    if (!el) return;
    el.addEventListener('mouseover', function () {
      killImgPen();
      var rect = el.getBoundingClientRect();
      imgPen = document.createElement('div');
      imgPen.className = 'sug-imgpen';
      imgPen.innerHTML = PEN;
      imgPen.title = code === FIELD_HERO ? 'Suggest a different photo' : 'Suggest an edit';
      imgPen.style.position = 'absolute';
      imgPen.style.left = (rect.right - 50 + window.scrollX) + 'px';
      imgPen.style.top = (rect.top + 8 + window.scrollY) + 'px';
      imgPen.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); killImgPen(); openFieldDialog(el, code); };
      document.body.appendChild(imgPen);
      el.addEventListener('mouseleave', function h() {
        el.removeEventListener('mouseleave', h);
        setTimeout(function () { if (imgPen && !imgPen.matches(':hover')) killImgPen(); }, 250);
      });
    });
    el.addEventListener('click', function (e) {
      // a field with a pending suggestion revises it; otherwise open fresh
      e.preventDefault(); e.stopPropagation();
      killImgPen();
      openFieldDialog(el, code);
    }, true);
    if (code !== FIELD_HERO) el.style.cursor = PEN_CURSOR;
    else el.style.cursor = 'pointer';
  }
  function openFieldDialog(el, code) {
    var mk = el.querySelector && el.querySelector('mark.tmw-sg');
    var pendingId = Number((mk && mk.dataset.sgId) || el.dataset && el.dataset.sgId || 0);
    if (code === FIELD_HERO) {
      openDialog({ kind: 'photo', original: (pendingId && el.dataset.sgOrig) || el.currentSrc || el.src || '', block: code,
        updateId: pendingId || undefined, proposed: pendingId ? el.dataset.sgProp : '', note: pendingId ? el.dataset.sgNote : '', fieldEl: el });
    } else {
      var orig = pendingId && mk ? mk.dataset.sgOrig : el.textContent.trim();
      openDialog({ kind: 'text', original: orig, block: code,
        updateId: pendingId || undefined, proposed: pendingId && mk ? mk.dataset.sgProp : '', note: pendingId && mk ? mk.dataset.sgNote : '', fieldEl: el, fieldCode: code });
    }
  }
  hookField(fieldEl(FIELD_TITLE), FIELD_TITLE);
  hookField(fieldEl(FIELD_DECK), FIELD_DECK);
  hookField(fieldEl(FIELD_HERO), FIELD_HERO);

  // ── paint existing suggestions: proposed text inline, purple mark ──
  fetch(WORKER_URL + '/draft-suggest?slug=' + encodeURIComponent(slug) + '&pt=' + encodeURIComponent(PREVIEW_TOKEN), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      ((j && j.suggestions) || []).forEach(function (sg) {
        try {
          if (sg.block === FIELD_HERO) { paintFieldHero(fieldEl(FIELD_HERO), sg); return; }
          if (sg.block === FIELD_TITLE || sg.block === FIELD_DECK) { paintFieldText(fieldEl(sg.block), sg); return; }
          if (!sg.original || /^https?:\/\//i.test(sg.original)) return;   // body photo suggestions have no text anchor
          highlightText(sg);
        } catch (e) {}
      });
    }).catch(function () {});
  function highlightText(sg) {
    var walk = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walk.nextNode())) {
      var i = node.nodeValue.indexOf(sg.original);
      if (i < 0) continue;
      if (node.parentElement && node.parentElement.closest('mark.tmw-sg')) continue;
      var r = document.createRange();
      r.setStart(node, i); r.setEnd(node, i + sg.original.length);
      var mk = wrapRange(r, sg.status);
      decorateMark(mk, sg.id, sg.original, sg.proposed, sg.note, sg.name);
      return;
    }
  }
}
