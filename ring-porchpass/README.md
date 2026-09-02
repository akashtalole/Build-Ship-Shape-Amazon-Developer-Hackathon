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
  types.ts         Pass, Visit, RingEvent, Notification, RecurrenceRule data model
  store.ts         In-memory pass/visit storage + idempotency-key cache
  ringClient.ts    RingClient interface + SimulatedRingClient (the Ring integration seam)
  notify.ts        Notifier interface + LoggingNotifier (the SMS/push integration seam)
  passService.ts   Core access-control logic: issue, check in, expire, revoke
  recurrence.ts    Recurring-pass rule evaluation (daysOfWeek + time-of-day window)
  settings.ts      Household settings: quiet hours
  webhookAuth.ts   HMAC-SHA256 signing/verification for the Ring webhook ingress
  rateLimiter.ts   In-memory sliding-window rate limiter for check-in attempts
  eventBus.ts      Pub/sub used to push live events to SSE dashboard clients
  server.ts        Express app: homeowner API, visitor check-in flow, Ring event ingress, SSE stream
  index.ts         Entry point
test/
  smoke.test.ts    End-to-end test over real HTTP: issue → doorbell event → check-in → audit trail →
                   single-use enforcement → multi-use enforcement → revocation → expiry → idempotent
                   issuance → recurring passes → webhook signature verification → live SSE stream →
                   quiet hours → check-in rate limiting
