import axios from "axios";
import { load } from "cheerio";
import type { YouTubeResults, TwitterResults, YouTubeVideo, YouTubeComment, TwitterTweet } from "./resources/api-results/types.js";
import type { ResearchQueryResult } from "./resources/research-agent/types.js";
import { processYouTubeResults, processTwitterResults, compileResearchResult } from "./resources/research-agent/orchestrator.js";
import { summarizeForVideo } from "./resources/research-agent/llm.js";

const API_TIMEOUT_MS = 8000;
const COMMENT_TIMEOUT_MS = 5000;

export type QuoraFAQ = {
  question: string;
  answer: string;
  url: string;
};

export type QuoraFAQResults = {
  query: string;
  count: number;
  faqs: QuoraFAQ[];
};

function normalizeBearerToken(rawToken: string): string {
  const trimmed = rawToken
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^['\"]|['\"]$/g, "");

  // Some dashboards/copy-pastes provide URL-encoded tokens (%2B, %3D, etc.).
  // Decode once so Authorization header gets the raw bearer token format.
  if (trimmed.includes("%")) {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function normalizeText(input: string, maxLength = 420): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-:|]+|[\s]+$/g, "")
    .trim()
    .slice(0, maxLength);
}

function stripQuoraBranding(input: string): string {
  return normalizeText(input)
    .replace(/\s*[\-|:]\s*Quora\s*$/i, "")
    .replace(/^Quora\s*[\-|:]\s*/i, "");
}

function tokenizeForMatch(input: string): string[] {
  return normalizeText(input, 600)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 4)
    .filter((token) => !["what", "when", "where", "which", "your", "from", "with", "about", "have", "that", "this"].includes(token));
}

