# Friction Log — PorchPass

Notes captured while building the Ring PorchPass submission, for the hackathon's optional friction-log bonus.

## What worked well

- Isolating Ring itself behind a small `RingClient` interface (`getRecentEvents` + `emitEvent`) made the
  access-control logic (issuing, correlating, expiring, revoking passes) fully testable from minute one, without
  waiting on Ring partner API credentials or physical hardware — and the hackathon rules explicitly allow this
  ("APIs, SDKs, simulators, or devices").
- A no-JS, form-POST check-in page (`GET`/`POST /checkin/:token`) matches the idea's "no-app-required" design goal
  literally: it works in any browser a visitor's phone already has, with zero client-side dependencies.
- Testing over real HTTP (`fetch` against a live `http.Server`) rather than calling service functions directly
  caught the one bug worth catching: the JSON vs. HTML response branching in `POST /checkin/:token` needed an
  explicit `Accept: application/json` header from the test client, which a unit test calling `checkIn()` directly
  would never have exercised.

## Friction encountered

1. **Ring's actual partner API requires an approved developer account and OAuth credentials** that aren't
   available in a sandboxed environment, so there's no way to validate the real webhook payload shape or the real
   snapshot-URL signing scheme against production Ring without that access. The `ring-api-helloworld` sample
   (mentioned in the hackathon resources) is the natural next step for anyone with real credentials, but its
   webhook payload shape isn't visible from the public docs alone — a published webhook payload schema (event
   type, device ID, snapshot/clip URL fields) would let a team build the real `RingClient` without needing live
   credentials just to see the shape.
2. **No standard for "delegated access" as a Ring concept.** Ring's own app supports shared users, but there's no
   first-party notion of a time-boxed, single-use, no-account guest pass — this had to be modeled entirely as an
   application-layer concept on top of raw doorbell/motion events. That's arguably the right layer for it to live,
   but it means every team solving this problem re-invents the same primitives (expiry, use-count, revocation).

## Feature requests

- A published (even unofficial/community) reference for Ring's real webhook payload shape, so `RingClient`
  implementations can be written and reviewed before a team has live partner credentials.
- Ring smart lock integration (if/when available to third-party developers) would let PorchPass close the loop
  fully — auto-unlocking on a valid check-in instead of only notifying the homeowner — which is the natural
  evolution of this idea once lock control is exposed.

## Round 2: advanced features

Notes from adding idempotent issuance, recurring passes, webhook signing, the SSE stream, quiet hours, and
check-in rate limiting on top of the v1 lifecycle above.

### What worked well

- Composing the new checks (`recurrence`, quiet hours) as independent early-return guards inside `checkIn()`,
  layered on top of the existing `effectiveStatus` check, kept each concern legible on its own — reading the
  function top to bottom now reads like a policy list (token valid? not expired/revoked/used-up? recurrence window?
  quiet hours?) rather than one tangled conditional. Each guard also returns its own specific `reason` string,
  which the smoke test then asserts on directly — a good forcing function for keeping rejection reasons meaningful
  instead of a generic "access denied."
- Reusing the *same* "HH:MM in UTC, handle start > end as crossing midnight" logic shape for both `recurrence.ts`
  and `settings.ts`'s quiet hours (rather than trying to unify them into one shared function, since one has a
  day-of-week dimension and the other doesn't) made both easy to reason about independently without forcing a
  premature abstraction.

### Friction encountered

1. **SSE + Express interop needed the raw `http.ServerResponse`, not the high-level `res.json()`/`res.send()`
   surface.** `res.writeHead()` + repeated `res.write()` calls work fine under Express (it's still just Node's
   `http.ServerResponse` underneath), but this is a different code shape from every other route in `server.ts`,
   and it's easy to forget to also handle client disconnects (`req.on("close", ...)`) — without that, every SSE
   connection would leak an `eventBus` listener forever. Testing this over real HTTP (rather than mocking) is what
   caught the need for a heartbeat comment line too: some intermediary would otherwise time out a connection that
   looks idle between real events.
