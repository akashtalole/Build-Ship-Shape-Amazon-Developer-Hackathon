import { DEFAULT_LOCALE, type CommentaryLine, type CommentaryLocale, type EventType, type GameEvent, type GameState, type ViewerPreferences } from "./types.js";

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
  locale: CommentaryLocale;
}

export interface QuestionAnswerData {
  kind: "question";
  question: string;
  game: GameState;
  locale: CommentaryLocale;
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
  locale: CommentaryLocale;
}

/**
 * The commentary-generation interface. A Fire TV overlay never talks to this
 * directly — `gameService.ts` calls it to turn a raw event or a viewer
 * question into a line of text to display/speak.
 */
export interface CommentaryProvider {
  /** Generates a natural-language line of commentary for a single game event, in the requested locale/style (defaults to `"en-broadcast"`). */
  narrateEvent(game: GameState, event: GameEvent, locale?: CommentaryLocale): Promise<string>;
  /** Answers an on-demand viewer question, grounded in current game state, in the requested locale/style. */
  answerQuestion(game: GameState, question: string, locale?: CommentaryLocale): Promise<string>;
  /** Generates a natural-language recap summarizing a window of events/commentary, in the requested locale/style — see `GET /games/:id/recap`. */
  generateRecap(
    game: GameState,
    events: GameEvent[],
    commentaryLines: CommentaryLine[],
    windowLabel: string,
    locale?: CommentaryLocale
  ): Promise<string>;
}

const SYSTEM_PERSONA =
  "You are CourtSide, an upbeat but concise AI sports co-commentator overlaid on a live broadcast. " +
  "Keep responses to one or two sentences so they fit an on-screen overlay without blocking the action.";

/**
 * Per-locale system persona — a real Bedrock-backed provider would swap its
 * whole system prompt per locale/style the same way `TemplateCommentaryProvider`
 * swaps its whole template pack below, rather than asking one prompt to
 * translate its own output on the fly. See "Localized commentary packs".
 */
function localeSystemPersona(locale: CommentaryLocale): string {
  if (locale === "en-casual") {
    return (
      "You are CourtSide, hanging out and watching the game with the viewer like a hype friend on the couch. " +
      "Casual, excited, first-person plural (\"we\"/\"our guys\") where it fits. One or two sentences, no jargon-y broadcast-speak."
    );
  }
  if (locale === "es-broadcast") {
    return (
      "Eres CourtSide, un co-comentarista de IA formal para una transmisión deportiva en vivo, superpuesto en pantalla. " +
      "Responde siempre en español, en un tono profesional de locutor. Una o dos oraciones como máximo."
    );
  }
  return SYSTEM_PERSONA;
}

/**
 * Template-based fallback implementation. Produces reasonable, varied
 * commentary directly from structured event/game data with no external LLM
 * call — this is what CourtSide runs with out of the box, and what keeps the
 * service fully demoable and testable without AWS credentials. Swap in a
 * real Bedrock-backed provider (see README) without touching any of
 * `gameService.ts` or `server.ts`, since both only depend on this interface.
 */
export class TemplateCommentaryProvider implements CommentaryProvider {
  async narrateEvent(game: GameState, event: GameEvent, locale: CommentaryLocale = DEFAULT_LOCALE): Promise<string> {
    const prompt = buildEventPrompt(game, event, locale);
    return templateNarrateEvent(prompt.data as EventCommentaryData);
  }

  async answerQuestion(game: GameState, question: string, locale: CommentaryLocale = DEFAULT_LOCALE): Promise<string> {
    const prompt = buildQuestionPrompt(game, question, locale);
    return templateAnswerQuestion(prompt.data as QuestionAnswerData);
  }

  async generateRecap(
    game: GameState,
    events: GameEvent[],
    commentaryLines: CommentaryLine[],
    windowLabel: string,
    locale: CommentaryLocale = DEFAULT_LOCALE
  ): Promise<string> {
    const prompt = buildRecapPrompt(game, events, commentaryLines, windowLabel, locale);
    return templateGenerateRecap(prompt.data as RecapData);
  }
}

