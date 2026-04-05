# Performance Optimization Summary

## Problem
Verification workflows were timing out or taking 60-120 seconds due to:
1. **Too many parallel HTTP requests** (~33 requests in 10 seconds)
2. **Timeout too short** for scraping activity (10s)
3. **Excessive retries** causing cascading delays
4. **Over-fetching** data that wasn't improving accuracy

## Solution

### Activity Timeout Adjustments
| Activity | Before | After | Reason |
|----------|--------|-------|--------|
| **Scraping** | 10s | 30s | Parallel HTTP (Google News, RSS feeds, Wikipedia, fact-checks) needs time |
| **LLM calls** | 60s | 45s | Groq completes in <5s typically, don't need 60s buffer |
| **Storage** | 10s | 10s | No change needed (PostgreSQL/Redis are fast) |

### Retry Policy Changes
| Activity | Before | After | Impact |
|----------|--------|-------|--------|
| **Scraping** | 3 attempts | 2 attempts | Fail faster; most succeed on first try |
| **LLM** | 3 attempts | 2 attempts | Groq is reliable; excessive retries add latency |
| **Storage** | 4 attempts | 4 attempts | Keep high for reliability |

### Source Fetching Limits
| Parameter | Before | After | Reduction |
|-----------|--------|-------|-----------|
| **Search queries per claim** | 4 | 3 | -25% |
| **News sources per query** | 5 | 3 | -40% |
| **Fact-check results per site** | 3 | 2 | -33% |
| **Direct publisher feeds** | 3/feed | 2/feed | -33% |
| **Wikipedia results** | 2 | 2 | No change |

### HTTP Timeout
| Setting | Before | After |
|---------|--------|-------|
| **Per-request timeout** | 5000ms | 8000ms |

**Rationale:** Slow sources (e.g., fact-checkers) need >5s. Better to wait 8s and get the data than timeout and retry.

## Expected Performance

### Before Optimization
```
┌─────────────────────┬──────────┐
│ Phase               │ Time     │
├─────────────────────┼──────────┤
│ Claim decomposition │ 3-5s     │
│ Scraping (timeout)  │ 30s+     │ ← Bottleneck
│ Credibility scoring │ 2-4s     │
│ Aggregation         │ 1s       │
│ Verdict LLM         │ 3-5s     │
│ Storage             │ 1s       │
├─────────────────────┼──────────┤
│ TOTAL               │ 60-120s  │
└─────────────────────┴──────────┘
```

### After Optimization
```
┌─────────────────────┬──────────┐
│ Phase               │ Time     │
├─────────────────────┼──────────┤
│ Claim decomposition │ 2-3s     │
│ Scraping (parallel) │ 8-12s    │ ← Optimized
│ Credibility scoring │ 1-2s     │
│ Aggregation         │ <1s      │
│ Verdict LLM         │ 2-4s     │
│ Storage             │ <1s      │
├─────────────────────┼──────────┤
│ TOTAL               │ 15-25s   │
└─────────────────────┴──────────┘
```

**Improvement:** 60-75% faster on average

## Quality Impact

### Sources Fetched (Per Verification)

**Before:**
- 4 search queries × 5 news = 20 Google News results
- 5 direct publisher feeds × 3 = 15 articles
- 2 Wikipedia results
- 3 fact-check sites × 3 = 9 results
- **Total: ~46 sources**

**After:**
- 3 search queries × 3 news = 9 Google News results
- 5 direct publisher feeds × 2 = 10 articles
- 2 Wikipedia results
- 3 fact-check sites × 2 = 6 results
- **Total: ~27 sources**

**Quality Analysis:**
- ✅ Still covers major wires (Reuters, BBC, AP)
- ✅ Still gets fact-checker input (Snopes, PolitiFact, FullFact)
- ✅ Still includes Wikipedia for factual claims
- ✅ 27 sources is more than enough for accurate verdicts
- ✅ Deduplication ensures no redundant sources

## Environment Variables

Update `.env` or Render environment:

```bash
# Scraping limits (reduced for speed)
SCRAPING_MAX_NEWS_SOURCES=3          # Default was 5
SCRAPING_MAX_FACT_CHECK_SOURCES=2    # Default was 3
SCRAPING_REQUEST_TIMEOUT_MS=8000     # Default was 5000
```

## Monitoring

Watch for these in logs:

### Good Performance
```
ClaimUnderstandingAgent: complete (2.1s)
scrapeNewsSourcesActivity: complete (9.3s)
  googleNewsCount: 9
  directPublisherCount: 10
  wikipediaCount: 2
  totalAfterDedup: 18
VerdictBrainAgent: verdict reached (3.2s)
Total workflow time: 16.8s ✅
```

### Still Slow (investigate)
```
scrapeNewsSourcesActivity: complete (25s)
  ⚠️ If consistently >20s, check network latency
```

### Failing
```
scrapeNewsSourcesActivity: failed after 2 attempts
  ❌ Check Temporal logs for HTTP errors
```

## Rollback Plan

If accuracy drops, increase limits in `.env`:

```bash
SCRAPING_MAX_NEWS_SOURCES=5
SCRAPING_MAX_FACT_CHECK_SOURCES=3
```

Or revert to commit before optimization.

## Future Optimizations

1. **Cache search query decomposition** (same claim = same queries)
2. **Pre-fetch popular sources** (prime the cache for trending claims)
3. **Parallel LLM calls** (run credibility scoring + verdict in parallel if possible)
4. **CDN for Wikipedia** (Wikipedia API can be slow in some regions)

---

**Status:** ✅ Deployed  
**Date:** 2026-04-05  
**Estimated improvement:** 60-75% faster, similar accuracy
