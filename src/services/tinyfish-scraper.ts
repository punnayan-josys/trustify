/**
 * tinyfish-scraper.ts
 *
 * TinyFish-inspired scraping wrapper using Axios + Cheerio.
 *
 * "TinyFish" is a lightweight scraping pattern:
 *   1. fetch HTML with Axios (small, fast, no browser overhead)
 *   2. parse with Cheerio (jQuery-like DOM API)
 *   3. extract structured fields
 *   4. return typed objects
 *
 * Why not a headless browser?
 *   - Free-tier servers have limited RAM
 *   - Most news sites serve full HTML without JavaScript rendering
 *   - Playwright/Puppeteer can be dropped in as a swap if needed
 *
 * Timeout: configurable via SCRAPING_REQUEST_TIMEOUT_MS (default 5 s)
 */

import axios, { AxiosResponse } from "axios";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { ScrapedNewsArticle, ScrapedFactCheckResult } from "../utils/shared-types";
import { logger } from "../utils/logger";

const REQUEST_TIMEOUT_MS = Number(
  process.env.SCRAPING_REQUEST_TIMEOUT_MS ?? 5_000
);

// ─── Generic Fetch ────────────────────────────────────────────────────────────

/**
 * Fetches a URL and returns parsed Cheerio root.
 * Returns null (non-throwing) on any network or parse error.
 */
async function fetchAndParseHtml(
  targetUrl: string
): Promise<cheerio.CheerioAPI | null> {
  try {
    const httpResponse: AxiosResponse<string> = await axios.get<string>(
      targetUrl,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          // Realistic user-agent avoids basic bot-detection blocks
          "User-Agent":
            "Mozilla/5.0 (compatible; Truthify-Verifier/1.0; +https://truthify.app)",
          Accept: "text/html,application/xhtml+xml",
        },
        // Only follow up to 3 redirects
        maxRedirects: 3,
        // Reject responses larger than 5 MB (avoid scraping huge pages)
        maxContentLength: 5 * 1024 * 1024,
      }
    );

    return cheerio.load(httpResponse.data);
  } catch (fetchError) {
    logger.warn("Failed to fetch URL for scraping", {
      targetUrl,
      errorMessage: (fetchError as Error).message,
    });
    return null;
  }
}

// ─── Text Extraction Helpers ──────────────────────────────────────────────────

/**
 * Extracts a plain-text summary from article body.
 * Concatenates the first 3 <p> tags to form a readable snippet.
 */
function extractArticleSummary(
  $: cheerio.CheerioAPI,
  maxCharacterLength: number = 400
): string {
  const paragraphs: string[] = [];
  $("article p, .article-body p, .post-content p, main p").each(
    (_index: number, element: AnyNode) => {
      const paragraphText = $(element).text().trim();
      if (paragraphText.length > 30) {
        paragraphs.push(paragraphText);
      }
    }
  );

  const combinedText = paragraphs.slice(0, 3).join(" ");
  return combinedText.length > maxCharacterLength
    ? combinedText.slice(0, maxCharacterLength) + "…"
    : combinedText;
}

/**
 * Extracts the page title, trying meta tags before falling back to <title>.
 */
function extractPageTitle($: cheerio.CheerioAPI): string {
  return (
    $('meta[property="og:title"]').attr("content") ??
    $('meta[name="twitter:title"]').attr("content") ??
    $("title").text() ??
    "Unknown Title"
  ).trim();
}

/**
 * Extracts the published date from common meta tags.
 */
function extractPublishedDate($: cheerio.CheerioAPI): string | null {
  return (
    $('meta[property="article:published_time"]').attr("content") ??
    $('meta[name="pubdate"]').attr("content") ??
    $('time[datetime]').first().attr("datetime") ??
    null
  );
}

// ─── News Article Scraper ─────────────────────────────────────────────────────

/**
 * Scrapes a single news article URL and returns structured data.
 * Returns null on failure so callers can skip bad URLs.
 */
export async function scrapeNewsArticle(
  articleUrl: string
): Promise<ScrapedNewsArticle | null> {
  const $ = await fetchAndParseHtml(articleUrl);
  if ($ === null) return null;

  const sourceDomain = extractDomainFromUrl(articleUrl);

  return {
    title: extractPageTitle($),
    url: articleUrl,
    summary: extractArticleSummary($),
    publishedAt: extractPublishedDate($),
    sourceDomain,
  };
}

