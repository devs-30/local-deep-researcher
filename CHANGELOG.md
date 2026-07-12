# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-07-12

### Changed

- README explains when a `.env` file applies: loaded from the current working directory by the
  CLI and MCP server (also via `npx`) and by LangGraph Studio; the library API loads no file,
  and `.env.example` ships in the git repository only. Documentation-only release, no code
  changes

## [0.7.0] - 2026-07-12

### Added

- LangSmith tracing for both research modes via first-class config: `langsmithTracing`
  (`LANGSMITH_TRACING`), `langsmithApiKey` (`LANGSMITH_API_KEY`), `langsmithProject`
  (`LANGSMITH_PROJECT`, defaults to `local-deep-researcher` when tracing is enabled) and
  `langsmithEndpoint` (`LANGSMITH_ENDPOINT`). Values passed programmatically or via env are
  mirrored into `process.env` before the graph runs, so CLI, MCP server and library usage are
  all traced. Tracing enabled without an API key fails fast with a `ConfigurationError`;
  disabled tracing (the default) sends nothing

### Fixed

- CLI and MCP server suppress the harmless `Error in handler LangChainTracer, ... No chain run
to end` log lines caused by a known upstream `@langchain/core` bug
  ([langchainjs#11189](https://github.com/langchain-ai/langchainjs/issues/11189), duplicated
  tracer handler when a compiled graph runs inside another graph's node). Traces are complete
  despite the warnings; library consumers keep the unfiltered console. Remove once fixed
  upstream

## [0.6.1] - 2026-07-12

### Changed

- README presents the workflow and agentic modes as two first-class research modes: a comparison
  table up front (engine, decision-maker, CLI, model requirement), the workflow section renamed
  accordingly, and cross-links from the quickstart and library API to the agentic mode section.
  Documentation-only release, no code changes.

## [0.6.0] - 2026-07-11

### Added

- Agentic mode: a single LLM agent decides its own searches, page fetches and notes in a
  tool-calling loop; the report is then written from the notes by a separate one-shot LLM call,
  with the sources section built deterministically. New CLI subcommand `agent` (`--max-steps`,
  `--agent-model`), new MCP tool `deep_research_agent`, new library function `researchAgentic()`,
  and a second Studio graph `local_deep_researcher_agent` (`src/agent.ts:agenticGraph`)
- New config `agentLlm` (env `AGENT_LLM`, falls back to `localLlm` when unset) and
  `maxAgentSteps` (env `MAX_AGENT_STEPS`, default `20`) - caps model calls in the agent loop; on
  the cap the report is written from the notes gathered so far
- Preflight check that fails fast when the configured agent model does not support tool calling,
  with a hint to set `--agent-model` / `AGENT_LLM` (e.g. `qwen3`)
- Loop guarantees: the agent is automatically re-engaged (with instructions to vary its queries)
  while it has zero findings and unspent budget, and records an honest negative finding when
  nothing relevant exists; tool feedback nudges it to fetch catalog pages in full and to keep
  researching on exhaustive-list questions instead of stopping after the first rich source
- New dependency: `langchain@^1`

### Changed

- Fetched pages are stripped of scripts, styles and page chrome (nav, footer, aside, forms,
  inline SVG, comments) before markdown conversion, and images are reduced to their alt text
  (no URLs or base64 data URIs) - fewer junk tokens in the agent's `fetch_page` output and in
  the workflow's `fetchFullPage` content, while brand names from logo walls stay readable

Existing workflow behavior (`research()` / `local-deep-researcher <topic>`) is otherwise
unchanged; agentic mode is purely additive

## [0.5.0] - 2026-07-11

### Changed

- Empty rounds no longer invoke the summarizer on an empty context: `gradeSources`
  routes them straight to reflection, and the reflection prompt lists the queries that
  returned nothing with a do-not-repeat instruction. A fully empty run now produces an
  honestly empty report instead of a summary hallucinated from empty context

## [0.4.0] - 2026-07-11

### Changed

- Research-loop budget now counts only productive rounds (at least one source kept after
  grading). Empty rounds (all sources rejected or a failed search) get free retries with a
  fresh query, bounded by a hard cap of `2 * (maxWebResearchLoops + 1)` total rounds.
  **Behavior change vs 0.2.x:** restore the old counting with `--count-empty-loops` /
  `COUNT_EMPTY_LOOPS=true` / `countEmptyLoops: true`

## [0.3.0] - 2026-07-11

### Changed

- Default local model switched from `llama3.2` to `gemma4:e4b` (`ollama pull gemma4:e4b`)

## [0.2.1] - 2026-07-11

### Fixed

- DuckDuckGo provider now ports the full backend fallback chain of the Python
  `duckduckgo_search` library used by the upstream repo: duck-duck-scrape (vqd API) →
  `html.duckduckgo.com` → `lite.duckduckgo.com` → Bing scrape. A failing or bot-blocked
  backend switches to the next one; only when all fail is the last error thrown

## [0.2.0] - 2026-07-11

### Added

- `gradeSources` node: two-stage source filtering (credibility heuristics + per-source LLM
  relevance check) between search and summarization. **Behavior change vs upstream:** ON by
  default, adds up to one LLM call per gathered source; disable with `--no-grade-sources` /
  `GRADE_SOURCES=false` / `gradeSources: false`
- `--no-grade-sources` and `--blocklist <domains>` CLI flags; `grade_sources` and
  `source_domain_blocklist` MCP tool inputs; `SOURCE_DOMAIN_BLOCKLIST` env var

## [0.1.1] - 2026-07-11

Accidental duplicate of v0.1.0 - no changes.

## [0.1.0] - 2026-07-11

### Added

- Initial release: faithful LangGraph.js port of [langchain-ai/local-deep-researcher](https://github.com/langchain-ai/local-deep-researcher)
- Four entry points: library (`research()`, `graph`), CLI (`npx @devs30/local-deep-researcher`), MCP stdio server (`mcp` subcommand), LangGraph Studio (`langgraph.json`)
- LLM providers: Ollama (default, `llama3.2`) and OpenAI-compatible endpoints
- Search providers: DuckDuckGo (default, keyless), Tavily, Perplexity, SearXNG
- Configuration via zod schema with precedence: params/flags → env → defaults
- Ollama pre-flight check with `ollama pull` hint
- Ready-made Claude Code subagent (`.claude/agents/deep-researcher.md`)

[unreleased]: https://github.com/devs-30/local-deep-researcher/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/devs-30/local-deep-researcher/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/devs-30/local-deep-researcher/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/devs-30/local-deep-researcher/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/devs-30/local-deep-researcher/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/devs-30/local-deep-researcher/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/devs-30/local-deep-researcher/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/devs-30/local-deep-researcher/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/devs-30/local-deep-researcher/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/devs-30/local-deep-researcher/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/devs-30/local-deep-researcher/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/devs-30/local-deep-researcher/releases/tag/v0.1.0
