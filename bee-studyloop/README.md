# StudyLoop — Ambient Study Session Coach for Bee

Implementation of the "StudyLoop" idea from [`hackathon-ideas/bee.md`](../hackathon-ideas/bee.md): students lose
track of what they actually discussed or decided in a study session, and converting ambient conversation into
structured review material is friction they mostly skip. StudyLoop takes a study session's transcript, turns it
into a short summary plus a set of spaced-repetition flashcards automatically, and schedules them into a daily
review queue — no manual note-taking required.

Built for the **Bee track** of the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/),
which requires data from a real Bee wearable (or an Apple Watch running Bee software) and guides teams to integrate
Bee's CLI, MCP server, or Agent Skills, prioritizing education, developer experience, and productivity.

## Scope of this submission

This environment has no physical Bee device or Apple Watch, so this repo implements **the backend service that
would sit behind Bee's ambient capture** — the part of StudyLoop that is genuinely testable headlessly: ingesting
transcript segments, generating flashcards/summaries from them, and running the spaced-repetition scheduler that
decides what to review and when. That pipeline is real, tested, and independent of where the transcript came from.

### What stands in for Bee, and what a real integration looks like

`POST /sessions` accepts a raw transcript directly (a text block, or an array of `{speaker, text, timestampMs}`
segments) — standing in for what Bee's MCP server or CLI would hand off after a study session ends. That
normalization is isolated in one function, `normalizeTranscript` in [`src/studyService.ts`](./src/studyService.ts),
which is explicitly documented as the integration seam:

- **Today:** a caller (a script, a curl command, a UI) posts a transcript straight to `POST /sessions`.
- **With real Bee integration:** instead of a human/UI posting a transcript, a small sync job would call Bee's
  transcript-retrieval MCP tool (e.g. a `get_transcript`-style tool for a session or time range) — which already
  returns diarized, timestamped segments in the *same* `{speaker, text, timestampMs}` shape defined in
  [`src/types.ts`](./src/types.ts) — and pass that array straight into `normalizeTranscript`/`ingestSession`. The
  array branch of `normalizeTranscript` **is** the real integration path already; only the string-splitting branch
  (a convenience for pasting raw text by hand, used here so the API is testable without Bee) would become dead code.
- Nothing in `flashcardGenerator.ts`, `scheduler.ts`, `studyService.ts`, or `server.ts` needs to change to wire in
  the real source — they only ever see `TranscriptSegment[]`.

## How it works

1. **Ingest a session** (`POST /sessions`) — post a transcript (string or segments). StudyLoop normalizes it,
   generates a summary and a set of flashcards, and stores them.
