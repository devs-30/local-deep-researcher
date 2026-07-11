import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigurationError,
  ensureConfiguration,
  validateConfiguration,
} from "../src/configuration";

const MANAGED_ENV = [
  "LLM_PROVIDER",
  "LOCAL_LLM",
  "OLLAMA_BASE_URL",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_API_KEY",
  "SEARCH_API",
  "MAX_WEB_RESEARCH_LOOPS",
  "FETCH_FULL_PAGE",
  "STRIP_THINKING_TOKENS",
  "TAVILY_API_KEY",
  "PERPLEXITY_API_KEY",
  "SEARXNG_URL",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("ensureConfiguration", () => {
  it("returns defaults with no input", () => {
    const cfg = ensureConfiguration();
    expect(cfg.llmProvider).toBe("ollama");
    expect(cfg.localLlm).toBe("llama3.2");
    expect(cfg.ollamaBaseUrl).toBe("http://localhost:11434");
    expect(cfg.searchApi).toBe("duckduckgo");
    expect(cfg.maxWebResearchLoops).toBe(3);
    expect(cfg.fetchFullPage).toBe(false);
    expect(cfg.stripThinkingTokens).toBe(true);
  });

  it("reads values from env vars", () => {
    process.env.LOCAL_LLM = "qwen3";
    process.env.MAX_WEB_RESEARCH_LOOPS = "5";
    process.env.FETCH_FULL_PAGE = "true";
    process.env.STRIP_THINKING_TOKENS = "false";
    const cfg = ensureConfiguration();
    expect(cfg.localLlm).toBe("qwen3");
    expect(cfg.maxWebResearchLoops).toBe(5);
    expect(cfg.fetchFullPage).toBe(true);
    expect(cfg.stripThinkingTokens).toBe(false);
  });

  it("prefers configurable over env", () => {
    process.env.LOCAL_LLM = "from-env";
    const cfg = ensureConfiguration({ configurable: { localLlm: "from-config" } });
    expect(cfg.localLlm).toBe("from-config");
  });

  it("coerces numeric strings from configurable (CLI flags)", () => {
    const cfg = ensureConfiguration({ configurable: { maxWebResearchLoops: "7" } });
    expect(cfg.maxWebResearchLoops).toBe(7);
  });

  it("throws ConfigurationError on invalid enum", () => {
    expect(() => ensureConfiguration({ configurable: { searchApi: "bing" } })).toThrow(
      ConfigurationError,
    );
  });
});

describe("validateConfiguration", () => {
  it("requires TAVILY_API_KEY for tavily", () => {
    const cfg = ensureConfiguration({ configurable: { searchApi: "tavily" } });
    expect(() => validateConfiguration(cfg)).toThrow(/TAVILY_API_KEY/);
  });

  it("requires PERPLEXITY_API_KEY for perplexity", () => {
    const cfg = ensureConfiguration({ configurable: { searchApi: "perplexity" } });
    expect(() => validateConfiguration(cfg)).toThrow(/PERPLEXITY_API_KEY/);
  });

  it("requires SEARXNG_URL for searxng", () => {
    const cfg = ensureConfiguration({ configurable: { searchApi: "searxng" } });
    expect(() => validateConfiguration(cfg)).toThrow(/SEARXNG_URL/);
  });

  it("requires base URL for openai_compatible", () => {
    const cfg = ensureConfiguration({ configurable: { llmProvider: "openai_compatible" } });
    expect(() => validateConfiguration(cfg)).toThrow(/OPENAI_COMPATIBLE_BASE_URL/);
  });

  it("passes for default duckduckgo + ollama", () => {
    expect(() => validateConfiguration(ensureConfiguration())).not.toThrow();
  });
});
