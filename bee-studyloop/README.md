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

A second pass added six more production-grade pieces on top of that pipeline — idempotent retries, leech
detection, topic tagging + search, adaptive review ordering, incremental/streaming ingestion, and a portable
export — each described in detail in **Advanced features** below.

## Project layout

```
src/
  types.ts               TranscriptSegment, StudySession, Flashcard, RecallGrade data model
  store.ts                In-memory session/flashcard storage, plus the idempotency-key index
  flashcardGenerator.ts    FlashcardGenerator interface (LLM-shaped) + TemplateFlashcardGenerator heuristic impl
  scheduler.ts             Spaced-repetition (simplified SM-2) logic, as pure functions
  leech.ts                 Leech-detection state machine (consecutive-failure tracking), as pure functions
  priority.ts              Adaptive review-ordering priority-score formula, as a pure function
  topics.ts                Heuristic topic-tag extraction (word-frequency, not real NLP)
  export.ts                Portable TSV export formatting (Anki-importable)
  studyService.ts          Business logic: ingestion (incl. idempotent + incremental), due/leech/search
                           queries, record review
  server.ts                Express app factory — see "How it works" and "Advanced features" for the full
                           route list
  index.ts                 Entry point
test/
  smoke.test.ts            End-to-end test over real HTTP covering the base lifecycle (ingest -> summary/
                           flashcards -> due queue -> good/again review rescheduling -> 404s -> invalid
                           grade -> empty transcript -> raw-text transcript) plus every feature in
                           "Advanced features" below, and direct unit checks of scheduler.ts, leech.ts,
                           priority.ts, and topics.ts
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
`scheduler.ts`'s interval/ease-factor math round it out. Every feature in **Advanced features** below has its own
passing HTTP-level check plus, where the logic is pure, a direct unit-style check — see the "Advanced features"
tests in `test/smoke.test.ts`.

## Advanced features

A second implementation pass added six production-grade features on top of the v1 pipeline above. Each is
independently tested in `test/smoke.test.ts` (search for "Feature 1" through "Feature 6").

### 1. Idempotent session ingestion

`POST /sessions` accepts an optional `idempotencyKey` (or `externalSessionId`, treated as an alias — pass whichever
you have). Re-posting the same transcript with the same key returns the *original* session and flashcards —
same ids, no regeneration — instead of creating a duplicate study set. This is what makes a retried upload (a
flaky connection, an at-least-once sync queue, a doubled tap on "sync now" in a companion app) safe to replay.
The mapping from key -> session id lives in `store.ts`; `studyService.ingestSession` checks it before doing any
generation work at all.

```bash
curl -X POST localhost:4466/sessions -H "Content-Type: application/json" -d '{
  "title": "Bio 101 study group",
  "idempotencyKey": "sync-job-run-482",
  "transcript": "Osmosis is the movement of water across a semipermeable membrane."
}'
# Re-run the exact same request (same idempotencyKey) any number of times —
# the response always has the same session.id and flashcard ids, never a duplicate.
```

### 2. Leech detection

Every flashcard tracks `consecutiveFailures` (consecutive "again" grades) and `isLeech` (true once that streak
hits `LEECH_THRESHOLD`, currently 3 — see `leech.ts`). A single subsequent "good" or "easy" grade clears the flag
and resets the streak; a "hard" grade neither advances nor resets it (it's a lukewarm pass, not a failure). Leeches
are surfaced on their own endpoint, `GET /review/leeches`, distinct from the general due queue, so a student can
see which cards need to be *reformulated* rather than endlessly rescheduled — SM-2's core blind spot.

```bash
# Grade the same card "again" three times in a row...
curl -X POST localhost:4466/review/<cardId> -H "Content-Type: application/json" -d '{"grade": "again"}'
curl -X POST localhost:4466/review/<cardId> -H "Content-Type: application/json" -d '{"grade": "again"}'
curl -X POST localhost:4466/review/<cardId> -H "Content-Type: application/json" -d '{"grade": "again"}'
# -> the response now has "isLeech": true, "consecutiveFailures": 3

curl localhost:4466/review/leeches
# -> a list of every currently-flagged leech, across every session

