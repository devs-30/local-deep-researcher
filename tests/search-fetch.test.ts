import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRawContent } from "../src/search/fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRawContent", () => {
  it("converts fetched HTML to markdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><body><h1>Title</h1><p>Body text</p></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const md = await fetchRawContent("https://example.com");
    expect(md).toContain("Title");
    expect(md).toContain("Body text");
  });

  it("returns undefined on HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    expect(await fetchRawContent("https://example.com")).toBeUndefined();
  });

  it("returns undefined on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("boom"))),
    );
    expect(await fetchRawContent("https://example.com")).toBeUndefined();
  });
});
