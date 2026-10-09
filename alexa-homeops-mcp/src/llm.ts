import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { BetaFallbackState, betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const DEFAULT_BEDROCK_MODEL = "anthropic.claude-opus-5-5";
export const BEDROCK_FALLBACK_MODEL = "anthropic.claude-opus-4-8";

export type TextSource = "sampling" | "bedrock";

export interface GeneratedText {
  text: string;
  source: TextSource;
}

export interface TextModel {
  readonly model: string;
  complete(prompt: string): Promise<string | undefined>;
}

export interface BedrockTextModelOptions {
  model?: string;
  awsRegion?: string;
  /** Test seam: lets the smoke test intercept the real HTTP request the SDK builds. */
  fetch?: typeof fetch;
  skipAuth?: boolean;
}

export class BedrockTextModel implements TextModel {
  readonly model: string;
  private readonly client: AnthropicBedrockMantle;

  constructor(opts: BedrockTextModelOptions = {}) {
    this.model = opts.model ?? DEFAULT_BEDROCK_MODEL;
    this.client = new AnthropicBedrockMantle({
      awsRegion: opts.awsRegion,
      skipAuth: opts.skipAuth,
      fetch: opts.fetch,
      // A voice turn can't wait out the SDK's default 10-minute timeout; fail
      // fast and let the caller fall back to a templated answer instead.
      timeout: 20_000,
      maxRetries: 1,
      middleware: [betaRefusalFallbackMiddleware([{ model: BEDROCK_FALLBACK_MODEL }])],
    });
  }

  async complete(prompt: string): Promise<string | undefined> {
    // The refusal-fallback middleware only wraps client.beta.messages requests.
    // Each call is a one-shot exchange, so its fallback pin is scoped to itself.
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: 1024,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt }],
      },
      { fallbackState: new BetaFallbackState() }
    );
    if (response.stop_reason === "refusal") return undefined;
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    return text || undefined;
  }
}

let textModel: TextModel | null = null;

export function setTextModel(model: TextModel | null): void {
  textModel = model;
}

export function getTextModel(): TextModel | null {
  return textModel;
}

/** Enables Bedrock when HOMEOPS_USE_BEDROCK=true; region comes from AWS_REGION via the SDK. */
export function configureTextModelFromEnv(env: NodeJS.ProcessEnv = process.env): TextModel | null {
  if (env.HOMEOPS_USE_BEDROCK !== "true") {
    setTextModel(null);
    return null;
  }
  const model = new BedrockTextModel({ model: env.HOMEOPS_BEDROCK_MODEL || undefined });
  setTextModel(model);
  return model;
}

/**
 * Turns a prompt into text using, in order: the connected client's own model
 * via MCP sampling (no cost to this server, and the protocol-preferred path),
 * then Claude on Amazon Bedrock if configured. Returns undefined when neither
 * is available so callers can use their templated fallback.
 */
export async function generateText(server: McpServer, prompt: string): Promise<GeneratedText | undefined> {
  if (server.server.getClientCapabilities()?.sampling) {
    try {
      const result = await server.server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens: 200,
      });
      if (result.content.type === "text" && result.content.text.trim()) {
        return { text: result.content.text, source: "sampling" };
      }
    } catch {
      // Sampling declared but the request failed; try Bedrock next.
    }
  }

  if (textModel) {
    try {
      const text = await textModel.complete(prompt);
      if (text) return { text, source: "bedrock" };
    } catch (err) {
      console.warn(`HomeOps: Bedrock call to ${textModel.model} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return undefined;
}
