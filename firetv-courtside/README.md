# CourtSide — AI Co-Commentator Backend for Live Sports

Implementation of the "CourtSide" idea from [`hackathon-ideas/fire-tv.md`](../hackathon-ideas/fire-tv.md): casual
sports viewers tune out of unfamiliar or lower-profile games because they lack context — the rules, the players,
what's actually at stake in the moment. CourtSide is an AI co-commentator that sits alongside a live sports
broadcast, narrating plays in plain language and answering spoken or typed questions ("why was that a foul?", "what's
the score?") without the viewer ever leaving the video.

Built for the **Fire TV track** of the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/).

## Scope of this submission

**This repo is the backend commentary service a Fire TV app's on-screen overlay would call — not the Fire TV app
itself.** The sandboxed environment this was built in can't run a Fire OS/Vega TV app, an Android emulator, or a
physical Fire TV device, so this submission focuses on the part that's genuinely testable headlessly: game-state
tracking, play-by-play event ingestion, and the two AI seams (event commentary + viewer Q&A) that a real Bedrock
call would sit behind.

**What the real Fire TV integration would look like:** a Vega/Fire OS video app renders the live stream full-screen
with a lightweight overlay panel (a persistent caption strip plus an expandable panel, positioned to never cover the
score bug or the ball/puck) that polls `GET /games/:id/commentary` and renders new lines as they arrive, auto-hiding
during high-action stretches so it never blocks the play. A computer-vision pipeline watching the broadcast feed (or
a paired play-by-play data API) would POST detected plays to `POST /games/:id/events` in real time. D-pad and voice
input both wire into the same `POST /games/:id/ask` — pressing a "Ask CourtSide" remote button or a wake-word-driven
voice query both just collect a question string and hit that one endpoint, so the front end doesn't need two
separate answer paths for the two input modalities.

**What round 5's frontend integration would look like:** a fantasy roster is a short settings-style form (search a
player, add to a short list) surfaced from the same overlay panel, with fantasy plays rendered as a visually distinct
"your player" badge on top of the regular caption strip rather than a separate screen. A posed prediction renders as
a lightweight, dismissible D-pad-selectable prompt (yes/no or two team logos) overlaid for a short window, the same
"never block the play" placement discipline as the commentary panel already follows, with the viewer's running
accuracy surfaced as a small persistent badge. A watch party is the natural extension of Fire TV's existing
Watch Party / group-watching affordances — joining one is a remote-friendly "enter a room code" or a deep link shared
from a companion app, and shared Q&A renders as a lightweight chat rail alongside the video rather than a modal that
blocks it. A locale is a one-time setting (an existing Fire TV profile/language setting, or a first-run prompt) that
the app threads into every `?locale=`/`locale` it sends, rather than a setting a viewer manages per session.

## How it works

1. **A game starts tracking** (`POST /games`) — team names, sport (default basketball), and initial clock/period.
2. **Plays stream in** (`POST /games/:id/events`) — this is the computer-vision/data-feed integration point. Each
   event (`score`, `foul`, `turnover`, `rebound`, `steal`, `block`, `timeout`, `period_end`, `game_end`) updates the
   running score/clock/period and immediately produces a line of commentary via the `CommentaryProvider` seam.
3. **The overlay polls state and commentary** (`GET /games/:id/state`, `GET /games/:id/commentary`) to render the
   score bug and the narration feed (newest first).
4. **A viewer asks a question** (`POST /games/:id/ask`) — answered by the same `CommentaryProvider` seam, grounded
   in the game's current score, period, clock, and recent plays.

## Advanced features

Six additions on top of the v1 golden path, aimed at the kind of production concerns that show up the moment a demo
service is asked to run for real: pushing updates instead of making every client poll, surviving a flaky upstream
feed, controlling AI cost/latency at scale, personalizing output per viewer, resuming a feed after a disconnect, and
protecting an LLM-shaped endpoint from abuse.

### 1. Live commentary push via Server-Sent Events

`GET /games/:id/stream` opens a long-lived `text/event-stream` connection and pushes a `data: {...}` line the moment
a new event produces commentary — no polling needed for a client that wants to react instantly. The existing
`GET /games/:id/commentary` polling endpoint is untouched, so an overlay can use either (or both: SSE for instant
reaction, polling as a fallback/resync). Implemented with a tiny in-process pub/sub (`src/pubsub.ts`, one
`EventEmitter` per game) — `ingestEvent` publishes after a non-duplicate event is processed; the route subscribes on
connect and unsubscribes on `req.on("close")`.

```bash
# In one terminal: hold a stream connection open and print every push
curl -N localhost:4455/games/<id>/stream

# In another terminal: ingest an event — the first terminal immediately prints a
# "data: {"type":"commentary","commentary":{...},"state":{...}}" line
curl -X POST localhost:4455/games/<id>/events -H "Content-Type: application/json" \
  -d '{"type": "score", "team": "home", "points": 2}'
```

### 2. Idempotent event ingestion

