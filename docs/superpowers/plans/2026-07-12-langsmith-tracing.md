# LangSmith Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class LangSmith tracing configuration (`langsmithTracing`, `langsmithApiKey`, `langsmithProject`, `langsmithEndpoint`) that activates automatic LangChain/LangGraph tracing for both research graphs.

**Architecture:** The `langsmith` client (transitive dependency of `@langchain/core`) reads `LANGSMITH_*` from `process.env` and traces every graph/LLM/tool call automatically. We add the four fields to `ConfigurationSchema` + `ENV_KEYS`, validate fail-fast, and mirror validated config into `process.env` via a new `applyTracingEnv()` called at the top of `research()` and `researchAgentic()`. This covers CLI, MCP server, and library usage, including values passed programmatically via `options`.

**Tech Stack:** TypeScript, Zod, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-langsmith-tracing-design.md`

## Global Constraints

- NEVER run `git commit`, `git tag`, or `git push`. At each commit step, only stage nothing and propose the commit message; the user commits himself.
- Stay on the current branch (`main`); do not create branches or worktrees.
- No em-dashes anywhere (code, docs, commit messages); use plain `-` only.
- Env var names must exactly match the native langsmith SDK names: `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_ENDPOINT`.
- When tracing is disabled, `applyTracingEnv` must not touch `process.env` at all.
- Default project name when tracing is enabled and no project given: `local-deep-researcher`.
- Run commands from the repo root: `/media/twapaw/ubuntu-data-1/0-Projekty/local-deep-researcher`.

---

### Task 1: Configuration schema fields + fail-fast validation

**Files:**

- Modify: `src/configuration.ts` (schema at lines 16-34, `ENV_KEYS` at lines 38-56, `validateConfiguration` at lines 81-96)
- Test: `tests/configuration.test.ts`

**Interfaces:**

- Produces: `Configuration` type gains `langsmithTracing: boolean`, `langsmithApiKey?: string`, `langsmithProject?: string`, `langsmithEndpoint?: string`. `validateConfiguration(cfg)` throws `ConfigurationError` matching `/LANGSMITH_API_KEY/` when `langsmithTracing && !langsmithApiKey`.

- [ ] **Step 1: Write the failing tests**

In `tests/configuration.test.ts`, add the four env vars to the `MANAGED_ENV` array (so `beforeEach`/`afterEach` save, clear, and restore them):

```ts
const MANAGED_ENV = [
  // ... existing entries stay unchanged ...
  "AGENT_LLM",
  "MAX_AGENT_STEPS",
  "LANGSMITH_TRACING",
  "LANGSMITH_API_KEY",
  "LANGSMITH_PROJECT",
  "LANGSMITH_ENDPOINT",
];
```

Append a new describe block at the end of the file:

```ts
describe("langsmith configuration", () => {
  it("defaults langsmithTracing to false and leaves the rest unset", () => {
    const cfg = ensureConfiguration();
    expect(cfg.langsmithTracing).toBe(false);
    expect(cfg.langsmithApiKey).toBeUndefined();
    expect(cfg.langsmithProject).toBeUndefined();
    expect(cfg.langsmithEndpoint).toBeUndefined();
  });

  it("reads LANGSMITH_* from env", () => {
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_key";
    process.env.LANGSMITH_PROJECT = "my-project";
    process.env.LANGSMITH_ENDPOINT = "https://eu.api.smith.langchain.com";
    const cfg = ensureConfiguration();
    expect(cfg.langsmithTracing).toBe(true);
    expect(cfg.langsmithApiKey).toBe("lsv2_key");
    expect(cfg.langsmithProject).toBe("my-project");
    expect(cfg.langsmithEndpoint).toBe("https://eu.api.smith.langchain.com");
  });

  it("lets configurable override LANGSMITH_TRACING env", () => {
    process.env.LANGSMITH_TRACING = "true";
    const cfg = ensureConfiguration({ configurable: { langsmithTracing: false } });
    expect(cfg.langsmithTracing).toBe(false);
  });

  it("requires LANGSMITH_API_KEY when tracing is enabled", () => {
    const cfg = ensureConfiguration({ configurable: { langsmithTracing: true } });
    expect(() => validateConfiguration(cfg)).toThrow(/LANGSMITH_API_KEY/);
  });

  it("passes validation when tracing is enabled with an API key", () => {
    const cfg = ensureConfiguration({
      configurable: { langsmithTracing: true, langsmithApiKey: "lsv2_key" },
    });
    expect(() => validateConfiguration(cfg)).not.toThrow();
  });
});
```

Note: `MANAGED_ENV` clears `LANGSMITH_*` in `beforeEach`, so these tests are immune to a real `.env`/shell config on the developer machine.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/configuration.test.ts`
Expected: the 5 new tests FAIL (unknown keys are dropped by the schema, so `cfg.langsmithTracing` is `undefined`, and `validateConfiguration` does not throw).

