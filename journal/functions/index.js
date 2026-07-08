// Cloudflare Pages Function — homepage (/) ONLY.
//
// Injects the CURRENT featured story into the hero on the way out, so the HTML
// the browser receives is always up to date. This replaces the old "bake the
// hero into index.html + wait for a redeploy" latency (a hero change used to
// take a few minutes to appear) — now it's live the instant the article is.
//
// No client-side swap → no old→new flash. The baked hero in index.html remains
// as the fallback: if the worker fetch fails or anything throws, we serve the
// untouched static page (exactly the prior behavior), so this can never break
// the homepage.
//
// Pick + link format mirror bake_hero.py and the client exactly:
//   HERO = most-recent FEATURED published post, else newest.
// We read the PUBLIC /posts feed, which is page-ready-gated, so the hero can
// only ever point at a /post/<slug>/ page that is already live (no 404).

const WORKER = 'https://tmw.jake-ab7.workers.dev';

async function getHero() {
  // cacheTtl keeps this to ~one subrequest per 30s across all homepage hits.
  const r = await fetch(WORKER + '/posts?limit=60&status=published', {
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!r.ok) return null;
  const items = ((await r.json()) || {}).items || [];
  if (!items.length) return null;
  const it = items.find((x) => x && x.featured) || items[0];
  if (!it || !it.slug || !it.title) return null;
  return {
    link: '/post/' + it.slug + '/',        // raw slug — matches bake_hero + the built page dir
    title: String(it.title),
    summary: String(it.excerpt || ''),
    image: String(it.cover_image || ''),
  };
}

export async function onRequest(context) {
  const res = await context.next();
  try {
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return res;   // only transform the HTML doc
    const hero = await getHero();
    if (!hero) return res;                        // no live pick → serve baked hero as-is

    const out = new HTMLRewriter()
      .on('#hero-img', { element(e) { if (hero.image) { e.setAttribute('src', hero.image); e.setAttribute('alt', hero.title); } } })
      .on('#hero-link', { element(e) { e.setAttribute('href', hero.link); e.setInnerContent(hero.title); } })
      .on('#hero-summary', { element(e) { e.setInnerContent(hero.summary); } })
      .on('#hero-cta', { element(e) { e.setAttribute('href', hero.link); } })
      .transform(res);
    // Tag the response so we can confirm the edge injection is live (curl -I).
    const h = new Headers(out.headers);
    h.set('x-tmw-hero', 'edge');
    return new Response(out.body, { status: out.status, statusText: out.statusText, headers: h });
  } catch (e) {
    return res;   // fail-safe: any error → untouched baked homepage
  }
}
