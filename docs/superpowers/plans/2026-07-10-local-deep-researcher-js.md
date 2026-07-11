# @devs30/local-deep-researcher - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TypeScript/LangGraph.js port of langchain-ai/local-deep-researcher: iterative local web-research agent published as one npm package with library, CLI, MCP server and LangGraph Studio entry points.

**Architecture:** A LangGraph `StateGraph` (generateQuery → webResearch → summarizeSources → reflectOnSummary → loop | finalizeSummary) is the single core; `research()` wraps it for the library, `cli.ts` and `mcp.ts` are thin adapters. Search providers implement one `SearchProvider` interface; LLM access goes through one `getLlm` factory (ChatOllama / ChatOpenAI). Dependency injection (`buildGraph(deps)`) makes the graph testable with fake LLM + fake search.

**Tech Stack:** TypeScript strict (moduleResolution Bundler, ESM only), Node ≥ 20, `@langchain/langgraph`, `@langchain/ollama`, `@langchain/openai`, `zod`, `duck-duck-scrape`, `turndown`, `@modelcontextprotocol/sdk`, `dotenv`, build: `tsup`, tests: `vitest`.

## Global Constraints

- Package name: `@devs30/local-deep-researcher`, version starts at `0.1.0`, license MIT, `"type": "module"` (ESM only), `engines.node >= 20`.
- Bin name: `local-deep-researcher` → `dist/cli.js`. Subcommand `mcp` starts the MCP stdio server.
- Env var names (exact): `LLM_PROVIDER`, `LOCAL_LLM`, `OLLAMA_BASE_URL`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `SEARCH_API`, `MAX_WEB_RESEARCH_LOOPS`, `FETCH_FULL_PAGE`, `STRIP_THINKING_TOKENS`, `TAVILY_API_KEY`, `PERPLEXITY_API_KEY`, `SEARXNG_URL`.
- Config precedence: programmatic/`configurable` → env → defaults. `.env` is loaded ONLY in `cli.ts` (which also covers `mcp`), never in library code.
- Defaults: provider `ollama`, model `llama3.2`, search `duckduckgo`, loops `3`, `fetchFullPage=false`, `stripThinkingTokens=true`, `ollamaBaseUrl=http://localhost:11434`.
- Port fidelity: prompts, message formats, source formatting, dedup logic and the `<=` loop condition are copied from the Python original (verbatim strings are embedded in the tasks below - do not paraphrase them).
- Search sizing: DuckDuckGo/SearXNG `maxResults=3`, Tavily `maxResults=1`; `MAX_TOKENS_PER_SOURCE=1000`, `CHARS_PER_TOKEN=4`; full-page fetch timeout 10 s per page.
- CLI: report on stdout, progress on stderr; exit codes: 0 success, 1 config/startup error, 2 research failed after start.
- All user-facing strings, code comments and docs in English.
- Relative imports WITHOUT file extensions (moduleResolution Bundler). Tests live in `tests/`, import from `../src/...`.
- Commit after every task (conventional commits). Run `npm test` before every commit.

---

### Task 1: Project scaffold

**Files:**

- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `src/index.ts`, `tests/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: nothing (first task).
- Produces: working `npm run typecheck`, `npm test`, `npm run build`, `npm run lint` for all later tasks. `src/index.ts` placeholder is replaced in Task 8.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@devs30/local-deep-researcher",
  "version": "0.1.0",
  "description": "Fully local web research assistant (LangGraph.js port of langchain-ai/local-deep-researcher) - library, CLI and MCP server",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "local-deep-researcher": "./dist/cli.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "langgraph.json", "README.md", "LICENSE"],
  "repository": { "type": "git", "url": "https://github.com/devs30/local-deep-researcher" },
  "keywords": ["research", "langgraph", "ollama", "mcp", "deep-research", "agent"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests && prettier --check \"**/*.{ts,js,json,md}\"",
    "format": "prettier --write \"**/*.{ts,js,json,md}\"",
    "prepublishOnly": "npm run typecheck && npm run test && npm run build"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install @langchain/core @langchain/langgraph @langchain/ollama @langchain/openai @modelcontextprotocol/sdk duck-duck-scrape turndown zod@^3.25.0 dotenv
npm install -D typescript tsup vitest @types/node @types/turndown eslint @eslint/js typescript-eslint prettier
```

Expected: both commands succeed, `package-lock.json` created.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "tsup.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Create tsup.config.ts**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  target: "node20",
});
```

Note: `src/cli.ts` does not exist until Task 9. Until then keep the entry list as `["src/index.ts"]` and change it to the above in Task 9. Use this initial version now:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  target: "node20",
});
```

- [ ] **Step 5: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 6: Create eslint.config.js and .prettierrc.json**

`eslint.config.js`:

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
```

`.prettierrc.json`:

```json
{ "printWidth": 100 }
```

- [ ] **Step 7: Create placeholder src/index.ts and smoke test**

`src/index.ts`:

```ts
export const PACKAGE_NAME = "@devs30/local-deep-researcher";
```

`tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";

describe("scaffold", () => {
  it("exposes the package name", () => {
    expect(PACKAGE_NAME).toBe("@devs30/local-deep-researcher");
  });
});
```

- [ ] **Step 8: Extend .gitignore**

Append to the existing `.gitignore`:

```
*.tsbuildinfo
coverage/
```

- [ ] **Step 9: Verify the toolchain**

Run: `npm run typecheck && npm test && npm run build && npm run lint`
Expected: all pass; `dist/index.js` and `dist/index.d.ts` exist. If prettier fails on formatting, run `npm run format` once and re-run.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript package (tsup, vitest, eslint)"
```

---

### Task 2: Configuration

**Files:**

- Create: `src/configuration.ts`
- Test: `tests/configuration.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces (used by every later task):
  - `ConfigurationSchema` (zod object), `type Configuration = z.infer<typeof ConfigurationSchema>`
  - `ensureConfiguration(config?: RunnableConfig): Configuration` - merges `config.configurable` → env → defaults, throws `ConfigurationError` on invalid values
  - `validateConfiguration(cfg: Configuration): void` - throws `ConfigurationError` when a selected provider misses its key/URL
  - `class ConfigurationError extends Error`
  - Field names (exact): `llmProvider`, `localLlm`, `ollamaBaseUrl`, `openaiCompatibleBaseUrl`, `openaiCompatibleApiKey`, `searchApi`, `maxWebResearchLoops`, `fetchFullPage`, `stripThinkingTokens`, `tavilyApiKey`, `perplexityApiKey`, `searxngUrl`

- [ ] **Step 1: Write the failing test**

`tests/configuration.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/configuration.test.ts`
Expected: FAIL - cannot resolve `../src/configuration`.

- [ ] **Step 3: Write the implementation**

`src/configuration.ts`:

```ts
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
  localLlm: z.string().default("llama3.2"),
  ollamaBaseUrl: z.string().default("http://localhost:11434"),
  openaiCompatibleBaseUrl: z.string().optional(),
  openaiCompatibleApiKey: z.string().optional(),
  searchApi: z.enum(["duckduckgo", "tavily", "perplexity", "searxng"]).default("duckduckgo"),
  maxWebResearchLoops: z.coerce.number().int().min(0).default(3),
  fetchFullPage: boolFromString.default(false),
  stripThinkingTokens: boolFromString.default(true),
  tavilyApiKey: z.string().optional(),
  perplexityApiKey: z.string().optional(),
  searxngUrl: z.string().optional(),
});

export type Configuration = z.infer<typeof ConfigurationSchema>;

