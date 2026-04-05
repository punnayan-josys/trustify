/**
 * credibility-scoring-agent.ts
 *
 * Agent 2: CredibilityScoringAgent  (LLM-powered)
 *
 * Responsibility:
 *   Assign a numeric credibility score (0–100) and source tier to every
 *   scraped source using an LLM that reasons about:
 *     - Publisher reputation, ownership, and editorial standards
 *     - History of accuracy and corrections policy
 *     - Whether the outlet is a primary source, wire service, or aggregator
 *     - Whether the outlet is a dedicated fact-checker
 *     - Potential bias, sensationalism, or tabloid tendencies
 *     - Domain authority signals visible in the source domain name
 *
 *   Scoring bands:
 *     tier1  (75–100): Major wire services, broadcasters, fact-checkers, official bodies
 *     tier2  (50–74):  Reputable national/regional outlets, encyclopaedias, sports authorities
 *     tier3  (20–49):  Smaller outlets, aggregators, less-known blogs
 *     unknown (0–19):  Unrecognised domain, no editorial signals present
 *
 *   Fact-check sources are always pre-scored at tier1 (90+) since their
 *   entire business model is accuracy verification.
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { getSharedLlmClient } from "./llm-client";
import {
  ScrapedNewsArticle,
  ScrapedFactCheckResult,
  CredibilityScoredSource,
} from "../utils/shared-types";
import { SourceTier } from "../services/source-tier-config";
import { logger } from "../utils/logger";

// ─── System Prompt ────────────────────────────────────────────────────────────
// Kept intentionally short — the LLM only needs domain names to score credibility.
// Sending titles/summaries wastes tokens; credibility is a property of the outlet, not the article.

const CREDIBILITY_SCORING_SYSTEM_PROMPT = `You are a media credibility expert. Score each news source domain.

TIERS (score MUST fall within range):
tier1 (75-100): Reuters, AP, AFP, Bloomberg, BBC, NPR, PBS, NYT, Guardian, WashingtonPost, FT, TheHindu, Snopes, PolitiFact, FactCheck.org, FullFact, BoomLive, AltNews, WHO, CDC, NASA, UN, ICC, BCCI, ESPNCricinfo, Cricbuzz
tier2 (50-74): CNN, NBC, CBS, ABC, WSJ, Economist, AlJazeera, DW, Politico, Axios, TheHill, NDTV, TimesOfIndia, IndiaToday, HindustanTimes, Scroll, TheWire, FirstPost, ESPN, YahooSports, Olympics, Wikipedia, Britannica
tier3 (20-49): Smaller regional outlets, aggregators, blogs, outlets with poor accuracy record
unknown (0-19): Unrecognisable domain, no editorial identity

RULES:
- Score EVERY item, same order as input, no skipping
- Sub-domains inherit parent (sports.ndtv.com = tier2)
- Top tier1 (Reuters, AP) = 92-100; tier1 press = 75-85; strong tier2 = 65-74
- Score is about the OUTLET, not the article content

Return ONLY a JSON array, no markdown:
[{{"index":0,"credibilityScore":88,"sourceTier":"tier1"}}]`;

const CREDIBILITY_SCORING_HUMAN_TEMPLATE = `Score these {count} domains:
{domainsJson}`;

// ─── LLM Scorer ───────────────────────────────────────────────────────────────

// Smaller batches + longer delays to stay within Groq free tier (6000 TPM)
const CREDIBILITY_BATCH_SIZE = 5;  // Reduced from 8
// Delay between batches to avoid rate limit
const INTER_BATCH_DELAY_MS = 3000;  // Increased from 1500ms

/**
 * Sends batches of domain names to the LLM and returns index-keyed scores.
 * Only the domain is sent — titles and summaries are NOT needed for credibility
 * scoring and would consume ~80% of the token budget unnecessarily.
 */