// ─── Google News RSS Scraper ──────────────────────────────────────────────────
//
// Why RSS instead of HTML scraping?
//   Google News HTML is JavaScript-rendered — Axios gets a shell page with 0
//   articles.  The RSS feed is server-rendered XML that always works without
//   a headless browser.  Same data, far more reliable.
//
// RSS item fields used:
//   <title>       — article headline
//   <link>        — Google News redirect URL (used as canonical reference)
//   <description> — HTML snippet with summary text
//   <pubDate>     — ISO publication date
//   <source url>  — actual publisher domain

/**
 * Fetches top news articles for a query via Google News RSS.
 * Returns structured ScrapedNewsArticle objects directly from the feed —
 * no secondary HTTP requests to individual article pages needed.
 */
export async function fetchAndScrapeNewsFromRss(
  searchQuery: string,
  maxResults: number = 5
): Promise<ScrapedNewsArticle[]> {
  const encodedQuery = encodeURIComponent(searchQuery);
  const rssUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;

  const $ = await fetchAndParseHtml(rssUrl);
  if ($ === null) {
    logger.warn("fetchAndScrapeNewsFromRss: failed to fetch RSS feed", {
      searchQuery,
    });
    return [];
  }

  const articles: ScrapedNewsArticle[] = [];

  // Cheerio parses XML the same way as HTML — item elements work fine
  $("item").each((_index: number, element: AnyNode) => {
    if (articles.length >= maxResults) return false as unknown as void;

    const rawTitle = $(element).find("title").first().text().trim();
    const articleLink = $(element).find("link").first().text().trim()
      // <link> in RSS is sometimes a text node after the element, not a child
      || $(element).find("link").next().text().trim();
    const pubDate = $(element).find("pubDate").first().text().trim() || null;
    const sourceUrl = $(element).find("source").attr("url") ?? "";
    const sourceName = $(element).find("source").first().text().trim();

    // Strip the " - Source Name" suffix Google appends to every title
    const cleanTitle = sourceName
      ? rawTitle.replace(new RegExp(`\\s*-\\s*${sourceName}\\s*$`), "").trim()
      : rawTitle;

    // Extract plain-text summary from the HTML <description> block
    const descriptionHtml = $(element).find("description").text();
    const $desc = cheerio.load(descriptionHtml);
    const summaryText = $desc("body").text().trim().slice(0, 400);

    const resolvedSourceDomain = sourceUrl
      ? extractDomainFromUrl(sourceUrl)
      : extractDomainFromUrl(articleLink);

    // Google News RSS <link> sometimes contains only the encoded token
    // (CBMi…) without the https:// scheme.  Normalise to a fully-qualified
    // redirect URL so downstream code always receives a valid HTTP URL.
    const normalizedLink = articleLink.startsWith("http")
      ? articleLink
      : `https://news.google.com/rss/articles/${articleLink}`;

    if (cleanTitle && normalizedLink) {
      articles.push({
        title: cleanTitle,
        url: normalizedLink,
        summary: summaryText || `News article from ${resolvedSourceDomain}`,
        publishedAt: pubDate,
        sourceDomain: resolvedSourceDomain,
      });
    }
  });

  logger.info("fetchAndScrapeNewsFromRss: complete", {
    searchQuery,
    articlesFound: articles.length,
  });

  return articles;
}

// ─── Direct Publisher RSS Scrapers ─────────────────────────────────────────────
//
// These outlets publish public RSS feeds that return full XML — no JS
// rendering, no auth, no API key required.
//
// Feed selection rationale (March 2026):
//   Times of India : general Indian news top stories
//   India Today    : general Indian news top stories
//   BBC Sport      : sports-specific feed; articles stay in feed longer than
//                    BBC World top stories (better for sports verification)
//   Cricbuzz       : authoritative cricket-specific news feed
//   Reuters        : Tier-1 international newswire (topic-agnostic)
//
// Each feed is filtered by keyword relevance so only articles matching
// the headline topic are returned.

/**
 * Configuration for each direct RSS source.
 */
interface DirectRssFeedConfig {
  feedUrl: string;
  sourceDomain: string;
  displayName: string;
}

