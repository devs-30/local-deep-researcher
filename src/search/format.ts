import type { SearchResult } from "./types";

const CHARS_PER_TOKEN = 4;

/** Port of deduplicate_and_format_sources: dedup by URL, format one block per source. */
export function deduplicateAndFormatSources(
  results: SearchResult[],
  maxTokensPerSource: number,
  fetchFullPage: boolean,
): string {
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    if (!unique.has(result.url)) unique.set(result.url, result);
  }
  let formatted = "Sources:\n\n";
  for (const source of unique.values()) {
    formatted += `Source: ${source.title}\n===\n`;
    formatted += `URL: ${source.url}\n===\n`;
    formatted += `Most relevant content from source: ${source.content}\n===\n`;
    if (fetchFullPage) {
      const charLimit = maxTokensPerSource * CHARS_PER_TOKEN;
      let raw = source.rawContent ?? "";
      if (raw.length > charLimit) raw = raw.slice(0, charLimit) + "... [truncated]";
      formatted += `Full source content limited to ${maxTokensPerSource} tokens: ${raw}\n\n`;
    }
  }
  return formatted.trim();
}

/** Port of format_sources: bullet list "* title : url". */
export function formatSources(results: SearchResult[]): string {
  return results.map((r) => `* ${r.title} : ${r.url}`).join("\n");
}

/** Inverse of formatSources for structured library output; splits on the LAST " : ". */
export function parseSourceLine(line: string): { title: string; url: string } {
  const body = line.replace(/^\*\s*/, "");
  const idx = body.lastIndexOf(" : ");
  if (idx === -1) return { title: body, url: "" };
  return { title: body.slice(0, idx), url: body.slice(idx + 3) };
}