`POST /games/:id/events` accepts an optional `externalEventId` — the upstream feed's own ID for the play. Re-posting
the same `externalEventId` for the same game is a clean no-op: the original event/commentary is returned, the score
is not double-applied, no second commentary line is generated, and nothing is re-published to the SSE stream. The
response status distinguishes the two cases (`201` for a new event, `200` with `"duplicate": true` for a replay) so
a caller can tell them apart if it cares, without either case being an error. This is the standard defense against a
webhook/event-ingestion endpoint getting double-posted by a flaky computer-vision pipeline or data feed.

```bash
curl -X POST localhost:4455/games/<id>/events -H "Content-Type: application/json" \
  -d '{"type": "score", "team": "home", "points": 3, "externalEventId": "cv-play-042"}'
# Reposting the exact same externalEventId (network retry, at-least-once delivery, etc.)
# returns 200 { "duplicate": true, ... } instead of scoring the play twice.
```

### 3. Confidence-gated commentary generation (sidecar-style fast path)

Not every play needs a full (potentially LLM-backed, per-call-cost) `CommentaryProvider` round trip. `isNotableEvent`
in `src/gameService.ts` is a small, explicit heuristic: a `game_end` always escalates; a `score` escalates only when
it changes who's leading or ties a previously-decided game (a go-ahead/momentum-shifting score); a `foul` escalates
only when its description flags it as serious (`flagrant`/`technical`/`ejection`); everything else (turnover,
rebound, steal, block, timeout, period_end) is routine enough to template directly. Routine events call
`TemplateCommentaryProvider` directly (the fast path); notable events go through the configured `provider` (the
escalated path — a real Bedrock provider in production). Both paths are counted per game and exposed via
`GET /games/:id/metrics`, mirroring a real cost/latency-optimization pattern for AI-generated commentary at scale.

```bash
curl localhost:4455/games/<id>/metrics
# -> { "gameId": "...", "fastPathCount": 11, "escalatedCount": 3, "total": 14 }
```

### 4. Personalized commentary preferences

`POST /games/:id/viewers/:viewerId/preferences` stores a per-viewer `{ favoriteTeam, verbosity }` object
(`verbosity` is `"concise"` — the default, unchanged output — or `"detailed"`). `personalizeText` in
`src/commentaryProvider.ts` applies those preferences as a post-processing decorator on top of whatever text was
already generated (template or LLM alike): a matching `favoriteTeam` gets an appended fan-perspective note (e.g.
"Celtics fan view: up by 3."), and `"detailed"` appends period/clock/score context. It's opt-in and additive —
`GET /games/:id/commentary` with no `viewerId` and `POST /games/:id/ask` with no `viewerId` behave exactly as before.

```bash
curl -X POST localhost:4455/games/<id>/viewers/v1/preferences -H "Content-Type: application/json" \
  -d '{"favoriteTeam": "Celtics", "verbosity": "detailed"}'

curl "localhost:4455/games/<id>/commentary?viewerId=v1"
# -> "...Tatum scores! ... (Celtics fan view: up by 3.) [Quarter 1, 11:42 remaining, Lakers 0 - 3 Celtics.]"
```

### 5. Resumable commentary feed

`GET /games/:id/commentary` accepts `?since=<cursor>`, where `<cursor>` is either a previously-seen commentary
line's `id` or an ISO timestamp. An ID cursor returns everything strictly newer than that entry (exact — unaffected
by clock resolution, since it's resolved by position in the stored feed, not by comparing timestamps); a timestamp
cursor returns everything created after it. A reconnecting client (or a Fire TV app resuming from the background)
remembers the last commentary `id` it saw and passes it back instead of re-fetching full history every time.

```bash
curl "localhost:4455/games/<id>/commentary?since=<last-seen-commentary-id>"
```

### 6. Rate limiting on `/ask`

`POST /games/:id/ask` now accepts an optional `viewerId` in the body. Questions are capped at 10 per 60-second
window, keyed by `(gameId, viewerId)` when a `viewerId` is given, or `(gameId, IP)` otherwise — so a busy show still
lets every viewer ask their own questions, but one spammy remote/voice loop can't flood the (potentially
LLM-backed) Q&A path. The 11th question within the window gets a `429` with a clear message and a `retryAfterMs`
hint instead of a silent drop or an expensive extra provider call.

```bash
curl -X POST localhost:4455/games/<id>/ask -H "Content-Type: application/json" \
  -d '{"question": "what is happening", "viewerId": "v1"}'
# -> 429 { "error": "Too many questions for this game — limit is 10 per 60s. ...", "retryAfterMs": 4213 }
```

## Round 3: archive, alerts, and a cross-game watchlist

Four more additions, all building directly on top of the confidence-gating work from round 2 rather than
duplicating it: a shareable highlight reel, outbound webhook alerts for notable moments, a multi-game "what did I
miss" view, and the idempotency/rate-limiting discipline those alerts need to be safe to turn on.

### 1. Game archive & highlights

