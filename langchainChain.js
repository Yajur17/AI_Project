import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";

// ─── Cost rates ──────────────────────────────────────────────────────────────
// Same rates as apiClient.js — keep in sync if you update pricing.
const INPUT_RATE_PER_1K = 0.00003;
const OUTPUT_RATE_PER_1K = 0.00006;

function estimateCost(inputTokens = 0, outputTokens = 0) {
  return (inputTokens * INPUT_RATE_PER_1K + outputTokens * OUTPUT_RATE_PER_1K) / 1000;
}

// ─── Shared model factory ────────────────────────────────────────────────────
// Returns a ChatOpenAI instance with the given options.
// Centralised here so both chain functions use the same setup.
function buildLLM({ model = "gpt-4o", temperature = 0.7 } = {}) {
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.key,
    model,
    temperature,
  });
}

// ─── Phase 1: Hello World chain ──────────────────────────────────────────────
// Single prompt → LLM → response.
// This is the simplest possible LangChain pipeline.
export async function runHelloWorldChain({ question, model, temperature }) {
  const llm = buildLLM({ model, temperature });

  const prompt = PromptTemplate.fromTemplate(
    "Answer the following question clearly and concisely:\n\n{question}"
  );

  // LCEL pipe syntax: prompt builds the formatted message,
  // then LLM receives it and returns an AIMessage.
  const chain = prompt.pipe(llm);

  const start = Date.now();
  const result = await chain.invoke({ question });
  const latencyMs = Date.now() - start;

  // usage_metadata is the standardised field across all LangChain providers.
  // If tokens are 0 here, the model response didn't include usage (rare on OpenAI).
  const inputTokens = result.usage_metadata?.input_tokens ?? 0;
  const outputTokens = result.usage_metadata?.output_tokens ?? 0;
  const totalTokens = result.usage_metadata?.total_tokens ?? 0;

  return {
    question,
    outputText: result.content,
    usage: { inputTokens, outputTokens, totalTokens },
    estimatedCost: estimateCost(inputTokens, outputTokens),
    latencyMs,
  };
}

// ─── Phase 2: Sequential 2-step Research chain ───────────────────────────────
// Step 1 builds an outline.  Step 2 expands it into 3 paragraphs.
// The output of Step 1 feeds directly into the input of Step 2.
export async function runResearchChain({ topic, model, temperature }) {
  const llm = buildLLM({ model, temperature });

  // ── Step 1 ───────────────────────────────────────────────────────────────
  const outlinePrompt = PromptTemplate.fromTemplate(
    "Create a concise 3-point bullet outline on the topic: {topic}\n\nOnly bullet points, no prose."
  );
  const outlineChain = outlinePrompt.pipe(llm);

  // ── Step 2 ───────────────────────────────────────────────────────────────
  const expandPrompt = PromptTemplate.fromTemplate(
    "You have this research outline:\n\n{outline}\n\nExpand each bullet point into one full paragraph." +
      " Write exactly 3 paragraphs, one per point. Be factual and clear."
  );
  const expandChain = expandPrompt.pipe(llm);

  // ── Run sequentially ─────────────────────────────────────────────────────
  // We run step 1, extract the text, then pass it explicitly to step 2.
  // This is the modern LCEL equivalent of the legacy SequentialChain class.
  const start = Date.now();

  const outlineResult = await outlineChain.invoke({ topic });
  const outline = outlineResult.content;

  const researchResult = await expandChain.invoke({ outline });
  const research = researchResult.content;

  const latencyMs = Date.now() - start;

  // Accumulate token usage across both steps.
  const inputTokens =
    (outlineResult.usage_metadata?.input_tokens ?? 0) +
    (researchResult.usage_metadata?.input_tokens ?? 0);
  const outputTokens =
    (outlineResult.usage_metadata?.output_tokens ?? 0) +
    (researchResult.usage_metadata?.output_tokens ?? 0);
  const totalTokens = inputTokens + outputTokens;

  return {
    topic,
    outline,
    research,
    usage: { inputTokens, outputTokens, totalTokens },
    estimatedCost: estimateCost(inputTokens, outputTokens),
    latencyMs,
  };
}
