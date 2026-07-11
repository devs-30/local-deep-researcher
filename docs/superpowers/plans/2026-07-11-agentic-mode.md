# Agentic Mode (`agent` command) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agentic research mode (single LLM agent in a tool-calling loop with `web_search` + `fetch_page` + `take_note`, report written one-shot outside the loop), exposed as CLI subcommand `agent`, MCP tool `deep_research_agent`, library function `researchAgentic()`, and a second Studio graph.

**Architecture:** New parent StateGraph `START -> agentLoop -> finalizeReport -> END` in `src/agent.ts`. `agentLoop` runs a per-invocation `createAgent` (langchain v1) with three closure-scoped tools sharing a per-run context (notes, seen URLs, progress emitter); `finalizeReport` writes the report from notes with a plain LLM call and builds the `### Sources:` section deterministically. Existing workflow is untouched.

**Tech Stack:** TypeScript ESM, Node >= 20, LangGraph.js (`@langchain/langgraph` ^1), NEW dependency `langchain` ^1 (`createAgent`, `modelCallLimitMiddleware`), `@langchain/core` `tool()`, zod v3, vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-agentic-mode-design.md`

## Global Constraints

- Target version: 0.6.0 (set only in Task 9; do not bump earlier).
- New runtime dependency allowed: `langchain@^1` only. No `deepagents`.
- Zero behavior changes to the existing workflow (`buildGraph`, `research`, `deep_research` MCP tool, default CLI command).
- Zod import style used in this repo: `import { z } from "zod"`.
- NEVER use the em-dash character in any code, docs, or strings; use plain "-" (user rule).
- Every task ends with: `npm run typecheck && npm test` green, then `npm run format`, then commit (conventional message given per task). Do not tag, do not push, do not publish; the user releases himself.
- Config precedence everywhere: `config.configurable` > env > schema defaults (already implemented by `ensureConfiguration`).
- Prompts must instruct JSON-free plain text (agent tools use native tool calling, not jsonMode).

---

### Task 1: Configuration - `agentLlm` and `maxAgentSteps`

**Files:**

- Modify: `src/configuration.ts`
- Test: `tests/configuration.test.ts`

**Interfaces:**

- Consumes: existing `ConfigurationSchema`, `ENV_KEYS`.
- Produces: `Configuration.agentLlm?: string` (env `AGENT_LLM`), `Configuration.maxAgentSteps: number` (env `MAX_AGENT_STEPS`, default 20, int, min 1). Later tasks read `cfg.agentLlm ?? cfg.localLlm` and `cfg.maxAgentSteps`.

- [ ] **Step 1: Write failing tests** (append to `tests/configuration.test.ts`, follow the file's existing style):

```ts
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
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `npx vitest run tests/configuration.test.ts`
Expected: 4 new tests FAIL (unknown keys are stripped, so defaults/values are undefined).

- [ ] **Step 3: Implement** - in `src/configuration.ts` add to `ConfigurationSchema` (after `localLlm`):

```ts
  agentLlm: z.string().optional(),
  maxAgentSteps: z.coerce.number().int().min(1).default(20),
```

and to `ENV_KEYS`:

```ts
  agentLlm: "AGENT_LLM",
  maxAgentSteps: "MAX_AGENT_STEPS",
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/configuration.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Full check and commit**

Run: `npm run typecheck && npm test && npm run format`

```bash
git add src/configuration.ts tests/configuration.test.ts
git commit -m "feat: add agentLlm and maxAgentSteps configuration"
```

---

### Task 2: Prompts - `agentInstructions` and `reportWriterInstructions`

**Files:**

- Modify: `src/prompts.ts`
- Test: `tests/prompts.test.ts`

**Interfaces:**

- Consumes: existing `getCurrentDate()` export in `src/prompts.ts`.
- Produces:
  - `agentInstructions(params: { researchTopic: string; currentDate: string; maxAgentSteps: number }): string`
  - `reportWriterInstructions: string` (constant)

- [ ] **Step 1: Write failing tests** (append to `tests/prompts.test.ts`):

```ts
describe("agentInstructions", () => {
  it("embeds topic, date and step budget", () => {
    const text = prompts.agentInstructions({
      researchTopic: "quantum computing",
      currentDate: "January 1, 2026",
      maxAgentSteps: 12,
    });
    expect(text).toContain("quantum computing");
    expect(text).toContain("January 1, 2026");
    expect(text).toContain("12");
    expect(text).toContain("web_search");
    expect(text).toContain("fetch_page");
    expect(text).toContain("take_note");
  });
});

