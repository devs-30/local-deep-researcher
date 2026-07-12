# LangSmith Tracing Design

Date: 2026-07-12
Status: approved

## Goal

Enable LangSmith tracing for both graphs (classic deep-researcher and agentic mode) via first-class configuration variables, so runs can be inspected in LangSmith regardless of whether the package is used as a CLI, MCP server, or library.

## Background

The `langsmith` client is a transitive dependency of `@langchain/core` and activates automatically when `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` are present in `process.env`. No callbacks or graph changes are needed. The CLI (and the MCP server, which starts through the same `main()`) already loads `.env` via `loadDotenv()` in `src/cli.ts`.

The gap: values passed programmatically through `options` (the `configurable` path used by the library API and MCP) never reach `process.env`, and there is no validation, no default project name, and no documentation.

## Design

### 1. Configuration schema (`src/configuration.ts`)

New fields in `ConfigurationSchema`, with `ENV_KEYS` mappings that match the native langsmith SDK variable names (so plain env passthrough keeps working with zero code):

| Field               | Env var              | Type / default                               |
| ------------------- | -------------------- | -------------------------------------------- |
| `langsmithTracing`  | `LANGSMITH_TRACING`  | `boolFromString.default(false)`              |
| `langsmithApiKey`   | `LANGSMITH_API_KEY`  | `string`, optional                           |
| `langsmithProject`  | `LANGSMITH_PROJECT`  | `string`, optional                           |
| `langsmithEndpoint` | `LANGSMITH_ENDPOINT` | `string`, optional (self-hosted / EU region) |

### 2. Fail-fast validation (`validateConfiguration`)

`langsmithTracing=true` without `langsmithApiKey` throws `ConfigurationError("langsmithTracing=true requires LANGSMITH_API_KEY")`, consistent with the existing tavily/perplexity/searxng provider-key pairs.

### 3. `applyTracingEnv(cfg)` (new function in `src/configuration.ts`)

Maps validated config to `process.env` because the langsmith SDK only reads env:

- When `cfg.langsmithTracing` is `true`:
  - `process.env.LANGSMITH_TRACING = "true"`
  - `process.env.LANGSMITH_API_KEY = cfg.langsmithApiKey`
  - `process.env.LANGSMITH_PROJECT = cfg.langsmithProject ?? "local-deep-researcher"` (default keeps traces out of the LangSmith "default" project)
  - `process.env.LANGSMITH_ENDPOINT = cfg.langsmithEndpoint` (only when set)
- When `false`: touch nothing (never delete or overwrite user-set env vars).

Called in `research()` and `researchAgentic()` (`src/research.ts`) immediately after `validateConfiguration(cfg)`. This single hook covers CLI, MCP, and library usage, including values supplied programmatically via `options`.

### 4. No CLI flags

Configuration is env-only (`.env`, process env) or programmatic via `options`. Secrets in CLI flags are an anti-pattern (shell history, `ps`), and `loadDotenv()` already covers the CLI/MCP path.

### 5. Testing

TDD, extending the existing configuration tests:

- schema: new fields parse from env and from `configurable`, `configurable` wins over env; `langsmithTracing` accepts `"true"/"1"/"yes"`.
- validation: tracing enabled without API key throws; with key passes.
- `applyTracingEnv`: sets all four vars when enabled; applies the `local-deep-researcher` project default only when no project is given; leaves `process.env` untouched when tracing is disabled.
- Tests must save and restore mutated `process.env` keys.

### 6. Documentation

- README: new "LangSmith tracing" section with an env var table and a `.env` example.
- CHANGELOG entry (minor version - new feature, no breaking changes).

## Out of scope

- CLI flags for LangSmith settings.
- Custom run names, metadata, or manual `traceable()` instrumentation - automatic graph tracing is sufficient.
- OpenTelemetry or other tracing backends.
