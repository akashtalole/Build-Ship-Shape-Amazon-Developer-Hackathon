import type { FoundationResult } from "./types.js";

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
 */
export class MockBedrockProvider implements FoundationModelProvider {
  async invoke(prompt: string): Promise<FoundationResult> {
    const text =
      `After a closer read, this message doesn't fit a single confident category from a quick keyword scan, ` +
      `so here is a fuller assessment: "${prompt.slice(0, 160)}" reads as a message that likely needs human ` +
      `judgment to prioritize correctly — consider the sender's context, time of day, and any follow-up messages ` +
      `before deciding how quickly to act on it.`;

    return {
      text,
      inputTokens: roughTokenCount(prompt),
      outputTokens: roughTokenCount(text),
    };
  }
}
