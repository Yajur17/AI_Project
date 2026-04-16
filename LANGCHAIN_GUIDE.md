# LangChain Integration — Engineering Guide

> Audience: You just joined this project. You can read JS, you've called APIs before, and you've seen this codebase.
> This doc explains every decision made in the LangChain integration — not just what was done, but why, what alternatives existed, and what breaks if something is missing.

---

## 1. What Changed and Why

Before this change, the project called OpenAI directly using the raw `openai` SDK in `apiClient.js`.
That's totally fine for simple, single-step calls. But when you want to:

- Build reusable prompt templates
- Chain one LLM call's output into another call's input
- Swap LLM providers without rewriting call logic

...you want an orchestration layer. That's what LangChain is.

**Three files changed or were created:**

| File | What happened |
|---|---|
| `package.json` | Added 3 new dependencies |
| `langchainChain.js` | New file — all LangChain logic lives here |
| `apiClient.js` | Added 1 import line + 1 new `/chain` endpoint |

Nothing existing was removed or broken. The old `/ask`, `/batch`, `/cost-estimate` endpoints are completely untouched.

---

## 2. Dependencies Added to `package.json`

```json
"@langchain/core": "^0.3.47",
"@langchain/openai": "^0.5.13",
"langchain": "^0.3.31"
```

### Why three packages, not one?

LangChain was refactored in 2024 from one giant package into a monorepo of smaller packages.
The split was intentional: people who only use OpenAI shouldn't have to install Anthropic/Google code.

| Package | What it gives you |
|---|---|
| `@langchain/core` | The foundation — `PromptTemplate`, `BaseMessage`, `RunnableSequence`, etc. |
| `@langchain/openai` | OpenAI-specific model wrappers (`ChatOpenAI`). Talks directly to OpenAI's API |
| `langchain` | Higher-level utilities and legacy chains (`SequentialChain`, document loaders, etc.) |

### What if you only installed `langchain`?

`langchain` itself imports from `@langchain/core` and `@langchain/openai` as peer dependencies — they'd still need to be installed. Skipping the explicit entries in `package.json` would work accidentally in some setups, but you'd get non-deterministic version resolution. Always be explicit.

### Alternative: Just one package

You could use the raw `openai` SDK and skip LangChain entirely. The old `askOne()` function in `apiClient.js` does exactly that. LangChain adds overhead (~50–100ms cold start, more memory). For a single-step prompt-response call, it's honestly overkill. The value shows up when you start chaining.

---

## 3. `langchainChain.js` — Explained Section by Section

### 3.1 The Imports

```js
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
```

**`ChatOpenAI`** — This is LangChain's wrapper around OpenAI's chat models (gpt-4o, gpt-4, etc.).
It's not the same as directly using the `openai` SDK's `client.responses.create()`. Instead, it returns a standardised `AIMessage` object that works uniformly across all LangChain-compatible providers.

If you wanted to switch to Anthropic Claude tomorrow, you'd only change this one import and constructor — the rest of your chain code stays the same. That's the point.

**`PromptTemplate`** — Instead of writing prompt strings inline, you define a template with named input variables like `{question}`. At call time, LangChain substitutes the real values. This makes prompts reusable, testable, and auditable.

**What breaks without these imports?**
Everything. The file won't run. These are the core building blocks of every chain.

---

### 3.2 `buildLLM()` — The Model Factory

```js
function buildLLM({ model = "gpt-4o", temperature = 0.7 } = {}) {
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.key,
    model,
    temperature,
  });
}
```

This is a small but important pattern. `runHelloWorldChain` and `runResearchChain` both need a model instance. Instead of duplicating the constructor call in both functions, we centralise it.

**Why `process.env.OPENAI_API_KEY || process.env.key`?**
The project has two env var names for the API key (`OPENAI_API_KEY` is the new standard name, `key` is the legacy one from the original scripts). This keeps backward compatibility. If neither is set, `ChatOpenAI` will throw at instantiation time, which is the right behaviour — fail early, fail loudly.

**Default temperature = 0.7?**
Temperature controls randomness. 0 = very deterministic, 2 = very random. 0.7 is a reasonable middle ground for conversational or research-style responses. It's intentionally a default, not a hard value — the caller can always override it.

**Alternatives:**
- You could set temperature on each call instead of in the factory. That's fine for simple cases but gets repetitive when you have many calls.
- You could export `buildLLM` directly if other files needed their own model instance. For now it's private to this module.

**What breaks if this is removed?**
Both exported functions would need to duplicate model setup. More importantly, if you later change something (e.g. add `maxTokens`, or enable streaming), you'd have to change it in multiple places. Single responsibility.

