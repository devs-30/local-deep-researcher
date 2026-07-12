// Minimal reproduction: "Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end."
//
// When a compiled LangGraph graph (here: createAgent from langchain v1) is invoked
// inside a node of another StateGraph with LangSmith tracing enabled, every tracer
// end-event is delivered to TWO LangChainTracer instances. The first one ends the
// run and removes it from the shared run map; the second one then throws
// "No chain/LLM/tool run to end", which @langchain/core catches and logs.
//
// The uploaded trace is complete and correct - the log lines are cosmetic noise -
// but a single agent run in a nested graph prints a dozen of them to stderr.
//
// Fully self-contained and offline: uses a deterministic fake chat model and a
// local HTTP stub as the LangSmith endpoint. Run:
//
//   node repro-langsmith-tracer-bug.mjs           # nested agent -> noise (bug)
//   NESTED=false node repro-langsmith-tracer-bug.mjs   # top-level agent -> clean
//
// Expected: no "Error in handler LangChainTracer" lines in either mode.
// Actual:   the nested mode prints several "Error in handler LangChainTracer,
//           handleChainEnd: Error: No chain run to end." / "handleLLMEnd: ...
//           No LLM run to end." lines; the top-level mode is clean.
//
// Versions: @langchain/core 1.2.2, @langchain/langgraph 1.4.7, langchain 1.5.3,
//           langsmith 0.8.1, Node 20+.

import { createServer } from "node:http";

// Stub LangSmith API so the run is offline and nothing hangs on retries.
// Env must be set before the langchain modules are imported, hence the
// dynamic imports below.
const stub = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.LANGSMITH_TRACING = "true";
process.env.LANGSMITH_API_KEY = "lsv2_pt_fake";
process.env.LANGSMITH_ENDPOINT = `http://127.0.0.1:${stub.address().port}`;

const { BaseChatModel } = await import("@langchain/core/language_models/chat_models");
const { AIMessage, HumanMessage } = await import("@langchain/core/messages");
const { tool } = await import("@langchain/core/tools");
const { z } = await import("zod");
const { createAgent } = await import("langchain");
const { StateGraph, START, END, Annotation } = await import("@langchain/langgraph");

// Deterministic offline chat model: one tool call, then a final answer.
class FakeToolCallingModel extends BaseChatModel {
  queue = [
    new AIMessage({
      content: "",
      tool_calls: [{ id: "call_1", name: "echo", args: { text: "hello" } }],
    }),
    new AIMessage("The echo tool returned: hello"),
  ];
  _llmType() {
    return "fake";
  }
  bindTools() {
    return this;
  }
  async _generate() {
    const message = this.queue.shift() ?? new AIMessage("done");
    return { generations: [{ message, text: "" }] };
  }
}

const echo = tool(async ({ text }) => `echoed: ${text}`, {
  name: "echo",
  description: "Echo the given text back.",
  schema: z.object({ text: z.string() }),
});

const ask = { messages: [new HumanMessage("Call the echo tool once, then answer.")] };
const makeAgent = () => createAgent({ model: new FakeToolCallingModel({}), tools: [echo] });

if (process.env.NESTED !== "false") {
  const State = Annotation.Root({ out: Annotation() });
  const graph = new StateGraph(State)
    .addNode("run", async (_state, config) => {
      // Passing (or omitting) `config` makes no difference - the noise appears either way.
      const result = await makeAgent().invoke(ask, config);
      return { out: result.messages.length };
    })
    .addEdge(START, "run")
    .addEdge("run", END)
    .compile();
  const result = await graph.invoke({});
  console.log("nested run finished, messages:", result.out);
} else {
  const result = await makeAgent().invoke(ask);
  console.log("top-level run finished, messages:", result.messages.length);
}

// Let the langsmith background queue flush against the stub, then shut it down.
const { awaitAllCallbacks } = await import("@langchain/core/callbacks/promises");
await awaitAllCallbacks();
stub.close();
stub.unref();
