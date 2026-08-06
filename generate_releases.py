#!/usr/bin/env python3
"""Build the /releases archive: TMW's LinkedIn newsletter editions, reader
pages + an index. Newest edition stacks on top. To add a new edition, prepend
its dict to EDITIONS and re-run; nothing else changes.

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

import glob, re, shutil

DIGEST_SRC = "newsletter/digest-archive"
DIGEST_OUT = OUT_DIR + "/digest"   # served copies at /releases/digest/<date>/

def _digest_title(text):
    m = re.search(r'<title>\s*([^<\n]{6,120})</title>', text)
    if m and 'intentionally' not in m.group(1).lower():
        return m.group(1).strip()
    m = re.search(r'(?:preheader|preview|hidden)[^>]*>\s*([^<\n]{10,140})', text, re.I)
    if m:
        t = re.sub(r'\s+', ' ', m.group(1)).strip()
        # trim a long preheader to a clean ~9-word headline
        words = t.split(' ')
        return ' '.join(words[:11]).rstrip(',;: ') + ('…' if len(words) > 11 else '')
    return 'Weekly digest'

MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
def _date_label(iso):
    y, m, d = iso.split('-')
    return f"{MONTHS[int(m)-1]} {int(d)}, {y}"

# Curated title overrides + editions to skip (Jake, 2026-07-13).
DIGEST_TITLES = {
    '2026-06-09': 'First U.S. Restaurant, Private Clubs & New Schools',
    '2026-06-16': 'Restaurant and District Expansions, New Hotels & More',
    '2026-06-23': '$1 Billion Districts, New Restaurants & Wellness Concepts',
    '2026-06-30': 'New Autonomous Car Network, Clubs, and Condos',
    '2026-07-07': 'Groundbreakings, Luxury Condos & Wellness',
    '2026-07-15': 'New Condos, Wellness & New Features',
    '2026-07-21': 'Home Premiums, New Hotels & More',
}
DIGEST_SKIP = {'2026-06-03', '2026-06-10'}

def discover_digests():
    out = []
    for fp in sorted(glob.glob(DIGEST_SRC + "/*.html"), reverse=True):
        base = os.path.basename(fp)[:-5]   # YYYY-MM-DD
        if not re.match(r'^\d{4}-\d{2}-\d{2}$', base):
            continue
        if base in DIGEST_SKIP:
            continue
        txt = open(fp, encoding='utf-8', errors='replace').read()
        title = DIGEST_TITLES.get(base) or _digest_title(txt)
        out.append({'date': base, 'date_label': _date_label(base),
                    'title': title, 'src': fp})
    return out

# ── Editions (newest FIRST) ───────────────────────────────────────────────
EDITIONS = [
  {
    "slug": "edition4", "num": 4,
    "title": "Four things you can go open right now",
    "dek": "The Atlas became an instrument, saved views and My Book, the Opening Radar, and The Passport.",
    "date_iso": "2026-08-04", "date_label": "August 4, 2026",
    "window": "The week of July 28, 2026",
    "cover": "ed4-0.png",
    "linkedin": "https://www.linkedin.com/pulse/four-things-you-can-open-right-now-jake-nicholas-kyuyf/",
    "body": [
      ("p", "West Palm Beach's supply-pressure line climbs to 100 and stays pinned there. Nashville's dips back into balanced in 2028 and eases off. Until this week you could see one number per market. Now you can put five markets on a single chart and watch the lines cross."),
      ("p", "Most weeks here I write about plumbing: the ontology, the learning loop, the verification gates. This week was the other kind. Four things shipped that anyone can go open, and they are the clearest picture yet of what the database is actually for."),
      ("h", "The Atlas became an instrument"),
      ("p", "The Atlas is our data surface, and it used to read like a report. Now it reads like a tool you operate. Eight views, each its own page: Overview, Markets, Projects, Firms, Supply, Pricing, Capital, Pipeline."),
      ("p", "At the top sits the master chart. The markets are the series and the metric is the lens, so you add up to five markets as purple pills and swap what the chart is measuring underneath them, with a 6-month, 1-year, 2-year, or all-time range toggle. Search a market and it becomes a pill that filters the entire page, tiles, leaderboards, supply cards and chart together."),
      ("img", "ed4-0.png"),
      ("p", "The best thing on it is supply pressure over time. A month ago we shipped it as a single score per market, how crowded a delivery calendar is getting. This week it became a trajectory: the same model run at every forward half-year across a five-year horizon, so you see saturation build as a wave of towers approaches and ease after it lands. Each line's color runs on a gradient keyed to its own height, green through yellow into deep red, so a market climbing into trouble looks like it. Zone bands behind it, a crosshair that names every market's zone at that point in time."),
      ("p", "And every metric carries a truth label. Tap the (i) and it tells you plainly what the number is, whether it's a modeled judgment or a curated count or a sourced floor, what it excludes, how confident the model is, and the as-of date. I care about that more than the chart. A number without its provenance is a vibe."),
      ("p", "Two smaller ones I like. The market picker now groups by region instead of dumping eighty cities in a wall, backed by a region table for 75 countries that lives in our ontology, so the map, the Atlas and our automated routines all agree on what continent something is on. And market pages now compare a market to its real geographic neighbors. London used to get compared to Coral Gables because their supply scores were close. Now London gets Paris and Lisbon, and when a market genuinely has no peers the module says \"comparable markets\" instead of pretending they're neighbors."),
      ("h", "Your own instrument: saved views and My Book"),
      ("p", "Any slice of the Atlas can be saved as a view, and a saved view isn't a bookmark. It lands on your dashboard as a live module that recomputes its own count through the same matching logic the Atlas and the map use, so a tile can never disagree with the page it links to. And because an empty grid is the standard failure of a build-your-own dashboard, there are three one-click starting bundles: Developer, Broker, Investor, each seeded from the markets you already follow."),
      ("p", "Under that is My Book, which is the thing I open most. Tap the bell on any project anywhere on the site, on the map, on the radar, inside an Onyx answer, in an article, and it goes into your book. The book is a table: every project you track with a progress bar against its delivery, the delivery date itself, and a movement column showing its last dated move. Above it, four live reads: how many projects you're tracking and how many moved this week, the supply pressure of your top market, the total construction capital tracked across your book, and your next delivery. Market chips filter the whole thing to one city."),
      ("p", "Then every Monday you get a brief. Week of the 3rd, the moves on your watchlist, pulled from what actually happened on your projects, your followed markets and your followed firms in the last seven days, written up by Onyx."),
      ("p", "That is the honest pitch for the whole platform: not \"here is a database,\" but \"here is your book, and here is what moved in it while you were busy.\""),
      ("h", "The Opening Radar"),
      ("p", "Then we turned the pipeline into something you'd browse for fun. Hotels of Tomorrow got the Opening Radar, a live board of every tracked hotel in the forward pipeline, 304 with photography across 37 countries, sorted by what opens next. Filter rows for location, opening window (next 6 months, 2026, 2027, 2028 and beyond), brand, and stage, with the brand list derived from the live data rather than a list I maintain. Gold means opening soon, green means building, purple means announced. Every card has a bell."),
      ("p", "Golf of Tomorrow got the same build a day later with a filter row of course designers and developers, so you can pull up everything Cabot or a specific architect has coming. Restaurants too."),
      ("p", "The pipeline maintains itself underneath. A project flips from Opening Soon to Now Open on its stated opening date, and the flip has to cite something, our own coverage of that project if we have it, the developer's official site if we don't, so the marker always links to something you can verify. Freshly opened properties pin to the top of the radar for four months and then clear out on their own."),
      ("h", "The Passport"),
      ("p", "The one I did not expect to enjoy this much. We publish iconic lists of hotels, golf courses and restaurants. Now you tap \"I've been\" on any of them and it saves to your account, one tap, no form. Those check-ins feed a single running level along with your travel, and there's a public leaderboard ranking everyone by hotels, courses, restaurants and total. Opt out any time, and no email is ever shown, only the name you chose."),
      ("p", "For two years we've written about these places. Now the people who have actually walked into them write back, and that record of where our audience has been is a layer nobody else has."),
      ("h", "What this compounds toward"),
      ("p", "All four of those are one idea wearing four faces. We spend most weeks on the unglamorous part: a verified database of 1,600+ developments, the ontology that encodes what our categories actually mean, and the verification gates that make sure nothing enters it that can't be proven. That work is invisible on purpose. This week is what it was for. A chart that can be trusted enough to argue with, a book that tells you what moved, a radar you can browse over coffee, a passport worth filling in."),
      ("p", "The everyday layer is free, so go open the map, filter a market, and ask Onyx something in plain English. TMW Pro is where it opens all the way: Deep mode reasoning across a hundred-plus verified projects at once, the full dossier on every building, the whole radar instead of the first screen, and the supply and pricing read underneath a market. Worth ten minutes of poking around."),
      ("p", "The model is still the rented part. The chart, the book, the radar and the graph underneath them are ours."),
    ],
  },
  {
    "slug": "edition3", "num": 3,
    "title": "The record became a forecast",
    "dek": "A projection layer on the verified pipeline, pricing bands comped to delivery, and a learning loop that grades its own homework.",
    "date_iso": "2026-07-20", "date_label": "July 20, 2026",
    "window": "The week of July 13, 2026",
    "cover": "ed3-0.jpg",
    "linkedin": "https://www.linkedin.com/pulse/edition-3-record-became-forecast-jake-nicholas-64lre",
    "body": [
      ("p", "Right now our database is tracking 100+ luxury developments in Miami. Almost 30,000 units. 21 of them are scheduled to deliver inside the next 24 months."),
      ("p", "For a while, that is all we told you: that each of those projects had been announced, financed, topped out, and when. A record of what exists. What we did not tell you was the thing that actually matters to anyone with money in the ground, which is what happens when 21 towers try to sell into the same two-year window. This week we taught the database to answer that."),
      ("p", "Two weeks ago I argued that the intelligence in what we build does not live in the model, it lives in the graph, the ontology, and the loop. This week we did the two things that only that architecture lets you do. We turned the record into a forecast, and we taught the loop to grade its own work. Here is what shipped."),
      ("img", "ed3-1.jpg"),
      ("h", "Supply pressure, or seeing the traffic jam coming"),
      ("p", "We built a projection layer on top of the verified pipeline. The first piece is supply pressure: a score, market by market, for how crowded the delivery calendar is getting. Miami sits at 92 out of 100, Saturated. Miami Beach 96. West Palm Beach 89 across 54 developments. New York, with a longer-dated pipeline, comes in at 65, Elevated. 87 markets modeled so far, each one reading its own forward calendar of what delivers, when, and how many units land in the same six-month window."),
      ("p", "Then we went a layer deeper, onto individual buildings: modeled pricing bands, comped off nearby delivered inventory, appreciated out to delivery, with bear, base, and bull scenarios. Never a listing price; we do not show those. A defensible read on where a specific project prices when it opens, always labeled as modeled, always carrying its confidence."),
      ("p", "Here is why this is a different animal than what came before. Anybody can tell you a tower was announced. A general model with no database will happily invent a number for you. Neither can tell you that a specific market is about to absorb more supply than it has ever delivered in a single year, because that requires knowing the real delivery date and the real square footage of every project in the pipeline, verified, at once. We own that. So the projection is ours to compute. The pipeline told you what is rising. Supply pressure tells you what that does to the market it is rising into. We took it bicoastal this week too, modeling New York alongside Florida, 520 Fifth Avenue and the rest."),
      ("img", "ed3-2.jpg"),
      ("h", "The loop got a scoreboard"),
      ("p", "The quieter half of the week is the one I like more. Last week the learning loop got smarter every time a person corrected the machine. The obvious problem with a loop like that is you cannot see whether it is actually working. You are trusting that the corrections add up."),
      ("p", "So this week we gave it a scoreboard. The brain now runs an honest experiment on itself. It writes a fresh draft of one of our best pieces with the learned brain switched on, writes the same piece with it switched off, and has a judge score both against the real published version. We can finally see the delta the loop is buying us, and we pin every score to the exact version of the brain that produced it. We also started measuring how much of the machine’s first draft survives all the way to the published piece, which is the cleanest quality signal we have."),
      ("p", "Then the shift that matters. The loop stopped only learning from what got fixed and started learning from what worked. It now reads our best-performing published articles and our top Instagram posts, the ones that actually earned saves and shares, and distills the voice behind them back into the brain. Correction taught it what to avoid. Performance teaches it what to reach for. And the whole pipeline, the distillers, the self-tuning, the pruning, now runs itself on a weekly cycle with nobody pressing a button. A loop you cannot measure is a guess. This one grades its own homework and tunes toward the answer."),
      ("img", "ed3-3.jpg"),
      ("h", "What this compounds toward"),
      ("p", "The map, the Atlas, and Onyx are live at <a href=\"https://www.oftmw.com\">www.oftmw.com</a>, and the everyday layer is free, so you can open it right now, watch a skyline fill in year by year, and ask a question in plain English. TMW Pro is where it opens all the way: Deep mode, the full dossier on every project, and now the projection underneath a market, how crowded its calendar is, and where a building prices when it opens."),
    ],
  },
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
      ("img", "ed2-2.jpg"),
      ("p", "So we taught the pipeline to read it. Every time our nightly sweep logs a financing milestone now, it captures two things it used to drop on the floor: the loan amount and the lender. And we went back and starting mining the history too, parsing amounts and lender names out of the notes we already had, backfilling hundreds of deals with a real dollar figure. The first version of this tried to parse the money out of the source URLs, which was clever and found exactly one figure in the entire database, so we threw it out and parsed the note itself instead. The boring approach won, which is usually how it goes."),
      ("p", "Here is why this matters more than it looks. The verified pipeline of 1,000+ projects was already the moat. But a pipeline tells you what is rising. Following the money tells you what is real. Capital is the earliest and most honest signal in this business. A project with a construction loan closed is a different animal than a project with a rendering and a prayer, and now the database knows the difference, at the level of dollars and names. We surfaced the first slice of it as a “Follow the Money” module on the Atlas and the homepage. It is the pipeline, but for capital instead of concrete."),
      ("img", "ed2-3.jpg"),
      ("h", "Onyx stopped waiting to be asked"),
      ("p", "Last week, we shipped Deep mode, the Pro layer that reasons across a hundred-plus projects to answer the questions that are briefs, not lookups. That was still a thing you had to go ask."),
      ("p", "This week Onyx started answering before you ask. We shipped the weekly Brief, a running read on your specific beat, the markets, firms, and projects you follow, assembled into what moved this week and pinned as a card every Friday. You do not query it. It arrives. The watchlist that used to be a static list of things you saved grew up into something that hunts while you sleep and hands you the results on Monday morning."),
      ("p", "The shift here is too small to describe and too large in practice. Reactive intelligence answers well. Proactive intelligence changes what you pay attention to. The most valuable thing an analyst does is not answer your question, but tell you the thing you did not know to ask about. That is the direction the Brief points, and it is the direction everything we build is walking."),
      ("img", "ed2-4.jpg"),
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
    "cover": "ed1-0.jpg", "cover_pos": "left", "cover_aspect": "1000/720",
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
.rel-hero-top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.rel-seg{display:inline-flex;border:1px solid var(--hair2);border-radius:999px;padding:3px;background:rgba(255,255,255,.03)}
.rel-seg button{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;color:var(--mute);background:none;border:0;cursor:pointer;padding:8px 16px;border-radius:999px;transition:color .2s,background .2s}
.rel-seg button.on{color:#0a0a0a;background:var(--purple-bright);text-shadow:none}
.rel-seg button:not(.on):hover{color:var(--cream)}
/* consumer digest rows: no image, just date + title */
.dig-list{display:flex;flex-direction:column;gap:0;padding:34px 0 90px}
.dig-row{display:grid;grid-template-columns:160px 1fr auto;align-items:center;gap:20px;padding:22px 6px;border-top:1px solid var(--hair);text-decoration:none;transition:background .18s,padding-left .18s}
.dig-row:last-child{border-bottom:1px solid var(--hair)}
.dig-row:hover{background:linear-gradient(90deg,rgba(167,139,250,.06),transparent 70%);padding-left:14px}
.dig-date{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}
.dig-title{font-family:var(--serif);font-size:clamp(18px,2vw,22px);font-weight:500;letter-spacing:-.012em;color:var(--white);line-height:1.2}
.dig-arr{color:var(--purple-bright);font-family:var(--mono);font-size:15px;opacity:.55;transition:opacity .2s,transform .2s}
.dig-row:hover .dig-arr{opacity:1;transform:translateX(3px)}
@media(max-width:620px){.dig-row{grid-template-columns:1fr auto;gap:6px 14px}.dig-date{grid-column:1/-1}}
.rel-crumbs{padding:26px 0 0;font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}
.rel-crumbs a:hover{color:var(--purple-bright)}
.rel-crumbs .sep{opacity:.4;margin:0 8px}
.rel-crumbs .rc-cur{color:var(--purple-bright);text-shadow:0 0 14px rgba(167,139,250,.45)}

/* ── Archive index ── */
.rel-hero{padding:52px 0 30px;border-bottom:1px solid var(--hair)}
.rel-hero h1{font-family:var(--serif);font-size:clamp(40px,6.4vw,68px);font-weight:500;letter-spacing:-.022em;line-height:1.02;color:var(--white);margin:16px 0 0;text-wrap:balance}
.rel-hero .sub{font-family:var(--serif);font-style:italic;font-weight:300;font-size:clamp(17px,2.1vw,21px);color:var(--mute2);margin-top:16px;max-width:56ch}
.rel-list{display:flex;flex-direction:column;gap:20px;padding:38px 0 90px}
.rel-list[hidden],.dig-list[hidden]{display:none}
.rel-card{display:grid;grid-template-columns:280px 1fr;gap:24px;align-items:center;padding:16px 0 16px 16px;border:1px solid var(--hair);border-radius:18px;overflow:hidden;background:linear-gradient(180deg,rgba(167,139,250,.035),transparent 60%);transition:border-color .2s,transform .2s,box-shadow .2s}
.rel-card:hover{border-color:rgba(167,139,250,.42);transform:translateY(-2px);box-shadow:0 24px 60px -30px rgba(167,139,250,.5)}
.rel-card .rc-media{position:relative;overflow:hidden;background:#111;aspect-ratio:3/2;align-self:center;border-radius:12px}
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
    h = head(f"Edition {ed['num']}: {ed['title']} | {SITE_NAME}", desc, canonical, og)
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
    h = head(f"Releases | The Weekly | {SITE_NAME}",
             "The Weekly: Backend build log and Consumer digest archive from Markets of Tomorrow.",
             canonical, og)
    # Backend view: the LinkedIn build-log editions
    cards = []
    for ed in EDITIONS:
        # cover_pos: which part of the cover survives the 3:2 side-crop.
        # Default center (even left+right trim); "left" keeps the left edge
        # and trims only from the right (edition 1's map fills the right half).
        pos = ed.get("cover_pos", "center")
        pos_style = ' style="object-position:left center"' if pos == "left" else ''
        # cover_aspect: override the media box ratio to match a pre-cropped
        # cover exactly (w/h), so nothing gets trimmed top/bottom.
        asp = ed.get("cover_aspect")
        media_style = f' style="aspect-ratio:{asp}"' if asp else ''
        cards.append(f"""
    <a class="rel-card" href="/releases/{e(ed['slug'])}/">
      <div class="rc-media"{media_style}><img src="/releases/img/{e(ed['cover'])}" alt="{e(ed['title'])}" loading="lazy"{pos_style}></div>
      <div class="rc-body">
        <div class="rc-meta"><span class="rc-no">No. {ed['num']:02d}</span><span>·</span><span>{e(ed['date_label'])}</span></div>
        <h2>{e(ed['title'])}</h2>
        <div class="rc-dek">{e(ed['dek'])}</div>
        <span class="rc-cta">Read the edition {ARROW}</span>
      </div>
    </a>""")
    # Consumer view: the newsletter digest archive (title + date, no images).
    # Each digest is copied to /releases/digest/<date>/ so it is web-served.
    digests = discover_digests()
    os.makedirs(DIGEST_OUT, exist_ok=True)
    rows = []
    for d in digests:
        dst = f"{DIGEST_OUT}/{d['date']}"
        os.makedirs(dst, exist_ok=True)
        shutil.copyfile(d['src'], f"{dst}/index.html")
        rows.append(f"""
    <a class="dig-row" href="/releases/digest/{e(d['date'])}/">
      <span class="dig-date">{e(d['date_label'])}</span>
      <span class="dig-title">{e(d['title'])}</span>
      <span class="dig-arr">&rarr;</span>
    </a>""")
    body = f"""
