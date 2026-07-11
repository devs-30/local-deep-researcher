import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { MessageContent } from "@langchain/core/messages";
import type { Configuration } from "./configuration";

export interface LlmOptions {
  jsonMode?: boolean;
}

export type LlmFactory = (cfg: Configuration, opts?: LlmOptions) => BaseChatModel;

export const getLlm: LlmFactory = (cfg, opts = {}) => {
  if (cfg.llmProvider === "ollama") {
    return new ChatOllama({
      baseUrl: cfg.ollamaBaseUrl,
      model: cfg.localLlm,
      temperature: 0,
      ...(opts.jsonMode ? { format: "json" } : {}),
    });
  }
  return new ChatOpenAI({
    model: cfg.localLlm,
    temperature: 0,
    apiKey: cfg.openaiCompatibleApiKey ?? "not-needed",
    configuration: { baseURL: cfg.openaiCompatibleBaseUrl },
    ...(opts.jsonMode ? { modelKwargs: { response_format: { type: "json_object" } } } : {}),
  });
};

/** Iteratively remove <think>...</think> blocks (deepseek-r1 and similar reasoning models). */
export function stripThinkingTokens(text: string): string {
  let result = text;
  for (;;) {
    const start = result.indexOf("<think>");
    const end = result.indexOf("</think>");
    if (start === -1 || end === -1 || end < start) return result;
    result = result.slice(0, start) + result.slice(end + "</think>".length);
  }
}

/** Parse JSON and return a non-empty string field, or undefined on any failure. */
export function extractJsonField(content: string, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(content.trim());
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

export function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
    )
    .join("");
}
