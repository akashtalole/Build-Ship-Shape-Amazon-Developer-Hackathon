# Friction Log — Model Router (SageMaker Sidecar)

Notes captured while building the AWS Builder mini-challenge submission, for the hackathon's optional friction-log
bonus.

## What worked well

- Designing `MockSidecarClassifier` as literal keyword/pattern matching (not a disguised LLM call) turned out to
  make the whole demo more honest *and* more testable at the same time — because the heuristic is fully explainable,
  it was easy to hand-pick input strings that deterministically land at a known confidence value (0.92, 0.55, 0.30),
  which is exactly what the smoke test needed for reliable, non-flaky assertions about routing behavior.
- Writing the two AWS-shaped interfaces (`SidecarClassifier.classify`, `FoundationModelProvider.invoke`) before
  writing either mock kept the router itself completely decoupled — `router.ts` has zero knowledge that it's talking
  to mocks, which made it straightforward to write the "swap in the real SDK" code samples in the README with
  confidence they're accurate, since they're describing a real seam rather than a hypothetical one.
- Testing the router twice — once directly (no HTTP) and once through real `fetch()` calls against `app.listen(0)`
  — caught that my first test only issued 3 `/classify` calls over HTTP while asserting `metrics.totalRequests
  === 4`; the mismatch surfaced immediately as a failing assertion rather than a silently-wrong metrics claim in
  the README.

## Friction encountered

1. **Designing believable cost/latency numbers without real AWS billing data.** There's no way to validate "a
   SageMaker real-time endpoint costs ~$0.0001/invocation" against an actual bill in this environment. I anchored
   the two numbers to a directionally-correct ratio (a small classifier endpoint being roughly two orders of
   magnitude cheaper and faster than a hosted foundation model call) rather than trying to cite precise pricing,
   and called that out explicitly in the README and in code comments — the risk of stating a specific number with
   false confidence felt worse than being upfront that it's illustrative.
2. **A test hang cost real debugging time.** My first version of the HTTP test threw an `AssertionError` *before*
   calling `httpServer.close()`, which left the Express server's underlying `http.Server` listening — Node's event
   loop had a live handle, so the process never exited and the test run silently hung past the tool's 120s timeout
   instead of failing fast. The fix was fixing the actual assertion bug (a missing fourth `/classify` call), but the
   general lesson — that a thrown assertion mid-test can leave an unclosed server holding the process open — is
   worth remembering for any future test using `app.listen()` without a `try/finally`.
3. **Mirroring the real Bedrock/SageMaker request-response shapes precisely, from memory, without live docs access**
   to double-check exact field names (`Body` vs `body`, `ContentType` vs `contentType`, the exact `usage` field
   names in a Bedrock Anthropic response) meant the "swap in the real SDK" code samples are written to be
   structurally and conceptually accurate rather than guaranteed byte-for-byte correct against the current SDK
   version — worth a real developer double-checking against `@aws-sdk/client-bedrock-runtime`'s current types before
   copy-pasting into production.

## Round 2: advanced features (caching, circuit breaker, shadow mode, adaptive threshold, streaming, rate limiting)

4. **Designing a deterministic way to simulate "the foundation model is down" was more design work than the
   circuit-breaker logic itself.** A real outage is flaky and non-deterministic by nature, which is exactly the
   opposite of what a reliable test needs. I ended up with two independent seams on purpose rather than one:
   constructor flags on `MockBedrockProvider` (`alwaysFail`, `failFirstN`) for tests that need multi-call sequences
   (e.g. "fail once, then recover" to exercise the half-open→closed transition), and a `FAILURE_TRIGGER` sentinel
   substring for tests that want to force a failure via a single input string without touching how the provider was
   constructed. Having both meant the circuit-breaker state machine itself (closed → open → half-open) could be
   tested with real, controlled failure *sequences* instead of just "always fails" / "never fails," which is what
   actually exercises the interesting transitions (a half-open trial failing re-opens the circuit immediately,
   regardless of the consecutive-failure threshold — a case that's easy to get wrong and easy to miss without a
   provider that can fail exactly once and then recover on command).
