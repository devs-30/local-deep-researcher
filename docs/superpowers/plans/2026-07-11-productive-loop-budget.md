# Productive Loop Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only productive rounds (at least one kept source) consume the `maxWebResearchLoops` budget; empty rounds get free retries bounded by a hard cap of `2 * (maxWebResearchLoops + 1)` total rounds; `countEmptyLoops=true` restores the v0.2.x counting.

**Architecture:** `researchLoopCount` keeps meaning "total attempts" (incremented in `webResearch`). A new state field `productiveLoopCount` (overwrite reducer) is incremented by `gradeSources` when a round keeps at least one source. `routeResearch` checks the hard cap first (total attempts), then the budget using `productiveLoopCount` by default or `researchLoopCount` when `countEmptyLoops=true`. The cap exit is clean (route to `finalizeSummary`, never a throw).

**Tech Stack:** TypeScript, LangGraph.js, Zod config, Vitest (`FakeListChatModel`), existing `buildGraph(overrides)` dependency injection.

**Spec:** `docs/superpowers/specs/2026-07-11-productive-loop-budget-design.md`

## Global Constraints

- Port-fidelity `<=` preserved: budget `N` means `N + 1` productive rounds.
- Hard cap: `2 * (maxWebResearchLoops + 1)` total rounds, non-configurable, checked BEFORE the budget in `routeResearch`; hitting it routes to `finalizeSummary` (never an exception).
- `countEmptyLoops: boolean`, default `false`, env `COUNT_EMPTY_LOOPS`, CLI `--count-empty-loops`, MCP `count_empty_loops`; `true` must reproduce v0.2.x counting exactly.
- "Productive" = the round kept >= 1 source: enabled path `kept.length > 0`; pass-through path `pendingResults.length > 0`.
- `researchLoopCount` semantics unchanged (total attempts, incremented in `webResearch`); the `SearchFailedError` guard is unchanged.
- `recursionLimit` in `research.ts` becomes `20 + cfg.maxWebResearchLoops * 10` so the cap always fires before LangGraph's recursion limit.
- Never use the em-dash character in any prose you write (docs, comments, commit messages); use plain "-".
- Test commands: `npx vitest run tests/<file>.test.ts` per task; `npm test` (full suite) before each commit; `npm run typecheck && npm test && npm run lint` in the final task.
- Commit style: conventional commits, each ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Configuration field `countEmptyLoops`

**Files:**

- Modify: `src/configuration.ts` (schema fields around lines 29-31, `ENV_KEYS` around lines 48-50)
- Test: `tests/configuration.test.ts`

**Interfaces:**

- Consumes: existing `ConfigurationSchema`, `boolFromString`, `ENV_KEYS`.
- Produces: `Configuration.countEmptyLoops: boolean` (default `false`, env `COUNT_EMPTY_LOOPS`). Later tasks read it via `ensureConfiguration`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` in `tests/configuration.test.ts`. Also add `COUNT_EMPTY_LOOPS` to the `MANAGED_ENV` list at the top of the file (required for env isolation, same as `GRADE_SOURCES`).

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/configuration.test.ts`
Expected: 2 new tests FAIL (`cfg.countEmptyLoops` is `undefined`).

- [ ] **Step 3: Implement**

In `src/configuration.ts`, add to `ConfigurationSchema` (after `sourceDomainBlocklist`):

```ts
  countEmptyLoops: boolFromString.default(false),
```

Add to `ENV_KEYS`:

```ts
  countEmptyLoops: "COUNT_EMPTY_LOOPS",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/configuration.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` - expected: all tests pass.

