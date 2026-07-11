import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureConfiguration, validateConfiguration, type Configuration } from "./configuration";
import { preflightAgentModel, preflightOllama } from "./preflight";
import { research, researchAgentic } from "./research";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export interface McpDeps {
  researchFn?: typeof research;
  researchAgenticFn?: typeof researchAgentic;
  preflight?: (cfg: Configuration) => Promise<void>;
  preflightAgentModel?: (cfg: Configuration) => Promise<void>;
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const researchFn = deps.researchFn ?? research;
  const researchAgenticFn = deps.researchAgenticFn ?? researchAgentic;
  const preflight = deps.preflight ?? preflightOllama;
  const preflightAgentModelFn = deps.preflightAgentModel ?? preflightAgentModel;

  const server = new McpServer({ name: "local-deep-researcher", version });

  server.registerTool(
    "deep_research",
    {
      title: "Deep web research",
      description:
        "Run iterative local web research on a topic (search → summarize → reflect loop) and return a markdown report with sources. Uses a local LLM; may take several minutes.",
      inputSchema: {
        topic: z.string().describe("The research topic or question"),
        max_loops: z.number().int().min(0).optional().describe("Research loops (default 3)"),
        search_api: z.enum(["duckduckgo", "tavily", "perplexity", "searxng"]).optional(),
        grade_sources: z
          .boolean()
          .optional()
          .describe(
            "Grade sources for credibility and relevance before summarizing (default true)",
          ),
        source_domain_blocklist: z
          .string()
          .optional()
          .describe("Comma-separated domains to always reject"),
        count_empty_loops: z
          .boolean()
          .optional()
          .describe("Empty rounds also consume the loop budget (default false)"),
      },
    },
    async (
      { topic, max_loops, search_api, grade_sources, source_domain_blocklist, count_empty_loops },
      extra,
    ) => {
      const configurable: Record<string, unknown> = {};
      if (max_loops !== undefined) configurable.maxWebResearchLoops = max_loops;
      if (search_api !== undefined) configurable.searchApi = search_api;
      if (grade_sources !== undefined) configurable.gradeSources = grade_sources;
      if (source_domain_blocklist !== undefined)
        configurable.sourceDomainBlocklist = source_domain_blocklist;
      if (count_empty_loops !== undefined) configurable.countEmptyLoops = count_empty_loops;
      try {
        const cfg = ensureConfiguration({ configurable });
        validateConfiguration(cfg);
        await preflight(cfg);
        const progressToken = extra._meta?.progressToken;
        const report = await researchFn(topic, configurable, {
          onProgress: (event) => {
            if (progressToken === undefined) return;
            extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: event.loop,
                  total: cfg.maxWebResearchLoops + 1,
                  message: event.phase,
                },
              })
              .catch(() => {
                // client may have disconnected; progress is best-effort
              });
          },
        });
        return { content: [{ type: "text", text: report.markdown }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `deep_research failed: ${(error as Error).message}` }],
        };
      }
    },
  );

  server.registerTool(
    "deep_research_agent",
    {
      title: "Agentic deep web research",
      description:
        "Run agentic web research: an autonomous LLM agent decides its own searches, page fetches and notes in a tool-calling loop, then a report is written from the notes. Requires a local model with tool calling (e.g. qwen3). Uses a local LLM; may take several minutes.",
      inputSchema: {
        topic: z.string().describe("The research topic or question"),
        max_steps: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Max model calls in the agent loop (default 20)"),
        agent_llm: z
          .string()
          .optional()
          .describe("Tool-calling model for the agent loop (default: the configured local LLM)"),
        search_api: z.enum(["duckduckgo", "tavily", "perplexity", "searxng"]).optional(),
        source_domain_blocklist: z
          .string()
          .optional()
          .describe("Comma-separated domains to always reject"),
      },
    },
    async ({ topic, max_steps, agent_llm, search_api, source_domain_blocklist }, extra) => {
      const configurable: Record<string, unknown> = {};
      if (max_steps !== undefined) configurable.maxAgentSteps = max_steps;
      if (agent_llm !== undefined) configurable.agentLlm = agent_llm;
      if (search_api !== undefined) configurable.searchApi = search_api;
      if (source_domain_blocklist !== undefined)
        configurable.sourceDomainBlocklist = source_domain_blocklist;
      try {
        const cfg = ensureConfiguration({ configurable });
        validateConfiguration(cfg);
        await preflight(cfg);
        await preflightAgentModelFn(cfg);
        const progressToken = extra._meta?.progressToken;
        const report = await researchAgenticFn(topic, configurable, {
          onProgress: (event) => {
            if (progressToken === undefined) return;
            extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: event.step ?? event.loop,
                  total: cfg.maxAgentSteps,
                  message: event.phase,
                },
              })
              .catch(() => {
                // client may have disconnected; progress is best-effort
              });
          },
        });
        return { content: [{ type: "text", text: report.markdown }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `deep_research_agent failed: ${(error as Error).message}` },
          ],
        };
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
