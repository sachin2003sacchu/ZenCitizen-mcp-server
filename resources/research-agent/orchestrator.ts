import type {
  YouTubeResults,
  TwitterResults,
  YouTubeVideo,
  YouTubeComment,
  TwitterTweet,
} from "../api-results/types.js";
import type {
  ResearchResource,
  Opinion,
  KeyPoint,
  ResearchQueryResult,
  CredibilityMetrics,
} from "./types.js";
import { classifySentiment, classifyComment, calculateHelpfulnessScore, extractKeyPoints } from "./classifier.js";
import { findGovernmentService } from "./services-db.js";
import { enrichGovernmentService } from "./services-fetcher.js";
import { inferGovernmentLinks, extractGovernmentLinksForQuery } from "./llm.js";
import type { ScrapedPageInfo } from "./dynamic-scraper.js";

/**
 * Research Agent Orchestrator
 * Processes YouTube and Twitter data, classifies sentiment, and extracts insights
 */

/**
 * Process YouTube data into research resources
 */
export function processYouTubeResults(results: YouTubeResults): ResearchResource[] {
  const resources: ResearchResource[] = [];

  for (const video of results.videos) {
    const opinions: Opinion[] = [];
    const allKeyPoints: { text: string; sources: Set<string> }[] = [];

    // Process comments for this specific video into opinions
    const commentsForVideo = results.commentsByVideo?.[video.id] || [];
    for (const comment of commentsForVideo) {
      const classified = classifyComment(comment.textDisplay);
      // Keep legacy sentiment neutral since we focus on opinion/information labels
      const helpfulness = calculateHelpfulnessScore(
        comment.textDisplay,
        comment.likeCount,
        "neutral"
      );

      const opinion: Opinion = {
        text: comment.textDisplay,
        label: classified.label,
        confidence: classified.confidence,
        likes: comment.likeCount,
        relevanceScore: helpfulness,
        source: "youtube_comment",
        timestamp: comment.publishedAt,
      };

      opinions.push(opinion);

      // Extract key points
      const keyPoints = extractKeyPoints(comment.textDisplay);
      for (const kp of keyPoints) {
        const existing = allKeyPoints.find(p => p.text === kp);
        const authorName = comment.authorDisplayName || "Unknown";
        if (existing) {
          existing.sources.add(authorName);
        } else {
          allKeyPoints.push({ text: kp, sources: new Set([authorName]) });
        }
      }
    }

    // Convert key points to typed structure
    const keyPoints: KeyPoint[] = allKeyPoints
      .filter(kp => kp.sources.size > 0)
      .map(kp => ({
        text: kp.text,
        frequency: kp.sources.size,
        sentiment: classifySentiment(kp.text).sentiment,
        sources: Array.from(kp.sources) as string[],
        evidenceCount: kp.sources.size,
      }))
      .sort((a, b) => b.frequency - a.frequency);

    // Calculate credibility metrics
    const videoCommentsCount = results.commentsByVideo?.[video.id]?.length || 0;
    const credibility = calculateCredibility({
      type: "video",
      likes: 0,
      views: 0,
      comments: videoCommentsCount,
      timestamp: video.publishedAt,
      source: "official" // YouTube videos from official channels are more credible
    });

    const resource: ResearchResource = {
      id: video.id,
      title: video.title,
      url: video.url,
      type: "video",
      credibility,
      opinions: opinions.slice(0, 10), // Top 10 opinions
      keyPoints: keyPoints.slice(0, 5), // Top 5 key points
      metadata: {
        channelName: video.channelTitle,
        author: video.channelTitle,
        publishDate: video.publishedAt,
        comments: videoCommentsCount || 0,
      },
    };

    resources.push(resource);
  }

  return resources;
}

/**
 * Process Twitter data into research resources
 */
export function processTwitterResults(results: TwitterResults): ResearchResource[] {
  const resources: ResearchResource[] = [];
  const allKeyPoints: { text: string; sources: Set<string> }[] = [];

  for (const tweet of results.tweets) {
    const classified = classifyComment(tweet.text);
    const helpfulness = calculateHelpfulnessScore(
      tweet.text,
      tweet.likeCount,
      "neutral"
    );

    const opinion: Opinion = {
      text: tweet.text,
      label: classified.label,
      confidence: classified.confidence,
      likes: tweet.likeCount,
      relevanceScore: helpfulness,
      source: "tweet",
      timestamp: tweet.createdAt,
    };

    // Extract key points
    const keyPoints = extractKeyPoints(tweet.text);
    for (const kp of keyPoints) {
      const existing = allKeyPoints.find(p => p.text === kp);
      const authorName = tweet.authorName || tweet.author || "Unknown";
      if (existing) {
        existing.sources.add(authorName);
      } else {
        allKeyPoints.push({ text: kp, sources: new Set([authorName]) });
      }
    }

    // Create resource — include all tweets (will be ranked by credibility later)
    if (helpfulness > 20) {
      const credibility = calculateCredibility({
        type: "tweet",
        likes: tweet.likeCount,
        views: tweet.retweetCount,
        comments: tweet.replyCount || 0,
        timestamp: tweet.createdAt,
        source: tweet.authorVerified ? "verified" : "community",
      });

      const resource: ResearchResource = {
        id: tweet.id,
        title: tweet.text.substring(0, 100),
        url: `https://twitter.com/${tweet.authorHandle}/status/${tweet.id}`,
        type: "tweet",
        credibility,
        opinions: [opinion],
        keyPoints: keyPoints
          .map(text => ({
            text,
            frequency: 1,
            sentiment: classifySentiment(text).sentiment,
            sources: [tweet.authorName || tweet.author],
            evidenceCount: 1,
          })),
        metadata: {
          author: tweet.authorName || tweet.author,
          publishDate: tweet.createdAt,
          likes: tweet.likeCount,
          comments: tweet.replyCount || 0,
        },
      };

      resources.push(resource);
    }
  }

  return resources;
}

