import TurndownService from "turndown";

const turndown = new TurndownService();
turndown.remove(["script", "style", "noscript"]);

// Elements that carry page chrome or code, not content. <header> is kept on
// purpose: HTML5 articles legitimately wrap their own title in a <header>.
// The non-greedy regex is a heuristic (nested same-name tags leave residue),
// which is fine here - the goal is fewer junk tokens, not perfect extraction.
const BOILERPLATE_TAGS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "form",
  "template",
  "nav",
  "footer",
  "aside",
];

export function stripBoilerplate(html: string): string {
  let result = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of BOILERPLATE_TAGS) {
    result = result.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi"), "");
  }
  return result;
}

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
    return turndown.turndown(stripBoilerplate(await res.text()));
  } catch {
    return undefined;
  }
}
