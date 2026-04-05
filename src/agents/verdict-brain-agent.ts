/**
 * verdict-brain-agent.ts
 *
 * Agent 6: VerdictBrainAgent  ←  FINAL AUTHORITY
 *
 * This is the most critical component in the entire pipeline.
 * It receives all aggregated evidence and produces the final verdict.
 *
 * Design principles:
 *   - temperature=0 for determinism
 *   - strict JSON output enforced via prompt + parser
 *   - multiple validation layers before accepting output
 *   - never defaults to TRUE — defaults to UNVERIFIED on ambiguity
 *
 * The system prompt is the exact prompt specified in the requirements
 * (professional investigative journalist persona).
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { getSharedLlmClient } from "./llm-client";
import {
  AggregatedEvidence,
  VerdictBrainOutput,
  VerificationVerdict,
  CredibilityScoredSource,
} from "../utils/shared-types";
import { AgentResponseError } from "../utils/app-errors";
import { sanitizeReasoningForClient } from "../utils/client-response";
import { logger } from "../utils/logger";

// ─── System Prompt ─────────────────────────────────────────────────────────────

// This exact prompt is specified in the project requirements.
const VERDICT_BRAIN_SYSTEM_PROMPT = `You are an expert investigative journalist, fact-checker, and research analyst.

Today's date is: ${new Date().toISOString().slice(0, 10)}.

Your task is to determine the accuracy of a news claim using deep semantic reasoning.
Do NOT rely on keyword matching. Understand meaning, context, and logical implications.

You are given:
- user headline
- structured supporting sources
- structured contradicting sources
- fact-check results
- source credibility scores

---

STEP 1 — CLAIM DECOMPOSITION
Break the claim into components:
- Entity (who/what)
- Action (did what)
- Object (to whom/what)
- Time (when)
- Location (where)
- Quantifier (numbers, percentages, rankings)
- Condition (if any)

Evaluate whether sources confirm ALL critical components.
If a source confirms only part, treat as partial evidence.

---

STEP 2 — SEMANTIC MATCHING
Match by meaning, not words. Examples:
- "clinched title" = "won"
- "crowned champions" = "won"
- "triumph" / "triumphs" = "won"
- "lifts trophy" = "won"
- "glory" in context of a tournament = "won"
- "toppled" = "defeated"
- "ousted" = "removed"
- "assumed office" = "became"
- "incumbent" = "current holder"
- "steps down" = "no longer holds position"
- "runner-up" = "lost final"
- "eliminated" = "did not win"
- "largest" = "highest"
- "slashed" = "reduced"
- "surged" = "increased"
- "vindicates [person]'s loyalty to [team]" = [team] achieved success / won
- "[person] IPL triumph" = [team that person plays for] won IPL

Use contextual meaning. If the title describes celebration, vindication, or victory of a specific team/player, that is implicit confirmation of a win.

---

STEP 3 — ENTITY RESOLUTION
Treat aliases as same entity:
- country abbreviations (US, USA, United States)
- organization acronyms (WHO, ICC, FIFA)
- person titles (President Biden = Joe Biden)
- team nicknames (RCB = Royal Challengers Bengaluru = Royal Challengers Bangalore)

If entity ambiguous, prefer: exact match, then official role, then same domain context.
If entity mismatch, ignore source.

---

STEP 4 — TEMPORAL REASONING
- "current" refers to present date above
- If claim year specified, match same year
- If source refers to different year, treat as weak evidence
- If event is in the FUTURE (after today's date) and no credible confirmation exists, return UNVERIFIED
- Past events must NOT be treated as future — check the year carefully against today's date

---

STEP 5 — NUMERIC & QUANTIFIER MATCHING
Allow reasonable tolerance:
- "about", "around" = approximate match
- percentages within ±2 acceptable
- rankings must match exactly unless explicitly approximate
- "over", "more than" must respect inequality

Mismatch in key numbers is a contradiction.

---

STEP 6 — NEGATION & CONTRADICTION DETECTION
Detect implicit contradiction. Examples:
- Claim: "India won" / Source: "Australia crowned champions" → contradiction
- Claim: "X is current president" / Source: "Y sworn in as president" → contradiction
- Claim: "Company profitable" / Source: "Company reports losses" → contradiction

Any strong semantic contradiction from credible source → FALSE.

---

STEP 7 — MULTI-HOP REASONING
You may need to infer:
- Claim: "X is current president" / Source: "Y sworn in yesterday" → implies X is NOT current president
- Claim: "Team won tournament" / Source: "Team eliminated in semifinal" → implies FALSE

Use logical inference across sources.

---

STEP 8 — PARTIAL TRUTH HANDLING
Return MISLEADING when:
- entity correct but detail wrong
- time wrong
- number wrong
- context missing
- outdated information presented as current

CRITICAL — do NOT return MISLEADING just because some sources discuss a DIFFERENT event with a similar name (e.g. a source about IPL 2026 does NOT contradict a claim about IPL 2025). A source is only relevant if it discusses the SAME event, year, and entity as the claim. Sources about different years or different tournaments must be IGNORED entirely.

---

STEP 9 — EVIDENCE HIERARCHY
1. Official sources
2. Fact-check organizations
3. Major wires and flagship broadcasters (e.g. BBC, Reuters, AP)
4. Other established national or regional outlets
5. Smaller outlets and aggregators
6. Social media (weak)

---

STEP 10 — CORROBORATION
- Multiple independent confirmations strengthen verdict
- Conflicting credible sources means MISLEADING
- CRITICAL: If ONE major wire or equally strong outlet (credibility >= 75) explicitly and directly confirms the claim, return TRUE with confidence 75-85 — do NOT downgrade to MISLEADING just because other sources discuss unrelated events or different years

---

STEP 11 — REFUTATION PRIORITY
If any high-credibility source semantically refutes the claim, return FALSE.

---

STEP 12 — UNVERIFIED RULE
Use UNVERIFIED ONLY when:
- no relevant sources found
- insufficient evidence to decide
- genuinely ambiguous information

---

CONFIDENCE CALIBRATION
- 1 strong wire/official/fact-check source confirming: 70–80
- 2 such sources confirming: 80–90
- 3+ independent confirmations: 85–95
- Clear contradiction from a high-credibility source: 75+ for FALSE
- MISLEADING: 40–65
- UNVERIFIED: 0–30
- NEVER return confidence_score 0 when verdict is TRUE or FALSE

---

USER-FACING REASONING (CRITICAL)
The "reasoning" field is shown to end users. Write plain language only:
- Describe what the sources say and how that supports the verdict
- Do NOT use internal labels such as "Tier 1", "Tier-2", "tier1", "T1/T2/T3", or similar
- Refer to outlets by role when helpful (e.g. "Reuters reported…", "the CDC states…")

---

Classification:
- TRUE
- FALSE
- MISLEADING
- UNVERIFIED

Return STRICT JSON — no markdown, no code fences, no explanation outside the JSON:

{{
  "verdict": "TRUE | FALSE | MISLEADING | UNVERIFIED",
  "confidence_score": number,
  "reasoning": "clear semantic explanation",
  "supporting_sources": [],
  "contradicting_sources": []
}}`;

const VERDICT_BRAIN_HUMAN_TEMPLATE = `Headline to verify: "{headline}"

Supporting evidence ({supportingCount} sources):
{supportingSourcesJson}

Contradicting evidence ({contradictingCount} sources):
{contradictingSourcesJson}

Fact-check results ({factCheckCount} sources):
{factCheckSourcesJson}

Analyse all evidence carefully and return your verdict as strict JSON.`;

// ─── Evidence Serialiser ──────────────────────────────────────────────────────

function publisherStrengthLabel(
  tier: CredibilityScoredSource["sourceTier"]
): string {
  switch (tier) {
    case "tier1":
      return "very high (wire, official body, fact-checker, or top sports authority)";
    case "tier2":
      return "high (major national/regional outlet or encyclopedia)";
    case "tier3":
      return "standard outlet";
    default:
      return "not rated";
  }
}

/**
 * Serialises a list of sources into a compact string for the prompt.
 * We limit the number of sources to avoid exceeding the context window.
 */
