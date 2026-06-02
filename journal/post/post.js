// ===================================================================
// Config (paths use absolute /... so they keep working from
// any URL depth, and survive the eventual migration to www.oftmw.com)
// ===================================================================
const WORKER_URL    = 'https://tmw.jake-ab7.workers.dev';
const WIX_RSS_URL   = 'https://www.oftmw.com/blog-feed.xml';
const CORS_PROXY    = 'https://api.codetabs.com/v1/proxy/?quest=';
const ADS_URL       = '/ads.json';
const PULSE_URL     = 'https://map.oftmw.com/pulse.json';
const PULSE_NEW_DAYS = 7;
const PULSE_MAX     = 8;
const PLACEMENT     = 'article';
const POST_URL_BASE = '/post/?slug=';

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
  // ── Pre-rendered static page (generate_articles.py) ───────────────
  // For path-based article URLs (/post/<slug>/) the body + SEO
  // <head> are already baked into the HTML so crawlers + social scrapers
  // see real content without running JS. Skip the fetch/render entirely;
  // just run the progressive enhancements on the existing DOM and load
  // the "Read next" rail.
  if (window.__PRERENDERED__ && window.__POST__) {
    const post = window.__POST__;
    const bodyEl = document.getElementById('article-body-content');
    if (bodyEl) { try { upgradeBodyImages(bodyEl); hookGalleries(bodyEl); } catch (e) {} }
    try { loadReadNext(post, post.slug); } catch (e) {}
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
    renderArticle(post);
    loadReadNext(post, slug);
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

async function fetchPost(slug) {
  // 1. Primary source: D1-backed /posts/by-slug/:slug (1,377 posts migrated
  //    from Wix). Returns a clean canonical record.
  try {
    const res = await fetch(WORKER_URL + '/posts/by-slug/' + encodeURIComponent(slug), { cache: 'no-store' });
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
      publisher: { '@type': 'Organization', name: 'Markets of Tomorrow', logo: { '@type': 'ImageObject', url: 'https://tmw.jake-ab7.workers.dev/media/wix/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png' } },
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
  }
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
// READ NEXT — show 3 most-recent other posts
// ===================================================================
async function loadReadNext(currentPost, currentSlug) {
  try {
    let items = [];
    // 1. Prefer D1 posts table (migrated articles)
    try {
      const r = await fetch(WORKER_URL + '/posts?limit=10&status=published', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        items = (d.items || []).map(it => ({
          slug: it.slug,
          title: it.title,
          image: it.cover_image,
          pubDate: it.published_iso || (it.published_at ? new Date(it.published_at * 1000).toUTCString() : ''),
        }));
      }
    } catch {}
    // 2. Fall back to RSS-backed /blog if D1 empty (pre-migration)
    if (!items.length) {
      const r = await fetch(WORKER_URL + '/blog?limit=20', { cache: 'no-store' });
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
    const others = items.filter(it => it.slug && it.slug !== currentSlug).slice(0, 3);
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
  CAROUSEL.timer = setInterval(() => { if (!CAROUSEL.hover) setSlide(CAROUSEL.idx + 1); }, CAROUSEL.intervalMs);
}
function stopCarouselTimer() { if (CAROUSEL.timer) { clearInterval(CAROUSEL.timer); CAROUSEL.timer = null; } }

async function loadPulse() {
  try {
    const r = await fetch(PULSE_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('pulse ' + r.status);
    const d = await r.json();
    const events = (d.events || []).filter(e => e && e.title && e.link);
    if (!events.length) { setPulseBadge(0); return; }
    const fresh = events.filter(e => { const t = Date.parse(e.timestamp || 0); return t && (Date.now() - t) <= PULSE_NEW_DAYS * 86400_000; });
    setPulseBadge(fresh.length);
    const visible = events.slice(0, PULSE_MAX);
    const cell = e => {
      const kind = e.type === 'article' ? 'article' : (e.type === 'status_change' ? 'status' : 'new');
      const age = e.timestamp ? relAge(e.timestamp) : '';
      return `<a class="ticker-item" href="${escapeAttr(e.link)}" target="_blank" rel="noopener">
        <span class="pdot ${kind}"></span>
        <span>${escapeHtml(e.title_full || e.title)}</span>
        ${age ? `<span class="tage">${escapeHtml(age)}</span>` : ''}
      </a>`;
    };
    const strip = visible.map(cell).join('');
    document.getElementById('ticker-track').innerHTML = strip + strip;
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
// Helpers
// ===================================================================
function setMeta(id, attr, val) { const el = document.getElementById(id); if (el && val) el.setAttribute(attr, val); }
function formatLongDate(s) { const d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// ===================================================================
// SUBSCRIBE LIGHTBOX — slides up from the bottom after a few seconds.
// Once per visitor (localStorage), dismissible, posts to the same
// newsletter endpoint as the home page.
// ===================================================================
(function () {
  var SUB_ENDPOINT = 'https://tmw-subscribe.jake-ab7.workers.dev';
  var MARKETS = ['florida', 'tennessee', 'newyork', 'caribbean', 'rockies', 'hotel'];
  var KEY = 'tmw-sub-lightbox-v1';
  var DELAY_MS = 3000;

  function seen() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function mark(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function build() {
    var el = document.createElement('div');
    el.className = 'tmw-sub';
    el.innerHTML =
      '<div class="tmw-sub-panel" role="dialog" aria-label="Subscribe to the newsletter">' +
        '<button class="tmw-sub-x" aria-label="Close">&times;</button>' +
        '<div class="tmw-sub-eyebrow">The Future Is Here</div>' +
        '<h3 class="tmw-sub-h">Separate yourself from millions of monthly readers and join our newsletter.</h3>' +
        '<form class="tmw-sub-form">' +
          '<input type="email" name="email" placeholder="you@example.com" autocomplete="email" required>' +
          '<button type="submit">Subscribe</button>' +
        '</form>' +
        '<div class="tmw-sub-msg" aria-live="polite"></div>' +
      '</div>';
    document.body.appendChild(el);

    // Dismiss only closes it for this page — it re-appears on the next article.
    function close() { el.classList.remove('show'); }
    el.querySelector('.tmw-sub-x').addEventListener('click', close);
    el.addEventListener('click', function (e) { if (e.target === el) close(); });

    var form = el.querySelector('.tmw-sub-form');
    var msg = el.querySelector('.tmw-sub-msg');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = (form.email.value || '').trim();
      if (!email) return;
      var btn = form.querySelector('button'); var orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Subscribing…';
      try {
        var r = await fetch(SUB_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, markets: MARKETS }) });
        var d = await r.json().catch(function () { return {}; });
        if (d && d.success) {
          try { if (window.gtag) window.gtag('event', 'subscribe_article'); } catch (_) {}
          form.style.display = 'none';
          msg.textContent = "✓ You've subscribed! Welcome to The Weekly.";
          mark('subscribed');
          setTimeout(function () { el.classList.remove('show'); }, 2600);
        } else { btn.disabled = false; btn.textContent = orig; }
      } catch (err) { btn.disabled = false; btn.textContent = orig; }
    });

    requestAnimationFrame(function () { el.classList.add('show'); });
  }

  // Show on EVERY article for logged-out readers. Suppress only for (a) people
  // who already subscribed via this lightbox, and (b) signed-in members (free
  // or pro) — they've already got an account.
  function suppressed(cb) {
    try { if (localStorage.getItem(KEY) === 'subscribed') { cb(true); return; } } catch (e) {}
    if (window._tmwSignedIn === true) { cb(true); return; }
    if (window._tmwSignedIn === false) { cb(false); return; }
    var m = window.$memberstackDom;
    if (m && m.getCurrentMember) {
      m.getCurrentMember().then(function (r) { cb(!!(r && r.data)); }).catch(function () { cb(false); });
      return;
    }
    cb(false); // Memberstack not up yet → treat as logged-out
  }
  var t = setTimeout(function () { suppressed(function (s) { if (!s) build(); }); }, DELAY_MS);
  // If they bounce fast, don't bother.
  window.addEventListener('pagehide', function () { clearTimeout(t); });
})();
