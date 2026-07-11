import { search, SafeSearchType } from "duck-duck-scrape";
import { fetchRawContent } from "./fetch";
import type { SearchProvider, SearchResult } from "./types";

const stripHtml = (text: string): string => text.replace(/<[^>]+>/g, "");

export const duckduckgoSearch: SearchProvider = async (query, opts) => {
  const response = await search(query, { safeSearch: SafeSearchType.MODERATE });
  const results: SearchResult[] = response.results.slice(0, opts.maxResults).map((r) => ({
    title: stripHtml(r.title),
    url: r.url,
    content: stripHtml(r.description),
  }));
  if (opts.fetchFullPage) {
    for (const result of results) result.rawContent = await fetchRawContent(result.url);
  }
  return results;
};