/** Builds the Bedrock-shaped prompt for a single event. Exported so a real provider's tests can reuse it. */
export function buildEventPrompt(game: GameState, event: GameEvent, locale: CommentaryLocale = DEFAULT_LOCALE): CommentaryPrompt {
  return {
    system: localeSystemPersona(locale),
    instruction: "Narrate this single play for a viewer who may not know the sport well. One or two sentences.",
    context: serializeGameContext(game, event),
    data: { kind: "event", event, game, locale },
  };
}

/** Builds the Bedrock-shaped prompt for a viewer question. Exported so a real provider's tests can reuse it. */
export function buildQuestionPrompt(game: GameState, question: string, locale: CommentaryLocale = DEFAULT_LOCALE): CommentaryPrompt {
  return {
    system: localeSystemPersona(locale),
    instruction: `Answer the viewer's question using only the game context below. Question: "${question}"`,
    context: serializeGameContext(game),
    data: { kind: "question", question, game, locale },
  };
}

/** Builds the Bedrock-shaped prompt for a "catch-up" window recap. Exported so a real provider's tests can reuse it. */
export function buildRecapPrompt(
  game: GameState,
  events: GameEvent[],
  commentaryLines: CommentaryLine[],
  windowLabel: string,
  locale: CommentaryLocale = DEFAULT_LOCALE
): CommentaryPrompt {
  return {
    system: localeSystemPersona(locale),
    instruction: `Summarize everything that happened ${windowLabel} in 2-4 sentences for a viewer catching up. Mention the score and any big moments.`,
    context: serializeRecapContext(game, events, windowLabel),
    data: { kind: "recap", game, windowLabel, events, commentaryLines, locale },
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
  const { event, game, locale } = data;
  const who = event.player ?? teamName(game, event.team) ?? "The team";
  const seed = event.id;

  if (locale === "en-casual") return pick(casualNarrateOptions(who, event, game), seed);
  if (locale === "es-broadcast") return pick(spanishNarrateOptions(who, event, game), seed);

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

// --- Localized commentary packs ------------------------------------------
//
// Two additional, genuinely distinct phrasing packs alongside the original
// (now-named) "en-broadcast" default above: a casual friend-watching-with-you
// voice, and a formal Spanish-language broadcast voice. Deliberately *not*
// translated word-for-word from the English broadcast templates above — each
// pack has its own sentence rhythm and vocabulary appropriate to its style,
// the same way a real bilingual or dual-tone broadcast booth would write two
// completely separate scripts rather than running one through a translator.
// Kept sport-neutral (unlike "en-broadcast", which is fully per-sport as of
// round 4) — an honest scope line documented in FRICTION_LOG.md rather than
// tripling the per-sport template surface for this round.

function casualNarrateOptions(who: string, event: GameEvent, game: GameState): string[] {
  const score = scoreLine(game);
  switch (event.type) {
    case "score":
      return [
        `Ohhh we love to see it — ${who} scores${event.points ? ` (+${event.points})` : ""}! ${score}.`,
        `${who} just put that one home! ${score}.`,
        `Yesss, ${who}'s heating up! ${score}.`,
      ];
    case "foul":
      return [
        `Ugh, foul on ${who}${event.description ? ` — ${event.description}` : ""}. Rough one.`,
        `${who} picks up a foul there${event.description ? ` (${event.description})` : ""}.`,
      ];
    case "turnover":
      return [
        `Oof, ${who} coughs it up${event.description ? ` — ${event.description}` : ""}. That's gonna hurt.`,
        `Turnover for ${who}, we'll take that back please.`,
      ];
    case "rebound":
      return [`${who} snags that rebound, nice hustle!`, `${who} cleans it up on the boards.`];
    case "steal":
      return [`Ooh, ${who} jumps the passing lane and steals it! Love that.`, `${who} with the sticky fingers — steal!`];
    case "block":
      return [`Get that outta here! ${who} sends it back.`, `${who} says not today — big block!`];
    case "timeout":
      return [`${who} calls timeout, let's regroup for a sec.`];
    case "period_end":
      return [`And that's the ${game.periodLabel}! ${score}. Let's see what's next.`];
    case "game_end":
      return [`And that's a wrap, folks! Final: ${score}. What a watch.`];
    default:
      return [`${who} — something's happening out there. ${score}.`];
  }
}

function spanishNarrateOptions(who: string, event: GameEvent, game: GameState): string[] {
  const score = scoreLine(game);
  switch (event.type) {
    case "score":
      return [
        `¡Anota ${who}${event.points ? ` (+${event.points})` : ""}! ${score}.`,
        `${who} pone el balón en la canasta. Marcador: ${score}.`,
      ];
    case "foul":
      return [
        `Falta de ${who}${event.description ? `: ${event.description}` : ""}.`,
        `Se marca una falta sobre ${who}.`,
      ];
    case "turnover":
      return [
        `Pérdida de balón de ${who}${event.description ? ` — ${event.description}` : ""}.`,
        `${who} pierde el balón.`,
      ];
    case "rebound":
      return [`Rebote de ${who}.`, `${who} se hace con el rebote.`];
    case "steal":
      return [`¡Robo de balón de ${who}!`, `${who} le quita el balón al rival.`];
    case "block":
      return [`¡Bloqueo de ${who}!`, `${who} rechaza el intento de tiro.`];
    case "timeout":
      return [`${who} pide tiempo fuera.`];
    case "period_end":
      return [`Termina el ${game.periodLabel} ${event.period ?? game.period}. ${score}.`];
    case "game_end":
      return [`¡Ese es el final del partido! ${score}.`];
    default:
      return [`Jugada de ${who}. ${score}.`];
  }
}

/**
 * Template fallback for `GET /games/:id/recap`: reuses the same
 * sport-neutral `describeEvent` helper the live-context serialization uses
 * (it prints `[type] who +points — description`, never basketball-specific
 * words like "basket"), so the recap adapts to any sport for free instead of
 * needing its own per-sport phrasing.
 */
function templateGenerateRecap(data: RecapData): string {
  const { game, events, windowLabel, locale } = data;

  if (locale === "en-casual") {
    if (events.length === 0) return `Nothing much going on ${windowLabel}, still hanging at ${scoreLine(game)}.`;
    const MAX_MENTIONED = 8;
    const mentioned = events.slice(-MAX_MENTIONED);
    const recap = mentioned.map((e) => describeEvent(e)).join("; ");
    const omitted = events.length - mentioned.length;
    const omittedNote = omitted > 0 ? ` (and ${omitted} more play${omitted === 1 ? "" : "s"} before that)` : "";
    return `Ok here's the rundown for ${windowLabel}: ${recap}${omittedNote}. We're at ${scoreLine(game)} now!`;
  }
  if (locale === "es-broadcast") {
    if (events.length === 0) return `No ha pasado nada ${windowLabel}. Sigue ${scoreLine(game)}.`;
    const MAX_MENTIONED = 8;
    const mentioned = events.slice(-MAX_MENTIONED);
    const recap = mentioned.map((e) => describeEvent(e)).join("; ");
    const omitted = events.length - mentioned.length;
    const omittedNote = omitted > 0 ? ` (además de ${omitted} jugada${omitted === 1 ? "" : "s"} anteriores)` : "";
    return `Resumen de lo ocurrido ${windowLabel}: ${recap}${omittedNote}. Marcador actual: ${scoreLine(game)}.`;
  }

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
  const { question, game, locale } = data;
  const q = question.toLowerCase();

  if (locale === "en-casual") return casualAnswerQuestion(q, game);
  if (locale === "es-broadcast") return spanishAnswerQuestion(q, game);

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

function casualAnswerQuestion(q: string, game: GameState): string {
  if (/score|winning|losing|ahead/.test(q)) {
    const diff = game.homeScore - game.awayScore;
    const leader = diff === 0 ? "it's all tied up" : diff > 0 ? `${game.homeTeam}'s up by ${diff}` : `${game.awayTeam}'s up by ${-diff}`;
    return `Right now ${leader}! ${scoreLine(game)}, ${game.periodLabel} ${game.period}, ${game.clock} left on the clock.`;
  }
  if (/foul/.test(q)) {
    const lastFoul = game.recentEvents.find((e) => e.type === "foul");
    if (lastFoul) {
      const who = lastFoul.player ?? teamName(game, lastFoul.team) ?? "somebody";
      return `Yeah, that was on ${who}${lastFoul.description ? ` — ${lastFoul.description}` : ""}.`;
    }
    return "No fouls to talk about lately, game's flowing!";
  }
  if (/turnover/.test(q)) {
    const lastTurnover = game.recentEvents.find((e) => e.type === "turnover");
    if (lastTurnover) {
      const who = lastTurnover.player ?? teamName(game, lastTurnover.team) ?? "somebody";
      return `${who} gave that one up${lastTurnover.description ? ` — ${lastTurnover.description}` : ""}. Happens.`;
    }
    return "Nobody's turned it over in a bit, clean stretch of ball.";
  }
  if (/happen|going on|update|catch me up/.test(q)) {
    if (game.recentEvents.length === 0) return `Nothing yet, we're just getting started at ${scoreLine(game)}.`;
    const recap = game.recentEvents.slice(0, 3).map((e) => describeEvent(e)).join("; ");
    return `Here's what you missed: ${recap}. We're at ${scoreLine(game)} right now.`;
  }
  return `We're at ${scoreLine(game)}, ${game.periodLabel} ${game.period}, ${game.clock} to go. Ask me about the score, a foul, or a turnover!`;
}

function spanishAnswerQuestion(q: string, game: GameState): string {
  if (/score|winning|losing|ahead|marcador|ganando/.test(q)) {
    const diff = game.homeScore - game.awayScore;
    const leader = diff === 0 ? "Están empatados" : diff > 0 ? `${game.homeTeam} gana por ${diff}` : `${game.awayTeam} gana por ${-diff}`;
    return `${leader}. Marcador actual: ${scoreLine(game)}, ${game.periodLabel} ${game.period}, quedan ${game.clock}.`;
  }
  if (/foul|falta/.test(q)) {
    const lastFoul = game.recentEvents.find((e) => e.type === "foul");
    if (lastFoul) {
      const who = lastFoul.player ?? teamName(game, lastFoul.team) ?? "un jugador";
      return `La última falta fue de ${who}${lastFoul.description ? `: ${lastFoul.description}` : ""}.`;
    }
    return "No ha habido faltas recientemente.";
  }
  if (/turnover|pérdida|perdida/.test(q)) {
    const lastTurnover = game.recentEvents.find((e) => e.type === "turnover");
    if (lastTurnover) {
      const who = lastTurnover.player ?? teamName(game, lastTurnover.team) ?? "un jugador";
      return `La última pérdida de balón fue de ${who}${lastTurnover.description ? ` — ${lastTurnover.description}` : ""}.`;
    }
    return "No ha habido pérdidas de balón recientemente.";
  }
  if (/happen|going on|update|catch me up|qué pasó|resumen/.test(q)) {
    if (game.recentEvents.length === 0) return `Todavía no ha pasado nada. Empezamos con ${scoreLine(game)}.`;
    const recap = game.recentEvents.slice(0, 3).map((e) => describeEvent(e)).join("; ");
    return `Esto es lo último: ${recap}. Marcador actual: ${scoreLine(game)}.`;
  }
  return `Ahora mismo va ${scoreLine(game)}, ${game.periodLabel} ${game.period}, quedan ${game.clock}. Pregúntame por el marcador, una falta o una pérdida de balón.`;
}
