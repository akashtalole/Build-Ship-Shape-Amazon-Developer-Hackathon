/**
 * End-to-end smoke test: starts the PorchPass server on an ephemeral port
 * with a real HTTP client (fetch), and drives the full access-control
 * lifecycle — issue a pass, simulate a Ring doorbell event, check the
 * visitor in, confirm the audit trail and homeowner notification, then
 * exercise expiry, revocation, and single-use enforcement — followed by a
 * second round covering the advanced features: idempotent issuance,
 * recurring passes, webhook signature verification, the real-time SSE
 * event stream, quiet-hours enforcement, and check-in rate limiting.
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { SimulatedRingClient } from "../src/ringClient.js";
import { LoggingNotifier } from "../src/notify.js";
import { getWebhookSecret, signPayload } from "../src/webhookAuth.js";

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

  httpServer.close();
  console.log("\nAll PorchPass smoke tests passed.");
}

function listPassCount(passes: Array<{ id: string }>, id: string): number {
  return passes.filter((p) => p.id === id).length;
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
