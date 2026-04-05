/**
 * server.ts
 *
 * Express API Server
 *
 * Entry point for the HTTP API.
 * Wires together Express, routes, and global error handling.
 *
 * Separation of concerns:
 *   - server.ts:      creates and starts the HTTP server
 *   - verify-route.ts: handles /api/v1/verify endpoints
 *   - temporal-client: communicates with Temporal
 *
 * Run with: npm run dev  (development)
 *            npm start   (production)
 */

import "dotenv/config";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { verifyRouter } from "./verify-route";
import { TruthifyError } from "../utils/app-errors";
import { logger } from "../utils/logger";
import { VerifyHeadlineResponse } from "../utils/shared-types";
import { closeDatabasePool } from "../database/database-client";
import { closeRedisClient } from "../cache/redis-client";

const SERVER_PORT = Number(process.env.PORT ?? 3000);
const API_VERSION_PREFIX = "/api/v1";

// ─── Express App Setup ────────────────────────────────────────────────────────

const expressApplication = express();

// Parse JSON request bodies
expressApplication.use(express.json({ limit: "10kb" }));

// CORS — in production, restrict this to your frontend domain
expressApplication.use(
  cors({
    origin: process.env.NODE_ENV === "production" ? false : "*",
    methods: ["GET", "POST"],
  })
);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — top level, no auth required
expressApplication.get("/health", (_request: Request, response: Response) => {
  response.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Verification API routes
expressApplication.use(`${API_VERSION_PREFIX}/verify`, verifyRouter);

// Serve the static UI from /public
expressApplication.use(express.static(path.join(__dirname, "../../public")));

// 404 handler — must be before global error handler
expressApplication.use((_request: Request, response: Response) => {
  response.status(404).json({
    success: false,
    data: null,
    error: `Route not found`,
  } satisfies VerifyHeadlineResponse);
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

expressApplication.use(
  (
    error: Error,
    _request: Request,
    response: Response,
    _next: NextFunction
  ) => {
    // Known application errors get a clean response
    if (error instanceof TruthifyError) {
      logger.warn("Application error handled", {
        errorCode: error.errorCode,
        errorMessage: error.message,
      });

      response.status(400).json({
        success: false,
        data: null,
        error: error.message,
      } satisfies VerifyHeadlineResponse);
      return;
    }

    // Unknown errors get a generic 500 response (never leak internals)
    logger.error("Unhandled server error", {
      errorMessage: error.message,
      stack: error.stack,
    });

    response.status(500).json({
      success: false,
      data: null,
      error: "An unexpected error occurred. Please try again.",
    } satisfies VerifyHeadlineResponse);
  }
);

// ─── Server Start ─────────────────────────────────────────────────────────────

const httpServer = expressApplication.listen(SERVER_PORT, () => {
  logger.info("Truthify API server started", {
    port: SERVER_PORT,
    environment: process.env.NODE_ENV ?? "development",
    apiBasePath: API_VERSION_PREFIX,
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function handleGracefulShutdown(signalName: string): Promise<void> {
  logger.info(`Received ${signalName}, starting graceful shutdown…`);

  httpServer.close(async () => {
    try {
      await Promise.all([closeDatabasePool(), closeRedisClient()]);
      logger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (shutdownError) {
      logger.error("Error during shutdown", {
        errorMessage: (shutdownError as Error).message,
      });
      process.exit(1);
    }
  });
}

process.on("SIGINT", () => void handleGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void handleGracefulShutdown("SIGTERM"));

export { expressApplication };
