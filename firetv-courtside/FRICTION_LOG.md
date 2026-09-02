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

## Feature requests

- A minimal, published schema for a "generic play-by-play event" (type, team/player, timestamp, description) that
  Fire TV sports hackathon entries could standardize against, so a CV pipeline built by one team and a commentary
  backend built by another could interoperate without both re-inventing the same event shape.
- A lightweight Fire OS/Vega overlay starter sample specifically for "poll an HTTP endpoint and render/speak
  incoming text lines without blocking video" would have made the frontend integration point in this README more
  concrete to describe precisely.
