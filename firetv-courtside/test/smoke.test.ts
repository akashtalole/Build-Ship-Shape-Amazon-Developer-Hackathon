/**
 * End-to-end smoke test: starts the CourtSide server on an ephemeral port
 * with a real HTTP client (fetch), and drives the golden path — start a
 * game, ingest several play-by-play events, confirm commentary and score
 * tracking, ask a viewer question — plus several edge cases. Run with
 * `npm test`.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { TemplateCommentaryProvider } from "../src/commentaryProvider.js";
import { createApp } from "../src/server.js";

async function main() {
  const provider = new TemplateCommentaryProvider();
  const app = createApp(provider);
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function postJson(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  // --- Start tracking a new game ---
  const startRes = await postJson("/games", { homeTeam: "Hawks", awayTeam: "Nets" });
  assert.equal(startRes.status, 201);
  const game = startRes.body;
  assert.equal(game.homeScore, 0);
  assert.equal(game.awayScore, 0);
  assert.equal(game.period, 1);
  assert.equal(game.status, "in_progress");
  console.log("✓ POST /games starts a new game at 0-0, period 1, in_progress");

  // --- Ingest a handful of different event types (the CV/data-feed integration point) ---
  const scoreRes = await postJson(`/games/${game.id}/events`, { type: "score", team: "home", player: "Trae", points: 3 });
  assert.equal(scoreRes.status, 201);
  assert.ok(scoreRes.body.commentary.text.length > 0, "commentary should be generated for a score event");
  assert.match(scoreRes.body.commentary.text, /Trae/);
  console.log("✓ POST /games/:id/events ingests a score event and generates grounded commentary");

  const foulRes = await postJson(`/games/${game.id}/events`, {
    type: "foul",
    team: "away",
    player: "Bridges",
    description: "reaching-in foul",
  });
  assert.equal(foulRes.status, 201);
  assert.match(foulRes.body.commentary.text, /Bridges/);
  console.log("✓ foul event generates commentary referencing the player");

  const turnoverRes = await postJson(`/games/${game.id}/events`, { type: "turnover", team: "home", description: "traveling" });
  assert.equal(turnoverRes.status, 201);

  const secondScoreRes = await postJson(`/games/${game.id}/events`, { type: "score", team: "away", player: "Bridges", points: 2 });
  assert.equal(secondScoreRes.status, 201);
  console.log("✓ ingested 4 events of different types (score, foul, turnover, score) without error");

  // --- State reflects the score ---
  const stateRes = await fetch(`${base}/games/${game.id}/state`);
  const state = await stateRes.json();
  assert.equal(state.homeScore, 3);
  assert.equal(state.awayScore, 2);
  assert.equal(state.recentEvents.length, 4);
  console.log("✓ GET /games/:id/state reflects the running score (3-2) and recent events");

  // --- Commentary list is newest-first ---
  const commentaryRes = await fetch(`${base}/games/${game.id}/commentary`);
  const commentary = await commentaryRes.json();
  assert.equal(commentary.length, 4);
  assert.match(commentary[0].text, /Bridges/); // the most recent event (second score) narrates Bridges
  assert.ok(
    new Date(commentary[0].createdAt).getTime() >= new Date(commentary[commentary.length - 1].createdAt).getTime(),
    "commentary should be ordered newest first"
  );
  console.log("✓ GET /games/:id/commentary returns lines newest-first, one per ingested event");

  // --- Ask a question grounded in current state ---
  const askRes = await postJson(`/games/${game.id}/ask`, { question: "what's the score?" });
  assert.equal(askRes.status, 200);
  assert.match(askRes.body.answer, /3/);
  assert.match(askRes.body.answer, /2/);
  console.log("✓ POST /games/:id/ask answers 'what's the score?' grounded in current state (3-2)");

  const whyFoulRes = await postJson(`/games/${game.id}/ask`, { question: "why was that a foul?" });
  assert.match(whyFoulRes.body.answer, /Bridges|reaching-in/);
  console.log("✓ POST /games/:id/ask answers a foul question referencing the actual foul that occurred");

  // --- Edge case: unknown game returns a clean 404, not a crash ---
  const missingState = await fetch(`${base}/games/does-not-exist/state`);
  assert.equal(missingState.status, 404);
  const missingBody = await missingState.json();
  assert.ok(missingBody.error, "a 404 should include a clean error message");
  console.log("✓ GET /games/:id/state for an unknown game returns a clean 404 error");

  const missingAsk = await postJson("/games/does-not-exist/ask", { question: "what's the score?" });
  assert.equal(missingAsk.status, 404);
  console.log("✓ POST /games/:id/ask for an unknown game returns a clean 404 error");

  // --- Edge case: invalid/missing event type is rejected with 400 ---
  const badType = await postJson(`/games/${game.id}/events`, { type: "slam_dunk_of_the_century", team: "home" });
  assert.equal(badType.status, 400);
  assert.ok(badType.body.error, "an invalid event type should include a clean error message");
  console.log("✓ an event with an invalid type is rejected with 400");

  const noType = await postJson(`/games/${game.id}/events`, { team: "home" });
  assert.equal(noType.status, 400);
  console.log("✓ an event with a missing type is rejected with 400");

  // --- Edge case: a score event without points is rejected ---
  const badScore = await postJson(`/games/${game.id}/events`, { type: "score", team: "home" });
  assert.equal(badScore.status, 400);
  console.log("✓ a score event without a positive numeric points field is rejected with 400");

  // --- Edge case: an empty question is rejected ---
  const emptyQuestion = await postJson(`/games/${game.id}/ask`, { question: "" });
  assert.equal(emptyQuestion.status, 400);
  console.log("✓ an empty question is rejected with 400");

  // --- Confirm a rejected event did not get appended to the commentary/event log ---
  const commentaryAfterRejections = await (await fetch(`${base}/games/${game.id}/commentary`)).json();
  assert.equal(commentaryAfterRejections.length, 4, "rejected events must not produce commentary lines");
  console.log("✓ rejected events do not pollute the commentary feed or game state");

  // ======================================================================
  // Advanced features (round 2)
  // ======================================================================

  // --- 1. Live commentary push via SSE: a connected client sees a new
  // commentary line the instant an event is ingested, without polling. ---
  const streamGame = (await postJson("/games", { homeTeam: "Bulls", awayTeam: "Heat" })).body;

  const streamRes = await fetch(`${base}/games/${streamGame.id}/stream`);
  assert.equal(streamRes.status, 200);
  assert.match(String(streamRes.headers.get("content-type")), /text\/event-stream/);

  const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const streamedChunks = (async () => {
    let buffer = "";
    while (!buffer.includes('"commentary"')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  })();

  await postJson(`/games/${streamGame.id}/events`, { type: "score", team: "home", player: "Zach", points: 2 });

  const streamed = await Promise.race([
    streamedChunks,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("SSE stream timed out")), 5000)),
  ]);
  assert.match(streamed, /^data: /m);
  assert.match(streamed, /Zach/);
  await reader.cancel().catch(() => {});
  console.log("✓ GET /games/:id/stream pushes new commentary via SSE the moment an event is ingested");

  // --- 2. Idempotent event ingestion: replaying the same externalEventId
  // is a no-op — no duplicate commentary, no duplicate state mutation. ---
  const idemGame = (await postJson("/games", { homeTeam: "Suns", awayTeam: "Kings" })).body;

  const firstIngest = await postJson(`/games/${idemGame.id}/events`, {
    type: "score",
    team: "home",
    points: 3,
    externalEventId: "cv-play-042",
  });
  assert.equal(firstIngest.status, 201);
  assert.equal(firstIngest.body.duplicate, false);

  const replayIngest = await postJson(`/games/${idemGame.id}/events`, {
    type: "score",
    team: "home",
    points: 3,
    externalEventId: "cv-play-042",
  });
  assert.equal(replayIngest.status, 200);
  assert.equal(replayIngest.body.duplicate, true);
  assert.equal(replayIngest.body.event.id, firstIngest.body.event.id, "a replay returns the original event, not a new one");

  const idemState = await (await fetch(`${base}/games/${idemGame.id}/state`)).json();
  assert.equal(idemState.homeScore, 3, "a replayed externalEventId must not double-apply the score");

  const idemCommentary = await (await fetch(`${base}/games/${idemGame.id}/commentary`)).json();
  assert.equal(idemCommentary.length, 1, "a replayed externalEventId must not produce a second commentary line");
  console.log("✓ POST /games/:id/events with a repeated externalEventId is idempotent (no duplicate state or commentary)");

  // --- 3. Confidence-gated commentary: a routine event takes the fast
  // template path, a notable one (here, a go-ahead score off a 0-0 tie)
  // escalates — reflected in GET /games/:id/metrics. ---
  const metricsGame = (await postJson("/games", { homeTeam: "Magic", awayTeam: "Spurs" })).body;

  const routineRes = await postJson(`/games/${metricsGame.id}/events`, { type: "rebound", team: "home", player: "Wendell" });
  assert.equal(routineRes.body.path, "fast");

  const notableRes = await postJson(`/games/${metricsGame.id}/events`, { type: "score", team: "home", points: 2 });
  assert.equal(notableRes.body.path, "escalated", "a go-ahead score off a tied game should escalate");

  const flagrantRes = await postJson(`/games/${metricsGame.id}/events`, {
    type: "foul",
    team: "away",
    description: "flagrant foul, hard contact",
  });
  assert.equal(flagrantRes.body.path, "escalated", "a flagrant foul should escalate");

  const routineFoulRes = await postJson(`/games/${metricsGame.id}/events`, { type: "foul", team: "away", description: "reaching-in foul" });
  assert.equal(routineFoulRes.body.path, "fast", "a routine foul should stay on the fast path");

  const metricsRes = await fetch(`${base}/games/${metricsGame.id}/metrics`);
  assert.equal(metricsRes.status, 200);
  const metrics = await metricsRes.json();
  assert.equal(metrics.fastPathCount, 2);
  assert.equal(metrics.escalatedCount, 2);
  assert.equal(metrics.total, 4);
  console.log("✓ routine events take the fast template path, notable events escalate, and GET /games/:id/metrics reflects the split (2 fast / 2 escalated)");

  // --- 4. Personalized commentary preferences: a viewer's favoriteTeam and
  // verbosity visibly change both commentary text and Q&A answers. ---
  const prefGame = (await postJson("/games", { homeTeam: "Lakers", awayTeam: "Celtics" })).body;

  const setPrefsRes = await postJson(`/games/${prefGame.id}/viewers/viewer-1/preferences`, {
    favoriteTeam: "Celtics",
    verbosity: "detailed",
  });
  assert.equal(setPrefsRes.status, 200);
  assert.equal(setPrefsRes.body.preferences.favoriteTeam, "Celtics");
  assert.equal(setPrefsRes.body.preferences.verbosity, "detailed");

  await postJson(`/games/${prefGame.id}/events`, { type: "score", team: "away", player: "Tatum", points: 3 });

  const plainCommentary = await (await fetch(`${base}/games/${prefGame.id}/commentary`)).json();
  assert.ok(!/fan view/.test(plainCommentary[0].text), "commentary with no viewerId must stay unpersonalized");

  const personalizedCommentary = await (await fetch(`${base}/games/${prefGame.id}/commentary?viewerId=viewer-1`)).json();
  assert.match(personalizedCommentary[0].text, /Celtics fan view/);
  assert.match(personalizedCommentary[0].text, /remaining/);
  console.log("✓ GET /games/:id/commentary?viewerId=... personalizes text per the viewer's favoriteTeam/verbosity preferences");

  const personalizedAsk = await postJson(`/games/${prefGame.id}/ask`, { question: "what's the score?", viewerId: "viewer-1" });
  assert.equal(personalizedAsk.status, 200);
  assert.match(personalizedAsk.body.answer, /Celtics fan view/);
  console.log("✓ POST /games/:id/ask personalizes its answer for a viewer with stored preferences");

  // --- 5. Resumable commentary feed: ?since=<id> returns only entries newer
  // than a given commentary line, so a reconnecting client can catch up. ---
  const resumeGame = (await postJson("/games", { homeTeam: "Mavs", awayTeam: "Nuggets" })).body;

  await postJson(`/games/${resumeGame.id}/events`, { type: "score", team: "home", points: 2 });
  const afterFirst = await (await fetch(`${base}/games/${resumeGame.id}/commentary`)).json();
  const cursorId = afterFirst[0].id; // the only entry so far

  await postJson(`/games/${resumeGame.id}/events`, { type: "foul", team: "away", description: "reaching-in foul" });
  await postJson(`/games/${resumeGame.id}/events`, { type: "turnover", team: "home" });

  const sinceRes = await fetch(`${base}/games/${resumeGame.id}/commentary?since=${cursorId}`);
  assert.equal(sinceRes.status, 200);
  const sinceBody = await sinceRes.json();
  assert.equal(sinceBody.length, 2, "?since=<id> should return only the entries newer than the cursor");
  assert.ok(
    sinceBody.every((c: { id: string }) => c.id !== cursorId),
    "?since=<id> must not include the cursor entry itself"
  );
  console.log("✓ GET /games/:id/commentary?since=<commentary-id> returns only newer entries (resumable feed)");

  const fullAfterResume = await (await fetch(`${base}/games/${resumeGame.id}/commentary`)).json();
  const timestampCursor = fullAfterResume[fullAfterResume.length - 1].createdAt; // oldest entry's timestamp
  const sinceTimestampRes = await fetch(`${base}/games/${resumeGame.id}/commentary?since=${encodeURIComponent(timestampCursor)}`);
  const sinceTimestampBody = await sinceTimestampRes.json();
  assert.ok(sinceTimestampBody.length <= fullAfterResume.length, "?since=<timestamp> should never return more than the full history");
  console.log("✓ GET /games/:id/commentary?since=<ISO timestamp> is also accepted as a resume cursor");

  // --- 6. Rate limiting on /ask: the 11th rapid question from one viewer in
  // one game is rejected with 429. ---
  const rateLimitGame = (await postJson("/games", { homeTeam: "Warriors", awayTeam: "Clippers" })).body;

  for (let i = 0; i < 10; i++) {
    const res = await postJson(`/games/${rateLimitGame.id}/ask`, { question: "what's the score?", viewerId: "rl-viewer" });
    assert.equal(res.status, 200, `question ${i + 1} of 10 should succeed`);
  }
  const eleventh = await postJson(`/games/${rateLimitGame.id}/ask`, { question: "what's the score?", viewerId: "rl-viewer" });
  assert.equal(eleventh.status, 429);
  assert.ok(eleventh.body.error, "a 429 should include a clear error message");
  console.log("✓ POST /games/:id/ask rate-limits a viewer to 10 questions/minute, returning 429 on the 11th");

  // A different viewer on the same game is unaffected by another viewer's limit.
  const otherViewerAsk = await postJson(`/games/${rateLimitGame.id}/ask`, { question: "what's the score?", viewerId: "rl-viewer-2" });
  assert.equal(otherViewerAsk.status, 200);
  console.log("✓ the rate limit is scoped per viewer (a different viewerId is not affected)");

  httpServer.close();
  console.log("\nAll CourtSide smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
