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
