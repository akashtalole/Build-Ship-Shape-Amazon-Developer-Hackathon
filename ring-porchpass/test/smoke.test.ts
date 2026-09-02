/**
 * End-to-end smoke test: starts the PorchPass server on an ephemeral port
 * with a real HTTP client (fetch), and drives the full access-control
 * lifecycle — issue a pass, simulate a Ring doorbell event, check the
 * visitor in, confirm the audit trail and homeowner notification, then
 * exercise expiry, revocation, and single-use enforcement. Run with
 * `npm test`.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { SimulatedRingClient } from "../src/ringClient.js";
import { LoggingNotifier } from "../src/notify.js";

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

  // --- A doorbell "ding" arrives, then the visitor checks in via the link ---
  await fetch(`${base}/ring/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "front-door", type: "ding" }),
  });

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

  httpServer.close();
  console.log("\nAll PorchPass smoke tests passed.");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
