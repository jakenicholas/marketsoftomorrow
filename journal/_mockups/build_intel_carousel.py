#!/usr/bin/env python3
"""Generate 7 text-free TMW Intelligence carousel slide HTMLs (1080x1350).
Each slide = the product UI visual only (no marketing headline/masthead) with a
clean top zone for Jake to add text in his own fonts/style guide. Rendered to PNG
via headless Chrome by the caller."""
import os

OUT = os.path.join(os.path.dirname(__file__), 'intel')
os.makedirs(OUT, exist_ok=True)

CSS = """
:root{--green:#1FDF67;--green-soft:#42EB81;--purple:#A78BFA;--purple-soft:#B9A6FF;
--ink:#0a0b0c;--line:rgba(255,255,255,.10);--mute:rgba(255,255,255,.55);--slate:#8b93a7;--gold:#e6c574;
--serif:Georgia,'Times New Roman',serif;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--mono:ui-monospace,'SF Mono',monospace;}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1350px;overflow:hidden}
body{font-family:var(--sans);color:#fff;position:relative;background:#08090a}
.canvas{position:absolute;inset:0;background:radial-gradient(130% 90% at 50% -8%,#15171b 0%,#0a0b0c 62%)}
/* top zone left clean for headline text overlay */
.textzone{position:absolute;left:0;right:0;top:0;height:430px;background:linear-gradient(180deg,rgba(0,0,0,.55),rgba(0,0,0,0));z-index:5;pointer-events:none}
.tz-guide{display:none}
/* browser frame holding the feature UI */
.stage{position:absolute;left:60px;right:60px;top:430px;bottom:60px;border-radius:30px;border:1px solid var(--line);background:linear-gradient(180deg,#0f1013,#0b0c0e);overflow:hidden;z-index:3;box-shadow:0 40px 90px rgba(0,0,0,.55)}
.bar{height:70px;display:flex;align-items:center;gap:11px;padding:0 30px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.02)}
.dot{width:14px;height:14px;border-radius:50%}
.url{margin-left:16px;font-family:var(--mono);font-size:20px;color:var(--mute)}
.url b{color:#fff}
.body{position:absolute;inset:70px 0 0 0}
/* map */
.map{position:absolute;inset:0;background:linear-gradient(135deg,#0c1418,#0a1013)}
.map::before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:78px 78px}
.water{position:absolute;right:0;top:0;bottom:0;width:33%;background:linear-gradient(90deg,#0a1013,#0e1a24);opacity:.85}
.mpin{position:absolute;width:24px;height:24px;border-radius:50%;background:var(--green);border:2px solid #fff;box-shadow:0 0 0 7px rgba(31,223,103,.16),0 5px 16px rgba(0,0,0,.5)}
.mpin.p{background:var(--purple);box-shadow:0 0 0 7px rgba(167,139,250,.16),0 5px 16px rgba(0,0,0,.5)}
.mpin.g{background:var(--gold);box-shadow:0 0 0 7px rgba(230,197,116,.16),0 5px 16px rgba(0,0,0,.5)}
.mpin.big{width:34px;height:34px}
.chips{position:absolute;left:30px;top:30px;display:flex;gap:13px}
.chip{font-size:20px;font-weight:600;padding:13px 24px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.05)}
.chip.on{background:var(--green);color:#062012;border-color:transparent}
/* dossier */
.dos{position:absolute;inset:0;padding:40px 50px}
.dos-h{display:flex;align-items:center;gap:14px;margin-bottom:34px}
.dos-h .lab{font-family:var(--mono);font-size:19px;letter-spacing:.12em;text-transform:uppercase;color:var(--purple-soft)}
.live{display:inline-flex;align-items:center;gap:9px;font-family:var(--mono);font-size:16px;color:var(--green);margin-left:auto;text-transform:uppercase;letter-spacing:.08em}
.live i{width:11px;height:11px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(31,223,103,.6)}
.tl{position:relative;padding-left:6px}
.tl::before{content:"";position:absolute;left:17px;top:10px;bottom:30px;width:3px;background:linear-gradient(180deg,var(--purple),rgba(167,139,250,.12))}
.row{position:relative;padding:0 0 40px 64px}
.row .d{position:absolute;left:6px;top:4px;width:24px;height:24px;border-radius:50%;background:var(--purple);box-shadow:0 0 0 6px rgba(167,139,250,.16)}
.row .d.done{background:var(--green);box-shadow:0 0 0 6px rgba(31,223,103,.16)}
.row .l{font-size:35px;font-weight:700}
.row .m{font-family:var(--mono);font-size:20px;color:var(--mute);margin-top:8px}
.row .m .dt{color:var(--purple-soft)}
.row .m .sr{color:var(--green-soft)}
/* pulse */
.pulse{position:absolute;inset:0;padding:30px 34px}
.ph{display:flex;align-items:center;gap:13px;margin-bottom:18px}
.ph i{width:14px;height:14px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(31,223,103,.6)}
.ph b{font-size:34px;font-weight:800}.ph span{font-family:var(--mono);font-size:18px;color:var(--mute)}
.pr{display:flex;gap:20px;padding:22px 6px;border-bottom:1px solid var(--line);align-items:center}
.pr .im{width:86px;height:86px;border-radius:16px;flex:0 0 auto;background:linear-gradient(135deg,#26405a,#0e1c28);border:1px solid var(--line)}
.pr .tg{font-family:var(--mono);font-size:18px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--purple)}
.pr .tt{font-size:30px;font-weight:600;margin-top:5px}
.pr .mt{font-family:var(--mono);font-size:18px;color:var(--mute);margin-top:7px}
.pr .mt .sr{color:var(--green-soft)}
.pr .tg.slate{color:var(--slate)}
/* atlas */
.atlas{position:absolute;inset:0;padding:34px 40px;display:flex;flex-direction:column;gap:26px}
.tiles{display:flex;gap:20px}
.tile{flex:1;border:1px solid var(--line);border-radius:20px;padding:26px 28px;background:rgba(255,255,255,.02)}
.tile .n{font-family:var(--serif);font-size:62px;font-weight:600;letter-spacing:-.02em}
.tile .n .suf{font-size:30px;color:var(--purple-soft)}
.tile .k{font-family:var(--mono);font-size:18px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em;margin-top:6px}
.panel{flex:1;border:1px solid var(--line);border-radius:20px;padding:28px 30px;background:rgba(255,255,255,.02);display:flex;flex-direction:column}
.panel .pt{font-family:var(--mono);font-size:17px;letter-spacing:.1em;text-transform:uppercase;color:var(--purple-soft);margin-bottom:22px}
.bars{display:flex;align-items:stretch;gap:26px;flex:1;padding-bottom:10px;min-height:0}
.barwrap{flex:1;height:100%;display:flex;flex-direction:column;align-items:center;gap:12px;justify-content:flex-end}
.bar2{width:100%;border-radius:10px 10px 0 0;background:linear-gradient(180deg,var(--purple),rgba(167,139,250,.4))}
.barwrap .yl{font-family:var(--mono);font-size:18px;color:var(--mute)}
/* journal grid */
.jr{position:absolute;inset:0;padding:32px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1.3fr 1fr;gap:22px}
.card{border-radius:18px;overflow:hidden;position:relative;border:1px solid var(--line);background:#10141a}
.card.feat{grid-row:span 1;grid-column:span 2}
.card .img{position:absolute;inset:0;background:radial-gradient(120% 100% at 70% 10%,#2a3f57,#0e1a26)}
.card .img.b{background:radial-gradient(120% 100% at 30% 20%,#3a2f24,#16100a)}
.card .img.c{background:radial-gradient(120% 100% at 50% 10%,#23323f,#0c1117)}
.card .scrim{position:absolute;inset:0;background:linear-gradient(180deg,transparent 30%,rgba(0,0,0,.85))}
.card .mast{position:absolute;top:18px;left:20px;font-family:var(--mono);font-size:15px;letter-spacing:.18em;color:rgba(255,255,255,.7)}
.card .hl{position:absolute;left:22px;right:22px;bottom:20px;font-family:var(--serif);font-size:32px;font-weight:600;line-height:1.12}
.card.sm .hl{font-size:24px}
.card .pin2{position:absolute;left:22px;bottom:108px;font-family:var(--mono);font-size:14px;letter-spacing:.12em;color:var(--green-soft);text-transform:uppercase}
/* hero */
.hero{position:absolute;inset:0;background:radial-gradient(120% 80% at 72% 18%,#1a3147 0%,#0b1a26 52%,#070d12 100%)}
.glow{position:absolute;left:50%;bottom:-220px;transform:translateX(-50%);width:900px;height:600px;background:radial-gradient(closest-side,rgba(31,223,103,.20),transparent);filter:blur(20px)}
.sky{position:absolute;left:0;right:0;bottom:0;height:620px;opacity:.92}
.mark{position:absolute;left:50%;bottom:230px;transform:translateX(-50%);width:150px;height:150px;border-radius:50%;border:3px solid rgba(255,255,255,.9);display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-size:74px;color:#fff;z-index:6}
.cta-mark{position:absolute;left:0;right:0;bottom:140px;text-align:center;font-family:var(--mono);font-size:30px;letter-spacing:.18em;color:#fff;z-index:6}
"""

