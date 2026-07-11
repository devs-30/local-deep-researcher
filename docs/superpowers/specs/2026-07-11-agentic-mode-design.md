# Agentic mode (`agent` command) - design

Date: 2026-07-11
Status: approved
Target version: 0.6.0 (minor - additive API, no changes to existing behavior)

## Goal

Add an agentic research mode alongside the existing fixed workflow. In the workflow the
graph decides the next step; in agentic mode a single LLM agent decides its own next
actions in a tool-calling loop (search, fetch, take notes) until it judges the topic
covered or hits a step budget. The final report is written outside the loop by a
one-shot LLM call (lesson from LangChain open_deep_research: keep agency in research,
not in report writing).

Explicitly out of scope for this version: sub-agents / supervisor patterns. The
architecture keeps clean seams (notes, research-vs-report split) so a supervisor or
deepagents-based mode can be added later for stronger models.

## Decisions made

- Separate command/tool/function per interface, not a flag: CLI subcommand `agent`,
  MCP tool `deep_research_agent`, library function `researchAgentic()`, second Studio
  graph. Better discoverability, especially for MCP clients.
- All 4 interfaces (lib, CLI, MCP, Studio) in the first version.
- Core built on `createAgent` from `langchain@^1` (LangChain 1.0 agent abstraction;
  `createReactAgent` is deprecated). No sub-agents.
- Agent tools: `web_search` + `fetch_page` + `take_note`. Report written outside the
  loop from the notes.
- Loop budget: new `maxAgentSteps` config (hard cap on model calls in the loop,
  default 20), enforced via the built-in model-call-limit middleware with graceful
  termination (proceed to report with whatever was gathered).
- Model config: new optional `agentLlm` (env `AGENT_LLM`) with fallback to `localLlm`;
  preflight verifies the agent model declares the `tools` capability in Ollama.

## Architecture

New module `src/agent.ts` exposing `buildAgenticGraph(overrides: Partial<GraphDeps>)`
(same DI pattern as `buildGraph`). Parent StateGraph:

```
START -> agentLoop -> finalizeReport -> END
```

### agentLoop

Creates a per-run `createAgent` instance:

- model: via existing `deps.getLlm`, with `cfg.agentLlm ?? cfg.localLlm` as the model
  name (tool-calling capable, e.g. qwen3),
- tools: `web_search`, `fetch_page`, `take_note` built in the node closure sharing a
  per-run context (notes array, seen-URL set, search provider, progress hooks),
- systemPrompt: new `prompts.agentInstructions({ researchTopic, currentDate,
maxAgentSteps })` - search first, fetch pages when needed, record findings with
  source URLs, stop when the topic is covered,
- middleware: built-in model-call limit set to `cfg.maxAgentSteps`; on limit the loop
  ends gracefully and the graph proceeds to the report.

The loop ends naturally when the model stops calling tools, or via the limit. The node
returns `notes` (list of `{ note, sourceUrl, sourceTitle }`) and the step counter.

### finalizeReport

One-shot LLM call (plain `localLlm`; no tool calling required): writes the report from
the notes and topic. The `### Sources:` section is built deterministically from
deduplicated note URLs (not by the LLM), mirroring the existing `finalizeSummary`.
Output format is identical to the workflow (`## Summary\n...\n\n### Sources:\n...`),
so `ResearchReport { summary, sources, markdown }` and its parsers stay shared.

### State

New `AgenticStateAnnotation` in `src/state.ts` (separate from `SummaryState`):
`researchTopic`, `notes[]`, `stepsUsed`, `runningSummary`.

### Progress

`agentLoop` is a single node (one stream update at the end), so progress events are
emitted by the tools themselves through the closure: `web_search` -> `searching`,
`fetch_page` -> `fetching`, `take_note` -> `noting`, plus `finalizing` from the graph.
`ProgressEvent` gains `step`/`maxSteps` fields (backwards-compatible union extension
next to `loop`/`maxLoops`).

## Components

