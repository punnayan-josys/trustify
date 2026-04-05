/**
 * Shared Temporal gRPC options for the API client and the worker.
 *
 * Temporal Cloud expects TLS + an API key; local Docker uses plain TCP.
 */

import type { NativeConnectionOptions } from "@temporalio/worker";

export function getTemporalAddress(): string {
  return process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
}

/**
 * Connection options for {@link Connection.connect} and {@link NativeConnection.connect}.
 */
export function buildTemporalConnectionOptions(): NativeConnectionOptions {
  const address = getTemporalAddress();
  const apiKey = process.env.TEMPORAL_API_KEY?.trim() || undefined;
  const tlsRequested = process.env.TEMPORAL_TLS === "true";
  const useTls = tlsRequested || Boolean(apiKey);

  return {
    address,
    ...(useTls ? { tls: true as const } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}
