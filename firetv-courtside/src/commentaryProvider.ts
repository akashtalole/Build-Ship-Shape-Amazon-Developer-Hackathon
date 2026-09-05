import type { CommentaryLine, EventType, GameEvent, GameState, ViewerPreferences } from "./types.js";

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
  data: EventCommentaryData | QuestionAnswerData | RecapData;
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

/** Structured data behind a `GET /games/:id/recap` window — see `CommentaryProvider.generateRecap`. */
export interface RecapData {
  kind: "recap";
  game: GameState;
  /** Human-readable description of the window being recapped, e.g. "in the last 10 minutes" or "since <cursor>". */
  windowLabel: string;
  /** Events within the window, chronological (oldest first). */
  events: GameEvent[];
  /** Commentary lines within the window, chronological (oldest first). */
  commentaryLines: CommentaryLine[];
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
  /** Generates a natural-language recap summarizing a window of events/commentary — see `GET /games/:id/recap`. */
  generateRecap(game: GameState, events: GameEvent[], commentaryLines: CommentaryLine[], windowLabel: string): Promise<string>;
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

  async generateRecap(game: GameState, events: GameEvent[], commentaryLines: CommentaryLine[], windowLabel: string): Promise<string> {
    const prompt = buildRecapPrompt(game, events, commentaryLines, windowLabel);
    return templateGenerateRecap(prompt.data as RecapData);
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

/** Builds the Bedrock-shaped prompt for a "catch-up" window recap. Exported so a real provider's tests can reuse it. */
export function buildRecapPrompt(
  game: GameState,
  events: GameEvent[],
  commentaryLines: CommentaryLine[],
  windowLabel: string
): CommentaryPrompt {
  return {
    system: SYSTEM_PERSONA,
    instruction: `Summarize everything that happened ${windowLabel} in 2-4 sentences for a viewer catching up. Mention the score and any big moments.`,
    context: serializeRecapContext(game, events, windowLabel),
    data: { kind: "recap", game, windowLabel, events, commentaryLines },
  };
}

function serializeRecapContext(game: GameState, events: GameEvent[], windowLabel: string): string {
  const lines = [
    `${game.homeTeam} ${game.homeScore} - ${game.awayScore} ${game.awayTeam}`,
    `${capitalize(game.periodLabel)} ${game.period}, ${game.clock} remaining, status: ${game.status}`,
    `Events ${windowLabel} (chronological):`,
    ...events.map((e) => `- ${describeEvent(e)}`),
  ];
  return lines.join("\n");
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

// --- Per-viewer personalization ------------------------------------------

/**
 * Applies a viewer's preferences on top of an already-generated line of
 * commentary or Q&A answer. Deliberately a post-processing decorator rather
 * than something baked into generation: commentary is generated once per
 * event and shared across every viewer of a game (a broadcast, not a
 * per-viewer LLM call), so personalization happens at serve time — in
 * `gameService.getCommentary`/`askQuestion` — for whichever viewer asked.
 * Works uniformly on top of either provider's output (template or a real
 * LLM's), since it only touches the returned text.
 */
export function personalizeText(text: string, game: GameState, prefs: ViewerPreferences | undefined): string {
  if (!prefs) return text;
  let out = text;

  const favoriteTeam = resolveFavoriteTeam(game, prefs.favoriteTeam);
  if (favoriteTeam) {
    const favoriteScore = favoriteTeam === game.homeTeam ? game.homeScore : game.awayScore;
    const otherScore = favoriteTeam === game.homeTeam ? game.awayScore : game.homeScore;
    const diff = favoriteScore - otherScore;
    const perspective =
      diff > 0 ? `up by ${diff}` : diff < 0 ? `down by ${-diff}` : "tied up";
    out += ` (${favoriteTeam} fan view: ${perspective}.)`;
  }

  if (prefs.verbosity === "detailed") {
    out += ` [${capitalize(game.periodLabel)} ${game.period}, ${game.clock} remaining, ${scoreLine(game)}.]`;
  }

  return out;
}

/** Resolves a viewer's `favoriteTeam` preference ("home"/"away"/a team name) to an actual team name in this game, or undefined if it doesn't match either side. */
function resolveFavoriteTeam(game: GameState, favoriteTeam?: string): string | undefined {
  if (!favoriteTeam?.trim()) return undefined;
  const f = favoriteTeam.trim().toLowerCase();
  if (f === "home") return game.homeTeam;
  if (f === "away") return game.awayTeam;
  if (game.homeTeam.toLowerCase() === f) return game.homeTeam;
  if (game.awayTeam.toLowerCase() === f) return game.awayTeam;
  return undefined;
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

// --- Multi-sport vocabulary ---------------------------------------------
//
// `GameState.sport` is free text (whatever a game was started with), but
// only a handful of sports get dedicated phrasing below — anything else
// (including an empty/unrecognized value) falls back to basketball's
// existing wording, which is also the *default* sport a game gets when none
// is given at all. That keeps every pre-round-4 game and test byte-for-byte
// unchanged while letting a game that explicitly declares "football" or
// "soccer" get commentary that doesn't talk about baskets or free throws.

export type SportKey = "basketball" | "football" | "soccer";

/** Normalizes a game's free-text `sport` field to one of the sports with dedicated phrasing, defaulting to basketball. */
export function normalizeSport(sport: string | undefined): SportKey {
  const s = (sport ?? "").trim().toLowerCase();
  if (s === "football" || s === "american football" || s === "nfl") return "football";
  if (s === "soccer" || s === "association football" || s === "futbol") return "soccer";
  return "basketball";
}

/** The `periodLabel` a game gets when it doesn't specify one explicitly — "half" for soccer, "quarter" otherwise (basketball's existing default, also used for football). */
export function defaultPeriodLabel(sport: string | undefined): string {
  return normalizeSport(sport) === "soccer" ? "half" : "quarter";
}

/**
 * Per-sport severity check for a `foul` event's free-text `description`,
 * driving `isNotableEvent`'s foul-escalation gate in `gameService.ts`.
 * Basketball's original keywords (flagrant/technical/ejection) stay the
 * default; football and soccer get their own sport-appropriate serious-foul
 * vocabulary instead of basketball's terms leaking into their heuristic.
 */
export function isSeriousFoulDescription(sport: string | undefined, description: string | undefined): boolean {
  const d = description ?? "";
  const key = normalizeSport(sport);
  if (key === "soccer") return /red card|second yellow|violent conduct|serious foul/i.test(d);
  if (key === "football") return /flagrant|ejection|targeting|unnecessary roughness|unsportsmanlike/i.test(d);
  return /flagrant|technical|ejection/i.test(d);
}

function scoreTemplates(sport: SportKey, who: string, event: GameEvent, game: GameState): string[] {
  const plusPoints = event.points ? ` (+${event.points})` : "";
  if (sport === "soccer") {
    return [
      `GOAL! ${who} finds the back of the net! ${scoreLine(game)}.`,
      `${who} scores! ${scoreLine(game)}.`,
      `${who} slots it home. ${scoreLine(game)}.`,
    ];
  }
  if (sport === "football") {
    return [
      `${who} scores${plusPoints}! ${scoreLine(game)}.`,
      `${who} finds the end zone${plusPoints}! ${scoreLine(game)}.`,
      `Points on the board for ${who}${plusPoints}. Now ${scoreLine(game)}.`,
    ];
  }
  return [
    `${who} scores${plusPoints}! ${scoreLine(game)}.`,
    `Bucket for ${who}! ${scoreLine(game)}.`,
    `${who} finds the basket${event.points ? ` for ${event.points}` : ""}. Now ${scoreLine(game)}.`,
  ];
}

function foulTemplates(sport: SportKey, who: string, event: GameEvent): string[] {
  const colonDesc = event.description ? `: ${event.description}` : "";
  const dashDesc = event.description ? ` — ${event.description}` : "";
  if (sport === "football") {
    return [`Penalty on ${who}${colonDesc}.`, `${who} flagged for a penalty${dashDesc}.`];
  }
  if (sport === "soccer") {
    return [`Foul called on ${who}${colonDesc}.`, `${who} commits a foul${dashDesc}.`];
  }
  return [`Foul called on ${who}${colonDesc}.`, `${who} picks up a foul${dashDesc}.`];
}

function turnoverTemplates(sport: SportKey, who: string, event: GameEvent): string[] {
  const parenDesc = event.description ? ` (${event.description})` : "";
  const dashDesc = event.description ? ` — ${event.description}` : "";
  if (sport === "football") {
    return [`Turnover! ${who} gives it away${parenDesc}.`, `${who} loses the ball${dashDesc}.`];
  }
  if (sport === "soccer") {
    return [`${who} gives away possession${parenDesc}.`, `Turnover, ${who}${dashDesc}.`];
  }
  return [`Turnover, ${who}${dashDesc}.`, `${who} loses possession${parenDesc}.`];
}

function reboundTemplates(sport: SportKey, who: string): string[] {
  if (sport === "basketball") return [`${who} grabs the rebound.`, `${who} cleans up the boards.`];
  return [`${who} recovers the loose ball.`, `${who} scoops up the loose ball.`];
}

function stealTemplates(sport: SportKey, who: string): string[] {
  if (sport === "soccer") return [`${who} wins the ball back!`, `Nice tackle from ${who} to win it back!`];
  if (sport === "football") return [`${who} comes up with the takeaway!`, `Big turnover forced by ${who}!`];
  return [`${who} comes up with the steal!`, `Great hands by ${who} for the steal!`];
}

function blockTemplates(sport: SportKey, who: string): string[] {
  if (sport === "soccer") return [`${who} blocks the shot!`, `Great defending — ${who} blocks it!`];
  if (sport === "football") return [`${who} blocks the kick!`, `${who} gets a hand up to block it!`];
  return [`${who} rejects the shot!`, `Denied! ${who} with the block.`];
}

function gameEndPhrase(sport: SportKey, game: GameState): string {
  if (sport === "soccer") return `That's full-time! ${scoreLine(game)}.`;
  if (sport === "football") return `That's the final whistle! ${scoreLine(game)}.`;
  return `That's the final! ${scoreLine(game)}.`;
}

function templateNarrateEvent(data: EventCommentaryData): string {
  const { event, game } = data;
  const who = event.player ?? teamName(game, event.team) ?? "The team";
  const seed = event.id;
  const sport = normalizeSport(game.sport);

  const templates: Record<EventType, () => string> = {
    score: () => pick(scoreTemplates(sport, who, event, game), seed),
    foul: () => pick(foulTemplates(sport, who, event), seed),
    turnover: () => pick(turnoverTemplates(sport, who, event), seed),
    rebound: () => pick(reboundTemplates(sport, who), seed),
    steal: () => pick(stealTemplates(sport, who), seed),
    block: () => pick(blockTemplates(sport, who), seed),
    timeout: () => `${who} calls a timeout.`,
    period_end: () =>
      `End of ${game.periodLabel} ${event.period ?? game.period}. ${scoreLine(game)}.`,
    game_end: () => gameEndPhrase(sport, game),
  };

  return templates[event.type]();
}

/**
 * Template fallback for `GET /games/:id/recap`: reuses the same
 * sport-neutral `describeEvent` helper the live-context serialization uses
 * (it prints `[type] who +points — description`, never basketball-specific
 * words like "basket"), so the recap adapts to any sport for free instead of
 * needing its own per-sport phrasing.
 */
function templateGenerateRecap(data: RecapData): string {
  const { game, events, windowLabel } = data;
  if (events.length === 0) {
    return `Nothing happened ${windowLabel}. Still ${scoreLine(game)}.`;
  }
  const MAX_MENTIONED = 8;
  const mentioned = events.slice(-MAX_MENTIONED); // events is already chronological; keep the most recent ones for a readable recap
  const recap = mentioned.map((e) => describeEvent(e)).join("; ");
  const omitted = events.length - mentioned.length;
  const omittedNote = omitted > 0 ? ` (plus ${omitted} earlier play${omitted === 1 ? "" : "s"} in this window)` : "";
  const playCount = `${events.length} play${events.length === 1 ? "" : "s"}`;
  return `Catching you up on what happened ${windowLabel}: ${recap}${omittedNote}. That's ${playCount} — now ${scoreLine(game)}.`;
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
