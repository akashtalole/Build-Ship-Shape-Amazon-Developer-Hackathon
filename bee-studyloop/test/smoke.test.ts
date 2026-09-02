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
import { listDueCards } from "../src/studyService.js";

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

  httpServer.close();
  console.log("\nAll StudyLoop smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
