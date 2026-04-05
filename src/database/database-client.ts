/**
 * database-client.ts
 *
 * Singleton PostgreSQL connection pool.
 *
 * We use a pool rather than a single connection so multiple concurrent
 * Temporal activities can safely query the database without blocking.
 *
 * Migration path to managed DB (e.g. Supabase, Neon, RDS):
 *   Just change the environment variables — no code changes needed.
 */

import { Pool, PoolConfig } from "pg";
import { logger } from "../utils/logger";
import { DatabaseServiceError } from "../utils/app-errors";

function buildPoolConfig(): PoolConfig {
  return {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? "truthify",
    user: process.env.POSTGRES_USER ?? "truthify_user",
    password: process.env.POSTGRES_PASSWORD ?? "",
    ssl:
      process.env.POSTGRES_SSL === "true"
        ? { rejectUnauthorized: false }
        : false,
    // Keep pool small to stay within free-tier connection limits
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

// Module-level singleton — created once, reused across all imports
let databasePool: Pool | null = null;

/**
 * Returns the shared PostgreSQL connection pool.
 * Lazily initialised on first call.
 */
export function getDatabasePool(): Pool {
  if (databasePool === null) {
    const poolConfig = buildPoolConfig();
    databasePool = new Pool(poolConfig);

    databasePool.on("error", (poolError: Error) => {
      logger.error("PostgreSQL pool encountered unexpected error", {
        errorMessage: poolError.message,
      });
    });

    logger.info("PostgreSQL connection pool initialised", {
      host: poolConfig.host,
      database: poolConfig.database,
    });
  }

  return databasePool;
}

/**
 * Gracefully closes the pool — call this during process shutdown.
 */
export async function closeDatabasePool(): Promise<void> {
  if (databasePool !== null) {
    await databasePool.end();
    databasePool = null;
    logger.info("PostgreSQL connection pool closed");
  }
}

/**
 * Health-check: verifies the database is reachable.
 * Throws DatabaseServiceError if not.
 */
export async function checkDatabaseHealth(): Promise<void> {
  const pool = getDatabasePool();
  try {
    await pool.query("SELECT 1");
  } catch (queryError) {
    throw new DatabaseServiceError(
      `Database health check failed: ${(queryError as Error).message}`
    );
  }
}
