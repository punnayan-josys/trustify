# Intelligent Claim Decomposition System

## Overview
The claim decomposition system automatically detects the **type of claim** (sports, politics, science, tech, etc.) and generates **targeted search queries** optimized for that specific domain.

## Why This Matters
Different types of facts require different search strategies:
- **Sports results** need official scores, tournament records, and championship data
- **Political claims** need government sources, election results, and official confirmations
- **Scientific claims** need peer-reviewed research, studies, and expert consensus
- **Tech news** needs official announcements, product specs, and tech publication reviews
- **Historical facts** need encyclopedic sources, archives, and historical records

## Claim Types Detected

### 1. SPORTS
**Examples:**
- "Did India win the 2026 T20 World Cup?"
- "Messi scored 5 goals in one match"
- "Lakers won NBA championship 2024"

**Search Strategy:**
- Q1: `[Team/Player] [Tournament] [Year] winner result`
- Q2: `[Tournament] [Year] final score official`
- Q3: `[League/Authority] official [Tournament] champion`
- Q4: `[Team] lost [Tournament]` OR `who beat [Team]`

### 2. POLITICS
**Examples:**
- "Trump is current president of America"
- "Biden won 2020 election"
- "New law passed in Congress"

**Search Strategy:**
- Q1: `Who is current [Position] [Country] [Year]`
- Q2: `[Person] [Position] official government confirmed`
- Q3: `[Position] latest election result [Year]`
- Q4: `[Person] not [Position] who is current`

### 3. SCIENCE
**Examples:**
- "Is Krebs cycle only aerobic?"
- "Vaccines cause autism"
- "Climate change is real"

**Search Strategy:**
- Q1: `[Claim] peer reviewed research`
- Q2: `[Topic] scientific consensus latest study`
- Q3: `[Claim] medical journal published`
- Q4: `[Claim] debunked false evidence`

### 4. TECH
**Examples:**
- "iPhone 16 released"
- "ChatGPT-5 launching next month"
- "Tesla Cybertruck production started"

**Search Strategy:**
- Q1: `[Product/Company] [Claim] official announcement`
- Q2: `[Product] release date confirmed [Year]`
- Q3: `[Tech site] [Product] review specs`
- Q4: `[Product] cancelled delayed postponed`

### 5. MUSIC/ENTERTAINMENT
**Examples:**
- "Taylor Swift won Grammy 2024"
- "Movie broke box office record"
- "Album reached #1 on Billboard"

**Search Strategy:**
- Q1: `[Artist] [Album/Award] [Year] winner`
- Q2: `[Award ceremony] [Year] official results`
- Q3: `[Chart] top position [Song] [Year]`
- Q4: `[Artist] did not win [Award]`

### 6. HISTORICAL
**Examples:**
- "World War II ended in 1945"
- "Columbus discovered America in 1492"
- "Moon landing was in 1969"

**Search Strategy:**
- Q1: `[Event] [Date/Year] what happened`
- Q2: `[Historical figure] [Event] historical records`
- Q3: `[Event] confirmed sources encyclopedia`
- Q4: `[Event] myth false historical accuracy`

### 7. CURRENT_EVENT
**Examples:**
- "Earthquake in Turkey today"
- "New variant spreading in Europe"
- "Protests happening in capital"

**Search Strategy:**
- Q1: `[Event] latest news [Location] [Date]`
- Q2: `[Event] official report statement`
- Q3: `[News agency] [Event] confirmed`
- Q4: `[Event] false hoax fact check`

### 8. FACT_CHECK (General factual claims)
**Examples:**
- "Pakistan is a country"
- "Water boils at 100°C"
- "Humans have 206 bones"

**Search Strategy:**
- Q1: `Is [Claim] true verified`
- Q2: `[Subject] facts encyclopedia reliable`
- Q3: `[Claim] scientific explanation`
- Q4: `[Claim] false myth debunked`

