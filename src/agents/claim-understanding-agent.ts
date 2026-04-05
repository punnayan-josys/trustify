/**
 * claim-understanding-agent.ts
 *
 * Agent 1: ClaimUnderstandingAgent
 *
 * Responsibility:
 *   Parse the raw headline into structured, machine-readable metadata.
 *   The output drives every downstream agent — get this right and the
 *   rest of the pipeline becomes deterministic.
 *
 * Output:
 *   - extractedEntities   – persons, organisations, places, dates
 *   - claimType           – categorises the claim for downstream routing
 *   - searchKeywords      – optimised query terms for scraping
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { getSharedLlmClient } from "./llm-client";
import { ClaimUnderstandingOutput } from "../utils/shared-types";
import { AgentResponseError } from "../utils/app-errors";
import { logger } from "../utils/logger";

// ─── Prompt ───────────────────────────────────────────────────────────────────

const CLAIM_UNDERSTANDING_SYSTEM_PROMPT = `You are a linguistics expert and news analyst.
Your task is to extract structured information from a news headline.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences.

JSON Schema:
{{
  "extractedEntities": string[],   // persons, organisations, locations, dates mentioned
  "claimType": string,             // one of: "event", "statistic", "quote", "allegation", "policy", "scientific"
  "claimCategory": string,         // one of: "sports_result", "office_holder", "current_event", "historical_fact", "future_claim", "general"
  "rewrittenQuestion": string,     // rephrase as a neutral, specific factual question a researcher would search (e.g. "Who won the ICC T20 World Cup 2026?")
  "searchKeywords": string[]       // 4-6 specific search terms to find corroborating evidence
}}

Rules:
- extractedEntities must be proper nouns only
- searchKeywords must be specific enough to find evidence, not too broad
- claimType must be exactly one of the listed values
- claimCategory choices:
  - sports_result: match outcomes, tournament winners, scores, championships
  - office_holder: who currently holds a political, executive, or institutional position
  - current_event: recent news, incidents, accidents, announcements happening now
  - historical_fact: past events with recorded history and known outcomes
  - future_claim: events scheduled for or claimed to occur in the future, or unconfirmed upcoming events
  - general: anything else that does not fit the above
- rewrittenQuestion must be a single neutral question (no opinion, no bias) suitable as a search query`;

const CLAIM_UNDERSTANDING_HUMAN_TEMPLATE = `News headline: "{headline}"`;

// ─── Agent Function ───────────────────────────────────────────────────────────

/**
 * Runs the ClaimUnderstandingAgent against a raw headline.
 * Returns structured metadata used by all downstream agents.
 */
export async function runClaimUnderstandingAgent(
  rawHeadline: string
): Promise<ClaimUnderstandingOutput> {
  logger.info("ClaimUnderstandingAgent: starting", {
    headlineLength: rawHeadline.length,
  });

  const promptTemplate = ChatPromptTemplate.fromMessages([
    ["system", CLAIM_UNDERSTANDING_SYSTEM_PROMPT],
    ["human", CLAIM_UNDERSTANDING_HUMAN_TEMPLATE],
  ]);

  const llmChain = promptTemplate
    .pipe(getSharedLlmClient())
    .pipe(new StringOutputParser());

  const rawLlmResponse = await llmChain.invoke({ headline: rawHeadline });

  const parsedOutput = parseClaimUnderstandingResponse(
    rawLlmResponse,
    rawHeadline
  );

  logger.info("ClaimUnderstandingAgent: complete", {
    claimType: parsedOutput.claimType,
    entityCount: parsedOutput.extractedEntities.length,
    keywordCount: parsedOutput.searchKeywords.length,
  });

  return parsedOutput;
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function parseClaimUnderstandingResponse(
  rawResponse: string,
  originalHeadline: string
): ClaimUnderstandingOutput {
  const VALID_CLAIM_TYPES = [
    "event",
    "statistic",
    "quote",
    "allegation",
    "policy",
    "scientific",
  ];

  const VALID_CLAIM_CATEGORIES = [
    "sports_result",
    "office_holder",
    "current_event",
    "historical_fact",
    "future_claim",
    "general",
  ];

  try {
    // Strip accidental markdown code fences if the model adds them
    const cleanedJson = rawResponse
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const parsed = JSON.parse(cleanedJson) as {
      extractedEntities: unknown;
      claimType: unknown;
      claimCategory: unknown;
      rewrittenQuestion: unknown;
      searchKeywords: unknown;
    };

    const extractedEntities = Array.isArray(parsed.extractedEntities)
      ? (parsed.extractedEntities as string[])
      : [];

    const claimType =
      typeof parsed.claimType === "string" &&
      VALID_CLAIM_TYPES.includes(parsed.claimType)
        ? parsed.claimType
        : "event";

    const claimCategory =
      typeof parsed.claimCategory === "string" &&
      VALID_CLAIM_CATEGORIES.includes(parsed.claimCategory)
        ? parsed.claimCategory
        : "general";

    const rewrittenQuestion =
      typeof parsed.rewrittenQuestion === "string" &&
      parsed.rewrittenQuestion.trim().length > 5
        ? parsed.rewrittenQuestion.trim()
        : originalHeadline;

    const searchKeywords = Array.isArray(parsed.searchKeywords)
      ? (parsed.searchKeywords as string[])
      : extractFallbackKeywords(originalHeadline);

    return {
      originalHeadline,
      extractedEntities,
      claimType,
      claimCategory,
      rewrittenQuestion,
      searchKeywords,
    };
  } catch (parseError) {
    throw new AgentResponseError(
      `ClaimUnderstandingAgent returned unparseable JSON: ${(parseError as Error).message}`
    );
  }
}

/**
 * Fallback keyword extractor — splits headline into capitalised words.
 * Used when the LLM returns malformed JSON.
 */
function extractFallbackKeywords(headline: string): string[] {
  return headline
    .split(/\s+/)
    .filter((word) => word.length > 4)
    .slice(0, 5);
}
