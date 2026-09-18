/**
 * End-to-end smoke test: starts the PorchPass server on an ephemeral port
 * with a real HTTP client (fetch), and drives the full access-control
 * lifecycle — issue a pass, simulate a Ring doorbell event, check the
 * visitor in, confirm the audit trail and homeowner notification, then
 * exercise expiry, revocation, and single-use enforcement — followed by a
 * second round covering the advanced features: idempotent issuance,
 * recurring passes, webhook signature verification, the real-time SSE
 * event stream, quiet-hours enforcement, and check-in rate limiting — a
 * third round covering multi-device support, outbound webhook notifications,
 * bulk/template pass issuance, and the grace-period extension flow — a
 * fourth round covering visit duration tracking, the traffic/analytics
 * report, household member roles, and encrypted-at-rest visitor PII — and a
 * fifth round covering visitor trust scoring (and trust-gated auto-approval
 * of grace-period extensions), Alexa+ voice-confirmed check-in, geofenced
 * pass activation, and neighborhood alert broadcast.
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { SimulatedRingClient } from "../src/ringClient.js";
import { LoggingNotifier } from "../src/notify.js";
import { getWebhookSecret, signPayload } from "../src/webhookAuth.js";
import { getPassById } from "../src/store.js";
import { decryptField } from "../src/crypto.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function minutesToHHMM(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`;
}

/** Signs a Ring webhook body exactly the way the server verifies it: HMAC-SHA256 over the raw JSON bytes. */
function ringWebhookHeaders(rawBody: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Ring-Signature": signPayload(getWebhookSecret(), rawBody),
  };
}

