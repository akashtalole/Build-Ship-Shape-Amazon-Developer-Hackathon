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

  httpServer.close();
  console.log("\nAll CourtSide smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
