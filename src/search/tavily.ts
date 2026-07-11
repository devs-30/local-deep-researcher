import type { SearchProvider } from "./types";

interface TavilyResponse {
  results?: Array<{ title: string; url: string; content: string; raw_content?: string | null }>;
}

export const tavilySearch: SearchProvider = async (query, opts) => {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.config.tavilyApiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: opts.maxResults,
      include_raw_content: opts.fetchFullPage,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as TavilyResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    ...(r.raw_content ? { rawContent: r.raw_content } : {}),
  }));
};
