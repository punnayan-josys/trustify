/**
 * source-tier-config.ts
 *
 * Deterministic, auditable credibility scoring.
 * - Exact domain matching
 * - Source-type aware scoring
 * - Override support
 * - Denylist protection
 */

export type SourceTier = "tier1" | "tier2" | "tier3" | "unknown";

export type SourceType =
  | "official"
  | "newswire"
  | "fact_check"
  | "major_media"
  | "regional_media"
  | "encyclopedia"
  | "sports_authority"
  | "aggregator";

/**
 * Base deterministic scores (no randomness)
 */
export const BASE_SCORE: Record<SourceTier, number> = {
  tier1: 90,
  tier2: 65,
  tier3: 40,
  unknown: 15,
};

/**
 * Source-type adjustments
 */
export const TYPE_BOOST: Record<SourceType, number> = {
  official: 8,
  newswire: 7,
  fact_check: 7,
  major_media: 5,
  regional_media: 2,
  encyclopedia: 3,
  sports_authority: 4,
  aggregator: -5,
};

/**
 * Full metadata (auditable)
 */
interface SourceEntry {
  domain: string;
  tier: SourceTier;
  type: SourceType;
}

/**
 * Tier 1 — Highest credibility
 */
export const TIER_ONE_SOURCES: readonly SourceEntry[] = [
  { domain: "reuters.com", tier: "tier1", type: "newswire" },
  { domain: "apnews.com", tier: "tier1", type: "newswire" },
  { domain: "bbc.com", tier: "tier1", type: "major_media" },
  { domain: "nytimes.com", tier: "tier1", type: "major_media" },
  { domain: "theguardian.com", tier: "tier1", type: "major_media" },
  { domain: "washingtonpost.com", tier: "tier1", type: "major_media" },

  { domain: "who.int", tier: "tier1", type: "official" },
  { domain: "cdc.gov", tier: "tier1", type: "official" },
  { domain: "nih.gov", tier: "tier1", type: "official" },
  { domain: "un.org", tier: "tier1", type: "official" },
  { domain: "nasa.gov", tier: "tier1", type: "official" },

  { domain: "snopes.com", tier: "tier1", type: "fact_check" },
  { domain: "factcheck.org", tier: "tier1", type: "fact_check" },
  { domain: "politifact.com", tier: "tier1", type: "fact_check" },
  { domain: "fullfact.org", tier: "tier1", type: "fact_check" },

  { domain: "espncricinfo.com", tier: "tier1", type: "sports_authority" },
  { domain: "icc-cricket.com", tier: "tier1", type: "sports_authority" },
];

/**
 * Tier 2 — Reputable but not primary verification
 */
export const TIER_TWO_SOURCES: readonly SourceEntry[] = [
  { domain: "cnn.com", tier: "tier2", type: "major_media" },
  { domain: "nbcnews.com", tier: "tier2", type: "major_media" },
  { domain: "wsj.com", tier: "tier2", type: "major_media" },
  { domain: "economist.com", tier: "tier2", type: "major_media" },

  { domain: "britannica.com", tier: "tier2", type: "encyclopedia" },
  { domain: "wikipedia.org", tier: "tier2", type: "encyclopedia" },

  { domain: "thehindu.com", tier: "tier2", type: "regional_media" },
  { domain: "ndtv.com", tier: "tier2", type: "regional_media" },
  { domain: "scroll.in", tier: "tier2", type: "regional_media" },
];

/**
 * Denylist — spoof / low credibility
 */
export const DENYLIST_DOMAINS = [
  "blogspot.com",
  "wordpress.com",
  "medium.com",
] as const;

/**
 * Domain matching (safe)
 */
function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Lookup entry
 */
function findSourceEntry(hostname: string): SourceEntry | null {
  for (const entry of TIER_ONE_SOURCES) {
    if (matchesDomain(hostname, entry.domain)) return entry;
  }

  for (const entry of TIER_TWO_SOURCES) {
    if (matchesDomain(hostname, entry.domain)) return entry;
  }

  return null;
}

/**
 * Classify tier
 */
export function classifySourceTier(sourceUrl: string): SourceTier {
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, "");

    if (DENYLIST_DOMAINS.some((d) => matchesDomain(hostname, d))) {
      return "tier3";
    }

    const entry = findSourceEntry(hostname);
    return entry?.tier ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Deterministic credibility score
 */
export function getCredibilityScore(sourceUrl: string): number {
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, "");

    if (DENYLIST_DOMAINS.some((d) => matchesDomain(hostname, d))) {
      return Math.max(0, Math.min(100, BASE_SCORE.tier3));
    }

    const entry = findSourceEntry(hostname);

    if (!entry) return BASE_SCORE.unknown;

    const base = BASE_SCORE[entry.tier];
    const boost = TYPE_BOOST[entry.type];

    return Math.max(0, Math.min(100, base + boost));
  } catch {
    return BASE_SCORE.unknown;
  }
}