const DIRECT_RSS_FEED_CONFIGS: readonly DirectRssFeedConfig[] = [
  {
    feedUrl: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    sourceDomain: "timesofindia.com",
    displayName: "Times of India",
  },
  {
    feedUrl: "https://www.indiatoday.in/rss/1206584",
    sourceDomain: "indiatoday.in",
    displayName: "India Today",
  },
  {
    // BBC Sport feed — sports articles stay relevant longer than World top stories
    feedUrl: "https://feeds.bbci.co.uk/sport/rss.xml",
    sourceDomain: "bbc.co.uk",
    displayName: "BBC Sport",
  },
  {
    feedUrl: "https://www.cricbuzz.com/rss-feeds/cricbuzz-latest-sports-headlines.xml",
    sourceDomain: "cricbuzz.com",
    displayName: "Cricbuzz",
  },
  {
    feedUrl: "https://feeds.reuters.com/reuters/topNews",
    sourceDomain: "reuters.com",
    displayName: "Reuters",
  },
];

/**
 * Parses a single RSS item element into a ScrapedNewsArticle.
 * Returns null if mandatory fields (title, link) are missing.
 */
function parseRssItemToArticle(
  $: cheerio.CheerioAPI,
  element: AnyNode,
  fallbackDomain: string
): ScrapedNewsArticle | null {
  // <title> can be wrapped in CDATA — strip it manually because Cheerio
  // in HTML parse mode does not automatically unwrap CDATA sections.
  const rawTitle = $(element)
    .find("title")
    .first()
    .text()
    .trim()
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "");

  // RSS <link> is a text node sibling of the <link> tag in some feeds;
  // try both the element text and the next sibling text.
  const articleLink =
    $(element).find("link").first().text().trim() ||
    $(element).find("link").next().text().trim();

  if (!rawTitle || !articleLink) return null;

  const pubDate = $(element).find("pubDate").first().text().trim() || null;

  // <description> may contain HTML — strip tags for plain text
  const rawDescription =
    $(element).find("description").first().text().trim() ||
    $(element).find("media\\:description").first().text().trim();
  const $desc = cheerio.load(rawDescription);
  const plainSummary = $desc("body").text().trim().slice(0, 400);

  return {
    title: rawTitle,
    url: articleLink,
    summary: plainSummary || `Article from ${fallbackDomain}`,
    publishedAt: pubDate,
    sourceDomain: fallbackDomain,
  };
}

/**
 * Scores relevance of an article to the search query.
 * Returns true if title or summary contains at least one keyword.
 * Used to filter out unrelated articles from topic-agnostic RSS feeds.
 */
function isArticleRelevantToQuery(
  article: ScrapedNewsArticle,
  searchKeywords: string[]
): boolean {
  const combinedText = `${article.title} ${article.summary}`.toLowerCase();
  return searchKeywords.some((keyword) =>
    combinedText.includes(keyword.toLowerCase())
  );
}

/**
 * Scrapes a single publisher RSS feed and returns relevant articles.
 *
 * @param feedConfig     The RSS feed to scrape
 * @param searchKeywords Keywords to filter relevant articles
 * @param maxResults     Maximum articles to return from this feed
 */
async function scrapeDirectPublisherRss(
  feedConfig: DirectRssFeedConfig,
  searchKeywords: string[],
  maxResults: number
): Promise<ScrapedNewsArticle[]> {
  const $ = await fetchAndParseHtml(feedConfig.feedUrl);
  if ($ === null) {
    logger.warn("scrapeDirectPublisherRss: failed to fetch feed", {
      feedUrl: feedConfig.feedUrl,
      source: feedConfig.displayName,
    });
    return [];
  }

  const matchingArticles: ScrapedNewsArticle[] = [];

  $("item").each((_index: number, element: AnyNode) => {
    if (matchingArticles.length >= maxResults) return false as unknown as void;

    const article = parseRssItemToArticle($, element, feedConfig.sourceDomain);
    if (article === null) return;

    // Only include articles relevant to the search query
    if (isArticleRelevantToQuery(article, searchKeywords)) {
      matchingArticles.push(article);
    }
  });

  logger.debug("scrapeDirectPublisherRss: complete", {
    source: feedConfig.displayName,
    articlesMatched: matchingArticles.length,
  });

  return matchingArticles;
}

/**
 * Queries all three direct publisher RSS feeds in parallel.
 * Each feed runs concurrently — total latency = slowest single feed, not sum.
 *
 * @param searchKeywords  Keywords extracted from the headline
 * @param maxPerSource    Maximum articles to take from each individual source
 */
