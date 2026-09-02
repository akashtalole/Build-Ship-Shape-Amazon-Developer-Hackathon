# PorchPass — Delegated, Time-Boxed Access Control for Ring

Implementation of the "PorchPass" idea from [`hackathon-ideas/ring.md`](../hackathon-ideas/ring.md): homeowners
frequently need to grant one-time or short-window access (a dog walker, a delivery, a contractor) but sharing a
permanent code or app login is insecure and inconvenient. PorchPass issues single-use or time-boxed access "passes"
tied to a visitor, correlates their arrival with Ring doorbell/motion events, notifies the homeowner with a
snapshot, and auto-expires the pass — no app or account required on the visitor's side.

Built for the **Ring track** of the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/),
which allows "Ring APIs, SDKs, simulators, or devices per developer docs." This ships a Ring **simulator** so the
access-control logic is fully demoable and testable without Ring hardware or partner API credentials, with the real
integration point isolated to a single file (`src/ringClient.ts`) — see [Swapping in the real Ring API](#swapping-in-the-real-ring-api).

## How it works

1. **Homeowner issues a pass** (`POST /passes`) — a visitor name/phone, a validity window, and how many times it can
   be used (default: once). PorchPass "texts" the visitor a magic link (simulated via `LoggingNotifier`; swap in
   Twilio for a real deployment).
2. **Visitor arrives and taps the link** — no app, login, or account needed. The link opens a one-button
   confirmation page (`GET /checkin/:token`), and tapping it (`POST /checkin/:token`) checks them in.
3. **PorchPass correlates the check-in with Ring** — it looks up the most recent doorbell ("ding") or motion event
   on the front door within a 5-minute window and attaches it to the visit record, including the snapshot URL Ring
   would provide.
4. **Homeowner is notified** with who arrived and a link to the doorbell snapshot; the pass auto-expires once it
   hits its use limit, its time window closes, or the homeowner revokes it early (`DELETE /passes/:id`).
5. **Full audit trail** (`GET /visits`) — who came, when, and the Ring event tied to their arrival.

## Project layout

```
src/
  types.ts         Pass, Visit, RingEvent, Notification data model
  store.ts         In-memory pass/visit storage
  ringClient.ts    RingClient interface + SimulatedRingClient (the Ring integration seam)
  notify.ts        Notifier interface + LoggingNotifier (the SMS/push integration seam)
  passService.ts   Core access-control logic: issue, check in, expire, revoke
  server.ts        Express app: homeowner API, visitor check-in flow, Ring event ingress
  index.ts         Entry point
test/
  smoke.test.ts    End-to-end test over real HTTP: issue → doorbell event → check-in → audit trail →
                   single-use enforcement → multi-use enforcement → revocation → expiry
```

## Running it

```bash
npm install
npm run build
npm start
# PorchPass listening on http://localhost:4444
```

Or for local iteration: `npm run dev`

### Try it by hand

```bash
# 1. Issue a pass valid for the next 2 hours
curl -X POST localhost:4444/passes -H "Content-Type: application/json" -d '{
  "visitorName": "Alex the Dog Walker",
  "visitorPhone": "+15551234567",
  "validUntil": "2026-09-02T18:00:00Z",
  "note": "dog walker"
}'
# -> note the checkinToken in the response, and watch the console for the "SMS" the visitor received

# 2. Simulate a doorbell press (stands in for Ring's real webhook)
curl -X POST localhost:4444/ring/events -H "Content-Type: application/json" \
  -d '{"deviceId": "front-door", "type": "ding"}'

# 3. Visit the check-in link in a browser, or simulate the visitor's tap:
curl -X POST localhost:4444/checkin/<checkinToken> -H "Accept: application/json"

# 4. See the audit trail
curl localhost:4444/visits
```

## Testing

```bash
npm test
```

Starts the server on an ephemeral port and drives the full lifecycle over real HTTP requests: issuing a pass sends
a (simulated) SMS with a check-in link; a simulated doorbell event plus a visitor check-in produces a correlated
visit with a snapshot URL and a homeowner notification; a single-use pass rejects a second check-in; a `maxUses: 2`
pass allows exactly two; a revoked pass and an expired pass both correctly deny access. No external services
required.

## Swapping in the real Ring API

Everything in `src/passService.ts` and `src/server.ts` is Ring-agnostic — it only depends on the `RingClient`
interface (`getRecentEvents`, `emitEvent`) in `src/ringClient.ts`. To go from simulator to production:

1. Implement `RingClient` against Ring's OAuth-authenticated device API (see the `ring-api-helloworld` starter
   sample) instead of `SimulatedRingClient`.
2. Replace the `POST /ring/events` demo-ingress route in `server.ts` with a route that verifies and parses Ring's
   actual webhook payload, then appends it to the same event log `getRecentEvents` reads from.
3. Swap `LoggingNotifier` for a real SMS provider (Twilio) and/or push provider.

No change to the access-control logic itself (issuing, correlating, expiring, revoking passes) is needed — that
was the point of isolating Ring behind an interface from the start.

## Judging-criteria alignment

- **Tech Implementation:** Ring event correlation (doorbell/motion → snapshot) and camera-adjacent data are treated
  as first-class integration points, isolated behind a `RingClient` interface exactly where the hackathon rules
  allow a simulator — the swap to Ring's real API is a one-file change, not a rewrite.
- **Design:** A genuine "two-tap" flow — the homeowner issues a pass in one call, the visitor confirms with one tap
  and no app, account, or login. Passes fail closed (expired/revoked/used-up all deny access) rather than open.
- **Potential Impact:** Solves a real, everyday problem (dog walkers, deliveries, contractors, short-term rentals)
  that today gets solved insecurely (a shared permanent code) or not at all (no delegated access at all).
- **Quality of Idea:** Goes beyond a notification app by adding a genuine access-delegation layer — time-boxing,
  use-limits, revocation, and an audit trail — on top of Ring's event stream, one of the five explicitly
  prioritized Ring categories ("access control").

## Friction log

See [`FRICTION_LOG.md`](./FRICTION_LOG.md) for notes captured while building this (eligible for the hackathon's
judging bonus).
