import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ConfigurationError } from "../src/configuration";
import { research, type ProgressEvent } from "../src/research";
import type { SearchProvider } from "../src/search/types";

const fakeSearch: SearchProvider = async (query) => [
  {
    title: `Result for ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}`,
    content: "snippet",
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
});
