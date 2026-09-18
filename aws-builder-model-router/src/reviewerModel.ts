import type { FoundationResult, UrgencyLabel } from "./types.js";
import type { FoundationModelProvider } from "./foundationModel.js";

/**
 * A third, independent keyword-hint list standing in for "what a smaller,
 * cheaper model would itself conclude" — deliberately distinct again from
 * both `MockSidecarClassifier`'s phrase-level keywords and
 * `MockBedrockProvider`'s single-word hints, for the same reason given in
 * foundationModel.ts: two independently-built models (here, two
 * different-sized foundation models from the same or different vendors)
 * don't cluster on identical cues just because they're solving the same
 * problem — a real "lite" model and a real full-size model would disagree
 * sometimes too.
 */
const REVIEWER_URGENCY_HINTS: Record<UrgencyLabel, string[]> = {
  urgent: ["fire", "smoke", "leak", "intruder", "danger", "injur", "trapped", "911", "can't breathe"],
  routine: ["remind", "schedule", "grocery", "filter", "maintenance", "appointment", "trash", "recycling", "laundry"],
  informational: ["fyi", "delivered", "shipped", "newsletter", "weather", "heads up", "arrived"],
};

/**
 * The reviewer model's own (simulated) best guess at the urgency label,
 * independent of both the sidecar's and the full foundation model's
 * heuristics. Exported so tests can reason about it directly.
 */
export function guessReviewerLabel(promptOrText: string): UrgencyLabel {
  const text = promptOrText.toLowerCase();
  let best: UrgencyLabel | null = null;
  let bestHits = 0;
  (Object.keys(REVIEWER_URGENCY_HINTS) as UrgencyLabel[]).forEach((label) => {
    const hits = REVIEWER_URGENCY_HINTS[label].filter((keyword) => text.includes(keyword)).length;
    if (hits > bestHits) {
      best = label;
      bestHits = hits;
    }
  });
  return best ?? "informational";
}

function roughTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Constructor knobs for simulating an unreliable reviewer-model provider (mirrors MockBedrockProviderOptions). */
export interface MockReviewerProviderOptions {
  /** If true, every invocation fails — the cascade's documented fail-open behavior (skip straight to the full foundation model) is what a test exercising this proves. */
  alwaysFail?: boolean;
}

/**
 * The three-tier cascade's mid tier: a second, cheaper/faster Bedrock-shaped
 * mock modeling a *smaller* foundation model (the kind of thing a real
 * deployment would reach for as e.g. Anthropic's Haiku-class model versus a
 * larger Sonnet/Opus-class model for the top tier) — same
 * `FoundationModelProvider` shape as `MockBedrockProvider`, invoked as a
 * "second opinion" before paying for the full-size top-tier model.
 *
 * To go live, swap this for a second `BedrockFoundationModelProvider`-shaped
 * class (see `foundationModel.ts`'s doc comment for the exact
 * `InvokeModelCommand` shape) configured with a smaller/cheaper `modelId`
 * (e.g. `anthropic.claude-3-5-haiku-...` for the reviewer tier vs. a larger
 * model for the top tier) — the interface is identical, so no other code
 * changes.
 */
export class MockReviewerProvider implements FoundationModelProvider {
  constructor(private readonly options: MockReviewerProviderOptions = {}) {}

  async invoke(prompt: string): Promise<FoundationResult> {
    if (this.options.alwaysFail) {
      throw new Error(
        "Simulated reviewer-model failure (e.g. throttling or an outage on the smaller model) — used to exercise the " +
          "cascade's fail-open-to-the-top-tier behavior deterministically in tests."
      );
    }

    const impliedLabel = guessReviewerLabel(prompt);
    const text =
      `Quick second opinion from the lightweight reviewer model: this reads as **${impliedLabel}**. ` +
      `This is a faster, cheaper pass than the full model — if it doesn't confirm the sidecar's own classification, ` +
      `the router escalates once more to the full foundation model for a fuller read.`;

    return {
      text,
      inputTokens: roughTokenCount(prompt),
      outputTokens: roughTokenCount(text),
    };
  }
}
