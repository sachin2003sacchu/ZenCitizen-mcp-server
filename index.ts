/**
 * articleFetcher.ts
 *
 * Fetches article links dynamically based on any query.
 * No hardcoded topics, keywords, or domains in search queries.
 * All ranking signals are structural (gov domains, article URL shape, query overlap).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RankedSource = {
  url: string;
  title: string;
  rank: number;
  tier: "tier-1" | "tier-2" | "tier-3";
  rationale: string;
};

// ---------------------------------------------------------------------------
// Trusted news domains (structural config — not query-specific)
// ---------------------------------------------------------------------------

const TRUSTED_NEWS_DOMAINS: string[] = [
  "hindustantimes.com",
  "thehindu.com",
  "timesofindia.indiatimes.com",
  "deccanherald.com",
  "ndtv.com",
  "indianexpress.com",
  "scroll.in",
  "thewire.in",
  "livemint.com",
  "businessstandard.com",
  "prajavani.net",
  "vijaykarnataka.com",
  "kannadaprabha.com",
  "udayavani.com",
  "vijayavani.net",
  "kannadadunia.com",
];

// ---------------------------------------------------------------------------
// URL utilities
// ---------------------------------------------------------------------------

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isTrustedNewsDomain(url: string): boolean {
  const host = getHostname(url);
  return TRUSTED_NEWS_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

function isOfficialDomain(url: string): boolean {
  const lower = url.toLowerCase();
  return /\.gov\.in|\.nic\.in/.test(lower);
}

function isIndexOrLandingPage(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return true;
    if (/^\/(news|latest|india|world|sport|sports|business|opinion|national|topics?|tag|tags|category|categories)$/i.test(path)) return true;
    return false;
  } catch {
    return true;
  }
}

function isArticleLikePath(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    // Has a deep path (likely article slug) and not a homepage
    return path.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function isPolicyOrMetaUrl(url: string): boolean {
  return /(policy|privacy|terms|sitemap|retention|copyright|data-sharing|archive)/i.test(url);
}

function isCommunityOrSocialUrl(url: string): boolean {
  return /(youtube\.com|twitter\.com|x\.com|reddit\.com|quora\.com|news\.google\.com|duckduckgo\.com)/i.test(url);
}

// ---------------------------------------------------------------------------
// Query tokenizer — purely based on input, no hardcoded expansions
// ---------------------------------------------------------------------------

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
    .filter(
      (t) =>
        !["this", "that", "with", "from", "your", "have", "will", "need", "what", "when", "where", "how"].includes(t)
    );
}

function queryRelevanceScore(url: string, title: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const corpus = `${url} ${title}`.toLowerCase();
  return tokens.reduce((count, t) => count + (corpus.includes(t) ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function rankSource(url: string, title: string, queryTokens: string[]): RankedSource {
  const safeTitle = (title || "Article").slice(0, 140);
  let rank = 20;
  const reasons: string[] = [];

  if (isCommunityOrSocialUrl(url)) {
    return { url, title: safeTitle, rank: 0, tier: "tier-3", rationale: "social/community platform excluded" };
  }

  if (isPolicyOrMetaUrl(url)) {
    rank -= 20;
    reasons.push("policy/meta page");
  }

  if (isOfficialDomain(url)) {
    rank += 60;
    reasons.push("official gov domain");
  }

  if (isTrustedNewsDomain(url)) {
    rank += 50;
    reasons.push("trusted news domain");
  }

  if (isIndexOrLandingPage(url)) {
    rank -= 40;
    reasons.push("index/landing page");
  }

  if (isArticleLikePath(url)) {
    rank += 15;
    reasons.push("article-like URL depth");
  }

  const relevance = queryRelevanceScore(url, safeTitle, queryTokens);
  if (relevance >= 3) {
    rank += 25;
    reasons.push("high query relevance");
  } else if (relevance === 2) {
    rank += 12;
    reasons.push("moderate query relevance");
  } else if (relevance === 1) {
    rank += 4;
    reasons.push("low query relevance");
  } else {
    rank -= 20;
    reasons.push("no query relevance");
  }

  const clipped = Math.max(0, Math.min(100, rank));
  const tier: RankedSource["tier"] =
    clipped >= 80 ? "tier-1" : clipped >= 55 ? "tier-2" : "tier-3";

  return {
    url,
    title: safeTitle,
    rank: clipped,
    tier,
    rationale: reasons.join(", ") || "no strong signals",
  };
}

// ---------------------------------------------------------------------------
// HTML / RSS parsers
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeDuckDuckGoRedirect(url: string): string {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractUrlsFromHtml(html: string): string[] {
  const decoded = decodeHtmlEntities(html);
  const urls = new Set<string>();

  // DuckDuckGo uddg redirect params
  const uddgMatches = decoded.match(/uddg=([^&"'\s>]+)/g) || [];
  for (const match of uddgMatches) {
    const encoded = match.replace(/^uddg=/, "");
    try {
      const resolved = decodeURIComponent(encoded);
      if (resolved.startsWith("http")) urls.add(resolved);
    } catch { /* skip malformed */ }
  }

  // href attributes
  const hrefMatches = decoded.match(/href=["']([^"']+)["']/gi) || [];
  for (const attr of hrefMatches) {
    const href = attr.replace(/^href=["']/i, "").replace(/["']$/, "").trim();
    if (!href) continue;
    const resolved = decodeDuckDuckGoRedirect(href);
    if (resolved.startsWith("http")) urls.add(resolved);
  }

  return Array.from(urls);
}

function extractUrlsFromGoogleNewsRss(xml: string): string[] {
  const urls = new Set<string>();
  const matches = xml.match(/<link>(https?:\/\/[^<]+)<\/link>/gi) || [];
  for (const m of matches) {
    const link = m.replace(/^<link>/i, "").replace(/<\/link>$/i, "").trim();
    if (link && !/news\.google\.com/.test(link)) urls.add(link);
  }
  return Array.from(urls);
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
};

async function fetchDuckDuckGoResults(query: string): Promise<string[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) return [];
    const html = await res.text();
    return extractUrlsFromHtml(html);
  } catch {
    return [];
  }
}