`GET /games/:id/highlights` returns a shareable recap of a game's notable moments — and reuses the *exact same*
`isNotableEvent` heuristic from round 2's confidence-gated commentary routing (`src/gameService.ts`) rather than a
second, separate notion of "highlight-worthy". Every notable event is now also appended to an uncapped per-game
highlight reel (`src/store.ts`'s `notableEventsByGame`, distinct from the capped `recentEvents` used for the live
overlay) the moment `ingestEvent` decides it's notable — so the endpoint works identically whether the game is still
in progress (highlights-so-far) or has already received a `game_end` event (`game_end` is always notable, so it's
always the top entry in a finished game's recap).

```bash
curl localhost:4455/games/<id>/highlights
# -> { "gameId": "...", "status": "in_progress", "homeScore": 8, "awayScore": 6,
#      "highlights": [ { "event": {...}, "commentary": {...} }, ... ] }  // newest first
```

### 2. Outbound score-alert subscriptions

`POST /games/:id/subscriptions { "callbackUrl": "https://...", "viewerId"?: "..." }` registers a webhook that gets a
signed `POST` the instant a *notable* event happens in that game — the same notability signal driving highlights
above. The response includes a freshly generated per-subscription secret (`subscription.secret`), returned exactly
once, that the receiver uses to verify each delivery.

Delivery (`src/webhooks.ts`) is fire-and-forget from `ingestEvent`'s point of view — the ingestion request that
triggered a notable event returns immediately regardless of how the webhook delivery goes. Each delivery is signed
with `HMAC-SHA256` over the raw JSON body using the subscription's secret, sent as
`X-CourtSide-Signature: sha256=<hex-digest>` (the same `algo=digest` convention GitHub/Stripe webhooks use). A
failing delivery (non-2xx response or a network error) is retried up to 3 attempts total, with exponential backoff
(150ms, then 300ms) between attempts, before being given up on and logged.

```bash
# Register a webhook (note the returned "secret" — you'll need it to verify deliveries)
curl -X POST localhost:4455/games/<id>/subscriptions -H "Content-Type: application/json" \
  -d '{"callbackUrl": "https://example.com/courtside-alerts"}'
# -> 201 { "subscription": { "id": "...", "callbackUrl": "...", "secret": "a3f1...c9", "createdAt": "..." }, "duplicate": false }

# Verify a delivery on the receiving end (Node example):
#   const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
#   if (`sha256=${expected}` !== req.headers["x-courtside-signature"]) reject();
```

### 3. Multi-game watchlist

`GET /watchlist?viewerId=<id>` answers "what did I miss across every game I'm following?" — it aggregates notable
events across every game that viewer has interacted with (asked a question on via `POST /games/:id/ask`, or set
preferences for via `POST /games/:id/viewers/:viewerId/preferences`), ordered newest-first *across* games rather
than grouped per game. A viewer who hasn't interacted with any game yet gets an empty (not error) watchlist.

```bash
curl "localhost:4455/watchlist?viewerId=v1"
# -> { "viewerId": "v1", "gameIds": ["game-a", "game-b"],
#      "highlights": [ { "gameId": "game-b", "homeTeam": "...", "awayTeam": "...", "event": {...}, "commentary": {...} }, ... ] }
```

### 4. Idempotent, rate-limited subscriptions

`POST /games/:id/subscriptions` is idempotent on `(gameId, callbackUrl)` — the same spirit as round 2's
`externalEventId` ingestion idempotency. Registering the same `callbackUrl` for the same game twice returns the
*original* subscription (`200`, `"duplicate": true`, same `id` and `secret`) rather than creating a second one that
would double-fire every future alert.

Each subscription is also capped at **5 alert deliveries per rolling 60-second window** (reusing the same
fixed-window `checkRateLimit` from `src/rateLimiter.ts` that powers `/ask`'s rate limiting, keyed per subscription
instead of per viewer). A burst of notable events beyond the cap — several quick go-ahead scores, say — has its
*excess deliveries dropped* for that subscription rather than queued or batched: the receiver never gets flooded,
and nothing is actually lost, since the full, uncapped notable-event history is always available afterward via
`GET /games/:id/highlights`. See `FRICTION_LOG.md` for why "drop" was chosen over "batch" here.

```bash
# Registering the same callback twice is a no-op, not a second subscription:
curl -X POST localhost:4455/games/<id>/subscriptions -H "Content-Type: application/json" \
  -d '{"callbackUrl": "https://example.com/courtside-alerts"}'
# -> 200 { "subscription": { ...same id and secret as the first registration... }, "duplicate": true }
```

## Round 4: season stats, catch-up recaps, multi-sport, player alerts

Four more additions: aggregating stats beyond a single game, a natural-language "what did I miss" recap for a
window instead of raw commentary lines, generalizing the event vocabulary/templates to more than basketball, and
narrowing the round-3 webhook subscription down to a single favorite player.

### 1. Season-long stats aggregation

`GET /stats/team/:teamName` and `GET /stats/player/:playerName` return cumulative totals — `points`, an
`eventCounts` breakdown per event type, `notableEvents`, and `gamesPlayed` — aggregated across **every game this
process has ingested events for**, not just one. Every non-duplicate event folds into whichever team/player it
names the instant `ingestEvent` processes it (`recordTeamStat`/`recordPlayerStat` in `src/gameService.ts`), keyed by
a trimmed, case-insensitive name so "Lakers" ingested as the home team in one game and the away team in another
still accumulates under one entry. A name that's never appeared in an event returns a zeroed result (`200`), not a
404 — there's no separate "team" or "player" resource to have gone missing.

```bash
curl localhost:4455/stats/team/Lakers
# -> { "name": "Lakers", "gamesPlayed": 2, "points": 13, "eventCounts": { "score": 2, "foul": 1 }, "notableEvents": 1 }

curl localhost:4455/stats/player/James
# -> { "name": "James", "gamesPlayed": 2, "points": 13, "eventCounts": { "score": 2, "foul": 1 }, "notableEvents": 1 }
```

### 2. "Catch-up" recap endpoint

`GET /games/:id/recap` generates a natural-language summary of a window of the game — via the exact same
`CommentaryProvider` seam that narrates events and answers questions (a real Bedrock provider would summarize it;
`TemplateCommentaryProvider`'s new `generateRecap` gives a deterministic fallback) — instead of just handing back
the raw commentary lines the way `GET /games/:id/commentary` does. The window is expressed either as
`?sinceMinutes=<n>` (a rolling time window ending now) or `?since=<commentary-id-or-ISO-timestamp>` (the same cursor
style `GET /games/:id/commentary?since=` already uses — an id resolved by position, exact; a timestamp as a
best-effort fallback); `since` wins if both are given, and omitting both recaps the whole game so far. Building this
required giving each game its own uncapped, chronological event log (`allEventsByGame` in `src/store.ts`) alongside
the capped `recentEvents` the live overlay uses — the same "capped list isn't an archive" lesson round 3's
highlights feature already ran into, applied to raw events instead of just notable ones.

```bash
curl "localhost:4455/games/<id>/recap?sinceMinutes=10"
# -> { "gameId": "...", "windowLabel": "in the last 10 minutes", "eventCount": 4,
#      "summary": "Catching you up on what happened in the last 10 minutes: ...", "generatedAt": "..." }

curl "localhost:4455/games/<id>/recap?since=<last-seen-commentary-id>"
```

### 3. Multi-sport event vocabulary

A game can declare `"sport": "basketball" | "football" | "soccer"` at `POST /games` (any other value, or none, keeps
basketball's exact original behavior — the default sport was already basketball since round 1). Two things now
adapt per sport instead of hardcoding basketball's vocabulary:

- **Commentary phrasing** (`src/commentaryProvider.ts`): each event type (`score`, `foul`, `turnover`, `rebound`,
  `steal`, `block`, `game_end`) has its own per-sport phrase set — a soccer score says "GOAL! ... finds the back of
  the net" instead of "Bucket for ...", a football foul says "Penalty on ..." instead of "Foul called on ...", and a
  soccer game ends with "That's full-time!" instead of "That's the final!". A game's default `periodLabel` is now
  sport-aware too — `"half"` for soccer, `"quarter"` for basketball and football (basketball's original default,
  unchanged).
- **The `isNotableEvent` foul-escalation gate** (`src/gameService.ts`): basketball's serious-foul keywords
  (flagrant/technical/ejection) don't mean anything in soccer or football. `isSeriousFoulDescription` now branches
  per sport — soccer escalates on "red card"/"second yellow"/"violent conduct", football on
  "flagrant"/"ejection"/"targeting"/"unnecessary roughness"/"unsportsmanlike" — so a soccer foul description that
  happens to say "reaching-in foul" (a basketball phrase, e.g. from a feed that reuses descriptions loosely) doesn't
  spuriously escalate, and a real red card does.

`GET /games/:id/recap` reuses the sport-neutral `describeEvent` helper (already just `[type] who +points —
description`, no sport-specific words), so recaps adapt to any sport for free without needing their own per-sport
phrasing.

```bash
curl -X POST localhost:4455/games -H "Content-Type: application/json" \
  -d '{"sport": "soccer", "homeTeam": "Barca", "awayTeam": "Real"}'
# -> periodLabel defaults to "half" instead of "quarter"

curl -X POST localhost:4455/games/<id>/events -H "Content-Type: application/json" \
  -d '{"type": "score", "team": "home", "player": "Messi", "points": 1}'
# -> "GOAL! Messi finds the back of the net! Barca 1 - 0 Real." (never "basket"/"bucket"/"free throw")
```

### 4. Player-level alert subscriptions

`POST /games/:id/subscriptions` now accepts an optional `playerName` alongside `callbackUrl`. When set, that
subscription only fires for a notable event whose `player` field matches (case-insensitively) — a fan who only
cares about their favorite player's moments, not every notable event in the game. Omitting `playerName` keeps
round 3's original behavior unchanged (every notable event in the game). The idempotency key
(`getOrCreateSubscription` in `src/store.ts`) is now `(gameId, callbackUrl, playerName)` instead of just
`(gameId, callbackUrl)`, so the same callback URL can hold both a game-wide subscription and separate per-player
ones without colliding, and re-registering the exact same `(callbackUrl, playerName)` pair is still idempotent.

```bash
curl -X POST localhost:4455/games/<id>/subscriptions -H "Content-Type: application/json" \
  -d '{"callbackUrl": "https://example.com/curry-alerts", "playerName": "Curry"}'
# -> only fires for a notable event with "player": "Curry" — a flagrant foul on a different player is silent
```

## Round 5: fantasy plays, live predictions, watch parties, localized commentary

Four genuinely new *product* features rather than more production hardening — each one a different way a viewer
could actually engage with the same live event stream, not a new event type or infrastructure concern.

### 1. Fantasy-relevant play detection

`POST /games/:id/fantasy/:viewerId { "players": ["Giannis", "Tatum"] }` registers a small fantasy roster for a
viewer, on top of the exact same event stream every other feature reads — no new event vocabulary, since
`IncomingGameEvent.player` already carries player attribution wherever a real feed would report it. The instant this
is registered, `src/gameService.ts`'s `setFantasyRoster` backfills a highlight reel from every event already
ingested for this game that names a rostered player (so registering mid-game doesn't lose earlier plays), and from
then on `ingestEvent` tags any new event naming a rostered player onto that viewer's reel live — independent of
whether the play was "notable" by broadcast standards (see `isNotableEvent`), since a garbage-time bucket by your
fantasy pick still matters to you even when it doesn't move the broadcast needle. `GET /games/:id/fantasy/:viewerId`
retrieves it, newest first — a genuinely different lens on the same plays, not a second copy of the commentary feed.

```bash
curl -X POST localhost:4455/games/<id>/fantasy/v1 -H "Content-Type: application/json" \
  -d '{"players": ["Giannis", "Tatum"]}'
# -> { "gameId": "...", "viewerId": "v1", "roster": ["Giannis", "Tatum"],
#      "highlights": [...] }   // backfilled from events already ingested

curl localhost:4455/games/<id>/fantasy/v1
# -> newest-first plays naming either rostered player, updated live as new events come in
```

### 2. Live prediction/trivia mode

`POST /games/:id/predictions { "type"?: "next_possession_score" | "next_team_to_score" }` poses a prediction tied
to the game's *actual*, still-unfolding state — `"next_possession_score"` (the default) asks a yes/no "will the next
possession end in a score?"; `"next_team_to_score"` asks a multiple-choice "which team scores next: home or away?".
Neither is canned or pre-scored: `POST /games/:id/predictions/:predictionId/answer { "viewerId", "answer" }` records
a viewer's guess while the prediction is still `"open"`, and `resolveOpenPredictions` in `src/gameService.ts` — run
against every subsequent ingested event — actually inspects each new event to decide whether it resolves the
question (a `score` resolves `"next_possession_score"` as `"yes"`; a `turnover` resolves it `"no"`; anything else,
like a routine rebound or foul, leaves it open for a later event to decide). The moment a prediction resolves, every
submitted answer is scored against the real outcome and folded into that viewer's running accuracy
(`GET /viewers/:viewerId/predictions/accuracy`). A prediction still open when the game ends is `"voided"` — no event
could ever resolve it, so it's retired without counting for or against anyone.

```bash
curl -X POST localhost:4455/games/<id>/predictions -H "Content-Type: application/json" -d '{}'
# -> { "id": "...", "type": "next_possession_score", "question": "Will the next possession end in a score?",
#      "options": ["yes", "no"], "status": "open", ... }

curl -X POST localhost:4455/games/<id>/predictions/<predictionId>/answer -H "Content-Type: application/json" \
  -d '{"viewerId": "v1", "answer": "yes"}'

# ...a "turnover" event ingested next actually resolves it "no" — v1's answer is scored incorrect...

curl localhost:4455/viewers/v1/predictions/accuracy
# -> { "viewerId": "v1", "correct": 0, "total": 1, "accuracy": 0 }
```

### 3. Shared watch-party session

`POST /games/:id/parties { "name": "Living Room", "viewerId"?: "v1" }` creates (or, idempotently by
case-insensitive name, joins) a named watch-party session for a game — modeling the "watching together, remotely"
use case Fire TV increasingly supports. `POST /games/:id/parties/:partyId/join { "viewerId" }` adds another viewer.
The real payoff: `POST /games/:id/ask` now accepts an optional `partyId` alongside its existing `question`/`viewerId`
body — when given, the question and CourtSide's answer are no longer private to the asker. They're recorded into
that party's durable history (`GET /games/:id/parties/:partyId/qa`) *and* pushed live to every viewer already
connected to that game's `GET /games/:id/stream` (the exact same SSE pipe commentary already rides), tagged
`"type": "party_qa"` and the `partyId` so a client can filter it into a shared party-chat view distinct from the
narration feed. Asking into a party doubles as joining it. A question asked with no `partyId` behaves exactly as
before — private to the asker, nothing pushed anywhere.

```bash
curl -X POST localhost:4455/games/<id>/parties -H "Content-Type: application/json" \
  -d '{"name": "Living Room", "viewerId": "v1"}'
# -> 201 { "party": { "id": "...", "name": "Living Room", "members": ["v1"], ... }, "duplicate": false }

# In one terminal: watch the shared stream
curl -N localhost:4455/games/<id>/stream

# In another: ask into the party — every connected party member's stream gets the Q&A instantly
curl -X POST localhost:4455/games/<id>/ask -H "Content-Type: application/json" \
  -d '{"question": "whats the score", "viewerId": "v2", "partyId": "<partyId>"}'
# -> the first terminal prints: data: {"type":"party_qa","partyQnA":{"partyId":"...","viewerId":"v2",...}}
```

### 4. Localized commentary packs

`CommentaryProvider` now supports a `locale` parameter (`GET .../commentary?locale=`, `POST .../ask` body `locale`,
`GET .../recap?locale=`, or a stored per-viewer `locale` preference via `POST .../viewers/:viewerId/preferences`),
backed by genuinely distinct template packs in `src/commentaryProvider.ts` — not a translated swap of the same
English strings. `"en-broadcast"` (the default, byte-for-byte the original round 1-4 wording) is a standard
play-by-play voice; `"en-casual"` is a hype-friend-on-the-couch voice with its own sentence rhythm ("Ohhh we love to
see it — Bridges scores!" instead of "Bridges scores!"); `"es-broadcast"` is a formal Spanish-language broadcast
voice written natively in Spanish ("¡Anota Bridges!"), not run through a translator. Because commentary is generated
once per event and shared across every viewer (see `personalizeText`'s doc comment — the same reasoning applies
here), a non-default locale is produced by regenerating each line fresh from its underlying event via the exact
commentary-generation path (`fast`/`escalated`) it originally took (`CommentaryLine.path`, new this round) — the
default-locale read stays exactly as cheap as it always was, and only a genuinely non-default request pays for
regeneration.

```bash
curl "localhost:4455/games/<id>/commentary?locale=en-casual"
# -> "Ohhh we love to see it — Bridges scores! Nets 2 - 0 Wizards."

curl "localhost:4455/games/<id>/commentary?locale=es-broadcast"
# -> "¡Anota Bridges! Nets 2 - 0 Wizards."

curl -X POST localhost:4455/games/<id>/viewers/v1/preferences -H "Content-Type: application/json" \
  -d '{"locale": "es-broadcast"}'
curl "localhost:4455/games/<id>/commentary?viewerId=v1"
# -> applies v1's stored locale automatically, no explicit ?locale= needed
```

## Project layout

```
src/
  types.ts               Game/event/commentary data model, valid event-type vocabulary, preferences/metrics types,
                          NotableEventRecord (highlights), Subscription (webhook, now with an optional playerName
                          filter), EntityStats (season-long team/player aggregation), and — new this round —
                          FantasyRosterResult/FantasyHighlightsResult, Prediction/PredictionAnswer/PredictionAccuracy,
                          WatchParty/PartyQnA, and CommentaryLocale types
  store.ts                In-memory game/commentary storage, idempotency ledger, metrics, viewer preferences,
                           per-game highlight reel, per-game subscriptions (now keyed by callbackUrl+playerName),
                           viewer<->game interaction tracking, an uncapped per-game event log (recap), season-long
                           team/player stats accumulators, and — new this round — per-viewer fantasy
                           rosters/highlights, predictions + answers + per-viewer accuracy, and watch
                           parties + shared Q&A history
  commentaryProvider.ts    CommentaryProvider interface (the Bedrock/LLM seam, now including a `locale` parameter on
                           every method) + TemplateCommentaryProvider fallback + personalizeText (per-viewer
                           preference decorator) + per-sport phrase tables + per-locale phrase packs
                           (en-broadcast/en-casual/es-broadcast)
  gameService.ts           Core logic: start a game, ingest + validate + de-duplicate events, confidence-gated
                           commentary routing (isNotableEvent, now sport-aware), generate commentary, answer
                           questions, highlights, subscription registration (game- or player-scoped), cross-game
                           watchlist aggregation, season-long stats lookups, catch-up recap, and — new this round —
                           fantasy roster registration + backfill, prediction posing/answering/resolution
                           (resolveOpenPredictions, driven by real ingested events), watch-party
                           creation/joining/shared-Q&A, and locale resolution (resolveLocale)
  webhooks.ts             Outbound score-alert delivery: HMAC-SHA256 signing, retry with exponential backoff,
                           per-subscription rate capping, and player-name filtering before fan-out
  pubsub.ts               Per-game EventEmitter registry powering the SSE stream (now also carrying "party_qa" pushes)
  rateLimiter.ts           Fixed-window rate limiter shared by POST /ask and outbound webhook delivery
  server.ts                Express app factory: the HTTP API a Fire TV overlay would poll and stream
  index.ts                 Entry point
test/
  smoke.test.ts            End-to-end test over real HTTP: start game → ingest events → state/commentary →
                            Q&A → unknown-game 404s → invalid-event 400s → ordering guarantees → SSE push →
                            idempotent ingestion → fast/escalated routing → per-viewer personalization →
                            resumable feed → /ask rate limiting → highlights → signed webhook delivery →
                            idempotent subscriptions → per-subscription rate cap → multi-game watchlist →
                            season-long team/player stats → windowed catch-up recaps → sport-aware commentary
                            and notable-event heuristic → player-scoped alert subscriptions → fantasy roster
                            registration + backfill + live tagging → prediction posing/answering/event-driven
                            resolution/voiding + per-viewer accuracy → watch-party creation/joining + shared
                            Q&A over SSE and its durable history → locale-parameterized commentary/Q&A + stored
                            per-viewer locale preference
```

## Running it

```bash
npm install
npm run build
npm start
# CourtSide listening on http://localhost:4455
```

Or for local iteration: `npm run dev`

### Try it by hand

```bash
# 1. Start tracking a game
curl -X POST localhost:4455/games -H "Content-Type: application/json" \
  -d '{"homeTeam": "Hawks", "awayTeam": "Nets"}'
# -> note the returned "id"; use it as :id below

# 2. Ingest a few plays (stands in for a CV pipeline / play-by-play feed)
curl -X POST localhost:4455/games/<id>/events -H "Content-Type: application/json" \
  -d '{"type": "score", "team": "home", "player": "Trae", "points": 3}'

curl -X POST localhost:4455/games/<id>/events -H "Content-Type: application/json" \
  -d '{"type": "foul", "team": "away", "player": "Bridges", "description": "reaching-in foul"}'

# 3. Check the running state
curl localhost:4455/games/<id>/state

# 4. See generated commentary, newest first
curl localhost:4455/games/<id>/commentary

# 5. Ask a question grounded in current game state
curl -X POST localhost:4455/games/<id>/ask -H "Content-Type: application/json" \
  -d '{"question": "why was that a foul?"}'
```

## Testing

```bash
npm test
```

Starts the server on an ephemeral port and drives it over real HTTP requests: starting a game, ingesting four
different event types (score, foul, turnover, score) and confirming each produces grounded commentary, confirming
`/state` reflects the running score, and confirming `/ask` answers both a "what's the score?" and a "why was that a
foul?" question using the actual game data. It also covers edge cases: an unknown game ID returns a clean 404 (not
a crash) from both `/state` and `/ask`; an event with a missing or invalid `type` is rejected with 400; a `score`
event missing a positive `points` field is rejected; an empty question is rejected; the commentary feed stays in
newest-first order; and rejected events are confirmed to leave no trace in game state or the commentary feed.

It then covers all six advanced features end to end: a client connected to `GET /games/:id/stream` receives a
pushed SSE line the instant an event is ingested; replaying the same `externalEventId` produces no duplicate score
mutation or commentary line; a routine event takes the fast template path while a go-ahead score and a flagrant foul
both escalate, reflected exactly in `GET /games/:id/metrics`; a viewer's stored preferences visibly change both
`GET /games/:id/commentary?viewerId=...` text and a personalized `/ask` answer while the un-personalized versions
stay unchanged; `?since=<commentary-id>` (and `?since=<timestamp>`) returns only newer entries; and the 11th rapid
question from one viewer in one game is rejected with 429 while a second viewer on the same game is unaffected. No
external services required.

It then covers all four round-3 features: `GET /games/:id/highlights` returns only the notable events out of a mixed
sequence of routine/notable ones, both while the game is in progress and after `game_end`; a webhook registered via
`POST /games/:id/subscriptions` (against a tiny local `http.createServer` the test spins up itself) receives a
correctly HMAC-SHA256-signed `POST` the moment a notable event is ingested, and nothing at all for a routine one;
registering the same `callbackUrl` twice returns the original subscription instead of creating a duplicate; a burst
of 8 notable events against one subscription results in exactly 5 deliveries (the rate cap) with the rest dropped,
while the full 8 still show up in that game's `/highlights`; and `GET /watchlist?viewerId=...` aggregates notable
events across two different games one viewer interacted with (one via `/ask`, one via preferences), newest-first
across games, with an empty (not error) result for a viewer with no interactions yet.

Finally, it covers all four round-4 features: `GET /stats/team/:teamName` and `GET /stats/player/:playerName`
correctly sum points/eventCounts/gamesPlayed for a team and player that appeared in two separate games (one as home,
one as away), and return a zeroed result for a name never seen; `GET /games/:id/recap?since=<cursor>` summarizes
only the event after the cursor (mentioning it by name) while never mentioning an earlier event outside the window,
`?sinceMinutes=` and no-window-at-all are also exercised; a soccer game's generated commentary is asserted to avoid
basketball-specific words ("basket"/"bucket"/"free throw"/"boards") and its notable-event heuristic is shown using
soccer's own serious-foul vocabulary (a basketball-phrased description stays routine, a "red card" escalates), while
a game with no sport specified is confirmed to keep basketball's original `periodLabel` default unchanged; and a
player-scoped subscription (`playerName: "Curry"`) is shown firing for a notable event naming that player but
staying silent for another player's notable event in the same game, with the same `callbackUrl` registering as a
distinct subscription per player.

Finally, it covers all four round-5 features: registering a fantasy roster backfills highlights from events already
ingested and then tags new matching plays live, while excluding plays naming a non-rostered player, and a viewer with
no registered roster gets an empty (not error) result; a posed prediction is shown staying `"open"` through an
unrelated event (a rebound) and only actually resolving off a real subsequent score/turnover event, with each
viewer's submitted answer scored correctly or incorrectly against the real outcome and folded into
`GET /viewers/:viewerId/predictions/accuracy`, a duplicate or post-resolution answer rejected with 400, an
out-of-options answer rejected with 400, and a prediction still open at `game_end` shown transitioning to
`"voided"` without affecting anyone's accuracy; a watch party is created and idempotently re-joined by a
case-insensitive duplicate name, a question asked with that party's id is asserted to arrive over the game's
`GET /games/:id/stream` tagged `"party_qa"` and to appear in `GET /games/:id/parties/:partyId/qa`'s durable history,
while a question asked with no `partyId` is confirmed to stay private and never appear in any party's history, and
both a missing `viewerId` and an unknown `partyId` are rejected cleanly; and localized commentary is shown producing
genuinely different text per locale (`en-casual` and `es-broadcast` each asserted to differ from the default
`en-broadcast` text, with the Spanish pack asserted to contain real Spanish words), an unsupported locale rejected
with 400, omitting `locale` confirmed to leave the original `en-broadcast` text byte-for-byte unchanged, and a
viewer's stored `locale` preference shown applying automatically with no explicit `?locale=` on the request.

## Swapping in a real Bedrock-backed provider

Everything in `gameService.ts` and `server.ts` depends only on the `CommentaryProvider` interface in
`src/commentaryProvider.ts` (`narrateEvent(game, event, locale?)` and `answerQuestion(game, question, locale?)`) —
not on `TemplateCommentaryProvider` directly. To go from template fallback to a real LLM:

1. Write a `BedrockCommentaryProvider implements CommentaryProvider` that builds the same `CommentaryPrompt` shape
   the template provider builds internally (`buildEventPrompt` / `buildQuestionPrompt`, already exported, both
   locale-aware via `localeSystemPersona`) — a `system` persona, an `instruction`, and serialized `context` — and
   forwards `system` + `instruction` + `context` into a `bedrock-runtime` `ConverseCommand` (e.g. against an
   Anthropic Claude or Amazon Nova model on Bedrock), returning the model's text response. A real LLM can honor
   `locale` directly from its (already locale-aware) `system` persona instead of needing a hand-written template
   pack per locale the way `TemplateCommentaryProvider` does.
2. Swap the one line in `src/index.ts` that constructs `new TemplateCommentaryProvider()` for
   `new BedrockCommentaryProvider(bedrockClient, modelId)`. Nothing in `gameService.ts`, `server.ts`, or the test
   suite needs to change, since both only ever call the interface.
3. Optionally keep `TemplateCommentaryProvider` around as an automatic fallback (e.g. wrap the Bedrock call in a
   `try/catch` that falls back to the template provider) so the overlay never shows a broken/empty commentary line
   if a Bedrock call times out or the account has no model access during a live demo.

This is deliberately the same boundary shape as `alexa-homeops-mcp`'s device-control seam and `ring-porchpass`'s
`RingClient` — an interface plus a fully-working in-memory/simulated default, with the real integration isolated to
one new file and one line in `index.ts`.

## Judging-criteria alignment

- **Tech Implementation:** A real Express/TypeScript service with an actual game-state machine (score, period,
  clock, capped recent-events log), input validation that rejects malformed CV/feed events with 400s instead of
  corrupting state, and a genuine end-to-end HTTP test suite (not mocks) covering the golden path plus edge cases.
  The `CommentaryProvider` interface is deliberately shaped like a Bedrock `Converse` call (system + instruction +
  context in, text out) so wiring in a real model is a same-shaped swap, not a redesign.
- **Design:** The API is shaped around exactly what a 10-foot overlay needs and nothing more — poll `/state` for the
  score bug, poll `/commentary` for the narration feed (newest first, so the overlay can just prepend), and a single
  `/ask` endpoint that both D-pad-driven typed questions and voice-transcribed questions can share, so the overlay
  doesn't need parallel code paths per input modality.
- **Potential Impact:** Commentary generation and Q&A are entirely event/data-driven and sport-agnostic (the event
  vocabulary and `sport`/`periodLabel` fields aren't basketball-specific), so the same service could sit behind any
  live-sports overlay across leagues — matching the idea's "big-tent, cross-league companion layer" pitch — without
  a new backend per sport. Round 5's shared watch-party session and localized commentary packs directly widen who
  the service reaches: co-viewing is exactly how Fire TV increasingly gets watched, and a real non-English broadcast
  voice (not a translated placeholder) is table stakes for reaching non-English-speaking households.
- **Quality of Idea:** This backend is the concrete, buildable slice of a pitch that stacks three prioritized Fire
  TV categories (AI-enhanced viewing, sports, multi-modal UX) and pairs naturally with the AWS Builder mini-challenge
  (Bedrock for commentary generation) with genuinely near-zero added scope, since the seam this submission built is
  exactly where that Bedrock integration plugs in. Round 5 pushes past production hardening into product
  differentiation: fantasy-relevant play detection and live prediction/trivia are engagement mechanics a viewer
  would actually seek CourtSide out for, not just infrastructure a judge would expect any production service to have.
