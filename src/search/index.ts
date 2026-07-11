import type { Configuration } from "../configuration";
import { duckduckgoSearch } from "./duckduckgo";
import { tavilySearch } from "./tavily";
import { perplexitySearch } from "./perplexity";
import { searxngSearch } from "./searxng";
import type { SearchOptions, SearchProvider, SearchResult } from "./types";

export type { SearchOptions, SearchProvider, SearchResult } from "./types";
export { duckduckgoSearch, tavilySearch, perplexitySearch, searxngSearch };

export function getSearchProvider(name: Configuration["searchApi"]): SearchProvider {
  switch (name) {
    case "duckduckgo":
      return duckduckgoSearch;
    case "tavily":
      return tavilySearch;
    case "perplexity":
      return perplexitySearch;
    case "searxng":
      return searxngSearch;
  }
}

/** One retry with a small delay; the second failure propagates to the caller. */
export async function searchWithRetry(
  provider: SearchProvider,
  query: string,
  opts: SearchOptions,
  retryDelayMs = 1000,
): Promise<SearchResult[]> {
  try {
    return await provider(query, opts);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return provider(query, opts);
  }
}
