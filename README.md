# Truthify — AI News Verifier

A production-quality news verification system that uses multi-agent AI orchestration, async workflows, and structured evidence scraping to produce accurate verdicts on news headlines.

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                        CLIENT / USER                           │
│              POST /api/v1/verify  { headline }                 │
└─────────────────────────┬──────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Node.js Express API                          │
│  src/api/server.ts  ←→  src/api/verify-route.ts               │
│                                                                 │
│  1. Validate request body (express-validator)                   │
│  2. Check Redis cache (CACHE HIT → return immediately)          │
│  3. Generate verification UUID                                  │
│  4. Start Temporal workflow, await result                       │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              Temporal Workflow (Orchestration)                  │
│           src/workflows/news-verification-workflow.ts           │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────────────────────────┐  │
│  │ scrapeNewsActivity│    │  scrapeFactCheckActivity         │  │
│  │ (parallel)        │    │  (parallel)                      │  │
│  │ 2 retries / 10s  │    │  2 retries / 10s                 │  │
│  └────────┬─────────┘    └─────────────┬────────────────────┘  │
│           │                            │                        │
│           └────────────┬───────────────┘                        │
│                        │                                        │
│                        ▼                                        │
│          ┌─────────────────────────────┐                        │
│          │  LangChain Pipeline Activity│                        │
│          │  2 retries / 60s            │                        │
│          └─────────────┬───────────────┘                        │
│                        │                                        │
│           ┌────────────┼─────────────┐                          │
│           ▼            ▼             │                          │
│  ┌──────────────┐ ┌──────────────┐   │                          │
│  │  Persist to  │ │  Cache in    │   │                          │
│  │  PostgreSQL  │ │  Redis       │   │                          │
│  │  3 retries   │ │  3 retries   │   │                          │
│  └──────────────┘ └──────────────┘   │                          │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│           LangChain Multi-Agent Pipeline                        │
│              src/agents/langchain-orchestrator.ts               │
│                                                                 │
│  [1] ClaimUnderstandingAgent (LLM)                              │
│      → extracts entities, claim type, search keywords          │
│                    │                                            │
│  [2] CredibilityScoringAgent (rule-based, no LLM)               │
│      → assigns tier-based scores to all sources                │
│                    │                                            │
│  [3] AggregationAgent (rule-based, no LLM)                      │
│      → deduplicates, classifies supporting/contradicting       │
│                    │                                            │
│  [4] VerdictBrainAgent (LLM — FINAL AUTHORITY)                  │
│      → TRUE / FALSE / MISLEADING / UNVERIFIED                  │
│      → confidence score 0-100                                   │
│      → reasoning string                                         │
└─────────────────────────┬───────────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │PostgreSQL│ │  Redis   │ │  Client  │
        │ results  │ │  cache   │ │ response │
        └──────────┘ └──────────┘ └──────────┘
```

## Folder Structure

```
Truthify/
├── docker-compose.yml        # PostgreSQL + Redis + Temporal infra
├── package.json
├── tsconfig.json
├── .env.example              # Copy to .env and fill in secrets
│
└── src/
    ├── api/
    │   ├── server.ts         # Express app entry point
    │   ├── verify-route.ts   # POST /api/v1/verify endpoint
    │   └── temporal-client.ts # Temporal client for API layer
    │
    ├── workflows/
    │   ├── news-verification-workflow.ts  # Temporal workflow definition
    │   └── worker.ts                      # Temporal worker process
    │
    ├── activities/
    │   └── scraping-activities.ts  # All Temporal activity implementations
    │
    ├── agents/
    │   ├── llm-client.ts                  # Shared ChatOpenAI singleton
    │   ├── claim-understanding-agent.ts   # Agent 1: parse headline
    │   ├── credibility-scoring-agent.ts   # Agent 4: score sources
    │   ├── aggregation-agent.ts           # Agent 5: merge evidence
    │   ├── verdict-brain-agent.ts         # Agent 6: final verdict (LLM)
    │   └── langchain-orchestrator.ts      # Pipeline coordinator
    │
    ├── services/
    │   ├── tinyfish-scraper.ts    # Axios + Cheerio scraping wrapper
    │   └── source-tier-config.ts  # Domain credibility tiers
    │
    ├── database/
    │   ├── database-client.ts          # pg Pool singleton
    │   ├── migrate.ts                  # Schema migration script
    │   └── verification-repository.ts  # SQL queries
    │
    ├── cache/
    │   ├── redis-client.ts         # ioredis singleton
    │   └── verification-cache.ts   # Cache read/write helpers
    │
    └── utils/
        ├── shared-types.ts  # All domain types (single source of truth)
        ├── logger.ts        # Winston structured logger
        ├── hash-utils.ts    # SHA-256 cache key generation
        └── app-errors.ts    # Typed error hierarchy
