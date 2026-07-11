import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureConfiguration, validateConfiguration, type Configuration } from "./configuration";
import { preflightOllama } from "./preflight";
import { research } from "./research";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export interface McpDeps {
  researchFn?: typeof research;
  preflight?: (cfg: Configuration) => Promise<void>;
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const researchFn = deps.researchFn ?? research;
  const preflight = deps.preflight ?? preflightOllama;

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
      },
    },
    async ({ topic, max_loops, search_api }, extra) => {
      const configurable: Record<string, unknown> = {};
      if (max_loops !== undefined) configurable.maxWebResearchLoops = max_loops;
      if (search_api !== undefined) configurable.searchApi = search_api;
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

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
