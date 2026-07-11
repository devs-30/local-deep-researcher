import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureConfiguration } from "../src/configuration";
import type { SearchOptions } from "../src/search/types";
import {
  duckduckgoSearch,
  parseBingHtml,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
} from "../src/search/duckduckgo";

const ddsSearch = vi.hoisted(() => vi.fn());
vi.mock("duck-duck-scrape", () => ({
  SafeSearchType: { MODERATE: 0 },
  search: ddsSearch,
}));

beforeEach(() => {
  ddsSearch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function opts(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    maxResults: 3,
    fetchFullPage: false,
    loopCount: 0,
    config: ensureConfiguration({}),
    ...overrides,
  };
}

const HTML_PAGE = `
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Great docs &amp; more</a>
  </div>
  <div class="result result--ad">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Sponsored</a>
    </h2>
    <a class="result__snippet" href="#">Buy now</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://plain.example/page">Plain link</a>
    </h2>
    <a class="result__snippet" href="#">Second snippet</a>
  </div>
</div>`;

const LITE_PAGE = `
<table>
  <tr><td>1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2Fa" class='result-link'>Lite A</a></td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Snippet A</td></tr>
  <tr><td>2.&nbsp;</td><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=ads.example" class='result-link'>Sponsored</a></td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Ad snippet</td></tr>
  <tr><td>3.&nbsp;</td><td><a rel="nofollow" href="https://lite.example/b" class='result-link'>Lite B</a></td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Snippet B</td></tr>
</table>`;

// u=a1<base64url("https://example.com/docs")>
const BING_PAGE = `
<ol id="b_results">
  <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=xyz&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9kb2Nz&amp;ntb=1">Bing Docs</a></h2><div class="b_caption"><p>Bing snippet</p></div></li>
  <li class="b_algo"><h2><a href="https://direct.example/page">Direct</a></h2><div class="b_caption"><p>Direct snippet</p></div></li>
</ol>`;

describe("parseDuckDuckGoHtml", () => {
  it("decodes uddg redirects, strips markup and skips ads", () => {
    const results = parseDuckDuckGoHtml(HTML_PAGE);
    expect(results).toEqual([
      { title: "Example Docs", url: "https://example.com/docs", content: "Great docs & more" },
      { title: "Plain link", url: "https://plain.example/page", content: "Second snippet" },
    ]);
  });
});

describe("parseDuckDuckGoLite", () => {
  it("pairs result links with snippets and skips ads", () => {
    const results = parseDuckDuckGoLite(LITE_PAGE);
    expect(results).toEqual([
      { title: "Lite A", url: "https://lite.example/a", content: "Snippet A" },
      { title: "Lite B", url: "https://lite.example/b", content: "Snippet B" },
    ]);
  });
});

describe("parseBingHtml", () => {
  it("decodes bing.com/ck/a base64 redirects", () => {
    const results = parseBingHtml(BING_PAGE);
    expect(results).toEqual([
      { title: "Bing Docs", url: "https://example.com/docs", content: "Bing snippet" },
      { title: "Direct", url: "https://direct.example/page", content: "Direct snippet" },
    ]);
  });
});

describe("duckduckgoSearch backend chain", () => {
  it("returns api results without touching fetch when duck-duck-scrape works", async () => {
    ddsSearch.mockResolvedValue({
      results: [{ title: "<b>API</b>", url: "https://api.example", description: "api <i>hit</i>" }],
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const results = await duckduckgoSearch("query", opts());
    expect(results).toEqual([{ title: "API", url: "https://api.example", content: "api hit" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the html backend (POST with browser headers) when the api is blocked", async () => {
    ddsSearch.mockRejectedValue(new Error("anomaly 202"));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(HTML_PAGE));
    vi.stubGlobal("fetch", fetchMock);

    const results = await duckduckgoSearch("test query", opts());
    expect(results[0].url).toBe("https://example.com/docs");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://html.duckduckgo.com/html");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("q=test+query&b=");
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toContain("Firefox");
    expect(headers["sec-fetch-mode"]).toBe("navigate");
    expect(headers.referer).toBe("https://html.duckduckgo.com/");
  });

  it("falls back to the lite backend when api and html fail", async () => {
    ddsSearch.mockRejectedValue(new Error("anomaly 202"));
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("html.duckduckgo.com")
        ? new Response("", { status: 403 })
        : new Response(LITE_PAGE),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await duckduckgoSearch("query", opts());
    expect(results[0]).toEqual({
      title: "Lite A",
      url: "https://lite.example/a",
      content: "Snippet A",
    });
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://lite.duckduckgo.com/lite/");
  });

  it("falls back to the bing backend when api, html and lite all fail", async () => {
    ddsSearch.mockRejectedValue(new Error("anomaly 202"));
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("bing.com")
        ? new Response(BING_PAGE)
        : new Response("", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await duckduckgoSearch("query", opts());
    expect(results[0].url).toBe("https://example.com/docs");
    const bingCall = String(fetchMock.mock.calls[2][0]);
    expect(bingCall).toBe("https://www.bing.com/search?q=query");
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("GET");
  });

  it("throws the last backend error when every backend fails", async () => {
    ddsSearch.mockRejectedValue(new Error("anomaly 202"));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(duckduckgoSearch("query", opts())).rejects.toThrow(/bing\.com.*429/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops the chain with an empty list on the genuine no-results marker", async () => {
    ddsSearch.mockRejectedValue(new Error("anomaly 202"));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("<div>No  results.</div>"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(duckduckgoSearch("query", opts())).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an unparseable page as a bot challenge and moves on", async () => {
    ddsSearch.mockRejectedValue(new Error("anomaly 202"));
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("html.duckduckgo.com")
        ? new Response("<html>challenge wall</html>")
        : new Response(LITE_PAGE),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await duckduckgoSearch("query", opts());
    expect(results[0].title).toBe("Lite A");
  });
});
