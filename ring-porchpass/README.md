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
  types.ts            Pass, Visit, RingEvent, Notification, RecurrenceRule, Device, PassExtension, EncryptedField data model
  store.ts            In-memory pass/visit storage + idempotency-key cache + visitor-identity phone-lookup index (round 5)
  devices.ts          Ring device registry: implicit + explicit device registration (multi-device support)
  ringClient.ts        RingClient interface + SimulatedRingClient (the Ring integration seam)
  notify.ts            Notifier interface + LoggingNotifier (the SMS/push integration seam)
  passService.ts       Core access-control logic: issue, check in (link or voice), check out, expire, revoke,
                        grace-period extensions (with trust-gated auto-approval), geofence confirmation
  recurrence.ts        Recurring-pass rule evaluation (daysOfWeek + time-of-day window)
  settings.ts          Household settings: quiet hours, home location + geofence radius (round 5)
  household.ts         Household member directory + owner/member role checks (round 4)
  crypto.ts             AES-256-GCM field encryption for visitor PII at rest (round 4) + one-way phone lookup key (round 5)
  analytics.ts          Traffic/analytics report built from real visit history (round 4)
  trust.ts              Visitor trust scoring: explainable 0-100 score from real pass/visit history (round 5)
  geo.ts                GeoVerifier interface + SimulatedGeoVerifier (the geolocation integration seam, round 5)
  neighborhoodWatch.ts  Risk-pattern detection + signed neighborhood-watch alert broadcast (round 5)
  format.ts             Shared duration/day/hour formatting helpers (round 4)
  webhookAuth.ts        HMAC-SHA256 signing/verification for the *inbound* Ring webhook ingress
  outboundWebhooks.ts   HMAC-signed *outbound* webhook delivery (retry+backoff) — reused by neighborhoodWatch.ts too
  rateLimiter.ts        In-memory sliding-window rate limiter for check-in/checkout/voice-confirm/location-ping attempts
  eventBus.ts          Pub/sub used to push live events to SSE dashboard clients and outbound webhooks
  server.ts            Express app: homeowner API, visitor check-in/checkout flow, Ring event ingress, SSE stream
  index.ts             Entry point
