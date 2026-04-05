/**
 * client-response.ts
 *
 * Shapes verification payloads for browsers and public API consumers:
 * strips internal scoring labels and rewrites any tier jargon in reasoning text.
 */

import type {
  CredibilityScoredSource,
  PublicEvidenceSource,
  VerificationClientResult,
} from "./shared-types";

export function toPublicEvidenceSource(
  source: CredibilityScoredSource
): PublicEvidenceSource {
  const out: PublicEvidenceSource = {
    url: source.url,
    title: source.title,
    summary: source.summary,
    credibilityScore: source.credibilityScore,
  };
  if (source.relevanceScore != null) {
    out.relevanceScore = source.relevanceScore;
  }
  return out;
}

/**
 * Replaces internal tier wording that may appear in model-generated reasoning.
 */
export function sanitizeReasoningForClient(reasoning: string): string {
  let text = reasoning;
  text = text.replace(
    /\bTier[-\u2013\s]?1\b/gi,
    "strong primary reporting (wires, official bodies, or fact-checkers)"
  );
  text = text.replace(
    /\bTier[-\u2013\s]?2\b/gi,
    "established news reporting"
  );
  text = text.replace(/\bTier[-\u2013\s]?3\b/gi, "other outlets");
  text = text.replace(/\btier[-\u2013\s]?1\b/g, "strong primary reporting");
  text = text.replace(/\btier[-\u2013\s]?2\b/g, "established news reporting");
  text = text.replace(/\btier[-\u2013\s]?3\b/g, "other outlets");
  return text.replace(/\s{2,}/g, " ").trim();
}

export function toVerificationClientResult(input: {
  verificationId: string;
  headlineText: string;
  verdict: VerificationClientResult["verdict"];
  confidenceScore: number;
  reasoning: string;
  supportingSources: CredibilityScoredSource[];
  contradictingSources: CredibilityScoredSource[];
  factCheckSources?: CredibilityScoredSource[];
  cachedResult: boolean;
  createdAt: string;
}): VerificationClientResult {
  const result: VerificationClientResult = {
    verificationId: input.verificationId,
    headlineText: input.headlineText,
    verdict: input.verdict,
    confidenceScore: input.confidenceScore,
    reasoning: sanitizeReasoningForClient(input.reasoning),
    supportingSources: input.supportingSources.map(toPublicEvidenceSource),
    contradictingSources: input.contradictingSources.map(toPublicEvidenceSource),
    cachedResult: input.cachedResult,
    createdAt: input.createdAt,
  };
  if (input.factCheckSources?.length) {
    result.factCheckSources = input.factCheckSources.map(toPublicEvidenceSource);
  }
  return result;
}
