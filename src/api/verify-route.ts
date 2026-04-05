/**
 * verify-route.ts
 *
 * POST /api/v1/verify
 *
 * The single API endpoint that drives the entire verification system.
 *
 * Request flow:
 *   1. Validate input (headline not empty, reasonable length)
 *   2. Check Redis cache — return immediately if hit
 *   3. Generate a unique verification ID
 *   4. Start Temporal workflow and wait for result
 *   5. Return structured response
 *
 * Error handling:
 *   - Validation errors → 400
 *   - Workflow errors   → 500
 *   - Cache errors are swallowed (fail-open, see verification-cache.ts)
 */

import { Router, Request, Response, NextFunction } from "express";
import { body, validationResult, ValidationError } from "express-validator";
import { v4 as generateUuid } from "uuid";
import { getCachedVerificationResult } from "../cache/verification-cache";
import { startAndAwaitVerificationWorkflow } from "./temporal-client";
import { VerifyHeadlineResponse } from "../utils/shared-types";
import { toVerificationClientResult } from "../utils/client-response";
import { ValidationError as AppValidationError } from "../utils/app-errors";
import { logger } from "../utils/logger";

export const verifyRouter = Router();

// ─── Input Validation Middleware ──────────────────────────────────────────────

const headlineValidationRules = [
  body("headline")
    .isString()
    .withMessage("headline must be a string")
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage("headline must be between 10 and 500 characters"),
];

// ─── POST /api/v1/verify ──────────────────────────────────────────────────────

verifyRouter.post(
  "/",
  headlineValidationRules,
  async (
    request: Request,
    response: Response,
    next: NextFunction
  ): Promise<void> => {
    // ── 1. Validate input ──────────────────────────────────────────────────
    const validationErrors = validationResult(request);
    if (!validationErrors.isEmpty()) {
      const firstError = validationErrors.array()[0] as ValidationError;
      const errorMessage =
        "msg" in firstError ? String(firstError.msg) : "Invalid input";

      logger.warn("POST /api/v1/verify: validation failed", {
        errors: validationErrors.array(),
      });

      const errorResponse: VerifyHeadlineResponse = {
        success: false,
        data: null,
        error: errorMessage,
      };

      response.status(400).json(errorResponse);
      return;
    }

    const { headline: rawHeadline } = request.body as { headline: string };
    const trimmedHeadline = rawHeadline.trim();

    logger.info("POST /api/v1/verify: received verification request", {
      headlineLength: trimmedHeadline.length,
    });

    try {
      // ── 2. Check Redis cache ─────────────────────────────────────────────
      const cachedVerificationResult =
        await getCachedVerificationResult(trimmedHeadline);

      if (cachedVerificationResult !== null) {
        logger.info("POST /api/v1/verify: returning cached result", {
          verdict: cachedVerificationResult.verdict,
        });

        const cachedResponse: VerifyHeadlineResponse = {
          success: true,
          data: toVerificationClientResult({
            verificationId: cachedVerificationResult.verificationId,
            headlineText: cachedVerificationResult.headlineText,
            verdict: cachedVerificationResult.verdict,
            confidenceScore: cachedVerificationResult.confidenceScore,
            reasoning: cachedVerificationResult.reasoning,
            supportingSources: cachedVerificationResult.supportingSources ?? [],
            contradictingSources:
              cachedVerificationResult.contradictingSources ?? [],
            factCheckSources: cachedVerificationResult.factCheckSources,
            cachedResult: cachedVerificationResult.cachedResult,
            createdAt: cachedVerificationResult.createdAt,
          }),
          error: null,
        };

        response.status(200).json(cachedResponse);
        return;
      }

      // ── 3. Generate unique verification ID ────────────────────────────────
      const newVerificationId = generateUuid();

      // ── 4. Start Temporal workflow and await result ───────────────────────
      const workflowOutput = await startAndAwaitVerificationWorkflow(
        trimmedHeadline,
        newVerificationId
      );

      const verificationResult = toVerificationClientResult({
        verificationId: workflowOutput.verificationId,
        headlineText: workflowOutput.headlineText,
        verdict: workflowOutput.verdict as import("../utils/shared-types").VerificationVerdict,
        confidenceScore: workflowOutput.confidenceScore,
        reasoning: workflowOutput.reasoning,
        supportingSources: workflowOutput.supportingSources ?? [],
        contradictingSources: workflowOutput.contradictingSources ?? [],
        factCheckSources: workflowOutput.factCheckSources ?? [],
        cachedResult: false,
        createdAt: new Date().toISOString(),
      });

      // ── 5. Return response ────────────────────────────────────────────────
      const successResponse: VerifyHeadlineResponse = {
        success: true,
        data: verificationResult,
        error: null,
      };

      logger.info("POST /api/v1/verify: verification complete", {
        verificationId: newVerificationId,
        verdict: workflowOutput.verdict,
        confidenceScore: workflowOutput.confidenceScore,
      });

      response.status(200).json(successResponse);
    } catch (routeError) {
      logger.error("POST /api/v1/verify: unexpected error", {
        errorMessage: (routeError as Error).message,
        stack: (routeError as Error).stack,
      });
      next(routeError);
    }
  }
);

// ─── GET /api/v1/verify/health ────────────────────────────────────────────────

verifyRouter.get(
  "/health",
  async (
    _request: Request,
    response: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { checkDatabaseHealth } = await import(
        "../database/database-client"
      );
      const { checkRedisHealth } = await import("../cache/redis-client");

      await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);

      response.status(200).json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        services: { database: "ok", cache: "ok", workflow: "not checked" },
      });
    } catch (healthCheckError) {
      logger.error("Health check failed", {
        errorMessage: (healthCheckError as Error).message,
      });
      next(
        new AppValidationError(
          `Health check failed: ${(healthCheckError as Error).message}`
        )
      );
    }
  }
);
