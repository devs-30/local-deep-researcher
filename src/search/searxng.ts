import { fetchRawContent } from "./fetch";
import type { SearchProvider, SearchResult } from "./types";

interface SearxngResponse {
  results?: Array<{ title: string; url: string; content?: string }>;
}

export const searxngSearch: SearchProvider = async (query, opts) => {
  const base = opts.config.searxngUrl!.endsWith("/")
    ? opts.config.searxngUrl!
    : `${opts.config.searxngUrl}/`;
  const url = new URL("search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`SearXNG error: ${res.status}`);
  const data = (await res.json()) as SearxngResponse;
  const results: SearchResult[] = (data.results ?? []).slice(0, opts.maxResults).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content ?? "",
  }));
  if (opts.fetchFullPage) {
    for (const result of results) result.rawContent = await fetchRawContent(result.url);
  }
  return results;
};