async function scoreBatchViaLlm(
  sources: Array<{ url: string; title: string; summary: string; domain: string }>
): Promise<CredibilityScoredSource[]> {
  if (sources.length === 0) return [];

  const allScored: CredibilityScoredSource[] = new Array(sources.length);

  for (let batchStart = 0; batchStart < sources.length; batchStart += CREDIBILITY_BATCH_SIZE) {
    if (batchStart > 0) {
      // Throttle between batches to avoid hitting TPM limits on free tier
      await new Promise((resolve) => setTimeout(resolve, INTER_BATCH_DELAY_MS));
    }

    const batch = sources.slice(batchStart, batchStart + CREDIBILITY_BATCH_SIZE);

    // Only send index + domain — that is all the LLM needs to score credibility
    const domainsJson = JSON.stringify(
      batch.map((s, i) => ({ index: batchStart + i, domain: s.domain }))
    );

    const promptTemplate = ChatPromptTemplate.fromMessages([
      ["system", CREDIBILITY_SCORING_SYSTEM_PROMPT],
      ["human", CREDIBILITY_SCORING_HUMAN_TEMPLATE],
    ]);

    const chain = promptTemplate
      .pipe(getSharedLlmClient())
      .pipe(new StringOutputParser());

    const rawResponse = await chain.invoke({
      count: batch.length,
      domainsJson,
    });

    const batchScored = parseCredibilityScoringResponse(rawResponse, batch, batchStart);
    batchScored.forEach((scored, i) => {
      allScored[batchStart + i] = scored;
    });
  }

  return allScored;
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function parseCredibilityScoringResponse(
  rawResponse: string,
  originalBatch: Array<{ url: string; title: string; summary: string; domain: string }>,
  batchOffset: number
): CredibilityScoredSource[] {
  const VALID_TIERS: SourceTier[] = ["tier1", "tier2", "tier3", "unknown"];

  const TIER_CLAMPS: Record<SourceTier, { min: number; max: number }> = {
    tier1:   { min: 75, max: 100 },
    tier2:   { min: 50, max: 74 },
    tier3:   { min: 20, max: 49 },
    unknown: { min: 0,  max: 19 },
  };

  try {
    const cleanedJson = rawResponse
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const parsed = JSON.parse(cleanedJson) as Array<{
      index?: unknown;
      credibilityScore?: unknown;
      sourceTier?: unknown;
    }>;

    if (!Array.isArray(parsed)) throw new Error("LLM returned non-array JSON");

    return originalBatch.map((original, localIdx) => {
      // Match by global index if present, otherwise fall back to positional order
      const globalIdx = batchOffset + localIdx;
      const item =
        parsed.find((p) => typeof p.index === "number" && p.index === globalIdx) ??
        parsed[localIdx];

      const sourceTier: SourceTier =
        item && typeof item.sourceTier === "string" && VALID_TIERS.includes(item.sourceTier as SourceTier)
          ? (item.sourceTier as SourceTier)
          : "unknown";

      const rawScore =
        item && typeof item.credibilityScore === "number"
          ? Math.round(item.credibilityScore)
          : TIER_CLAMPS[sourceTier].min + 5;

      const clamp = TIER_CLAMPS[sourceTier];
      const credibilityScore = Math.max(clamp.min, Math.min(clamp.max, rawScore));

      return {
        url: original.url,
        title: original.title,
        summary: original.summary,
        credibilityScore,
        sourceTier,
      } satisfies CredibilityScoredSource;
    });
  } catch (err) {
    logger.warn("CredibilityScoringAgent: LLM response parse failed, falling back to tier3", {
      error: (err as Error).message,
      rawResponseSnippet: rawResponse.slice(0, 200),
    });
    return originalBatch.map((s) => ({
      url: s.url,
      title: s.title,
      summary: s.summary,
      credibilityScore: 30,
      sourceTier: "tier3" as SourceTier,
    }));
  }
}

// ─── Score News Articles ───────────────────────────────────────────────────────

/**
 * Uses the LLM to evaluate and score all scraped news articles.
 * 
 * OPTIMIZATION: Use deterministic rule-based scoring for known sources to avoid
 * hitting Groq rate limits. Only use LLM for unknown domains.
 */
export async function scoreNewsArticleSources(
  scrapedArticles: ScrapedNewsArticle[]
): Promise<CredibilityScoredSource[]> {
  if (scrapedArticles.length === 0) return [];

  const { classifySourceTier, getCredibilityScore } = await import(
    "../services/source-tier-config"
  );

  logger.info("CredibilityScoringAgent: starting (rule-based + LLM fallback)", {
    inputCount: scrapedArticles.length,
  });

  // Separate known sources (can be scored deterministically) from unknown
  const knownSources: ScrapedNewsArticle[] = [];
  const unknownSources: ScrapedNewsArticle[] = [];

  for (const article of scrapedArticles) {
    const tier = classifySourceTier(article.url);
    if (tier === "unknown") {
      unknownSources.push(article);
    } else {
      knownSources.push(article);
    }
  }

  // Score known sources deterministically (no LLM cost)
  const knownScored: CredibilityScoredSource[] = knownSources.map((article) => ({
    url: article.url,
    title: article.title,
    summary: article.summary,
    credibilityScore: getCredibilityScore(article.url),
    sourceTier: classifySourceTier(article.url),
  }));

  // Only use LLM for unknown sources
  let unknownScored: CredibilityScoredSource[] = [];
  if (unknownSources.length > 0) {
    const input = unknownSources.map((a) => ({
      url: a.url,
      domain: a.sourceDomain && a.sourceDomain !== "unknown" ? a.sourceDomain : a.url,
      title: a.title,
      summary: a.summary,
    }));

    unknownScored = await scoreBatchViaLlm(input);
  }

  const allScored = [...knownScored, ...unknownScored];

  logger.info("CredibilityScoringAgent: scoring complete", {
    inputCount: scrapedArticles.length,
    knownSources: knownSources.length,
    unknownSources: unknownSources.length,
    tier1Count: allScored.filter((s) => s.sourceTier === "tier1").length,
    tier2Count: allScored.filter((s) => s.sourceTier === "tier2").length,
    tier3Count: allScored.filter((s) => s.sourceTier === "tier3").length,
    unknownCount: allScored.filter((s) => s.sourceTier === "unknown").length,
  });

  return allScored;
}

// ─── Score Fact-Check Results ──────────────────────────────────────────────────

/**
 * Scores fact-check results using deterministic rules.
 * Fact-check organizations are tier1 by definition.
 */
export async function scoreFactCheckSources(
  scrapedFactChecks: ScrapedFactCheckResult[]
): Promise<CredibilityScoredSource[]> {
  if (scrapedFactChecks.length === 0) return [];

  const { getCredibilityScore } = await import(
    "../services/source-tier-config"
  );

  logger.info("CredibilityScoringAgent: scoring fact-check sources (rule-based)", {
    inputCount: scrapedFactChecks.length,
  });

  // Use deterministic scoring — all fact-checkers are tier1
  return scrapedFactChecks.map((fc) => ({
    url: fc.url,
    title: fc.title,
    summary: `${fc.claimRating ? `[Fact-check rating: ${fc.claimRating}] ` : ""}${fc.summary}`,
    credibilityScore: Math.max(75, getCredibilityScore(fc.url)),
    sourceTier: "tier1" as SourceTier,
  }));
}
