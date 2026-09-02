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
