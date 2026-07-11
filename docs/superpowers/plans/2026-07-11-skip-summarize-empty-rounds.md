# Skip Summarize on Empty Rounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empty rounds (no sources kept) route from `gradeSources` straight to `reflectOnSummary` (no summarize LLM call), and reflection receives the list of failed queries with a do-not-repeat instruction.

**Architecture:** New state fields `lastRoundEmpty: boolean` (overwrite) and `failedQueries: string[]` (concat), both written by `gradeSources` in its two paths. The unconditional `gradeSources -> summarizeSources` edge becomes a conditional `routeAfterGrading`. `reflectOnSummary` and `finalizeSummary` guard `state.runningSummary ?? ""` because a summary may not exist yet (round 1 empty) or ever (all rounds empty). `reflectionInstructions` gains an optional `failedQueries` parameter rendering a `<FAILED_QUERIES>` block.

**Tech Stack:** TypeScript, LangGraph.js, Vitest (`FakeListChatModel`), existing `buildGraph(overrides)` dependency injection.

**Spec:** `docs/superpowers/specs/2026-07-11-skip-summarize-empty-rounds-design.md`

## Global Constraints

- NO GIT COMMITS by the implementer - end each task with a clean verification run and report a PROPOSED commit message; the user commits between tasks. Do not run `git commit`, `git tag`, or `git push` under any circumstances. Stage nothing.
- Empty round definition matches v0.4.0 exactly: enabled path `kept.length === 0`, pass-through path `results.length === 0` (the inverse of the productive-round increment).
- With no failed queries, `reflectionInstructions` output must be byte-identical to the current prompt.
- Empty rounds append NOTHING to `webResearchResults`; productive rounds behave exactly as today.
- `researchLoopCount`, `productiveLoopCount`, routing budget/cap logic (`routeResearch`) are untouched.
- Never use the em-dash character in any prose; only plain "-".
- Test commands: `npx vitest run tests/<file>.test.ts` per task; `npm run typecheck && npm test && npm run lint` at the end of every task (no commit follows, so the full gate is each task's exit criterion).

---

### Task 1: Skip routing, state fields, summary guards

**Files:**

- Modify: `src/state.ts`
- Modify: `src/graph.ts` (`gradeSources` both return blocks at lines 104-111 and 160-168; `reflectOnSummary` human message around line 199; `finalizeSummary` template around line 218; wiring block at the bottom)
- Test: `tests/graph.test.ts`

**Interfaces:**

- Consumes: existing state (`pendingResults`, `searchQuery`, `productiveLoopCount`), `gradeSources`, graph wiring.
- Produces: state fields `lastRoundEmpty: boolean` (overwrite, default `false`) and `failedQueries: string[]` (concat, default `[]`); routing function `routeAfterGrading`; `runningSummary ?? ""` guards. Task 2 relies on `state.failedQueries` being populated.

- [ ] **Step 1: Update the four affected "loop budget" test scripts**

Node-execution order changes on empty rounds: `summarizeSources` drops out, so the shared `FakeListChatModel` scripts consume responses in a new order (`generateQuery`, then per round: grader responses for surviving sources, then summarize ONLY if the round kept something, then reflect). Update these tests in `tests/graph.test.ts` (assertions stay untouched):

1. `"does not charge the budget for a round rejected by grading"` - new responses array:

```ts
      responses: [
        '{"query": "q1", "rationale": "r"}',
        '{"relevant": "no", "reason": "junk"}', // round 1: rejected -> skip summarize
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
        '{"relevant": "yes", "reason": "ok"}', // round 2: productive
        "A summary.",
        '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
      ],
```

2. `"exits cleanly at the hard cap when every round is empty"` - new responses array:

```ts
      responses: [
        '{"query": "q1", "rationale": "r"}',
        '{"relevant": "no", "reason": "junk"}', // round 1: empty -> skip summarize
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
        '{"relevant": "no", "reason": "junk"}', // round 2: empty (cap = 2 for max=0)
        '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
      ],
```

3. `"countEmptyLoops=true restores v0.2.x counting"` - new responses array:

```ts
      responses: [
        '{"query": "q1", "rationale": "r"}',
        '{"relevant": "no", "reason": "junk"}',
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
      ],
```

4. `"gives a failing search a free retry when grading is disabled"` - new responses array (round 1 has no grader call and no summarize; round 2 summarizes then reflects):

```ts
      responses: [
        '{"query": "q1", "rationale": "r"}',
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
        "A better summary.",
        '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
      ],
```

- [ ] **Step 2: Add the new failing tests**

Append inside the `describe("loop budget", ...)` block (it already defines `uniqueUrlSearch`):

```ts
it("skips summarizeSources on an empty round", async () => {
  const llm = new FakeListChatModel({
    responses: [
      '{"query": "q1", "rationale": "r"}',
      '{"relevant": "no", "reason": "junk"}',
      '{"knowledge_gap": "g", "follow_up_query": "q2"}',
      '{"relevant": "yes", "reason": "ok"}',
      "A summary.",
      '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
    ],
  });
  let llmNodes = 0;
  const graph = buildGraph({
    getLlm: () => {
      llmNodes++;
      return llm;
    },
    getSearchProvider: () => uniqueUrlSearch,
    retryDelayMs: 0,
    warn: () => {},
  });
  const state = await graph.invoke(
    { researchTopic: "t" },
    { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
  );
  // generateQuery + (grade, reflect) for the empty round + (grade, summarize, reflect)
  // for the productive one = 6 LLM-using node executions; 7 would mean summarize ran
  // on the empty round.
  expect(llmNodes).toBe(6);
  expect(state.lastRoundEmpty).toBe(false);
  expect(state.failedQueries).toEqual(["q1"]);
});

it("produces an honestly empty report when every round is empty", async () => {
  const llm = new FakeListChatModel({
    responses: [
      '{"query": "q1", "rationale": "r"}',
      '{"relevant": "no", "reason": "junk"}',
      '{"knowledge_gap": "g", "follow_up_query": "q2"}',
      '{"relevant": "no", "reason": "junk"}',
      '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
    ],
  });
  let llmNodes = 0;
  const graph = buildGraph({
    getLlm: () => {
      llmNodes++;
      return llm;
    },
    getSearchProvider: () => uniqueUrlSearch,
    retryDelayMs: 0,
    warn: () => {},
  });
  const state = await graph.invoke(
    { researchTopic: "t" },
    { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
  );
  // generateQuery + 2 x (grade, reflect); no summarize ever ran.
  expect(llmNodes).toBe(5);
  // The summary was never written by an LLM: no hallucinated content.
  expect(state.runningSummary.startsWith("## Summary")).toBe(true);
  expect(state.runningSummary).not.toContain("A summary");
  expect(state.failedQueries).toEqual(["q1", "q2"]);
  expect(state.lastRoundEmpty).toBe(true);
  expect(state.webResearchResults).toHaveLength(0);
});
```

- [ ] **Step 3: Run tests to verify the state of the world**

Run: `npx vitest run tests/graph.test.ts`
Expected: the 2 new tests FAIL (`lastRoundEmpty`/`failedQueries` undefined; llmNodes counts include summarize on empty rounds). Rewritten scripts 1, 2 and 4 also FAIL for now (their responses assume the skip). Rewritten script 3 (`countEmptyLoops=true`) still PASSES - it is a script alignment, not a behavior probe; that is expected, do not stop on it. Pre-existing non-loop-budget tests still PASS.

- [ ] **Step 4: Implement**

In `src/state.ts`, add after `productiveLoopCount`:

```ts
  lastRoundEmpty: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
  failedQueries: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
```

In `src/graph.ts`, replace the pass-through return of `gradeSources` (lines 104-111) with:

```ts
const passThroughEmpty = results.length === 0;
return {
  pendingResults: [],
  lastRoundEmpty: passThroughEmpty,
  failedQueries: passThroughEmpty ? [state.searchQuery] : [],
  sourcesGathered: results.length > 0 ? [formatSources(results)] : [],
  webResearchResults: passThroughEmpty
    ? []
    : [deduplicateAndFormatSources(results, MAX_TOKENS_PER_SOURCE, cfg.fetchFullPage)],
  productiveLoopCount: state.productiveLoopCount + (passThroughEmpty ? 0 : 1),
};
```

Replace the enabled-path return (lines 160-168) with:

```ts
const roundEmpty = kept.length === 0;
return {
  pendingResults: [],
  gradedUrls: results.map((r) => r.url),
  lastRoundEmpty: roundEmpty,
  failedQueries: roundEmpty ? [state.searchQuery] : [],
  sourcesGathered: roundEmpty ? [] : [formatSources(kept)],
  webResearchResults: roundEmpty
    ? []
    : [deduplicateAndFormatSources(kept, MAX_TOKENS_PER_SOURCE, cfg.fetchFullPage)],
  productiveLoopCount: state.productiveLoopCount + (roundEmpty ? 0 : 1),
};
```

In `reflectOnSummary`, guard the summary interpolation (the human message): replace `${state.runningSummary}` with `${state.runningSummary ?? ""}`.

In `finalizeSummary`, replace `${state.runningSummary}` with `${state.runningSummary ?? ""}` in the template string.

Add the routing function next to `routeResearch`:

```ts
function routeAfterGrading(state: SummaryState): "summarizeSources" | "reflectOnSummary" {
  // Empty rounds have nothing to fold into the summary - go straight to reflection.
  return state.lastRoundEmpty ? "reflectOnSummary" : "summarizeSources";
}
```

In the wiring block, replace `.addEdge("gradeSources", "summarizeSources")` with:

```ts
    .addConditionalEdges("gradeSources", routeAfterGrading, [
      "summarizeSources",
      "reflectOnSummary",
    ])
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/graph.test.ts`
Expected: PASS (all tests in file, including the 4 rewritten scripts and 2 new tests).

- [ ] **Step 6: Full gate + hand off for commit**

Run: `npm run typecheck && npm test && npm run lint` - expected: all clean.
Do NOT commit. Report the changed files (`src/state.ts`, `src/graph.ts`, `tests/graph.test.ts`) and this proposed commit message:

```
feat: skip summarize on empty rounds, route straight to reflection
```

---

### Task 2: Failed-queries context for reflection

**Files:**

- Modify: `src/prompts.ts` (`reflectionInstructions` at lines 73-85)
- Modify: `src/graph.ts` (`reflectOnSummary` system message)
- Test: `tests/prompts.test.ts`, `tests/graph.test.ts`

**Interfaces:**

- Consumes: `state.failedQueries` (Task 1).
- Produces: `reflectionInstructions(params: { researchTopic: string; failedQueries?: string[] }): string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/prompts.test.ts` (follow the file's existing import style):

```ts
describe("reflectionInstructions failed queries", () => {
  it("is unchanged when no failed queries are given", () => {
    const base = prompts.reflectionInstructions({ researchTopic: "t" });
    const withEmpty = prompts.reflectionInstructions({ researchTopic: "t", failedQueries: [] });
    expect(withEmpty).toBe(base);
    expect(base).not.toContain("FAILED_QUERIES");
  });

  it("lists failed queries with a do-not-repeat instruction", () => {
    const text = prompts.reflectionInstructions({
      researchTopic: "t",
      failedQueries: ["quantum cats", "qubit dogs"],
    });
    expect(text).toContain("<FAILED_QUERIES>");
    expect(text).toContain("quantum cats");
    expect(text).toContain("qubit dogs");
    expect(text.toLowerCase()).toContain("do not repeat");
  });
});
```

Append inside the `describe("loop budget", ...)` block in `tests/graph.test.ts` (recording-wrapper pattern: the graph calls `llm.invoke(messages)`, so wrap a real fake and capture the system prompts):

```ts
it("passes failed queries to the reflection prompt", async () => {
  const inner = new FakeListChatModel({
    responses: [
      '{"query": "q1", "rationale": "r"}',
      '{"relevant": "no", "reason": "junk"}',
      '{"knowledge_gap": "g", "follow_up_query": "q2"}',
      '{"relevant": "yes", "reason": "ok"}',
      "A summary.",
      '{"knowledge_gap": "g2", "follow_up_query": "q3"}',
    ],
  });
  const systemPrompts: string[] = [];
  const recordingLlm = {
    invoke: async (messages: Array<{ content: unknown }>) => {
      systemPrompts.push(String(messages[0]?.content ?? ""));
      return inner.invoke(messages as never);
    },
  } as unknown as ReturnType<typeof fakeLlm>;
  const graph = buildGraph({
    getLlm: () => recordingLlm,
    getSearchProvider: () => uniqueUrlSearch,
    retryDelayMs: 0,
    warn: () => {},
  });
  await graph.invoke(
    { researchTopic: "t" },
    { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
  );
  // The reflection after the empty round 1 must see the failed query "q1".
  const reflectionPrompts = systemPrompts.filter((p) => p.includes("expert research assistant"));
  expect(reflectionPrompts.length).toBeGreaterThan(0);
  expect(reflectionPrompts[0]).toContain("<FAILED_QUERIES>");
  expect(reflectionPrompts[0]).toContain("q1");
});
```

(If `fakeLlm` is not in scope for the cast, cast to `BaseChatModel` via the existing import used by the throwing-LLM test instead.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/prompts.test.ts tests/graph.test.ts`
Expected: the 3 new tests FAIL (no `failedQueries` param; no `<FAILED_QUERIES>` block in the reflect system prompt).

- [ ] **Step 3: Implement**

In `src/prompts.ts`, replace `reflectionInstructions` with:

```ts
export function reflectionInstructions(params: {
  researchTopic: string;
  failedQueries?: string[];
}): string {
  const failed = params.failedQueries ?? [];
  const failedBlock =
    failed.length > 0
      ? `

<FAILED_QUERIES>
These queries returned no usable sources:
${failed.map((query) => `- ${query}`).join("\n")}
Propose a meaningfully different follow-up query. Do not repeat them.
</FAILED_QUERIES>`
      : "";
  return `You are an expert research assistant analyzing a summary about ${params.researchTopic}.

<GOAL>
1. Identify knowledge gaps or areas that need deeper exploration
2. Generate a follow-up question that would help expand your understanding
3. Focus on technical details, implementation specifics, or emerging trends that weren't fully covered
</GOAL>

<REQUIREMENTS>
Ensure the follow-up question is self-contained and includes necessary context for web search.
</REQUIREMENTS>${failedBlock}`;
}
```

In `src/graph.ts` `reflectOnSummary`, pass the list:

```ts
          new SystemMessage(
            prompts.reflectionInstructions({
              researchTopic: state.researchTopic,
              failedQueries: state.failedQueries,
            }),
          ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/prompts.test.ts tests/graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + hand off for commit**

Run: `npm run typecheck && npm test && npm run lint` - expected: all clean.
Do NOT commit. Report the changed files (`src/prompts.ts`, `src/graph.ts`, `tests/prompts.test.ts`, `tests/graph.test.ts`) and this proposed commit message:

```
feat: reflection sees failed queries after empty rounds
```

---

### Task 3: Documentation + final verification

**Files:**

- Modify: `README.md` (loop/flow description)
- Modify: `CHANGELOG.md` (new `## [Unreleased]` section above `## [0.4.0]`)

**Interfaces:**

- Consumes: everything above. No code changes. Release (version bump + tag) is the user's separate decision (suggested: 0.5.0).

- [ ] **Step 1: Update README**

In the research-loop description (the numbered flow section), extend the sentence about empty rounds: empty rounds skip the summarize step entirely and go straight to reflection, which receives the list of queries that returned nothing and is instructed not to repeat them; a run where every round is empty produces an honestly empty report instead of a summary hallucinated from empty context.

- [ ] **Step 2: Update CHANGELOG.md**

Add above `## [0.4.0]`:

```markdown
## [Unreleased]

### Changed

- Empty rounds no longer invoke the summarizer on an empty context: `gradeSources`
  routes them straight to reflection, and the reflection prompt lists the queries that
  returned nothing with a do-not-repeat instruction. A fully empty run now produces an
  honestly empty report instead of a summary hallucinated from empty context
```

The `[unreleased]` link reference at the bottom already points at `compare/v0.4.0...HEAD` - leave it.

- [ ] **Step 3: Final verification + hand off for commit**

Run: `npm run typecheck && npm test && npm run lint` - expected: all clean (run `npm run format` on touched files if prettier complains, then re-check).
Do NOT commit. Report the changed files (`README.md`, `CHANGELOG.md`) and this proposed commit message:

```
docs: document empty-round summarize skip and failed-query reflection
```
