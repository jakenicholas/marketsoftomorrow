#!/usr/bin/env python3
"""
TMW Project Page Generator
Reads Google Sheet CSV → generates /projects/{slug}/index.html for each project
Run: python3 generate_pages.py
"""

import csv, io, os, re, json, urllib.request, sys

SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1qwU7ykIDUrtPlIQu-qk2FIJwiz-WWg5caq02ja30sgM/export?format=csv&gid=0"
OUTPUT_DIR = "projects"
SITE_URL = "https://map.oftmw.com"
DEFAULT_IMAGE = "https://static.wixstatic.com/media/ca3b83_93ffb2f000f94a12aa874fe44153be18~mv2.jpg"
# SVG wordmark — same logo used in main map header
LOGO_URL = "https://static.wixstatic.com/shapes/ca3b83_a647b53cad4c49c5b012af991d286a86.svg"
FAVICON_URL = "https://static.wixstatic.com/media/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png"

# Mapbox config — same token + style as main map
MAPBOX_TOKEN = "pk.eyJ1IjoiZmxvcmlkYW9mdG9tb3Jyb3ciLCJhIjoiY2xrYmpmdGQ2MGdibTNzcXZjMnA4aXh3ZiJ9.uBeYS7jmKwWS6xAgY-R1UA"
MAPBOX_STYLE = "floridaoftomorrow/clkbk4qlw000a01qw94rj0xa7"

def slugify(title):
    s = title.lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s-]+', '-', s).strip('-')
    return s

def map_slug(title):
    """Slug for map deep-link param (no hyphens, matches JS logic)"""
    return re.sub(r'[^a-z0-9]', '', title.lower())

def delivery_info(delivery):
    d = delivery.lower().strip()
    stages = [
        ('announced',         'Announced',       10,  '#999999'),
        ('breaking ground',   'Breaking Ground', 30,  '#FFD300'),
        ('under construction','Construction',    60,  '#FF9500'),
        ('opening soon',      'Opening Soon',    85,  '#1FDF67'),
        ('now open',          'Now Open',        100, '#1FDF67'),
    ]
    for key, label, pct, color in stages:
        if key in d:
            return label, pct, color
    return 'Announced', 10, '#999999'

def progress_bar_html(delivery):
    stage_label, pct, color = delivery_info(delivery)
    stage_labels = ['Announced', 'Breaking Ground', 'Construction', 'Opening Soon', 'Now Open']
    stage_keys   = ['announced', 'breaking ground', 'under construction', 'opening soon', 'now open']
    d = delivery.lower()
    active_idx = 0
    for i, key in enumerate(stage_keys):
        if key in d:
            active_idx = i
            break

    steps_html = ''
    for i, lbl in enumerate(stage_labels):
        if i < active_idx:
            cls = 'done'
        elif i == active_idx:
            cls = 'active'
        else:
            cls = 'future'
        steps_html += f'<div class="ps-step ps-{cls}" style="--sc:{color}"></div>'

    labels_html = ''
    for i, lbl in enumerate(stage_labels):
        cur = ' ps-cur' if i == active_idx else ''
        style = f'style="color:{color}"' if i == active_idx else ''
        labels_html += f'<span class="ps-label{cur}" {style}>{lbl}</span>'

    return f'''
    <div class="ps-wrap">
      <div class="ps-top">
        <span class="ps-stage" style="color:{color}">{stage_label}</span>
        <span class="ps-pct">{pct}%</span>
      </div>
      <div class="ps-steps">{steps_html}</div>
      <div class="ps-labels">{labels_html}</div>
    </div>'''

def gallery_html(row):
    imgs = [row.get('ImageURL',''), row.get('Image2',''), row.get('Image3',''),
            row.get('Image4',''), row.get('Image5','')]
    imgs = [i.strip() for i in imgs if i and i.strip()]
    if not imgs:
        return ''

    # Single image: no arrows, no counter
    if len(imgs) == 1:
        return f'''
    <div class="gallery">
      <div class="gallery-stage">
        <img class="gallery-img" src="{imgs[0]}" alt="" loading="eager" />
      </div>
    </div>'''

    # Multiple images: slider with arrow buttons + counter
    # JSON array of image URLs is read by client-side JS
    imgs_json = json.dumps(imgs)
    return f'''
    <div class="gallery" data-images='{imgs_json}'>
      <div class="gallery-stage">
        <img class="gallery-img" src="{imgs[0]}" alt="" loading="eager" />
        <button class="gallery-arrow gallery-arrow-prev" type="button" aria-label="Previous image">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <button class="gallery-arrow gallery-arrow-next" type="button" aria-label="Next image">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
        <div class="gallery-counter"><span class="gallery-counter-cur">1</span> / {len(imgs)}</div>
      </div>
    </div>'''