/** Reads chunks off an SSE reader until a real `event:` frame arrives (skipping the initial comment/heartbeats), or times out. */
async function waitForSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 3000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const read = async (): Promise<string> => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed before an event arrived");
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.startsWith("event:")) return frame;
      }
    }
  };
  return Promise.race([
    read(),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for an SSE event`)), timeoutMs)),
  ]);
}

async function main() {
  const ringClient = new SimulatedRingClient();
  const notifier = new LoggingNotifier();
  const app = createApp(ringClient, notifier);
  const httpServer = app.listen(0);
  const { port } = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // --- Issue a time-boxed, single-use pass ---
  const validUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const issueRes = await fetch(`${base}/passes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitorName: "Alex the Dog Walker", visitorPhone: "+15551234567", validUntil, note: "dog walker" }),
  });
  assert.equal(issueRes.status, 201);
  const pass = await issueRes.json();
  assert.equal(pass.status, "active");
  assert.equal(pass.maxUses, 1);
  assert.match(
    notifier.history().find((n) => n.to === "visitor")?.message ?? "",
    /checkin/,
    "issuing a pass sends the visitor an SMS with a check-in link"
  );
  console.log("✓ issuePass creates an active, single-use pass and SMS's the visitor a check-in link");

  // --- A doorbell "ding" arrives (a signed Ring webhook call), then the visitor checks in via the link ---
  const dingBody = JSON.stringify({ deviceId: "front-door", type: "ding" });
  await fetch(`${base}/ring/events`, { method: "POST", headers: ringWebhookHeaders(dingBody), body: dingBody });

  const checkinPage = await fetch(`${base}/checkin/${pass.checkinToken}`);
  assert.equal(checkinPage.status, 200);
  assert.match(await checkinPage.text(), /I'm here/);
  console.log("✓ GET /checkin/:token serves a no-app-required confirmation page");

  const checkinRes = await fetch(`${base}/checkin/${pass.checkinToken}`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  assert.equal(checkinRes.status, 200);
  const checkinResult = await checkinRes.json();
  assert.equal(checkinResult.ok, true);
  assert.ok(checkinResult.visit.matchedEvent, "check-in should correlate with the recent doorbell event");
  assert.equal(checkinResult.pass.status, "used_up", "a single-use pass is used up after one check-in");
  console.log("✓ checkIn correlates the visit with the recent Ring doorbell event and marks a single-use pass used up");

  const homeownerPing = notifier.history().find((n) => n.to === "homeowner");
  assert.ok(homeownerPing, "checking in notifies the homeowner");
  assert.match(homeownerPing!.message, /snapshot/);
  console.log("✓ homeowner is notified with a link to the correlated doorbell snapshot");

  // --- Audit trail ---
  const visitsRes = await fetch(`${base}/visits`);
  const visits = await visitsRes.json();
  assert.equal(visits.length, 1);
  assert.equal(visits[0].visitorName, "Alex the Dog Walker");
  console.log("✓ GET /visits exposes an audit trail of who came and when");

  // --- A used-up pass can't be reused ---
  const secondAttempt = await fetch(`${base}/checkin/${pass.checkinToken}`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const secondResult = await secondAttempt.json();
  assert.equal(secondResult.ok, false);
  assert.match(secondResult.reason, /already been used/);
  console.log("✓ a used-up single-use pass rejects a second check-in attempt");

  // --- An invalid token is rejected ---
  const badToken = await fetch(`${base}/checkin/not-a-real-token`, { method: "POST", headers: { Accept: "application/json" } });
  const badResult = await badToken.json();
  assert.equal(badResult.ok, false);
  assert.match(badResult.reason, /isn't valid/);
  console.log("✓ an unknown check-in token is rejected");

  // --- Multi-use pass allows repeated check-ins up to the limit ---
  const multiUseUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const multiIssue = await fetch(`${base}/passes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitorName: "Contractor Crew", visitorPhone: "+15559876543", validUntil: multiUseUntil, maxUses: 2 }),
  });
  const multiPass = await multiIssue.json();
  const use1 = await (await fetch(`${base}/checkin/${multiPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })).json();
  const use2 = await (await fetch(`${base}/checkin/${multiPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })).json();
  const use3 = await (await fetch(`${base}/checkin/${multiPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })).json();
  assert.equal(use1.ok, true);
  assert.equal(use1.pass.status, "active");
  assert.equal(use2.ok, true);
  assert.equal(use2.pass.status, "used_up");
  assert.equal(use3.ok, false);
  console.log("✓ a maxUses=2 pass allows exactly two check-ins, then rejects the third");

  // --- Revocation ---
  const revokeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const toRevoke = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Uninvited Guest", visitorPhone: "+15550001111", validUntil: revokeUntil }),
    })
  ).json();
  const revokeRes = await fetch(`${base}/passes/${toRevoke.id}`, { method: "DELETE" });
  assert.equal(revokeRes.status, 200);
  const revoked = await revokeRes.json();
  assert.equal(revoked.status, "revoked");
  const revokedCheckin = await (
    await fetch(`${base}/checkin/${toRevoke.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(revokedCheckin.ok, false);
  assert.match(revokedCheckin.reason, /revoked/);
  console.log("✓ a revoked pass can no longer be used to check in");

  // --- Expiry ---
  const alreadyExpired = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Late Arrival",
        visitorPhone: "+15552223333",
        validFrom: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        validUntil: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    })
  ).json();
  const expiredCheckin = await (
    await fetch(`${base}/checkin/${alreadyExpired.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(expiredCheckin.ok, false);
  assert.match(expiredCheckin.reason, /expired/);
  console.log("✓ a pass past its validUntil window auto-expires instead of granting access");

  // =========================================================================
  // Advanced features
  // =========================================================================

  // --- 1. Idempotency-key protected issuance ---
  const idemKey = "idem-test-key-001";
  const idemUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const visitorSmsCountBefore = notifier.history().filter((n) => n.to === "visitor").length;
  const idemFirst = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Idempotent Ivy", visitorPhone: "+15554440000", validUntil: idemUntil, idempotencyKey: idemKey }),
    })
  ).json();
  const idemRetry = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A retried request might not even carry identical fields (e.g. a
      // client resubmitting with a slightly stale form state) — the
      // idempotency key alone must be enough to detect the replay.
      body: JSON.stringify({ visitorName: "Idempotent Ivy", visitorPhone: "+15554440000", validUntil: idemUntil, idempotencyKey: idemKey, note: "should be ignored on replay" }),
    })
  ).json();
  const visitorSmsCountAfter = notifier.history().filter((n) => n.to === "visitor").length;
  assert.equal(idemRetry.id, idemFirst.id, "retrying issuance with the same idempotency key returns the original pass");
  assert.equal(listPassCount(await (await fetch(`${base}/passes`)).json(), idemFirst.id), 1, "no duplicate pass was created");
  assert.equal(visitorSmsCountAfter, visitorSmsCountBefore + 1, "the retry does not re-send the visitor SMS");
  console.log("✓ POST /passes with a repeated idempotencyKey returns the original pass without creating a duplicate or re-notifying");

  // --- 2. Recurring passes ---
  const today = new Date().getUTCDay();
  const notToday = (today + 1) % 7;
  const recurUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const recurFrom = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const recurringValidNow = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Weekly Dog Walker",
        visitorPhone: "+15556667777",
        validFrom: recurFrom,
        validUntil: recurUntil,
        maxUses: 999,
        recurrence: { daysOfWeek: [today], startTime: "00:00", endTime: "23:59" },
      }),
    })
  ).json();
  const recurringValidCheckin = await (
    await fetch(`${base}/checkin/${recurringValidNow.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(recurringValidCheckin.ok, true, "a recurring pass whose rule covers today/now allows check-in");
  console.log("✓ a recurring pass is valid when today matches its daysOfWeek and now falls in its time window");

  const recurringWrongDay = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Wrong Day Visitor",
        visitorPhone: "+15556668888",
        validFrom: recurFrom,
        validUntil: recurUntil,
        recurrence: { daysOfWeek: [notToday], startTime: "00:00", endTime: "23:59" },
      }),
    })
  ).json();
  const recurringWrongDayCheckin = await (
    await fetch(`${base}/checkin/${recurringWrongDay.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(recurringWrongDayCheckin.ok, false, "a recurring pass whose rule doesn't include today rejects check-in");
  assert.match(recurringWrongDayCheckin.reason, /recurring schedule/);
  console.log("✓ a recurring pass outside its daysOfWeek/time window is rejected, even though the pass itself hasn't expired");

  // --- 3. Webhook signature verification ---
  const unsignedBody = JSON.stringify({ deviceId: "front-door", type: "motion" });
  const unsignedRes = await fetch(`${base}/ring/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: unsignedBody,
  });
  assert.equal(unsignedRes.status, 401, "a Ring webhook call with no signature header is rejected");

  const badlySignedRes = await fetch(`${base}/ring/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ring-Signature": "0000000000000000000000000000000000000000000000000000000000000000" },
    body: unsignedBody,
  });
  assert.equal(badlySignedRes.status, 401, "a Ring webhook call with a wrong signature is rejected");
  console.log("✓ POST /ring/events rejects missing and invalid X-Ring-Signature headers with 401");

  const correctlySignedRes = await fetch(`${base}/ring/events`, {
    method: "POST",
    headers: ringWebhookHeaders(unsignedBody),
    body: unsignedBody,
  });
  assert.equal(correctlySignedRes.status, 201, "a Ring webhook call with a correctly computed HMAC signature is accepted");
  console.log("✓ POST /ring/events accepts a call whose X-Ring-Signature matches the HMAC-SHA256 of the raw body");

  // --- 4. Real-time homeowner event stream (SSE) ---
  const streamRes = await fetch(`${base}/events/stream`);
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader();

  const ssePromise = waitForSseEvent(reader);
  const sseUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await fetch(`${base}/passes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitorName: "SSE Streamed Visitor", visitorPhone: "+15559990000", validUntil: sseUntil }),
  });
  const sseFrame = await ssePromise;
  assert.match(sseFrame, /event: pass_issued/);
  assert.match(sseFrame, /SSE Streamed Visitor/);
  await reader.cancel();
  console.log("✓ GET /events/stream pushes a live SSE event the moment a pass is issued, while the connection is held open");

  // --- 5. Quiet-hours enforcement ---
  const nowForQuiet = new Date();
  const nowMinutes = nowForQuiet.getUTCHours() * 60 + nowForQuiet.getUTCMinutes();
  const quietStart = minutesToHHMM(nowMinutes - 15);
  const quietEnd = minutesToHHMM(nowMinutes + 15);
  const settingsRes = await fetch(`${base}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quietHours: { start: quietStart, end: quietEnd } }),
  });
  assert.equal(settingsRes.status, 200);

  const quietBoundPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Late Night Visitor", visitorPhone: "+15551110000", validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    })
  ).json();
  const quietBlockedCheckin = await (
    await fetch(`${base}/checkin/${quietBoundPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(quietBlockedCheckin.ok, false, "a check-in during quiet hours is rejected");
  assert.match(quietBlockedCheckin.reason, /quiet hours/);
  console.log("✓ a check-in during configured quiet hours is rejected with a clear reason, even though the pass is otherwise valid");

  const quietOptOutPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Overnight Nurse",
        visitorPhone: "+15551110001",
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        allowQuietHours: true,
      }),
    })
  ).json();
  const quietOptOutCheckin = await (
    await fetch(`${base}/checkin/${quietOptOutPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(quietOptOutCheckin.ok, true, "a pass with allowQuietHours:true bypasses quiet-hours enforcement");
  console.log("✓ a pass with allowQuietHours:true can still check in during quiet hours");

  // Reset quiet hours so they don't affect the rate-limit checks below.
  await fetch(`${base}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quietHours: null }),
  });

  // --- 6. Rate limiting on check-in attempts ---
  const rateLimitedPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Persistent Prowler", visitorPhone: "+15550009999", validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(), maxUses: 999 }),
    })
  ).json();
  const attemptStatuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${base}/checkin/${rateLimitedPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });
    attemptStatuses.push(res.status);
    if (i === 5) {
      const body = await res.json();
      assert.equal(res.status, 429, "the 6th check-in attempt within the window is rate-limited");
      assert.match(body.reason, /Too many/);
    }
  }
  assert.equal(attemptStatuses.slice(0, 5).every((s) => s !== 429), true, "the first 5 attempts are not rate-limited");
  console.log("✓ the 6th rapid check-in attempt on one checkinToken within 10 minutes is rejected with 429");

  // =========================================================================
  // Round 3: multi-device support, outbound webhooks, bulk issuance, grace-
  // period extensions
  // =========================================================================

  // --- 1. Multi-device support ---
  const deviceListBefore = await (await fetch(`${base}/devices`)).json();
  assert.ok(
    deviceListBefore.some((d: { id: string }) => d.id === "front-door"),
    "front-door is pre-registered by default, for backward compatibility"
  );
  console.log("✓ GET /devices lists the pre-registered front-door device by default");

  const backDoorPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Back Door Gardener",
        visitorPhone: "+15552221111",
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        maxUses: 2,
        deviceIds: ["back-door"],
      }),
    })
  ).json();
  assert.deepEqual(backDoorPass.deviceIds, ["back-door"]);

  const devicesAfterPassIssuance = await (await fetch(`${base}/devices`)).json();
  assert.ok(
    devicesAfterPassIssuance.some((d: { id: string }) => d.id === "back-door"),
    "a pass naming a new deviceId implicitly registers that device"
  );
  console.log("✓ issuing a pass scoped to a new deviceId implicitly registers that device");

  // A front-door ding should NOT correlate with a pass scoped only to back-door.
  const frontDingBody = JSON.stringify({ deviceId: "front-door", type: "ding" });
  await fetch(`${base}/ring/events`, { method: "POST", headers: ringWebhookHeaders(frontDingBody), body: frontDingBody });
  const backDoorScopedMissCheckin = await (
    await fetch(`${base}/checkin/${backDoorPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(backDoorScopedMissCheckin.ok, true, "the check-in still succeeds even with no matching event on its scoped device");
  assert.equal(backDoorScopedMissCheckin.visit.matchedEvent, undefined, "a front-door event must not correlate with a back-door-scoped pass");
  console.log("✓ a pass scoped to back-door does not correlate with a front-door Ring event");

  // A back-door ding SHOULD correlate with the same pass's second use.
  const backDingBody = JSON.stringify({ deviceId: "back-door", type: "ding" });
  await fetch(`${base}/ring/events`, { method: "POST", headers: ringWebhookHeaders(backDingBody), body: backDingBody });
  const backDoorScopedHitCheckin = await (
    await fetch(`${base}/checkin/${backDoorPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(backDoorScopedHitCheckin.ok, true);
  assert.ok(backDoorScopedHitCheckin.visit.matchedEvent, "a back-door event must correlate with a back-door-scoped pass");
  assert.equal(backDoorScopedHitCheckin.visit.matchedEvent.deviceId, "back-door");
  console.log("✓ a pass scoped to back-door correlates correctly with a back-door Ring event");

  const explicitDevice = await (
    await fetch(`${base}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "garage", name: "Garage Camera" }),
    })
  ).json();
  assert.equal(explicitDevice.name, "Garage Camera");
  console.log("✓ POST /devices explicitly registers a device with a custom name");

  // --- 2. Outbound webhook notifications ---
  const receivedWebhookDeliveries: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const webhookServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      receivedWebhookDeliveries.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
  const webhookPort = (webhookServer.address() as AddressInfo).port;
  const webhookUrl = `http://127.0.0.1:${webhookPort}/hook`;

  const webhookRegRes = await fetch(`${base}/settings/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });
  assert.equal(webhookRegRes.status, 201);
  const webhookReg = await webhookRegRes.json();
  assert.equal(webhookReg.url, webhookUrl);
  assert.ok(webhookReg.secret, "registering a webhook returns a server-generated signing secret");

  const getWebhookRes = await fetch(`${base}/settings/webhook`);
  assert.equal(getWebhookRes.status, 200);
  const fetchedWebhookReg = await getWebhookRes.json();
  assert.equal(fetchedWebhookReg.secret, webhookReg.secret, "GET /settings/webhook exposes the same secret so the receiver can verify signatures");
  console.log("✓ POST/GET /settings/webhook registers a callback URL and exposes its signing secret");

  const webhookUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const webhookPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Webhook Watched Visitor", visitorPhone: "+15553334444", validUntil: webhookUntil }),
    })
  ).json();
  await fetch(`${base}/checkin/${webhookPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });

  const visitDelivery = await waitFor(
    () => receivedWebhookDeliveries.find((d) => JSON.parse(d.body).type === "visit_checkin" && JSON.parse(d.body).visit?.passId === webhookPass.id),
    3000,
    "the registered webhook to receive a signed visit_checkin delivery"
  );
  const deliveredSignature = visitDelivery.headers["x-porchpass-signature"];
  assert.ok(deliveredSignature, "the outbound delivery carries an X-PorchPass-Signature header");
  const expectedSignature = signPayload(webhookReg.secret, visitDelivery.body);
  assert.equal(deliveredSignature, expectedSignature, "the receiver can independently recompute the HMAC-SHA256 signature from the secret and raw body");
  console.log("✓ a registered outbound webhook receives a correctly HMAC-signed POST when a visit happens");

  const webhookStatusRes = await (await fetch(`${base}/settings/webhook`)).json();
  assert.ok(webhookStatusRes.deliveryStatus.lastSuccessAt, "successful deliveries are tracked for observability");
  console.log("✓ GET /settings/webhook exposes last-delivery status for observability");

  webhookServer.close();

  // --- 3. Bulk/template pass issuance ---
  const bulkUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const bulkRes = await fetch(`${base}/passes/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      template: { visitorPhone: "+15556660000", validUntil: bulkUntil, note: "weekly dog walker" },
      variations: [
        { visitorName: "Monday Walker", recurrence: { daysOfWeek: [1], startTime: "13:00", endTime: "15:00" } },
        { visitorName: "Wednesday Walker", recurrence: { daysOfWeek: [3], startTime: "13:00", endTime: "15:00" } },
        { visitorName: "Friday Walker", recurrence: { daysOfWeek: [5], startTime: "13:00", endTime: "15:00" } },
      ],
      idempotencyKeyPrefix: "bulk-walkers-week1-",
    }),
  });
  assert.equal(bulkRes.status, 201);
  const bulkResult = await bulkRes.json();
  assert.equal(bulkResult.results.length, 3, "one result per variation, in one response");
  assert.ok(bulkResult.results.every((r: { status: string }) => r.status === "created"));
  assert.deepEqual(
    bulkResult.results.map((r: { pass: { visitorName: string } }) => r.pass.visitorName),
    ["Monday Walker", "Wednesday Walker", "Friday Walker"]
  );
  assert.ok(bulkResult.results.every((r: { pass: { note: string } }) => r.pass.note === "weekly dog walker"), "template fields apply to every variation");
  console.log("✓ POST /passes/bulk creates N passes from a template + variations in one request");

  const bulkReplayRes = await fetch(`${base}/passes/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      template: { visitorPhone: "+15556660000", validUntil: bulkUntil, note: "weekly dog walker" },
      variations: [
        { visitorName: "Monday Walker", recurrence: { daysOfWeek: [1], startTime: "13:00", endTime: "15:00" } },
        { visitorName: "Wednesday Walker", recurrence: { daysOfWeek: [3], startTime: "13:00", endTime: "15:00" } },
        { visitorName: "Friday Walker", recurrence: { daysOfWeek: [5], startTime: "13:00", endTime: "15:00" } },
      ],
      idempotencyKeyPrefix: "bulk-walkers-week1-",
    }),
  });
  const bulkReplayResult = await bulkReplayRes.json();
  assert.ok(bulkReplayResult.results.every((r: { status: string }) => r.status === "replayed"), "a repeated bulk call with the same idempotencyKeyPrefix replays, not duplicates");
  assert.deepEqual(
    bulkReplayResult.results.map((r: { pass: { id: string } }) => r.pass.id),
    bulkResult.results.map((r: { pass: { id: string } }) => r.pass.id)
  );
  console.log("✓ POST /passes/bulk replays (not duplicates) passes on a repeated idempotencyKeyPrefix");

  const bulkPartialRes = await fetch(`${base}/passes/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      template: { visitorPhone: "+15556660001", validUntil: bulkUntil },
      variations: [{ visitorName: "Valid Visitor" }, { visitorPhone: "+15559999999" /* missing visitorName */ }],
    }),
  });
  assert.equal(bulkPartialRes.status, 207);
  const bulkPartialResult = await bulkPartialRes.json();
  assert.equal(bulkPartialResult.results[0].status, "created");
  assert.equal(bulkPartialResult.results[1].status, "error");
  console.log("✓ POST /passes/bulk reports per-item results — one bad variation doesn't fail the whole batch");

  // --- 4. Grace-period extension flow ---
  const justExpiredPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Just Missed It",
        visitorPhone: "+15557778888",
        validFrom: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        validUntil: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // expired 5 minutes ago — inside the 30-minute grace window
      }),
    })
  ).json();

  const justExpiredCheckin = await (
    await fetch(`${base}/checkin/${justExpiredPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(justExpiredCheckin.ok, false);
  assert.equal(justExpiredCheckin.graceEligible, true, "a pass expired within the grace window is offered an extension");
  console.log("✓ a pass that just expired is flagged graceEligible instead of only a flat rejection");

  // Never-requested: a second attempt without ever requesting an extension still stays rejected.
  const neverRequestedRecheck = await (
    await fetch(`${base}/checkin/${justExpiredPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(neverRequestedRecheck.ok, false, "a never-requested expired pass stays rejected");

  const extensionRequestRes = await fetch(`${base}/checkin/${justExpiredPass.checkinToken}/request-extension`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  assert.equal(extensionRequestRes.status, 201);
  const extensionRequestResult = await extensionRequestRes.json();
  assert.equal(extensionRequestResult.ok, true);
  assert.equal(extensionRequestResult.pass.extension.status, "pending");
  const extensionRequestNotification = notifier.history().find((n) => n.to === "homeowner" && /extension|more minutes/.test(n.message));
  assert.ok(extensionRequestNotification, "requesting an extension notifies the homeowner via the existing Notifier");
  console.log("✓ POST /checkin/:token/request-extension creates a pending request and notifies the homeowner");

  // Deny path: a denied pass stays rejected.
  const denyUntil = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const toBeDeniedPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "To Be Denied",
        visitorPhone: "+15557778889",
        validFrom: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        validUntil: denyUntil,
      }),
    })
  ).json();
  await fetch(`${base}/checkin/${toBeDeniedPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });
  await fetch(`${base}/checkin/${toBeDeniedPass.checkinToken}/request-extension`, { method: "POST", headers: { Accept: "application/json" } });
  const denyRes = await fetch(`${base}/passes/${toBeDeniedPass.id}/extension/deny`, { method: "POST" });
  assert.equal(denyRes.status, 200);
  const denyResult = await denyRes.json();
  assert.equal(denyResult.pass.extension.status, "denied");
  const deniedCheckin = await (
    await fetch(`${base}/checkin/${toBeDeniedPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(deniedCheckin.ok, false, "a denied extension request stays rejected");
  console.log("✓ POST /passes/:id/extension/deny keeps the pass rejected on the next check-in attempt");

  // Approve path: an approved extension unlocks exactly one more check-in.
  const approveRes = await fetch(`${base}/passes/${justExpiredPass.id}/extension/approve`, { method: "POST" });
  assert.equal(approveRes.status, 200);
  const approveResult = await approveRes.json();
  assert.equal(approveResult.pass.extension.status, "approved");
  const visitorExtensionSms = notifier.history().find((n) => n.to === "visitor" && n.message.includes("more minutes") && n.message.includes("Good news"));
  assert.ok(visitorExtensionSms, "approving an extension notifies the visitor");

  const extendedCheckin = await (
    await fetch(`${base}/checkin/${justExpiredPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(extendedCheckin.ok, true, "an approved grace-period extension unlocks one more check-in on an otherwise-expired pass");
  console.log("✓ an approved grace-period extension lets a just-expired pass check in one more time");

  // The extension is single-use: a further attempt is rejected again.
  const afterExtensionUsedCheckin = await (
    await fetch(`${base}/checkin/${justExpiredPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(afterExtensionUsedCheckin.ok, false, "an approved extension is consumed after one use and can't be replayed");
  console.log("✓ a used grace-period extension can't be reused for a further check-in");

  // Approving/denying an extension that isn't pending is rejected.
  const doubleApproveRes = await fetch(`${base}/passes/${justExpiredPass.id}/extension/approve`, { method: "POST" });
  assert.equal(doubleApproveRes.status, 409, "approving an extension that's already been decided is rejected");
  console.log("✓ POST /passes/:id/extension/approve rejects a request that isn't pending");

  // =========================================================================
  // Round 4: visit duration tracking, traffic/analytics report, household
  // member roles, encrypted-at-rest visitor PII
  // =========================================================================

  // --- 1. Visit duration tracking (arrival + departure) ---
  const durationPassUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const durationPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Duration Tester", visitorPhone: "+15550003333", validUntil: durationPassUntil }),
    })
  ).json();

  const arrivalRes = await (
    await fetch(`${base}/checkin/${durationPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(arrivalRes.ok, true);
  const durationVisitId = arrivalRes.visit.id;

  const visitsWhileOnSite = await (await fetch(`${base}/visits`)).json();
  const onSiteVisit = visitsWhileOnSite.find((v: { id: string }) => v.id === durationVisitId);
  assert.ok(onSiteVisit, "the new visit shows up in GET /visits immediately after arrival");
  assert.equal(onSiteVisit.status, "on_site", "a visit with only an arrival shows as still on-site");
  assert.equal(onSiteVisit.checkedOutAt, undefined, "an on-site visit has no checkedOutAt yet");
  assert.equal(typeof onSiteVisit.onSiteForMs, "number", "an on-site visit reports how long it's been going so far");
  console.log("✓ GET /visits shows a visit with only an arrival as still on-site");

  // A small real delay so the computed duration is meaningfully > 0, not just non-negative by luck.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const checkoutRes = await fetch(`${base}/checkin/${durationPass.checkinToken}/checkout`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  assert.equal(checkoutRes.status, 200);
  const checkoutResult = await checkoutRes.json();
  assert.equal(checkoutResult.ok, true);
  assert.equal(checkoutResult.visit.id, durationVisitId, "checkout closes the same visit the arrival opened");
  assert.ok(checkoutResult.visit.durationMs >= 20, "a checkout computes a real, non-trivial visit duration");
  console.log("✓ POST /checkin/:token/checkout closes out a visit and computes its duration");

  const visitsAfterCheckout = await (await fetch(`${base}/visits`)).json();
  const completedVisit = visitsAfterCheckout.find((v: { id: string }) => v.id === durationVisitId);
  assert.equal(completedVisit.status, "completed", "GET /visits reflects the departure once it happens");
  assert.equal(completedVisit.durationMs, checkoutResult.visit.durationMs);
  console.log("✓ GET /visits shows a completed visit's status and computed duration after checkout");

  // Edge case: a departure with no matching open visit (already checked out, or never checked in at all) is a clean rejection.
  const doubleCheckoutRes = await (
    await fetch(`${base}/checkin/${durationPass.checkinToken}/checkout`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(doubleCheckoutRes.ok, false, "a second checkout with no new arrival in between is rejected");
  assert.match(doubleCheckoutRes.reason, /no active visit/i);

  const neverArrivedPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Never Arrived", visitorPhone: "+15550003334", validUntil: durationPassUntil }),
    })
  ).json();
  const noArrivalCheckoutRes = await (
    await fetch(`${base}/checkin/${neverArrivedPass.checkinToken}/checkout`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(noArrivalCheckoutRes.ok, false, "a departure with no matching arrival at all is rejected, not a crash");
  console.log("✓ a checkout with no matching open visit (already checked out, or never checked in) is rejected cleanly");

  // --- 2. Traffic/analytics report ---
  const analyticsBefore = await (await fetch(`${base}/analytics`)).json();

  async function issueCheckinCheckout(visitorName: string, phone: string, note: string) {
    const p = await (
      await fetch(`${base}/passes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorName, visitorPhone: phone, validUntil: durationPassUntil, note }),
      })
    ).json();
    await fetch(`${base}/checkin/${p.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });
    await fetch(`${base}/checkin/${p.checkinToken}/checkout`, { method: "POST", headers: { Accept: "application/json" } });
    return p;
  }
  await issueCheckinCheckout("Analytics Dog Walker A", "+15550004001", "dog walker");
  await issueCheckinCheckout("Analytics Dog Walker B", "+15550004002", "dog walker");
  await issueCheckinCheckout("Analytics Delivery A", "+15550004003", "delivery");

  const analyticsAfter = await (await fetch(`${base}/analytics`)).json();
  function categoryCount(report: { visitsByCategory: Array<{ category: string; count: number }> }, category: string): number {
    return report.visitsByCategory.find((c) => c.category === category)?.count ?? 0;
  }

  assert.equal(analyticsAfter.totalVisits - analyticsBefore.totalVisits, 3, "analytics totalVisits reflects the real, freshly-recorded visit count");
  assert.equal(categoryCount(analyticsAfter, "dog walker") - categoryCount(analyticsBefore, "dog walker"), 2, "analytics tallies visits per note-category (dog walker)");
  assert.equal(categoryCount(analyticsAfter, "delivery") - categoryCount(analyticsBefore, "delivery"), 1, "analytics tallies visits per note-category (delivery)");
  assert.equal(typeof analyticsAfter.averageVisitDurationMs, "number", "average visit duration is a real computed number once completed visits exist");
  assert.ok(analyticsAfter.busiestDay, "analytics surfaces a busiest day");
  const expectedDayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  assert.equal(
    analyticsAfter.busiestDay.day,
    expectedDayNames[new Date().getUTCDay()],
    "the busiest day reflects when the test's visits actually happened (all of them, today)"
  );
  assert.ok(
    analyticsAfter.insights.some((s: string) => /busiest/i.test(s)) && analyticsAfter.insights.some((s: string) => /average/i.test(s)),
    "analytics includes plain-language insight strings, not just raw numbers"
  );
  console.log("✓ GET /analytics aggregates real visit history into busiest-day/hour, average duration, and per-visitor/category counts");

  const trafficAlias = await (await fetch(`${base}/reports/traffic`)).json();
  assert.equal(trafficAlias.totalVisits, analyticsAfter.totalVisits, "GET /reports/traffic is an alias for the same report as GET /analytics");
  console.log("✓ GET /reports/traffic returns the same traffic report as GET /analytics");

  // --- 3. Household member roles ---
  const membersBefore = await (await fetch(`${base}/household/members`)).json();
  assert.ok(
    membersBefore.some((m: { id: string; role: string }) => m.id === "owner" && m.role === "owner"),
    "a default 'owner' household member is pre-seeded, for zero-setup backward compatibility"
  );
  console.log("✓ GET /household/members lists the pre-seeded default owner");

  const addMemberRes = await fetch(`${base}/household/members`, {
    // No X-PorchPass-Member header — defaults to the owner, per household.ts, so this succeeds.
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "helper1", name: "Helper One", role: "member" }),
  });
  assert.equal(addMemberRes.status, 201);
  const addedMember = await addMemberRes.json();
  assert.equal(addedMember.role, "member");
  console.log("✓ POST /household/members (as the default owner) adds a member-role household member");

  const roleTestUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const roleTestPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Role Test Visitor", visitorPhone: "+15550002222", validUntil: roleTestUntil }),
    })
  ).json();

  const memberRevokeRes = await fetch(`${base}/passes/${roleTestPass.id}`, {
    method: "DELETE",
    headers: { "X-PorchPass-Member": "helper1" },
  });
  assert.equal(memberRevokeRes.status, 403, "a member-role caller cannot revoke a pass");
  console.log("✓ DELETE /passes/:id rejects a member-role caller with 403");

  const ownerRevokeRes = await fetch(`${base}/passes/${roleTestPass.id}`, {
    method: "DELETE",
    headers: { "X-PorchPass-Member": "owner" },
  });
  assert.equal(ownerRevokeRes.status, 200, "an owner-role caller can revoke a pass");
  console.log("✓ DELETE /passes/:id succeeds for an owner-role caller");

  const memberSettingsRes = await fetch(`${base}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PorchPass-Member": "helper1" },
    body: JSON.stringify({ quietHours: { start: "01:00", end: "02:00" } }),
  });
  assert.equal(memberSettingsRes.status, 403, "a member-role caller cannot change household settings");
  const ownerSettingsRes = await fetch(`${base}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PorchPass-Member": "owner" },
    body: JSON.stringify({ quietHours: null }),
  });
  assert.equal(ownerSettingsRes.status, 200, "an owner-role caller can change household settings");
  console.log("✓ POST /settings enforces the owner role, rejecting a member-role caller with 403 while an owner succeeds");

  const unknownCallerRes = await fetch(`${base}/settings/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PorchPass-Member": "totally-unknown-id" },
    body: JSON.stringify({ url: "http://127.0.0.1:1/nowhere" }),
  });
  assert.equal(unknownCallerRes.status, 401, "an unrecognized member id is rejected outright, not silently downgraded");
  console.log("✓ an unrecognized X-PorchPass-Member id is rejected with 401 rather than falling back to a default role");

  // --- 4. Encrypted-at-rest visitor PII ---
  const piiPhone = "+15559998888";
  const piiPassRes = await fetch(`${base}/passes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitorName: "PII Test Visitor", visitorPhone: piiPhone, validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
  });
  const piiPass = await piiPassRes.json();

  assert.ok(!JSON.stringify(piiPass).includes(piiPhone), "the API response never echoes the visitor's plaintext phone number");
  assert.ok(
    typeof piiPass.visitorPhone === "string" && piiPass.visitorPhone.endsWith("8888") && piiPass.visitorPhone !== piiPhone,
    "the API instead shows a masked phone number (last 4 digits visible)"
  );
  console.log("✓ POST /passes response never contains the visitor's plaintext phone number, only a masked version");

  const rawStoredPass = getPassById(piiPass.id);
  assert.ok(rawStoredPass, "the pass exists in the in-memory store");
  assert.ok(!JSON.stringify(rawStoredPass).includes(piiPhone), "the raw in-memory record does not contain the plaintext phone number anywhere");
  assert.ok(rawStoredPass!.visitorPhoneEnc?.ciphertext, "the phone number is stored as an AES-256-GCM-encrypted field, not a plain string");
  assert.equal(decryptField(rawStoredPass!.visitorPhoneEnc), piiPhone, "the encrypted field decrypts back to the exact original phone number");
  console.log("✓ the visitor's phone number is stored encrypted at rest — confirmed against the raw in-memory record, not just the API's response shape");

  const piiNotification = notifier.history().find((n) => n.to === "visitor" && n.recipient === piiPhone);
  assert.ok(piiNotification, "the notifier still 'sends' the visitor's SMS to the real, decrypted phone number");
  console.log("✓ the visitor-facing notification is still sent to the real decrypted phone number, despite encrypted-at-rest storage");

  // =========================================================================
  // Round 5: visitor trust scoring, Alexa+ voice-confirmed check-in,
  // geofenced pass activation, neighborhood alert broadcast
  // =========================================================================

  // --- 1. Visitor trust scoring ---
  const trustPhone = "+15557771111";
  const trustUrl = `${base}/visitors/${encodeURIComponent(trustPhone)}/trust`;

  const trustBaseline = await (await fetch(trustUrl)).json();
  assert.equal(trustBaseline.score, 50, "a visitor with no history at all starts at the neutral baseline score");
  assert.equal(trustBaseline.passesConsidered, 0);
  assert.equal(trustBaseline.factors.length, 1, "with no history, the only factor is the baseline itself");
  assert.match(trustBaseline.factors[0].label, /baseline/i);
  console.log("✓ GET /visitors/:phone/trust returns a neutral baseline score for a visitor with no history");

  // A completed visit (arrival + checkout) should raise the score.
  const trustPassA = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Trust Test Visitor", visitorPhone: trustPhone, validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    })
  ).json();
  await fetch(`${base}/checkin/${trustPassA.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });
  await fetch(`${base}/checkin/${trustPassA.checkinToken}/checkout`, { method: "POST", headers: { Accept: "application/json" } });
  const trustAfterCompleted = await (await fetch(trustUrl)).json();
  assert.equal(trustAfterCompleted.completedVisits, 1);
  assert.equal(trustAfterCompleted.score, 58, "one completed visit adds +8 to the baseline of 50");
  assert.ok(trustAfterCompleted.factors.some((f: { label: string }) => /completed visit/.test(f.label)));
  console.log("✓ a completed visit (arrival + checkout) raises this visitor's trust score, with a matching explainable factor");

  // A revoked pass for the same visitor identity should lower it.
  const trustPassB = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Trust Test Visitor", visitorPhone: trustPhone, validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    })
  ).json();
  await fetch(`${base}/passes/${trustPassB.id}`, { method: "DELETE" });
  const trustAfterRevocation = await (await fetch(trustUrl)).json();
  assert.equal(trustAfterRevocation.revocations, 1);
  assert.equal(trustAfterRevocation.score, 33, "a revoked pass on this visitor's history subtracts 25");
  console.log("✓ a revoked pass on the same visitor identity lowers their trust score");

  // A no-show (expired, never used) pass for the same visitor lowers it further.
  await fetch(`${base}/passes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      visitorName: "Trust Test Visitor",
      visitorPhone: trustPhone,
      validFrom: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      validUntil: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }),
  });
  const trustAfterNoShow = await (await fetch(trustUrl)).json();
  assert.equal(trustAfterNoShow.noShows, 1);
  assert.equal(trustAfterNoShow.score, 18, "a pass that expired without ever being used (no-show) subtracts 15 more");
  console.log("✓ a pass that expired unused (a no-show) further lowers this visitor's trust score");

  // A visit that only succeeded via a grace-period extension (late arrival) lowers it further still.
  const trustLatePass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Trust Test Visitor",
        visitorPhone: trustPhone,
        validFrom: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        validUntil: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
    })
  ).json();
  await fetch(`${base}/checkin/${trustLatePass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });
  await fetch(`${base}/checkin/${trustLatePass.checkinToken}/request-extension`, { method: "POST", headers: { Accept: "application/json" } });
  await fetch(`${base}/passes/${trustLatePass.id}/extension/approve`, { method: "POST" });
  await fetch(`${base}/checkin/${trustLatePass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });

  const trustFinal = await (await fetch(trustUrl)).json();
  assert.equal(trustFinal.lateArrivals, 1);
  assert.equal(trustFinal.passesConsidered, 4);
  assert.equal(trustFinal.score, 8, "baseline 50 + one completed visit (+8) - one revocation (-25) - one no-show (-15) - one late arrival (-10) = 8");
  assert.equal(
    trustFinal.factors.reduce((sum: number, f: { delta: number }) => sum + f.delta, 0),
    trustFinal.score,
    "the score is nothing more than the sum of the explainable factors — no hidden weighting"
  );
  assert.ok(trustFinal.visitorPhone.endsWith("1111") && trustFinal.visitorPhone !== trustPhone, "the trust report masks the phone number, same as everywhere else");
  console.log("✓ a visit that only succeeded via a grace-period extension lowers trust further, and the final score is fully explained by its factors");

  // --- Trust-gated auto-approval of grace-period extensions ---
  const autoApprovePhone = "+15557772222";
  for (let i = 0; i < 3; i++) {
    const p = await (
      await fetch(`${base}/passes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorName: "Future Regular", visitorPhone: autoApprovePhone, validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
      })
    ).json();
    await fetch(`${base}/checkin/${p.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });
    await fetch(`${base}/checkin/${p.checkinToken}/checkout`, { method: "POST", headers: { Accept: "application/json" } });
  }
  const autoApproveTrust = await (await fetch(`${base}/visitors/${encodeURIComponent(autoApprovePhone)}/trust`)).json();
  assert.equal(autoApproveTrust.score, 74, "3 completed visits bring this visitor to a score of 74 (50 + 3*8)");

  const autoApprovePass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Future Regular",
        visitorPhone: autoApprovePhone,
        validFrom: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        validUntil: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        autoApproveExtensionsAboveTrust: 70,
      }),
    })
  ).json();
  const autoApproveCheckin = await (
    await fetch(`${base}/checkin/${autoApprovePass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(autoApproveCheckin.graceEligible, true);

  const autoApproveExtRes = await (
    await fetch(`${base}/checkin/${autoApprovePass.checkinToken}/request-extension`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(autoApproveExtRes.ok, true);
  assert.equal(autoApproveExtRes.autoApproved, true, "a request from a visitor whose trust score already clears the pass's threshold is auto-approved");
  assert.equal(autoApproveExtRes.pass.extension.status, "approved");
  console.log("✓ POST /checkin/:token/request-extension auto-approves instantly when the visitor's trust score clears autoApproveExtensionsAboveTrust");

  const autoApproveFinalCheckin = await (
    await fetch(`${base}/checkin/${autoApprovePass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(autoApproveFinalCheckin.ok, true, "the auto-approved extension unlocks a check-in exactly like a manual approval would");
  console.log("✓ an auto-approved extension actually unlocks the next check-in");

  // A visitor who does NOT clear the threshold still waits on a manual decision.
  const unearnedTrustPhone = "+15557773333";
  const unearnedPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Unproven Visitor",
        visitorPhone: unearnedTrustPhone,
        validFrom: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        validUntil: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        autoApproveExtensionsAboveTrust: 90,
      }),
    })
  ).json();
  await fetch(`${base}/checkin/${unearnedPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });
  const unearnedExtRes = await (
    await fetch(`${base}/checkin/${unearnedPass.checkinToken}/request-extension`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(unearnedExtRes.ok, true);
  assert.ok(!unearnedExtRes.autoApproved, "a visitor whose trust score doesn't clear the threshold is not auto-approved");
  assert.equal(unearnedExtRes.pass.extension.status, "pending", "their request waits on the homeowner exactly like before this feature existed");
  console.log("✓ a visitor below the configured trust threshold still waits on a manual homeowner decision, not an automatic approval");

  // --- 2. Alexa+ ecosystem tie-in: voice-verified check-in confirmation ---
  const voicePass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Voice Confirmed Visitor", visitorPhone: "+15557774444", validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    })
  ).json();
  const voiceConfirmRes = await fetch(`${base}/passes/${voicePass.id}/voice-confirm`, { method: "POST" });
  assert.equal(voiceConfirmRes.status, 200);
  const voiceConfirmResult = await voiceConfirmRes.json();
  assert.equal(voiceConfirmResult.ok, true, "a household member voice-confirming a visitor checks them in, same as tapping the link");
  assert.equal(voiceConfirmResult.visit.confirmedVia, "voice");
  assert.equal(voiceConfirmResult.visit.confirmedByMember, "owner", "no member header defaults to the owner, same as every other household.ts-gated route");
  assert.equal(voiceConfirmResult.pass.status, "used_up", "voice-confirming consumes the pass's use-count exactly like a link check-in does");
  console.log("✓ POST /passes/:id/voice-confirm checks a visitor in via household voice confirmation instead of the visitor's own link tap");

  const voiceConfirmAgainRes = await (await fetch(`${base}/passes/${voicePass.id}/voice-confirm`, { method: "POST" })).json();
  assert.equal(voiceConfirmAgainRes.ok, false, "voice-confirming a used-up pass a second time is rejected, same access-control rules as the link flow");
  console.log("✓ voice-confirm check-in obeys the exact same validity rules as a link check-in (used_up, expired, revoked, quiet hours, ...)");

  const voiceConfirmUnknownMemberRes = await fetch(`${base}/passes/${voicePass.id}/voice-confirm`, {
    method: "POST",
    headers: { "X-PorchPass-Member": "totally-unknown-voice-caller" },
  });
  assert.equal(voiceConfirmUnknownMemberRes.status, 401, "an unrecognized household member id is rejected, same as every other household.ts-gated route");
  console.log("✓ POST /passes/:id/voice-confirm rejects an unrecognized household member id with 401");

  const voicePassForMember = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Voice Confirmed By Member", visitorPhone: "+15557774445", validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    })
  ).json();
  const memberVoiceConfirmRes = await (
    await fetch(`${base}/passes/${voicePassForMember.id}/voice-confirm`, { method: "POST", headers: { "X-PorchPass-Member": "helper1" } })
  ).json();
  assert.equal(memberVoiceConfirmRes.ok, true, "a non-owner household member can also voice-confirm a visitor — this isn't owner-restricted");
  assert.equal(memberVoiceConfirmRes.visit.confirmedByMember, "helper1");
  console.log("✓ any known household member (not just the owner) can voice-confirm a visitor");

  const voiceConfirmMissingPassRes = await fetch(`${base}/passes/not-a-real-pass-id/voice-confirm`, { method: "POST" });
  assert.equal(voiceConfirmMissingPassRes.status, 404, "voice-confirming a pass ID that doesn't exist is a clean 404");
  console.log("✓ POST /passes/:id/voice-confirm returns 404 for an unknown pass ID");

  // --- 3. Geofenced pass activation (simulated) ---
  const homeLocation = { lat: 37.7749, lng: -122.4194 };
  const farAwayLocation = { lat: 38.5816, lng: -121.4944 }; // Sacramento — comfortably outside any reasonable home radius

  const geofenceSettingsMemberRes = await fetch(`${base}/settings/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PorchPass-Member": "helper1" },
    body: JSON.stringify({ ...homeLocation, radiusMeters: 100 }),
  });
  assert.equal(geofenceSettingsMemberRes.status, 403, "configuring the household's home location is owner-only");

  const geofenceSettingsRes = await fetch(`${base}/settings/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...homeLocation, radiusMeters: 100 }),
  });
  assert.equal(geofenceSettingsRes.status, 200);
  const geofenceSettings = await geofenceSettingsRes.json();
  assert.deepEqual(geofenceSettings.homeLocation, homeLocation);
  assert.equal(geofenceSettings.geofenceRadiusMeters, 100);
  console.log("✓ POST /settings/location (as the owner) configures the household's home location and geofence radius");

  const geofencedPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Geofenced Visitor",
        visitorPhone: "+15557775555",
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        requireGeofence: true,
      }),
    })
  ).json();
  assert.equal(geofencedPass.requireGeofence, true);

  const geofenceBlockedCheckin = await (
    await fetch(`${base}/checkin/${geofencedPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(geofenceBlockedCheckin.ok, false, "a geofenced pass can't check in before any location has been confirmed");
  assert.equal(geofenceBlockedCheckin.reasonCode, "geofence");
  assert.match(geofenceBlockedCheckin.reason, /near the property/);
  console.log("✓ a pass with requireGeofence:true rejects check-in until a location ping confirms proximity");

  const farPingRes = await fetch(`${base}/passes/${geofencedPass.id}/location-ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(farAwayLocation),
  });
  assert.equal(farPingRes.status, 409);
  const farPingResult = await farPingRes.json();
  assert.equal(farPingResult.ok, false);
  assert.equal(farPingResult.withinRadius, false);
  assert.ok(farPingResult.distanceMeters > 1000, "a ping from far away reports a real, large computed distance");
  console.log("✓ POST /passes/:id/location-ping rejects a ping from outside the configured radius, reporting the real distance");

  const stillBlockedCheckin = await (
    await fetch(`${base}/checkin/${geofencedPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(stillBlockedCheckin.ok, false, "check-in is still blocked after a ping that landed outside the radius");

  const nearPingRes = await fetch(`${base}/passes/${geofencedPass.id}/location-ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(homeLocation),
  });
  assert.equal(nearPingRes.status, 200);
  const nearPingResult = await nearPingRes.json();
  assert.equal(nearPingResult.ok, true);
  assert.equal(nearPingResult.withinRadius, true);
  assert.ok(nearPingResult.distanceMeters < 1, "a ping at the exact home coordinates computes a near-zero distance");
  console.log("✓ POST /passes/:id/location-ping accepts a ping within the configured radius, confirming the pass's geofence");

  const geofenceUnlockedCheckin = await (
    await fetch(`${base}/checkin/${geofencedPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } })
  ).json();
  assert.equal(geofenceUnlockedCheckin.ok, true, "check-in succeeds once the geofence has been confirmed");
  console.log("✓ a geofenced pass checks in normally once a location ping has confirmed proximity");

  const nonGeofencedPingRes = await fetch(`${base}/passes/${trustPassA.id}/location-ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(homeLocation),
  });
  assert.equal(nonGeofencedPingRes.status, 409);
  const nonGeofencedPingResult = await nonGeofencedPingRes.json();
  assert.match(nonGeofencedPingResult.reason, /doesn't require location confirmation/);
  console.log("✓ POST /passes/:id/location-ping rejects a ping against a pass that doesn't require geofencing");

  // --- 4. Neighborhood alert broadcast ---
  const neighborDeliveries: Array<{ neighbor: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  function makeNeighborServer(name: string): http.Server {
    return http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        neighborDeliveries.push({ neighbor: name, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  }
  const neighborA = makeNeighborServer("A");
  const neighborB = makeNeighborServer("B");
  await new Promise<void>((resolve) => neighborA.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => neighborB.listen(0, "127.0.0.1", resolve));
  const neighborAUrl = `http://127.0.0.1:${(neighborA.address() as AddressInfo).port}/watch`;
  const neighborBUrl = `http://127.0.0.1:${(neighborB.address() as AddressInfo).port}/watch`;

  const memberSubscriberRes = await fetch(`${base}/neighborhood/subscribers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PorchPass-Member": "helper1" },
    body: JSON.stringify({ url: neighborAUrl }),
  });
  assert.equal(memberSubscriberRes.status, 403, "registering a neighborhood subscriber is owner-only");

  const subA = await (
    await fetch(`${base}/neighborhood/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: neighborAUrl }),
    })
  ).json();
  const subB = await (
    await fetch(`${base}/neighborhood/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: neighborBUrl }),
    })
  ).json();
  assert.ok(subA.secret && subB.secret && subA.secret !== subB.secret, "each neighborhood subscriber gets its own signing secret");

  const subscriberList = await (await fetch(`${base}/neighborhood/subscribers`)).json();
  assert.ok(subscriberList.some((s: { id: string }) => s.id === subA.id) && subscriberList.some((s: { id: string }) => s.id === subB.id));
  console.log("✓ POST /neighborhood/subscribers (owner-only) registers other simulated households, each with their own signing secret");

  // Risk pattern 1: a check-in attempt on an already-revoked pass.
  const riskRevokedPass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "Risk Test — Revoked", visitorPhone: "+15557776666", validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    })
  ).json();
  await fetch(`${base}/passes/${riskRevokedPass.id}`, { method: "DELETE" });
  await fetch(`${base}/checkin/${riskRevokedPass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });

  const revocationDeliveries = await waitFor(
    () => {
      const matches = neighborDeliveries.filter((d) => {
        const parsed = JSON.parse(d.body);
        return parsed.alert?.type === "checkin_after_revocation" && parsed.alert?.passId === riskRevokedPass.id;
      });
      return matches.length === 2 ? matches : undefined;
    },
    3000,
    "both neighborhood subscribers to receive a checkin_after_revocation alert"
  );
  for (const delivery of revocationDeliveries) {
    const subscriber = delivery.neighbor === "A" ? subA : subB;
    const expectedSig = signPayload(subscriber.secret, delivery.body);
    assert.equal(delivery.headers["x-porchpass-signature"], expectedSig, `neighbor ${delivery.neighbor}'s delivery is signed with its own secret`);
  }
  console.log("✓ a check-in attempt on an already-revoked pass broadcasts a signed neighborhood-watch alert to every subscribed household");

  // Risk pattern 2: several failed check-in attempts on the same pass in a short window.
  const today2 = new Date().getUTCDay();
  const notToday2 = (today2 + 1) % 7;
  const riskRepeatedFailurePass = await (
    await fetch(`${base}/passes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorName: "Risk Test — Repeated Failures",
        visitorPhone: "+15557777777",
        validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        maxUses: 999,
        recurrence: { daysOfWeek: [notToday2], startTime: "00:00", endTime: "23:59" }, // never matches today — every attempt fails the same deterministic way
      }),
    })
  ).json();
  for (let i = 0; i < 3; i++) {
    await fetch(`${base}/checkin/${riskRepeatedFailurePass.checkinToken}`, { method: "POST", headers: { Accept: "application/json" } });
  }

  const repeatedFailureDeliveries = await waitFor(
    () => {
      const matches = neighborDeliveries.filter((d) => {
        const parsed = JSON.parse(d.body);
        return parsed.alert?.type === "repeated_failed_checkins" && parsed.alert?.passId === riskRepeatedFailurePass.id;
      });
      return matches.length === 2 ? matches : undefined;
    },
    3000,
    "both neighborhood subscribers to receive a repeated_failed_checkins alert"
  );
  assert.ok(repeatedFailureDeliveries.every((d) => /3 failed or expired check-in attempts/.test(JSON.parse(d.body).alert.detail)));
  console.log("✓ 3 failed check-in attempts on the same pass within the risk window broadcasts a signed neighborhood-watch alert, exactly once");

  const alertsLog = await (await fetch(`${base}/neighborhood/alerts`)).json();
  assert.ok(alertsLog.some((a: { passId: string; type: string }) => a.passId === riskRevokedPass.id && a.type === "checkin_after_revocation"));
  assert.ok(alertsLog.some((a: { passId: string; type: string }) => a.passId === riskRepeatedFailurePass.id && a.type === "repeated_failed_checkins"));
  console.log("✓ GET /neighborhood/alerts exposes the broadcast alert log for observability");

  const removeSubMemberRes = await fetch(`${base}/neighborhood/subscribers/${subA.id}`, { method: "DELETE", headers: { "X-PorchPass-Member": "helper1" } });
  assert.equal(removeSubMemberRes.status, 403, "removing a neighborhood subscriber is also owner-only");
  const removeSubRes = await fetch(`${base}/neighborhood/subscribers/${subA.id}`, { method: "DELETE" });
  assert.equal(removeSubRes.status, 204);
  console.log("✓ DELETE /neighborhood/subscribers/:id (owner-only) removes a subscribed household");

  neighborA.close();
  neighborB.close();

  httpServer.close();
  console.log("\nAll PorchPass smoke tests passed.");
}

/** Polls `check()` until it returns a truthy value, or throws after `timeoutMs`. Used for asserting on an async side effect (e.g. a webhook delivery) that doesn't have its own completion signal to await. */
async function waitFor<T>(check: () => T | undefined, timeoutMs: number, description: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

function listPassCount(passes: Array<{ id: string }>, id: string): number {
  return passes.filter((p) => p.id === id).length;
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
