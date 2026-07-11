import { parseArgs } from "node:util";
import { ConfigurationError } from "./configuration";

export interface CliOptions {
  topic: string;
  configurable: Record<string, unknown>;
  output?: string;
  json: boolean;
  quiet: boolean;
}

export type CliCommand =
  | { kind: "research"; options: CliOptions }
  | { kind: "mcp" }
  | { kind: "help" }
  | { kind: "version" };

export const HELP = `local-deep-researcher - fully local iterative web research (LangGraph.js)

Usage:
  local-deep-researcher "<topic>" [options]
  local-deep-researcher mcp                 Start the MCP stdio server

Options:
  --max-loops <n>        Research loops (default 3; N yields N+1 productive rounds)
  --provider <name>      ollama | openai_compatible (default ollama)
  --model <name>         Model name (default gemma4:e4b, env LOCAL_LLM)
  --base-url <url>       LLM base URL (Ollama or OpenAI-compatible endpoint)
  --search-api <name>    duckduckgo | tavily | perplexity | searxng (default duckduckgo)
  --fetch-full-page      Fetch full page content for each source
  --no-grade-sources     Disable source grading (credibility heuristics + LLM relevance filter)
  --blocklist <domains>  Comma-separated domains to always reject (e.g. spam.example,junk.example)
  --count-empty-loops    Empty rounds (no sources kept) also consume the loop budget (v0.2.x behavior)
  -o, --output <file>    Write the report to a file instead of stdout
  --json                 Output {"summary", "sources"} JSON instead of markdown
  -q, --quiet            Suppress progress output on stderr
  -h, --help             Show this help
  -v, --version          Show version

Environment: TAVILY_API_KEY, PERPLEXITY_API_KEY, SEARXNG_URL, OLLAMA_BASE_URL,
OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, GRADE_SOURCES, SOURCE_DOMAIN_BLOCKLIST, COUNT_EMPTY_LOOPS (also read from .env).`;

export function parseCliArgs(argv: string[]): CliCommand {
  if (argv[0] === "mcp") return { kind: "mcp" };
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "max-loops": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "search-api": { type: "string" },
      "fetch-full-page": { type: "boolean" },
      "no-grade-sources": { type: "boolean" },
      blocklist: { type: "string" },
      "count-empty-loops": { type: "boolean" },
      output: { type: "string", short: "o" },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const topic = positionals.join(" ").trim();
  if (!topic) {
    throw new ConfigurationError(
      'Missing research topic. Usage: local-deep-researcher "<topic>" [options]',
    );
  }
  const configurable: Record<string, unknown> = {};
  if (values["max-loops"] !== undefined) configurable.maxWebResearchLoops = values["max-loops"];
  if (values.provider !== undefined) configurable.llmProvider = values.provider;
  if (values.model !== undefined) configurable.localLlm = values.model;
  if (values["search-api"] !== undefined) configurable.searchApi = values["search-api"];
  if (values["fetch-full-page"] !== undefined)
    configurable.fetchFullPage = values["fetch-full-page"];
  if (values["no-grade-sources"]) configurable.gradeSources = false;
  if (values.blocklist !== undefined) configurable.sourceDomainBlocklist = values.blocklist;
  if (values["count-empty-loops"]) configurable.countEmptyLoops = true;
  if (values["base-url"] !== undefined) {
    configurable.ollamaBaseUrl = values["base-url"];
    configurable.openaiCompatibleBaseUrl = values["base-url"];
  }
  return {
    kind: "research",
    options: {
      topic,
      configurable,
      output: values.output,
      json: values.json ?? false,
      quiet: values.quiet ?? false,
    },
  };
}
