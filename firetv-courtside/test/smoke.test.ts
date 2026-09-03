/**
 * End-to-end smoke test: starts the CourtSide server on an ephemeral port
 * with a real HTTP client (fetch), and drives the golden path — start a
 * game, ingest several play-by-play events, confirm commentary and score
 * tracking, ask a viewer question — plus several edge cases. Run with
 * `npm test`.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
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

  // ======================================================================
  // Round 3 features: game archive & highlights, outbound score-alert
  // subscriptions (signed + retried + rate-capped), multi-game watchlist.
  // ======================================================================

  // --- 7. Game archive & highlights: reuses isNotableEvent — only notable
  // events show up, both for a game still in progress and after it ends. ---
  const highlightGame = (await postJson("/games", { homeTeam: "Nuggets", awayTeam: "Timberwolves" })).body;

  await postJson(`/games/${highlightGame.id}/events`, { type: "rebound", team: "home", player: "Gobert" }); // routine
  const goAhead = await postJson(`/games/${highlightGame.id}/events`, { type: "score", team: "home", points: 2 }); // notable: 0-0 -> lead
  assert.equal(goAhead.body.path, "escalated");
  await postJson(`/games/${highlightGame.id}/events`, { type: "foul", team: "away", description: "reaching-in foul" }); // routine
  const flagrant = await postJson(`/games/${highlightGame.id}/events`, {
    type: "foul",
    team: "away",
    description: "flagrant foul, hard contact",
  }); // notable
  assert.equal(flagrant.body.path, "escalated");

  const highlightsInProgress = await (await fetch(`${base}/games/${highlightGame.id}/highlights`)).json();
  assert.equal(highlightsInProgress.status, "in_progress");
  assert.equal(highlightsInProgress.highlights.length, 2, "only the 2 notable events should appear, not the 2 routine ones");
  assert.equal(highlightsInProgress.highlights[0].event.id, flagrant.body.event.id, "highlights are newest-first");
  console.log("✓ GET /games/:id/highlights returns only notable events (highlights-so-far) while a game is still in progress");

  const gameEndRes = await postJson(`/games/${highlightGame.id}/events`, { type: "game_end" });
  assert.equal(gameEndRes.body.path, "escalated", "game_end always escalates/is notable");

  const highlightsFinal = await (await fetch(`${base}/games/${highlightGame.id}/highlights`)).json();
  assert.equal(highlightsFinal.status, "final");
  assert.equal(highlightsFinal.highlights.length, 3, "game_end joins the highlight reel once the game ends");
  assert.equal(highlightsFinal.highlights[0].event.type, "game_end");
  console.log("✓ GET /games/:id/highlights includes game_end and reflects final status once the game has ended");

  const missingHighlights = await fetch(`${base}/games/does-not-exist/highlights`);
  assert.equal(missingHighlights.status, 404);
  console.log("✓ GET /games/:id/highlights for an unknown game returns a clean 404 error");

  // --- Helpers for the webhook-subscription tests below: a tiny local HTTP
  // listener standing in for a client's registered callback endpoint. ---
  interface WebhookHit {
    headers: http.IncomingHttpHeaders;
    body: string;
  }
  function startWebhookListener(): Promise<{ port: number; received: WebhookHit[]; close: () => Promise<void> }> {
    const received: WebhookHit[] = [];
    return new Promise((resolve) => {
      const listener = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        });
      });
      listener.listen(0, "127.0.0.1", () => {
        const { port } = listener.address() as AddressInfo;
        resolve({ port, received, close: () => new Promise((r) => listener.close(() => r())) });
      });
    });
  }
  async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor(): condition never became true within the timeout");
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // --- 8. Outbound score-alert subscriptions: a registered webhook gets a
  // correctly HMAC-signed POST the moment a notable event is ingested — and
  // never for a routine one. ---
  const subGame = (await postJson("/games", { homeTeam: "Thunder", awayTeam: "Rockets" })).body;
  const webhook = await startWebhookListener();

  const subscribeRes = await postJson(`/games/${subGame.id}/subscriptions`, {
    callbackUrl: `http://127.0.0.1:${webhook.port}/alerts`,
    viewerId: "sub-viewer",
  });
  assert.equal(subscribeRes.status, 201);
  assert.equal(subscribeRes.body.duplicate, false);
  const { subscription } = subscribeRes.body;
  assert.ok(subscription.id);
  assert.ok(subscription.secret, "the registration response must expose the signing secret");
  console.log("✓ POST /games/:id/subscriptions registers a webhook and returns its id + signing secret");

  const notableForWebhook = await postJson(`/games/${subGame.id}/events`, {
    type: "foul",
    team: "away",
    player: "Sengun",
    description: "flagrant foul, hard contact",
  });
  assert.equal(notableForWebhook.body.path, "escalated");

  await waitFor(() => webhook.received.length >= 1);
  assert.equal(webhook.received.length, 1, "exactly the one notable event should have fired a delivery so far");
  const delivered = webhook.received[0];
  const sigHeader = String(delivered.headers["x-courtside-signature"] ?? "");
  assert.match(sigHeader, /^sha256=[0-9a-f]{64}$/, "the signature header should be a hex-encoded sha256 HMAC");
  const expectedSig = createHmac("sha256", subscription.secret).update(delivered.body).digest("hex");
  assert.equal(sigHeader, `sha256=${expectedSig}`, "the receiver must be able to verify the payload with the returned secret");
  const deliveredPayload = JSON.parse(delivered.body);
  assert.equal(deliveredPayload.type, "notable_event");
  assert.equal(deliveredPayload.gameId, subGame.id);
  assert.equal(deliveredPayload.event.id, notableForWebhook.body.event.id);
  console.log("✓ a notable event triggers a webhook POST correctly HMAC-SHA256-signed, verifiable with the returned secret");

  await postJson(`/games/${subGame.id}/events`, { type: "rebound", team: "home", player: "Holmgren" }); // routine
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(webhook.received.length, 1, "a routine (non-notable) event must not trigger a webhook delivery");
  console.log("✓ routine events do not trigger score-alert webhook deliveries, only notable ones do");

  // --- 9. Idempotent subscription registration: the same callbackUrl for
  // the same game is a no-op, not a second subscription. ---
  const duplicateSubscribeRes = await postJson(`/games/${subGame.id}/subscriptions`, {
    callbackUrl: `http://127.0.0.1:${webhook.port}/alerts`,
  });
  assert.equal(duplicateSubscribeRes.status, 200);
  assert.equal(duplicateSubscribeRes.body.duplicate, true);
  assert.equal(
    duplicateSubscribeRes.body.subscription.id,
    subscription.id,
    "re-registering the same callbackUrl must return the original subscription, not a new one"
  );
  assert.equal(duplicateSubscribeRes.body.subscription.secret, subscription.secret);
  console.log("✓ POST /games/:id/subscriptions is idempotent — the same callbackUrl for the same game never creates a duplicate");

  const badSubscribeRes = await postJson(`/games/${subGame.id}/subscriptions`, {});
  assert.equal(badSubscribeRes.status, 400);
  console.log("✓ registering a subscription with no callbackUrl is rejected with 400");

  // --- 10. Per-subscription rate cap: a burst of notable events beyond the
  // cap is dropped for that subscription rather than flooding the receiver. ---
  const rateCapGame = (await postJson("/games", { homeTeam: "Wolves", awayTeam: "Grizzlies" })).body;
  const rateCapWebhook = await startWebhookListener();

  const rateCapSubscribeRes = await postJson(`/games/${rateCapGame.id}/subscriptions`, {
    callbackUrl: `http://127.0.0.1:${rateCapWebhook.port}/alerts`,
  });
  assert.equal(rateCapSubscribeRes.status, 201);

  const BURST_SIZE = 8; // deliberately > the 5/min per-subscription cap
  for (let i = 0; i < BURST_SIZE; i++) {
    const res = await postJson(`/games/${rateCapGame.id}/events`, {
      type: "foul",
      team: "home",
      description: "flagrant foul, hard contact", // always notable, regardless of score state — keeps the burst simple
    });
    assert.equal(res.body.path, "escalated");
  }

  await new Promise((r) => setTimeout(r, 400)); // let every not-dropped delivery land
  assert.equal(
    rateCapWebhook.received.length,
    5,
    `subscription should receive only the rate-capped 5 of ${BURST_SIZE} notable-event alerts, the rest dropped`
  );
  console.log("✓ a burst of notable events beyond the per-subscription rate cap (5/min) is dropped, not flooding the receiver");

  const rateCapHighlights = await (await fetch(`${base}/games/${rateCapGame.id}/highlights`)).json();
  assert.equal(
    rateCapHighlights.highlights.length,
    BURST_SIZE,
    "the delivery rate cap must only drop webhook alerts — the archived highlight history keeps every notable event"
  );
  console.log("✓ the webhook rate cap never drops events from the highlight/archive history, only excess deliveries");

  await webhook.close();
  await rateCapWebhook.close();

  // --- 11. Multi-game watchlist: aggregates notable events across every
  // game a viewer has interacted with, newest-first across games. ---
  const wlGameA = (await postJson("/games", { homeTeam: "Bucks", awayTeam: "Pacers" })).body;
  const wlGameB = (await postJson("/games", { homeTeam: "Knicks", awayTeam: "76ers" })).body;
  const wlViewer = "watchlist-viewer";

  // Interacting via a question on game A, and via preferences on game B —
  // both count, per spec ("asked a question on, or set preferences for").
  await postJson(`/games/${wlGameA.id}/ask`, { question: "what's the score?", viewerId: wlViewer });
  await postJson(`/games/${wlGameB.id}/viewers/${wlViewer}/preferences`, { verbosity: "detailed" });

  const wlEventA = await postJson(`/games/${wlGameA.id}/events`, { type: "foul", team: "away", description: "technical foul" });
  assert.equal(wlEventA.body.path, "escalated");
  await new Promise((r) => setTimeout(r, 5)); // guarantee a distinct, later occurredAt for the ordering assertion below
  const wlEventB = await postJson(`/games/${wlGameB.id}/events`, { type: "foul", team: "home", description: "flagrant foul" });
  assert.equal(wlEventB.body.path, "escalated");

  const watchlistRes = await fetch(`${base}/watchlist?viewerId=${wlViewer}`);
  assert.equal(watchlistRes.status, 200);
  const watchlist = await watchlistRes.json();
  assert.equal(watchlist.gameIds.length, 2);
  assert.ok(watchlist.gameIds.includes(wlGameA.id) && watchlist.gameIds.includes(wlGameB.id));
  assert.equal(watchlist.highlights.length, 2, "the watchlist should include the one notable event from each of the viewer's two games");
  assert.equal(watchlist.highlights[0].event.id, wlEventB.body.event.id, "watchlist entries are newest-first across games");
  assert.equal(watchlist.highlights[0].gameId, wlGameB.id);
  assert.equal(watchlist.highlights[1].event.id, wlEventA.body.event.id);
  console.log("✓ GET /watchlist?viewerId=... aggregates notable events across every game the viewer interacted with, newest-first");

  const emptyWatchlistRes = await fetch(`${base}/watchlist?viewerId=nobody-yet`);
  assert.equal(emptyWatchlistRes.status, 200);
  const emptyWatchlist = await emptyWatchlistRes.json();
  assert.equal(emptyWatchlist.gameIds.length, 0);
  assert.equal(emptyWatchlist.highlights.length, 0);
  console.log("✓ GET /watchlist?viewerId=... for a viewer with no interactions yet returns an empty (not error) watchlist");

  const missingViewerWatchlist = await fetch(`${base}/watchlist`);
  assert.equal(missingViewerWatchlist.status, 400);
  console.log("✓ GET /watchlist with no viewerId is rejected with 400");

  httpServer.close();
  console.log("\nAll CourtSide smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
