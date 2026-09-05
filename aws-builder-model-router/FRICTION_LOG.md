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

## Round 3: cost-budget enforcement, three-tier cascade, explainability, persistent metrics

10. **Picking a believable mid-tier cost/latency profile took more deliberation than picking the original two
    numbers did.** With only sidecar vs. foundation, "two orders of magnitude apart" was an easy, defensible anchor
    (see friction #1). A third tier needs to sit *between* them believably on both axes at once — cheap/fast enough
    to be worth trying before the full model, but not so cheap that it's indistinguishable from the sidecar (which
    would make the whole tier pointless) and not so close to the top tier's cost that skipping straight to the top
    tier would obviously be the better call. I landed on $0.002/250ms (~20x the sidecar's cost, ~1/6 the foundation
    model's cost; ~5.5x the sidecar's latency, ~1/3.4 the foundation model's latency) and picked the real-world
    framing that makes this concrete rather than arbitrary: a smaller "lite"/Haiku-class Bedrock model in front of a
    larger Sonnet/Opus-class one, which is an actual pattern people reach for, not just a number that looked
    reasonable in isolation.
11. **Deciding where the reviewer band's boundaries sit, without breaking round 2's existing tests, was a genuine
    constraint-satisfaction problem, not just a design choice.** The task asked for a cascade that changes routing
    behavior for borderline inputs, but "don't break what currently works" meant the *existing* smoke test's specific
    fixture strings (confidence 0.30 and 0.55 at the default 0.7 threshold) had to keep landing exactly where they
    already did. I worked backward from that constraint: `MockSidecarClassifier`'s confidence buckets are a small,
    known, discrete set (0.3, 0.55, 0.75, 0.92, each optionally minus a 0.15 ambiguity penalty), so I picked
    `reviewerConfidenceThreshold = 0.6` specifically because it sits strictly between the existing fixtures' 0.55 and
    0.7 — nothing already in the test suite could accidentally fall into the new band. Then I *engineered* new
    fixture text to land exactly at that boundary (a 2-keyword-hit winner plus a 1-keyword-hit runner-up trips the
    ambiguity penalty and produces exactly 0.75 − 0.15 = 0.6), the same deliberate-confidence-value technique the
    original test suite used, applied one level higher up the cascade.
12. **Getting the reviewer's independent guess to *disagree* with the sidecar, on purpose and deterministically, was
    the hardest single piece of test-fixture engineering in this round — harder than the original shadow-mode
    disagreement fixture (friction #7), because now there are three independent keyword lists in play instead of
    two, and two of them (the sidecar's and the reviewer's) both need to react differently to the same input.** My
    first few attempts kept "accidentally" agreeing, because bare short substrings like "leaking" or "trapped" that
    I picked for the reviewer's hint list turned out to already be full keywords in the sidecar's own list too — so
    any text using them nudged *both* models toward the same label instead of just one. The fix was auditing the
    reviewer's hint words against the sidecar's actual keyword list one by one and deliberately choosing bare
    substrings the sidecar's phrase-level matching would never fire on for the same input (e.g. reviewer's "leak" —
    which matches "a slow leak" — is a different string than the sidecar's "water leak"/"gas leak"/"leaking" — none
    of which match "a slow leak"). That's a real, mildly uncomfortable fixture-writing shortcut: a genuinely
    independently-trained model wouldn't need to be this carefully cross-checked against another model's exact
    keyword list — hand-authoring three deterministic heuristics to still disagree on cue is quantifiably more
    manual than that, and worth naming rather than presenting the resulting fixture as if it emerged naturally.
13. **Cost-budget bookkeeping forced an explicit choice between a rolling window and a fixed window, and I picked
    fixed for the same reason `RateLimiter` already did (round 2), but this time the tradeoff bit differently.** A
    rate limiter's fixed-window "up to 2x the limit across a boundary" artifact is usually harmless — a few extra
    requests. A *cost* budget's fixed-window equivalent is a real dollar amount: a burst right before the window
    rolls over, followed by another right after, really can spend close to double the nominal per-period budget in a
    short span. I decided that was still the right tradeoff for a demo (a rolling window needs a timestamped spend
    log and a prune-on-every-check, real bookkeeping overhead for what's fundamentally a "prove the throttle works"
    feature) but it's a more consequential simplification to gloss over than the rate limiter's, so I gave it its
    own, more detailed doc comment in `budgetTracker.ts` rather than reusing the rate limiter's shorter one verbatim.
14. **Whether the budget should also count the reviewer tier's spend, not just the top-tier foundation model's, was
    a real ambiguity in the feature as specified ("the tracked foundation-model spend") that the three-tier cascade
    exposed.** Read narrowly, only the top-tier model's cost would count, letting a budget-exhausted router still
    freely spend on reviewer calls forever. That felt like it defeated the point of a *cost* budget once a second
    paid tier existed, so I extended "budgeted spend" to mean any paid tier beyond the sidecar (reviewer *and*
    foundation) and said so explicitly in the budget's own doc comment and the README, rather than silently
    resolving the ambiguity one way and leaving a reader to notice the mismatch between the docs and the code later.
15. **Refactoring `actualCostUsd` from "counts × constants" to a running per-request accumulator was a small change
    that quietly fixed a correctness bug the cascade would otherwise have introduced.** Round 2's cost math computed
    total spend by multiplying path counts by fixed per-path costs after the fact — which only works when every
    request on a given path costs exactly the same amount. Once a single "foundation" result could mean either
    "sidecar + foundation" (direct escalation) or "sidecar + reviewer + foundation" (cascaded through a disagreeing
    reviewer), that assumption broke, and the old formula would have silently under- or over-counted cost depending
    on the mix. Summing each request's own already-correctly-computed `totalCostUsd` as it happens sidesteps the
    combinatorics entirely — a case where making the code simpler (fewer moving parts to keep in sync) also made it
    more correct, not just more concise.
16. **Explainability vs. simplicity in the heuristic classifier turned out to be a smaller tension than I expected
    going in, which is itself worth noting.** I'd assumed adding real explainability (which keyword(s) actually
    matched) would mean either a second pass over the text or a parallel data structure to keep in sync with the
    matching logic. In the end, `MockSidecarClassifier` was already computing a hit *count* per category by filtering
    its keyword list against the input — keeping the filtered array instead of just its `.length` was a one-line
    change, not a redesign. The real tension is more honestly described as "explainability vs. classifier choice,
    full stop," documented on `SidecarResult` itself: this specific win (matched keywords come nearly free) is a
    property of choosing a keyword-heuristic classifier in the first place, and evaporates the moment that classifier
    is swapped for a real trained model (a SageMaker DistilBERT endpoint doesn't hand back "which words it looked
    at" for free — that's a SHAP/attention-weights problem, a materially bigger lift than keeping an array around).
17. **Testing "does a restart actually reload state" required deliberately *not* reusing the same router instance,
    which is a subtly different (and stricter) test than the TTL/circuit-breaker clock-mocking pattern from round 2.**
    It would have been easy to write a test that calls `persistMetricsNow()` then `loadMetricsState()` on the same
    object and calls that sufficient — but that doesn't actually prove the feature, because an in-memory router
    already has all that state; round-tripping it through a file and back into the *same* object could pass even if
    the constructor's hydration path were completely broken. The test that actually matters constructs a **second,
    independent `ModelRouter`** pointed at the same file path with no other shared state, and checks *its*
    `getMetrics()` — genuinely exercising the constructor's load path the way a real process restart would, not just
    the save path.

## Round 4: per-caller budgets, canary/A-B sidecar routing, alert webhooks, Prometheus export

18. **The shared checkout this session started in was, mid-task, silently switched to a completely different
    branch by another concurrent agent working in the same repo directory** — `git branch --show-current` returned
    `claude/friction-log-round4-sync` a few commands after I'd checked out `claude/model-router-round4-canary` in
    what I'd assumed was an isolated worktree, and `src/budgetTracker.ts`/`metricsPersistence.ts` briefly appeared to
    not exist at all because the working tree really was pointed somewhere else at that moment. This wasn't a bug in
    my own reasoning to debug around — `git worktree list` confirmed several *other* sessions were already using
    dedicated worktrees under `.claude/worktrees/`, which is the actual fix: I created my own
    (`.claude/worktrees/model-router-round4`, checked out to `claude/model-router-round4-canary`) and did every
    remaining edit, test run, and commit there instead of in the shared top-level checkout. Worth naming explicitly
    because the failure mode is silent and easy to misattribute to "the file must have been deleted" rather than
    "the branch under my feet just changed."
19. **Deciding what "no `X-Caller-Id` header" means for `/budget` couldn't reuse the rate limiter's own convention
    verbatim, even though the feature spec explicitly said to reuse its identification mechanism.** The rate limiter
    treats a missing header as the caller `"anonymous"` — one bucket among many, no different in kind from any other
    caller id. If `/budget` did the same, then `POST /budget` with no header (every pre-round-4 call, including the
    existing HTTP test) would configure `"anonymous"`'s *own* budget bucket instead of the shared default — and any
    other caller who also never sends a header (a different test's `X-Caller-Id: "budget-tester"`, say) would find
    the shared default still completely unconfigured, silently breaking the existing budget-over-HTTP test's
    assumption that one `POST /budget` governs every caller that follows. So I split the reader in two:
    `callerIdOrAnonymous` (rate limiting, `/classify` routing — a request always belongs to *some* caller) and
    `explicitCallerId` (the budget endpoints — a missing header means "the shared default," full stop, `undefined`
    rather than a stand-in id). Reusing the *header name* but not the *missing-value fallback* is a real, deliberate
    deviation from "identical mechanism," and I documented the reason on `explicitCallerId` itself rather than
    leaving a future reader to wonder why budgets and rate limits treat the same header differently.
20. **Canary evaluation couldn't reuse shadow evaluation's fire-and-forget pattern, even though the feature
    description explicitly invited the comparison ("similar spirit to shadow evaluation").** Shadow mode calls the
    foundation model *after* the fast-path response is already on its way back to the caller, specifically so a slow
    or failing comparison call can never affect what the caller sees. A canary's whole point is the opposite: the
    candidate's answer needs to be able to reach real traffic and change the actual routing decision, which means
    the comparison has to be awaited *before* routing continues, not fired off after. I only felt comfortable doing
    that synchronously because both classifiers involved are `MockSidecarClassifier`-shaped — sub-millisecond in
    practice, ~45ms even in the simulated-cost model — so `Promise.all`-ing them adds no meaningfully observable
    latency; a canary comparing two *foundation*-model-shaped candidates (a more realistic "compare two LLM prompt
    versions" use case) would need to think much harder about whether awaiting both really is affordable on every
    request, or whether it needs its own sampling/async story instead.
21. **Getting the canary's disagreement signal to be deterministic while its traffic split stays genuinely
    probabilistic required two different test strategies for what's really one feature, mirroring friction #12's
    "getting two heuristics to disagree on cue" problem one layer up.** A random 40%/60% split is *supposed* to
    vary run to run — asserting an exact count would be either flaky or a lie. But if the disagreement rate is
    *also* left to chance (two independently-tuned keyword sets happening to disagree on naturally-varied test
    input), a test failure can't distinguish "the traffic split is broken" from "these two heuristics just didn't
    happen to disagree this run." I split the concerns: a single made-up marker keyword (`zzzcanarymarkerzzz`,
    checked by inspection against every built-in keyword list so it can't collide) added only to the candidate's
    config makes disagreement deterministic — 100% of evaluations, every run — while the *served-request* share is
    the only thing left genuinely random, checked against a generous tolerance band instead of an exact number.
22. **Whether a `budget_exceeded` alert should fire on every throttled request or only on the transition into
    "exceeded," and a `circuit_open` alert on every failure or only on the transition into "open," turned out to
    have different right answers for the two events — and I initially implemented them identically before noticing
    that.** A circuit breaker has a real, discrete "just tripped" moment (`onFoundationFailure` setting
    `circuitState` from anything else to `"open"`), so alerting only on that transition is both more useful (one
    notification, not a flood) and easy to detect precisely. A budget's "exceeded" check is re-evaluated fresh on
    every request that would otherwise escalate, with no separate stored "was I already exceeded last time"
    flag to compare against cheaply — adding one purely to dedupe alerts felt like more state for a demo-scale
    feature to carry than the problem justified. I left budget alerts firing once per throttled request (documented
    as a deliberate, spam-prone simplification on `fireBudgetExceededAlert`'s doc comment, with the obvious real-world
    mitigation named — rate-limit the alert itself, or track a per-period "already alerted" flag) rather than quietly
    making the two events behave inconsistently without saying why.
23. **Round-4 state (per-caller budget overrides, the canary registration, the alert-webhook registration) is
    deliberately *not* added to `metricsPersistence.ts`'s persisted file, which is a scope decision worth stating
    plainly rather than an oversight to stumble on later.** The existing persistence feature already documents itself
    as demo-grade — plain `writeFileSync`, no locking, no schema migration — and folding in three more pieces of
    state (a growing map of per-caller trackers, a classifier config object, a webhook secret) would have meaningfully
    expanded that file's schema and its "what happens on a corrupt/partial read" surface for a restart story this
    round's spec didn't ask for. A restarted process currently comes back up with the shared default budget restored
    (unchanged from round 3) but per-caller overrides, the canary, and the alert-webhook registration reset to
    "unconfigured" — acceptable for a demo process that's expected to stay up for the length of a demo, and called
    out here so it's a known boundary rather than a surprise.