2. **Testing a push-based stream from a script that also *causes* the push is inherently a race** — the test has
   to open the SSE connection, register a reader, *then* trigger the action, and be prepared to wait (with a
   timeout) for the frame to arrive asynchronously, rather than asserting synchronously like every other check in
   the suite. Node's `fetch()` returning a Web `ReadableStream` (not an async-iterable-friendly Node stream by
   default in every version) meant hand-rolling a small buffered frame-reader over `getReader()` rather than
   reaching for a one-liner.
3. **Recurrence and quiet-hours midnight-crossing is the kind of edge case that's trivial to get backwards.** The
   naive `now >= start && now <= end` check silently produces a rule that can *never* match once `start > end`
   (e.g. a `"22:00"`->`"02:00"` overnight window) instead of erroring loudly, which would have been a very quiet
   correctness bug in production — an overnight dog-sitter's pass would just never work, with no error message
   pointing at why. Writing it as an explicit `if (start < end) { same-day } else { crosses midnight }` branch
   (rather than trying to be clever with a single modular-arithmetic expression) kept it readable and testable.
4. **HMAC verification only works if the exact bytes that were signed are the exact bytes being re-hashed** — using
   `JSON.stringify(req.body)` *after* Express has already parsed the request would silently break verification the
   moment key order or whitespace differs from what the sender actually transmitted (both realistic: `JSON.stringify`
   is deterministic per-engine but not across languages, and a real webhook sender is very unlikely to serialize a
   payload the exact same way `JSON.stringify` in Node does). The fix was capturing the raw bytes via
   `express.json({ verify: (req, res, buf) => ... })` before parsing discards them, and signing/verifying against
   that buffer specifically — a subtlety easy to miss if you reach for `req.body` out of habit everywhere else.
5. **In-memory rate limiting is a single-instance-only mitigation.** A sliding window keyed by `checkinToken` in a
   plain `Map` is the right complexity for this hackathon deployment (one process, one demo), but it's worth being
   explicit that it does *not* survive a restart and does *not* work correctly the moment there's more than one
   server instance behind a load balancer — an attacker split across two instances gets 2x the effective limit.
   A real production deployment needs a shared store (Redis `INCR` + `EXPIRE`, or a managed rate-limiting service)
   keyed the same way. Worth flagging explicitly rather than letting "it's rate-limited" imply more robustness than
   the current implementation actually provides.

## Round 3: multi-device, outbound webhooks, bulk issuance, grace-period extensions

Notes from generalizing the single-device assumption baked into every earlier round, adding the outbound half of
the webhook story, bulk/template issuance, and a homeowner-approved grace-period extension flow.

### What worked well

- **Making device registration implicit, not a prerequisite, avoided inventing a whole extra "onboarding" concept**
  for a feature that's otherwise small. The temptation with "add a device registry" is to also design a setup
  wizard, validation for device types, capability negotiation, etc. — none of which this problem actually needed.
  Letting the first pass or Ring event that names a `deviceId` register it on the spot (with `POST /devices` only
  for a homeowner who wants a nicer name up front) kept the feature exactly as big as the requirement, and it
  matches how `store.ts`'s idempotency-key cache and `settings.ts`'s single mutable record already treat "the
  simplest thing that satisfies the requirement" as the right default for a project this size.
- **Reusing `eventBus.subscribe` for outbound webhook delivery, instead of adding a second call site inside
  `passService.ts`,** kept `passService.ts` completely unaware that outbound webhooks exist at all — it just
  publishes to the same bus it always has, and `outboundWebhooks.ts` decides independently whether anyone's
  listening. That's the same seam the SSE stream already uses, so the "outbound webhook is the push counterpart to
  the pull-based SSE stream" framing in the README isn't just a marketing line — it's true at the code level too:
  both are just different subscribers on the same bus.
- **Reusing `issuePass` unchanged for bulk issuance, by merging `template` + each `variation` into one plain object
  and calling `issuePass` once per item,** rather than writing a parallel "bulk-issue" code path, meant idempotency,
  recurrence validation, and device registration all worked correctly for free on the first try — there was no
  second implementation to have forgotten to update when (for example) `deviceIds` was added to `issuePass`
  slightly earlier in this same round.

### Friction encountered