---

### 3.3 `runHelloWorldChain()` — Phase 1

```js
const prompt = PromptTemplate.fromTemplate(
  "Answer the following question clearly and concisely:\n\n{question}"
);

const chain = prompt.pipe(llm);
const result = await chain.invoke({ question });
```

This is the core LangChain pattern. Let's break it down:

**`PromptTemplate.fromTemplate(...)`**
Parses the string and identifies `{question}` as an input variable.
At invoke time, `{ question: "What is RAG?" }` gets substituted in.

Without this, you'd do string interpolation manually everywhere: `"Answer this: " + userInput`. That works but is fragile, doesn't compose, and is harder to version or test.

**`.pipe(llm)` — LCEL syntax**
LCEL stands for LangChain Expression Language. It's the modern way to compose chains.
`prompt.pipe(llm)` means: "take the formatted prompt, pass it to the LLM, return its response."

This creates a lazy pipeline — nothing runs until you call `.invoke()`. You can inspect the chain, add steps, or wrap it in another chain before running it.

**The old equivalent (legacy, do not use in new code):**
```js
// LLMChain is still available but is now a thin wrapper around LCEL internally
const chain = new LLMChain({ llm, prompt });
const result = await chain.call({ question });
```
If you see `LLMChain` in tutorials, it's pre-2024 LangChain. It still works but the API is being sunsetted.

**What does `result` look like?**
`result` is an `AIMessage`:
```js
{
  content: "Machine learning is...",  // the actual text response
  usage_metadata: {
    input_tokens: 18,
    output_tokens: 94,
    total_tokens: 112
  },
  response_metadata: { ... }  // raw OpenAI response headers and model info
}
```

We read `result.content` for the text and `result.usage_metadata` for token counts. The reason we do NOT attach a `StringOutputParser` (which would simplify output to just a string) is that it strips the `AIMessage` object, losing the `usage_metadata`. For a learning project where we want to observe tokens and cost, keeping the raw `AIMessage` is more valuable.

**Token tracking — when it returns 0:**
If `usage_metadata` is `undefined`, the tokens default to `0`. This is rare on OpenAI but can happen if:
- You're using a streaming response config that doesn't return usage
- The provider doesn't support usage metadata (rare)
- A network-level error occurred but was swallowed

For production-grade token tracking, you'd use a `CallbackHandler` instead. We keep it simple here for clarity.

---

### 3.4 `runResearchChain()` — Phase 2: Sequential Chain

This is the main upgrade. Instead of one prompt → one response, we have a pipeline:

```
topic → [outlineChain] → outline text → [expandChain] → 3-paragraph research
```

```js
// Step 1
const outlineChain = outlinePrompt.pipe(llm);
const outlineResult = await outlineChain.invoke({ topic });
const outline = outlineResult.content;   // extract plain text

// Step 2
const expandChain = expandPrompt.pipe(llm);
const researchResult = await expandChain.invoke({ outline });
const research = researchResult.content;
```

**Why not one big prompt?**
You could write one prompt that says "here's a topic, write 3 paragraphs on it." It works, but:

1. Structure quality varies — the model improvises the structure each time
2. You can't inspect Step 1's output independently for debugging
3. You lose the ability to swap Step 2 for a different model or style later

Decomposition gives you consistency, debuggability, and composability. Step 1 forces the model to think in structure. Step 2 forces expansion of that exact structure. Two focused steps beat one vague step.

**The legacy `SequentialChain` — what was it?**
Before LCEL, you'd do this:
```js
import { SequentialChain, LLMChain } from "langchain/chains";

const outlineChain = new LLMChain({ llm, prompt: outlinePrompt, outputKey: "outline" });
const expandChain  = new LLMChain({ llm, prompt: expandPrompt,  outputKey: "research" });

const overallChain = new SequentialChain({
  chains: [outlineChain, expandChain],
  inputVariables: ["topic"],
  outputVariables: ["outline", "research"],
});
const result = await overallChain.call({ topic });
```

This is equivalent to what we do, but more verbose and harder to debug because the intermediate state is hidden inside `SequentialChain`. With LCEL, you explicitly `await` each step, so you always have the intermediate `outline` in scope — you can log it, validate it, or short-circuit if Step 1 output looks wrong.

**What if we run both steps in parallel instead of sequentially?**
You can't here. Step 2's prompt literally requires Step 1's output. That's a data dependency — sequential is the only correct order. `Promise.all()` would fail because Step 2 starts with no outline yet.

