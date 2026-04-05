/**
 * worker.ts
 *
 * Temporal Worker Process
 *
 * The worker polls the Temporal task queue and executes:
 *   - Workflow code (news-verification-workflow)
 *   - Activity implementations (scraping-activities)
 *
 * Run with: npm run worker
 *
 * In production, run multiple worker instances behind a load balancer.
 * Temporal handles work distribution automatically.
 *
 * Temporal Cloud: set TEMPORAL_ADDRESS (gRPC host:7233), TEMPORAL_NAMESPACE,
 * TEMPORAL_API_KEY (TLS is enabled automatically when the API key is set).
 */

import "dotenv/config";
import { Worker, NativeConnection } from "@temporalio/worker";
import * as scrapingActivities from "../activities/scraping-activities";
import { logger } from "../utils/logger";
import { buildTemporalConnectionOptions } from "../utils/temporal-connection";

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
const TEMPORAL_TASK_QUEUE =
  process.env.TEMPORAL_TASK_QUEUE ?? "news-verification-queue";

async function startWorker(): Promise<void> {
  logger.info("Temporal worker: connecting to server", {
    temporalAddress: TEMPORAL_ADDRESS,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TEMPORAL_TASK_QUEUE,
  });

  const temporalConnection = await NativeConnection.connect(
    buildTemporalConnectionOptions()
  );

  const temporalWorker = await Worker.create({
    connection: temporalConnection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TEMPORAL_TASK_QUEUE,

    // Point to compiled workflow file — Temporal bundles this separately
    // from activities to enforce the sandbox constraint.
    workflowsPath: require.resolve("./news-verification-workflow"),

    // All activity implementations registered here
    activities: scrapingActivities,

    // Concurrency limits — tune based on available CPU/memory
    maxConcurrentActivityTaskExecutions: 10,
    maxConcurrentWorkflowTaskExecutions: 10,
  });

  logger.info("Temporal worker: started successfully", {
    taskQueue: TEMPORAL_TASK_QUEUE,
  });

  // Graceful shutdown on SIGINT / SIGTERM
  process.on("SIGINT", async () => {
    logger.info("Temporal worker: received SIGINT, shutting down…");
    await temporalWorker.shutdown();
    await temporalConnection.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Temporal worker: received SIGTERM, shutting down…");
    await temporalWorker.shutdown();
    await temporalConnection.close();
    process.exit(0);
  });

  // Blocks until worker is shut down
  await temporalWorker.run();
}

startWorker().catch((workerStartError: Error) => {
  logger.error("Temporal worker: failed to start", {
    errorMessage: workerStartError.message,
    stack: workerStartError.stack,
  });
  process.exit(1);
});
