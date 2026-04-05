/**
 * app-errors.ts
 *
 * Typed error hierarchy for Truthify.
 *
 * Using typed errors instead of plain Error objects lets middleware
 * and callers distinguish operational failures (expected, recoverable)
 * from programming errors (unexpected, should crash loudly).
 */

/** Base class — all Truthify errors extend this. */
export class TruthifyError extends Error {
  public readonly errorCode: string;

  constructor(message: string, errorCode: string) {
    super(message);
    this.name = this.constructor.name;
    this.errorCode = errorCode;
    // Maintains proper stack trace in V8 (available in Node.js)
    if (typeof (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      (Error as unknown as { captureStackTrace: (t: unknown, c: unknown) => void }).captureStackTrace(this, this.constructor);
    }
  }
}

/** Thrown when the Redis client cannot connect or execute a command. */
export class CacheServiceError extends TruthifyError {
  constructor(message: string) {
    super(message, "CACHE_SERVICE_ERROR");
  }
}

/** Thrown when PostgreSQL operations fail. */
export class DatabaseServiceError extends TruthifyError {
  constructor(message: string) {
    super(message, "DATABASE_SERVICE_ERROR");
  }
}

/** Thrown when a scraping activity fails to fetch or parse a page. */
export class ScrapingActivityError extends TruthifyError {
  constructor(message: string) {
    super(message, "SCRAPING_ACTIVITY_ERROR");
  }
}

/** Thrown when an LLM agent returns an unexpected or unparseable response. */
export class AgentResponseError extends TruthifyError {
  constructor(message: string) {
    super(message, "AGENT_RESPONSE_ERROR");
  }
}

/** Thrown for invalid incoming API requests. */
export class ValidationError extends TruthifyError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
  }
}

/** Thrown when the Temporal workflow cannot be started or polled. */
export class WorkflowOrchestrationError extends TruthifyError {
  constructor(message: string) {
    super(message, "WORKFLOW_ORCHESTRATION_ERROR");
  }
}