### 9. CONTRADICTION (Disputed/Debated claims)
**Examples:**
- "Coffee is good vs bad for health"
- "Remote work increases productivity"
- "Nuclear energy is safe"

**Search Strategy:**
- Q1: `[Topic] expert consensus`
- Q2: `[Side A] vs [Side B] evidence`
- Q3: `[Topic] fact check both sides`
- Q4: `[Topic] resolved final answer`

### 10. FUTURE (Predictions/Scheduled events)
**Examples:**
- "World Cup 2026 in USA"
- "Next iPhone will have USB-C"
- "Company going bankrupt next year"

**Search Strategy:**
- Q1: `[Event] scheduled official date`
- Q2: `[Entity] confirmed announcement [Event]`
- Q3: `[Event] rumors speculation fact check`
- Q4: `[Event] cancelled postponed not happening`

## Key Features

### 1. Type Detection
The LLM first analyzes the claim to determine which category it belongs to, then applies the appropriate search strategy.

### 2. Mandatory Refutation Query
Every search includes at least one query designed to find **contradicting evidence** (Q4), ensuring balanced coverage.

### 3. Authority Keywords
Queries include domain-specific authority markers:
- Sports: `official`, `final score`, `championship`
- Politics: `government`, `official`, `sworn in`
- Science: `peer reviewed`, `study`, `research`
- Tech: `official announcement`, `confirmed`, `specs`

### 4. Time Handling
- **"Current" claims**: Include `latest` or current year (2026)
- **Historical claims**: Preserve exact dates/years
- **Future claims**: Include `scheduled`, `confirmed`, `announced`

### 5. Entity Disambiguation
When entities might be ambiguous (e.g., "Paris" = city or person), queries include context:
- `Paris France` (not Paris Hilton)
- `Trump president USA` (not other Trumps)
- `India cricket team` (not India country alone)

## Example Outputs

### Example 1: Sports Claim
**Input:** "Did India win the 2026 T20 World Cup?"

**Generated Queries:**
1. `India 2026 T20 World Cup winner result`
2. `2026 T20 World Cup final score official`
3. `ICC 2026 T20 World Cup champion official`
4. `who beat India 2026 T20 World Cup final`

### Example 2: Political Claim
**Input:** "Trump is current president"

**Generated Queries:**
1. `Who is current president United States 2026`
2. `Trump president official government confirmed`
3. `United States president latest election result 2026`
4. `Trump not president who is current`

### Example 3: Scientific Claim
**Input:** "Is Krebs cycle only aerobic?"

**Generated Queries:**
1. `Krebs cycle aerobic anaerobic conditions research`
2. `Krebs cycle scientific consensus peer reviewed`
3. `cellular respiration Krebs cycle conditions study`
4. `Krebs cycle anaerobic false debunked`

### Example 4: Tech Claim
**Input:** "iPhone 16 has USB-C"

**Generated Queries:**
1. `iPhone 16 USB-C official Apple announcement`
2. `iPhone 16 release date specs confirmed 2024`
3. `TechCrunch iPhone 16 review USB-C specs`
4. `iPhone 16 Lightning port not USB-C`

## Benefits

1. **Higher Quality Results**: Domain-specific queries return more relevant sources
2. **Balanced Evidence**: Refutation queries ensure we find contradicting evidence
3. **Better Authority Sources**: Keyword choices target authoritative sources for each domain
4. **Reduced False Positives**: More precise queries reduce irrelevant results
5. **Faster Processing**: Better queries = better initial results = less filtering needed

## Technical Implementation

**File:** `src/activities/scraping-activities.ts`
**Function:** `decomposeClaimActivity()`

The function uses the LLM with a comprehensive prompt that:
1. Detects claim type from 10 predefined categories
2. Applies domain-specific search patterns
3. Ensures 1 refutation query is always included
4. Handles time/date context appropriately
5. Returns exactly 4 queries as a JSON array

**Fallback:** If LLM fails or returns malformed data, the system falls back to using the original headline as the search query.
