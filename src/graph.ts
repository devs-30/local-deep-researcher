import { END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { ensureConfiguration } from "./configuration";
import {
  contentToString,
  extractJsonField,
  getLlm as defaultGetLlm,
  stripThinkingTokens,
  type LlmFactory,
} from "./llm";
import * as prompts from "./prompts";
import { deduplicateAndFormatSources, formatSources } from "./search/format";
import { getSearchProvider as defaultGetSearchProvider, searchWithRetry } from "./search/index";
import type { SearchResult } from "./search/types";
import { SummaryStateAnnotation, type SummaryState } from "./state";

const MAX_TOKENS_PER_SOURCE = 1000;

export class SearchFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchFailedError";
  }
}

export interface GraphDeps {
  getLlm: LlmFactory;
  getSearchProvider: typeof defaultGetSearchProvider;
  retryDelayMs: number;
  warn: (message: string) => void;
}

export function buildGraph(overrides: Partial<GraphDeps> = {}) {
  const deps: GraphDeps = {
    getLlm: defaultGetLlm,
    getSearchProvider: defaultGetSearchProvider,
    retryDelayMs: 1000,
    warn: (message) => console.error(message),
    ...overrides,
  };

  async function generateQuery(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const systemPrompt = prompts.queryWriterInstructions({
      currentDate: prompts.getCurrentDate(),
      researchTopic: state.researchTopic,
    });
    const llm = deps.getLlm(cfg, { jsonMode: true });
    const result = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(prompts.jsonModeQueryInstructions),
    ]);
    let content = contentToString(result.content);
    if (cfg.stripThinkingTokens) content = stripThinkingTokens(content);
    // Fallback (per spec): use the topic itself as the query.
    const query = extractJsonField(content, "query") ?? state.researchTopic;
    return { searchQuery: query };
  }

  async function webResearch(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const provider = deps.getSearchProvider(cfg.searchApi);
    const searchOptions = {
      maxResults: cfg.searchApi === "tavily" ? 1 : 3,
      fetchFullPage: cfg.fetchFullPage,
      loopCount: state.researchLoopCount,
      config: cfg,
    };
    let results: SearchResult[];
    try {
      results = await searchWithRetry(
        provider,
        state.searchQuery,
        searchOptions,
        deps.retryDelayMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state.sourcesGathered.length === 0) {
        throw new SearchFailedError(
          `Web search failed with no sources gathered yet (${cfg.searchApi}): ${message}`,
        );
      }
      deps.warn(
        `Web search failed (${cfg.searchApi}), continuing with gathered sources: ${message}`,
      );
      results = [];
    }
    return {
      pendingResults: results,
      researchLoopCount: state.researchLoopCount + 1,
    };
  }

  async function gradeSources(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const results = state.pendingResults;
    return {
      pendingResults: [],
      gradedUrls: results.map((r) => r.url),
      sourcesGathered: results.length > 0 ? [formatSources(results)] : [],
      webResearchResults: [
        deduplicateAndFormatSources(results, MAX_TOKENS_PER_SOURCE, cfg.fetchFullPage),
      ],
    };
  }

  async function summarizeSources(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const mostRecent = state.webResearchResults[state.webResearchResults.length - 1] ?? "";
    // Message formats ported verbatim from graph.py.
    const humanMessage = state.runningSummary
      ? `<Existing Summary> \n ${state.runningSummary} \n <Existing Summary>\n\n<New Context> \n ${mostRecent} \n <New Context>Update the Existing Summary with the New Context on this topic: \n <User Input> \n ${state.researchTopic} \n <User Input>\n\n`
      : `<Context> \n ${mostRecent} \n <Context>Create a Summary using the Context on this topic: \n <User Input> \n ${state.researchTopic} \n <User Input>\n\n`;
    const llm = deps.getLlm(cfg);
    const result = await llm.invoke([
      new SystemMessage(prompts.summarizerInstructions),
      new HumanMessage(humanMessage),
    ]);
    let summary = contentToString(result.content);
    if (cfg.stripThinkingTokens) summary = stripThinkingTokens(summary);
    return { runningSummary: summary };
  }

  async function reflectOnSummary(state: SummaryState, config?: RunnableConfig) {
    const cfg = ensureConfiguration(config);
    const llm = deps.getLlm(cfg, { jsonMode: true });
    const result = await llm.invoke([
      new SystemMessage(prompts.reflectionInstructions({ researchTopic: state.researchTopic })),
      new HumanMessage(
        `${prompts.jsonModeReflectionInstructions}\n\nReflect on our existing knowledge: \n === \n ${state.runningSummary}, \n === \n And now identify a knowledge gap and generate a follow-up web search query:`,
      ),
    ]);
    let content = contentToString(result.content);
    if (cfg.stripThinkingTokens) content = stripThinkingTokens(content);
    const followUp =
      extractJsonField(content, "follow_up_query") ?? `Tell me more about ${state.researchTopic}`;
    return { searchQuery: followUp };
  }

  function finalizeSummary(state: SummaryState) {
    // Port of finalize_summary: dedup source lines across all gathered blocks.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const block of state.sourcesGathered) {
      for (const line of block.split("\n")) {
        if (line.trim() && !seen.has(line)) {
          seen.add(line);
          unique.push(line);
        }
      }
    }
    const allSources = unique.join("\n");
    return {
      runningSummary: `## Summary\n${state.runningSummary}\n\n ### Sources:\n${allSources}`,
    };
  }

  function routeResearch(
    state: SummaryState,
    config?: RunnableConfig,
  ): "webResearch" | "finalizeSummary" {
    const cfg = ensureConfiguration(config);
    // Port fidelity: <= means max=N yields N+1 search rounds, matching the original.
    return state.researchLoopCount <= cfg.maxWebResearchLoops ? "webResearch" : "finalizeSummary";
  }

  return new StateGraph(SummaryStateAnnotation)
    .addNode("generateQuery", generateQuery)
    .addNode("webResearch", webResearch)
    .addNode("gradeSources", gradeSources)
    .addNode("summarizeSources", summarizeSources)
    .addNode("reflectOnSummary", reflectOnSummary)
    .addNode("finalizeSummary", finalizeSummary)
    .addEdge(START, "generateQuery")
    .addEdge("generateQuery", "webResearch")
    .addEdge("webResearch", "gradeSources")
    .addEdge("gradeSources", "summarizeSources")
    .addEdge("summarizeSources", "reflectOnSummary")
    .addConditionalEdges("reflectOnSummary", routeResearch, ["webResearch", "finalizeSummary"])
    .addEdge("finalizeSummary", END)
    .compile();
}

/** Default compiled graph - entry point for LangGraph Studio (langgraph.json). */
export const graph = buildGraph();
