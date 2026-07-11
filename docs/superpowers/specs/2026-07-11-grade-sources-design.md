# gradeSources Node — Design

**Date:** 2026-07-11
**Status:** Approved for implementation planning

## Problem

The research graph consumes search results as-is: provider ranking is the only quality
signal, and every gathered source lands in the final bibliography. There is no evaluation
of source credibility or topical relevance. Content-farm pages and off-topic results flow
straight into the running summary.

## Goal

Add a `gradeSources` node that filters search results before summarization, using a
two-stage cascade informed by CRAG / Self-RAG research and LLM-grader reliability
findings:

1. **Heuristics stage** (deterministic, no LLM cost) — drops evident junk.
2. **LLM relevance stage** (per-source, binary, lenient) — drops off-topic sources.

Non-goal: claim-level support checking (Self-RAG ISSUP) — out of scope for this design.

## Decisions (from brainstorming)

| Decision             | Choice                                                                         |
| -------------------- | ------------------------------------------------------------------------------ |
| Scope                | Hybrid: credibility heuristics + LLM relevance grading                         |
| Default              | ON, opt-out via dedicated flag (behavior change vs upstream — changelog entry) |
| LLM grading mode     | Per source, binary yes/no (most reliable on small local models)                |
| All sources rejected | Drop all + warning; existing reflect loop retries with a new query (CRAG-lite) |
| Heuristics ↔ LLM     | Cascade: heuristics pre-filter, survivors go to the LLM                        |

## Graph topology

```
START → generateQuery → webResearch → gradeSources → summarizeSources → reflectOnSummary
                            ▲                                                │
                            └────────────── (loop) ──────────────────────────┘
                                                                  finalizeSummary → END
```

Topology is **static**: the node always exists; `gradeSources=false` switches it to
pass-through at runtime. Required because the compiled graph is exported once for
LangGraph Studio while configuration arrives per-invocation via `RunnableConfig`.

## Data flow changes

- `webResearch` no longer formats results or writes `sourcesGathered` /
  `webResearchResults`. It stores raw `SearchResult[]` in a new state field
  `pendingResults` (overwrite reducer, default `[]`).
- New state field `gradedUrls` (concat reducer, default `[]`): every URL processed by
  `gradeSources` — kept **or** rejected — is recorded, so later loops neither re-grade
  kept sources nor retry rejected ones.
- `gradeSources` consumes `pendingResults`, filters, then produces the formatted
  outputs exactly as `webResearch` does today: `formatSources(kept)` appended to
  `sourcesGathered`, `deduplicateAndFormatSources(kept, MAX_TOKENS_PER_SOURCE,
fetchFullPage)` appended to `webResearchResults`.
- Rejected sources therefore never reach the summarizer nor the final bibliography.
- With `gradeSources=false` the node formats everything unfiltered — output identical
  to current behavior, zero extra LLM calls.

## Stage 1 — heuristics (pure function, no LLM)

`applyHeuristics(results, cfg, state)` drops only evident junk, each drop logged via
`deps.warn` with a reason:

- **Domain blocklist** — from config (comma-separated). Dot-boundary host-suffix
  match: host equals the entry or ends with `.` + entry (`example.com` matches
  `www.example.com` but not `notexample.com`). Default: empty.
- **Empty/thin content** — low bar (< 50 chars) always; the content-farm bar
  (< 300 words) applies **only** when full page content was fetched
  (`fetchFullPage=true` / `rawContent` present), because default provider snippets are
  legitimately short.
- **Cross-loop URL dedup** — a URL present in `gradedUrls` (graded in a previous
  loop) is neither re-graded nor re-appended (today dedup is per-loop only).

Soft signals (TLD, HTTPS) intentionally do **not** reject — too weak statistically.

## Stage 2 — LLM relevance grading (per source)

For each survivor, one JSON-mode LLM call (same model as the rest of the graph):

- Prompt input: research topic, current search query, source title + URL + content
  trimmed to ~`MAX_TOKENS_PER_SOURCE` (1000 tokens).
- Output: `{"relevant": "yes"|"no", "reason": "..."}`, parsed with `extractJsonField`.
- Prompt is **lenient**: "when in doubt, answer yes" (small models over-reject
  otherwise; research shows false negatives are the costlier failure).
- New prompts in `prompts.ts`: `sourceGraderInstructions`,
  `jsonModeGraderInstructions`, stylistically consistent with existing ones.

### Reliability rules

- JSON parse failure → **keep** the source (fail-open per source).
- LLM call error → keep the source + warning (search succeeded; losing data is worse
  than not filtering).
- All sources rejected → empty round + warning; the existing
  `reflectOnSummary` loop naturally retries with a different query next round.
  The node never throws.

## Configuration

Two new `ConfigurationSchema` fields (+ env, CLI args, MCP, Studio):

| Field                   | Type                     | Default | Env                       |
| ----------------------- | ------------------------ | ------- | ------------------------- |
| `gradeSources`          | boolean                  | `true`  | `GRADE_SOURCES`           |
| `sourceDomainBlocklist` | string (comma-separated) | `""`    | `SOURCE_DOMAIN_BLOCKLIST` |

Changelog: note the behavior change vs upstream (extra per-source LLM calls, result
filtering, default ON). README: document the node and how to disable it.

## Testing

- **Heuristics**: unit tests of the pure function — blocklist matching (incl. subdomain
  suffix), thin-content thresholds for snippet vs full-page modes, cross-loop dedup,
  empty blocklist cuts nothing.
- **Node/graph**: via existing `buildGraph({ getLlm, getSearchProvider })` injection —
  fake LLM returning scripted verdicts: keep/drop path, all-rejected path (empty round
  plus warn), `gradeSources=false` (zero grader calls, output identical to current),
  fail-open on malformed JSON and on LLM exceptions.
- **Bibliography**: a rejected source never appears in the final "Sources" section.

## Research references

- CRAG — Corrective RAG: evaluator verdicts drive corrective action
  (https://arxiv.org/pdf/2401.15884)
- Self-RAG — separate relevance (ISREL) from support (ISSUP)
  (https://arxiv.org/pdf/2310.11511)
- LangGraph CRAG tutorial — canonical binary `grade_documents` node
  (https://www.datacamp.com/tutorial/corrective-rag-crag)
- LLM-judge overrating / threshold sensitivity (https://arxiv.org/pdf/2602.17170,
  https://arxiv.org/html/2601.04395)
- Credibility signals survey (https://arxiv.org/html/2410.21360v1)
