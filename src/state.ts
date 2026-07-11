import { Annotation } from "@langchain/langgraph";
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
  runningSummary: Annotation<string>(),
});

export type SummaryState = typeof SummaryStateAnnotation.State;
