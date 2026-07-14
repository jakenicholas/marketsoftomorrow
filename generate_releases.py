#!/usr/bin/env python3
"""Build the /releases archive: TMW's LinkedIn newsletter editions, reader
pages + an index. Newest edition stacks on top. To add a new edition, prepend
its dict to EDITIONS and re-run — nothing else changes.

Output:
  journal/releases/index.html            (archive landing, newest first)
  journal/releases/<slug>/index.html      (one reader per edition)

Images live in journal/releases/img/ (already committed). Body blocks:
  ("h", text)     section heading (Fraunces)
  ("p", html)     paragraph (inline HTML allowed: <a>, <b>, <em>)
  ("img", file)   full-bleed figure from releases/img/<file>
  ("ul", [items]) list
"""
import html, os

ROOT_URL  = "https://www.oftmw.com"
SITE_NAME = "Markets of Tomorrow"
OUT_DIR   = "journal/releases"

def e(s): return html.escape(str(s or ""), quote=True)

# ── Editions (newest FIRST) ───────────────────────────────────────────────
EDITIONS = [
  {
    "slug": "edition2", "num": 2,
    "title": "The database learned to follow the money",
    "dek": "Following the money, a proactive weekly Brief, and answers that are doors instead of dead ends.",
    "date_iso": "2026-07-12", "date_label": "July 12, 2026",
    "window": "The week of July 5, 2026",
    "cover": "ed2-0.jpg",
    "linkedin": "https://www.linkedin.com/pulse/database-learned-follow-money-jake-nicholas-25sce",
    "body": [
      ("p", "There was about $67 billion sitting inside our own database this week that we could not query."),
      ("p", "It was all there. Roughly 169 financing events across 64 markets, the loan amounts, the lenders behind them. But it was trapped as prose, one sentence buried in a press release we had logged as a milestone. Our database knew a tower had closed on construction financing. It did not know that the loan was $340 million and that Bank OZK or Madison Realty Capital wrote it, because that fact was a phrase in a note, not a number in a field. So we could show you the concrete. We could not show you the capital."),
      ("p", "Last week, I argued that the intelligence in what we build does not live in the model, it lives in the graph, the ontology, and the loop. This week was about making the graph deeper. Here is what we shipped."),
      ("img", "ed2-1.jpg"),
      ("h", "Follow the money"),
      ("p", "A development press release is very good at telling you what is being built and almost silent on who is paying for it. That is not an accident. The financing is the part the real estate and investor market actually cares about and the part the public and news feed decides not to lead with to better market towards consumers."),
      ("p", "So we taught the pipeline to read it. Every time our nightly sweep logs a financing milestone now, it captures two things it used to drop on the floor: the loan amount and the lender. And we went back and starting mining the history too, parsing amounts and lender names out of the notes we already had, backfilling hundreds of deals with a real dollar figure. The first version of this tried to parse the money out of the source URLs, which was clever and found exactly one figure in the entire database, so we threw it out and parsed the note itself instead. The boring approach won, which is usually how it goes."),
      ("p", "Here is why this matters more than it looks. The verified pipeline of 1,000+ projects was already the moat. But a pipeline tells you what is rising. Following the money tells you what is real. Capital is the earliest and most honest signal in this business. A project with a construction loan closed is a different animal than a project with a rendering and a prayer, and now the database knows the difference, at the level of dollars and names. We surfaced the first slice of it as a “Follow the Money” module on the Atlas and the homepage. It is the pipeline, but for capital instead of concrete."),
      ("img", "ed2-2.jpg"),
      ("h", "Onyx stopped waiting to be asked"),
      ("p", "Last week, we shipped Deep mode, the Pro layer that reasons across a hundred-plus projects to answer the questions that are briefs, not lookups. That was still a thing you had to go ask."),
      ("p", "This week Onyx started answering before you ask. We shipped the weekly Brief, a running read on your specific beat, the markets, firms, and projects you follow, assembled into what moved this week and pinned as a card every Friday. You do not query it. It arrives. The watchlist that used to be a static list of things you saved grew up into something that hunts while you sleep and hands you the results on Monday morning."),
      ("p", "The shift here is too small to describe and too large in practice. Reactive intelligence answers well. Proactive intelligence changes what you pay attention to. The most valuable thing an analyst does is not answer your question, but tell you the thing you did not know to ask about. That is the direction the Brief points, and it is the direction everything we build is walking."),
      ("img", "ed2-3.jpg"),
      ("h", "Every answer is a door now"),
      ("p", "The last piece is the least glamorous and the one I like most. Onyx answers used to be dead ends. Beautiful paragraphs, and then nothing, a wall of text you had to copy a name out of and paste into a new search."),
      ("p", "Now every firm and every market inside an answer is a live link deeper into the database. Ask about a developer, and the answer lists every market they are in, not just their home city, each one clickable. Ask a country-level question, China and twenty others that used to return a blank, and it resolves."),
      ("p", "An answer that dead-ends is a lookup. An answer you can walk into is a graph. We spent the week turning the first into the second."),
      ("p", "We also shipped a pre-generated thumbnail system to speed up image loads and then deleted it 48 hours later when it added more moving parts than it saved. Owning the whole stack means we get to make that call and unmake it in two days without asking anyone. That freedom is worth more than the thumbnails were."),
      ("h", "What this compounds toward"),
      ("p", "None of this is a private demo. The map, the Atlas, and Onyx are live at <a href=\"https://www.oftmw.com\">www.oftmw.com</a> and the everyday layer is free, so you can open it right now, watch a city’s skyline fill in year by year, and ask a question in plain English. TMW Pro is where it opens all the way up: Deep mode, the full dossier on every project, the weekly Brief on your beat, and the capital picture underneath it all. If you follow luxury real estate, it is worth ten minutes of poking around."),
      ("p", "The through-line of the week is the same argument as last week, one step further along. The model is rented and getting cheaper by the month. What we own is a verified database of 1,000+ projects that now follows the money, an intelligence engine that comes to you instead of waiting to be asked, and answers that are doors instead of dead ends. The model is the cheapest part. Everything that compounds is ours."),
    ],
  },
  {
    "slug": "edition1", "num": 1,
    "title": "The model is the cheapest part",
    "dek": "One shared brain that learns from every edit, Deep mode, and the day we deleted a 29,000-token prompt and the answers got better.",
    "date_iso": "2026-07-05", "date_label": "July 5, 2026",
    "window": "The week of June 28, 2026",
    "cover": "ed1-0.jpg",
    "linkedin": "https://www.linkedin.com/pulse/model-cheapest-part-jake-nicholas-irmue",
    "body": [
      ("p", "This week we deleted a 29,000-token prompt from our AI, and the answers got better."),
      ("p", "For months, every rule we had ever learned about how to answer a real estate question got stuffed into the front of the model’s context. 233 handwritten notes, injected on every single query. It felt like intelligence. It was actually a hoarder’s closet. The model spent more effort reading our instructions than reading the data. So we tore it out and replaced it with 20 curated canon rules that always run, plus a retrieval layer that pulls in only the notes relevant to the question being asked. Fewer words in, sharper answers out."),
      ("p", "That one decision is the whole thesis of the week, so let me say it plainly: the model is the cheapest, most replaceable part of what we’re building. The intelligence lives somewhere else. It lives in the graph, the ontology, and the loop. Here’s what we shipped to make that true."),
      ("img", "ed1-1.jpg"),
      ("h", "The brain that grades its own homework"),
      ("p", "Onyx, our intelligence engine, now has one shared brain that every part of the company reads from and writes to. Before this week, we had three brains learning in isolation. The voice rules the article writer used never taught the search engine anything. The real questions people asked Onyx never steered what we wrote about. Three silos, zero compounding."),
      ("img", "ed1-2.jpg"),
      ("p", "Now every human edit is a lesson. When a draft gets written by the machine and then fixed by a person before it is published, we diff the two versions, extract the generalizable rule behind the fix, and stage it for review. Same for the social graphics: edit a caption, and the system learns the caption rule. Approve it once, and it applies everywhere, forever. We also gave the brain a gardener, a weekly pass that finds duplicate and redundant rules and merges them, so the thing prunes itself instead of bloating back into that 29,000-token closet."),
      ("p", "The point is not that the AI writes. Lots of things write. The point is that the writing gets better in a direction that is ours, on a corpus that is ours, and the compounding accrues to us and not to whatever model vendor we happen to be renting this quarter."),
      ("img", "ed1-3.jpg"),
      ("h", "Deep mode, or the difference between a fact and a brief"),
      ("p", "Most AI searches give you a fact. Ask a normal question, get a quick grounded answer. That is our free tier, and it is genuinely useful."),
      ("p", "But the questions that actually matter in this industry are not lookups."),
      ("ul", [
        "Map West Palm Beach’s entire luxury pipeline through 2030, and tell me how much of it is real versus vaporware.",
        "Where is capital rotating now that Miami and Nashville are crowded, and which developers are already there?",
        "Which branded-residence flag (Aston Martin, Bentley, Ritz, Waldorf) is expanding fastest, and what market are they racing into next?",
        "Compare Miami’s Edgewater and West Palm Beach’s waterfront: who’s building more, taller, and faster right now?",
        "Which architects are quietly shaping most of the next decade of South Florida’s skyline?",
        "Give me the full development story of one neighborhood: every project, its status, who’s behind it, and how it reshapes the area.",
      ]),
      ("p", "Those are not facts you retrieve; they are briefs you synthesize, and synthesis needs the whole picture in view at once."),
      ("p", "So we built Deep mode. Flip the toggle and TMW Intelligence stops doing fast lookups and instead reasons across a hundred-plus matched projects from the verified database at the same time, holding all of it in wide context, cross-referencing timelines and developers and delivery track records before it answers. It is slower on purpose. What comes back is not a sentence; it is the kind of memo an analyst would spend an afternoon assembling."),
      ("p", "Here is the part that ties back to the whole thesis. The power of Deep mode is not the model. It is the wide context, plus the verified graph, plus the ontology the model reasons over, the encoded logic of how this industry actually thinks. That “biggest” means gross floor area, not unit count. That a project is announced is not a project delivered. A giant general-purpose model with no database will hand you a confident, beautiful, wrong answer. Deep mode hands you a grounded one, because it is reasoning over facts we verified and rules we wrote."),
      ("p", "And because the intelligence is our data and not the model, we get to be economical about it. Deep runs on the model whose entire value is holding a lot in context, which costs us about 16 cents a query instead of the 53 a heavier writer model would. We cap it so it stays sharp rather than abused. It is a Pro feature, and honestly, it is the first thing I would point a serious real estate person at."),
      ("img", "ed1-4.jpg"),
      ("h", "You can just go use it"),
      ("p", "None of this is a private demo. The journal, atlas, and map are all live. Anyone can open it, search across 1,000+ verified projects, watch a city’s skyline fill in year by year, and ask Onyx a question in plain English right now. That everyday layer is free."),
      ("p", "TMW Pro is where it opens all the way up. Deep mode, the full dossier on every project, the timeline, our intelligence read on where a development is really headed. We built the free layer to be genuinely good and the Pro layer to be the thing you stop wanting to work without. We also run all of it on our own infrastructure now, our own database, our own tracking, our own pipes, which is a boring sentence that mostly means it is fast and the numbers are real. If you follow luxury real estate in our markets, it is worth ten minutes of poking around."),
      ("img", "ed1-5.jpg"),
      ("h", "What this compounds toward"),
      ("p", "The through-line of the week is one idea. The model is rented and getting cheaper by the month. What we own is a verified database of 1,000+ projects, an ontology that encodes how this industry actually reasons, and a loop that gets smarter every time someone touches the work."),
    ],
  },
]

