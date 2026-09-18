# Friction Log — CourtSide

Notes captured while building the Fire TV CourtSide submission, for the hackathon's optional friction-log bonus.

## What worked well

- Shaping `CommentaryProvider` around a Bedrock-style call (`system` + `instruction` + `context` in, text out) up
  front made the interface obviously correct before writing any implementation — it's exactly what a real
  `ConverseCommand` payload looks like, so `TemplateCommentaryProvider` and a future `BedrockCommentaryProvider`
  are true drop-in siblings rather than the template implementation quietly baking in assumptions a real model call
  couldn't share.
- Testing over real HTTP (`fetch` against a live `http.Server`, not calling `gameService` functions directly) caught
  a real bug: my first cut of `server.ts` had `handleError(err, res)` with the arguments swapped on one route
  (copy-paste from a different call site) — a unit test calling the service layer directly would never have
  exercised the Express error path and this would have silently 500'd (actually thrown, since `res` would have been
  `undefined`) in the running server.
- Deciding event validation should live in `gameService.ts` rather than `server.ts` paid off immediately: the same
  validation (unknown event type, a `score` missing `points`) is exercised identically whether it arrives over HTTP
  or gets called directly in a future unit test, and it's the one thing standing between a garbled CV detection and
  a corrupted running score.

## Friction encountered

1. **"Reasonable template fallback" is genuinely a design decision, not a mechanical one.** Without an LLM, a
   template has to decide how much personality to fake — too flat ("Score: home +2") reads as a log line, not
   commentary; too much variety per event type risks feeling incoherent across a run. Settled on 2-3 seeded (not
   truly random) phrasings per event type keyed off the event's own ID, so the output is varied across events but
   deterministic for a given event — useful for asserting on it in tests without either flaky randomness or every
   line reading identically.
2. **Q&A template fallback can't actually understand a question, only pattern-match it.** A real Bedrock-backed
   provider trivially handles "why did the ref call that?" or "is that a common foul in this league?", but the
   template fallback only recognizes a handful of keyword buckets (score/foul/turnover/recap) and falls back to a
   generic state summary otherwise. That's an honest limitation of the fallback, not the interface — the seam
   itself doesn't restrict question complexity at all once a real LLM is behind it.
3. **No real CV pipeline or sports data API to integrate against in this environment** — same shape of gap as the
   sibling submissions not having Ring/Alexa device credentials. `POST /games/:id/events` deliberately mirrors the
   generic shape (`type`, `team`/`player`, `points`/`description`) any such feed would produce, so a real CV
   pipeline or a play-by-play API integration becomes a translation layer in front of this same endpoint rather
   than a rewrite of the event model.

## Round 2: advanced features

1. **SSE with Express is mostly fine, but the test is the hard part, not the server code.** Writing the
   `text/event-stream` route itself was ~15 lines (`writeHead` with the three standard headers, `res.write` a
   `data: ...\n\n` line per push, unsubscribe on `req.on("close")`). The friction was entirely on the test side:
   Node's `fetch()` resolves as soon as headers arrive, so the request/response cycle never "completes" while a
   stream stays open, and you have to read the body as a `ReadableStream` via `.getReader()` and race it against a
   timeout rather than just `await`ing a JSON body like every other test in this file. Worth the trouble — it's the
   only way to prove the push actually fires, rather than just asserting the route returns 200 with the right
   `Content-Type`.
