import { describe, expect, it } from "vitest";
import { research } from "../src/research";

// Opt-in: RUN_LIVE_TESTS=1 npx vitest run tests/live.test.ts
// Requires a running Ollama with gemma4:e4b pulled, and network access for DuckDuckGo.
describe.skipIf(process.env.RUN_LIVE_TESTS !== "1")("live smoke", () => {
  it("produces a real report with one research loop", async () => {
    const report = await research("What is LangGraph?", { maxWebResearchLoops: 0 });
    expect(report.markdown).toContain("## Summary");
    expect(report.sources.length).toBeGreaterThan(0);
  }, 300_000);
});
