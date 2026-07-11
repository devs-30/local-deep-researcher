import { describe, expect, it, vi } from "vitest";
import { createAgentTools, type AgentToolsContext } from "../src/agent-tools";
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

  it("dedups already-seen urls and reports no new results", async () => {
    const ctx = makeCtx({
      seenUrls: new Set(["https://good.example/a", "https://spam.example/x"]),
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
