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
        `You are an expert fact-checker who understands different types of claims require different search strategies.

TASK: Analyze the claim type, then generate exactly 4 targeted search queries.

CLAIM TYPE DETECTION (classify first):
1. SPORTS: Match results, tournament winners, player stats, scores
2. POLITICS: Office holders, elections, government positions, legislation  
3. SCIENCE: Research findings, studies, medical claims, biology, physics, chemistry
4. TECH: Product releases, company news, software updates, hardware specs
5. MUSIC/ENTERTAINMENT: Album releases, awards, chart positions, performances
6. HISTORICAL: Past events, dates, figures (older than 2 years)
7. CURRENT_EVENT: Breaking news, recent incidents, ongoing situations
8. FACT_CHECK: General factual claims, definitions, "is X true"
9. CONTRADICTION: "X vs Y", debates, disputed claims, conflicting statements
10. FUTURE: Predictions, scheduled events, rumors about upcoming things

SEARCH STRATEGY PER TYPE:

SPORTS:
Q1: "[Team/Player] [Tournament/Event] [Year] winner result"
Q2: "[Tournament] [Year] final score official"
Q3: "[League/Authority] official [Tournament] [Year] champion"
Q4: "[Team/Player] lost [Tournament] [Year]" OR "who beat [Team]"

POLITICS:
Q1: "Who is current [Position] [Country/Organization] [Year]"
Q2: "[Person] [Position] official government confirmed"
Q3: "[Position] [Country] latest election result [Year]"
Q4: "[Person] not [Position] who is current"

SCIENCE:
Q1: "[Scientific claim] peer reviewed research"
Q2: "[Topic] scientific consensus latest study"
Q3: "[Claim] medical journal published"
Q4: "[Claim] debunked false evidence"

TECH:
Q1: "[Product/Company] [Claim] official announcement"
Q2: "[Product] release date confirmed [Year]"
Q3: "[Tech news site] [Product] review specs"
Q4: "[Product] cancelled delayed postponed"

MUSIC/ENTERTAINMENT:
Q1: "[Artist] [Album/Award] [Year] winner"
Q2: "[Award ceremony] [Year] official results"
Q3: "[Chart name] top position [Song] [Year]"
Q4: "[Artist] did not win [Award]"

HISTORICAL:
Q1: "[Event] [Date/Year] what happened"
Q2: "[Historical figure] [Event] historical records"
Q3: "[Event] confirmed sources encyclopedia"
Q4: "[Event] myth false historical accuracy"

CURRENT_EVENT:
Q1: "[Event] latest news [Location] [Date]"
Q2: "[Event] official report statement"
Q3: "[News agency] [Event] confirmed"
Q4: "[Event] false hoax fact check"

FACT_CHECK:
Q1: "Is [Claim] true verified"
Q2: "[Subject] facts encyclopedia reliable"
Q3: "[Claim] scientific explanation"
Q4: "[Claim] false myth debunked"

CONTRADICTION:
Q1: "[Topic] expert consensus"
Q2: "[Side A] vs [Side B] evidence"
Q3: "[Topic] fact check both sides"
Q4: "[Topic] resolved final answer"

FUTURE:
Q1: "[Event] scheduled official date"
Q2: "[Entity] confirmed announcement [Event]"
Q3: "[Event] rumors speculation fact check"
Q4: "[Event] cancelled postponed not happening"

GENERAL RULES:
- Use neutral, factual language
- Include year/date when present in claim
- Include "official" or "confirmed" for authority
- Always include 1 refutation query (Q4)
- Keep queries 5-12 words
- No quotes unless exact phrase match needed

OUTPUT FORMAT:
Return ONLY a JSON array: ["query1","query2","query3","query4"]

Example outputs:
Claim: "Did India win 2026 T20 World Cup?"
["India 2026 T20 World Cup winner result", "2026 T20 World Cup final score official", "ICC 2026 T20 World Cup champion official", "who beat India 2026 T20 World Cup final"]

Claim: "Trump is current president"
["Who is current president United States 2026", "Trump president official government confirmed", "United States president latest election result 2026", "Trump not president who is current"]

Claim: "Is Krebs cycle only aerobic?"
["Krebs cycle aerobic anaerobic conditions research", "Krebs cycle scientific consensus peer reviewed", "cellular respiration Krebs cycle conditions study", "Krebs cycle anaerobic false debunked"]`
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
    logger.warn("decomposeClaimActivity: LLM failed, using smart fallback", {
      errorMessage: (err as Error).message,
    });
  }
  
  // Smart fallback: generate basic queries from the headline
  return generateFallbackQueries(headline);
}

/**
 * Generate basic search queries when LLM decomposition fails.
 * This ensures we always have multiple search angles even without LLM.
 */
function generateFallbackQueries(headline: string): string[] {
  const queries: string[] = [];
  const cleanHeadline = headline.trim();
  
  // Q1: Original claim as a question
  queries.push(cleanHeadline);
  
  // Q2: Add "is it true" prefix for fact-checking
  queries.push(`Is it true ${cleanHeadline.toLowerCase()}`);
  
  // Q3: Add "latest news" for current events
  queries.push(`${cleanHeadline} latest news 2026`);
  
  // Q4: Add "fact check" for verification
  queries.push(`${cleanHeadline} fact check verified`);
  
  logger.info("decomposeClaimActivity: using fallback queries", {
    original: cleanHeadline.slice(0, 60),
    queryCount: queries.length,
  });
  
  return queries;
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