```

## Database Schema

```sql
CREATE TABLE news_verification_results (
  verification_id   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  headline_text     TEXT          NOT NULL,
  verdict           VARCHAR(20)   NOT NULL CHECK (verdict IN ('TRUE','FALSE','MISLEADING','UNVERIFIED')),
  confidence_score  SMALLINT      NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  reasoning         TEXT          NOT NULL,
  evidence_json     JSONB         NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  workflow_id       TEXT          NOT NULL
);

CREATE INDEX idx_nvr_workflow_id  ON news_verification_results (workflow_id);
CREATE INDEX idx_nvr_created_at   ON news_verification_results (created_at DESC);
CREATE INDEX idx_nvr_evidence_gin ON news_verification_results USING GIN (evidence_json);
```

## Agent Design

| Agent | Type | Purpose |
|-------|------|---------|
| ClaimUnderstandingAgent | LLM | Extract entities, claim type, search keywords |
| CredibilityScoringAgent | Rule-based | Assign tier-based scores (no LLM cost) |
| AggregationAgent | Rule-based | Deduplicate, classify supporting/contradicting |
| VerdictBrainAgent | LLM (final) | Produce verdict, confidence, reasoning |

**NewsEvidenceAgent** and **FactCheckAgent** are implemented as Temporal activities rather than LangChain agents — they are I/O bound (scraping), not reasoning bound, so using an LLM for them would be wasteful and slower.

## API Reference

### POST /api/v1/verify

Verifies a news headline.

**Request:**
```json
{
  "headline": "NASA confirms liquid water found on Mars surface"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "verificationId": "550e8400-e29b-41d4-a716-446655440000",
    "headlineText": "NASA confirms liquid water found on Mars surface",
    "verdict": "MISLEADING",
    "confidenceScore": 72,
    "reasoning": "While NASA has detected evidence of ancient water...",
    "supportingSources": [],
    "contradictingSources": [],
    "cachedResult": false,
    "createdAt": "2026-03-29T10:00:00.000Z"
  },
  "error": null
}
```

**Verdict values:** `TRUE` | `FALSE` | `MISLEADING` | `UNVERIFIED`

### GET /api/v1/verify/health

Returns health status of all connected services.

```json
{
  "status": "healthy",
  "timestamp": "2026-03-29T10:00:00.000Z",
  "services": { "database": "ok", "cache": "ok" }
}
```

## Step-by-Step Run Instructions

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- An OpenAI API key (get one free at platform.openai.com)

### Step 1: Clone and Install

```bash
cd /path/to/Truthify
npm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:
```
OPENAI_API_KEY=sk-your-key-here
POSTGRES_PASSWORD=local_dev_password_change_in_production
```

### Step 3: Start Infrastructure (Docker)

```bash
docker compose up -d
```

Wait for all services to be healthy (~30 seconds for Temporal):
```bash
docker compose ps
```

You should see all services as `healthy` or `running`.

### Step 4: Run Database Migration

```bash
npm run db:migrate
```

Expected output: `Database migration completed successfully`

### Step 5: Start the Temporal Worker

Open a new terminal:
```bash
npm run worker
```

Expected output: `Temporal worker: started successfully`

### Step 6: Start the API Server

Open another terminal:
```bash
npm run dev
```

Expected output: `Truthify API server started { port: 3000 }`

### Step 7: Verify a Headline

```bash
curl -X POST http://localhost:3000/api/v1/verify \
  -H "Content-Type: application/json" \
  -d '{"headline": "Scientists discover new species of dinosaur in Argentina"}'
```

### Step 8: Monitor Workflows

Open Temporal UI: http://localhost:8080

You can see all workflow executions, their status, and activity logs.

### Step 9: Check the Cache

The second request with the same headline returns instantly (Redis cache hit):
```bash
# First request: ~5-30 seconds (runs workflow)
curl -X POST http://localhost:3000/api/v1/verify \
  -d '{"headline": "Scientists discover new species of dinosaur in Argentina"}' \
  -H "Content-Type: application/json"

# Second request: <50ms (cache hit, cachedResult: true)
curl -X POST http://localhost:3000/api/v1/verify \
  -d '{"headline": "Scientists discover new species of dinosaur in Argentina"}' \
  -H "Content-Type: application/json"
```

## Migration Path to Paid Services

| Component | Free Tier | Paid Migration |
|-----------|-----------|----------------|
| LLM | gpt-3.5-turbo | Change `OPENAI_MODEL_NAME=gpt-4o` in .env |
| PostgreSQL | Local / Supabase free | Change `POSTGRES_*` env vars to Neon/RDS |
| Redis | Local / Upstash free | Set `REDIS_HOST`, `REDIS_TLS=true` in .env |
| Temporal | Self-hosted (Docker) | Set `TEMPORAL_ADDRESS` to Temporal Cloud endpoint |
| Scraping | Axios + Cheerio | Replace `tinyfish-scraper.ts` with Apify/Browserless |

**No application code changes required** for any of these migrations — only environment variable changes.

## Caching Strategy

```
Redis Key: news_verification:{sha256(normalised_headline)}
TTL:       86400 seconds (24 hours)

Normalisation before hashing:
  - lowercase
  - trim whitespace
  - collapse repeated spaces
```

