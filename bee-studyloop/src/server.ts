import express, { type Express } from "express";
import type { FlashcardGenerator } from "./flashcardGenerator.js";
import type { RecallGrade } from "./types.js";
import { getSessionWithCards, ingestSession, listDueCards, recordReview } from "./studyService.js";

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
  app.post("/sessions", async (req, res) => {
    const { title, transcript } = req.body ?? {};
    if (transcript === undefined || transcript === null) {
      res.status(400).json({ error: "transcript is required (a string, or an array of {speaker, text, timestampMs} segments)." });
      return;
    }
    if (typeof transcript !== "string" && !Array.isArray(transcript)) {
      res.status(400).json({ error: "transcript must be a string or an array of segments." });
      return;
    }

    const result = await ingestSession(generator, { title, transcript });
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

  // Flashcards due for review today, across every session — the "daily
  // review" surface a companion app would render.
  app.get("/review/due", (_req, res) => {
    res.json(listDueCards());
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
