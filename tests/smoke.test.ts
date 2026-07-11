import { describe, expect, it } from "vitest";
import { graph, research } from "../src/index";

describe("public API", () => {
  it("exports research() and the compiled graph", () => {
    expect(typeof research).toBe("function");
    expect(graph).toBeDefined();
  });
});
