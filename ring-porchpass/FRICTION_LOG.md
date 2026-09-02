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