export async function fetchFromDirectPublisherFeeds(
  searchKeywords: string[],
  maxPerSource: number = 3
): Promise<ScrapedNewsArticle[]> {
  const feedPromises = DIRECT_RSS_FEED_CONFIGS.map((feedConfig) =>
    scrapeDirectPublisherRss(feedConfig, searchKeywords, maxPerSource)
  );

  const feedResults = await Promise.allSettled(feedPromises);

  const allArticles: ScrapedNewsArticle[] = [];

  feedResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      allArticles.push(...result.value);
    } else {
      logger.warn("fetchFromDirectPublisherFeeds: feed failed", {
        source: DIRECT_RSS_FEED_CONFIGS[index].displayName,
        errorMessage: String(result.reason),
      });
    }
  });

  logger.info("fetchFromDirectPublisherFeeds: all feeds complete", {
    sourcesQueried: DIRECT_RSS_FEED_CONFIGS.length,
    totalArticlesFound: allArticles.length,
  });

  return allArticles;
}



/**
 * List of fact-checking sites to query.
 * Each entry includes its search URL pattern.
 */
const FACT_CHECK_SITE_SEARCH_URLS: readonly { site: string; searchUrlTemplate: string }[] = [
  {
    site: "snopes.com",
    searchUrlTemplate: "https://www.snopes.com/?s={query}",
  },
  {
    site: "politifact.com",
    searchUrlTemplate: "https://www.politifact.com/search/?q={query}",
  },
  {
    site: "fullfact.org",
    searchUrlTemplate: "https://fullfact.org/search/?q={query}",
  },
];

/**
 * Scrapes a single fact-check search result page.
 * Returns up to `maxResults` ScrapedFactCheckResult objects.
 */
async function scrapeFactCheckSearchPage(
  factCheckSite: string,
  searchUrl: string,
  maxResults: number
): Promise<ScrapedFactCheckResult[]> {
  const $ = await fetchAndParseHtml(searchUrl);
  if ($ === null) return [];

  const factCheckResults: ScrapedFactCheckResult[] = [];

  // Common selectors across fact-check sites
  $("article, .search-result, .fact-check-item, li.result").each(
    (_index: number, element: AnyNode): boolean | void => {
      if (factCheckResults.length >= maxResults) return false; // break

      const titleAnchor = $(element).find("a[href]").first();
      const titleText = titleAnchor.text().trim();
      const relativeOrAbsoluteHref = titleAnchor.attr("href") ?? "";

      if (!titleText || !relativeOrAbsoluteHref) return; // skip empty

      const absoluteUrl = relativeOrAbsoluteHref.startsWith("http")
        ? relativeOrAbsoluteHref
        : `https://${factCheckSite}${relativeOrAbsoluteHref}`;

      // Skip search-result pages, tag indexes, personality/people profiles —
      // these contain no actual fact-check verdict and confuse the brain agent.
      const FACT_CHECK_NOISE_PATTERNS = [
        "/search",
        "/tag/",
        "/people/",
        "/personalities/",
        "/category/",
        "/topics/",
      ];
      const isNoisePage = FACT_CHECK_NOISE_PATTERNS.some((p) =>
        absoluteUrl.includes(p)
      );
      if (isNoisePage) return; // skip — not a verdict article

      const summaryText = $(element).find("p").first().text().trim();

      // Look for a rating badge (varies by site)
      const claimRating =
        $(element).find(".truth-o-meter, .rating, .verdict-badge").text().trim() || null;

      factCheckResults.push({
        title: titleText,
        url: absoluteUrl,
        summary: summaryText.slice(0, 400),
        claimRating,
        sourceDomain: factCheckSite,
      });
    }
  );

  return factCheckResults;
}

/**
 * Queries all configured fact-check sites and aggregates results.
 */
export async function fetchFactCheckResults(
  searchKeywords: string[],
  maxResultsPerSite: number = 2
): Promise<ScrapedFactCheckResult[]> {
  const searchQuery = searchKeywords.join(" ");
  const encodedQuery = encodeURIComponent(searchQuery);

  const allFactCheckResults: ScrapedFactCheckResult[] = [];

  for (const factCheckSiteConfig of FACT_CHECK_SITE_SEARCH_URLS) {
    const resolvedSearchUrl = factCheckSiteConfig.searchUrlTemplate.replace(
      "{query}",
      encodedQuery
    );

    const siteResults = await scrapeFactCheckSearchPage(
      factCheckSiteConfig.site,
      resolvedSearchUrl,
      maxResultsPerSite
    );

    allFactCheckResults.push(...siteResults);

    logger.debug("Scraped fact-check site", {
      site: factCheckSiteConfig.site,
      resultsFound: siteResults.length,
    });
  }

  logger.info("Fact-check scraping complete", {
    totalResults: allFactCheckResults.length,
    searchQuery,
  });

  return allFactCheckResults;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function extractDomainFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}