const ENV_KEYS: Record<keyof Configuration, string> = {
  llmProvider: "LLM_PROVIDER",
  localLlm: "LOCAL_LLM",
  ollamaBaseUrl: "OLLAMA_BASE_URL",
  openaiCompatibleBaseUrl: "OPENAI_COMPATIBLE_BASE_URL",
  openaiCompatibleApiKey: "OPENAI_COMPATIBLE_API_KEY",
  searchApi: "SEARCH_API",
  maxWebResearchLoops: "MAX_WEB_RESEARCH_LOOPS",
  fetchFullPage: "FETCH_FULL_PAGE",
  stripThinkingTokens: "STRIP_THINKING_TOKENS",
  tavilyApiKey: "TAVILY_API_KEY",
  perplexityApiKey: "PERPLEXITY_API_KEY",
  searxngUrl: "SEARXNG_URL",
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/configuration.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/configuration.ts tests/configuration.test.ts
git commit -m "feat: configuration schema with env/configurable precedence and startup validation"
```

---

### Task 3: Prompts (verbatim port of prompts.py)

**Files:**

- Create: `src/prompts.ts`
- Test: `tests/prompts.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (used by Task 7):
  - `getCurrentDate(): string` - e.g. "July 10, 2026"
  - `queryWriterInstructions(params: { currentDate: string; researchTopic: string }): string`
  - `jsonModeQueryInstructions: string` (const)
  - `summarizerInstructions: string` (const)
  - `reflectionInstructions(params: { researchTopic: string }): string`
  - `jsonModeReflectionInstructions: string` (const)

- [ ] **Step 1: Write the failing test**

`tests/prompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  getCurrentDate,
  jsonModeQueryInstructions,
  jsonModeReflectionInstructions,
  queryWriterInstructions,
  reflectionInstructions,
  summarizerInstructions,
} from "../src/prompts";

describe("prompts", () => {
  it("getCurrentDate returns 'Month D, YYYY'", () => {
    expect(getCurrentDate()).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  });

  it("queryWriterInstructions interpolates date and topic", () => {
    const prompt = queryWriterInstructions({
      currentDate: "July 10, 2026",
      researchTopic: "quantum computing",
    });
    expect(prompt).toContain("Current date: July 10, 2026");
    expect(prompt).toContain("quantum computing");
    expect(prompt).toContain('"query"');
  });

  it("reflectionInstructions interpolates the topic", () => {
    const prompt = reflectionInstructions({ researchTopic: "quantum computing" });
    expect(prompt).toContain("analyzing a summary about quantum computing");
  });

  it("JSON-mode instruction constants mention required keys", () => {
    expect(jsonModeQueryInstructions).toContain('"query"');
    expect(jsonModeQueryInstructions).toContain('"rationale"');
    expect(jsonModeReflectionInstructions).toContain("knowledge_gap");
    expect(jsonModeReflectionInstructions).toContain("follow_up_query");
    expect(summarizerInstructions).toContain("<GOAL>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL - cannot resolve `../src/prompts`.

- [ ] **Step 3: Write the implementation (verbatim port - do not rephrase the prompt text)**

`src/prompts.ts`:

```ts
/** Prompts ported verbatim from ollama_deep_researcher/prompts.py (JSON mode only). */

export function getCurrentDate(): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function queryWriterInstructions(params: {
  currentDate: string;
  researchTopic: string;
}): string {
  return `Your goal is to generate a targeted web search query.

<CONTEXT>
Current date: ${params.currentDate}
Please ensure your queries account for the most current information available as of this date.
</CONTEXT>

<TOPIC>
${params.researchTopic}
</TOPIC>

<EXAMPLE>
Example output:
{
    "query": "machine learning transformer architecture explained",
    "rationale": "Understanding the fundamental structure of transformer models"
}
</EXAMPLE>`;
}

export const jsonModeQueryInstructions = `<FORMAT>
Format your response as a JSON object with ALL three of these exact keys:
- "query": The actual search query string
- "rationale": Brief explanation of why this query is relevant
</FORMAT>

Provide your response in JSON format:`;

export const summarizerInstructions = `
<GOAL>
Generate a high-quality summary of the provided context.
</GOAL>

<REQUIREMENTS>
When creating a NEW summary:
1. Highlight the most relevant information related to the user topic from the search results
2. Ensure a coherent flow of information

When EXTENDING an existing summary:
1. Read the existing summary and new search results carefully.
2. Compare the new information with the existing summary.
3. For each piece of new information:
    a. If it's related to existing points, integrate it into the relevant paragraph.
    b. If it's entirely new but relevant, add a new paragraph with a smooth transition.
    c. If it's not relevant to the user topic, skip it.
4. Ensure all additions are relevant to the user's topic.
5. Verify that your final output differs from the input summary.
</REQUIREMENTS>

<FORMATTING>
- Start directly with the updated summary, without preamble or titles. Do not use XML tags in the output.
</FORMATTING>

<Task>
Think carefully about the provided Context first. Then generate a summary of the context to address the User Input.
</Task>
`;

export function reflectionInstructions(params: { researchTopic: string }): string {
  return `You are an expert research assistant analyzing a summary about ${params.researchTopic}.

<GOAL>
1. Identify knowledge gaps or areas that need deeper exploration
2. Generate a follow-up question that would help expand your understanding
3. Focus on technical details, implementation specifics, or emerging trends that weren't fully covered
</GOAL>

<REQUIREMENTS>
Ensure the follow-up question is self-contained and includes necessary context for web search.
</REQUIREMENTS>`;
}

export const jsonModeReflectionInstructions = `<FORMAT>
Format your response as a JSON object with these exact keys:
- knowledge_gap: Describe what information is missing or needs clarification
- follow_up_query: Write a specific question to address this gap
</FORMAT>

<Task>
Reflect carefully on the Summary to identify knowledge gaps and produce a follow-up query. Then, produce your output following this JSON format:
{
    "knowledge_gap": "The summary lacks information about performance metrics and benchmarks",
    "follow_up_query": "What are typical performance benchmarks and metrics used to evaluate [specific technology]?"
}
</Task>

Provide your analysis in JSON format:`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts tests/prompts.test.ts
git commit -m "feat: port research prompts from Python original"
```

---

### Task 4: LLM helpers

**Files:**

- Create: `src/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**

- Consumes: `Configuration` from `src/configuration` (Task 2).
- Produces (used by Task 7):
  - `interface LlmOptions { jsonMode?: boolean }`
  - `type LlmFactory = (cfg: Configuration, opts?: LlmOptions) => BaseChatModel`
  - `getLlm: LlmFactory` - ChatOllama for `ollama`, ChatOpenAI for `openai_compatible`
  - `stripThinkingTokens(text: string): string` - removes all `<think>...</think>` blocks
  - `extractJsonField(content: string, field: string): string | undefined` - JSON.parse + field pick, `undefined` on any failure
  - `contentToString(content: MessageContent): string` - flattens LangChain message content

- [ ] **Step 1: Write the failing test**

`tests/llm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { contentToString, extractJsonField, getLlm, stripThinkingTokens } from "../src/llm";
import { ensureConfiguration } from "../src/configuration";

describe("stripThinkingTokens", () => {
  it("removes a single think block", () => {
    expect(stripThinkingTokens('<think>reasoning</think>{"query": "x"}')).toBe('{"query": "x"}');
  });

  it("removes multiple think blocks iteratively", () => {
    expect(stripThinkingTokens("<think>a</think>foo<think>b</think>bar")).toBe("foobar");
  });

  it("returns text unchanged without think tokens", () => {
    expect(stripThinkingTokens("plain text")).toBe("plain text");
  });

  it("leaves unbalanced tags alone", () => {
    expect(stripThinkingTokens("<think>never closed")).toBe("<think>never closed");
  });
});

describe("extractJsonField", () => {
  it("extracts a string field from valid JSON", () => {
    expect(extractJsonField('{"query": "llm benchmarks", "rationale": "r"}', "query")).toBe(
      "llm benchmarks",
    );
  });

  it("returns undefined for invalid JSON", () => {
    expect(extractJsonField("not json at all", "query")).toBeUndefined();
  });

  it("returns undefined for missing or empty field", () => {
    expect(extractJsonField('{"rationale": "r"}', "query")).toBeUndefined();
    expect(extractJsonField('{"query": ""}', "query")).toBeUndefined();
  });
});

describe("contentToString", () => {
  it("passes strings through", () => {
    expect(contentToString("hello")).toBe("hello");
  });

  it("joins text parts of complex content", () => {
    expect(
      contentToString([
        { type: "text", text: "part1 " },
        { type: "text", text: "part2" },
      ]),
    ).toBe("part1 part2");
  });
});

describe("getLlm", () => {
  it("builds ChatOllama for the ollama provider", () => {
    const cfg = ensureConfiguration({ configurable: { llmProvider: "ollama" } });
    expect(getLlm(cfg, { jsonMode: true })).toBeInstanceOf(ChatOllama);
  });

  it("builds ChatOpenAI for openai_compatible", () => {
    const cfg = ensureConfiguration({
      configurable: {
        llmProvider: "openai_compatible",
        openaiCompatibleBaseUrl: "http://localhost:1234/v1",
        openaiCompatibleApiKey: "test-key",
      },
    });
    expect(getLlm(cfg)).toBeInstanceOf(ChatOpenAI);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm.test.ts`
Expected: FAIL - cannot resolve `../src/llm`.

- [ ] **Step 3: Write the implementation**

`src/llm.ts`:

```ts
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { MessageContent } from "@langchain/core/messages";
import type { Configuration } from "./configuration";

export interface LlmOptions {
  jsonMode?: boolean;
}

export type LlmFactory = (cfg: Configuration, opts?: LlmOptions) => BaseChatModel;

export const getLlm: LlmFactory = (cfg, opts = {}) => {
  if (cfg.llmProvider === "ollama") {
    return new ChatOllama({
      baseUrl: cfg.ollamaBaseUrl,
      model: cfg.localLlm,
      temperature: 0,
      ...(opts.jsonMode ? { format: "json" } : {}),
    });
  }
  return new ChatOpenAI({
    model: cfg.localLlm,
    temperature: 0,
    apiKey: cfg.openaiCompatibleApiKey ?? "not-needed",
    configuration: { baseURL: cfg.openaiCompatibleBaseUrl },
    ...(opts.jsonMode ? { modelKwargs: { response_format: { type: "json_object" } } } : {}),
  });
};

/** Iteratively remove <think>...</think> blocks (deepseek-r1 and similar reasoning models). */
export function stripThinkingTokens(text: string): string {
  let result = text;
  for (;;) {
    const start = result.indexOf("<think>");
    const end = result.indexOf("</think>");
    if (start === -1 || end === -1 || end < start) return result;
    result = result.slice(0, start) + result.slice(end + "</think>".length);
  }
}

/** Parse JSON and return a non-empty string field, or undefined on any failure. */
export function extractJsonField(content: string, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(content.trim());
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

export function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
    )
    .join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/llm.ts tests/llm.test.ts
git commit -m "feat: LLM factory (Ollama/OpenAI-compatible) with JSON-mode helpers"
```

---

### Task 5: Search types, source formatting, full-page fetching

**Files:**

- Create: `src/search/types.ts`, `src/search/format.ts`, `src/search/fetch.ts`
- Test: `tests/search-format.test.ts`, `tests/search-fetch.test.ts`

**Interfaces:**

- Consumes: `Configuration` (Task 2).
- Produces (used by Tasks 6–8):
  - `interface SearchResult { title: string; url: string; content: string; rawContent?: string }`
  - `interface SearchOptions { maxResults: number; fetchFullPage: boolean; loopCount: number; config: Configuration }`
  - `type SearchProvider = (query: string, opts: SearchOptions) => Promise<SearchResult[]>`
  - `deduplicateAndFormatSources(results: SearchResult[], maxTokensPerSource: number, fetchFullPage: boolean): string`
  - `formatSources(results: SearchResult[]): string` - lines `* {title} : {url}`
  - `parseSourceLine(line: string): { title: string; url: string }`
  - `fetchRawContent(url: string, timeoutMs?: number): Promise<string | undefined>` - HTML→markdown, undefined on any failure

- [ ] **Step 1: Write the failing formatting test**

`tests/search-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deduplicateAndFormatSources, formatSources, parseSourceLine } from "../src/search/format";
import type { SearchResult } from "../src/search/types";

const results: SearchResult[] = [
  { title: "A", url: "https://a.example", content: "alpha", rawContent: "x".repeat(5000) },
  { title: "B", url: "https://b.example", content: "beta" },
  { title: "A-dup", url: "https://a.example", content: "duplicate of A" },
];

describe("deduplicateAndFormatSources", () => {
  it("deduplicates by URL and formats sections", () => {
    const text = deduplicateAndFormatSources(results, 1000, false);
    expect(text).toContain("Sources:");
    expect(text).toContain("Source: A\n===");
    expect(text).toContain("URL: https://a.example");
    expect(text).toContain("Most relevant content from source: alpha");
    expect(text).toContain("Source: B\n===");
    expect(text).not.toContain("A-dup");
    expect(text).not.toContain("Full source content");
  });

  it("appends truncated raw content when fetchFullPage=true", () => {
    const text = deduplicateAndFormatSources(results, 1000, true);
    expect(text).toContain("Full source content limited to 1000 tokens:");
    expect(text).toContain("... [truncated]");
  });
});

describe("formatSources / parseSourceLine", () => {
  it("formats one bullet line per result", () => {
    expect(formatSources(results.slice(0, 2))).toBe(
      "* A : https://a.example\n* B : https://b.example",
    );
  });

  it("round-trips through parseSourceLine", () => {
    expect(parseSourceLine("* A : https://a.example")).toEqual({
      title: "A",
      url: "https://a.example",
    });
  });

  it("keeps colons inside titles intact", () => {
    expect(parseSourceLine("* Rust: The Book : https://doc.rust-lang.org")).toEqual({
      title: "Rust: The Book",
      url: "https://doc.rust-lang.org",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search-format.test.ts`
Expected: FAIL - cannot resolve `../src/search/format`.

- [ ] **Step 3: Implement types and formatting**

`src/search/types.ts`:

```ts
import type { Configuration } from "../configuration";

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
}

export interface SearchOptions {
  maxResults: number;
  fetchFullPage: boolean;
  /** 0-based research loop counter (used by the Perplexity provider for labels). */
  loopCount: number;
  config: Configuration;
}

export type SearchProvider = (query: string, opts: SearchOptions) => Promise<SearchResult[]>;
```

`src/search/format.ts` (port of utils.py formatting):

```ts
import type { SearchResult } from "./types";

const CHARS_PER_TOKEN = 4;

/** Port of deduplicate_and_format_sources: dedup by URL, format one block per source. */
export function deduplicateAndFormatSources(
  results: SearchResult[],
  maxTokensPerSource: number,
  fetchFullPage: boolean,
): string {
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    if (!unique.has(result.url)) unique.set(result.url, result);
  }
  let formatted = "Sources:\n\n";
  for (const source of unique.values()) {
    formatted += `Source: ${source.title}\n===\n`;
    formatted += `URL: ${source.url}\n===\n`;
    formatted += `Most relevant content from source: ${source.content}\n===\n`;
    if (fetchFullPage) {
      const charLimit = maxTokensPerSource * CHARS_PER_TOKEN;
      let raw = source.rawContent ?? "";
      if (raw.length > charLimit) raw = raw.slice(0, charLimit) + "... [truncated]";
      formatted += `Full source content limited to ${maxTokensPerSource} tokens: ${raw}\n\n`;
    }
  }
  return formatted.trim();
}

/** Port of format_sources: bullet list "* title : url". */
export function formatSources(results: SearchResult[]): string {
  return results.map((r) => `* ${r.title} : ${r.url}`).join("\n");
}

/** Inverse of formatSources for structured library output; splits on the LAST " : ". */
export function parseSourceLine(line: string): { title: string; url: string } {
  const body = line.replace(/^\*\s*/, "");
  const idx = body.lastIndexOf(" : ");
  if (idx === -1) return { title: body, url: "" };
  return { title: body.slice(0, idx), url: body.slice(idx + 3) };
}
```

- [ ] **Step 4: Run formatting test to verify it passes**

Run: `npx vitest run tests/search-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing fetch test**

`tests/search-fetch.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRawContent } from "../src/search/fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRawContent", () => {
  it("converts fetched HTML to markdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><body><h1>Title</h1><p>Body text</p></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const md = await fetchRawContent("https://example.com");
    expect(md).toContain("Title");
    expect(md).toContain("Body text");
  });

  it("returns undefined on HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    expect(await fetchRawContent("https://example.com")).toBeUndefined();
  });

  it("returns undefined on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("boom"))),
    );
    expect(await fetchRawContent("https://example.com")).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run fetch test to verify it fails**

