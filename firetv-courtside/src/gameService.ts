import { randomUUID } from "node:crypto";
import type { CommentaryProvider } from "./commentaryProvider.js";
import { addCommentary, getGame, listCommentary, pushRecentEvent, saveGame } from "./store.js";
import {
  VALID_EVENT_TYPES,
  type AskQuestionResult,
  type CommentaryLine,
  type GameEvent,
  type GameState,
  type IncomingGameEvent,
  type StartGameInput,
} from "./types.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export function startGame(input: StartGameInput): GameState {
  if (!input?.homeTeam?.trim() || !input?.awayTeam?.trim()) {
    throw new ValidationError("homeTeam and awayTeam are required.");
  }
  const now = new Date().toISOString();
  const game: GameState = {
    id: randomUUID(),
    sport: input.sport?.trim() || "basketball",
    homeTeam: input.homeTeam.trim(),
    awayTeam: input.awayTeam.trim(),
    homeScore: 0,
    awayScore: 0,
    period: 1,
    periodLabel: input.periodLabel?.trim() || "quarter",
    clock: input.initialClock?.trim() || "12:00",
    status: "in_progress",
    recentEvents: [],
    createdAt: now,
    updatedAt: now,
  };
  saveGame(game);
  return game;
}

export function requireGame(gameId: string): GameState {
  const game = getGame(gameId);
  if (!game) {
    throw new NotFoundError(`No game with id "${gameId}".`);
  }
  return game;
}

function isValidEventType(type: unknown): type is IncomingGameEvent["type"] {
  return typeof type === "string" && (VALID_EVENT_TYPES as readonly string[]).includes(type);
}

function applyEventToState(game: GameState, event: GameEvent): void {
  if (event.type === "score") {
    if (event.team === "home") game.homeScore += event.points ?? 0;
    else if (event.team === "away") game.awayScore += event.points ?? 0;
  }
  if (event.type === "period_end") {
    game.period = (event.period ?? game.period) + 1;
  } else if (typeof event.period === "number") {
    game.period = event.period;
  }
  if (typeof event.clock === "string" && event.clock.length > 0) {
    game.clock = event.clock;
  }
  if (event.type === "game_end") {
    game.status = "final";
  }
  game.updatedAt = event.occurredAt;
}

export interface IngestResult {
  game: GameState;
  event: GameEvent;
  commentary: CommentaryLine;
}

export async function ingestEvent(
  gameId: string,
  incoming: IncomingGameEvent,
  provider: CommentaryProvider
): Promise<IngestResult> {
  const game = requireGame(gameId);

  if (!isValidEventType(incoming?.type)) {
    throw new ValidationError(
      `Invalid or missing event type. Must be one of: ${VALID_EVENT_TYPES.join(", ")}.`
    );
  }
  if (incoming.type === "score" && (typeof incoming.points !== "number" || incoming.points <= 0)) {
    throw new ValidationError('"score" events require a positive numeric "points" field.');
  }
  if ((incoming.type === "score" || incoming.type === "foul" || incoming.type === "turnover") && !incoming.team && !incoming.player) {
    throw new ValidationError(`"${incoming.type}" events require a "team" or "player" field.`);
  }

  const event: GameEvent = {
    ...incoming,
    id: randomUUID(),
    gameId,
    occurredAt: new Date().toISOString(),
  };

  applyEventToState(game, event);
  pushRecentEvent(game, event);
  saveGame(game);

  const text = await provider.narrateEvent(game, event);
  const commentary: CommentaryLine = {
    id: randomUUID(),
    gameId,
    text,
    eventId: event.id,
    createdAt: new Date().toISOString(),
  };
  addCommentary(gameId, commentary);

  return { game, event, commentary };
}

export function getCommentary(gameId: string): CommentaryLine[] {
  requireGame(gameId); // 404s cleanly for an unknown game
  return listCommentary(gameId);
}

export async function askQuestion(
  gameId: string,
  question: string,
  provider: CommentaryProvider
): Promise<AskQuestionResult> {
  const game = requireGame(gameId);
  if (!question?.trim()) {
    throw new ValidationError('A non-empty "question" field is required.');
  }
  const answer = await provider.answerQuestion(game, question.trim());
  return { question: question.trim(), answer, answeredAt: new Date().toISOString() };
}
