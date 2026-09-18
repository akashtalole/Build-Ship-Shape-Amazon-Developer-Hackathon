# Friction Log — StudyLoop

Notes captured while building the Bee StudyLoop submission, for the hackathon's optional friction-log bonus.

## What worked well

- Isolating transcript normalization into one function (`normalizeTranscript`) made the "Bee isn't attached"
  constraint disappear as a design problem: the array-of-segments branch is *already* the real integration shape
  (it matches what an MCP transcript tool would return), so there's no speculative interface to later discover is
  wrong — only the string-splitting convenience branch is throwaway.
- Writing `scheduler.ts` as pure functions (`initialSchedulerState`, `scheduleReview`, `isDue`) that take `now` as
  an explicit parameter rather than reading `Date.now()` internally made the interval-growth and ease-factor math
  trivial to reason about and test directly, without needing to fake the system clock.
- Designing the smoke test to chain three consecutive reviews on the same card (good, good, again) rather than
  three independent one-off reviews caught the actual requirement precisely: "again" needs to shorten the interval
  relative to where the card *was*, not just be different from the previous card's default state.

## Friction encountered

1. **No real Bee MCP server/CLI or hardware is reachable in this environment.** There is no way to validate the
   exact tool name, arguments, or transcript response shape a real Bee MCP integration would expose (e.g. whether
   segments are already diarized/timestamped, whether summaries are chunked per speaker turn, or how a session
   boundary is defined) — that had to be reasoned about from the hackathon idea doc's description alone. Bee
   publishing its MCP tool schemas (even just tool names + JSON schemas) would let this normalization layer be
   written against the real contract instead of an assumed one.
2. **Heuristic flashcard extraction without an LLM is inherently shallow.** The three-tier heuristic (Q&A pairing,
   "X is Y" definition matching, cloze fallback) works well on tidy, declarative study talk but would visibly
   struggle on messier real speech — filler words, false starts, or a definition phrased as "so basically X is kind
   of like Y" won't match the anchored regex. This is an accepted, documented limitation (hence the LLM-swap seam)
   rather than something worth over-engineering with more regex special cases.
3. **Choosing a grade vocabulary was a real design decision, not just naming.** True SM-2 uses a 0-5 quality score,
   which is precise but meaningless to type by hand while testing or demoing (`3` vs `4` isn't obviously "hard" vs
   "good"). Mapping a friendly four-point scale (`again`/`hard`/`good`/`easy`) onto SM-2's quality score, rather
   than exposing the raw 0-5 scale, cost a small amount of scheduling nuance (`hard` and `good` collapse a wider
   quality range each) in exchange for an API that's actually pleasant to drive from curl or a real UI.

## Feature requests

- A published Bee MCP tool/resource schema (transcript retrieval by session or time range, at minimum) so
  `normalizeTranscript`'s array branch could be validated against the real contract instead of only the shape
  implied by the idea doc.
- Session-boundary detection from Bee itself (i.e., Bee already knowing "this was one continuous study session")
  would remove the one manual input (`title`, and implicitly "where does this session start/end") StudyLoop still
  asks a caller to provide.

## Round 2: advanced features

Notes from the second pass (idempotent ingestion, leech detection, topic search, adaptive ordering, incremental
ingestion, portable export).

### What worked well

- Writing `leech.ts` and `priority.ts` as pure functions with the exact same discipline as `scheduler.ts` (explicit
  `now`/state in, new state out, zero I/O) made both trivially unit-testable and meant `studyService.ts` stayed a
  thin orchestration layer instead of accumulating scattered leech/priority logic inline in `recordReview` and
  `listDueCards`.
- Reusing the existing `FlashcardGenerator.generate()` seam for incremental ingestion — rather than inventing a
  second "generate just the delta" method on the interface — meant `appendSessionSegments` needed zero changes to
  `flashcardGenerator.ts` at all; the dedupe-by-front-text step alone was enough to make full-transcript
  regeneration behave like delta generation from the caller's point of view.