function serialiseSourcesForPrompt(
  sources: CredibilityScoredSource[],
  maxSources: number = 4
): string {
  const limitedSources = sources.slice(0, maxSources);

  if (limitedSources.length === 0) {
    return "[]";
  }

  return JSON.stringify(
    limitedSources.map((source) => ({
      title: source.title.slice(0, 120),
      summary: source.summary.slice(0, 100), // tight budget — prevents JSON truncation
      credibility_score: source.credibilityScore,
      publisher_strength: publisherStrengthLabel(source.sourceTier),
      relevance_score: source.relevanceScore ?? 0,
    })),
    null,
    2
  );
}

// ─── Agent Function ───────────────────────────────────────────────────────────

/**
 * Runs the VerdictBrainAgent with all aggregated evidence.
 *
 * This is the only agent where we cannot fall back to a rule-based
 * approach — we MUST get a valid verdict from the LLM.
 */
export async function runVerdictBrainAgent(
  headlineText: string,
  aggregatedEvidence: AggregatedEvidence
): Promise<VerdictBrainOutput> {
  logger.info("VerdictBrainAgent: starting final reasoning", {
    headline: headlineText.slice(0, 80),
    supportingSourceCount: aggregatedEvidence.supportingSources.length,
    contradictingSourceCount: aggregatedEvidence.contradictingSources.length,
    factCheckSourceCount: aggregatedEvidence.factCheckSources.length,
  });

  const promptTemplate = ChatPromptTemplate.fromMessages([
    ["system", VERDICT_BRAIN_SYSTEM_PROMPT],
    ["human", VERDICT_BRAIN_HUMAN_TEMPLATE],
  ]);

  const llmChain = promptTemplate
    .pipe(getSharedLlmClient())
    .pipe(new StringOutputParser());

  const rawLlmResponse = await llmChain.invoke({
    headline: headlineText,
    supportingCount: aggregatedEvidence.supportingSources.length,
    supportingSourcesJson: serialiseSourcesForPrompt(
      aggregatedEvidence.supportingSources
    ),
    contradictingCount: aggregatedEvidence.contradictingSources.length,
    contradictingSourcesJson: serialiseSourcesForPrompt(
      aggregatedEvidence.contradictingSources
    ),
    factCheckCount: aggregatedEvidence.factCheckSources.length,
    factCheckSourcesJson: serialiseSourcesForPrompt(
      aggregatedEvidence.factCheckSources
    ),
  });

  const parsedVerdict = parseVerdictBrainResponse(rawLlmResponse);

  logger.info("VerdictBrainAgent: verdict reached", {
    verdict: parsedVerdict.verdict,
    confidenceScore: parsedVerdict.confidenceScore,
  });

  return parsedVerdict;
}