def page(body, full=False):
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body>{body}</body></html>"""

def frame(url, inner):
    return f"""<div class="canvas"></div>
<div class="stage"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="url">{url}</span></div>
<div class="body">{inner}</div></div>
<div class="textzone"></div><div class="tz-guide">headline zone — add in your style guide</div>"""

# ---- slide bodies ----
slides = {}

# 1 — HERO (pure canvas, montage glow + skyline + TMW mark)
slides['1-hero'] = """<div class="hero"></div>
<svg class="sky" viewBox="0 0 1080 620" preserveAspectRatio="none"><g fill="#0a1620">
<rect x="30" y="250" width="120" height="370"/><rect x="170" y="160" width="95" height="460"/><rect x="285" y="300" width="70" height="320"/>
<rect x="375" y="90" width="120" height="530"/><rect x="515" y="210" width="85" height="410"/><rect x="620" y="60" width="135" height="560"/>
<rect x="775" y="200" width="100" height="420"/><rect x="895" y="130" width="125" height="490"/></g>
<g fill="rgba(31,223,103,.55)"><rect x="410" y="120" width="9" height="9"/><rect x="445" y="170" width="9" height="9"/><rect x="660" y="100" width="9" height="9"/><rect x="700" y="160" width="9" height="9"/><rect x="930" y="170" width="9" height="9"/></g></svg>
<div class="glow"></div><div class="mark">T</div>
<div class="textzone" style="height:520px"></div><div class="tz-guide">headline zone — TMW Intelligence</div>"""

# 2 — MAP
slides['2-map'] = frame('map.<b>oftmw.com</b>', """<div class="map"><div class="water"></div>
<div class="chips"><span class="chip on">Miami</span><span class="chip on">Towers</span><span class="chip">Hotels</span></div>
<div class="mpin big" style="left:18%;top:42%"></div><div class="mpin p" style="left:33%;top:58%"></div><div class="mpin" style="left:26%;top:72%"></div>
<div class="mpin g" style="left:46%;top:40%"></div><div class="mpin p" style="left:40%;top:78%"></div><div class="mpin" style="left:55%;top:62%"></div>
<div class="mpin" style="left:60%;top:34%"></div><div class="mpin p big" style="left:50%;top:54%"></div><div class="mpin g" style="left:30%;top:46%"></div>
<div class="mpin" style="left:22%;top:60%"></div><div class="mpin" style="left:44%;top:50%"></div></div>""")

# 3 — DOSSIER (story so far, live daily)
slides['3-dossier'] = frame('oftmw.com/<b>south-flagler-house</b>', """<div class="dos">
<div class="dos-h"><span class="lab">Milestones — the story so far</span><span class="live"><i></i>Updated daily</span></div>
<div class="tl">
<div class="row"><span class="d done"></span><div class="l">Announced</div><div class="m"><span class="dt">2022</span> · <span class="sr">oftmw.com ↗</span></div></div>
<div class="row"><span class="d done"></span><div class="l">Financing secured</div><div class="m"><span class="dt">Jun 2025</span> · <span class="sr">oftmw.com ↗</span></div></div>
<div class="row"><span class="d done"></span><div class="l">Going vertical</div><div class="m"><span class="dt">Nov 2024</span> · <span class="sr">therealdeal ↗</span></div></div>
<div class="row"><span class="d"></span><div class="l">Topped out</div><div class="m"><span class="dt">Nov 2025</span> · <span class="sr">oftmw.com ↗</span></div></div>
</div></div>""")

# 4 — PULSE
slides['4-pulse'] = frame('oftmw.com/<b>map</b> · Pulse', """<div class="pulse">
<div class="ph"><i></i><b>Pulse</b><span>latest across the network</span></div>
<div class="pr"><div class="im"></div><div><div class="tg">Financing secured</div><div class="tt">15 CityPlace</div><div class="mt">Dec 2025 · West Palm Beach · <span class="sr">oftmw.com ↗</span></div></div></div>
<div class="pr"><div class="im"></div><div><div class="tg">Topped out</div><div class="tt">The Perigon Miami Beach</div><div class="mt">Mar 2026 · Miami Beach · <span class="sr">floridayimby ↗</span></div></div></div>
<div class="pr"><div class="im"></div><div><div class="tg">Halfway there</div><div class="tt">Waldorf Astoria Residences</div><div class="mt">Dec 2025 · Miami · <span class="sr">floridayimby ↗</span></div></div></div>
<div class="pr"><div class="im"></div><div><div class="tg slate">Now tracking</div><div class="tt">18 new projects</div><div class="mt">The Benson, The Henry, The Willow +15</div></div></div>
</div>""")

# 5 — ATLAS (intelligence dashboard)
slides['5-atlas'] = frame('oftmw.com/<b>atlas</b>', """<div class="atlas">
<div class="tiles">
<div class="tile"><div class="n">381</div><div class="k">Projects tracked</div></div>
<div class="tile"><div class="n">112<span class="suf"></span></div><div class="k">Under construction</div></div>
<div class="tile"><div class="n">29<span class="suf"></span></div><div class="k">Opening this year</div></div>
</div>
<div class="panel"><div class="pt">Openings by year</div>
<div class="bars">
<div class="barwrap"><div class="bar2" style="height:38%"></div><div class="yl">24</div></div>
<div class="barwrap"><div class="bar2" style="height:55%"></div><div class="yl">25</div></div>
<div class="barwrap"><div class="bar2" style="height:78%"></div><div class="yl">26</div></div>
<div class="barwrap"><div class="bar2" style="height:100%"></div><div class="yl">27</div></div>
<div class="barwrap"><div class="bar2" style="height:64%"></div><div class="yl">28</div></div>
<div class="barwrap"><div class="bar2" style="height:30%"></div><div class="yl">29</div></div>
</div></div></div>""")

# 6 — JOURNAL
slides['6-journal'] = frame('<b>oftmw.com</b>', """<div class="jr">
<div class="card feat"><div class="img"></div><div class="scrim"></div><div class="mast">FLORIDA OF TMW</div><div class="pin2">West Palm Beach</div><div class="hl">Over thirty projects that are transforming West Palm Beach</div></div>
<div class="card sm"><div class="img b"></div><div class="scrim"></div><div class="mast">FLORIDA OF TMW</div><div class="hl">Jeff Greene plans Florida's tallest mass timber tower</div></div>
<div class="card sm"><div class="img c"></div><div class="scrim"></div><div class="mast">FLORIDA OF TMW</div><div class="hl">A $45.5M penthouse in downtown Tampa hits the market</div></div>
</div>""")

# 7 — CTA
slides['7-cta'] = """<div class="hero" style="background:radial-gradient(120% 90% at 50% 0%,#143025 0%,#0a1410 55%,#07090a 100%)"></div>
<div class="map" style="opacity:.45"><div class="water"></div>
<div class="mpin" style="left:18%;top:40%"></div><div class="mpin p" style="left:33%;top:58%"></div><div class="mpin g" style="left:46%;top:44%"></div><div class="mpin" style="left:60%;top:34%"></div><div class="mpin p big" style="left:50%;top:60%"></div><div class="mpin" style="left:26%;top:70%"></div></div>
<div class="glow"></div><div class="mark" style="bottom:auto;top:430px">T</div>
<div class="cta-mark">oftmw.com</div>
<div class="textzone" style="height:430px;background:linear-gradient(180deg,rgba(0,0,0,.7),rgba(0,0,0,0))"></div><div class="tz-guide">call-to-action zone</div>"""

for name, body in slides.items():
    with open(os.path.join(OUT, name + '.html'), 'w') as f:
        f.write(page(body))
print("wrote", len(slides), "slides to", OUT)
print(" ".join(sorted(slides.keys())))
