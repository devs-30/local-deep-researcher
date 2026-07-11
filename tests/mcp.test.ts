import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp";
import type { research, researchAgentic } from "../src/research";

const fakeResearch = (async (topic: string) => ({
  summary: `Summary of ${topic}`,
  sources: [{ title: "A", url: "https://a.example" }],
  markdown: `## Summary\nSummary of ${topic}\n\n ### Sources:\n* A : https://a.example`,
})) as typeof research;

async function connectedClient(deps: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function listRegisteredTools() {
  const client = await connectedClient({
    preflight: async () => {},
    preflightAgentModel: async () => {},
  });
  const tools = await client.listTools();
  return tools.tools;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: Parameters<typeof createMcpServer>[0] = {},
) {
  const client = await connectedClient({
    preflight: async () => {},
    preflightAgentModel: async () => {},
    ...deps,
  });
  const result = await client.callTool({ name, arguments: args });
  return result as unknown as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

describe("MCP server", () => {
  it("lists the deep_research tool", async () => {
    const client = await connectedClient({ researchFn: fakeResearch, preflight: async () => {} });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("deep_research");
  });

  it("runs deep_research and returns the markdown report", async () => {
    const client = await connectedClient({ researchFn: fakeResearch, preflight: async () => {} });
    const result = await client.callTool({
      name: "deep_research",
      arguments: { topic: "quantum computing", max_loops: 1 },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBeFalsy();
    expect(content[0].text).toContain("## Summary");
    expect(content[0].text).toContain("quantum computing");
  });

  it("returns isError with a readable message instead of crashing", async () => {
    const failing = (async () => {
      throw new Error("Ollama exploded");
    }) as unknown as typeof research;
    const client = await connectedClient({ researchFn: failing, preflight: async () => {} });
    const result = await client.callTool({
      name: "deep_research",
      arguments: { topic: "anything" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0].text).toContain("Ollama exploded");
  });

  it("forwards grade_sources and source_domain_blocklist to the research configurable", async () => {
    const spy = vi.fn(fakeResearch);
    const client = await connectedClient({ researchFn: spy, preflight: async () => {} });
    await client.callTool({
      name: "deep_research",
      arguments: { topic: "t", grade_sources: false, source_domain_blocklist: "spam.example" },
    });
    expect(spy).toHaveBeenCalledWith(
      "t",
      expect.objectContaining({ gradeSources: false, sourceDomainBlocklist: "spam.example" }),
      expect.anything(),
    );
  });

  it("forwards count_empty_loops to the research configurable", async () => {
    const spy = vi.fn(fakeResearch);
    const client = await connectedClient({ researchFn: spy, preflight: async () => {} });
    await client.callTool({
      name: "deep_research",
      arguments: { topic: "t", count_empty_loops: true },
    });
    expect(spy).toHaveBeenCalledWith(
      "t",
      expect.objectContaining({ countEmptyLoops: true }),
      expect.anything(),
    );
  });
});

describe("deep_research_agent tool", () => {
  it("is registered with the expected input schema", async () => {
    const tools = await listRegisteredTools();
    const agentTool = tools.find((t) => t.name === "deep_research_agent");
    expect(agentTool).toBeDefined();
    expect(agentTool?.inputSchema.properties).toHaveProperty("topic");
    expect(agentTool?.inputSchema.properties).toHaveProperty("max_steps");
    expect(agentTool?.inputSchema.properties).toHaveProperty("agent_llm");
  });

  it("maps snake_case inputs to configurable and returns markdown", async () => {
    const researchAgenticFn = vi.fn(async () => ({
      summary: "s",
      sources: [{ title: "T", url: "https://t.example" }],
      markdown: "## Summary\nbody",
    })) as unknown as typeof researchAgentic;
    const result = await callTool(
      "deep_research_agent",
      { topic: "alpha", max_steps: 5, agent_llm: "qwen3" },
      { researchAgenticFn },
    );
    expect(researchAgenticFn).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ maxAgentSteps: 5, agentLlm: "qwen3" }),
      expect.anything(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("## Summary");
  });

  it("returns isError on failure", async () => {
    const researchAgenticFn = vi.fn(async () => {
      throw new Error("agent blew up");
    }) as unknown as typeof researchAgentic;
    const result = await callTool("deep_research_agent", { topic: "alpha" }, { researchAgenticFn });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("agent blew up");
  });
});
