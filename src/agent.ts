import { END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createAgent, createMiddleware, modelCallLimitMiddleware } from "langchain";
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
  /**
   * Fired once per executed tool call. modelCall is the 1-based number of the
   * model call that requested the tool - the unit maxAgentSteps budgets. A
   * single model call may batch several tool calls, which then share a number.
   */
  onToolEvent?: (phase: AgentToolPhase, modelCall?: number) => void;
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
    // Tool events report against the model-call budget, so count model calls
    // exactly instead of assuming one tool call per model turn (models may
    // batch several tool calls in a single turn).
    let modelCalls = 0;
    const modelCallCounter = createMiddleware({
      name: "ModelCallCounter",
      beforeModel: () => {
        modelCalls += 1;
        return undefined;
      },
    });
    const ctx: AgentToolsContext = {
      cfg,
      provider: deps.getSearchProvider(cfg.searchApi),
      retryDelayMs: deps.retryDelayMs,
      seenUrls: new Set(),
      notes: [],
      warn: deps.warn,
      onToolEvent: deps.onToolEvent ? (phase) => deps.onToolEvent?.(phase, modelCalls) : undefined,
      budget: () => ({ used: modelCalls, max: cfg.maxAgentSteps }),
    };
    const tools = createAgentTools(ctx);
    const systemPrompt = prompts.agentInstructions({
      researchTopic: state.researchTopic,
      currentDate: prompts.getCurrentDate(),
      maxAgentSteps: cfg.maxAgentSteps,
    });
    // The agent must not give up while it has zero findings and unspent budget:
    // models tend to quit after a few fruitless searches. Each pass gets the
    // remaining budget as its run limit; the pass prompt tells a re-engaged
    // agent to vary its queries. Positive exit: notes exist. Hard exit: budget.
    let lastAiCount: number;
    let lastRunLimit: number;
    for (let attempt = 1; ; attempt += 1) {
      const remaining = cfg.maxAgentSteps - modelCalls;
      lastRunLimit = remaining;
      const agent = createAgent({
        model,
        tools,
        systemPrompt,
        // Order matters: the limiter's beforeModel must run first so its jump to
        // the end prevents the counter from counting a call that never happens.
        middleware: [
          modelCallLimitMiddleware({ runLimit: remaining, exitBehavior: "end" }),
          modelCallCounter,
        ],
      });
      const content =
        attempt === 1
          ? `Research this topic: ${state.researchTopic}`
          : `Research this topic: ${state.researchTopic}\n\nYour previous attempt recorded no findings. ${remaining} of ${cfg.maxAgentSteps} model calls remain. Try DIFFERENT search queries and angles (already-seen URLs are filtered out automatically). Record a negative finding only as a last resort when the budget is nearly exhausted.`;
      const result = await agent.invoke(
        { messages: [new HumanMessage(content)] },
        // Termination is owned by modelCallLimitMiddleware; the recursion limit
        // is only a runaway backstop. Each loop iteration costs ~3 super-steps
        // (model + tools + middleware hooks), so leave generous headroom.
        { recursionLimit: cfg.maxAgentSteps * 10 + 50 },
      );
      lastAiCount = (result.messages as BaseMessage[]).filter((m) => m.getType() === "ai").length;
      if (ctx.notes.length > 0 || modelCalls >= cfg.maxAgentSteps) break;
      deps.warn(
        `agentLoop: attempt ${attempt} ended with no findings, re-engaging with ${cfg.maxAgentSteps - modelCalls} calls left`,
      );
    }
    // The middleware injects one extra "ai"-typed stop-notice message when it
    // cuts a run off, so aiCount > that run's limit is the capped signal.
    const capped = lastAiCount > lastRunLimit;
    const stepsUsed = Math.min(modelCalls, cfg.maxAgentSteps);
    if (capped) {
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
        "Agent finished without recording any findings - not even a negative one, although the prompt asks for it. The model likely struggles to follow note-taking instructions; try a different --agent-model, or a larger --max-steps.",
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
