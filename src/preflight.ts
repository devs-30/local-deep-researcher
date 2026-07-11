import type { Configuration } from "./configuration";

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

interface OllamaTags {
  models?: Array<{ name: string }>;
}

interface OllamaShow {
  capabilities?: string[];
}

/** Fail fast with actionable messages before starting a multi-minute research run. */
export async function preflightOllama(
  cfg: Configuration,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (cfg.llmProvider !== "ollama") return;
  let tags: OllamaTags;
  try {
    const res = await fetchFn(new URL("/api/tags", cfg.ollamaBaseUrl), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tags = (await res.json()) as OllamaTags;
  } catch {
    throw new PreflightError(
      `Cannot reach Ollama at ${cfg.ollamaBaseUrl}. Start it with \`ollama serve\` or set OLLAMA_BASE_URL.`,
    );
  }
  const names = (tags.models ?? []).map((m) => m.name);
  const found = names.some((n) => n === cfg.localLlm || n.split(":")[0] === cfg.localLlm);
  if (!found) {
    throw new PreflightError(
      `Model "${cfg.localLlm}" not found in Ollama. Pull it with: ollama pull ${cfg.localLlm}`,
    );
  }
}

/**
 * Agentic mode requires native tool calling. Ollama >= 0.6 reports capabilities
 * via POST /api/show; older versions do not, in which case we fail open.
 */
export async function preflightAgentModel(
  cfg: Configuration,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (cfg.llmProvider !== "ollama") return;
  const model = cfg.agentLlm ?? cfg.localLlm;
  let show: OllamaShow;
  try {
    const res = await fetchFn(new URL("/api/show", cfg.ollamaBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    show = (await res.json()) as OllamaShow;
  } catch {
    throw new PreflightError(
      `Cannot inspect model "${model}" in Ollama at ${cfg.ollamaBaseUrl}. Pull it with: ollama pull ${model}`,
    );
  }
  if (show.capabilities && !show.capabilities.includes("tools")) {
    throw new PreflightError(
      `Model "${model}" does not support tool calling. Set --agent-model (env AGENT_LLM) to a tool-calling model, e.g. qwen3.`,
    );
  }
}
