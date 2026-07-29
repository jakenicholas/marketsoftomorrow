// Cloudflare Pages Function — the Atlas app's route paths.
//
// The Atlas is a routed app: /atlas/projects/, /atlas/supply/, /atlas/capital/
// and friends are VIEWS, not files. There is one shell (journal/atlas/
// index.html) and the client picks the view from the path.
//
// _redirects cannot do this. Its 301/302 rules work fine on this project, but
// its 200 (rewrite) rules are ignored here — verified live: /blog 301s
// correctly while /atlas/projects/ 404s and /atlas/projects 308s to /atlas/.
// So the rewrite happens here instead.
//
// Unknown segments fall through to the shell too, and the client resolves any
// unrecognised route to Overview. That is deliberate: a stale or mistyped
// Atlas link should land the reader in the app, not on a 404.
//
// The shell is served with its own URL so relative asset paths resolve, and
// the reader keeps the route in the address bar (a rewrite, never a redirect).

const ROUTES = new Set([
  'overview', 'projects', 'supply', 'pricing', 'builders', 'capital', 'movers',
]);

export async function onRequest(context) {
  const { request, env, params, next } = context;
  const url = new URL(request.url);
  const route = String(params.route || '').toLowerCase();

  // Anything that looks like a real file under /atlas/ stays a real file.
  if (route.includes('.')) return next();

  // Not one of ours → let Pages answer (404 or a future asset).
  if (!ROUTES.has(route)) return next();

  const shell = await env.ASSETS.fetch(new URL('/atlas/index.html', url));
  // Re-wrap so we can set our own cache headers without touching the body.
  return new Response(shell.body, {
    status: shell.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Same posture as the shell itself: always revalidate, so a new build
      // reaches readers without a stale route serving old app code.
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
}
