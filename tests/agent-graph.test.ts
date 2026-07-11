import { describe, expect, it, vi } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { AgentResearchError, buildAgenticGraph } from "../src/agent";
import type { SearchResult } from "../src/search/types";

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

const searchCall = (id: string, query: string) =>
  new AIMessage({
    content: "",
    tool_calls: [{ id, name: "web_search", args: { query } }],
  });
const noteCall = (id: string, note: string, url: string, title: string) =>
  new AIMessage({
    content: "",
    tool_calls: [{ id, name: "take_note", args: { note, source_url: url, source_title: title } }],
  });

const provider = vi.fn(async (): Promise<SearchResult[]> => [
  { title: "Alpha", url: "https://alpha.example/1", content: "alpha content ".repeat(30) },
]);

function deps(agentModel: FakeToolCallingModel, writerText = "Report body.") {
  const writer = new FakeToolCallingModel([new AIMessage(writerText)]);
  return {
    // agentLoop asks for cfg.agentLlm ?? cfg.localLlm; finalizeReport for cfg.localLlm.
    // We route on the model name that agentLoop overrides into cfg.localLlm.
    getLlm: vi.fn((cfg: { localLlm: string }) =>
      cfg.localLlm === "fake-agent" ? agentModel : writer,
    ),
    getSearchProvider: () => provider,
    retryDelayMs: 0,
    warn: vi.fn(),
  };
}

const CONFIG = { configurable: { agentLlm: "fake-agent", localLlm: "fake-writer" } };

describe("agentic graph", () => {
  it("runs search -> note -> stop and produces a report with sources", async () => {
    const model = new FakeToolCallingModel([
      searchCall("c1", "alpha"),
      noteCall("c2", "Alpha does X", "https://alpha.example/1", "Alpha"),
      noteCall("c3", "Alpha also does Y", "https://alpha.example/1", "Alpha"),
      new AIMessage("Done researching."),
    ]);
    const d = deps(model);
    const graph = buildAgenticGraph(d);
    const result = await graph.invoke({ researchTopic: "alpha systems" }, CONFIG);
    expect(result.notes).toHaveLength(2);
    expect(result.runningSummary).toContain("## Summary");
    expect(result.runningSummary).toContain("Report body.");
    expect(result.runningSummary).toContain("### Sources:");
    // Sources are deduplicated by URL.
    expect(result.runningSummary.match(/alpha\.example/g)).toHaveLength(1);
    expect(result.reportBody).toBe("Report body.");
    // Finished naturally, well under the (default) step budget - no cap warning.
    expect(d.warn).not.toHaveBeenCalledWith(expect.stringContaining("maxAgentSteps"));
  });

  it("stops at maxAgentSteps and still finalizes with gathered notes", async () => {
    // Model always wants another search; middleware must cut it off.
    const endless = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? searchCall(`s${i}`, `query ${i}`)
        : noteCall(`n${i}`, `Fact ${i}`, `https://alpha.example/${i}`, "Alpha"),
    );
    const model = new FakeToolCallingModel(endless);
    const d = deps(model);
    const graph = buildAgenticGraph(d);
    const result = await graph.invoke(
      { researchTopic: "alpha systems" },
      { configurable: { ...CONFIG.configurable, maxAgentSteps: 3 } },
    );
    // modelCallLimitMiddleware (exitBehavior: "end") injects one extra AIMessage
    // carrying its stop notice when the run limit is hit. stepsUsed is clamped to
    // maxAgentSteps so it always reflects the configured budget, not the raw
    // "ai"-typed message count (which is runLimit + 1 in the capped case).
    expect(result.stepsUsed).toBeLessThanOrEqual(3);
    expect(result.runningSummary).toContain("## Summary");
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining("maxAgentSteps"));
  });

  it("throws AgentResearchError when the loop ends with zero notes", async () => {
    const model = new FakeToolCallingModel([new AIMessage("Nothing to do.")]);
    const graph = buildAgenticGraph(deps(model));
    await expect(graph.invoke({ researchTopic: "alpha systems" }, CONFIG)).rejects.toThrow(
      AgentResearchError,
    );
  });

  it("emits tool events through deps.onToolEvent", async () => {
    const events: string[] = [];
    const model = new FakeToolCallingModel([
      searchCall("c1", "alpha"),
      noteCall("c2", "Alpha does X", "https://alpha.example/1", "Alpha"),
      new AIMessage("Done."),
    ]);
    const graph = buildAgenticGraph({ ...deps(model), onToolEvent: (p) => events.push(p) });
    await graph.invoke({ researchTopic: "alpha systems" }, CONFIG);
    expect(events).toEqual(["searching", "noting"]);
  });
});
