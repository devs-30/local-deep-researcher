# GitHub issue draft for langchain-ai/langchainjs

## Title

```
LangChainTracer logs "No chain run to end" for every end event when a compiled graph runs inside another StateGraph node
```

## Checked other resources

- [x] This is a bug, not a usage question. For questions, please use the LangChain Forum (https://forum.langchain.com/).
- [x] I added a very descriptive title to this issue.
- [x] I searched the LangChain.js documentation with the integrated search.
- [x] I used the GitHub search to find a similar question and didn't find it.
- [x] I am sure that this is a bug in LangChain.js rather than my code.
- [x] The bug is not resolved by updating to the latest stable version of LangChain (or the specific integration package).

## Example Code

Fully self-contained and offline: deterministic fake chat model, local HTTP stub as the
LangSmith endpoint, no real API key needed.

```bash
# setup (Node 20+)
mkdir langsmith-tracer-repro && cd langsmith-tracer-repro
npm init -y
npm install @langchain/core@1.2.2 @langchain/langgraph@1.4.7 langchain@1.5.3 zod@3
# save the script below as repro-langsmith-tracer-bug.mjs, then:

node repro-langsmith-tracer-bug.mjs                # nested agent -> ~12 noise lines (bug)
NESTED=false node repro-langsmith-tracer-bug.mjs   # same agent top-level -> clean
```

```javascript
// repro-langsmith-tracer-bug.mjs
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
```

## Error Message and Stack Trace (if applicable)

```
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
Error in handler LangChainTracer, handleLLMEnd: Error: No LLM run to end.
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
Error in handler LangChainTracer, handleToolEnd: Error: No tool run to end
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
Error in handler LangChainTracer, handleLLMEnd: Error: No LLM run to end.
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
Error in handler LangChainTracer, handleChainEnd: Error: No chain run to end.
nested run finished, messages: 4
```

The errors are thrown in `@langchain/core/dist/tracers/base.js` (`handleChainEnd` /
`handleLLMEnd` / `handleToolEnd`: "No ... run to end") and caught and logged by the callback
manager.

## Description

When a compiled LangGraph graph (e.g. an agent built with `createAgent` from langchain v1) is
invoked inside a node of another `StateGraph` with LangSmith tracing enabled, `@langchain/core`
logs a burst of handler errors to stderr - about 12 lines for a single small agent run.

The uploaded trace is complete and correct (verified via the LangSmith API: every run has
`status: success` and an `end_time`), so the lines appear to be purely cosmetic - but they are
indistinguishable from real errors for end users, and any CLI built on nested graphs spams
stderr with them.

The exact same agent invoked top-level (not inside another graph's node) produces no such
lines (`NESTED=false` mode of the repro).

What seems to happen: I instrumented `LangChainTracer.prototype.handle*` to log which tracer
instance receives which event. In the nested case every start/end event is delivered to TWO
distinct `LangChainTracer` instances (fresh copies are created per `CallbackManager.configure()`
via `copyWithTracingConfig`, see `callbacks/manager.js`). The instances share run bookkeeping
(`usesRunTreeMap = true`), so the first delivery ends the run and removes it from the shared
map, and the second delivery then throws "No chain/LLM/tool run to end". Instrumented output
excerpt (Tn = distinct tracer instances):

```
[T4] handleChainStart run=... known=true
[T5] handleChainStart run=... known=true
[T4] handleChainEnd   run=... known=true
[T5] handleChainEnd   run=... known=false
[T5] handleChainEnd   run=... THREW: No chain run to end.
```

Passing or omitting the node's `config` to the inner `agent.invoke()` makes no difference.

Expected behavior: no "Error in handler LangChainTracer" lines in either mode - each end event
should be handled by exactly one tracer instance, as in the top-level case.

## System Info

- @langchain/core 1.2.2
- @langchain/langgraph 1.4.7
- langchain 1.5.3
- langsmith 0.8.1
- Node v22.18.0, npm 10.9.3
- Linux (Ubuntu, kernel 6.17)
- Reproduced both with a real model (ChatOllama) and with the fake model above
