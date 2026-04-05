/**
 * llm-client.ts
 *
 * Shared LLM instance used by all agents.
 *
 * Provider selection (via LLM_PROVIDER env var):
 *   "groq"   — Groq free tier (default). Fast, no billing required.
 *              Get a free key at https://console.groq.com
 *   "openai" — OpenAI (requires billing credits).
 *              Set OPENAI_API_KEY in .env to switch.
 *
 * temperature=0 is locked for deterministic, reproducible verdicts.
 * Swapping providers requires only an .env change — no agent code changes.
 */

import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";

// Use a union type so TypeScript accepts both providers
type SupportedLlmClient = ChatGroq | ChatOpenAI;

let sharedLlmInstance: SupportedLlmClient | null = null;

/**
 * Returns the shared LLM client, lazily initialised on first call.
 * Provider is chosen via LLM_PROVIDER env var ("groq" | "openai").
 */
export function getSharedLlmClient(): SupportedLlmClient {
  if (sharedLlmInstance === null) {
    const selectedProvider = process.env.LLM_PROVIDER ?? "groq";

    if (selectedProvider === "openai") {
      sharedLlmInstance = new ChatOpenAI({
        modelName: process.env.OPENAI_MODEL_NAME ?? "gpt-3.5-turbo",
        temperature: 0,
        openAIApiKey: process.env.OPENAI_API_KEY,
        maxTokens: 1500,
      });
    } else {
      // Default: Groq free tier — llama-3.1-8b-instant is the current fast model.
      // For higher verdict accuracy use llama-3.3-70b-versatile.
      sharedLlmInstance = new ChatGroq({
        model: process.env.GROQ_MODEL_NAME ?? "llama-3.1-8b-instant",
        temperature: 0,
        apiKey: process.env.GROQ_API_KEY,
        maxTokens: 1500,
      });
    }
  }

  return sharedLlmInstance;
}