- [ ] **Step 3: Implement schema + validation**

In `src/configuration.ts`, add to `ConfigurationSchema` (after `countEmptyLoops`):

```ts
  langsmithTracing: boolFromString.default(false),
  langsmithApiKey: z.string().optional(),
  langsmithProject: z.string().optional(),
  langsmithEndpoint: z.string().optional(),
```

Add to `ENV_KEYS` (after `countEmptyLoops`):

```ts
  langsmithTracing: "LANGSMITH_TRACING",
  langsmithApiKey: "LANGSMITH_API_KEY",
  langsmithProject: "LANGSMITH_PROJECT",
  langsmithEndpoint: "LANGSMITH_ENDPOINT",
```

Add to `validateConfiguration` (after the `openai_compatible` check):

```ts
if (cfg.langsmithTracing && !cfg.langsmithApiKey) {
  throw new ConfigurationError("langsmithTracing=true requires LANGSMITH_API_KEY");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/configuration.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck and propose commit**

Run: `npm run typecheck`
Expected: no errors.

Propose this commit message to the user (do NOT commit):

```
feat: add LangSmith tracing config (LANGSMITH_* env vars, fail-fast key check)
```

---

### Task 2: `applyTracingEnv()` maps config to process.env

**Files:**

- Modify: `src/configuration.ts` (append after `validateConfiguration`)
- Test: `tests/configuration.test.ts`

**Interfaces:**

- Consumes: `Configuration` fields from Task 1.
- Produces: `export function applyTracingEnv(cfg: Configuration): void` and `export const DEFAULT_LANGSMITH_PROJECT = "local-deep-researcher"`, both exported from `src/configuration.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/configuration.test.ts` (the existing `beforeEach`/`afterEach` already clear and restore `LANGSMITH_*` after Task 1). Extend the import at the top of the file:

```ts
import {
  applyTracingEnv,
  ConfigurationError,
  DEFAULT_LANGSMITH_PROJECT,
  ensureConfiguration,
  validateConfiguration,
} from "../src/configuration";
```

New describe block:

```ts
describe("applyTracingEnv", () => {
  it("does not touch process.env when tracing is disabled", () => {
    process.env.LANGSMITH_PROJECT = "untouched";
    applyTracingEnv(ensureConfiguration({ configurable: { langsmithProject: undefined } }));
    expect(process.env.LANGSMITH_TRACING).toBeUndefined();
    expect(process.env.LANGSMITH_API_KEY).toBeUndefined();
    expect(process.env.LANGSMITH_PROJECT).toBe("untouched");
    expect(process.env.LANGSMITH_ENDPOINT).toBeUndefined();
  });

  it("mirrors config into process.env when tracing is enabled", () => {
    const cfg = ensureConfiguration({
      configurable: {
        langsmithTracing: true,
        langsmithApiKey: "lsv2_key",
        langsmithProject: "my-project",
        langsmithEndpoint: "https://eu.api.smith.langchain.com",
      },
    });
    applyTracingEnv(cfg);
    expect(process.env.LANGSMITH_TRACING).toBe("true");
    expect(process.env.LANGSMITH_API_KEY).toBe("lsv2_key");
    expect(process.env.LANGSMITH_PROJECT).toBe("my-project");
    expect(process.env.LANGSMITH_ENDPOINT).toBe("https://eu.api.smith.langchain.com");
  });

  it("defaults the project to local-deep-researcher when none is given", () => {
    const cfg = ensureConfiguration({
      configurable: { langsmithTracing: true, langsmithApiKey: "lsv2_key" },
    });
    applyTracingEnv(cfg);
    expect(process.env.LANGSMITH_PROJECT).toBe(DEFAULT_LANGSMITH_PROJECT);
    expect(DEFAULT_LANGSMITH_PROJECT).toBe("local-deep-researcher");
  });

  it("does not set LANGSMITH_ENDPOINT when no endpoint is configured", () => {
    const cfg = ensureConfiguration({
      configurable: { langsmithTracing: true, langsmithApiKey: "lsv2_key" },
    });
    applyTracingEnv(cfg);
    expect(process.env.LANGSMITH_ENDPOINT).toBeUndefined();
  });
});
```

Note on the first test: an env `LANGSMITH_PROJECT` would flow back into `cfg.langsmithProject` via `ensureConfiguration` (env is a config source), which is fine - the assertion is only that a disabled tracer changes nothing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/configuration.test.ts`
Expected: FAIL - `applyTracingEnv` and `DEFAULT_LANGSMITH_PROJECT` are not exported (import error).

