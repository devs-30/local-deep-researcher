# Productive Loop Budget - Design

**Date:** 2026-07-11
**Status:** Approved for implementation planning

## Problem

Since v0.2.0 the `gradeSources` node can reject a whole round of search results. Such a
round still increments `researchLoopCount` (in `webResearch`), so it permanently consumes
one iteration of the `maxWebResearchLoops` budget. In the worst case (overbroad blocklist,
flaky search, over-strict grader) every round is empty and the final report contains no
sources even though the loop "ran out" of budget.

## Goal

Only productive rounds consume the research-loop budget. A round is **productive** when it
contributes at least one kept source (after grading; in pass-through mode: when search
returned anything). A dedicated flag restores the current counting. A hard cap bounds the
total number of rounds so the loop can never run forever.

## Decisions (from brainstorming)

| Decision              | Choice                                                                               |
| --------------------- | ------------------------------------------------------------------------------------ |
| Which rounds are free | Every empty round, regardless of cause (grading rejected all OR search failed/empty) |
| Flag                  | `countEmptyLoops` (default `false`); `true` restores the v0.2.0 counting             |
| Hard cap              | `2 * (maxWebResearchLoops + 1)` total rounds, non-configurable formula               |
| Cap exit              | Clean: route to `finalizeSummary`, never an exception                                |

## Semantics

- Port-fidelity `<=` is preserved: budget `N` means `N + 1` **productive** rounds.
- `researchLoopCount` keeps its current meaning: total attempts, incremented in
  `webResearch` every round (feeds the Perplexity loop label and progress events).
- New state field `productiveLoopCount` (overwrite reducer, default `0`): `gradeSources`
  increments it by 1 when the round kept at least one source. In the disabled
  (`gradeSources=false`) pass-through path: when `pendingResults.length > 0`.
- `routeResearch` decides in two steps:
  1. Hard cap first: `researchLoopCount >= 2 * (maxWebResearchLoops + 1)` ->
     `finalizeSummary`.
  2. Budget: counter is `countEmptyLoops ? researchLoopCount : productiveLoopCount`;
     continue while `counter <= maxWebResearchLoops`.
- With `countEmptyLoops=true` the behavior is exactly v0.2.0: the budget check uses
  `researchLoopCount` as today, and the cap can never fire first because
  `researchLoopCount <= max < 2 * (max + 1)` holds whenever the budget allows another
  round.
- The `SearchFailedError` guard in `webResearch` is unchanged (still hard-fails when
  search throws and nothing was ever kept).
- Full upstream-identical behavior: `countEmptyLoops=true` + `gradeSources=false`.

## Configuration

One new `ConfigurationSchema` field (+ env, CLI, MCP):

| Field             | Type    | Default | Env                 | CLI                   | MCP                 |
| ----------------- | ------- | ------- | ------------------- | --------------------- | ------------------- |
| `countEmptyLoops` | boolean | `false` | `COUNT_EMPTY_LOOPS` | `--count-empty-loops` | `count_empty_loops` |

The hard-cap formula is internal and not configurable (YAGNI).

## Limits and progress

- `recursionLimit` in `research.ts` grows from `20 + 5 * max` to `20 + 10 * max`
  (worst case: `2 * (max + 1)` rounds x 4 nodes + generateQuery + finalizeSummary).
  The hard cap therefore always fires before LangGraph's recursion limit; a
  `GraphRecursionError` can no longer be the normal all-empty exit.
- Progress reporting is unchanged: `ProgressEvent.loop` = attempt number
  (`researchLoopCount`). With free retries it can exceed `maxWebResearchLoops + 1`
  (the MCP `total`); this is known and intended, documented in README.

## Testing

Graph-level via existing `buildGraph({ getLlm, getSearchProvider })` injection:

- Empty round consumes no budget: grader says "no" to everything in round 1, "yes"
  later -> the run still achieves `max + 1` productive rounds and the summary contains
  the kept sources.
- All-empty run exits cleanly at the cap: exactly `2 * (max + 1)` attempts
  (`researchLoopCount`), `finalizeSummary` reached, no throw.
- `countEmptyLoops=true` restores v0.2.0 counting: parity with the existing
  "loops maxWebResearchLoops+1 times" expectations (`researchLoopCount == max + 1`).
- Failing search with grading disabled also gets free retries (empty rounds do not
  consume budget in pass-through mode either).
- `research()` end-to-end on an all-empty scenario completes within the new
  `recursionLimit` (no `GraphRecursionError`).

## Docs and versioning

- README: configuration table row, CLI options row, loop description (budget = productive
  rounds, hard cap formula, how to restore old counting), note that MCP progress `loop`
  can exceed `total`.
- `.env.example`: `COUNT_EMPTY_LOOPS` entry.
- CHANGELOG `[Unreleased]` -> ship as **0.3.0** (default behavior change vs 0.2.0).