1. **Designing retry-with-backoff that's genuinely fire-and-forget took more care than "just don't `await` it."**
   The easy trap is writing `deliverWithRetry(...)` without `void` and letting the surrounding function's return
   type or a linter nudge you toward awaiting it "to be safe" — which would silently reintroduce exactly the
   blocking behavior the feature is supposed to avoid, since `eventBus.emit` is a synchronous call inside
   `passService.ts`'s request-handling path. The fix was making the non-blocking property structural rather than a
   matter of remembering to omit `await`: `outboundWebhooks.ts`'s `eventBus.subscribe` callback is not declared
   `async`, so there's no `await` keyword available inside it to reach for in the first place, and `deliverWithRetry`
   is invoked with an explicit `void` at the one call site — the type of "can't accidentally get this wrong later"
   fix that's worth the extra line.
2. **The extension state machine needed an explicit "already asked" guard, or it would have silently become an
   infinite-retry loop.** The first draft let `POST /checkin/:token/request-extension` succeed any time the pass
   was expired-and-within-window, with no check for an existing request — which meant a denied visitor (or a
   confused client retrying) could just ask again immediately, turning "the homeowner denied it" into "the
   homeowner has to keep denying it." Modeling `Pass.extension` as `undefined -> pending -> approved | denied`
   with no way back to `undefined` made "already decided" a state the code can check for directly
   (`if (pass.extension) reject`), rather than something that had to be reasoned about separately in every caller.