```

## Running it

```bash
npm install
npm run build
npm start
# PorchPass listening on http://localhost:4444
```

Or for local iteration: `npm run dev`

### Environment variables (all optional)

| Variable                            | Default                                              | Purpose                                     |
| ------------------------------------ | ----------------------------------------------------- | -------------------------------------------- |
| `PORT`                                | `4444`                                                | HTTP port                                    |
| `RING_WEBHOOK_SECRET`                 | a clearly-marked **local-dev-only** default           | HMAC secret for `POST /ring/events` (see [§3](#3-webhook-signature-verification)) |
| `QUIET_HOURS_START` / `QUIET_HOURS_END` | unset (no quiet hours)                              | Initial quiet-hours window (`"HH:MM"`, UTC) — can also be set at runtime via `POST /settings` |

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

# 2. Simulate a doorbell press (stands in for Ring's real webhook — now signed, see "Webhook signature
#    verification" below for why)
BODY='{"deviceId": "front-door", "type": "ding"}'
SIGNATURE=$(node -e "console.log(require('node:crypto').createHmac('sha256', process.argv[1]).update(process.argv[2]).digest('hex'))" \
  "porchpass-local-dev-secret-DO-NOT-USE-IN-PRODUCTION" "$BODY")
curl -X POST localhost:4444/ring/events -H "Content-Type: application/json" -H "X-Ring-Signature: $SIGNATURE" -d "$BODY"

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
pass allows exactly two; a revoked pass and an expired pass both correctly deny access — then a second round covers
every feature in [Advanced features](#advanced-features) below. No external services required.

## Advanced features

Six additions on top of the v1 lifecycle, aimed at the kind of depth a real access-control service needs in
production, not just a demo.

### 1. Idempotency-key protected issuance

`POST /passes` accepts an optional `idempotencyKey`. Retrying the exact same issuance request (e.g. a mobile client
that isn't sure whether its first request made it through a flaky connection) with the same key returns the
**original** pass — no duplicate pass, no duplicate "you have access" SMS to the visitor. This mirrors how any real
payment or side-effecting API protects a retried request (Stripe, for example, does the same thing). Implemented
as a small `idempotencyKey -> passId` cache in `store.ts`, checked before a new pass is ever created.

```bash
curl -X POST localhost:4444/passes -H "Content-Type: application/json" -d '{
  "visitorName": "Alex the Dog Walker", "visitorPhone": "+15551234567",
  "validUntil": "2026-09-02T18:00:00Z", "idempotencyKey": "dog-walker-tuesday-001"
}'
# Run the exact same request again — same pass ID comes back, no second SMS sent.
curl -X POST localhost:4444/passes -H "Content-Type: application/json" -d '{
  "visitorName": "Alex the Dog Walker", "visitorPhone": "+15551234567",
  "validUntil": "2026-09-02T18:00:00Z", "idempotencyKey": "dog-walker-tuesday-001"
}'
```

### 2. Recurring passes

Instead of only a fixed one-off `validFrom`/`validUntil` window, a pass can carry a `recurrence` rule:

```json
{ "daysOfWeek": [2, 4], "startTime": "13:00", "endTime": "15:00" }
```

`daysOfWeek` uses `0`=Sunday..`6`=Saturday; `startTime`/`endTime` are `"HH:MM"` 24-hour clock values, interpreted in
**UTC** for consistency in this demo (a real deployment would store the household's IANA timezone alongside the
rule). `validFrom`/`validUntil` still apply as the *outer* bounds of the whole schedule (e.g. "good for the next 90
days") — the recurrence rule narrows validity further, to only the matching day-of-week/time-of-day slices within
that range. This is the realistic fix for "the weekly dog walker doesn't need a brand-new pass issued every week."
One-off passes that omit `recurrence` behave exactly as before — this is additive, not a breaking change.
`recurrence.ts` also handles a window that crosses midnight (`startTime` > `endTime`, e.g. an overnight `"22:00"` ->
`"02:00"` sitter window).

```bash
curl -X POST localhost:4444/passes -H "Content-Type: application/json" -d '{
  "visitorName": "Alex the Dog Walker", "visitorPhone": "+15551234567",
  "validUntil": "2026-12-01T00:00:00Z",
  "recurrence": { "daysOfWeek": [2, 4], "startTime": "13:00", "endTime": "15:00" },
  "note": "dog walker, Tue/Thu afternoons"
}'
```

### 3. Webhook signature verification

`POST /ring/events` — the Ring event ingress — now verifies an HMAC-SHA256 signature over the raw request body
against a shared secret, rejecting missing or invalid signatures with `401`. This mirrors how Ring's real webhook
delivery authenticates callers, and closes off the obvious hole in leaving a public event-ingress endpoint
unauthenticated: without it, anyone who finds the URL could forge doorbell/motion events. The secret comes from
`RING_WEBHOOK_SECRET`; if unset, a **clearly-marked local-dev-only default** (`DEFAULT_DEV_WEBHOOK_SECRET` in
`webhookAuth.ts`) is used so the demo and tests work with zero configuration — never rely on that default outside
local development. `webhookAuth.ts` exports `signPayload(secret, rawBody)`, the same helper the test suite and any
real Ring integration would use to compute the `X-Ring-Signature` header.

```bash
SECRET="porchpass-local-dev-secret-DO-NOT-USE-IN-PRODUCTION"  # or your $RING_WEBHOOK_SECRET
BODY='{"deviceId":"front-door","type":"ding"}'
SIGNATURE=$(node -e "console.log(require('node:crypto').createHmac('sha256', process.argv[1]).update(process.argv[2]).digest('hex'))" "$SECRET" "$BODY")

curl -X POST localhost:4444/ring/events \
  -H "Content-Type: application/json" \
  -H "X-Ring-Signature: $SIGNATURE" \
  -d "$BODY"
# A request with no X-Ring-Signature header (or a wrong one) gets 401.
```

### 4. Real-time homeowner event stream

`GET /events/stream` opens a Server-Sent Events connection: a homeowner's dashboard can hold it open and receive a
pushed `pass_issued`, `visit_checkin`, `pass_revoked`, or `pass_expired` event the instant it happens, instead of
polling `GET /visits`. `GET /visits` is unchanged and still the audit-trail source of truth — the stream is a
purely additive real-time layer on top, backed by a small pub/sub (`eventBus.ts`) that `passService.ts` publishes
to on every state-changing action.

```bash
curl -N localhost:4444/events/stream
# In another terminal, issue a pass or check a visitor in — the first terminal
# immediately prints an `event: pass_issued` / `event: visit_checkin` frame.
```

### 5. Quiet-hours enforcement

`POST /settings` sets a household-level quiet-hours window (`{ "quietHours": { "start": "22:00", "end": "07:00" } }`,
UTC, and handles crossing midnight the same way `recurrence.ts` does). Once set, `POST /checkin/:token` rejects
check-ins during that window with a clear reason — even for a pass whose own `validFrom`/`validUntil` or
`recurrence` window would otherwise allow it — unless the pass explicitly opts out with `"allowQuietHours": true`
(e.g. a pass for an overnight nurse or a legitimately late delivery). This layers a security-conscious household
policy on top of, not instead of, ordinary pass validity.

```bash
curl -X POST localhost:4444/settings -H "Content-Type: application/json" \
  -d '{"quietHours": {"start": "22:00", "end": "07:00"}}'
