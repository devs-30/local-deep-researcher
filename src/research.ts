import {
  ConfigurationError,
  ensureConfiguration,
  validateConfiguration,
  type Configuration,
} from "./configuration";
import { buildGraph, type GraphDeps } from "./graph";
import { parseSourceLine } from "./search/format";

export interface Source {
  title: string;
  url: string;
}

export interface ResearchReport {
  summary: string;
  sources: Source[];
  markdown: string;
}

export type ResearchPhase =
  "generating_query" | "searching" | "grading" | "summarizing" | "reflecting" | "finalizing";

export interface ProgressEvent {
  phase: ResearchPhase;
  loop: number;
  maxLoops: number;
}

export interface ResearchHooks {
  onProgress?: (event: ProgressEvent) => void;
}

const PHASE_BY_NODE: Record<string, ResearchPhase> = {
  generateQuery: "generating_query",
  webResearch: "searching",
  gradeSources: "grading",
  summarizeSources: "summarizing",
  reflectOnSummary: "reflecting",
  finalizeSummary: "finalizing",
};

export async function research(
  topic: string,
  options: Partial<Configuration> = {},
  hooks: ResearchHooks = {},
  deps: Partial<GraphDeps> = {},
): Promise<ResearchReport> {
  if (!topic.trim()) throw new ConfigurationError("Research topic must not be empty");
  const cfg = ensureConfiguration({ configurable: options });
  validateConfiguration(cfg);

  const graph = buildGraph(deps);
  const stream = await graph.stream(
    { researchTopic: topic },
    {
      configurable: options,
      streamMode: "updates",
      recursionLimit: 20 + cfg.maxWebResearchLoops * 5,
    },
  );

  let loop = 0;
  let summary = "";
  let markdown = "";
  const rawSourceBlocks: string[] = [];

  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk as Record<string, Record<string, unknown>>)) {
      if (node === "webResearch") {
        loop = typeof update.researchLoopCount === "number" ? update.researchLoopCount : loop;
      }
      if (node === "gradeSources") {
        rawSourceBlocks.push(...((update.sourcesGathered as string[] | undefined) ?? []));
      }
      if (node === "summarizeSources") summary = String(update.runningSummary ?? summary);
      if (node === "finalizeSummary") markdown = String(update.runningSummary ?? markdown);
      const phase = PHASE_BY_NODE[node];
      if (phase) hooks.onProgress?.({ phase, loop, maxLoops: cfg.maxWebResearchLoops });
    }
  }

  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const block of rawSourceBlocks) {
    for (const line of block.split("\n")) {
      if (line.trim() && !seen.has(line)) {
        seen.add(line);
        sources.push(parseSourceLine(line));
      }
    }
  }

  return { summary, sources, markdown };
}