| File                            | Change                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/agent.ts`                  | new: `buildAgenticGraph()`, exported `agenticGraph` for Studio                                         |
| `src/agent-tools.ts`            | new: factories for the 3 tools with per-run context                                                    |
| `src/prompts.ts`                | add `agentInstructions`, `reportWriterInstructions`                                                    |
| `src/state.ts`                  | add `AgenticStateAnnotation`                                                                           |
| `src/research.ts`               | add `researchAgentic(topic, options, hooks, deps)` mirroring `research()`                              |
| `src/configuration.ts`          | add `agentLlm` (optional, env `AGENT_LLM`), `maxAgentSteps` (default 20, min 1, env `MAX_AGENT_STEPS`) |
| `src/preflight.ts`              | add agent-model tool-calling check                                                                     |
| `src/cli-args.ts`, `src/cli.ts` | add `agent` subcommand                                                                                 |
| `src/mcp.ts`                    | add `deep_research_agent` tool                                                                         |
| `src/index.ts`                  | export `researchAgentic` and new types                                                                 |
| `langgraph.json`                | add `"local_deep_researcher_agent": "./src/agent.ts:agenticGraph"`                                     |
| `package.json`                  | add `langchain@^1`                                                                                     |

### Tools

- `web_search(query)`: wraps existing `searchWithRetry` plus heuristics from
  `grade.ts` (domain blocklist, dedup against seen URLs, thin-content filter). No
  in-loop LLM grading - relevance judgment is the agent's own job; this halves model
  calls. Returns a formatted list: title, URL, excerpt trimmed to the existing
  `MAX_TOKENS_PER_SOURCE` budget.
- `fetch_page(url)`: reuses `src/search/fetch.ts` + turndown markdown conversion,
  hard length cap on returned content.
- `take_note(note, source_url, source_title?)`: appends to the run's notes; returns a
  short confirmation including the notes count (feedback for the model).

### Model configuration and preflight

`agentLlm` unset -> falls back to `localLlm`. In agentic mode preflight queries Ollama
(`/api/show`) and fails fast with a clear message when the model does not declare the
`tools` capability ("model X does not support tool calling; set --agent-model, e.g.
qwen3"). For `openai_compatible` the check is skipped (no capabilities API); errors
surface at runtime with the same hint attached.

## Interfaces

- CLI: `local-deep-researcher agent "<topic>" [shared options] --max-steps <n>
--agent-model <name>`. Shared options (`--search-api`, `--blocklist`, `-o`,
  `--json`, `-q`, ...) behave identically. Help text extended.
- MCP: tool `deep_research_agent` (title "Agentic deep web research"; description
  highlights the autonomous loop and the tool-calling model requirement). Inputs:
  `topic`, `max_steps`, `agent_llm`, `search_api`, `source_domain_blocklist`.
  Progress notifications: `progress = step`, `total = maxAgentSteps`.
- Library: `researchAgentic()` returns the same `ResearchReport`; exported from
  `index.ts`.
- Studio: second graph in `langgraph.json` (`agentLoop -> finalizeReport`; the loop
  internals are visible in traces since `createAgent` compiles to a subgraph).

## Error handling

- Search failure inside the tool: `web_search` does not throw into the loop - it
  returns an error string to the model ("search failed: ..., try a different query"),
  enabling self-repair. Same for `fetch_page` (timeout/HTTP error -> message).
- Zero notes at the end of the loop: `AgentResearchError` ("agent finished without
  gathering any findings") instead of writing a report from nothing. CLI: non-zero
  exit code; MCP: `isError: true`.
- Model without tool calling: caught in preflight; if runtime still fails on tool
  parsing, the error propagates with the `--agent-model` hint.
- Step limit reached: not an error - graceful descent to `finalizeReport` with the
  gathered notes, warning on stderr.
- `finalizeReport` failure: propagated (like summarize failures today) - no silent
  fallbacks.

## Testing (vitest, existing repo patterns)

1. Unit - tools: blocklist/dedup/thin-content in `web_search`; content trimming;
   `take_note` accumulation and confirmation; progress event emission.
2. Unit - configuration: new fields, env mapping, `agentLlm -> localLlm` fallback,
   `maxAgentSteps >= 1` validation.
3. Integration - graph: mocked `LlmFactory` returning scripted `AIMessage`s with
   `tool_calls` (scenario: search -> fetch -> note -> note -> end); assertions on
   notes, report, `## Summary`/`### Sources` format, source dedup; step-limit scenario
   (model wants more, middleware cuts off); zero-notes scenario -> `AgentResearchError`.
4. CLI: parsing of the `agent` subcommand, `--max-steps`, `--agent-model`, help.
5. MCP: tool schema, snake_case -> configurable mapping, `isError` on failure.
6. Preflight: mocked Ollama `/api/show` responses with/without the `tools` capability.

No E2E against a real Ollama in CI (as today) - manual verification before release.
