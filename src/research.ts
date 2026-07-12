import { buildAgenticGraph, type AgenticGraphDeps } from "./agent";
import type { AgentNote } from "./agent-tools";
import {
  applyTracingEnv,
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
  | "generating_query"
  | "searching"
  | "grading"
  | "summarizing"
  | "reflecting"
  | "finalizing"
  | "fetching"
  | "noting";

export interface ProgressEvent {
  phase: ResearchPhase;
  loop: number;
  maxLoops: number;
  /** Agentic mode only: model-step counter (mirrors loop/maxLoops). */
  step?: number;
  maxSteps?: number;
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
  applyTracingEnv(cfg);

  const graph = buildGraph(deps);
  const stream = await graph.stream(
    { researchTopic: topic },
    {
      configurable: options,
      streamMode: "updates",
      recursionLimit: 20 + cfg.maxWebResearchLoops * 10,
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

export async function researchAgentic(
  topic: string,
  options: Partial<Configuration> = {},
  hooks: ResearchHooks = {},
  deps: Partial<AgenticGraphDeps> = {},
): Promise<ResearchReport> {
  if (!topic.trim()) throw new ConfigurationError("Research topic must not be empty");
  const cfg = ensureConfiguration({ configurable: options });
  validateConfiguration(cfg);
  applyTracingEnv(cfg);

  let step = 0;
  const emit = (phase: ResearchPhase) =>
    hooks.onProgress?.({
      phase,
      loop: step,
      maxLoops: cfg.maxAgentSteps,
      step,
      maxSteps: cfg.maxAgentSteps,
    });

  const graph = buildAgenticGraph({
    ...deps,
    onToolEvent: (phase, modelCall) => {
      // The model-call number is the budget unit; fall back to counting tool
      // events only when a caller-supplied graph does not report it.
      step = modelCall ?? step + 1;
      emit(phase);
      deps.onToolEvent?.(phase, modelCall);
    },
  });

  const stream = await graph.stream(
    { researchTopic: topic },
    {
      configurable: options,
      streamMode: "updates",
      recursionLimit: 10 + cfg.maxAgentSteps * 3,
    },
  );

  let markdown = "";
  let reportBody = "";
  let notes: AgentNote[] = [];
  for await (const chunk of stream) {
    for (const [node, update] of Object.entries(chunk as Record<string, Record<string, unknown>>)) {
      if (node === "agentLoop") {
        notes = (update.notes as AgentNote[] | undefined) ?? [];
        emit("finalizing");
      }
      if (node === "finalizeReport") {
        markdown = String(update.runningSummary ?? markdown);
        reportBody = String(update.reportBody ?? reportBody);
      }
    }
  }

  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const n of notes) {
    if (!seen.has(n.sourceUrl)) {
      seen.add(n.sourceUrl);
      sources.push({ title: n.sourceTitle ?? n.sourceUrl, url: n.sourceUrl });
    }
  }
  const summary = reportBody;
  return { summary, sources, markdown };
}
