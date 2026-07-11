import { Annotation } from "@langchain/langgraph";

export const SummaryStateAnnotation = Annotation.Root({
  researchTopic: Annotation<string>(),
  searchQuery: Annotation<string>(),
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
