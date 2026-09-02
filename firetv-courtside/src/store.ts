import type { CommentaryLine, GameState } from "./types.js";

const MAX_RECENT_EVENTS = 15;

const games = new Map<string, GameState>();
const commentaryByGame = new Map<string, CommentaryLine[]>(); // newest first

export function saveGame(game: GameState): void {
  games.set(game.id, game);
}

export function getGame(id: string): GameState | undefined {
  return games.get(id);
}

export function listGames(): GameState[] {
  return [...games.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Pushes an event onto a game's recent-events log, newest first, capped in length. */
export function pushRecentEvent(game: GameState, event: GameState["recentEvents"][number]): void {
  game.recentEvents.unshift(event);
  if (game.recentEvents.length > MAX_RECENT_EVENTS) {
    game.recentEvents.length = MAX_RECENT_EVENTS;
  }
}

export function addCommentary(gameId: string, line: CommentaryLine): void {
  const existing = commentaryByGame.get(gameId) ?? [];
  existing.unshift(line); // newest first
  commentaryByGame.set(gameId, existing);
}

export function listCommentary(gameId: string): CommentaryLine[] {
  return commentaryByGame.get(gameId) ?? [];
}
