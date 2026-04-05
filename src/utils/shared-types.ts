/**
 * shared-types.ts
 *
 * Central type registry for the entire Truthify system.
 * All domain objects are defined here so every layer shares
 * the same vocabulary.  Import only from this file — never
 * re-define types locally.
 */

// ─── Verdict ────────────────────────────────────────────────────────────────

export type VerificationVerdict =
  | "TRUE"
  | "FALSE"
  | "MISLEADING"
  | "UNVERIFIED";

// ─── Evidence / Sources ──────────────────────────────────────────────────────

export interface ScrapedNewsArticle {
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
  sourceDomain: string;
}

export interface ScrapedFactCheckResult {
  title: string;
  url: string;
  summary: string;
  claimRating: string | null; // e.g. "False", "Mostly True"
  sourceDomain: string;
}

export interface ScrapingOutput {
  newsArticles: ScrapedNewsArticle[];
  factCheckResults: ScrapedFactCheckResult[];
  scrapingErrors: string[];
}

// ─── Agent Payloads ──────────────────────────────────────────────────────────

export interface ClaimUnderstandingOutput {
  originalHeadline: string;
  extractedEntities: string[];         // persons, organisations, places
  claimType: string;                   // "event", "statistic", "quote", "allegation"
  claimCategory: string;               // "sports_result" | "office_holder" | "current_event" | "historical_fact" | "future_claim" | "general"
  rewrittenQuestion: string;           // neutral factual question for retrieval (e.g. "Who won the T20 World Cup 2026?")
  searchKeywords: string[];
}

export interface CredibilityScoredSource {
  url: string;
  title: string;
  summary: string;
  credibilityScore: number;            // 0–100
  sourceTier: "tier1" | "tier2" | "tier3" | "unknown";
  relevanceScore?: number;             // 0–100 keyword overlap with claim
}

/** API / UI payload — no internal tier labels */
export interface PublicEvidenceSource {
  url: string;
  title: string;
  summary: string;
  credibilityScore: number;
  relevanceScore?: number;
}

export interface AggregatedEvidence {
  supportingSources: CredibilityScoredSource[];
  contradictingSources: CredibilityScoredSource[];
  factCheckSources: CredibilityScoredSource[];
  totalSourceCount: number;
  hasEnoughEvidence: boolean;          // false = skip LLM, return UNVERIFIED immediately
}

export interface VerdictBrainOutput {
  verdict: VerificationVerdict;
  confidenceScore: number;             // 0–100
  reasoning: string;
  supportingSources: CredibilityScoredSource[];
  contradictingSources: CredibilityScoredSource[];
}

// ─── Workflow / API Contracts ────────────────────────────────────────────────

export interface VerificationWorkflowInput {
  headlineText: string;
  workflowId: string;
}

export interface VerificationWorkflowResult {
  verificationId: string;
  headlineText: string;
  verdict: VerificationVerdict;
  confidenceScore: number;
  reasoning: string;
  supportingSources: CredibilityScoredSource[];
  contradictingSources: CredibilityScoredSource[];
  factCheckSources?: CredibilityScoredSource[];
  cachedResult: boolean;
  createdAt: string;
}

/** Returned to browsers and public API clients */
export interface VerificationClientResult {
  verificationId: string;
  headlineText: string;
  verdict: VerificationVerdict;
  confidenceScore: number;
  reasoning: string;
  supportingSources: PublicEvidenceSource[];
  contradictingSources: PublicEvidenceSource[];
  factCheckSources?: PublicEvidenceSource[];
  cachedResult: boolean;
  createdAt: string;
}

// ─── Database Row ────────────────────────────────────────────────────────────

export interface NewsVerificationRow {
  verification_id: string;
  headline_text: string;
  verdict: VerificationVerdict;
  confidence_score: number;
  reasoning: string;
  evidence_json: AggregatedEvidence;
  created_at: Date;
  workflow_id: string;
}

// ─── API Request / Response ──────────────────────────────────────────────────

export interface VerifyHeadlineRequest {
  headline: string;
}

export interface VerifyHeadlineResponse {
  success: boolean;
  data: VerificationClientResult | null;
  error: string | null;
}
