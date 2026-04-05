/**
 * verification-repository.ts
 *
 * Data access layer for the news_verification_results table.
 *
 * All SQL lives here — no SQL in activities, agents, or the API layer.
 * This makes it trivial to swap PostgreSQL for another store later.
 */

import { getDatabasePool } from "./database-client";
import {
  NewsVerificationRow,
  VerificationWorkflowResult,
  AggregatedEvidence,
  VerificationVerdict,
  CredibilityScoredSource,
} from "../utils/shared-types";
import { DatabaseServiceError } from "../utils/app-errors";
import { logger } from "../utils/logger";

// ─── Write ───────────────────────────────────────────────────────────────────

export interface SaveVerificationParams {
  verificationId: string;
  headlineText: string;
  verdict: VerificationVerdict;
  confidenceScore: number;
  reasoning: string;
  aggregatedEvidence: AggregatedEvidence;
  workflowId: string;
}

/**
 * Persists a completed verification result.
 * Uses INSERT … ON CONFLICT DO NOTHING so replaying a Temporal workflow
 * (retry safe) never creates duplicate rows.
 */
export async function saveVerificationResult(
  params: SaveVerificationParams
): Promise<void> {
  const databasePool = getDatabasePool();
  const insertQuery = `
    INSERT INTO news_verification_results
      (verification_id, headline_text, verdict, confidence_score,
       reasoning, evidence_json, workflow_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (verification_id) DO NOTHING
  `;

  try {
    await databasePool.query(insertQuery, [
      params.verificationId,
      params.headlineText,
      params.verdict,
      params.confidenceScore,
      params.reasoning,
      JSON.stringify(params.aggregatedEvidence),
      params.workflowId,
    ]);

    logger.info("Verification result saved to database", {
      verificationId: params.verificationId,
      verdict: params.verdict,
    });
  } catch (queryError) {
    throw new DatabaseServiceError(
      `Failed to save verification result: ${(queryError as Error).message}`
    );
  }
}

// ─── Read by Workflow ID ──────────────────────────────────────────────────────

/**
 * Retrieves a verification result by its Temporal workflow ID.
 * Returns null if the workflow hasn't stored a result yet.
 */
export async function findVerificationByWorkflowId(
  workflowId: string
): Promise<VerificationWorkflowResult | null> {
  const databasePool = getDatabasePool();
  const selectQuery = `
    SELECT verification_id, headline_text, verdict, confidence_score,
           reasoning, evidence_json, created_at, workflow_id
    FROM   news_verification_results
    WHERE  workflow_id = $1
    LIMIT  1
  `;

  try {
    const queryResult = await databasePool.query<NewsVerificationRow>(
      selectQuery,
      [workflowId]
    );

    if (queryResult.rows.length === 0) {
      return null;
    }

    return mapRowToWorkflowResult(queryResult.rows[0]);
  } catch (queryError) {
    throw new DatabaseServiceError(
      `Failed to find verification by workflow ID: ${(queryError as Error).message}`
    );
  }
}

// ─── Row Mapping ─────────────────────────────────────────────────────────────

function mapRowToWorkflowResult(
  row: NewsVerificationRow
): VerificationWorkflowResult {
  const evidence = row.evidence_json as AggregatedEvidence;

  const supportingSources: CredibilityScoredSource[] =
    evidence.supportingSources ?? [];
  const contradictingSources: CredibilityScoredSource[] =
    evidence.contradictingSources ?? [];

  return {
    verificationId: row.verification_id,
    headlineText: row.headline_text,
    verdict: row.verdict,
    confidenceScore: row.confidence_score,
    reasoning: row.reasoning,
    supportingSources,
    contradictingSources,
    cachedResult: false,
    createdAt: row.created_at.toISOString(),
  };
}
