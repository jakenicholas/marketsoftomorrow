// ─────────────────────────────────────────────────────────────────────────────
// THE TMW ONTOLOGY — the single source of truth for the structural rules of
// Markets of Tomorrow's world. The brand BRAIN (assembleBrain/brainWrite)
// holds learned editorial taste; THIS file holds the rules that are true about
// the data regardless of voice: the project lifecycle, hierarchy, metric
// semantics, category law, place logic, and write routing.
//
// Everything should INHERIT from here rather than restate:
//   · worker code imports the constants (STATUS_ORDER etc.) for enforcement
//   · mcp.js renders tool descriptions from it (a hand-written description
//     once listed the lifecycle in the wrong order while the code enforced
//     the right one — that class of drift is what this file kills)
//   · GET /ontology serves it (JSON or ?format=text) to the Claude routines,
//     admin pages, and any future agent surface
//   · brain.html renders it read-only in the brand-brain hub
//
// Bump ONTOLOGY_VERSION on any rule change so consumers can detect drift.
// ─────────────────────────────────────────────────────────────────────────────

export const ONTOLOGY_VERSION = '2026-07-29.2';

export const ONTOLOGY = {
  version: ONTOLOGY_VERSION,

  // ── Project lifecycle ──────────────────────────────────────────────────────
  statuses: {
    // Canonical slugs, in lifecycle order. Status only ever advances along
    // this path (the one exception is documented in rules below).
    order: ['announced', 'breaking-ground', 'construction', 'coming-soon', 'open'],
    // Slug → the display value stored in the project's Delivery field / shown
    // as the status badge across every surface.
    display: {
      'announced':       'Announced',
      'breaking-ground': 'Breaking Ground',
      'construction':    'Under Construction',
      'coming-soon':     'Opening Soon',
      'open':            'Now Open',
    },
    rules: [
      'Status only moves FORWARD along the order. The ONE exception is correction:true on update_project_status, which walks an over-stated status back when credible current sources show the recorded phase is wrong.',
      '"coming-soon" means UNDER CONSTRUCTION and opening within ~6-7 months (TMW\'s definition of "soon") — it is NOT a pre-construction sales/marketing phase and sits between construction and open.',
      'A daily cron auto-promotes past-due projects: Opening Soon flips to Now Open once the stated opening date has passed.',
      'Editorial display priority (how result sets are ranked for readers) is a DIFFERENT axis from lifecycle order: Featured (our pick) → Coming Soon → Recently Opened (last ~6 months) → Under Construction → Breaking Ground → Announced. A far-off announcement is the weakest lead, never the headline.',
      'STATUS HONESTY in prose: announced/proposed/future-dated projects are "planned"/"proposed", never present-tense "is remaking/building/opening". Active language is reserved for under-construction or open projects.',
      'DEMOTION DIRECTION: a project wrongly marked construction with no real construction evidence (no groundbreaking, a future start date, sales/marketing language only) demotes BACKWARD to announced — or breaking-ground if ground actually broke — NEVER to coming-soon, which would falsely claim it is about to open. Set coming-soon ONLY when construction is complete/topping-out done and an opening is imminent. Backward fixes use correction:true; at low confidence route to a human instead of writing.',
      '"announced" is the ORIGINAL reveal, never "now": a backward correction records when the fix happened, not when the project was announced (usually long before). Never leave a timeline where announced post-dates a later milestone — anchor announced to the earliest sourced coverage, or leave it dateless and let the dossier anchor it.',
    ],
    gotchas: [
      'MILESTONE-REVERT: a same-project milestone call can revert a status advance applied moments earlier. When advancing status AND logging milestones across separate calls, set (or re-assert) the status LAST.',
      'KEYS-WRITE: the keys (hotel rooms) field sometimes returns "no-change" on projects where it is blank. Do not retry in a loop — route hotel key counts to manual entry.',
    ],
  },

  // ── Dossier milestones (finer than lifecycle) ─────────────────────────────
  milestones: {
    phases: ['financing', 'going-vertical', 'halfway', 'topping-out', 'tenant', 'tco', 'move-in', 'bookings'],
    rules: [
      'Milestones log dated, sourced events to the dossier timeline WITHOUT changing the coarse lifecycle status. The coarse transitions (announced, broke ground, grand opening) go via new_status, never as milestones.',
      '"bookings" is the reservations/sales-launch slot: the dossier auto-labels it "Bookings open" for hotels and "Sales launched" for residential, by building type. Pick it by what happened, not by the label.',
      'Always pass effective_date (when the event actually happened, not when we discovered it) plus source_url.',
      'Date milestones by the EVENT, never the publication: match the date grain to the source (a precise day only when the source states one, else YYYY-MM or YYYY) and never date a milestone AFTER the article that reports it.',
      'Re-logging a phase with a better date/source is the correction mechanism — the dossier renders the most-recently-recorded entry per phase, so a fresh log supersedes the old automatically. Never re-log identical data.',
      'PHASED DISTRICTS put their phases IN the story (2026-07-27, The Waterfront Daniel Island pattern): log each completed phase as a move-in milestone whose note reads "Phase N complete: <what it delivered>", and each phase groundbreaking as a backfilled construction entry noting the phase name and expected completion. The dossier timeline then itemizes the build-out phase by phase instead of leaving one delivery date to misrepresent the whole community — the district\'s single delivery date is only the ACTIVE phase\'s.',
    ],
  },

  // ── Hierarchy ─────────────────────────────────────────────────────────────
  hierarchy: {
    rules: [
      'Projects link multi-level via ParentSlug: district → tower → leaf (e.g. The Nora District → The Nora Hotel). A child\'s ParentSlug names its parent\'s Slug.',
      'A project with district:true is a multi-component master plan delivering in PHASES over years. Never treat a district\'s single delivery date as the whole development finishing then — describe it as phased/built out over time, or cite the specific component opening.',
      'A perfect project-name match suppresses unrelated grids; only formal parent/child/sibling relations (via ParentSlug) ride along.',
    ],
  },

  // ── Metric semantics ──────────────────────────────────────────────────────
  metrics: {
    definitions: {
      gfa_sqft: 'GROSS FLOOR AREA — total built square feet. THE "how big" number.',
      floors:   'Stories. THE "how tall" number.',
      units:    'Residential unit count.',
      keys:     'Hotel room count.',
    },
    rules: [
      '"biggest" ranks by gfa_sqft (built square feet), NEVER by units.',
      '"tallest" ranks by floors.',
      'Hard figures (floors, units, keys, dates, dollars) are verified facts — never invented, never attributed to a project whose record does not carry them.',
    ],
  },

  // ── Category law ──────────────────────────────────────────────────────────
  categories: {
    rules: [
      'NO tool or automation may mint a new category — every post write path passes through knownCategoryOrBlank (unknown label → saved uncategorized). Categories are created deliberately, only in the Studio Categories tab.',
      'Article categories use the exact curated forms ("X of Tomorrow", city names like "New York City") — near-misses are dropped, not fuzzy-matched.',
      'Type tags are FLAT, one per vertical: "Food & Drinks", "Hotels", "Golf", "Wellness", "Clubs", "Travel", "Residential". Never compound region-type tags ("Florida Food & Drinks" is retired, 2026-07-21) — a story\'s geography comes from its market/city categories and combines with the flat type by logic.',
      'main_category is the editor\'s PRIMARY placement and the authoritative GEOGRAPHY for an article — an article tagged both "London" and "New York City" belongs where main_category says.',
    ],
  },

  // ── Place logic ───────────────────────────────────────────────────────────
  places: {
    nyc_family: ['new york city', 'new york', 'nyc', 'manhattan', 'brooklyn', 'queens', 'the bronx', 'bronx', 'staten island'],
    rules: [
      'Same-family place names are NOT different places for exclusion purposes: containment either way (with a plural strip) marks the family — "Palm Beach" / "The Palm Beaches" / "West Palm Beach" never exclude each other; the NYC family is one place.',
      'A bare neighborhood ("brickell", "wynwood") resolves to its parent city\'s pipeline.',
      'Geography beats words: an article\'s linked project city or main_category outranks a place name appearing in its title/excerpt (origin-qualifier mentions like "London\'s Gymkhana debuts NYC concept" belong to the destination).',
      'A place query\'s project set is AUTHORITATIVE scope — never compare its size against loose keyword matches.',
      'Every project carries a STRUCTURED ADDRESS: street (street line), city, postal_code (zip), country (spelled-out nation), plus US state (auto-derived from lat/lng). US rows get country="United States" automatically; international rows are backfilled by the construction sweep. Answer "what is the address of X" from these fields, and country resolves country-level searches.',
      'GEOGRAPHY IS A TREE (2026-07-21): a post is tagged with its most specific place; ancestors are implied by geo_parents below and auto-applied by tooling (the editor auto-adds them; filters may expand them). "United States" is always implied for US content and never needs tagging.',
    ],

    // Category geography: child → immediate parent, walked transitively.
    // Keys/values are canonical category names as they exist in the corpus.
    // Parents that are not (yet) real categories (e.g. "Europe") stay listed —
    // consumers only auto-apply a parent that exists in the category master.
    geo_parents: {
      // Florida
      'Miami': 'Florida of Tomorrow', 'The Palm Beaches': 'Florida of Tomorrow', 'Broward': 'Florida of Tomorrow',
      'Tampa Bay': 'Florida of Tomorrow', 'Orlando': 'Florida of Tomorrow', 'Jacksonville': 'Florida of Tomorrow',
      'Naples': 'Florida of Tomorrow', 'Sarasota': 'Florida of Tomorrow', 'The Florida Keys': 'Florida of Tomorrow',
      'Treasure Coast': 'Florida of Tomorrow', 'Space Coast': 'Florida of Tomorrow', 'Daytona Beach': 'Florida of Tomorrow',
      'Florida Panhandle': 'Florida of Tomorrow', 'Florida': 'Florida of Tomorrow', 'Marina Pointe': 'Tampa Bay',
      // Tennessee
      'Nashville': 'Tennessee of Tomorrow', 'Memphis': 'Tennessee of Tomorrow', 'Knoxville': 'Tennessee of Tomorrow',
      'East Tennessee': 'Tennessee of Tomorrow', 'West Tennessee': 'Tennessee of Tomorrow', 'Bowling Green': 'Tennessee of Tomorrow',
      // New York
      'Brooklyn': 'New York City', 'Greenwich Village': 'New York City', 'New York City': 'New York of Tomorrow',
      'The Hamptons': 'New York of Tomorrow', 'New Jersey': 'New York of Tomorrow',
      // Rockies
      'Aspen': 'Colorado', 'Denver': 'Colorado', 'Park City': 'Utah', 'Moab': 'Utah', 'Jackson Hole': 'Wyoming',
      'Colorado': 'Rockies of Tomorrow', 'Utah': 'Rockies of Tomorrow', 'Wyoming': 'Rockies of Tomorrow',
      'Montana': 'Rockies of Tomorrow', 'Idaho': 'Rockies of Tomorrow', 'Rockies': 'Rockies of Tomorrow',
      // Caribbean
      'The Abacos': 'The Bahamas', 'The Bahamas': 'Caribbean of Tomorrow', 'Aruba': 'Caribbean of Tomorrow',
      'British Virgin Islands': 'Caribbean of Tomorrow', 'Cayman Islands': 'Caribbean of Tomorrow',
      'Dominican Republic': 'Caribbean of Tomorrow', 'Puerto Rico': 'Caribbean of Tomorrow',
      'Sint Maarten': 'Caribbean of Tomorrow', 'St. Maarten': 'Caribbean of Tomorrow', 'Turks and Caicos': 'Caribbean of Tomorrow',
      // Mexico + Latin America
      'Cancún': 'Mexico', 'Costa Mujeres': 'Mexico', 'Cabo San Lucas': 'Los Cabos', 'Los Cabos': 'Baja California',
      'Baja California': 'Mexico',
      // US at large (country level stays implied — no parent for these)
      'Austin': 'Texas', 'Dallas': 'Texas', 'Seattle': 'Washington', 'Charleston': 'Carolinas',
      'Las Vegas': 'Nevada', 'Boston': 'Massachusetts', 'Sierra Nevada': 'California',
      // Europe (parent "Europe" applies once that category exists)
      'Florence': 'Italy', 'Nice': 'France', 'French Riviera': 'France', 'Ibiza': 'Spain', 'Andalusia': 'Spain',
      'Mykonos': 'Greece', 'Paros': 'Greece', 'Copenhagen': 'Denmark', 'Stockholm': 'Sweden',
      'Italy': 'Europe', 'France': 'Europe', 'Spain': 'Europe', 'Greece': 'Europe', 'Portugal': 'Europe',
      'Germany': 'Europe', 'Denmark': 'Europe', 'Sweden': 'Europe', 'Norway': 'Europe', 'Hungary': 'Europe',
      'Croatia': 'Europe', 'London': 'Europe',
      // Asia + Indian Ocean
      'Tokyo': 'Japan', 'Ella': 'Sri Lanka', 'Japan': 'Asia', 'China': 'Asia', 'Singapore': 'Asia',
      'Malaysia': 'Asia', 'Indonesia': 'Asia', 'Thailand': 'Asia', 'Sri Lanka': 'Asia', 'Maldives': 'Asia',
      // Middle East + Africa + Canada
      'Dubai': 'United Arab Emirates', 'Kenya': 'Africa', 'Morocco': 'Africa', 'Toronto': 'Canada',
    },
  },

  // ── Filter state (the contract shared by /map/ and /atlas/) ───────────────
  // Map and Atlas render the SAME projects two ways. Before this existed they
  // filtered on the same three axes with different controls and different URL
  // params, so a filter never survived a surface change and every cross-link
  // dumped the reader back to an unfiltered view. These five params are the
  // canonical query string BOTH surfaces read on load and write on change, so
  // the Journal|Map|Atlas toggle is a view switch, not a reset.
  //
  // /_shared/tmw-filters.js is the client-side implementation. It carries a
  // copy of this vocabulary (a browser cannot import worker source) stamped
  // with the ontology version it was written against — if these drift, that
  // stamp is how you find out.
  filters: {
    params: ['city', 'state', 'type', 'status', 'year'],

    // Project type. A project matches a type if ANY of its types match:
    // `ProjectType` is a comma-separated LIST ("Residences, Hotel, Mixed-Use")
    // and `PreferredType` is only the primary — the two disagree on 151 of 911
    // live rows, so filtering on PreferredType hides real matches. These slugs
    // are the URL form.
    types: {
      order: ['residences', 'mixed-use', 'hotel', 'golf', 'museum', 'office', 'entertainment',
              'stadium', 'travel', 'cultural', 'park', 'retail', 'education', 'marina', 'healthcare'],
      display: {
        'residences': 'Residences', 'mixed-use': 'Mixed-Use', 'hotel': 'Hotel', 'golf': 'Golf',
        'museum': 'Museum', 'office': 'Office', 'entertainment': 'Entertainment', 'stadium': 'Stadium',
        'travel': 'Travel', 'cultural': 'Cultural', 'park': 'Park', 'retail': 'Retail',
        'education': 'Education', 'marina': 'Marina', 'healthcare': 'Healthcare',
      },
      // Long-tail PreferredType values that are really one of the above.
      // These are NOT cleanup candidates — DO NOT normalise the rows. A project
      // may carry a preferred custom type name as its DISPLAY label ("Members
      // Club & Boutique Hotel" is editorially truer than "Hotel"), and these
      // aliases exist so filtering still finds it. Label and filter vocabulary
      // are deliberately separate: the alias is how a custom name stays visible
      // without falling out of a Hotel filter.
      aliases: {
        'hospital': 'healthcare',
        'country-club': 'golf',
        'members-club-and-boutique-hotel': 'hotel',   // slug() turns '&' into ' and '
      },
    },

    // Delivery values seen in the data that are NOT in statuses.display.
    // 'Complete'/'Completed' predate the canonical list; they mean open.
    status_aliases: { 'complete': 'open', 'completed': 'open' },

    rules: [
      'CANONICAL FORM IS THE SLUG: city=west-palm-beach, state=FL, type=mixed-use, status=construction, year=2027. Consumers must ALSO accept the legacy display form (city=West%20Palm%20Beach) because live links, embeds and the sitemap still carry it — normalise on read, always write the slug.',
      'PLACE IS TWO PARAMS, NOT ONE: `state` (2-letter US code, uppercase) and `city` (slug). Atlas already owned ?state= and the map already owned ?city=, and they do not collide, so the shared contract extends what shipped rather than inventing a third scheme. A city implies its state; setting a city does not require setting the state.',
      'CUSTOM TYPE NAMES ARE A DISPLAY CONCERN, NOT A DATA ONE: a project may keep a preferred, more specific PreferredType as its visible label (e.g. "Members Club & Boutique Hotel", "Country Club"). Never rewrite those rows to a canonical type to "clean up" the data — that destroys editorial specificity. Add an entry to types.aliases instead so the row still answers the canonical filter.',
      'TYPE MATCHES ANY, NOT THE PRIMARY: filter on the full ProjectType list, never PreferredType and never just the first entry. A mixed-use tower typed "Residences, Hotel, Mixed-Use" is a legitimate hit for all three. Surfaces additionally SUPPRESS a district when one of its own children covers the same type, so filtering Hotel returns The Nora Hotel and not The Nora District — that rule needs the parent/child index and stays surface-side.',
      'YEAR IS CUMULATIVE: year=2027 means "delivering BY the end of 2027", not "delivering in 2027". This is the meaning Atlas already shipped and the more useful pipeline filter; both surfaces must apply it the same way.',
      'STATUS USES THE LIFECYCLE SLUGS from statuses.order — never the display strings. Read through status_aliases so legacy Delivery values still resolve.',
      'An ABSENT param means "no filter on that axis", never "all" as an explicit value. Empty params are stripped from the URL so a clean state is a clean link.',
      'Surfaces own their own view params (map: project/embed/fullscreen/ui; atlas: aview) and must preserve any param they do not recognise when they rewrite the query string — the filter module only ever touches the five it owns.',
      'Filter changes use history.replaceState, not pushState: filtering is not navigation, and a filter-per-back-button makes the back button useless.',
    ],
  },

  // ── Write routing (which tool writes where) ───────────────────────────────
  writes: {
    // Editorially BANNED source domains — never citable in the dossier or any
    // milestone/status write. Enforced deterministically on the write path
    // (update_project_status rejects them) AND the page generator strips them
    // from existing entries so they can never render as a citation.
    banned_source_domains: ['palmbeachnow.com'],
    rules: [
      'BANNED cited sources: palmbeachnow.com is not an approved source — never cite it in a milestone, status change, or article; find a different credible source or skip the update.',
      'update_project_status → LIVE map writes: dates and spec fields (units/floors/keys/gfa_sqft, neighborhood, and the address fields street/postal_code/country) always auto-apply; status changes apply directly (mode "apply") or queue for one-tap review (mode "propose") for ambiguous/thin/multi-step cases.',
      'propose_project_edit → REVIEW QUEUE, never live (param target_slug). match_project resolves by name first.',
      'The construction sweep must NOT overwrite a specific curated neighborhood tag with a vaguer one — fill blanks or refine to MORE specific only.',
      'Map drafts (create_map_draft) land in the Studio map admin Drafts tab for human promotion; nothing publishes to the live map, journal, or socials without a human.',
    ],
  },

  // ── Articles & the AI pipeline ────────────────────────────────────────────
  articles: {
    rules: [
      'posts.source: "ai" = written by the AI routine (Studio AI tab); null/anything-else = human (Drafts tab). Both tabs are status=draft split by source.',
      'Saving a draft of an AI article in the editor hands it to the Drafts tab (source cleared) — a human has taken it over.',
      'The learning loop is a PUBLISH-TIME cumulative diff: posts.ai_original_html freezes the AI\'s original body; at publish the worker diffs it against the final, proposes review-gated lessons to the shared brain, then advances the baseline. It keys on the snapshot, NOT the source tag — tab moves and intermediate edits never break it.',
      'Deleting a draft is an editorial REJECTION: the topic is suppressed from re-drafting for ~120 days (draft_rejected event).',
    ],
  },
};

