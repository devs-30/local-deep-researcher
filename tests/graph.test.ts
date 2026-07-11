import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { buildGraph, SearchFailedError } from "../src/graph";
import type { SearchProvider } from "../src/search/types";

const fakeSearch: SearchProvider = async (query) => [
  {
    title: `Result for ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}`,
    content: `Snippet about ${query}`,
  },
];

function fakeLlm() {
  // FakeListChatModel cycles through responses; order per loop:
  // generateQuery (JSON) -> summarize (text) -> reflect (JSON)
  return new FakeListChatModel({
    responses: [
      '{"query": "initial query", "rationale": "start"}',
      "A running summary.",
      '{"knowledge_gap": "gap", "follow_up_query": "follow-up query"}',
    ],
  });
}

describe("research graph", () => {
  it("loops maxWebResearchLoops+1 times and finalizes with sources", async () => {
    const graph = buildGraph({
      getLlm: () => fakeLlm(),
      getSearchProvider: () => fakeSearch,
      retryDelayMs: 0,
    });
    const state = await graph.invoke(
      { researchTopic: "test topic" },
      { configurable: { maxWebResearchLoops: 1 }, recursionLimit: 50 },
    );
    // <= condition (port fidelity): loops run until count exceeds max, so 2 searches for max=1
    expect(state.researchLoopCount).toBe(2);
    expect(state.sourcesGathered).toHaveLength(2);
    expect(state.runningSummary).toContain("## Summary");
    expect(state.runningSummary).toContain("### Sources:");
    expect(state.runningSummary).toContain("* Result for initial query : ");
  });

  it("falls back to the topic when query JSON is invalid", async () => {
    const llm = new FakeListChatModel({
      responses: ["THIS IS NOT JSON", "A summary.", "also not json"],
    });
    const seen: string[] = [];
    const spySearch: SearchProvider = async (query) => {
      seen.push(query);
      return fakeSearch(query, undefined as never);
    };
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => spySearch,
      retryDelayMs: 0,
    });
    await graph.invoke(
      { researchTopic: "fallback topic" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    // generateQuery fallback = the topic itself; reflect fallback = "Tell me more about ..."
    expect(seen[0]).toBe("fallback topic");
  });

  it("hard-fails when search dies on the first loop with no sources", async () => {
    const failingSearch: SearchProvider = async () => {
      throw new Error("network down");
    };
    const graph = buildGraph({
      getLlm: () => fakeLlm(),
      getSearchProvider: () => failingSearch,
      retryDelayMs: 0,
    });
    await expect(
      graph.invoke(
        { researchTopic: "t" },
        { configurable: { maxWebResearchLoops: 1 }, recursionLimit: 50 },
      ),
    ).rejects.toThrow(SearchFailedError);
  });

  it("continues with a warning when search fails but sources exist", async () => {
    const failingSearch: SearchProvider = async () => {
      throw new Error("network down");
    };
    const warn = vi.fn();
    const graph = buildGraph({
      getLlm: () => fakeLlm(),
      getSearchProvider: () => failingSearch,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      { researchTopic: "t", sourcesGathered: ["* Seed : https://seed.example"] },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    expect(warn).toHaveBeenCalled();
    expect(state.runningSummary).toContain("* Seed : https://seed.example");
  });
});