- [ ] **Step 3: Implement `applyTracingEnv`**

Append to `src/configuration.ts` after `validateConfiguration`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/configuration.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck and propose commit**

Run: `npm run typecheck`
Expected: no errors.

Propose this commit message to the user (do NOT commit):

```
feat: applyTracingEnv mirrors LangSmith config into process.env
```

---

### Task 3: Wire tracing into research() and researchAgentic()

**Files:**

- Modify: `src/research.ts` (imports at lines 3-8; after `validateConfiguration(cfg)` at lines 63 and 117)
- Test: `tests/research.test.ts`

**Interfaces:**

- Consumes: `applyTracingEnv(cfg)` from Task 2.
- Produces: both public entrypoints activate tracing before streaming the graph; no API changes.

- [ ] **Step 1: Write the failing test**

In `tests/research.test.ts`, add a test to the existing `describe("research", ...)` block. It uses the existing `deps` stub (fake LLM + fake search), so no network or Ollama is involved. The `langsmithEndpoint` points at an unroutable local port so the langsmith client cannot send anything real; its failed uploads are logged as warnings, never thrown.

```ts
it("mirrors LangSmith options into process.env before running", async () => {
  const saved = {
    LANGSMITH_TRACING: process.env.LANGSMITH_TRACING,
    LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY,
    LANGSMITH_PROJECT: process.env.LANGSMITH_PROJECT,
    LANGSMITH_ENDPOINT: process.env.LANGSMITH_ENDPOINT,
  };
  try {
    await research(
      "t",
      {
        maxWebResearchLoops: 0,
        langsmithTracing: true,
        langsmithApiKey: "lsv2_test",
        langsmithEndpoint: "http://127.0.0.1:1",
      },
      {},
      deps,
    );
    expect(process.env.LANGSMITH_TRACING).toBe("true");
    expect(process.env.LANGSMITH_API_KEY).toBe("lsv2_test");
    expect(process.env.LANGSMITH_PROJECT).toBe("local-deep-researcher");
    expect(process.env.LANGSMITH_ENDPOINT).toBe("http://127.0.0.1:1");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

it("rejects langsmithTracing without an API key before running", async () => {
  await expect(research("t", { langsmithTracing: true }, {}, deps)).rejects.toThrow(
    /LANGSMITH_API_KEY/,
  );
});
```

Add the same two tests to the `describe` block covering `researchAgentic` (find it in the same file), replacing the `research(...)` call with `researchAgentic(...)` and using that block's existing agentic deps stub in place of `deps`. Keep the assertions identical.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/research.test.ts`
Expected: the validation tests PASS already (Task 1 wired `validateConfiguration`), but the two `mirrors LangSmith options` tests FAIL: `process.env.LANGSMITH_TRACING` is `undefined` because nothing maps config to env yet.

- [ ] **Step 3: Implement the wiring**

In `src/research.ts`, extend the configuration import:

```ts
import {
  applyTracingEnv,
  ConfigurationError,
  ensureConfiguration,
  validateConfiguration,
  type Configuration,
} from "./configuration";
```

In `research()`, directly after `validateConfiguration(cfg);`:

```ts
applyTracingEnv(cfg);
```

In `researchAgentic()`, directly after its `validateConfiguration(cfg);`:

