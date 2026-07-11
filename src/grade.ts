import type { SearchResult } from "./search/types";

const MIN_CONTENT_CHARS = 50;
const MIN_FULL_PAGE_WORDS = 300;

export interface HeuristicsOptions {
  blocklist: string[];
  fetchFullPage: boolean;
  gradedUrls: Set<string>;
}

export interface DroppedSource {
  result: SearchResult;
  reason: string;
}

export interface HeuristicsOutcome {
  kept: SearchResult[];
  dropped: DroppedSource[];
}

/** Split a comma-separated blocklist into normalized host entries. */
export function parseBlocklist(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Dot-boundary suffix match: "example.com" blocks "example.com" and "www.example.com". */
export function isBlockedHost(url: string, blocklist: string[]): boolean {
  if (blocklist.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return blocklist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Stage-1 grading: drop evident junk without any LLM cost. */
export function applyHeuristics(
  results: SearchResult[],
  opts: HeuristicsOptions,
): HeuristicsOutcome {
  const kept: SearchResult[] = [];
  const dropped: DroppedSource[] = [];
  const seenThisRound = new Set<string>();
  for (const result of results) {
    if (opts.gradedUrls.has(result.url)) {
      dropped.push({ result, reason: "already graded in a previous loop" });
      continue;
    }
    if (seenThisRound.has(result.url)) {
      dropped.push({ result, reason: "duplicate URL in this round" });
      continue;
    }
    seenThisRound.add(result.url);
    if (isBlockedHost(result.url, opts.blocklist)) {
      dropped.push({ result, reason: "blocklisted domain" });
      continue;
    }
    const bestText = (result.rawContent?.trim() || result.content.trim()) ?? "";
    if (bestText.length < MIN_CONTENT_CHARS) {
      dropped.push({ result, reason: "thin content" });
      continue;
    }
    if (
      opts.fetchFullPage &&
      result.rawContent !== undefined &&
      countWords(result.rawContent) < MIN_FULL_PAGE_WORDS
    ) {
      dropped.push({ result, reason: "thin full page (content-farm signal)" });
      continue;
    }
    kept.push(result);
  }
  return { kept, dropped };
}