Run: `npx vitest run tests/search-fetch.test.ts`
Expected: FAIL - cannot resolve `../src/search/fetch`.

- [ ] **Step 7: Implement fetchRawContent**

`src/search/fetch.ts`:

```ts
import TurndownService from "turndown";

const turndown = new TurndownService();

/**
 * Fetch a page and convert HTML to markdown (port of fetch_raw_content).
 * Failures are silent by design: the caller keeps the search snippet instead.
 */
export async function fetchRawContent(
  url: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "local-deep-researcher" },
    });
    if (!res.ok) return undefined;
    return turndown.turndown(await res.text());
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 8: Run fetch test to verify it passes**

Run: `npx vitest run tests/search-fetch.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/search tests/search-format.test.ts tests/search-fetch.test.ts
git commit -m "feat: search types, source formatting and full-page fetching"
```

---

### Task 6: Search providers + registry + retry

**Files:**

- Create: `src/search/duckduckgo.ts`, `src/search/tavily.ts`, `src/search/perplexity.ts`, `src/search/searxng.ts`, `src/search/index.ts`
- Test: `tests/search-providers.test.ts`

**Interfaces:**

- Consumes: `SearchProvider`, `SearchResult`, `SearchOptions` (Task 5); `fetchRawContent` (Task 5); `Configuration` (Task 2).
- Produces (used by Task 7):
  - `getSearchProvider(name: Configuration["searchApi"]): SearchProvider`
  - `searchWithRetry(provider: SearchProvider, query: string, opts: SearchOptions, retryDelayMs?: number): Promise<SearchResult[]>` - one retry, second failure propagates
  - Named providers: `duckduckgoSearch`, `tavilySearch`, `perplexitySearch`, `searxngSearch`

- [ ] **Step 1: Write the failing test**

`tests/search-providers.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureConfiguration } from "../src/configuration";
import type { SearchOptions, SearchProvider } from "../src/search/types";
import { getSearchProvider, searchWithRetry } from "../src/search/index";
import { duckduckgoSearch } from "../src/search/duckduckgo";
import { tavilySearch } from "../src/search/tavily";
import { perplexitySearch } from "../src/search/perplexity";
import { searxngSearch } from "../src/search/searxng";

vi.mock("duck-duck-scrape", () => ({
  SafeSearchType: { MODERATE: 0 },
  search: vi.fn(async () => ({
    results: [
      { title: "<b>DDG One</b>", url: "https://one.example", description: "first <i>hit</i>" },
      { title: "DDG Two", url: "https://two.example", description: "second hit" },
      { title: "DDG Three", url: "https://three.example", description: "third hit" },
      { title: "DDG Four", url: "https://four.example", description: "fourth hit" },
    ],
  })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function opts(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    maxResults: 3,
    fetchFullPage: false,
    loopCount: 0,
    config: ensureConfiguration({
      configurable: {
        tavilyApiKey: "tvly-test",
        perplexityApiKey: "pplx-test",
        searxngUrl: "http://searx.local",
      },
    }),
    ...overrides,
  };
}

describe("duckduckgoSearch", () => {
  it("maps and truncates results, stripping HTML", async () => {
    const results = await duckduckgoSearch("query", opts());
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "DDG One",
      url: "https://one.example",
      content: "first hit",
    });
  });
});

describe("tavilySearch", () => {
  it("POSTs to the Tavily API and maps results", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [
          { title: "T", url: "https://t.example", content: "tavily hit", raw_content: "full" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const results = await tavilySearch("query", opts({ maxResults: 1, fetchFullPage: true }));
    expect(results).toEqual([
      { title: "T", url: "https://t.example", content: "tavily hit", rawContent: "full" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(init.body as string)).toMatchObject({
      query: "query",
      max_results: 1,
      include_raw_content: true,
    });
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 401 })),
    );
    await expect(tavilySearch("query", opts())).rejects.toThrow(/Tavily API error: 401/);
  });
});

