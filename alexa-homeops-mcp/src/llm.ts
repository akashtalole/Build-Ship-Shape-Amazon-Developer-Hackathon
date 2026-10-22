import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import Anthropic, { BetaFallbackState, betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const DEFAULT_BEDROCK_MODEL = "anthropic.claude-opus-5-5";
export const BEDROCK_FALLBACK_MODEL = "anthropic.claude-opus-4-8";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export type TextSource = "sampling" | "bedrock" | "anthropic";

export interface GeneratedText {
  text: string;
  source: TextSource;
}

export interface TextModel {
  readonly model: string;
  readonly source: Exclude<TextSource, "sampling">;
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
  readonly source = "bedrock" as const;
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

export interface AnthropicTextModelOptions {
  model?: string;
  apiKey?: string;
  /** Test seams: let the smoke test point the real SDK at a fake endpoint. */
  baseURL?: string;
  fetch?: typeof fetch;
}

/** Claude through the Anthropic API, for deployments that use an API key instead of Bedrock. */
export class AnthropicTextModel implements TextModel {
  readonly model: string;
  readonly source = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(opts: AnthropicTextModelOptions = {}) {
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      fetch: opts.fetch,
      timeout: 20_000,
      maxRetries: 1,
    });
  }

  async complete(prompt: string): Promise<string | undefined> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 1024,
      output_config: { effort: "low" },
      // A policy refusal is retried server-side on the model Anthropic picks for that refusal category.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });
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

/**
 * HOMEOPS_LLM_PROVIDER=anthropic uses ANTHROPIC_API_KEY; =bedrock (or the older
 * HOMEOPS_USE_BEDROCK=true) uses Bedrock with AWS credentials and AWS_REGION.
 */
export function configureTextModelFromEnv(env: NodeJS.ProcessEnv = process.env): TextModel | null {
  const provider = env.HOMEOPS_LLM_PROVIDER || (env.HOMEOPS_USE_BEDROCK === "true" ? "bedrock" : "");
  let model: TextModel | null = null;
  try {
    if (provider === "anthropic") {
      if (env.ANTHROPIC_API_KEY) {
        model = new AnthropicTextModel({ model: env.HOMEOPS_ANTHROPIC_MODEL || undefined, apiKey: env.ANTHROPIC_API_KEY });
      } else {
        console.warn("HomeOps: HOMEOPS_LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set; model fallback disabled.");
      }
    } else if (provider === "bedrock") {
      model = new BedrockTextModel({
        model: env.HOMEOPS_BEDROCK_MODEL || undefined,
        awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
      });
    } else if (provider) {
      console.warn(`HomeOps: unknown HOMEOPS_LLM_PROVIDER "${provider}"; model fallback disabled.`);
    }
  } catch (err) {
    // A misconfigured fallback (e.g. Bedrock with no region) must not stop the server from starting.
    console.warn(`HomeOps: ${provider} model fallback disabled: ${err instanceof Error ? err.message : String(err)}`);
    model = null;
  }
  setTextModel(model);
  return model;
}

/**
 * Turns a prompt into text using, in order: the connected client's own model
 * via MCP sampling (no cost to this server, and the protocol-preferred path),
 * then the configured Claude provider (Bedrock or the Anthropic API). Returns undefined when neither
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
      // Sampling declared but the request failed; try the configured provider next.
    }
  }

  if (textModel) {
    try {
      const text = await textModel.complete(prompt);
      if (text) return { text, source: textModel.source };
    } catch (err) {
      console.warn(`HomeOps: ${textModel.source} call to ${textModel.model} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return undefined;
}
