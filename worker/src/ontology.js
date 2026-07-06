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

export const ONTOLOGY_VERSION = '2026-07-05.2';

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
      'Article categories use the exact curated forms ("X of Tomorrow", "All Food & Drinks", city names like "New York City") — near-misses are dropped, not fuzzy-matched.',
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
    ],
  },

  // ── Write routing (which tool writes where) ───────────────────────────────
  writes: {
    rules: [
      'update_project_status → LIVE map writes: dates and spec fields (units/floors/keys/gfa_sqft) always auto-apply; status changes apply directly (mode "apply") or queue for one-tap review (mode "propose") for ambiguous/thin/multi-step cases.',
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
  if (want('writes')) { out.push('\n## Write routing'); o.writes.rules.forEach((r) => out.push('- ' + r)); }
  if (want('articles')) { out.push('\n## Articles & the AI pipeline'); o.articles.rules.forEach((r) => out.push('- ' + r)); }
  return out.join('\n');
}
