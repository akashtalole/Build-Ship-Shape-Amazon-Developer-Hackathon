import type { EventType, GameEvent, GameState } from "./types.js";

/**
 * The seam between CourtSide's game logic and whatever actually generates
 * commentary text. Shaped the way a Bedrock (or any hosted LLM) call looks —
 * a system persona, an instruction for what to do right now, and serialized
 * context — so a real provider only needs to forward this straight into a
 * `bedrock-runtime` `InvokeModel`/`Converse` call. See "Swapping in a real
 * Bedrock provider" in the README for exactly what that involves.
 *
 * `data` carries the same information as `context`, but structured, so a
 * template-based fallback (no LLM available) can generate reasonable
 * commentary from the raw event/game data without having to parse it back
 * out of a prose string. A real LLM-backed provider ignores `data` entirely
 * and answers purely from `system` + `instruction` + `context`.
 */
export interface CommentaryPrompt {
  /** Persona / standing instructions, analogous to a Bedrock system prompt. */
  system: string;
  /** What to do right now, e.g. "Narrate this play in one enthusiastic sentence." */
  instruction: string;
  /** Serialized game context an LLM would read (score, period, recent plays). */
  context: string;
  /** Structured data backing this request, for non-LLM fallbacks. */
  data: EventCommentaryData | QuestionAnswerData;
}

export interface EventCommentaryData {
  kind: "event";
  event: GameEvent;
  game: GameState;
}

export interface QuestionAnswerData {
  kind: "question";
  question: string;
  game: GameState;
}

/**
 * The commentary-generation interface. A Fire TV overlay never talks to this
 * directly — `gameService.ts` calls it to turn a raw event or a viewer
 * question into a line of text to display/speak.
 */
export interface CommentaryProvider {
  /** Generates a natural-language line of commentary for a single game event. */
  narrateEvent(game: GameState, event: GameEvent): Promise<string>;
  /** Answers an on-demand viewer question, grounded in current game state. */
  answerQuestion(game: GameState, question: string): Promise<string>;
}

const SYSTEM_PERSONA =
  "You are CourtSide, an upbeat but concise AI sports co-commentator overlaid on a live broadcast. " +
  "Keep responses to one or two sentences so they fit an on-screen overlay without blocking the action.";

/**
 * Template-based fallback implementation. Produces reasonable, varied
 * commentary directly from structured event/game data with no external LLM
 * call — this is what CourtSide runs with out of the box, and what keeps the
 * service fully demoable and testable without AWS credentials. Swap in a
 * real Bedrock-backed provider (see README) without touching any of
 * `gameService.ts` or `server.ts`, since both only depend on this interface.
 */
export class TemplateCommentaryProvider implements CommentaryProvider {
  async narrateEvent(game: GameState, event: GameEvent): Promise<string> {
    const prompt = buildEventPrompt(game, event);
    return templateNarrateEvent(prompt.data as EventCommentaryData);
  }

  async answerQuestion(game: GameState, question: string): Promise<string> {
    const prompt = buildQuestionPrompt(game, question);
    return templateAnswerQuestion(prompt.data as QuestionAnswerData);
  }
}

/** Builds the Bedrock-shaped prompt for a single event. Exported so a real provider's tests can reuse it. */
export function buildEventPrompt(game: GameState, event: GameEvent): CommentaryPrompt {
  return {
    system: SYSTEM_PERSONA,
    instruction: "Narrate this single play for a viewer who may not know the sport well. One or two sentences.",
    context: serializeGameContext(game, event),
    data: { kind: "event", event, game },
  };
}

/** Builds the Bedrock-shaped prompt for a viewer question. Exported so a real provider's tests can reuse it. */
export function buildQuestionPrompt(game: GameState, question: string): CommentaryPrompt {
  return {
    system: SYSTEM_PERSONA,
    instruction: `Answer the viewer's question using only the game context below. Question: "${question}"`,
    context: serializeGameContext(game),
    data: { kind: "question", question, game },
  };
}

function serializeGameContext(game: GameState, highlightEvent?: GameEvent): string {
  const lines = [
    `${game.homeTeam} ${game.homeScore} - ${game.awayScore} ${game.awayTeam}`,
    `${capitalize(game.periodLabel)} ${game.period}, ${game.clock} remaining, status: ${game.status}`,
    "Recent plays:",
    ...game.recentEvents.slice(0, 5).map((e) => `- ${describeEvent(e)}`),
  ];
  if (highlightEvent) {
    lines.push(`Focus on this play: ${describeEvent(highlightEvent)}`);
  }
  return lines.join("\n");
}