### Friction encountered

1. **The leech "which grades count as a failure" question had no single right answer.** True SM-2 has one
   pass/fail boundary (quality >= 3). The friendly four-point vocabulary (`again`/`hard`/`good`/`easy`) blurs that:
   `hard` is technically a pass in `scheduler.ts`'s quality mapping, but it's clearly not a *confident* recall
   either. The spec only says a "good"/"easy" grade should clear a leech, so I made `hard` a no-op for the leech
   streak (neither advances nor resets it) rather than either treating it as a failure or a full clear — a
   defensible middle ground, but genuinely underspecified, and a different reasonable implementation would treat
   `hard` as clearing the streak too.
2. **Designing a priority-score formula meant picking arbitrary-feeling weights with no usage data to tune
   against.** Why is the leech bonus 10 and not 5 or 20? Why is the ease-factor multiplier 2 and not 1? There's no
   principled answer without real review data to calibrate against — 10 was chosen because it comfortably
   dominates the realistic range of `overdueDays` in a demo/test setting (single-digit days) without being so
   large that overdue-ness stops mattering for leeches entirely. This is called out explicitly in the code comment
   and README rather than dressed up as more rigorous than it is.
3. **Testing the priority ordering over real HTTP turned out to be impractical, not just inconvenient.** Every
   `POST /review/:cardId` call reschedules a card's `dueAt` at least one day into the future (SM-2's minimum
   interval is 1 day, even after a failing grade) — so a card that was just made a leech is immediately *not* due
   any more at the real wall-clock "now" the HTTP route uses, and there's no way to ask the running server "what
   would `/review/due` return three days from now" without either sleeping the test for real days or adding a
   test-only clock-injection endpoint (which would be worse: a code path that exists only for tests). Calling
   `listDueCards(now)` directly — the exact function the route delegates to, with an injected future `now` — was
   the honest way to test the real ordering logic without either compromise.
4. **Incremental ingestion's "don't duplicate already-processed segments" requirement has a real tradeoff, not a
   clean solution.** Regenerating over the *full* transcript on every `PATCH` (then dropping any candidate whose
   front matches an existing card) correctly catches Q&A pairs and definitions that straddle the old/new segment
   boundary, which a "only look at the new segments" approach would miss entirely. The cost: the generator's own
   "no Q&A/definition matches found anywhere -> fall back to cloze deletion" tier only ever fires once per session,
   on whichever ingest/append first produces zero tier-1/2 matches — a later append whose new content is pure
   cloze-fallback material (no question, no "X is Y" statement) won't get a card at all if *any* earlier content
   already tripped tier-1/2, because the generator never sees "zero cards so far" again. Documented rather than
   silently accepted: a production version would need the fallback tier to reason about "new" vs "already covered"
   content explicitly, not just "cards.length === 0 for this call."
5. **Picking a portable export format meant weighing correctness (CSV) against convenience (TSV) for real study
   content.** Flashcard fronts/backs are free text generated from lecture-style sentences, which routinely contain
   commas — a proper CSV export would need quoting/escaping around every field, which is easy to get subtly wrong
   (embedded quotes, embedded newlines). Tab-separated sidesteps that almost entirely since a literal tab is far
   rarer in prose, at the cost of very rare tab characters getting silently stripped instead of escaped — an
   acceptable simplification for a hackathon-scope export, called out in the README rather than hidden.

## Round 3: quiz mode, shared decks, reminders, adaptive generation bias

Notes from the third pass (quiz/practice-test mode, shared study-group decks, due-card reminder digest, adaptive
new-card generation bias).

### What worked well

