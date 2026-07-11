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
  /** Current model-call usage, reported back to the model in take_note confirmations. */
  budget?: () => { used: number; max: number };
}

// Same per-source budget as the workflow (MAX_TOKENS_PER_SOURCE * 4 chars).
const MAX_EXCERPT_CHARS = 4000;
// Generous enough to keep long catalog/list pages mostly intact after markdown
// conversion, while still bounding context growth for local models.
const MAX_PAGE_CHARS = 16_000;

// 172.16.0.0/12 spans second-octet values 16-31.
const IPV4_172_PRIVATE_RANGE = { min: 16, max: 31 };

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return false;
  }
  const [a, b] = parts.map(Number);
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= IPV4_172_PRIVATE_RANGE.min && b <= IPV4_172_PRIVATE_RANGE.max) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 0 && b === 0) return true; // 0.0.0.0
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const addr = hostname.slice(1, -1).toLowerCase();
  if (addr === "::1") return true; // loopback
  if (/^fe[89ab][0-9a-f]?:/.test(addr) || addr === "fe80") return true; // fe80::/10 (link-local)
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true; // fc00::/7 (unique-local)
  return false;
}

/** Pure, unit-testable guard: true when a URL must not be fetched (local/private/unparseable). */
export function isPrivateTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isPrivateIPv4(hostname)) return true;
  if (isPrivateIPv6(hostname)) return true;
  return false;
}

export function createAgentTools(ctx: AgentToolsContext): StructuredToolInterface[] {
  const fetchPage = ctx.fetchPage ?? fetchRawContent;
  let searchCount = 0;

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
            loopCount: searchCount,
            config: ctx.cfg,
          },
          ctx.retryDelayMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.warn(`web_search failed: ${message}`);
        return `Search failed: ${message}. Try a different, simpler query.`;
      }
      searchCount += 1;
      const { kept, dropped } = applyHeuristics(results, {
        blocklist: parseBlocklist(ctx.cfg.sourceDomainBlocklist),
        fetchFullPage: ctx.cfg.fetchFullPage,
        gradedUrls: ctx.seenUrls,
      });
      for (const { result, reason } of dropped) {
        ctx.warn(`web_search: dropped ${result.url} (${reason})`);
      }
      for (const r of results) ctx.seenUrls.add(r.url);
      if (kept.length === 0) {
        const allSeen =
          results.length > 0 &&
          dropped.every(
            (d) =>
              d.reason === "already graded in a previous loop" ||
              d.reason === "duplicate URL in this round",
          );
        // Repeated near-identical queries only resurface known pages; tell the
        // model explicitly so it changes angle instead of burning budget.
        if (allSeen) {
          return "All results were already seen in previous searches. Try another query that will differentiate the results (different keywords, site, or angle), or note what you already have.";
        }
        return "No new relevant results. Try a different query.";
      }
      // In-context nudge: system-prompt rules fade for small models, but a hint
      // attached to the result they are looking at right now gets followed.
      const results_ = kept
        .map(
          (r) =>
            `Title: ${r.title}\nURL: ${r.url}\nContent: ${(r.rawContent?.trim() || r.content).slice(0, MAX_EXCERPT_CHARS)}`,
        )
        .join("\n\n---\n\n");
      return `${results_}\n\n(Note: excerpts are truncated. Call fetch_page(url) to read a page in full - always do this for catalog, list or customer-stories pages before noting.)`;
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
      try {
        new URL(url);
      } catch {
        return `Invalid URL: ${url}`;
      }
      if (isPrivateTarget(url)) {
        return `Fetching local or private addresses is not allowed: ${url}`;
      }
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
      // Anti-satisficing nudge at the exact moment the model decides whether to
      // stop: models tend to quit after one rich haul even when the user asked
      // for exhaustive coverage and most of the budget is unspent.
      const budget = ctx.budget?.();
      const budgetInfo = budget ? ` at model call ${budget.used} of ${budget.max}` : "";
      return `Noted (${ctx.notes.length} notes so far${budgetInfo}). If the user asked for an exhaustive answer, keep searching from new angles - stop only when searches surface nothing new.`;
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