def stat_card(label, value):
    if not value or not value.strip():
        return ''
    return f'''<div class="stat-card">
      <div class="stat-label">{label}</div>
      <div class="stat-val">{value.strip()}</div>
    </div>'''

def truncate_developer(dev):
    if not dev:
        return ''
    parts = re.split(r'\s*/\s*', dev)
    if len(parts) > 2:
        return parts[0].strip() + ' & More'
    return dev

def map_preview_html(lat, lng, map_url):
    """Render a clickable static Mapbox preview for the project location."""
    if not lat or not lng:
        return ''
    try:
        latf = float(lat)
        lngf = float(lng)
    except (ValueError, TypeError):
        return ''

    # Static Mapbox image — green pin (#1FDF67) at project location, zoom 14
    # 2x for retina, 600x300 displayed at 100% width
    style_path = MAPBOX_STYLE  # username/styleid
    static_url = (
        f"https://api.mapbox.com/styles/v1/{style_path}/static/"
        f"pin-l+1fdf67({lngf},{latf})/"
        f"{lngf},{latf},14,0/600x300@2x"
        f"?access_token={MAPBOX_TOKEN}&attribution=false&logo=false"
    )

    return f'''
    <a class="map-preview" href="{map_url}" aria-label="View on Map of Tomorrow">
      <img src="{static_url}" alt="Project location map" loading="lazy" />
      <div class="map-preview-overlay">
        <span class="map-preview-cta">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
          View on Map of Tomorrow
        </span>
      </div>
    </a>'''

