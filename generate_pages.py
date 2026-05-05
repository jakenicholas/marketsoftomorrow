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

    # Multiple images — slider with desktop peek effect; mobile fades full-width
    slides = ''.join(
        f'<img class="gs-slide" src="{u}" alt="" '
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

    # Pills — only the Featured star, project type now lives in subtitle only
    pills = ''
    if featured:
        pills += '<span class="pill pill-featured">★ Featured</span>'
    pills_section = f'<div class="pills">{pills}</div>' if pills else ''

    # Stats
    stats = ''
    stats += stat_card('Developer', developer)
    stats += stat_card('Architect', architect)
    stats += stat_card('Delivery', delivery_date or delivery)
    stats += stat_card('Market', city)
    stats_section = f'<div class="stats-grid">{stats}</div>' if stats.strip() else ''

    # Website button + share button
    if website:
        website_btn = f'<a class="btn-primary" href="{website}" target="_blank" rel="noopener">Official Website <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>'
    else:
        website_btn = '<span class="btn-primary btn-disabled">No Website Listed</span>'

    # Share button — uses Web Share API on mobile/supported browsers, falls back to clipboard
    share_btn = (
        '<button class="btn-share" type="button" aria-label="Share project" '
        'onclick="window.shareProject &amp;&amp; window.shareProject(this)">'
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
        '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>'
        '<polyline points="16 6 12 2 8 6"/>'
        '<line x1="12" y1="2" x2="12" y2="15"/>'
        '</svg>'
        '<span class="btn-share-tooltip" aria-live="polite"></span>'
        '</button>'
    )

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
  <!-- Disable iOS Safari Data Detectors so phone numbers, addresses, dates, etc.
       in body copy aren't auto-linked into tappable blue text -->
  <meta name="format-detection" content="telephone=no, address=no, email=no, date=no">
  <meta name="x-apple-disable-message-reformatting" content="">
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
    /* Belt-and-suspenders defense against iOS Safari Data Detectors:
       even when the format-detection meta tag is set, iOS sometimes still auto-links
       addresses/phones/dates inside body copy. Neutralize any that slip through. */
    .description a[href^="tel:"], .description a[href^="mailto:"], .description a[x-apple-data-detectors] {{
      color: inherit !important;
      text-decoration: inherit !important;
      pointer-events: none !important;
      cursor: text !important;
    }}

    /* Gallery */
    .gallery {{ width: 100%; position: relative; overflow: hidden; }}
    .gallery-hero {{ width: 100%; height: 320px; object-fit: cover; display: block; }}

    /* Slider — multi-image cycling gallery
       Desktop: center slide takes ~60% width with prev/next peeking in dimmed.
       Mobile: full-width single-slide fade. */
    .gs-slider {{
      height: 460px;
      background: #0a0a0a;
      padding: 24px 0;
      box-sizing: content-box;
    }}
    .gs-track {{ position: relative; width: 100%; height: 100%; }}
    .gs-slide {{
      position: absolute;
      top: 0;
      height: 100%;
      object-fit: cover;
      border-radius: 12px;
      transition: left 0.4s ease, width 0.4s ease, opacity 0.4s ease, filter 0.4s ease, transform 0.4s ease;
      pointer-events: none;
      box-shadow: 0 8px 30px rgba(0,0,0,0.5);
    }}
    /* Default state for any slide not assigned a position — fully off-screen and hidden */
    .gs-slide {{
      left: 50%;
      width: 60%;
      opacity: 0;
      transform: translateX(-50%) scale(0.9);
    }}
    .gs-slide[data-pos="active"] {{
      left: 20%;
      width: 60%;
      opacity: 1;
      transform: translateX(0) scale(1);
      filter: none;
      pointer-events: auto;
      z-index: 2;
    }}
    .gs-slide[data-pos="prev"] {{
      left: -38%;
      width: 60%;
      opacity: 0.55;
      transform: translateX(0) scale(0.92);
      filter: brightness(0.45);
      z-index: 1;
    }}
    .gs-slide[data-pos="next"] {{
      left: 78%;
      width: 60%;
      opacity: 0.55;
      transform: translateX(0) scale(0.92);
      filter: brightness(0.45);
      z-index: 1;
    }}
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
      z-index: 3;
    }}
    .gs-arrow:hover {{ background: #fff; }}
    .gs-arrow:active {{ transform: translateY(-50%) scale(0.94); }}
    .gs-arrow svg {{ width: 18px; height: 18px; }}
    .gs-prev {{ left: 14%; transform: translate(-50%, -50%); }}
    .gs-prev:active {{ transform: translate(-50%, -50%) scale(0.94); }}
    .gs-next {{ right: 14%; transform: translate(50%, -50%); }}
    .gs-next:active {{ transform: translate(50%, -50%) scale(0.94); }}
    .gs-counter {{
      position: absolute;
      bottom: 38px; left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: rgba(255,255,255,0.95);
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 20px;
      z-index: 3;
      letter-spacing: 0.02em;
    }}

    /* Content */
    .content {{ max-width: 560px; margin: 0 auto; padding: 20px 20px 40px; }}

    /* Pills */
    .pills {{ display: flex; gap: 6px; margin-bottom: 12px; }}
    .pill {{ font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 9px; border-radius: 20px; }}
    .pill-featured {{ background: #FFD300; color: #000; }}

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
    .stats-grid {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin-bottom: 20px; align-items: stretch; }}
    .stat-card {{ background: rgba(255,255,255,0.04); border-radius: 8px; padding: 10px 12px; min-width: 0; display: flex; flex-direction: column; }}
    .stat-label {{ font-size: 8px; color: rgba(255,255,255,0.28); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }}
    .stat-val {{ font-size: 13px; color: #fff; font-weight: 500; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto; }}

    /* CTA */
    .cta-row {{ display: flex; gap: 10px; align-items: stretch; margin-bottom: 16px; }}
    .btn-primary {{ flex: 1; background: #1FDF67; color: #000; border: none; border-radius: 10px; padding: 13px 16px; font-size: 14px; font-weight: 700; cursor: pointer; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 6px; }}
    .btn-primary:hover {{ background: #18c75a; }}
    .btn-disabled {{ background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.3); cursor: default; }}
    /* Share button — square, gray pill matching map-preview CTA aesthetic */
    .btn-share {{
      flex: 0 0 auto;
      width: 50px;
      background: rgba(255,255,255,0.07);
      border: 0.5px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      color: rgba(255,255,255,0.85);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s, color 0.15s;
      position: relative;
      padding: 0;
    }}
    .btn-share:hover {{ background: rgba(255,255,255,0.14); color: #fff; }}
    .btn-share:active {{ transform: scale(0.97); }}
    .btn-share svg {{ opacity: 0.85; }}
    /* "Link copied" tooltip — fades in for 1.5s after a desktop fallback copy */
    .btn-share-tooltip {{
      position: absolute;
      bottom: calc(100% + 6px); right: 0;
      background: rgba(0,0,0,0.85);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 9px;
      border-radius: 6px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s;
    }}
    .btn-share.copied .btn-share-tooltip {{ opacity: 1; }}

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
      display: flex; align-items: center; gap: 7px;
      background: rgba(255,255,255,0.07);
      border: 0.5px solid rgba(255,255,255,0.15);
      color: rgba(255,255,255,0.9);
      padding: 10px 16px;
      border-radius: 22px;
      font-size: 13px; font-weight: 500;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 2px 10px rgba(0,0,0,0.4);
      transition: background 0.15s;
    }}
    .map-preview-cta svg {{ opacity: 0.7; }}
    .map-preview:hover .map-preview-cta {{ background: rgba(255,255,255,0.14); }}

    /* Site header is hidden across all viewports — brand lives in the footer logo */
    .site-header {{ display: none !important; }}

    /* Footer logo — centered Markets of Tomorrow wordmark below content (all viewports) */
    .footer-logo {{
      display: block;
      padding: 40px 20px 48px;
      text-align: center;
    }}
    .footer-logo a {{
      display: inline-block;
      transition: opacity 0.2s;
    }}
    .footer-logo a:hover {{ opacity: 0.8; }}
    .footer-logo img {{
      height: 56px;
      width: auto;
      filter: brightness(0) invert(1);
      opacity: 0.9;
    }}

    @media (max-width: 480px) {{
      /* Mobile keeps a slightly smaller footer logo */
      .footer-logo img {{ height: 48px; }}
      /* Gallery taller on mobile since header reclaim is freed up */
      .gallery-hero {{ height: 280px; }}
      /* Mobile slider: revert to full-width single-image fade (no desktop peek) */
      .gs-slider {{ height: 280px; padding: 0; }}
      .gs-slide {{ border-radius: 0; box-shadow: none; }}
      .gs-slide[data-pos="active"] {{ left: 0; width: 100%; transform: none; }}
      .gs-slide[data-pos="prev"], .gs-slide[data-pos="next"] {{
        left: 0; width: 100%; opacity: 0; transform: none; filter: none; pointer-events: none;
      }}
      .gs-arrow {{ width: 34px; height: 34px; }}
      .gs-prev {{ left: 10px; transform: translateY(-50%); }}
      .gs-prev:active {{ transform: translateY(-50%) scale(0.94); }}
      .gs-next {{ right: 10px; transform: translateY(-50%); }}
      .gs-next:active {{ transform: translateY(-50%) scale(0.94); }}
      .gs-counter {{ bottom: 14px; left: auto; right: 14px; transform: none; }}
      .project-title {{ font-size: 24px; }}
      .stats-grid {{ grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }}
      .map-preview {{ height: 180px; }}
    }}
  </style>
</head>
<body>

  {gallery_html(row)}

  <div class="content">
    {pills_section}
    <h1 class="project-title">{title}</h1>
    <p class="project-city">{city}{' • ' + proj_type if proj_type else ''}</p>
    {progress_bar_html(delivery)}
    <div class="divider"></div>
    <p class="description">{description}</p>
    <div class="divider"></div>
    {stats_section}
    <div class="cta-row">
      {website_btn}
      {share_btn}
    </div>
    {map_preview_html(lat, lng, map_url)}
  </div>

  <!-- Footer logo — centered Markets of Tomorrow wordmark, shown on all viewports -->
  <div class="footer-logo">
    <a href="{SITE_URL}" aria-label="Markets of Tomorrow home">
      <img src="https://static.wixstatic.com/shapes/ca3b83_a647b53cad4c49c5b012af991d286a86.svg" alt="Markets of Tomorrow" />
    </a>
  </div>

  <script>
    // Share button — uses Web Share API on mobile/supported browsers,
    // falls back to copying the page URL to the clipboard with a "Link copied" tooltip.
    window.shareProject = function(btn) {{
      const url = window.location.href;
      const title = document.title;
      const shareData = {{ title: title, url: url }};
      if (navigator.share) {{
        navigator.share(shareData).catch(() => {{ /* user dismissed; nothing to do */ }});
        return;
      }}
      // Clipboard fallback
      const showTooltip = (text) => {{
        const tip = btn && btn.querySelector('.btn-share-tooltip');
        if (!tip) return;
        tip.textContent = text;
        btn.classList.add('copied');
        clearTimeout(btn._tipTimer);
        btn._tipTimer = setTimeout(() => btn.classList.remove('copied'), 1500);
      }};
      if (navigator.clipboard && navigator.clipboard.writeText) {{
        navigator.clipboard.writeText(url)
          .then(() => showTooltip('Link copied'))
          .catch(() => showTooltip('Press \u2318C to copy'));
      }} else {{
        // Last resort: legacy execCommand
        try {{
          const ta = document.createElement('textarea');
          ta.value = url; ta.setAttribute('readonly', '');
          ta.style.position = 'absolute'; ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          showTooltip('Link copied');
        }} catch (e) {{
          showTooltip('Could not copy');
        }}
      }}
    }};

    // Gallery slider — arrow cycling, keyboard arrows, and touch swipe
    // Uses data-pos="active|prev|next" so CSS can position the center slide and
    // peek slides on desktop, while mobile collapses to a full-width fade.
    (function() {{
      const slider = document.querySelector('.gs-slider');
      if (!slider) return;
      const slides = slider.querySelectorAll('.gs-slide');
      const counter = slider.querySelector('.gs-cur');
      const prevBtn = slider.querySelector('.gs-prev');
      const nextBtn = slider.querySelector('.gs-next');
      const total = slides.length;
      let cur = 0;

      // Preload an image so transitions feel instant
      function preload(idx) {{
        const img = slides[idx];
        if (!img) return;
        if (img.dataset.preloaded) return;
        const ghost = new Image();
        ghost.src = img.src;
        img.dataset.preloaded = '1';
      }}

      function applyPositions() {{
        const prevIdx = (cur - 1 + total) % total;
        const nextIdx = (cur + 1) % total;
        slides.forEach((slide, i) => {{
          // With only 2 images, the same image would be both prev AND next.
          // Show it only as "next" in that case so we don't get duplicate peeks.
          if (i === cur) {{
            slide.setAttribute('data-pos', 'active');
          }} else if (total > 2 && i === prevIdx) {{
            slide.setAttribute('data-pos', 'prev');
          }} else if (i === nextIdx) {{
            slide.setAttribute('data-pos', 'next');
          }} else if (total === 2 && i === prevIdx) {{
            // Hide the duplicate when there are only 2 slides
            slide.setAttribute('data-pos', 'hidden');
          }} else {{
            slide.setAttribute('data-pos', 'hidden');
          }}
        }});
      }}

      function go(next) {{
        if (next === cur) return;
        cur = (next + total) % total;
        applyPositions();
        if (counter) counter.textContent = cur + 1;
        // Preload neighbors
        preload((cur + 1) % total);
        preload((cur - 1 + total) % total);
      }}

      // Initial render
      applyPositions();

      prevBtn?.addEventListener('click', () => go(cur - 1));
      nextBtn?.addEventListener('click', () => go(cur + 1));

      // Click on a peek slide to navigate to it
      slides.forEach((slide, i) => {{
        slide.addEventListener('click', () => {{
          const pos = slide.getAttribute('data-pos');
          if (pos === 'prev') go(cur - 1);
          else if (pos === 'next') go(cur + 1);
        }});
      }});

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
