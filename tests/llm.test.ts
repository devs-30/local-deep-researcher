import { describe, expect, it } from "vitest";
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { contentToString, extractJsonField, getLlm, stripThinkingTokens } from "../src/llm";
import { ensureConfiguration } from "../src/configuration";

describe("stripThinkingTokens", () => {
  it("removes a single think block", () => {
    expect(stripThinkingTokens('<think>reasoning</think>{"query": "x"}')).toBe('{"query": "x"}');
  });

  it("removes multiple think blocks iteratively", () => {
    expect(stripThinkingTokens("<think>a</think>foo<think>b</think>bar")).toBe("foobar");
  });

  it("returns text unchanged without think tokens", () => {
    expect(stripThinkingTokens("plain text")).toBe("plain text");
  });

  it("leaves unbalanced tags alone", () => {
    expect(stripThinkingTokens("<think>never closed")).toBe("<think>never closed");
  });
});

describe("extractJsonField", () => {
  it("extracts a string field from valid JSON", () => {
    expect(extractJsonField('{"query": "llm benchmarks", "rationale": "r"}', "query")).toBe(
      "llm benchmarks",
    );
  });

  it("returns undefined for invalid JSON", () => {
    expect(extractJsonField("not json at all", "query")).toBeUndefined();
  });

  it("returns undefined for missing or empty field", () => {
    expect(extractJsonField('{"rationale": "r"}', "query")).toBeUndefined();
    expect(extractJsonField('{"query": ""}', "query")).toBeUndefined();
  });
});

describe("contentToString", () => {
  it("passes strings through", () => {
    expect(contentToString("hello")).toBe("hello");
  });

  it("joins text parts of complex content", () => {
    expect(
      contentToString([
        { type: "text", text: "part1 " },
        { type: "text", text: "part2" },
      ]),
    ).toBe("part1 part2");
  });
});

describe("getLlm", () => {
  it("builds ChatOllama for the ollama provider", () => {
    const cfg = ensureConfiguration({ configurable: { llmProvider: "ollama" } });
    expect(getLlm(cfg, { jsonMode: true })).toBeInstanceOf(ChatOllama);
  });

  it("builds ChatOpenAI for openai_compatible", () => {
    const cfg = ensureConfiguration({
      configurable: {
        llmProvider: "openai_compatible",
        openaiCompatibleBaseUrl: "http://localhost:1234/v1",
        openaiCompatibleApiKey: "test-key",
      },
    });
    expect(getLlm(cfg)).toBeInstanceOf(ChatOpenAI);
  });
});
