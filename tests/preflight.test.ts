import { describe, expect, it, vi } from "vitest";
import { ensureConfiguration } from "../src/configuration";
import { PreflightError, preflightOllama, preflightAgentModel } from "../src/preflight";

const cfg = (over: Record<string, unknown> = {}) =>
  ensureConfiguration({ configurable: { llmProvider: "ollama", localLlm: "llama3.2", ...over } });

describe("preflightOllama", () => {
  it("passes when the model is present", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ models: [{ name: "llama3.2:latest" }] }),
    ) as unknown as typeof fetch;
    await expect(preflightOllama(cfg(), fetchFn)).resolves.toBeUndefined();
  });

  it("suggests ollama pull when the model is missing", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ models: [{ name: "qwen3:latest" }] }),
    ) as unknown as typeof fetch;
    await expect(preflightOllama(cfg(), fetchFn)).rejects.toThrow(/ollama pull llama3.2/);
  });

  it("explains when Ollama is unreachable", async () => {
    const fetchFn = vi.fn(async () =>
      Promise.reject(new Error("ECONNREFUSED")),
    ) as unknown as typeof fetch;
    await expect(preflightOllama(cfg(), fetchFn)).rejects.toThrow(PreflightError);
    await expect(preflightOllama(cfg(), fetchFn)).rejects.toThrow(/Cannot reach Ollama/);
  });

  it("is a no-op for openai_compatible", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await preflightOllama(
      cfg({ llmProvider: "openai_compatible", openaiCompatibleBaseUrl: "http://x/v1" }),
      fetchFn,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("preflightAgentModel", () => {
  const cfg = ensureConfiguration({ configurable: { agentLlm: "qwen3" } });

  function showResponse(body: unknown, ok = true): typeof fetch {
    return vi.fn(
      async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response,
    ) as unknown as typeof fetch;
  }

  it("passes when the model declares the tools capability", async () => {
    await expect(
      preflightAgentModel(cfg, showResponse({ capabilities: ["completion", "tools"] })),
    ).resolves.toBeUndefined();
  });

  it("throws when the model lacks the tools capability", async () => {
    await expect(
      preflightAgentModel(cfg, showResponse({ capabilities: ["completion"] })),
    ).rejects.toThrow(/does not support tool calling/);
  });

  it("fails open when capabilities are not reported", async () => {
    await expect(preflightAgentModel(cfg, showResponse({}))).resolves.toBeUndefined();
  });

  it("throws a reachability error when /api/show fails", async () => {
    await expect(preflightAgentModel(cfg, showResponse({}, false))).rejects.toThrow(
      /Cannot inspect model/,
    );
  });

  it("is a no-op for openai_compatible", async () => {
    const compat = ensureConfiguration({
      configurable: { llmProvider: "openai_compatible", openaiCompatibleBaseUrl: "http://x" },
    });
    const fetchFn = vi.fn();
    await expect(
      preflightAgentModel(compat, fetchFn as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
