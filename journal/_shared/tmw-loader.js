/* tmw-loader.js — the between-pages loading screen.
   Dark-gray full-screen veil with the "Future is Here" mark: the logo is a
   CSS mask over a white base, and a purple "water" layer with two drifting
   wave crests rises inside it, so the letters fill white → purple like a cup.

   Shows the moment a same-origin navigation click happens (so it covers the
   unload/response wait) and never on the destination page. Guards:
   - bubble-phase listener that respects e.defaultPrevented (overlay/JS links
     never trigger it), modifier/middle clicks, target=_blank, download,
     mailto/tel, same-page #hashes, and [data-no-loader]
   - pageshow ALWAYS hides it (bfcache restores would otherwise resurrect it)
   - a 5s failsafe hides it if the navigation never actually happens
   - no CSS transitions anywhere (the GL map stalls them); animations only
   Include once per page (journal-chrome.js loads it site-wide). */
(function () {
  'use strict';
  if (window.__tmwLoader) return;
  window.__tmwLoader = true;

  var css = [
    '.tmwl{position:fixed;inset:0;z-index:99990;background:#131316;display:none;align-items:center;justify-content:center}',
    '.tmwl.on{display:flex}',
    '.tmwl-logo{position:relative;width:min(150px,36vw);aspect-ratio:382.2/419;background:#fff;overflow:hidden;',
    '-webkit-mask:url(/_shared/futureishere.svg) center/contain no-repeat;mask:url(/_shared/futureishere.svg) center/contain no-repeat}',
    /* the rising water — loops like the cup refilling */
    '.tmwl-water{position:absolute;left:0;right:0;bottom:0;height:0;background:#A78BFA;animation:tmwlRise 2s ease-in-out infinite}',
    /* two drifting crests riding the waterline (only visible inside the mask) */
    '.tmwl-wave{position:absolute;bottom:100%;left:0;width:200%;height:12px;background-repeat:repeat-x;background-size:96px 12px;animation:tmwlDrift 1.15s linear infinite}',
    '.tmwl-wave.w1{background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 96 12%27%3E%3Cpath d=%27M0 12V7C12 7 12 2 24 2s12 5 24 5 12-5 24-5 12 5 24 5v5z%27 fill=%27%23A78BFA%27/%3E%3C/svg%3E")}',
    '.tmwl-wave.w2{background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 96 12%27%3E%3Cpath d=%27M0 12V6C16 6 16 10 32 10S48 4 64 4s16 6 32 6v2z%27 fill=%27%23C4B5FD%27 fill-opacity=%27.55%27/%3E%3C/svg%3E")',
    ';animation-duration:1.7s;animation-direction:reverse;height:10px}',
    '@keyframes tmwlRise{0%{height:4%}55%{height:96%}82%{height:104%}100%{height:104%}}',
    '@keyframes tmwlDrift{to{transform:translateX(-96px)}}',
    '@media(prefers-reduced-motion:reduce){.tmwl-water{animation:none;height:55%}.tmwl-wave{animation:none}}'
  ].join('');
  var st = document.createElement('style'); st.textContent = css;
  document.head.appendChild(st);

  var el = document.createElement('div');
  el.className = 'tmwl';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="tmwl-logo"><div class="tmwl-water"><div class="tmwl-wave w1"></div><div class="tmwl-wave w2"></div></div></div>';
  function mount(){ if (!el.parentNode && document.body) document.body.appendChild(el); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  var hideTimer = null;
  function show(){
    mount();
    el.classList.add('on');
    clearTimeout(hideTimer);
    // failsafe: a click that never became a navigation must not trap the page
    hideTimer = setTimeout(hide, 5000);
  }
  function hide(){ clearTimeout(hideTimer); el.classList.remove('on'); }
  window.tmwLoader = { show: show, hide: hide };

  // bfcache restore (Safari/Chrome back-forward) resurrects the old page WITH
  // the veil up — always drop it when a page becomes visible again.
  window.addEventListener('pageshow', hide);

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;                        // an overlay/JS handled it
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.closest('[data-no-loader]') || a.hasAttribute('data-no-loader')) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    var u; try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.origin !== location.origin) return;
    if (u.pathname === location.pathname && u.search === location.search && u.hash) return;  // same-page anchor
    show();
  });
})();
