import { describe, expect, it, vi } from "vitest";
import { createAgentTools, isPrivateTarget, type AgentToolsContext } from "../src/agent-tools";
import { ensureConfiguration } from "../src/configuration";
import type { SearchResult } from "../src/search/types";

function makeCtx(overrides: Partial<AgentToolsContext> = {}): AgentToolsContext {
  return {
    cfg: ensureConfiguration({ configurable: { sourceDomainBlocklist: "spam.example" } }),
    provider: vi.fn(async (): Promise<SearchResult[]> => [
      { title: "Good", url: "https://good.example/a", content: "useful content ".repeat(30) },
      { title: "Spam", url: "https://spam.example/x", content: "junk ".repeat(30) },
    ]),
    retryDelayMs: 0,
    seenUrls: new Set(),
    notes: [],
    warn: vi.fn(),
    ...overrides,
  };
}

function getTool(ctx: AgentToolsContext, name: string) {
  const found = createAgentTools(ctx).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe("web_search tool", () => {
  it("returns formatted results, applies blocklist and records seen urls", async () => {
    const ctx = makeCtx();
    const events: string[] = [];
    ctx.onToolEvent = (phase) => events.push(phase);
    const out = (await getTool(ctx, "web_search").invoke({ query: "test" })) as string;
    expect(out).toContain("https://good.example/a");
    expect(out).not.toContain("spam.example");
    expect(ctx.seenUrls.has("https://good.example/a")).toBe(true);
    expect(ctx.seenUrls.has("https://spam.example/x")).toBe(true);
    expect(events).toEqual(["searching"]);
  });

  it("steers the model to a different query when all results were already seen", async () => {
    const ctx = makeCtx({
      seenUrls: new Set(["https://good.example/a", "https://spam.example/x"]),
    });
    const out = (await getTool(ctx, "web_search").invoke({ query: "test" })) as string;
    expect(out).toContain("already seen");
    expect(out).toContain("differentiate");
  });

  it("reports no new relevant results when heuristics (not dedup) dropped everything", async () => {
    // A single thin result: dropped for content quality, not because it was seen.
    const ctx = makeCtx({
      provider: vi.fn(async (): Promise<SearchResult[]> => [
        { title: "Thin", url: "https://thin.example/x", content: "too short" },
      ]),
    });
    const out = (await getTool(ctx, "web_search").invoke({ query: "test" })) as string;
    expect(out).toContain("No new relevant results");
  });

  it("returns an error string instead of throwing when search fails", async () => {
    const ctx = makeCtx({ provider: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const out = (await getTool(ctx, "web_search").invoke({ query: "test" })) as string;
    expect(out).toContain("Search failed");
    expect(out).toContain("boom");
  });

  it("passes a per-context search counter as loopCount, incrementing per call", async () => {
    const ctx = makeCtx();
    const tool = getTool(ctx, "web_search");
    await tool.invoke({ query: "first" });
    await tool.invoke({ query: "second" });
    const provider = ctx.provider as unknown as { mock: { calls: unknown[][] } };
    expect(provider.mock.calls[0][1]).toMatchObject({ loopCount: 0 });
    expect(provider.mock.calls[1][1]).toMatchObject({ loopCount: 1 });
  });
});

describe("fetch_page tool", () => {
  it("returns page content truncated and emits fetching", async () => {
    const ctx = makeCtx({ fetchPage: vi.fn(async () => "x".repeat(20_000)) });
    const events: string[] = [];
    ctx.onToolEvent = (phase) => events.push(phase);
    const out = (await getTool(ctx, "fetch_page").invoke({
      url: "https://good.example/a",
    })) as string;
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(events).toEqual(["fetching"]);
  });

  it("returns an actionable message when fetch fails", async () => {
    const ctx = makeCtx({ fetchPage: vi.fn(async () => undefined) });
    const out = (await getTool(ctx, "fetch_page").invoke({ url: "https://bad.example" })) as string;
    expect(out).toContain("Could not fetch");
  });

  it("refuses localhost without invoking the fetch seam", async () => {
    const fetchPage = vi.fn(async () => "should not be called");
    const ctx = makeCtx({ fetchPage });
    const out = (await getTool(ctx, "fetch_page").invoke({
      url: "http://localhost:11434/api/tags",
    })) as string;
    expect(out).toBe(
      "Fetching local or private addresses is not allowed: http://localhost:11434/api/tags",
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("refuses a private-network address without invoking the fetch seam", async () => {
    const fetchPage = vi.fn(async () => "should not be called");
    const ctx = makeCtx({ fetchPage });
    const out = (await getTool(ctx, "fetch_page").invoke({
      url: "http://192.168.1.5/x",
    })) as string;
    expect(out).toBe("Fetching local or private addresses is not allowed: http://192.168.1.5/x");
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("still fetches a public address", async () => {
    const fetchPage = vi.fn(async () => "page content");
    const ctx = makeCtx({ fetchPage });
    const out = (await getTool(ctx, "fetch_page").invoke({
      url: "https://good.example/a",
    })) as string;
    expect(out).toBe("page content");
    expect(fetchPage).toHaveBeenCalledWith("https://good.example/a");
  });
});

describe("isPrivateTarget", () => {
  it("blocks loopback, private and link-local IPv4 addresses", () => {
    expect(isPrivateTarget("http://127.0.0.1/")).toBe(true);
    expect(isPrivateTarget("http://10.0.0.5/")).toBe(true);
    expect(isPrivateTarget("http://172.20.1.1/")).toBe(true);
    expect(isPrivateTarget("http://192.168.1.5/")).toBe(true);
    expect(isPrivateTarget("http://169.254.1.1/")).toBe(true);
    expect(isPrivateTarget("http://0.0.0.0/")).toBe(true);
  });

  it("blocks localhost hostnames", () => {
    expect(isPrivateTarget("http://localhost/")).toBe(true);
    expect(isPrivateTarget("http://foo.localhost/")).toBe(true);
  });

  it("blocks IPv6 loopback, link-local and unique-local addresses", () => {
    expect(isPrivateTarget("http://[::1]/")).toBe(true);
    expect(isPrivateTarget("http://[fe80::1]/")).toBe(true);
    expect(isPrivateTarget("http://[fc00::1]/")).toBe(true);
  });

  it("blocks non-http(s) protocols and unparseable URLs", () => {
    expect(isPrivateTarget("ftp://x")).toBe(true);
    expect(isPrivateTarget("not a url")).toBe(true);
  });

  it("allows public http(s) addresses", () => {
    expect(isPrivateTarget("https://good.example/a")).toBe(false);
    expect(isPrivateTarget("http://172.32.1.1/")).toBe(false);
  });
});

describe("take_note tool", () => {
  it("accumulates notes and confirms with a count", async () => {
    const ctx = makeCtx();
    const events: string[] = [];
    ctx.onToolEvent = (phase) => events.push(phase);
    const out = (await getTool(ctx, "take_note").invoke({
      note: "Finding A",
      source_url: "https://good.example/a",
      source_title: "Good",
    })) as string;
    expect(ctx.notes).toEqual([
      { note: "Finding A", sourceUrl: "https://good.example/a", sourceTitle: "Good" },
    ]);
    expect(out).toContain("1");
    expect(events).toEqual(["noting"]);
  });
});
