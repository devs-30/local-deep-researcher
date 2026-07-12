/**
 * Known-cosmetic upstream bug (@langchain/core 1.2.x): when a compiled graph
 * runs inside another graph's node with LangSmith tracing enabled, callback
 * configure() duplicates the LangChainTracer handler, every end event is
 * delivered twice, and the second delivery throws "No chain/LLM/tool run to
 * end" - which core catches and logs. Traces upload completely; the log lines
 * are pure noise. Remove this filter once fixed upstream:
 * https://github.com/langchain-ai/langchainjs/issues/11189
 */
const TRACER_NOISE =
  /^Error in handler LangChainTracer, handle\w+: Error: No (chain|LLM|tool) run to end\.?$/;

type ConsoleFn = (...args: unknown[]) => void;

/**
 * Drop the known tracer noise from console.error/console.warn (core logs to
 * either, depending on the handler's raiseError flag). CLI/MCP entry only -
 * library consumers keep the unfiltered console. Returns a restore function.
 */
export function suppressTracerNoise(): () => void {
  const originalError = console.error;
  const originalWarn = console.warn;
  const wrap =
    (fn: ConsoleFn): ConsoleFn =>
    (...args) => {
      if (typeof args[0] === "string" && TRACER_NOISE.test(args[0])) return;
      fn(...args);
    };
  console.error = wrap(originalError as ConsoleFn);
  console.warn = wrap(originalWarn as ConsoleFn);
  return () => {
    console.error = originalError;
    console.warn = originalWarn;
  };
}
