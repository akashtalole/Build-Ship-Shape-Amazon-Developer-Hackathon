import type { SidecarResult, UrgencyLabel } from "./types.js";

/**
 * SageMaker-runtime-shaped classifier interface. A real implementation
 * wraps a call to a deployed SageMaker endpoint — see MockSidecarClassifier's
 * doc comment below for exactly what that call looks like.
 */
export interface SidecarClassifier {
  classify(input: string): Promise<SidecarResult>;
}

interface KeywordSet {
  label: UrgencyLabel;
  keywords: string[];
}

// Deliberately simple, explainable keyword/pattern matching — this is the
// "cheap fast path," not a disguised LLM call. Real deployments would train
// a small model (e.g. a fine-tuned DistilBERT or a linear classifier over
// TF-IDF features) on labeled household-message data and serve it from a
// SageMaker endpoint, but a hand-written rule set demonstrates the same
// architectural role for this demo without needing training data or GPUs.
const KEYWORD_SETS: KeywordSet[] = [
  {
    label: "urgent",
    keywords: [
      "fire",
      "smoke",
      "gas leak",
      "gas smell",
      "smell of gas",
      "flood",
      "flooding",
      "water leak",
      "leaking",
      "intruder",
      "break-in",
      "broke in",
      "break in",
      "carbon monoxide",
      "no power",
      "power outage",
      "power is out",
      "emergency",
      "burglar",
      "trapped",
      "can't breathe",
      "cant breathe",
      "chest pain",
      "fell down",
      "injured",
      "alarm is going off",
      "alarm triggered",
      "help immediately",
      "call 911",
    ],
  },
  {
    label: "routine",
    keywords: [
      "reminder",
      "schedule",
      "scheduled",
      "grocery",
      "groceries",
      "trash day",
      "recycling day",
      "mow the lawn",
      "lawn care",
      "filter needs",
      "replace the filter",
      "restock",
      "routine maintenance",
      "appointment",
      "refill",
      "laundry",
      "dishwasher cycle",
      "thermostat schedule",
      "weekly check",
      "monthly check",
    ],
  },
  {
    label: "informational",
    keywords: [
      "fyi",
      "just so you know",
      "for your information",
      "heads up",
      "newsletter",
      "weather today",
      "package arrived",
      "package was delivered",
      "delivery confirmation",
      "order shipped",
      "order has shipped",
      "was delivered",
    ],
  },
];

/** How much each additional matched keyword raises confidence in the winning label. */
function confidenceForHits(hits: number): number {
  if (hits <= 0) return 0.3;
  if (hits === 1) return 0.55;
  if (hits === 2) return 0.75;
  return 0.92;
}

/**
 * Tuning knobs for a `MockSidecarClassifier` instance, used to construct a
 * deliberately *different* second classifier for canary/A-B sidecar routing
 * (`POST /router/canary`) — the two sidecar "versions" a real deployment
 * would compare are two different trained-model artifacts behind two
 * SageMaker endpoints; here, since both are the same keyword-heuristic
 * class, the difference has to come from configuration instead.
 */
export interface SidecarClassifierConfig {
  /**
   * Keyword/phrase rules layered on top of the built-in set (see
   * `KEYWORD_SETS` above), matched the same case-insensitive-substring way
   * and counted toward that label's hit total. Lets a candidate
   * configuration react to inputs the primary's built-in set doesn't, for a
   * genuine (not simulated) behavioral difference between the two.
   */
  extraKeywords?: { label: UrgencyLabel; keywords: string[] }[];
  /**
   * Multiplies the confidence this instance would otherwise report (clamped
   * back to [0, 1] afterward). Default 1 (no change). Lets a candidate
   * simulate being systematically more or less confident than the primary
   * on the exact same inputs — e.g. a newer model version that's more
   * conservative about the "urgent" label.
   */
  confidenceScale?: number;
}