ABOUT = ("Founded in 2022, Markets of Tomorrow is a real-time journal and data "
  "platform tracking the world’s most significant new developments in "
  "hospitality, residential, golf, and dining. We reach 8M+ people a month "
  "across our network of accounts, with focus markets in Florida of Tomorrow, "
  "New York of Tomorrow, Tennessee of Tomorrow, the Caribbean of Tomorrow, and "
  "the Rockies of Tomorrow, plus Hotels of Tomorrow, our global travel arm. It "
  "is all backed by a live database of 1,000+ daily-tracked projects, powered "
  "by an interactive Map, data Atlas, and our proprietary AI research layer, "
  "TMW Intelligence.")

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">')

CSS = """
:root{--ink:#070709;--ink2:#0d0f12;--hair:rgba(255,255,255,.08);--hair2:rgba(255,255,255,.14);
  --cream:#ECEAE5;--white:#fff;--mute:#9AA39C;--mute2:#C2C9C3;
  --purple:#A78BFA;--purple-bright:#C4B5FD;--purple-glow:#B9A6FF;
  --serif:'Fraunces',Georgia,serif;--sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{overflow-x:hidden}
body{background:var(--ink);color:var(--cream);font-family:var(--sans);line-height:1.6;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(900px 560px at 82% -8%,rgba(167,139,250,.10),transparent 60%),radial-gradient(700px 600px at -6% 40%,rgba(167,139,250,.05),transparent 55%)}
a{color:inherit;text-decoration:none}
.wrap{position:relative;z-index:1;max-width:760px;margin:0 auto;padding:0 24px}
.rel-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--purple-bright);font-weight:600;text-shadow:0 0 16px rgba(167,139,250,.5)}
.rel-crumbs{padding:26px 0 0;font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}
.rel-crumbs a:hover{color:var(--purple-bright)}
.rel-crumbs .sep{opacity:.4;margin:0 8px}
.rel-crumbs .rc-cur{color:var(--purple-bright);text-shadow:0 0 14px rgba(167,139,250,.45)}

/* ── Archive index ── */
.rel-hero{padding:52px 0 30px;border-bottom:1px solid var(--hair)}
.rel-hero h1{font-family:var(--serif);font-size:clamp(40px,6.4vw,68px);font-weight:500;letter-spacing:-.022em;line-height:1.02;color:var(--white);margin:16px 0 0;text-wrap:balance}
.rel-hero .sub{font-family:var(--serif);font-style:italic;font-weight:300;font-size:clamp(17px,2.1vw,21px);color:var(--mute2);margin-top:16px;max-width:56ch}
.rel-list{display:flex;flex-direction:column;gap:20px;padding:38px 0 90px}
.rel-card{display:grid;grid-template-columns:360px 1fr;gap:24px;align-items:center;padding:16px 0 16px 16px;border:1px solid var(--hair);border-radius:18px;overflow:hidden;background:linear-gradient(180deg,rgba(167,139,250,.035),transparent 60%);transition:border-color .2s,transform .2s,box-shadow .2s}
.rel-card:hover{border-color:rgba(167,139,250,.42);transform:translateY(-2px);box-shadow:0 24px 60px -30px rgba(167,139,250,.5)}
.rel-card .rc-media{position:relative;overflow:hidden;background:#111;aspect-ratio:16/9;align-self:center;border-radius:12px}
.rel-card .rc-media img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s ease}
.rel-card:hover .rc-media img{transform:scale(1.05)}
.rel-card .rc-body{padding:4px 24px 4px 0;display:flex;flex-direction:column;justify-content:center;min-width:0}
.rel-card .rc-meta{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.rel-card .rc-no{color:var(--purple-bright);font-weight:700}
.rel-card h2{font-family:var(--serif);font-size:clamp(19px,2.1vw,23px);font-weight:500;letter-spacing:-.012em;line-height:1.14;color:var(--white);margin:9px 0 7px}
.rel-card .rc-dek{font-size:12.5px;color:var(--mute2);line-height:1.55}
.rel-card .rc-cta{margin-top:14px;font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--purple-bright);display:inline-flex;align-items:center;gap:7px}
.rel-card .rc-cta svg{width:13px;height:13px;transition:transform .2s}
.rel-card:hover .rc-cta svg{transform:translateX(3px)}
@media(max-width:620px){.rel-card{grid-template-columns:1fr}.rel-card .rc-media{aspect-ratio:16/9;min-height:0}.rel-card .rc-body{padding:0 22px 24px}}

/* ── Reader ── */
.rd-head{padding:44px 0 34px}
.rd-head .meta{display:flex;align-items:center;gap:12px;margin-top:16px;font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.rd-head .meta .no{color:var(--purple-bright);font-weight:700}
.rd-head h1{font-family:var(--serif);font-size:clamp(34px,5.4vw,58px);font-weight:500;letter-spacing:-.02em;line-height:1.04;color:var(--white);margin:18px 0 0;text-wrap:balance}
.rd-head .dek{font-family:var(--serif);font-style:italic;font-weight:300;font-size:clamp(17px,2.1vw,21px);color:var(--mute2);margin-top:18px;max-width:56ch}
.rd-cover{margin:8px 0 6px;border-radius:16px;overflow:hidden;border:1px solid var(--hair)}
.rd-cover img{width:100%;height:auto;display:block}
.rd-body{padding:12px 0 40px}
.rd-body p{font-family:var(--serif);font-weight:300;font-size:19px;line-height:1.72;color:var(--cream);margin:0 0 26px;max-width:64ch}
.rd-body p a{color:var(--purple-bright);border-bottom:1px solid rgba(167,139,250,.4);transition:border-color .2s}
.rd-body p a:hover{border-color:var(--purple-bright)}
.rd-body p b{font-weight:600;color:var(--white)}
.rd-body h2{font-family:var(--sans);font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--purple-bright);margin:44px 0 20px;padding-top:26px;border-top:1px solid var(--hair);text-shadow:0 0 14px rgba(167,139,250,.4)}
.rd-body figure{margin:34px 0 40px;border-radius:14px;overflow:hidden;border:1px solid var(--hair);box-shadow:0 26px 70px -34px rgba(0,0,0,.85)}
.rd-body figure img{width:100%;height:auto;display:block}
.rd-qs{list-style:none;margin:0 0 28px;padding:22px 24px;border:1px solid rgba(167,139,250,.28);border-radius:14px;background:linear-gradient(180deg,rgba(167,139,250,.06),rgba(167,139,250,.015));display:flex;flex-direction:column;gap:13px}
.rd-qs li{font-family:var(--serif);font-style:italic;font-weight:300;font-size:16.5px;line-height:1.5;color:var(--mute2);display:flex;gap:12px}
.rd-qs li::before{content:"";flex:none;width:6px;height:6px;margin-top:11px;border-radius:50%;background:var(--purple-glow);box-shadow:0 0 10px rgba(185,166,255,.8)}
.rd-about{margin:10px 0 0;padding:26px 0 40px;border-top:1px solid var(--hair)}
.rd-about .lbl{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--mute);margin-bottom:12px}
.rd-about p{font-size:14px;line-height:1.65;color:var(--mute2);font-family:var(--sans);font-weight:300;max-width:none}
.rd-foot{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:24px 0 90px}
.rd-foot a{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);display:inline-flex;align-items:center;gap:8px;transition:color .2s}
.rd-foot a:hover{color:var(--purple-bright)}
.rd-foot a svg{width:13px;height:13px}
.rd-foot .li{color:var(--purple-bright)}
"""

