/**
 * hash-utils.ts
 *
 * Deterministic, collision-resistant hash generation for Redis cache keys.
 *
 * We normalise the headline before hashing so that minor whitespace or
 * capitalisation differences produce the same cache key.
 *
 * Crypto is a Node.js built-in — no extra dependency required.
 */

import { createHash } from "crypto";

/**
 * Normalises a news headline for consistent cache key generation:
 * - trims surrounding whitespace
 * - collapses internal whitespace to single spaces
 * - lowercases everything
 */
function normaliseHeadlineForHashing(rawHeadline: string): string {
  return rawHeadline.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Produces a SHA-256 hex digest of the normalised headline.
 * Used as the Redis cache key suffix.
 *
 * Example:
 *   generateHeadlineHash("NASA lands on Mars") → "3f4a8b…"
 */
export function generateHeadlineHash(rawHeadline: string): string {
  const normalisedHeadline = normaliseHeadlineForHashing(rawHeadline);
  return createHash("sha256").update(normalisedHeadline).digest("hex");
}

/**
 * Builds the full Redis cache key for a given headline.
 * Prefix keeps all Truthify keys namespaced so they don't collide
 * with other applications sharing the same Redis instance.
 */
export function buildRedisCacheKey(rawHeadline: string): string {
  const headlineHash = generateHeadlineHash(rawHeadline);
  return `news_verification:${headlineHash}`;
}
