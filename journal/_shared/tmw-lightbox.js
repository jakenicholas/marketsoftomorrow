/* ------------------------------------------------------------------
   Markets of Tomorrow — shared image lightbox
   Port of the article-page lightbox (journal/post/post.js) so any
   page (project pages, market pages, firm pages) can drop in a single
   <script src="/_shared/tmw-lightbox.js" defer></script> and get the
   same click-to-zoom-on-dark-backdrop UX.

   API:
     window.tmwLightbox.attach(root?)     hook every <img> under `root`
                                          (default: document) as clickable
     window.tmwLightbox.open(items, idx)  programmatic open
     window.tmwLightbox.close()           close

   Markup conventions inherited from articles:
     - figure > img + figcaption          → caption pulled from figcaption
     - .tmw-gallery-track > * > img       → grouped (prev/next arrows)
     - .tmw-gallery-grid > .tmw-gallery-grid-item > img   → same
     - opt-out: <img data-no-lightbox>

   Visual styles live in this same file (injected once) so the script is
   self-contained — no /_shared/tmw-lightbox.css to babysit.
-------------------------------------------------------------------*/
(function () {
  'use strict';
  if (window.tmwLightbox) return;

  var LB = { items: [], idx: 0, el: null, img: null };

  function injectCSS() {
    if (document.getElementById('tmw-lb-css')) return;
    var s = document.createElement('style'); s.id = 'tmw-lb-css';
    s.textContent = [
      '.tmw-lb{position:fixed; inset:0; z-index:99998; background:rgba(8,8,8,.93); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); display:flex; align-items:center; justify-content:center; padding:40px; opacity:0; pointer-events:none; transition:opacity .18s ease}',
      '.tmw-lb.open{opacity:1; pointer-events:auto}',
      '.tmw-lb-img{max-width:min(100%, 1400px); max-height:calc(100vh - 120px); object-fit:contain; border-radius:6px; box-shadow:0 30px 80px rgba(0,0,0,.6); user-select:none}',
      '.tmw-lb-close{position:absolute; top:18px; right:22px; width:42px; height:42px; border:0; border-radius:50%; background:rgba(255,255,255,.08); color:#fff; font-size:24px; line-height:42px; cursor:pointer; backdrop-filter:blur(8px); transition:background .15s}',
      '.tmw-lb-close:hover{background:rgba(255,255,255,.16)}',
      '.tmw-lb-arrow{position:absolute; top:50%; transform:translateY(-50%); width:48px; height:48px; border:0; border-radius:50%; background:rgba(255,255,255,.08); color:#fff; cursor:pointer; backdrop-filter:blur(8px); transition:background .15s; display:flex; align-items:center; justify-content:center}',
      '.tmw-lb-arrow:hover{background:rgba(255,255,255,.16)}',
      '.tmw-lb-arrow svg{width:22px; height:22px}',
      '.tmw-lb-arrow.prev{left:22px}',
      '.tmw-lb-arrow.next{right:22px}',
      '.tmw-lb-counter{position:absolute; top:24px; left:50%; transform:translateX(-50%); font-family:"JetBrains Mono","SF Mono",ui-monospace,monospace; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:rgba(255,255,255,.7); background:rgba(0,0,0,.4); padding:6px 14px; border-radius:999px}',
      '.tmw-lb-cap{position:absolute; bottom:24px; left:50%; transform:translateX(-50%); max-width:min(80vw, 800px); text-align:center; font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif; font-size:13.5px; color:rgba(255,255,255,.85); background:rgba(0,0,0,.5); padding:10px 18px; border-radius:8px; backdrop-filter:blur(6px); line-height:1.45}',
      '@media (max-width:760px){.tmw-lb{padding:14px} .tmw-lb-arrow{width:40px; height:40px} .tmw-lb-arrow.prev{left:10px} .tmw-lb-arrow.next{right:10px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function ensureLightbox() {
    if (LB.el) return;
    injectCSS();
    var el = document.createElement('div');
    el.className = 'tmw-lb';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<button class="tmw-lb-close" aria-label="Close">×</button>' +
      '<button class="tmw-lb-arrow prev" aria-label="Previous"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<img class="tmw-lb-img" alt="">' +
      '<button class="tmw-lb-arrow next" aria-label="Next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>' +
      '<div class="tmw-lb-counter"></div>' +
      '<div class="tmw-lb-cap"></div>';
    document.body.appendChild(el);
    LB.el = el;
    LB.img = el.querySelector('.tmw-lb-img');
    var prevBtn = el.querySelector('.tmw-lb-arrow.prev');
    var nextBtn = el.querySelector('.tmw-lb-arrow.next');
    LB.counter = el.querySelector('.tmw-lb-counter');
    LB.cap = el.querySelector('.tmw-lb-cap');
    LB.prevBtn = prevBtn; LB.nextBtn = nextBtn;
    el.querySelector('.tmw-lb-close').addEventListener('click', close);
    prevBtn.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
    nextBtn.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    document.addEventListener('keydown', function (e) {
      if (!LB.el.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
  }

  function captionFor(img) {
    var fig = img.closest('figure');
    if (fig) { var fc = fig.querySelector('figcaption'); if (fc) return (fc.textContent || '').trim(); }
    var slide = img.closest('.tmw-gallery-track > *, .tmw-gallery-grid-item');
    if (slide) { var c = slide.querySelector('.tmw-gallery-caption, figcaption'); if (c) return (c.textContent || '').trim(); }
    // Also honor an alt attribute as a fallback caption (project card titles)
    var alt = (img.getAttribute('alt') || '').trim();
    if (alt && alt.toLowerCase().indexOf('image of ') === 0) return alt.slice(9);
    return alt;
  }

  function step(dir) {
    if (!LB.items.length) return;
    LB.idx = (LB.idx + dir + LB.items.length) % LB.items.length;
    render();
  }

  function render() {
    var it = LB.items[LB.idx]; if (!it) return;
    LB.img.src = it.src;
    LB.img.alt = it.caption || '';
    LB.cap.textContent = it.caption || '';
    LB.cap.style.display = it.caption ? '' : 'none';
    var multi = LB.items.length > 1;
    LB.prevBtn.style.display = LB.nextBtn.style.display = LB.counter.style.display = multi ? '' : 'none';
    if (multi) LB.counter.textContent = (LB.idx + 1) + ' / ' + LB.items.length;
  }

  function open(items, idx) {
    ensureLightbox();
    LB.items = items || []; LB.idx = idx || 0;
    render();
    LB.el.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
  }

  function close() {
    if (!LB.el) return;
    LB.el.classList.remove('open');
    document.documentElement.style.overflow = '';
  }

  function attach(root) {
    root = root || document;
    var imgs = root.querySelectorAll('img:not([data-no-lightbox])');
    Array.prototype.forEach.call(imgs, function (img) {
      if (img.__lbHooked) return;
      // Skip tiny icons / svgs / logos. Heuristic: width/height attribute under 64
      // (or 0/unset which means we let it through and check at click time).
      var w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      var h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10);
      if (w && h && w < 64 && h < 64) return;
      img.__lbHooked = true;
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', function (e) {
        e.preventDefault();
        var gal = img.closest('.tmw-gallery-track, .tmw-gallery-grid, .tmw-project-grid');
        var group = gal ? Array.prototype.slice.call(gal.querySelectorAll('img:not([data-no-lightbox])')) : [img];
        var items = group.map(function (g) { return { src: g.currentSrc || g.src, caption: captionFor(g) }; });
        var idx = Math.max(0, group.indexOf(img));
        open(items, idx);
      });
    });
  }

  // Also pick up div-backgrounds (project card .card-img uses background-image
  // rather than a real <img>). Honor data-lightbox-src to make it explicit.
  function attachBackgrounds(root) {
    root = root || document;
    var els = root.querySelectorAll('[data-lightbox-src]');
    Array.prototype.forEach.call(els, function (el) {
      if (el.__lbHooked) return;
      el.__lbHooked = true;
      el.style.cursor = 'zoom-in';
      el.addEventListener('click', function (e) {
        // Only open if the click isn't on a link/button INSIDE the card.
        if (e.target.closest('a,button') && e.target !== el) return;
        var src = el.getAttribute('data-lightbox-src');
        var cap = el.getAttribute('data-lightbox-caption') || '';
        // Group by nearest .tmw-project-grid; gather all sibling backgrounds.
        var grid = el.closest('.tmw-project-grid');
        var group = grid ? Array.prototype.slice.call(grid.querySelectorAll('[data-lightbox-src]')) : [el];
        var items = group.map(function (g) {
          return { src: g.getAttribute('data-lightbox-src'), caption: g.getAttribute('data-lightbox-caption') || '' };
        });
        var idx = Math.max(0, group.indexOf(el));
        e.preventDefault();
        e.stopPropagation();
        open(items, idx);
      }, true); // capture so we beat the card's <a> default
    });
  }

  window.tmwLightbox = { attach: attach, attachBackgrounds: attachBackgrounds, open: open, close: close };

  function init() { attach(document); attachBackgrounds(document); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