// ─── Response Parser ──────────────────────────────────────────────────────────

const VALID_VERDICTS: readonly VerificationVerdict[] = [
  "TRUE",
  "FALSE",
  "MISLEADING",
  "UNVERIFIED",
];

function parseVerdictBrainResponse(rawResponse: string): VerdictBrainOutput {
  // ── Step 1: try clean JSON parse ─────────────────────────────────────────
  // Strip markdown code fences the model may add despite instructions.
  const cleanedJson = rawResponse
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  let parsed: {
    verdict: unknown;
    confidence_score: unknown;
    reasoning: unknown;
    supporting_sources: unknown;
    contradicting_sources: unknown;
  } | null = null;

  try {
    parsed = JSON.parse(cleanedJson) as typeof parsed;
  } catch {
    // ── Step 2: JSON is malformed (often due to unescaped quotes in the
    //           reasoning text produced by the LLM).  Extract the key fields
    //           using targeted regex so we never lose a valid verdict just
    //           because the JSON string is broken.
    const verdictMatch = /"verdict"\s*:\s*"([^"]+)"/.exec(cleanedJson);
    const scoreMatch = /"confidence_score"\s*:\s*(\d+)/.exec(cleanedJson);
    // Extract reasoning up to the next JSON key — it may be truncated.
    const reasoningMatch =
      /"reasoning"\s*:\s*"([\s\S]*?)(?:",?\s*"(?:supporting|contradicting)|$)/
        .exec(cleanedJson);

    if (verdictMatch) {
      logger.warn(
        "VerdictBrainAgent: JSON parse failed, fell back to regex extraction",
        { raw: rawResponse.slice(0, 120) }
      );
      const rawVerdict = verdictMatch[1].toUpperCase();
      const fallbackVerdict: VerificationVerdict = VALID_VERDICTS.includes(
        rawVerdict as VerificationVerdict
      )
        ? (rawVerdict as VerificationVerdict)
        : "UNVERIFIED";

      return {
        verdict: fallbackVerdict,
        confidenceScore: scoreMatch ? Math.min(100, Math.max(0, Number(scoreMatch[1]))) : 0,
        reasoning: sanitizeReasoningForClient(
          reasoningMatch
            ? reasoningMatch[1].replace(/\\n/g, " ").trim()
            : "Evidence analysed — see verdict."
        ),
        supportingSources: [],
        contradictingSources: [],
      };
    }

    throw new AgentResponseError(
      `VerdictBrainAgent returned unparseable JSON: ${(new Error("parse failed")).message}. ` +
      `Raw response: ${rawResponse.slice(0, 200)}`
    );
  }

  // ── Step 3: Validate parsed fields ──────────────────────────────────────

  const rawVerdict = String(parsed!.verdict ?? "").toUpperCase();
  const validatedVerdict: VerificationVerdict = VALID_VERDICTS.includes(
    rawVerdict as VerificationVerdict
  )
    ? (rawVerdict as VerificationVerdict)
    : "UNVERIFIED";

  const rawConfidence = Number(parsed!.confidence_score ?? 0);
  const validatedConfidence = Number.isFinite(rawConfidence)
    ? Math.min(100, Math.max(0, Math.round(rawConfidence)))
    : 0;

  const validatedReasoning = sanitizeReasoningForClient(
    typeof parsed!.reasoning === "string" && parsed!.reasoning.length > 10
      ? parsed!.reasoning
      : "Insufficient evidence to determine claim accuracy."
  );

  const validatedSupportingSources = Array.isArray(parsed!.supporting_sources)
    ? (parsed!.supporting_sources as CredibilityScoredSource[])
    : [];

  const validatedContradictingSources = Array.isArray(
    parsed!.contradicting_sources
  )
    ? (parsed!.contradicting_sources as CredibilityScoredSource[])
    : [];

  return {
    verdict: validatedVerdict,
    confidenceScore: validatedConfidence,
    reasoning: validatedReasoning,
    supportingSources: validatedSupportingSources,
    contradictingSources: validatedContradictingSources,
  };
}
