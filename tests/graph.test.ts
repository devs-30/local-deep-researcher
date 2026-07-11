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
