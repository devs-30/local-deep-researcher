import { describe, expect, it } from "vitest";
import { applyHeuristics, isBlockedHost, parseBlocklist } from "../src/grade";
import type { SearchResult } from "../src/search/types";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "A useful article",
    url: "https://example.com/article",
    content: "A substantive snippet about the topic that is clearly long enough to keep.",
    ...overrides,
  };
}

const noOpts = { blocklist: [], fetchFullPage: false, gradedUrls: new Set<string>() };

describe("parseBlocklist", () => {
  it("splits, trims, lowercases and drops empties", () => {
    expect(parseBlocklist(" Spam.example, junk.example ,, ")).toEqual([
      "spam.example",
      "junk.example",
    ]);
  });

  it("returns [] for an empty string", () => {
    expect(parseBlocklist("")).toEqual([]);
  });
});

describe("isBlockedHost", () => {
  it("matches the exact host and subdomains at a dot boundary", () => {
    expect(isBlockedHost("https://example.com/x", ["example.com"])).toBe(true);
    expect(isBlockedHost("https://www.example.com/x", ["example.com"])).toBe(true);
    expect(isBlockedHost("https://notexample.com/x", ["example.com"])).toBe(false);
  });

  it("is false for unparsable URLs and empty blocklists", () => {
    expect(isBlockedHost("not a url", ["example.com"])).toBe(false);
    expect(isBlockedHost("https://example.com/x", [])).toBe(false);
  });
});

describe("applyHeuristics", () => {
  it("keeps a normal source with an empty blocklist", () => {
    const outcome = applyHeuristics([result()], noOpts);
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.dropped).toHaveLength(0);
  });

  it("drops blocklisted domains with a reason", () => {
    const outcome = applyHeuristics([result()], { ...noOpts, blocklist: ["example.com"] });
    expect(outcome.kept).toHaveLength(0);
    expect(outcome.dropped[0].reason).toContain("blocklist");
  });

  it("drops thin content below 50 chars", () => {
    const outcome = applyHeuristics([result({ content: "too short" })], noOpts);
    expect(outcome.kept).toHaveLength(0);
    expect(outcome.dropped[0].reason).toContain("thin");
  });

  it("uses rawContent for the thin-content bar when present", () => {
    const long = "word ".repeat(400);
    const outcome = applyHeuristics([result({ content: "short", rawContent: long })], {
      ...noOpts,
      fetchFullPage: true,
    });
    expect(outcome.kept).toHaveLength(1);
  });

  it("applies the 300-word content-farm bar only to full pages", () => {
    const thinPage = "word ".repeat(100); // 100 words, > 50 chars
    const fullPage = applyHeuristics([result({ rawContent: thinPage })], {
      ...noOpts,
      fetchFullPage: true,
    });
    expect(fullPage.kept).toHaveLength(0);
    expect(fullPage.dropped[0].reason).toContain("thin full page");
    const snippetOnly = applyHeuristics([result()], noOpts);
    expect(snippetOnly.kept).toHaveLength(1);
  });

  it("drops URLs already graded in previous loops", () => {
    const outcome = applyHeuristics([result()], {
      ...noOpts,
      gradedUrls: new Set(["https://example.com/article"]),
    });
    expect(outcome.kept).toHaveLength(0);
    expect(outcome.dropped[0].reason).toContain("already graded");
  });

  it("drops duplicate URLs within the same round", () => {
    const outcome = applyHeuristics([result(), result()], noOpts);
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.dropped).toHaveLength(1);
  });
});
