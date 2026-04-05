/**
 * langchain-orchestrator.ts
 *
 * LangChain Multi-Agent Orchestration Pipeline
 *
 * This is NOT an autonomous agent loop.  It is a deterministic,
 * sequential pipeline with well-defined inputs and outputs at each step.
 *
 * Pipeline order (fixed):
 *   1. ClaimUnderstandingAgent  → extract entities, keywords, claim type
 *   2. CredibilityScoringAgent  → score all scraped sources (rule-based)
 *   3. AggregationAgent         → merge, deduplicate, classify (rule-based)
 *   4. VerdictBrainAgent        → final LLM reasoning → verdict
 *
 * Note: NewsEvidenceAgent and FactCheckAgent run as Temporal activities
 * BEFORE this orchestrator is called.  The scraping results are passed
 * in as parameters so this function is pure and testable.
 *
 * Why deterministic pipeline vs autonomous loop?
 *   - Loops are unpredictable and expensive
 *   - Every step here is auditable and reproducible
 *   - Each step can be unit tested independently
 */

import { runClaimUnderstandingAgent } from "./claim-understanding-agent";
import {
  scoreNewsArticleSources,
  scoreFactCheckSources,
} from "./credibility-scoring-agent";
import { runAggregationAgent } from "./aggregation-agent";
import { runVerdictBrainAgent } from "./verdict-brain-agent";
import { fetchArticleBodyViaTinyFish } from "../services/tinyfish-client";
import {
  ScrapingOutput,
  AggregatedEvidence,
  VerdictBrainOutput,
  ClaimUnderstandingOutput,
  VerificationVerdict,
  CredibilityScoredSource,
} from "../utils/shared-types";
import { logger } from "../utils/logger";

// ─── Orchestration Result ─────────────────────────────────────────────────────

export interface OrchestrationPipelineResult {
  claimUnderstanding: ClaimUnderstandingOutput;
  aggregatedEvidence: AggregatedEvidence;
  verdictOutput: VerdictBrainOutput;
}

// ─── Google News Redirect Resolver ──────────────────────────────────────────────

import axios from "axios";

/**
 * Google News RSS links are opaque redirect tokens (CBMi...).
 * A single HEAD request with maxRedirects:0 returns a 301 with the real URL
 * in the Location header. We follow that to get the actual article URL.
 * Returns the original URL unchanged on any error.
 */
async function resolveGoogleNewsUrl(url: string): Promise<string> {
  if (!url.includes("news.google.com/rss/articles/")) return url;
  try {
    const resp = await axios.head(url, {
      maxRedirects: 5,
      timeout: 5_000,
      validateStatus: () => true, // don't throw on any status
    });
    // axios follows redirects and gives us the final URL
    const finalUrl: string | undefined =
      (resp.request as { res?: { responseUrl?: string } })?.res?.responseUrl;
    if (finalUrl && finalUrl.startsWith("http") && !finalUrl.includes("news.google.com")) {
      logger.debug("resolveGoogleNewsUrl: resolved", {
        from: url.slice(0, 60),
        to: finalUrl.slice(0, 80),
      });
      return finalUrl;
    }
  } catch {
    // silent fallback
  }
  return url;
}

// ─── Article Body Enrichment ────────────────────────────────────────────────

/**
 * For sources that survived the relevance filter, follow their URLs and replace
 * the short RSS snippet (~100 chars) with the real article body (~400 chars).
 *
 * This is the key step that lets the LLM read actual article content rather
 * than just headlines — e.g. "RCB won the IPL 2025 title" buried in the body
 * of an article titled "Virat Kohli IPL triumph vindicates loyalty".
 *
 * Strategy:
 *   - Prioritise tier1 > tier2, then by relevanceScore descending
 *   - Attempt at most `maxFetch` fetches (default 8) in parallel
 *   - Fall back to original RSS summary silently on any fetch/parse error
 *   - Only replace summary when fetched body is meaningfully longer
 */
async function enrichSourcesWithArticleBody(
  sources: CredibilityScoredSource[],
  maxFetch = 8
): Promise<CredibilityScoredSource[]> {
  if (sources.length === 0) return sources;

  const tierOrder: Record<string, number> = {
    tier1: 0,
    tier2: 1,
    tier3: 2,
    unknown: 3,
  };

  // Pick top candidates — best tier first, then best relevance
  const ranked = [...sources]
    .map((s, originalIndex) => ({ s, originalIndex }))
    .sort((a, b) => {
      const tierDiff =
        (tierOrder[a.s.sourceTier] ?? 3) - (tierOrder[b.s.sourceTier] ?? 3);
      if (tierDiff !== 0) return tierDiff;
      return (b.s.relevanceScore ?? 0) - (a.s.relevanceScore ?? 0);
    })
    .slice(0, maxFetch);

  logger.info("enrichSourcesWithArticleBody: fetching full article bodies", {
    totalSources: sources.length,
    fetchingCount: ranked.length,
  });

  // Step 1: resolve Google News redirect tokens to real article URLs in parallel
  const resolvedRanked = await Promise.all(
    ranked.map(async ({ s, originalIndex }) => ({
      s: { ...s, url: await resolveGoogleNewsUrl(s.url) },
      originalUrl: s.url,
      originalIndex,
    }))
  );

  // Step 2: fetch article bodies via TinyFish in parallel — failures silently swallowed
  const results = await Promise.allSettled(
    resolvedRanked.map(async ({ s, originalUrl }) => {
      const body = await fetchArticleBodyViaTinyFish(s.url);
      if (body && body.length > (s.summary?.length ?? 0) + 30) {
        logger.debug("enrichSourcesWithArticleBody: enriched via TinyFish", {
          url: s.url.slice(0, 70),
          oldLen: s.summary?.length ?? 0,
          newLen: body.length,
        });
        // Keep original URL so the UI links to the right place
        return { ...s, url: originalUrl, summary: body } as CredibilityScoredSource;
      }
      return { ...s, url: originalUrl } as CredibilityScoredSource;
    })
  );

  // Build a URL → enriched source map (keyed on original URL)
  const enrichedMap = new Map<string, CredibilityScoredSource>();
  results.forEach((result, i) => {
    const originalUrl = resolvedRanked[i].originalUrl;
    enrichedMap.set(
      originalUrl,
      result.status === "fulfilled" ? result.value : ranked[i].s
    );
  });

  // Return all sources, replacing whichever ones were enriched
  return sources.map((s) => enrichedMap.get(s.url) ?? s);
}

