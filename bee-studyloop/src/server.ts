import express, { type Express } from "express";
import type { FlashcardGenerator } from "./flashcardGenerator.js";
import type { RecallGrade } from "./types.js";
import {
  appendSessionSegments,
  exportAllFlashcards,
  exportSessionFlashcards,
  getSessionWithCards,
  ingestSession,
  listDueCards,
  listLeechCards,
  recordReview,
  searchFlashcardsByTopic,
} from "./studyService.js";

const VALID_GRADES: RecallGrade[] = ["again", "hard", "good", "easy"];

function isRecallGrade(value: unknown): value is RecallGrade {
  return typeof value === "string" && (VALID_GRADES as string[]).includes(value);
}

/**
 * Builds the StudyLoop Express app. Kept as a factory (rather than a
 * module-level app) so tests — and any future swap to a real LLM-backed
 * generator — can wire in a fresh `FlashcardGenerator` and empty in-memory
 * store per run instead of sharing state across test cases.
 */
export function createApp(generator: FlashcardGenerator): Express {
  const app = express();
  app.use(express.json());

  // Ingest a study session's transcript. In production the caller here would
  // be a small sync job pulling segments from Bee's MCP server/CLI rather
  // than a human-triggered POST — see README "Wiring in Bee for real".
  //
  // Accepts an optional `idempotencyKey` (or `externalSessionId`, treated as
  // an alias) so a retried upload — a flaky network, an at-least-once queue,
  // a doubled tap on "sync now" — returns the original session/flashcards
  // instead of generating duplicate study material.
  app.post("/sessions", async (req, res) => {
    const { title, transcript, idempotencyKey, externalSessionId } = req.body ?? {};
    if (transcript === undefined || transcript === null) {
      res.status(400).json({ error: "transcript is required (a string, or an array of {speaker, text, timestampMs} segments)." });
      return;
    }
    if (typeof transcript !== "string" && !Array.isArray(transcript)) {
      res.status(400).json({ error: "transcript must be a string or an array of segments." });
      return;
    }

    const key = typeof idempotencyKey === "string" && idempotencyKey.trim()
      ? idempotencyKey.trim()
      : typeof externalSessionId === "string" && externalSessionId.trim()
        ? externalSessionId.trim()
        : undefined;

    const result = await ingestSession(generator, { title, transcript, idempotencyKey: key });
    res.status(201).json(result);
  });

  app.get("/sessions/:id", (req, res) => {
    const result = getSessionWithCards(req.params.id);
    if (!result) {
      res.status(404).json({ error: "No study session with that ID." });
      return;
    }
    res.json(result);
  });

  // Streaming/incremental ingestion: append newly-captured transcript
  // segments to an already-ingested session (mirroring Bee's continuous
  // ambient capture rather than one big batch upload after the fact).
  // Generates flashcards only from the newly-appended material and updates
  // the session summary/topics to reflect the fuller transcript.
  app.patch("/sessions/:id/segments", async (req, res) => {
    const { segments } = req.body ?? {};
    if (segments === undefined || segments === null) {
      res.status(400).json({ error: "segments is required (a string, or an array of {speaker, text, timestampMs} segments)." });
      return;
    }
    if (typeof segments !== "string" && !Array.isArray(segments)) {
      res.status(400).json({ error: "segments must be a string or an array of segments." });
      return;
    }

    const result = await appendSessionSegments(generator, req.params.id, { segments });
    if (!result) {
      res.status(404).json({ error: "No study session with that ID." });
      return;
    }
    res.status(200).json(result);
  });

  // Portable export: every flashcard in one session as a flat TSV
  // (front/back/tags), suitable for import into a real spaced-repetition
  // tool like Anki. See export.ts for the exact format.
  app.get("/sessions/:id/export", (req, res) => {
    const tsv = exportSessionFlashcards(req.params.id);
    if (tsv === undefined) {
      res.status(404).json({ error: "No study session with that ID." });
      return;
    }
    res.type("text/tab-separated-values").send(tsv);
  });

  // Portable export across every session.
  app.get("/export", (_req, res) => {
    res.type("text/tab-separated-values").send(exportAllFlashcards());
  });

  // Flashcards whose heuristic topic tags match `topic`, across every
  // session — lets a student find related material even across separate
  // study sessions.
  app.get("/flashcards/search", (req, res) => {
    const topic = req.query.topic;
    if (typeof topic !== "string" || !topic.trim()) {
      res.status(400).json({ error: "topic query parameter is required, e.g. /flashcards/search?topic=mitochondria" });
      return;
    }
    res.json(searchFlashcardsByTopic(topic));
  });

  // Flashcards due for review today, across every session — ordered by
  // adaptive priority (overdue-ness, leech status, ease factor). See
  // priority.ts for the exact formula.
  app.get("/review/due", (_req, res) => {
    res.json(listDueCards());
  });

  // Cards flagged as leeches (repeated consecutive failures) — surfaced
  // distinctly so a student can reformulate them instead of endlessly
  // rescheduling.
  app.get("/review/leeches", (_req, res) => {
    res.json(listLeechCards());
  });

  app.post("/review/:cardId", (req, res) => {
    const { grade } = req.body ?? {};
    if (!isRecallGrade(grade)) {
      res.status(400).json({ error: `grade must be one of: ${VALID_GRADES.join(", ")}` });
      return;
    }

    const updated = recordReview(req.params.cardId, grade);
    if (!updated) {
      res.status(404).json({ error: "No flashcard with that ID." });
      return;
    }
    res.json(updated);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