- Designing shared decks around a completely separate `PersonalReviewState` keyed by `(studentId, cardId)` —
  rather than trying to retrofit multi-student state onto the `Flashcard` record itself — meant every existing
  endpoint, test, and piece of scheduling/leech/priority logic kept working completely unmodified for the
  student-less "default reviewer" path. The new per-student path reuses `scheduleReview`/`updateLeechState`
  verbatim on a differently-shaped state object; nothing in `scheduler.ts` or `leech.ts` needed to change or even
  know multi-student review state exists.
- Quiz sampling and the reminder digest both turned out to be thin composition on top of logic that already
  existed (`isDue`, `priorityScore`/the new shared `sortByPriority` helper, and the per-student due/leech queries
  built for shared decks) rather than new algorithms in their own right — a good sign that the underlying
  abstractions (a pool of due-checkable, priority-scorable cards) were already the right shape, not that these
  features were trivial.

### Friction encountered

1. **"Independent progress on shared content" is a real modeling decision with more than one defensible answer.**
   The chosen design — a card's own embedded state represents the student-less "default reviewer," and every
   named `studentId` (including, in principle, the original ingesting student, if they ever review with their own
   `studentId`) gets an entirely separate, lazily-created `PersonalReviewState` — means there's no built-in notion
   of "the session's owner" gating who else's progress starts from what baseline. A different reasonable design
   would treat the ingesting student as having implicit day-one ownership of the embedded state and make everyone
   else's "independent" state start as a *copy* of it rather than fresh at `interval: 0`. I chose fresh-and-
   independent for every named student uniformly (simpler, more predictable, and matches "no auth, just a
   studentId string" — there's no reliable way to know who the "real" owner even is without auth), but a
   production version with real accounts would probably want the copy-on-join semantics instead.
2. **Quiz grading: exact match vs. fuzzy match is a real tradeoff, not a settled question.** Case-insensitive/
   trimmed exact matching is trivial to implement and impossible to game accidentally with whitespace or
   capitalization, but it's brittle against anything else: a student who answers "it produces ATP through
   respiration" for a card whose back is "The mitochondria produces ATP through respiration" is graded wrong for
   omitting the subject, even though the substance is right. A looser match (word-overlap scoring, a Levenshtein-
   distance threshold, or routing through an LLM-as-judge once the generator is swapped for a real model — see
   "Swapping in a real LLM-backed generator") would mark that correct, at the cost of also creeping in false
   positives on shorter or more generic backs. Exact match was chosen because it's the only grading rule whose
   behavior a student can predict and rely on without a model in the loop, and because it never needs tuning
   thresholds nobody has real usage data to calibrate against (the same "arbitrary weights" problem the round-2
   priority formula ran into) — documented as a known limitation in the README rather than dressed up as smarter
   than it is.
3. **The adaptive generation-bias heuristic's "more cards" choice, and its real limitations.** The spec allows
   "more cards, or simpler cards" as the bias; I chose "more cards" (extra cloze-deletion cards from the newly
   appended segments alone, on top of whatever the normal tiers produced) because it's the more directly
   observable and testable signal — a card count strictly increasing is easy to assert on, where "simpler" has no
   agreed-upon heuristic definition without real reading-difficulty scoring. Real limitations, called out rather
   than hidden: (a) a topic's "weakness" is computed from the *session-level* tags every card in that session
   shares, not a true per-card topic classification, so a multi-topic session can flag a topic weak based on a
   different card entirely (documented directly in `computeWeakTopics`'s doc comment); (b) it's cold-start blind —
   a student's very first exposure to a topic can never be "weak" yet, since weakness requires at least one prior
   review, so the very session that introduces a hard topic gets no extra help, only the next one that touches it
   again; (c) the ease/leech threshold (`2.0`, chosen as "meaningfully below the 2.5 baseline") and the extra-card
   cap (3) are picked the same way round 2's priority-formula weights were — reasoned about, not tuned against
   real review data, because none exists in a hackathon-scope build.
4. **Testing the bias heuristic required picking transcript sentences with real care around the definition-tier
   regex's backtracking.** An early version of the "new segments" test transcript used a sentence with a
   standalone " is " buried in the middle ("...when oxygen is limited"), which the definition-pattern regex's lazy
   term-group quantifier happily backtracked into, matching an unintended (and slightly absurd) definition card
   from it — silently making the "the control should generate zero new cards" assumption false. The fix was
   picking sentences with no bare "is"/"are"/"means"/"refers to" token anywhere in them, not just at the start,
   which is an easy trap to fall into when hand-writing test fixtures for a regex-driven, non-LLM generator: the
   pattern's reach is the whole sentence, not just its beginning.

## Round 4: streaks & gamification, session planner, import round-trip, regenerate-a-card

Notes from the fourth pass (study streaks/badges, the global daily review session planner, TSV import round-trip,
regenerate-a-card).

### What worked well

- Streak bookkeeping turned out to want its own tiny state machine (`streak.ts`) rather than living inline in
  `studyService.ts` — exactly the same shape as `scheduler.ts`/`leech.ts`: a pure `(state, event) -> state`
  function, unit-testable with no HTTP or storage involved, called from one place (`recordReviewForStudent`). That
  consistency made the design decision easy: "what's a streak day, when does it reset" is a self-contained question
  with the same answer regardless of which endpoint eventually triggers it.
- The session planner (Feature 12) needed zero new ranking logic — `buildReviewSession` is a three-line function
  that calls the existing `listDueCardsForStudent` and slices the result. That it came out this thin is a good sign
  the underlying "pool of priority-scorable, student-scoped due cards" abstraction from round 3 was already the
  right shape; a "bounded session" and an "unbounded due-list" are the same data at two different cutoffs, not two
  different features.
- The regenerate endpoint's requirement to "reuse the existing FlashcardGenerator, don't duplicate its logic" led
  to a genuinely pleasant discovery: because `TemplateFlashcardGenerator` already runs three independent
  pattern-matching tiers over whatever segments it's given, re-running it over just a card's two source segments
  frequently surfaces a *second* tier's candidate for the same material for free (a Q&A pair's answer sentence
  often also matches the definition pattern) — a real "alternative phrasing," not a synthetic one, with no
  cloze-fallback needed in the common case. See the smoke test's mitochondria example.

### Friction encountered

1. **"Which segments did this card come from?" has no stored answer — it has to be reverse-engineered.** Nothing in
   the `Flashcard` record links back to the specific transcript segment(s) that produced it (only `sessionId`, the
   whole session). Regeneration therefore leans on `findUnderlyingSegments`, a heuristic that exploits each
   generator tier's own text-construction rules in reverse (Q&A cards carry verbatim segment text; cloze cards can
   have their blank filled back in; definition cards can only be traced to "the segment that mentions the term").
   This works well for the `TemplateFlashcardGenerator`'s own output, but it is coupled to that generator's exact
   conventions — swapping in a real LLM-backed generator (see "Swapping in a real LLM-backed generator") would
   break the exact-match and reconstruction heuristics entirely, since an LLM's phrasing wouldn't carry verbatim
   segment text or a literal "____" placeholder. The honest fix, out of scope for a hackathon-scope build, is
   storing a `sourceSegmentIndices: number[]` on `Flashcard` at generation time so regeneration (and, likely, a
   future "explain this card" feature) never has to guess. Falling back to the whole session's transcript when
   nothing more specific is found keeps regeneration from ever hard-failing in the meantime.
