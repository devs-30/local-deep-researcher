import { search, SafeSearchType } from "duck-duck-scrape";
import { fetchRawContent } from "./fetch";
import type { SearchProvider, SearchResult } from "./types";

/**
 * Backend chain ported from the Python `duckduckgo_search` (8.1.1) library used
 * by the original repo: each backend is tried in turn, an error switches to the
 * next one, and only when all fail is the last error thrown. The Python lib
 * chains html → lite (→ bing as its emergency backend); we keep duck-duck-scrape
 * (the vqd `d.js` API) first because it is the richest source when not blocked.
 */

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.5",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

/** Ad/tracking links skipped by the Python lib in every backend. */
const AD_PREFIXES = ["http://www.google.com/search?q=", "https://duckduckgo.com/y.js"];

const stripHtml = (text: string): string => text.replace(/<[^>]+>/g, "");

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const cleanText = (text: string): string =>
  decodeEntities(stripHtml(text)).replace(/\s+/g, " ").trim();

/** Resolve DDG redirect links (`//duckduckgo.com/l/?uddg=<url>`) to the target URL. */
function resolveDuckDuckGoUrl(href: string): string {
  const raw = decodeEntities(href);
  const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(absolute, "https://duckduckgo.com");
    if (url.hostname === "duckduckgo.com" && url.pathname === "/l/") {
      const uddg = url.searchParams.get("uddg");
      if (uddg) return uddg;
    }
    return absolute;
  } catch {
    return absolute;
  }
}

/** Decode Bing redirect links (`bing.com/ck/a?...&u=a1<base64url>`). */
function resolveBingUrl(href: string): string {
  const raw = decodeEntities(href);
  if (!raw.startsWith("https://www.bing.com/ck/a?")) return raw;
  try {
    const u = new URL(raw).searchParams.get("u") ?? "";
    if (u.length <= 2) return raw;
    const b64 = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf-8");
  } catch {
    return raw;
  }
}

const isAd = (href: string): boolean =>
  AD_PREFIXES.some((prefix) =>
    decodeEntities(href).replace(/^\/\//, "https://").startsWith(prefix),
  );

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of html.split(/<div[^>]*class="result\b/).slice(1)) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link || isAd(link[1])) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({
      title: cleanText(link[2]),
      url: resolveDuckDuckGoUrl(link[1]),
      content: cleanText(snippet?.[1] ?? ""),
    });
  }
  return results;
}

export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const re =
    /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    if (isAd(match[1])) continue;
    results.push({
      title: cleanText(match[2]),
      url: resolveDuckDuckGoUrl(match[1]),
      content: cleanText(match[3]),
    });
  }
  return results;
}

export function parseBingHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of html.split(/<li[^>]*class="b_algo\b/).slice(1)) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    results.push({
      title: cleanText(link[2]),
      url: resolveBingUrl(link[1]),
      content: cleanText(snippet?.[1] ?? ""),
    });
  }
  return results;
}

async function fetchBackendPage(
  url: string,
  referer: string,
  body?: URLSearchParams,
): Promise<string> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...BROWSER_HEADERS, referer },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

type Backend = (query: string, maxResults: number) => Promise<SearchResult[]>;

const apiBackend: Backend = async (query, maxResults) => {
  const response = await search(query, { safeSearch: SafeSearchType.MODERATE });
  const results = response.results.slice(0, maxResults).map((r) => ({
    title: stripHtml(r.title),
    url: r.url,
    content: stripHtml(r.description),
  }));
  if (results.length === 0) throw new Error("duck-duck-scrape returned no results");
  return results;
};

/**
 * Shared shape of the scraping backends: the Python lib returns [] on the
 * genuine empty-results marker, while an unparseable page (bot challenge,
 * markup change — surfaced there as non-200 ratelimit statuses) becomes an
 * error that moves the chain to the next backend.
 */
function scrapeBackend(
  request: (query: string) => Promise<string>,
  emptyMarker: string,
  parse: (html: string) => SearchResult[],
  name: string,
): Backend {
  return async (query, maxResults) => {
    const page = await request(query);
    if (page.includes(emptyMarker)) return [];
    const results = parse(page);
    if (results.length === 0) {
      throw new Error(`DuckDuckGo ${name} backend returned no results (likely a bot challenge)`);
    }
    return results.slice(0, maxResults);
  };
}

const htmlBackend = scrapeBackend(
  (query) =>
    fetchBackendPage(
      "https://html.duckduckgo.com/html",
      "https://html.duckduckgo.com/",
      new URLSearchParams({ q: query, b: "" }),
    ),
  "No  results.",
  parseDuckDuckGoHtml,
  "html",
);

const liteBackend = scrapeBackend(
  (query) =>
    fetchBackendPage(
      "https://lite.duckduckgo.com/lite/",
      "https://lite.duckduckgo.com/",
      new URLSearchParams({ q: query, b: "" }),
    ),
  "No more results.",
  parseDuckDuckGoLite,
  "lite",
);

const bingBackend = scrapeBackend(
  (query) =>
    fetchBackendPage(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      "https://www.bing.com/",
    ),
  "There are no results for",
  parseBingHtml,
  "bing",
);

export const duckduckgoSearch: SearchProvider = async (query, opts) => {
  const backends: Backend[] = [apiBackend, htmlBackend, liteBackend, bingBackend];
  let lastError: unknown;
  for (const backend of backends) {
    let results: SearchResult[];
    try {
      results = await backend(query, opts.maxResults);
    } catch (err) {
      lastError = err;
      continue;
    }
    if (opts.fetchFullPage) {
      for (const result of results) result.rawContent = await fetchRawContent(result.url);
    }
    return results;
  }
  throw lastError;
};
