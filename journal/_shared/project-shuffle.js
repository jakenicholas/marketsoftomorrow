/* project-shuffle.js — cinematic project page gallery
 *
 * (Despite the legacy filename, this is now gallery-only. The random-project
 * "shuffle" arrows were removed in favour of a static "Nearby Projects" section
 * rendered server-side at the bottom of the page.)
 *
 * The hero background is a photo gallery: the bottom-centre cluster (and the
 * arrow keys / swipe) cycle through this project's photos. Per-page image list
 * lives on #pp[data-images].
 */
(function () {
  'use strict';

  var root = document.getElementById('pp');
  if (!root) return;

  var hero = document.getElementById('ppHero');
  var bgLayers = root.querySelectorAll('.pp-bg');
  var gal = document.getElementById('ppGal');

  // ---- hero background crossfade ---------------------------------------------
  var bgActive = 0;
  function setHeroBg(url, instant) {
    if (!url || bgLayers.length < 2) return;
    var incoming = bgLayers[bgActive ^ 1];
    var outgoing = bgLayers[bgActive];
    incoming.style.backgroundImage = "url('" + url.replace(/'/g, '%27') + "')";
    if (instant) {
      incoming.style.transition = 'none';
      outgoing.style.transition = 'none';
    }
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

  // ---- gallery ---------------------------------------------------------------
  var gImages = [];
  var gIdx = 0;

  function readImages() {
    try { gImages = JSON.parse(root.getAttribute('data-images') || '[]'); }
    catch (e) { gImages = []; }
    if (!Array.isArray(gImages)) gImages = [];
  }

  function renderCluster() {
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

  function go(delta, absolute) {
    if (gImages.length < 2) return;
    gIdx = absolute != null
      ? absolute
      : (gIdx + delta + gImages.length) % gImages.length;
    setHeroBg(gImages[gIdx]);
    renderCluster();
    var nxt = new Image(); nxt.src = gImages[(gIdx + 1) % gImages.length];
  }

  if (gal) {
    var gp = gal.querySelector('.pp-gal-prev');
    var gn = gal.querySelector('.pp-gal-next');
    if (gp) gp.addEventListener('click', function () { go(-1); });
    if (gn) gn.addEventListener('click', function () { go(1); });
    gal.addEventListener('click', function (e) {
      var dot = e.target.closest && e.target.closest('.pp-gal-dots i');
      if (dot) go(0, parseInt(dot.getAttribute('data-i'), 10));
    });
  }

  // swipe on the hero image = cycle photos
  var sx = 0, sy = 0;
  if (hero) {
    hero.addEventListener('touchstart', function (e) {
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    hero.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - sx;
      var dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  document.addEventListener('keydown', function (e) {
    var t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  });

  // ---- init ------------------------------------------------------------------
  readImages();
  gIdx = 0;
  if (gImages.length) setHeroBg(gImages[0], true);
  renderCluster();
})();