// Render the ontology as plain text (markdown-ish) for prompts, routines, and
// the admin hub. Pass section keys to slice; omit for the whole thing.
export function ontologyText(sections) {
  const o = ONTOLOGY;
  const want = (k) => !sections || !sections.length || sections.includes(k);
  const out = [`TMW ONTOLOGY v${o.version} — the structural rules of Markets of Tomorrow's world.`];
  if (want('statuses')) {
    out.push('\n## Project lifecycle');
    out.push('Order (slugs): ' + o.statuses.order.join(' → '));
    out.push('Display: ' + o.statuses.order.map((s) => `${s} = "${o.statuses.display[s]}"`).join(' · '));
    o.statuses.rules.forEach((r) => out.push('- ' + r));
    o.statuses.gotchas.forEach((r) => out.push('- GOTCHA: ' + r));
  }
  if (want('milestones')) {
    out.push('\n## Dossier milestones');
    out.push('Phases: ' + o.milestones.phases.join(', '));
    o.milestones.rules.forEach((r) => out.push('- ' + r));
  }
  if (want('hierarchy')) { out.push('\n## Hierarchy'); o.hierarchy.rules.forEach((r) => out.push('- ' + r)); }
  if (want('metrics')) {
    out.push('\n## Metric semantics');
    Object.entries(o.metrics.definitions).forEach(([k, v]) => out.push(`- ${k}: ${v}`));
    o.metrics.rules.forEach((r) => out.push('- ' + r));
  }
  if (want('categories')) { out.push('\n## Category law'); o.categories.rules.forEach((r) => out.push('- ' + r)); }
  if (want('places')) {
    out.push('\n## Place logic');
    out.push('NYC family: ' + o.places.nyc_family.join(', '));
    o.places.rules.forEach((r) => out.push('- ' + r));
  }
  if (want('filters')) {
    out.push('\n## Filter state (shared by /map/ and /atlas/)');
    out.push('Params: ' + o.filters.params.join(', '));
    out.push('Types: ' + o.filters.types.order.join(', '));
    o.filters.rules.forEach((r) => out.push('- ' + r));
  }
  if (want('writes')) { out.push('\n## Write routing'); o.writes.rules.forEach((r) => out.push('- ' + r)); }
  if (want('articles')) { out.push('\n## Articles & the AI pipeline'); o.articles.rules.forEach((r) => out.push('- ' + r)); }
  return out.join('\n');
}