describe("reportWriterInstructions", () => {
  it("asks for a report without a sources section", () => {
    expect(prompts.reportWriterInstructions).toContain("report");
    expect(prompts.reportWriterInstructions.toLowerCase()).toContain("do not");
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL with "agentInstructions is not a function".

- [ ] **Step 3: Implement** - append to `src/prompts.ts`:

```ts
export const agentInstructions = (params: {
  researchTopic: string;
  currentDate: string;
  maxAgentSteps: number;
}) => `You are a web research agent. The current date is ${params.currentDate}.

Your task is to research this topic thoroughly:
<TOPIC>
${params.researchTopic}
</TOPIC>

You have three tools:
- web_search(query): search the web. Returns titles, URLs and content excerpts.
- fetch_page(url): fetch the full content of one page when an excerpt is not enough.
- take_note(note, source_url, source_title): record ONE distinct finding with its source.

Rules:
1. Start with a web_search using a focused query (not the topic verbatim if it is broad).
2. After each search, record every relevant finding with take_note before searching again.
3. Use fetch_page only when an excerpt looks promising but is too shallow.
4. Prefer several precise searches over one broad one. Avoid repeating similar queries.
5. You have a budget of at most ${params.maxAgentSteps} thinking steps. Plan accordingly.
6. When your notes cover the topic (aim for 5-10 solid notes), respond with a short
   plain-text confirmation and STOP calling tools. Do not write the report yourself.`;

export const reportWriterInstructions = `Write a well-structured research report in markdown based ONLY on the provided notes.

Requirements:
- Start directly with the content (no title, no preamble).
- Organize related findings into coherent paragraphs; do not enumerate the notes one by one.
- Keep every factual claim traceable to the notes; do not invent facts.
- Do NOT include a sources or references section; sources are appended separately.`;
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run typecheck && npm test && npm run format`

```bash
git add src/prompts.ts tests/prompts.test.ts
git commit -m "feat: add agent loop and report writer prompts"
```

---

### Task 3: Agent tools (`web_search`, `fetch_page`, `take_note`)

**Files:**

- Create: `src/agent-tools.ts`
- Test: `tests/agent-tools.test.ts`

**Interfaces:**

- Consumes: `searchWithRetry` (`src/search/index.ts`), `applyHeuristics`, `parseBlocklist` (`src/grade.ts`), `fetchRawContent(url, timeoutMs?)` (`src/search/fetch.ts`), `Configuration`, `SearchProvider`, `SearchResult`.
- Produces (used by Task 5 and later):

```ts
export interface AgentNote {
  note: string;
  sourceUrl: string;
  sourceTitle?: string;
}
export type AgentToolPhase = "searching" | "fetching" | "noting";
export interface AgentToolsContext {
  cfg: Configuration;
  provider: SearchProvider;
  retryDelayMs: number;
  seenUrls: Set<string>;
  notes: AgentNote[];
  warn: (message: string) => void;
  onToolEvent?: (phase: AgentToolPhase) => void;
  fetchPage?: typeof fetchRawContent; // test seam, defaults to fetchRawContent
}
export function createAgentTools(ctx: AgentToolsContext): StructuredToolInterface[];
```

- [ ] **Step 1: Write failing tests** - create `tests/agent-tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createAgentTools, type AgentToolsContext } from "../src/agent-tools";
import { ensureConfiguration } from "../src/configuration";
import type { SearchResult } from "../src/search/types";

function makeCtx(overrides: Partial<AgentToolsContext> = {}): AgentToolsContext {
  return {
    cfg: ensureConfiguration({ configurable: { sourceDomainBlocklist: "spam.example" } }),
    provider: vi.fn(async (): Promise<SearchResult[]> => [
      { title: "Good", url: "https://good.example/a", content: "useful content ".repeat(30) },
      { title: "Spam", url: "https://spam.example/x", content: "junk ".repeat(30) },
    ]),
    retryDelayMs: 0,
    seenUrls: new Set(),
    notes: [],
    warn: vi.fn(),
    ...overrides,
  };
}

function getTool(ctx: AgentToolsContext, name: string) {
  const found = createAgentTools(ctx).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe("web_search tool", () => {
  it("returns formatted results, applies blocklist and records seen urls", async () => {
    const ctx = makeCtx();
    const events: string[] = [];
    ctx.onToolEvent = (phase) => events.push(phase);
    const out = (await getTool(ctx, "web_search").invoke({ query: "test" })) as string;
    expect(out).toContain("https://good.example/a");
    expect(out).not.toContain("spam.example");
    expect(ctx.seenUrls.has("https://good.example/a")).toBe(true);
    expect(events).toEqual(["searching"]);
  });

  it("dedups already-seen urls and reports no new results", async () => {
    const ctx = makeCtx({
      seenUrls: new Set(["https://good.example/a", "https://spam.example/x"]),
    });
    const out = (await getTool(ctx, "web_search").invoke({ query: "test" })) as string;
    expect(out).toContain("No new relevant results");
  });

  it("returns an error string instead of throwing when search fails", async () => {
    const ctx = makeCtx({ provider: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const out = (await getTool(ctx, "web_search").invoke({ query: "test" })) as string;
    expect(out).toContain("Search failed");
    expect(out).toContain("boom");
  });
});

describe("fetch_page tool", () => {
  it("returns page content truncated and emits fetching", async () => {
    const ctx = makeCtx({ fetchPage: vi.fn(async () => "x".repeat(20_000)) });
    const events: string[] = [];
    ctx.onToolEvent = (phase) => events.push(phase);
    const out = (await getTool(ctx, "fetch_page").invoke({
      url: "https://good.example/a",
    })) as string;
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(events).toEqual(["fetching"]);
  });

  it("returns an actionable message when fetch fails", async () => {
    const ctx = makeCtx({ fetchPage: vi.fn(async () => undefined) });
    const out = (await getTool(ctx, "fetch_page").invoke({ url: "https://bad.example" })) as string;
    expect(out).toContain("Could not fetch");
  });
});

describe("take_note tool", () => {
  it("accumulates notes and confirms with a count", async () => {
    const ctx = makeCtx();
    const events: string[] = [];
    ctx.onToolEvent = (phase) => events.push(phase);
    const out = (await getTool(ctx, "take_note").invoke({
      note: "Finding A",
      source_url: "https://good.example/a",
      source_title: "Good",
    })) as string;
    expect(ctx.notes).toEqual([
      { note: "Finding A", sourceUrl: "https://good.example/a", sourceTitle: "Good" },
    ]);
    expect(out).toContain("1");
    expect(events).toEqual(["noting"]);
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npx vitest run tests/agent-tools.test.ts`
Expected: FAIL with "Cannot find module '../src/agent-tools'".

- [ ] **Step 3: Implement** - create `src/agent-tools.ts`:

```ts
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { Configuration } from "./configuration";
import { applyHeuristics, parseBlocklist } from "./grade";
import { fetchRawContent } from "./search/fetch";
import { searchWithRetry } from "./search/index";
import type { SearchProvider, SearchResult } from "./search/types";

export interface AgentNote {
  note: string;
  sourceUrl: string;
  sourceTitle?: string;
}

export type AgentToolPhase = "searching" | "fetching" | "noting";

export interface AgentToolsContext {
  cfg: Configuration;
  provider: SearchProvider;
  retryDelayMs: number;
  seenUrls: Set<string>;
  notes: AgentNote[];
  warn: (message: string) => void;
  onToolEvent?: (phase: AgentToolPhase) => void;
  /** Test seam; defaults to fetchRawContent. */
  fetchPage?: typeof fetchRawContent;
}

// Same per-source budget as the workflow (MAX_TOKENS_PER_SOURCE * 4 chars).
const MAX_EXCERPT_CHARS = 4000;
const MAX_PAGE_CHARS = 8000;

export function createAgentTools(ctx: AgentToolsContext): StructuredToolInterface[] {
  const fetchPage = ctx.fetchPage ?? fetchRawContent;

  const webSearch = tool(
    async ({ query }: { query: string }) => {
      ctx.onToolEvent?.("searching");
      let results: SearchResult[];
      try {
        results = await searchWithRetry(
          ctx.provider,
          query,
          {
            maxResults: ctx.cfg.searchApi === "tavily" ? 1 : 3,
            fetchFullPage: ctx.cfg.fetchFullPage,
            loopCount: 0,
            config: ctx.cfg,
          },
          ctx.retryDelayMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.warn(`web_search failed: ${message}`);
        return `Search failed: ${message}. Try a different, simpler query.`;
      }
      const { kept, dropped } = applyHeuristics(results, {
        blocklist: parseBlocklist(ctx.cfg.sourceDomainBlocklist),
        fetchFullPage: ctx.cfg.fetchFullPage,
        gradedUrls: ctx.seenUrls,
      });
      for (const { result, reason } of dropped) {
        ctx.warn(`web_search: dropped ${result.url} (${reason})`);
      }
      for (const r of results) ctx.seenUrls.add(r.url);
      if (kept.length === 0) return "No new relevant results. Try a different query.";
      return kept
        .map(
          (r) =>
            `Title: ${r.title}\nURL: ${r.url}\nContent: ${(r.rawContent?.trim() || r.content).slice(0, MAX_EXCERPT_CHARS)}`,
        )
        .join("\n\n---\n\n");
    },
    {
      name: "web_search",
      description:
        "Search the web. Returns titles, URLs and content excerpts. Low-quality and already-seen results are filtered out.",
      schema: z.object({ query: z.string().describe("The search query") }),
    },
  );

  const fetchPageTool = tool(
    async ({ url }: { url: string }) => {
      ctx.onToolEvent?.("fetching");
      const content = await fetchPage(url);
      if (!content) {
        return `Could not fetch ${url}. Use the search excerpt instead or try another source.`;
      }
      return content.slice(0, MAX_PAGE_CHARS);
    },
    {
      name: "fetch_page",
      description:
        "Fetch the full content of one web page as markdown. Use only when a search excerpt is not enough.",
      schema: z.object({ url: z.string().describe("URL from a web_search result") }),
    },
  );

  const takeNote = tool(
    async ({
      note,
      source_url,
      source_title,
    }: {
      note: string;
      source_url: string;
      source_title?: string;
    }) => {
      ctx.onToolEvent?.("noting");
      ctx.notes.push({ note, sourceUrl: source_url, sourceTitle: source_title });
      return `Noted (${ctx.notes.length} notes so far).`;
    },
    {
      name: "take_note",
      description: "Record ONE distinct research finding with its source. Call once per finding.",
      schema: z.object({
        note: z.string().describe("The finding, 1-3 sentences"),
        source_url: z.string().describe("URL supporting the finding"),
        source_title: z.string().optional().describe("Title of the source"),
      }),
    },
  );

  return [webSearch, fetchPageTool, takeNote];
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/agent-tools.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full check and commit**

Run: `npm run typecheck && npm test && npm run format`

```bash
git add src/agent-tools.ts tests/agent-tools.test.ts
git commit -m "feat: add agent tools (web_search, fetch_page, take_note)"
```

---

### Task 4: Preflight - agent model tool-calling capability check

**Files:**

- Modify: `src/preflight.ts`
- Test: `tests/preflight.test.ts`

**Interfaces:**

- Consumes: `Configuration` (incl. `agentLlm` from Task 1), existing `PreflightError`.
- Produces: `preflightAgentModel(cfg: Configuration, fetchFn?: typeof fetch): Promise<void>` - throws `PreflightError` when the agent model does not declare the Ollama `tools` capability; fails open when capabilities are not reported (older Ollama); no-op for `openai_compatible`.

- [ ] **Step 1: Write failing tests** (append to `tests/preflight.test.ts`, mirroring the file's existing fetch-mock style):

```ts
describe("preflightAgentModel", () => {
  const cfg = ensureConfiguration({ configurable: { agentLlm: "qwen3" } });

  function showResponse(body: unknown, ok = true): typeof fetch {
    return vi.fn(
      async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response,
    ) as unknown as typeof fetch;
  }

  it("passes when the model declares the tools capability", async () => {
    await expect(
      preflightAgentModel(cfg, showResponse({ capabilities: ["completion", "tools"] })),
    ).resolves.toBeUndefined();
  });

  it("throws when the model lacks the tools capability", async () => {
    await expect(
      preflightAgentModel(cfg, showResponse({ capabilities: ["completion"] })),
    ).rejects.toThrow(/does not support tool calling/);
  });

  it("fails open when capabilities are not reported", async () => {
    await expect(preflightAgentModel(cfg, showResponse({}))).resolves.toBeUndefined();
  });

  it("throws a reachability error when /api/show fails", async () => {
    await expect(preflightAgentModel(cfg, showResponse({}, false))).rejects.toThrow(
      /Cannot inspect model/,
    );
  });

  it("is a no-op for openai_compatible", async () => {
    const compat = ensureConfiguration({
      configurable: { llmProvider: "openai_compatible", openaiCompatibleBaseUrl: "http://x" },
    });
    const fetchFn = vi.fn();
    await expect(
      preflightAgentModel(compat, fetchFn as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npx vitest run tests/preflight.test.ts`
Expected: FAIL with "preflightAgentModel is not a function" (add the import to the test file's existing import line).

- [ ] **Step 3: Implement** - append to `src/preflight.ts`:

```ts
interface OllamaShow {
  capabilities?: string[];
}

/**
 * Agentic mode requires native tool calling. Ollama >= 0.6 reports capabilities
 * via POST /api/show; older versions do not, in which case we fail open.
 */
export async function preflightAgentModel(
  cfg: Configuration,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (cfg.llmProvider !== "ollama") return;
  const model = cfg.agentLlm ?? cfg.localLlm;
  let show: OllamaShow;
  try {
    const res = await fetchFn(new URL("/api/show", cfg.ollamaBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    show = (await res.json()) as OllamaShow;
  } catch {
    throw new PreflightError(
      `Cannot inspect model "${model}" in Ollama at ${cfg.ollamaBaseUrl}. Pull it with: ollama pull ${model}`,
    );
  }
  if (show.capabilities && !show.capabilities.includes("tools")) {
    throw new PreflightError(
      `Model "${model}" does not support tool calling. Set --agent-model (env AGENT_LLM) to a tool-calling model, e.g. qwen3.`,
    );
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/preflight.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run typecheck && npm test && npm run format`

```bash
git add src/preflight.ts tests/preflight.test.ts
git commit -m "feat: preflight tool-calling capability check for agent model"
```

---

### Task 5: Agentic graph (`agentLoop` + `finalizeReport`)

**Files:**

- Modify: `package.json` (add dependency), `src/state.ts`
- Create: `src/agent.ts`
- Test: `tests/agent-graph.test.ts`

**Interfaces:**

- Consumes: `createAgentTools`, `AgentNote`, `AgentToolPhase`, `AgentToolsContext` (Task 3); `agentInstructions`, `reportWriterInstructions`, `getCurrentDate` (Task 2); `cfg.agentLlm`, `cfg.maxAgentSteps` (Task 1); `GraphDeps`, `getLlm`, `contentToString`, `stripThinkingTokens`, `getSearchProvider`.
- Produces:

```ts
// src/state.ts
export const AgenticStateAnnotation; // researchTopic, notes (concat reducer), stepsUsed, runningSummary
export type AgenticState = typeof AgenticStateAnnotation.State;
// src/agent.ts
export class AgentResearchError extends Error {}
export interface AgenticGraphDeps extends GraphDeps {
  onToolEvent?: (phase: AgentToolPhase) => void;
}
export function buildAgenticGraph(overrides?: Partial<AgenticGraphDeps>); // compiled graph
export const agenticGraph; // default compiled graph for Studio
```

- [ ] **Step 1: Install the langchain dependency**

Run: `npm install langchain@^1`
Expected: `package.json` gains `"langchain": "^1.x"`; `npm run typecheck` still green.

- [ ] **Step 2: Add `AgenticStateAnnotation`** - append to `src/state.ts`:

```ts
import type { AgentNote } from "./agent-tools";

export const AgenticStateAnnotation = Annotation.Root({
  researchTopic: Annotation<string>(),
  notes: Annotation<AgentNote[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  stepsUsed: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  runningSummary: Annotation<string>(),
});

export type AgenticState = typeof AgenticStateAnnotation.State;
```

(Merge the `import type` line with existing imports at the top of the file.)

- [ ] **Step 3: Write failing tests** - create `tests/agent-graph.test.ts`. The fake model is the critical piece: it extends `BaseChatModel`, returns queued `AIMessage`s, and `bindTools` returns itself.

```ts
import { describe, expect, it, vi } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { AgentResearchError, buildAgenticGraph } from "../src/agent";
import type { SearchResult } from "../src/search/types";

class FakeToolCallingModel extends BaseChatModel {
  private queue: AIMessage[];
  constructor(queue: AIMessage[]) {
    super({});
    this.queue = [...queue];
  }
  _llmType(): string {
    return "fake-tool-calling";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.queue.shift() ?? new AIMessage("Research complete.");
    return { generations: [{ message, text: "" }] };
  }
}

const searchCall = (id: string, query: string) =>
  new AIMessage({
    content: "",
    tool_calls: [{ id, name: "web_search", args: { query } }],
  });
const noteCall = (id: string, note: string, url: string, title: string) =>
  new AIMessage({
    content: "",
    tool_calls: [{ id, name: "take_note", args: { note, source_url: url, source_title: title } }],
  });

const provider = vi.fn(async (): Promise<SearchResult[]> => [
  { title: "Alpha", url: "https://alpha.example/1", content: "alpha content ".repeat(30) },
]);

function deps(agentModel: FakeToolCallingModel, writerText = "Report body.") {
  const writer = new FakeToolCallingModel([new AIMessage(writerText)]);
  return {
    // agentLoop asks for cfg.agentLlm ?? cfg.localLlm; finalizeReport for cfg.localLlm.
    // We route on the model name that agentLoop overrides into cfg.localLlm.
    getLlm: vi.fn((cfg: { localLlm: string }) =>
      cfg.localLlm === "fake-agent" ? agentModel : writer,
    ),
    getSearchProvider: () => provider,
    retryDelayMs: 0,
    warn: vi.fn(),
  };
}

const CONFIG = { configurable: { agentLlm: "fake-agent", localLlm: "fake-writer" } };

describe("agentic graph", () => {
  it("runs search -> note -> stop and produces a report with sources", async () => {
    const model = new FakeToolCallingModel([
      searchCall("c1", "alpha"),
      noteCall("c2", "Alpha does X", "https://alpha.example/1", "Alpha"),
      noteCall("c3", "Alpha also does Y", "https://alpha.example/1", "Alpha"),
      new AIMessage("Done researching."),
    ]);
    const graph = buildAgenticGraph(deps(model));
    const result = await graph.invoke({ researchTopic: "alpha systems" }, CONFIG);
    expect(result.notes).toHaveLength(2);
    expect(result.runningSummary).toContain("## Summary");
    expect(result.runningSummary).toContain("Report body.");
    expect(result.runningSummary).toContain("### Sources:");
    // Sources are deduplicated by URL.
    expect(result.runningSummary.match(/alpha\.example/g)).toHaveLength(1);
  });

  it("stops at maxAgentSteps and still finalizes with gathered notes", async () => {
    // Model always wants another search; middleware must cut it off.
    const endless = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? searchCall(`s${i}`, `query ${i}`)
        : noteCall(`n${i}`, `Fact ${i}`, `https://alpha.example/${i}`, "Alpha"),
    );
    const model = new FakeToolCallingModel(endless);
    const d = deps(model);
    const graph = buildAgenticGraph(d);
    const result = await graph.invoke(
      { researchTopic: "alpha systems" },
      { configurable: { ...CONFIG.configurable, maxAgentSteps: 3 } },
    );
    expect(result.stepsUsed).toBeLessThanOrEqual(3);
    expect(result.runningSummary).toContain("## Summary");
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining("maxAgentSteps"));
  });

  it("throws AgentResearchError when the loop ends with zero notes", async () => {
    const model = new FakeToolCallingModel([new AIMessage("Nothing to do.")]);
    const graph = buildAgenticGraph(deps(model));
    await expect(graph.invoke({ researchTopic: "alpha systems" }, CONFIG)).rejects.toThrow(
      AgentResearchError,
    );
  });

  it("emits tool events through deps.onToolEvent", async () => {
    const events: string[] = [];
    const model = new FakeToolCallingModel([
      searchCall("c1", "alpha"),
      noteCall("c2", "Alpha does X", "https://alpha.example/1", "Alpha"),
      new AIMessage("Done."),
    ]);
    const graph = buildAgenticGraph({ ...deps(model), onToolEvent: (p) => events.push(p) });
    await graph.invoke({ researchTopic: "alpha systems" }, CONFIG);
    expect(events).toEqual(["searching", "noting"]);
  });
});
```

- [ ] **Step 4: Run tests, verify fail**

Run: `npx vitest run tests/agent-graph.test.ts`
Expected: FAIL with "Cannot find module '../src/agent'".

- [ ] **Step 5: Implement** - create `src/agent.ts`:

```ts
import { END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createAgent, modelCallLimitMiddleware } from "langchain";
import { createAgentTools, type AgentToolPhase, type AgentToolsContext } from "./agent-tools";
import { ensureConfiguration } from "./configuration";
import type { GraphDeps } from "./graph";
import { contentToString, getLlm as defaultGetLlm, stripThinkingTokens } from "./llm";
import * as prompts from "./prompts";
import { getSearchProvider as defaultGetSearchProvider } from "./search/index";
import { AgenticStateAnnotation, type AgenticState } from "./state";

export class AgentResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentResearchError";
  }
}

export interface AgenticGraphDeps extends GraphDeps {
  onToolEvent?: (phase: AgentToolPhase) => void;
}

export function buildAgenticGraph(overrides: Partial<AgenticGraphDeps> = {}) {
  const deps: AgenticGraphDeps = {
    getLlm: defaultGetLlm,
    getSearchProvider: defaultGetSearchProvider,
    retryDelayMs: 1000,
    warn: (message) => console.error(message),
    ...overrides,
  };

  async function agentLoop(state: AgenticState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    // The agent model may differ from the workflow model (tool calling required).
    const model = deps.getLlm({ ...cfg, localLlm: cfg.agentLlm ?? cfg.localLlm });
    const ctx: AgentToolsContext = {
      cfg,
      provider: deps.getSearchProvider(cfg.searchApi),
      retryDelayMs: deps.retryDelayMs,
      seenUrls: new Set(),
      notes: [],
      warn: deps.warn,
      onToolEvent: deps.onToolEvent,
    };
    const agent = createAgent({
      model,
      tools: createAgentTools(ctx),
      systemPrompt: prompts.agentInstructions({
        researchTopic: state.researchTopic,
        currentDate: prompts.getCurrentDate(),
        maxAgentSteps: cfg.maxAgentSteps,
      }),
      middleware: [modelCallLimitMiddleware({ runLimit: cfg.maxAgentSteps, exitBehavior: "end" })],
    });
    const result = await agent.invoke(
      { messages: [new HumanMessage(`Research this topic: ${state.researchTopic}`)] },
      { recursionLimit: cfg.maxAgentSteps * 2 + 10 },
    );
    const stepsUsed = (result.messages as BaseMessage[]).filter((m) => m.getType() === "ai").length;
    if (stepsUsed >= cfg.maxAgentSteps) {
      deps.warn(
        `agentLoop: reached maxAgentSteps=${cfg.maxAgentSteps}, finalizing with ${ctx.notes.length} notes`,
      );
    }
    return { notes: ctx.notes, stepsUsed };
  }

  async function finalizeReport(state: AgenticState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    if (state.notes.length === 0) {
      throw new AgentResearchError(
        "Agent finished without gathering any findings. Try a larger --max-steps or a different --agent-model.",
      );
    }
    const llm = deps.getLlm(cfg);
    const notesBlock = state.notes
      .map((n, i) => `${i + 1}. ${n.note} (source: ${n.sourceUrl})`)
      .join("\n");
    const result = await llm.invoke([
      new SystemMessage(prompts.reportWriterInstructions),
      new HumanMessage(
        `<Notes>\n${notesBlock}\n</Notes>\n\nWrite a research report on this topic: \n<User Input>\n${state.researchTopic}\n</User Input>\n\n`,
      ),
    ]);
    let summary = contentToString(result.content);
    if (cfg.stripThinkingTokens) summary = stripThinkingTokens(summary);
    const seen = new Set<string>();
    const sourceLines: string[] = [];
    for (const n of state.notes) {
      if (!seen.has(n.sourceUrl)) {
        seen.add(n.sourceUrl);
        sourceLines.push(`* ${n.sourceTitle ?? n.sourceUrl} : ${n.sourceUrl}`);
      }
    }
    return {
      runningSummary: `## Summary\n${summary}\n\n### Sources:\n${sourceLines.join("\n")}`,
    };
  }

  return new StateGraph(AgenticStateAnnotation)
    .addNode("agentLoop", agentLoop)
    .addNode("finalizeReport", finalizeReport)
    .addEdge(START, "agentLoop")
    .addEdge("agentLoop", "finalizeReport")
    .addEdge("finalizeReport", END)
    .compile();
}

/** Default compiled agentic graph - entry point for LangGraph Studio (langgraph.json). */
export const agenticGraph = buildAgenticGraph();
```

- [ ] **Step 6: Run tests, verify pass**

Run: `npx vitest run tests/agent-graph.test.ts`
Expected: PASS (4 tests). If `modelCallLimitMiddleware` counts differently than assumed, adjust only the `stepsUsed` assertion bound, not the middleware config.

- [ ] **Step 7: Full check and commit**

Run: `npm run typecheck && npm test && npm run format`

```bash
git add package.json package-lock.json src/state.ts src/agent.ts tests/agent-graph.test.ts
git commit -m "feat: agentic graph with createAgent tool loop and one-shot report"
```

---

### Task 6: `researchAgentic()` + progress extension + library exports

**Files:**

- Modify: `src/research.ts`, `src/index.ts`
- Test: `tests/research.test.ts`

**Interfaces:**

- Consumes: `buildAgenticGraph`, `AgenticGraphDeps`, `AgentResearchError` (Task 5); `AgentNote`, `AgentToolPhase` (Task 3).
- Produces:
  - `ResearchPhase` extended with `"fetching" | "noting"`.
  - `ProgressEvent` gains optional `step?: number; maxSteps?: number` (existing fields unchanged; for agentic events `loop` mirrors `step` and `maxLoops` mirrors `maxSteps` so existing renderers keep working).
  - `researchAgentic(topic: string, options?: Partial<Configuration>, hooks?: ResearchHooks, deps?: Partial<AgenticGraphDeps>): Promise<ResearchReport>`
  - `src/index.ts` re-exports: `researchAgentic`, `buildAgenticGraph`, `agenticGraph`, `AgentResearchError`, types `AgenticGraphDeps`, `AgentNote`, `AgentToolPhase`, `AgenticState`, `AgenticStateAnnotation`.

- [ ] **Step 1: Write failing tests** (append to `tests/research.test.ts`; reuse the `FakeToolCallingModel` pattern from `tests/agent-graph.test.ts` - duplicate the small class locally, do not import across test files):

```ts
describe("researchAgentic", () => {
  it("returns a ResearchReport with parsed sources and emits step progress", async () => {
    const model = new FakeToolCallingModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "web_search", args: { query: "alpha" } }],
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "c2",
            name: "take_note",
            args: {
              note: "Alpha does X",
              source_url: "https://alpha.example/1",
              source_title: "Alpha",
            },
          },
        ],
      }),
      new AIMessage("Done."),
    ]);
    const writer = new FakeToolCallingModel([new AIMessage("Agentic report body.")]);
    const events: Array<{ phase: string; step?: number }> = [];
    const report = await researchAgentic(
      "alpha systems",
      { agentLlm: "fake-agent", localLlm: "fake-writer", maxAgentSteps: 5 },
      { onProgress: (e) => events.push({ phase: e.phase, step: e.step }) },
      {
        getLlm: (cfg) => (cfg.localLlm === "fake-agent" ? model : writer),
        getSearchProvider: () => async () => [
          { title: "Alpha", url: "https://alpha.example/1", content: "alpha ".repeat(50) },
        ],
        retryDelayMs: 0,
        warn: () => {},
      },
    );
    expect(report.markdown).toContain("## Summary");
    expect(report.markdown).toContain("Agentic report body.");
    expect(report.summary).toContain("Agentic report body.");
    expect(report.sources).toEqual([{ title: "Alpha", url: "https://alpha.example/1" }]);
    expect(events.map((e) => e.phase)).toEqual(["searching", "noting", "finalizing"]);
    expect(events[0].step).toBe(1);
  });

  it("rejects an empty topic", async () => {
    await expect(researchAgentic("  ")).rejects.toThrow(ConfigurationError);
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npx vitest run tests/research.test.ts`
Expected: new tests FAIL ("researchAgentic is not a function").

- [ ] **Step 3: Implement** - in `src/research.ts`:

Extend the types:

```ts
export type ResearchPhase =
  | "generating_query"
  | "searching"
  | "grading"
  | "summarizing"
  | "reflecting"
  | "finalizing"
  | "fetching"
  | "noting";

export interface ProgressEvent {
  phase: ResearchPhase;
  loop: number;
  maxLoops: number;
  /** Agentic mode only: model-step counter (mirrors loop/maxLoops). */
  step?: number;
  maxSteps?: number;
}
```

Add (new imports: `buildAgenticGraph`, `type AgenticGraphDeps` from `./agent`, `type AgentNote` from `./agent-tools`):

```ts
export async function researchAgentic(
  topic: string,
  options: Partial<Configuration> = {},
  hooks: ResearchHooks = {},
  deps: Partial<AgenticGraphDeps> = {},
): Promise<ResearchReport> {
  if (!topic.trim()) throw new ConfigurationError("Research topic must not be empty");
  const cfg = ensureConfiguration({ configurable: options });
  validateConfiguration(cfg);

  let step = 0;
  const emit = (phase: ResearchPhase) =>
    hooks.onProgress?.({
      phase,
      loop: step,
      maxLoops: cfg.maxAgentSteps,
      step,
      maxSteps: cfg.maxAgentSteps,
    });

  const graph = buildAgenticGraph({
    ...deps,
    onToolEvent: (phase) => {
      if (phase === "searching") step += 1;
      emit(phase);
      deps.onToolEvent?.(phase);
    },
  });

  const stream = await graph.stream(
    { researchTopic: topic },
    {
      configurable: options,
      streamMode: "updates",
      recursionLimit: 10 + cfg.maxAgentSteps * 3,
    },
  );

  let markdown = "";
  let notes: AgentNote[] = [];
  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk as Record<string, Record<string, unknown>>)) {
      if (node === "agentLoop") {
        notes = (update.notes as AgentNote[] | undefined) ?? [];
        emit("finalizing");
      }
      if (node === "finalizeReport") markdown = String(update.runningSummary ?? markdown);
    }
  }

  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const n of notes) {
    if (!seen.has(n.sourceUrl)) {
      seen.add(n.sourceUrl);
      sources.push({ title: n.sourceTitle ?? n.sourceUrl, url: n.sourceUrl });
    }
  }
  const summary = markdown.replace(/^## Summary\n/, "").split("\n\n### Sources:")[0] ?? markdown;
  return { summary, sources, markdown };
}
```

Update `src/index.ts` exports:

```ts
export {
  AgentResearchError,
  agenticGraph,
  buildAgenticGraph,
  type AgenticGraphDeps,
} from "./agent";
export { type AgentNote, type AgentToolPhase } from "./agent-tools";
export { AgenticStateAnnotation, type AgenticState } from "./state";
// and add researchAgentic to the existing ./research export list
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/research.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run typecheck && npm test && npm run format`

```bash
git add src/research.ts src/index.ts tests/research.test.ts
git commit -m "feat: researchAgentic library entry point with step progress"
```

---

### Task 7: CLI subcommand `agent`

**Files:**

- Modify: `src/cli-args.ts`, `src/cli.ts`
- Test: `tests/cli-args.test.ts`

**Interfaces:**

- Consumes: `researchAgentic` (Task 6), `preflightAgentModel` (Task 4).
- Produces: `CliCommand` union gains `{ kind: "agent"; options: CliOptions }`; new flags `--max-steps <n>` -> `configurable.maxAgentSteps`, `--agent-model <name>` -> `configurable.agentLlm`.

- [ ] **Step 1: Write failing tests** (append to `tests/cli-args.test.ts`):

```ts
describe("agent subcommand", () => {
  it("parses agent with topic and agent flags", () => {
    const cmd = parseCliArgs([
      "agent",
      "quantum computing",
      "--max-steps",
      "10",
      "--agent-model",
      "qwen3",
    ]);
    expect(cmd.kind).toBe("agent");
    if (cmd.kind !== "agent") return;
    expect(cmd.options.topic).toBe("quantum computing");
    expect(cmd.options.configurable.maxAgentSteps).toBe(10);
    expect(cmd.options.configurable.agentLlm).toBe("qwen3");
  });

  it("supports shared options in agent mode", () => {
    const cmd = parseCliArgs(["agent", "topic", "--search-api", "searxng", "--json", "-q"]);
    if (cmd.kind !== "agent") throw new Error("expected agent");
    expect(cmd.options.configurable.searchApi).toBe("searxng");
    expect(cmd.options.json).toBe(true);
    expect(cmd.options.quiet).toBe(true);
  });

  it("requires a topic in agent mode", () => {
    expect(() => parseCliArgs(["agent"])).toThrow(ConfigurationError);
  });

  it("mentions the agent subcommand in help", () => {
    expect(HELP).toContain("agent");
    expect(HELP).toContain("--max-steps");
    expect(HELP).toContain("--agent-model");
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npx vitest run tests/cli-args.test.ts`
Expected: FAIL (agent argv[0] is treated as the topic today).

- [ ] **Step 3: Implement** - in `src/cli-args.ts`:

1. Extend the union: `| { kind: "agent"; options: CliOptions }`.
2. In `parseCliArgs`, before the existing `parseArgs` call:

```ts
const isAgent = argv[0] === "agent";
const args = isAgent ? argv.slice(1) : argv;
```

Use `args` in `parseArgs`, add options `"max-steps": { type: "string" }` and `"agent-model": { type: "string" }`, map them into `configurable` next to the existing mappings:

```ts
if (values["max-steps"] !== undefined) configurable.maxAgentSteps = Number(values["max-steps"]);
if (values["agent-model"] !== undefined) configurable.agentLlm = values["agent-model"];
```

Return `{ kind: isAgent ? "agent" : "research", options }` (keep the existing empty-topic `ConfigurationError`). 3. Extend `HELP` usage block:

```
  local-deep-researcher "<topic>" [options]         Fixed research workflow
  local-deep-researcher agent "<topic>" [options]   Agentic research (tool-calling loop)
  local-deep-researcher mcp                         Start the MCP stdio server
```

and add to the options list:

```
  --max-steps <n>        Agent mode: max model calls in the loop (default 20)
  --agent-model <name>   Agent mode: tool-calling model (default: --model, env AGENT_LLM)
```

4. In `src/cli.ts`, replace the final research block so both kinds share it:

```ts
  const { options } = command;
  let started = false;
  try {
    const cfg = ensureConfiguration({ configurable: options.configurable });
    validateConfiguration(cfg);
    await preflightOllama(cfg);
    if (command.kind === "agent") await preflightAgentModel(cfg);
    started = true;
    const runner = command.kind === "agent" ? researchAgentic : research;
    const report = await runner(options.topic, options.configurable, {
      onProgress: (event) => {
        if (options.quiet) return;
        if (event.step !== undefined) {
          console.error(`[${event.phase}] step ${event.step}/${event.maxSteps}`);
        } else {
          console.error(`[${event.phase}] loop ${event.loop}/${event.maxLoops}`);
        }
      },
    });
```

(imports: `preflightAgentModel` from `./preflight`, `researchAgentic` from `./research`; the output/error handling below stays unchanged).

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/cli-args.test.ts tests/cli-e2e.test.ts`
Expected: PASS (including untouched e2e tests).

- [ ] **Step 5: Full check and commit**

Run: `npm run typecheck && npm test && npm run format`

```bash
git add src/cli-args.ts src/cli.ts tests/cli-args.test.ts
git commit -m "feat: agent CLI subcommand with --max-steps and --agent-model"
```

---

### Task 8: MCP tool `deep_research_agent`

**Files:**

- Modify: `src/mcp.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**

- Consumes: `researchAgentic` (Task 6), `preflightAgentModel` (Task 4), existing `runMcpServer` DI pattern (it takes an injectable research function; follow the same injection style for `researchAgentic`).
- Produces: MCP tool `deep_research_agent` with inputs `topic` (required), `max_steps`, `agent_llm`, `search_api`, `source_domain_blocklist`; progress notifications use `progress = step`, `total = maxAgentSteps`.

- [ ] **Step 1: Write failing tests** (append to `tests/mcp.test.ts`, mirroring the existing `deep_research` tool tests - the file already has helpers to list tools and call them through an in-memory transport; follow them exactly):

```ts
describe("deep_research_agent tool", () => {
  it("is registered with the expected input schema", async () => {
    // Follow the existing pattern in this file for listing tools.
    const tools = await listRegisteredTools();
    const agentTool = tools.find((t) => t.name === "deep_research_agent");
    expect(agentTool).toBeDefined();
    expect(agentTool?.inputSchema.properties).toHaveProperty("topic");
    expect(agentTool?.inputSchema.properties).toHaveProperty("max_steps");
    expect(agentTool?.inputSchema.properties).toHaveProperty("agent_llm");
  });

  it("maps snake_case inputs to configurable and returns markdown", async () => {
    const researchAgenticFn = vi.fn(async () => ({
      summary: "s",
      sources: [{ title: "T", url: "https://t.example" }],
      markdown: "## Summary\nbody",
    }));
    const result = await callTool(
      "deep_research_agent",
      { topic: "alpha", max_steps: 5, agent_llm: "qwen3" },
      { researchAgenticFn },
    );
    expect(researchAgenticFn).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ maxAgentSteps: 5, agentLlm: "qwen3" }),
      expect.anything(),
    );
    expect(result.content[0].text).toContain("## Summary");
  });

  it("returns isError on failure", async () => {
    const researchAgenticFn = vi.fn(async () => {
      throw new Error("agent blew up");
    });
    const result = await callTool("deep_research_agent", { topic: "alpha" }, { researchAgenticFn });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("agent blew up");
  });
});
```

(Adapt helper names `listRegisteredTools` / `callTool` to whatever the existing tests actually use; keep assertions identical.)

- [ ] **Step 2: Run tests, verify fail**

Run: `npx vitest run tests/mcp.test.ts`
Expected: new tests FAIL (tool not registered).

- [ ] **Step 3: Implement** - in `src/mcp.ts`, extend `runMcpServer`'s injectable signature with a `researchAgenticFn` parameter (defaulting to `researchAgentic`), then register alongside `deep_research`:

```ts
server.registerTool(
  "deep_research_agent",
  {
    title: "Agentic deep web research",
    description:
      "Run agentic web research: an autonomous LLM agent decides its own searches, page fetches and notes in a tool-calling loop, then a report is written from the notes. Requires a local model with tool calling (e.g. qwen3). Uses a local LLM; may take several minutes.",
    inputSchema: {
      topic: z.string().describe("The research topic or question"),
      max_steps: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max model calls in the agent loop (default 20)"),
      agent_llm: z
        .string()
        .optional()
        .describe("Tool-calling model for the agent loop (default: the configured local LLM)"),
      search_api: z.enum(["duckduckgo", "tavily", "perplexity", "searxng"]).optional(),
      source_domain_blocklist: z
        .string()
        .optional()
        .describe("Comma-separated domains to always reject"),
    },
  },
  async ({ topic, max_steps, agent_llm, search_api, source_domain_blocklist }, extra) => {
    const configurable: Record<string, unknown> = {};
    if (max_steps !== undefined) configurable.maxAgentSteps = max_steps;
    if (agent_llm !== undefined) configurable.agentLlm = agent_llm;
    if (search_api !== undefined) configurable.searchApi = search_api;
    if (source_domain_blocklist !== undefined)
      configurable.sourceDomainBlocklist = source_domain_blocklist;
    try {
      const cfg = ensureConfiguration({ configurable });
      validateConfiguration(cfg);
      await preflight(cfg);
      await preflightAgentModel(cfg);
      const progressToken = extra._meta?.progressToken;
      const report = await researchAgenticFn(topic, configurable, {
        onProgress: (event) => {
          if (progressToken === undefined) return;
          extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: event.step ?? event.loop,
                total: cfg.maxAgentSteps,
                message: event.phase,
              },
            })
            .catch(() => {
              // client may have disconnected; progress is best-effort
            });
        },
      });
      return { content: [{ type: "text", text: report.markdown }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
      };
    }
  },
);
```

(Match the surrounding file's exact error-handling and return shape used by `deep_research`; import `preflightAgentModel` and `researchAgentic`.)

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run typecheck && npm test && npm run format`

```bash
git add src/mcp.ts tests/mcp.test.ts
git commit -m "feat: deep_research_agent MCP tool"
```

---

### Task 9: Studio graph, docs, changelog, version 0.6.0

**Files:**

- Modify: `langgraph.json`, `README.md`, `CHANGELOG.md`, `package.json`
- Test: `tests/smoke.test.ts` (only if it asserts exports; otherwise no new tests - docs task)

**Interfaces:**

- Consumes: `agenticGraph` export (Task 5), everything shipped in Tasks 1-8.
- Produces: released-ready 0.6.0 tree; user performs the actual release (tag/push/publish) himself.

- [ ] **Step 1: Register the Studio graph** - `langgraph.json`:

```json
{
  "node_version": "20",
  "dependencies": ["."],
  "graphs": {
    "local_deep_researcher": "./src/graph.ts:graph",
    "local_deep_researcher_agent": "./src/agent.ts:agenticGraph"
  },
  "env": ".env"
}
```

- [ ] **Step 2: README** - add an "Agentic mode" section after the existing usage section covering: what it is (agent decides its own searches/fetches/notes in a loop; report written afterwards), the tool-calling model requirement and `AGENT_LLM`, CLI example (`local-deep-researcher agent "topic" --agent-model qwen3 --max-steps 15`), MCP tool name `deep_research_agent`, library example with `researchAgentic()`, and new env vars `AGENT_LLM`, `MAX_AGENT_STEPS`. Plain "-" only, no em-dashes.

- [ ] **Step 3: CHANGELOG** - add a `## 0.6.0` section at the top following the existing entry style: agentic mode (CLI `agent` subcommand, MCP `deep_research_agent`, `researchAgentic()`, Studio graph), new config `agentLlm`/`maxAgentSteps` (env `AGENT_LLM`/`MAX_AGENT_STEPS`), new dependency `langchain@^1`, preflight tool-calling check. Note explicitly: no changes to existing workflow behavior.

- [ ] **Step 4: Bump version** - `package.json`: `"version": "0.6.0"`.

- [ ] **Step 5: Verify everything**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: all green; `dist/` builds.

- [ ] **Step 6: Commit and hand over**

```bash
git add langgraph.json README.md CHANGELOG.md package.json
git commit -m "chore: release 0.6.0 (agentic mode)"
```

Do NOT tag or push. Tell the user the tree is release-ready: he creates the `v0.6.0` tag and pushes (release workflow guards on version + tag match).

---

## Manual verification (post-plan, user-assisted)

Before the actual release, verify end to end with a real Ollama tool-calling model (not part of CI):

```bash
ollama pull qwen3
npm run build
node dist/bin.js agent "what is productive loop budget in iterative research agents" --agent-model qwen3 --max-steps 8
```

Expected: stderr shows `[searching] step 1/8`, `[noting] ...`, `[finalizing] ...`; stdout ends with `## Summary` + `### Sources:`. Also verify `gemma4:e4b` (no tools capability) produces the preflight error with the `--agent-model` hint.
