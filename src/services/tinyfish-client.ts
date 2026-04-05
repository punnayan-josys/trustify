/**
 * tinyfish-client.ts
 *
 * REST API wrapper for the TinyFish Web Agent (https://agent.tinyfish.ai)
 *
 * TinyFish spins up a real browser, navigates to the URL, and returns
 * structured JSON extracted via natural language — no CSS selectors, no
 * XPath, no JS rendering issues.
 *
 * API reference: https://docs.tinyfish.ai/api-reference/automation/run-browser-automation-synchronously
 *
 * Endpoint  : POST https://agent.tinyfish.ai/v1/automation/run
 * Auth      : X-API-Key header
 * Returns   : { status: "COMPLETED"|"FAILED", result: { ... } }
 */

import axios from "axios";
import { logger } from "../utils/logger";

const TINYFISH_BASE_URL = "https://agent.tinyfish.ai";
const TINYFISH_TIMEOUT_MS = 20_000; // real browser — 20s per call

// ─── Types ────────────────────────────────────────────────────────────────────

interface TinyFishRunResponse {
  run_id: string | null;
  status: "COMPLETED" | "FAILED";
  result: Record<string, unknown> | null;
  error: { message: string } | null;
  num_of_steps: number | null;
}

// ─── Core runner ──────────────────────────────────────────────────────────────

/**
 * Runs a TinyFish browser automation synchronously and returns the raw result.
 * Returns null on any error (network, timeout, API failure, missing key).
 */
async function runTinyFishAgent(
  url: string,
  goal: string,
  browserProfile: "lite" | "stealth" = "lite"
): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.TINYFISH_API_KEY;

  if (!apiKey) {
    logger.warn("TinyFish: TINYFISH_API_KEY not set — skipping enrichment");
    return null;
  }

  try {
    const response = await axios.post<TinyFishRunResponse>(
      `${TINYFISH_BASE_URL}/v1/automation/run`,
      {
        url,
        goal,
        browser_profile: browserProfile,
        api_integration: "truthify",
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        timeout: TINYFISH_TIMEOUT_MS,
      }
    );

    const data = response.data;

    if (data.status !== "COMPLETED" || !data.result) {
      logger.warn("TinyFish: run did not complete successfully", {
        url: url.slice(0, 80),
        status: data.status,
        error: data.error?.message,
      });
      return null;
    }

    return data.result;
  } catch (err) {
    logger.warn("TinyFish: request failed", {
      url: url.slice(0, 80),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Public helper: extract article body ─────────────────────────────────────

/**
 * Uses TinyFish to visit an article URL with a real browser and extract
 * the main article body text as a plain string (~400 chars).
 *
 * Returns null if TinyFish is unavailable, the page fails, or the result
 * contains no usable text.
 */
export async function fetchArticleBodyViaTinyFish(
  articleUrl: string
): Promise<string | null> {
  const GOAL =
    "Extract the main article body text from this news article page. " +
    "Return a JSON object with a single field: " +
    '{ "body": "<the full article text as plain text, no HTML, no links, max 500 characters>" }. ' +
    "If you cannot find the article body, return { \"body\": \"\" }.";

  logger.debug("TinyFish: fetching article body", { url: articleUrl.slice(0, 80) });

  const result = await runTinyFishAgent(articleUrl, GOAL, "lite");

  if (!result) return null;

  // Accept any string-valued field named "body", "text", "content", "article"
  const body =
    result["body"] ??
    result["text"] ??
    result["content"] ??
    result["article"] ??
    null;

  if (typeof body !== "string" || body.trim().length < 30) {
    logger.warn("TinyFish: result had no usable body text", {
      url: articleUrl.slice(0, 80),
      resultKeys: Object.keys(result),
    });
    return null;
  }

  const trimmed = body.trim().slice(0, 500);

  logger.debug("TinyFish: article body fetched", {
    url: articleUrl.slice(0, 80),
    bodyLength: trimmed.length,
  });

  return trimmed;
}