curl localhost:4444/settings   # see the current setting
# Clear it again:
curl -X POST localhost:4444/settings -H "Content-Type: application/json" -d '{"quietHours": null}'
```

### 6. Rate limiting on check-in attempts

`POST /checkin/:token` is, by design, the one endpoint in the system that doesn't require an account or login —
that's the whole point of the no-app-required flow, but it also makes it the one place someone could try to
brute-force or guess a `checkinToken`. Each token is capped at 5 check-in attempts per rolling 10-minute window
(valid or invalid tokens both count, since an unknown token is exactly what a guesser sends); the 6th attempt
within the window gets `429` with a clear "too many attempts" message. Implemented as an in-memory sliding window
in `rateLimiter.ts` — see [`FRICTION_LOG.md`](./FRICTION_LOG.md) for the multi-instance-deployment caveat that
comes with that choice.

## Swapping in the real Ring API

Everything in `src/passService.ts` and `src/server.ts` is Ring-agnostic — it only depends on the `RingClient`
interface (`getRecentEvents`, `emitEvent`) in `src/ringClient.ts`. To go from simulator to production:

1. Implement `RingClient` against Ring's OAuth-authenticated device API (see the `ring-api-helloworld` starter
   sample) instead of `SimulatedRingClient`.
2. Replace the payload parsing in the `POST /ring/events` route in `server.ts` with Ring's actual webhook payload
   shape, then append it to the same event log `getRecentEvents` reads from. The signature-verification wrapper
   around it (`webhookAuth.ts`) is written to mirror real webhook authentication and should carry over unchanged —
   just point `RING_WEBHOOK_SECRET` at the real shared secret Ring issues.
3. Swap `LoggingNotifier` for a real SMS provider (Twilio) and/or push provider.

No change to the access-control logic itself (issuing, correlating, expiring, revoking passes) is needed — that
was the point of isolating Ring behind an interface from the start.

## Judging-criteria alignment

- **Tech Implementation:** Ring event correlation (doorbell/motion → snapshot) and camera-adjacent data are treated
  as first-class integration points, isolated behind a `RingClient` interface exactly where the hackathon rules
  allow a simulator — the swap to Ring's real API is a one-file change, not a rewrite. The advanced round adds
  production-grade concerns that a hackathon demo usually skips entirely: HMAC-verified webhook ingress, an
  idempotency-safe write path, a real-time SSE push layer, and a rate limiter guarding the one intentionally
  unauthenticated endpoint.
- **Design:** A genuine "two-tap" flow — the homeowner issues a pass in one call, the visitor confirms with one tap
  and no app, account, or login. Passes fail closed (expired/revoked/used-up all deny access) rather than open, and
  now compose multiple independent policy layers cleanly (base validity → recurrence window → quiet hours) rather
  than tangling them into one conditional.
- **Potential Impact:** Solves a real, everyday problem (dog walkers, deliveries, contractors, short-term rentals)
  that today gets solved insecurely (a shared permanent code) or not at all (no delegated access at all).
  Recurring passes remove the friction of re-issuing a pass every week for a standing visitor, which is what would
  actually make this usable day-to-day rather than just for one-off events.
- **Quality of Idea:** Goes beyond a notification app by adding a genuine access-delegation layer — time-boxing,
  use-limits, revocation, and an audit trail — on top of Ring's event stream, one of the five explicitly
  prioritized Ring categories ("access control").

## Friction log

See [`FRICTION_LOG.md`](./FRICTION_LOG.md) for notes captured while building this (eligible for the hackathon's
judging bonus).