2. **Badges-as-permanent-achievements vs. badges-as-live-status is a real modeling choice, not an obvious one.** I
   chose to base badges on `longestStreak` (once earned, never revoked) rather than `currentStreak` (which would
   make a badge disappear the moment a streak resets). The permanent-achievement model is how most habit-tracking
   apps actually behave and avoids the discouraging feel of "losing" a badge you already earned, but it does mean
   `GET /students/:studentId/streak`'s `badges` array can't be used, by itself, to answer "is this student
   currently on at least a 3-day streak" — a caller wanting that has to compare `currentStreak` against
   `STREAK_MILESTONES` directly. Documented in `streak.ts`'s doc comment rather than left implicit.
3. **Import's dedup key (front-text only) inherits the same limitation `appendSessionSegments`'s dedup already
   has, and for the same reason.** Two cards with identical fronts but different backs (a hand-edited TSV row, or a
   card whose answer was corrected after export) collide under `fromPortableTsv`'s dedup and the second is silently
   dropped rather than merged or flagged as a conflict. This mirrors the existing incremental-ingestion tradeoff
   (documented in round 2's friction log) of "simple and predictable" over "correct in every edge case," and was
   deliberately kept consistent with it rather than inventing a different, one-off conflict-resolution rule just
   for import.
4. **The exact TSV row count from `GET /export` isn't a safe test fixture for import once earlier test sections
   have already run.** An early version of the import test computed its expected imported-card count from the
   *global* `/export`, which by that point in the smoke test's own run had accumulated many earlier sessions —
   several of which legitimately share front-text (e.g. more than one "What is meiosis?"-style card minted across
   different fixture transcripts in earlier feature sections). That's exactly the documented within-batch dedup
   behavior working correctly, not a bug — but it made the test's "one card per exported row" assumption false and
   the assertion failed. The fix was giving the import test its own dedicated, freshly-ingested session with known
   content and exporting *that* (`GET /sessions/:id/export`) rather than the ever-growing global export, plus a
   second, explicitly-crafted small TSV with a deliberate duplicate row to test the within-batch dedup behavior
   directly instead of hoping the accumulated global state would happen to exercise it.

## Round 5: concept graph, Feynman mode, study-guide synthesis, exam readiness

The brief for this pass was explicit and different from the previous four: stop hardening infrastructure and add
features a judge would say "I haven't seen that idea before" — real functionality, not stubs. Notes from building
the concept graph, the Feynman/peer-teaching explanation mode, cross-session study-guide synthesis, and the exam
readiness score.

### What worked well

- Every one of these four features turned out to be a genuine *composition* of round 1-4 primitives rather than a
  parallel system: the concept graph reuses nothing external but is itself immediately reusable (the study guide's
  `concepts` union is just `extractConceptsFromCard` called across more cards); the Feynman mode reuses
  `recordReview`/`recordReviewForStudent` verbatim rather than inventing a second scheduling path, so an
  explanation-graded card and a normally-graded card are indistinguishable to every other endpoint (leech
  detection, adaptive ordering, streaks all "just work" on it for free); the readiness score reuses `isDue`'s own
  timestamp comparison, each card's own `lastGrade`, and `streak.ts`'s existing `currentStreak` rather than
  tracking anything new. Four "novel" features added zero new persisted state to `store.ts` — everything is derived
  on read from data the store already had.
- Writing `conceptGraph.ts`'s three extraction tiers cheapest-first (definition-style front, then cloze, then
  generic word-overlap) and having each tier `return` immediately on a match — the same short-circuit shape
  `flashcardGenerator.ts`'s own three tiers already use — meant no card ever needed more than one tier evaluated to
  get a real answer, and made the module trivially unit-testable tier-by-tier in isolation.
