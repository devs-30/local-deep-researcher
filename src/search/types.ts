import type { Configuration } from "../configuration";

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
}

export interface SearchOptions {
  maxResults: number;
  fetchFullPage: boolean;
  /** 0-based research loop counter (used by the Perplexity provider for labels). */
  loopCount: number;
  config: Configuration;
}

export type SearchProvider = (query: string, opts: SearchOptions) => Promise<SearchResult[]>;