test/
  smoke.test.ts    End-to-end test over real HTTP: issue → doorbell event → check-in → audit trail →
                   single-use enforcement → multi-use enforcement → revocation → expiry → idempotent
                   issuance → recurring passes → webhook signature verification → live SSE stream →
                   quiet hours → check-in rate limiting → multi-device correlation → outbound webhook
                   delivery → bulk/template issuance → grace-period extension approval/denial → visit
                   duration tracking → traffic analytics → household member roles → encrypted-at-rest PII →
                   visitor trust scoring (+ trust-gated auto-approval) → Alexa+ voice-confirmed check-in →
                   geofenced pass activation → neighborhood alert broadcast
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
| `PORCHPASS_ENCRYPTION_KEY`             | a clearly-marked **local-dev-only** default          | Key material for AES-256-GCM encryption of visitor PII at rest (see [§4 of Round 4 additions](#4-encrypted-at-rest-visitor-pii)) |

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
every feature in [Advanced features](#advanced-features), a third round covers every feature in
[Round 3 additions](#round-3-additions), a fourth round covers every feature in
[Round 4 additions](#round-4-additions), and a fifth round covers every feature in
[Round 5 additions](#round-5-additions) below — including spinning up two more real local HTTP listeners to verify a
neighborhood alert broadcast is independently signed per recipient, and computing a visitor's trust score across
multiple issued passes to confirm the score is exactly the sum of its explainable factors. No external services
required.

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

## Round 3 additions

Four more additions on top of everything above: multi-device support, outbound webhook notifications,
bulk/template pass issuance, and a grace-period extension flow for a visitor who just missed their window.

### 1. Multi-device support

Every device reference used to be hardcoded to a single `"front-door"` id. Now PorchPass has a small device
registry (`devices.ts`): a `Device` is `{ id, name, registeredAt, registeredVia }`, and a device needs no separate
setup step to be usable — the first pass that names it in `deviceIds`, or the first Ring event that arrives for
it, registers it right then with a name derived from the id (`"back-door"` → `"Back Door"`). `POST /devices` is
there for a homeowner who wants to register (or rename) a device explicitly, e.g. to give it a nicer name before
anything else references it. `"front-door"` is pre-registered by default, so a deployment that never touches this
feature sees the exact same single device it always implicitly had.

A pass can now specify which device(s) its check-in should correlate against via `deviceIds: string[]` — omit it
and a pass behaves exactly as before, correlating only against `"front-door"`. `POST /ring/events` accepts an event
for any device id, registering it on the way in.

```bash
# Register a device explicitly (optional — it would also be registered implicitly
# the first time a pass or event referenced "back-door")
curl -X POST localhost:4444/devices -H "Content-Type: application/json" \
  -d '{"id": "back-door", "name": "Back Door"}'
curl localhost:4444/devices   # -> front-door (pre-registered) + back-door

# Issue a pass scoped to the back door only
curl -X POST localhost:4444/passes -H "Content-Type: application/json" -d '{
  "visitorName": "Gardener", "visitorPhone": "+15551230000",
  "validUntil": "2026-12-01T00:00:00Z", "deviceIds": ["back-door"]
}'
# A front-door ding will NOT correlate with this pass's check-in; a back-door ding will.
```

### 2. Outbound webhook notifications

`GET /events/stream` (the SSE feed) is a *pull* model — a client has to hold a connection open. This adds the
*push* counterpart: a homeowner registers their own callback URL (`POST /settings/webhook { "url": "..." }`), and
PorchPass `POST`s a signed payload to it whenever a pass is issued, a visit happens, or a pass is revoked or
expires — the same four event types the SSE stream emits. Signing mirrors the *inbound* Ring webhook verification
exactly, just in the opposite direction: PorchPass generates a per-registration secret (returned once at
registration, and again from `GET /settings/webhook` so the homeowner's receiving endpoint can be configured to
verify it), computes an HMAC-SHA256 over the raw JSON body it's about to send using `webhookAuth.ts`'s same
`signPayload` helper, and sends it as `X-PorchPass-Signature`. The receiver verifies it exactly like
`ring/events`'s handler does for inbound Ring calls — recompute the same HMAC over the exact raw bytes received and
compare.

Delivery retries up to 3 times with exponential backoff (~300ms, then ~600ms) on a non-2xx response or network
error, and is genuinely fire-and-forget: `outboundWebhooks.ts` subscribes to the same `eventBus` `passService.ts`
already publishes to, and never `await`s the delivery — the request that triggered the event (issuing a pass,
checking a visitor in, ...) returns to its caller immediately, regardless of how slow or broken the homeowner's
endpoint is. Failures (and successes) are still observable: `GET /settings/webhook` reports the last delivery's
outcome (`lastSuccessAt`, `lastError`, `consecutiveFailures`, ...) instead of that information disappearing into a
server log no one's watching.

```bash
# Register a callback (any local HTTP listener works for testing)
curl -X POST localhost:4444/settings/webhook -H "Content-Type: application/json" \
  -d '{"url": "https://your-backend.example/porchpass-webhook"}'
# -> { "url": "...", "secret": "<hex secret — save this>", "createdAt": "..." }

curl localhost:4444/settings/webhook   # re-fetch the secret + last delivery status any time

# On the receiving end (Node, mirroring webhookAuth.ts's verifySignature):
node -e '
  const crypto = require("node:crypto");
  const secret = "<the secret from above>";
  const rawBody = "<the exact raw request body bytes your endpoint received>";
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  console.log(expected === "<the X-PorchPass-Signature header value>");
'
```

### 3. Bulk/template pass issuance

`POST /passes/bulk` issues many passes from one call: a shared `template` (fields common to every pass — e.g.
`visitorPhone`, `validUntil`, `note`) plus a `variations` array of per-pass overrides (a different `visitorName`
and `recurrence` per weekday, or the same visitor across a list of explicit date windows). Each variation is
merged onto the template and passed straight through to the existing `issuePass` — no separate issuance code path,
so idempotency, recurrence validation, device registration, notifications, and event-bus publishing all work
exactly as they do for a single `POST /passes`. An optional `idempotencyKeyPrefix` gives each item a stable,
distinct idempotency key (`` `${idempotencyKeyPrefix}${index}` ``) so retrying the whole bulk call is safe too.

The response lists one result per input item — `"created"`, `"replayed"` (an idempotency-key collision), or
`"error"` (e.g. a variation missing a required field after merging) — so one bad entry doesn't sink the rest of the
batch.

```bash
curl -X POST localhost:4444/passes/bulk -H "Content-Type: application/json" -d '{
  "template": { "visitorPhone": "+15556660000", "validUntil": "2026-12-01T00:00:00Z", "note": "weekly dog walker" },
  "variations": [
    { "visitorName": "Monday Walker",    "recurrence": { "daysOfWeek": [1], "startTime": "13:00", "endTime": "15:00" } },
    { "visitorName": "Wednesday Walker", "recurrence": { "daysOfWeek": [3], "startTime": "13:00", "endTime": "15:00" } },
    { "visitorName": "Friday Walker",    "recurrence": { "daysOfWeek": [5], "startTime": "13:00", "endTime": "15:00" } }
  ],
  "idempotencyKeyPrefix": "bulk-walkers-week1-"
}'
# -> { "results": [ { "index": 0, "status": "created", "pass": {...} }, ... ] }
```

### 4. Grace-period extension flow

A visitor who taps the check-in link moments after their pass expired used to get a flat rejection. Now, a pass
that expired within the last **30 minutes** (`GRACE_REQUEST_WINDOW_MS` in `passService.ts`) is flagged
`graceEligible: true` in the check-in response instead — the visitor-facing HTML page renders a "Request a few
more minutes" button, or a JSON client can call `POST /checkin/:token/request-extension` directly. That creates a
`"pending"` extension request on the pass and notifies the homeowner via the existing `Notifier` (no new
notification channel). The homeowner then approves (`POST /passes/:id/extension/approve`) or denies
(`POST /passes/:id/extension/deny`) it; only approval unlocks anything, and only for **15 more minutes**
(`EXTENSION_USABLE_WINDOW_MS`) and exactly **one** more check-in — after that single use (or once the 15 minutes
lapse unused), the pass is back to being flatly rejected, and a pass can only ever ask for one extension (a denied
or never-requested pass has no second chance to ask again).

```bash
# Visitor taps the link on an expired pass -> response includes "graceEligible": true
curl -X POST localhost:4444/checkin/<token> -H "Accept: application/json"

# Visitor requests a few more minutes
curl -X POST localhost:4444/checkin/<token>/request-extension -H "Accept: application/json"
# -> homeowner is notified via the existing Notifier

# Homeowner approves (or: .../extension/deny)
curl -X POST localhost:4444/passes/<passId>/extension/approve
# -> visitor is SMS'd a link; the very next check-in within 15 minutes succeeds, then the extension is spent
```

## Round 4 additions

Four more additions: visit duration tracking, a traffic/analytics report, household member roles, and
encrypted-at-rest visitor PII.

### 1. Visit duration tracking

A "visit" used to be a single instant — the moment a visitor tapped the check-in link. Now it's a pair: an arrival
(the existing `POST /checkin/:token`, unchanged) and, once the visitor taps "I'm leaving," a departure
(`POST /checkin/:token/checkout`). This is a **separate token action**, not a `direction` field folded into the
existing check-in endpoint — arrival already carries meaning specific to arriving (correlating a Ring event,
consuming a pass's use-count, enforcing quiet hours/recurrence/expiry) that a departure has no reason to re-run; a
visitor leaving doesn't need to pass the same gauntlet of validity checks that let them in, they just need to mark
that they left. Checkout finds the most recently opened visit for that pass that hasn't already been checked out of
and closes it, computing `durationMs` once at that moment. `GET /visits` now shows a `status` of `"on_site"` (with a
live `onSiteForMs`) for a visit with only an arrival, or `"completed"` (with the final `durationMs`) once a
departure closes it. A checkout with nothing open to close — no matching arrival at all, or a repeat call after
already checking out — is rejected with a clear reason instead of silently doing nothing or crashing (see
[`FRICTION_LOG.md`](./FRICTION_LOG.md) for that edge case).

```bash
# Visitor arrives (as before)
curl -X POST localhost:4444/checkin/<token> -H "Accept: application/json"
# -> { "ok": true, "visit": { "id": "...", "checkedInAt": "...", ... } }

# ...later, visitor leaves
curl -X POST localhost:4444/checkin/<token>/checkout -H "Accept: application/json"
# -> { "ok": true, "visit": { "checkedOutAt": "...", "durationMs": 734000, ... } }

curl localhost:4444/visits
# -> each visit now carries "status": "on_site" | "completed", and a completed one carries "durationMs"
```

### 2. Traffic/analytics report

`GET /analytics` (aliased at `GET /reports/traffic` — both return the identical report) aggregates real visit
history into plain-language insights, in the same spirit as the "StoreWatch" idea documented in
[`hackathon-ideas/ring.md`](../hackathon-ideas/ring.md) ("Tuesdays 2–4pm are your busiest window" rather than a raw
event log) — folded directly into PorchPass's own visit data instead of a separate project. It reports the busiest
day and hour (by arrival time, UTC), the average duration of completed visits, a count of visits per visitor and
per pass `note` category (e.g. "dog walker" vs. "delivery" — joined from each visit's pass), how many visitors are
currently on-site, and an `insights` array of ready-to-display sentences built from those same numbers. There's no
separate analytics data store to keep in sync — every number comes straight from `store.ts`'s existing `Visit`
records, so the report is always as current as the last check-in or checkout.

```bash
curl localhost:4444/analytics
# -> {
#   "totalVisits": 12, "completedVisits": 9, "onSiteNow": 3,
#   "busiestDay": { "day": "Tuesday", "count": 5 },
#   "busiestHour": { "hourUtc": 14, "label": "2 PM", "count": 4 },
#   "averageVisitDurationMs": 1080000,
#   "visitsByVisitor": [ { "visitorName": "Alex the Dog Walker", "count": 4 }, ... ],
#   "visitsByCategory": [ { "category": "dog walker", "count": 5 }, { "category": "delivery", "count": 3 }, ... ],
#   "insights": [
#     "Tuesday is your busiest day (5 visits).",
#     "Most visits happen around 2 PM UTC (4 visits).",
#     "The average completed visit lasts 18 minutes.",
#     "\"dog walker\" is your most common visit type (5 visits).",
#     "3 visitors are currently on-site."
#   ]
# }
```

### 3. Household member roles

More than one homeowner/admin can now exist per household, with different permission levels: `owner` can revoke
passes, approve/deny grace-period extensions, and manage household settings/webhooks; `member` can issue and view
passes but not any of those owner-scoped actions. This is deliberately the simplest thing that demonstrates real
authorization scoping without inventing a full auth system: there's no login, password, or session — a caller
identifies themselves with a plain `X-PorchPass-Member` header (or `?member=`, so a browser/curl GET can supply one
too) naming a registered member id in the household directory (`household.ts`). **This is illustrative
authorization, not real authentication** — a caller-supplied header proves nothing about who's actually holding the
phone that sent it; a real deployment needs actual authenticated sessions (each member signs in; the server reads
their identity off a verified session/JWT, never a client-supplied header). See `household.ts`'s doc comment and
[`FRICTION_LOG.md`](./FRICTION_LOG.md) for the honest version of this tradeoff.

A caller who supplies **no** member header at all resolves to a pre-seeded default `"owner"` — which is what keeps
every endpoint and every test from every earlier round working completely unchanged, since nothing before this
round had any notion of a "caller" to begin with. An unrecognized member id is a hard `401`, not a silent fallback
to the lowest privilege; a recognized id with the wrong role is a `403`.

```bash
# See the household's members (starts with just the pre-seeded owner)
curl localhost:4444/household/members

# The default owner adds a member-role household member (no header needed — no header = owner)
curl -X POST localhost:4444/household/members -H "Content-Type: application/json" \
  -d '{"id": "jamie", "name": "Jamie", "role": "member"}'

# Jamie (a member) tries to revoke a pass -> 403
curl -X DELETE localhost:4444/passes/<passId> -H "X-PorchPass-Member: jamie"

# The owner revokes it instead -> 200
curl -X DELETE localhost:4444/passes/<passId> -H "X-PorchPass-Member: owner"
```

### 4. Encrypted-at-rest visitor PII

A visitor's phone number is now encrypted at rest (AES-256-GCM, `crypto.ts`) — the in-memory `Pass` record stores an
`EncryptedField` (`{ iv, authTag, ciphertext }`, all hex), never the plaintext number, and it's decrypted only at
the one moment it's actually needed: sending the visitor's SMS (on issuance, and on an approved grace-period
extension). The API itself never re-exposes the full number either — `POST /passes`/`GET /passes` return a masked
`visitorPhone` (e.g. `"••••••••1234"`) so a homeowner can still recognize which visitor a pass belongs to without
the wire response carrying the plaintext value back out. **This is illustrative, not production key management**:
the encryption key is derived (via `scrypt`, meant for passwords, not real key derivation) from
`PORCHPASS_ENCRYPTION_KEY`, or a clearly-marked local-dev default if unset — good enough that the demo and test
suite encrypt/decrypt correctly with zero configuration, and nowhere near what a real deployment should do. A real
deployment must pull its data-encryption key from a proper KMS (AWS KMS, etc.), ideally via envelope encryption —
see [`FRICTION_LOG.md`](./FRICTION_LOG.md) for what that gap actually costs a from-scratch hackathon build.

```bash
# Issue a pass — the response's visitorPhone is masked, not the plaintext you sent.
curl -X POST localhost:4444/passes -H "Content-Type: application/json" -d '{
  "visitorName": "Alex the Dog Walker", "visitorPhone": "+15551234567",
  "validUntil": "2026-12-01T00:00:00Z"
}'
# -> { ..., "visitorPhone": "••••••••4567", ... }
# Meanwhile the console log for the (simulated) SMS send still shows the real
# number — decrypted right there, at the point of actually sending it.
```

## Round 5 additions

Four genuinely new capabilities, not more infrastructure hardening: visitor trust scoring, an Alexa+ ecosystem
tie-in, simulated geofenced pass activation, and neighborhood alert broadcast. Every prior round added a production
concern (webhooks, roles, rate limiting, encryption) — this round adds functionality a homeowner would actually
notice and want.

### 1. Visitor trust scoring

PorchPass already tracks a visitor's phone number per pass (encrypted at rest since round 4) — round 5 correlates
it *across* every pass and visit a visitor has ever had, via a one-way HMAC-SHA256 "lookup key"
(`crypto.ts#phoneLookupKey`) that is never the plaintext number and can't be reversed back into one, only compared.
`GET /visitors/:phone/trust` turns that history into a deterministic, fully explainable 0-100 score: no ML, no
hidden weights — the score is nothing more than the sum of a `factors` array, each entry naming exactly which real
signal moved the score and by how much. The signals are all things already sitting in `store.ts`: completed visits
(arrived *and* checked out cleanly, +8 each up to +40), revocations (the household actually revoked a pass, -25
each up to -50), no-shows (a pass that expired without the visitor ever checking in at all, -15 each up to -45),
and late arrivals (a visit that only succeeded via a homeowner-approved grace-period extension — i.e. outside the
pass's own expected window, -10 each up to -30).

```bash
curl "localhost:4444/visitors/%2B15551234567/trust"   # %2B is a URL-encoded '+'
# -> {
#   "visitorPhone": "••••••••4567", "score": 58, "passesConsidered": 2,
#   "completedVisits": 1, "revocations": 0, "noShows": 0, "lateArrivals": 0,
#   "factors": [
#     { "label": "Baseline score for any visitor, with or without history", "delta": 50 },
#     { "label": "1 completed visit (arrived and checked out cleanly)", "delta": 8 }
#   ]
# }
```

Trust scoring also plugs directly into pass issuance and the existing grace-period extension flow, rather than
sitting off to the side as a read-only report: a pass can carry `autoApproveExtensionsAboveTrust: <N>`, and the
*next* time that visitor's pass expires and they request a few more minutes
(`POST /checkin/:token/request-extension`), PorchPass checks their current trust score against `N` and — if it
clears the bar — approves the request instantly via the exact same `decideExtension` code path a manual homeowner
approval takes, instead of waiting on the homeowner to decide every single time. This is the "auto-approve future
recurring visits above trust N" behavior a homeowner would actually want for a standing dog walker or cleaner,
without ever having to trust a black box to make the call.

```bash
# A homeowner issuing a pass for a long-standing, trusted visitor:
curl -X POST localhost:4444/passes -H "Content-Type: application/json" -d '{
  "visitorName": "Alex the Dog Walker", "visitorPhone": "+15551234567",
  "validUntil": "2026-12-01T00:00:00Z", "autoApproveExtensionsAboveTrust": 70
}'
# The next time Alex's pass expires and they request a few more minutes, if their
# trust score is already >= 70, they're approved instantly — no round trip to the
# homeowner's phone required. Below 70, it still waits on a manual decision exactly
# like every prior round's extension flow.
```

### 2. Alexa+ ecosystem tie-in: voice-verified check-in confirmation

This hackathon explicitly rewards ideas that combine tracks. `POST /passes/:id/voice-confirm` is the integration
seam for a real Alexa+ skill (or an MCP client speaking for one): instead of the visitor tapping their link, a
household member confirms the visitor's identity out loud in response to a doorbell announcement — "yes, let the
dog walker in" — and the skill calls this endpoint on their behalf. In production this would be a small MCP tool
an Alexa+-connected client calls, exactly mirroring how `ringClient.ts` is the documented seam for the real Ring
API: this endpoint *is* the seam, not a stub waiting to be replaced.

Crucially, voice confirmation doesn't bypass a single access-control rule — it's the exact same `performCheckIn`
policy engine as the link flow (recurrence windows, quiet hours, geofencing, expiry, revocation, use-limits), just
identified by pass ID instead of a check-in token and confirmed by a household member instead of the visitor. The
resulting `Visit` record carries `confirmedVia: "voice"` and `confirmedByMember` so the audit trail
(`GET /visits`) always shows *how* someone got in, not just that they did. Any known household member — not just
the owner — can voice-confirm a visitor, the same way any adult in a real household could plausibly say "let them
in."

```bash
# A household member says "yes, let the dog walker in" — the skill resolves that to a pass and calls:
curl -X POST localhost:4444/passes/<passId>/voice-confirm -H "X-PorchPass-Member: jamie"
# -> { "ok": true, "visit": { "confirmedVia": "voice", "confirmedByMember": "jamie", ... }, ... }
```

### 3. Geofenced pass activation (simulated)

A check-in link is only as secure as knowing it can't be used from anywhere in the world the moment it's
intercepted. A pass issued with `requireGeofence: true` adds a location constraint on top of everything else: it
can't check in (by link *or* by voice) until a simulated location ping
(`POST /passes/:id/location-ping { lat, lng }`) confirms the visitor is within the household's configured home
radius (`POST /settings/location`). There's no real geolocation hardware available in this sandboxed environment,
so — exactly the same pattern `ringClient.ts` uses for Ring itself — the "real" location source sits behind a small
`GeoVerifier` interface (`geo.ts`); `SimulatedGeoVerifier` does the honest haversine-distance math on whatever
coordinates it's given, with a doc comment spelling out what a production implementation actually needs instead (a
companion mobile app's native geolocation API, which layers in real anti-spoofing a raw POST body can't provide).

```bash
curl -X POST localhost:4444/settings/location -H "Content-Type: application/json" \
  -d '{"lat": 37.7749, "lng": -122.4194, "radiusMeters": 150}'

curl -X POST localhost:4444/passes -H "Content-Type: application/json" -d '{
  "visitorName": "Delivery Driver", "visitorPhone": "+15557778888",
  "validUntil": "2026-12-01T00:00:00Z", "requireGeofence": true
}'
# -> check-in is rejected with reasonCode "geofence" until:
curl -X POST localhost:4444/passes/<passId>/location-ping -H "Content-Type: application/json" \
  -d '{"lat": 37.7749, "lng": -122.4194}'
# -> { "ok": true, "withinRadius": true, "distanceMeters": 0.4, ... } — check-in now succeeds.
```

### 4. Neighborhood alert broadcast

Ring itself leans heavily into community safety (Neighbors); this models the same idea for PorchPass's own risk
signals. `neighborhoodWatch.ts` watches every check-in attempt for two real risk patterns: three or more
failed/expired check-in attempts on the *same* pass within a 5-minute window, or any attempt at all on a pass the
household has already revoked. The moment either pattern fires, PorchPass broadcasts a signed "neighborhood watch"
alert to every *other* simulated household that's opted in (`POST /neighborhood/subscribers`) — not just the
owning household's own SSE feed or outbound webhook. Delivery reuses the exact same HMAC-signing-with-retry
mechanism as the existing outbound webhook (`outboundWebhooks.ts#deliverSignedPayload`), just fanned out to a list
of recipients, each with their own PorchPass-generated secret, rather than a second delivery implementation.

```bash
# Two "neighbor" households opt in (owner-only to register):
curl -X POST localhost:4444/neighborhood/subscribers -H "Content-Type: application/json" \
  -d '{"url": "https://neighbor-a.example/porchpass-watch"}'
curl -X POST localhost:4444/neighborhood/subscribers -H "Content-Type: application/json" \
  -d '{"url": "https://neighbor-b.example/porchpass-watch"}'
# -> { "id": "...", "url": "...", "secret": "<save this — the neighbor verifies with it>", "addedAt": "..." }

# Someone tries a revoked pass, or hammers a pass 3+ times in 5 minutes — both neighbors
# receive a signed POST like:
# { "event": "neighborhood_watch_alert",
#   "alert": { "type": "checkin_after_revocation", "passId": "...", "visitorName": "...", "detail": "..." } }

curl localhost:4444/neighborhood/alerts   # the broadcast log, for observability
```

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
  unauthenticated endpoint. Round 3 adds the symmetric *outbound* half of that webhook story (signed, retried,
  non-blocking delivery) and generalizes the whole system from one hardcoded device to a real multi-device
  correlation model. Round 4 adds authorization scoping (owner vs. member roles) and encryption-at-rest for
  visitor PII — the two production concerns a real access-control service can't ship without, alongside turning
  raw visit history into an actual analytics report instead of just a log. Round 5 shifts from hardening to genuine
  new functionality: a real (if intentionally simple) scoring model built entirely from existing store data, a
  second simulated-hardware seam (`GeoVerifier`, mirroring `RingClient`'s exact pattern) for geofencing, an
  Alexa+ integration point that reuses the whole existing check-in policy engine rather than a parallel one, and a
  broadcast feature that fans the existing outbound-webhook signing/retry mechanism out to N recipients instead of
  one.
- **Design:** A genuine "two-tap" flow — the homeowner issues a pass in one call, the visitor confirms with one tap
  and no app, account, or login (or, since round 5, a household member confirms by voice instead). Passes fail
  closed (expired/revoked/used-up all deny access) rather than open, and now compose multiple independent policy
  layers cleanly (base validity → recurrence window → geofence → quiet hours → grace-period extension) rather than
  tangling them into one conditional. The extension flow specifically turns a hard failure mode ("you were 90
  seconds late, tough luck") into a graceful, homeowner-approved — or, once trust is established, instantly
  auto-approved — recovery path instead of just a bigger grace window applied blindly to everyone.
- **Potential Impact:** Solves a real, everyday problem (dog walkers, deliveries, contractors, short-term rentals)
  that today gets solved insecurely (a shared permanent code) or not at all (no delegated access at all).
  Recurring passes remove the friction of re-issuing a pass every week for a standing visitor; bulk/template
  issuance removes the friction of doing that by hand one pass at a time, which is what would actually make this
  usable for a household managing several standing visitors rather than just one. The traffic/analytics report
  turns a household's own visit history into the kind of operational insight the "StoreWatch" idea in
  `hackathon-ideas/ring.md` proposes for small businesses — real value for a household with several standing
  visitors, not just a security log nobody reads. Round 5's trust scoring removes the last real friction of a
  recurring pass (being asked to approve the same trusted visitor's edge cases over and over), voice confirmation
  meets a homeowner where Ring's own ecosystem is headed (Alexa+), geofencing closes the one gap a link-based
  system can't otherwise close (a leaked link being usable from anywhere), and the neighborhood broadcast turns an
  individual household's risk signal into the kind of community safety net Ring already invests in at the product
  level (Neighbors) — genuinely new value, not more plumbing.
- **Quality of Idea:** Goes beyond a notification app by adding a genuine access-delegation layer — time-boxing,
  use-limits, revocation, and an audit trail — on top of Ring's event stream, one of the five explicitly
  prioritized Ring categories ("access control"). Multi-device support and outbound webhooks both point at the
  same underlying idea: a household's real security setup usually has more than one camera and more than one
  place it wants to be told about events, and both features generalize a single-instance assumption baked into
  earlier rounds rather than bolting on something unrelated. A real household also usually has more than one
  adult with access-control authority (round 4's owner/member roles) and cares that a visitor's phone number isn't
  sitting in plaintext in whatever store PorchPass runs on (round 4's encryption-at-rest) — both are the kind of
  detail a demo can skip and a real deployment can't. Round 5 is the round that stops treating every visitor
  identically: a visitor's own history now informs how much friction they face next time, exactly the kind of
  judgment a human homeowner already applies informally and PorchPass can now make explicit and explainable
  instead of leaving it to memory.

## Friction log

See [`FRICTION_LOG.md`](./FRICTION_LOG.md) for notes captured while building this (eligible for the hackathon's
judging bonus).
