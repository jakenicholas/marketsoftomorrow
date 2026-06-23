// ===================================================================
// Config (paths use absolute /... so they keep working from
// any URL depth, and survive the eventual migration to www.oftmw.com)
// ===================================================================
const WORKER_URL    = 'https://tmw.jake-ab7.workers.dev';
const WIX_RSS_URL   = 'https://www.oftmw.com/blog-feed.xml';
const CORS_PROXY    = 'https://api.codetabs.com/v1/proxy/?quest=';
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
    if (post && post.status && post.status !== 'published') markDraftPreview();
    loadReadNext(post, slug);
    try { initComments(slug, post); } catch (e) {}
  } catch (err) {
    console.error('[article] load failed:', err);
    renderArticleEmpty(
      'Couldn\'t load this article',
      err && err.legacy
        ? 'This post is older than our current RSS window (Wix only exposes the 20 most-recent). Open the original on Wix Studio:'
        : 'The journal feed didn\'t respond. Try refreshing, or open the original:',
      err && err.legacyUrl ? err.legacyUrl : ('https://studio.oftmw.com/post/' + slug),
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
  // 1. Primary source: D1-backed /posts/by-slug/:slug (1,377 posts migrated
  //    from Wix). Returns a clean canonical record.
  try {
    const res = await fetch(WORKER_URL + '/posts/by-slug/' + encodeURIComponent(slug) + (PREVIEW_TOKEN ? '?preview=' + encodeURIComponent(PREVIEW_TOKEN) : ''), { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.post) {
        console.log('[article] source: D1 /posts/by-slug ·', data.post.body_source);
        // Normalize to the shape renderArticle expects (it was written for
        // the older RSS shape — adapt field names).
        return adaptD1PostShape(data.post);
      }
    }
    console.warn('[article] /posts/by-slug returned non-ok status:', res.status);
  } catch (e) {
    console.warn('[article] /posts/by-slug failed, trying scrape fallback', e);
  }

  // 2. Fallback (only for posts not yet migrated): the older /post/:slug
  //    endpoint that scrapes Wix on demand.
  try {
    const res = await fetch(WORKER_URL + '/post/' + encodeURIComponent(slug), { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.post) return data.post;
    } else if (res.status === 404) {
      const err = new Error('Post not found in DB or Wix');
      err.legacy = true;
      err.legacyUrl = 'https://www.oftmw.com/post/' + slug;
      throw err;
    }
  } catch (e) {
    if (e.legacy) throw e;
    console.warn('[article] scrape fallback failed', e);
  }

  // 3. Last-ditch: direct Wix RSS via CORS proxy (metadata only, no body)
  const res = await fetch(CORS_PROXY + encodeURIComponent(WIX_RSS_URL), { cache: 'no-store' });
  if (!res.ok) throw new Error('All sources failed (last: RSS proxy ' + res.status + ')');
  const xml = await res.text();
  const items = parseRssXmlFull(xml);
  const slugLc = slug.toLowerCase();
  const post = items.find(it =>
    (it.slug && it.slug.toLowerCase() === slugLc) ||
    (it.link && it.link.toLowerCase().endsWith('/' + slugLc))
  );
  if (!post) {
    const err = new Error('Post not found in any source');
    err.legacy = true;
    err.legacyUrl = 'https://www.oftmw.com/post/' + slug;
    throw err;
  }
  return post;
}

// Normalize D1 post shape (snake_case fields) to the RSS-style shape the
// rest of the page expects. Cheap to do client-side so we don't have to
// touch the renderer.
function adaptD1PostShape(p) {
  return {
    title:        p.title,
    slug:         p.slug,
    link:         p.wix_url || ('/post/?slug=' + p.slug),
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
    source_url:   p.wix_url || '',
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
      author: post.author_name ? { '@type': 'Person', name: post.author_name } : { '@type': 'Organization', name: 'Markets of Tomorrow' },
      publisher: { '@type': 'Organization', name: 'Markets of Tomorrow', logo: { '@type': 'ImageObject', url: 'https://pub-7da0281887564d10a10107987c7c6c0c.r2.dev/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png' } },
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

  // Byline
  document.getElementById('article-author').textContent = post.author || 'Markets of Tomorrow';
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
    bodyEl.innerHTML = `<p>${escapeHtml(post.summary || '(no preview available — open original on Wix Studio)')}</p>`;
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
    ${legacyUrl ? `<a class="legacy-link" href="${escapeAttr(legacyUrl)}" target="_blank" rel="noopener">Open on Wix Studio
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
    </a>` : ''}
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
    // 2. Fall back to RSS-backed /blog if D1 empty (pre-migration)
    if (!items.length) {
      const r = await fetch(WORKER_URL + '/blog?limit=30', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        items = d.items || [];
      }
    }
    // 3. Fall back to direct RSS
    if (!items.length) {
      const px = await fetch(CORS_PROXY + encodeURIComponent(WIX_RSS_URL), { cache: 'no-store' });
      if (px.ok) items = parseRssXmlFull(await px.text());
    }
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
  return `<a class="fc-slide${onCls}" href="${escapeAttr(s.url || '#')}" target="_blank" rel="noopener sponsored">${media}</a>`;
}
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
function formatLongDate(s) { const d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
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
