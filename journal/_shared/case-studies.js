/* TMW Proven Results — shared, synced case-study module. Mount with:
     <div data-tmw-cases data-match="florida,luxury-condo,west-palm-beach" data-limit="2"></div>
     <script src="/_shared/case-studies.js" defer></script>
   Injects scoped styles once + a "Proven Results" section into every mount:
   one featured case study (best match to data-match tags) + up to data-limit
   compact cards, ranked by tag overlap. Edit the STUDIES array below to add a
   client — it flows to every proposal that embeds this. Optional attrs:
     data-match     comma tags describing the prospect (city, asset type, state)
     data-limit     max compact cards after the featured one (default 2)
     data-headline  overrides the <em> phrase, e.g. "a comparable Brickell tower"
   Full results reports are PRIVATE — this module never links to them. Each card
   shows reach + media value + engagement + a media-spend tile + months active. */
(function(){
  'use strict';

  /* ── the library — one entry per client. Canonical fields below. ───────── */
  var STUDIES = [
    {
      badge:'PP', name:'Ponce Park Residences', sub:'The Allen Morris Company · Coral Gables, FL',
      tags:['florida','south-florida','luxury-condo','condo','coral-gables','miami'],
      pills:['Luxury Condo','South Florida'],
      status:'active', months:7,
      impressions:'3.3M', mediaValue:'$98.6K', ctr:'1.49%', spend:'$33.75K',
      quote:'Halfway through a 14-month program, Ponce Park has reached <b>3.3M affluent buyers</b>, driven <b>7,229 clicks</b> to their sales site, and earned <b>~$99K in media value</b> &mdash; a 1.49% newsletter CTR into a 46%-realtor audience.'
    },
    {
      badge:'WA', name:'Waldorf Astoria Residences', sub:'St. Petersburg, FL · Tampa Bay · Branded Residences',
      tags:['florida','tampa-bay','st-petersburg','st-pete','luxury-condo','condo','branded-residences','hotel'],
      pills:['Branded Residences','St. Petersburg'],
      status:'active', months:4,
      impressions:'1.87M', mediaValue:'$57.6K', ctr:'1.43%', spend:'$19.8K',
      quote:'Four months into its campaign, Waldorf Astoria Residences has reached <b>1.87M affluent buyers</b> and earned <b>~$58K in media value</b> &mdash; a 1.43% newsletter CTR, with the program still running.'
    },
    {
      badge:'TB', name:'The Berkeley', sub:'West Palm Beach, FL · Luxury Condo',
      tags:['florida','south-florida','palm-beaches','west-palm-beach','wpb','luxury-condo','condo'],
      pills:['Luxury Condo','West Palm Beach'],
      status:'complete', months:10,
      impressions:'4.58M', mediaValue:'$132.4K', ctr:'1.54%', spend:'$46.5K',
      quote:'Across a completed 10-month program, The Berkeley reached <b>4.58M affluent buyers</b> and earned <b>~$132K in media value</b> &mdash; a 1.54% newsletter CTR that kept the tower top-of-mind through sell-out.'
    },
    {
      badge:'MO', name:'Mandarin Oriental Residences', sub:'West Palm Beach, FL · Branded Residences',
      tags:['florida','south-florida','luxury-condo','condo','branded-residences','hotel','west-palm-beach','wpb','palm-beaches'],
      pills:['Branded Residences','West Palm Beach'],
      status:'active', months:1,
      impressions:'381K', mediaValue:'$11.4K', ctr:'1.11%', spend:'$6K',
      quote:'Just one month in, Mandarin Oriental Residences has reached <b>381K affluent buyers</b> at a <b>$15.74 CPM</b> &mdash; a 1.11% newsletter CTR, with the campaign only getting started.'
    }
  ];

  var HUB = 'https://www.oftmw.com/media/';   // "dive into our live data" target

  var CSS = `
.tmw-cases{--white:#fff;--cream:#ECEAE5;--mute:#8b958d;--mute2:#C2C9C3;--hair:rgba(255,255,255,.08);--hair2:rgba(255,255,255,.14);
  --green:#1FDF67;--green-soft:#42EB81;--purple:#A78BFA;--purple-glow:#B9A6FF;--gold:#e6c574;--gold-soft:#f0d68a;
  --cs-sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--cs-serif:'Fraunces',Georgia,serif;--cs-mono:'Inter',sans-serif;
  position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:64px 32px;color:var(--cream);font-family:var(--cs-sans)}
.tmw-cases *{box-sizing:border-box}
.tmw-cases .cs-eyebrow{display:inline-flex;align-items:center;gap:9px;font-family:var(--cs-mono);font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--green-soft);margin-bottom:14px}
.tmw-cases .cs-eyebrow::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green)}
.tmw-cases h2.cs-h{font-family:var(--cs-serif);font-weight:500;font-size:clamp(26px,3.2vw,38px);letter-spacing:-.02em;line-height:1.07;color:#fff;margin:0 0 10px}
.tmw-cases h2.cs-h em{font-style:italic;color:var(--gold-soft);font-weight:500}
.tmw-cases .cs-sub{font-family:var(--cs-serif);font-style:italic;font-weight:300;font-size:17px;color:var(--mute2);margin:0 0 28px;max-width:62ch}
.tmw-cases .cs-card{position:relative;border:1px solid var(--hair2);border-radius:18px;overflow:hidden;background:linear-gradient(180deg,rgba(230,197,116,.05),rgba(20,23,20,.55));box-shadow:0 30px 80px rgba(0,0,0,.5)}
.tmw-cases .cs-top{display:flex;align-items:center;gap:14px;padding:22px 26px 18px;border-bottom:1px solid var(--hair)}
.tmw-cases .cs-badge{flex:0 0 auto;width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(230,197,116,.12);border:1px solid rgba(230,197,116,.32);font-family:var(--cs-serif);font-weight:600;font-size:18px;color:var(--gold-soft)}
.tmw-cases .cs-name{font-family:var(--cs-serif);font-weight:600;font-size:21px;color:#fff;line-height:1.1}
.tmw-cases .cs-namesub{font-family:var(--cs-mono);font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--mute);margin-top:3px}
.tmw-cases .cs-pills{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.tmw-cases .cs-pill{font-family:var(--cs-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--purple-glow);border:1px solid rgba(167,139,250,.32);border-radius:999px;padding:5px 11px;white-space:nowrap}
.tmw-cases .cs-pill.live{color:var(--green-soft);border-color:rgba(31,223,103,.35)}
.tmw-cases .cs-pill.done{color:var(--gold-soft);border-color:rgba(230,197,116,.4)}
.tmw-cases .cs-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--hair);border-bottom:1px solid var(--hair)}
.tmw-cases .cs-metric{background:#0d0f0d;padding:20px 26px}
.tmw-cases .cs-mn{font-family:var(--cs-serif);font-weight:600;font-size:clamp(24px,2.8vw,34px);letter-spacing:-.02em;color:var(--green-soft);line-height:1}
.tmw-cases .cs-mn.gold{color:var(--gold-soft)}
.tmw-cases .cs-ml{font-family:var(--cs-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute2);margin-top:9px}
.tmw-cases .cs-body{display:flex;align-items:center;gap:24px;padding:20px 26px}
.tmw-cases .cs-quote{font-family:var(--cs-serif);font-style:italic;font-weight:300;font-size:16.5px;line-height:1.5;color:var(--cream);margin:0}
.tmw-cases .cs-quote b{font-style:normal;font-weight:500;color:#fff}
.tmw-cases .cs-spend{flex:0 0 auto;text-align:center;border:1px solid rgba(230,197,116,.35);border-radius:14px;background:rgba(230,197,116,.06);padding:15px 24px;min-width:158px}
.tmw-cases .cs-spend-l{font-family:var(--cs-mono);font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-soft);margin-bottom:7px}
.tmw-cases .cs-spend-n{font-family:var(--cs-serif);font-weight:600;font-size:27px;color:#fff;line-height:1}
.tmw-cases .cs-spend-sub{font-family:var(--cs-mono);font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--mute2);margin-top:8px}
.tmw-cases .cs-also{font-family:var(--cs-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin:26px 0 12px}
.tmw-cases .cs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.tmw-cases .cs-cc{border:1px solid var(--hair);border-radius:14px;background:rgba(255,255,255,.02);padding:16px 17px;color:inherit;display:flex;flex-direction:column;text-decoration:none}
.tmw-cases a.cs-cc{transition:border-color .2s}
.tmw-cases a.cs-cc:hover{border-color:rgba(230,197,116,.4)}
.tmw-cases .cs-cctop{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.tmw-cases .cs-badge.sm{width:34px;height:34px;font-size:13px;border-radius:9px}
.tmw-cases .cs-ccname{font-family:var(--cs-serif);font-weight:600;font-size:14.5px;color:#fff;line-height:1.15}
.tmw-cases .cs-ccsub{font-family:var(--cs-mono);font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:var(--mute);margin-top:2px}
.tmw-cases .cs-ccm{display:flex;gap:16px}
.tmw-cases .cs-ccm div{display:flex;flex-direction:column}
.tmw-cases .cs-ccm b{font-family:var(--cs-serif);font-weight:600;font-size:19px;color:var(--green-soft);line-height:1}
.tmw-cases .cs-ccm b.gold{color:var(--gold-soft)}
.tmw-cases .cs-ccm b.cream{color:var(--cream)}
.tmw-cases .cs-ccm span{font-family:var(--cs-mono);font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin-top:6px}
.tmw-cases .cs-ccfoot{font-family:var(--cs-mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin-top:12px;padding-top:11px;border-top:1px solid var(--hair)}
.tmw-cases .cs-ccfoot .on{color:var(--green-soft)}
.tmw-cases .cs-cc.ghost{border-style:dashed;align-items:center;justify-content:center;text-align:center;color:var(--mute)}
.tmw-cases .cs-cc.ghost .g-n{font-family:var(--cs-serif);font-style:italic;font-size:16px;color:var(--mute2)}
.tmw-cases .cs-cc.ghost .g-l{font-family:var(--cs-mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;margin-top:6px}
.tmw-cases .cs-trust{display:flex;align-items:center;gap:16px;margin-top:24px;padding-top:20px;border-top:1px solid var(--hair)}
.tmw-cases .cs-trust .lbl{font-family:var(--cs-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);white-space:nowrap}
.tmw-cases .cs-trust .names{font-family:var(--cs-sans);font-size:13px;color:var(--mute2)}
.tmw-cases .cs-trust .names b{color:var(--cream);font-weight:600}
@media(max-width:720px){.tmw-cases{padding:44px 20px}.tmw-cases .cs-grid{grid-template-columns:1fr}.tmw-cases .cs-body{flex-direction:column;align-items:flex-start}.tmw-cases .cs-pills{display:none}}
`;

  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function score(st, m){ var s=0; for (var i=0;i<m.length;i++){ if (st.tags.indexOf(m[i])!==-1) s++; } return s; }
  function statusPill(st){
    return st.status==='active'
      ? '<span class="cs-pill live">Campaign Active</span>'
      : '<span class="cs-pill done">Campaign Complete</span>';
  }
  function durLabel(st){
    return st.months+' month'+(st.months===1?'':'s')+(st.status==='active'?' active':' · complete');
  }

  function featuredHTML(st){
    var pills = st.pills.map(function(p){ return '<span class="cs-pill">'+esc(p)+'</span>'; }).join('') + statusPill(st);
    var metrics =
      '<div class="cs-metric"><div class="cs-mn">'+st.impressions+'</div><div class="cs-ml">Total impressions</div></div>'+
      '<div class="cs-metric"><div class="cs-mn gold">'+st.mediaValue+'</div><div class="cs-ml">Est. media value</div></div>'+
      '<div class="cs-metric"><div class="cs-mn">'+st.ctr+'</div><div class="cs-ml">Newsletter CTR</div></div>';
    return ''+
    '<div class="cs-card">'+
      '<div class="cs-top">'+
        '<div class="cs-badge">'+esc(st.badge)+'</div>'+
        '<div><div class="cs-name">'+esc(st.name)+'</div><div class="cs-namesub">'+esc(st.sub)+'</div></div>'+
        '<div class="cs-pills">'+pills+'</div>'+
      '</div>'+
      '<div class="cs-metrics">'+metrics+'</div>'+
      '<div class="cs-body">'+
        '<p class="cs-quote">'+st.quote+'</p>'+
        '<div class="cs-spend"><div class="cs-spend-l">Media Spend</div><div class="cs-spend-n">'+st.spend+'</div><div class="cs-spend-sub">'+durLabel(st)+'</div></div>'+
      '</div>'+
    '</div>';
  }

  function compactHTML(st){
    return '<div class="cs-cc">'+
      '<div class="cs-cctop"><span class="cs-badge sm">'+esc(st.badge)+'</span>'+
      '<div><div class="cs-ccname">'+esc(st.name)+'</div><div class="cs-ccsub">'+esc(st.sub)+'</div></div></div>'+
      '<div class="cs-ccm">'+
        '<div><b>'+st.impressions+'</b><span>Impressions</span></div>'+
        '<div><b class="gold">'+st.mediaValue+'</b><span>Media value</span></div>'+
        '<div><b class="cream">'+st.spend+'</b><span>Spend</span></div>'+
      '</div>'+
      '<div class="cs-ccfoot"><span'+(st.status==='active'?' class="on"':'')+'>'+durLabel(st)+'</span></div>'+
    '</div>';
  }

  function render(mount){
    var matchTags = (mount.getAttribute('data-match')||'').toLowerCase().split(',').map(function(t){return t.trim();}).filter(Boolean);
    var limit = parseInt(mount.getAttribute('data-limit')||'2', 10);
    var headline = mount.getAttribute('data-headline') || 'developers like you';

    var ranked = STUDIES.map(function(st){ return {st:st, s:score(st, matchTags)}; })
      .sort(function(a,b){ return b.s - a.s; }).map(function(x){ return x.st; });
    if (!ranked.length) return;

    var featured = ranked[0];
    var rest = ranked.slice(1, 1+Math.max(0,limit));
    var compact = rest.map(compactHTML).join('');
    compact += '<a class="cs-cc ghost" href="'+esc(HUB)+'"><div class="g-n">Dive into our live data</div><div class="g-l">Explore the network &rarr;</div></a>';

    mount.className += ' tmw-cases';
    mount.innerHTML = ''+
      '<div class="cs-eyebrow">Proven Results</div>'+
      '<h2 class="cs-h">What we delivered for <em>'+esc(headline)+'</em></h2>'+
      '<p class="cs-sub">Before the numbers below, here&rsquo;s a real luxury campaign on the network &mdash; matched to your market and asset type.</p>'+
      featuredHTML(featured)+
      '<div class="cs-also">More proof in your market</div>'+
      '<div class="cs-grid">'+compact+'</div>'+
      '<div class="cs-trust"><span class="lbl">Trusted by</span><span class="names"><b>250+ development &amp; hospitality partners</b> across 40+ markets</span></div>';
  }

  function init(){
    if (!document.getElementById('tmw-cases-css')){
      var s = document.createElement('style'); s.id='tmw-cases-css'; s.textContent=CSS; document.head.appendChild(s);
    }
    var mounts = document.querySelectorAll('[data-tmw-cases]');
    for (var i=0;i<mounts.length;i++){ if (!mounts[i].__csDone){ mounts[i].__csDone=1; render(mounts[i]); } }
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
