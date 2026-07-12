import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const boolFromString = z.preprocess((value) => {
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.toLowerCase());
  return value;
}, z.boolean());

export const ConfigurationSchema = z.object({
  llmProvider: z.enum(["ollama", "openai_compatible"]).default("ollama"),
  localLlm: z.string().default("gemma4:e4b"),
  agentLlm: z.string().optional(),
  ollamaBaseUrl: z.string().default("http://localhost:11434"),
  openaiCompatibleBaseUrl: z.string().optional(),
  openaiCompatibleApiKey: z.string().optional(),
  searchApi: z.enum(["duckduckgo", "tavily", "perplexity", "searxng"]).default("duckduckgo"),
  maxWebResearchLoops: z.coerce.number().int().min(0).default(3),
  maxAgentSteps: z.coerce.number().int().min(1).default(20),
  fetchFullPage: boolFromString.default(false),
  stripThinkingTokens: boolFromString.default(true),
  tavilyApiKey: z.string().optional(),
  perplexityApiKey: z.string().optional(),
  searxngUrl: z.string().optional(),
  gradeSources: boolFromString.default(true),
  sourceDomainBlocklist: z.string().default(""),
  countEmptyLoops: boolFromString.default(false),
  langsmithTracing: boolFromString.default(false),
  langsmithApiKey: z.string().optional(),
  langsmithProject: z.string().optional(),
  langsmithEndpoint: z.string().optional(),
});

export type Configuration = z.infer<typeof ConfigurationSchema>;

const ENV_KEYS: Record<keyof Configuration, string> = {
  llmProvider: "LLM_PROVIDER",
  localLlm: "LOCAL_LLM",
  agentLlm: "AGENT_LLM",
  ollamaBaseUrl: "OLLAMA_BASE_URL",
  openaiCompatibleBaseUrl: "OPENAI_COMPATIBLE_BASE_URL",
  openaiCompatibleApiKey: "OPENAI_COMPATIBLE_API_KEY",
  searchApi: "SEARCH_API",
  maxWebResearchLoops: "MAX_WEB_RESEARCH_LOOPS",
  maxAgentSteps: "MAX_AGENT_STEPS",
  fetchFullPage: "FETCH_FULL_PAGE",
  stripThinkingTokens: "STRIP_THINKING_TOKENS",
  tavilyApiKey: "TAVILY_API_KEY",
  perplexityApiKey: "PERPLEXITY_API_KEY",
  searxngUrl: "SEARXNG_URL",
  gradeSources: "GRADE_SOURCES",
  sourceDomainBlocklist: "SOURCE_DOMAIN_BLOCKLIST",
  countEmptyLoops: "COUNT_EMPTY_LOOPS",
  langsmithTracing: "LANGSMITH_TRACING",
  langsmithApiKey: "LANGSMITH_API_KEY",
  langsmithProject: "LANGSMITH_PROJECT",
  langsmithEndpoint: "LANGSMITH_ENDPOINT",
};

/**
 * Merge configuration sources with precedence:
 * config.configurable (programmatic / CLI / MCP) > environment variables > schema defaults.
 * Note: this intentionally differs from the Python original, where env wins over configurable.
 */
export function ensureConfiguration(config?: RunnableConfig): Configuration {
  const configurable = (config?.configurable ?? {}) as Record<string, unknown>;
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(ConfigurationSchema.shape) as (keyof Configuration)[]) {
    const value = configurable[key] ?? process.env[ENV_KEYS[key]];
    if (value !== undefined && value !== null && value !== "") raw[key] = value;
  }
  const parsed = ConfigurationSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}

/** Fail fast, before any LLM call, when the selected provider is missing its credentials. */
export function validateConfiguration(cfg: Configuration): void {
  if (cfg.searchApi === "tavily" && !cfg.tavilyApiKey) {
    throw new ConfigurationError("searchApi=tavily requires TAVILY_API_KEY");
  }
  if (cfg.searchApi === "perplexity" && !cfg.perplexityApiKey) {
    throw new ConfigurationError("searchApi=perplexity requires PERPLEXITY_API_KEY");
  }
  if (cfg.searchApi === "searxng" && !cfg.searxngUrl) {
    throw new ConfigurationError("searchApi=searxng requires SEARXNG_URL");
  }
  if (cfg.llmProvider === "openai_compatible" && !cfg.openaiCompatibleBaseUrl) {
    throw new ConfigurationError(
      "llmProvider=openai_compatible requires OPENAI_COMPATIBLE_BASE_URL",
    );
  }
  if (cfg.langsmithTracing && !cfg.langsmithApiKey) {
    throw new ConfigurationError("langsmithTracing=true requires LANGSMITH_API_KEY");
  }
}

export const DEFAULT_LANGSMITH_PROJECT = "local-deep-researcher";

/**
 * The langsmith SDK reads its settings exclusively from process.env, so config
 * values (including ones passed programmatically via configurable) must be
 * mirrored there before the graph runs. No-op when tracing is disabled, so
 * user-managed env vars are never deleted or overwritten.
 */
export function applyTracingEnv(cfg: Configuration): void {
  if (!cfg.langsmithTracing) return;
  process.env.LANGSMITH_TRACING = "true";
  if (cfg.langsmithApiKey) process.env.LANGSMITH_API_KEY = cfg.langsmithApiKey;
  process.env.LANGSMITH_PROJECT = cfg.langsmithProject ?? DEFAULT_LANGSMITH_PROJECT;
  if (cfg.langsmithEndpoint) process.env.LANGSMITH_ENDPOINT = cfg.langsmithEndpoint;
}
