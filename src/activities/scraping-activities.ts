/**
 * scraping-activities.ts
 *
 * Temporal Activities for scraping news and fact-check sources.
 *
 * Temporal activities are the units of work that can be:
 *   - retried automatically on failure
 *   - executed with timeouts
 *   - run in parallel (from the workflow)
 *   - replayed safely (idempotent)
 *
 * Why separate activities for news vs fact-check scraping?
 *   - They can run in PARALLEL via Promise.all in the workflow
 *   - They can have independent retry counts and timeouts
 *   - If fact-check scraping fails, news scraping result is still usable
 *
 * IMPORTANT: Activities must NOT import from @temporalio/workflow.
 *            Only @temporalio/activity is safe here.
 */

import { ScrapedNewsArticle, ScrapedFactCheckResult } from "../utils/shared-types";
import {
  fetchAndScrapeNewsFromRss,
  fetchFromDirectPublisherFeeds,
  fetchFromWikipedia,
  fetchFactCheckResults,
} from "../services/tinyfish-scraper";
import { logger } from "../utils/logger";

const MAX_NEWS_SOURCES = Number(process.env.SCRAPING_MAX_NEWS_SOURCES ?? 3);  // Reduced from 5
const MAX_FACT_CHECK_SOURCES = Number(
  process.env.SCRAPING_MAX_FACT_CHECK_SOURCES ?? 2  // Reduced from 3
);

// ─── Activity: Decompose Claim into Multiple Search Queries ──────────────────

/**
 * Decomposes a news claim into 4 targeted search queries covering the claim
 * from different angles simultaneously — including a mandatory refutation query.
 *
 *   Q1 — Canonical factual question  ("Did India win ICC T20 World Cup 2026?")
 *   Q2 — Direct entity verification  ("India T20 World Cup 2026 winner official result")
 *   Q3 — Broad independent search    ("ICC T20 World Cup 2026 final winner champion")
 *   Q4 — Explicit refutation search  ("Who beat India T20 World Cup 2026 final")
 *
 * Each query runs as an independent parallel Google News RSS search so the
 * evidence pool covers both confirming AND contradicting evidence.
 *
 * Non-throwing: falls back to the original headline on any LLM error.
 */
export async function decomposeClaimActivity(
  headline: string
): Promise<string[]> {
  try {
    const { getSharedLlmClient } = await import("../agents/llm-client");
    const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");

    const llm = getSharedLlmClient();
    const response = await llm.invoke([
      new SystemMessage(
        `You are a fact-checking research assistant.
Given a claim, generate exactly 4 search queries that together VERIFY or REFUTE it globally.

OBJECTIVE
The queries must maximize coverage, reduce ambiguity, and surface both confirming and contradicting evidence.

GENERAL RULES
* Queries must be concise and factual
* Prefer neutral wording
* Include year/time when applicable
* Avoid repeating same phrasing
* Include entity disambiguation if ambiguous (country, role, organization)
* Ensure at least one query is designed to REFUTE the claim
* Do NOT include quotes unless needed for exact phrase
* Return ONLY a JSON array of exactly 4 strings

QUERY DECOMPOSITION STRATEGY

Q1 — Canonical factual question
Convert the claim into a precise answerable question.
Examples: "Who is the current president of the United States", "Did India win ICC T20 World Cup 2026"

Q2 — Direct entity verification search
Pattern: "[entity] [claim context] official result confirmed"
Examples: "India T20 World Cup 2026 winner official result", "current US president official government confirmation"

Q3 — Broad independent confirmation
Pattern: "[event/topic] winner result latest official"
Examples: "ICC T20 World Cup 2026 final winner", "United States president current 2026"

Q4 — Explicit refutation / contradiction search (MANDATORY)
Search for evidence the claim is false.
Pattern: "[entity] did not win" OR "[entity] lost" OR "[actual alternative entity]"
Examples: "Who beat India T20 World Cup 2026 final", "Trump not president who is current US president"

DOMAIN HANDLING
Sports: include winner, final, champion, result
Politics: include current, official, government, sworn in
Events: include confirmed, report, official statement

TIME HANDLING
* If claim implies "current", include "latest" or present year
* If claim includes year, preserve it in all 4 queries
* If no time provided, append "latest"

OUTPUT FORMAT
Return ONLY: ["query1","query2","query3","query4"]`
      ),
      new HumanMessage(`Claim: "${headline}"`),
    ]);

    const rawText = (response.content as string)
      .trim()
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    // Primary: try parsing as clean JSON array
    // Fallback: extract array literal from prose like "Here are 4 queries: [\"a\",\"b\",...]\n"
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const arrayMatch = rawText.match(/\[([\s\S]*?)\]/);
      if (arrayMatch) {
        try {
          parsed = JSON.parse(arrayMatch[0]);
        } catch {
          // fall through to outer catch
        }
      }
    }

    if (Array.isArray(parsed)) {
      const queries = (parsed as unknown[])
        .filter((q): q is string => typeof q === "string" && q.trim().length > 3)
        .map((q) => q.trim())
        .slice(0, 5); // accept up to 5 in case model generates an extra
      if (queries.length > 0) {
        logger.info("decomposeClaimActivity: generated search queries", {
          original: headline.slice(0, 80),
          queries,
        });
        return queries;
      }
    }
  } catch (err) {
    logger.warn("decomposeClaimActivity: failed, using original headline", {
      errorMessage: (err as Error).message,
    });
  }
  return [headline];
}

