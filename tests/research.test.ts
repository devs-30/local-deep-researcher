import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ConfigurationError } from "../src/configuration";
import { research, type ProgressEvent } from "../src/research";
import type { SearchProvider } from "../src/search/types";

const fakeSearch: SearchProvider = async (query) => [
  {
    title: `Result for ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}`,
    // Long enough to clear applyHeuristics' thin-content bar (MIN_CONTENT_CHARS = 50).
    content: "A snippet with enough detail to clear the minimum content length threshold.",
  },
];

const deps = {
  getLlm: () =>
    new FakeListChatModel({
      responses: [
        '{"query": "q1", "rationale": "r"}',
        "The summary.",
        '{"knowledge_gap": "g", "follow_up_query": "q2"}',
      ],
    }),
  getSearchProvider: () => fakeSearch,
  retryDelayMs: 0,
};

describe("research", () => {
  it("returns summary, structured sources and markdown", async () => {
    const report = await research("test topic", { maxWebResearchLoops: 1 }, {}, deps);
    expect(report.markdown).toContain("## Summary");
    expect(report.markdown).toContain("### Sources:");
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.summary).not.toContain("## Summary");
    expect(report.sources.length).toBeGreaterThanOrEqual(2);
    expect(report.sources[0]).toEqual({
      title: "Result for q1",
      url: "https://example.com/q1",
    });
  });

  it("emits progress events with phases and loop counts", async () => {
    const events: ProgressEvent[] = [];
    await research("t", { maxWebResearchLoops: 0 }, { onProgress: (e) => events.push(e) }, deps);
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("searching");
    expect(phases).toContain("summarizing");
    expect(phases[phases.length - 1]).toBe("finalizing");
    expect(events.every((e) => e.maxLoops === 0)).toBe(true);
  });

  it("rejects an empty topic", async () => {
    await expect(research("   ", {}, {}, deps)).rejects.toThrow(ConfigurationError);
  });

  it("rejects invalid configuration before running", async () => {
    await expect(research("t", { searchApi: "tavily" }, {}, deps)).rejects.toThrow(
      /TAVILY_API_KEY/,
    );
  });

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
        getLlm: () =>
          new FakeListChatModel({ responses: ['{"relevant": "no", "reason": "junk"}'] }),
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
});
