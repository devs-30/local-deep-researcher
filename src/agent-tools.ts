import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { Configuration } from "./configuration";
import { applyHeuristics, parseBlocklist } from "./grade";
import { fetchRawContent } from "./search/fetch";
import { searchWithRetry } from "./search/index";
import type { SearchProvider, SearchResult } from "./search/types";

export interface AgentNote {
  note: string;
  sourceUrl: string;
  sourceTitle?: string;
}

export type AgentToolPhase = "searching" | "fetching" | "noting";

export interface AgentToolsContext {
  cfg: Configuration;
  provider: SearchProvider;
  retryDelayMs: number;
  seenUrls: Set<string>;
  notes: AgentNote[];
  warn: (message: string) => void;
  onToolEvent?: (phase: AgentToolPhase) => void;
  /** Test seam; defaults to fetchRawContent. */
  fetchPage?: typeof fetchRawContent;
}

// Same per-source budget as the workflow (MAX_TOKENS_PER_SOURCE * 4 chars).
const MAX_EXCERPT_CHARS = 4000;
const MAX_PAGE_CHARS = 8000;

export function createAgentTools(ctx: AgentToolsContext): StructuredToolInterface[] {
  const fetchPage = ctx.fetchPage ?? fetchRawContent;

  const webSearch = tool(
    async ({ query }: { query: string }) => {
      ctx.onToolEvent?.("searching");
      let results: SearchResult[];
      try {
        results = await searchWithRetry(
          ctx.provider,
          query,
          {
            maxResults: ctx.cfg.searchApi === "tavily" ? 1 : 3,
            fetchFullPage: ctx.cfg.fetchFullPage,
            loopCount: 0,
            config: ctx.cfg,
          },
          ctx.retryDelayMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.warn(`web_search failed: ${message}`);
        return `Search failed: ${message}. Try a different, simpler query.`;
      }
      const { kept, dropped } = applyHeuristics(results, {
        blocklist: parseBlocklist(ctx.cfg.sourceDomainBlocklist),
        fetchFullPage: ctx.cfg.fetchFullPage,
        gradedUrls: ctx.seenUrls,
      });
      for (const { result, reason } of dropped) {
        ctx.warn(`web_search: dropped ${result.url} (${reason})`);
      }
      for (const r of results) ctx.seenUrls.add(r.url);
      if (kept.length === 0) return "No new relevant results. Try a different query.";
      return kept
        .map(
          (r) =>
            `Title: ${r.title}\nURL: ${r.url}\nContent: ${(r.rawContent?.trim() || r.content).slice(0, MAX_EXCERPT_CHARS)}`,
        )
        .join("\n\n---\n\n");
    },
    {
      name: "web_search",
      description:
        "Search the web. Returns titles, URLs and content excerpts. Low-quality and already-seen results are filtered out.",
      schema: z.object({ query: z.string().describe("The search query") }),
    },
  );

  const fetchPageTool = tool(
    async ({ url }: { url: string }) => {
      ctx.onToolEvent?.("fetching");
      const content = await fetchPage(url);
      if (!content) {
        return `Could not fetch ${url}. Use the search excerpt instead or try another source.`;
      }
      return content.slice(0, MAX_PAGE_CHARS);
    },
    {
      name: "fetch_page",
      description:
        "Fetch the full content of one web page as markdown. Use only when a search excerpt is not enough.",
      schema: z.object({ url: z.string().describe("URL from a web_search result") }),
    },
  );

  const takeNote = tool(
    async ({
      note,
      source_url,
      source_title,
    }: {
      note: string;
      source_url: string;
      source_title?: string;
    }) => {
      ctx.onToolEvent?.("noting");
      ctx.notes.push({ note, sourceUrl: source_url, sourceTitle: source_title });
      return `Noted (${ctx.notes.length} notes so far).`;
    },
    {
      name: "take_note",
      description: "Record ONE distinct research finding with its source. Call once per finding.",
      schema: z.object({
        note: z.string().describe("The finding, 1-3 sentences"),
        source_url: z.string().describe("URL supporting the finding"),
        source_title: z.string().optional().describe("Title of the source"),
      }),
    },
  );

  return [webSearch, fetchPageTool, takeNote];
}
