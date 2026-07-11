import type { SearchProvider } from "./types";

interface PerplexityResponse {
  choices: Array<{ message: { content: string } }>;
  citations?: string[];
}

export const perplexitySearch: SearchProvider = async (query, opts) => {
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.config.perplexityApiKey}`,
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: "Search the web and provide factual information with sources." },
        { role: "user", content: query },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Perplexity API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as PerplexityResponse;
  const content = data.choices[0]?.message.content ?? "";
  const citations = data.citations?.length ? data.citations : ["https://perplexity.ai"];
  const label = `Perplexity Search ${opts.loopCount + 1}`;
  return citations.map((url, index) => ({
    title: `${label}, Source ${index + 1}`,
    url,
    content: index === 0 ? content : "See above content.",
    rawContent: index === 0 ? content : "See above content.",
  }));
};