// ─── Activity: Scrape News Sources ───────────────────────────────────────────

/**
 * Fetches and scrapes the top news articles for a search query.
 *
 * Retry-safe: if a URL fails to scrape, we skip it and return
 * whatever succeeded.  The workflow retries the whole activity on
 * complete failure.
 *
 * Returns an array of structured news articles (may be empty on full failure).
 */
export async function scrapeNewsSourcesActivity(
  searchQueries: string[]
): Promise<ScrapedNewsArticle[]> {
  logger.info("scrapeNewsSourcesActivity: starting", {
    queryCount: searchQueries.length,
    queries: searchQueries.map((q) => q.slice(0, 60)),
    maxPerQuery: MAX_NEWS_SOURCES,
  });

  // Build word-level tokens for direct publisher feed matching.
  // Direct feeds need individual words, not full question strings.
  const DIRECT_FEED_STOP_WORDS = new Set([
    "who", "what", "when", "where", "why", "how", "did", "does",
    "the", "a", "an", "is", "are", "was", "were", "has", "have",
    "in", "of", "to", "for", "with", "from", "at", "by", "on",
  ]);
  const allQueryText = searchQueries.join(" ");
  const directFeedKeywords = allQueryText
    .toLowerCase()
    .replace(/[?!.,]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !DIRECT_FEED_STOP_WORDS.has(w));

  const keywordsForDirectFeeds =
    directFeedKeywords.length > 0 ? directFeedKeywords : searchQueries;

  // Run every search query against Google News RSS in parallel,
  // PLUS all direct publisher feeds + Wikipedia for factual claims.
  // Total latency = slowest single call.
  const [googleResultBatches, directPublisherArticles, wikipediaArticles] =
    await Promise.all([
      Promise.allSettled(
        searchQueries.slice(0, 3).map((query) =>  // Limit to 3 queries max
          fetchAndScrapeNewsFromRss(query, MAX_NEWS_SOURCES)
        )
      ),
      fetchFromDirectPublisherFeeds(keywordsForDirectFeeds, 2),  // Reduced from 3
      fetchFromWikipedia(searchQueries.slice(0, 2), 2),  // Limit queries + results
    ]);

  const googleNewsArticles = googleResultBatches.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );

  // Merge all articles and deduplicate by URL
  const allArticles = [
    ...googleNewsArticles,
    ...directPublisherArticles,
    ...wikipediaArticles,
  ];
  const seenUrls = new Set<string>();
  const deduplicatedArticles = allArticles.filter((article) => {
    const normalisedUrl = article.url.toLowerCase().replace(/\/$/, "");
    if (seenUrls.has(normalisedUrl)) return false;
    seenUrls.add(normalisedUrl);
    return true;
  });

  logger.info("scrapeNewsSourcesActivity: complete", {
    googleNewsCount: googleNewsArticles.length,
    directPublisherCount: directPublisherArticles.length,
    wikipediaCount: wikipediaArticles.length,
    totalAfterDedup: deduplicatedArticles.length,
  });

  return deduplicatedArticles;
}

// ─── Activity: Scrape Fact-Check Sources ─────────────────────────────────────