// ─── Main Orchestration Entry Point ──────────────────────────────────────────

/**
 * Runs the full LangChain multi-agent pipeline.
 *
 * Called by the Temporal workflow after scraping activities complete.
 *
 * @param headlineText    The original user-submitted news headline
 * @param scrapingOutput  Structured results from both scraping activities
 */
export async function runVerificationOrchestrationPipeline(
  headlineText: string,
  scrapingOutput: ScrapingOutput
): Promise<OrchestrationPipelineResult> {
  logger.info("LangChain orchestration pipeline: starting", {
    headline: headlineText.slice(0, 80),
    newsArticleCount: scrapingOutput.newsArticles.length,
    factCheckResultCount: scrapingOutput.factCheckResults.length,
  });

  // ── Step 1: Claim Understanding (LLM) ─────────────────────────────────────
  // Extracts entities and keywords from the headline.
  // Used for evidence classification context passed to VerdictBrainAgent.
  const claimUnderstanding = await runClaimUnderstandingAgent(headlineText);

  // ── Step 2: Credibility Scoring (LLM-powered) ──────────────────────────────
  // The LLM evaluates each source domain against editorial standards,
  // ownership, history of accuracy, and independence — far richer than
  // a static domain lookup.  Both calls run in parallel to save latency.
  const [scoredNewsSources, scoredFactCheckSources] = await Promise.all([
    scoreNewsArticleSources(scrapingOutput.newsArticles),
    scoreFactCheckSources(scrapingOutput.factCheckResults),
  ]);

  // ── Step 3: Aggregation (LLM-powered) ───────────────────────────────────
  // The LLM semantically filters, deduplicates, and classifies sources by
  // meaning — understands synonyms, paraphrase, and indirect references.
  // headlineText is passed as the primary claim context so the model can
  // reason about the EXACT claim, not just keyword overlap.
  const aggregatedEvidence = await runAggregationAgent(
    scoredNewsSources,
    scoredFactCheckSources,
    claimUnderstanding.searchKeywords,
    headlineText
  );

  // ── Evidence Guard: short-circuit if no credible relevant evidence ────────
  // If no tier1/tier2 sources survived the relevance filter and there are
  // no fact-check results, skip the LLM entirely and return UNVERIFIED.
  // This prevents the model from hallucinating verdicts from weak/noisy sources.
  if (!aggregatedEvidence.hasEnoughEvidence) {
    logger.warn("LangChain orchestration: insufficient evidence — returning UNVERIFIED early", {
      supportingCount: aggregatedEvidence.supportingSources.length,
      factCheckCount: aggregatedEvidence.factCheckSources.length,
      claimCategory: claimUnderstanding.claimCategory,
    });
    return {
      claimUnderstanding,
      aggregatedEvidence,
      verdictOutput: {
        verdict: "UNVERIFIED" as VerificationVerdict,
        confidenceScore: 0,
        reasoning:
          "No high-quality relevant sources were found to confirm or deny this claim. " +
          "Increase source coverage or try again with a more specific headline.",
        supportingSources: aggregatedEvidence.supportingSources,
        contradictingSources: aggregatedEvidence.contradictingSources,
      } satisfies VerdictBrainOutput,
    };
  }

  // ── Step 3b: Article Body Enrichment ────────────────────────────────────
  // Follow each source URL and replace the short RSS snippet with the real
  // article body so the LLM can read actual content, not just headlines.
  const enrichedSupporting = await enrichSourcesWithArticleBody(
    aggregatedEvidence.supportingSources
  );
  const enrichedContradicting = await enrichSourcesWithArticleBody(
    aggregatedEvidence.contradictingSources
  );
  const enrichedAggregatedEvidence: AggregatedEvidence = {
    ...aggregatedEvidence,
    supportingSources: enrichedSupporting,
    contradictingSources: enrichedContradicting,
  };

  // ── Step 4: Verdict Brain (LLM — final authority) ─────────────────────────
  // Receives all structured evidence and produces the final verdict.
  const verdictOutput = await runVerdictBrainAgent(
    headlineText,
    enrichedAggregatedEvidence
  );

  logger.info("LangChain orchestration pipeline: complete", {
    verdict: verdictOutput.verdict,
    confidenceScore: verdictOutput.confidenceScore,
    totalSources: aggregatedEvidence.totalSourceCount,
  });

  return {
    claimUnderstanding,
    aggregatedEvidence: enrichedAggregatedEvidence,
    verdictOutput,
  };
}