/**
 * Calculate credibility metrics for a resource
 */
interface CredibilityInput {
  type: "video" | "tweet" | "official";
  likes: number;
  views: number;
  comments: number;
  timestamp: string;
  source: "official" | "verified" | "community" | "unknown";
}

function calculateCredibility(input: CredibilityInput): CredibilityMetrics {
  let score = 50; // Base score

  // Source authority (most important)
  if (input.source === "official") score += 40;
  else if (input.source === "verified") score += 25;
  else if (input.source === "community") score += 10;

  // Engagement metrics
  const engagement = input.likes + input.views + input.comments;
  const engagementBonus = Math.min(20, Math.floor(Math.log(engagement + 1) * 2));
  score += engagementBonus;

  // Recency (newer is better)
  const dateObj = new Date(input.timestamp);
  const daysSincePost = (Date.now() - dateObj.getTime()) / (1000 * 60 * 60 * 24);
  
  let recencyScore = 100;
  if (daysSincePost > 365) recencyScore = 40; // Older than 1 year
  else if (daysSincePost > 90) recencyScore = 70;
  else if (daysSincePost > 30) recencyScore = 85;
  
  score += (recencyScore - 50) * 0.3; // Weight recency at 30%

  // Engagement rate
  const engagementRate = input.type === "tweet" 
    ? (input.likes + input.views) / 100 
    : input.comments / 10;
  
  score += Math.min(10, engagementRate);

  return {
    overall: Math.max(0, Math.min(100, score)),
    engagement: Math.min(100, (engagement / 1000) * 100), // Normalize
    recency: recencyScore,
    source_authority: input.source,
    verification_status: input.source === "official" || input.source === "verified",
  };
}

/**
 * Compile final research result
 */
export async function compileResearchResult(
  query: string,
  youtubeResources: ResearchResource[],
  twitterResources: ResearchResource[]
): Promise<ResearchQueryResult> {
  const allResources = [...youtubeResources, ...twitterResources];

  // Sort by credibility
  allResources.sort((a, b) => b.credibility.overall - a.credibility.overall);

  // Calculate distribution of comment classifications (opinion/information/other)
  let opinionCount = 0;
  let informationCount = 0;
  let otherCount = 0;

  for (const resource of allResources) {
    for (const op of resource.opinions) {
      if ((op as any).label === "opinion") opinionCount++;
      else if ((op as any).label === "information") informationCount++;
      else otherCount++;
    }
  }

  const total = opinionCount + informationCount + otherCount;
  const opinionDistribution = {
    opinion: total > 0 ? Math.round((opinionCount / total) * 100) : 0,
    information: total > 0 ? Math.round((informationCount / total) * 100) : 0,
    other: total > 0 ? Math.round((otherCount / total) * 100) : 0,
  };

  // Extract top key points
  const allKeyPoints: KeyPoint[] = [];
  for (const resource of allResources) {
    allKeyPoints.push(...resource.keyPoints);
  }

  // Merge and deduplicate key points
  const mergedKeyPoints = mergeKeyPoints(allKeyPoints);
  const topKeyPoints = mergedKeyPoints
    .sort((a, b) => (b.frequency + b.evidenceCount) - (a.frequency + a.evidenceCount))
    .slice(0, 5);

  // Generate recommended actions
  const recommendedActions = generateRecommendations(query, topKeyPoints, allResources);

  // Find related government service
  let governmentService = findGovernmentService(query);

  // ONLY call LLM if we don't already have a database result
  // This prevents unnecessary rate limiting
  const inferred = !governmentService 
    ? await extractGovernmentLinksForQuery(query).catch((err) => {
        console.warn("[LLM] Gov link extraction failed:", (err as any)?.message || err);
        return null;
      })
    : null;

  // Enrich DB result if found
  const enriched = governmentService
    ? await enrichGovernmentService(governmentService).catch((err) => {
        console.warn("Failed to enrich government service:", (err as any)?.message || err);
        return governmentService;
      })
    : null;

  if (enriched) governmentService = enriched;

  // If no DB match, use LLM-inferred result
  if (!governmentService && inferred && inferred.officialLinks.length > 0) {
    governmentService = {
      id: "llm-extracted",
      name: inferred.serviceName,
      description: inferred.description,
      category: inferred.category,
      keywords: inferred.keywords || [],
      officialLinks: inferred.officialLinks,
      documentLinks: extractDocumentLinksFromScraped(
        inferred.scrapedInfo,
        inferred.officialLinks,
        [query, inferred.serviceName, ...(inferred.keywords || [])]
      ),
      requirements: extractRequirementsFromScraped(inferred.scrapedInfo),
      processingTime: extractProcessingTimeFromScraped(inferred.scrapedInfo),
      relatedServices: [],
      state: inferred.state,
    };
  }

  return {
    query,
    timestamp: new Date().toISOString(),
    governmentService: governmentService || undefined,
    resources: allResources.slice(0, 10), // Top 10 resources
    opinionDistribution,
    averageCredibility: Math.round(
      allResources.reduce((sum, r) => sum + r.credibility.overall, 0) / allResources.length
    ),
    topKeyPoints,
    recommendedActions,
  };
}