function extractDuckDuckGoResultUrls(html: string): string[] {
  const decoded = html
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  const urls = new Set<string>();

  const uddgMatches = decoded.match(/uddg=([^&"'\s>]+)/g) || [];
  for (const match of uddgMatches) {
    const encoded = match.replace(/^uddg=/, "").trim();
    if (!encoded) continue;
    try {
      const raw = decodeURIComponent(encoded);
      if (raw.startsWith("http")) urls.add(raw);
    } catch {
      // Ignore malformed URL encodings.
    }
  }

  const hrefMatches = decoded.match(/href=["']([^"']+)["']/gi) || [];
  for (const attr of hrefMatches) {
    const href = attr.replace(/^href=["']/i, "").replace(/["']$/g, "").trim();
    if (!href) continue;
    try {
      const resolved = new URL(href, "https://duckduckgo.com");
      const uddg = resolved.searchParams.get("uddg");
      if (uddg) {
        const decodedTarget = decodeURIComponent(uddg);
        if (decodedTarget.startsWith("http")) urls.add(decodedTarget);
      } else if (resolved.protocol.startsWith("http")) {
        urls.add(resolved.toString());
      }
    } catch {
      // Ignore malformed href values.
    }
  }

  return Array.from(urls);
}

function extractQuestionAndAnswerFromQuoraHtml(html: string, url: string): QuoraFAQ | null {
  const $ = load(html);

  const title =
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    $("title").text() ||
    "";

  const description =
    $("meta[property='og:description']").attr("content") ||
    $("meta[name='description']").attr("content") ||
    $("meta[name='twitter:description']").attr("content") ||
    "";

  const rawQuestion = stripQuoraBranding(title);
  const fallbackQuestion = description.includes("?") ? description.split("?")[0] + "?" : "";
  const question = normalizeText(rawQuestion || fallbackQuestion, 220);

  let answer = normalizeText(description, 520);

  if (!answer || answer.length < 45) {
    const paragraphTexts: string[] = [];
    const nodes = $("p, span").toArray();
    for (const node of nodes) {
      if (paragraphTexts.length >= 20) break;
      const extracted = normalizeText($(node).text(), 300);
      if (extracted.length >= 55) paragraphTexts.push(extracted);
    }

    answer = normalizeText(paragraphTexts.join(" "), 520);
  }

  if (!question || question.length < 8) return null;
  if (!answer || answer.length < 45) return null;

  return {
    question,
    answer,
    url,
  };
}

export async function searchQuoraFAQs(query: string, limit = 5): Promise<QuoraFAQResults> {
  const safeLimit = Math.max(1, Math.min(10, limit));
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(`${query} site:quora.com`)}`;

  const searchResponse = await axios.get<string>(searchUrl, {
    timeout: API_TIMEOUT_MS,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const allResultUrls = extractDuckDuckGoResultUrls(searchResponse.data)
    .filter((resultUrl) => /https?:\/\/(www\.)?quora\.com\//i.test(resultUrl))
    .filter((resultUrl) => !/\/profile\//i.test(resultUrl));

  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  for (const resultUrl of allResultUrls) {
    const normalized = resultUrl.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueUrls.push(resultUrl);
    if (uniqueUrls.length >= 12) break;
  }

  const queryTerms = tokenizeForMatch(query);
  const faqs: Array<QuoraFAQ & { relevance: number }> = [];

  await Promise.all(
    uniqueUrls.map(async (resultUrl) => {
      try {
        const pageResponse = await axios.get<string>(resultUrl, {
          timeout: API_TIMEOUT_MS,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });

        const extracted = extractQuestionAndAnswerFromQuoraHtml(pageResponse.data, resultUrl);
        if (!extracted) return;

        const corpus = `${extracted.question} ${extracted.answer}`.toLowerCase();
        const relevance = queryTerms.reduce((score, term) => score + (corpus.includes(term) ? 1 : 0), 0);
        if (queryTerms.length > 0 && relevance === 0) return;

        faqs.push({ ...extracted, relevance });
      } catch {
        // Skip inaccessible or anti-bot-protected pages and continue.
      }
    })
  );

  const deduped = new Map<string, QuoraFAQ & { relevance: number }>();
  for (const faq of faqs) {
    const key = faq.question.toLowerCase();
    const existing = deduped.get(key);
    if (!existing || faq.relevance > existing.relevance) {
      deduped.set(key, faq);
    }
  }

  const topFaqs = Array.from(deduped.values())
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, safeLimit)
    .map(({ question, answer, url }) => ({ question, answer, url }));

  return {
    query,
    count: topFaqs.length,
    faqs: topFaqs,
  };
}

/**
 * YouTube API Helper
 * Requires: YOUTUBE_API_KEY environment variable
 */
export async function searchYouTube(query: string): Promise<YouTubeResults> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY environment variable not set");
  }

  try {
    const queryVariants = [
      query,
      `${query} india official process`,
      `${query} duplicate certificate apply online`,
    ];

    const videosMap = new Map<string, YouTubeVideo>();

    for (const variant of queryVariants) {
      if (videosMap.size >= 5) break;

      // Search for videos - India specific
      const searchResponse = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        timeout: API_TIMEOUT_MS,
        params: {
          q: variant,
          key: apiKey,
          part: "snippet",
          type: "video",
          maxResults: 5,
          relevanceLanguage: "en",
          regionCode: "IN", // India specific
          relevantLanguage: "en,hi", // English and Hindi
        },
      });

      const variantVideos: YouTubeVideo[] = (searchResponse.data.items || [])
        .filter((item: any) => item?.id?.videoId)
        .map((item: any) => ({
          id: item.id.videoId,
          title: item.snippet.title,
          description: item.snippet.description,
          thumbnail: item.snippet.thumbnails?.medium?.url || "",
          channelTitle: item.snippet.channelTitle,
          publishedAt: item.snippet.publishedAt,
          url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        }));

      for (const video of variantVideos) {
        if (!videosMap.has(video.id)) {
          videosMap.set(video.id, video);
        }
        if (videosMap.size >= 5) break;
      }
    }

    const videos = Array.from(videosMap.values()).slice(0, 5);

    // Fetch comments for each video (top 3 comments per video), build commentsByVideo map and aggregated comments list
    const commentsByVideo: Record<string, YouTubeComment[]> = {};
    const aggregatedComments: YouTubeComment[] = [];

    const commentResults = await Promise.all(
      videos.map(async (video) => {
        try {
          const commentsResponse = await axios.get("https://www.googleapis.com/youtube/v3/commentThreads", {
            timeout: COMMENT_TIMEOUT_MS,
            params: {
              videoId: video.id,
              key: apiKey,
              part: "snippet",
              maxResults: 3,
              textFormat: "plainText",
            },
          });

          const videoComments: YouTubeComment[] = (commentsResponse.data.items || [])
            .map((thread: any) => {
              const comment = thread.snippet.topLevelComment.snippet;
              return {
                id: thread.id,
                authorDisplayName: comment.authorDisplayName,
                textDisplay: comment.textDisplay,
                likeCount: comment.likeCount,
                publishedAt: comment.publishedAt,
                authorProfileImageUrl: comment.authorProfileImageUrl,
                videoId: video.id,
              };
            })
            .slice(0, 3);

          return { videoId: video.id, comments: videoComments };
        } catch (error) {
          console.warn(`Could not fetch comments for video ${video.id}:`, (error as any)?.message || error);
          return { videoId: video.id, comments: [] as YouTubeComment[] };
        }
      })
    );

    commentResults.forEach(({ videoId, comments }) => {
      commentsByVideo[videoId] = comments;
      aggregatedComments.push(...comments);
    });

    return {
      videos,
      comments: aggregatedComments,
      commentsByVideo,
      query,
    };
  } catch (error) {
    throw new Error(`YouTube search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Twitter/X API Helper
 * Requires: TWITTER_BEARER_TOKEN environment variable
 * Filters for India-specific content
 */
export async function searchTwitter(query: string): Promise<TwitterResults> {
  const rawBearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!rawBearerToken) {
    throw new Error("TWITTER_BEARER_TOKEN environment variable not set");
  }
  const bearerToken = normalizeBearerToken(rawBearerToken);

  try {
    // Add India context to query for region-specific results
    const indiaQuery = `(${query}) (India OR Indian OR "in" OR "IN") lang:en`;
    
    const response = await axios.get("https://api.twitter.com/2/tweets/search/recent", {
      timeout: API_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
      params: {
        query: indiaQuery,
        "tweet.fields": "public_metrics,created_at,author_id",
        "user.fields": "username,profile_image_url,verified",
        expansions: "author_id",
        max_results: 10,
      },
    });

    const users = response.data.includes?.users || [];
    const userMap = Object.fromEntries(users.map((u: any) => [u.id, u]));

    const tweets: TwitterTweet[] = (response.data.data || []).map((tweet: any) => {
      const author = userMap[tweet.author_id];
      return {
        id: tweet.id,
        text: tweet.text,
        author: author?.name || "Unknown",
        authorName: author?.name || "Unknown",
        authorHandle: author?.username || "unknown",
        authorAvatarUrl: author?.profile_image_url,
        authorVerified: author?.verified || false,
        createdAt: tweet.created_at,
        likeCount: tweet.public_metrics?.like_count || 0,
        retweetCount: tweet.public_metrics?.retweet_count || 0,
        replyCount: tweet.public_metrics?.reply_count || 0,
        url: `https://twitter.com/${author?.username}/status/${tweet.id}`,
      };
    });

    return {
      tweets,
      query,
      count: tweets.length,
    };
  } catch (error: any) {
    const status = error?.response?.status;
    const apiMessage = error?.response?.data?.detail || error?.response?.data?.title;

    if (status === 401) {
      throw new Error(
        `Twitter search failed: Unauthorized (401). Verify TWITTER_BEARER_TOKEN is valid and not URL-encoded. ${apiMessage ? `API: ${apiMessage}` : ""}`.trim()
      );
    }

    throw new Error(`Twitter search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Combined search for both platforms
 * Twitter is optional - research agent works with just YouTube
 */
export async function searchBothPlatforms(query: string): Promise<{
  youtube: YouTubeResults | null;
  twitter: TwitterResults | null;
  errors: string[];
}> {
  const errors: string[] = [];
  let youtube: YouTubeResults | null = null;
  let twitter: TwitterResults | null = null;

  // Search YouTube (REQUIRED)
  try {
    youtube = await searchYouTube(query);
  } catch (error) {
    errors.push(`YouTube: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Search Twitter (OPTIONAL - graceful fail)
  try {
    twitter = await searchTwitter(query);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[Research Agent] Twitter unavailable (${errorMsg}) - continuing with YouTube only`);
    // Don't add to errors - Twitter is optional
  }

  return { youtube, twitter, errors };
}

/**
 * Research Agent for Government Services - INDIA SPECIFIC
 * PRIMARY: YouTube (working)
 * OPTIONAL: Twitter (graceful fallback)
 * Integrates YouTube and optionally Twitter, with Indian government service database
 * Searches only for India-specific content and resources
 * Provides curated insights with sentiment analysis and credibility scoring
 */
export async function researchGovernmentQuery(query: string, instructions?: string): Promise<ResearchQueryResult> {
  try {
    console.log(`[Research Agent - India] Processing query: "${query}"`);

    // Fetch data from both platforms (India-specific)
    const { youtube, twitter, errors } = await searchBothPlatforms(query);

    if (errors.length > 0) {
      console.warn("[Research Agent] Errors during data collection:", errors);
    }

    if (!youtube && !twitter) {
      throw new Error("No data retrieved from any source");
    }

    // Process raw data through sentiment classifier and credibility scorer
    const youtubeResources = youtube ? processYouTubeResults(youtube) : [];
    const twitterResources = twitter ? processTwitterResults(twitter) : [];

    console.log(
      `[Research Agent] Processed ${youtubeResources.length} YouTube resources${twitter ? ` and ${twitterResources.length} Twitter resources` : " (Twitter unavailable)"}`
    );

    // Attach LLM-generated summaries to YouTube resources (if OpenAI key is available)
    if (youtube && youtubeResources.length > 0) {
      for (const res of youtubeResources) {
        try {
          const video = youtube.videos.find((v) => v.id === res.id);
          const commentsForVideo = youtube.commentsByVideo?.[res.id] || [];
          const summary = await summarizeForVideo(
            video?.title || res.title,
            video?.description || "",
            commentsForVideo,
            instructions
          );
          if (!res.metadata) res.metadata = {} as any;
          (res.metadata as any).summary = summary;
        } catch (err) {
          console.warn("Failed to summarize resource", res.id, (err as any)?.message || err);
        }
      }
    }

    // Compile final research result (may enrich government service with official docs)
    const result = await compileResearchResult(query, youtubeResources, twitterResources);

    console.log(
      `[Research Agent] Research complete. Comment distribution: ${result.opinionDistribution.opinion}% opinion, ${result.opinionDistribution.information}% information, ${result.opinionDistribution.other}% other`
    );

    return result;
  } catch (error) {
    throw new Error(
      `Research failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

