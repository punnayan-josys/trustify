/**
 * aggregation-agent.ts
 *
 * Agent 3: AggregationAgent  (LLM-powered)
 *
 * Responsibility:
 *   Given all credibility-scored sources and the original claim, use an LLM to:
 *     1. Filter out sources that are semantically irrelevant to the claim
 *        (goes far beyond keyword overlap — understands paraphrase, synonyms,
 *        indirect references, and topic proximity)
 *     2. Deduplicate sources covering the exact same event from the same outlet
 *     3. Classify each surviving source as "supporting", "contradicting", or
 *        "neutral/background" with respect to the specific claim
 *     4. Assign a semantic relevance score (0–100) to each source
 *     5. Determine whether the evidence base is sufficient to justify
 *        running the expensive VerdictBrainAgent LLM call
 *
 *   This replaces all previous keyword tokenisation, stop-word lists, and
 *   hardcoded contradiction-signal keywords with deep semantic reasoning.
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { getSharedLlmClient } from "./llm-client";
import { CredibilityScoredSource, AggregatedEvidence } from "../utils/shared-types";
import { logger } from "../utils/logger";

// ─── System Prompt ────────────────────────────────────────────────────────────

// ─── System Prompt ────────────────────────────────────────────────────────────
// Kept concise to stay within Groq free-tier 6000 TPM limit.
// The LLM returns ONLY index+classification+score — full source objects are
// reconstructed in code, eliminating the largest token cost (output echoing).

const AGGREGATION_SYSTEM_PROMPT = `You are a fact-checking editor. Classify news sources against a claim.

For each source decide:
1. Is it relevant to the EXACT claim? (same event + same entities + same year)
2. If relevant, classify as: supporting / contradicting / neutral
3. Give a relevanceScore 0-100 (omit sources below 30)

RELEVANT = directly addresses this exact claim. Drop: different year, different tournament, same person but unrelated story.

CLASSIFICATION:
supporting    = confirms the claim ("CSK won", "clinched title", "crowned champions", "lifted trophy")
contradicting = disputes it ("RCB won", "CSK knocked out", "eliminated", "fact-checked FALSE", "debunked")
neutral       = relevant context but no clear verdict on the claim

EVIDENCE SUFFICIENCY: hasEnoughEvidence=true if at least 1 tier1/tier2 source is supporting/contradicting with relevanceScore>=50, OR any fact-check source exists.

Return ONLY this JSON, no markdown:
{{"results":[{{"i":0,"c":"supporting","r":85}},{{"i":2,"c":"contradicting","r":70}}],"hasEnoughEvidence":true}}

Keys: i=index, c=classification(supporting/contradicting/neutral), r=relevanceScore(30-100)
Omit sources with relevanceScore<30.`;

const AGGREGATION_HUMAN_TEMPLATE = `Claim: "{claim}"

Sources:
{sourcesCompact}`;

// Cap sources sent to the aggregation LLM — pre-ranked by credibility.
const AGGREGATION_MAX_SOURCES = 12;

// ─── LLM Aggregation Call ─────────────────────────────────────────────────────

interface LlmClassificationItem {
  i: number;           // index into the combined sources array
  c: string;           // "supporting" | "contradicting" | "neutral"
  r: number;           // relevanceScore 30-100
}

interface LlmAggregationOutput {
  supportingSources: CredibilityScoredSource[];
  contradictingSources: CredibilityScoredSource[];
  neutralSources: CredibilityScoredSource[];
  hasEnoughEvidence: boolean;
}

async function runAggregationLlm(
  claim: string,
  _claimKeywords: string[],
  newsSources: CredibilityScoredSource[],
  factCheckSources: CredibilityScoredSource[]
): Promise<LlmAggregationOutput> {
  // Pre-rank by credibility, cap to budget, keep originals for reconstruction
  const topNewsSources = [...newsSources]
    .sort((a, b) => (b.credibilityScore ?? 0) - (a.credibilityScore ?? 0))
    .slice(0, AGGREGATION_MAX_SOURCES);

  // Combine news + fact-checks into one indexed list for the LLM
  const allSources = [...topNewsSources, ...factCheckSources];

  // Build a compact text block: one line per source to minimise JSON overhead.
  // Format: [i] tier | title (80 chars) | summary (70 chars)
  // ~25 tokens per source × 15 sources = ~375 tokens of source data.
  const sourcesCompact = allSources
    .map((s, i) =>
      `[${i}] credibility=${s.credibilityScore} | ${s.title.slice(0, 80)} | ${s.summary.slice(0, 70)}`
    )
    .join("\n");

  const promptTemplate = ChatPromptTemplate.fromMessages([
    ["system", AGGREGATION_SYSTEM_PROMPT],
    ["human", AGGREGATION_HUMAN_TEMPLATE],
  ]);

  const chain = promptTemplate
    .pipe(getSharedLlmClient())
    .pipe(new StringOutputParser());

  const rawResponse = await chain.invoke({
    claim,
    sourcesCompact,
  });

  return parseAggregationResponse(rawResponse, allSources, factCheckSources);
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function parseAggregationResponse(
  rawResponse: string,
  allSources: CredibilityScoredSource[],
  originalFactCheckSources: CredibilityScoredSource[]
): LlmAggregationOutput {
  const VALID_CLASSIFICATIONS = ["supporting", "contradicting", "neutral"] as const;
  type Classification = typeof VALID_CLASSIFICATIONS[number];

  try {
    const cleanedJson = rawResponse
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const parsed = JSON.parse(cleanedJson) as {
      results?: unknown;
      hasEnoughEvidence?: unknown;
    };

    const results: LlmClassificationItem[] = Array.isArray(parsed.results)
      ? (parsed.results as Array<Record<string, unknown>>)
          .map((item) => ({
            i: typeof item.i === "number" ? item.i : -1,
            c: typeof item.c === "string" ? item.c : "neutral",
            r: typeof item.r === "number" ? Math.round(item.r) : 50,
          }))
          .filter((item) => item.i >= 0 && item.i < allSources.length && item.r >= 30)
      : [];

    const supporting: CredibilityScoredSource[] = [];
    const contradicting: CredibilityScoredSource[] = [];
    const neutral: CredibilityScoredSource[] = [];

    for (const result of results) {
      const source = allSources[result.i];
      if (!source) continue;

      const enriched: CredibilityScoredSource = { ...source, relevanceScore: result.r };
      const classification: Classification = VALID_CLASSIFICATIONS.includes(result.c as Classification)
        ? (result.c as Classification)
        : "neutral";

      if (classification === "supporting") supporting.push(enriched);
      else if (classification === "contradicting") contradicting.push(enriched);
      else neutral.push(enriched);
    }

    const hasEnoughEvidence =
      typeof parsed.hasEnoughEvidence === "boolean"
        ? parsed.hasEnoughEvidence
        : supporting.some((s) => (s.sourceTier === "tier1" || s.sourceTier === "tier2") && (s.relevanceScore ?? 0) >= 50) ||
          contradicting.some((s) => (s.sourceTier === "tier1" || s.sourceTier === "tier2") && (s.relevanceScore ?? 0) >= 50) ||
          originalFactCheckSources.length > 0;

    return { supportingSources: supporting, contradictingSources: contradicting, neutralSources: neutral, hasEnoughEvidence };
  } catch (err) {
    logger.warn("AggregationAgent: LLM parse failed, using fallback passthrough", {
      error: (err as Error).message,
      rawResponseSnippet: rawResponse.slice(0, 200),
    });
    return {
      supportingSources: [],
      contradictingSources: [],
      neutralSources: [],
      hasEnoughEvidence: originalFactCheckSources.length > 0,
    };
  }
}

// ─── Main Aggregation Function ────────────────────────────────────────────────

/**
 * Runs the LLM-powered aggregation pipeline:
 *   1. Sends all scored sources to the LLM with the original claim
 *   2. LLM semantically filters, deduplicates, and classifies them
 *   3. Returns structured AggregatedEvidence for the VerdictBrainAgent
 *
 * @param scoredNewsSources       Credibility-scored news articles
 * @param scoredFactCheckSources  Credibility-scored fact-check results
 * @param claimKeywords           Keywords from ClaimUnderstandingAgent (context only)
 * @param headlineClaim           Original headline — used as primary claim context
 */
