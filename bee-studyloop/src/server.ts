import express, { type Express } from "express";
import type { FlashcardGenerator } from "./flashcardGenerator.js";
import type { RecallGrade } from "./types.js";
import {
  appendSessionSegments,
  buildReviewSession,
  exportAllFlashcards,
  exportSessionFlashcards,
  getQuizPrompts,
  getQuizResults,
  getReminderDigest,
  getSessionWithCards,
  getStreakForStudent,
  importFlashcards,
  ingestSession,
  joinSharedDeck,
  listDueCards,
  listDueCardsForStudent,
  listLeechCards,
  listLeechCardsForStudent,
  recordReview,
  recordReviewForStudent,
  regenerateFlashcard,
  searchFlashcardsByTopic,
  startQuiz,
  submitQuizAnswer,
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
    const { title, transcript, idempotencyKey, externalSessionId, shared } = req.body ?? {};
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

    // Marks the session as a shared study-group deck: another student can
    // pull its flashcards into their own review queue via
    // POST /decks/:sessionId/join. See README "Shared study-group decks".
    const result = await ingestSession(generator, { title, transcript, idempotencyKey: key, shared: Boolean(shared) });
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
    const { segments, studentId } = req.body ?? {};
    if (segments === undefined || segments === null) {
      res.status(400).json({ error: "segments is required (a string, or an array of {speaker, text, timestampMs} segments)." });
      return;
    }
    if (typeof segments !== "string" && !Array.isArray(segments)) {
      res.status(400).json({ error: "segments must be a string or an array of segments." });
      return;
    }

    // Optional studentId biases new-card generation toward this student's
    // weak topics (see README "Adaptive new-card generation bias").
    const studentIdInput = typeof studentId === "string" && studentId.trim() ? studentId.trim() : undefined;
    const result = await appendSessionSegments(generator, req.params.id, { segments, studentId: studentIdInput });
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

  // Flashcards due for review today — ordered by adaptive priority
  // (overdue-ness, leech status, ease factor; see priority.ts for the exact
  // formula). With no ?studentId=, this is the shared, student-less pool
  // every original endpoint reads/writes; with ?studentId=, it's that
  // student's own personal deck (joined shared decks + directly-reviewed
  // cards) — see README "Shared study-group decks".
  app.get("/review/due", (req, res) => {
    const studentId = req.query.studentId;
    if (typeof studentId === "string" && studentId.trim()) {
      res.json(listDueCardsForStudent(studentId.trim()));
      return;
    }
    res.json(listDueCards());
  });

  // Cards flagged as leeches (repeated consecutive failures) — surfaced
  // distinctly so a student can reformulate them instead of endlessly
  // rescheduling. ?studentId= scopes this to one student's own deck, same
  // as GET /review/due.
  app.get("/review/leeches", (req, res) => {
    const studentId = req.query.studentId;
    if (typeof studentId === "string" && studentId.trim()) {
      res.json(listLeechCardsForStudent(studentId.trim()));
      return;
    }
    res.json(listLeechCards());
  });

  app.post("/review/:cardId", (req, res) => {
    const { grade, studentId } = req.body ?? {};
    if (!isRecallGrade(grade)) {
      res.status(400).json({ error: `grade must be one of: ${VALID_GRADES.join(", ")}` });
      return;
    }
    if (studentId !== undefined && (typeof studentId !== "string" || !studentId.trim())) {
      res.status(400).json({ error: "studentId, if provided, must be a non-empty string." });
      return;
    }

    // A studentId submits this grade against that student's own independent
    // review state (see README "Shared study-group decks"); omitting it
    // reviews the card's own embedded state, exactly as before.
    const updated =
      typeof studentId === "string" && studentId.trim()
        ? recordReviewForStudent(studentId.trim(), req.params.cardId, grade)
        : recordReview(req.params.cardId, grade);
    if (!updated) {
      res.status(404).json({ error: "No flashcard with that ID." });
      return;
    }
    res.json(updated);
  });

  // Shared study-group decks: pull a shared session's flashcards into this
  // student's own review queue. Flashcard content is never duplicated —
  // only a fresh, independent review-state row per card is created for this
  // studentId. See README "Shared study-group decks".
  app.post("/decks/:sessionId/join", (req, res) => {
    const { studentId } = req.body ?? {};
    if (typeof studentId !== "string" || !studentId.trim()) {
      res.status(400).json({ error: "studentId is required." });
      return;
    }

    const result = joinSharedDeck(req.params.sessionId, studentId.trim());
    if (!result.ok) {
      if (result.reason === "not_found") {
        res.status(404).json({ error: "No study session with that ID." });
        return;
      }
      res.status(400).json({ error: "That session is not shared. Ingest it with shared: true so others can join it." });
      return;
    }
    res.status(200).json({ studentId: studentId.trim(), sessionId: result.session.id, cards: result.cards });
  });

  // Quiz/practice-test mode: sample up to `count` cards (prioritizing
  // due/leech cards — see startQuiz in studyService.ts) into a new timed
  // quiz. Optional studentId samples from that student's own personal deck
  // instead of the shared pool.
  app.post("/quiz/start", (req, res) => {
    const { count, studentId } = req.body ?? {};
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      res.status(400).json({ error: "count is required and must be a positive number." });
      return;
    }
    if (studentId !== undefined && (typeof studentId !== "string" || !studentId.trim())) {
      res.status(400).json({ error: "studentId, if provided, must be a non-empty string." });
      return;
    }

    const quiz = startQuiz(count, typeof studentId === "string" ? studentId.trim() : undefined);
    res.status(201).json({ id: quiz.id, studentId: quiz.studentId, startedAt: quiz.startedAt, cards: getQuizPrompts(quiz) });
  });

  // Grades one quiz answer. See submitQuizAnswer in studyService.ts for the
  // exact (case-insensitive/trimmed exact-match) grading heuristic.
  app.post("/quiz/:id/answer", (req, res) => {
    const { cardId, answer } = req.body ?? {};
    if (typeof cardId !== "string" || !cardId.trim() || typeof answer !== "string") {
      res.status(400).json({ error: "cardId (string) and answer (string) are required." });
      return;
    }

    const result = submitQuizAnswer(req.params.id, cardId, answer);
    if (!result.ok) {
      if (result.reason === "quiz_not_found") {
        res.status(404).json({ error: "No quiz with that ID." });
        return;
      }
      res.status(400).json({ error: "That card is not part of this quiz." });
      return;
    }
    res.json({ correct: result.correct });
  });

  // Score summary for a quiz — correct/total plus which cards were missed —
  // available at any point, mid-quiz or once every card has been answered.
  app.get("/quiz/:id/results", (req, res) => {
    const results = getQuizResults(req.params.id);
    if (!results) {
      res.status(404).json({ error: "No quiz with that ID." });
      return;
    }
    res.json(results);
  });

  // Due-card reminder digest: a compact, read-aloud-friendly summary for one
  // student (e.g. "You have 5 cards due today, including 2 leeches."), plus
  // the structured counts it's built from. See README "Due-card reminder
  // digest".
  app.get("/reminders/digest", (req, res) => {
    const studentId = req.query.studentId;
    if (typeof studentId !== "string" || !studentId.trim()) {
      res.status(400).json({ error: "studentId query parameter is required, e.g. /reminders/digest?studentId=alice" });
      return;
    }
    res.json(getReminderDigest(studentId.trim()));
  });

  // Study streaks & gamification: current/longest consecutive-day review
  // streak plus earned milestone badges for one student. See README "Study
  // streaks & gamification".
  app.get("/students/:studentId/streak", (req, res) => {
    const studentId = req.params.studentId;
    if (!studentId.trim()) {
      res.status(400).json({ error: "studentId is required." });
      return;
    }
    res.json(getStreakForStudent(studentId.trim()));
  });

  // Global daily review session planner: a bounded "here's your review for
  // today" pull across every deck a student has (own + joined shared decks),
  // in the existing adaptive priority order, capped at maxCards. See README
  // "Global daily review session planner".
  app.get("/review/session", (req, res) => {
    const { studentId, maxCards } = req.query;
    if (typeof studentId !== "string" || !studentId.trim()) {
      res.status(400).json({ error: "studentId query parameter is required, e.g. /review/session?studentId=alice&maxCards=20" });
      return;
    }
    const parsedMax = typeof maxCards === "string" ? Number(maxCards) : NaN;
    if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
      res.status(400).json({ error: "maxCards query parameter is required and must be a positive number, e.g. ?maxCards=20" });
      return;
    }
    res.json(buildReviewSession(studentId.trim(), parsedMax));
  });

  // Import round-trip: creates flashcards from a TSV in the same format
  // GET /export produces, deduplicating by front-text against both the
  // target session's existing cards and the rest of the batch being
  // imported. Omit sessionId to restore into a brand-new session. See
  // README "Import round-trip".
  app.post("/import", (req, res) => {
    const { tsv, sessionId, title } = req.body ?? {};
    if (typeof tsv !== "string" || !tsv.trim()) {
      res.status(400).json({ error: "tsv is required — the same format GET /export produces." });
      return;
    }
    if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim())) {
      res.status(400).json({ error: "sessionId, if provided, must be a non-empty string." });
      return;
    }

    const result = importFlashcards({
      tsv,
      sessionId: typeof sessionId === "string" ? sessionId.trim() : undefined,
      title: typeof title === "string" ? title : undefined,
    });
    if (!result.ok) {
      res.status(404).json({ error: "No study session with that ID to import into." });
      return;
    }
    res.status(201).json({ session: result.session, imported: result.imported, skippedDuplicates: result.skippedDuplicates });
  });

  // Regenerate-a-card: re-runs generation against just this card's
  // underlying transcript material for an alternative phrasing, replacing
  // front/back while leaving scheduling and leech state untouched. See
  // README "Regenerate-a-card".
  app.post("/flashcards/:cardId/regenerate", async (req, res) => {
    const result = await regenerateFlashcard(generator, req.params.cardId);
    if (!result.ok) {
      if (result.reason === "card_not_found") {
        res.status(404).json({ error: "No flashcard with that ID." });
        return;
      }
      if (result.reason === "session_not_found") {
        res.status(404).json({ error: "This flashcard's parent session no longer exists." });
        return;
      }
      res.status(422).json({ error: "Could not generate an alternative phrasing for this card from its underlying transcript material." });
      return;
    }
    res.json(result.card);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
