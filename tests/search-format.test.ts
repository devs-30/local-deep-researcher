import { describe, expect, it } from "vitest";
import { deduplicateAndFormatSources, formatSources, parseSourceLine } from "../src/search/format";
import type { SearchResult } from "../src/search/types";

const results: SearchResult[] = [
  { title: "A", url: "https://a.example", content: "alpha", rawContent: "x".repeat(5000) },
  { title: "B", url: "https://b.example", content: "beta" },
  { title: "A-dup", url: "https://a.example", content: "duplicate of A" },
];

describe("deduplicateAndFormatSources", () => {
  it("deduplicates by URL and formats sections", () => {
    const text = deduplicateAndFormatSources(results, 1000, false);
    expect(text).toContain("Sources:");
    expect(text).toContain("Source: A\n===");
    expect(text).toContain("URL: https://a.example");
    expect(text).toContain("Most relevant content from source: alpha");
    expect(text).toContain("Source: B\n===");
    expect(text).not.toContain("A-dup");
    expect(text).not.toContain("Full source content");
  });

  it("appends truncated raw content when fetchFullPage=true", () => {
    const text = deduplicateAndFormatSources(results, 1000, true);
    expect(text).toContain("Full source content limited to 1000 tokens:");
    expect(text).toContain("... [truncated]");
  });
});

describe("formatSources / parseSourceLine", () => {
  it("formats one bullet line per result", () => {
    expect(formatSources(results.slice(0, 2))).toBe(
      "* A : https://a.example\n* B : https://b.example",
    );
  });

  it("round-trips through parseSourceLine", () => {
    expect(parseSourceLine("* A : https://a.example")).toEqual({
      title: "A",
      url: "https://a.example",
    });
  });

  it("keeps colons inside titles intact", () => {
    expect(parseSourceLine("* Rust: The Book : https://doc.rust-lang.org")).toEqual({
      title: "Rust: The Book",
      url: "https://doc.rust-lang.org",
    });
  });
});
