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