def head(title, desc, canonical, og_img):
    return ("<!DOCTYPE html>\n<html lang=\"en\"><head>\n"
      "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
      f"<title>{e(title)}</title>\n"
      f"<meta name=\"description\" content=\"{e(desc)}\">\n"
      f"<link rel=\"canonical\" href=\"{e(canonical)}\">\n"
      "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/media/img/favicon.svg\">\n"
      "<meta property=\"og:type\" content=\"article\">\n"
      f"<meta property=\"og:title\" content=\"{e(title)}\">\n"
      f"<meta property=\"og:description\" content=\"{e(desc)}\">\n"
      f"<meta property=\"og:url\" content=\"{e(canonical)}\">\n"
      f"<meta property=\"og:image\" content=\"{e(og_img)}\">\n"
      "<meta name=\"twitter:card\" content=\"summary_large_image\">\n"
      f"<meta name=\"twitter:image\" content=\"{e(og_img)}\">\n"
      + FONTS + "\n<style>" + CSS + "</style>\n</head>\n<body>\n")

FOOT_SCRIPTS = ('<script src="/_shared/journal-chrome.js" defer></script>\n'
  '<script src="/_shared/journal-dock.js" defer></script>\n</body></html>')

ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'

def render_body(blocks, slug):
    out = []
    for kind, val in blocks:
        if kind == "h":
            out.append(f'<h2>{e(val)}</h2>')
        elif kind == "p":
            out.append(f'<p>{val}</p>')   # val carries trusted inline HTML
        elif kind == "img":
            out.append(f'<figure><img src="/releases/img/{e(val)}" alt="" loading="lazy"></figure>')
        elif kind == "ul":
            lis = ''.join(f'<li>{e(x)}</li>' for x in val)
            out.append(f'<ul class="rd-qs">{lis}</ul>')
    return '\n'.join(out)

