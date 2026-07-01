/* TMW Proven Results — shared, synced case-study module. Mount with:
     <div data-tmw-cases data-match="florida,luxury-condo,west-palm-beach" data-limit="2"></div>
     <script src="/_shared/case-studies.js" defer></script>
   Injects scoped styles once + a "Proven Results" section into every mount:
   one featured case study (best match to data-match tags) + up to data-limit
   compact cards, ranked by tag overlap. Edit the STUDIES array below to add a
   client — it flows to every proposal that embeds this, and (later) to the
   public /media/case-studies/ hub. Optional attrs:
     data-match   comma tags describing the prospect (city, asset type, state)
     data-limit   max compact cards after the featured one (default 2)
     data-headline  overrides the <em> phrase, e.g. "a comparable Brickell tower"
   NOTE: client spend is deliberately omitted — these cards appear in other
   clients' proposals, so we show reach + media value + engagement, never cost. */
(function(){
  'use strict';

  /* ── the library — one entry per closed client ─────────────────────────── */
  var STUDIES = [
    {
      badge:'PP', name:'Ponce Park Residences', sub:'The Allen Morris Company · Coral Gables, FL',
      tags:['florida','south-florida','luxury-condo','condo','coral-gables','miami','active'],
      pills:['Luxury Condo','South Florida',{t:'Campaign Active',live:true}],
      metrics:[
        {n:'3.3M', l:'Total impressions'},
        {n:'$98.6K', l:'Est. media value', gold:true},
        {n:'1.49%', l:'Newsletter CTR'}
      ],
      quote:'Halfway through a 14-month program, Ponce Park has reached <b>3.3M affluent buyers</b>, driven <b>7,229 clicks</b> to their sales site, and earned <b>~$99K in media value</b> &mdash; a 1.49% newsletter CTR into a 46%-realtor audience.',
      compact:[{n:'3.3M',l:'Impressions'},{n:'$98.6K',l:'Media value',gold:true},{n:'7,229',l:'Site clicks'}],
      url:'https://www.oftmw.com/media/ponce-park/'
    },
    {
      badge:'MO', name:'Mandarin Oriental Residences', sub:'West Palm Beach, FL · Branded Residences',
      tags:['florida','south-florida','luxury-condo','condo','branded-residences','hotel','west-palm-beach','wpb','palm-beaches','active'],
      pills:['Branded Residences','West Palm Beach',{t:'Campaign Active',live:true}],
      metrics:[
        {n:'381K', l:'Total impressions'},
        {n:'$11.4K', l:'Est. media value', gold:true},
        {n:'1.11%', l:'Newsletter CTR'}
      ],
      quote:'In its first month, Mandarin Oriental Residences reached <b>381K affluent buyers</b> at a <b>$15.74 CPM</b> and drove <b>1,627 clicks</b> &mdash; a 1.11% newsletter CTR, with two of three months still to run.',
      compact:[{n:'381K',l:'Impressions'},{n:'$11.4K',l:'Media value',gold:true},{n:'1.11%',l:'News. CTR'}],
      url:'https://www.oftmw.com/media/mandarin-oriental-residences-wpb/'
    }
  ];

  var HUB = 'https://www.oftmw.com/media/';   // "browse all" target (swap to /media/case-studies/ when live)

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
.tmw-cases .cs-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--hair);border-bottom:1px solid var(--hair)}
.tmw-cases .cs-metric{background:#0d0f0d;padding:20px 26px}
.tmw-cases .cs-mn{font-family:var(--cs-serif);font-weight:600;font-size:clamp(24px,2.8vw,34px);letter-spacing:-.02em;color:var(--green-soft);line-height:1}
.tmw-cases .cs-mn.gold{color:var(--gold-soft)}
.tmw-cases .cs-ml{font-family:var(--cs-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute2);margin-top:9px}
.tmw-cases .cs-body{display:flex;align-items:center;gap:24px;padding:20px 26px}
.tmw-cases .cs-quote{font-family:var(--cs-serif);font-style:italic;font-weight:300;font-size:16.5px;line-height:1.5;color:var(--cream);margin:0}
.tmw-cases .cs-quote b{font-style:normal;font-weight:500;color:#fff}
.tmw-cases .cs-cta{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;font-family:var(--cs-mono);font-size:12px;font-weight:700;letter-spacing:.03em;color:#1a1505;background:linear-gradient(135deg,var(--gold-soft),var(--gold));border-radius:10px;padding:13px 18px;text-decoration:none;white-space:nowrap}
.tmw-cases .cs-also{font-family:var(--cs-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin:26px 0 12px}
.tmw-cases .cs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.tmw-cases .cs-cc{border:1px solid var(--hair);border-radius:14px;background:rgba(255,255,255,.02);padding:16px 17px;text-decoration:none;color:inherit;display:flex;flex-direction:column;transition:border-color .2s}
.tmw-cases .cs-cc:hover{border-color:rgba(230,197,116,.4)}
.tmw-cases .cs-cctop{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.tmw-cases .cs-badge.sm{width:34px;height:34px;font-size:13px;border-radius:9px}
.tmw-cases .cs-ccname{font-family:var(--cs-serif);font-weight:600;font-size:14.5px;color:#fff;line-height:1.15}
.tmw-cases .cs-ccsub{font-family:var(--cs-mono);font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:var(--mute);margin-top:2px}
.tmw-cases .cs-ccm{display:flex;gap:16px;margin-top:auto}
.tmw-cases .cs-ccm div{display:flex;flex-direction:column}
.tmw-cases .cs-ccm b{font-family:var(--cs-serif);font-weight:600;font-size:19px;color:var(--green-soft);line-height:1}
.tmw-cases .cs-ccm b.gold{color:var(--gold-soft)}
.tmw-cases .cs-ccm span{font-family:var(--cs-mono);font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin-top:6px}
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

  function score(study, matchTags){
    var s = 0;
    for (var i=0;i<matchTags.length;i++){ if (study.tags.indexOf(matchTags[i]) !== -1) s++; }
    return s;
  }

  function pill(p){
    if (typeof p === 'string') return '<span class="cs-pill">'+esc(p)+'</span>';
    return '<span class="cs-pill'+(p.live?' live':'')+'">'+esc(p.t)+'</span>';
  }

  function featuredHTML(st){
    var metrics = st.metrics.map(function(m){
      return '<div class="cs-metric"><div class="cs-mn'+(m.gold?' gold':'')+'">'+m.n+'</div><div class="cs-ml">'+esc(m.l)+'</div></div>';
    }).join('');
    return ''+
    '<div class="cs-card">'+
      '<div class="cs-top">'+
        '<div class="cs-badge">'+esc(st.badge)+'</div>'+
        '<div><div class="cs-name">'+esc(st.name)+'</div><div class="cs-namesub">'+esc(st.sub)+'</div></div>'+
        '<div class="cs-pills">'+st.pills.map(pill).join('')+'</div>'+
      '</div>'+
      '<div class="cs-metrics">'+metrics+'</div>'+
      '<div class="cs-body">'+
        '<p class="cs-quote">'+st.quote+'</p>'+
        '<a class="cs-cta" href="'+esc(st.url)+'">Full results report &rarr;</a>'+
      '</div>'+
    '</div>';
  }

  function compactHTML(st){
    var m = (st.compact||st.metrics).slice(0,3).map(function(x){
      return '<div><b'+(x.gold?' class="gold"':'')+'>'+x.n+'</b><span>'+esc(x.l)+'</span></div>';
    }).join('');
    return '<a class="cs-cc" href="'+esc(st.url)+'">'+
      '<div class="cs-cctop"><span class="cs-badge sm">'+esc(st.badge)+'</span>'+
      '<div><div class="cs-ccname">'+esc(st.name)+'</div><div class="cs-ccsub">'+esc(st.sub)+'</div></div></div>'+
      '<div class="cs-ccm">'+m+'</div></a>';
  }

  function render(mount){
    var matchAttr = (mount.getAttribute('data-match')||'').toLowerCase();
    var matchTags = matchAttr.split(',').map(function(t){return t.trim();}).filter(Boolean);
    var limit = parseInt(mount.getAttribute('data-limit')||'2', 10);
    var headline = mount.getAttribute('data-headline') || 'developers like you';

    var ranked = STUDIES.map(function(st){ return {st:st, s:score(st, matchTags)}; })
      .sort(function(a,b){ return b.s - a.s; })
      .map(function(x){ return x.st; });

    if (!ranked.length) return;
    var featured = ranked[0];
    var rest = ranked.slice(1, 1+Math.max(0,limit));

    var compact = rest.map(compactHTML).join('');
    compact += '<a class="cs-cc ghost" href="'+esc(HUB)+'"><div class="g-n">Browse all case studies</div><div class="g-l">The full results library &rarr;</div></a>';

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
      var s = document.createElement('style');
      s.id = 'tmw-cases-css'; s.textContent = CSS;
      document.head.appendChild(s);
    }
    var mounts = document.querySelectorAll('[data-tmw-cases]');
    for (var i=0;i<mounts.length;i++){ if (!mounts[i].__csDone){ mounts[i].__csDone = 1; render(mounts[i]); } }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