describe("perplexitySearch", () => {
  it("maps the answer plus citations like the Python original", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { content: "The answer." } }],
          citations: ["https://c1.example", "https://c2.example"],
        }),
      ),
    );
    const results = await perplexitySearch("query", opts({ loopCount: 1 }));
    expect(results).toEqual([
      {
        title: "Perplexity Search 2, Source 1",
        url: "https://c1.example",
        content: "The answer.",
        rawContent: "The answer.",
      },
      {
        title: "Perplexity Search 2, Source 2",
        url: "https://c2.example",
        content: "See above content.",
        rawContent: "See above content.",
      },
    ]);
  });
});

describe("searxngSearch", () => {
  it("GETs the configured instance with format=json", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [{ title: "S", url: "https://s.example", content: "searx hit" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const results = await searxngSearch("query", opts());
    expect(results).toEqual([{ title: "S", url: "https://s.example", content: "searx hit" }]);
    const requested = String(fetchMock.mock.calls[0][0]);
    expect(requested).toContain("http://searx.local/search");
    expect(requested).toContain("format=json");
    expect(requested).toContain("q=query");
  });
});

describe("getSearchProvider", () => {
  it("resolves every configured name", () => {
    expect(getSearchProvider("duckduckgo")).toBe(duckduckgoSearch);
    expect(getSearchProvider("tavily")).toBe(tavilySearch);
    expect(getSearchProvider("perplexity")).toBe(perplexitySearch);
    expect(getSearchProvider("searxng")).toBe(searxngSearch);
  });
});

describe("searchWithRetry", () => {
  it("retries once after a failure", async () => {
    const provider: SearchProvider = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([{ title: "ok", url: "https://ok.example", content: "c" }]);
    const results = await searchWithRetry(provider, "q", opts(), 0);
    expect(results).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("propagates the second failure", async () => {
    const provider: SearchProvider = vi.fn().mockRejectedValue(new Error("down"));
    await expect(searchWithRetry(provider, "q", opts(), 0)).rejects.toThrow("down");
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search-providers.test.ts`
Expected: FAIL - cannot resolve `../src/search/index` (and provider modules).

- [ ] **Step 3: Implement the providers**

`src/search/duckduckgo.ts`:

```ts
import { search, SafeSearchType } from "duck-duck-scrape";
import { fetchRawContent } from "./fetch";
import type { SearchProvider, SearchResult } from "./types";

const stripHtml = (text: string): string => text.replace(/<[^>]+>/g, "");

export const duckduckgoSearch: SearchProvider = async (query, opts) => {
  const response = await search(query, { safeSearch: SafeSearchType.MODERATE });
  const results: SearchResult[] = response.results.slice(0, opts.maxResults).map((r) => ({
    title: stripHtml(r.title),
    url: r.url,
    content: stripHtml(r.description),
  }));
  if (opts.fetchFullPage) {
    for (const result of results) result.rawContent = await fetchRawContent(result.url);
  }
  return results;
};
```

`src/search/tavily.ts`:

```ts
import type { SearchProvider } from "./types";

interface TavilyResponse {
  results?: Array<{ title: string; url: string; content: string; raw_content?: string | null }>;
}

export const tavilySearch: SearchProvider = async (query, opts) => {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.config.tavilyApiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: opts.maxResults,
      include_raw_content: opts.fetchFullPage,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as TavilyResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    ...(r.raw_content ? { rawContent: r.raw_content } : {}),
  }));
};
```

`src/search/perplexity.ts`:

```ts
import type { SearchProvider } from "./types";

interface PerplexityResponse {
  choices: Array<{ message: { content: string } }>;
  citations?: string[];
}

export const perplexitySearch: SearchProvider = async (query, opts) => {
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.config.perplexityApiKey}`,
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: "Search the web and provide factual information with sources." },
        { role: "user", content: query },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Perplexity API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as PerplexityResponse;
  const content = data.choices[0]?.message.content ?? "";
  const citations = data.citations?.length ? data.citations : ["https://perplexity.ai"];
  const label = `Perplexity Search ${opts.loopCount + 1}`;
  return citations.map((url, index) => ({
    title: `${label}, Source ${index + 1}`,
    url,
    content: index === 0 ? content : "See above content.",
    rawContent: index === 0 ? content : "See above content.",
  }));
};
```

`src/search/searxng.ts`:

```ts
import { fetchRawContent } from "./fetch";
import type { SearchProvider, SearchResult } from "./types";

interface SearxngResponse {
  results?: Array<{ title: string; url: string; content?: string }>;
}

export const searxngSearch: SearchProvider = async (query, opts) => {
  const url = new URL("/search", opts.config.searxngUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`SearXNG error: ${res.status}`);
  const data = (await res.json()) as SearxngResponse;
  const results: SearchResult[] = (data.results ?? []).slice(0, opts.maxResults).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content ?? "",
  }));
  if (opts.fetchFullPage) {
    for (const result of results) result.rawContent = await fetchRawContent(result.url);
  }
  return results;
};
```

`src/search/index.ts`:

```ts
import type { Configuration } from "../configuration";
import { duckduckgoSearch } from "./duckduckgo";
import { tavilySearch } from "./tavily";
import { perplexitySearch } from "./perplexity";
import { searxngSearch } from "./searxng";
import type { SearchOptions, SearchProvider, SearchResult } from "./types";

export type { SearchOptions, SearchProvider, SearchResult } from "./types";
export { duckduckgoSearch, tavilySearch, perplexitySearch, searxngSearch };

export function getSearchProvider(name: Configuration["searchApi"]): SearchProvider {
  switch (name) {
    case "duckduckgo":
      return duckduckgoSearch;
    case "tavily":
      return tavilySearch;
    case "perplexity":
      return perplexitySearch;
    case "searxng":
      return searxngSearch;
  }
}

/** One retry with a small delay; the second failure propagates to the caller. */
export async function searchWithRetry(
  provider: SearchProvider,
  query: string,
  opts: SearchOptions,
  retryDelayMs = 1000,
): Promise<SearchResult[]> {
  try {
    return await provider(query, opts);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return provider(query, opts);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/search-providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: all green.

```bash
git add src/search tests/search-providers.test.ts
git commit -m "feat: DuckDuckGo, Tavily, Perplexity and SearXNG search providers with retry"
```

---

### Task 7: State and graph (core port of graph.py)

**Files:**

- Create: `src/state.ts`, `src/graph.ts`
- Test: `tests/graph.test.ts`

**Interfaces:**

- Consumes: `ensureConfiguration` (Task 2); prompts (Task 3); `getLlm`, `LlmFactory`, `stripThinkingTokens`, `extractJsonField`, `contentToString` (Task 4); `getSearchProvider`, `searchWithRetry`, `deduplicateAndFormatSources`, `formatSources` (Tasks 5–6).
- Produces (used by Tasks 8, 11):
  - `SummaryStateAnnotation`, `type SummaryState`
  - `interface GraphDeps { getLlm: LlmFactory; getSearchProvider: typeof getSearchProvider; retryDelayMs: number; warn: (message: string) => void }`
  - `buildGraph(overrides?: Partial<GraphDeps>)` - returns a compiled graph
  - `graph` - default compiled graph (`buildGraph()`), exported for LangGraph Studio
  - `class SearchFailedError extends Error`
  - Node names (exact, used for progress mapping): `generateQuery`, `webResearch`, `summarizeSources`, `reflectOnSummary`, `finalizeSummary`

- [ ] **Step 1: Write src/state.ts (no separate test - covered by graph tests)**

```ts
import { Annotation } from "@langchain/langgraph";

export const SummaryStateAnnotation = Annotation.Root({
  researchTopic: Annotation<string>(),
  searchQuery: Annotation<string>(),
  webResearchResults: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  sourcesGathered: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  researchLoopCount: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  runningSummary: Annotation<string>(),
});

export type SummaryState = typeof SummaryStateAnnotation.State;
```

- [ ] **Step 2: Write the failing graph test**

`tests/graph.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { buildGraph, SearchFailedError } from "../src/graph";
import type { SearchProvider } from "../src/search/types";

const fakeSearch: SearchProvider = async (query) => [
  {
    title: `Result for ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}`,
    content: `Snippet about ${query}`,
  },
];

function fakeLlm() {
  // FakeListChatModel cycles through responses; order per loop:
  // generateQuery (JSON) -> summarize (text) -> reflect (JSON)
  return new FakeListChatModel({
    responses: [
      '{"query": "initial query", "rationale": "start"}',
      "A running summary.",
      '{"knowledge_gap": "gap", "follow_up_query": "follow-up query"}',
    ],
  });
}

describe("research graph", () => {
  it("loops maxWebResearchLoops+1 times and finalizes with sources", async () => {
    const graph = buildGraph({
      getLlm: () => fakeLlm(),
      getSearchProvider: () => fakeSearch,
      retryDelayMs: 0,
    });
    const state = await graph.invoke(
      { researchTopic: "test topic" },
      { configurable: { maxWebResearchLoops: 1 }, recursionLimit: 50 },
    );
    // <= condition (port fidelity): loops run until count exceeds max, so 2 searches for max=1
    expect(state.researchLoopCount).toBe(2);
    expect(state.sourcesGathered).toHaveLength(2);
    expect(state.runningSummary).toContain("## Summary");
    expect(state.runningSummary).toContain("### Sources:");
    expect(state.runningSummary).toContain("* Result for initial query : ");
  });

  it("falls back to the topic when query JSON is invalid", async () => {
    const llm = new FakeListChatModel({
      responses: ["THIS IS NOT JSON", "A summary.", "also not json"],
    });
    const seen: string[] = [];
    const spySearch: SearchProvider = async (query) => {
      seen.push(query);
      return fakeSearch(query, undefined as never);
    };
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => spySearch,
      retryDelayMs: 0,
    });
    await graph.invoke(
      { researchTopic: "fallback topic" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    // generateQuery fallback = the topic itself; reflect fallback = "Tell me more about ..."
    expect(seen[0]).toBe("fallback topic");
  });

  it("hard-fails when search dies on the first loop with no sources", async () => {
    const failingSearch: SearchProvider = async () => {
      throw new Error("network down");
    };
    const graph = buildGraph({
      getLlm: () => fakeLlm(),
      getSearchProvider: () => failingSearch,
      retryDelayMs: 0,
    });
    await expect(
      graph.invoke(
        { researchTopic: "t" },
        { configurable: { maxWebResearchLoops: 1 }, recursionLimit: 50 },
      ),
    ).rejects.toThrow(SearchFailedError);
  });

  it("continues with a warning when search fails but sources exist", async () => {
    const failingSearch: SearchProvider = async () => {
      throw new Error("network down");
    };
    const warn = vi.fn();
    const graph = buildGraph({
      getLlm: () => fakeLlm(),
      getSearchProvider: () => failingSearch,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      { researchTopic: "t", sourcesGathered: ["* Seed : https://seed.example"] },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    expect(warn).toHaveBeenCalled();
    expect(state.runningSummary).toContain("* Seed : https://seed.example");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/graph.test.ts`
Expected: FAIL - cannot resolve `../src/graph`.

- [ ] **Step 4: Implement the graph**

`src/graph.ts`:

```ts
import { END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { ensureConfiguration } from "./configuration";
import {
  contentToString,
  extractJsonField,
  getLlm as defaultGetLlm,
  stripThinkingTokens,
  type LlmFactory,
} from "./llm";
import * as prompts from "./prompts";
import { deduplicateAndFormatSources, formatSources } from "./search/format";
import { getSearchProvider as defaultGetSearchProvider, searchWithRetry } from "./search/index";
import { SummaryStateAnnotation, type SummaryState } from "./state";

const MAX_TOKENS_PER_SOURCE = 1000;

export class SearchFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchFailedError";
  }
}

export interface GraphDeps {
  getLlm: LlmFactory;
  getSearchProvider: typeof defaultGetSearchProvider;
  retryDelayMs: number;
  warn: (message: string) => void;
}

export function buildGraph(overrides: Partial<GraphDeps> = {}) {
  const deps: GraphDeps = {
    getLlm: defaultGetLlm,
    getSearchProvider: defaultGetSearchProvider,
    retryDelayMs: 1000,
    warn: (message) => console.error(message),
    ...overrides,
  };

  async function generateQuery(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const systemPrompt = prompts.queryWriterInstructions({
      currentDate: prompts.getCurrentDate(),
      researchTopic: state.researchTopic,
    });
    const llm = deps.getLlm(cfg, { jsonMode: true });
    const result = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(prompts.jsonModeQueryInstructions),
    ]);
    let content = contentToString(result.content);
    if (cfg.stripThinkingTokens) content = stripThinkingTokens(content);
    // Fallback (per spec): use the topic itself as the query.
    const query = extractJsonField(content, "query") ?? state.researchTopic;
    return { searchQuery: query };
  }

  async function webResearch(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const provider = deps.getSearchProvider(cfg.searchApi);
    const searchOptions = {
      maxResults: cfg.searchApi === "tavily" ? 1 : 3,
      fetchFullPage: cfg.fetchFullPage,
      loopCount: state.researchLoopCount,
      config: cfg,
    };
    let results;
    try {
      results = await searchWithRetry(
        provider,
        state.searchQuery,
        searchOptions,
        deps.retryDelayMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state.sourcesGathered.length === 0) {
        throw new SearchFailedError(
          `Web search failed on the first research loop (${cfg.searchApi}): ${message}`,
        );
      }
      deps.warn(
        `Web search failed (${cfg.searchApi}), continuing with gathered sources: ${message}`,
      );
      results = [];
    }
    return {
      sourcesGathered: results.length > 0 ? [formatSources(results)] : [],
      researchLoopCount: state.researchLoopCount + 1,
      webResearchResults: [
        deduplicateAndFormatSources(results, MAX_TOKENS_PER_SOURCE, cfg.fetchFullPage),
      ],
    };
  }

  async function summarizeSources(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const mostRecent = state.webResearchResults[state.webResearchResults.length - 1] ?? "";
    // Message formats ported verbatim from graph.py.
    const humanMessage = state.runningSummary
      ? `<Existing Summary> \n ${state.runningSummary} \n <Existing Summary>\n\n<New Context> \n ${mostRecent} \n <New Context>Update the Existing Summary with the New Context on this topic: \n <User Input> \n ${state.researchTopic} \n <User Input>\n\n`
      : `<Context> \n ${mostRecent} \n <Context>Create a Summary using the Context on this topic: \n <User Input> \n ${state.researchTopic} \n <User Input>\n\n`;
    const llm = deps.getLlm(cfg);
    const result = await llm.invoke([
      new SystemMessage(prompts.summarizerInstructions),
      new HumanMessage(humanMessage),
    ]);
    let summary = contentToString(result.content);
    if (cfg.stripThinkingTokens) summary = stripThinkingTokens(summary);
    return { runningSummary: summary };
  }

  async function reflectOnSummary(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const llm = deps.getLlm(cfg, { jsonMode: true });
    const result = await llm.invoke([
      new SystemMessage(prompts.reflectionInstructions({ researchTopic: state.researchTopic })),
      new HumanMessage(
        `${prompts.jsonModeReflectionInstructions}\n\nReflect on our existing knowledge: \n === \n ${state.runningSummary}, \n === \n And now identify a knowledge gap and generate a follow-up web search query:`,
      ),
    ]);
    let content = contentToString(result.content);
    if (cfg.stripThinkingTokens) content = stripThinkingTokens(content);
    const followUp =
      extractJsonField(content, "follow_up_query") ?? `Tell me more about ${state.researchTopic}`;
    return { searchQuery: followUp };
  }

  function finalizeSummary(state: SummaryState) {
    // Port of finalize_summary: dedup source lines across all gathered blocks.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const block of state.sourcesGathered) {
      for (const line of block.split("\n")) {
        if (line.trim() && !seen.has(line)) {
          seen.add(line);
          unique.push(line);
        }
      }
    }
    const allSources = unique.join("\n");
    return {
      runningSummary: `## Summary\n${state.runningSummary}\n\n ### Sources:\n${allSources}`,
    };
  }

  function routeResearch(
    state: SummaryState,
    config?: RunnableConfig,
  ): "webResearch" | "finalizeSummary" {
    const cfg = ensureConfiguration(config);
    // Port fidelity: <= means max=N yields N+1 search rounds, matching the original.
    return state.researchLoopCount <= cfg.maxWebResearchLoops ? "webResearch" : "finalizeSummary";
  }

  return new StateGraph(SummaryStateAnnotation)
    .addNode("generateQuery", generateQuery)
    .addNode("webResearch", webResearch)
    .addNode("summarizeSources", summarizeSources)
    .addNode("reflectOnSummary", reflectOnSummary)
    .addNode("finalizeSummary", finalizeSummary)
    .addEdge(START, "generateQuery")
    .addEdge("generateQuery", "webResearch")
    .addEdge("webResearch", "summarizeSources")
    .addEdge("summarizeSources", "reflectOnSummary")
    .addConditionalEdges("reflectOnSummary", routeResearch, ["webResearch", "finalizeSummary"])
    .addEdge("finalizeSummary", END)
    .compile();
}

/** Default compiled graph - entry point for LangGraph Studio (langgraph.json). */
export const graph = buildGraph();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/graph.test.ts`
Expected: PASS (4 tests). If the loop-count assertion fails, verify `routeResearch` uses `<=` and that `webResearch` increments `researchLoopCount` by exactly 1.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: all green.

```bash
git add src/state.ts src/graph.ts tests/graph.test.ts
git commit -m "feat: LangGraph research loop (port of graph.py) with injectable deps"
```

---

### Task 8: research() library API and public exports

**Files:**

- Create: `src/research.ts`
- Modify: `src/index.ts` (replace placeholder)
- Test: `tests/research.test.ts`

**Interfaces:**

- Consumes: `buildGraph`, `GraphDeps` (Task 7); `ensureConfiguration`, `validateConfiguration`, `ConfigurationError`, `Configuration` (Task 2); `parseSourceLine` (Task 5).
- Produces (used by Tasks 9–10):
  - `interface Source { title: string; url: string }`
  - `interface ResearchReport { summary: string; sources: Source[]; markdown: string }`
  - `type ResearchPhase = "generating_query" | "searching" | "summarizing" | "reflecting" | "finalizing"`
  - `interface ProgressEvent { phase: ResearchPhase; loop: number; maxLoops: number }`
  - `interface ResearchHooks { onProgress?: (event: ProgressEvent) => void }`
  - `research(topic: string, options?: Partial<Configuration>, hooks?: ResearchHooks, deps?: Partial<GraphDeps>): Promise<ResearchReport>`

- [ ] **Step 1: Write the failing test**

`tests/research.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ConfigurationError } from "../src/configuration";
import { research, type ProgressEvent } from "../src/research";
import type { SearchProvider } from "../src/search/types";

const fakeSearch: SearchProvider = async (query) => [
  {
    title: `Result for ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}`,
    content: "snippet",
  },
];

const deps = {
  getLlm: () =>
    new FakeListChatModel({
      responses: [
        '{"query": "q1", "rationale": "r"}',
        "The summary.",
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
      ],
    }),
  getSearchProvider: () => fakeSearch,
  retryDelayMs: 0,
};

describe("research", () => {
  it("returns summary, structured sources and markdown", async () => {
    const report = await research("test topic", { maxWebResearchLoops: 1 }, {}, deps);
    expect(report.markdown).toContain("## Summary");
    expect(report.markdown).toContain("### Sources:");
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.summary).not.toContain("## Summary");
    expect(report.sources.length).toBeGreaterThanOrEqual(2);
    expect(report.sources[0]).toEqual({
      title: "Result for q1",
      url: "https://example.com/q1",
    });
  });

  it("emits progress events with phases and loop counts", async () => {
    const events: ProgressEvent[] = [];
    await research("t", { maxWebResearchLoops: 0 }, { onProgress: (e) => events.push(e) }, deps);
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("searching");
    expect(phases).toContain("summarizing");
    expect(phases[phases.length - 1]).toBe("finalizing");
    expect(events.every((e) => e.maxLoops === 0)).toBe(true);
  });

  it("rejects an empty topic", async () => {
    await expect(research("   ", {}, {}, deps)).rejects.toThrow(ConfigurationError);
  });

  it("rejects invalid configuration before running", async () => {
    await expect(research("t", { searchApi: "tavily" }, {}, deps)).rejects.toThrow(
      /TAVILY_API_KEY/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/research.test.ts`
Expected: FAIL - cannot resolve `../src/research`.

- [ ] **Step 3: Implement research()**

`src/research.ts`:

```ts
import {
  ConfigurationError,
  ensureConfiguration,
  validateConfiguration,
  type Configuration,
} from "./configuration";
import { buildGraph, type GraphDeps } from "./graph";
import { parseSourceLine } from "./search/format";

export interface Source {
  title: string;
  url: string;
}

export interface ResearchReport {
  summary: string;
  sources: Source[];
  markdown: string;
}

export type ResearchPhase =
  "generating_query" | "searching" | "summarizing" | "reflecting" | "finalizing";

export interface ProgressEvent {
  phase: ResearchPhase;
  loop: number;
  maxLoops: number;
}

export interface ResearchHooks {
  onProgress?: (event: ProgressEvent) => void;
}

const PHASE_BY_NODE: Record<string, ResearchPhase> = {
  generateQuery: "generating_query",
  webResearch: "searching",
  summarizeSources: "summarizing",
  reflectOnSummary: "reflecting",
  finalizeSummary: "finalizing",
};

export async function research(
  topic: string,
  options: Partial<Configuration> = {},
  hooks: ResearchHooks = {},
  deps: Partial<GraphDeps> = {},
): Promise<ResearchReport> {
  if (!topic.trim()) throw new ConfigurationError("Research topic must not be empty");
  const cfg = ensureConfiguration({ configurable: options });
  validateConfiguration(cfg);

  const graph = buildGraph(deps);
  const stream = await graph.stream(
    { researchTopic: topic },
    {
      configurable: options,
      streamMode: "updates",
      recursionLimit: 20 + cfg.maxWebResearchLoops * 5,
    },
  );

  let loop = 0;
  let summary = "";
  let markdown = "";
  const rawSourceBlocks: string[] = [];

  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk as Record<string, Record<string, unknown>>)) {
      if (node === "webResearch") {
        loop = typeof update.researchLoopCount === "number" ? update.researchLoopCount : loop;
        rawSourceBlocks.push(...((update.sourcesGathered as string[] | undefined) ?? []));
      }
      if (node === "summarizeSources") summary = String(update.runningSummary ?? summary);
      if (node === "finalizeSummary") markdown = String(update.runningSummary ?? markdown);
      const phase = PHASE_BY_NODE[node];
      if (phase) hooks.onProgress?.({ phase, loop, maxLoops: cfg.maxWebResearchLoops });
    }
  }

  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const block of rawSourceBlocks) {
    for (const line of block.split("\n")) {
      if (line.trim() && !seen.has(line)) {
        seen.add(line);
        sources.push(parseSourceLine(line));
      }
    }
  }

  return { summary, sources, markdown };
}
```

- [ ] **Step 4: Replace src/index.ts with public exports**

```ts
export {
  research,
  type ProgressEvent,
  type ResearchHooks,
  type ResearchPhase,
  type ResearchReport,
  type Source,
} from "./research";
export { buildGraph, graph, SearchFailedError, type GraphDeps } from "./graph";
export {
  ConfigurationError,
  ConfigurationSchema,
  ensureConfiguration,
  validateConfiguration,
  type Configuration,
} from "./configuration";
export { SummaryStateAnnotation, type SummaryState } from "./state";
export type { SearchOptions, SearchProvider, SearchResult } from "./search/types";
```

Also update `tests/smoke.test.ts` to match the new index:

```ts
import { describe, expect, it } from "vitest";
import { graph, research } from "../src/index";

describe("public API", () => {
  it("exports research() and the compiled graph", () => {
    expect(typeof research).toBe("function");
    expect(graph).toBeDefined();
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/research.test.ts tests/smoke.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, build, commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green, `dist/index.d.ts` contains `research`.

```bash
git add src/research.ts src/index.ts tests/research.test.ts tests/smoke.test.ts
git commit -m "feat: research() library API with progress hooks and structured sources"
```

---

### Task 9: Ollama preflight + CLI

**Files:**

- Create: `src/preflight.ts`, `src/cli-args.ts`, `src/cli.ts`
- Modify: `tsup.config.ts` (add `src/cli.ts` entry - see Task 1 Step 4)
- Test: `tests/preflight.test.ts`, `tests/cli-args.test.ts`

**Interfaces:**

- Consumes: `research` (Task 8); `ensureConfiguration`, `validateConfiguration`, `ConfigurationError` (Task 2); `runMcpServer` (Task 10 - until Task 10 lands, keep the `mcp` branch as the stub shown in Step 7).
- Produces:
  - `class PreflightError extends Error`
  - `preflightOllama(cfg: Configuration, fetchFn?: typeof fetch): Promise<void>`
  - `parseCliArgs(argv: string[]): CliCommand` where `type CliCommand = { kind: "research"; options: CliOptions } | { kind: "mcp" } | { kind: "help" } | { kind: "version" }` and `interface CliOptions { topic: string; configurable: Record<string, unknown>; output?: string; json: boolean; quiet: boolean }`
  - `main(argv?: string[]): Promise<number>` (exit code) in `src/cli.ts`, executed on module load

- [ ] **Step 1: Write the failing preflight test**

`tests/preflight.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ensureConfiguration } from "../src/configuration";
import { PreflightError, preflightOllama } from "../src/preflight";

const cfg = (over: Record<string, unknown> = {}) =>
  ensureConfiguration({ configurable: { llmProvider: "ollama", localLlm: "llama3.2", ...over } });

describe("preflightOllama", () => {
  it("passes when the model is present", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ models: [{ name: "llama3.2:latest" }] }),
    ) as unknown as typeof fetch;
    await expect(preflightOllama(cfg(), fetchFn)).resolves.toBeUndefined();
  });

  it("suggests ollama pull when the model is missing", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ models: [{ name: "qwen3:latest" }] }),
    ) as unknown as typeof fetch;
    await expect(preflightOllama(cfg(), fetchFn)).rejects.toThrow(/ollama pull llama3.2/);
  });

  it("explains when Ollama is unreachable", async () => {
    const fetchFn = vi.fn(async () =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof fetch;
    await expect(preflightOllama(cfg(), fetchFn)).rejects.toThrow(PreflightError);
    await expect(preflightOllama(cfg(), fetchFn)).rejects.toThrow(/Cannot reach Ollama/);
  });

  it("is a no-op for openai_compatible", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await preflightOllama(
      cfg({ llmProvider: "openai_compatible", openaiCompatibleBaseUrl: "http://x/v1" }),
      fetchFn,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then implement preflight**

Run: `npx vitest run tests/preflight.test.ts` - expected FAIL (module missing).

`src/preflight.ts`:

```ts
import type { Configuration } from "./configuration";

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

interface OllamaTags {
  models?: Array<{ name: string }>;
}

/** Fail fast with actionable messages before starting a multi-minute research run. */
export async function preflightOllama(
  cfg: Configuration,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (cfg.llmProvider !== "ollama") return;
  let tags: OllamaTags;
  try {
    const res = await fetchFn(new URL("/api/tags", cfg.ollamaBaseUrl), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tags = (await res.json()) as OllamaTags;
  } catch {
    throw new PreflightError(
      `Cannot reach Ollama at ${cfg.ollamaBaseUrl}. Start it with \`ollama serve\` or set OLLAMA_BASE_URL.`,
    );
  }
  const names = (tags.models ?? []).map((m) => m.name);
  const found = names.some((n) => n === cfg.localLlm || n.split(":")[0] === cfg.localLlm);
  if (!found) {
    throw new PreflightError(
      `Model "${cfg.localLlm}" not found in Ollama. Pull it with: ollama pull ${cfg.localLlm}`,
    );
  }
}
```

Run: `npx vitest run tests/preflight.test.ts` - expected PASS.

- [ ] **Step 3: Write the failing CLI args test**

`tests/cli-args.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args";
import { ConfigurationError } from "../src/configuration";

describe("parseCliArgs", () => {
  it("parses a plain topic with defaults", () => {
    const cmd = parseCliArgs(["history of rocket engines"]);
    expect(cmd).toEqual({
      kind: "research",
      options: {
        topic: "history of rocket engines",
        configurable: {},
        output: undefined,
        json: false,
        quiet: false,
      },
    });
  });

  it("maps flags to configurable keys", () => {
    const cmd = parseCliArgs([
      "topic",
      "--max-loops",
      "5",
      "--model",
      "qwen3",
      "--search-api",
      "tavily",
      "--fetch-full-page",
      "--output",
      "report.md",
      "--json",
      "--quiet",
    ]);
    expect(cmd.kind).toBe("research");
    if (cmd.kind !== "research") return;
    expect(cmd.options.configurable).toEqual({
      maxWebResearchLoops: "5",
      localLlm: "qwen3",
      searchApi: "tavily",
      fetchFullPage: true,
    });
    expect(cmd.options.output).toBe("report.md");
    expect(cmd.options.json).toBe(true);
    expect(cmd.options.quiet).toBe(true);
  });

  it("routes provider and base-url", () => {
    const cmd = parseCliArgs(["t", "--provider", "openai_compatible", "--base-url", "http://x/v1"]);
    if (cmd.kind !== "research") throw new Error("expected research");
    expect(cmd.options.configurable.llmProvider).toBe("openai_compatible");
    expect(cmd.options.configurable.openaiCompatibleBaseUrl).toBe("http://x/v1");
    expect(cmd.options.configurable.ollamaBaseUrl).toBe("http://x/v1");
  });

  it("recognizes the mcp subcommand, help and version", () => {
    expect(parseCliArgs(["mcp"])).toEqual({ kind: "mcp" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("throws ConfigurationError when the topic is missing", () => {
    expect(() => parseCliArgs([])).toThrow(ConfigurationError);
    expect(() => parseCliArgs(["--json"])).toThrow(ConfigurationError);
  });
});
```

- [ ] **Step 4: Run test to verify it fails, then implement cli-args**

Run: `npx vitest run tests/cli-args.test.ts` - expected FAIL (module missing).

`src/cli-args.ts`:

```ts
import { parseArgs } from "node:util";
import { ConfigurationError } from "./configuration";

export interface CliOptions {
  topic: string;
  configurable: Record<string, unknown>;
  output?: string;
  json: boolean;
  quiet: boolean;
}

export type CliCommand =
  | { kind: "research"; options: CliOptions }
  | { kind: "mcp" }
  | { kind: "help" }
  | { kind: "version" };

export const HELP = `local-deep-researcher - fully local iterative web research (LangGraph.js)

Usage:
  local-deep-researcher "<topic>" [options]
  local-deep-researcher mcp                 Start the MCP stdio server

Options:
  --max-loops <n>        Research loops (default 3, env MAX_WEB_RESEARCH_LOOPS)
  --provider <name>      ollama | openai_compatible (default ollama)
  --model <name>         Model name (default llama3.2, env LOCAL_LLM)
  --base-url <url>       LLM base URL (Ollama or OpenAI-compatible endpoint)
  --search-api <name>    duckduckgo | tavily | perplexity | searxng (default duckduckgo)
  --fetch-full-page      Fetch full page content for each source
  -o, --output <file>    Write the report to a file instead of stdout
  --json                 Output {"summary", "sources"} JSON instead of markdown
  -q, --quiet            Suppress progress output on stderr
  -h, --help             Show this help
  -v, --version          Show version

Environment: TAVILY_API_KEY, PERPLEXITY_API_KEY, SEARXNG_URL, OLLAMA_BASE_URL,
OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY (also read from .env).`;

export function parseCliArgs(argv: string[]): CliCommand {
  if (argv[0] === "mcp") return { kind: "mcp" };
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "max-loops": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "search-api": { type: "string" },
      "fetch-full-page": { type: "boolean" },
      output: { type: "string", short: "o" },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const topic = positionals.join(" ").trim();
  if (!topic) {
    throw new ConfigurationError(
      'Missing research topic. Usage: local-deep-researcher "<topic>" [options]',
    );
  }
  const configurable: Record<string, unknown> = {};
  if (values["max-loops"] !== undefined) configurable.maxWebResearchLoops = values["max-loops"];
  if (values.provider !== undefined) configurable.llmProvider = values.provider;
  if (values.model !== undefined) configurable.localLlm = values.model;
  if (values["search-api"] !== undefined) configurable.searchApi = values["search-api"];
  if (values["fetch-full-page"] !== undefined)
    configurable.fetchFullPage = values["fetch-full-page"];
  if (values["base-url"] !== undefined) {
    configurable.ollamaBaseUrl = values["base-url"];
    configurable.openaiCompatibleBaseUrl = values["base-url"];
  }
  return {
    kind: "research",
    options: {
      topic,
      configurable,
      output: values.output,
      json: values.json ?? false,
      quiet: values.quiet ?? false,
    },
  };
}
```

Run: `npx vitest run tests/cli-args.test.ts` - expected PASS.

- [ ] **Step 5: Implement the CLI entry**

`src/cli.ts`:

```ts
#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { config as loadDotenv } from "dotenv";
import { HELP, parseCliArgs, type CliCommand } from "./cli-args";
import { ConfigurationError, ensureConfiguration, validateConfiguration } from "./configuration";
import { PreflightError, preflightOllama } from "./preflight";
import { research } from "./research";
import { runMcpServer } from "./mcp";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  loadDotenv({ quiet: true });

  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  if (command.kind === "help") {
    console.log(HELP);
    return 0;
  }
  if (command.kind === "version") {
    const require = createRequire(import.meta.url);
    console.log((require("../package.json") as { version: string }).version);
    return 0;
  }
  if (command.kind === "mcp") {
    await runMcpServer();
    return 0;
  }

  const { options } = command;
  let started = false;
  try {
    const cfg = ensureConfiguration({ configurable: options.configurable });
    validateConfiguration(cfg);
    await preflightOllama(cfg);
    started = true;
    const report = await research(options.topic, options.configurable, {
      onProgress: (event) => {
        if (!options.quiet) console.error(`[${event.phase}] loop ${event.loop}/${event.maxLoops}`);
      },
    });
    const output = options.json
      ? JSON.stringify({ summary: report.summary, sources: report.sources }, null, 2)
      : report.markdown;
    if (options.output) {
      writeFileSync(options.output, output + "\n");
      if (!options.quiet) console.error(`Report written to ${options.output}`);
    } else {
      console.log(output);
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof PreflightError) {
      console.error(`Error: ${(error as Error).message}`);
      return 1;
    }
    console.error(`Research failed: ${(error as Error).message}`);
    return started ? 2 : 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
```

**Task-10 dependency stub:** if Task 10 has not been implemented yet, create `src/mcp.ts` with this stub now (Task 10 replaces it):

```ts
export async function runMcpServer(): Promise<void> {
  throw new Error("MCP server not implemented yet");
}
```

- [ ] **Step 6: Add src/cli.ts to tsup entries**

Update `tsup.config.ts` `entry` to `["src/index.ts", "src/cli.ts"]` (final form shown in Task 1 Step 4).

- [ ] **Step 7: Verify build and manual smoke**

Run: `npm run typecheck && npm test && npm run build`
Expected: green; `dist/cli.js` exists and starts with `#!/usr/bin/env node`.

Run: `node dist/cli.js --help`
Expected: help text, exit code 0.

Run: `node dist/cli.js` (no topic)
Expected: "Missing research topic..." on stderr, exit code 1 (`echo $?`).

- [ ] **Step 8: Commit**

```bash
git add src/preflight.ts src/cli-args.ts src/cli.ts src/mcp.ts tsup.config.ts tests/preflight.test.ts tests/cli-args.test.ts
git commit -m "feat: CLI with Ollama preflight, stderr progress and exit codes"
```

---

### Task 10: MCP server

**Files:**

- Create/Replace: `src/mcp.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**

- Consumes: `research`, `ResearchReport` types (Task 8); `ensureConfiguration`, `validateConfiguration` (Task 2); `preflightOllama` (Task 9).
- Produces:
  - `interface McpDeps { researchFn?: typeof research; preflight?: (cfg: Configuration) => Promise<void> }`
  - `createMcpServer(deps?: McpDeps): McpServer` - registers the `deep_research` tool
  - `runMcpServer(): Promise<void>` - connects a `StdioServerTransport` (used by `cli.ts`)

- [ ] **Step 1: Write the failing test**

`tests/mcp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp";
import type { research } from "../src/research";

const fakeResearch = (async (topic: string) => ({
  summary: `Summary of ${topic}`,
  sources: [{ title: "A", url: "https://a.example" }],
  markdown: `## Summary\nSummary of ${topic}\n\n ### Sources:\n* A : https://a.example`,
})) as typeof research;

async function connectedClient(deps: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server", () => {
  it("lists the deep_research tool", async () => {
    const client = await connectedClient({ researchFn: fakeResearch, preflight: async () => {} });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("deep_research");
  });

  it("runs deep_research and returns the markdown report", async () => {
    const client = await connectedClient({ researchFn: fakeResearch, preflight: async () => {} });
    const result = await client.callTool({
      name: "deep_research",
      arguments: { topic: "quantum computing", max_loops: 1 },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBeFalsy();
    expect(content[0].text).toContain("## Summary");
    expect(content[0].text).toContain("quantum computing");
  });

  it("returns isError with a readable message instead of crashing", async () => {
    const failing = (async () => {
      throw new Error("Ollama exploded");
    }) as unknown as typeof research;
    const client = await connectedClient({ researchFn: failing, preflight: async () => {} });
    const result = await client.callTool({
      name: "deep_research",
      arguments: { topic: "anything" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0].text).toContain("Ollama exploded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL - `createMcpServer` is not exported (stub from Task 9 only has `runMcpServer`).

- [ ] **Step 3: Implement the MCP server (replace the Task 9 stub entirely)**

`src/mcp.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureConfiguration, validateConfiguration, type Configuration } from "./configuration";
import { preflightOllama } from "./preflight";
import { research } from "./research";

export interface McpDeps {
  researchFn?: typeof research;
  preflight?: (cfg: Configuration) => Promise<void>;
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const researchFn = deps.researchFn ?? research;
  const preflight = deps.preflight ?? preflightOllama;

  const server = new McpServer({ name: "local-deep-researcher", version: "0.1.0" });

  server.registerTool(
    "deep_research",
    {
      title: "Deep web research",
      description:
        "Run iterative local web research on a topic (search → summarize → reflect loop) and return a markdown report with sources. Uses a local LLM; may take several minutes.",
      inputSchema: {
        topic: z.string().describe("The research topic or question"),
        max_loops: z.number().int().min(0).optional().describe("Research loops (default 3)"),
        search_api: z.enum(["duckduckgo", "tavily", "perplexity", "searxng"]).optional(),
      },
    },
    async ({ topic, max_loops, search_api }, extra) => {
      const configurable: Record<string, unknown> = {};
      if (max_loops !== undefined) configurable.maxWebResearchLoops = max_loops;
      if (search_api !== undefined) configurable.searchApi = search_api;
      try {
        const cfg = ensureConfiguration({ configurable });
        validateConfiguration(cfg);
        await preflight(cfg);
        const progressToken = extra._meta?.progressToken;
        const report = await researchFn(topic, configurable, {
          onProgress: (event) => {
            if (progressToken === undefined) return;
            void extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: event.loop,
                total: cfg.maxWebResearchLoops + 1,
                message: event.phase,
              },
            });
          },
        });
        return { content: [{ type: "text", text: report.markdown }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `deep_research failed: ${(error as Error).message}` }],
        };
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, build, manual smoke, commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: green.

Manual smoke: `printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' | node dist/cli.js mcp | head -1`
Expected: one JSON-RPC `result` line containing `"local-deep-researcher"`.

```bash
git add src/mcp.ts tests/mcp.test.ts
git commit -m "feat: MCP stdio server exposing deep_research tool with progress notifications"
```

---

### Task 11: LangGraph Studio, docs, agent integration files

**Files:**

- Create: `langgraph.json`, `.env.example`, `LICENSE`, `README.md`, `.claude/agents/deep-researcher.md`

**Interfaces:**

- Consumes: `graph` export from `src/graph.ts` (Task 7); CLI/MCP usage patterns (Tasks 9–10).
- Produces: user-facing docs; no code consumed by later tasks.

- [ ] **Step 1: Create langgraph.json**

```json
{
  "node_version": "20",
  "dependencies": ["."],
  "graphs": {
    "local_deep_researcher": "./src/graph.ts:graph"
  },
  "env": ".env"
}
```

Verify: `npx @langchain/langgraph-cli dev --help` runs (do not start the full server in CI).

- [ ] **Step 2: Create .env.example**

```bash
# LLM
LLM_PROVIDER=ollama                # ollama | openai_compatible
LOCAL_LLM=llama3.2
OLLAMA_BASE_URL=http://localhost:11434
# OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1   # LMStudio / llama.cpp / vLLM / OpenRouter
# OPENAI_COMPATIBLE_API_KEY=

# Search
SEARCH_API=duckduckgo              # duckduckgo | tavily | perplexity | searxng
# TAVILY_API_KEY=
# PERPLEXITY_API_KEY=
# SEARXNG_URL=http://localhost:8888

# Research loop
MAX_WEB_RESEARCH_LOOPS=3
FETCH_FULL_PAGE=false
STRIP_THINKING_TOKENS=true
```

- [ ] **Step 3: Create LICENSE (MIT)**

```
MIT License

Copyright (c) 2026 devs30

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Create README.md**

Structure (write full prose in English; code blocks below are the exact commands to include):

1. **Title + one-liner**: JS/TS port of langchain-ai/local-deep-researcher; fully local web research with Ollama; link to the Python original.
2. **How it works**: the loop diagram (generate query → search → summarize → reflect → repeat → finalize), default 3 loops.
3. **Quickstart (CLI)**:
   ```bash
   ollama pull llama3.2
   npx @devs30/local-deep-researcher "history of liquid rocket engines"
   ```
   Flags table matching `src/cli-args.ts` HELP text.
4. **Use as a Claude Code subagent**: copy `.claude/agents/deep-researcher.md` into your project (content in Step 5) - Claude Code will delegate research tasks to it via the CLI.
5. **Use as an MCP server (Claude Code / Codex)**:
   ```bash
   claude mcp add deep-researcher -- npx -y @devs30/local-deep-researcher mcp
   ```
   For Codex (`~/.codex/config.toml`):
   ```toml
   [mcp_servers.deep-researcher]
   command = "npx"
   args = ["-y", "@devs30/local-deep-researcher", "mcp"]
   ```
6. **Library API**: `research()` example with progress hook and the `ResearchReport` shape.
7. **LangGraph Studio**: `npx @langchain/langgraph-cli dev` in the repo root.
8. **Configuration**: table of env vars/defaults from the spec (Task 2 ENV_KEYS).
9. **Search providers**: DuckDuckGo (default, no key), Tavily, Perplexity, SearXNG.
10. **License** MIT; credit to the LangChain original.

- [ ] **Step 5: Create .claude/agents/deep-researcher.md**

```markdown
---
name: deep-researcher
description: Runs deep, iterative web research on a topic using a fully local LLM (Ollama) and returns a markdown report with cited sources. Use when the user asks for in-depth research, a literature scan, or a sourced report on a topic.
tools: Bash
---

You are a deep-research subagent. Given a research topic:

1. Run: `npx -y @devs30/local-deep-researcher "<topic>" --quiet`
2. Return the markdown report EXACTLY as produced (it already contains `## Summary` and `### Sources:`). Do not rewrite or shorten it.
3. If the command fails with an Ollama error, tell the user to check that Ollama is running (`ollama serve`) and the model is pulled (`ollama pull llama3.2`), then stop.

Optional flags when the user asks for it: `--max-loops <n>` for deeper research, `--search-api tavily|perplexity|searxng` when API keys are configured.
```

- [ ] **Step 6: Commit**

```bash
git add langgraph.json .env.example LICENSE README.md .claude/agents/deep-researcher.md
git commit -m "docs: README, LangGraph Studio config, env example and Claude Code subagent"
```

---

### Task 12: CI, live smoke test, release workflow

**Files:**

- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `tests/live.test.ts`

**Interfaces:**

- Consumes: npm scripts from Task 1; `research` (Task 8).
- Produces: CI green on push; `npm publish` on version tags.

- [ ] **Step 1: Create the opt-in live smoke test**

`tests/live.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { research } from "../src/research";

// Opt-in: RUN_LIVE_TESTS=1 npx vitest run tests/live.test.ts
// Requires a running Ollama with llama3.2 pulled, and network access for DuckDuckGo.
describe.skipIf(process.env.RUN_LIVE_TESTS !== "1")("live smoke", () => {
  it("produces a real report with one research loop", async () => {
    const report = await research("What is LangGraph?", { maxWebResearchLoops: 0 });
    expect(report.markdown).toContain("## Summary");
    expect(report.sources.length).toBeGreaterThan(0);
  }, 300_000);
});
```

Run: `npm test` - expected: live suite reported as skipped, everything else green.

- [ ] **Step 2: Create .github/workflows/ci.yml**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 3: Create .github/workflows/release.yml**

```yaml
name: Release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: "https://registry.npmjs.org"
          cache: npm
      - run: npm ci
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Note for the maintainer (include in the PR/commit description): set the `NPM_TOKEN` secret in the GitHub repo before tagging `v0.1.0`.

- [ ] **Step 4: Final verification**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: everything green.

Optional end-to-end check (requires local Ollama): `RUN_LIVE_TESTS=1 npx vitest run tests/live.test.ts`

- [ ] **Step 5: Commit**

```bash
git add .github tests/live.test.ts
git commit -m "ci: GitHub Actions test matrix, npm release workflow and opt-in live smoke test"
```