**Token accumulation:**
```js
const inputTokens =
  (outlineResult.usage_metadata?.input_tokens ?? 0) +
  (researchResult.usage_metadata?.input_tokens ?? 0);
```
We sum tokens from both steps to give you the real total cost of the full pipeline. This is important — a two-step chain can cost 2–3x a single call because Step 2's input includes the entire outline from Step 1.

---

## 4. Changes to `apiClient.js`

### 4.1 The Import

```js
import { runHelloWorldChain, runResearchChain } from "./langchainChain.js";
```

This is standard ES module named import. The `.js` extension is required in Node.js ES modules — omitting it causes a `Cannot find module` error at runtime.

**Why a separate file instead of writing the chain logic inside `apiClient.js`?**
Separation of concerns. `apiClient.js` is your transport layer: routing, request validation, error handling, logging, Lambda handler. `langchainChain.js` is your model orchestration layer: prompt templates, chain composition, token tracking. Mixing them would make both harder to read, test, and modify independently.

If tomorrow you want to test the chain logic in isolation (unit test, or a one-off script), you can import it without starting an Express server.

**What breaks if this import line is missing?**
The `/chain` endpoint will throw `ReferenceError: runHelloWorldChain is not defined` at the first request. The app still starts, but chains are dead. Always verify imports when adding new endpoints.

---

### 4.2 The `/chain` Endpoint

```js
app.post("/chain", async (req, res) => { ... });
```

The endpoint accepts a `mode` field to route between the two chain types.

**Request shapes:**

*Hello World (single chain):*
```json
{
  "mode": "hello",
  "question": "What is retrieval-augmented generation?",
  "model": "gpt-4o",
  "temperature": 0.7
}
```

*Research (sequential chain):*
```json
{
  "mode": "research",
  "topic": "Quantum computing",
  "model": "gpt-4o",
  "temperature": 0.5
}
```

**Why `mode` instead of two separate endpoints (`/chain/hello`, `/chain/research`)?**
Both approaches are valid. A single endpoint with a `mode` parameter is simpler on the client side when chaining is exploratory — you switch modes without changing the URL. Separate endpoints would make sense if the two modes diverged significantly in validation logic or had very different response shapes. For now, they share the same endpoint cleanly.

**Why does the endpoint reuse `isValidPrompt` and `isValidTemperature`?**
These validators already exist in `apiClient.js` and do exactly what's needed. Rather than duplicating the same validation logic inside `langchainChain.js`, the endpoint validates at the boundary (HTTP layer) before calling the chain. The chain functions trust their inputs are already clean. This matches the principle: validate at system boundaries, not inside every function.

**What if the chain throws?**
The `catch` block catches it, logs with `writeLog("error", "chain_error", ...)`, and returns a 500. The same pattern as every other endpoint in the file. The server stays up — one bad request doesn't crash anything.

---

## 5. Response Shapes

**`mode: "hello"` returns:**
```json
{
  "question": "What is RAG?",
  "outputText": "RAG stands for...",
  "usage": {
    "inputTokens": 18,
    "outputTokens": 94,
    "totalTokens": 112
  },
  "estimatedCost": 0.0000079,
  "latencyMs": 1240
}
```

**`mode: "research"` returns:**
```json
{
  "topic": "Quantum computing",
  "outline": [
    "What it is",
    "How it differs from classical computing",
    "Current real-world applications"
  ],
  "research": [
    "Quantum computing is a paradigm... [paragraph 1]",
    "Unlike classical computers... [paragraph 2]",
    "Today, companies like IBM... [paragraph 3]"
  ],
  "usage": {
    "inputTokens": 310,
    "outputTokens": 420,
    "totalTokens": 730
  },
  "estimatedCost": 0.0000345,
  "latencyMs": 4800
}
```

Current implementation normalizes research output for API readability:
- `outline` is returned as an array of cleaned bullet points.
- `research` is returned as an array of paragraphs.

Notice how `latencyMs` is roughly 4x higher for research mode. That's two sequential API calls. This is the cost of the decomposition pattern — you pay in latency to gain structure quality.

---

## 6. LangChain Concepts You Just Used

| Concept | What it is | Where it appears |
|---|---|---|
| `PromptTemplate` | A string template with named variables | Both chain functions |
| `ChatOpenAI` | LangChain's OpenAI chat model wrapper | `buildLLM()` |
| LCEL pipe (`.pipe()`) | Composing runnables into a chain | `prompt.pipe(llm)` |
| `invoke()` | Executes the chain with a given input map | Both chain functions |
| `AIMessage` | Standardised model output object | What `invoke()` returns |
| `usage_metadata` | Token counts on an `AIMessage` | Token tracking in both functions |
| Sequential pattern | Running chains one after another, feeding outputs forward | `runResearchChain()` |

