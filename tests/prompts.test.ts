import { describe, expect, it } from "vitest";
import * as prompts from "../src/prompts";
import {
  getCurrentDate,
  jsonModeGraderInstructions,
  jsonModeQueryInstructions,
  jsonModeReflectionInstructions,
  queryWriterInstructions,
  reflectionInstructions,
  sourceGraderInstructions,
  summarizerInstructions,
} from "../src/prompts";

describe("prompts", () => {
  it("getCurrentDate returns 'Month D, YYYY'", () => {
    expect(getCurrentDate()).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  });

  it("queryWriterInstructions interpolates date and topic", () => {
    const prompt = queryWriterInstructions({
      currentDate: "July 10, 2026",
      researchTopic: "quantum computing",
    });
    expect(prompt).toContain("Current date: July 10, 2026");
    expect(prompt).toContain("quantum computing");
    expect(prompt).toContain('"query"');
  });

  it("reflectionInstructions interpolates the topic", () => {
    const prompt = reflectionInstructions({ researchTopic: "quantum computing" });
    expect(prompt).toContain("analyzing a summary about quantum computing");
  });

  it("JSON-mode instruction constants mention required keys", () => {
    expect(jsonModeQueryInstructions).toContain('"query"');
    expect(jsonModeQueryInstructions).toContain('"rationale"');
    expect(jsonModeReflectionInstructions).toContain("knowledge_gap");
    expect(jsonModeReflectionInstructions).toContain("follow_up_query");
    expect(summarizerInstructions).toContain("<GOAL>");
  });
});

describe("sourceGraderInstructions", () => {
  it("embeds the topic and the query", () => {
    const text = sourceGraderInstructions({
      researchTopic: "quantum computing",
      searchQuery: "qubit error correction",
    });
    expect(text).toContain("quantum computing");
    expect(text).toContain("qubit error correction");
  });

  it("is lenient by instruction", () => {
    const text = sourceGraderInstructions({ researchTopic: "t", searchQuery: "q" });
    expect(text.toLowerCase()).toContain("when in doubt");
  });
});

describe("jsonModeGraderInstructions", () => {
  it("requires the relevant key with yes/no values", () => {
    expect(jsonModeGraderInstructions).toContain('"relevant"');
    expect(jsonModeGraderInstructions).toContain('"yes"');
    expect(jsonModeGraderInstructions).toContain('"no"');
  });
});

describe("reflectionInstructions failed queries", () => {
  it("is unchanged when no failed queries are given", () => {
    const base = reflectionInstructions({ researchTopic: "t" });
    const withEmpty = reflectionInstructions({ researchTopic: "t", failedQueries: [] });
    expect(withEmpty).toBe(base);
    expect(base).not.toContain("FAILED_QUERIES");
  });

  it("lists failed queries with a do-not-repeat instruction", () => {
    const text = reflectionInstructions({
      researchTopic: "t",
      failedQueries: ["quantum cats", "qubit dogs"],
    });
    expect(text).toContain("<FAILED_QUERIES>");
    expect(text).toContain("quantum cats");
    expect(text).toContain("qubit dogs");
    expect(text.toLowerCase()).toContain("do not repeat");
  });
});

describe("agentInstructions", () => {
  it("embeds topic, date and step budget", () => {
    const text = prompts.agentInstructions({
      researchTopic: "quantum computing",
      currentDate: "January 1, 2026",
      maxAgentSteps: 12,
    });
    expect(text).toContain("quantum computing");
    expect(text).toContain("January 1, 2026");
    expect(text).toContain("12");
    expect(text).toContain("web_search");
    expect(text).toContain("fetch_page");
    expect(text).toContain("take_note");
  });

  it("warns that search excerpts are truncated and directs list pages to fetch_page", () => {
    const text = prompts.agentInstructions({
      researchTopic: "list all X",
      currentDate: "January 1, 2026",
      maxAgentSteps: 12,
    });
    expect(text).toMatch(/only (a )?short excerpt/i);
    expect(text).toMatch(/catalogs|customer stories|rankings/i);
  });

  it("tells the agent to record negative findings instead of ending empty-handed", () => {
    const text = prompts.agentInstructions({
      researchTopic: "was X ever used on Y",
      currentDate: "January 1, 2026",
      maxAgentSteps: 12,
    });
    expect(text).toMatch(/negative finding/i);
    expect(text).toMatch(/no evidence/i);
    expect(text).toMatch(/never stop with zero notes/i);
  });

  it("scales research breadth to the user's intent instead of a fixed note count", () => {
    const text = prompts.agentInstructions({
      researchTopic: "list all X",
      currentDate: "January 1, 2026",
      maxAgentSteps: 12,
    });
    expect(text).toContain("exhaustive");
    expect(text).toMatch(/nothing new/i);
    expect(text).toMatch(/whole step budget/i);
  });
});

describe("reportWriterInstructions", () => {
  it("asks for a report without a sources section", () => {
    expect(prompts.reportWriterInstructions).toContain("report");
    expect(prompts.reportWriterInstructions).toMatch(/do not include a sources/i);
  });

  it("gives user output-format instructions precedence over the defaults", () => {
    expect(prompts.reportWriterInstructions).toContain("take precedence");
    expect(prompts.reportWriterInstructions).toMatch(/language of the user input/i);
  });
});
