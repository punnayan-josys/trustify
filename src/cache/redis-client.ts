/**
 * redis-client.ts
 *
 * Singleton ioredis client.
 *
 * Migration path to Upstash (managed Redis, free tier available):
 *   Set REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_TLS=true
 *   in your environment — no code changes needed.
 */

import Redis, { RedisOptions } from "ioredis";
import { logger } from "../utils/logger";
import { CacheServiceError } from "../utils/app-errors";

function buildRedisConfig(): RedisOptions {
  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    // Fail fast rather than queue commands while disconnected
    enableOfflineQueue: false,
    // Reconnect with exponential back-off, max 3 attempts
    maxRetriesPerRequest: 3,
    retryStrategy(retryAttemptCount: number): number | null | void {
      if (retryAttemptCount > 3) {
        return null; // stop retrying
      }
      return Math.min(retryAttemptCount * 200, 2000);
    },
  };
}

let redisClient: Redis | null = null;

/**
 * Returns the shared ioredis client.
 * Lazily initialised on first call.
 */
export function getRedisClient(): Redis {
  if (redisClient === null) {
    const redisConfig = buildRedisConfig();
    redisClient = new Redis(redisConfig);

    redisClient.on("connect", () => {
      logger.info("Redis client connected", {
        host: redisConfig.host,
        port: redisConfig.port,
      });
    });

    redisClient.on("error", (redisError: Error) => {
      logger.error("Redis client error", { errorMessage: redisError.message });
    });
  }

  return redisClient;
}

/**
 * Gracefully closes the Redis connection — call during process shutdown.
 */
export async function closeRedisClient(): Promise<void> {
  if (redisClient !== null) {
    await redisClient.quit();
    redisClient = null;
    logger.info("Redis client disconnected");
  }
}

/**
 * Health-check: verifies Redis is reachable via PING.
 * Throws CacheServiceError if not.
 */
export async function checkRedisHealth(): Promise<void> {
  const client = getRedisClient();
  try {
    const pongResponse = await client.ping();
    if (pongResponse !== "PONG") {
      throw new CacheServiceError("Redis PING returned unexpected response");
    }
  } catch (pingError) {
    throw new CacheServiceError(
      `Redis health check failed: ${(pingError as Error).message}`
    );
  }
}