- Deciding to make `POST /review/:cardId/explain` work on *any* card rather than gating it to leeches only (the
  spec's framing, "for a card a student has struggled with," described the *use case*, not a hard precondition) was
  the right call once actually building it: enforcing a leech-only precondition would have meant either an awkward
  412-style error for a perfectly reasonable "let me explain this one just to check my understanding" request, or a
  second code path for "explain a non-leech" vs. "explain a leech" that didn't need to exist — the grading logic
  doesn't care why the student is explaining.

### Friction encountered

1. **Concept extraction's generic (non-"what is") tier is the same word-frequency heuristic as `topics.ts`, scoped
   down from a whole transcript to two short fields — and at that scale, ties are common and the tie-break
   (alphabetical) can pick a less-meaningful word over a more-meaningful one that just happens to sort later.** An
   early test fixture ("What does the mitochondrion do?" / "It converts nutrients into usable energy.") produced
   `["converts", "energy"]` instead of anything mentioning "mitochondrion" at all, because every content word in
   that pair appeared exactly once with no capitalization bonus, and alphabetical tie-break has no way to know
   "mitochondrion" is the actual subject. The fix was accepting this as a real, documented limitation of a
   frequency-only heuristic at small scale (the same honest tradeoff `topics.ts` already made for whole
   transcripts) and writing test fixtures where the shared term is either capitalized in the source text (the
   existing capitalization-bonus signal) or repeated, rather than trying to patch the heuristic with more special
   cases for a hackathon-scope build. A production version would want real named-entity recognition here, not a
   frequency count.
2. **The Feynman-mode rubric's key-term extraction has no way to distinguish "this word matters" from "this word
   is merely long."** `keyTerms()` treats any non-stopword >= 4 characters in the answer as something the
   explanation must mention, which means a grammatically necessary but substantively unimportant word (e.g.
   "process," "through") counts exactly as much as the actual concept term. This is deliberately not "fixed" with a
   second, more selective word list — there's no principled, tunable-without-real-data line between "important key
   term" and "just a long word," the same honest admission round 2's friction log already made about the priority
   formula's weights — but it does mean a technically-passing explanation can occasionally miss the word that
   actually mattered ("mitochondria") while still crediting a structural word ("respiration" vs. "through") equally.
   Documented in `explainGrader.ts`'s doc comment as a known LLM-free tradeoff rather than smoothed over.
3. **Deciding what counts as a "duplicate sentence" for study-guide merging required picking a normalization that's
   forgiving of punctuation/case but not of real paraphrasing — and there's no way to do better without an LLM.**
   `normalizeSentenceKey` strips punctuation and lowercases before deduping, which correctly collapses two sessions
   both stating "Mitochondria is the powerhouse of the cell." verbatim, but does nothing for two sessions that say
   the same thing in different words ("Mitochondria produce the cell's energy" vs. "Mitochondria is the powerhouse
   of the cell") — those appear in the merged guide as two separate, seemingly-redundant sentences. A real
   semantic-similarity dedup (embeddings, or an LLM pass) would catch that; exact-after-normalization was the
   honest LLM-free ceiling, called out here rather than oversold as smarter deduplication than it is.
4. **The exam-readiness score's three weights (50/35/15) and the streak cap (7 days) and recency half-life
   (14 days) are, once again, reasoned-about rather than tuned against real usage data** — the exact same
   "arbitrary weights, no data to calibrate against" position round 2's priority formula and round 3's weak-topic
   threshold were already honest about. The recency half-life in particular is doing a lot of implicit work (it's
   what makes "recent" grade history mean something different from "any" grade history at all), and 14 days was
   chosen only because it felt like a plausible "still fairly fresh" window for exam prep, not because any review
   data was available to fit it against.
5. **Testing the readiness score's streak/recency components over real HTTP has the exact same real-clock problem
   round 2 and round 4 already hit (and solved the same way).** Building up a multi-day streak, or checking that a
   grade from "yesterday" outweighs one from "a month ago," requires backdating reviews the way the priority-
   ordering, reminder-digest, and streak tests already do — `POST /review/:cardId` has no way to inject a fake
   `now` over the wire, and grading always pushes `dueAt` at least a day into the real future. The readiness tests
   follow the same documented pattern already established in this file: call `recordReviewForStudent` and
   `getTopicReadiness` directly with an injected `now`, rather than sleeping the test suite for real days or adding
   a test-only clock-override endpoint that would only exist to serve tests.
