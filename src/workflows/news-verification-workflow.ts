/**
 * news-verification-workflow.ts
 *
 * Temporal Workflow: NewsVerificationWorkflow
 *
 * This workflow orchestrates the entire verification pipeline:
 *   1. Check Redis cache (via activity)
 *   2. Run scraping activities IN PARALLEL
 *   3. Run LangChain multi-agent pipeline
 *   4. Persist result to PostgreSQL
 *   5. Cache result in Redis
 *   6. Return final result
 *
 * IMPORTANT Temporal constraints (this file is sandboxed):
 *   - NO I/O (no fetch, no fs, no database calls)
 *   - NO process.env (use activity parameters instead)
 *   - NO non-deterministic code (no Date.now(), no Math.random())
 *   - Import ONLY from @temporalio/workflow — never from Node.js core
 *   - All I/O must go through activity calls
 *
 * Retry policy:
 *   - Scraping activities:     1 retry, 30s timeout (parallel HTTP needs time)
 *   - LangChain activity:      1 retry, 45s timeout (Groq is fast)
 *   - Database/cache activities: 3 retries, 10s timeout
 */

import {
  proxyActivities,
  ActivityOptions,
  workflowInfo,
  sleep,
} from "@temporalio/workflow";

import type {
  scrapeNewsSourcesActivity,
  scrapeFactCheckSourcesActivity,
  runLangChainOrchestrationActivity,
  persistVerificationResultActivity,
  cacheVerificationResultActivity,
  decomposeClaimActivity,
} from "../activities/scraping-activities";

// ─── Activity Proxies ─────────────────────────────────────────────────────────
//
// We create THREE proxy groups with different retry/timeout policies:
//
//   scrapingActivities   - 1 retry, 30s each (many parallel HTTP requests)
//   llmActivities        - 1 retry, 45s each (Groq is fast, <5s typical)
//   storageActivities    - 3 retries, 10s each (PostgreSQL/Redis, fast)

const SCRAPING_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "30 seconds",  // Increased: need time for parallel HTTP
  retry: {
    maximumAttempts: 2,            // Reduced retries (1 initial + 1 retry)
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "8 seconds",
  },
};

const LLM_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "45 seconds",  // Reduced: Groq is fast
  retry: {
    maximumAttempts: 2,            // Reduced retries
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "8 seconds",
  },
};

const STORAGE_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "10 seconds",
  retry: {
    maximumAttempts: 4,
    initialInterval: "500ms",
    backoffCoefficient: 2,
    maximumInterval: "5 seconds",
  },
};

// Typed activity proxies
const scrapingActivities = proxyActivities<{
  scrapeNewsSourcesActivity: typeof scrapeNewsSourcesActivity;
  scrapeFactCheckSourcesActivity: typeof scrapeFactCheckSourcesActivity;
}>(SCRAPING_ACTIVITY_OPTIONS);

const llmActivities = proxyActivities<{
  runLangChainOrchestrationActivity: typeof runLangChainOrchestrationActivity;
  decomposeClaimActivity: typeof decomposeClaimActivity;
}>(LLM_ACTIVITY_OPTIONS);

const storageActivities = proxyActivities<{
  persistVerificationResultActivity: typeof persistVerificationResultActivity;
  cacheVerificationResultActivity: typeof cacheVerificationResultActivity;
}>(STORAGE_ACTIVITY_OPTIONS);

// ─── Workflow Input / Output ──────────────────────────────────────────────────

export interface NewsVerificationWorkflowInput {
  headlineText: string;
  verificationId: string;
}

export interface NewsVerificationWorkflowOutput {
  verificationId: string;
  headlineText: string;
  verdict: string;
  confidenceScore: number;
  reasoning: string;
  totalSourceCount: number;
  supportingSources: import('../utils/shared-types').CredibilityScoredSource[];
  contradictingSources: import('../utils/shared-types').CredibilityScoredSource[];
  factCheckSources: import('../utils/shared-types').CredibilityScoredSource[];
  workflowId: string;
  cachedResult: boolean;
}

// ─── Workflow Implementation ──────────────────────────────────────────────────

/**
 * Main Temporal workflow function.
 *
 * Must be deterministic — the same inputs always produce the same sequence
 * of activity calls.  Temporal replays this function on worker restart,
 * so any non-determinism causes a NondeterminismError.
 */