5. **Real time (`Date.now()`, `setTimeout`) and deterministic tests actively fight each other for TTL/cooldown
   logic.** My first instinct for testing the cache TTL and circuit-breaker cooldown was to use short real durations
   and `await sleep(...)` in the test — which works, but makes the test suite slower and (worse) flaky under any
   system load, since a "short" real delay is still a race against the wall clock. Threading an injectable
   `now: () => number` clock through `ModelRouter`'s constructor instead (defaulting to `Date.now`) meant tests could
   advance a fake clock by exactly `61_000` ms with zero real waiting and zero flakiness — a few extra lines in the
   constructor bought a meaningfully more reliable test suite. In hindsight this should probably be the default way
   I design anything with a TTL, not an afterthought.
6. **A background "shadow" call that must never affect the caller's response is trickier to test than to write.**
   The implementation itself is simple (`this.foundation.invoke(...).then(...).catch(...)`, never awaited by
   `route()`), but *proving* in a test that it truly doesn't add latency or fail the caller's request needs either an
   arbitrary `setTimeout` in the test (racy) or a way to deterministically wait for exactly the background work that
   was kicked off. I added a small `flushShadowEvaluations()` method to `ModelRouter` purely for this — collecting
   the fire-and-forget promises and exposing a way to await them on demand. It's not needed in production use (shadow
   mode's whole point is not being awaited), but without it the shadow-mode tests would have had to guess how long
   "long enough" is, which is exactly the kind of flakiness a test suite shouldn't tolerate.
7. **Getting the sidecar and the foundation model's shadow-mode "opinions" to sometimes genuinely disagree, on
   purpose, took more thought than expected.** If the foundation model's mock simply reused the sidecar's own
   keyword list, shadow mode would trivially agree 100% of the time forever — which proves nothing about the
   feature's plumbing versus just tautology. I gave `MockBedrockProvider` its own, deliberately different and
   smaller keyword-hint list (single words rather than the sidecar's often-multi-word phrases), which is honestly
   also more representative of two real, independently-trained models: they don't cluster on identical cues just
   because they're solving the same problem. That difference let me hand-construct a test input where the sidecar
   is confident about one label via a phrase-level keyword its own list has but the foundation model's list lacks,
   while a completely incidental word elsewhere in the same sentence trips the foundation model's *own* independent
   category — producing a disagreement that's deterministic (not random) but still genuinely a disagreement between
   two different heuristics rather than a scripted "always agree" or "always disagree" toggle.
8. **SSE mechanics in Express are simple in principle and easy to get subtly wrong.** `res.writeHead` with
   `Content-Type: text/event-stream`, then repeated `res.write(...)`, then `res.end()` is the whole mechanism — but
   it only actually streams (rather than silently buffering until the end and delivering everything at once) if
   nothing upstream buffers it. `X-Accel-Buffering: no` matters for any reverse proxy in front of a real deployment,
   and forgetting `res.end()` after the final event leaves the connection hanging exactly like the unclosed
   `http.Server` bug from round 1's friction log — a similar "small mechanical detail with an outsized, silent
   failure mode" shape. I also learned the hard way (a genuinely broken first test) that naively parsing SSE frames
   with `text.split("data: ")[1]` is a landmine the moment a data payload's own JSON could theoretically contain that
   substring — worth remembering that ad hoc SSE parsing in a test is not the same as a real EventSource client.
9. **The adaptive-threshold heuristic is the single feature I'm least comfortable calling "correct," and I said so
   directly in the code and the README rather than dressing it up.** Pooling shadow-agreement data and explicit
   caller feedback into one accuracy estimate, then nudging a single global threshold up or down off of a minimum
   sample count, has real, known problems: it doesn't correct for selection bias (only requests that got feedback or
   ran a shadow eval count, which are not a random sample of traffic), it treats "the foundation model disagreed"
   as equivalent to "the sidecar was wrong" (they could both be wrong, or the ambiguity could be genuine), and a
   single fixed step size (±0.05) is an arbitrary choice with no tie to how much a given amount of evidence should
   actually move a probability estimate. I kept it because the feature explicitly asked for "simple and illustrative,
   not real statistical rigor," and documented every one of these caveats inline rather than let the number's
   confident-looking presentation in `GET /metrics` imply more rigor than there is.