async function fetchGoogleNewsRssResults(query: string): Promise<string[]> {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const res = await fetch(rssUrl, { headers: FETCH_HEADERS });
    if (!res.ok) return [];
    const xml = await res.text();
    return extractUrlsFromGoogleNewsRss(xml);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetches and ranks article links for any query.
 * No hardcoded topics — all signals are structural.
 *
 * @param query   The raw user query string
 * @param maxResults  Max number of ranked sources to return (default 6)
 */
export async function fetchArticleLinks(
  query: string,
  maxResults = 6
): Promise<RankedSource[]> {
  const queryTokens = tokenizeQuery(query);
  const collected = new Map<string, RankedSource>();

  const addUrl = (url: string, title = "Article") => {
    const clean = url.replace(/[).,;!?]+$/g, "").trim();
    if (!clean || isCommunityOrSocialUrl(clean)) return;
    const ranked = rankSource(clean, title, queryTokens);
    if (ranked.rank === 0) return;
    const key = clean.toLowerCase();
    const existing = collected.get(key);
    if (!existing || ranked.rank > existing.rank) {
      collected.set(key, ranked);
    }
  };

  // Source 1: DuckDuckGo HTML search
  const ddgUrls = await fetchDuckDuckGoResults(query);
  ddgUrls.forEach((url) => addUrl(url));

  // Source 2: Google News RSS — same raw query, no injected keywords
  const rssUrls = await fetchGoogleNewsRssResults(query);
  rssUrls.forEach((url) => addUrl(url));

  return Array.from(collected.values())
    .sort((a, b) => b.rank - a.rank)
    .slice(0, maxResults);
}

/**
 * Merges two ranked source arrays, deduplicating by URL and keeping highest rank.
 */
export function mergeRankedSources(
  primary: RankedSource[],
  secondary: RankedSource[]
): RankedSource[] {
  const deduped = new Map<string, RankedSource>();
  for (const source of [...primary, ...secondary]) {
    const key = source.url.toLowerCase();
    const existing = deduped.get(key);
    if (!existing || source.rank > existing.rank) {
      deduped.set(key, source);
    }
  }
  return Array.from(deduped.values())
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 6);
}