def build_page(row):
    title = row.get('Title','').strip()
    city  = row.get('City','').strip()
    proj_type = row.get('ProjectType','').strip().split(',')[0].strip()
    delivery  = row.get('Delivery','').strip()
    delivery_date = row.get('DeliveryDate','').strip()
    developer = truncate_developer(row.get('Developer','').strip())
    architect = row.get('Architect','').strip().split('/')[0].strip()
    description = row.get('DescriptionLong','').strip() or row.get('Description','').strip()
    image = row.get('ImageURL','').strip() or DEFAULT_IMAGE
    website = row.get('OfficialWebsite','').strip()
    featured = row.get('Featured','').strip().lower() == 'featured'
    lat = row.get('Latitude','').strip()
    lng = row.get('Longitude','').strip()

    slug     = slugify(title)
    mslug    = map_slug(title)
    page_url = f"{SITE_URL}/projects/{slug}/"
    # Goes to the map zoomed to the pin with the small popup preview
    # (no fullscreen=true → no full project modal)
    map_url  = f"{SITE_URL}/?project={mslug}"

    seo_title = f"{title}, {city} | Markets of Tomorrow"
    seo_desc  = description[:200].rstrip() + ('…' if len(description) > 200 else '')

    # Pills (featured only — project type pill removed per design update)
    pills = ''
    if featured:
        pills += '<span class="pill pill-featured">★ Featured</span>'

    # Stats
    stats = ''
    stats += stat_card('Developer', developer)
    stats += stat_card('Architect', architect)
    stats += stat_card('Delivery', delivery_date or delivery)
    stats += stat_card('Market', city)
    stats_section = f'<div class="stats-grid">{stats}</div>' if stats.strip() else ''

    # Mini map preview (above CTAs)
    map_preview = map_preview_html(lat, lng, map_url)

    # Website button
    if website:
        website_btn = f'<a class="btn-primary" href="{website}" target="_blank" rel="noopener">Official Website <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>'
    else:
        website_btn = '<span class="btn-primary btn-disabled">No Website Listed</span>'

    # JSON-LD structured data
    jsonld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Place",
        "name": title,
        "description": seo_desc,
        "image": image,
        "url": page_url,
        "address": { "@type": "PostalAddress", "addressLocality": city },
        "additionalProperty": [
            {"@type": "PropertyValue", "name": "Status", "value": delivery},
            {"@type": "PropertyValue", "name": "Developer", "value": developer},
            {"@type": "PropertyValue", "name": "Architect", "value": architect},
        ]
    }, indent=2)

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>{seo_title}</title>
  <meta name="description" content="{seo_desc}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="{page_url}">

  <!-- Open Graph -->
  <meta property="og:site_name" content="Markets of Tomorrow">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{seo_title}">
  <meta property="og:description" content="{seo_desc}">
  <meta property="og:image" content="{image}">
  <meta property="og:url" content="{page_url}">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@floridaoftomorrow">
  <meta name="twitter:title" content="{seo_title}">
  <meta name="twitter:description" content="{seo_desc}">
  <meta name="twitter:image" content="{image}">

  <!-- Favicon -->
  <link rel="icon" href="{FAVICON_URL}" type="image/png">

  <!-- JSON-LD -->
  <script type="application/ld+json">{jsonld}</script>

  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    html, body {{ overflow-x: hidden; max-width: 100vw; }}
    body {{ background: #0d0d0d; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; -webkit-text-size-adjust: 100%; }}

    /* Header — transparent, no background, logo only */
    .site-header {{
      position: fixed;
      top: 0; left: 0; right: 0;
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px;
      padding-top: calc(16px + env(safe-area-inset-top));
      padding-left: calc(20px + env(safe-area-inset-left));
      padding-right: calc(20px + env(safe-area-inset-right));
      z-index: 10;
      pointer-events: none; /* let map/scroll through, only logo+button receive */
    }}
    .site-logo, .header-map-btn {{ pointer-events: auto; }}

    /* Logo — bigger, no bg, drop shadow for visibility on light hero images */
    .site-logo {{ display: flex; align-items: center; text-decoration: none; }}
    .site-logo img {{
      height: 48px; width: auto; display: block;
      filter: brightness(0) invert(1) drop-shadow(0 2px 8px rgba(0,0,0,0.6));
    }}

    /* Header map button — glass pill */
    .header-map-btn {{
      display: flex; align-items: center; gap: 7px;
      background: rgba(15,15,15,0.55);
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      padding: 9px 14px;
      color: rgba(255,255,255,0.92);
      text-decoration: none;
      font-size: 13px; font-weight: 500;
      transition: background 0.15s;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }}
    .header-map-btn:hover {{ background: rgba(30,30,30,0.7); }}
    .header-map-btn svg {{ opacity: 0.85; }}

    /* Gallery — single image or arrow-cycling slider */
    .gallery {{ width: 100%; max-width: 100vw; overflow: hidden; }}
    .gallery-stage {{
      position: relative;
      width: 100%;
      height: 60vh;
      max-height: 520px;
      background: #1a1a1a;
      overflow: hidden;
    }}
    .gallery-img {{
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
      transition: opacity 0.25s ease;
    }}
    .gallery-img.is-fading {{ opacity: 0; }}

    /* Arrow buttons — white, glassy, only visible when multi-image */
    .gallery-arrow {{
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 44px; height: 44px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.35);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 50%;
      color: #fff;
      cursor: pointer;
      padding: 0;
      transition: background 0.15s, transform 0.1s;
      z-index: 2;
    }}
    .gallery-arrow:hover {{ background: rgba(0,0,0,0.55); }}
    .gallery-arrow:active {{ transform: translateY(-50%) scale(0.92); }}
    .gallery-arrow-prev {{ left: 14px; }}
    .gallery-arrow-next {{ right: 14px; }}

    /* Counter pill */
    .gallery-counter {{
      position: absolute;
      bottom: 14px;
      right: 14px;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      padding: 5px 10px;
      border-radius: 20px;
      pointer-events: none;
      z-index: 2;
    }}

    /* Content */
    .content {{
      max-width: 560px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 20px 40px;
      padding-left: max(20px, env(safe-area-inset-left));
      padding-right: max(20px, env(safe-area-inset-right));
    }}

    /* Pills */
    .pills {{ display: flex; gap: 6px; margin-bottom: 12px; }}
    .pill {{ font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 9px; border-radius: 20px; }}
    .pill-featured {{ background: #FFD300; color: #000; }}

    /* Title */
    .project-title {{ font-size: 28px; font-weight: 700; line-height: 1.15; margin-bottom: 4px; word-wrap: break-word; overflow-wrap: break-word; }}
    .project-city {{ font-size: 13px; color: rgba(255,255,255,0.45); margin-bottom: 16px; }}

    /* Progress */
    .ps-wrap {{ margin-bottom: 16px; }}
    .ps-top {{ display: flex; justify-content: space-between; margin-bottom: 6px; }}
    .ps-stage {{ font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }}
    .ps-pct {{ font-size: 10px; color: rgba(255,255,255,0.25); }}
    .ps-steps {{ display: flex; gap: 3px; margin-bottom: 5px; }}
    .ps-step {{ flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.08); min-width: 0; }}
    .ps-done {{ background: var(--sc); }}
    .ps-active {{ background: var(--sc); opacity: 0.5; }}
    .ps-labels {{ display: flex; justify-content: space-between; gap: 4px; }}
    .ps-label {{ font-size: 7px; color: rgba(255,255,255,0.2); flex: 1; text-align: center; min-width: 0; }}
    .ps-label:first-child {{ text-align: left; }}
    .ps-label:last-child {{ text-align: right; }}
    .ps-cur {{ color: var(--sc, #FF9500); }}

    /* Divider */
    .divider {{ height: 0.5px; background: rgba(255,255,255,0.07); margin: 16px 0; }}

    /* Description */
    .description {{ font-size: 14px; color: rgba(255,255,255,0.6); line-height: 1.7; margin-bottom: 16px; word-wrap: break-word; overflow-wrap: break-word; }}

    /* Stats — fits within viewport, wraps long values */
    .stats-grid {{
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 20px;
    }}
    .stat-card {{
      background: rgba(255,255,255,0.04);
      border-radius: 8px;
      padding: 10px 12px;
      min-width: 0; /* allow content to shrink */
      overflow: hidden;
    }}
    .stat-label {{ font-size: 8px; color: rgba(255,255,255,0.28); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }}
    .stat-val {{
      font-size: 13px;
      color: #fff;
      font-weight: 500;
      line-height: 1.3;
      word-wrap: break-word;
      overflow-wrap: break-word;
      hyphens: auto;
    }}

    /* Mini map preview */
    .map-preview {{
      display: block;
      position: relative;
      width: 100%;
      height: 180px;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 12px;
      text-decoration: none;
      background: rgba(255,255,255,0.04);
      border: 0.5px solid rgba(255,255,255,0.08);
      transition: transform 0.15s, border-color 0.15s;
    }}
    .map-preview:hover {{ transform: translateY(-1px); border-color: rgba(31,223,103,0.35); }}
    .map-preview img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
    .map-preview-overlay {{
      position: absolute;
      inset: 0;
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
      padding: 12px;
      background: linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 50%);
      pointer-events: none;
    }}
    .map-preview-cta {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(15,15,15,0.7);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 0.5px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      padding: 7px 11px;
      font-size: 12px;
      font-weight: 600;
      color: #fff;
    }}
    .map-preview-cta svg {{ opacity: 0.85; }}

    /* CTA */
    .cta-row {{ display: flex; gap: 10px; align-items: stretch; margin-bottom: 12px; }}
    .btn-primary {{
      flex: 1;
      background: #1FDF67; color: #000; border: none; border-radius: 10px;
      padding: 13px 16px;
      font-size: 14px; font-weight: 700; cursor: pointer; text-decoration: none;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      min-width: 0; /* allow shrinking */
    }}
    .btn-primary:hover {{ background: #18c75a; }}
    .btn-disabled {{ background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.3); cursor: default; }}

    @media (max-width: 480px) {{
      .gallery-stage {{ height: 50vh; max-height: 360px; }}
      .gallery-arrow {{ width: 38px; height: 38px; }}
      .gallery-arrow-prev {{ left: 10px; }}
      .gallery-arrow-next {{ right: 10px; }}
      .gallery-counter {{ bottom: 10px; right: 10px; font-size: 11px; padding: 4px 9px; }}
      .project-title {{ font-size: 24px; }}
      .map-preview {{ height: 160px; }}
      .site-logo img {{ height: 42px; }}
      .header-map-btn {{ font-size: 12px; padding: 8px 12px; }}
    }}
  </style>
</head>
<body>

  <header class="site-header">
    <a class="site-logo" href="{SITE_URL}" aria-label="Markets of Tomorrow home">
      <img src="{LOGO_URL}" alt="Markets of Tomorrow" />
    </a>
    <a class="header-map-btn" href="{map_url}">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
      View on Map
    </a>
  </header>

  {gallery_html(row)}

  <div class="content">
    <div class="pills">{pills}</div>
    <h1 class="project-title">{title}</h1>
    <p class="project-city">{city}{' • ' + proj_type if proj_type else ''}</p>
    {progress_bar_html(delivery)}
    <div class="divider"></div>
    <p class="description">{description}</p>
    <div class="divider"></div>
    {stats_section}
    {map_preview}
    <div class="cta-row">
      {website_btn}
    </div>
  </div>

  <script>
    // ── Gallery slider ───────────────────────────────────────────────
    (function() {{
      var gallery = document.querySelector('.gallery[data-images]');
      if (!gallery) return;
      var images;
      try {{ images = JSON.parse(gallery.getAttribute('data-images')); }} catch (e) {{ return; }}
      if (!images || images.length < 2) return;

      var img = gallery.querySelector('.gallery-img');
      var counterCur = gallery.querySelector('.gallery-counter-cur');
      var prevBtn = gallery.querySelector('.gallery-arrow-prev');
      var nextBtn = gallery.querySelector('.gallery-arrow-next');
      var idx = 0;

      // Preload all images so cycling feels instant
      images.forEach(function(src) {{ var i = new Image(); i.src = src; }});

      function goTo(newIdx) {{
        // Wrap around in both directions
        idx = ((newIdx % images.length) + images.length) % images.length;
        img.classList.add('is-fading');
        setTimeout(function() {{
          img.src = images[idx];
          if (counterCur) counterCur.textContent = String(idx + 1);
          // Force reflow then fade back in
          requestAnimationFrame(function() {{ img.classList.remove('is-fading'); }});
        }}, 120);
      }}

      prevBtn.addEventListener('click', function() {{ goTo(idx - 1); }});
      nextBtn.addEventListener('click', function() {{ goTo(idx + 1); }});

      // Keyboard: left/right arrows
      document.addEventListener('keydown', function(e) {{
        if (e.key === 'ArrowLeft') goTo(idx - 1);
        else if (e.key === 'ArrowRight') goTo(idx + 1);
      }});

      // Touch swipe
      var touchStartX = null;
      img.addEventListener('touchstart', function(e) {{
        touchStartX = e.touches[0].clientX;
      }}, {{ passive: true }});
      img.addEventListener('touchend', function(e) {{
        if (touchStartX === null) return;
        var dx = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(dx) > 40) goTo(idx + (dx < 0 ? 1 : -1));
        touchStartX = null;
      }}, {{ passive: true }});
    }})();

    // ── iOS browser-chrome reset on map navigation ───────────────────
    // iOS Safari/Chrome can end up with the URL bar stuck in a half-collapsed
    // state after scrolling. When the user taps a "View on Map" link, scroll
    // back to the top first so the next page loads with clean browser chrome.
    (function() {{
      var mapLinks = document.querySelectorAll('a[href*="/?project="]');
      mapLinks.forEach(function(link) {{
        link.addEventListener('click', function(e) {{
          // Only on touch devices where the issue actually occurs
          if (!('ontouchstart' in window)) return;
          // If user is at the top, just let the navigation happen normally
          if (window.scrollY < 10) return;
          // Otherwise, prevent default, scroll to top, then navigate
          e.preventDefault();
          var href = this.href;
          window.scrollTo({{ top: 0, behavior: 'instant' }});
          // Tiny delay so iOS settles before navigating
          setTimeout(function() {{ window.location.href = href; }}, 30);
        }});
      }});
    }})();
  </script>

</body>
</html>'''
    return html, slug

def main():
    print("Fetching sheet data...")
    try:
        req = urllib.request.Request(SHEET_CSV_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read().decode('utf-8')
        print("  ✓ Fetched from Google Sheets")
    except Exception as e:
        print(f"  ✗ Could not fetch sheet: {e}")
        print("  Trying local cache...")
        try:
            with open('projects_latest.csv') as f:
                content = f.read()
            print("  ✓ Using local cache")
        except:
            print("  ✗ No local cache found. Exiting.")
            sys.exit(1)

    rows = list(csv.DictReader(io.StringIO(content)))
    rows = [r for r in rows if r.get('Title','').strip()]
    print(f"  {len(rows)} projects found")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Generate index page
    index_items = []
    generated = 0
    skipped = 0

    for row in rows:
        title = row.get('Title','').strip()
        if not title:
            continue
        try:
            html, slug = build_page(row)
            page_dir = os.path.join(OUTPUT_DIR, slug)
            os.makedirs(page_dir, exist_ok=True)
            with open(os.path.join(page_dir, 'index.html'), 'w', encoding='utf-8') as f:
                f.write(html)
            generated += 1
            index_items.append((slug, title, row.get('City',''), row.get('Delivery',''), row.get('ImageURL','')))
        except Exception as e:
            print(f"  ✗ Error on '{title}': {e}")
            skipped += 1

    # Generate /projects/index.html
    build_index(index_items)

    print(f"\n✅ Done! Generated {generated} pages, skipped {skipped}")
    print(f"   Output: ./{OUTPUT_DIR}/")

def build_index(items):
    cards = ''
    for slug, title, city, delivery, image in items:
        stage, pct, color = delivery_info(delivery)
        img = image or DEFAULT_IMAGE
        cards += f'''
    <a class="card" href="./{slug}/">
      <div class="card-img" style="background-image:url('{img}')"></div>
      <div class="card-body">
        <div class="card-title">{title}</div>
        <div class="card-city">{city}</div>
        <div class="card-status" style="color:{color}">{stage}</div>
      </div>
    </a>'''

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>All Projects | Markets of Tomorrow</title>
  <meta name="description" content="Browse all {len(items)} projects tracked on the Map of Tomorrow — luxury real estate, hotels, stadiums, and more from Markets of Tomorrow.">
  <meta property="og:title" content="All Projects | Markets of Tomorrow">
  <meta property="og:description" content="Browse {len(items)} future developments on the Map of Tomorrow.">
  <meta property="og:image" content="{DEFAULT_IMAGE}">
  <link rel="icon" href="{FAVICON_URL}" type="image/png">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    html, body {{ overflow-x: hidden; max-width: 100vw; }}
    body {{ background: #0d0d0d; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }}
    .site-header {{
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px;
      padding-top: calc(16px + env(safe-area-inset-top));
      border-bottom: 0.5px solid rgba(255,255,255,0.08);
      position: sticky; top: 0;
      background: rgba(13,13,13,0.92); backdrop-filter: blur(12px); z-index: 10;
    }}
    .site-logo img {{ height: 42px; width: auto; display: block; filter: brightness(0) invert(1); }}
    .header-map-btn {{
      display: flex; align-items: center; gap: 7px;
      background: rgba(255,255,255,0.07); border: 0.5px solid rgba(255,255,255,0.15);
      border-radius: 8px; padding: 8px 14px;
      color: rgba(255,255,255,0.8); text-decoration: none;
      font-size: 13px; font-weight: 500;
    }}
    .page-header {{ padding: 32px 20px 20px; max-width: 1200px; margin: 0 auto; }}
    .page-header h1 {{ font-size: 28px; font-weight: 700; margin-bottom: 6px; }}
    .page-header p {{ color: rgba(255,255,255,0.45); font-size: 14px; }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 12px;
      padding: 0 20px 40px;
      max-width: 1200px;
      margin: 0 auto;
    }}
    .card {{ text-decoration: none; color: #fff; background: #111; border-radius: 12px; overflow: hidden; transition: transform 0.15s; min-width: 0; }}
    .card:hover {{ transform: translateY(-2px); }}
    .card-img {{ height: 160px; background-size: cover; background-position: center; }}
    .card-body {{ padding: 12px; }}
    .card-title {{ font-size: 14px; font-weight: 600; margin-bottom: 3px; word-wrap: break-word; }}
    .card-city {{ font-size: 12px; color: rgba(255,255,255,0.4); margin-bottom: 5px; }}
    .card-status {{ font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }}
    @media (max-width: 480px) {{
      .grid {{ grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; padding: 0 14px 40px; }}
      .card-img {{ height: 120px; }}
      .site-logo img {{ height: 36px; }}
    }}
  </style>
</head>
<body>
  <header class="site-header">
    <a class="site-logo" href="{SITE_URL}"><img src="{LOGO_URL}" alt="Markets of Tomorrow" /></a>
    <a class="header-map-btn" href="{SITE_URL}">← View Map</a>
  </header>
  <div class="page-header">
    <h1>All Projects</h1>
    <p>{len(items)} developments tracked on the Map of Tomorrow</p>
  </div>
  <div class="grid">{cards}</div>
</body>
</html>'''

    with open(os.path.join(OUTPUT_DIR, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"  ✓ Index page: ./{OUTPUT_DIR}/index.html")

if __name__ == '__main__':
    main()
