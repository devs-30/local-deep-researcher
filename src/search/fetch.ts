import TurndownService from "turndown";

const turndown = new TurndownService();

/**
 * Fetch a page and convert HTML to markdown (port of fetch_raw_content).
 * Failures are silent by design: the caller keeps the search snippet instead.
 */
export async function fetchRawContent(
  url: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "local-deep-researcher" },
    });
    if (!res.ok) return undefined;
    return turndown.turndown(await res.text());
  } catch {
    return undefined;
  }
}
