import { describe, expect, it } from "vitest";
import { HELP, parseCliArgs } from "../src/cli-args";
import { ConfigurationError } from "../src/configuration";

describe("parseCliArgs", () => {
  it("parses a plain topic with defaults", () => {
    const cmd = parseCliArgs(["history of rocket engines"]);
    expect(cmd).toEqual({
      kind: "research",
      options: {
        topic: "history of rocket engines",
        configurable: {},
        output: undefined,
        json: false,
        quiet: false,
      },
    });
  });

  it("maps flags to configurable keys", () => {
    const cmd = parseCliArgs([
      "topic",
      "--max-loops",
      "5",
      "--model",
      "qwen3",
      "--search-api",
      "tavily",
      "--fetch-full-page",
      "--output",
      "report.md",
      "--json",
      "--quiet",
    ]);
    expect(cmd.kind).toBe("research");
    if (cmd.kind !== "research") return;
    expect(cmd.options.configurable).toEqual({
      maxWebResearchLoops: "5",
      localLlm: "qwen3",
      searchApi: "tavily",
      fetchFullPage: true,
    });
    expect(cmd.options.output).toBe("report.md");
    expect(cmd.options.json).toBe(true);
    expect(cmd.options.quiet).toBe(true);
  });

  it("routes provider and base-url", () => {
    const cmd = parseCliArgs(["t", "--provider", "openai_compatible", "--base-url", "http://x/v1"]);
    if (cmd.kind !== "research") throw new Error("expected research");
    expect(cmd.options.configurable.llmProvider).toBe("openai_compatible");
    expect(cmd.options.configurable.openaiCompatibleBaseUrl).toBe("http://x/v1");
    expect(cmd.options.configurable.ollamaBaseUrl).toBe("http://x/v1");
  });

  it("recognizes the mcp subcommand, help and version", () => {
    expect(parseCliArgs(["mcp"])).toEqual({ kind: "mcp" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("throws ConfigurationError when the topic is missing", () => {
    expect(() => parseCliArgs([])).toThrow(ConfigurationError);
    expect(() => parseCliArgs(["--json"])).toThrow(ConfigurationError);
  });

  it("maps --no-grade-sources and --blocklist into configurable", () => {
    const cmd = parseCliArgs([
      "topic",
      "--no-grade-sources",
      "--blocklist",
      "spam.example,junk.example",
    ]);
    expect(cmd.kind).toBe("research");
    if (cmd.kind !== "research") return;
    expect(cmd.options.configurable.gradeSources).toBe(false);
    expect(cmd.options.configurable.sourceDomainBlocklist).toBe("spam.example,junk.example");
  });

  it("omits grading keys when the flags are absent", () => {
    const cmd = parseCliArgs(["topic"]);
    expect(cmd.kind).toBe("research");
    if (cmd.kind !== "research") return;
    expect("gradeSources" in cmd.options.configurable).toBe(false);
    expect("sourceDomainBlocklist" in cmd.options.configurable).toBe(false);
  });

  it("maps --count-empty-loops into configurable", () => {
    const cmd = parseCliArgs(["topic", "--count-empty-loops"]);
    expect(cmd.kind).toBe("research");
    if (cmd.kind !== "research") return;
    expect(cmd.options.configurable.countEmptyLoops).toBe(true);
  });

  it("omits countEmptyLoops when the flag is absent", () => {
    const cmd = parseCliArgs(["topic"]);
    expect(cmd.kind).toBe("research");
    if (cmd.kind !== "research") return;
    expect("countEmptyLoops" in cmd.options.configurable).toBe(false);
  });
});

describe("agent subcommand", () => {
  it("parses agent with topic and agent flags", () => {
    const cmd = parseCliArgs([
      "agent",
      "quantum computing",
      "--max-steps",
      "10",
      "--agent-model",
      "qwen3",
    ]);
    expect(cmd.kind).toBe("agent");
    if (cmd.kind !== "agent") return;
    expect(cmd.options.topic).toBe("quantum computing");
    expect(cmd.options.configurable.maxAgentSteps).toBe(10);
    expect(cmd.options.configurable.agentLlm).toBe("qwen3");
  });

  it("supports shared options in agent mode", () => {
    const cmd = parseCliArgs(["agent", "topic", "--search-api", "searxng", "--json", "-q"]);
    if (cmd.kind !== "agent") throw new Error("expected agent");
    expect(cmd.options.configurable.searchApi).toBe("searxng");
    expect(cmd.options.json).toBe(true);
    expect(cmd.options.quiet).toBe(true);
  });

  it("requires a topic in agent mode", () => {
    expect(() => parseCliArgs(["agent"])).toThrow(ConfigurationError);
  });

  it("mentions the agent subcommand in help", () => {
    expect(HELP).toContain("agent");
    expect(HELP).toContain("--max-steps");
    expect(HELP).toContain("--agent-model");
  });

  it("ignores an empty --max-steps value (falls back to default)", () => {
    const cmd = parseCliArgs(["agent", "topic", "--max-steps", ""]);
    if (cmd.kind !== "agent") throw new Error("expected agent");
    expect(cmd.options.configurable.maxAgentSteps).toBeUndefined();
  });
});