/**
 * Deterministic, keyword-based stand-in for a SageMaker real-time (or
 * serverless) inference endpoint.
 *
 * To go live, this class's body is replaced with something like:
 *
 * ```ts
 * import { SageMakerRuntimeClient, InvokeEndpointCommand } from "@aws-sdk/client-sagemaker-runtime";
 *
 * export class SageMakerSidecarClassifier implements SidecarClassifier {
 *   private client = new SageMakerRuntimeClient({ region: process.env.AWS_REGION });
 *
 *   async classify(input: string): Promise<SidecarResult> {
 *     const response = await this.client.send(new InvokeEndpointCommand({
 *       EndpointName: process.env.SAGEMAKER_ENDPOINT_NAME, // e.g. "urgency-classifier-prod"
 *       ContentType: "application/json",
 *       Body: new TextEncoder().encode(JSON.stringify({ inputs: input })),
 *     }));
 *     const body = JSON.parse(new TextDecoder().decode(response.Body));
 *     // Shape depends on how the model's inference.py formats output —
 *     // a typical HF text-classification container returns [{label, score}, ...].
 *     const top = body[0];
 *     return { label: top.label, confidence: top.score };
 *   }
 * }
 * ```
 *
 * Auth is handled by the AWS SDK's default credential chain (an IAM role in
 * production, e.g. attached to the Lambda/ECS task calling this code); no
 * API keys are stored in application code.
 */
export class MockSidecarClassifier implements SidecarClassifier {
  /** Per-instance keyword sets: the built-in `KEYWORD_SETS`, plus this instance's `config.extraKeywords` layered on top — computed once here rather than on every `classify()` call. */
  private readonly keywordSets: KeywordSet[];
  private readonly confidenceScale: number;

  constructor(config: SidecarClassifierConfig = {}) {
    this.confidenceScale = config.confidenceScale ?? 1;
    // Deep-copy so mutating a per-instance set (below) never touches the
    // shared module-level `KEYWORD_SETS` that every other instance reads.
    this.keywordSets = KEYWORD_SETS.map((set) => ({ label: set.label, keywords: [...set.keywords] }));
    for (const extra of config.extraKeywords ?? []) {
      const target = this.keywordSets.find((set) => set.label === extra.label);
      if (target) target.keywords.push(...extra.keywords);
      else this.keywordSets.push({ label: extra.label, keywords: [...extra.keywords] });
    }
  }

  async classify(input: string): Promise<SidecarResult> {
    const text = input.toLowerCase();

    // Track *which* keyword(s) matched, not just a count — this is the
    // sidecar's explainability story (feature: classification explainability).
    // A trained-model endpoint wouldn't have this exact signal (see
    // SidecarResult's doc comment), but a hand-written rule set gets it for
    // free, which is one honest advantage of choosing simplicity here.
    const hitCounts = this.keywordSets.map((set) => {
      const matches = set.keywords.filter((keyword) => text.includes(keyword));
      return { label: set.label, hits: matches.length, matches };
    });

    let winner = hitCounts[0];
    for (const candidate of hitCounts) {
      if (candidate.hits > winner.hits) winner = candidate;
    }

    if (winner.hits === 0) {
      // No keyword signal at all — the sidecar has nothing to go on, so it
      // reports its default label at low confidence, which is exactly the
      // signal the router needs to escalate to the foundation model.
      return { label: "informational", confidence: this.scaleConfidence(0.3), matchedKeywords: [] };
    }

    let confidence = confidenceForHits(winner.hits);

    // Ambiguity penalty: if another category also matched, this input isn't
    // as clean a fit as the raw hit count alone would suggest.
    const runnerUp = hitCounts.find((c) => c.label !== winner.label && c.hits > 0);
    if (runnerUp) {
      confidence = Math.max(0.2, confidence - 0.15);
    }

    return { label: winner.label, confidence: this.scaleConfidence(confidence), matchedKeywords: winner.matches };
  }

  /** Applies this instance's `confidenceScale` (a no-op at the default of 1) and clamps back to a valid [0, 1] confidence. */
  private scaleConfidence(confidence: number): number {
    return Math.min(1, Math.max(0, confidence * this.confidenceScale));
  }
}