2. **Designing "notable" was the actual design decision here, and it's easy to either over- or under-scope it.** A
   heuristic that escalates too much (e.g. "any score is notable") defeats the point of having a fast path at all;
   one that escalates too little (e.g. "only game_end is notable") would silently flatten genuinely big moments
   (a buzzer-beater go-ahead three) into the same generic template as a garbage-time free throw. Landed on
   "does this event change who's winning, or is it flagged serious by its own description" — cheap to compute from
   data already in hand (no new event fields, no separate classifier call), and it reads as an obviously correct
   line to draw rather than an arbitrary one. The one thing it can't catch: a `description` that under-reports
   severity (a feed that doesn't bother tagging a foul as "flagrant") — an honest limitation of a keyword heuristic,
   same shape as the Q&A template's keyword-matching limitation noted above.
3. **Resumable-feed cursor: ID vs. timestamp is a real tradeoff, not a formality.** A timestamp cursor is simpler to
   reason about and works even if the client only ever logged "the time I last saw a line," but two commentary
   lines generated in the same event-loop tick can land on the same millisecond, making a strict `createdAt >
   since` comparison silently drop or double-return an entry at the boundary. An ID cursor sidesteps that
   completely — it's resolved by *position* in the stored (newest-first) list, not by comparing clock values — but
   it requires the client to have actually captured an ID rather than "just the last timestamp I have," and it
   breaks if that specific entry is ever pruned. Shipped both (ID preferred, exact; timestamp as a documented, best
   -effort fallback) rather than picking one, since a real Fire TV client is exactly the kind of consumer that would
   reasonably have either on hand depending on how it persisted state before backgrounding.
4. **Per-viewer rate limiting needs a key strategy decided up front, or it silently limits the wrong thing.** The
   naive version — rate-limit by IP alone — would have let one viewer's spam exhaust the budget for every other
   viewer behind the same NAT/proxy (a real risk for a shared living-room Fire TV, or several viewers on one home
   network), while a version keyed only by `gameId` would let one viewer lock out everyone watching that game. Went
   with `(gameId, viewerId)` when a viewer ID is available and `(gameId, IP)` as the fallback the route already had
   to support (since `/ask` had no required viewer identity before this round) — which also meant threading an
   optional `viewerId` through the existing `/ask` body rather than adding a new required field, so the endpoint's
   old callers (no `viewerId` at all) keep working unchanged.

## Round 3: archive, alerts, watchlist

1. **Reusing `isNotableEvent` instead of a second "highlight-worthy" concept was the right call, but it meant
   changing what gets persisted, not just what gets read.** The tempting shortcut for `GET /games/:id/highlights`
   was to filter `GameState.recentEvents` at read time — but that list is capped at 15 and newest-first for the live
   overlay's benefit, not built to be a full-game archive. A high-scoring game blows past 15 events well before it
   ends, silently dropping early highlights from a "recap" that's supposed to cover the whole game. The actual fix
   was to give notable events their own uncapped, append-only store (`notableEventsByGame` in `store.ts`), populated
   at the exact moment `ingestEvent` already computes `isNotableEvent` — so the detection logic itself is reused
   byte-for-byte (one call site, one heuristic), only the *persistence* is new. Worth calling out because "reuse the
   heuristic" and "reuse the data structure it happens to write into" turned out to be two different decisions.
2. **Fire-and-forget webhook delivery is simple to say and slightly fiddly to get right without an unhandled
   rejection or an accidental await creeping back in.** `notifySubscribers` has to return before any HTTP call
   resolves (the whole point is not to slow down event ingestion), but every `deliverWithRetry` call inside it is
   still a real `async` function — call it without `void` and a linter (or a future reviewer) reasonably assumes a
   dropped promise is a bug. Settled on making `notifySubscribers` itself synchronous (it only decides rate limits
   and starts deliveries) and explicitly `void`-ing each `deliverWithRetry` call, with `deliverWithRetry` guaranteed
   to swallow every failure internally (network errors *and* non-2xx responses both just count as "try again") so
   there's never an unhandled rejection to chase down from a detached promise.
3. **Retry backoff timing is a real tradeoff between "prove it works" and "don't make the test suite slow."** A
   production-grade backoff (1s, 2s, 4s...) is the right call for a real receiver having a bad few seconds, but
   baking those delays into constants the test suite can't override would make a full `npm test` run take many
   extra seconds for a code path that, in the test's own local-HTTP-listener setup, virtually never actually fails.
   Went with short, still-genuinely-exponential backoff (150ms, then 300ms) rather than parameterizing it for tests
   the way `checkRateLimit` already is — the smoke suite's webhook receiver is always up, so retries basically never
   trigger there; the honest tradeoff being made is that this constant is tuned for "demo-fast" rather than
   "production-realistic," and a real deployment would want it configurable or at least larger.
4. **The rate-cap policy (drop vs. batch) has a real answer once you ask "what's the source of truth."** Batching
   sounded appealing at first — collapse a burst into one alert instead of silently losing information — but it
   means either delaying every alert until a batching window closes (adding latency to the *first* alert too, not
   just the excess ones) or holding an unbounded queue per subscription, which just moves the "what if the receiver
   never catches up" problem instead of solving it. Landed on dropping excess deliveries outright, and specifically
   because `GET /games/:id/highlights` already exists as the durable, uncapped record of every notable event: the
   webhook is explicitly a *best-effort, live* nudge, not the archive, so a receiver that wants the full picture
   after a burst can always reconcile against `/highlights` instead of the webhook stream. That framing — "the
   webhook can lose events, the archive never does" — made the tradeoff easy to defend rather than arbitrary, and is
   worth keeping in mind if a future round adds a "replay missed alerts" endpoint instead of just documenting the
   gap.
5. **Reusing `checkRateLimit` for a completely different key space (subscriptions, not viewers) than it was written
   for was a good sign the round-2 design held up.** It already took `max`/`windowMs` as parameters "for tests," but
   that same parameterization made it trivially reusable for the webhook cap with a different key prefix
   (`webhook:<subscriptionId>` vs. `<gameId>:<viewerId or IP>`) and different constants, with zero changes to
   `rateLimiter.ts` itself — a small confirmation that keeping that module's interface generic instead of hardcoding
   the `/ask` constants into its logic paid for itself a round later.

## Round 4: season stats, recaps, multi-sport, player alerts

1. **"Aggregate across every game" quietly needed a new uncapped store, twice.** Season-long stats and the recap
   endpoint both ran into the same shape of gap round 3's highlights feature already hit once:
   `GameState.recentEvents` is capped at 15 and scoped to one game, so neither "how many total points has this
   player scored across the season" nor "what happened in the last 10 minutes" could be answered from it once a
   game ran long or a viewer asked about a team across games. The fix for stats was an accumulator keyed by
   trimmed/lowercased name (not by game), folded in once per non-duplicate event right where `isNotableEvent` is
   already computed; the fix for recap was a second uncapped per-game event log alongside the existing uncapped
   commentary log, since a recap needs the raw events (for a structured, sport-neutral template) not just the
   rendered commentary text. Worth flagging as a pattern now: any "across time" or "across games" feature in this
   codebase should assume the capped, per-game `recentEvents` list isn't the right source, before reaching for it.
2. **Recap's window semantics had to pick a tiebreak between `since` and `sinceMinutes`, and pick it explicitly.**
   Both are legitimate ways to ask "what did I miss" — a client that persisted a last-seen commentary id wants exact
   resumption, one that only knows "it's been about 10 minutes" wants a rolling window — so rather than reject a
   request with both query params, `since` simply wins if present (matching `GET .../commentary?since=`'s existing
   precedent of accepting either an id or a timestamp under the same param without erroring). The one thing that
   needed to be resisted was reusing `getCommentary`'s cursor logic by importing it directly — the recap needs the
   underlying *events* in the window too (for the sport-neutral template), not just filtered commentary lines, so
   the id/timestamp cutoff-resolution logic got duplicated in `getRecap` against `listFullEvents` rather than
   threading commentary-derived cutoffs back through a second data source. A small amount of duplication beat a
   forced dependency between two independent stores.
3. **"Don't hardcode basketball language" is a real audit, not just adding an if-branch on `sport`.** It's easy to
   add a `sport` field, thread it into `isNotableEvent`, and call it done while every phrase template still says
   "grabs the rebound" or "finds the basket" regardless of sport — the field would exist but do nothing observable.
   Actually satisfying the requirement meant going template-by-template (`score`, `foul`, `turnover`, `rebound`,
   `steal`, `block`, `game_end`) and asking "does this specific phrase assume basketball," which turned out to be
   yes for most of them (a "rebound" and a "block" are basketball-specific enough that even the *event type name*
   carries baggage, addressed by giving non-basketball sports their own generic phrasing — "recovers the loose ball"
   instead of "cleans up the boards" — without renaming the shared event-type vocabulary itself, since that's the
   contract every existing test and integration already depends on). The one template intentionally left alone was
   `templateAnswerQuestion` and `describeEvent` — neither one actually contains a basketball-specific word to begin
   with, so branching them per sport would have been unnecessary work invented to look thorough rather than because
   the audit found anything to fix.
4. **The serious-foul heuristic couldn't just reuse basketball's keyword list with a shrug.** The tempting shortcut
   was "keep the same regex, sports are basically the same" — but a real soccer feed describing a "reaching-in foul"
   (a basketball phrase a lazily-ported feed might reuse) would never say "flagrant" or "technical," so every soccer
   foul would silently stay on the fast path forever, and a genuine red card wouldn't escalate either. Had to
   actually research what "serious foul" means in each sport's own vocabulary (soccer: red/second-yellow cards,
   violent conduct; football: flagrant/targeting/unnecessary-roughness/unsportsmanlike) rather than pattern-matching
   basketball's words onto a different sport's incidents.
