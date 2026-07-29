/* ───────────────────────────────────────────────────────────────────────────
   TMW Dashboard: the member's portfolio as a real, mountable surface.

   Usage:  <div data-tmw-dashboard></div>
           <script src="/_shared/tmw-dashboard.js" defer></script>

   This is the canonical home of the portfolio. /dashboard/ mounts it; the
   account page links here rather than keeping a second copy, so the two can
   never drift apart.

   Everything is derived from data we already publish: the member's follow sets
   (Memberstack JSON), projects-flat, atlas-intel (supply pressure), the pulse
   feed and /watch/feed. No new backend.
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  var WORKER = 'https://tmw.jake-ab7.workers.dev';

  // ── helpers ──────────────────────────────────────────────────────────────
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function slugify(t){ return String(t||'').toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/[\s-]+/g,'-').replace(/^-|-$/g,''); }
  function ms(){ return window.$memberstackDom; }
  var _memP=null;
  function getMember(){
    if(_memP) return _memP;
    _memP=new Promise(function(res){
      var tries=0;
      (function go(){
        var m=ms();
        if(m&&m.getCurrentMember){
          m.getCurrentMember().then(function(r){
            var mem=r&&r.data;
            if(mem){res(mem);} else if(++tries<6){setTimeout(go,400);} else {res(null);}
          }).catch(function(){ if(++tries<6){setTimeout(go,400);} else {res(null);} });
          return;
        }
        if(++tries>40){res(null);return;}
        setTimeout(go,250);
      })();
    });
    return _memP;
  }
  var _mjP=null;
  function getMJ(){
    if(_mjP) return _mjP;
    _mjP=new Promise(function(res){
      getMember().then(function(mem){
        var m=ms();
        if(mem&&m&&m.getMemberJSON){ m.getMemberJSON().then(function(r){ res((r&&r.data)||{}); }).catch(function(){ res({}); }); }
        else res({});
      });
    });
    return _mjP;
  }
  function isPro(){ try{ return window._isPaidMember===true || (window.__tmwMember&&window.__tmwMember.plan==='paid'); }catch(e){ return false; } }
  function weekOf(){
    var d=new Date(), diff=(d.getDay()+6)%7; d.setDate(d.getDate()-diff);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function evDate(ev){
    if(ev&&ev.timestamp) return String(ev.timestamp).slice(0,10);
    var m=/(\d{4}-\d{2}-\d{2})$/.exec(String((ev&&ev.id)||'')); return m?m[1]:'';
  }
  function evRealDate(ev){
    var e=String((ev&&(ev.event_date||ev.effective_date))||'').trim();
    return e?e.slice(0,10):evDate(ev);
  }
  function fmtDate(s){
    s=String(s||'').trim(); var m;
    if(/^\d{4}-\d{2}-\d{2}/.test(s)){ var d=new Date(s.slice(0,10)+'T00:00:00'); return isNaN(d)?s:d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
    if(m=/^(\d{4})-(\d{2})/.exec(s)) return new Date(+m[1],+m[2]-1,1).toLocaleDateString('en-US',{month:'short',year:'numeric'});
    return s;
  }
  // Delivery dates are often VAGUE ("Early 2027", "Summer 2030"), not ISO.
  var SEASON={early:'02',spring:'04',summer:'07',fall:'10',autumn:'10',late:'11',winter:'12'};
  function deliveryKey(p){
    var raw=String(p.DeliveryDate||'').trim(); if(!raw) return '';
    if(/^\d{4}(-\d{2})?/.test(raw)) return raw.slice(0,10);
    var y=(raw.match(/\b(20\d{2})\b/)||[])[1]; if(!y) return '';
    var w=(raw.toLowerCase().match(/early|spring|summer|fall|autumn|late|winter/)||[])[0];
    return y+'-'+(w?SEASON[w]:'06');
  }
  function quarter(d){
    if(!d) return '';
    var y=d.slice(0,4), mo=parseInt(d.slice(5,7),10);
    return mo ? 'Q'+Math.min(4,Math.ceil(mo/3))+' '+y : y;
  }
  function deliveryLabel(p){
    if(String(p.Delivery||'')==='Now Open') return 'Opened';
    var raw=String(p.DeliveryDate||'').trim(); if(!raw) return '';
    if(/^\d{4}-\d{2}/.test(raw)) return quarter(raw);
    if(/^\d{4}$/.test(raw)) return raw;
    return raw;
  }
  var PCT={'announced':12,'breaking ground':33,'under construction':64,'opening soon':88,'now open':100};
  function pct(st){ return PCT[String(st||'').toLowerCase()]||8; }
  function money(m){
    var n=parseFloat(m); if(!isFinite(n)||n<=0) return '';
    return n>=1000 ? ('$'+(n/1000).toFixed(1).replace(/\.0$/,'')+'B') : ('$'+Math.round(n)+'M');
  }

  // ── styles ───────────────────────────────────────────────────────────────
  var CSS = `
.tmw-dash{--d-hair:rgba(255,255,255,.09);--d-mute:#9AA39C;--d-mute2:#C2C9C3;
  font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#ECEAE5}
.tmw-dash .d-wrap{max-width:1180px;margin:0 auto;padding:0 30px}
.tmw-dash .d-head{padding:44px 0 18px;display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap}
.tmw-dash .d-h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(30px,4vw,44px);font-weight:600;color:#fff;letter-spacing:-.02em}
.tmw-dash .d-sub{color:var(--d-mute);font-size:14px;margin-top:6px}
.tmw-dash .d-app{background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.022));
  border:1px solid rgba(255,255,255,.12);border-radius:20px;overflow:hidden;box-shadow:0 26px 70px rgba(0,0,0,.5);margin-bottom:40px}
.tmw-dash .d-bar{display:flex;align-items:center;gap:10px;padding:13px 20px;border-bottom:1px solid var(--d-hair);background:rgba(255,255,255,.03)}
.tmw-dash .d-bar .u{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--d-mute)}
.tmw-dash .d-bar .pro{margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;
  font-weight:700;color:#f0d68a;background:rgba(230,197,116,.12);border:1px solid rgba(230,197,116,.4);padding:4px 10px;border-radius:999px}
.tmw-dash .d-in{padding:24px 22px 26px}
.tmw-dash .d-top{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:20px}
.tmw-dash .d-t1{font-family:'Fraunces',Georgia,serif;font-size:25px;font-weight:600;color:#fff}
.tmw-dash .d-t2{font-size:13px;color:var(--d-mute);margin-top:4px}
.tmw-dash .d-chips{display:flex;gap:7px;flex-wrap:wrap}
.tmw-dash .d-chip{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--d-mute2);
  background:rgba(255,255,255,.05);border:1px solid var(--d-hair);padding:6px 12px;border-radius:999px}
.tmw-dash .d-chip.on{background:#1FDF67;border-color:#1FDF67;color:#070807;font-weight:700}
.tmw-dash .d-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:22px}
.tmw-dash .d-kpi{padding:15px 17px;border:1px solid var(--d-hair);border-radius:14px;background:rgba(255,255,255,.025)}
.tmw-dash .d-kpi .v{font-family:'Fraunces',Georgia,serif;font-size:27px;font-weight:600;color:#fff;line-height:1;letter-spacing:-.02em}
.tmw-dash .d-kpi .v.g{color:#42EB81}.tmw-dash .d-kpi .v.p{color:#B9A6FF}.tmw-dash .d-kpi .v.r{color:#FF5C5C}.tmw-dash .d-kpi .v.a{color:#F5A623}
.tmw-dash .d-kpi .k{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--d-mute);margin-top:8px}
.tmw-dash .d-kpi .x{font-size:11px;color:var(--d-mute2);margin-top:4px;line-height:1.35}
.tmw-dash .d-thead,.tmw-dash .d-row{display:grid;grid-template-columns:minmax(0,1fr) 220px 118px 132px;gap:14px;align-items:center}
.tmw-dash .d-thead{padding:0 10px 11px;border-bottom:1px solid rgba(255,255,255,.1);
  font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--d-mute);font-weight:600}
.tmw-dash .d-row{padding:13px 10px;border-bottom:1px solid rgba(255,255,255,.05);text-decoration:none;color:inherit;border-radius:8px}
.tmw-dash .d-row:hover{background:rgba(167,139,250,.05)}
.tmw-dash .d-nm{font-weight:600;color:#fff;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmw-dash .d-lo{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--d-mute);margin-top:3px}
.tmw-dash .d-bar2{height:5px;border-radius:99px;background:rgba(255,255,255,.09);overflow:hidden;width:200px;max-width:100%}
.tmw-dash .d-bar2 i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#18c75a,#42EB81)}
.tmw-dash .d-st{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--d-mute2);margin-top:6px;display:block}
.tmw-dash .d-when{font-size:11.5px;color:var(--d-mute2)}
.tmw-dash .d-mv{justify-self:end;text-align:center;font-family:'JetBrains Mono',monospace;font-size:10px;padding:3px 9px;border-radius:999px;white-space:nowrap}
.tmw-dash .d-mv.up{color:#42EB81;background:rgba(31,223,103,.1);border:1px solid rgba(31,223,103,.3)}
.tmw-dash .d-mv.new{color:#B9A6FF;background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.3)}
.tmw-dash .d-mv.flat{color:var(--d-mute);border:1px solid rgba(255,255,255,.1)}
.tmw-dash .d-two{display:grid;grid-template-columns:1.25fr 1fr;gap:16px;margin-top:24px}
@media(max-width:820px){.tmw-dash .d-two{grid-template-columns:1fr}.tmw-dash .d-thead,.tmw-dash .d-row{grid-template-columns:minmax(0,1fr) auto}.tmw-dash .d-prog,.tmw-dash .d-when{display:none}}
.tmw-dash .d-card{border:1px solid var(--d-hair);border-radius:14px;background:rgba(255,255,255,.028);padding:17px 19px 19px}
.tmw-dash .d-card h4{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#B9A6FF;margin-bottom:14px;font-weight:600}
.tmw-dash .d-feed{display:flex;flex-direction:column;gap:13px}
.tmw-dash .d-frow{display:flex;gap:11px;align-items:flex-start;font-size:12.5px;color:var(--d-mute2);line-height:1.45}
.tmw-dash .d-dot{width:6px;height:6px;border-radius:50%;flex:none;margin-top:6px;background:#1FDF67;box-shadow:0 0 8px rgba(31,223,103,.7)}
.tmw-dash .d-dot.p{background:#A78BFA;box-shadow:0 0 8px rgba(167,139,250,.7)}
.tmw-dash .d-frow b{color:#fff;font-weight:600}
.tmw-dash .d-fw{margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:9.5px;color:var(--d-mute);white-space:nowrap}
.tmw-dash .d-cap{display:flex;justify-content:space-between;align-items:baseline;padding:10px 2px;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px}
.tmw-dash .d-cap:last-child{border-bottom:none}
.tmw-dash .d-cap .amt{font-family:'Fraunces',Georgia,serif;font-size:17px;font-weight:600;color:#f0d68a}
.tmw-dash .d-cap .who{color:var(--d-mute);font-family:'JetBrains Mono',monospace;font-size:10.5px;margin-top:2px}
.tmw-dash .d-brief{margin-top:22px;padding:20px 22px;border:1px solid rgba(167,139,250,.3);border-radius:15px;
  background:linear-gradient(180deg,rgba(167,139,250,.09),transparent)}
.tmw-dash .d-bk{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#B9A6FF;font-weight:700;margin-bottom:12px}
.tmw-dash .d-bstats{display:flex;gap:34px;margin-bottom:14px;flex-wrap:wrap}
.tmw-dash .d-bstat .v{font-family:'Fraunces',Georgia,serif;font-size:26px;font-weight:600;color:#fff;line-height:1}
.tmw-dash .d-bstat .k{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--d-mute);margin-top:6px}
.tmw-dash .d-bnarr{font-size:13.5px;line-height:1.65;color:var(--d-mute2)}
.tmw-dash .d-empty{color:var(--d-mute);font-size:14px;padding:22px 2px}
.tmw-dash .d-cta{display:inline-block;margin-top:14px;background:#1FDF67;color:#070807;text-decoration:none;
  font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;padding:10px 18px;border-radius:999px}
/* account links: the profile menu is hidden behind the Dashboard button now,
   so this page has to carry the way into settings, billing and sign-out. */
