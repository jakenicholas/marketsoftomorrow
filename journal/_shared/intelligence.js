/* TMW Intelligence — shared, synced section. Mount with:
     <div data-tmw-intel></div>  (add data-anchor="intelligence" for an #anchor id)
     <script src="/_shared/intelligence.js" defer></script>
   Injects scoped styles once + the live product-preview section into every mount,
   wired to projects-flat.json (breakdown + pins) and pulse.json (ticker). */
(function(){
  'use strict';
  var CSS = `/* Scoped under .tmw-intel so the homepage's global .wrap/.eyebrow/h2/etc. are
   untouched; keyframes are ti-prefixed to avoid colliding with site animations. */
.tmw-intel{
  --green:#1FDF67; --green-deep:#18c75a; --green-soft:#42EB81;
  --purple:#A78BFA; --purple-glow:#B9A6FF; --purple-deep:#7c5cff;
  --gold:#e6c574; --gold-soft:#f0d68a;
  --ink:#070807; --panel:#121512; --panel2:#171a17; --panel3:#1d211d;
  --hair:rgba(255,255,255,.08); --hair2:rgba(255,255,255,.14);
  --white:#fff; --cream:#ECEAE5; --mute:#8b958d; --mute2:#C2C9C3;
  --sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  --serif:'Fraunces',Georgia,serif;
  --mono:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  --glass:blur(18px) saturate(1.4);
  position:relative; z-index:1; padding:104px 0 116px; color:var(--cream);
  font-family:var(--sans); line-height:1.5; background:var(--ink); overflow:hidden;
}
.tmw-intel::before{content:""; position:absolute; inset:0; z-index:0; pointer-events:none;
  background:
    radial-gradient(1000px 680px at 80% -10%, rgba(167,139,250,.12), transparent 60%),
    radial-gradient(820px 700px at -8% 18%, rgba(31,223,103,.07), transparent 55%),
    radial-gradient(760px 640px at 112% 96%, rgba(31,223,103,.06), transparent 55%),
    radial-gradient(720px 520px at 12% 88%, rgba(230,197,116,.05), transparent 60%);}
.tmw-intel .wrap{position:relative; z-index:1; max-width:1200px; margin:0 auto; padding:0 32px}

/* header */
.tmw-intel .eyebrow{display:inline-flex; align-items:center; gap:9px; font-family:var(--mono); font-size:11.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--purple-glow); font-weight:500; margin-bottom:22px}
.tmw-intel .eyebrow .pip{width:6px; height:6px; border-radius:50%; background:var(--purple); box-shadow:0 0 12px var(--purple); animation:tiPip 2.6s ease-in-out infinite}
@keyframes tiPip{0%,100%{opacity:.45; transform:scale(.85)}50%{opacity:1; transform:scale(1.15)}}
.tmw-intel h2{font-family:var(--serif); font-weight:400; letter-spacing:-.012em; line-height:1.03; color:var(--white); font-size:clamp(36px,5vw,64px)}
.tmw-intel h2 em{font-style:italic; color:var(--purple-glow); font-weight:400}
.tmw-intel .shead{display:flex; justify-content:space-between; align-items:flex-end; gap:40px; margin-bottom:42px}
.tmw-intel .shead .htxt{max-width:760px}
.tmw-intel .shead h2{margin:6px 0 20px}
.tmw-intel .lede{font-size:clamp(15px,1.45vw,19px); color:var(--mute2); max-width:62ch; line-height:1.6; font-weight:300}
.tmw-intel .lede b{color:var(--cream); font-weight:500}
.tmw-intel .headstats{display:flex; gap:30px; flex-shrink:0; padding-bottom:6px}
.tmw-intel .headstat .n{font-family:var(--serif); font-size:34px; font-weight:600; color:var(--white); line-height:1; letter-spacing:-.02em}
.tmw-intel .headstat .n .pct{color:var(--green)}
.tmw-intel .headstat .l{font-family:var(--mono); font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); margin-top:8px}

/* product window */
.tmw-intel .app{position:relative; border-radius:20px; overflow:hidden;
  background:linear-gradient(180deg, rgba(20,23,20,.92), rgba(10,12,10,.96));
  border:1px solid var(--hair2);
  box-shadow:0 40px 120px rgba(0,0,0,.6), 0 0 0 1px rgba(167,139,250,.06), inset 0 1px 0 rgba(255,255,255,.05);}
.tmw-intel .app::after{content:""; position:absolute; inset:0; pointer-events:none; border-radius:20px; box-shadow:inset 0 0 140px rgba(167,139,250,.05);}
.tmw-intel .chrome{display:flex; align-items:center; gap:14px; padding:12px 16px; border-bottom:1px solid var(--hair); background:rgba(0,0,0,.25)}
.tmw-intel .dots{display:flex; gap:7px}
.tmw-intel .dots i{width:11px; height:11px; border-radius:50%; display:block}
.tmw-intel .dots i:nth-child(1){background:#ff5f57}.tmw-intel .dots i:nth-child(2){background:#febc2e}.tmw-intel .dots i:nth-child(3){background:#28c840}
.tmw-intel .urlbar{flex:1; display:flex; align-items:center; gap:9px; max-width:340px; margin:0 auto; padding:6px 13px; background:rgba(255,255,255,.04); border:1px solid var(--hair); border-radius:999px; font-family:var(--mono); font-size:11.5px; color:var(--mute2)}
.tmw-intel .urlbar svg{width:11px; height:11px; stroke:var(--green); fill:none; stroke-width:2}
.tmw-intel .urlbar b{color:var(--cream); font-weight:500}
.tmw-intel .live{display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--green); font-weight:500}
.tmw-intel .live .pip{width:6px; height:6px; border-radius:50%; background:var(--green); box-shadow:0 0 10px var(--green); animation:tiPip 2s ease-in-out infinite}
.tmw-intel .cmd{display:flex; align-items:center; gap:13px; padding:15px 20px; border-bottom:1px solid var(--hair); background:rgba(255,255,255,.015)}
.tmw-intel .cmd .mag{width:16px; height:16px; stroke:var(--mute2); fill:none; stroke-width:2; flex-shrink:0}
.tmw-intel .cmd .ph{flex:1; font-size:14.5px; color:var(--mute2); font-weight:300}
.tmw-intel .cmd .ph .typed{color:var(--cream); font-weight:400}
.tmw-intel .cmd .ph .cursor{display:inline-block; width:1.5px; height:15px; background:var(--green); margin-left:1px; vertical-align:-2px; animation:tiBlink 1.1s step-end infinite}
@keyframes tiBlink{50%{opacity:0}}
.tmw-intel .cmd .kbd{font-family:var(--mono); font-size:10px; color:var(--mute); border:1px solid var(--hair); border-radius:6px; padding:3px 7px; letter-spacing:.04em}
.tmw-intel .cmd .resultcount{font-family:var(--mono); font-size:11px; color:var(--green); font-weight:500}
.tmw-intel .stage{display:grid; grid-template-columns:1.55fr 1fr; min-height:520px}
.tmw-intel .map{position:relative; overflow:hidden; background:radial-gradient(120% 120% at 50% 40%, rgba(167,139,250,.06), transparent 70%), linear-gradient(180deg, #0c0f0d, #090b09);}
.tmw-intel .map .grid{position:absolute; inset:0;
  background-image:linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
  background-size:38px 38px; mask-image:radial-gradient(95% 90% at 50% 45%, #000 35%, transparent 92%); -webkit-mask-image:radial-gradient(95% 90% at 50% 45%, #000 35%, transparent 92%);}
.tmw-intel .map .arc{position:absolute; border:1px solid rgba(255,255,255,.05); border-radius:50%}
.tmw-intel .map .arc.a1{width:420px; height:520px; right:-130px; top:60px; transform:rotate(18deg)}
.tmw-intel .map .arc.a2{width:260px; height:360px; right:-40px; top:170px; transform:rotate(12deg); opacity:.6}
.tmw-intel .map .coord{position:absolute; font-family:var(--mono); font-size:9px; letter-spacing:.05em; color:var(--mute); opacity:.45}
.tmw-intel .map .coord.c1{top:14px; left:18px}.tmw-intel .map .coord.c2{bottom:14px; right:18px}
.tmw-intel .pin{position:absolute; transform:translate(-50%,-50%); cursor:pointer; z-index:3}
.tmw-intel .pin .bub{display:flex; align-items:center; justify-content:center; border-radius:999px; font-family:var(--mono); font-weight:700; color:#04210f; background:var(--green); box-shadow:0 0 0 5px rgba(31,223,103,.14), 0 4px 18px rgba(31,223,103,.45); transition:transform .25s, box-shadow .25s; position:relative}
.tmw-intel .pin .bub::after{content:""; position:absolute; inset:-7px; border-radius:50%; border:1.5px solid var(--green); opacity:0; animation:tiRing 2.8s ease-out infinite}
.tmw-intel .pin:hover .bub{transform:scale(1.12)}
.tmw-intel .pin.sel .bub{background:var(--purple); color:#1a0f3d; box-shadow:0 0 0 6px rgba(167,139,250,.2), 0 6px 24px rgba(167,139,250,.55)}
.tmw-intel .pin.sel .bub::after{border-color:var(--purple)}
@keyframes tiRing{0%{transform:scale(.7); opacity:.8}100%{transform:scale(2.1); opacity:0}}
.tmw-intel .pin .lab{position:absolute; left:50%; top:-22px; transform:translateX(-50%); font-family:var(--mono); font-size:9.5px; letter-spacing:.06em; color:var(--mute2); white-space:nowrap; opacity:.75}
.tmw-intel .intel{position:absolute; z-index:6; width:294px; border-radius:14px; overflow:hidden;
  background:linear-gradient(180deg, rgba(28,22,46,.92), rgba(14,12,22,.96));
  backdrop-filter:var(--glass); -webkit-backdrop-filter:var(--glass);
  border:1px solid rgba(167,139,250,.4); box-shadow:0 24px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(167,139,250,.1); transition:opacity .35s, transform .35s;}
.tmw-intel .intel .ihead{display:flex; align-items:center; gap:8px; padding:11px 14px 9px}
.tmw-intel .intel .ihead .badge{display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:9px; letter-spacing:.14em; text-transform:uppercase; color:var(--purple-glow); font-weight:500}
.tmw-intel .intel .ihead .badge svg{width:11px; height:11px; fill:var(--purple-glow)}
.tmw-intel .intel .ihead .pro{margin-left:auto; font-family:var(--mono); font-size:8.5px; letter-spacing:.12em; color:var(--gold-soft); border:1px solid rgba(230,197,116,.4); border-radius:5px; padding:2px 6px}
.tmw-intel .intel .iname{padding:0 14px; font-size:13.5px; font-weight:600; color:#fff; line-height:1.25}
.tmw-intel .intel .iloc{padding:2px 14px 12px; font-family:var(--mono); font-size:10px; letter-spacing:.04em; color:var(--mute); text-transform:uppercase}
.tmw-intel .intel .forecast{margin:0 14px; padding:12px 13px; background:rgba(0,0,0,.32); border:1px solid rgba(167,139,250,.2); border-radius:10px}
.tmw-intel .intel .forecast .big{font-size:22px; font-weight:700; color:var(--purple-glow); letter-spacing:-.01em; line-height:1}
.tmw-intel .intel .forecast .big small{font-size:12px; color:#fff; font-weight:500; margin-left:3px}
.tmw-intel .intel .conf{display:flex; align-items:center; gap:8px; margin-top:10px}
.tmw-intel .intel .conf .bar{flex:1; height:5px; padding:0; border:0; backdrop-filter:none; -webkit-backdrop-filter:none; border-radius:3px; background:rgba(255,255,255,.1); overflow:hidden}
.tmw-intel .intel .conf .bar i{display:block; height:100%; border-radius:3px; background:linear-gradient(90deg, var(--purple-deep), var(--purple-glow)); transition:width .6s ease}
.tmw-intel .intel .conf .pc{font-family:var(--mono); font-size:10px; color:var(--purple-glow); font-weight:500}
.tmw-intel .intel .conf .lbl{font-family:var(--mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute)}
.tmw-intel .intel .comps{padding:11px 14px 13px}
.tmw-intel .intel .comps .ct{font-family:var(--mono); font-size:8.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--mute); margin-bottom:8px}
.tmw-intel .intel .comp{display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-top:1px solid var(--hair); font-size:11px}
.tmw-intel .intel .comp .cn{color:var(--mute2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px}
.tmw-intel .intel .comp .cv{font-family:var(--mono); color:#fff; font-weight:500; flex-shrink:0}
.tmw-intel .rail{border-left:1px solid var(--hair); display:flex; flex-direction:column; background:rgba(255,255,255,.012)}
.tmw-intel .rail .rhead{padding:16px 18px 0}
.tmw-intel .rail .rtitle{font-size:13px; font-weight:600; color:#fff; display:flex; align-items:center; gap:8px}
.tmw-intel .rail .rtitle .ic{width:14px; height:14px; stroke:var(--green); fill:none; stroke-width:2}
.tmw-intel .rail .rsub{font-family:var(--mono); font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute); margin-top:5px}
.tmw-intel .bk{display:flex; gap:6px; padding:14px 18px 6px}
.tmw-intel .bk button{flex:1; font-family:var(--mono); font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--mute2); background:rgba(255,255,255,.03); border:1px solid var(--hair); border-radius:8px; padding:8px 4px; cursor:pointer; transition:all .18s; font-weight:500}
.tmw-intel .bk button:hover{color:var(--cream); border-color:var(--hair2)}
.tmw-intel .bk button.on{color:#04210f; background:var(--green); border-color:var(--green); font-weight:700}
.tmw-intel .lblist{list-style:none; padding:6px 14px 8px; flex:1; min-height:0; overflow:hidden; margin:0;
  -webkit-mask-image:linear-gradient(180deg, #000 78%, transparent 99%); mask-image:linear-gradient(180deg, #000 78%, transparent 99%);}
.tmw-intel .lblist li{display:grid; grid-template-columns:20px 1fr auto auto; gap:10px; align-items:center; padding:9px 6px; border-radius:8px; transition:background .15s; cursor:default; position:relative}
.tmw-intel .lblist li:hover{background:rgba(255,255,255,.025)}
.tmw-intel .lblist .rk{font-family:var(--mono); font-size:11px; font-weight:700; color:var(--mute); font-variant-numeric:tabular-nums}
.tmw-intel .lblist li.top1 .rk,.tmw-intel .lblist li.top2 .rk,.tmw-intel .lblist li.top3 .rk{color:var(--gold-soft)}
.tmw-intel .lblist .nmwrap{min-width:0}
.tmw-intel .lblist .nm{font-size:13px; font-weight:600; color:var(--cream); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.tmw-intel .lblist .track{height:3px; border-radius:2px; background:rgba(255,255,255,.07); margin-top:6px; overflow:hidden}
.tmw-intel .lblist .track i{display:block; height:100%; border-radius:2px; background:linear-gradient(90deg, var(--green-deep), var(--green-soft)); transition:width .6s ease}
.tmw-intel .lblist .dl{font-family:var(--mono); font-size:10px; font-weight:700; color:var(--green); text-align:right; min-width:40px; font-variant-numeric:tabular-nums; letter-spacing:.01em}
.tmw-intel .lblist .dl.flat{color:var(--mute); opacity:.4}
.tmw-intel .lblist .ct{font-family:var(--mono); font-size:15px; font-weight:700; color:#fff; font-variant-numeric:tabular-nums; line-height:1; text-align:right; min-width:24px}
.tmw-intel .rail .rfoot{padding:12px 18px; border-top:1px solid var(--hair); display:flex; align-items:center; justify-content:space-between; font-family:var(--mono); font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--mute)}
.tmw-intel .rail .rfoot a{display:inline-flex; align-items:center; gap:6px; color:var(--green); text-decoration:none; font-weight:700}
.tmw-intel .rail .rfoot a svg{width:11px; height:11px; stroke:currentColor; fill:none; stroke-width:2.4}
.tmw-intel .pulse{display:flex; align-items:center; gap:0; border-top:1px solid var(--hair); background:rgba(0,0,0,.3); overflow:hidden}
.tmw-intel .pulse .ptag{flex-shrink:0; display:inline-flex; align-items:center; gap:7px; padding:11px 16px; font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--green); font-weight:500; border-right:1px solid var(--hair); background:rgba(31,223,103,.04)}
.tmw-intel .pulse .ptag .pip{width:6px; height:6px; border-radius:50%; background:var(--green); box-shadow:0 0 10px var(--green); animation:tiPip 2s ease-in-out infinite}
.tmw-intel .pulse .ptrack{flex:1; overflow:hidden; position:relative; mask-image:linear-gradient(90deg, transparent, #000 4%, #000 92%, transparent); -webkit-mask-image:linear-gradient(90deg, transparent, #000 4%, #000 92%, transparent)}
.tmw-intel .pulse .pmove{display:inline-flex; gap:42px; white-space:nowrap; padding-left:24px; animation:tiTicker 34s linear infinite}
.tmw-intel .pulse:hover .pmove{animation-play-state:paused}
.tmw-intel .pulse .pitem{display:inline-flex; align-items:center; gap:11px; font-size:12.5px; color:var(--mute2)}
.tmw-intel .pulse .pitem b{color:var(--cream); font-weight:500}
.tmw-intel .pulse .pitem .age{font-family:var(--mono); font-size:10px; color:var(--purple-glow); border:1px solid rgba(167,139,250,.3); border-radius:5px; padding:1px 6px}
.tmw-intel .pulse .pitem .dot{width:4px; height:4px; border-radius:50%; background:var(--green); flex-shrink:0}
@keyframes tiTicker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
.tmw-intel .feats{margin-top:30px; display:grid; grid-template-columns:repeat(5,1fr); gap:12px}
.tmw-intel .feat{padding:18px 16px 16px; border-radius:14px; background:rgba(255,255,255,.03); border:1px solid var(--hair); position:relative; overflow:hidden; transition:transform .25s, border-color .25s, background .25s}
.tmw-intel .feat:hover{transform:translateY(-3px); border-color:var(--hair2); background:rgba(255,255,255,.05)}
.tmw-intel .feat .ficon{width:30px; height:30px; border-radius:9px; display:flex; align-items:center; justify-content:center; background:rgba(31,223,103,.1); border:1px solid rgba(31,223,103,.25); margin-bottom:13px}
.tmw-intel .feat .ficon svg{width:15px; height:15px; stroke:var(--green-soft); fill:none; stroke-width:1.9}
.tmw-intel .feat.pro .ficon{background:rgba(167,139,250,.12); border-color:rgba(167,139,250,.3)}
.tmw-intel .feat.pro .ficon svg{stroke:var(--purple-glow)}
.tmw-intel .feat .fname{font-size:13px; font-weight:600; color:#fff; display:flex; align-items:center; gap:7px}
.tmw-intel .feat .fname .lock{width:11px; height:11px; stroke:var(--gold-soft); fill:none; stroke-width:2}
.tmw-intel .feat .fdesc{font-size:11.5px; color:var(--mute); margin-top:5px; line-height:1.45; font-weight:300}
.tmw-intel .feat .ptag2{position:absolute; top:13px; right:13px; font-family:var(--mono); font-size:8px; letter-spacing:.12em; color:var(--gold-soft); border:1px solid rgba(230,197,116,.4); border-radius:5px; padding:2px 5px}
.tmw-intel .cta{margin-top:30px; min-height:0; display:flex; align-items:center; justify-content:space-between; gap:24px; padding:26px 30px; border-radius:16px;
  background:linear-gradient(100deg, rgba(167,139,250,.1), rgba(31,223,103,.06)); border:1px solid var(--hair2); flex-wrap:wrap}
.tmw-intel .cta .ctxt{max-width:560px}
.tmw-intel .cta .ctxt h3{font-family:var(--serif); font-weight:400; font-size:clamp(20px,2.4vw,28px); color:#fff; letter-spacing:-.01em; line-height:1.2}
.tmw-intel .cta .ctxt h3 em{font-style:italic; color:var(--purple-glow)}
.tmw-intel .cta .ctxt p{font-size:13px; color:var(--mute2); margin-top:7px; font-weight:300}
.tmw-intel .cta .cbtns{display:flex; gap:12px; flex-shrink:0}
.tmw-intel .btn{display:inline-flex; align-items:center; gap:9px; padding:13px 22px; border-radius:999px; font-size:13.5px; font-weight:600; text-decoration:none; cursor:pointer; transition:transform .2s, box-shadow .2s, background .2s; font-family:var(--sans)}
.tmw-intel .btn svg{width:15px; height:15px; stroke:currentColor; fill:none; stroke-width:2; transition:transform .2s}
.tmw-intel .btn.primary{background:linear-gradient(180deg, var(--gold-soft), var(--gold)); color:#2a1f06; box-shadow:0 8px 30px 2px rgba(230,197,116,.45)}
.tmw-intel .btn.primary:hover{transform:translateY(-2px); background:linear-gradient(180deg, #f6e2a6, var(--gold-soft)); box-shadow:0 12px 42px 6px rgba(240,214,138,.6)}
.tmw-intel .btn.primary:hover svg{transform:translateX(3px)}
.tmw-intel .btn.ghost{background:rgba(255,255,255,.05); color:var(--cream); border:1px solid var(--hair2)}
.tmw-intel .btn.ghost:hover{background:rgba(167,139,250,.14); border-color:rgba(167,139,250,.4); color:#fff}
.tmw-intel .ti-wrap{margin-top:64px}
.tmw-intel .ti-eyebrow{display:inline-flex; align-items:center; gap:9px; font-family:var(--mono); font-size:11.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--purple-glow); font-weight:500; margin-bottom:18px}
.tmw-intel .ti-hex{display:inline-flex; width:18px; height:18px; flex:0 0 auto}
.tmw-intel .ti-hex svg{width:100%; height:100%; overflow:visible}
.tmw-intel .ti-hex polygon{stroke:var(--purple); fill:none; stroke-width:7; stroke-linejoin:round; animation:tiHexpulse 4.2s ease-in-out infinite; transform-origin:50% 50%}
.tmw-intel .ti-hex .ti-spin{transform-origin:50% 50%; animation:tiHardspin 4.2s cubic-bezier(.16,1,.3,1) infinite}
.tmw-intel .ti-wrap h3.tih{font-family:var(--serif); font-weight:400; letter-spacing:-.012em; line-height:1.05; color:var(--white); font-size:clamp(28px,3.4vw,42px); margin-bottom:16px}
.tmw-intel .ti-wrap h3.tih em{font-style:italic; color:var(--purple-glow)}
.tmw-intel .ti-wrap .lede{margin-bottom:30px}
.tmw-intel .ti-wrap .lede .hl-gold{color:var(--gold-soft)}
.tmw-intel .ti-grid{display:grid; grid-template-columns:repeat(3,1fr); gap:16px}
.tmw-intel .ti-card{padding:30px 28px; border:1px solid rgba(167,139,250,.24); border-radius:16px; background:rgba(167,139,250,.04); position:relative; overflow:hidden; transition:transform .28s ease, border-color .28s ease}
.tmw-intel .ti-card:hover{transform:translateY(-4px); border-color:rgba(167,139,250,.45)}
.tmw-intel .ti-card::after{content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(135deg, rgba(167,139,250,.08), transparent 55%); opacity:.7}
.tmw-intel .ti-card-num{font-family:var(--mono); font-size:12px; letter-spacing:.1em; color:var(--purple-glow); margin-bottom:18px; position:relative; z-index:1}
.tmw-intel .ti-card-h{font-family:var(--serif); font-weight:600; font-size:22px; color:var(--white); letter-spacing:-.01em; margin-bottom:10px; position:relative; z-index:1}
.tmw-intel .ti-card-p{font-size:14px; color:var(--mute2); line-height:1.55; font-weight:300; position:relative; z-index:1}
.tmw-intel .ti-strip{display:flex; flex-wrap:wrap; gap:24px 38px; margin-top:16px; padding:22px 28px; border:1px solid rgba(167,139,250,.22); border-radius:16px; background:rgba(167,139,250,.05); align-items:center}
.tmw-intel .ti-strip-lab{font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--purple-glow)}
.tmw-intel .ti-strip-stats{flex:1; display:grid; grid-template-columns:repeat(4,1fr); gap:24px; align-items:start}
.tmw-intel .ti-strip-stat{display:flex; flex-direction:column; gap:3px}
.tmw-intel .ti-strip-v{font-family:var(--serif); font-weight:600; font-size:26px; color:var(--purple-glow); letter-spacing:-.02em; line-height:1}
.tmw-intel .ti-strip-k{font-family:var(--mono); font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute)}
@keyframes tiHexpulse{0%,45%{stroke:var(--purple); filter:drop-shadow(0 0 0 rgba(167,139,250,0))}70%{stroke:var(--purple-glow); filter:drop-shadow(0 0 6px rgba(185,166,255,.9))}100%{stroke:var(--purple); filter:drop-shadow(0 0 0 rgba(167,139,250,0))}}
@keyframes tiHardspin{0%{transform:rotate(0)}55%{transform:rotate(810deg)}70%{transform:rotate(900deg)}100%{transform:rotate(1080deg)}}
@media(max-width:980px){
  .tmw-intel .shead{flex-direction:column; align-items:flex-start; gap:24px}
  .tmw-intel .stage{grid-template-columns:1fr}
  .tmw-intel .map{min-height:340px}
  .tmw-intel .rail{border-left:none; border-top:1px solid var(--hair)}
  .tmw-intel .lblist{overflow:visible; -webkit-mask-image:none; mask-image:none}
  .tmw-intel .intel{width:255px}
  .tmw-intel .feats{grid-template-columns:repeat(2,1fr); grid-auto-rows:1fr}
  .tmw-intel .headstats{gap:24px}
  .tmw-intel .ti-grid{grid-template-columns:1fr}
  .tmw-intel .ti-strip{flex-direction:column; align-items:stretch; gap:18px}
  .tmw-intel .ti-strip-stats{grid-template-columns:1fr 1fr; gap:18px 20px; width:100%}
}
@media(max-width:560px){
  .tmw-intel{padding:72px 0 82px}
  .tmw-intel .wrap{padding:0 18px}
  .tmw-intel .cmd .kbd{display:none}
  .tmw-intel .feats{grid-template-columns:repeat(2,1fr); grid-auto-rows:1fr}
  .tmw-intel .cta{flex-direction:column; align-items:flex-start}
  /* Mobile: keep the intel card a compact overlay anchored top-LEFT of the map
     (like desktop) instead of a full-width relative block that buries the whole
     map. width stays at the desktop 294px and transform:scale(.6) shrinks the
     whole card 40% from its top-left corner, so it covers only the corner. */
  .tmw-intel .intel{position:absolute!important; left:12px!important; top:12px!important; right:auto!important; bottom:auto!important; width:294px!important; margin:0!important; transform:scale(.6); transform-origin:top left}
}
.tmw-intel .btn-pro{font-family:var(--mono); font-size:9px; font-weight:500; letter-spacing:.12em; color:var(--gold-soft); border:1px solid rgba(230,197,116,.45); border-radius:5px; padding:2px 6px; line-height:1.2}`;
  var HTML = `<section class="tmw-intel">
  <div class="wrap">

    <div class="shead">
      <div class="htxt">
        <span class="eyebrow"><span class="pip"></span>TMW Intelligence</span>
        <h2>Not a map.<br>A live intelligence<br>layer on <em>every project.</em></h2>
        <p class="lede">Behind every pin: timelines, developers, architects, units, milestones &mdash; and a <b>predictive engine</b> that forecasts completion and surfaces comparable developments. The cities and firms moving right now, broken down however you need to see them.</p>
      </div>
      <div class="headstats">
        <div class="headstat"><div class="n">396</div><div class="l">Projects tracked</div></div>
        <div class="headstat"><div class="n">40<span class="pct">+</span></div><div class="l">Live markets</div></div>
        <div class="headstat"><div class="n">Daily</div><div class="l">Synced</div></div>
      </div>
    </div>

    <div class="app">
      <div class="chrome">
        <div class="dots"><i></i><i></i><i></i></div>
        <div class="urlbar">
          <svg viewBox="0 0 24 24"><path d="M12 21s-7-5.5-7-11a7 7 0 1114 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
          <b>map.oftmw.com</b>
        </div>
        <span class="live"><span class="pip"></span>Live</span>
      </div>

      <div class="cmd">
        <svg class="mag" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
        <div class="ph">Search <span class="typed" id="tiTyped"></span><span class="cursor"></span></div>
        <span class="resultcount" id="tiRcount">396 results</span>
        <span class="kbd">&#8984;K</span>
      </div>

      <div class="stage">
        <div class="map">
          <div class="grid"></div>
          <div class="arc a1"></div>
          <div class="arc a2"></div>
          <span class="coord c1">27.77&deg; N</span>
          <span class="coord c2">82.64&deg; W</span>

          <div class="pin sel" style="left:46%; top:60%" data-k="waldorf"><span class="lab">St. Petersburg</span><span class="bub" style="width:40px;height:40px;font-size:13px">15</span></div>
          <div class="pin" style="left:63%; top:78%" data-k="melia"><span class="lab">Miami</span><span class="bub" style="width:52px;height:52px;font-size:15px">78</span></div>
          <div class="pin" style="left:71%; top:62%" data-k="greene"><span class="lab">West Palm</span><span class="bub" style="width:44px;height:44px;font-size:14px">55</span></div>
          <div class="pin" style="left:40%; top:40%" data-k="nashville"><span class="bub" style="width:34px;height:34px;font-size:12px">16</span></div>
          <div class="pin" style="left:58%; top:86%" data-k="ftl"><span class="bub" style="width:30px;height:30px;font-size:11px">14</span></div>

          <div class="intel" id="tiIntel" style="left:20px; top:18px">
            <div class="ihead">
              <span class="badge"><svg viewBox="0 0 24 24"><polygon points="12,4.3 18.65,8.16 18.65,15.84 12,19.68 5.35,15.84 5.35,8.16"/></svg>TMW Intelligence</span>
              <span class="pro">PRO</span>
            </div>
            <div class="iname" id="tiName">Waldorf Astoria Residences</div>
            <div class="iloc" id="tiLoc">St. Petersburg &middot; Construction</div>
            <div class="forecast">
              <div class="big" id="tiBig">~3.5 yrs<small>to completion</small></div>
              <div class="conf">
                <span class="lbl">Confidence</span>
                <span class="bar"><i id="tiBar" style="width:82%"></i></span>
                <span class="pc" id="tiPc">82%</span>
              </div>
            </div>
            <div class="comps">
              <div class="ct">Comparable projects &middot; same type, same metro</div>
              <div id="tiComps"></div>
            </div>
          </div>
        </div>

        <div class="rail">
          <div class="rhead">
            <div class="rtitle">
              <svg class="ic" viewBox="0 0 24 24"><path d="M4 19h16M7 16V9M12 16V5M17 16v-6"/></svg>
              Movers, right now
            </div>
            <div class="rsub">Break it down by</div>
          </div>
          <div class="bk">
            <button class="on" data-bk="cities">Cities</button>
            <button data-bk="developers">Developers</button>
            <button data-bk="architects">Architects</button>
          </div>
          <ul class="lblist" id="tiLblist"></ul>
          <div class="rfoot">
            <span id="tiRfoot">&#8593; = announced / breaking ground</span>
            <a href="https://www.oftmw.com/map" target="_blank" rel="noopener">Open map <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></a>
          </div>
        </div>
      </div>

      <div class="pulse">
        <span class="ptag"><span class="pip"></span>Pulse</span>
        <div class="ptrack"><div class="pmove" id="tiPmove"></div></div>
      </div>
    </div>

    <div class="feats">
      <div class="feat">
        <div class="ficon"><svg viewBox="0 0 24 24"><path d="M12 21s-7-5.5-7-11a7 7 0 1114 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg></div>
        <div class="fname">View on map</div>
        <div class="fdesc">Every project as a pin. Fly to any city, filter by type, status, or year.</div>
      </div>
      <div class="feat pro">
        <span class="ptag2">PRO</span>
        <div class="ficon"><svg viewBox="0 0 24 24"><polygon points="12,4.3 18.65,8.16 18.65,15.84 12,19.68 5.35,15.84 5.35,8.16"/></svg></div>
        <div class="fname">Intelligence <svg class="lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg></div>
        <div class="fdesc">Timeline forecasts &amp; comparable-project engine on every development.</div>
      </div>
      <div class="feat pro">
        <span class="ptag2">PRO</span>
        <div class="ficon"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/></svg></div>
        <div class="fname">Compare <svg class="lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg></div>
        <div class="fdesc">Two developers, two markets, side by side. Units, timelines, pipeline.</div>
      </div>
      <div class="feat pro">
        <span class="ptag2">PRO</span>
        <div class="ficon"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></div>
        <div class="fname">Watchlist <svg class="lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg></div>
        <div class="fdesc">Star the firms and projects you follow. Get pinged when they move.</div>
      </div>
      <div class="feat pro">
        <span class="ptag2">PRO</span>
        <div class="ficon"><svg viewBox="0 0 24 24"><path d="M3 12h4l2 6 4-14 2 8h6"/></svg></div>
        <div class="fname">Pulse <svg class="lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg></div>
        <div class="fdesc">A live feed of every new project, milestone, and market shift.</div>
      </div>
    </div>

    <div class="cta">
      <div class="ctxt">
        <h3>The map is the front door. <em>Intelligence is the building.</em></h3>
        <p>Explore all 396 projects free. Unlock forecasts, compare mode, and your watchlist with TMW Pro.</p>
      </div>
      <div class="cbtns">
        <a class="btn ghost" href="https://www.oftmw.com/map" target="_blank" rel="noopener">See TMW Pro <span class="btn-pro">PRO</span></a>
      </div>
    </div>

  </div>
</section>`;
  if(!document.getElementById('tmw-intel-styles')){ var s=document.createElement('style'); s.id='tmw-intel-styles'; s.textContent=CSS; document.head.appendChild(s); }
  var mounts=document.querySelectorAll('[data-tmw-intel]');
  Array.prototype.forEach.call(mounts, function(m){
    if(m.getAttribute('data-tmw-intel-done')) return; m.setAttribute('data-tmw-intel-done','1');
    m.innerHTML=HTML; var root=m.querySelector('.tmw-intel'); if(!root) return;
    var anchor=m.getAttribute('data-anchor'); if(anchor) root.id=anchor;
    init(root);
  });
  function init(root){
    function $(s){ return root.querySelector(s); }
    function $all(s){ return root.querySelectorAll(s); }

    function $(s){ return root.querySelector(s); }
    function $all(s){ return root.querySelectorAll(s); }
    function esc(s){ return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

    var PROJECTS_URL = 'https://map.oftmw.com/projects-flat.json';
    var PULSE_URL    = 'https://map.oftmw.com/pulse.json';
    var PIN_CITY = { waldorf:'St. Petersburg', melia:'Miami', greene:'West Palm Beach', nashville:'Nashville', ftl:'Fort Lauderdale' };

    /* ---- breakdown data (static seed = instant paint + offline fallback;
            overwritten by live projects-flat.json below) ---- */
    var DATA = {
      cities:{ label:'↑ = announced / breaking ground', rows:[
        {n:'Miami',c:78,d:20},{n:'West Palm Beach',c:55,d:23},{n:'Nashville',c:16,d:5},
        {n:'Miami Beach',c:15,d:3},{n:'Fort Lauderdale',c:14,d:2},{n:'Tampa',c:13,d:4},
        {n:'New York City',c:12,d:2},{n:'Riviera Beach',c:9,d:6},{n:'Dubai',c:7,d:0}]},
      developers:{ label:'↑ = active pipeline projects', rows:[
        {n:'Related Group',c:13,d:3},{n:'Related Ross',c:11,d:5},{n:'Property Markets Group',c:11,d:1},
        {n:'Two Roads Development',c:5,d:0},{n:'Terra Group',c:5,d:2},{n:'BH Group',c:5,d:1},
        {n:'Witkoff',c:4,d:1},{n:'Place Projects',c:4,d:1},{n:'Wheelock Street Capital',c:4,d:1}]},
      architects:{ label:'↑ = active pipeline projects', rows:[
        {n:'Arquitectonica',c:56,d:15},{n:'Foster + Partners',c:18,d:8},{n:'Kohn Pedersen Fox',c:13,d:4},
        {n:'Kobi Karp',c:12,d:4},{n:'Skidmore, Owings & Merrill',c:11,d:1},{n:'Spina O’Rourke + Partners',c:10,d:2},
        {n:'REG Architects',c:9,d:6},{n:'Hart Howerton',c:9,d:0},{n:'Sieger Suarez Architects',c:7,d:2}]}
    };
    var curTab = 'cities';
    var baseCount = 396;

    function renderBoard(key){
      curTab = key;
      var set = DATA[key]; var max = Math.max.apply(null, set.rows.map(function(r){return r.c;})) || 1;
      $('#tiLblist').innerHTML = set.rows.map(function(r,i){
        var top = i<3 ? ' top'+(i+1) : ''; var w = Math.round((r.c/max)*100);
        var dl = r.d>0 ? '+'+r.d+' ↑' : '·'; var dc = r.d>0 ? '' : ' flat';
        return '<li class="'+top.trim()+'"><span class="rk">'+String(i+1).padStart(2,'0')+'</span>'+
          '<span class="nmwrap"><span class="nm">'+esc(r.n)+'</span><span class="track"><i style="width:'+w+'%"></i></span></span>'+
          '<span class="dl'+dc+'">'+dl+'</span><span class="ct">'+r.c+'</span></li>';
      }).join('');
      $('#tiRfoot').textContent = set.label;
    }
    $all('.bk button').forEach(function(b){
      b.addEventListener('click', function(){
        $all('.bk button').forEach(function(x){x.classList.remove('on');});
        b.classList.add('on'); renderBoard(b.getAttribute('data-bk'));
      });
    });
    renderBoard('cities');

    /* ---- intelligence card content per pin (illustrative Pro preview) ---- */
    var INTEL = {
      waldorf:{name:'Waldorf Astoria Residences', loc:'St. Petersburg · Construction', big:'~3.5 yrs', pc:82,
        comps:[['Saltaire St. Petersburg','+3.2 yrs'],['400 Central','+3.6 yrs'],['One St. Petersburg','+2.9 yrs']]},
      melia:{name:'Meliá Residences Miami', loc:'Miami · Announced', big:'~4.1 yrs', pc:74,
        comps:[['Aston Martin Residences','+4.4 yrs'],['Okan Tower','+3.9 yrs'],['Waldorf Astoria Miami','+4.6 yrs']]},
      greene:{name:'One West Palm', loc:'West Palm Beach · Breaking ground', big:'~3.0 yrs', pc:79,
        comps:[['Olara WPB','+2.8 yrs'],['South Flagler House','+3.1 yrs'],['Forté on Flagler','+2.6 yrs']]},
      nashville:{name:'Nashville Yards', loc:'Nashville · Construction', big:'~2.7 yrs', pc:71,
        comps:[['Five Twelve','+2.5 yrs'],['Paseo South Gulch','+3.0 yrs'],['1 Hotel Nashville','+2.4 yrs']]},
      ftl:{name:'The Las Olas Project', loc:'Fort Lauderdale · Announced', big:'~3.8 yrs', pc:68,
        comps:[['Riverwalk Residences','+3.5 yrs'],['Six13','+4.0 yrs'],['Olara FTL','+3.6 yrs']]}
    };
    function setIntel(k){
      var d = INTEL[k]; if(!d) return;
      $('#tiName').textContent = d.name;
      $('#tiLoc').textContent = d.loc;
      $('#tiBig').innerHTML = d.big+'<small>to completion</small>';
      $('#tiBar').style.width = d.pc+'%';
      $('#tiPc').textContent = d.pc+'%';
      $('#tiComps').innerHTML = d.comps.map(function(c){
        return '<div class="comp"><span class="cn">'+esc(c[0])+'</span><span class="cv">'+esc(c[1])+'</span></div>';
      }).join('');
    }
    $all('.pin').forEach(function(p){
      p.addEventListener('click', function(){
        $all('.pin').forEach(function(x){x.classList.remove('sel');});
        p.classList.add('sel'); setIntel(p.getAttribute('data-k'));
      });
    });
    setIntel('waldorf');

    /* ---- typed search placeholder ---- */
    var QUERIES = ['Related Group','condos in West Palm Beach','Foster + Partners','timelines · 2027 delivery','mass timber towers'];
    var COUNTS  = ['41 results','22 results','17 results','63 results','4 results'];
    var qi=0, ci=0, typing=true, tEl=$('#tiTyped'), rEl=$('#tiRcount');
    function tick(){
      var q = QUERIES[qi];
      if(typing){
        ci++; tEl.textContent = q.slice(0,ci);
        if(ci>=q.length){ typing=false; rEl.textContent=COUNTS[qi]; setTimeout(tick,1700); return; }
        setTimeout(tick, 55+Math.random()*55);
      } else {
        ci--; tEl.textContent = q.slice(0,ci);
        if(ci<=0){ typing=true; qi=(qi+1)%QUERIES.length; rEl.textContent=baseCount+' results'; setTimeout(tick,260); return; }
        setTimeout(tick, 28);
      }
    }
    setTimeout(tick, 900);

    /* ---- pulse ticker (static seed; overwritten by pulse.json) ---- */
    var PULSE = [
      ['Meliá Residences Miami added to the map','1d'],
      ['Jeff Greene plans Florida’s tallest mass timber tower','2d'],
      ['Nude Miami opens in Brickell — the city’s first organic grocer','5d'],
      ['Waldorf Astoria Residences St. Petersburg → Construction','5d'],
      ['Related Ross adds 3 West Palm towers to the pipeline','3d'],
      ['Arquitectonica crosses 54 tracked projects','6d']
    ];
    function pulseHtml(){
      return PULSE.map(function(p){
        return '<span class="pitem"><span class="dot"></span><b>'+esc(p[0])+'</b><span class="age">'+esc(p[1])+'</span></span>';
      }).join('');
    }
    function renderPulse(){ $('#tiPmove').innerHTML = pulseHtml()+pulseHtml(); }
    renderPulse();

    /* ================= LIVE DATA ================= */
    var FIRM_PRESERVE = ['Skidmore, Owings & Merrill', 'Robert A.M. Stern Architects'];
    var PIPELINE = ['announced', 'breaking ground'];   // the "↑" delta signal
    function isPipe(p){ return PIPELINE.indexOf(String(p.Delivery||'').trim().toLowerCase()) !== -1; }
    function splitFirms(value){
      if(!value) return [];
      var v = String(value); var ph = [];
      FIRM_PRESERVE.forEach(function(name,i){
        var token='__P'+i+'__'; var re=new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
        if(re.test(v)){ ph.push({t:token,n:name}); v=v.replace(re,token); }
      });
      return v.split(/\s*[,/]\s*/).map(function(s){ var o=s.trim(); ph.forEach(function(p){ if(o===p.t)o=p.n; }); return o; }).filter(Boolean);
    }
    function tally(projects, type){
      var counts={}, pipe={};
      function bump(b,k){ b[k]=(b[k]||0)+1; }
      projects.forEach(function(p){
        var inP = isPipe(p);
        if(type==='cities'){ var c=(p.City||'').trim(); if(!c) return; bump(counts,c); if(inP)bump(pipe,c); }
        else { splitFirms(type==='developers'?p.Developer:p.Architect).forEach(function(n){ if(n.toLowerCase()==='various')return; bump(counts,n); if(inP)bump(pipe,n); }); }
      });
      return Object.keys(counts).map(function(k){ return {n:k, c:counts[k], d:pipe[k]||0}; })
        .sort(function(a,b){ return b.c-a.c || b.d-a.d || a.n.localeCompare(b.n); }).slice(0,9);
    }
    function ageLabel(iso){
      try{ var t=new Date(iso).getTime(); if(isNaN(t)) return ''; var h=Math.max(0,Math.round((Date.now()-t)/3600000));
        return h<1?'now':h<24?h+'h':Math.round(h/24)+'d'; }catch(e){ return ''; }
    }
    fetch(PROJECTS_URL, {cache:'no-store'}).then(function(r){ return r.ok?r.json():null; }).then(function(rows){
      if(!Array.isArray(rows) || !rows.length) return;
      DATA.cities.rows = tally(rows,'cities');
      DATA.developers.rows = tally(rows,'developers');
      DATA.architects.rows = tally(rows,'architects');
      renderBoard(curTab);
      // headstats + command-bar + CTA totals
      baseCount = rows.length;
      var nEl = $('.headstats .headstat .n'); if(nEl) nEl.textContent = baseCount;   // "Projects tracked" live; "40+ markets" stays curated
      if(rEl) rEl.textContent = baseCount+' results';
      var ctaP = $('.cta .ctxt p'); if(ctaP) ctaP.textContent = ctaP.textContent.replace(/\b\d{2,4}\b/, baseCount);
      // live pin counts (by city) + size scaled to the busiest pin
      var cityCount = {}; DATA.cities.rows.forEach(function(r){ cityCount[r.n]=r.c; });
      rows.forEach(function(p){ var c=(p.City||'').trim(); if(c) cityCount[c]=(cityCount[c]||0); });
      var cc={}; rows.forEach(function(p){ var c=(p.City||'').trim(); if(c) cc[c]=(cc[c]||0)+1; });
      var pinVals = [];
      $all('.pin').forEach(function(pin){ var city=PIN_CITY[pin.getAttribute('data-k')]; pinVals.push(city?(cc[city]||0):0); });
      var pmax = Math.max.apply(null, pinVals.concat([1]));
      $all('.pin').forEach(function(pin){
        var city = PIN_CITY[pin.getAttribute('data-k')]; if(!city) return;
        var c = cc[city]; if(c==null) return; var bub = pin.querySelector('.bub'); if(!bub) return;
        var size = Math.round(30 + (c/pmax)*26);
        bub.textContent = c; bub.style.width=size+'px'; bub.style.height=size+'px'; bub.style.fontSize=Math.max(11,Math.round(size*0.3))+'px';
      });
    }).catch(function(){});

    fetch(PULSE_URL, {cache:'no-store'}).then(function(r){ return r.ok?r.json():null; }).then(function(d){
      var ev = d && (Array.isArray(d)?d:d.events); if(!ev || !ev.length) return;
      PULSE = ev.slice(0,14).map(function(e){ return [ (e.title||e.project_title||'').trim(), ageLabel(e.timestamp) ]; }).filter(function(x){ return x[0]; });
      renderPulse();
      var fresh = ev.filter(function(e){ try{ return (Date.now()-new Date(e.timestamp).getTime()) < 7*86400000; }catch(_){ return false; } }).length;
      var tag = $('.pulse .ptag'); if(tag) tag.innerHTML = '<span class="pip"></span>Pulse'+(fresh?' · '+fresh+' new':'');
    }).catch(function(){});
  
  }
})();