<div class="wrap">
  <nav class="rel-crumbs"><a href="/">TMW</a><span class="sep">/</span><span class="rc-cur" id="crumbCur">The Weekly:Backend</span></nav>
  <header class="rel-hero">
    <div class="rel-hero-top">
      <span class="rel-eyebrow" id="relEyebrow">The Weekly:Backend</span>
      <div class="rel-seg" role="tablist">
        <button type="button" data-view="backend" class="on">Backend</button>
        <button type="button" data-view="consumer">Consumer</button>
      </div>
    </div>
    <h1 id="relH1">The build log.</h1>
    <p class="sub" id="relSub">Every edition of The Weekly:Backend, what we shipped, and why it compounds.</p>
  </header>
  <div class="rel-list" data-view="backend">{''.join(cards)}
  </div>
  <div class="dig-list" data-view="consumer" hidden>{''.join(rows)}
  </div>
</div>
<script>
(function(){{
  var COPY = {{
    backend:  {{ eye:'The Weekly:Backend',  h1:'The build log.',   sub:'Every edition of The Weekly:Backend, what we shipped, and why it compounds.' }},
    consumer: {{ eye:'The Weekly:Consumer', h1:'The dispatch.',     sub:'The weekly openings, project updates, and stories.' }}
  }};
  var segs = document.querySelectorAll('.rel-seg button');
  function show(v){{
    document.querySelectorAll('[data-view]').forEach(function(el){{
      if (el.classList.contains('rel-list') || el.classList.contains('dig-list')) el.hidden = (el.getAttribute('data-view') !== v);
    }});
    segs.forEach(function(b){{ b.classList.toggle('on', b.getAttribute('data-view') === v); }});
    var c = COPY[v];
    document.getElementById('relEyebrow').textContent = c.eye;
    document.getElementById('crumbCur').textContent = c.eye;
    document.getElementById('relH1').textContent = c.h1;
    document.getElementById('relSub').textContent = c.sub;
    try {{ history.replaceState(null, '', v === 'consumer' ? '#consumer' : '#backend'); }} catch(_){{}}
  }}
  segs.forEach(function(b){{ b.addEventListener('click', function(){{ show(b.getAttribute('data-view')); }}); }});
  if (location.hash === '#consumer') show('consumer');
}})();
</script>
"""
    with open(f"{OUT_DIR}/index.html", "w", encoding="utf-8") as f:
        f.write(h + body + FOOT_SCRIPTS)


# ── IG story graphic: one 1080x1920 page per edition ─────────────────────────────
# The standing convention: every edition's story graphic lives at
# /releases/<slug>/story/ — open it, screenshot at native size, post it.
# Exports worth keeping go to the Studio media folder "Social / LinkedIn Stories".
# The design is the locked "New Edition" announcement (wordmark, purple glow,
# The build log., edition tile, arrow pill) first shipped for edition 2.
WORDMARK = "https://media.oftmw.com/wix/other/16f511-MARKETSOFTMW.svg"

def build_story(ed):
    h = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex, nofollow"><title>{e(ed["title"])} · Story</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:1080px;height:1920px;overflow:hidden}}
body{{background:#070709;font-family:'Inter',sans-serif;color:#ECEAE5;position:relative}}
.bg{{position:absolute;inset:0;
  background:radial-gradient(1200px 900px at 78% 6%,rgba(167,139,250,.20),transparent 58%),
             radial-gradient(1000px 1100px at -8% 62%,rgba(167,139,250,.10),transparent 55%),
             radial-gradient(900px 700px at 110% 96%,rgba(167,139,250,.12),transparent 55%)}}
.noise{{position:absolute;inset:0;opacity:.05;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}}
.wrap{{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;align-items:center;padding:150px 90px 130px}}
.wordmark{{width:230px;height:auto;display:block}}
.wordmark img{{width:100%;display:block;filter:brightness(0) invert(1)}}
.backend{{font-family:'Fraunces';font-style:italic;font-weight:300;font-size:32px;letter-spacing:.005em;color:#C2C9C3;margin-top:20px}}
.eyebrow{{font-family:'JetBrains Mono';font-size:22px;letter-spacing:.34em;text-transform:uppercase;color:#C4B5FD;font-weight:700;text-shadow:0 0 26px rgba(167,139,250,.6);margin-top:64px}}
.hl{{font-family:'Fraunces';font-weight:500;font-size:100px;line-height:.98;letter-spacing:-.022em;color:#fff;margin-top:26px;text-align:center;text-wrap:balance}}
.tile{{margin-top:auto;margin-bottom:auto;width:90%;border:1px solid rgba(167,139,250,.5);border-radius:30px;overflow:hidden;
  background:linear-gradient(180deg,rgba(167,139,250,.10),rgba(167,139,250,.02) 60%);
  box-shadow:0 60px 160px -50px rgba(167,139,250,.6),0 0 0 1px rgba(167,139,250,.12) inset}}
.tile-media{{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;background:#0b0d10}}
.tile-media img{{width:100%;height:100%;object-fit:cover;display:block}}
.tile-media::after{{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 55%,rgba(7,7,9,.55))}}
.tile-body{{padding:44px 48px 48px}}
.tile-meta{{display:flex;align-items:center;gap:16px;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;letter-spacing:.16em;text-transform:uppercase;color:#9AA39C;font-weight:500}}
.tile-meta .no{{color:#C4B5FD;font-weight:700;text-shadow:0 0 20px rgba(167,139,250,.5)}}
.tile h2{{font-family:'Fraunces';font-weight:500;font-size:64px;line-height:1.09;letter-spacing:-.016em;color:#fff;margin:22px 0 20px}}
.tile .dek{{font-size:29px;line-height:1.5;color:#C2C9C3;font-weight:400}}
.cta{{margin-top:auto;text-align:center}}
.cta .go{{display:inline-flex;align-items:center;justify-content:flex-end;gap:22px;width:460px;height:104px;padding:0 56px 0 0;border-radius:999px;
  background:rgba(167,139,250,.14);border:1.5px solid rgba(167,139,250,.55);
  box-shadow:0 0 50px -8px rgba(167,139,250,.5)}}
.cta .go .arr{{font-family:'JetBrains Mono';font-size:40px;color:#DCD2FF;font-weight:700;text-shadow:0 0 20px rgba(167,139,250,.5)}}
.cta .url{{margin-top:38px;font-family:'Fraunces';font-style:italic;font-weight:300;font-size:38px;letter-spacing:.005em;color:#ECEAE5}}
.cta .url b{{color:#C4B5FD;font-weight:400;font-style:italic}}
</style></head>
<body>
<div class="bg"></div><div class="noise"></div>
<div class="wrap">
  <div class="wordmark"><img src="{WORDMARK}" alt="Markets of Tomorrow"></div>
  <div class="backend">The Weekly:Backend</div>
  <div class="eyebrow">New Edition</div>
  <div class="hl">The build log.</div>

  <div class="tile">
    <div class="tile-media"><img src="/releases/img/{e(ed["cover"])}" alt=""></div>
    <div class="tile-body">
      <div class="tile-meta"><span class="no">No. {ed["num"]:02d}</span><span>&middot;</span><span>{e(ed["date_label"])}</span></div>
      <h2>{e(ed["title"])}</h2>
      <div class="dek">{e(ed["dek"])}</div>
    </div>
  </div>

  <div class="cta">
    <span class="go"><span class="arr">&rarr;</span></span>
    <div class="url">www.oftmw.com/<b>releases</b></div>
  </div>
</div>
</body></html>"""
    os.makedirs(f"{OUT_DIR}/{ed['slug']}/story", exist_ok=True)
    with open(f"{OUT_DIR}/{ed['slug']}/story/index.html", "w", encoding="utf-8") as f:
        f.write(h)

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for ed in EDITIONS:
        build_reader(ed)
        build_story(ed)
    build_index()
    print(f"Wrote /releases index + {len(EDITIONS)} editions: " + ", ".join(x['slug'] for x in EDITIONS))