def build_reader(ed):
    canonical = f"{ROOT_URL}/releases/{ed['slug']}/"
    og = f"{ROOT_URL}/releases/img/{ed['cover']}"
    desc = ed["dek"]
    h = head(f"Edition {ed['num']}: {ed['title']} — {SITE_NAME}", desc, canonical, og)
    body = f"""
<div class="wrap">
  <nav class="rel-crumbs"><a href="/">TMW</a><span class="sep">/</span><a href="/releases/">The Weekly:Backend</a><span class="sep">/</span>Edition {ed['num']}</nav>
  <header class="rd-head">
    <span class="rel-eyebrow">The Weekly · Edition {ed['num']}</span>
    <h1>{e(ed['title'])}</h1>
    <p class="dek">{e(ed['dek'])}</p>
    <div class="meta"><span>{e(ed['window'])}</span><span>·</span><span>{e(ed['date_label'])}</span></div>
  </header>
  <div class="rd-cover"><img src="/releases/img/{e(ed['cover'])}" alt="{e(ed['title'])}"></div>
  <article class="rd-body">
{render_body(ed['body'], ed['slug'])}
  </article>
  <div class="rd-about">
    <div class="lbl">About Markets of Tomorrow</div>
    <p>{e(ABOUT)} Join and learn more at <a href="https://www.oftmw.com" style="color:var(--purple-bright)">www.oftmw.com</a>.</p>
  </div>
  <div class="rd-foot">
    <a href="/releases/">{ARROW.replace('M13 6l6 6-6 6','M11 6l-6 6 6 6').replace('M5 12h14','M19 12H5')} All releases</a>
    <a class="li" href="{e(ed['linkedin'])}" target="_blank" rel="noopener">Read on LinkedIn {ARROW}</a>
  </div>
</div>
"""
    os.makedirs(f"{OUT_DIR}/{ed['slug']}", exist_ok=True)
    with open(f"{OUT_DIR}/{ed['slug']}/index.html", "w", encoding="utf-8") as f:
        f.write(h + body + FOOT_SCRIPTS)

