import express, { type Express } from "express";
import type { CommentaryProvider } from "./commentaryProvider.js";
import {
  answerPrediction,
  askQuestion,
  createParty,
  getCommentary,
  getFantasyHighlights,
  getGameMetrics,
  getHighlights,
  getPartyInfo,
  getPartyQnAHistory,
  getPlayerStats,
  getPredictionDetail,
  getPreferences,
  getRecap,
  getTeamStats,
  getViewerPredictionAccuracy,
  getWatchlist,
  ingestEvent,
  joinParty,
  listGamePredictions,
  posePrediction,
  requireGame,
  setFantasyRoster,
  setPreferences,
  startGame,
  subscribeToGame,
  NotFoundError,
  ValidationError,
} from "./gameService.js";
import { subscribe, type StreamEvent } from "./pubsub.js";
import { checkRateLimit, ASK_RATE_LIMIT_MAX, ASK_RATE_LIMIT_WINDOW_MS } from "./rateLimiter.js";

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
      // A replayed externalEventId is a clean no-op: 200 (nothing new was
      // created) instead of 201, but otherwise the same successful shape.
      res.status(result.duplicate ? 200 : 201).json({
        event: result.event,
        commentary: result.commentary,
        state: result.game,
        duplicate: result.duplicate ?? false,
        path: result.path,
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
  // `?since=<commentary-id-or-ISO-timestamp>` resumes a feed instead of
  // re-fetching full history (e.g. after the app comes back from the
  // background). `?viewerId=<id>` personalizes the returned text per that
  // viewer's stored preferences.
  // `?locale=<...>` (see `CommentaryLocale`) requests a distinct
  // commentary pack for this read — falling back to the viewer's stored
  // `locale` preference, then the `"en-broadcast"` default. See "Localized
  // commentary packs" in the README.
  app.get("/games/:id/commentary", async (req, res) => {
    try {
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const viewerId = typeof req.query.viewerId === "string" ? req.query.viewerId : undefined;
      const locale = typeof req.query.locale === "string" ? req.query.locale : undefined;
      res.json(await getCommentary(req.params.id, since, viewerId, provider, locale));
    } catch (err) {
      handleError(res, err);
    }
  });

  // Live push companion to the polling endpoint above: an SSE stream that
  // emits `data: {"type":"commentary","commentary":...,"state":...}\n\n`
  // the instant a new event produces commentary, so a connected overlay
  // reacts immediately instead of waiting for its next poll.
  app.get("/games/:id/stream", (req, res) => {
    try {
      requireGame(req.params.id); // 404s cleanly for an unknown game, same as the other read routes
    } catch (err) {
      handleError(res, err);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n"); // comment line: opens the stream immediately, nothing for clients to parse

    const unsubscribe = subscribe(req.params.id, (payload: StreamEvent) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });

    req.on("close", () => {
      unsubscribe();
    });
  });

  // Per-game commentary-generation cost/latency metrics: how many events
  // took the fast template path vs. escalated to the full provider. See
  // `isNotableEvent` in gameService.ts for the routing heuristic.
  app.get("/games/:id/metrics", (req, res) => {
    try {
      const metrics = getGameMetrics(req.params.id);
      res.json({
        gameId: req.params.id,
        fastPathCount: metrics.fastPathCount,
        escalatedCount: metrics.escalatedCount,
        total: metrics.fastPathCount + metrics.escalatedCount,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // Sets a viewer's commentary preferences (favorite team, verbosity),
  // applied at read time by /commentary?viewerId=... and /ask.
  app.post("/games/:id/viewers/:viewerId/preferences", (req, res) => {
    try {
      const preferences = setPreferences(req.params.id, req.params.viewerId, req.body ?? {});
      res.status(200).json({ viewerId: req.params.viewerId, preferences });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/games/:id/viewers/:viewerId/preferences", (req, res) => {
    try {
      const preferences = getPreferences(req.params.id, req.params.viewerId) ?? {};
      res.json({ viewerId: req.params.viewerId, preferences });
    } catch (err) {
      handleError(res, err);
    }
  });

  // On-demand viewer Q&A ("what's the score?", "why was that a foul?"),
  // triggered by remote/voice input on the Fire TV overlay. Rate-limited
  // per (game, viewer) — or per (game, IP) when no viewerId is given — to
  // protect the Q&A path from abuse/spam.
  app.post("/games/:id/ask", async (req, res) => {
    try {
      const { question, viewerId, partyId, locale } = req.body ?? {};
      const rateLimitKey = `${req.params.id}:${viewerId || req.ip}`;
      const rateLimit = checkRateLimit(rateLimitKey);
      if (!rateLimit.allowed) {
        res.status(429).json({
          error: `Too many questions for this game — limit is ${ASK_RATE_LIMIT_MAX} per ${
            ASK_RATE_LIMIT_WINDOW_MS / 1000
          }s. Try again shortly.`,
          retryAfterMs: rateLimit.retryAfterMs,
        });
        return;
      }
      const result = await askQuestion(req.params.id, question, provider, viewerId, { partyId, locale });
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Shareable recap of a game's notable moments (see `isNotableEvent` in
  // gameService.ts) — works for a game that's still in progress
  // (highlights-so-far) or one that has already received a `game_end` event.
  app.get("/games/:id/highlights", (req, res) => {
    try {
      res.json(getHighlights(req.params.id));
    } catch (err) {
      handleError(res, err);
    }
  });

  // Registers a webhook to receive a signed POST whenever a notable event
  // happens in this game. Idempotent on (gameId, callbackUrl) — see
  // `subscribeToGame`. 201 for a new registration, 200 (`duplicate: true`)
  // when the same callback was already registered for this game.
  app.post("/games/:id/subscriptions", (req, res) => {
    try {
      const { subscription, created } = subscribeToGame(req.params.id, req.body ?? {});
      res.status(created ? 201 : 200).json({ subscription, duplicate: !created });
    } catch (err) {
      handleError(res, err);
    }
  });

  // Cross-game "what did I miss?" view: notable events across every game a
  // viewer has interacted with (asked a question on, or set preferences
  // for), newest first regardless of which game they happened in.
  app.get("/watchlist", (req, res) => {
    try {
      const viewerId = typeof req.query.viewerId === "string" ? req.query.viewerId : "";
      res.json(getWatchlist(viewerId));
    } catch (err) {
      handleError(res, err);
    }
  });

  // Season-long cumulative stats for a team or player, aggregated across
  // every game this process has ingested events for — not just one game.
  // Zeroed (not a 404) for a name that's never appeared in an event, since
  // there's no separate "team"/"player" resource that could be missing.
  app.get("/stats/team/:teamName", (req, res) => {
    try {
      res.json(getTeamStats(req.params.teamName));
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/stats/player/:playerName", (req, res) => {
    try {
      res.json(getPlayerStats(req.params.playerName));
    } catch (err) {
      handleError(res, err);
    }
  });

  // "Catch-up" recap: a natural-language summary (via the same
  // CommentaryProvider used for narration/Q&A) of everything that happened
  // in a window, rather than the raw commentary lines `GET .../commentary`
  // returns. `?sinceMinutes=<n>` recaps a rolling time window; `?since=<id
  // or timestamp>` recaps everything after that cursor, same style as
  // `GET /games/:id/commentary?since=`. Neither given recaps the whole game.
  app.get("/games/:id/recap", async (req, res) => {
    try {
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      let sinceMinutes: number | undefined;
      if (typeof req.query.sinceMinutes === "string") {
        const parsed = Number(req.query.sinceMinutes);
        if (Number.isNaN(parsed)) {
          res.status(400).json({ error: '"sinceMinutes" must be a number.' });
          return;
        }
        sinceMinutes = parsed;
      }
      const locale = typeof req.query.locale === "string" ? req.query.locale : undefined;
      const result = await getRecap(req.params.id, { sinceMinutes, since }, provider, locale);
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // --- Round 5: fantasy-relevant plays, live predictions, watch parties -----

  // Registers (replacing wholesale) a viewer's fantasy roster for this game —
  // a small list of player names. Immediately backfills highlights from
  // events already ingested, then tags new matching plays live as they come
  // in via `ingestEvent`.
  app.post("/games/:id/fantasy/:viewerId", (req, res) => {
    try {
      const result = setFantasyRoster(req.params.id, req.params.viewerId, req.body ?? {});
      res.status(200).json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // A viewer's fantasy-relevant plays for this game — a separate lens on the
  // same event stream from the shared commentary feed.
  app.get("/games/:id/fantasy/:viewerId", (req, res) => {
    try {
      res.json(getFantasyHighlights(req.params.id, req.params.viewerId));
    } catch (err) {
      handleError(res, err);
    }
  });

  // Poses a new live prediction tied to the game's real event stream. Body:
  // `{ "type"?: "next_possession_score" | "next_team_to_score" }` (defaults
  // to "next_possession_score").
  app.post("/games/:id/predictions", (req, res) => {
    try {
      const prediction = posePrediction(req.params.id, req.body ?? {});
      res.status(201).json(prediction);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/games/:id/predictions", (req, res) => {
    try {
      res.json(listGamePredictions(req.params.id));
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/games/:id/predictions/:predictionId", (req, res) => {
    try {
      res.json(getPredictionDetail(req.params.id, req.params.predictionId));
    } catch (err) {
      handleError(res, err);
    }
  });

  // Submits a viewer's answer before the outcome is known. Body:
  // `{ "viewerId": "...", "answer": "yes" | "no" | "home" | "away" }`
  // (whichever pair the prediction's `options` are).
  app.post("/games/:id/predictions/:predictionId/answer", (req, res) => {
    try {
      const answer = answerPrediction(req.params.id, req.params.predictionId, req.body ?? {});
      res.status(201).json(answer);
    } catch (err) {
      handleError(res, err);
    }
  });

  // A viewer's running prediction accuracy, across every game they've
  // answered predictions in.
  app.get("/viewers/:viewerId/predictions/accuracy", (req, res) => {
    try {
      res.json(getViewerPredictionAccuracy(req.params.viewerId));
    } catch (err) {
      handleError(res, err);
    }
  });

  // Creates (or, idempotently, returns) a named watch-party session for this
  // game, optionally joining `viewerId` to it in the same call.
  app.post("/games/:id/parties", (req, res) => {
    try {
      const { party, created } = createParty(req.params.id, req.body ?? {});
      res.status(created ? 201 : 200).json({ party, duplicate: !created });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post("/games/:id/parties/:partyId/join", (req, res) => {
    try {
      const { viewerId } = req.body ?? {};
      const party = joinParty(req.params.id, req.params.partyId, viewerId);
      res.status(200).json(party);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/games/:id/parties/:partyId", (req, res) => {
    try {
      res.json(getPartyInfo(req.params.id, req.params.partyId));
    } catch (err) {
      handleError(res, err);
    }
  });

  // The durable history of every question+answer shared into this party so
  // far (the same records also pushed live over `GET /games/:id/stream`,
  // tagged `type: "party_qa"`, the instant they're asked).
  app.get("/games/:id/parties/:partyId/qa", (req, res) => {
    try {
      res.json(getPartyQnAHistory(req.params.id, req.params.partyId));
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
