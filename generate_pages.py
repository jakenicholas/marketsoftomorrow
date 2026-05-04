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
LOGO_URL = "https://static.wixstatic.com/media/ca3b83_71f3cd2ef61049028b2daf4e2ff71d52~mv2.png"

# Mapbox static image config — used for the mini map preview at bottom of project pages
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

    # Single image — no slider chrome, just the image
    if len(imgs) == 1:
        return f'''
    <div class="gallery">
      <img class="gallery-hero" src="{imgs[0]}" alt="" loading="eager" />
    </div>'''

    # Multiple images — arrow-cycling slider
    slides = ''.join(
        f'<img class="gs-slide{ " active" if i == 0 else ""}" src="{u}" alt="" '
        f'loading="{"eager" if i == 0 else "lazy"}" data-i="{i}" />'
        for i, u in enumerate(imgs)
    )
    return f'''
    <div class="gallery gs-slider" data-count="{len(imgs)}">
      <div class="gs-track">{slides}</div>
      <button class="gs-arrow gs-prev" aria-label="Previous image">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <button class="gs-arrow gs-next" aria-label="Next image">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
      <div class="gs-counter"><span class="gs-cur">1</span> / {len(imgs)}</div>
    </div>'''

def map_preview_html(lat, lng, map_url):
    """Generate a clickable Mapbox static image preview with a green pin at the project location."""
    if not lat or not lng:
        return ''
    try:
        flat, flng = float(lat), float(lng)
    except (TypeError, ValueError):
        return ''
    # Mapbox Static Image API URL — green pin at coords, zoom 14, 720x320 retina
    img_url = (
        f"https://api.mapbox.com/styles/v1/{MAPBOX_STYLE}/static/"
        f"pin-l+1FDF67({flng},{flat})/"
        f"{flng},{flat},14,0/720x320@2x"
        f"?access_token={MAPBOX_TOKEN}"
    )
    return f'''
    <a class="map-preview" href="{map_url}" aria-label="View on map">
      <img src="{img_url}" alt="Map location" loading="lazy" />
      <div class="map-preview-overlay">
        <div class="map-preview-cta">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
          View on Map
        </div>
      </div>
    </a>'''

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
    # Deep-link to map: omit fullscreen=true so the map opens with a small popup
    # preview hovering over the pin (not the full modal). Per UX spec.
    map_url  = f"{SITE_URL}/?project={mslug}"

    seo_title = f"{title}, {city} | Markets of Tomorrow"
    seo_desc  = description[:200].rstrip() + ('…' if len(description) > 200 else '')

    # Pills
    pills = ''
    if featured:
        pills += '<span class="pill pill-featured">★ Featured</span>'
    if proj_type:
        pills += f'<span class="pill pill-type">{proj_type}</span>'

    # Stats
    stats = ''
    stats += stat_card('Developer', developer)
    stats += stat_card('Architect', architect)
    stats += stat_card('Delivery', delivery_date or delivery)
    stats += stat_card('Market', city)
    stats_section = f'<div class="stats-grid">{stats}</div>' if stats.strip() else ''

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
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
  <link rel="icon" href="{LOGO_URL}" type="image/png">

  <!-- JSON-LD -->
  <script type="application/ld+json">{jsonld}</script>

  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ background: #0d0d0d; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }}

    /* Header */
    .site-header {{ display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 0.5px solid rgba(255,255,255,0.08); position: sticky; top: 0; background: rgba(13,13,13,0.92); backdrop-filter: blur(12px); z-index: 10; }}
    .site-logo img {{ height: 28px; }}
    .header-map-btn {{ display: flex; align-items: center; gap: 7px; background: rgba(255,255,255,0.07); border: 0.5px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px 14px; color: rgba(255,255,255,0.8); text-decoration: none; font-size: 13px; font-weight: 500; transition: background 0.15s; }}
    .header-map-btn:hover {{ background: rgba(255,255,255,0.12); }}
    .header-map-btn svg {{ opacity: 0.6; }}

    /* Gallery */
    .gallery {{ width: 100%; position: relative; overflow: hidden; }}
    .gallery-hero {{ width: 100%; height: 320px; object-fit: cover; display: block; }}

    /* Slider — multi-image cycling gallery */
    .gs-slider {{ height: 320px; background: #0a0a0a; }}
    .gs-track {{ position: relative; width: 100%; height: 100%; }}
    .gs-slide {{
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: cover;
      opacity: 0;
      transition: opacity 0.35s ease;
      pointer-events: none;
    }}
    .gs-slide.active {{ opacity: 1; pointer-events: auto; }}
    .gs-arrow {{
      position: absolute;
      top: 50%; transform: translateY(-50%);
      width: 38px; height: 38px;
      border-radius: 50%;
      background: rgba(255,255,255,0.92);
      border: none;
      color: #000;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
      transition: background 0.15s, transform 0.1s;
      z-index: 2;
    }}
    .gs-arrow:hover {{ background: #fff; }}
    .gs-arrow:active {{ transform: translateY(-50%) scale(0.94); }}
    .gs-arrow svg {{ width: 18px; height: 18px; }}
    .gs-prev {{ left: 14px; }}
    .gs-next {{ right: 14px; }}
    .gs-counter {{
      position: absolute;
      bottom: 14px; right: 14px;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: rgba(255,255,255,0.95);
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 20px;
      z-index: 2;
      letter-spacing: 0.02em;
    }}

    /* Content */
    .content {{ max-width: 560px; margin: 0 auto; padding: 20px 20px 40px; }}

    /* Pills */
    .pills {{ display: flex; gap: 6px; margin-bottom: 12px; }}
    .pill {{ font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 9px; border-radius: 20px; }}
    .pill-featured {{ background: #FFD300; color: #000; }}
    .pill-type {{ background: rgba(31,223,103,0.12); color: #1FDF67; }}

    /* Title */
    .project-title {{ font-size: 28px; font-weight: 700; line-height: 1.15; margin-bottom: 4px; }}
    .project-city {{ font-size: 13px; color: rgba(255,255,255,0.45); margin-bottom: 16px; }}

    /* Progress */
    .ps-wrap {{ margin-bottom: 16px; }}
    .ps-top {{ display: flex; justify-content: space-between; margin-bottom: 6px; }}
    .ps-stage {{ font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }}
    .ps-pct {{ font-size: 10px; color: rgba(255,255,255,0.25); }}
    .ps-steps {{ display: flex; gap: 3px; margin-bottom: 5px; }}
    .ps-step {{ flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.08); }}
    .ps-done {{ background: var(--sc); }}
    .ps-active {{ background: var(--sc); opacity: 0.5; }}
    .ps-labels {{ display: flex; justify-content: space-between; }}
    .ps-label {{ font-size: 7px; color: rgba(255,255,255,0.2); }}
    .ps-cur {{ color: var(--sc, #FF9500); }}

    /* Divider */
    .divider {{ height: 0.5px; background: rgba(255,255,255,0.07); margin: 16px 0; }}

    /* Description */
    .description {{ font-size: 14px; color: rgba(255,255,255,0.6); line-height: 1.7; margin-bottom: 16px; }}

    /* Stats */
    .stats-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 20px; }}
    .stat-card {{ background: rgba(255,255,255,0.04); border-radius: 8px; padding: 10px 12px; }}
    .stat-label {{ font-size: 8px; color: rgba(255,255,255,0.28); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }}
    .stat-val {{ font-size: 13px; color: #fff; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}

    /* CTA */
    .cta-row {{ display: flex; gap: 10px; align-items: center; margin-bottom: 16px; }}
    .btn-primary {{ flex: 1; background: #1FDF67; color: #000; border: none; border-radius: 10px; padding: 13px 16px; font-size: 14px; font-weight: 700; cursor: pointer; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 6px; }}
    .btn-primary:hover {{ background: #18c75a; }}
    .btn-disabled {{ background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.3); cursor: default; }}

    /* Mini map preview — clickable Mapbox static image with overlay CTA */
    .map-preview {{
      display: block;
      position: relative;
      width: 100%;
      height: 180px;
      border-radius: 12px;
      overflow: hidden;
      text-decoration: none;
      margin-bottom: 16px;
      background: #1a1a1a;
      transition: transform 0.15s, box-shadow 0.15s;
    }}
    .map-preview:hover {{ transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0,0,0,0.4); }}
    .map-preview img {{
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }}
    .map-preview-overlay {{
      position: absolute; inset: 0;
      background: linear-gradient(to bottom, rgba(0,0,0,0) 50%, rgba(0,0,0,0.7) 100%);
      display: flex; align-items: flex-end; justify-content: center;
      padding: 14px;
    }}
    .map-preview-cta {{
      display: flex; align-items: center; gap: 8px;
      background: rgba(31,223,103,0.95);
      color: #000;
      padding: 10px 16px;
      border-radius: 22px;
      font-size: 13px; font-weight: 700;
      box-shadow: 0 2px 10px rgba(0,0,0,0.4);
      transition: background 0.15s;
    }}
    .map-preview:hover .map-preview-cta {{ background: #1FDF67; }}

    /* Back breadcrumb */
    .breadcrumb {{ font-size: 12px; color: rgba(255,255,255,0.3); margin-bottom: 20px; }}
    .breadcrumb a {{ color: rgba(255,255,255,0.4); text-decoration: none; }}
    .breadcrumb a:hover {{ color: rgba(255,255,255,0.7); }}

    /* Footer logo (mobile only) — centered Markets of Tomorrow wordmark below content */
    .footer-logo {{
      display: none; /* desktop hides this — header is the brand on desktop */
      padding: 32px 20px 40px;
      text-align: center;
    }}
    .footer-logo a {{
      display: inline-block;
      transition: opacity 0.2s;
    }}
    .footer-logo a:hover {{ opacity: 0.8; }}
    .footer-logo img {{
      height: 38px;
      width: auto;
      filter: brightness(0) invert(1);
      opacity: 0.9;
    }}

    @media (max-width: 480px) {{
      /* Mobile: remove top black header bar entirely */
      .site-header {{ display: none !important; }}
      /* Show centered footer logo at bottom of page */
      .footer-logo {{ display: block; }}
      .footer-logo img {{ height: 42px; }}
      /* Gallery taller on mobile since header reclaim is freed up */
      .gallery-hero {{ height: 280px; }}
      .gs-slider {{ height: 280px; }}
      .gs-arrow {{ width: 34px; height: 34px; }}
      .gs-prev {{ left: 10px; }}
      .gs-next {{ right: 10px; }}
      .project-title {{ font-size: 24px; }}
      .stats-grid {{ grid-template-columns: 1fr 1fr; }}
      .map-preview {{ height: 180px; }}
    }}
  </style>
</head>
<body>

  <header class="site-header">
    <a class="site-logo" href="{SITE_URL}">
      <img src="{LOGO_URL}" alt="Markets of Tomorrow" />
    </a>
    <a class="header-map-btn" href="{map_url}">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
      View on Map
    </a>
  </header>

  {gallery_html(row)}

  <div class="content">
    <p class="breadcrumb"><a href="{SITE_URL}">Map of Tomorrow</a> / {city} / {title}</p>
    <div class="pills">{pills}</div>
    <h1 class="project-title">{title}</h1>
    <p class="project-city">{city}{' • ' + proj_type if proj_type else ''}</p>
    {progress_bar_html(delivery)}
    <div class="divider"></div>
    <p class="description">{description}</p>
    <div class="divider"></div>
    {stats_section}
    <div class="cta-row">
      {website_btn}
    </div>
    {map_preview_html(lat, lng, map_url)}
  </div>

  <!-- Footer logo (mobile only, centered) — desktop hides this since header has the brand -->
  <div class="footer-logo">
    <a href="{SITE_URL}" aria-label="Markets of Tomorrow home">
      <img src="https://static.wixstatic.com/shapes/ca3b83_a647b53cad4c49c5b012af991d286a86.svg" alt="Markets of Tomorrow" />
    </a>
  </div>

  <script>
    // Gallery slider — arrow cycling, keyboard arrows, and touch swipe
    (function() {{
      const slider = document.querySelector('.gs-slider');
      if (!slider) return;
      const slides = slider.querySelectorAll('.gs-slide');
      const counter = slider.querySelector('.gs-cur');
      const prevBtn = slider.querySelector('.gs-prev');
      const nextBtn = slider.querySelector('.gs-next');
      const total = slides.length;
      let cur = 0;

      // Preload next image so transitions feel instant
      function preload(idx) {{
        const img = slides[idx];
        if (!img) return;
        if (img.dataset.preloaded) return;
        const ghost = new Image();
        ghost.src = img.src;
        img.dataset.preloaded = '1';
      }}

      function go(next) {{
        if (next === cur) return;
        slides[cur].classList.remove('active');
        cur = (next + total) % total;
        slides[cur].classList.add('active');
        if (counter) counter.textContent = cur + 1;
        // Preload neighbors
        preload((cur + 1) % total);
        preload((cur - 1 + total) % total);
      }}

      prevBtn?.addEventListener('click', () => go(cur - 1));
      nextBtn?.addEventListener('click', () => go(cur + 1));

      // Keyboard arrows when slider is focused/in view
      document.addEventListener('keydown', (e) => {{
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowLeft')  go(cur - 1);
        if (e.key === 'ArrowRight') go(cur + 1);
      }});

      // Touch swipe for mobile
      let startX = 0, startY = 0;
      slider.addEventListener('touchstart', (e) => {{
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      }}, {{ passive: true }});
      slider.addEventListener('touchend', (e) => {{
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {{
          go(dx < 0 ? cur + 1 : cur - 1);
        }}
      }}, {{ passive: true }});

      // Preload the second image immediately
      preload(1 % total);
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

    # Generate sitemap.xml + robots.txt at repo root
    write_sitemap_and_robots(index_items)

    print(f"\n✅ Done! Generated {generated} pages, skipped {skipped}")
    print(f"   Output: ./{OUTPUT_DIR}/")
    print(f"   Sitemap: ./sitemap.xml ({generated + 2} URLs)")

def write_sitemap_and_robots(items):
    """Write sitemap.xml and robots.txt to repo root for SEO."""
    from datetime import datetime
    today = datetime.utcnow().strftime('%Y-%m-%d')

    urls = []
    # Map root (highest priority)
    urls.append({'loc': SITE_URL + '/', 'priority': '1.0', 'changefreq': 'daily'})
    # Projects index
    urls.append({'loc': SITE_URL + '/projects/', 'priority': '0.9', 'changefreq': 'daily'})
    # Each individual project page
    for slug, title, city, delivery, image in items:
        urls.append({
            'loc': f"{SITE_URL}/projects/{slug}/",
            'priority': '0.8',
            'changefreq': 'weekly',
        })

    sitemap_xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    sitemap_xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    for u in urls:
        sitemap_xml += '  <url>\n'
        sitemap_xml += f'    <loc>{u["loc"]}</loc>\n'
        sitemap_xml += f'    <lastmod>{today}</lastmod>\n'
        sitemap_xml += f'    <changefreq>{u["changefreq"]}</changefreq>\n'
        sitemap_xml += f'    <priority>{u["priority"]}</priority>\n'
        sitemap_xml += '  </url>\n'
    sitemap_xml += '</urlset>\n'

    with open('sitemap.xml', 'w', encoding='utf-8') as f:
        f.write(sitemap_xml)

    robots_txt = (
        "User-agent: *\n"
        "Allow: /\n\n"
        f"Sitemap: {SITE_URL}/sitemap.xml\n"
    )
    with open('robots.txt', 'w', encoding='utf-8') as f:
        f.write(robots_txt)

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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>All Projects | Markets of Tomorrow</title>
  <meta name="description" content="Browse all {len(items)} projects tracked on the Map of Tomorrow — luxury real estate, hotels, stadiums, and more from Markets of Tomorrow.">
  <meta property="og:title" content="All Projects | Markets of Tomorrow">
  <meta property="og:description" content="Browse {len(items)} future developments on the Map of Tomorrow.">
  <meta property="og:image" content="{DEFAULT_IMAGE}">
  <link rel="icon" href="{LOGO_URL}" type="image/png">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ background: #0d0d0d; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }}
    .site-header {{ display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 0.5px solid rgba(255,255,255,0.08); position: sticky; top:0; background: rgba(13,13,13,0.92); backdrop-filter: blur(12px); z-index:10; }}
    .site-logo img {{ height: 28px; }}
    .header-map-btn {{ display:flex;align-items:center;gap:7px;background:rgba(255,255,255,0.07);border:0.5px solid rgba(255,255,255,0.15);border-radius:8px;padding:8px 14px;color:rgba(255,255,255,0.8);text-decoration:none;font-size:13px;font-weight:500; }}
    .page-header {{ padding: 32px 20px 20px; max-width: 1200px; margin: 0 auto; }}
    .page-header h1 {{ font-size: 28px; font-weight: 700; margin-bottom: 6px; }}
    .page-header p {{ color: rgba(255,255,255,0.45); font-size: 14px; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; padding: 0 20px 40px; max-width: 1200px; margin: 0 auto; }}
    .card {{ text-decoration: none; color: #fff; background: #111; border-radius: 12px; overflow: hidden; transition: transform 0.15s; }}
    .card:hover {{ transform: translateY(-2px); }}
    .card-img {{ height: 160px; background-size: cover; background-position: center; }}
    .card-body {{ padding: 12px; }}
    .card-title {{ font-size: 14px; font-weight: 600; margin-bottom: 3px; }}
    .card-city {{ font-size: 12px; color: rgba(255,255,255,0.4); margin-bottom: 5px; }}
    .card-status {{ font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }}
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