export async function newsVerificationWorkflow(
  input: NewsVerificationWorkflowInput
): Promise<NewsVerificationWorkflowOutput> {
  const currentWorkflowInfo = workflowInfo();
  const currentWorkflowId = currentWorkflowInfo.workflowId;

  // ── Step 1: Decompose claim into 3 targeted search queries ────────────────────
  // LLM generates 3 specific questions covering different evidence angles:
  //   Q1 — direct factual question
  //   Q2 — entity + outcome result
  //   Q3 — broader winner/champion search
  // Each runs as a parallel Google News RSS query, tripling evidence coverage.
  const searchQueries = await llmActivities.decomposeClaimActivity(
    input.headlineText
  );

  // ── Step 2: Run scraping activities IN PARALLEL ────────────────────────────
  // Both scraping operations are completely independent so we run them
  // concurrently to minimise total latency.
  //
  // Promise.all is safe inside Temporal workflows — both are deterministic
  // activity calls and Temporal replays them correctly.
  const [scrapedNewsArticlesJson, scrapedFactCheckResultsJson] =
    await Promise.all([
      scrapingActivities
        .scrapeNewsSourcesActivity(searchQueries)
        .then((articles: import('../utils/shared-types').ScrapedNewsArticle[]) => JSON.stringify(articles)),

      scrapingActivities
        .scrapeFactCheckSourcesActivity(
          searchQueries.flatMap((q: string) => q.split(" ")).slice(0, 8)
        )
        .then((factChecks: import('../utils/shared-types').ScrapedFactCheckResult[]) => JSON.stringify(factChecks)),
    ]);

  // ── Step 2: Run LangChain multi-agent pipeline ─────────────────────────────
  const pipelineResultJson =
    await llmActivities.runLangChainOrchestrationActivity(
      input.headlineText,
      scrapedNewsArticlesJson,
      scrapedFactCheckResultsJson
    );

  // ── Step 3: Parse result for storage and response ─────────────────────────
  // We parse inside the workflow only to build the response object.
  // The raw JSON is passed to storage activities to avoid re-serialisation.
  const pipelineResult = JSON.parse(pipelineResultJson) as {
    verdictOutput: {
      verdict: string;
      confidenceScore: number;
      reasoning: string;
    };
    aggregatedEvidence: {
      totalSourceCount: number;
      supportingSources: import('../utils/shared-types').CredibilityScoredSource[];
      contradictingSources: import('../utils/shared-types').CredibilityScoredSource[];
      factCheckSources: import('../utils/shared-types').CredibilityScoredSource[];
    };
  };

  // Build the final workflow result for caching
  const workflowResult: NewsVerificationWorkflowOutput = {
    verificationId: input.verificationId,
    headlineText: input.headlineText,
    verdict: pipelineResult.verdictOutput.verdict,
    confidenceScore: pipelineResult.verdictOutput.confidenceScore,
    reasoning: pipelineResult.verdictOutput.reasoning,
    totalSourceCount: pipelineResult.aggregatedEvidence.totalSourceCount,
    supportingSources: pipelineResult.aggregatedEvidence.supportingSources,
    contradictingSources: pipelineResult.aggregatedEvidence.contradictingSources,
    factCheckSources: pipelineResult.aggregatedEvidence.factCheckSources,
    workflowId: currentWorkflowId,
    cachedResult: false,
  };

  // ── Step 4: Persist to PostgreSQL (retry safe) ────────────────────────────
  await storageActivities.persistVerificationResultActivity(
    input.verificationId,
    input.headlineText,
    pipelineResultJson,
    currentWorkflowId
  );

  // ── Step 5: Store in Redis cache ──────────────────────────────────────────
  // We pass a lightweight summary to Redis (not the full evidence JSON)
  // to keep memory usage low on the free tier.
  await storageActivities.cacheVerificationResultActivity(
    input.headlineText,
    JSON.stringify({
      verificationId: workflowResult.verificationId,
      headlineText: workflowResult.headlineText,
      verdict: workflowResult.verdict,
      confidenceScore: workflowResult.confidenceScore,
      reasoning: workflowResult.reasoning,
      supportingSources:
        pipelineResult.aggregatedEvidence.supportingSources.slice(0, 3),
      contradictingSources:
        pipelineResult.aggregatedEvidence.contradictingSources.slice(0, 3),
      cachedResult: true,
      createdAt: new Date().toISOString(),
    })
  );

  // Temporal requires at least one activity between timers and return.
  // We do a short sleep here only if we need to debounce rapid re-submissions.
  // (Removed — unnecessary in this flow, keeping it minimal.)
  void sleep; // reference to suppress unused import warning

  return workflowResult;
}
