/*
  Iconic list pages (golf / hotels / restaurants) — a gold view-switcher in
  the tabs-bar:

      Card  ⇄  Text  ⇄  Map

  Card view (the big ranked cards) is the default. Text view is a dense
  spreadsheet built from whatever cards are currently rendered. Map view
  is a dark-themed Mapbox map (same style as the /map/ page) with a gold
  pin per item — locations are forward-geocoded via Mapbox and cached in
  localStorage so subsequent visits drop pins instantly.

  Shared + identical across all three iconic-list pages:
      <script src="/_shared/iconic-view.js" defer></script>
*/
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ─── Mapbox config ───────────────────────────────────────────────
  // Same token + style used by the main /map/ page so the brand feel
  // carries straight over.
  var MAPBOX_TOKEN = 'pk.eyJ1IjoiZmxvcmlkYW9mdG9tb3Jyb3ciLCJhIjoiY2xrYmpmdGQ2MGdibTNzcXZjMnA4aXh3ZiJ9.uBeYS7jmKwWS6xAgY-R1UA';
  var MAPBOX_STYLE = 'mapbox://styles/floridaoftomorrow/clkbk4qlw000a01qw94rj0xa7';
  var MAPBOX_GL_JS  = 'https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.js';
  var MAPBOX_GL_CSS = 'https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.css';
  // Versioned cache namespace so a future schema change can invalidate
  // old cached coordinates by bumping the key prefix.
  var GEOCODE_CACHE_KEY = 'tmwIconicGeocodeV1';

  if (!document.getElementById('iconic-view-styles')) {
    var css =
      '.iv-toggle{display:inline-flex; gap:4px; padding:4px; background:rgba(255,255,255,.04); border:1px solid var(--hair-2); border-radius:999px}' +
      '.iv-btn{width:36px; height:30px; display:inline-flex; align-items:center; justify-content:center; border:0; background:transparent; color:var(--mute-2); border-radius:999px; cursor:pointer; transition:background .18s, color .18s; padding:0}' +
      '.iv-btn:hover{color:var(--gold-soft)}' +
      '.iv-btn.on{background:var(--gold); color:var(--ink)}' +
      '.iv-btn.on:hover{color:var(--ink)}' +
      '.iv-btn svg{width:16px; height:16px}' +
      '.iv-btn .iv-t{font-family:var(--serif); font-weight:700; font-size:16px; line-height:1}' +
      '.iv-sheet{margin-top:10px; border:1px solid var(--hair); border-radius:14px; overflow:hidden; background:rgba(255,255,255,.015)}' +
      '.iv-row{display:grid; grid-template-columns:56px 1.5fr 1fr 1fr; gap:18px; align-items:center; padding:13px 22px; border-top:1px solid var(--hair)}' +
      '.iv-row:first-child{border-top:0}' +
      '.iv-head{font-family:var(--mono); font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--mute); background:rgba(255,255,255,.025)}' +
      '.iv-row:not(.iv-head):hover{background:rgba(230,197,116,.05)}' +
      '.iv-rk{font-family:var(--serif); font-size:19px; font-weight:600; color:var(--gold-soft); font-variant-numeric:tabular-nums; letter-spacing:-.01em}' +
      '.iv-nm{font-weight:600; color:var(--white); font-size:15px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}' +
      '.iv-nm a{color:inherit; text-decoration:none}' +
      '.iv-nm a:hover{color:var(--gold-soft)}' +
      '.iv-lc{font-family:var(--mono); font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--green); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}' +
      '.iv-dt{font-size:13px; color:var(--mute-2); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}' +
      '.iv-empty{padding:50px 0; text-align:center; color:var(--mute); font-family:var(--mono); font-size:13px; letter-spacing:.1em}' +
      '@media(max-width:760px){.iv-row{grid-template-columns:38px 1fr auto; gap:12px} .iv-row .iv-dt{display:none} .iv-head span:nth-child(4){display:none}}' +
      /* ── Map view ── */
      '.iv-map-wrap{margin-top:10px; border:1px solid var(--hair); border-radius:14px; overflow:hidden; background:#0a0c0a; position:relative}' +
      '.iv-map{width:100%; height:min(72vh, 720px); min-height:480px; background:#0a0c0a}' +
      '.iv-map-status{position:absolute; top:14px; left:14px; z-index:5; padding:7px 13px; background:rgba(7,8,7,.78); -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); border:1px solid var(--hair-2); border-radius:999px; font-family:var(--mono); font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--mute-2); pointer-events:none; transition:opacity .25s}' +
      '.iv-map-status.hide{opacity:0}' +
      '.iv-map-status .dot{display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--gold); margin-right:7px; vertical-align:1px; animation:ivPulse 1.6s ease-out infinite}' +
      '@keyframes ivPulse{0%,100%{opacity:.5} 50%{opacity:1; box-shadow:0 0 8px var(--gold)}}' +
      /* Gold pin marker — square with star, matching the map page convention */
      '.iv-pin{position:relative; width:26px; height:26px; border-radius:6px; background:var(--gold); display:flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.5), 0 0 0 1.5px rgba(0,0,0,.4); transition:transform .15s, box-shadow .15s}' +
      '.iv-pin:hover{transform:translateY(-3px) scale(1.08); box-shadow:0 6px 20px rgba(230,197,116,.45), 0 0 0 1.5px rgba(0,0,0,.4)}' +
      '.iv-pin svg{width:14px; height:14px; fill:#0a0a0a}' +
      '.iv-pin-rank{position:absolute; top:-7px; right:-9px; min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--ink); color:var(--gold-soft); font-family:var(--mono); font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; border:1px solid var(--gold); font-variant-numeric:tabular-nums; line-height:1}' +
      /* Popup — dark theme. Inner padding zeroed on .mapboxgl-popup-content
         so the hero photo can sit flush against the top + left + right
         edges; .iv-pop-body re-adds padding under the photo for text. */
      '.mapboxgl-popup-content{background:rgba(13,15,14,.96)!important; color:var(--cream)!important; border:1px solid var(--hair-2); border-radius:14px; padding:0!important; font-family:var(--sans); box-shadow:0 14px 36px rgba(0,0,0,.65); max-width:340px; overflow:hidden}' +
      '.mapboxgl-popup-tip{border-top-color:rgba(13,15,14,.96)!important}' +
      '.mapboxgl-popup-close-button{color:var(--white)!important; padding:2px 9px; font-size:20px; background:rgba(7,8,7,.55)!important; border-radius:999px; width:28px; height:28px; margin:8px 8px 0 0; -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); z-index:2}' +
      '.mapboxgl-popup-close-button:hover{background:rgba(7,8,7,.78)!important}' +
      '.iv-pop{font-family:var(--sans); width:320px; max-width:100%}' +
      '.iv-pop-img{display:block; width:100%; height:170px; object-fit:cover; background:rgba(255,255,255,.04)}' +
      '.iv-pop-img-fb{display:flex; align-items:center; justify-content:center; width:100%; height:170px; background:linear-gradient(135deg, rgba(230,197,116,.15), rgba(167,139,250,.10)); color:var(--gold-soft); font-family:var(--mono); font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; font-weight:600}' +
      '.iv-pop-body{padding:14px 16px 16px}' +
      '.iv-pop .iv-pop-rk{font-family:var(--mono); font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--gold-soft); margin-bottom:6px; font-weight:700}' +
      '.iv-pop .iv-pop-nm{font-family:var(--serif); font-size:20px; font-weight:600; color:var(--white); line-height:1.2; margin-bottom:6px; letter-spacing:-.01em}' +
      '.iv-pop .iv-pop-lc{font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--green); margin-bottom:12px}' +
      '.iv-pop .iv-pop-go{display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--gold); font-weight:700; text-decoration:none; padding:9px 14px; border:1px solid rgba(230,197,116,.4); border-radius:999px; transition:background .15s, border-color .15s; cursor:pointer}' +
      '.iv-pop .iv-pop-go:hover{background:rgba(230,197,116,.14); border-color:var(--gold)}' +
      /* Highlight pulse on the card we just scrolled to from a popup */
      '.rank-item.iv-flash{animation:ivFlash 1.6s ease-out 1}' +
      '@keyframes ivFlash{0%{box-shadow:0 0 0 0 rgba(230,197,116,.55)} 60%{box-shadow:0 0 0 14px rgba(230,197,116,0)} 100%{box-shadow:0 0 0 0 rgba(230,197,116,0)}}' +
      /* Mapbox control restyle to fit dark UI */
      '.mapboxgl-ctrl-bottom-right .mapboxgl-ctrl{margin:0 14px 14px 0!important}' +
      '.mapboxgl-ctrl-attrib{background:rgba(0,0,0,.5)!important}' +
      '.mapboxgl-ctrl-attrib a{color:var(--mute-2)!important}';
    var st = document.createElement('style'); st.id = 'iconic-view-styles'; st.textContent = css; document.head.appendChild(st);
  }

  var IMG_CARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.6" fill="currentColor" stroke="none"/><path d="M21 15l-5-4.5L6 20"/></svg>';
  var IMG_MAP  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 21s-7-7-7-12a7 7 0 0114 0c0 5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5" fill="currentColor"/></svg>';
  var PIN_STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.95 6.55 7.18.75-5.35 4.82 1.55 7.05L12 18l-6.33 3.67 1.55-7.05L1.87 9.8l7.18-.75L12 2.5z"/></svg>';

  // ─── Geocode cache (localStorage) ───────────────────────────────
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveCache(cache) {
    try { localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache)); }
    catch (e) { /* quota — non-fatal */ }
  }

  function geocodeLocation(loc) {
    // Returns a Promise resolving to [lng, lat] or null.
    if (!loc) return Promise.resolve(null);
    var q = String(loc).trim();
    if (!q) return Promise.resolve(null);
    var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
      encodeURIComponent(q) +
      '.json?limit=1&types=place,locality,neighborhood,address,region,district&access_token=' + MAPBOX_TOKEN;
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.features || !j.features.length) return null;
        var c = j.features[0].center;
        if (!Array.isArray(c) || c.length !== 2) return null;
        return [c[0], c[1]];
      })
      .catch(function () { return null; });
  }

  // ─── Mapbox GL loader (deferred until Map view first activated) ──
  var mapboxReady = null;
  function ensureMapbox() {
    if (mapboxReady) return mapboxReady;
    mapboxReady = new Promise(function (resolve, reject) {
      if (window.mapboxgl) return resolve(window.mapboxgl);
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = MAPBOX_GL_CSS;
      document.head.appendChild(link);
      var script = document.createElement('script');
      script.src = MAPBOX_GL_JS; script.async = true;
      script.onload = function () { resolve(window.mapboxgl); };
      script.onerror = function () { reject(new Error('Failed to load Mapbox GL JS')); };
      document.head.appendChild(script);
    });
    return mapboxReady;
  }

  function start() {
    var actions = document.querySelector('.tabs-bar .actions');
    var ranking = document.getElementById('ranking');
    if (!actions || !ranking || document.getElementById('iconicSheet')) return;

    // 3-button toggle
    var tg = document.createElement('div');
    tg.className = 'iv-toggle';
    tg.setAttribute('role', 'tablist');
    tg.innerHTML =
      '<button class="iv-btn on" data-v="card" title="Card view" aria-label="Card view">' + IMG_CARD + '</button>' +
      '<button class="iv-btn" data-v="text" title="List view" aria-label="List view"><span class="iv-t">T</span></button>' +
      '<button class="iv-btn" data-v="map"  title="Map view" aria-label="Map view">' + IMG_MAP + '</button>';
    actions.appendChild(tg);

    // Text sheet
    var sheet = document.createElement('div');
    sheet.id = 'iconicSheet'; sheet.className = 'iv-sheet'; sheet.hidden = true;
    ranking.parentNode.insertBefore(sheet, ranking.nextSibling);

    // Map container — built once, hidden until map view chosen
    var mapWrap = document.createElement('div');
    mapWrap.id = 'iconicMapWrap'; mapWrap.className = 'iv-map-wrap'; mapWrap.hidden = true;
    mapWrap.innerHTML =
      '<div id="iconicMap" class="iv-map"></div>' +
      '<div id="iconicMapStatus" class="iv-map-status hide"><span class="dot"></span><span class="iv-map-status-t">Locating</span></div>';
    sheet.parentNode.insertBefore(mapWrap, sheet.nextSibling);

    var mode = 'card';
    var mapInstance = null;
    var mapMarkers = [];

    function buildSheet() {
      var cards = [].slice.call(ranking.querySelectorAll('.rank-item'));
      var head = '<div class="iv-row iv-head"><span>#</span><span>Name</span><span>Location</span><span>Details</span></div>';
      if (!cards.length) { sheet.innerHTML = head + '<div class="iv-empty">Nothing in this region yet.</div>'; return; }
      var body = cards.map(function (c) {
        function txt(sel) { var e = c.querySelector(sel); return e ? e.textContent.trim() : ''; }
        var arch = txt('.ri-chip.arch').replace(/^[^A-Za-z0-9]+/, '').trim();
        var year = txt('.ri-chip.year').trim();
        var details = [arch, year].filter(Boolean).join('  ·  ');
        var cta = c.querySelector('.btn-cta');
        var href = cta ? (cta.getAttribute('href') || '') : '';
        var name = txt('.ri-name');
        var nm = (href && href !== '#') ? ('<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(name) + '</a>') : esc(name);
        return '<div class="iv-row">' +
          '<span class="iv-rk">' + esc(txt('.ri-rank')) + '</span>' +
          '<span class="iv-nm">' + nm + '</span>' +
          '<span class="iv-lc">' + esc(txt('.ri-loc')) + '</span>' +
          '<span class="iv-dt">' + esc(details) + '</span></div>';
      }).join('');
      sheet.innerHTML = head + body;
    }

    // Extract items from the currently-rendered ranking cards. Stays in
    // sync with sort + region filters — same trick the text view uses.
    function collectItems() {
      var cards = [].slice.call(ranking.querySelectorAll('.rank-item'));
      return cards.map(function (c) {
        function txt(sel) { var e = c.querySelector(sel); return e ? e.textContent.trim() : ''; }
        var cta = c.querySelector('.btn-cta');
        // Pull the hero image straight out of the rendered card — same
        // photo the card view shows, so the popup feels like a preview
        // of where you're about to go.
        var imgEl = c.querySelector('.ri-photo img, .ri-media img');
        var image = imgEl ? (imgEl.currentSrc || imgEl.src || imgEl.getAttribute('data-src') || '') : '';
        return {
          id:       c.getAttribute('data-id') || '',
          rank:     txt('.ri-rank'),
          name:     txt('.ri-name'),
          location: txt('.ri-loc'),
          image:    image,
          href:     cta ? (cta.getAttribute('href') || '') : '',
        };
      }).filter(function (it) { return it.name && it.location; });
    }

    function setStatus(text, hide) {
      var s = document.getElementById('iconicMapStatus');
      if (!s) return;
      s.querySelector('.iv-map-status-t').textContent = text;
      s.classList.toggle('hide', !!hide);
    }

    function clearMarkers() {
      mapMarkers.forEach(function (m) { try { m.remove(); } catch (e) {} });
      mapMarkers = [];
    }

    function pinHtml(rank) {
      return '<div class="iv-pin" title="Open list item">' +
        PIN_STAR_SVG +
        (rank ? '<span class="iv-pin-rank">' + esc(rank) + '</span>' : '') +
        '</div>';
    }

    function popupHtml(it) {
      // Hero photo sits flush to the popup's top + sides (no inner
      // padding — .mapboxgl-popup-content padding is zeroed in CSS).
      // Falls back to a gold-glow placeholder when the card has no
      // photo so the layout stays consistent.
      var hero = it.image
        ? '<img class="iv-pop-img" src="' + esc(it.image) + '" alt="' + esc(it.name) + '" loading="lazy">'
        : '<div class="iv-pop-img-fb">No photo</div>';
      // CTA jumps to the card view + scrolls to the matching .rank-item.
      // data-iv-jump carries the item id so the delegated click handler
      // (bound on the document below) can find the right card.
      var cta = it.id
        ? '<a class="iv-pop-go" href="#item-' + esc(it.id) + '" data-iv-jump="' + esc(it.id) + '">View card →</a>'
        : '';
      return '<div class="iv-pop">' + hero +
        '<div class="iv-pop-body">' +
          (it.rank ? '<div class="iv-pop-rk">Rank ' + esc(it.rank) + '</div>' : '') +
          '<div class="iv-pop-nm">' + esc(it.name) + '</div>' +
          '<div class="iv-pop-lc">' + esc(it.location) + '</div>' +
          cta +
        '</div>' +
        '</div>';
    }

    function plotMarkers(mapboxgl, map, items, coords) {
      clearMarkers();
      var bounds = new mapboxgl.LngLatBounds();
      var placed = 0;
      items.forEach(function (it) {
        var c = coords[it.location];
        if (!Array.isArray(c)) return;
        var el = document.createElement('div');
        el.innerHTML = pinHtml(it.rank);
        var pinNode = el.firstChild;
        var marker = new mapboxgl.Marker({ element: pinNode, anchor: 'bottom' })
          .setLngLat(c)
          .setPopup(new mapboxgl.Popup({ offset: 28, closeButton: true, maxWidth: '280px' }).setHTML(popupHtml(it)))
          .addTo(map);
        mapMarkers.push(marker);
        bounds.extend(c);
        placed++;
      });
      if (placed > 0) {
        map.fitBounds(bounds, { padding: { top: 70, bottom: 60, left: 60, right: 60 }, maxZoom: 9, duration: 700 });
      }
      return placed;
    }

    function activateMap() {
      ensureMapbox().then(function (mapboxgl) {
        mapboxgl.accessToken = MAPBOX_TOKEN;
        if (!mapInstance) {
          mapInstance = new mapboxgl.Map({
            container: 'iconicMap',
            style: MAPBOX_STYLE,
            center: [-30, 30],
            zoom: 1.4,
            attributionControl: { compact: true },
          });
          mapInstance.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
        }
        // Once the style is ready, plot whatever's currently in the
        // ranking. Re-plot every time a user lands on Map view to honor
        // active sort / region filters.
        var run = function () { renderMapMarkers(mapboxgl, mapInstance); };
        if (mapInstance.isStyleLoaded()) run();
        else mapInstance.once('load', run);
      }).catch(function (err) {
        console.warn('[iconic-map] mapbox load failed', err);
        setStatus('Map unavailable', false);
      });
    }

    function renderMapMarkers(mapboxgl, map) {
      var items = collectItems();
      if (!items.length) {
        clearMarkers();
        setStatus('No items in this view', false);
        return;
      }
      var cache = loadCache();
      var missing = items.filter(function (it) { return !Array.isArray(cache[it.location]); });
      // Plot whatever we have cached IMMEDIATELY so the user sees pins
      // dropping right away — uncached items get filled in as their
      // geocoding completes.
      var placed = plotMarkers(mapboxgl, map, items, cache);
      if (missing.length === 0) {
        setStatus(placed + ' pins on the map', true);
        return;
      }
      setStatus('Locating ' + missing.length + ' more…', false);
      var pending = missing.length;
      missing.forEach(function (it) {
        geocodeLocation(it.location).then(function (lnglat) {
          if (lnglat) {
            cache[it.location] = lnglat;
            saveCache(cache);
          }
          pending--;
          if (pending === 0) {
            var total = plotMarkers(mapboxgl, map, items, cache);
            setStatus(total + ' pins on the map', true);
          }
        });
      });
    }

    function setMode(v) {
      if (v === mode) return;
      mode = v;
      var btns = tg.querySelectorAll('.iv-btn');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-v') === v);
      if (v === 'text') {
        buildSheet();
        ranking.style.display = 'none';
        sheet.hidden = false;
        mapWrap.hidden = true;
      } else if (v === 'map') {
        ranking.style.display = 'none';
        sheet.hidden = true;
        mapWrap.hidden = false;
        activateMap();
        // Mapbox can render blank if its container wasn't visible at
        // init time — kick a resize after the layout settles.
        setTimeout(function () { try { mapInstance && mapInstance.resize(); } catch (e) {} }, 60);
      } else {
        sheet.hidden = true;
        mapWrap.hidden = true;
        ranking.style.display = '';
      }
    }

    tg.addEventListener('click', function (e) {
      var b = e.target.closest('.iv-btn'); if (b) setMode(b.getAttribute('data-v'));
    });

    // Delegated handler for "View card →" links in map popups. Mapbox
    // popup elements live OUTSIDE the iconic ranking container, so a
    // listener bound on .iv-pop-go directly wouldn't survive popup
    // re-renders. Delegate at document level instead.
    document.addEventListener('click', function (e) {
      var go = e.target.closest('.iv-pop-go[data-iv-jump]');
      if (!go) return;
      var id = go.getAttribute('data-iv-jump');
      if (!id) return;
      e.preventDefault();
      // Force Card view so the user actually sees the photo card they
      // came from the popup to find.
      setMode('card');
      // Card view's container needs a render tick to become visible
      // again before scrollIntoView fires, otherwise the offset math
      // is computed against the hidden display:none box.
      setTimeout(function () {
        var card = document.querySelector('.rank-item[data-id="' + id + '"]');
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('iv-flash');
        // Reflow so the animation can replay on subsequent clicks.
        void card.offsetWidth;
        card.classList.add('iv-flash');
      }, 60);
    });

    // Keep the sheet AND the map current as the cards re-render
    // (sort change, region filter, edits).
    try {
      new MutationObserver(function () {
        if (mode === 'text') buildSheet();
        else if (mode === 'map' && mapInstance && window.mapboxgl) renderMapMarkers(window.mapboxgl, mapInstance);
      }).observe(ranking, { childList: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
