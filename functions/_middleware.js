// Cloudflare Pages middleware — loading-veil anti-flash.
//
// When a page is reached through the Departure Board loader (tmw-loader.js), the
// origin stamps sessionStorage.tmwl_t0 right before navigating. The destination
// is supposed to cover itself in site-black instantly, but that cover was
// injected by journal-chrome.js — a DEFERRED script that runs AFTER the browser
// has already painted the new page, so you saw a 1-frame flash of the
// destination between the two board animations (Jake, screen recording 2026-08-11).
//
// Fix: inject the SAME cover as a SYNCHRONOUS inline <script> at the end of
// <head>, so it runs before the body ever paints. It only acts when tmwl_t0 is
// fresh (a real loader navigation) — a direct visit is a no-op. journal-chrome.js
// still runs its copy, but its `#tmwl-stub` guard makes it a harmless no-op once
// this one exists; tmw-loader.js's arrival board removes the stub as before.
//
// Streaming HTMLRewriter, HTML responses only, and it passes the response through
// untouched on anything unexpected — it can never break a page.

const STUB =
  '<script>/*tmwl-stub*/(function(){try{var t=+sessionStorage.getItem("tmwl_t0")||0;' +
  'if(!t||Date.now()-t>8000)return;var d=document.createElement("div");d.id="tmwl-stub";' +
  'd.style.cssText="position:fixed;inset:0;z-index:99989;background:#070807";' +
  '(document.body||document.documentElement).appendChild(d);' +
  'setTimeout(function(){try{if(d.parentNode)d.parentNode.removeChild(d)}catch(e){}},8000)}catch(e){}})()</script>';

export async function onRequest(context) {
  const response = await context.next();
  try {
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return response;
    return new HTMLRewriter()
      .on('head', { element(el) { el.append(STUB, { html: true }); } })
      .transform(response);
  } catch (e) { return response; }
}