def build_index():
    canonical = f"{ROOT_URL}/releases/"
    og = f"{ROOT_URL}/releases/img/{EDITIONS[0]['cover']}"
    h = head(f"Releases — The Weekly | {SITE_NAME}",
             "Every edition of The Weekly — the build log of Markets of Tomorrow, newest first.",
             canonical, og)
    cards = []
    for ed in EDITIONS:
        cards.append(f"""
    <a class="rel-card" href="/releases/{e(ed['slug'])}/">
      <div class="rc-media"><img src="/releases/img/{e(ed['cover'])}" alt="{e(ed['title'])}" loading="lazy"></div>
      <div class="rc-body">
        <div class="rc-meta"><span class="rc-no">No. {ed['num']:02d}</span><span>·</span><span>{e(ed['date_label'])}</span></div>
        <h2>{e(ed['title'])}</h2>
        <div class="rc-dek">{e(ed['dek'])}</div>
        <span class="rc-cta">Read the edition {ARROW}</span>
      </div>
    </a>""")
    body = f"""
<div class="wrap">
  <nav class="rel-crumbs"><a href="/">TMW</a><span class="sep">/</span><span class="rc-cur">The Weekly:Backend</span></nav>
  <header class="rel-hero">
    <span class="rel-eyebrow">The Weekly</span>
    <h1>The build log.</h1>
    <p class="sub">Every edition of The Weekly:Backend, what we shipped, and why it compounds.</p>
  </header>
  <div class="rel-list">{''.join(cards)}
  </div>
</div>
"""
    with open(f"{OUT_DIR}/index.html", "w", encoding="utf-8") as f:
        f.write(h + body + FOOT_SCRIPTS)

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for ed in EDITIONS:
        build_reader(ed)
    build_index()
    print(f"Wrote /releases index + {len(EDITIONS)} editions: " + ", ".join(x['slug'] for x in EDITIONS))
