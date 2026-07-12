import { afterEach, describe, expect, it } from "vitest";
import { suppressTracerNoise } from "../src/tracer-noise";

const NOISE = [
  "Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.",
  "Error in handler LangChainTracer, handleLLMEnd: Error: No LLM run to end.",
  "Error in handler LangChainTracer, handleToolEnd: Error: No tool run to end",
];

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("suppressTracerNoise", () => {
  it("drops known tracer noise on console.error and console.warn", () => {
    const seen: unknown[][] = [];
    const recorder = (...args: unknown[]) => {
      seen.push(args);
    };
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = recorder;
    console.warn = recorder;
    try {
      restore = suppressTracerNoise();
      for (const line of NOISE) {
        console.error(line);
        console.warn(line);
      }
      expect(seen).toEqual([]);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  it("passes every other message through unchanged", () => {
    const seen: unknown[][] = [];
    const recorder = (...args: unknown[]) => {
      seen.push(args);
    };
    const originalError = console.error;
    console.error = recorder;
    try {
      restore = suppressTracerNoise();
      console.error("Research failed: boom");
      console.error("Error in handler LangChainTracer, handleChainError: Error: something else");
      console.error(new Error("No chain run to end."));
      expect(seen.length).toBe(3);
    } finally {
      console.error = originalError;
    }
  });

  it("returns a restore function that unwraps the consoles", () => {
    const originalError = console.error;
    restore = suppressTracerNoise();
    expect(console.error).not.toBe(originalError);
    restore();
    restore = undefined;
    expect(console.error).toBe(originalError);
  });
});
