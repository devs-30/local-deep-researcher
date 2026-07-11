import { END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createAgent, modelCallLimitMiddleware } from "langchain";
import { createAgentTools, type AgentToolPhase, type AgentToolsContext } from "./agent-tools";
import { ensureConfiguration } from "./configuration";
import type { GraphDeps } from "./graph";
import { contentToString, getLlm as defaultGetLlm, stripThinkingTokens } from "./llm";
import * as prompts from "./prompts";
import { getSearchProvider as defaultGetSearchProvider } from "./search/index";
import { AgenticStateAnnotation, type AgenticState } from "./state";

export class AgentResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentResearchError";
  }
}

export interface AgenticGraphDeps extends GraphDeps {
  onToolEvent?: (phase: AgentToolPhase) => void;
}

export function buildAgenticGraph(overrides: Partial<AgenticGraphDeps> = {}) {
  const deps: AgenticGraphDeps = {
    getLlm: defaultGetLlm,
    getSearchProvider: defaultGetSearchProvider,
    retryDelayMs: 1000,
    warn: (message) => console.error(message),
    ...overrides,
  };

  async function agentLoop(state: AgenticState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    // The agent model may differ from the workflow model (tool calling required).
    const model = deps.getLlm({ ...cfg, localLlm: cfg.agentLlm ?? cfg.localLlm });
    const ctx: AgentToolsContext = {
      cfg,
      provider: deps.getSearchProvider(cfg.searchApi),
      retryDelayMs: deps.retryDelayMs,
      seenUrls: new Set(),
      notes: [],
      warn: deps.warn,
      onToolEvent: deps.onToolEvent,
    };
    const agent = createAgent({
      model,
      tools: createAgentTools(ctx),
      systemPrompt: prompts.agentInstructions({
        researchTopic: state.researchTopic,
        currentDate: prompts.getCurrentDate(),
        maxAgentSteps: cfg.maxAgentSteps,
      }),
      middleware: [modelCallLimitMiddleware({ runLimit: cfg.maxAgentSteps, exitBehavior: "end" })],
    });
    const result = await agent.invoke(
      { messages: [new HumanMessage(`Research this topic: ${state.researchTopic}`)] },
      { recursionLimit: cfg.maxAgentSteps * 2 + 10 },
    );
    const stepsUsed = (result.messages as BaseMessage[]).filter((m) => m.getType() === "ai").length;
    if (stepsUsed >= cfg.maxAgentSteps) {
      deps.warn(
        `agentLoop: reached maxAgentSteps=${cfg.maxAgentSteps}, finalizing with ${ctx.notes.length} notes`,
      );
    }
    return { notes: ctx.notes, stepsUsed };
  }

  async function finalizeReport(state: AgenticState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    if (state.notes.length === 0) {
      throw new AgentResearchError(
        "Agent finished without gathering any findings. Try a larger --max-steps or a different --agent-model.",
      );
    }
    const llm = deps.getLlm(cfg);
    const notesBlock = state.notes
      .map((n, i) => `${i + 1}. ${n.note} (source: ${n.sourceUrl})`)
      .join("\n");
    const result = await llm.invoke([
      new SystemMessage(prompts.reportWriterInstructions),
      new HumanMessage(
        `<Notes>\n${notesBlock}\n</Notes>\n\nWrite a research report on this topic: \n<User Input>\n${state.researchTopic}\n</User Input>\n\n`,
      ),
    ]);
    let summary = contentToString(result.content);
    if (cfg.stripThinkingTokens) summary = stripThinkingTokens(summary);
    const seen = new Set<string>();
    const sourceLines: string[] = [];
    for (const n of state.notes) {
      if (!seen.has(n.sourceUrl)) {
        seen.add(n.sourceUrl);
        sourceLines.push(`* ${n.sourceTitle ?? n.sourceUrl} : ${n.sourceUrl}`);
      }
    }
    return {
      runningSummary: `## Summary\n${summary}\n\n### Sources:\n${sourceLines.join("\n")}`,
      reportBody: summary,
    };
  }

  return new StateGraph(AgenticStateAnnotation)
    .addNode("agentLoop", agentLoop)
    .addNode("finalizeReport", finalizeReport)
    .addEdge(START, "agentLoop")
    .addEdge("agentLoop", "finalizeReport")
    .addEdge("finalizeReport", END)
    .compile();
}

/** Default compiled agentic graph - entry point for LangGraph Studio (langgraph.json). */
export const agenticGraph = buildAgenticGraph();
