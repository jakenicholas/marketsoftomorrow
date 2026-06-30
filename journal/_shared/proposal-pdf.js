/*
  proposal-pdf.js — "Export PDF" button for media proposal pages.

  On click it builds a BESPOKE, page-per-section document (crisp vector text,
  on-brand dark, no site chrome) and prints it from an ISOLATED window — so the
  output is a clean ~700KB native PDF, NOT a screenshot of the scroll page and
  NOT bloated by the live page's loaded images.

  Shared media-kit content is baked in; per-proposal bits come from a
  <script type="application/json" id="tmw-proposal-config"> on the page:
    { "project":"619 Brickell", "prepared":"2026", "subtitle":"…",
      "campaign":{ "intro":"…", "deliverables":[{"q":"6×","t":"…"},{"t":"…"}],
        "price":"$21,000","priceNote":"…","term":"…","termNote":"…" },
      "cta":"…", "contactName":"Jake Nicholas","contactLine":"Founder & CEO · jake@oftmw.com" }
*/
(function () {
  'use strict';
  if (window.tmwProposalPDF) return;

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];}); }

  var cfg = {};
  try { var el = document.getElementById('tmw-proposal-config'); if (el) cfg = JSON.parse(el.textContent) || {}; } catch (e) {}
  var camp = cfg.campaign || {};
  var D = {
    project: cfg.project || 'Your Brand', prepared: cfg.prepared || '2026',
    subtitle: cfg.subtitle || ('A custom media campaign by Markets of Tomorrow, prepared for ' + (cfg.project || 'your brand') + '.'),
    campIntro: camp.intro || '', deliverables: camp.deliverables || [],
    price: camp.price || '', priceNote: camp.priceNote || '', term: camp.term || '', termNote: camp.termNote || 'Invoiced ahead of start',
    cta: cfg.cta || ('Ready to put ' + (cfg.project || 'your brand') + ' in front of buyers and millions of readers.'),
    contactName: cfg.contactName || 'Jake Nicholas', contactLine: cfg.contactLine || 'Founder & CEO · jake@oftmw.com'
  };
  var TIERS = cfg.tiers || [
    { lab:'Three-Month Gold', head:'Sustained presence, distilled.', price:'$9,000', items:[
      'Monthly collaborative post on our social accounts','Monthly website article / feature across Markets of Tomorrow',
      'Bi-weekly Instagram + Facebook story','Monthly highlighted feature in The Weekly newsletter',
      'Rotating banner ad across all website pages','Featured spotlight in our Database — Map, Atlas, TMW Intelligence' ] },
    { lab:'One-Time Blast', head:'One feature, one moment.', price:'$950', items:[
      'One collab social post across our channels','One original website article across Markets of Tomorrow','Instagram + Facebook story linked to your article' ] }
  ];

  // Live umbrella follower count (admin Followers tab → worker /followers),
  // prefetched on init so the PDF prints the current number. Falls back to the
  // last-known static value if the fetch hasn't landed.
  var LIVE = null;
  function fmtK(n){ n=Number(n)||0; if(n>=1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M'; if(n>=1e4) return Math.round(n/1e3)+'K'; if(n>=1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K'; return String(n); }
  function umbFull(){ return (LIVE && LIVE.umbrella) ? Number(LIVE.umbrella).toLocaleString() : '192,900'; }
  function umbK(){ return (LIVE && LIVE.umbrella) ? fmtK(LIVE.umbrella) : '192.9K'; }

  function delivHtml(){ return D.deliverables.map(function(d){ var lead = d.q ? '<span class="pdf-q">'+esc(d.q)+'</span>' : '<span class="pdf-dot"></span>'; return '<li>'+lead+'<span>'+esc(d.t)+'</span></li>'; }).join(''); }
  function tierHtml(t){ return '<div class="pdf-card"><div class="pdf-tierlab">'+esc(t.lab)+'</div><div class="pdf-tierhead">'+esc(t.head)+'</div><div class="pdf-price" style="font-size:34px;margin:6px 0 14px">'+esc(t.price)+'</div><ul class="pdf-deliv" style="font-size:13px">'+ t.items.map(function(i){return '<li><span class="pdf-dot"></span><span>'+esc(i)+'</span></li>';}).join('') +'</ul></div>'; }
  function metric(n,t,a,al,b,bl){ return '<div class="pdf-card pdf-metric"><div class="n">'+n+'</div><div class="t">'+t+'</div><div class="row"><span><b>'+a+'</b>'+al+'</span><span style="text-align:right"><b>'+b+'</b>'+bl+'</span></div></div>'; }
  function lens(lab,desc,a,al,b,bl){ return '<div class="pdf-card"><div class="pdf-tierlab">'+lab+'</div><div class="pdf-sub" style="margin:6px 0 16px">'+desc+'</div><div class="pdf-kv"><b>'+a+'</b> '+al+'</div><div class="pdf-kv" style="margin-top:6px"><b>'+b+'</b> '+bl+'</div></div>'; }
  function ft(n){ return '<div class="pdf-foot"><span>'+esc(D.project)+' × Markets of Tomorrow</span><span class="pdf-gn">'+n+'</span></div>'; }

  function buildPages(){
    return ''+
    '<section class="pdf-page pdf-cover"><div class="pdf-brand">Markets of Tomorrow · Media Kit</div><div class="pdf-cap">A custom campaign proposal</div><h1 class="pdf-h1" style="font-size:96px">'+esc(D.project).replace(/\s+/, '<br>')+'</h1><div class="pdf-rule"></div><div class="pdf-csub">'+esc(D.subtitle)+'</div><div class="pdf-meta"><span>Prepared '+esc(D.prepared)+'</span><span>oftmw.com · @marketsoftomorrow</span></div></section>'+
    '<section class="pdf-page"><div class="pdf-eyebrow">The Network</div><h2 class="pdf-h2">A powerhouse news network<br>+ data platform</h2><p class="pdf-lead">A reach snapshot across every outlet — the audience, the engagement, and the markets where it all lands.</p><div style="height:18px"></div><div class="pdf-grid pdf-g2"><div class="pdf-card pdf-stat"><div class="n">8.1M</div><div class="l">Monthly social views</div></div><div class="pdf-card pdf-stat"><div class="n">'+umbFull()+'</div><div class="l">Total followers</div></div><div class="pdf-card pdf-stat"><div class="n">593,180</div><div class="l">Monthly web impressions</div></div><div class="pdf-card pdf-stat"><div class="n">15,700</div><div class="l">Newsletter subscribers</div></div></div><div style="height:26px"></div><div class="pdf-eyebrow">Who’s watching</div><div class="pdf-grid pdf-g2" style="gap:10px 28px"><div class="pdf-kv"><b>46%</b> &nbsp;Realtors &amp; brokers</div><div class="pdf-kv"><b>7%</b> &nbsp;Influencers</div><div class="pdf-kv"><b>21%</b> &nbsp;Business owners</div><div class="pdf-kv"><b>6%</b> &nbsp;Designers</div></div><div style="height:18px"></div><div class="pdf-eyebrow">Who’s reading</div><p class="pdf-sub">Founders, brokers, agents, developers, designers, hospitality leaders, and creators — across real estate, architecture, affluent buyers, wellness, and tech.</p><div class="pdf-spacer"></div>'+ft('01')+'</section>'+
    '<section class="pdf-page"><div class="pdf-eyebrow">Reach Without Borders</div><h2 class="pdf-h2">A global footprint</h2><p class="pdf-lead">With hyper-focus markets in Florida, New York, Tennessee, the Caribbean, and the Rockies — we also showcase global travel through our Hotels of Tomorrow outlet, and standout experiences through our Iconic Lists.</p><div style="height:18px"></div><div class="pdf-grid pdf-g2"><div class="pdf-card pdf-stat"><div class="n">40+</div><div class="l">Markets tracked worldwide</div></div><div class="pdf-card pdf-stat"><div class="n">8.1M</div><div class="l">Monthly views, globally</div></div></div><div style="height:26px"></div><div class="pdf-eyebrow">Where our audience lives</div><div class="pdf-chips">'+['Florida','Manhattan','Nashville','Charleston','The Caribbean','Utah','Colorado','Wyoming','Los Angeles','Chicago','London','Paris','Rome','Tokyo','Dubai'].map(function(c,i,a){return '<span>'+c+'</span>'+(i<a.length-1?'<span class="sep">/</span>':'');}).join('')+'</div><div class="pdf-spacer"></div>'+ft('02')+'</section>'+
    '<section class="pdf-page"><div class="pdf-eyebrow">All Markets · Combined Data</div><h2 class="pdf-h2">The full reach, by the numbers</h2><div style="height:16px"></div><div class="pdf-grid pdf-g2">'+metric('8,145,000','Monthly social media views','76%','instagram','10%','linkedin')+metric(umbFull(),'Total social media followers','80%','instagram','10%','linkedin')+metric('593,180','Monthly website impressions','31%','ai + google','60%','direct + social')+metric('65,850','Avg. Instagram post views','600K','average max','20K','average low')+metric('1,700','Avg. Instagram post shares','200','story shares','1,500','message shares')+metric('15,700','Total newsletter subscribers','33%','open rate','6.5%','click rate')+'</div><div style="height:18px"></div><div class="pdf-grid pdf-g3"><div class="pdf-card pdf-stat" style="padding:16px 20px"><div class="n" style="font-size:24px">42×</div><div class="l">Views-to-follower ratio</div></div><div class="pdf-card pdf-stat" style="padding:16px 20px"><div class="n" style="font-size:24px">2.6%</div><div class="l">Avg. share rate</div></div><div class="pdf-card pdf-stat" style="padding:16px 20px"><div class="n" style="font-size:24px">2M→20M</div><div class="l">Reach growth, ’25→’26 proj.</div></div></div><div class="pdf-spacer"></div>'+ft('03')+'</section>'+
    '<section class="pdf-page"><div class="pdf-eyebrow">One Network · Three Formats</div><h2 class="pdf-h2">Every market, three ways</h2><p class="pdf-lead">One network, told through three lenses — the journal, the socials, and the live database.</p><div style="height:18px"></div><div class="pdf-grid pdf-g3">'+lens('The Journal','Original reporting on what’s getting built, published across Markets of Tomorrow.','593K','mo. web','250+','projects')+lens('The Socials','A network of accounts sharing every project and story as one.',umbK(),'followers','8.1M','mo. views')+lens('The Database','The live map + Atlas of new development, powered by TMW Intelligence.','250+','mapped','40+','markets')+'</div><div style="height:26px"></div><div class="pdf-card" style="background:#0d100d"><div class="pdf-eyebrow" style="margin-bottom:8px">Our monthly reach</div><div style="font-family:var(--pdf-serif);font-size:22px;color:#fff;font-weight:500">Growing every month</div><p class="pdf-sub" style="margin-top:8px">Monthly impressions have climbed from 2M to a projected <span style="color:#42EB81">20M</span> by year-end 2026. Be part of the journey.</p></div><div class="pdf-spacer"></div>'+ft('04')+'</section>'+
    '<section class="pdf-page"><div class="pdf-eyebrow">Partners of Tomorrow</div><h2 class="pdf-h2">In good company</h2><p class="pdf-lead">We’re grateful to work with some incredible brands across real estate, hospitality, and lifestyle.</p><div style="height:20px"></div><div class="pdf-grid pdf-g2" style="gap:12px">'+['Little Palm Island','Andaz Hotels & Resorts','Four Seasons','Related Ross','Brightline','One Aldwych, London','Pendry Residences','Tapestry Collection by Hilton'].map(function(b){return '<div class="pdf-card" style="text-align:center;padding:18px">'+esc(b)+'</div>';}).join('')+'</div><div style="height:16px"></div><p class="pdf-sub" style="text-align:center"><span style="color:#42EB81;font-weight:600">250+</span> brands and counting.</p><div class="pdf-spacer"></div>'+ft('05')+'</section>'+
    '<section class="pdf-page"><div class="pdf-eyebrow">Your Campaign</div><h2 class="pdf-h2">What we’ll provide</h2>'+(D.campIntro?'<p class="pdf-lead">'+esc(D.campIntro)+'</p>':'')+'<div style="height:14px"></div><ul class="pdf-deliv">'+delivHtml()+'</ul><div style="height:18px"></div><div class="pdf-card" style="display:flex;justify-content:space-between;align-items:flex-end"><div><div class="pdf-tierlab">Investment</div><div class="pdf-price">'+esc(D.price)+'</div>'+(D.priceNote?'<div class="pdf-sub" style="margin-top:6px">'+esc(D.priceNote)+'</div>':'')+'</div><div style="text-align:right"><div class="pdf-kv" style="text-transform:uppercase;letter-spacing:.14em">Term</div><div style="font-family:var(--pdf-serif);font-size:17px;color:#fff;margin-top:4px">'+esc(D.term)+'</div>'+(D.termNote?'<div class="pdf-sub" style="margin-top:4px">'+esc(D.termNote)+'</div>':'')+'</div></div><div class="pdf-spacer"></div>'+ft('06')+'</section>'+
    '<section class="pdf-page"><div class="pdf-eyebrow">Other Ways to Partner</div><h2 class="pdf-h2">Flexible by design</h2><div style="height:16px"></div>'+TIERS.map(tierHtml).join('<div style="height:14px"></div>')+'<div class="pdf-spacer"></div>'+ft('07')+'</section>'+
    '<section class="pdf-page" style="justify-content:center"><div class="pdf-eyebrow">Let’s Build the Future Together</div><h1 class="pdf-h1" style="font-size:44px;color:#fff;max-width:18ch">'+esc(D.cta)+'</h1><div class="pdf-rule" style="margin:26px 0 30px"></div><div class="pdf-eyebrow" style="margin-bottom:8px">Contact</div><div style="font-family:var(--pdf-serif);font-size:24px;color:#fff;font-weight:500">'+esc(D.contactName)+'</div><div class="pdf-sub" style="margin-top:4px">'+esc(D.contactLine)+'</div><div class="pdf-spacer"></div><div class="pdf-foot"><span>Markets of Tomorrow · Florida of Tomorrow LLC · West Palm Beach, FL</span><span class="pdf-gn">oftmw.com · @marketsoftomorrow</span></div></section>';
  }

  var DOC_CSS =
'@import url("https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,300&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap");'+
':root{--pdf-serif:"Fraunces",Georgia,serif;--pdf-sans:"Inter",-apple-system,sans-serif;--pdf-mono:"JetBrains Mono",ui-monospace,monospace}'+
'@page{size:Letter;margin:0}'+
'*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;text-shadow:none}'+
'html,body{margin:0;background:#0a0c0a;color:#ECEAE5;font-family:var(--pdf-sans);font-weight:300}'+
'.pdf-page{width:8.5in;min-height:10.3in;padding:0.55in 0.72in;page-break-after:always;display:flex;flex-direction:column;background:#0a0c0a;position:relative}'+
'.pdf-page:last-child{page-break-after:auto}'+
'.pdf-eyebrow{font-family:var(--pdf-mono);font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#1FDF67;font-weight:500;margin-bottom:14px}'+
'.pdf-h1{font-family:var(--pdf-serif);font-weight:600;letter-spacing:-.02em;line-height:1.0;margin:0;color:#fff}'+
'.pdf-h2{font-family:var(--pdf-serif);font-weight:600;font-size:34px;letter-spacing:-.02em;line-height:1.08;color:#fff;margin:0 0 14px}'+
'.pdf-lead{font-family:var(--pdf-serif);font-weight:300;font-style:italic;font-size:16px;line-height:1.5;color:#C2C9C3;max-width:62ch;margin:0 0 4px}'+
'.pdf-sub{font-size:13.5px;line-height:1.55;color:#C2C9C3;max-width:64ch;font-weight:300}'+
'.pdf-grid{display:grid;gap:14px}.pdf-g2{grid-template-columns:1fr 1fr}.pdf-g3{grid-template-columns:1fr 1fr 1fr}'+
'.pdf-card{background:#101410;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:22px 24px;break-inside:avoid}'+
'.pdf-stat .n{font-family:var(--pdf-serif);font-weight:600;font-size:34px;line-height:1;color:#42EB81}'+
'.pdf-stat .l{font-family:var(--pdf-mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#9AA39C;margin-top:9px}'+
'.pdf-metric .n{font-family:var(--pdf-serif);font-weight:600;font-size:26px;color:#42EB81;line-height:1}'+
'.pdf-metric .t{font-size:12.5px;color:#fff;font-weight:400;margin:6px 0 12px}'+
'.pdf-metric .row{display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,.12);padding-top:9px;font-family:var(--pdf-mono);font-size:9px;letter-spacing:.06em;color:#9AA39C}'+
'.pdf-metric .row b{display:block;font-family:var(--pdf-sans);font-size:13px;font-weight:600;color:#ECEAE5;letter-spacing:0}'+
'.pdf-spacer{flex:1}'+
'.pdf-foot{display:flex;justify-content:space-between;align-items:center;font-family:var(--pdf-mono);font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:#5f655f;border-top:1px solid rgba(255,255,255,.12);padding-top:12px;margin-top:26px}'+
'.pdf-foot .pdf-gn{color:#1FDF67}'+
'ul.pdf-deliv{list-style:none;margin:0;padding:0}'+
'ul.pdf-deliv li{display:flex;gap:12px;align-items:flex-start;padding:9px 0;font-size:13.5px;color:#ECEAE5;font-weight:400;border-bottom:1px solid rgba(255,255,255,.06)}'+
'ul.pdf-deliv li:last-child{border-bottom:0}'+
'.pdf-dot{width:6px;height:6px;border-radius:50%;background:#1FDF67;margin-top:7px;flex:none}'+
'.pdf-q{font-family:var(--pdf-mono);font-size:11px;color:#42EB81;font-weight:700;min-width:30px}'+
'.pdf-price{font-family:var(--pdf-serif);font-weight:600;font-size:44px;color:#fff;letter-spacing:-.02em;line-height:1}'+
'.pdf-tierlab{font-family:var(--pdf-mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#1FDF67;margin-bottom:8px}'+
'.pdf-tierhead{font-family:var(--pdf-serif);font-size:22px;color:#fff;font-weight:500;margin-bottom:2px}'+
'.pdf-chips{display:flex;flex-wrap:wrap;gap:8px 10px;font-family:var(--pdf-serif);font-size:15px;color:#C2C9C3;line-height:1.6}'+
'.pdf-chips .sep{color:#1FDF67;opacity:.6}'+
'.pdf-kv{font-family:var(--pdf-mono);font-size:11px;color:#9AA39C;letter-spacing:.04em}'+
'.pdf-kv b{font-family:var(--pdf-sans);color:#ECEAE5;font-weight:600;font-size:13px}'+
'.pdf-cover{justify-content:center}'+
'.pdf-cover .pdf-brand{font-family:var(--pdf-mono);font-size:11px;letter-spacing:.26em;text-transform:uppercase;color:#1FDF67;position:absolute;top:.55in;left:.72in}'+
'.pdf-cover .pdf-cap{font-family:var(--pdf-mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#1FDF67;margin-bottom:20px}'+
'.pdf-rule{width:64px;height:4px;background:#1FDF67;border-radius:2px;margin:18px 0 26px}'+
'.pdf-cover .pdf-csub{font-family:var(--pdf-serif);font-style:italic;font-weight:300;font-size:20px;color:#C2C9C3;max-width:30ch;line-height:1.4}'+
'.pdf-cover .pdf-meta{position:absolute;bottom:.55in;left:.72in;right:.72in;display:flex;justify-content:space-between;font-family:var(--pdf-mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#5f655f;border-top:1px solid rgba(255,255,255,.12);padding-top:14px}';

  function exportPDF(){
    var title = D.project + ' — Markets of Tomorrow';
    var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>'+esc(title)+'</title><style>'+DOC_CSS+'</style></head><body>'+buildPages()+
      '<scr'+'ipt>(function(){function p(){setTimeout(function(){window.focus();window.print();},120);} if(document.fonts&&document.fonts.ready){document.fonts.ready.then(p);setTimeout(p,1500);}else{window.addEventListener("load",function(){setTimeout(p,500);});}})();</scr'+'ipt>'+
      '</body></html>';
    var w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups for this site to export the PDF.'); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  function injectBtnCss(){
    if (document.getElementById('tmw-pdfbtn-css')) return;
    var st=document.createElement('style'); st.id='tmw-pdfbtn-css';
    st.textContent='.tmw-pdf-btn{position:fixed;right:20px;bottom:20px;z-index:99996;display:inline-flex;align-items:center;gap:8px;background:#1FDF67;color:#06210f;border:0;border-radius:999px;padding:13px 20px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.4),0 0 0 1px rgba(31,223,103,.3);transition:background .15s}'+
      '.tmw-pdf-btn:hover{background:#42EB81}@media(max-width:560px){.tmw-pdf-btn{right:12px;bottom:12px;padding:11px 16px;font-size:11px}}@media print{.tmw-pdf-btn{display:none!important}}';
    document.head.appendChild(st);
  }
  function init(){
    injectBtnCss();
    // Prefetch live follower counts so an Export prints the current umbrella total.
    fetch('https://tmw.jake-ab7.workers.dev/followers', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; }).then(function(d){ if (d) LIVE = d; }).catch(function(){});
    var btn=document.createElement('button'); btn.type='button'; btn.className='tmw-pdf-btn';
    btn.innerHTML='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 11l5 4 5-4M5 21h14"/></svg> Export PDF';
    btn.addEventListener('click', exportPDF);
    document.body.appendChild(btn);
    window.tmwProposalPDF = { export: exportPDF };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