---

## 7. Common Failure Modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find module './langchainChain.js'` | Missing `.js` extension in import | Add `.js` to the import path |
| `tokens are all 0` | Model response didn't include usage | Check if streaming is accidentally enabled; OpenAI should always return usage |
| `mode: "research"` returns generic output | Step 1 outline prompt is too vague | Tighten the outline prompt to force specific bullets |
| High latency on `/chain` | Two sequential API calls | Expected — this is the tradeoff for structured output |
| `API key not found` in LangChain but works in apiClient.js | `dotenv` loaded after `buildLLM()` | Ensure `dotenv.config()` runs before any model instantiation |
| `temperature` not applying | Passed as string (`"0.7"`) instead of number | The validator `isValidTemperature` catches this — `typeof value === "number"` |

---

## 8. What to Try Next

1. **Log the intermediate outline** in the response from `research` mode and manually evaluate it. Is Step 2's output better when Step 1's outline is structured versus loose? That's your first empirical LangChain experiment.

2. **Measure the overhead**: Call `/ask` and `/chain` with `mode: "hello"` for the same question. Compare `latencyMs`. The difference is the LangChain abstraction overhead.

3. **Add a third chain step**: Extract key facts from the research as a bullet summary. That's a 3-step sequential chain — same pattern, one more `prompt.pipe(llm)`.

4. **Swap the model**: Change `buildLLM` to use `gpt-4o-mini` for the outline step and `gpt-4o` for the expansion step. More cost-efficient — cheap model structures, expensive model writes.

5. **Explore `StringOutputParser`**: Add `.pipe(new StringOutputParser())` to one chain and see what you lose (token metadata). That trade-off is always present: simplicity vs observability.

---

## 9. LangChain in the `/prompt` Endpoint (Structured Output Extraction)

The `/prompt` endpoint was added on April 15. It uses LangChain in one of its three parsing strategies.

### The `json` strategy — `JsonOutputParser`

```js
import { JsonOutputParser } from "@langchain/core/output_parsers";

const parser = new JsonOutputParser();
const parsed = await parser.invoke(rawText);
```

`JsonOutputParser` does two things the raw `JSON.parse()` doesn't:
1. **Markdown fence stripping** — the model often wraps JSON in triple-backtick fences (` ```json ... ``` `). `JsonOutputParser` strips the fence before parsing.
2. **LangChain-compatible output** — it returns a plain JS object, compatible with LCEL chains if you add it to a pipeline later.

For the other two strategies (`regex` and `custom`), standard JavaScript handles the parsing — no LangChain is needed because those strategies don't expect strict JSON output from the model.

### Why `JsonOutputParser` and not a custom function?

The alternative is `extractJsonSnippet()`, which is a custom helper in `apiClient.js` that also strips fences before calling `JSON.parse()`. That function exists as a fallback for cases where `JsonOutputParser` isn't available.

Using `JsonOutputParser` as the primary path means the project leverages a tested, community-maintained utility rather than maintaining its own fence-stripping regex.

### The three `/prompt` strategies summarised

| Strategy | LangChain involved | Parse approach |
|---|---|---|
| `json` | Yes — `JsonOutputParser` | Model outputs JSON → parser strips fences + parses |
| `regex` | No | Model outputs `Key: Value` lines → regex extracts pairs |
| `custom` | No | Model outputs free text → tries JSON, then line heuristics, then sentence patterns |

### Dynamic Schema — what the model is told

For all three strategies, `getExtractionInstructionByStrategy(strategy, schemaFields)` builds the system instruction. When `schemaFields` is non-empty (e.g. `["answer", "key_points"]`), the instruction explicitly names those fields. When empty, the model is told to extract whatever key-value structure it sees in the text.

This is a prompt-engineering pattern, not a LangChain feature — but it directly controls what the LangChain-parsed (or regex-parsed, or custom-parsed) output contains.

### Retry loop — error feedback

When parsing fails, `extractStructuredWithRetries()` formats the error message into the next prompt:

```js
const nextPrompt = getStructuredPrompt({ instruction, sourceTask, previousError: parseError.message });
```

The model receives its previous failure reason as context before its next attempt. This is a manual prompt-chaining pattern (not a LangChain `RunnableWithMessageHistory`). It's simpler and sufficient for a retry count of 0–5.