function describeEvent(event: GameEvent): string {
  const who = event.player ?? event.team ?? "unknown";
  return `[${event.type}] ${who}${event.points ? ` +${event.points}` : ""}${
    event.description ? ` — ${event.description}` : ""
  }`;
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// --- Template generation, keyed off structured data --------------------

/** Deterministic pseudo-random pick so the same event always narrates the same way (useful for tests, harmless in practice). */
function pick<T>(options: readonly T[], seed: string): T {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return options[hash % options.length];
}

function teamName(game: GameState, team?: "home" | "away"): string | undefined {
  if (team === "home") return game.homeTeam;
  if (team === "away") return game.awayTeam;
  return undefined;
}

function scoreLine(game: GameState): string {
  return `${game.homeTeam} ${game.homeScore} - ${game.awayScore} ${game.awayTeam}`;
}

function templateNarrateEvent(data: EventCommentaryData): string {
  const { event, game } = data;
  const who = event.player ?? teamName(game, event.team) ?? "The team";
  const seed = event.id;

  const templates: Record<EventType, () => string> = {
    score: () =>
      pick(
        [
          `${who} scores${event.points ? ` (+${event.points})` : ""}! ${scoreLine(game)}.`,
          `Bucket for ${who}! ${scoreLine(game)}.`,
          `${who} finds the basket${event.points ? ` for ${event.points}` : ""}. Now ${scoreLine(game)}.`,
        ],
        seed
      ),
    foul: () =>
      pick(
        [
          `Foul called on ${who}${event.description ? `: ${event.description}` : ""}.`,
          `${who} picks up a foul${event.description ? ` — ${event.description}` : ""}.`,
        ],
        seed
      ),
    turnover: () =>
      pick(
        [
          `Turnover, ${who}${event.description ? ` — ${event.description}` : ""}.`,
          `${who} loses possession${event.description ? ` (${event.description})` : ""}.`,
        ],
        seed
      ),
    rebound: () => pick([`${who} grabs the rebound.`, `${who} cleans up the boards.`], seed),
    steal: () => pick([`${who} comes up with the steal!`, `Great hands by ${who} for the steal!`], seed),
    block: () => pick([`${who} rejects the shot!`, `Denied! ${who} with the block.`], seed),
    timeout: () => `${who} calls a timeout.`,
    period_end: () =>
      `End of ${game.periodLabel} ${event.period ?? game.period}. ${scoreLine(game)}.`,
    game_end: () => `That's the final! ${scoreLine(game)}.`,
  };

  return templates[event.type]();
}

function templateAnswerQuestion(data: QuestionAnswerData): string {
  const { question, game } = data;
  const q = question.toLowerCase();

  if (/score|winning|losing|ahead/.test(q)) {
    const diff = game.homeScore - game.awayScore;
    const leader =
      diff === 0
        ? "It's tied"
        : diff > 0
          ? `${game.homeTeam} leads by ${diff}`
          : `${game.awayTeam} leads by ${-diff}`;
    return `${leader}. Current score: ${scoreLine(game)}, ${game.periodLabel} ${game.period} with ${game.clock} remaining.`;
  }

  if (/foul/.test(q)) {
    const lastFoul = game.recentEvents.find((e) => e.type === "foul");
    if (lastFoul) {
      const who = lastFoul.player ?? teamName(game, lastFoul.team) ?? "a player";
      return `The most recent foul was on ${who}${lastFoul.description ? `: ${lastFoul.description}` : ""}.`;
    }
    return "There hasn't been a foul called recently.";
  }

  if (/turnover/.test(q)) {
    const lastTurnover = game.recentEvents.find((e) => e.type === "turnover");
    if (lastTurnover) {
      const who = lastTurnover.player ?? teamName(game, lastTurnover.team) ?? "a player";
      return `The last turnover was by ${who}${lastTurnover.description ? ` — ${lastTurnover.description}` : ""}.`;
    }
    return "No turnovers have happened recently.";
  }

  if (/happen|going on|update|catch me up/.test(q)) {
    if (game.recentEvents.length === 0) {
      return `Nothing has happened yet. ${scoreLine(game)} to start.`;
    }
    const recap = game.recentEvents.slice(0, 3).map((e) => describeEvent(e)).join("; ");
    return `Here's the recent action: ${recap}. Currently ${scoreLine(game)}.`;
  }

  // Generic fallback: ground the answer in the current state even without matching a known intent.
  return `Right now it's ${scoreLine(game)}, ${game.periodLabel} ${game.period} with ${game.clock} remaining. Ask about the score, a foul, or a turnover for more detail.`;
}
