import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureConfiguration } from "../src/configuration";
import type { SearchOptions, SearchProvider } from "../src/search/types";
import { getSearchProvider, searchWithRetry } from "../src/search/index";
import { duckduckgoSearch } from "../src/search/duckduckgo";
import { tavilySearch } from "../src/search/tavily";
import { perplexitySearch } from "../src/search/perplexity";
import { searxngSearch } from "../src/search/searxng";

vi.mock("duck-duck-scrape", () => ({
  SafeSearchType: { MODERATE: 0 },
  search: vi.fn(async () => ({
    results: [
      { title: "<b>DDG One</b>", url: "https://one.example", description: "first <i>hit</i>" },
      { title: "DDG Two", url: "https://two.example", description: "second hit" },
      { title: "DDG Three", url: "https://three.example", description: "third hit" },
      { title: "DDG Four", url: "https://four.example", description: "fourth hit" },
    ],
  })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function opts(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    maxResults: 3,
    fetchFullPage: false,
    loopCount: 0,
    config: ensureConfiguration({
      configurable: {
        tavilyApiKey: "tvly-test",
        perplexityApiKey: "pplx-test",
        searxngUrl: "http://searx.local",
      },
    }),
    ...overrides,
  };
}

describe("duckduckgoSearch", () => {
  it("maps and truncates results, stripping HTML", async () => {
    const results = await duckduckgoSearch("query", opts());
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "DDG One",
      url: "https://one.example",
      content: "first hit",
    });
  });
});

describe("tavilySearch", () => {
  it("POSTs to the Tavily API and maps results", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [
          { title: "T", url: "https://t.example", content: "tavily hit", raw_content: "full" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const results = await tavilySearch("query", opts({ maxResults: 1, fetchFullPage: true }));
    expect(results).toEqual([
      { title: "T", url: "https://t.example", content: "tavily hit", rawContent: "full" },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      query: "query",
      max_results: 1,
      include_raw_content: true,
    });
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 401 })),
    );
    await expect(tavilySearch("query", opts())).rejects.toThrow(/Tavily API error: 401/);
  });
});

describe("perplexitySearch", () => {
  it("maps the answer plus citations like the Python original", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { content: "The answer." } }],
          citations: ["https://c1.example", "https://c2.example"],
        }),
      ),
    );
    const results = await perplexitySearch("query", opts({ loopCount: 1 }));
    expect(results).toEqual([
      {
        title: "Perplexity Search 2, Source 1",
        url: "https://c1.example",
        content: "The answer.",
        rawContent: "The answer.",
      },
      {
        title: "Perplexity Search 2, Source 2",
        url: "https://c2.example",
        content: "See above content.",
        rawContent: "See above content.",
      },
    ]);
  });
});

describe("searxngSearch", () => {
  it("GETs the configured instance with format=json", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [{ title: "S", url: "https://s.example", content: "searx hit" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const results = await searxngSearch("query", opts());
    expect(results).toEqual([{ title: "S", url: "https://s.example", content: "searx hit" }]);
    const requested = String(fetchMock.mock.calls[0][0]);
    expect(requested).toContain("http://searx.local/search");
    expect(requested).toContain("format=json");
    expect(requested).toContain("q=query");
  });
});

describe("getSearchProvider", () => {
  it("resolves every configured name", () => {
    expect(getSearchProvider("duckduckgo")).toBe(duckduckgoSearch);
    expect(getSearchProvider("tavily")).toBe(tavilySearch);
    expect(getSearchProvider("perplexity")).toBe(perplexitySearch);
    expect(getSearchProvider("searxng")).toBe(searxngSearch);
  });
});

describe("searchWithRetry", () => {
  it("retries once after a failure", async () => {
    const provider: SearchProvider = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([{ title: "ok", url: "https://ok.example", content: "c" }]);
    const results = await searchWithRetry(provider, "q", opts(), 0);
    expect(results).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("propagates the second failure", async () => {
    const provider: SearchProvider = vi.fn().mockRejectedValue(new Error("down"));
    await expect(searchWithRetry(provider, "q", opts(), 0)).rejects.toThrow("down");
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
