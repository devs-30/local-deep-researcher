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

  it("strips scripts, styles and page chrome before markdown conversion", async () => {
    const html = `<html><head><style>.x{color:red}</style><script>var t=1;</script></head>
      <body>
        <nav><a href="/a">Products</a><a href="/b">Pricing</a></nav>
        <main><h1>Customers</h1><p>Rakuten uses LangChain.</p></main>
        <aside>Related articles</aside>
        <footer><a href="/tos">Terms</a></footer>
        <script>analytics.track()</script>
        <!-- tracking comment -->
      </body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      ),
    );
    const md = await fetchRawContent("https://example.com");
    expect(md).toContain("Customers");
    expect(md).toContain("Rakuten uses LangChain.");
    expect(md).not.toContain("var t=1");
    expect(md).not.toContain("analytics.track");
    expect(md).not.toContain("color:red");
    expect(md).not.toContain("Products");
    expect(md).not.toContain("Terms");
    expect(md).not.toContain("Related articles");
    expect(md).not.toContain("tracking comment");
  });

  it("reduces images to their alt text and drops the rest", async () => {
    const html = `<html><body><main>
        <h1>Trusted by</h1>
        <img src="https://cdn.example/nvidia.png" alt="NVIDIA">
        <img src="data:image/png;base64,${"A".repeat(200)}">
        <picture><source srcset="a.webp"><img src="b.jpg" alt="Klarna logo"></picture>
        <p>text</p>
      </main></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      ),
    );
    const md = await fetchRawContent("https://example.com");
    expect(md).toContain("NVIDIA");
    expect(md).toContain("Klarna logo");
    expect(md).not.toContain("![");
    expect(md).not.toContain("data:image");
    expect(md).not.toContain("cdn.example");
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
