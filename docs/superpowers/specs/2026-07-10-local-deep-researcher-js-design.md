# Local Deep Researcher (JS) - Design

**Data:** 2026-07-10
**Pakiet:** `@devs30/local-deep-researcher`
**Cel:** Port [langchain-ai/local-deep-researcher](https://github.com/langchain-ai/local-deep-researcher) (Python) na TypeScript/LangGraph.js - łatwy w użyciu standalone oraz jako subagent w Claude Code / Codex.

## 1. Przegląd

W pełni lokalny asystent web-researchu: dla zadanego tematu iteracyjnie generuje zapytania, przeszukuje web, streszcza wyniki, identyfikuje luki wiedzy i pogłębia research w konfigurowalnej liczbie pętli (domyślnie 3), po czym zwraca raport markdown z deduplikowanymi źródłami.

Jeden pakiet npm z czterema punktami wejścia (podejście „jeden pakiet, wiele entry pointów"):

1. **Biblioteka** - `import { research, graph }`
2. **CLI** - `npx @devs30/local-deep-researcher "temat" [flagi]`
3. **Serwer MCP** - `npx @devs30/local-deep-researcher mcp` (stdio)
4. **LangGraph Studio** - `langgraph.json` + `npx @langchain/langgraph-cli dev`

Stack: TypeScript strict, ESM, Node ≥ 20, LangGraph.js.

## 2. Rdzeń - port grafu

Wierny port `graph.py`:

### Stan (`state.ts`)

`SummaryStateAnnotation`:

- `researchTopic: string`
- `searchQuery: string`
- `webResearchResults: string[]` (akumulowane)
- `sourcesGathered: string[]` (akumulowane)
- `researchLoopCount: number`
- `runningSummary: string`

### Węzły i przepływ (`graph.ts`)

```
START → generateQuery → webResearch → summarizeSources → reflectOnSummary
      → [routeResearch] → webResearch (pętla)  |  finalizeSummary → END
```

- **generateQuery** - LLM w JSON mode generuje zapytanie z tematu.
- **webResearch** - wykonuje wyszukiwanie skonfigurowanym providerem, formatuje i akumuluje źródła, inkrementuje `researchLoopCount`.
- **summarizeSources** - rozszerza/aktualizuje `runningSummary` o nowe wyniki.
- **reflectOnSummary** - identyfikuje lukę wiedzy, generuje zapytanie pogłębiające (JSON mode).
- **routeResearch** - `researchLoopCount <= maxWebResearchLoops` → pętla; inaczej finalizacja.
- **finalizeSummary** - deduplikacja źródeł, składanie raportu `## Summary … ### Sources:`.

### Prompty (`prompts.ts`)

Port 1:1 z `prompts.py` (instrukcje JSON mode, refleksja nad lukami, data bieżąca w kontekście).

### LLM (`llm.ts`)

- `@langchain/ollama` (ChatOllama, domyślnie `llama3.2`) - provider `ollama`.
- `@langchain/openai` (ChatOpenAI z `baseUrl`) - provider `openai_compatible`: LMStudio, llama.cpp, vLLM, OpenRouter, OpenAI.
- JSON mode; strip `<think>…</think>` (deepseek-r1 itp.) przed parsowaniem - port `strip_thinking_tokens`.

### Wyszukiwarki (`search/`)

Wspólny interfejs `SearchProvider` + formatowanie/deduplikacja źródeł (port `utils.py`):

- **DuckDuckGo** (domyślna, bez klucza) - pakiet `duck-duck-scrape`
- **Tavily** - REST przez fetch (spójne mockowanie, mniej zależności)
- **Perplexity** - fetch (REST)
- **SearXNG** - fetch (self-hosted URL)
- `fetchFullPage` - opcjonalne dociąganie pełnej treści stron (timeout 10 s/strona, limit znaków per źródło).

## 3. Interfejsy

### Biblioteka

```ts
const report = await research("temat", { maxWebResearchLoops: 3 });
// { summary: string, sources: Source[], markdown: string }
```

Eksport surowego `graph` (skompilowany StateGraph) do osadzania we własnych grafach i streamingu (`graph.stream(...)`).

### CLI (`cli.ts`)

```bash
npx @devs30/local-deep-researcher "temat" \
  --max-loops 3 --provider ollama --model llama3.2 \
  --search-api duckduckgo --output report.md [--json]
```

- Raport na **stdout** (lub `--output`), postęp pętli na **stderr** - agent przez Bash dostaje czysty raport.
- `--json` → `{summary, sources}` dla skryptów.
- Kody wyjścia: `0` sukces, `1` błąd konfiguracji/startu, `2` research przerwany w trakcie.

### Serwer MCP (`mcp.ts`)

- Podkomenda `mcp`, transport stdio, `@modelcontextprotocol/sdk`.
- Narzędzie `deep_research(topic, max_loops?, search_api?)` → raport markdown.
- MCP progress notifications w trakcie pętli (ochrona przed timeoutem klienta).
- Błędy jako `isError: true`, serwer nigdy nie crashuje.
- Instalacja: `claude mcp add deep-researcher -- npx @devs30/local-deep-researcher mcp`.

### LangGraph Studio

`langgraph.json` wskazuje eksportowany graf; `npx @langchain/langgraph-cli dev` daje wizualny UI jak w oryginale. Konfiguracja natywnie przez panel `configurable`.

### Integracja z agentami

- `.claude/agents/deep-researcher.md` - gotowy subagent Claude Code wywołujący CLI przez Bash.
- README: sekcje „Użycie jako subagent w Claude Code" (wariant CLI i MCP) oraz snippet dla Codex.

## 4. Konfiguracja (`configuration.ts`)

Jedno źródło prawdy - schema zod, użyta przez wszystkie interfejsy. Pola/env zgodne z oryginałem:

| Pole                      | Env                                                   | Domyślnie                                            |
| ------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `llmProvider`             | `LLM_PROVIDER`                                        | `ollama` \| `openai_compatible` (domyślnie `ollama`) |
| `localLlm`                | `LOCAL_LLM`                                           | `llama3.2`                                           |
| `ollamaBaseUrl`           | `OLLAMA_BASE_URL`                                     | `http://localhost:11434`                             |
| `openaiCompatibleBaseUrl` | `OPENAI_COMPATIBLE_BASE_URL`                          | -                                                    |
| `openaiCompatibleApiKey`  | `OPENAI_COMPATIBLE_API_KEY`                           | -                                                    |
| `searchApi`               | `SEARCH_API`                                          | `duckduckgo`                                         |
| `maxWebResearchLoops`     | `MAX_WEB_RESEARCH_LOOPS`                              | `3`                                                  |
| `fetchFullPage`           | `FETCH_FULL_PAGE`                                     | `false`                                              |
| `stripThinkingTokens`     | `STRIP_THINKING_TOKENS`                               | `true`                                               |
| klucze wyszukiwarek       | `TAVILY_API_KEY`, `PERPLEXITY_API_KEY`, `SEARXNG_URL` | -                                                    |

Priorytet: **argumenty programistyczne / flagi CLI / parametry MCP → env → `.env` (ładowany tylko w CLI/MCP, nie w bibliotece) → domyślne.**

Walidacja na starcie: np. `searchApi=tavily` bez `TAVILY_API_KEY` → czytelny błąd przed pierwszym callem LLM.

## 5. Obsługa błędów

Zasada: **pętla badawcza jest odporna, start jest surowy.**

- **Ollama nieosiągalna / brak modelu** - pre-flight check (ping + lista modeli) przed grafem; błąd z podpowiedzią `ollama pull llama3.2`.
- **Niepoprawny JSON z LLM** - strip thinking-tokenów, próba parsowania; fallback: w `generateQuery` temat jako zapytanie, w `reflectOnSummary` generyczne zapytanie pogłębiające. Pętla nie umiera na złym JSON-ie.
- **Błąd wyszukiwarki** - 1 retry z backoffem; dalej fail → pusta lista + ostrzeżenie na stderr, pętla kontynuuje. Wyjątek: fail w pierwszej iteracji przy zerze źródeł → twardy błąd.
- **fetchFullPage** - timeout 10 s/strona; błąd pojedynczej strony cichy (zostaje snippet); limit znaków per źródło.

## 6. Testy i tooling

**Tooling:** TypeScript strict, tsup (ESM + d.ts), vitest, eslint + prettier, Node ≥ 20. Publikacja `npm publish --access public`; `bin` + `exports` skonfigurowane pod `npx` bez instalacji.

**Testy:**

1. **Unit (bez sieci):** parsowanie/fallback JSON z thinking-tokenami, deduplikacja źródeł, formatowanie źródeł, precedencja konfiguracji, walidacja startowa.
2. **Integracja grafu (mock LLM + mock search):** pełny przebieg pętli - respektowanie `maxWebResearchLoops`, akumulacja stanu, finalny markdown z sekcją Sources.
3. **Smoke test live (opt-in):** `RUN_LIVE_TESTS=1` → prawdziwa Ollama + DuckDuckGo, 1 pętla; poza CI.

**CI (GitHub Actions):** lint + build + testy na push; publish na npm przy tagu wersji.

## 7. Struktura plików

```
local-deep-researcher/
├── src/
│   ├── graph.ts           # StateGraph: węzły + routing (port graph.py)
│   ├── state.ts           # SummaryStateAnnotation
│   ├── configuration.ts   # schema zod + ensureConfiguration
│   ├── prompts.ts         # port prompts.py
│   ├── llm.ts             # fabryka ChatOllama / ChatOpenAI, strip thinking-tokens
│   ├── search/
│   │   ├── index.ts       # interfejs SearchProvider + formatowanie źródeł
│   │   ├── duckduckgo.ts
│   │   ├── tavily.ts
│   │   ├── perplexity.ts
│   │   └── searxng.ts
│   ├── research.ts        # wysokopoziomowe research() - API biblioteki
│   ├── cli.ts             # bin: flagi, progress na stderr
│   └── mcp.ts             # podkomenda mcp: serwer stdio
├── langgraph.json
├── .claude/agents/deep-researcher.md
├── tests/
└── package.json
```

## 8. Poza zakresem (YAGNI)

- Dedykowane integracje Anthropic/Google (dostępne przez OpenAI-compatible baseUrl).
- Dodatkowe wyszukiwarki (Brave, Exa) - możliwe później dzięki interfejsowi `SearchProvider`.
- Monorepo, checkpointing/persystencja stanu, web UI własny.
