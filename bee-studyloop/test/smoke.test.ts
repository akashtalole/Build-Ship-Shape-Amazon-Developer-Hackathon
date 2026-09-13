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
import { initialLeechState, LEECH_THRESHOLD, updateLeechState } from "../src/leech.js";
import { priorityScore } from "../src/priority.js";
import { extractTopics } from "../src/topics.js";
import { getReminderDigest, getTopicReadiness, listDueCards, recordReviewForStudent } from "../src/studyService.js";
import { conceptsMatch, extractConceptsFromCard } from "../src/conceptGraph.js";
import { gradeExplanation, scoreToRecallGrade } from "../src/explainGrader.js";
import { buildStudyGuide } from "../src/studyGuide.js";
import { computeReadiness } from "../src/readiness.js";

async function main() {
  const generator = new TemplateFlashcardGenerator();
  const app = createApp(generator);
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const headers = { "Content-Type": "application/json" };

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

  // ===================================================================
  // Advanced features
  // ===================================================================

  // --- Feature 1: idempotent session ingestion ---
  const idemKey = "retry-key-123";
  const idemTranscript = [
    { text: "Osmoregulation is the process of maintaining fluid and electrolyte balance." },
    { text: "What is osmoregulation?" },
    { text: "It is the process that maintains fluid and electrolyte balance in an organism." },
  ];
  const firstIngestRes = await fetch(`${base}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Idempotency check", transcript: idemTranscript, idempotencyKey: idemKey }),
  });
  assert.equal(firstIngestRes.status, 201);
  const firstIngestBody = await firstIngestRes.json();
  assert.ok(firstIngestBody.flashcards.length >= 1, "the first ingest of the idempotency-key session generates flashcards");

  const retryIngestRes = await fetch(`${base}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Idempotency check", transcript: idemTranscript, idempotencyKey: idemKey }),
  });
  assert.equal(retryIngestRes.status, 201);
  const retryIngestBody = await retryIngestRes.json();
  assert.equal(retryIngestBody.session.id, firstIngestBody.session.id, "retrying POST /sessions with the same idempotencyKey returns the original session id");
  assert.deepEqual(
    retryIngestBody.flashcards.map((c: { id: string }) => c.id).sort(),
    firstIngestBody.flashcards.map((c: { id: string }) => c.id).sort(),
    "retrying does not mint new/duplicate flashcard ids"
  );
  console.log("✓ POST /sessions with a repeated idempotencyKey returns the original session/flashcards instead of duplicating them");

  const sessionAfterRetry = await (await fetch(`${base}/sessions/${firstIngestBody.session.id}`)).json();
  assert.equal(
    sessionAfterRetry.flashcards.length,
    firstIngestBody.flashcards.length,
    "the session's stored flashcard count is unaffected by the idempotent retry (no duplicates were persisted)"
  );
  console.log("✓ idempotent retries leave no duplicate flashcards behind in storage");

  // --- Feature 2: leech detection ---
  const leechIngestRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Leech test", transcript: "Entropy is a measure of disorder in a system." }),
    })
  ).json();
  assert.ok(leechIngestRes.flashcards.length >= 1, "the leech-test session generates at least one flashcard");
  const leechCard = leechIngestRes.flashcards[0];
  assert.equal(leechCard.isLeech, false, "a freshly generated card is not a leech");
  assert.equal(leechCard.consecutiveFailures, 0, "a freshly generated card has zero consecutive failures");

  let lastLeechReview: { isLeech: boolean; consecutiveFailures: number } | undefined;
  for (let i = 0; i < LEECH_THRESHOLD; i++) {
    const r = await fetch(`${base}/review/${leechCard.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ grade: "again" }),
    });
    lastLeechReview = await r.json();
  }
  assert.equal(lastLeechReview!.consecutiveFailures, LEECH_THRESHOLD);
  assert.equal(lastLeechReview!.isLeech, true, `a card should be flagged a leech after ${LEECH_THRESHOLD} consecutive "again" grades`);
  console.log(`✓ a card failing ("again") ${LEECH_THRESHOLD} times in a row is flagged isLeech: true`);

  const leechesRes = await (await fetch(`${base}/review/leeches`)).json();
  assert.ok(leechesRes.some((c: { id: string }) => c.id === leechCard.id), "GET /review/leeches surfaces the flagged card");
  console.log("✓ GET /review/leeches surfaces cards flagged as leeches");

  const clearedRes = await (
    await fetch(`${base}/review/${leechCard.id}`, { method: "POST", headers, body: JSON.stringify({ grade: "good" }) })
  ).json();
  assert.equal(clearedRes.isLeech, false, "a single 'good' grade clears the leech flag");
  assert.equal(clearedRes.consecutiveFailures, 0, "a single 'good' grade resets the failure streak");
  console.log('✓ a single "good" grade clears the leech flag and resets the failure streak');

  const leechesAfterClear = await (await fetch(`${base}/review/leeches`)).json();
  assert.ok(!leechesAfterClear.some((c: { id: string }) => c.id === leechCard.id), "cleared card no longer appears in the leech list");
  console.log("✓ GET /review/leeches no longer lists a card once its leech flag is cleared");

  // --- Feature 3: topic tagging + search across separate sessions ---
  const topicSessionA = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Cell biology deep dive",
        transcript:
          "Ribosome is the cellular structure that synthesizes proteins. Ribosome activity increases during growth. What is a ribosome? Ribosome function is essential for protein synthesis.",
      }),
    })
  ).json();
  const topicSessionB = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Protein synthesis review",
        transcript:
          "The ribosome reads messenger RNA to build proteins. Ribosome structure includes two subunits. Ribosome complexes are found throughout the cytoplasm.",
      }),
    })
  ).json();
  assert.ok(
    topicSessionA.session.topics.length >= 1 && topicSessionA.session.topics.length <= 3,
    "each session gets 1-3 heuristic topic tags"
  );
  console.log("✓ POST /sessions extracts 1-3 heuristic topic tags per session, attached to its flashcards");

  const searchRes = await (await fetch(`${base}/flashcards/search?topic=ribosome`)).json();
  const searchSessionIds = new Set(searchRes.map((c: { sessionId: string }) => c.sessionId));
  assert.ok(searchRes.length >= 2, "the topic search finds flashcards from the topic");
  assert.ok(
    searchSessionIds.has(topicSessionA.session.id) && searchSessionIds.has(topicSessionB.session.id),
    "GET /flashcards/search?topic= finds matching flashcards across two different sessions"
  );
  console.log(`✓ GET /flashcards/search?topic=ribosome finds flashcards across ${searchSessionIds.size} separate sessions`);

  const emptySearchRes = await fetch(`${base}/flashcards/search`);
  assert.equal(emptySearchRes.status, 400, "a missing ?topic= query parameter is rejected with a 400");
  console.log("✓ GET /flashcards/search without a topic query parameter returns a clean 400");

  const directTopics = extractTopics([{ text: "Ribosome is important. Ribosome makes proteins. Ribosome ribosome ribosome." }]);
  assert.ok(directTopics.includes("ribosome"), "extractTopics: the most frequent content word becomes a topic tag");
  console.log("✓ topics.ts: direct unit check of the extractTopics frequency heuristic");

  // --- Feature 4: adaptive review ordering ---
  const orderingIngestRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Ordering test",
        transcript: [
          { text: "Valence is the combining power of an atom." },
          { text: "What is valence?" },
          { text: "It is the number of electrons an atom can lose gain or share." },
          { text: "Isotopes are atoms of the same element with different neutron counts." },
          { text: "What are isotopes?" },
          { text: "They are atoms with the same proton count but different neutron counts." },
        ],
      }),
    })
  ).json();
  assert.ok(orderingIngestRes.flashcards.length >= 2, "the ordering-test session yields at least two flashcards");
  const [orderCardA, orderCardB] = orderingIngestRes.flashcards;

  // Fail card A three times in a row to make it a leech (also drags its ease factor down).
  for (let i = 0; i < LEECH_THRESHOLD; i++) {
    await fetch(`${base}/review/${orderCardA.id}`, { method: "POST", headers, body: JSON.stringify({ grade: "again" }) });
  }
  const refreshedOrderSession = await (await fetch(`${base}/sessions/${orderingIngestRes.session.id}`)).json();
  const refreshedOrderCardA = refreshedOrderSession.flashcards.find((c: { id: string }) => c.id === orderCardA.id);
  assert.equal(refreshedOrderCardA.isLeech, true, "card A is now a leech");

  // Card B is left untouched (never reviewed): still due immediately, baseline ease factor.
  // listDueCards is the same pure function GET /review/due delegates to (with an
  // injectable "now") — call it directly with a fixed future "now" far enough out that
  // both cards are due again (card A's post-failure interval is only 1 day) so we can
  // observe the actual ordering it produces without sleeping the test for real days.
  const futureNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const dueLater = listDueCards(futureNow);
  const idxA = dueLater.findIndex((c) => c.id === orderCardA.id);
  const idxB = dueLater.findIndex((c) => c.id === orderCardB.id);
  assert.ok(idxA !== -1 && idxB !== -1, "both cards are due once enough time has passed");
  assert.ok(idxA < idxB, "a leech card is ranked ahead of a non-leech card even though both are due");
  console.log("✓ GET /review/due's ordering (listDueCards) ranks a leech/harder card ahead of an equally-due non-leech card");

  // --- Feature 5: streaming/incremental ingestion ---
  const streamInitial = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Streaming lecture",
        transcript: [
          { text: "Diffusion is the movement of molecules from high to low concentration." },
          { text: "What is diffusion?" },
          { text: "It is passive movement of particles down a concentration gradient." },
        ],
      }),
    })
  ).json();
  const initialCardCount = streamInitial.flashcards.length;
  assert.ok(initialCardCount >= 1, "the streaming-test session's initial batch yields flashcards");

  const patchRes = await fetch(`${base}/sessions/${streamInitial.session.id}/segments`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      segments: [
        { text: "Active transport is the movement of molecules against a concentration gradient using energy." },
        { text: "What is active transport?" },
        { text: "It is movement against the gradient that requires ATP." },
      ],
    }),
  });
  assert.equal(patchRes.status, 200);
  const patchBody = await patchRes.json();
  assert.ok(patchBody.newFlashcards.length >= 1, "appending new segments generates at least one new flashcard");
  console.log(`✓ PATCH /sessions/:id/segments generates ${patchBody.newFlashcards.length} new flashcard(s) from just the appended material`);

  const afterPatch = await (await fetch(`${base}/sessions/${streamInitial.session.id}`)).json();
  assert.equal(
    afterPatch.flashcards.length,
    initialCardCount + patchBody.newFlashcards.length,
    "no duplicate flashcards were created for the segments that were already processed"
  );
  const originalIds = new Set(streamInitial.flashcards.map((c: { id: string }) => c.id));
  assert.ok(
    [...originalIds].every((id) => afterPatch.flashcards.some((c: { id: string }) => c.id === id)),
    "the original flashcards are preserved after the append"
  );
  console.log("✓ appending segments via PATCH does not duplicate flashcards already generated from earlier segments");

  assert.ok(afterPatch.session.segments.length > streamInitial.session.segments.length, "the session's segment list grows after an append");
  assert.ok(afterPatch.session.summary.includes("Active transport"), "the session summary is updated to reflect the fuller transcript");
  console.log("✓ PATCH /sessions/:id/segments updates the session's segment list and summary to reflect the fuller transcript");

  const missingPatchRes = await fetch(`${base}/sessions/not-a-real-session-id/segments`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ segments: "more text" }),
  });
  assert.equal(missingPatchRes.status, 404);
  console.log("✓ PATCH /sessions/:id/segments for an unknown session id returns a clean 404");

  // --- Feature 6: portable export ---
  const exportRes = await fetch(`${base}/sessions/${streamInitial.session.id}/export`);
  assert.equal(exportRes.status, 200);
  const exportText = await exportRes.text();
  const exportLines = exportText.trim().split("\n");
  assert.equal(exportLines[0], "front\tback\ttags", "the export has a header row with front/back/tags columns");
  assert.equal(exportLines.length - 1, afterPatch.flashcards.length, "the export has exactly one row per flashcard in the session");
  assert.equal(exportLines[1].split("\t").length, 3, "each export row has exactly three tab-separated columns");
  console.log(`✓ GET /sessions/:id/export returns a well-formed TSV (header + ${exportLines.length - 1} row(s))`);

  const globalExportRes = await fetch(`${base}/export`);
  assert.equal(globalExportRes.status, 200);
  const globalExportText = await globalExportRes.text();
  assert.ok(globalExportText.startsWith("front\tback\ttags"), "the global export also has the header row");
  console.log("✓ GET /export returns a global TSV export of flashcards across every session");

  const missingExportRes = await fetch(`${base}/sessions/not-a-real-session-id/export`);
  assert.equal(missingExportRes.status, 404);
  console.log("✓ GET /sessions/:id/export for an unknown session id returns a clean 404");

  // --- Direct unit-style checks: leech state machine ---
  let leechState = initialLeechState();
  for (let i = 0; i < LEECH_THRESHOLD - 1; i++) {
    leechState = updateLeechState(leechState, "again");
    assert.equal(leechState.isLeech, false, "not yet flagged before the threshold is reached");
  }
  leechState = updateLeechState(leechState, "again");
  assert.equal(leechState.isLeech, true, `becomes a leech at exactly ${LEECH_THRESHOLD} consecutive failures`);
  leechState = updateLeechState(leechState, "good");
  assert.deepEqual(leechState, { consecutiveFailures: 0, isLeech: false }, "a 'good' grade clears the leech flag and resets the streak");
  console.log("✓ leech.ts: direct unit checks of the leech state machine");

  // --- Direct unit-style checks: priority-score formula ---
  const priorityNow = new Date("2026-01-10T00:00:00.000Z");
  const overdueNotLeech = priorityScore(
    { dueAt: new Date(priorityNow.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(), isLeech: false, easeFactor: 2.5 },
    priorityNow
  );
  const barelyDueLeech = priorityScore({ dueAt: priorityNow.toISOString(), isLeech: true, easeFactor: 2.5 }, priorityNow);
  assert.ok(barelyDueLeech > overdueNotLeech, "the leech bonus outweighs several days of plain overdue-ness");
  const lowEaseCard = priorityScore({ dueAt: priorityNow.toISOString(), isLeech: false, easeFactor: 1.3 }, priorityNow);
  const baselineEaseCard = priorityScore({ dueAt: priorityNow.toISOString(), isLeech: false, easeFactor: 2.5 }, priorityNow);
  assert.ok(lowEaseCard > baselineEaseCard, "a lower ease factor (historically harder card) increases priority");
  console.log("✓ priority.ts: direct unit checks of the priority-score formula");

  // ===================================================================
  // Round 3: quiz mode, shared decks, reminders, adaptive generation bias
  // ===================================================================

  // --- Feature 7: shared study-group decks ---
  const deckSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Shared genetics deck",
        shared: true,
        transcript: [
          { text: "Meiosis is the process of cell division that produces gametes." },
          { text: "What is meiosis?" },
          { text: "Meiosis produces four genetically unique haploid cells." },
        ],
      }),
    })
  ).json();
  assert.equal(deckSessionRes.session.shared, true, "a session ingested with shared: true is marked shared");
  assert.ok(deckSessionRes.flashcards.length >= 1, "the shared-deck session generates at least one flashcard");
  const sharedCard = deckSessionRes.flashcards[0];
  console.log("✓ POST /sessions accepts shared: true and stores it on the session");

  // Joining a non-shared session is rejected.
  const notSharedSessionRes = await (
    await fetch(`${base}/sessions`, { method: "POST", headers, body: JSON.stringify({ title: "Private", transcript: "Homeostasis keeps internal conditions stable." }) })
  ).json();
  const joinNotSharedRes = await fetch(`${base}/decks/${notSharedSessionRes.session.id}/join`, {
    method: "POST",
    headers,
    body: JSON.stringify({ studentId: "someone" }),
  });
  assert.equal(joinNotSharedRes.status, 400, "joining a session that isn't marked shared is rejected with a 400");
  console.log("✓ POST /decks/:sessionId/join rejects a session that wasn't ingested with shared: true");

  const joinMissingSessionRes = await fetch(`${base}/decks/not-a-real-session-id/join`, {
    method: "POST",
    headers,
    body: JSON.stringify({ studentId: "someone" }),
  });
  assert.equal(joinMissingSessionRes.status, 404, "joining an unknown session id returns a clean 404");
  console.log("✓ POST /decks/:sessionId/join for an unknown session id returns a clean 404");

  // Two different students join the same shared deck.
  const alice = "alice-deck-student";
  const bob = "bob-deck-student";
  const aliceJoinRes = await fetch(`${base}/decks/${deckSessionRes.session.id}/join`, {
    method: "POST",
    headers,
    body: JSON.stringify({ studentId: alice }),
  });
  assert.equal(aliceJoinRes.status, 200);
  const aliceJoinBody = await aliceJoinRes.json();
  const bobJoinBody = await (
    await fetch(`${base}/decks/${deckSessionRes.session.id}/join`, { method: "POST", headers, body: JSON.stringify({ studentId: bob }) })
  ).json();
  assert.ok(
    aliceJoinBody.cards.some((c: { id: string }) => c.id === sharedCard.id) && bobJoinBody.cards.some((c: { id: string }) => c.id === sharedCard.id),
    "both students' personal decks include the shared card"
  );
  console.log("✓ POST /decks/:sessionId/join pulls the shared session's flashcards into a student's own queue without duplicating content");

  // Alice reviews the shared card well; Bob fails it three times in a row (a leech for him only).
  const aliceReview = await (
    await fetch(`${base}/review/${sharedCard.id}`, { method: "POST", headers, body: JSON.stringify({ grade: "easy", studentId: alice }) })
  ).json();
  let bobReview;
  for (let i = 0; i < LEECH_THRESHOLD; i++) {
    bobReview = await (
      await fetch(`${base}/review/${sharedCard.id}`, { method: "POST", headers, body: JSON.stringify({ grade: "again", studentId: bob }) })
    ).json();
  }
  assert.equal(aliceReview.isLeech, false, "alice's independent progress on the shared card is not a leech");
  assert.equal(bobReview.isLeech, true, "bob's independent progress on the exact same shared card became a leech");
  assert.notEqual(aliceReview.easeFactor, bobReview.easeFactor, "the two students' ease factors on the same card diverge independently");
  console.log("✓ two students reviewing the same shared card independently end up with different ease factors/leech status");

  // The original card's own embedded state is untouched by either student's reviews.
  const sharedSessionAfter = await (await fetch(`${base}/sessions/${deckSessionRes.session.id}`)).json();
  const sharedCardAfter = sharedSessionAfter.flashcards.find((c: { id: string }) => c.id === sharedCard.id);
  assert.equal(sharedCardAfter.repetitions, 0, "the underlying flashcard's own embedded review state is untouched by per-student reviews");
  assert.equal(sharedCardAfter.isLeech, false, "the underlying flashcard's own embedded state never becomes a leech from a student's personal reviews");
  console.log("✓ per-student review state never mutates the shared flashcard's own embedded scheduling/leech fields");

  // GET /review/leeches?studentId= is scoped per student.
  const bobLeeches = await (await fetch(`${base}/review/leeches?studentId=${bob}`)).json();
  const aliceLeeches = await (await fetch(`${base}/review/leeches?studentId=${alice}`)).json();
  const globalLeeches = await (await fetch(`${base}/review/leeches`)).json();
  assert.ok(bobLeeches.some((c: { id: string }) => c.id === sharedCard.id), "GET /review/leeches?studentId=bob includes bob's leeched shared card");
  assert.ok(!aliceLeeches.some((c: { id: string }) => c.id === sharedCard.id), "GET /review/leeches?studentId=alice does not include it");
  assert.ok(!globalLeeches.some((c: { id: string }) => c.id === sharedCard.id), "the unscoped GET /review/leeches does not include it either");
  console.log("✓ GET /review/leeches?studentId= scopes leech visibility to one student's own deck");

  // --- Feature 8: quiz/practice-test mode ---
  const quizSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Capitals quiz deck",
        shared: true,
        transcript: [
          { text: "What is the capital of France?" },
          { text: "Paris is the capital of France." },
          { text: "What is the capital of Japan?" },
          { text: "Tokyo is the capital of Japan." },
          { text: "What is the capital of Italy?" },
          { text: "Rome is the capital of Italy." },
        ],
      }),
    })
  ).json();
  assert.ok(quizSessionRes.flashcards.length >= 3, "the quiz-test session yields at least 3 flashcards to sample from");
  const backByCardId = new Map<string, string>(quizSessionRes.flashcards.map((c: { id: string; back: string }) => [c.id, c.back]));

  const quizStudent = "quiz-student-1";
  await fetch(`${base}/decks/${quizSessionRes.session.id}/join`, { method: "POST", headers, body: JSON.stringify({ studentId: quizStudent }) });

  const quizStartRes = await fetch(`${base}/quiz/start`, { method: "POST", headers, body: JSON.stringify({ count: 3, studentId: quizStudent }) });
  assert.equal(quizStartRes.status, 201);
  const quiz = await quizStartRes.json();
  assert.equal(quiz.cards.length, 3, "POST /quiz/start samples exactly the requested count of cards");
  assert.ok(
    quiz.cards.every((c: { front?: string; back?: string }) => typeof c.front === "string" && c.back === undefined),
    "quiz cards expose the prompt (front) but withhold the answer (back) until graded"
  );
  console.log(`✓ POST /quiz/start samples exactly ${quiz.cards.length} card(s) into a new timed quiz`);

  const [q1, q2, q3] = quiz.cards;
  const correctAnswerRes = await fetch(`${base}/quiz/${quiz.id}/answer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cardId: q1.cardId, answer: `  ${backByCardId.get(q1.cardId)!.toUpperCase()}  ` }),
  });
  assert.equal(correctAnswerRes.status, 200);
  const correctAnswerBody = await correctAnswerRes.json();
  assert.equal(correctAnswerBody.correct, true, "an answer matching the card's back (modulo case/whitespace) is graded correct");
  console.log("✓ POST /quiz/:id/answer grades a correct (case/whitespace-insensitive) answer as correct");

  const wrongAnswerBody = await (
    await fetch(`${base}/quiz/${quiz.id}/answer`, { method: "POST", headers, body: JSON.stringify({ cardId: q2.cardId, answer: "definitely not it" }) })
  ).json();
  assert.equal(wrongAnswerBody.correct, false, "an answer that doesn't match the card's back is graded incorrect");
  console.log("✓ POST /quiz/:id/answer grades an incorrect answer as incorrect");

  const midQuizResults = await (await fetch(`${base}/quiz/${quiz.id}/results`)).json();
  assert.equal(midQuizResults.total, 3);
  assert.equal(midQuizResults.answered, 2);
  assert.equal(midQuizResults.correct, 1);
  assert.equal(midQuizResults.complete, false, "results are available mid-quiz and report complete: false before every card is answered");
  assert.equal(midQuizResults.missed.length, 1, "results list exactly the missed card(s) so far");
  assert.equal(midQuizResults.missed[0].cardId, q2.cardId);
  console.log("✓ GET /quiz/:id/results reports a correct partial score summary mid-quiz, including which cards were missed");

  await fetch(`${base}/quiz/${quiz.id}/answer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cardId: q3.cardId, answer: backByCardId.get(q3.cardId) }),
  });
  const finalResults = await (await fetch(`${base}/quiz/${quiz.id}/results`)).json();
  assert.equal(finalResults.answered, 3);
  assert.equal(finalResults.correct, 2);
  assert.equal(finalResults.complete, true, "results report complete: true once every sampled card has been answered");
  console.log("✓ GET /quiz/:id/results reports complete: true and the final score once every card is answered");

  const answerUnknownCardRes = await fetch(`${base}/quiz/${quiz.id}/answer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cardId: "not-a-card-in-this-quiz", answer: "whatever" }),
  });
  assert.equal(answerUnknownCardRes.status, 400, "answering a card that isn't part of the quiz returns a 400");
  console.log("✓ POST /quiz/:id/answer rejects a cardId that isn't part of the quiz");

  const answerUnknownQuizRes = await fetch(`${base}/quiz/not-a-real-quiz-id/answer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cardId: q1.cardId, answer: "x" }),
  });
  assert.equal(answerUnknownQuizRes.status, 404, "answering into an unknown quiz id returns a clean 404");
  const resultsUnknownQuizRes = await fetch(`${base}/quiz/not-a-real-quiz-id/results`);
  assert.equal(resultsUnknownQuizRes.status, 404, "fetching results for an unknown quiz id returns a clean 404");
  console.log("✓ quiz endpoints return clean 404s for an unknown quiz id");

  // A quiz with no studentId samples from the shared, student-less pool (there are plenty of cards by now).
  const anonymousQuizRes = await (await fetch(`${base}/quiz/start`, { method: "POST", headers, body: JSON.stringify({ count: 2 }) })).json();
  assert.equal(anonymousQuizRes.cards.length, 2, "POST /quiz/start without a studentId samples from the shared default pool");
  console.log("✓ POST /quiz/start without a studentId still samples the requested count from the shared card pool");

  // --- Feature 9: due-card reminder digest ---
  const digestSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Cell biology reminders deck",
        shared: true,
        transcript: [
          { text: "Mitochondria is the powerhouse of the cell." },
          { text: "What produces ATP in a cell?" },
          { text: "The mitochondria produces ATP through respiration." },
        ],
      }),
    })
  ).json();
  assert.equal(digestSessionRes.flashcards.length, 2, "the reminders-test session yields exactly two flashcards");

  const reminderStudent = "reminder-student-1";
  const digestJoinBody = await (
    await fetch(`${base}/decks/${digestSessionRes.session.id}/join`, { method: "POST", headers, body: JSON.stringify({ studentId: reminderStudent }) })
  ).json();
  assert.equal(digestJoinBody.cards.length, 2);

  const freshDigestRes = await fetch(`${base}/reminders/digest?studentId=${reminderStudent}`);
  assert.equal(freshDigestRes.status, 200);
  const freshDigest = await freshDigestRes.json();
  assert.equal(freshDigest.counts.due, 2, "both freshly-joined cards are immediately due");
  assert.equal(freshDigest.counts.dueLeeches, 0, "no leeches yet");
  assert.equal(freshDigest.summary, "You have 2 cards due today.", "the digest summary reflects the actual due count with no leech clause");
  console.log(`✓ GET /reminders/digest reflects actual due counts: "${freshDigest.summary}"`);

  // Make the second card a leech for this student.
  const [digestCardA, digestCardB] = digestJoinBody.cards;
  for (let i = 0; i < LEECH_THRESHOLD; i++) {
    await fetch(`${base}/review/${digestCardB.id}`, { method: "POST", headers, body: JSON.stringify({ grade: "again", studentId: reminderStudent }) });
  }

  // Grading pushes dueAt at least a day into the future (SM-2's minimum interval),
  // so — same documented pattern as the adaptive-ordering test above — call
  // getReminderDigest directly with an injected future "now" to observe the
  // digest once both cards are due again, rather than sleeping the test for real days.
  const digestFutureNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const leechDigest = getReminderDigest(reminderStudent, digestFutureNow);
  assert.equal(leechDigest.counts.due, 2, "both cards are due again once enough time has passed");
  assert.equal(leechDigest.counts.dueLeeches, 1, "exactly one of the due cards is a leech");
  assert.equal(leechDigest.counts.totalLeeches, 1);
  assert.equal(leechDigest.summary, "You have 2 cards due today, including 1 leech.", "the digest summary mentions the leech count in a voice-assistant-friendly sentence");
  console.log(`✓ getReminderDigest reflects leech counts once a card becomes a leech: "${leechDigest.summary}"`);

  const missingStudentDigestRes = await fetch(`${base}/reminders/digest`);
  assert.equal(missingStudentDigestRes.status, 400, "GET /reminders/digest without a studentId returns a clean 400");
  console.log("✓ GET /reminders/digest without a studentId query parameter returns a clean 400");

  // --- Feature 10: adaptive new-card generation bias ---
  // Establish "weak-glyco-student" as historically weak on the "glycolysis" topic:
  // ingest a glycolysis-tagged session, then fail its card three times in a row.
  const weakTopicSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Glycolysis basics",
        transcript: [
          { text: "Glycolysis is the process of breaking down glucose to release energy." },
          { text: "What is glycolysis?" },
          { text: "Glycolysis converts glucose into pyruvate and produces ATP." },
        ],
      }),
    })
  ).json();
  assert.ok(weakTopicSessionRes.session.topics.includes("glycolysis"), "the glycolysis-heavy session is tagged with the glycolysis topic");
  const weakGlycoStudent = "weak-glyco-student";
  for (let i = 0; i < LEECH_THRESHOLD; i++) {
    await fetch(`${base}/review/${weakTopicSessionRes.flashcards[0].id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ grade: "again", studentId: weakGlycoStudent }),
    });
  }

  // Plain statement sentences about glycolysis that don't match the Q&A or
  // "X is Y" definition tiers, so — absent the bias — regenerating over the
  // full transcript yields zero *new* cards (the fallback cloze tier never
  // fires because the session already has cards from its initial ingest).
  const glycolysisAppend = [
    { text: "Glycolysis also helps regulate blood sugar levels during exercise." },
    { text: "Muscle cells increasingly turn to glycolysis when oxygen grows scarce." },
    { text: "Excess lactate from glycolysis can contribute to muscle fatigue." },
  ];

  // Control: a fresh session + a student with zero review history appends the exact same content.
  const controlSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Meiosis basics (control)",
        transcript: [
          { text: "Meiosis is the process of cell division that produces gametes." },
          { text: "What is meiosis?" },
          { text: "Meiosis produces four genetically unique haploid cells." },
        ],
      }),
    })
  ).json();
  const freshStudent = "fresh-no-history-student";
  const controlPatchBody = await (
    await fetch(`${base}/sessions/${controlSessionRes.session.id}/segments`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ segments: glycolysisAppend, studentId: freshStudent }),
    })
  ).json();
  assert.equal(controlPatchBody.newFlashcards.length, 0, "appending plain statements with no weak-topic history yields zero new cards (no Q&A/definition match, fallback tier already spent)");
  console.log("✓ control: appending non-Q&A/definition statements with a student who has no weak-topic history generates zero new cards");

  // Biased: the same append, on the student's own glycolysis session, with their studentId.
  const biasedPatchRes = await fetch(`${base}/sessions/${weakTopicSessionRes.session.id}/segments`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ segments: glycolysisAppend, studentId: weakGlycoStudent }),
  });
  assert.equal(biasedPatchRes.status, 200);
  const biasedPatchBody = await biasedPatchRes.json();
  assert.ok(
    biasedPatchBody.newFlashcards.length > controlPatchBody.newFlashcards.length,
    "appending the same content for a student who is historically weak on the touched topic generates more new cards than the control"
  );
  assert.ok(
    biasedPatchBody.newFlashcards.every((c: { front: string }) => c.front.startsWith("Fill in the blank:")),
    "the bias-generated cards are the documented extra simple cloze-deletion cards"
  );
  console.log(
    `✓ PATCH /sessions/:id/segments with a studentId weak on the touched topic generates ${biasedPatchBody.newFlashcards.length} extra card(s) vs. ${controlPatchBody.newFlashcards.length} for the control`
  );

  // --- Feature 11: study streaks & gamification ---
  // Join a shared deck for a dedicated streak-test student, then simulate reviews on
  // three consecutive days (2026-01-01 through 2026-01-03) by calling
  // recordReviewForStudent directly with an injected "now" — the same documented
  // pattern used above for the priority-ordering and reminder-digest tests, since
  // POST /review/:cardId has no way to backdate a review over HTTP.
  const streakSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Streak test deck",
        shared: true,
        transcript: [
          { text: "What is osmosis?" },
          { text: "Osmosis is the diffusion of water across a semi-permeable membrane." },
        ],
      }),
    })
  ).json();
  const streakStudent = "streak-student-1";
  const streakJoinBody = await (
    await fetch(`${base}/decks/${streakSessionRes.session.id}/join`, { method: "POST", headers, body: JSON.stringify({ studentId: streakStudent }) })
  ).json();
  const streakCardId = streakJoinBody.cards[0].id;

  const day1 = new Date("2026-01-01T09:00:00.000Z");
  const day2 = new Date("2026-01-02T09:00:00.000Z");
  const day3 = new Date("2026-01-03T09:00:00.000Z");
  const day3Again = new Date("2026-01-03T20:00:00.000Z"); // same UTC day, later — must not double-count
  const day5 = new Date("2026-01-05T09:00:00.000Z"); // day 4 is skipped

  recordReviewForStudent(streakStudent, streakCardId, "good", day1);
  const afterDay1 = await (await fetch(`${base}/students/${streakStudent}/streak`)).json();
  assert.equal(afterDay1.currentStreak, 1, "one review on day one starts a 1-day streak");
  assert.equal(afterDay1.longestStreak, 1);
  assert.deepEqual(afterDay1.badges, [], "no milestone badge yet after a single day");
  console.log("✓ GET /students/:studentId/streak reports a 1-day streak after the first day's review");

  recordReviewForStudent(streakStudent, streakCardId, "good", day2);
  const afterDay2 = await (await fetch(`${base}/students/${streakStudent}/streak`)).json();
  assert.equal(afterDay2.currentStreak, 2, "a review on the very next day extends the streak");
  assert.equal(afterDay2.longestStreak, 2);

  recordReviewForStudent(streakStudent, streakCardId, "good", day3);
  recordReviewForStudent(streakStudent, streakCardId, "easy", day3Again); // same calendar day: must not double-count
  const afterDay3 = await (await fetch(`${base}/students/${streakStudent}/streak`)).json();
  assert.equal(afterDay3.currentStreak, 3, "three consecutive days of review produce a 3-day streak (a second same-day review doesn't inflate it)");
  assert.equal(afterDay3.longestStreak, 3);
  assert.deepEqual(afterDay3.badges, ["3-day-streak"], "reaching a 3-day streak earns exactly the 3-day badge");
  console.log(`✓ a scripted sequence of reviews across 3 simulated consecutive days produces currentStreak=3 and the "3-day-streak" badge`);

  recordReviewForStudent(streakStudent, streakCardId, "good", day5);
  const afterMissedDay = await (await fetch(`${base}/students/${streakStudent}/streak`)).json();
  assert.equal(afterMissedDay.currentStreak, 1, "a missed day (day 4) resets the current streak back to 1");
  assert.equal(afterMissedDay.longestStreak, 3, "the longest-streak record survives a reset");
  assert.deepEqual(afterMissedDay.badges, ["3-day-streak"], "an already-earned badge is never revoked after the streak resets");
  console.log("✓ a missed day resets the current streak but leaves the longest-streak record and earned badges intact");

  const freshStreak = await (await fetch(`${base}/students/never-reviewed-student/streak`)).json();
  assert.equal(freshStreak.currentStreak, 0, "a student with no review history has a zero streak rather than an error");
  assert.deepEqual(freshStreak.badges, []);
  console.log("✓ GET /students/:studentId/streak for a student with no history returns a valid zero-streak summary, not an error");

  // --- Feature 12: global daily review session planner ---
  // Two separate shared decks, both joined by the same student, so their due cards
  // must be pooled together and capped rather than served deck-by-deck.
  const plannerDeckARes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Planner deck A",
        shared: true,
        transcript: [
          { text: "What is diffusion?" },
          { text: "Diffusion is the net movement of molecules from high to low concentration." },
          { text: "What is entropy?" },
          { text: "Entropy is a measure of disorder in a thermodynamic system." },
        ],
      }),
    })
  ).json();
  const plannerDeckBRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Planner deck B",
        shared: true,
        transcript: [
          { text: "What is inertia?" },
          { text: "Inertia is the tendency of an object to resist a change in motion." },
          { text: "What is velocity?" },
          { text: "Velocity is the speed of an object in a given direction." },
        ],
      }),
    })
  ).json();
  assert.ok(plannerDeckARes.flashcards.length >= 2 && plannerDeckBRes.flashcards.length >= 2, "both planner decks yield at least two cards each");

  const plannerStudent = "planner-student-1";
  await fetch(`${base}/decks/${plannerDeckARes.session.id}/join`, { method: "POST", headers, body: JSON.stringify({ studentId: plannerStudent }) });
  await fetch(`${base}/decks/${plannerDeckBRes.session.id}/join`, { method: "POST", headers, body: JSON.stringify({ studentId: plannerStudent }) });

  const totalAcrossBothDecks = plannerDeckARes.flashcards.length + plannerDeckBRes.flashcards.length;
  const sessionCap = 3;
  const sessionPlanRes = await fetch(`${base}/review/session?studentId=${plannerStudent}&maxCards=${sessionCap}`);
  assert.equal(sessionPlanRes.status, 200);
  const sessionPlan = await sessionPlanRes.json();
  assert.equal(sessionPlan.cards.length, sessionCap, "GET /review/session caps the returned cards at maxCards");
  assert.equal(sessionPlan.totalDue, totalAcrossBothDecks, "totalDue reports every due card across every joined deck, uncapped");
  assert.ok(sessionPlan.totalDue > sessionPlan.cards.length, "there are more due cards overall than fit in this capped session");
  const distinctSessionIds = new Set(sessionPlan.cards.map((c: { sessionId: string }) => c.sessionId));
  assert.ok(distinctSessionIds.size >= 2, "the capped session pulls cards from multiple decks, not just the first one joined");
  console.log(`✓ GET /review/session pools due cards across ${distinctSessionIds.size} joined decks and caps them at maxCards=${sessionCap} (of ${sessionPlan.totalDue} total due)`);

  const sessionPlanFull = await (await fetch(`${base}/review/session?studentId=${plannerStudent}&maxCards=1000`)).json();
  assert.equal(sessionPlanFull.cards.length, totalAcrossBothDecks, "a maxCards larger than what's due simply returns everything due, uncapped in practice");
  console.log("✓ GET /review/session returns every due card when maxCards exceeds the total due");

  const missingStudentSessionRes = await fetch(`${base}/review/session?maxCards=5`);
  assert.equal(missingStudentSessionRes.status, 400, "GET /review/session without a studentId returns a clean 400");
  const missingMaxCardsRes = await fetch(`${base}/review/session?studentId=${plannerStudent}`);
  assert.equal(missingMaxCardsRes.status, 400, "GET /review/session without maxCards returns a clean 400");
  console.log("✓ GET /review/session validates that both studentId and maxCards are required");

  // --- Feature 13: import round-trip (the inverse of GET /export) ---
  // Use a dedicated, freshly-ingested session (rather than the accumulated global
  // /export, whose rows can legitimately repeat front-text across unrelated earlier
  // test sections) so the exact row count is known and the round-trip is deterministic.
  const importSourceRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Import round-trip source",
        transcript: [
          { text: "What is homeostasis?" },
          { text: "Homeostasis is the maintenance of a stable internal environment." },
          { text: "What is a neuron?" },
          { text: "A neuron is a specialized cell that transmits electrical signals." },
        ],
      }),
    })
  ).json();
  assert.ok(importSourceRes.flashcards.length >= 2, "the import-source session yields at least two flashcards");

  const exportedTsv = await (await fetch(`${base}/sessions/${importSourceRes.session.id}/export`)).text();
  const exportedRowCount = exportedTsv.trim().split("\n").length - 1; // minus the header row
  assert.equal(exportedRowCount, importSourceRes.flashcards.length, "the exported TSV has exactly one row per flashcard in this session");

  const importRes = await fetch(`${base}/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tsv: exportedTsv, title: "Restored from backup" }),
  });
  assert.equal(importRes.status, 201);
  const importBody = await importRes.json();
  assert.equal(importBody.imported.length, exportedRowCount, "importing a fresh export into a brand-new session creates exactly one flashcard per exported row");
  assert.equal(importBody.skippedDuplicates, 0, "nothing is a duplicate yet in a brand-new session");
  assert.ok(
    importBody.imported.every((c: { interval: number; repetitions: number }) => c.interval === 0 && c.repetitions === 0),
    "imported cards start with fresh scheduling state (a TSV export carries no review history)"
  );
  console.log(`✓ POST /import creates ${importBody.imported.length} flashcard(s) from a TSV in the exact format GET /export produces`);

  // Re-importing the very same TSV into the same session must not duplicate any cards.
  const reImportRes = await fetch(`${base}/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tsv: exportedTsv, sessionId: importBody.session.id }),
  });
  assert.equal(reImportRes.status, 201);
  const reImportBody = await reImportRes.json();
  assert.equal(reImportBody.imported.length, 0, "re-importing an already-imported export creates zero new cards");
  assert.equal(reImportBody.skippedDuplicates, exportedRowCount, "every row is recognized as a front-text duplicate of an existing card");
  console.log("✓ POST /import deduplicates by front-text against a session's existing cards, so re-importing the same export is a safe no-op");

  // A single import batch with an internal duplicate row also collapses to one card —
  // dedup applies within the batch itself, not just against a session's pre-existing cards.
  const duplicateRowTsv = "front\tback\ttags\nWhat is ATP?\tAdenosine triphosphate.\tbiology\nWhat is ATP?\tAdenosine triphosphate.\tbiology\nWhat is DNA?\tDeoxyribonucleic acid.\tbiology\n";
  const batchDedupeRes = await fetch(`${base}/import`, { method: "POST", headers, body: JSON.stringify({ tsv: duplicateRowTsv }) });
  assert.equal(batchDedupeRes.status, 201);
  const batchDedupeBody = await batchDedupeRes.json();
  assert.equal(batchDedupeBody.imported.length, 2, "two distinct front-texts in the batch produce two cards");
  assert.equal(batchDedupeBody.skippedDuplicates, 1, "a repeated front-text row within the same import batch is skipped as a duplicate");
  console.log("✓ POST /import also deduplicates by front-text within a single import batch, not only against a session's pre-existing cards");

  const importMissingSessionRes = await fetch(`${base}/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tsv: exportedTsv, sessionId: "not-a-real-session-id" }),
  });
  assert.equal(importMissingSessionRes.status, 404, "importing into an unknown sessionId returns a clean 404");
  const importMissingTsvRes = await fetch(`${base}/import`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(importMissingTsvRes.status, 400, "importing without a tsv body returns a clean 400");
  console.log("✓ POST /import returns clean errors for an unknown sessionId and a missing tsv body");

  // --- Feature 14: regenerate-a-card ---
  const regenSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Regenerate test deck",
        transcript: [
          { speaker: "Alice", text: "What is the powerhouse of the cell?" },
          { speaker: "Bob", text: "The mitochondria is the powerhouse of the cell." },
        ],
      }),
    })
  ).json();
  const regenCard = regenSessionRes.flashcards.find((c: { front: string }) => c.front === "What is the powerhouse of the cell?");
  assert.ok(regenCard, "the Q&A tier generated the expected original card");

  // Put the card through a real review first, so it has non-default scheduling/leech
  // state to verify survives regeneration untouched.
  const regenAfterReviewBody = await (
    await fetch(`${base}/review/${regenCard.id}`, { method: "POST", headers, body: JSON.stringify({ grade: "good" }) })
  ).json();
  assert.ok(regenAfterReviewBody.interval > 0 && regenAfterReviewBody.repetitions === 1, "the card has real (non-default) review state before regenerating it");

  const regenerateRes = await fetch(`${base}/flashcards/${regenCard.id}/regenerate`, { method: "POST" });
  assert.equal(regenerateRes.status, 200);
  const regenerated = await regenerateRes.json();
  assert.equal(regenerated.id, regenCard.id, "regeneration replaces the card in place rather than creating a new one");
  assert.notEqual(regenerated.front, regenAfterReviewBody.front, "regeneration produces a different front (alternative phrasing)");
  assert.notEqual(regenerated.back, regenAfterReviewBody.back, "regeneration produces a different back to match the new front");
  assert.equal(regenerated.interval, regenAfterReviewBody.interval, "regeneration leaves the card's interval untouched");
  assert.equal(regenerated.easeFactor, regenAfterReviewBody.easeFactor, "regeneration leaves the card's ease factor untouched");
  assert.equal(regenerated.dueAt, regenAfterReviewBody.dueAt, "regeneration leaves the card's due date untouched");
  assert.equal(regenerated.repetitions, regenAfterReviewBody.repetitions, "regeneration leaves the card's repetition count untouched");
  assert.equal(regenerated.isLeech, regenAfterReviewBody.isLeech, "regeneration leaves the card's leech status untouched");
  console.log(
    `✓ POST /flashcards/:cardId/regenerate rewrote "${regenAfterReviewBody.front}" -> "${regenerated.front}" while leaving review-state (interval, easeFactor, dueAt) untouched`
  );

  const regenMissingCardRes = await fetch(`${base}/flashcards/not-a-real-card-id/regenerate`, { method: "POST" });
  assert.equal(regenMissingCardRes.status, 404, "regenerating an unknown card id returns a clean 404");
  console.log("✓ POST /flashcards/:cardId/regenerate for an unknown card id returns a clean 404");

  // ===================================================================
  // Round 5: concept graph, Feynman mode, study guide synthesis, readiness
  // ===================================================================

  // --- Feature 15: concept graph ---
  // Two separate sessions, ingested independently, that both discuss the
  // same underlying term via genuinely different card phrasings — one a
  // "What is X?" definition-style card, the other a generic Q&A pair whose
  // question doesn't start with "what is" at all — so the only thing linking
  // them is real text analysis of their own content, not a shared tag either
  // session was ingested with.
  const conceptSessionA = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Cell energy lecture",
        transcript: [
          { text: "What is Mitochondrion?" },
          { text: "Mitochondrion is the organelle that produces ATP for the cell." },
        ],
      }),
    })
  ).json();
  const conceptSessionB = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Biology review (unrelated deck)",
        transcript: [
          { text: "What does Mitochondrion do?" },
          { text: "Mitochondrion converts nutrients into usable energy for the cell." },
        ],
      }),
    })
  ).json();
  assert.ok(conceptSessionA.flashcards.length >= 1 && conceptSessionB.flashcards.length >= 1, "both concept-graph test sessions generate at least one flashcard");

  const conceptRes = await fetch(`${base}/concepts/mitochondrion`);
  assert.equal(conceptRes.status, 200);
  const conceptBody = await conceptRes.json();
  assert.equal(conceptBody.concept, "mitochondrion");
  const conceptSessionIds = new Set(conceptBody.cards.map((c: { sessionId: string }) => c.sessionId));
  assert.ok(
    conceptSessionIds.has(conceptSessionA.session.id) && conceptSessionIds.has(conceptSessionB.session.id),
    "GET /concepts/:name links cards from two entirely separate sessions/decks that reference the same concept, with no manual tag connecting them"
  );
  console.log(`✓ GET /concepts/mitochondrion finds cards across ${conceptSessionIds.size} separate sessions purely from card content`);

  const conceptCaseInsensitiveRes = await (await fetch(`${base}/concepts/Mitochondrion`)).json();
  assert.equal(conceptCaseInsensitiveRes.cards.length, conceptBody.cards.length, "concept lookup is case-insensitive");
  console.log("✓ GET /concepts/:name is case-insensitive");

  const unknownConceptRes = await fetch(`${base}/concepts/not-a-real-concept-xyz`);
  assert.equal(unknownConceptRes.status, 200, "an unrecognized concept returns an empty result, not an error (the concept space isn't a stored resource)");
  const unknownConceptBody = await unknownConceptRes.json();
  assert.deepEqual(unknownConceptBody.cards, []);
  console.log("✓ GET /concepts/:name for a concept no card resolves to returns a clean empty list");

  // Direct unit checks of extractConceptsFromCard's three tiers.
  assert.deepEqual(
    extractConceptsFromCard({ front: "What is Osmoregulation?", back: "It maintains fluid balance." }),
    ["osmoregulation"],
    "a 'What is X?' front yields the defined term as the concept"
  );
  assert.deepEqual(
    extractConceptsFromCard({ front: "Fill in the blank: Osmosis is the movement of ____ across a membrane.", back: "water" }),
    ["water"],
    "a cloze card yields its blanked answer as the concept"
  );
  const genericConcepts = extractConceptsFromCard({ front: "What does photosynthesis produce?", back: "It produces glucose and oxygen." });
  assert.ok(genericConcepts.length >= 1 && genericConcepts.length <= 2, "a generic Q&A card yields 1-2 concepts from shared significant words");
  assert.ok(conceptsMatch("Photosynthesis", "photosynthesis") && !conceptsMatch("photosynthesis", "osmosis"), "conceptsMatch is case-insensitive but not a fuzzy match");
  console.log("✓ conceptGraph.ts: direct unit checks of extractConceptsFromCard's definition/cloze/generic tiers");

  // --- Feature 16: Feynman/peer-teaching explanation mode ---
  const explainSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Feynman test deck",
        transcript: [
          { text: "What is Osmoregulation?" },
          { text: "Osmoregulation is the process of maintaining fluid and electrolyte balance in an organism." },
        ],
      }),
    })
  ).json();
  assert.ok(explainSessionRes.flashcards.length >= 1, "the Feynman-test session yields at least one flashcard");
  const explainCard = explainSessionRes.flashcards[0];

  // A solid, in-your-own-words explanation covering most of the answer's key terms.
  const goodExplainRes = await fetch(`${base}/review/${explainCard.id}/explain`, {
    method: "POST",
    headers,
    body: JSON.stringify({ explanation: "Osmoregulation is the process that keeps an organism's fluid and electrolyte balance steady." }),
  });
  assert.equal(goodExplainRes.status, 200);
  const goodExplainBody = await goodExplainRes.json();
  assert.equal(goodExplainBody.passed, true, "an explanation covering most key terms passes the rubric");
  assert.ok(goodExplainBody.score >= 0.5 && goodExplainBody.score <= 1, "the coverage score is a fraction between 0 and 1");
  assert.ok(["good", "easy"].includes(goodExplainBody.grade), "a passing explanation maps to a good/easy recall grade");
  assert.ok(goodExplainBody.matchedTerms.includes("osmoregulation"), "matchedTerms reports the specific key terms the explanation covered");
  assert.ok(goodExplainBody.feedback.length > 0, "the response includes plain-language feedback");
  assert.ok(goodExplainBody.card.interval > 0, "a passing explanation reschedules the card exactly like a normal passing grade would");
  console.log(`✓ POST /review/:cardId/explain grades a solid explanation as "${goodExplainBody.grade}" (score ${goodExplainBody.score.toFixed(2)}) and reschedules the card`);

  // A poor explanation, submitted three times in a row for one student, should behave
  // exactly like three consecutive "again" grades — including becoming a leech.
  const feynmanStudent = "feynman-student-1";
  let lastExplain: { passed: boolean; grade: string; card: { isLeech: boolean; consecutiveFailures: number } } | undefined;
  for (let i = 0; i < LEECH_THRESHOLD; i++) {
    const r = await fetch(`${base}/review/${explainCard.id}/explain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ explanation: "I don't remember what this is about.", studentId: feynmanStudent }),
    });
    lastExplain = await r.json();
  }
  assert.equal(lastExplain!.passed, false, "an explanation covering none of the key terms fails the rubric");
  assert.equal(lastExplain!.grade, "again");
  assert.equal(lastExplain!.card.isLeech, true, `failing the explanation ${LEECH_THRESHOLD} times in a row flags the card a leech, exactly like a normal "again" streak would`);
  assert.equal(lastExplain!.card.consecutiveFailures, LEECH_THRESHOLD);
  console.log(`✓ POST /review/:cardId/explain with a poor explanation ${LEECH_THRESHOLD}x in a row flags the card as a leech, reusing the exact same leech state machine as normal grading`);

  const clearExplainRes = await (
    await fetch(`${base}/review/${explainCard.id}/explain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ explanation: "Osmoregulation is the process that keeps an organism's fluid and electrolyte balance steady.", studentId: feynmanStudent }),
    })
  ).json();
  assert.equal(clearExplainRes.card.isLeech, false, "a subsequent solid explanation clears the leech flag");
  assert.equal(clearExplainRes.card.consecutiveFailures, 0);
  console.log("✓ a solid explanation after a leeched streak clears the leech flag, same as a normal good/easy grade would");

  const missingExplanationRes = await fetch(`${base}/review/${explainCard.id}/explain`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(missingExplanationRes.status, 400, "submitting without an explanation returns a clean 400");
  const explainMissingCardRes = await fetch(`${base}/review/not-a-real-card-id/explain`, {
    method: "POST",
    headers,
    body: JSON.stringify({ explanation: "whatever" }),
  });
  assert.equal(explainMissingCardRes.status, 404, "explaining an unknown card id returns a clean 404");
  console.log("✓ POST /review/:cardId/explain returns clean errors for a missing explanation and an unknown card id");

  // Direct unit checks of the grading rubric itself.
  const directGoodGrade = gradeExplanation("Mitochondria produces ATP through cellular respiration.", "The mitochondria makes ATP using cellular respiration processes.");
  assert.ok(directGoodGrade.score > 0.5 && directGoodGrade.matchedTerms.includes("mitochondria"));
  const directBadGrade = gradeExplanation("Mitochondria produces ATP through cellular respiration.", "It's a cell part.");
  assert.equal(directBadGrade.score, 0);
  assert.equal(scoreToRecallGrade(0), "again");
  assert.equal(scoreToRecallGrade(1), "easy");
  console.log("✓ explainGrader.ts: direct unit checks of the key-term coverage rubric and score-to-grade mapping");

  // --- Feature 17: cross-session study guide synthesis ---
  // Reuses topicSessionA/topicSessionB from Feature 3 above — two separate
  // sessions already tagged "ribosome" — to prove the guide merges real
  // stored sessions, not just synthetic fixtures.
  const guideRes = await fetch(`${base}/topics/ribosome/study-guide`);
  assert.equal(guideRes.status, 200);
  const guide = await guideRes.json();
  assert.equal(guide.topic, "ribosome");
  assert.equal(guide.sessionCount, 2, "the study guide covers exactly the two sessions tagged 'ribosome'");
  const guideSessionIds = new Set(guide.sessions.map((s: { id: string }) => s.id));
  assert.ok(guideSessionIds.has(topicSessionA.session.id) && guideSessionIds.has(topicSessionB.session.id));
  assert.equal(guide.cardCount, topicSessionA.flashcards.length + topicSessionB.flashcards.length, "cardCount is the sum of both sessions' flashcards");
  assert.ok(guide.concepts.length > 0, "the guide reports the union of concepts covered across both sessions");
  assert.ok(guide.combinedSummary.length > 0);
  const guideSentences = guide.combinedSummary
    .split(/(?<=[.?!])\s+/)
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);
  assert.equal(new Set(guideSentences).size, guideSentences.length, "the merged summary has no duplicate sentences");
  console.log(`✓ GET /topics/ribosome/study-guide merges ${guide.sessionCount} sessions into one deduplicated guide with ${guide.concepts.length} concept(s)`);

  const missingGuideRes = await fetch(`${base}/topics/not-a-real-topic-xyz/study-guide`);
  assert.equal(missingGuideRes.status, 404, "requesting a study guide for a topic no session is tagged with returns a clean 404");
  console.log("✓ GET /topics/:topic/study-guide for an unused topic returns a clean 404");

  // Direct unit check of the actual dedup mechanism: two synthetic sessions whose
  // summaries share one verbatim sentence must contribute it to the guide once.
  const fakeSessionX = {
    id: "fake-session-x",
    title: "X",
    createdAt: new Date().toISOString(),
    segments: [],
    summary: "Session covered 3 statement(s) across 1 speaker(s). Water boils at 100 degrees Celsius. Ice melts at 0 degrees Celsius.",
    topics: ["thermo-fixture"],
    shared: false,
  };
  const fakeSessionY = {
    id: "fake-session-y",
    title: "Y",
    createdAt: new Date().toISOString(),
    segments: [],
    summary: "Session covered 2 statement(s). Water boils at 100 degrees Celsius. Steam is water vapor.",
    topics: ["thermo-fixture"],
    shared: false,
  };
  const fakeCard = (id: string, sessionId: string, front: string, back: string) => ({
    id,
    sessionId,
    front,
    back,
    createdAt: new Date().toISOString(),
    tags: ["thermo-fixture"],
    interval: 0,
    easeFactor: 2.5,
    repetitions: 0,
    dueAt: new Date().toISOString(),
    consecutiveFailures: 0,
    isLeech: false,
  });
  const directGuide = buildStudyGuide(
    "thermo-fixture",
    [fakeSessionX, fakeSessionY],
    new Map([
      ["fake-session-x", [fakeCard("fx1", "fake-session-x", "What is Water?", "Water is a molecule made of hydrogen and oxygen.")]],
      ["fake-session-y", [fakeCard("fy1", "fake-session-y", "What is Steam?", "Steam is water vapor produced by boiling.")]],
    ])
  );
  const waterBoilsOccurrences = (directGuide.combinedSummary.match(/Water boils at 100 degrees Celsius\./g) ?? []).length;
  assert.equal(waterBoilsOccurrences, 1, "a sentence repeated verbatim across two sessions' summaries appears exactly once in the merged guide");
  assert.ok(directGuide.combinedSummary.includes("Ice melts at 0 degrees Celsius.") && directGuide.combinedSummary.includes("Steam is water vapor."));
  assert.ok(directGuide.concepts.includes("water") && directGuide.concepts.includes("steam"));
  console.log("✓ studyGuide.ts: direct unit check proving verbatim-duplicate sentences across sessions are merged, not concatenated twice");

  // --- Feature 18: exam readiness score ---
  const readinessSessionRes = await (
    await fetch(`${base}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Thermogenesis basics",
        transcript: [
          { text: "What is Thermogenesis?" },
          { text: "Thermogenesis is the process of heat production in an organism." },
          { text: "What triggers thermogenesis?" },
          { text: "Cold exposure and diet can trigger thermogenesis." },
        ],
      }),
    })
  ).json();
  assert.ok(readinessSessionRes.flashcards.length >= 2, "the readiness-test session yields at least two flashcards");
  assert.ok(readinessSessionRes.session.topics.includes("thermogenesis"), "the readiness-test session is tagged with the thermogenesis topic");

  // Unscoped, fresh, ungraded: a real HTTP round trip against the live server/clock —
  // safe here because nothing depends on future scheduling (freshly generated cards
  // are due right now regardless of exactly when "now" is evaluated).
  const freshReadinessRes = await fetch(`${base}/topics/thermogenesis/readiness`);
  assert.equal(freshReadinessRes.status, 200);
  const freshReadiness = await freshReadinessRes.json();
  assert.equal(freshReadiness.topic, "thermogenesis");
  assert.equal(freshReadiness.cardCount, readinessSessionRes.flashcards.length);
  assert.equal(freshReadiness.dueCount, readinessSessionRes.flashcards.length, "freshly generated cards are all immediately due");
  assert.equal(freshReadiness.notDueFraction, 0);
  assert.ok(freshReadiness.reasons.includes("no review history yet"));
  assert.ok(freshReadiness.reasons.includes("no active study streak"));
  console.log(`✓ GET /topics/:topic/readiness reports a low score (${freshReadiness.score}/100) for a freshly-ingested, ungraded topic, with plain-language reasons why`);

  // Scoped to a student with good recent grades and an active streak: grading pushes
  // dueAt/streak state relative to an injected "now", which (like the adaptive-ordering
  // and streak tests above) would drift arbitrarily from the real wall clock by the
  // time an HTTP request used the real "now" — so call getTopicReadiness directly with
  // the same fixed "now", the same documented pattern used throughout this file.
  const readinessStudent = "readiness-student-good";
  const [readinessCardA, readinessCardB] = readinessSessionRes.flashcards;
  const readinessNow = new Date("2026-02-10T09:00:00.000Z");
  recordReviewForStudent(readinessStudent, readinessCardA.id, "good", new Date("2026-02-08T09:00:00.000Z"));
  recordReviewForStudent(readinessStudent, readinessCardA.id, "good", new Date("2026-02-09T09:00:00.000Z"));
  recordReviewForStudent(readinessStudent, readinessCardA.id, "good", readinessNow);
  recordReviewForStudent(readinessStudent, readinessCardB.id, "good", readinessNow);

  const goodReadiness = getTopicReadiness("thermogenesis", readinessStudent, readinessNow);
  assert.equal(goodReadiness.cardCount, 2);
  assert.equal(goodReadiness.dueCount, 0, "every card was just graded 'good', so none are due right at readinessNow");
  assert.equal(goodReadiness.notDueFraction, 1);
  assert.ok(goodReadiness.recentPerformance > 0.5, "recent 'good' grades push recentPerformance above the neutral 0.5 baseline");
  assert.equal(goodReadiness.streakDays, 3, "three simulated consecutive days of review produce a 3-day streak, folded into the score");
  assert.ok(
    goodReadiness.score > freshReadiness.score,
    "a student with good recent grades, nothing due, and an active streak scores higher than a freshly-ingested, ungraded topic"
  );
  assert.ok(!goodReadiness.reasons.includes("no active study streak"));
  console.log(`✓ getTopicReadiness(studentId=...) reports a higher score (${goodReadiness.score}/100) once a student has good grades, nothing due, and a streak`);

  // A different student who has leeched one of the same topic's cards sees that named explicitly.
  const readinessLeechStudent = "readiness-student-leech";
  for (let i = 0; i < LEECH_THRESHOLD; i++) {
    recordReviewForStudent(readinessLeechStudent, readinessCardA.id, "again", readinessNow);
  }
  const leechReadiness = getTopicReadiness("thermogenesis", readinessLeechStudent, readinessNow);
  assert.equal(leechReadiness.leechCount, 1);
  assert.ok(leechReadiness.reasons.some((r: string) => r.includes("leech")), "the breakdown names the unresolved leech as a specific drag on the score");
  console.log(`✓ getTopicReadiness surfaces an unresolved leech as an explicit reason: ${JSON.stringify(leechReadiness.reasons)}`);

  const unknownTopicReadinessRes = await fetch(`${base}/topics/not-a-real-topic-xyz/readiness`);
  assert.equal(unknownTopicReadinessRes.status, 200, "a topic nobody tagged a session with still returns a valid response, not an error");
  const unknownTopicReadiness = await unknownTopicReadinessRes.json();
  assert.equal(unknownTopicReadiness.score, 0);
  assert.ok(unknownTopicReadiness.reasons.length > 0);
  console.log("✓ GET /topics/:topic/readiness for a topic with zero cards returns a valid zero score with an explanatory reason, not an error");

  // Direct unit check of the composite formula on fully synthetic input, independent of the store.
  const emptyReadiness = computeReadiness([], 0);
  assert.equal(emptyReadiness.score, 0);
  const strongReadiness = computeReadiness(
    [{ dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), isLeech: false, lastGrade: "easy", lastReviewedAt: new Date().toISOString() }],
    7
  );
  assert.equal(strongReadiness.score, 100, "a not-due, perfectly-graded card with a maxed-out streak scores a perfect 100");
  console.log("✓ readiness.ts: direct unit checks of computeReadiness's weighted formula at both extremes");

  httpServer.close();
  console.log("\nAll StudyLoop smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
