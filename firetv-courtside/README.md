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

## How it works

1. **A game starts tracking** (`POST /games`) — team names, sport (default basketball), and initial clock/period.
2. **Plays stream in** (`POST /games/:id/events`) — this is the computer-vision/data-feed integration point. Each
   event (`score`, `foul`, `turnover`, `rebound`, `steal`, `block`, `timeout`, `period_end`, `game_end`) updates the
   running score/clock/period and immediately produces a line of commentary via the `CommentaryProvider` seam.
3. **The overlay polls state and commentary** (`GET /games/:id/state`, `GET /games/:id/commentary`) to render the
   score bug and the narration feed (newest first).
4. **A viewer asks a question** (`POST /games/:id/ask`) — answered by the same `CommentaryProvider` seam, grounded
   in the game's current score, period, clock, and recent plays.

## Project layout

```
src/
  types.ts               Game/event/commentary data model, valid event-type vocabulary
  store.ts                In-memory game/commentary storage
  commentaryProvider.ts    CommentaryProvider interface (the Bedrock/LLM seam) + TemplateCommentaryProvider fallback
  gameService.ts           Core logic: start a game, ingest + validate events, generate commentary, answer questions
  server.ts                Express app factory: the HTTP API a Fire TV overlay would poll
  index.ts                 Entry point
test/
  smoke.test.ts            End-to-end test over real HTTP: start game → ingest events → state/commentary →
                            Q&A → unknown-game 404s → invalid-event 400s → ordering guarantees
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
newest-first order; and rejected events are confirmed to leave no trace in game state or the commentary feed. No
external services required.

## Swapping in a real Bedrock-backed provider

Everything in `gameService.ts` and `server.ts` depends only on the `CommentaryProvider` interface in
`src/commentaryProvider.ts` (`narrateEvent(game, event)` and `answerQuestion(game, question)`) — not on
`TemplateCommentaryProvider` directly. To go from template fallback to a real LLM:

1. Write a `BedrockCommentaryProvider implements CommentaryProvider` that builds the same `CommentaryPrompt` shape
   the template provider builds internally (`buildEventPrompt` / `buildQuestionPrompt`, already exported) — a
   `system` persona, an `instruction`, and serialized `context` — and forwards `system` + `instruction` + `context`
   into a `bedrock-runtime` `ConverseCommand` (e.g. against an Anthropic Claude or Amazon Nova model on Bedrock),
   returning the model's text response.
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
  a new backend per sport.
- **Quality of Idea:** This backend is the concrete, buildable slice of a pitch that stacks three prioritized Fire
  TV categories (AI-enhanced viewing, sports, multi-modal UX) and pairs naturally with the AWS Builder mini-challenge
  (Bedrock for commentary generation) with genuinely near-zero added scope, since the seam this submission built is
  exactly where that Bedrock integration plugs in.
