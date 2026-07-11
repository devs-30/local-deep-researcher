import { describe, expect, it } from "vitest";
import {
  getCurrentDate,
  jsonModeQueryInstructions,
  jsonModeReflectionInstructions,
  queryWriterInstructions,
  reflectionInstructions,
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
