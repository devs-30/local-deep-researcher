import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp";
import type { research } from "../src/research";

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
});