curl -X POST localhost:4466/review/<cardId> -H "Content-Type: application/json" -d '{"grade": "good"}'
# -> "isLeech": false, "consecutiveFailures": 0 — one solid recall clears it
```

### 3. Topic tagging + search

When a session is ingested (or extended — see Feature 5), `topics.ts` extracts 1-3 heuristic topic tags from the
full transcript and attaches them to every flashcard generated at that point. **This is explicitly a heuristic,
not real NLP or topic modeling**: it scores each content word (length >= 4, not a stopword) by raw frequency, with
a small bonus for words that appeared capitalized in the original text (a cheap proxy for proper nouns/key terms),
and returns the top-scoring 1-3 as lowercase tags. It reliably picks out the term a session was *about* ("ribosome,"
"mitochondria") when that term is repeated, and does nothing cleverer than that. `GET /flashcards/search?topic=`
then finds every flashcard across *every* session carrying a given tag, so a student can pull together material on
the same topic even when it came from separate study sessions weeks apart.

```bash
curl "localhost:4466/flashcards/search?topic=ribosome"
# -> every flashcard, from any session, whose extracted topics include "ribosome"
```

### 4. Adaptive review ordering

`GET /review/due` no longer returns cards in plain due-date order — it ranks them by a priority score (see
`priority.ts`, doc-commented in full there):

```
score = overdueDays * OVERDUE_WEIGHT           (OVERDUE_WEIGHT = 1)
      + (isLeech ? LEECH_BONUS : 0)            (LEECH_BONUS   = 10)
      + max(0, BASELINE_EASE - easeFactor)      (BASELINE_EASE = 2.5)
        * EASE_WEIGHT                           (EASE_WEIGHT   = 2)
```

`overdueDays` rewards cards that have been put off longer; the leech bonus is a large flat addition (worth ~10
days of plain overdue-ness) so a leech surfaces near the top of the queue almost regardless of its due date,
because the whole point of leech-flagging is forcing it in front of the student instead of letting it get quietly
rescheduled forever; the ease term gives a smaller boost to cards that have historically been hard to recall
(a below-baseline SM-2 ease factor), since that's a real but softer signal than 3-in-a-row failures. Cards that
aren't due yet are still filtered out first — this only reorders the pool that's already eligible today.

```bash
curl localhost:4466/review/due
# -> due cards sorted by priority score descending: a leech, or a badly overdue/hard card, first
```

### 5. Streaming/incremental ingestion

`PATCH /sessions/:id/segments` appends newly-captured transcript segments to an already-ingested session — the
same shape `POST /sessions` accepts (a string, or an array of `{speaker, text, timestampMs}` segments) — mirroring
Bee's continuous ambient capture (many small updates over the course of a session) rather than one big batch
upload after the fact. It regenerates the session's summary and topic tags from the *full* updated transcript, but
only persists flashcards that weren't already generated for this session (deduped by front text), so re-running
the generator over the combined transcript doesn't re-mint duplicates for material it already produced a card
from earlier.

```bash
curl -X PATCH localhost:4466/sessions/<sessionId>/segments -H "Content-Type: application/json" -d '{
  "segments": [
    {"speaker": "Alice", "text": "Active transport moves molecules against a concentration gradient using energy."},
    {"speaker": "Bob", "text": "What is active transport?"},
    {"speaker": "Alice", "text": "It requires ATP to move against the gradient."}
  ]
}'
# -> { "session": { ...updated summary/segments/topics... }, "newFlashcards": [ ...only the new cards... ] }
```

### 6. Portable export

`GET /sessions/:id/export` (one session) and `GET /export` (every session) return every flashcard as a flat TSV —
tab-separated rather than comma-separated because flashcard text routinely contains commas, which would otherwise
need quoting. Three columns, with a header row: `front`, `back`, `tags` (space-separated, matching Anki's own
multi-value tag convention).

```bash
curl localhost:4466/sessions/<sessionId>/export
# front	back	tags
# What is a ribosome?	Ribosome function is essential for protein synthesis.	ribosome protein
# ...
```

To import into Anki: **File -> Import**, set "Fields separated by" to **Tab**, map column 1 -> Front, column 2 ->
Back, column 3 -> Tags, and tell it to skip the header line.

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
  reset on failure), not a placeholder. The advanced round adds real production concerns on top: idempotent
  ingestion (safe retries), a leech-detection state machine, a documented multi-signal priority formula for review
  ordering, incremental ingestion that dedupes against already-generated material, and a portable export format —
  each isolated in its own small module (`leech.ts`, `priority.ts`, `topics.ts`, `export.ts`) and covered by its
  own passing test, not bolted on as a demo-only stub.
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