```bash
git add src/configuration.ts tests/configuration.test.ts
git commit -m "feat: add countEmptyLoops configuration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Productive counter + two-step routing

**Files:**

- Modify: `src/state.ts` (add one field)
- Modify: `src/graph.ts` (`gradeSources` returns at lines 104-110 and 159-166; `routeResearch` at lines 220-227)
- Test: `tests/graph.test.ts`

**Interfaces:**

- Consumes: `Configuration.countEmptyLoops` (Task 1); existing state fields `researchLoopCount`, `pendingResults`.
- Produces: state field `productiveLoopCount: number` (overwrite reducer, default `0`); routing behavior relied on by Tasks 3-6.

- [ ] **Step 1: Write the failing tests**

Append a new describe block to `tests/graph.test.ts`. Response-ordering convention (shared `FakeListChatModel` consumes responses in node-execution order): `generateQuery`, then per round: one grader response per surviving source, `summarizeSources`, `reflectOnSummary`. Reflection responses provide distinct `follow_up_query` values so each round searches a different URL (the cross-loop dedup heuristic would otherwise turn later rounds empty).

```ts
describe("loop budget", () => {
  const uniqueUrlSearch: SearchProvider = async (query) => [
    {
      title: `Result for ${query}`,
      url: `https://example.com/${encodeURIComponent(query)}`,
      content: `A long, substantive snippet about ${query} that clears the thin-content bar.`,
    },
  ];

  it("does not charge the budget for a round rejected by grading", async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q1", "rationale": "r"}',
        '{"relevant": "no", "reason": "junk"}', // round 1: rejected -> free
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
        '{"relevant": "yes", "reason": "ok"}', // round 2: productive
        "A better summary.",
        '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
      ],
    });
    const warn = vi.fn();
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => uniqueUrlSearch,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    // Budget 0 = 1 productive round; the rejected round was a free retry.
    expect(state.researchLoopCount).toBe(2);
    expect(state.productiveLoopCount).toBe(1);
    expect(state.sourcesGathered).toHaveLength(1);
    expect(state.sourcesGathered.join("\n")).toContain("q2");
  });

  it("exits cleanly at the hard cap when every round is empty", async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q1", "rationale": "r"}',
        '{"relevant": "no", "reason": "junk"}', // round 1
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
        '{"relevant": "no", "reason": "junk"}', // round 2 (cap = 2 for max=0)
        "A summary again.",
        '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
      ],
    });
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => uniqueUrlSearch,
      retryDelayMs: 0,
      warn: () => {},
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    expect(state.researchLoopCount).toBe(2); // 2 * (0 + 1)
    expect(state.productiveLoopCount).toBe(0);
    expect(state.sourcesGathered).toHaveLength(0);
    expect(state.runningSummary).toContain("## Summary");
  });

  it("countEmptyLoops=true restores v0.2.x counting", async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q1", "rationale": "r"}',
        '{"relevant": "no", "reason": "junk"}',
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
      ],
    });
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => uniqueUrlSearch,
      retryDelayMs: 0,
      warn: () => {},
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0, countEmptyLoops: true }, recursionLimit: 50 },
    );
    // Old semantics: the empty round consumed the whole budget.
    expect(state.researchLoopCount).toBe(1);
    expect(state.sourcesGathered).toHaveLength(0);
  });

  it("gives a failing search a free retry when grading is disabled", async () => {
    let call = 0;
    const flakySearch: SearchProvider = async (query) => {
      call++;
      if (call === 1) throw new Error("network down");
      return uniqueUrlSearch(query, undefined as never);
    };
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q1", "rationale": "r"}',
        "A summary.", // round 1 (empty round: summarize + reflect still run)
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
        "A better summary.", // round 2
        '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
      ],
    });
    const warn = vi.fn();
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => flakySearch,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      // Seeded source keeps the SearchFailedError guard from hard-failing round 1.
      { researchTopic: "t", sourcesGathered: ["* Seed : https://seed.example"] },
      { configurable: { maxWebResearchLoops: 0, gradeSources: false }, recursionLimit: 50 },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Web search failed"));
    expect(state.researchLoopCount).toBe(2);
    expect(state.productiveLoopCount).toBe(1);
    expect(state.sourcesGathered.join("\n")).toContain("q2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph.test.ts`
Expected: the 4 new tests FAIL (`productiveLoopCount` undefined; old routing charges empty rounds). All pre-existing tests still PASS.

- [ ] **Step 3: Implement**

In `src/state.ts`, add after `researchLoopCount`:

```ts
  productiveLoopCount: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
```

In `src/graph.ts`, extend the pass-through return of `gradeSources` (lines 104-110) with:

```ts
        productiveLoopCount: state.productiveLoopCount + (results.length > 0 ? 1 : 0),
```

Extend the enabled-path return (lines 159-166) with:

```ts
      productiveLoopCount: state.productiveLoopCount + (kept.length > 0 ? 1 : 0),
```

Replace the body of `routeResearch` (lines 220-227):

```ts
function routeResearch(
  state: SummaryState,
  config?: RunnableConfig,
): "webResearch" | "finalizeSummary" {
  const cfg = ensureConfiguration(config);
  // Hard cap on total rounds (productive + empty) so free retries can never loop forever.
  if (state.researchLoopCount >= 2 * (cfg.maxWebResearchLoops + 1)) return "finalizeSummary";
  // Port fidelity: <= means max=N yields N+1 productive rounds, matching the original.
  const spent = cfg.countEmptyLoops ? state.researchLoopCount : state.productiveLoopCount;
  return spent <= cfg.maxWebResearchLoops ? "webResearch" : "finalizeSummary";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph.test.ts`
Expected: PASS, including all pre-existing tests. Note: the pre-existing test "continues with a warning when search fails but sources exist" now runs 2 rounds instead of 1 (the empty round is free and the cap is 2); its assertions do not depend on round count, so it stays green.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` - expected: all tests pass (see the Task 3 note if `tests/research.test.ts` shows timing growth; assertions there do not depend on round counts).

```bash
git add src/state.ts src/graph.ts tests/graph.test.ts
git commit -m "feat: charge loop budget only for productive rounds, hard-capped retries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: recursionLimit headroom + end-to-end all-empty test

**Files:**

- Modify: `src/research.ts` (line 59)
- Test: `tests/research.test.ts`

**Interfaces:**

- Consumes: routing behavior from Task 2; existing `research(topic, options, hooks, deps)` signature (4th param injects `GraphDeps`).
- Produces: `recursionLimit: 20 + cfg.maxWebResearchLoops * 10`.

- [ ] **Step 1: Write the failing test**

Append to `tests/research.test.ts` (follow the file's existing import style; it already imports `research` and `FakeListChatModel`):

```ts
it("completes an all-empty run at the hard cap without hitting the recursion limit", async () => {
  // Every getLlm call returns a fresh fake whose single response is a "no" verdict.
  // generateQuery/reflect fall back (topic / "Tell me more..."), the grader rejects
  // round 1, and later rounds die on cross-loop dedup - so every round is empty.
  const report = await research(
    "empty topic",
    // max=4: cap = 10 rounds = 42 supersteps; fails the old limit (40), fits the new (60).
    { maxWebResearchLoops: 4 },
    {},
    {
      getLlm: () => new FakeListChatModel({ responses: ['{"relevant": "no", "reason": "junk"}'] }),
      getSearchProvider: () => async () => [
        {
          title: "Same page",
          url: "https://same.example/page",
          content: "A long, substantive snippet that clears the thin-content bar easily.",
        },
      ],
      retryDelayMs: 0,
      warn: () => {},
    },
  );
  // Cap = 2 * (4 + 1) = 10 rounds, all empty: report exists, bibliography is empty.
  expect(report.sources).toHaveLength(0);
  expect(report.markdown).toContain("## Summary");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/research.test.ts`
Expected: the new test FAILS with `GraphRecursionError`: the all-empty run needs 1 + 10 x 4 + 1 = 42 supersteps, above the old limit `20 + 4 * 5 = 40` (and within the new `20 + 4 * 10 = 60`).

- [ ] **Step 3: Implement**

In `src/research.ts` line 59, change:

```ts
      recursionLimit: 20 + cfg.maxWebResearchLoops * 5,
```

to:

```ts
      recursionLimit: 20 + cfg.maxWebResearchLoops * 10,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/research.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` - expected: all tests pass.

```bash
git add src/research.ts tests/research.test.ts
git commit -m "feat: recursion-limit headroom for hard-capped free retries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: CLI flag `--count-empty-loops`

**Files:**

- Modify: `src/cli-args.ts` (options object, configurable mapping, HELP text, Environment line)
- Test: `tests/cli-args.test.ts`

**Interfaces:**

- Consumes: config key `countEmptyLoops` (Task 1).
- Produces: CLI flag `--count-empty-loops` mapped into `options.configurable`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/cli-args.test.ts`:

```ts
it("maps --count-empty-loops into configurable", () => {
  const cmd = parseCliArgs(["topic", "--count-empty-loops"]);
  expect(cmd.kind).toBe("research");
  if (cmd.kind !== "research") return;
  expect(cmd.options.configurable.countEmptyLoops).toBe(true);
});

it("omits countEmptyLoops when the flag is absent", () => {
  const cmd = parseCliArgs(["topic"]);
  expect(cmd.kind).toBe("research");
  if (cmd.kind !== "research") return;
  expect("countEmptyLoops" in cmd.options.configurable).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli-args.test.ts`
Expected: FAIL (`parseArgs` throws on the unknown option).

- [ ] **Step 3: Implement**

In `src/cli-args.ts`, add to the `options` object (after `blocklist`):

```ts
      "count-empty-loops": { type: "boolean" },
```

Add to the configurable mapping (after the `blocklist` line):

```ts
if (values["count-empty-loops"]) configurable.countEmptyLoops = true;
```

Add to `HELP` after the `--blocklist` line:

```
  --count-empty-loops    Empty rounds (no sources kept) also consume the loop budget (v0.2.x behavior)
```

Extend the `Environment:` line with `COUNT_EMPTY_LOOPS`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli-args.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` - expected: all tests pass.

```bash
git add src/cli-args.ts tests/cli-args.test.ts
git commit -m "feat: --count-empty-loops CLI flag

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: MCP tool input `count_empty_loops`

**Files:**

- Modify: `src/mcp.ts` (inputSchema, handler destructuring, configurable mapping)
- Test: `tests/mcp.test.ts`

**Interfaces:**

- Consumes: config key `countEmptyLoops` (Task 1); existing `connectedClient(deps)` helper and `fakeResearch` stub in the test file.
- Produces: optional MCP input `count_empty_loops: boolean` on the `deep_research` tool.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("MCP server", ...)` block in `tests/mcp.test.ts` (the file already imports `vi` and defines `connectedClient` / `fakeResearch`):

```ts
it("forwards count_empty_loops to the research configurable", async () => {
  const spy = vi.fn(fakeResearch);
  const client = await connectedClient({ researchFn: spy, preflight: async () => {} });
  await client.callTool({
    name: "deep_research",
    arguments: { topic: "t", count_empty_loops: true },
  });
  expect(spy).toHaveBeenCalledWith(
    "t",
    expect.objectContaining({ countEmptyLoops: true }),
    expect.anything(),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp.test.ts`
Expected: new test FAILS (unknown input key not forwarded).

- [ ] **Step 3: Implement**

In `src/mcp.ts`, extend `inputSchema` (after `source_domain_blocklist`):

```ts
        count_empty_loops: z
          .boolean()
          .optional()
          .describe("Empty rounds also consume the loop budget (default false)"),
```

Extend the handler destructuring with `count_empty_loops` and the mapping:

```ts
if (count_empty_loops !== undefined) configurable.countEmptyLoops = count_empty_loops;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` - expected: all tests pass.

```bash
git add src/mcp.ts tests/mcp.test.ts
git commit -m "feat: expose count_empty_loops via MCP

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation + final verification

**Files:**

- Modify: `README.md` (configuration table, CLI options table, loop/flow description)
- Modify: `CHANGELOG.md` (new `## [Unreleased]` section above `## [0.2.1]`)
- Modify: `.env.example`

**Interfaces:**

- Consumes: everything above. No code changes. Release itself (version bump + tag) is NOT part of this plan; the user decides separately (target: 0.3.0).

- [ ] **Step 1: Update README**

1. In the flow/loop description (the numbered research-loop section), update the routing sentence to say: the budget counts only productive rounds (at least one source kept); empty rounds (all rejected or failed search) retry for free with a new query, up to a hard cap of `2 * (maxWebResearchLoops + 1)` total rounds; `--count-empty-loops` restores the previous counting. Also note that MCP progress `loop` counts attempts and can exceed `total` when free retries happen.
2. CLI options table - add row (match column formatting):

```markdown
| `--count-empty-loops` | Empty rounds (no sources kept) also consume the loop budget (v0.2.x behavior) |
```

3. Configuration table - add row:

```markdown
| `countEmptyLoops` | `COUNT_EMPTY_LOOPS` | `false` |
```

- [ ] **Step 2: Update CHANGELOG.md**

Add above `## [0.2.1]`:

```markdown
## [Unreleased]

### Changed

- Research-loop budget now counts only productive rounds (at least one source kept after
  grading). Empty rounds (all sources rejected or a failed search) get free retries with a
  fresh query, bounded by a hard cap of `2 * (maxWebResearchLoops + 1)` total rounds.
  **Behavior change vs 0.2.x:** restore the old counting with `--count-empty-loops` /
  `COUNT_EMPTY_LOOPS=true` / `countEmptyLoops: true`
```

- [ ] **Step 3: Update .env.example**

Add after the `SOURCE_DOMAIN_BLOCKLIST` entry, matching the file's comment style:

```bash
# Empty rounds (no sources kept) also consume the loop budget (v0.2.x behavior; default false)
# COUNT_EMPTY_LOOPS=true
```

- [ ] **Step 4: Final verification**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all clean (run `npm run format` first if prettier complains about touched files, then re-run lint).

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md .env.example
git commit -m "docs: document productive loop budget and countEmptyLoops flag

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
