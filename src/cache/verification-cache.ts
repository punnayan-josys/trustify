/**
 * verification-cache.ts
 *
 * Cache read/write operations for verification results.
 *
 * Key format:  news_verification:{sha256(normalised_headline)}
 * TTL:         REDIS_CACHE_TTL_SECONDS (default 86400 = 24 hours)
 *
 * Design decisions:
 * - We store the full VerificationWorkflowResult as JSON so the API
 *   can serve a cache hit without touching PostgreSQL at all.
 * - cache misses return null (callers decide what to do next).
 * - We never throw on cache errors — a cache miss is acceptable;
 *   we simply fall through to the workflow.
 */

import { getRedisClient } from "./redis-client";
import { buildRedisCacheKey } from "../utils/hash-utils";
import { VerificationWorkflowResult } from "../utils/shared-types";
import { logger } from "../utils/logger";

const CACHE_TTL_SECONDS = Number(
  process.env.REDIS_CACHE_TTL_SECONDS ?? 86_400
);

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Looks up a cached verification result for a given headline.
 * Returns null on cache miss or any Redis error (fail-open behaviour).
 */
export async function getCachedVerificationResult(
  headlineText: string
): Promise<VerificationWorkflowResult | null> {
  const cacheKey = buildRedisCacheKey(headlineText);

  try {
    const cachedJson = await getRedisClient().get(cacheKey);

    if (cachedJson === null) {
      logger.debug("Cache miss", { cacheKey });
      return null;
    }

    const cachedResult = JSON.parse(cachedJson) as VerificationWorkflowResult;
    logger.info("Cache hit — returning cached verification result", {
      cacheKey,
      verdict: cachedResult.verdict,
    });

    // Annotate the result so the caller knows it was served from cache
    return { ...cachedResult, cachedResult: true };
  } catch (cacheError) {
    // Log and fail open — do not block the verification pipeline
    logger.warn("Failed to read from Redis cache, proceeding without cache", {
      cacheKey,
      errorMessage: (cacheError as Error).message,
    });
    return null;
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Stores a completed verification result in Redis with a 24-hour TTL.
 * Non-throwing — a write failure is logged but does not abort the workflow.
 */
export async function setCachedVerificationResult(
  headlineText: string,
  verificationResult: VerificationWorkflowResult
): Promise<void> {
  const cacheKey = buildRedisCacheKey(headlineText);

  try {
    const serialisedResult = JSON.stringify(verificationResult);
    await getRedisClient().setex(cacheKey, CACHE_TTL_SECONDS, serialisedResult);

    logger.info("Verification result stored in Redis cache", {
      cacheKey,
      ttlSeconds: CACHE_TTL_SECONDS,
      verdict: verificationResult.verdict,
    });
  } catch (cacheError) {
    logger.warn("Failed to write to Redis cache", {
      cacheKey,
      errorMessage: (cacheError as Error).message,
    });
  }
}