2. **Generate flashcards/summary** — [`src/flashcardGenerator.ts`](./src/flashcardGenerator.ts) defines an
   LLM-shaped `FlashcardGenerator` interface and ships `TemplateFlashcardGenerator`, a heuristic implementation with
   no model dependency: it pairs question/answer exchanges, extracts definition-style statements ("X is/means/refers
   to Y"), and falls back to cloze-deletion cards from the longest sentences so a session with neither still yields
   review material.
3. **Schedule review** — each flashcard gets spaced-repetition state (interval, ease factor, repetitions, due date)
   from a simplified SM-2 algorithm in [`src/scheduler.ts`](./src/scheduler.ts), as pure functions.
4. **Review daily** (`GET /review/due`) — the flashcards due today, across every session, oldest-due first.
5. **Submit a grade** (`POST /review/:cardId`) — `again` / `hard` / `good` / `easy`; the scheduler reschedules the
   card's next due date and returns its updated interval/ease factor.

## Project layout

```
src/
  types.ts               TranscriptSegment, StudySession, Flashcard, RecallGrade data model
  store.ts                In-memory session/flashcard storage
  flashcardGenerator.ts    FlashcardGenerator interface (LLM-shaped) + TemplateFlashcardGenerator heuristic impl
  scheduler.ts             Spaced-repetition (simplified SM-2) logic, as pure functions
  studyService.ts          Business logic: transcript ingestion seam, ingest session, list due cards, record review
  server.ts                Express app factory: POST /sessions, GET /sessions/:id, GET /review/due, POST /review/:cardId
  index.ts                 Entry point
test/
  smoke.test.ts            End-to-end test over real HTTP: ingest -> summary/flashcards -> due queue ->
                           good/again review rescheduling -> 404s -> invalid grade -> empty transcript ->
                           raw-text transcript, plus direct scheduler unit checks
```

## Running it

```bash
npm install
npm run build
npm start
# StudyLoop listening on http://localhost:4466
```

Or for local iteration: `npm run dev`

### Try it by hand

```bash
# 1. Ingest a study session transcript (stands in for a Bee ambient capture pull)
curl -X POST localhost:4466/sessions -H "Content-Type: application/json" -d '{
  "title": "Bio 101 study group",
  "transcript": [
    {"speaker": "Alice", "text": "Mitochondria is the powerhouse of the cell."},
    {"speaker": "Bob", "text": "What is the powerhouse of the cell?"},
    {"speaker": "Alice", "text": "The mitochondria is the powerhouse of the cell."}
  ]
}'
# -> note the session id and the generated flashcard ids in the response

# 2. See the session's summary and flashcards again
curl localhost:4466/sessions/<sessionId>

# 3. Check today's review queue (freshly generated cards are due immediately)
curl localhost:4466/review/due

# 4. Submit a recall grade for a card ("again" | "hard" | "good" | "easy")
curl -X POST localhost:4466/review/<cardId> -H "Content-Type: application/json" -d '{"grade": "good"}'
# -> the response shows the new interval/dueAt; review again with "again" to see it drop back down
```

## Testing

```bash
npm test
```

Starts the server on an ephemeral port and drives it over real HTTP requests: ingesting a transcript produces a
non-empty summary and at least one flashcard; a fresh card appears in `GET /review/due`; a `good` grade grows its
interval and moves it out of today's queue; consecutive `good` grades keep growing the interval; an `again` grade
resets the streak and shortens the interval back down instead of continuing to grow it; reviewing an unknown card
id or fetching an unknown session id returns a clean 404; an invalid grade returns a 400; an empty/whitespace-only
transcript still returns a sensible response (a fallback summary, zero flashcards) instead of crashing; and a raw
text-block transcript (not pre-segmented) is ingested successfully too. A couple of direct unit-style checks of
`scheduler.ts`'s interval/ease-factor math round it out.

## Swapping in a real LLM-backed generator

Everything in `server.ts` and `studyService.ts` depends only on the `FlashcardGenerator` interface in
`flashcardGenerator.ts` (`generate(segments) -> {summary, flashcards}`), not on `TemplateFlashcardGenerator`
specifically. To go from heuristic to model-backed:

1. Implement `FlashcardGenerator` with a class that sends the segments to a model — e.g. Amazon Bedrock (natural
   pairing with the hackathon's AWS Builder mini-challenge) — with a prompt like "extract key facts and Q&A pairs
   from this study session transcript and return JSON `{summary, flashcards: [{front, back}]}`", then parses and
   validates the model's JSON response into that same shape.
2. Swap the generator instance constructed in `src/index.ts` (and in tests, if desired) from
   `new TemplateFlashcardGenerator()` to `new LlmFlashcardGenerator(bedrockClient)`.

No change to `studyService.ts`, `scheduler.ts`, or `server.ts` is needed — that's the point of isolating generation
behind an interface from the start.

## Judging-criteria alignment

- **Tech Implementation:** The three real seams a production build would need — Bee transcript ingestion,
  LLM-backed generation, and spaced-repetition scheduling — are each isolated behind a small interface
  (`normalizeTranscript`'s segment shape, `FlashcardGenerator`, and pure functions in `scheduler.ts`), so swapping
  the heuristic generator for Bedrock or wiring in Bee's real MCP tool is a scoped, single-file change, not a
  rewrite. The scheduler itself implements real SM-2 mechanics (interval growth, ease factor, repetition streak
  reset on failure), not a placeholder.
- **Design:** Zero manual note-taking — a transcript in, a summary and review-ready flashcards out. The daily
  review surface (`GET /review/due`) is a single endpoint by design, matching the idea's "clean daily review flow"
  goal; a companion app would render it directly with no extra aggregation logic needed.
- **Potential Impact:** Directly hits "education," one of the Bee track's three explicitly prioritized categories,
  with an everyday, recurring use case (students studying together, or half-remembering a lecture) rather than a
  one-off demo scenario.
- **Quality of Idea:** Goes beyond a transcript viewer or generic summarizer by closing the loop into an active
  learning system — extraction feeding a real scheduling algorithm that adapts to how well material was recalled,
  which is what makes it a study *coach* rather than a note-taking tool.

## Friction log

See [`FRICTION_LOG.md`](./FRICTION_LOG.md) for notes captured while building this (eligible for the hackathon's
optional friction-log bonus).
