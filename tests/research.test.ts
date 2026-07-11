import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ConfigurationError } from "../src/configuration";
import { research, researchAgentic, type ProgressEvent } from "../src/research";
import type { SearchProvider } from "../src/search/types";

class FakeToolCallingModel extends BaseChatModel {
  private queue: AIMessage[];
  constructor(queue: AIMessage[]) {
    super({});
    this.queue = [...queue];
  }
  _llmType(): string {
    return "fake-tool-calling";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.queue.shift() ?? new AIMessage("Research complete.");
    return { generations: [{ message, text: "" }] };
  }
}

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

describe("researchAgentic", () => {
  it("returns a ResearchReport with parsed sources and emits step progress", async () => {
    const model = new FakeToolCallingModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "web_search", args: { query: "alpha" } }],
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "c2",
            name: "take_note",
            args: {
              note: "Alpha does X",
              source_url: "https://alpha.example/1",
              source_title: "Alpha",
            },
          },
        ],
      }),
      new AIMessage("Done."),
    ]);
    const writer = new FakeToolCallingModel([new AIMessage("Agentic report body.")]);
    const events: Array<{ phase: string; step?: number }> = [];
    const report = await researchAgentic(
      "alpha systems",
      { agentLlm: "fake-agent", localLlm: "fake-writer", maxAgentSteps: 5 },
      { onProgress: (e) => events.push({ phase: e.phase, step: e.step }) },
      {
        getLlm: (cfg) => (cfg.localLlm === "fake-agent" ? model : writer),
        getSearchProvider: () => async () => [
          { title: "Alpha", url: "https://alpha.example/1", content: "alpha ".repeat(50) },
        ],
        retryDelayMs: 0,
        warn: () => {},
      },
    );
    expect(report.markdown).toContain("## Summary");
    expect(report.markdown).toContain("Agentic report body.");
    expect(report.summary).toContain("Agentic report body.");
    expect(report.sources).toEqual([{ title: "Alpha", url: "https://alpha.example/1" }]);
    expect(events.map((e) => e.phase)).toEqual(["searching", "noting", "finalizing"]);
    expect(events[0].step).toBe(1);
    expect(events[1].step).toBe(2);
  });

  it("rejects an empty topic", async () => {
    await expect(researchAgentic("  ")).rejects.toThrow(ConfigurationError);
  });

  it("does not truncate the summary when the writer's own text contains the sources delimiter", async () => {
    const model = new FakeToolCallingModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "web_search", args: { query: "alpha" } }],
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "c2",
            name: "take_note",
            args: {
              note: "Alpha does X",
              source_url: "https://alpha.example/1",
              source_title: "Alpha",
            },
          },
        ],
      }),
      new AIMessage("Done."),
    ]);
    // The writer's own report text happens to contain the literal delimiter the old
    // code split on ("\n\n### Sources:"). A structural fix must not lose anything
    // after that point.
    const writerText = "Before text.\n\n### Sources:\nfake source line";
    const writer = new FakeToolCallingModel([new AIMessage(writerText)]);
    const report = await researchAgentic(
      "alpha systems",
      { agentLlm: "fake-agent", localLlm: "fake-writer", maxAgentSteps: 5 },
      {},
      {
        getLlm: (cfg) => (cfg.localLlm === "fake-agent" ? model : writer),
        getSearchProvider: () => async () => [
          { title: "Alpha", url: "https://alpha.example/1", content: "alpha ".repeat(50) },
        ],
        retryDelayMs: 0,
        warn: () => {},
      },
    );
    expect(report.summary).toContain("Before text.");
    expect(report.summary).toContain("fake source line");
    expect(report.markdown.trim().endsWith("* Alpha : https://alpha.example/1")).toBe(true);
  });
});