.tmw-dash .d-acct{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tmw-dash .d-al{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--d-mute2);text-decoration:none;background:rgba(255,255,255,.045);border:1px solid var(--d-hair);
  padding:8px 14px;border-radius:999px;cursor:pointer;transition:.16s;white-space:nowrap;font-weight:600}
.tmw-dash .d-al:hover{color:#fff;border-color:rgba(167,139,250,.6);background:rgba(167,139,250,.1)}
.tmw-dash .d-al.out{color:var(--d-mute)}
.tmw-dash .d-al.out:hover{color:#FF8A8A;border-color:rgba(255,92,92,.5);background:rgba(255,92,92,.08)}
.tmw-dash .d-gate{text-align:center;padding:52px 24px}
.tmw-dash .d-gate h3{font-family:'Fraunces',Georgia,serif;font-size:26px;color:#fff;margin-bottom:10px}
.tmw-dash .d-gate p{color:var(--d-mute);font-size:14.5px;max-width:52ch;margin:0 auto 20px;line-height:1.6}
`;

  // ── render ───────────────────────────────────────────────────────────────
  function watchedProjects(flat, mj){
    var favs={}; (mj.favorites||[]).forEach(function(x){ if(x) favs[slugify(x)]=1; });
    return flat.filter(function(p){ var k=slugify(p.Title); return k&&favs[k]; });
  }

  function render(host, d){
    var book=watchedProjects(d.flat, d.mj);
    var owner=(d.mem&&(d.mem.customFields&&(d.mem.customFields['first-name']||d.mem.customFields.name)))
      || (d.mem&&d.mem.auth&&d.mem.auth.email) || 'My portfolio';
    if(!book.length){
      host.innerHTML='<div class="d-app"><div class="d-bar"><span class="u">'+esc(owner)+'</span></div>'
        + '<div class="d-in"><div class="d-empty">Nothing in your book yet. Tap the eye icon on any project to start tracking it, '
        + 'and this becomes your live dashboard.</div><a class="d-cta" href="/map/">Explore the database →</a></div></div>';
      return;
    }
    var caps=book.map(function(p){ return parseFloat(p.FinancingAmountM)||0; });
    var capTotal=caps.reduce(function(a,b){return a+b;},0);
    var today=new Date().toISOString().slice(0,10);
    var upcoming=book.map(deliveryKey).filter(Boolean).filter(function(x){ return x>=today; }).sort();
    var moved=book.filter(function(p){ return d.movesBySlug[slugify(p.Title)]; }).length;
    var cityCount={}; book.forEach(function(p){ var c=(p.City||'').trim(); if(c) cityCount[c]=(cityCount[c]||0)+1; });
    var cities=Object.keys(cityCount).sort(function(a,b){ return cityCount[b]-cityCount[a]; });
    var mk=null; try{ mk=d.intel&&d.intel.markets&&d.intel.markets[slugify(cities[0]||'')]; }catch(e){}
    var lvl=mk?(mk.level==='Saturated'?'r':mk.level==='Elevated'?'a':'g'):'';

    var kpis='<div class="d-kpis">'
      + '<div class="d-kpi"><div class="v">'+book.length+'</div><div class="k">In your book</div><div class="x">'+(moved?moved+' moved this week':'no moves this week')+'</div></div>'
      + (mk?'<div class="d-kpi"><div class="v '+lvl+'">'+mk.score+'</div><div class="k">Supply pressure</div><div class="x">'+esc(cities[0])+' · '+esc(mk.level)+'</div></div>':'')
      + (capTotal?'<div class="d-kpi"><div class="v g">'+money(capTotal)+'</div><div class="k">Capital tracked</div><div class="x">across '+caps.filter(Boolean).length+' financed</div></div>':'')
      + (upcoming.length?'<div class="d-kpi"><div class="v p">'+quarter(upcoming[0])+'</div><div class="k">Next delivery</div><div class="x">'+esc((book.filter(function(p){return deliveryKey(p)===upcoming[0];})[0]||{}).Title||'')+'</div></div>':'')
      + '</div>';

    var rows=book.slice().sort(function(a,b){ return pct(b.Delivery)-pct(a.Delivery); }).map(function(p){
      var k=slugify(p.Title), mv=d.movesBySlug[k];
      var chip = mv ? '<span class="d-mv up">▲ '+esc(mv)+'</span>'
                : (p.FinancingAmountM ? '<span class="d-mv new">'+money(p.FinancingAmountM)+'</span>'
                : '<span class="d-mv flat">No change</span>');
      return '<a class="d-row" href="/projects/'+encodeURIComponent(p.Slug||k)+'/">'
        + '<div><div class="d-nm">'+esc(p.Title||'')+'</div><div class="d-lo">'+esc(p.City||'')+(p.PreferredType?' · '+esc(p.PreferredType):'')+'</div></div>'
        + '<div class="d-prog"><div class="d-bar2"><i style="width:'+pct(p.Delivery)+'%"></i></div><span class="d-st">'+esc(p.Delivery||'')+'</span></div>'
        + '<div class="d-when">'+esc(deliveryLabel(p)||'–')+'</div>'
        + chip + '</a>';
    }).join('');

    var feed=(d.recent||[]).slice(0,4).map(function(m){
      return '<div class="d-frow"><span class="d-dot'+(m.cap?' p':'')+'"></span><div><b>'+esc(m.title)+'</b> '+esc(m.text)+'</div><span class="d-fw">'+esc(m.when||'')+'</span></div>';
    }).join('');
    var fin=book.filter(function(p){ return parseFloat(p.FinancingAmountM)>0; })
      .sort(function(a,b){ return parseFloat(b.FinancingAmountM)-parseFloat(a.FinancingAmountM); }).slice(0,4);
    var capHtml=fin.map(function(p){
      return '<div class="d-cap"><span><b style="color:#fff">'+esc(p.Title||'')+'</b><div class="who">'+esc(p.FinancingLender||'Construction loan')+'</div></span><span class="amt">'+money(p.FinancingAmountM)+'</span></div>';
    }).join('');

    var brief='';
    if(d.brief && (d.brief.n||d.brief.summary)){
      brief='<div class="d-brief"><div class="d-bk">Onyx Brief · week of '+esc(d.brief.week||'')+'</div>'
        + '<div class="d-bstats">'
        +   '<div class="d-bstat"><div class="v">'+(d.brief.n||0)+'</div><div class="k">Moves</div></div>'
        +   '<div class="d-bstat"><div class="v">'+(d.brief.np||0)+'</div><div class="k">Projects</div></div>'
        +   '<div class="d-bstat"><div class="v">'+(d.brief.nm||0)+'</div><div class="k">Markets</div></div>'
        + '</div>'
        + (d.brief.summary?'<div class="d-bnarr">'+esc(d.brief.summary)+'</div>':'')
        + '</div>';
    }

    host.innerHTML='<div class="d-app">'
      + '<div class="d-bar"><span class="u">'+esc(owner)+'</span>'+(isPro()?'<span class="pro">Pro</span>':'')+'</div>'
      + '<div class="d-in">'
      +   '<div class="d-top"><div><div class="d-t1">My Book</div>'
      +     '<div class="d-t2">'+book.length+' project'+(book.length===1?'':'s')+' watched · '+cities.length+' market'+(cities.length===1?'':'s')+'</div></div>'
      +     '<div class="d-chips">'+cities.slice(0,3).map(function(c,i){ return '<span class="d-chip'+(i===0?' on':'')+'">'+esc(c)+'</span>'; }).join('')+'</div></div>'
      +   kpis
      +   '<div class="d-thead"><span>Project</span><span>Progress</span><span>Delivery</span><span>Movement</span></div>'
      +   '<div>'+rows+'</div>'
      +   brief
      +   ((feed||capHtml)?'<div class="d-two">'
      +     (feed?'<div class="d-card"><h4>What moved in your book</h4><div class="d-feed">'+feed+'</div></div>':'')
      +     (capHtml?'<div class="d-card"><h4>Capital in your book</h4>'+capHtml+'</div>':'')
      +   '</div>':'')
      + '</div></div>';
  }

  // ── data + mount ─────────────────────────────────────────────────────────
  function loadAll(){
    var wk=weekOf();
    var from=new Date(wk+'T00:00:00'); from.setDate(from.getDate()-7);
    var fromKey=from.getFullYear()+'-'+String(from.getMonth()+1).padStart(2,'0')+'-'+String(from.getDate()).padStart(2,'0');
    var J=function(u){ return fetch(u,{cache:'no-cache'}).then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; }); };
    return Promise.all([
      getMember(), getMJ(),
      J('https://www.oftmw.com/map/projects-flat.json'),
      J('https://www.oftmw.com/map/atlas-intel.json'),
      J('https://www.oftmw.com/map/pulse.json')
    ]).then(function(o){
      var mem=o[0], mj=o[1]||{}, flat=o[2]||[], intel=o[3], pulseD=o[4];
      if(!mem) return { mem:null };
      var pulse=Array.isArray(pulseD)?pulseD:((pulseD&&(pulseD.events||pulseD.recent_activity))||[]);
      return fetch(WORKER+'/watch/feed?member='+encodeURIComponent(mem.id),{cache:'no-store'})
        .then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; })
        .then(function(feed){
          var favs={}; (mj.favorites||[]).forEach(function(x){ if(x) favs[slugify(x)]=1; });
          var moves={}, order=[];
          function add(ev){
            var dt=evDate(ev); if(!dt||dt<=fromKey||dt>wk) return;
            var id=ev.id||((ev.project_slug||'')+dt); if(moves[id]) return;
            moves[id]={ev:ev,date:dt,rdate:evRealDate(ev)}; order.push(id);
          }
          ((feed&&feed.moves)||[]).forEach(add);
          pulse.forEach(function(ev){ if(ev&&ev.project_slug&&favs[slugify(ev.project_slug)]) add(ev); });
          order.sort(function(a,b){ return moves[b].date.localeCompare(moves[a].date); });
          var movesBySlug={}, projSet={}, mktSet={};
          order.forEach(function(id){
            var ev=moves[id].ev, k=slugify(ev.project_title||ev.project_slug||'');
            if(k&&!movesBySlug[k]) movesBySlug[k]=ev.tag||ev.type||'Moved';
            if(ev.project_slug) projSet[ev.project_slug]=1;
            if(ev.city) mktSet[ev.city]=1;
          });
          var recent=order.slice(0,4).map(function(id){
            var x=moves[id], ev=x.ev, tag=String(ev.tag||ev.type||'moved');
            return { title:ev.project_title||ev.title||'', text:tag.toLowerCase()+(ev.city?' in '+ev.city:'')+'.',
                     when:fmtDate(x.rdate), cap:/financ|loan/i.test(tag) };
          });
          var dt=new Date(wk+'T00:00:00');
          return { mem:mem, mj:mj, flat:flat, intel:intel, movesBySlug:movesBySlug, recent:recent,
                   brief:{ n:order.length, np:Object.keys(projSet).length, nm:Object.keys(mktSet).length,
                           week:dt.toLocaleDateString('en-US',{month:'short',day:'numeric'}), summary:'' },
                   _order:order, _moves:moves, _wk:wk };
        });
    });
  }

  function mount(host){
    host.classList.add('tmw-dash');
    host.innerHTML='<div class="d-wrap"><div class="d-empty">Loading your dashboard…</div></div>';
    loadAll().then(function(d){
      var wrap=document.createElement('div'); wrap.className='d-wrap';
      host.innerHTML=''; host.appendChild(wrap);
      if(!d || !d.mem){
        wrap.innerHTML='<div class="d-gate"><h3>Sign in to open your dashboard</h3>'
          + '<p>Your dashboard tracks the projects, firms and markets you follow: what moved, what got financed, and what delivers next.</p>'
          + '<a class="d-cta" href="/map/">Browse the database →</a></div>';
        return;
      }
      var head=document.createElement('div');
      head.className='d-head';
      head.innerHTML='<div><div class="d-h1">Dashboard</div><div class="d-sub">Your book, your markets, and what moved this week.</div></div>'
        + '<div class="d-acct">'
        +   '<a class="d-al" href="/account/#overview">Watchlist</a>'
        +   '<a class="d-al" href="/account/#saved">Saved articles</a>'
        +   '<a class="d-al" href="/account/#account">Account &amp; billing</a>'
        +   '<button class="d-al out" type="button" data-d-out>Sign out</button>'
        + '</div>';
      wrap.appendChild(head);
      var out=head.querySelector('[data-d-out]');
      if(out) out.addEventListener('click', function(){
        var m=window.$memberstackDom;
        try{ if(m&&m.logout){ m.logout().then(function(){ location.href='/'; }).catch(function(){ location.href='/'; }); return; } }catch(e){}
        location.href='/';
      });
      var body=document.createElement('div');
      wrap.appendChild(body);
      render(body, d);
      // Onyx narrative (server-generated, cached per member+week). Fails soft.
      if(d._order && d._order.length){
        fetch(WORKER+'/brief/summary',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({member:d.mem.id,week:d._wk,moves:d._order.slice(0,40).map(function(id){
            var x=d._moves[id],ev=x.ev; return {title:ev.project_title||ev.title||'',tag:ev.tag||ev.type||'',city:ev.city||'',date:x.rdate,label:'Watched'};
          })})})
          .then(function(r){ return r.ok?r.json():null; })
          .then(function(j){
            if(j&&j.summary){ d.brief.summary=j.summary; render(body,d); }
          }).catch(function(){});
      }
    }).catch(function(){
      host.innerHTML='<div class="d-wrap"><div class="d-empty">Could not load your dashboard. Refresh to try again.</div></div>';
    });
  }

  function boot(){
    if(!document.getElementById('tmw-dash-styles')){
      var st=document.createElement('style'); st.id='tmw-dash-styles'; st.textContent=CSS; document.head.appendChild(st);
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-tmw-dashboard]'), function(h){
      if(h.getAttribute('data-tmw-dash-done')) return;
      h.setAttribute('data-tmw-dash-done','1');
      mount(h);
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
