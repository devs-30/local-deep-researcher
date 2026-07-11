import { Annotation } from "@langchain/langgraph";
import type { AgentNote } from "./agent-tools";
import type { SearchResult } from "./search/types";

export const SummaryStateAnnotation = Annotation.Root({
  researchTopic: Annotation<string>(),
  searchQuery: Annotation<string>(),
  pendingResults: Annotation<SearchResult[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  gradedUrls: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  webResearchResults: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  sourcesGathered: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  researchLoopCount: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  productiveLoopCount: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  lastRoundEmpty: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
  failedQueries: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  runningSummary: Annotation<string>(),
});

export type SummaryState = typeof SummaryStateAnnotation.State;

export const AgenticStateAnnotation = Annotation.Root({
  researchTopic: Annotation<string>(),
  notes: Annotation<AgentNote[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  stepsUsed: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  runningSummary: Annotation<string>(),
});

export type AgenticState = typeof AgenticStateAnnotation.State;
