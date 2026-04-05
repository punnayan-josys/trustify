/**
 * temporal-client.ts
 *
 * Temporal client singleton for the API server.
 *
 * The API uses this to:
 *   - start new verification workflows
 *   - poll for workflow completion
 *   - check workflow status
 *
 * The worker uses a separate NativeConnection (in worker.ts).
 * These are two different process roles — keep them separate.
 */

import { Client, Connection, WorkflowHandle } from "@temporalio/client";
import { logger } from "../utils/logger";
import { WorkflowOrchestrationError } from "../utils/app-errors";
import type { NewsVerificationWorkflowOutput } from "../workflows/news-verification-workflow";
import { buildTemporalConnectionOptions } from "../utils/temporal-connection";

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
const TEMPORAL_TASK_QUEUE =
  process.env.TEMPORAL_TASK_QUEUE ?? "news-verification-queue";

// Maximum time the API will wait for a workflow to complete (30 seconds)
const WORKFLOW_COMPLETION_TIMEOUT_MS = 120_000;

let temporalClient: Client | null = null;

/**
 * Returns the shared Temporal client.
 * Lazily initialised on first call.
 */
export async function getTemporalClient(): Promise<Client> {
  if (temporalClient === null) {
    const temporalConnection = await Connection.connect(
      buildTemporalConnectionOptions()
    );

    temporalClient = new Client({
      connection: temporalConnection,
      namespace: TEMPORAL_NAMESPACE,
    });

    logger.info("Temporal client connected", {
      temporalAddress: TEMPORAL_ADDRESS,
      namespace: TEMPORAL_NAMESPACE,
    });
  }

  return temporalClient;
}

/**
 * Starts a new NewsVerificationWorkflow and waits for its result.
 *
 * Uses a deterministic workflow ID based on the verification UUID.
 * This makes the start idempotent — duplicate starts return the
 * same workflow handle.
 */
export async function startAndAwaitVerificationWorkflow(
  headlineText: string,
  verificationId: string
): Promise<NewsVerificationWorkflowOutput> {
  const client = await getTemporalClient();
  const workflowId = `news-verification-${verificationId}`;

  // Dynamically import the workflow function (not allowed in workflow sandbox,
  // but fine in the API process which is a regular Node.js process)
  const { newsVerificationWorkflow } = await import(
    "../workflows/news-verification-workflow"
  );

  try {
    logger.info("Starting Temporal workflow", {
      workflowId,
      headlineLength: headlineText.length,
    });

    const workflowHandle: WorkflowHandle<typeof newsVerificationWorkflow> =
      await client.workflow.start(newsVerificationWorkflow, {
        taskQueue: TEMPORAL_TASK_QUEUE,
        workflowId,
        args: [{ headlineText, verificationId }],
      });

    // Wait for workflow to complete with a timeout
    const workflowResult = await Promise.race([
      workflowHandle.result(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(
            new WorkflowOrchestrationError(
              `Workflow ${workflowId} did not complete within ${WORKFLOW_COMPLETION_TIMEOUT_MS}ms`
            )
          );
        }, WORKFLOW_COMPLETION_TIMEOUT_MS);
      }),
    ]);

    logger.info("Temporal workflow completed", {
      workflowId,
      verdict: workflowResult.verdict,
    });

    return workflowResult;
  } catch (workflowError) {
    if (workflowError instanceof WorkflowOrchestrationError) {
      throw workflowError;
    }

    throw new WorkflowOrchestrationError(
      `Temporal workflow failed: ${(workflowError as Error).message}`
    );
  }
}