```ts
applyTracingEnv(cfg);
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all files; the new env mutations are restored in `finally`, so no cross-test leakage).

- [ ] **Step 5: Typecheck, lint and propose commit**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

Propose this commit message to the user (do NOT commit):

```
feat: activate LangSmith tracing in research entrypoints (CLI, MCP, library)
```

---

### Task 4: Documentation, .env.example, changelog, version bump

**Files:**

- Modify: `README.md` (config table at lines 231-249; new section after line 251)
- Modify: `.env.example`
- Modify: `CHANGELOG.md` (new entry above `## [0.6.1]`)
- Modify: `package.json` (version field, line 3)

**Interfaces:**

- Consumes: env var names and defaults from Tasks 1-2.
- Produces: user-facing docs; version `0.7.0` (new feature, no breaking changes).

- [ ] **Step 1: Extend the README configuration table**

Add these rows to the table in `## Configuration` (after the `searxngUrl` row):

```markdown
| `langsmithTracing` | `LANGSMITH_TRACING` | `false` |
| `langsmithApiKey` | `LANGSMITH_API_KEY` | _(none, required if `langsmithTracing=true`)_ |
| `langsmithProject` | `LANGSMITH_PROJECT` | `local-deep-researcher` _(when tracing is enabled)_ |
| `langsmithEndpoint` | `LANGSMITH_ENDPOINT` | _(none, langsmith default endpoint)_ |
```

- [ ] **Step 2: Add a README "LangSmith tracing" section**

Insert after the `## Configuration` section (after the line `Copy .env.example to .env and adjust as needed.`), before `## Search providers`:

````markdown
## LangSmith tracing

Both research modes (workflow and agentic) can send full traces - every graph node, LLM call and
tool call - to [LangSmith](https://smith.langchain.com). Tracing is built into LangChain/LangGraph;
enabling it requires no code changes:

```bash
# .env
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...
# LANGSMITH_PROJECT=local-deep-researcher   # optional, this is the default
# LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com   # optional, self-hosted / EU region
```

With `npx`, either export the variables in your shell
(`LANGSMITH_TRACING=true LANGSMITH_API_KEY=lsv2_... npx @devs30/local-deep-researcher "topic"`)
or put them in a `.env` file in the directory you run the command from.

For the MCP server, pass them through the MCP client's `env` block, e.g. in `.mcp.json`:

```json
{
  "mcpServers": {
    "local-deep-researcher": {
      "command": "npx",
      "args": ["-y", "@devs30/local-deep-researcher", "mcp"],
      "env": {
        "LANGSMITH_TRACING": "true",
        "LANGSMITH_API_KEY": "lsv2_..."
      }
    }
  }
}
```

The same settings also work programmatically via the `options` argument
(`research(topic, { langsmithTracing: true, langsmithApiKey: "..." })`). When tracing is enabled
without an API key, the run fails fast with a configuration error. When it is disabled (the
default), no trace data leaves your machine.
````

- [ ] **Step 3: Extend `.env.example`**

Append at the end:

```bash

# LangSmith tracing (optional; when disabled, nothing leaves your machine)
# LANGSMITH_TRACING=true
# LANGSMITH_API_KEY=lsv2_...
# LANGSMITH_PROJECT=local-deep-researcher
# LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com
```

- [ ] **Step 4: CHANGELOG entry + version bump**

In `package.json`, change `"version": "0.6.1"` to `"version": "0.7.0"`.

In `CHANGELOG.md`, add above the `## [0.6.1]` entry:

```markdown
## [0.7.0] - 2026-07-12

### Added

- LangSmith tracing for both research modes via first-class config: `langsmithTracing`
  (`LANGSMITH_TRACING`), `langsmithApiKey` (`LANGSMITH_API_KEY`), `langsmithProject`
  (`LANGSMITH_PROJECT`, defaults to `local-deep-researcher` when tracing is enabled) and
  `langsmithEndpoint` (`LANGSMITH_ENDPOINT`). Values passed programmatically or via env are
  mirrored into `process.env` before the graph runs, so CLI, MCP server and library usage are
  all traced. Tracing enabled without an API key fails fast with a `ConfigurationError`;
  disabled tracing (the default) sends nothing
```

- [ ] **Step 5: Verify docs formatting and propose commit**

Run: `npm run lint`
Expected: no errors (prettier checks markdown too; run `npm run format` first if it complains).

Run: `npx vitest run`
Expected: PASS.

Propose this commit message to the user (do NOT commit):

```
docs: LangSmith tracing section, .env.example, changelog 0.7.0
```