/**
 * Merge duplicate key points
 */
function mergeKeyPoints(keyPoints: KeyPoint[]): KeyPoint[] {
  const merged: Record<string, KeyPoint> = {};

  for (const kp of keyPoints) {
    const key = kp.text.toLowerCase();
    if (merged[key]) {
      merged[key].frequency += kp.frequency;
      merged[key].evidenceCount += kp.evidenceCount;
      merged[key].sources = [...new Set([...merged[key].sources, ...kp.sources])];
    } else {
      merged[key] = { ...kp };
    }
  }

  return Object.values(merged);
}

/**
 * Generate recommended actions based on extracted insights
 */
function generateRecommendations(
  query: string,
  keyPoints: KeyPoint[],
  resources: ResearchResource[]
): string[] {
  const recommendations: string[] = [];

  // Add top key points as recommendations
  for (const kp of keyPoints.slice(0, 3)) {
    if (kp.sentiment !== "spam" && kp.text.length > 10) {
      recommendations.push(kp.text);
    }
  }

  // Add official resource recommendations
  for (const resource of resources) {
    if (resource.credibility.source_authority === "official" && recommendations.length < 5) {
      recommendations.push(`Check official source: ${resource.title}`);
    }
  }

  return recommendations.slice(0, 5);
}

/**
 * Extract document links from scraped portal information
 */
function extractDocumentLinksFromScraped(
  scrapedInfo?: ScrapedPageInfo[],
  officialLinks: string[] = [],
  terms: string[] = []
): string[] {
  if (!scrapedInfo?.length) return [];

  const officialHosts = new Set(
    officialLinks
      .map((url) => {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })
      .filter(Boolean)
  );

  const normalizedTerms = terms
    .flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/g))
    .filter((t) => t.length >= 3 && !["the", "for", "and", "with", "from", "india"].includes(t));

  const docs = scrapedInfo
    .flatMap((info) => info.documents || [])
    .map((doc) => doc.url)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, "");
        if (officialHosts.size > 0 && !officialHosts.has(host)) return false;

        const lowered = (parsed.pathname + parsed.search).toLowerCase();
        const hasUsefulPattern = /(form|apply|application|permit|license|dl|idp|download|document|pdf)/.test(lowered);
        const hasTermMatch = normalizedTerms.length === 0 || normalizedTerms.some((t) => lowered.includes(t));
        return hasUsefulPattern && hasTermMatch;
      } catch {
        return false;
      }
    });

  // Fallback: if strict filter returns nothing, relax term-match but keep host + useful path constraints.
  const fallbackDocs = docs.length > 0
    ? docs
    : scrapedInfo
        .flatMap((info) => info.documents || [])
        .map((doc) => doc.url)
        .filter((url) => {
          try {
            const parsed = new URL(url);
            const host = parsed.hostname.replace(/^www\./, "");
            if (officialHosts.size > 0 && !officialHosts.has(host)) return false;
            const lowered = (parsed.pathname + parsed.search).toLowerCase();
            return /(form|apply|application|permit|license|download|document|pdf)/.test(lowered);
          } catch {
            return false;
          }
        });

  return [...new Set(fallbackDocs)].slice(0, 20);
}

/**
 * Extract requirements from scraped portal information
 */
function extractRequirementsFromScraped(scrapedInfo?: ScrapedPageInfo[]): string[] {
  if (!scrapedInfo?.length) return [];
  
  return scrapedInfo
    .flatMap(info => info.requirements || [])
    .slice(0, 15);
}

/**
 * Extract processing time from scraped portal information
 */
function extractProcessingTimeFromScraped(scrapedInfo?: ScrapedPageInfo[]): string {
  if (!scrapedInfo?.length) return "Varies by service";
  
  const times = scrapedInfo
    .map(info => info.processingTime)
    .filter(Boolean);
  
  return times[0] || "Varies by service";
}
