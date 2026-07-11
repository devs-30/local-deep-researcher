# @devs30/local-deep-researcher

[![npm](https://img.shields.io/npm/v/%40devs30%2Flocal-deep-researcher)](https://www.npmjs.com/package/@devs30/local-deep-researcher)
[![CI](https://github.com/devs-30/local-deep-researcher/actions/workflows/ci.yml/badge.svg)](https://github.com/devs-30/local-deep-researcher/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40devs30%2Flocal-deep-researcher)](./LICENSE)

A JavaScript/TypeScript port of
[langchain-ai/local-deep-researcher](https://github.com/langchain-ai/local-deep-researcher):
a fully local, iterative web research assistant built on [LangGraph.js](https://langchain-ai.github.io/langgraphjs/).
It runs against a local LLM via [Ollama](https://ollama.com) by default, so no API keys are
required to get a cited research report. Use it as a library, a CLI, an MCP server, or a
LangGraph Studio graph.

## How it works

The assistant runs a small research loop as a LangGraph state machine:

```
generate query → web search → grade sources → summarize → reflect on gaps
                     ^                                          |
                     └───────────────── repeat ─────────────────┘
                                                                  |
                                                          finalize summary
```

1. **Generate query** - the LLM turns your topic into a targeted search query.
2. **Web search** - the query is run against the configured search provider.
3. **Grade sources** - results are filtered in two stages: deterministic credibility heuristics
   (domain blocklist, thin/empty content, cross-loop URL dedup - no LLM cost), then a per-source
   binary LLM relevance check ("when in doubt, keep"). Rejected sources never reach the summary or
   final bibliography; every drop is logged to stderr with a reason. If a whole round is rejected,
   the research loop tries a different query next iteration - these empty rounds (all sources
   rejected or a failed search) get free retries that don't consume the budget. The budget counts
   only productive rounds (at least one source kept), up to a hard cap of `2 * (maxWebResearchLoops + 1)`
   total rounds. Use `--count-empty-loops` to restore the v0.2.x behavior where empty rounds
   consume budget. Note that MCP progress `loop` counts all attempts and can exceed `total` when
   free retries happen.
4. **Summarize** - the new results are folded into a running summary. Empty rounds skip this step
   and go straight to reflection, which receives the list of failed queries with a do-not-repeat
   instruction; a run where every round is empty produces an honestly empty report instead of a
   summary hallucinated from empty context.
5. **Reflect** - the LLM looks for knowledge gaps and produces a follow-up query.
6. Steps 2–5 repeat until the configured loop count is reached (default **3** loops), then the
   summary is finalized into a markdown report with a deduplicated source list. (Like the Python
   original, `--max-loops N` performs N+1 productive rounds; empty rounds get free retries up to a hard cap of `2 * (N + 1)` total rounds.)

> **Behavior change vs the Python original (`ollama-deep-researcher`):** source grading is ON by
> default and adds up to one LLM call per gathered source. Disable it with `--no-grade-sources` (CLI),
> `GRADE_SOURCES=false` (env), or `gradeSources: false` (library/MCP) to restore upstream-identical
> behavior.

## Quickstart (CLI)

```bash
ollama pull gemma4:e4b
npx @devs30/local-deep-researcher "history of liquid rocket engines"
```

This prints a markdown report to stdout, with progress logged to stderr. No search API key is
needed - the default search provider is DuckDuckGo.

### CLI flags

| Flag                    | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `--max-loops <n>`       | Research loops (default `3`; N yields N+1 productive rounds)                  |
| `--count-empty-loops`   | Empty rounds (no sources kept) also consume the loop budget (v0.2.x behavior) |
| `--provider <name>`     | `ollama` \| `openai_compatible` (default `ollama`)                            |
| `--model <name>`        | Model name (default `gemma4:e4b`, env `LOCAL_LLM`)                            |
| `--base-url <url>`      | LLM base URL (Ollama or OpenAI-compatible endpoint)                           |
| `--search-api <name>`   | `duckduckgo` \| `tavily` \| `perplexity` \| `searxng` (default `duckduckgo`)  |
| `--fetch-full-page`     | Fetch full page content for each source                                       |
| `--no-grade-sources`    | Disable source grading (credibility + relevance filter)                       |
| `--blocklist <domains>` | Comma-separated domains to always reject                                      |
| `-o, --output <file>`   | Write the report to a file instead of stdout                                  |
| `--json`                | Output `{"summary", "sources"}` JSON instead of markdown                      |
| `-q, --quiet`           | Suppress progress output on stderr                                            |
| `-h, --help`            | Show help                                                                     |
| `-v, --version`         | Show version                                                                  |

`local-deep-researcher mcp` starts the MCP stdio server instead of running a one-off research
task - see [Use as an MCP server](#use-as-an-mcp-server-claude-code--codex) below.

## Use as a Claude Code subagent

Copy [`.claude/agents/deep-researcher.md`](.claude/agents/deep-researcher.md) into your project's
`.claude/agents/` directory. Claude Code will pick it up automatically and delegate research
tasks to it - it shells out to the CLI (`npx -y @devs30/local-deep-researcher "<topic>" --quiet`)
and returns the markdown report verbatim.

## Use as an MCP server (Claude Code / Codex)

Register the server with Claude Code:

```bash
claude mcp add deep-researcher -- npx -y @devs30/local-deep-researcher mcp
```

For Codex, add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.deep-researcher]
command = "npx"
args = ["-y", "@devs30/local-deep-researcher", "mcp"]
```

The server exposes a single tool, `deep_research`, which takes `topic` (required), and optional
`max_loops` and `search_api` parameters, and streams progress notifications while it runs.

## Library API

```ts
import { research } from "@devs30/local-deep-researcher";

const report = await research(
  "history of liquid rocket engines",
  { maxWebResearchLoops: 3 },
  {
    onProgress: (event) => {
      // event.phase: "generating_query" | "searching" | "summarizing" | "reflecting" | "finalizing"
      console.error(`[${event.loop}/${event.maxLoops}] ${event.phase}`);
    },
  },
);

console.log(report.markdown); // full "## Summary" + "### Sources:" report
console.log(report.summary); // the running summary text
console.log(report.sources); // [{ title, url }, ...] deduplicated sources
```

`research(topic, options?, hooks?, deps?)` returns a `ResearchReport`:

```ts
interface ResearchReport {
  summary: string;
  sources: Array<{ title: string; url: string }>;
  markdown: string;
}
```

`options` is a `Partial<Configuration>` (see [Configuration](#configuration) below) and takes
precedence over environment variables. `deps` lets you override the LLM factory or search
provider - mainly useful for testing.

## Agentic mode

Alongside the fixed research loop above, this repo also ships an agentic mode: a single LLM agent
decides its own searches, page fetches and notes in a tool-calling loop, instead of following the
generate-query -> search -> grade -> summarize -> reflect steps. Once the agent stops (or hits the
step cap), a separate one-shot LLM call writes the report from the gathered notes; the sources
section is built deterministically from the notes' source URLs.

Agentic mode requires an Ollama model with tool calling (e.g. `qwen3`) - the default `gemma4:e4b`
does not support tools. A preflight check fails fast with a hint to set `--agent-model` /
`AGENT_LLM` if the configured model can't call tools.

```bash
ollama pull qwen3
npx @devs30/local-deep-researcher agent "history of liquid rocket engines" --agent-model qwen3 --max-steps 15
```

| Flag                   | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `--max-steps <n>`      | Max model calls in the agent loop (default `20`, env `MAX_AGENT_STEPS`)     |
| `--agent-model <name>` | Tool-calling model for the agent loop (default: `--model`, env `AGENT_LLM`) |

The MCP server exposes a second tool alongside `deep_research`: `deep_research_agent`, which takes
`topic` (required), and optional `max_steps`, `agent_llm`, `search_api` and
`source_domain_blocklist` parameters.

```ts
import { researchAgentic } from "@devs30/local-deep-researcher";

const report = await researchAgentic("history of liquid rocket engines", {
  agentLlm: "qwen3",
  maxAgentSteps: 15,
});

console.log(report.markdown); // same ResearchReport shape as research()
```

`researchAgentic(topic, options?, hooks?, deps?)` returns the same `ResearchReport` shape as
`research()`. `agentLlm` falls back to `localLlm` when unset; `maxAgentSteps` caps the number of
model calls in the loop (default `20`) - when the cap is hit, the report is written from whatever
notes were gathered so far.

Existing workflow behavior (`research()` / `local-deep-researcher <topic>`) is unchanged;
agentic mode is purely additive.

## LangGraph Studio

This repo ships a `langgraph.json` with two graphs, so you can open them directly in LangGraph
Studio from the repo root:

- `local_deep_researcher` - the fixed research loop (`src/graph.ts:graph`)
- `local_deep_researcher_agent` - agentic mode (`src/agent.ts:agenticGraph`)

```bash
npx @langchain/langgraph-cli dev
```

## Configuration

All settings can be set via environment variables (see `.env.example`), and programmatic callers
can also pass them directly as the `options` argument to `research()`. Programmatic options take
precedence over environment variables, which take precedence over the defaults below.

| Config key                | Env var                      | Default                                               |
| ------------------------- | ---------------------------- | ----------------------------------------------------- |
| `llmProvider`             | `LLM_PROVIDER`               | `ollama`                                              |
| `localLlm`                | `LOCAL_LLM`                  | `gemma4:e4b`                                          |
| `agentLlm`                | `AGENT_LLM`                  | _(none, falls back to `localLlm`)_                    |
| `ollamaBaseUrl`           | `OLLAMA_BASE_URL`            | `http://localhost:11434`                              |
| `openaiCompatibleBaseUrl` | `OPENAI_COMPATIBLE_BASE_URL` | _(none, required if `llmProvider=openai_compatible`)_ |
| `openaiCompatibleApiKey`  | `OPENAI_COMPATIBLE_API_KEY`  | _(none)_                                              |
| `searchApi`               | `SEARCH_API`                 | `duckduckgo`                                          |
| `maxWebResearchLoops`     | `MAX_WEB_RESEARCH_LOOPS`     | `3`                                                   |
| `maxAgentSteps`           | `MAX_AGENT_STEPS`            | `20`                                                  |
| `fetchFullPage`           | `FETCH_FULL_PAGE`            | `false`                                               |
| `gradeSources`            | `GRADE_SOURCES`              | `true`                                                |
| `sourceDomainBlocklist`   | `SOURCE_DOMAIN_BLOCKLIST`    | (empty)                                               |
| `countEmptyLoops`         | `COUNT_EMPTY_LOOPS`          | `false`                                               |
| `stripThinkingTokens`     | `STRIP_THINKING_TOKENS`      | `true`                                                |
| `tavilyApiKey`            | `TAVILY_API_KEY`             | _(none, required if `searchApi=tavily`)_              |
| `perplexityApiKey`        | `PERPLEXITY_API_KEY`         | _(none, required if `searchApi=perplexity`)_          |
| `searxngUrl`              | `SEARXNG_URL`                | _(none, required if `searchApi=searxng`)_             |

Copy `.env.example` to `.env` and adjust as needed.

## Search providers

- **DuckDuckGo** (default) - no API key required.
- **Tavily** - set `SEARCH_API=tavily` and `TAVILY_API_KEY`.
- **Perplexity** - set `SEARCH_API=perplexity` and `PERPLEXITY_API_KEY`.
- **SearXNG** - set `SEARCH_API=searxng` and `SEARXNG_URL` to your instance URL.

## License

MIT. This is a port of [langchain-ai/local-deep-researcher](https://github.com/langchain-ai/local-deep-researcher);
credit to the original authors for the research loop design and prompts.
