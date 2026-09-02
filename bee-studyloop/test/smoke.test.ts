/**
 * End-to-end smoke test: starts the StudyLoop server on an ephemeral port
 * with a real HTTP client (fetch), and drives the full ambient-capture-to-
 * review lifecycle — ingest a study session transcript, confirm a summary
 * and flashcards were generated, confirm a fresh card shows up in the daily
 * review queue, submit recall grades and confirm the spaced-repetition
 * schedule reacts correctly — plus edge cases around bad input. Run with
 * `npm test`.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { TemplateFlashcardGenerator } from "../src/flashcardGenerator.js";
import { initialSchedulerState, scheduleReview } from "../src/scheduler.js";

async function main() {
  const generator = new TemplateFlashcardGenerator();
  const app = createApp(generator);
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // --- Ingest a study session transcript as diarized segments ---
  const transcript = [
    { speaker: "Alice", text: "Mitochondria is the powerhouse of the cell." },
    { speaker: "Bob", text: "What is the powerhouse of the cell?" },
    { speaker: "Alice", text: "The mitochondria is the powerhouse of the cell." },
    { speaker: "Bob", text: "Photosynthesis is the process by which plants convert light into chemical energy." },
    { speaker: "Alice", text: "What does photosynthesis produce?" },
    { speaker: "Bob", text: "It produces glucose and oxygen." },
  ];

  const ingestRes = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Bio 101 study group", transcript }),
  });
  assert.equal(ingestRes.status, 201);
  const ingested = await ingestRes.json();
  assert.ok(ingested.session.id, "ingest returns a session with an id");
  assert.ok(ingested.session.summary.length > 0, "ingest generates a non-empty summary");
  assert.ok(ingested.flashcards.length >= 1, "ingest generates at least one flashcard");
  console.log(`✓ POST /sessions ingests a transcript and generates a summary + ${ingested.flashcards.length} flashcard(s)`);

  const card = ingested.flashcards[0];
  assert.ok(card.front && card.back, "each flashcard has a front and back");
  assert.equal(card.repetitions, 0, "a freshly generated card has no repetitions yet");
  console.log("✓ generated flashcards have both a front (prompt) and back (answer)");

  // --- Fetch the session back ---
  const sessionRes = await fetch(`${base}/sessions/${ingested.session.id}`);
  assert.equal(sessionRes.status, 200);
  const sessionBody = await sessionRes.json();
  assert.equal(sessionBody.session.id, ingested.session.id);
  assert.equal(sessionBody.flashcards.length, ingested.flashcards.length);
  console.log("✓ GET /sessions/:id returns the session summary and its flashcards");

  // --- A freshly generated card is immediately due for review ---
  const dueRes = await fetch(`${base}/review/due`);
  const due = await dueRes.json();
  assert.ok(
    due.some((c: { id: string }) => c.id === card.id),
    "a freshly created card should be in the due queue"
  );
  console.log("✓ GET /review/due includes freshly generated cards (nothing reviewed yet)");

  // --- A "good" recall grade pushes the due date into the future ---
  const goodRes = await fetch(`${base}/review/${card.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grade: "good" }),
  });
  assert.equal(goodRes.status, 200);
  const afterGood = await goodRes.json();
  assert.ok(afterGood.interval > card.interval, "a passing grade increases the interval");
  assert.ok(new Date(afterGood.dueAt).getTime() > new Date(card.dueAt).getTime(), "a passing grade moves the due date into the future");
  assert.equal(afterGood.repetitions, 1);
  console.log(`✓ POST /review/:cardId with "good" reschedules the card further out (interval ${card.interval} -> ${afterGood.interval} day(s))`);

  // A card just rescheduled a day+ into the future should no longer be due today.
  const dueAfterGood = await (await fetch(`${base}/review/due`)).json();
  assert.ok(
    !dueAfterGood.some((c: { id: string }) => c.id === card.id),
    "a card rescheduled into the future drops out of today's due queue"
  );
  console.log("✓ reviewing a card removes it from the due queue until its new due date arrives");

  // --- A second "good" grows the interval further (1 -> 6 days) ---
  const secondGoodRes = await fetch(`${base}/review/${card.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grade: "good" }),
  });
  const afterSecondGood = await secondGoodRes.json();
  assert.ok(afterSecondGood.interval > afterGood.interval, "consecutive passes keep growing the interval");
  console.log(`✓ consecutive "good" reviews keep growing the interval (${afterGood.interval} -> ${afterSecondGood.interval} day(s))`);

  // --- Edge case: an "again" (failing) grade shortens the interval back down ---
  const againRes = await fetch(`${base}/review/${card.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grade: "again" }),
  });
  assert.equal(againRes.status, 200);
  const afterAgain = await againRes.json();
  assert.ok(afterAgain.interval < afterSecondGood.interval, "a failing grade shortens the interval back down rather than growing it");
  assert.equal(afterAgain.repetitions, 0, "a failing grade resets the repetition streak");
  console.log(`✓ POST /review/:cardId with "again" resets the streak and shortens the interval back down (${afterSecondGood.interval} -> ${afterAgain.interval} day(s))`);

  // --- Edge case: reviewing a nonexistent card returns a clean 404 ---
  const missingCardRes = await fetch(`${base}/review/not-a-real-card-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grade: "good" }),
  });
  assert.equal(missingCardRes.status, 404);
  const missingCardBody = await missingCardRes.json();
  assert.ok(missingCardBody.error, "a 404 includes an error message");
  console.log("✓ POST /review/:cardId for an unknown card id returns a clean 404");

  // --- Edge case: fetching a nonexistent session returns a clean 404 ---
  const missingSessionRes = await fetch(`${base}/sessions/not-a-real-session-id`);
  assert.equal(missingSessionRes.status, 404);
  console.log("✓ GET /sessions/:id for an unknown session id returns a clean 404");

  // --- Edge case: an invalid grade is rejected with a 400, not a crash ---
  const badGradeRes = await fetch(`${base}/review/${card.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grade: "excellent" }),
  });
  assert.equal(badGradeRes.status, 400);
  console.log("✓ POST /review/:cardId rejects an invalid grade with a 400");

  // --- Edge case: an empty/near-empty transcript still returns a sensible response ---
  const emptyRes = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Empty session", transcript: "   " }),
  });
  assert.equal(emptyRes.status, 201, "an empty transcript is accepted rather than erroring");
  const emptyBody = await emptyRes.json();
  assert.ok(emptyBody.session.summary.length > 0, "an empty transcript still gets a sensible fallback summary");
  assert.deepEqual(emptyBody.flashcards, [], "an empty transcript yields zero flashcards rather than crashing");
  console.log("✓ an empty transcript degrades gracefully to a fallback summary and zero flashcards");

  // --- Edge case: a raw text-block transcript (not pre-segmented) also works ---
  const rawTextRes = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Pasted lecture notes",
      transcript:
        "Osmosis is the movement of water across a semipermeable membrane. What drives osmosis? Water moves from low to high solute concentration.",
    }),
  });
  assert.equal(rawTextRes.status, 201);
  const rawTextBody = await rawTextRes.json();
  assert.ok(rawTextBody.flashcards.length >= 1, "a raw text-block transcript still produces flashcards");
  console.log("✓ a raw text-block transcript (the non-Bee, paste-it-yourself path) is also ingested successfully");

  // --- A couple of direct unit-style checks of the scheduler math ---
  const fresh = initialSchedulerState(new Date("2026-01-01T00:00:00.000Z"));
  const easy = scheduleReview(fresh, "easy", new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(easy.interval, 1, "the first passing review always schedules a 1-day interval");
  assert.ok(easy.easeFactor >= fresh.easeFactor, "an 'easy' grade should not decrease the ease factor");
  const hardAfterEasy = scheduleReview(easy, "hard", new Date("2026-01-02T00:00:00.000Z"));
  assert.ok(hardAfterEasy.easeFactor < easy.easeFactor, "a 'hard' grade decreases the ease factor");
  console.log("✓ scheduler.ts: direct unit checks of interval and ease-factor math pass");

  httpServer.close();
  console.log("\nAll StudyLoop smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
