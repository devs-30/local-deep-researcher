# Skip Summarize on Empty Rounds - Design

**Date:** 2026-07-11
**Status:** Approved for implementation planning

## Problem

Since v0.4.0 empty rounds (no sources kept) get free retries, but each empty round still
runs `summarizeSources` on an empty context block (the literal `"Sources:"` string). That
wastes one LLM call per empty round (up to `2 * (maxWebResearchLoops + 1)` worst case) and
invites the model to hallucinate a summary from nothing. Additionally, `reflectOnSummary`
after an empty round reasons over an unchanged summary at temperature 0, so it tends to
regenerate a near-identical query - burning the retry cap on variations of a query that
already failed.

## Goal

1. Empty rounds route directly from `gradeSources` to `reflectOnSummary`, skipping
   `summarizeSources` entirely (no LLM call, no summary mutation).
2. Reflection sees which queries already failed and is instructed to propose a
   meaningfully different one.

## Decisions (from brainstorming)

| Decision      | Choice                                                            |
| ------------- | ----------------------------------------------------------------- |
| Flag          | None - unconditional (quality bugfix, YAGNI on a third loop knob) |
| Reflect input | Gets the list of failed queries with a do-not-repeat instruction  |

## Routing

- The unconditional edge `gradeSources -> summarizeSources` becomes a conditional edge
  `routeAfterGrading(state): "summarizeSources" | "reflectOnSummary"`.
- Signal: new state field `lastRoundEmpty: boolean` (overwrite reducer, default `false`),
  set by `gradeSources` on both paths: enabled path `kept.length === 0`, pass-through
  path `results.length === 0`.
- Empty rounds no longer append the empty `"Sources:"` block to `webResearchResults`
  (nothing consumes it once summarize is skipped). `sourcesGathered` behavior unchanged
  (already appends only when non-empty).
- Productive rounds are routed and processed exactly as today.

## Failed-queries context for reflection

- New state field `failedQueries: string[]` (concat reducer, default `[]`):
  `gradeSources` appends `state.searchQuery` whenever the round is empty.
- `reflectionInstructions` gains a parameter `failedQueries: string[]`. When non-empty,
  the prompt renders a `<FAILED_QUERIES>` block listing them with the instruction:
  these queries returned no usable sources - propose a meaningfully different follow-up
  query and do not repeat them. When empty, the prompt is byte-identical to today's.

## Edge cases exposed by the skip

- **Round 1 empty:** `reflectOnSummary` now runs before any summary exists;
  `state.runningSummary` is `undefined` and the template would interpolate the literal
  string "undefined". Guard: use `state.runningSummary ?? ""` in the reflect human
  message.
- **All rounds empty:** `runningSummary` is never set; `finalizeSummary` guards with
  `state.runningSummary ?? ""` and produces an honestly empty report
  (`## Summary` header + empty body + empty sources) instead of a summary hallucinated
  from empty contexts. This is an intended quality improvement.

## Impact on existing tests

Node-execution order changes on empty rounds (summarize drops out), so shared
`FakeListChatModel` response scripts in the "loop budget" graph tests and the all-empty
research test consume responses in a new order. The implementation plan recomputes those
sequences exactly; assertions on counters, sources and report shape stay as they are
(the all-empty test's `runningSummary`/markdown assertions still hold via the
`finalizeSummary` guard). Progress-phase tests are unaffected: productive rounds still
emit "summarizing".

## Docs and versioning

- README: loop description - empty rounds skip the summarize step and reflection
  receives the failed queries; note the honestly-empty report on all-empty runs.
- CHANGELOG `[Unreleased]` `### Changed` entry.
- No new configuration. Suggested release version when cut: **0.5.0** (behavior change,
  consistent with the project's minor-bump policy).

## Process note

Per user instruction: the assistant and its subagents do not run `git commit` - each
work unit ends with prepared changes plus a proposed commit message, and the user
commits.
