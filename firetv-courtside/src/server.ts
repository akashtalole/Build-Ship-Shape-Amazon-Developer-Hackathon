import express, { type Express } from "express";
import type { CommentaryProvider } from "./commentaryProvider.js";
import { askQuestion, getCommentary, ingestEvent, requireGame, startGame, NotFoundError, ValidationError } from "./gameService.js";

/**
 * Builds the CourtSide Express app. Kept as a factory (rather than a
 * module-level app) so tests get a fresh app — and a fresh commentary
 * provider — per run instead of sharing state across test cases.
 */
export function createApp(provider: CommentaryProvider): Express {
  const app = express();
  app.use(express.json());

  // A Fire TV overlay's CV/data-feed integration point: whatever detects
  // plays (computer vision on the broadcast, or a paired play-by-play API)
  // POSTs events here.
  app.post("/games/:id/events", async (req, res) => {
    try {
      const result = await ingestEvent(req.params.id, req.body ?? {}, provider);
      res.status(201).json({
        event: result.event,
        commentary: result.commentary,
        state: result.game,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post("/games", (req, res) => {
    try {
      const { sport, homeTeam, awayTeam, periodLabel, initialClock } = req.body ?? {};
      const game = startGame({ sport, homeTeam, awayTeam, periodLabel, initialClock });
      res.status(201).json(game);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/games/:id/state", (req, res) => {
    try {
      const game = requireGame(req.params.id);
      res.json(game);
    } catch (err) {
      handleError(res, err);
    }
  });

  // What a Fire TV overlay polls to render/speak new commentary lines.
  app.get("/games/:id/commentary", (req, res) => {
    try {
      res.json(getCommentary(req.params.id));
    } catch (err) {
      handleError(res, err);
    }
  });

  // On-demand viewer Q&A ("what's the score?", "why was that a foul?"),
  // triggered by remote/voice input on the Fire TV overlay.
  app.post("/games/:id/ask", async (req, res) => {
    try {
      const { question } = req.body ?? {};
      const result = await askQuestion(req.params.id, question, provider);
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}

function handleError(res: express.Response, err: unknown): void {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
}
