import type { FoundationResult, UrgencyLabel } from "./types.js";

/**
 * Bedrock-runtime-shaped provider interface. A real implementation wraps a
 * call to `InvokeModel` (or `Converse`) against a Bedrock foundation model —
 * see MockBedrockProvider's doc comment below for exactly what that call
 * looks like.
 */
export interface FoundationModelProvider {
  invoke(prompt: string): Promise<FoundationResult>;
}

function roughTokenCount(text: string): number {
  // Rough approximation (~4 chars/token) — good enough for a cost/latency
  // demo; a real Bedrock response reports exact usage in its body.
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * A deliberately small, independent keyword heuristic standing in for "what
 * the foundation model itself would have concluded." It is intentionally
 * *different* from `MockSidecarClassifier`'s keyword set (fewer, single-word
 * hints) rather than a copy of it — real shadow evaluation compares two
 * genuinely independent models, and a foundation model reading the full
 * sentence would sometimes pick up on different cues (or miss ones the
 * sidecar's phrase-level keywords catch), which is exactly the kind of
 * disagreement shadow mode exists to surface.
 */
const FOUNDATION_URGENCY_HINTS: Record<UrgencyLabel, string[]> = {
  urgent: [
    "fire",
    "smoke",
    "emergency",
    "911",
    "gas",
    "flood",
    "intruder",
    "injured",
    "chest pain",
    "carbon monoxide",
    "break-in",
    "trapped",
    "burglar",
  ],
  routine: ["reminder", "schedule", "appointment", "grocery", "filter", "maintenance", "laundry", "trash", "recycling", "refill"],
  informational: ["fyi", "heads up", "delivered", "shipped", "newsletter", "weather", "package"],
};

/**
 * The foundation model's own (simulated) best guess at the urgency label,
 * independent of the sidecar's classification. Exported so shadow-evaluation
 * bookkeeping and tests can reason about it directly.
 */
export function guessUrgencyLabel(promptOrText: string): UrgencyLabel {
  const text = promptOrText.toLowerCase();
  let best: UrgencyLabel | null = null;
  let bestHits = 0;
  (Object.keys(FOUNDATION_URGENCY_HINTS) as UrgencyLabel[]).forEach((label) => {
    const hits = FOUNDATION_URGENCY_HINTS[label].filter((keyword) => text.includes(keyword)).length;
    if (hits > bestHits) {
      best = label;
      bestHits = hits;
    }
  });
  // No signal at all -> default to "informational", mirroring the sidecar's
  // own no-signal default rather than an arbitrary tie-break.
  return best ?? "informational";
}

/**
 * Pulls the label the foundation model's (simulated) free-text answer implies
 * back out of that text, the way a real integration might parse a structured
 * hint out of an LLM's natural-language response for shadow-mode comparison.
 * Returns null if the text doesn't clearly state one of the three labels.
 */
export function inferLabelFromFoundationText(text: string): UrgencyLabel | null {
  const match = text.match(/\b(urgent|routine|informational)\b/i);
  return match ? (match[1].toLowerCase() as UrgencyLabel) : null;
}

/**
 * Special substring that, when present anywhere in the prompt passed to
 * `MockBedrockProvider.invoke`, deterministically makes that call fail — the
 * router's circuit-breaker/fallback tests use this to simulate "the
 * foundation model is down" without any real network flakiness or timers.
 * A real Bedrock outage obviously wouldn't announce itself this way; this
 * exists purely as a test seam.
 */
export const FAILURE_TRIGGER = "__FORCE_FOUNDATION_FAILURE__";

/** Constructor knobs for simulating an unreliable foundation model provider. */
export interface MockBedrockProviderOptions {
  /** If true, every invocation fails — simulates a fully-down provider / a tripped circuit breaker. */
  alwaysFail?: boolean;
  /** The first N invocations fail, then it recovers — simulates a flaky provider that comes back. */
  failFirstN?: number;
}

/**
 * Template-based stand-in for a Bedrock foundation model invocation. It
 * doesn't reason about the input — it just produces a plausibly "richer"
 * answer with realistic token counts, because the point of this demo is the
 * cost/latency contrast with the sidecar, not generation quality.
 *
 * To go live, this class's body is replaced with something like:
 *
 * ```ts
 * import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
 *
 * export class BedrockFoundationModelProvider implements FoundationModelProvider {
 *   private client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
 *
 *   async invoke(prompt: string): Promise<FoundationResult> {
 *     const response = await this.client.send(new InvokeModelCommand({
 *       modelId: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-haiku-20241022-v1:0",
 *       contentType: "application/json",
 *       accept: "application/json",
 *       body: JSON.stringify({
 *         anthropic_version: "bedrock-2023-05-31",
 *         max_tokens: 512,
 *         messages: [{ role: "user", content: prompt }],
 *       }),
 *     }));
 *     const body = JSON.parse(new TextDecoder().decode(response.body));
 *     return {
 *       text: body.content[0].text,
 *       inputTokens: body.usage.input_tokens,
 *       outputTokens: body.usage.output_tokens,
 *     };
 *   }
 * }
 * ```
 *
 * As with SageMaker, auth flows through the AWS SDK's default credential
 * chain — the calling service's IAM role needs `bedrock:InvokeModel` on the
 * chosen model ARN, not an API key baked into the code.
 *
 * For the streaming variant (`POST /classify/stream`), a real implementation
 * would use `InvokeModelWithResponseStreamCommand` instead and relay each
 * chunk from `response.body` (an async-iterable of `PartialModelResponse`
 * events) to the caller as it arrives — see `src/server.ts` for how this
 * mock's already-complete text is chunked after the fact to demonstrate the
 * relay mechanics without a real streaming provider available.
 */
export class MockBedrockProvider implements FoundationModelProvider {
  private invocationCount = 0;

  constructor(private readonly options: MockBedrockProviderOptions = {}) {}

  async invoke(prompt: string): Promise<FoundationResult> {
    this.invocationCount += 1;

    const shouldFail =
      this.options.alwaysFail === true ||
      prompt.includes(FAILURE_TRIGGER) ||
      (this.options.failFirstN !== undefined && this.invocationCount <= this.options.failFirstN);

    if (shouldFail) {
      throw new Error(
        "Simulated Bedrock InvokeModel failure (e.g. throttling, a transient outage, or a request timeout) — " +
          "used to exercise the router's circuit-breaker/fallback path deterministically in tests."
      );
    }

    const impliedLabel = guessUrgencyLabel(prompt);
    const text =
      `Based on a closer read, this message is best classified as **${impliedLabel}**. ` +
      `A quick keyword scan alone wasn't confident enough, so here is a fuller assessment: "${prompt.slice(0, 160)}" reads as a ` +
      `message that benefits from a human-language read rather than a keyword match — consider the sender's context, ` +
      `time of day, and any follow-up messages before deciding how quickly to act on it.`;

    return {
      text,
      inputTokens: roughTokenCount(prompt),
      outputTokens: roughTokenCount(text),
    };
  }
}
