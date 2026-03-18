import axios from "axios";
import { scrapeMultiplePortals, type ScrapedPageInfo } from "./dynamic-scraper.js";

const OPENAI_URL = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

// Cache for government links extraction results (24-hour TTL)
const GOVERNMENT_LINKS_CACHE = new Map<string, { result: any; timestamp: number }>();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Rate limiting: track last API call time to avoid 429 errors
let lastApiCallTime = 0;
const MIN_REQUEST_INTERVAL_MS = 100; // Minimum 100ms between API calls

/**
 * Wait before next API call to respect rate limits
 */
async function waitForRateLimit() {
  const timeSinceLastCall = Date.now() - lastApiCallTime;
  if (timeSinceLastCall < MIN_REQUEST_INTERVAL_MS) {
    const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastCall;
    console.log("[RateLimit] Waiting", waitTime, "ms before next API call");
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastApiCallTime = Date.now();
}

export async function summarizeForVideo(
  title: string,
  description: string,
  comments: { authorDisplayName?: string; textDisplay: string }[],
  instructions?: string
): Promise<string> {
  // SKIPPED: Don't use LLM for video summarization to avoid rate limiting
  // The government links extraction is more important
  // Instead, return the title + first comment as summary
  if (comments && comments.length > 0) {
    return `${title} - ${comments[0].textDisplay.substring(0, 100)}`;
  }
  return title;
}

export interface InferredGovernmentLinks {
  serviceName: string;
  description: string;
  officialLinks: string[];
  category: string;
  state?: string;
  keywords: string[];
  scrapedInfo?: ScrapedPageInfo[];
}

/**
 * Uses the LLM to infer official Indian government portal URLs for any query
 * that wasn't found in the static services-db.
 * Returns null if OpenAI is unavailable or confidence is too low.
 */
export async function inferGovernmentLinks(query: string): Promise<InferredGovernmentLinks | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const system = `You are an expert on Indian government digital portals and services. 
Given a user query about an Indian government service, identify:
1. The exact service name
2. A brief description (1 sentence)
3. The official Indian government portal URLs that handle this service (homepage-level URLs only, must be real government sites ending in .gov.in, .nic.in, or well-known .in domains)
4. The service category
5. The state (if applicable)
6. 3-5 keywords related to the service

CRITICAL RULES:
- Only return URLs you are highly confident actually exist (e.g., parivahan.gov.in, uidai.gov.in, incometaxindiaefiling.gov.in, epfindia.gov.in, digilocker.gov.in, india.gov.in, mkisan.gov.in, mca.gov.in, passport.gov.in, sarthi.nic.in etc.)
- Prefer the specific portal over the generic india.gov.in
- Return at most 4 URLs
- Always include india.gov.in as a fallback if no specific portal is known
- Return ONLY valid JSON, no commentary

Response format:
{
  "serviceName": "...",
  "description": "...",
  "officialLinks": ["https://...", "https://..."],
  "category": "...",
  "state": null,
  "keywords": ["keyword1", "keyword2", "keyword3"]
}`;

  try {
    const resp = await axios.post(
      `${OPENAI_URL}/chat/completions`,
      {
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Query: ${query}` },
        ],
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const raw = resp.data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw) as InferredGovernmentLinks;

    if (!parsed.officialLinks || parsed.officialLinks.length === 0) return null;

    // Validate: only keep links that look like real gov URLs
    parsed.officialLinks = parsed.officialLinks.filter((url: string) => {
      try {
        const u = new URL(url);
        return u.hostname.endsWith(".gov.in") || u.hostname.endsWith(".nic.in") || u.hostname.endsWith(".in");
      } catch {
        return false;
      }
    });

    return parsed.officialLinks.length > 0 ? parsed : null;
  } catch (err) {
    console.warn("LLM gov link inference failed:", (err as any)?.message || err);
    return null;
  }
}



/**
 * Extract government links AND scrape portals on-demand
 * Uses LLM to find links, then dynamically scrapes them for documents, requirements, processing time, etc.
 * Results are cached for 24 hours
 */
export async function extractGovernmentLinksForQuery(query: string): Promise<InferredGovernmentLinks | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[LLM] OPENAI_API_KEY not set");
    return null;
  }

  // Check cache first
  const cached = GOVERNMENT_LINKS_CACHE.get(query);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log("[Cache] Returning cached result for query:", query);
    return cached.result;
  }

  const system = `You are an expert on Indian government digital portals and services. 
Given a user query about an Indian government service, identify:
1. The exact service name
2. A brief description (1 sentence)
3. The official Indian government portal URLs that handle this service (homepage-level URLs only, must be real government sites ending in .gov.in, .nic.in, or well-known .in domains)
4. The service category
5. The state (if applicable)
6. 3-5 keywords related to the service

CRITICAL RULES:
- Only return URLs you are highly confident actually exist
- Return at most 4 URLs, prioritize specific portals over india.gov.in
- ALWAYS include real, verified government URLs
- Return ONLY valid JSON, no commentary

Response format:
{
  "serviceName": "...",
  "description": "...",
  "officialLinks": ["https://...", "https://..."],
  "category": "...",
  "state": null,
  "keywords": ["keyword1", "keyword2", "keyword3"]
}`;

  try {
    console.log("[LLM] Extracting government links for query:", query);
    
    // Retry logic with exponential backoff (longer delays for rate-limited APIs)
    let resp;
    let retries = 5;  // More retries
    let delay = 3000; // Start with 3 second delay (free tier: 3 RPM = 1 request per 20 seconds)
    
    while (retries > 0) {
      try {
        // Wait before API call to avoid rate limiting
        await waitForRateLimit();
        
        resp = await axios.post(
          `${OPENAI_URL}/chat/completions`,
          {
            model: process.env.OPENAI_MODEL || "gpt-4o-mini",
            messages: [
              { role: "system", content: system },
              { role: "user", content: `Query: ${query}` },
            ],
            temperature: 0.2,
            max_tokens: 500,
            response_format: { type: "json_object" },
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            timeout: 10000, // 10 second timeout
          }
        );
        console.log("[LLM] ✅ Successfully extracted government links");
        break; // Success, exit retry loop
      } catch (err: any) {
        if (err.response?.status === 429 && retries > 1) {
          // Rate limited, wait longer and retry
          console.warn("[LLM] Rate limited (429), retrying in", delay, "ms (attempt", 6 - retries, "/5)...");
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 1.5, 20000); // Exponential backoff, cap at 20 seconds
          retries--;
        } else {
          throw err; // Other error or last retry failed
        }
      }
    }

    const raw = resp?.data?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw) as InferredGovernmentLinks;

    if (!parsed.officialLinks || parsed.officialLinks.length === 0) {
      console.warn("[LLM] No links returned for query:", query);
      return null;
    }

    // Validate: only keep links that are government domains
    parsed.officialLinks = parsed.officialLinks.filter((url: string) => {
      try {
        const u = new URL(url);
        const isGov = u.hostname.endsWith(".gov.in") || u.hostname.endsWith(".nic.in") || u.hostname.endsWith(".in");
        if (!isGov) {
          console.warn("[LLM] Filtering out non-government URL:", url);
        }
        return isGov;
      } catch {
        return false;
      }
    });

    if (parsed.officialLinks.length === 0) {
      console.warn("[LLM] No valid government URLs after filtering");
      return null;
    }

    console.log("[LLM] Found", parsed.officialLinks.length, "government links:", parsed.officialLinks);

    // Now scrape all discovered links in parallel
    if (parsed.officialLinks.length > 0) {
      console.log("[Scraper] Scraping discovered URLs...");
      
      const scrapedInfo = await scrapeMultiplePortals(parsed.officialLinks);
      
      if (scrapedInfo.length > 0) {
        parsed.scrapedInfo = scrapedInfo;
        // Keep only successfully fetched official links to avoid dead/hallucinated URLs.
        parsed.officialLinks = scrapedInfo.map((s) => s.url);
        console.log("[Scraper] Successfully scraped", scrapedInfo.length, "pages");
      }
    }

    // Ensure state and keywords exist
    parsed.state = parsed.state || undefined;
    parsed.keywords = parsed.keywords || [];

    // Cache result
    GOVERNMENT_LINKS_CACHE.set(query, { result: parsed, timestamp: Date.now() });
    console.log("[Cache] Cached result for:", query);

    return parsed;

  } catch (err) {
    const errorMsg = (err as any)?.message || String(err);
    console.warn("[LLM] Failed to extract government links:", errorMsg);
    return null;
  }
}

export default { summarizeForVideo, inferGovernmentLinks, extractGovernmentLinksForQuery };
