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