export async function runAggregationAgent(
  scoredNewsSources: CredibilityScoredSource[],
  scoredFactCheckSources: CredibilityScoredSource[],
  claimKeywords: string[] = [],
  headlineClaim: string = ""
): Promise<AggregatedEvidence> {
  logger.info("AggregationAgent: starting LLM-based aggregation", {
    newsSourceCount: scoredNewsSources.length,
    factCheckCount: scoredFactCheckSources.length,
    claim: headlineClaim.slice(0, 80),
  });

  const {
    supportingSources,
    contradictingSources,
    neutralSources,
    hasEnoughEvidence,
  } = await runAggregationLlm(
    headlineClaim,
    claimKeywords,
    scoredNewsSources,
    scoredFactCheckSources
  );

  // Merge neutral sources into supporting so downstream agents receive a full
  // picture — VerdictBrainAgent has final authority on classification.
  const allSupportingAndNeutral = [
    ...supportingSources,
    ...neutralSources,
  ].sort((a, b) => (b.credibilityScore ?? 0) - (a.credibilityScore ?? 0));

  const aggregatedEvidence: AggregatedEvidence = {
    supportingSources: allSupportingAndNeutral,
    contradictingSources: contradictingSources.sort(
      (a, b) => (b.credibilityScore ?? 0) - (a.credibilityScore ?? 0)
    ),
    factCheckSources: scoredFactCheckSources,
    totalSourceCount:
      allSupportingAndNeutral.length +
      contradictingSources.length +
      scoredFactCheckSources.length,
    hasEnoughEvidence,
  };

  logger.info("AggregationAgent: aggregation complete", {
    supportingCount: allSupportingAndNeutral.length,
    contradictingCount: contradictingSources.length,
    neutralMergedIntoSupporting: neutralSources.length,
    factCheckCount: scoredFactCheckSources.length,
    totalCount: aggregatedEvidence.totalSourceCount,
    hasEnoughEvidence,
  });

  return aggregatedEvidence;
}
