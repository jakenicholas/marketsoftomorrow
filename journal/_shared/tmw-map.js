/* ───────────────────────────────────────────────────────────────────────────
   TMW MAP COMPONENT — the map as an organ, not a page.

   /map/index.html is 1.36MB, and its Mapbox core is roughly 5% of that; the
   rest is that page's furniture (sidebar, paywall, compare, scrubber). This
   file is the core alone, extracted so OTHER surfaces can mount a real,
   filterable TMW map in a container div. The Atlas overview is the first
   host; /map/ itself should adopt this component next, so there is exactly
   ONE pin-rendering implementation — two would drift, and we have already
   paid for that class of bug once (three surfaces, three type semantics,
   151 of 911 rows silently dropped).

   Everything visual is copied from /map/, not invented:
     · style  mapbox://styles/floridaoftomorrow/clkbk4qlw000a01qw94rj0xa7
     · status colours   = window.TMW_STATUS_COLOR's mapping (map:13407)
     · cluster stack    = green #1FDF67, step radii 20/30/40 @ 100/750 (map:19721)
     · pin layer        = zoom-interpolated 2.5→4.5 radius, 0→2 white stroke
     · glow layer       = z≥8 blur halo
   GL version pinned to the same v2.14.1 the map page ships.

   USAGE
     tmwMap.mount(el, {
       rows,                    // projects-flat rows (the FULL set)
       visible(i) -> bool,      // which indexes are currently in the filter
       onProjectClick(i),       // click-through (host opens its drawer)
     }).then(handle => {
       handle.refresh()         // re-read visible() after a filter change
       handle.setHighlight(setOfIdx | null)   // brush-and-link overlay
       handle.resize()          // after a container move/reveal
       handle.supported         // false → host should render its fallback
     })

   Loads mapbox-gl lazily on first mount (script + css injected once), so a
   page that never shows the map never pays for it. If WebGL is unavailable
   the promise resolves with {supported:false} and mounts nothing — the host
   decides its fallback (the Atlas uses its SVG world scatter).
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.tmwMap) return;

  var GL_JS  = 'https://api.mapbox.com/mapbox-gl-js/v2.14.1/mapbox-gl.js';
  var GL_CSS = 'https://api.mapbox.com/mapbox-gl-js/v2.14.1/mapbox-gl.css';
  var TOKEN  = 'pk.eyJ1IjoiZmxvcmlkYW9mdG9tb3Jyb3ciLCJhIjoiY2xrYmpmdGQ2MGdibTNzcXZjMnA4aXh3ZiJ9.uBeYS7jmKwWS6xAgY-R1UA';
  var STYLE  = 'mapbox://styles/floridaoftomorrow/clkbk4qlw000a01qw94rj0xa7';

  // The map page's canonical status → colour mapping, verbatim.
  var STATUS_COLOR = ['match', ['get', 'delivery'],
    'Announced',          '#FFD300',
    'Breaking Ground',    '#3FA9F5',
    'Under Construction', '#3FA9F5',
    'Opening Soon',       '#1FDF67',
    'Now Open',           '#1FDF67',
    /* other */           '#A78BFA'];
  var HL_COLOR = '#7DF0C8';   // brush-and-link mint (validated in the Atlas palette)

  var _loader = null;
  function loadGL() {
    if (window.mapboxgl) return Promise.resolve(true);
    if (_loader) return _loader;
    _loader = new Promise(function (res) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = GL_CSS;
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = GL_JS;
      s.onload = function () { res(true); };
      s.onerror = function () { res(false); };
      document.head.appendChild(s);
    });
    return _loader;
  }

  function toFeature(r, i) {
    var la = parseFloat(r.Latitude), lo = parseFloat(r.Longitude);
    if (!isFinite(la) || !isFinite(lo)) return null;
    return {
      type: 'Feature', id: i,
      geometry: { type: 'Point', coordinates: [lo, la] },
      properties: {
        i: i,
        title: String(r.Title || ''),
        city: String(r.City || ''),
        delivery: String(r.Delivery || ''),
        img: String(r.ImageURL || ''),
        slug: String(r.Slug || '')
      }
    };
  }

  function mount(el, opts) {
    opts = opts || {};
    return loadGL().then(function (ok) {
      if (!ok || !window.mapboxgl || !window.mapboxgl.supported || !window.mapboxgl.supported()) {
        return { supported: false, refresh: function () {}, setHighlight: function () {},
                 resize: function () {}, destroy: function () {} };
      }
      mapboxgl.accessToken = TOKEN;
      var rows = opts.rows || [];
      var feats = rows.map(toFeature).filter(Boolean);
      var visible = opts.visible || function () { return true; };

      var map = new mapboxgl.Map({
        container: el,
        style: STYLE,
        center: [-40, 28],       // Atlantic overview: US + Europe + Gulf in frame
        zoom: 1.7,
        attributionControl: false,
        cooperativeGestures: true   // scroll the PAGE, not the map, unless ⌘/ctrl
      });
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
      map.addControl(new mapboxgl.AttributionControl({ compact: true }));

      function visibleData() {
        return { type: 'FeatureCollection',
                 features: feats.filter(function (f) { return visible(f.properties.i); }) };
      }

      var popup = null;
      var ready = new Promise(function (res) {
        map.on('load', function () {
          map.addSource('projects', { type: 'geojson', data: visibleData(),
            cluster: true, clusterMaxZoom: 13, clusterRadius: 46 });
          map.addSource('hl', { type: 'geojson',
            data: { type: 'FeatureCollection', features: [] } });

          // — the /map/ layer stack, verbatim paint —
          map.addLayer({ id: 'clusters', type: 'circle', source: 'projects',
            filter: ['has', 'point_count'],
            paint: { 'circle-color': '#1FDF67',
              'circle-radius': ['step', ['get', 'point_count'], 20, 100, 30, 750, 40],
              'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
          map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'projects',
            filter: ['has', 'point_count'],
            layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 12,
              'text-allow-overlap': true, 'text-ignore-placement': true },
            paint: { 'text-color': '#ffffff' } });
          map.addLayer({ id: 'unclustered-glow', type: 'circle', source: 'projects',
            filter: ['!', ['has', 'point_count']], minzoom: 8,
            paint: { 'circle-color': STATUS_COLOR, 'circle-blur': 1,
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 11, 12, 14, 18],
              'circle-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0, 11, 0.42] } });
          map.addLayer({ id: 'unclustered-point', type: 'circle', source: 'projects',
            filter: ['!', ['has', 'point_count']],
            paint: { 'circle-color': STATUS_COLOR,
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 8, 4.5],
              'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 0, 8, 2],
              'circle-stroke-color': '#fff' } });
          // brush-and-link ring, above everything
          map.addLayer({ id: 'hl-ring', type: 'circle', source: 'hl',
            paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 7,
              'circle-stroke-width': 2.5, 'circle-stroke-color': HL_COLOR } });

          // cluster click → zoom in one step
          map.on('click', 'clusters', function (e) {
            var f = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
            map.getSource('projects').getClusterExpansionZoom(
              f.properties.cluster_id, function (err, z) {
                if (err) return;
                map.easeTo({ center: f.geometry.coordinates, zoom: z });
              });
          });
          // pin click → the small in-map popup; Details hands off to the host
          map.on('click', 'unclustered-point', function (e) {
            var f = e.features[0], p = f.properties;
            if (popup) popup.remove();
            var root = document.createElement('div');
            root.className = 'tmwmap-pop';
            if (p.img) { var im = document.createElement('img'); im.src = p.img; im.alt = ''; root.appendChild(im); }
            var t = document.createElement('div'); t.className = 'pt'; t.textContent = p.title; root.appendChild(t);
            var st = document.createElement('div'); st.className = 'ps'; st.textContent = (p.city ? p.city + ' · ' : '') + p.delivery; root.appendChild(st);
            var b = document.createElement('button'); b.className = 'pb'; b.type = 'button'; b.textContent = 'Details →';
            b.addEventListener('click', function () {
              if (popup) popup.remove();
              if (opts.onProjectClick) opts.onProjectClick(+p.i);
            });
            root.appendChild(b);
            popup = new mapboxgl.Popup({ offset: 12, closeButton: true, maxWidth: '250px' })
              .setLngLat(f.geometry.coordinates).setDOMContent(root).addTo(map);
          });
          map.on('mouseenter', 'unclustered-point', function () { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', 'unclustered-point', function () { map.getCanvas().style.cursor = ''; });
          map.on('mouseenter', 'clusters', function () { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', 'clusters', function () { map.getCanvas().style.cursor = ''; });
          res();
        });
      });

      // popup styling, injected once
      if (!document.getElementById('tmwmap-css')) {
        var st = document.createElement('style');
        st.id = 'tmwmap-css';
        st.textContent =
          '.mapboxgl-popup-content{background:#141416;border:1px solid rgba(255,255,255,.16);border-radius:12px;' +
            'padding:0;overflow:hidden;box-shadow:0 18px 44px -12px rgba(0,0,0,.9);font-family:Inter,-apple-system,sans-serif}' +
          '.mapboxgl-popup-tip{border-top-color:#141416!important;border-bottom-color:#141416!important}' +
          '.mapboxgl-popup-close-button{color:#9AA39C;font-size:15px;right:4px;top:2px}' +
          '.tmwmap-pop{width:230px}' +
          '.tmwmap-pop img{width:100%;height:110px;object-fit:cover;display:block}' +
          '.tmwmap-pop .pt{font-weight:600;font-size:13.5px;color:#fff;padding:10px 12px 0;line-height:1.3}' +
          '.tmwmap-pop .ps{font-family:"JetBrains Mono",monospace;font-size:9.5px;letter-spacing:.07em;' +
            'text-transform:uppercase;color:#9AA39C;padding:5px 12px 0}' +
          '.tmwmap-pop .pb{margin:10px 12px 12px;background:#8f6ff0;color:#12091f;border:0;border-radius:999px;' +
            'padding:7px 13px;font:700 10px "JetBrains Mono",monospace;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}';
        document.head.appendChild(st);
      }

      return {
        supported: true,
        map: map,
        refresh: function () {
          ready.then(function () { map.getSource('projects').setData(visibleData()); });
        },
        setHighlight: function (idxSet) {
          ready.then(function () {
            var fs = [];
            if (idxSet && idxSet.size && idxSet.size <= 400) {
              feats.forEach(function (f) { if (idxSet.has(f.properties.i)) fs.push(f); });
            }
            map.getSource('hl').setData({ type: 'FeatureCollection', features: fs });
          });
        },
        resize: function () { try { map.resize(); } catch (e) {} },
        // how many pins the CURRENT visible() admits — staging verification
        debugCount: function () { return visibleData().features.length; },
        destroy: function () { try { map.remove(); } catch (e) {} }
      };
    });
  }

  window.tmwMap = { mount: mount };
})();
