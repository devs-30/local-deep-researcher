import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildGraph, SearchFailedError } from "../src/graph";
import type { SearchProvider } from "../src/search/types";

const fakeSearch: SearchProvider = async (query) => [
  {
    title: `Result for ${query}`,
    url: `https://example.com/${encodeURIComponent(query)}`,
    // Long enough to clear applyHeuristics' thin-content bar (MIN_CONTENT_CHARS = 50).
    content: `Snippet about ${query} with enough detail to clear the minimum content length threshold.`,
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

describe("gradeSources node", () => {
  const twoSources: SearchProvider = async () => [
    {
      title: "Relevant article",
      url: "https://good.example/a",
      content: "A long, substantive snippet that easily clears the thin-content bar for grading.",
    },
    {
      title: "Off-topic article",
      url: "https://offtopic.example/b",
      content: "Another long snippet, also clearly above the minimum length threshold for keeping.",
    },
  ];

  it("drops sources the LLM marks not relevant", async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q", "rationale": "r"}',
        '{"relevant": "yes", "reason": "on topic"}',
        '{"relevant": "no", "reason": "off topic"}',
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "f"}',
      ],
    });
    const warn = vi.fn();
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => twoSources,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    expect(state.sourcesGathered.join("\n")).toContain("https://good.example/a");
    expect(state.sourcesGathered.join("\n")).not.toContain("https://offtopic.example/b");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offtopic.example"));
    expect(state.gradedUrls).toContain("https://good.example/a");
    expect(state.gradedUrls).toContain("https://offtopic.example/b");
    expect(state.runningSummary).not.toContain("offtopic.example");
  });

  it("fails open when the grader verdict is unparsable", async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q", "rationale": "r"}',
        "NOT JSON AT ALL",
        '{"relevant": "yes", "reason": "ok"}',
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "f"}',
      ],
    });
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => twoSources,
      retryDelayMs: 0,
      warn: () => {},
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    expect(state.sourcesGathered.join("\n")).toContain("https://good.example/a");
  });

  it('fails open on a non-canonical verdict string like "true"', async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q", "rationale": "r"}',
        '{"relevant": "true", "reason": "non-canonical but affirmative"}',
        '{"relevant": "no", "reason": "off topic"}',
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "f"}',
      ],
    });
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => twoSources,
      retryDelayMs: 0,
      warn: () => {},
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    expect(state.sourcesGathered.join("\n")).toContain("https://good.example/a");
    expect(state.sourcesGathered.join("\n")).not.toContain("https://offtopic.example/b");
  });

  it("fails open and warns when the grader LLM call throws", async () => {
    const mainLlm = new FakeListChatModel({
      responses: [
        '{"query": "q", "rationale": "r"}',
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "f"}',
      ],
    });
    const throwingLlm = {
      invoke: async () => {
        throw new Error("ollama down");
      },
    } as unknown as BaseChatModel;
    let llmCalls = 0;
    const warn = vi.fn();
    const graph = buildGraph({
      // Node-execution order: generateQuery (1), gradeSources (2), summarize (3), reflect (4).
      getLlm: () => {
        llmCalls++;
        return llmCalls === 2 ? throwingLlm : mainLlm;
      },
      getSearchProvider: () => twoSources,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    expect(state.sourcesGathered.join("\n")).toContain("https://good.example/a");
    expect(state.sourcesGathered.join("\n")).toContain("https://offtopic.example/b");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("keeping source"));
  });

  it("warns and continues with an empty round when all sources are rejected", async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q", "rationale": "r"}',
        '{"relevant": "no", "reason": "junk"}',
        '{"relevant": "no", "reason": "junk"}',
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "f"}',
      ],
    });
    const warn = vi.fn();
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => twoSources,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0 }, recursionLimit: 50 },
    );
    expect(state.sourcesGathered).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("all 2 sources rejected"));
    expect(state.runningSummary).toContain("## Summary");
  });

  it("makes zero grader calls and keeps everything when gradeSources=false", async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q", "rationale": "r"}',
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "f"}',
      ],
    });
    let llmCalls = 0;
    const graph = buildGraph({
      getLlm: () => {
        llmCalls++;
        return llm;
      },
      getSearchProvider: () => twoSources,
      retryDelayMs: 0,
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 0, gradeSources: false }, recursionLimit: 50 },
    );
    // generateQuery + summarize + reflect only — gradeSources never asked for an LLM.
    expect(llmCalls).toBe(3);
    expect(state.sourcesGathered.join("\n")).toContain("https://good.example/a");
    expect(state.sourcesGathered.join("\n")).toContain("https://offtopic.example/b");
  });

  it("drops blocklisted domains before any LLM call", async () => {
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q", "rationale": "r"}',
        '{"relevant": "yes", "reason": "ok"}',
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "f"}',
      ],
    });
    const warn = vi.fn();
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => twoSources,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      {
        configurable: { maxWebResearchLoops: 0, sourceDomainBlocklist: "offtopic.example" },
        recursionLimit: 50,
      },
    );
    expect(state.sourcesGathered.join("\n")).not.toContain("offtopic.example");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("blocklisted domain"));
  });

  it("does not re-grade a URL seen in a previous loop", async () => {
    const sameUrlEveryLoop: SearchProvider = async () => [
      {
        title: "Same page",
        url: "https://same.example/page",
        content: "A long, substantive snippet that easily clears the thin-content bar for grading.",
      },
    ];
    const llm = new FakeListChatModel({
      responses: [
        '{"query": "q", "rationale": "r"}',
        '{"relevant": "yes", "reason": "ok"}', // loop 1: graded once
        "A summary.",
        '{"knowledge_gap": "g", "follow_up_query": "f"}',
        // loop 2: no grader call (heuristics dedup), straight to summarize + reflect
        "An updated summary.",
        '{"knowledge_gap": "g2", "follow_up_query": "f2"}',
      ],
    });
    const warn = vi.fn();
    const graph = buildGraph({
      getLlm: () => llm,
      getSearchProvider: () => sameUrlEveryLoop,
      retryDelayMs: 0,
      warn,
    });
    const state = await graph.invoke(
      { researchTopic: "t" },
      { configurable: { maxWebResearchLoops: 1 }, recursionLimit: 50 },
    );
    expect(state.sourcesGathered).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("already graded"));
  });
});

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
      // searchWithRetry (unmodified) already retries once internally, so round 1's
      // single node execution issues 2 calls; both must fail for round 1 to be empty.
      if (call <= 2) throw new Error("network down");
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