5. **Extending subscription idempotency to include a new dimension (`playerName`) meant re-deriving the key, not
   just adding a field to compare.** The existing `getOrCreateSubscription` was keyed by `callbackUrl` alone inside
   a per-game map; naively adding `playerName` as a second equality check on lookup would have been fine for reads
   but wrong for the map's actual key space — two different players subscribing through the same `callbackUrl` need
   to land in *different* map entries, not one that gets silently overwritten or returned as a false "duplicate" for
   the second registration. Landed on folding `callbackUrl` and (when present) a normalized `playerName` into one
   composite string key computed by a single `subscriptionKey` helper, so there's exactly one place that decides
   what "the same subscription" means, and a subscription with no `playerName` still keys identically to before
   (pure `callbackUrl`) — the round-3 idempotency test needed zero changes to keep passing.

## Feature requests

- A minimal, published schema for a "generic play-by-play event" (type, team/player, timestamp, description) that
  Fire TV sports hackathon entries could standardize against, so a CV pipeline built by one team and a commentary
  backend built by another could interoperate without both re-inventing the same event shape.
- A lightweight Fire OS/Vega overlay starter sample specifically for "poll an HTTP endpoint and render/speak
  incoming text lines without blocking video" would have made the frontend integration point in this README more
  concrete to describe precisely.
