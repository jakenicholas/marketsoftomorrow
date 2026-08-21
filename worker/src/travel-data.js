// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE TRAVEL ITINERARIES — the sensitive layer of /travel.
//
// Exact hotels, exact dates, and transit times are NOT published in any static
// page (view-source would defeat a client-side hide). They live here and are
// served ONLY by /travel-itinerary after a per-recipient signed token verifies.
// The public pages ship a city+month teaser instead.
//
// Edit these the same way you used to edit the itinerary pages.
// ─────────────────────────────────────────────────────────────────────────────

export const TRAVEL_STOPS = {
  california: [
  { loc:'Palo Alto, California', nights:'3 Nights · Aug 1 → 4', stay:'Nobu Hotel Palo Alto', rate:'$1,300/night', client:'Quinn', confirmed:true, imgPos:'center 72%',
    in:{ start:true, date:'August 1', mode:'flight', note:'Touchdown, the journey begins' },
    vibe:'Opening in the heart of Silicon Valley, a sleek, design-forward base with Nobu’s signature dining and easy reach of the Peninsula and the city.',
    todo:[
      { a:'Dinner', t:'Nobu Restaurant', partner:'Quinn', img:'https://www.nobuhotels.com/palo-alto/content/uploads/2024/11/twilight-nobu-garden-overview.jpg' },
      { a:'Explore', t:'Palo Alto', img:'https://media-production.lp-cdn.com/cdn-cgi/image/format=auto,quality=85,fit=scale-down,width=1280/https://media-production.lp-cdn.com/media/ece5959e-deaf-4894-b0ee-a834a42e3f94' },
      { a:'Explore', t:'Stanford University', img:'https://www.tclf.org/sites/default/files/styles/crop_2000x700/public/thumbnails/image/CA_Stanford_StanfordUniversity_courtesyWikimediaCommons_2011_005_Hero.jpg?itok=B8YAapxD' },
      { a:'Dinner', t:'Macarena', img:'https://www.paloaltoonline.com/wp-content/uploads/2024/12/PA_Macarena_DEC2024_03-1.png' },
      { a:'Explore', t:'San Francisco', img:'https://lp-cms-production.imgix.net/2021-05/GettyRF_462144413.jpg?auto=format,compress&q=72&w=1920&fit=crop&crop=faces,edges' },
      { a:'Lunch', t:"Tony's Pizza Napoletana", star:'Ranked #3 Best Pizza in the World', img:'https://media.oftmw.com/2026/07/tonys-pizza-napoletana.webp' },
      { a:'Dinner', t:'Kokkari Estiatorio', img:'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRRwqoq33wUN4Y4llWeaSLVLKXVzp9cUKcHKrW_G_Ykaey5-rDtQeWv0apB&s=10' },
      { a:'Explore', t:'Muir Woods', img:'https://upload.wikimedia.org/wikipedia/commons/1/12/Muir_Woods_National_Monument_%2847879029461%29.jpg' }
    ],
    logi:[], imgs:['https://www.nobuhotels.com/palo-alto/content/uploads/2024/09/contact-us-scaled.jpg'] },

  { loc:'Big Sur, California', nights:'1 Night · Aug 4 → 5', stay:'Highway 1 & the Coast', confirmed:true, noClient:true,
    in:{ date:'Aug 4', mode:'car', note:'Palo Alto → Big Sur → Santa Cruz' },
    vibe:'The most dramatic stretch of the Pacific Coast Highway, Bixby Bridge, redwoods meeting the sea, and the pull-offs above the cliffs before turning back north.',
    logi:[['The Drive','South down Highway 1 along the coast, threading the cliffs and coves of the Big Sur shoreline.']],
    todo:[
      { a:'Explore', t:'17-Mile Drive', img:'https://a0.muscache.com/im/pictures/miso/Hosting-924683645412539102/original/1c5e3fd0-4c14-4fbc-8069-46ba5ab6f994.jpeg' },
      { a:'Explore', t:'Carmel-by-the-Sea', img:'https://sarahseeksadventure.com/wp-content/uploads/2023/11/IMG_2699-1024x683.jpg' },
      { a:'Explore', t:'Bixby Creek Bridge', img:'https://images.squarespace-cdn.com/content/v1/5a5986b2cf81e095e172ce87/1597531116722-41NP8HVUE7BPQI0DYJES/flyingdawnmarie-bixby-creek-bridge-04-banner.jpg' },
      { a:'Explore', t:'Pfeiffer Beach', img:'https://www.bemytravelmuse.com/wp-content/uploads/2020/05/Pfeiffer-Beach-3.jpg' },
      { a:'Explore', t:'Julia Pfeiffer Burns State Park', img:'https://www.travelandleisure.com/thmb/h3YE-IFCMRTab85fNW0ir6JxP28=/1500x0/filters:no_upscale():max_bytes(150000):strip_icc()/TAL-mcway-waterfall-julia-pfeiffer-burns-state-park-JULIAPFEIFFERBURNPARK0326-fce67b202d604b5981bd01969dea8cce.jpg' },
      { a:'Check-in', t:'Hotel Paradox', img:'https://www.visittheusa.com/wp-content/uploads/2025/11/Capitola-Village_Sunset-Venetians_credit-VSCC-and-Praveen-PN_20181920px.jpg' }
    ],
    imgs:['https://static01.nyt.com/images/2018/10/07/travel/07highwayone1/07highwayone1-superJumbo.jpg'] },

  { loc:'Sonoma, California', nights:'2 Nights · Aug 5 → 7', stay:'MacArthur Place Sonoma', rate:'$890/night', client:'J/PR', confirmed:true,
    in:{ date:'Aug 5', mode:'car', note:'Santa Cruz → Sonoma' },
    vibe:'A historic six-acre estate at the edge of Sonoma’s plaza, where garden cottages, a spa, and the wine country’s ease set the tone for the valley.',
    logi:[],
    todo:[
      { a:'Explore', t:'Santa Cruz', img:'https://www.visittheusa.com/wp-content/uploads/2025/11/Davenport_by-Ben-Ingram_20221920px.jpg' },
      { a:'Explore', t:'Napa Valley', img:'https://wineinternationalassociation.org/wp-content/uploads/2026/01/napa-valley-winery-gpt1.jpg' },
      { a:'Dinner', t:'Layla', partner:'J/PR', img:'https://assets.simpleviewinc.com/simpleview/image/upload/crm/sonomavalley/LaylaPatio_3B2B90EA-DDAA-4A4D-BA8AB6EEA23F2FF7_8d47d839-c905-4f0d-900f6c1aa4afc377.jpg' },
      { a:'Winery Tour', t:'Chateau St. Jean Winery', partner:'J/PR', img:'https://assets.simpleviewinc.com/simpleview/image/upload/crm/sonomavalley/the-chateau-20-55e3c8e15056b3a_55e3ca69-5056-b3a8-49e8bba5d0f3d508.jpg' },
      { a:'Explore', t:'Sonoma', img:'https://www.sonomacounty.com/wp-content/uploads/2024/01/Kunde_Winery_Vineyards_Kenwood-1024x768.jpg' }
    ],
    imgs:['https://media.oftmw.com/2026/07/90bf050f4cc7-macarthur-place-entrance-evening.jpg','https://media.oftmw.com/2026/07/73bcb18a80f9-macarthur-place-layla-interior.jpg','https://media.oftmw.com/2026/07/7ab0cbb6d61f-macarthur-place-grounds.jpg'] },

  { loc:'Sacramento, California', nights:'2 Nights · Aug 7 → 9', stay:'Private Stay', noClient:true, confirmed:true,
    in:{ date:'Aug 7', mode:'car', note:'Napa Valley → Sacramento' },
    vibe:'Closing the loop in the capital, a private base among the tree-lined grid, farm-to-fork tables, and the historic riverfront.',
    todo:[
      { a:'Golf', t:'Martis Camp Golf Club', partner:'C&R', img:'https://media.oftmw.com/2026/07/martis-camp-golf-club.webp' }
    ],
    logi:[], imgs:['https://discovercaliforniawines.com/wp-content/uploads/2011/06/Sacramento-shutterstock_1476260747-scaled.jpg'] },
],

  europe: [
  // ── Part 0: Italy & the Adriatic (Sept 3 → 13) ──
  { loc:'Rome, Italy', nights:'3 Nights · Sept 4 → 7', stay:'Private Stay', noClient:true, confirmed:true,
    in:{ start:true, date:'September 3', mode:'flight', note:'Depart home, arrive Rome the 4th' },
    logi:[], imgs:[
      'https://www.italyperfect.com/g/photos/upload/sml_845543004-1590582528-ip-info-rome.jpg'] },

  { loc:'Verona, Italy', nights:'4 Nights · Sept 7 → 11', stay:'Hotel Touring', noClient:true, confirmed:true,
    in:{ date:'Sept 7', mode:'train', note:'Rome → Verona' },
    logi:[],
    todo:[
      { a:'Day Trip', t:'Venice · A Day on the Water', img:'https://betweencarpools.com/wp-content/uploads/2019/03/shutterstock_720444505-5000x3184.jpg' }
    ],
    imgs:['https://travelthru.com/cdn-cgi/imagedelivery/wZpbJM3t8iED5kIISxeUgQ/506fd17a-fa66-4fb1-d067-0d209a988b00/public'] },
  { loc:'The Dolomites, Italy', nights:'2 Nights · Sept 11 → 13', stay:'Private Stay', noClient:true, confirmed:true,
    in:{ date:'Sept 11', mode:'car', note:'Verona → the Dolomites' },
    logi:[['The Drive','<b>~3-hour drive</b> north from Verona into the heart of the Dolomites.']],
    todo:[
      { a:'Stay', t:'Faloria Mountain Spa Resort', img:'https://faloriasparesort.com/wp-content/uploads/sites/18/2019/02/faloria_2146-2F-LOW.jpg' },
      { a:'Hike', t:'Tre Cime di Lavaredo', img:'https://huttohuthikingeurope.com/_next/image?url=https%3A%2F%2Fcdn.world-discovery.com%2F64672%2Ftre-cime-di-lavaredo-with-reflection-in-lake-at-sundown-dolomit.webp&w=1920&q=75' },
      { a:'Hike', t:'Seceda Ridgeline', img:'https://images.squarespace-cdn.com/content/v1/5bad2c26d74562245b63d094/cce0c7db-e5d6-4a04-ad56-1603b0662749/viewpoint+of+Seceda+along+the+ridgeline+trail' },
      { a:'Explore', t:'Cortina d\u2019Ampezzo', img:'https://ik.imgkit.net/3vlqs5axxjf/TAW/ik-seo/uploadedImages/All_Gateways/Europe/Features/CortinaItaly_Hero/An-Adventurer%E2%80%99s-Guide-to-What-to-Do-and-Where-to-S.jpg?tr=w-1008%2Ch-567%2Cfo-auto' },
      { a:'Hike', t:'Lago di Sorapis', img:'https://thephotohikes.com/wp-content/uploads/2024/01/Lago-di-Sorapis-11.jpg' },
      { a:'Explore', t:'Plose', img:'https://www.plose.org/bilder/Natur-pur_%C2%A9Horeca.jpg' }
    ],
    imgs:[
      'https://cdn1.modernadventure.com/app/uploads/2021/10/moad-dolomites-4-edited-e1634571651246-1.jpeg',
      'https://www.livelikeitstheweekend.com/wp-content/uploads/2026/01/Dolomites-where-to-visit-.jpg'] },

  { loc:'Milan, Italy', nights:'1 Night · Sept 13 → 14', stay:'Private Stay', confirmed:true, noClient:true,
    in:{ date:'Sept 13', mode:'car', note:'The Dolomites → Milan' },
    logi:[['The Drive','<b>~4-hour drive</b> down from the mountains to Milan.']],
    imgs:['https://assets.purewow.com/wp-content/uploads/2024/03/things-to-do-in-milan_uni.jpg'] },

  // ── Part 1: The Greek Isles ──
  { loc:'Mykonos', nights:'2 Nights · Sept 14 → 16', stay:'Cali Mykonos', confirmed:true,
    in:{ date:'Sept 14', mode:'flight', note:'Milan → Mykonos' },
    logi:[['Transit','Fly Air Serbia from Milan on Sept 14, landing in Mykonos at <b>3:50 PM</b>.']],
    todo:[
      { a:'Dinner', t:'Apollo Restaurant', partner:'J/PR', img:'https://www.calimykonos.com/sites/default/files/2026-06/Cali-Apollo_dusk-1200x1600.jpg' }
    ],
    imgs:[
      'https://www.calimykonos.com/sites/default/files/2025-06/Cali_hotel_mykonos-beach-Missoni_beach_resort.jpg',
      'https://images.trvl-media.com/lodging/79000000/78280000/78277600/78277523/46c088bb.jpg?impolicy=resizecrop&rw=575&rh=575&ra=fill'] },

  { loc:'Santorini, Greece', nights:'2 Nights · Sept 16 → 18', stay:'Andronis Arcadia', confirmed:true,
    in:{ date:'Sept 16', mode:'ferry', note:'Ferry to Santorini' },
    logi:[['Transit','Ferry from Mykonos to Santorini, <b>11:30 AM → 1:40 PM</b>.']],
    imgs:[
      'https://media.cntraveler.com/photos/6638fe33e2d99e8ecd3db913/16:9/w_2560%2Cc_limit/Andronis%2520Arcadia%2C%2520Santorini_Pacman%25203_CREDIT%2520Tryfon%2520Georgopoulos.jpg',
      'https://cdn.sanity.io/images/nxpteyfv/goguides/9ca4581e7f31535984243dfa9c08c12c8a30ffeb-1600x1066.jpg'] },

  // ── Part 2: Switzerland, the Lakes & Slovenia ──
  { loc:'Zürich, Switzerland', nights:'1 Night · Sept 18 → 19', stay:'Private Stay', confirmed:true, noClient:true,
    in:{ date:'Sept 18', mode:'flight', note:'Santorini → Zürich' },
    logi:[['Transit','Fly from Santorini to <b>Zürich</b> on Sept 18.']],
    imgs:['https://cdn.inspiringvacations.com/254da5e5-5246-4cce-ab1a-0318212404aa.jpeg'] },

  { loc:'Andermatt, Switzerland', nights:'3 Nights · Sept 19 → 22', stay:'The Chedi Andermatt', client:'Quinn', inworks:true,
    in:{ date:'Sept 19', mode:'car', note:'Zürich → Andermatt' },
    logi:[['The Drive','<b>~1.5-hour drive</b> south from Zürich up the Reuss valley to Andermatt.']],
    imgs:[
      'https://d1pe873sdaunfo.cloudfront.net/www.thechediandermatt.com-1283389050/cms/cache/v2/634012f2b4525.jpg/1920x1080/resize/80/c84e42eddb769d1f14348e6b935cd5a5.jpg',
      'https://media.cntraveler.com/photos/6973c1dd1dfa66ef6df9ff7b/16:9/w_2560%2Cc_limit/The%2520Chedi%2520Andermatt-The_Chedi_Andermatt_Exterior_Winter_Impressions%2520(1)_1.jpg'] },

  { loc:'Lake Como, Italy', nights:'2 Nights · Sept 22 → 24', stayPending:'Looking for a partner', pending:true,
    in:{ date:'Sept 22', mode:'car', note:'Andermatt → Lake Como' },
    logi:[['The Drive','<b>~3-hour drive</b> south from Zürich, over the Alps and down to the lake.']],
    imgs:['https://imageio.forbes.com/specials-images/imageserve/646b6b45d9b20ac15900fd8a/0x0.jpg?format=jpg&height=900&width=1600&fit=bounds'] },

  { loc:'St. Moritz, Switzerland', nights:'1 Night · Sept 24 → 25', stayPending:'Looking for a partner', pending:true,
    in:{ date:'Sept 24', mode:'car', note:'Lake Como → St. Moritz' },
    logi:[['The Drive','<b>~2.5-hour climb</b> from Lake Como up the Maloja Pass into the Engadin.']],
    imgs:['https://assets.vogue.com/photos/65ccb18a486b55e585379e53/master/w_2560%2Cc_limit/GettyImages-1353085015.jpg'] },

  { loc:'Ljubljana, Slovenia', nights:'4 Nights · Sept 25 → 29', stay:'Private Stay', confirmed:true, noClient:true,
    in:{ date:'Sept 25', mode:'flight', note:'St. Moritz → Zürich Airport → Ljubljana' },
    logi:[['The Drive','<b>~2.5-hour drive</b> from St. Moritz to Zürich Airport.'],['Transit','Fly Zürich → <b>Ljubljana</b>. Fly home from Ljubljana on the 29th.']],
    todo:[
      { a:'Day Trip', t:'Lake Bled', img:'https://deih43ym53wif.cloudfront.net/osojnica-lake-bled-slovenia-shutterstock_339896984_dcc9309723.jpeg' }
    ],
    imgs:[
      'https://kayak-soca.com/wp-content/uploads/2023/07/1566500157333.jpg',
      'https://deih43ym53wif.cloudfront.net/osojnica-lake-bled-slovenia-shutterstock_339896984_dcc9309723.jpeg'] },

],
};

// Public-safe summary per trip (what an ungated visitor may see).
export const TRAVEL_PUBLIC = {
  california: { label: 'Pacific Coast Highway & Napa Valley', window: 'August 2026', region: 'California' },
  europe:     { label: 'Italy, the Alps & the Greek Isles', window: 'September 2026', region: 'Europe' },
};