/**
 * Fetches and scrapes fact-checking websites for the given keywords.
 *
 * Retry-safe: returns empty array on complete failure rather than throwing.
 * (Fact-check data is valuable but not required for a valid verdict.)
 */
export async function scrapeFactCheckSourcesActivity(
  searchKeywords: string[]
): Promise<ScrapedFactCheckResult[]> {
  logger.info("scrapeFactCheckSourcesActivity: starting", {
    keywordCount: searchKeywords.length,
  });

  const factCheckResults = await fetchFactCheckResults(
    searchKeywords,
    MAX_FACT_CHECK_SOURCES
  );

  logger.info("scrapeFactCheckSourcesActivity: complete", {
    resultCount: factCheckResults.length,
  });

  return factCheckResults;
}

// ─── Activity: Run LangChain Pipeline ────────────────────────────────────────

/**
 * Runs the full LangChain multi-agent orchestration pipeline.
 *
 * This is a single activity so Temporal can retry the entire LLM
 * pipeline if an OpenAI API call fails transiently.
 *
 * Returns the final verdict output as a plain serialisable object.
 */
export async function runLangChainOrchestrationActivity(
  headlineText: string,
  scrapedNewsArticlesJson: string,
  scrapedFactCheckResultsJson: string
): Promise<string> {
  const { runVerificationOrchestrationPipeline } = await import(
    "../agents/langchain-orchestrator"
  );

  const scrapedNewsArticles = JSON.parse(
    scrapedNewsArticlesJson
  ) as ScrapedNewsArticle[];
  const scrapedFactCheckResults = JSON.parse(
    scrapedFactCheckResultsJson
  ) as ScrapedFactCheckResult[];

  logger.info("runLangChainOrchestrationActivity: starting", {
    newsArticleCount: scrapedNewsArticles.length,
    factCheckCount: scrapedFactCheckResults.length,
  });

  const pipelineResult = await runVerificationOrchestrationPipeline(
    headlineText,
    {
      newsArticles: scrapedNewsArticles,
      factCheckResults: scrapedFactCheckResults,
      scrapingErrors: [],
    }
  );

  logger.info("runLangChainOrchestrationActivity: complete", {
    verdict: pipelineResult.verdictOutput.verdict,
  });

  return JSON.stringify(pipelineResult);
}

// ─── Activity: Persist Result to PostgreSQL ───────────────────────────────────

/**
 * Saves a completed verification result to the database.
 * Idempotent: uses INSERT ON CONFLICT DO NOTHING.
 */
export async function persistVerificationResultActivity(
  verificationId: string,
  headlineText: string,
  pipelineResultJson: string,
  workflowId: string
): Promise<void> {
  const { OrchestrationPipelineResult } = await import(
    "../agents/langchain-orchestrator"
  ).then(async (m) => {
    // We only need the type, not the runtime value
    void m;
    return {} as { OrchestrationPipelineResult: unknown };
  });

  void OrchestrationPipelineResult; // suppress unused warning

  const { saveVerificationResult } = await import(
    "../database/verification-repository"
  );

  const pipelineResult = JSON.parse(pipelineResultJson) as {
    verdictOutput: {
      verdict: string;
      confidenceScore: number;
      reasoning: string;
    };
    aggregatedEvidence: import("../utils/shared-types").AggregatedEvidence;
  };

  await saveVerificationResult({
    verificationId,
    headlineText,
    verdict: pipelineResult.verdictOutput.verdict as import("../utils/shared-types").VerificationVerdict,
    confidenceScore: pipelineResult.verdictOutput.confidenceScore,
    reasoning: pipelineResult.verdictOutput.reasoning,
    aggregatedEvidence: pipelineResult.aggregatedEvidence,
    workflowId,
  });
}

// ─── Activity: Cache Result in Redis ─────────────────────────────────────────

/**
 * Stores the final result in Redis with a 24-hour TTL.
 * Non-throwing — cache failure is logged but does not fail the workflow.
 */
export async function cacheVerificationResultActivity(
  headlineText: string,
  workflowResultJson: string
): Promise<void> {
  const { setCachedVerificationResult } = await import(
    "../cache/verification-cache"
  );

  const workflowResult = JSON.parse(
    workflowResultJson
  ) as import("../utils/shared-types").VerificationWorkflowResult;

  await setCachedVerificationResult(headlineText, workflowResult);
}
