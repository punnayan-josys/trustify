/**
 * migrate.ts
 *
 * Idempotent database migration script.
 *
 * Run with:  npm run db:migrate
 *
 * This is intentionally a simple SQL-over-pool approach rather than
 * a full migration framework (Flyway, Liquibase).  When the project
 * grows, swap this out for a proper migration tool without touching
 * the application code.
 *
 * Each migration is wrapped in a transaction so partial failures
 * leave the schema in a clean state.
 */

import "dotenv/config";
import { getDatabasePool, closeDatabasePool } from "./database-client";
import { logger } from "../utils/logger";

const MIGRATION_SQL = `
  -- Enable UUID generation without extra extensions on PG 13+
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  -- ─── news_verification_results ────────────────────────────────────────────
  -- Stores the final verdict for every unique verification run.
  -- evidence_json is JSONB so we can query into the nested structure later
  -- without schema migrations (e.g. index on evidence_json->>'verdict').
  CREATE TABLE IF NOT EXISTS news_verification_results (
    verification_id   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    headline_text     TEXT          NOT NULL,
    verdict           VARCHAR(20)   NOT NULL
                      CHECK (verdict IN ('TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIED')),
    confidence_score  SMALLINT      NOT NULL
                      CHECK (confidence_score BETWEEN 0 AND 100),
    reasoning         TEXT          NOT NULL,
    evidence_json     JSONB         NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    workflow_id       TEXT          NOT NULL
  );

  -- ─── Indices ──────────────────────────────────────────────────────────────
  -- Lookup by workflow ID (used to retrieve result after Temporal workflow ends)
  CREATE INDEX IF NOT EXISTS idx_nvr_workflow_id
    ON news_verification_results (workflow_id);

  -- Lookup by creation time (for auditing / analytics queries)
  CREATE INDEX IF NOT EXISTS idx_nvr_created_at
    ON news_verification_results (created_at DESC);

  -- GIN index on JSONB evidence for fast containment queries
  CREATE INDEX IF NOT EXISTS idx_nvr_evidence_gin
    ON news_verification_results USING GIN (evidence_json);
`;

async function runMigrations(): Promise<void> {
  const databasePool = getDatabasePool();
  const databaseClient = await databasePool.connect();

  try {
    logger.info("Starting database migration…");

    await databaseClient.query("BEGIN");
    await databaseClient.query(MIGRATION_SQL);
    await databaseClient.query("COMMIT");

    logger.info("Database migration completed successfully");
  } catch (migrationError) {
    await databaseClient.query("ROLLBACK");
    logger.error("Database migration failed — rolling back", {
      errorMessage: (migrationError as Error).message,
    });
    throw migrationError;
  } finally {
    databaseClient.release();
    await closeDatabasePool();
  }
}

runMigrations().catch((fatalError: Error) => {
  logger.error("Fatal migration error", { errorMessage: fatalError.message });
  process.exit(1);
});
