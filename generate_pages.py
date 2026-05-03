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

    main = imgs[0]
    thumbs = imgs[1:4]
    extra = len(imgs) - 4  # images beyond first 4

    thumb_html = ''
    for i, url in enumerate(thumbs):
        is_last = (i == len(thumbs) - 1) and extra > 0
        overlay = f'<div class="gt-overlay">+{extra} more</div>' if is_last else ''
        thumb_html += f'<div class="gt-thumb" style="background-image:url(\'{url}\')">{overlay}</div>'

    strip = f'<div class="gt-strip">{thumb_html}</div>' if thumbs else ''

    return f'''
    <div class="gallery">
      <img class="gallery-hero" src="{main}" alt="" loading="eager" />
      {strip}
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

    slug     = slugify(title)
    mslug    = map_slug(title)
    page_url = f"{SITE_URL}/projects/{slug}/"
    map_url  = f"{SITE_URL}/?fullscreen=true&project={mslug}"

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
  2     website_btn = '<span class="btn-primary btn-disabled">No Website Listed</span>'

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
    .gallery {{ width: 100%; }}
    .gallery-hero {{ width: 100%; height: 320px; object-fit: cover; display: block; }}
    .gt-strip {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; }}
    .gt-thumb {{ height: 80px; background-size: cover; background-position: center; position: relative; }}
    .gt-overlay {{ position: absolute; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.85); }}

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
    .cta-row {{ display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }}
    .btn-primary {{ flex: 1; background: #1FDF67; color: #000; border: none; border-radius: 10px; padding: 13px 16px; font-size: 14px; font-weight: 700; cursor: pointer; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 6px; }}
    .btn-primary:hover {{ background: #18c75a; }}
    .btn-disabled {{ background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.3); cursor: default; }}
    .btn-map {{ display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.06); border: 0.5px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 13px 16px; color: rgba(255,255,255,0.75); text-decoration: none; font-size: 14px; font-weight: 500; white-space: nowrap; transition: background 0.15s; }}
    .btn-map:hover {{ background: rgba(255,255,255,0.1); }}
    .btn-map svg {{ opacity: 0.6; }}

    /* Back breadcrumb */
    .breadcrumb {{ font-size: 12px; color: rgba(255,255,255,0.3); margin-bottom: 20px; }}
    .breadcrumb a {{ color: rgba(255,255,255,0.4); text-decoration: none; }}
    .breadcrumb a:hover {{ color: rgba(255,255,255,0.7); }}

    @media (max-width: 480px) {{
      .gallery-hero {{ height: 260px; }}
      .project-title {{ font-size: 24px; }}
      .stats-grid {{ grid-template-columns: 1fr 1fr; }}
      .cta-row {{ flex-wrap: wrap; }}
      .btn-map {{ width: 100%; justify-content: center; }}
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
      <a class="btn-map" href="{map_url}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
        View on Map
      </a>
    </div>
  </div>

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