3. **Multi-device correlation needed the "which devices does this pass care about" question answered *before* the
   Ring-event-lookup question, not folded into it** — it would have been easy to write `getRecentEvents` itself to
   take an array and hide the fan-out inside `ringClient.ts`, but that conflates "how many devices a client wants
   to query" (a `passService.ts` concern — the pass's own `deviceIds`) with "how one device's event log is queried"
   (a `RingClient` concern, which shouldn't need to know passes exist at all). Keeping `RingClient.getRecentEvents`
   single-device and doing the `Promise.all` + merge-and-sort fan-out in `passService.checkIn` instead kept the
   `RingClient` interface exactly as small as it was when it only had to support one device, which matters for
   [Swapping in the real Ring API](./README.md#swapping-in-the-real-ring-api) staying a one-file change.
4. **Skipping the recurrence check when a grace-period extension is in play, but *not* skipping the quiet-hours
   check, is an asymmetry that's easy to get backwards** — both are "narrow an otherwise-valid pass further"
   guards that look structurally identical in `checkIn()`. The reasoning that settled it: recurrence narrows
   validity *within* the pass's own outer `[validFrom, validUntil]` window, which by definition has already ended
   once an extension is relevant, so re-checking it is moot; quiet hours is an independent household-level policy
   that has nothing to do with any individual pass's schedule, so there's no reason an extension should bypass it.
   Writing that reasoning down directly as a code comment next to the `!usingExtension &&` guards (rather than
   leaving future-me to rediscover it by re-deriving the same argument) was the actual fix, not the logic itself.

## Round 4: visit duration, traffic analytics, household roles, encrypted-at-rest PII

Notes from pairing arrivals with departures, turning raw visit history into an analytics report, adding
household-member authorization scoping, and encrypting visitor PII at rest.

### What worked well

- **Making checkout a separate token action instead of a `direction` field on the existing check-in endpoint**
  avoided smuggling a second, mostly-unrelated meaning into `checkIn()`'s already-long list of validity guards
  (recurrence, quiet hours, rate limiting, grace-period extensions — see Round 2/3 notes above). A departure
  doesn't need to re-run any of that; it just needs to find the open visit and close it. Keeping them as genuinely
  different functions (`checkIn` vs. `checkOut`) made that asymmetry obvious in the code instead of buried inside
  one function's branching on a `direction` parameter.
- **Reusing the exact same rate-limiter function for checkout, on an independently-keyed budget
  (`` `checkout:${token}` ``)** rather than either skipping rate-limiting on checkout entirely or sharing the
  arrival token's budget, cost one string template and nothing else — and it meant not having to make (and
  justify) a judgment call about whether checkout "deserves" its own protection separately from arrival.
- **`serializePass` as one function, called at every route that returns a `Pass`**, was the right amount of
  refactor for adding field-level encryption without turning it into a bigger project than it needed to be. The
  temptation with "mask a field in API responses" is to reach for a general-purpose response-serialization
  middleware or a schema library; a single small function, applied at each of the (already small number of) call
  sites that hand a `Pass` back to an HTTP caller, was easy to audit for "did I actually apply this everywhere" —
  the actual risk with this approach, see below.

### Friction encountered

1. **Adding a masked/derived field to every API response touching `Pass` is exactly the kind of change that's easy
   to apply in most places and quietly miss in one.** `POST /passes`, `GET /passes`, `DELETE /passes/:id`,
   `POST /passes/bulk`, both extension-decision routes, and the check-in/request-extension results all independently
   construct a JSON response containing a `pass` — there's no single funnel every `Pass` object passes through on
   its way out. The actual fix was grepping every `res.json(` and `res.status(...).json(` call in `server.ts` after
   making the change, one at a time, rather than trusting "I think I got them all" — a genuinely production version
   of this would want a lint rule or a type-level guarantee (e.g. a branded `PassView` type that a route literally
   cannot construct except via `serializePass`) rather than relying on a manual audit catching every call site
   forever.
2. **Deciding what "encrypted at rest" should mean for a field the API still needs to show *something* useful for**
   took more thought than "just encrypt it." The requirement is specifically that the *raw stored representation*
   never contains the plaintext — it says nothing about whether the API may show the real number to the household
   that owns it, which is arguably fine on its own (it's the visitor's own number, given voluntarily, to the
   household they're visiting). The design that felt most defensible: encrypt at rest unconditionally, decrypt
   fully only at the one place with an actual technical need (sending the SMS), and show the API a masked value
   everywhere else — good enough to recognize which visitor a pass is for, without every response over the wire
   carrying the full number back out just to render a list. A different, equally reasonable team could have decided
   the API should show the full number to an authenticated household member; the point that mattered here was
   picking one answer and being explicit about which one, not stumbling into either accidentally.
3. **A demo's encryption key management is the same shape of "clearly-marked, not-for-production" tradeoff every
   earlier secret in this project made (the webhook HMAC secret, the rate limiter's in-memory store) — but it's
   worth being extra explicit about here, since "encrypted at rest" reads as a much stronger claim to a reviewer
   than it actually is if the key itself is derivable from a hardcoded string.** `crypto.ts`'s key is derived via
   `scrypt` — a slow KDF built for hashing *passwords*, not for deriving a data-encryption key — from an env var or,
   absent one, a string checked into the repository in plaintext. That's fine for a demo whose entire point is
   "show the mechanism works," and outright dangerous the moment `PORCHPASS_ENCRYPTION_KEY` isn't set in a real
   deployment: anyone with the source can derive the same key and decrypt everything it ever encrypted. The honest
   fix isn't a stronger KDF (that doesn't solve the actual problem, which is *where the key material comes from*,
   not how it's stretched) — it's a proper KMS integration: the application never holds a long-lived plaintext key
   at all, only ever requesting a short-lived plaintext *data* key from KMS for the duration of one encrypt/decrypt
   call (envelope encryption), with the long-lived key itself staying inside the KMS boundary permanently. That's a
   real integration (IAM roles/permissions, a KMS client, key rotation policy) well beyond what a sandboxed
   hackathon environment can stand up, which is exactly why it's called out explicitly here rather than silently
   glossed over by the word "encrypted."
4. **The visit-duration state machine's edge cases are easy to under-specify until you actually try to write the
   rejection message.** "A checkout with nothing to close" turns out to bundle two different situations — a
   visitor who taps "I'm leaving" without ever having checked in at all (a bad/forged link, or a UI bug), and one
   who taps it twice (a double-tap, or a retried request after a flaky connection) — that could plausibly deserve
   different reasons ("you haven't checked in yet" vs. "you already checked out"). The implementation deliberately
   collapses them into one message (`findOpenVisitForPass` returning nothing either way) rather than trying to
   distinguish "never arrived" from "already departed," since from the checkout endpoint's point of view they're
   the same action to take (reject, cleanly, with no state change) — but it's a real design choice, not an
   oversight, and worth naming as one rather than let a future reader assume the two cases were never considered.