This means `"NASA lands on MARS"` and `"nasa lands on mars"` produce the same cache key.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API server port |
| `OPENAI_API_KEY` | required | OpenAI API key |
| `OPENAI_MODEL_NAME` | `gpt-3.5-turbo` | Model to use |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `truthify` | Database name |
| `POSTGRES_USER` | `truthify_user` | Database user |
| `POSTGRES_PASSWORD` | required | Database password |
| `POSTGRES_SSL` | `false` | Enable SSL for managed DB |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis password (Upstash) |
| `REDIS_TLS` | `false` | Enable TLS for managed Redis |
| `REDIS_CACHE_TTL_SECONDS` | `86400` | Cache TTL (24 hours) |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address (`*.tmprl.cloud:7233` on Temporal Cloud) |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_API_KEY` | — | Temporal Cloud API key (enables TLS automatically) |
| `TEMPORAL_TLS` | — | Set `true` for self-hosted Temporal with TLS (no API key) |
| `TEMPORAL_TASK_QUEUE` | `news-verification-queue` | Worker task queue |
| `SCRAPING_REQUEST_TIMEOUT_MS` | `5000` | Per-request scraping timeout |
| `SCRAPING_MAX_NEWS_SOURCES` | `5` | Max news articles to scrape |
| `SCRAPING_MAX_FACT_CHECK_SOURCES` | `3` | Max fact-check results per site |
| `LOG_LEVEL` | `info` | Winston log level |

## Deploying on [Render](https://render.com)

Render runs your **API** and **worker**; it does **not** host a Temporal server. Use **Temporal Cloud** (or any reachable Temporal cluster) plus **PostgreSQL** and **Redis** (Render add-ons or external providers).

### Option A: Single Web Service (Recommended - Free tier friendly)

Run both the API and worker in **one** Render Web Service to save costs.

**Service settings:**
- **Type:** Web Service
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm run start:all`
- **Health Check Path:** `/health`

This uses `concurrently` to run both processes together:
- Express API (handles HTTP requests)
- Temporal worker (executes workflows)

### Option B: Two Separate Services (Better for scaling)

If you need independent scaling or high throughput:

| | **Web Service** | **Background Worker** |
|--|-----------------|----------------------|
| **Build** | `npm install && npm run build` | Same |
| **Start** | `npm start` | `npm run worker:prod` |
| **Health** | `/health` | *(none)* |

### 1. Create backing services

- **PostgreSQL** — Render Postgres *or* Neon/Supabase. Set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_SSL=true` for managed TLS.
- **Redis** — Render Key Value *or* Upstash. Set `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` if required, and `REDIS_TLS=true` when the provider requires TLS.
- **Temporal** — In Temporal Cloud, copy the **gRPC endpoint** (e.g. `your-namespace.acct.tmprl.cloud:7233`), **namespace**, and **API key**. Set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` (TLS is turned on automatically when the key is set).

### 2. Environment variables (same for both options)

After Postgres exists, run:

```bash
npm run db:migrate
```

Use Render **Shell** on the web service, or a **one-off job**, with the same `POSTGRES_*` env vars as production.

Set these on your Render Web Service (or both services if using Option B):

- `NODE_ENV=production`
- `PORT` — Render sets this automatically
- **Temporal Cloud:**
  - `TEMPORAL_ADDRESS=ap-northeast-1.aws.api.temporal.io:7233` (or your region)
  - `TEMPORAL_NAMESPACE=your-namespace.acct.tmprl.cloud`
  - `TEMPORAL_API_KEY=eyJ...` (from Temporal Cloud dashboard)
  - `TEMPORAL_TASK_QUEUE=news-verification-queue`
- **PostgreSQL:** (Render Postgres or external)
  - `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
  - `POSTGRES_SSL=true`
- **Redis:** (Render Redis or Upstash)
  - `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_TLS=true` (if required)
- **LLM:**
  - `LLM_PROVIDER=groq` (or `openai`)
  - `GROQ_API_KEY=gsk_...` (or `OPENAI_API_KEY`)

### 3. Run database migration once

- Scale the **worker** if workflows queue up; Temporal distributes tasks across worker replicas.
- Ensure the **task queue** name matches everywhere (`TEMPORAL_TASK_QUEUE`, default `news-verification-queue`).
- Workflow timeout in the API is **120s** (`temporal-client.ts`); very slow LLM/scrape runs may need tuning.

## Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set strong `POSTGRES_PASSWORD`
- [ ] Enable `POSTGRES_SSL=true` with managed DB
- [ ] Set `REDIS_PASSWORD` and `REDIS_TLS=true` with managed Redis
- [ ] Set `TEMPORAL_ADDRESS` to Temporal Cloud
- [ ] Restrict CORS origin in `server.ts`
- [ ] Add API authentication (JWT / API key middleware)
- [ ] Set up log aggregation (Datadog / CloudWatch)
- [ ] Configure Temporal Cloud namespace and API key
- [ ] Upgrade `OPENAI_MODEL_NAME=gpt-4o` for higher accuracy
