/* project-shuffle.js — cinematic project page enhancements
 *
 * Two independent interactions on the cinematic project page:
 *   1) GALLERY  — bottom-centre cluster cycles THIS project's photos (the hero
 *      background). Keys ← → and swipe. Pure client, no network.
 *   2) SHUFFLE  — big edge arrows jump to ANOTHER project (same-market first,
 *      else random). Keys [ ]. Implemented as a pjax fragment swap: we fetch the
 *      target's real, server-rendered page and swap in its #ppHeroInner + #ppBelow
 *      fragments, then history.pushState to its URL. This keeps every project's
 *      own crawlable URL + identical content (no template duplication in JS) and
 *      makes back/forward work via popstate.
 *
 * Per-page data lives on #pp (data-slug, data-images). The shuffle candidate list
 * + same-market grouping come from /map/projects-flat.json (the same manifest the
 * search + map use). Watch/Updates hydration is re-run after each swap via the
 * window.ppInitWatch / window.ppInitUpdates hooks the page exposes.
 */
(function () {
  'use strict';

  var root = document.getElementById('pp');
  if (!root) return;

  var hero = document.getElementById('ppHero');
  var heroInner = document.getElementById('ppHeroInner');
  var below = document.getElementById('ppBelow');
  var bgLayers = root.querySelectorAll('.pp-bg');
  var gal = document.getElementById('ppGal');

  // ---- shared: hero background crossfade -------------------------------------
  var bgActive = 0;
  function setHeroBg(url, instant) {
    if (!url || bgLayers.length < 2) return;
    var incoming = bgLayers[bgActive ^ 1];
    var outgoing = bgLayers[bgActive];
    incoming.style.backgroundImage = "url('" + url.replace(/'/g, "%27") + "')";
    if (instant) {
      incoming.style.transition = 'none';
      outgoing.style.transition = 'none';
    }
    // force reflow so the transition picks up the new image
    void incoming.offsetWidth;
    incoming.style.opacity = '1';
    outgoing.style.opacity = '0';
    incoming.style.transform = 'scale(1.06)';
    outgoing.style.transform = 'scale(1)';
    if (instant) {
      requestAnimationFrame(function () {
        incoming.style.transition = '';
        outgoing.style.transition = '';
      });
    }
    bgActive ^= 1;
  }

  // ---- GALLERY ---------------------------------------------------------------
  var gImages = [];
  var gIdx = 0;

  function readImages() {
    try { gImages = JSON.parse(root.getAttribute('data-images') || '[]'); }
    catch (e) { gImages = []; }
    if (!Array.isArray(gImages)) gImages = [];
  }

  function renderGalleryCluster() {
    if (!gal) return;
    if (gImages.length < 2) { gal.style.display = 'none'; return; }
    gal.style.display = 'flex';
    var dots = gal.querySelector('.pp-gal-dots');
    var cnt = gal.querySelector('.pp-gal-cnt');
    if (dots) {
      var h = '';
      for (var i = 0; i < gImages.length; i++) {
        h += '<i class="' + (i === gIdx ? 'on' : '') + '" data-i="' + i + '"></i>';
      }
      dots.innerHTML = h;
    }
    if (cnt) cnt.textContent = (gIdx + 1) + ' / ' + gImages.length;
  }

  function galleryGo(delta, absolute) {
    if (gImages.length < 2) return;
    gIdx = absolute != null
      ? absolute
      : (gIdx + delta + gImages.length) % gImages.length;
    setHeroBg(gImages[gIdx]);
    renderGalleryCluster();
    // preload neighbour
    var nxt = new Image(); nxt.src = gImages[(gIdx + 1) % gImages.length];
  }

  function resetGallery(instant) {
    readImages();
    gIdx = 0;
    if (gImages.length) setHeroBg(gImages[0], instant);
    renderGalleryCluster();
  }

  if (gal) {
    var gp = gal.querySelector('.pp-gal-prev');
    var gn = gal.querySelector('.pp-gal-next');
    if (gp) gp.addEventListener('click', function () { galleryGo(-1); });
    if (gn) gn.addEventListener('click', function () { galleryGo(1); });
    gal.addEventListener('click', function (e) {
      var dot = e.target.closest && e.target.closest('.pp-gal-dots i');
      if (dot) galleryGo(0, parseInt(dot.getAttribute('data-i'), 10));
    });
  }

  // swipe on hero = gallery photos
  var sx = 0, sy = 0;
  if (hero) {
    hero.addEventListener('touchstart', function (e) {
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    hero.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - sx;
      var dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) galleryGo(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // ---- SHUFFLE (pjax) --------------------------------------------------------
  var projects = null;
  var bySlug = {};
  var byCity = {};
  var pending = null;     // { rec, promise } prefetched next candidate
  var busy = false;

  function slugify(t) {
    return (t || '').toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function firstImage(rec) {
    var keys = ['ImageURL', 'Image2', 'Image3', 'Image4', 'Image5'];
    for (var i = 0; i < keys.length; i++) {
      var v = (rec[keys[i]] || '').trim();
      if (v) return v;
    }
    return '';
  }

  function loadManifest() {
    return fetch('/map/projects-flat.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        projects = Array.isArray(list) ? list : [];
        projects.forEach(function (p) {
          p.__slug = slugify(p.Title || '');
          bySlug[p.__slug] = p;
          var c = (p.City || '').trim();
          (byCity[c] = byCity[c] || []).push(p);
        });
        return projects;
      })
      .catch(function () { projects = []; return projects; });
  }

  function pickNext() {
    if (!projects || !projects.length) return null;
    var curSlug = root.getAttribute('data-slug') || '';
    var cur = bySlug[curSlug];
    var pool = [];
    if (cur) {
      var same = byCity[(cur.City || '').trim()] || [];
      pool = same.filter(function (p) { return p.__slug !== curSlug; });
    }
    if (!pool.length) {
      pool = projects.filter(function (p) { return p.__slug !== curSlug; });
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Fetch + parse a project page into the fragments we swap in.
  function fetchProject(rec) {
    var url = '/map/projects/' + rec.__slug + '/';
    return fetch(url, { cache: 'force-cache' })
      .then(function (r) { if (!r.ok) throw new Error('404'); return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var pp = doc.getElementById('pp');
        var hi = doc.getElementById('ppHeroInner');
        var bl = doc.getElementById('ppBelow');
        if (!pp || !hi || !bl) throw new Error('shape');
        var canon = doc.querySelector('link[rel="canonical"]');
        return {
          url: url,
          slug: pp.getAttribute('data-slug') || rec.__slug,
          images: pp.getAttribute('data-images') || '[]',
          heroHTML: hi.innerHTML,
          belowHTML: bl.innerHTML,
          title: doc.title || document.title,
          canonical: canon ? canon.getAttribute('href') : null,
          desc: (doc.querySelector('meta[name="description"]') || {}).content || ''
        };
      });
  }

  function preparePending() {
    var rec = pickNext();
    if (!rec) { pending = null; updatePeeks(null); return; }
    pending = { rec: rec, promise: fetchProject(rec).catch(function () { return null; }) };
    updatePeeks(rec);
  }

  function updatePeeks(rec) {
    var img = rec ? firstImage(rec) : '';
    ['ppPeekL', 'ppPeekR'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.backgroundImage = img ? "url('" + img.replace(/'/g, '%27') + "')" : '';
    });
  }

  // Apply a parsed project to the DOM with a horizontal slide.
  function applyProject(parsed, dir, push) {
    if (!parsed) return;
    var outX = dir < 0 ? '46px' : '-46px';
    var inX = dir < 0 ? '-46px' : '46px';

    heroInner.style.transform = 'translateX(' + outX + ')';
    heroInner.style.opacity = '0';
    if (below) below.style.opacity = '0';

    setTimeout(function () {
      // swap content
      heroInner.innerHTML = parsed.heroHTML;
      if (below) below.innerHTML = parsed.belowHTML;
      root.setAttribute('data-slug', parsed.slug);
      root.setAttribute('data-images', parsed.images);

      // hero bg = first image of new project
      resetGallery(true);

      // metadata
      document.title = parsed.title;
      if (parsed.canonical) {
        var c = document.querySelector('link[rel="canonical"]');
        if (c) c.setAttribute('href', parsed.canonical);
      }
      if (parsed.desc) {
        var m = document.querySelector('meta[name="description"]');
        if (m) m.setAttribute('content', parsed.desc);
      }
      if (push) history.pushState({ slug: parsed.slug }, '', parsed.url);

      // animate in from the opposite side
      heroInner.style.transition = 'none';
      heroInner.style.transform = 'translateX(' + inX + ')';
      void heroInner.offsetWidth;
      heroInner.style.transition = '';
      heroInner.style.transform = 'translateX(0)';
      heroInner.style.opacity = '1';
      if (below) below.style.opacity = '1';

      try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { window.scrollTo(0, 0); }

      // re-hydrate the swapped-in interactive bits
      reinit();
      busy = false;
    }, 240);
  }

  function reinit() {
    try { if (window.ppInitWatch) window.ppInitWatch(); } catch (e) {}
    try { if (window.ppInitUpdates) window.ppInitUpdates(); } catch (e) {}
  }

  function shuffle(dir) {
    if (busy || !projects) return;
    if (!pending) { preparePending(); if (!pending) return; }
    busy = true;
    var p = pending;
    p.promise.then(function (parsed) {
      if (!parsed) {
        // fetch failed — fall back to a hard navigation so the user still moves
        busy = false;
        window.location.href = '/map/projects/' + p.rec.__slug + '/';
        return;
      }
      applyProject(parsed, dir, true);
      preparePending();   // line up + prefetch the next one
    });
  }

  // popstate: user hit back/forward — resolve slug from the path and swap.
  window.addEventListener('popstate', function () {
    var m = location.pathname.match(/\/projects\/([^\/]+)\/?$/);
    if (!m) return;
    var slug = m[1];
    if (slug === root.getAttribute('data-slug')) return;
    var rec = bySlug[slug] || { __slug: slug };
    fetchProject(rec).then(function (parsed) {
      if (parsed) applyProject(parsed, -1, false);
      else window.location.reload();
    }).catch(function () { window.location.reload(); });
  });

  // wire arrows + keys
  var prevBtn = document.getElementById('ppPrev');
  var nextBtn = document.getElementById('ppNext');
  if (prevBtn) prevBtn.addEventListener('click', function () { shuffle(-1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { shuffle(1); });
  [prevBtn, nextBtn].forEach(function (b) {
    if (b) b.addEventListener('mouseenter', function () { if (!pending) preparePending(); });
  });

  document.addEventListener('keydown', function (e) {
    var t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === 'ArrowLeft') galleryGo(-1);
    else if (e.key === 'ArrowRight') galleryGo(1);
    else if (e.key === '[') shuffle(-1);
    else if (e.key === ']') shuffle(1);
  });

  // ---- init ------------------------------------------------------------------
  resetGallery(true);
  loadManifest().then(function () {
    // prefetch the first candidate on idle so the first shuffle is instant
    if ('requestIdleCallback' in window) requestIdleCallback(preparePending);
    else setTimeout(preparePending, 600);
  });
})();
