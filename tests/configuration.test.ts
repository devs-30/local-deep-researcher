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
  "GRADE_SOURCES",
  "SOURCE_DOMAIN_BLOCKLIST",
  "COUNT_EMPTY_LOOPS",
  "AGENT_LLM",
  "MAX_AGENT_STEPS",
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
    expect(cfg.localLlm).toBe("gemma4:e4b");
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

  it("defaults gradeSources to true and sourceDomainBlocklist to empty", () => {
    const cfg = ensureConfiguration();
    expect(cfg.gradeSources).toBe(true);
    expect(cfg.sourceDomainBlocklist).toBe("");
  });

  it("reads GRADE_SOURCES and SOURCE_DOMAIN_BLOCKLIST from env", () => {
    process.env.GRADE_SOURCES = "false";
    process.env.SOURCE_DOMAIN_BLOCKLIST = "spam.example, junk.example";
    try {
      const cfg = ensureConfiguration();
      expect(cfg.gradeSources).toBe(false);
      expect(cfg.sourceDomainBlocklist).toBe("spam.example, junk.example");
    } finally {
      delete process.env.GRADE_SOURCES;
      delete process.env.SOURCE_DOMAIN_BLOCKLIST;
    }
  });

  it("lets configurable override GRADE_SOURCES env", () => {
    process.env.GRADE_SOURCES = "false";
    try {
      const cfg = ensureConfiguration({ configurable: { gradeSources: true } });
      expect(cfg.gradeSources).toBe(true);
    } finally {
      delete process.env.GRADE_SOURCES;
    }
  });

  it("defaults countEmptyLoops to false", () => {
    const cfg = ensureConfiguration();
    expect(cfg.countEmptyLoops).toBe(false);
  });

  it("reads COUNT_EMPTY_LOOPS from env", () => {
    process.env.COUNT_EMPTY_LOOPS = "true";
    try {
      const cfg = ensureConfiguration();
      expect(cfg.countEmptyLoops).toBe(true);
    } finally {
      delete process.env.COUNT_EMPTY_LOOPS;
    }
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

describe("agentic configuration", () => {
  it("defaults maxAgentSteps to 20 and leaves agentLlm unset", () => {
    const cfg = ensureConfiguration();
    expect(cfg.maxAgentSteps).toBe(20);
    expect(cfg.agentLlm).toBeUndefined();
  });

  it("reads agentLlm and maxAgentSteps from configurable", () => {
    const cfg = ensureConfiguration({
      configurable: { agentLlm: "qwen3", maxAgentSteps: 5 },
    });
    expect(cfg.agentLlm).toBe("qwen3");
    expect(cfg.maxAgentSteps).toBe(5);
  });

  it("reads AGENT_LLM and MAX_AGENT_STEPS from env", () => {
    process.env.AGENT_LLM = "llama3.3";
    process.env.MAX_AGENT_STEPS = "7";
    try {
      const cfg = ensureConfiguration();
      expect(cfg.agentLlm).toBe("llama3.3");
      expect(cfg.maxAgentSteps).toBe(7);
    } finally {
      delete process.env.AGENT_LLM;
      delete process.env.MAX_AGENT_STEPS;
    }
  });

  it("rejects maxAgentSteps below 1", () => {
    expect(() => ensureConfiguration({ configurable: { maxAgentSteps: 0 } })).toThrow(
      ConfigurationError,
    );
  });
});
