import "dotenv/config";
import { MCPServer, object, text, markdown } from "mcp-use/server";
import { z } from "zod";
import { load } from "cheerio";
import { searchYouTube, searchTwitter, searchQuoraFAQs, researchGovernmentQuery } from "./api.js";
import type { YouTubeResults, TwitterResults } from "./resources/api-results/types.js";

function buildActionLinks(service?: { officialLinks?: string[]; documentLinks?: string[] }) {
  const links = service?.officialLinks || [];
  const docs = service?.documentLinks || [];

  const inferPurpose = (url: string) => {
    const u = url.toLowerCase();
    if (/(apply|register|application|new-?service|request)/.test(u)) return "apply";
    if (/(view|search|download|records|certificate|rtc|pahani|khata|mutation)/.test(u)) return "view";
    if (/(status|track|grievance|help|support|contact|sakala)/.test(u)) return "help";
    return "official";
  };

  const inferLabel = (purpose: string, index: number, url: string) => {
    if (purpose === "apply") return "Apply online";
    if (purpose === "view") return "View or download records";
    if (purpose === "help") return "Official help or status portal";
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return index === 0 ? `Official primary portal (${host})` : `Official portal (${host})`;
    } catch {
      return index === 0 ? "Official primary portal" : "Official portal";
    }
  };

  const actionLinks = links.slice(0, 6).map((url, index) => {
    const purpose = inferPurpose(url);
    return {
      label: inferLabel(purpose, index, url),
      url,
      purpose,
    };
  });

  const documentLinks = docs.slice(0, 4).map((url) => ({
    label: "Official document or form",
    url,
    purpose: "document",
  }));

  return [...actionLinks, ...documentLinks];
}

const BANNED_OUTPUT_PATTERNS = [
  /\bif you want\b/i,
  /\bwould you like\b/i,
  /\bi can also\b/i,
  /\bif you tell me\b/i,
  /\bsince .* i\s*'?ll explain\b/i,
  /\bi\s*'?m checking\b/i,
  /\bcalled tool\b/i,
  /\bcan help you with\b/i,
];

function toPlainTextReport(input: string): string {
  const allowedSections = [
    "About This Service",
    "Requirements & Process",
    "Official Links",
    "Related Articles (Context Only)",
    "Related YouTube Videos",
  ];

  const normalizeHeading = (line: string): string =>
    line.replace(/^\*\*(.+)\*\*$/, "$1").trim();

  const isNoiseUrl = (url: string): boolean => {
    const lower = url.toLowerCase();
    if (!/^https?:\/\//.test(lower)) return true;

    const blockedHosts = ["duckduckgo.com", "w3.org"];
    if (blockedHosts.some((host) => lower.includes(host))) return true;

    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|xml)(\?|$)/.test(lower)) return true;
    if (/(\/favicon\.ico|\/opensearch|\/feedback|\/html\/)/.test(lower)) return true;

    return false;
  };

  const extractUrl = (line: string): string | null => {
    const match = line.match(/https?:\/\/\S+/);
    return match ? match[0].replace(/[),.;]+$/, "") : null;
  };

  const lines = String(input || "").split("\n");
  const output: string[] = [];
  let keepSection = false;
  const seenUrls = new Set<string>();
  let currentSection = "";
  let articleCount = 0;
  let videoCount = 0;

  for (const raw of lines) {
    let clean = raw;
    clean = clean.replace(/^>\s?/, "");
    clean = clean.replace(/^REPORT_START\s*$/g, "");
    clean = clean.replace(/^REPORT_END\s*$/g, "");

    const headingMatch = clean.match(/^\*\*(.+)\*\*$/);
    if (headingMatch) {
      const heading = normalizeHeading(clean);
      keepSection = allowedSections.some((prefix) => heading.startsWith(prefix));
      if (keepSection) {
        currentSection = heading;
        if (heading.startsWith("Related Articles")) articleCount = 0;
        if (heading.startsWith("Related YouTube Videos")) videoCount = 0;
        output.push(heading);
        output.push("");
      }
      continue;
    }

    if (!keepSection) continue;

    clean = clean.replace(/\*\*(.*?)\*\*/g, "$1");
    clean = clean.replace(/^\s*(Information:|Sources:)\s*$/i, "");
    clean = clean.replace(/\s*\[Source:\s*https?:\/\/[^\]]+\]\s*$/i, "");
    clean = clean.replace(/^\s*-\s*".*"\s*\(\d+\s*likes\)\s*$/i, "");

    if (!clean.trim()) {
      output.push("");
      continue;
    }

    // Cap long list sections to improve parent-LLM readability.
    if (currentSection.startsWith("Related Articles") && /^\s*\d+\./.test(clean)) {
      articleCount += 1;
      if (articleCount > 6) continue;
    }
    if (currentSection.startsWith("Related YouTube Videos") && /^\s*\d+\./.test(clean)) {
      videoCount += 1;
      if (videoCount > 6) continue;
    }

    const maybeUrl = extractUrl(clean);
    if (maybeUrl && isNoiseUrl(maybeUrl)) continue;

    // Drop duplicate URL-only lines (typically repeated under Sources blocks).
    if (maybeUrl) {
      if (seenUrls.has(maybeUrl) && /^\s*https?:\/\//.test(clean)) continue;
      seenUrls.add(maybeUrl);
    }

    output.push(clean);
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLine(text: string, maxLength = 220): string {
  const compact = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^["'`\-\s]+|["'`\s]+$/g, "")
    .trim();
  return compact.slice(0, maxLength);
}

function isLikelyNoisyComment(text: string): boolean {
  const cleaned = normalizeLine(text, 260);
  if (!cleaned || cleaned.length < 14) return true;

  const lower = cleaned.toLowerCase();
  if (/^[^a-z0-9\u0C80-\u0CFF]+$/i.test(cleaned)) return true;
  if (/\b(mam|sir|bro|bhai|tnq|pls|ple|frad)\b/i.test(lower) && cleaned.length < 60) return true;
  if ((cleaned.match(/[!?]/g) || []).length >= 3) return true;
  if (/^is\s+this\s+still\s+valid\??$/i.test(lower)) return true;
  if (/\b(crush|voice tone|subscribe|follow me|love you|first comment)\b/i.test(lower)) return true;

  return false;
}

function isDisallowedOutputLine(text: string): boolean {
  const line = normalizeLine(text, 320);
  if (!line) return false;
  return BANNED_OUTPUT_PATTERNS.some((pattern) => pattern.test(line));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const clean = normalizeLine(value, 260);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function isPolicyIntentQuery(query: string): boolean {
  return /(policy|act|rule|law|legal|gazette|notification|privacy|retention|compliance)/i.test(query);
}

function isPolicyOrMetaDocument(url: string): boolean {
  const lower = url.toLowerCase();
  return /(policy|privacy|retention|terms|copyright|sitemap|data-sharing|archieval|archive)/.test(lower);
}

function isApplicationRelevantDocument(url: string): boolean {
  const lower = url.toLowerCase();
  return /(form|apply|application|guideline|faq|instruction|permit|license|idp|service|download|dl|rto|parivahan)/.test(lower);
}

function filterOfficialUrlsForQuery(urls: string[], query: string): string[] {
  const allowPolicy = isPolicyIntentQuery(query);
  return Array.from(new Set(urls))
    .filter(Boolean)
    .filter((url) => {
      if (allowPolicy) return true;
      if (isPolicyOrMetaDocument(url)) return false;
      return true;
    });
}

function scoreProcessSpecificity(url: string, query: string): number {
  const lower = url.toLowerCase();
  let score = 0;

  if (/\.gov\.in|\.nic\.in/.test(lower)) score += 25;
  if (isApplicationRelevantDocument(lower)) score += 35;
  if (/(form|apply|application|guideline|faq|instruction|service|permit|license|idp|khata|parivahan|bbmp|sarathi|rto)/.test(lower)) score += 25;
  if (isPolicyOrMetaDocument(lower)) score -= 30;

  const queryTokens = tokenize(query);
  const tokenMatches = queryTokens.filter((t) => lower.includes(t)).length;
  score += Math.min(20, tokenMatches * 5);

  try {
    const parsed = new URL(url);
    // Prefer deeper URLs over root-only homepages for procedural claims.
    if (parsed.pathname && parsed.pathname !== "/") score += 10;
    else score -= 10;
  } catch {
    // noop
  }

  return score;
}

function selectProcessSpecificOfficialUrls(urls: string[], query: string, maxCount = 6): string[] {
  const ranked = Array.from(new Set(urls))
    .filter(Boolean)
    .map((url) => ({ url, score: scoreProcessSpecificity(url, query) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.url);

  return ranked.slice(0, maxCount);
}

function formatClaimWithSource(claim: string, sourceUrl?: string): string {
  if (!sourceUrl) return claim;
  return `${claim} [Source: ${sourceUrl}]`;
}

function filterActionLinksForQuery(
  links: Array<{ label: string; url: string; purpose: string }>,
  query: string
): Array<{ label: string; url: string; purpose: string }> {
  const allowPolicy = isPolicyIntentQuery(query);
  const out: Array<{ label: string; url: string; purpose: string }> = [];
  const seen = new Set<string>();

  for (const link of links) {
    if (!link?.url) continue;
    const key = link.url.toLowerCase();
    if (seen.has(key)) continue;

    if (!allowPolicy && link.purpose === "document") {
      if (isPolicyOrMetaDocument(link.url)) continue;
      if (!isApplicationRelevantDocument(link.url)) continue;
    }

    seen.add(key);
    out.push(link);
  }

  return out;
}

function isLikelyPromotional(text: string): boolean {
  const lower = normalizeLine(text, 320).toLowerCase();
  return /(use code|discount|promo|affiliate|apply here|subscribe|dm me|link in bio|whatsapp me|telegram)/.test(lower);
}

function tokenize(text: string): string[] {
  return normalizeLine(text, 400)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 4)
    .filter((t) => !["this", "that", "with", "from", "your", "have", "will", "need", "apply", "online", "official"].includes(t));
}

function buildQueryTerms(query: string): string[] {
  const base = new Set(tokenize(query));
  const lower = query.toLowerCase();

  if (/(international\s+driving\s+permit|\bidp\b|driving\s+licen[cs]e|rto|parivahan)/.test(lower)) {
    ["international", "driving", "permit", "idp", "license", "licence", "parivahan", "rto"].forEach((t) => base.add(t));
  }

  if (/(passport|visa|medical|application|form|document|renew|validity)/.test(lower)) {
    ["passport", "visa", "medical", "application", "form", "document", "renewal", "validity"].forEach((t) => base.add(t));
  }

  if (/(marriage|certificate|kaveri|sub-registrar|sro|witness|esign)/.test(lower)) {
    ["marriage", "certificate", "kaveri", "subregistrar", "sro", "witness", "esign", "karnataka"].forEach((t) => base.add(t));
  }

  return Array.from(base);
}

function hasQuerySignal(text: string, query: string): boolean {
  const line = normalizeLine(text, 320).toLowerCase();
  if (!line) return false;
  const terms = buildQueryTerms(query);
  return terms.some((t) => line.includes(t));
}

function hasGovernmentProcessSignal(text: string): boolean {
  const line = normalizeLine(text, 320).toLowerCase();
  return /(permit|license|licence|application|apply|form|document|guideline|validity|rto|parivahan|passport|visa|medical|renew)/.test(line);
}

function isCommunityInsightCorroborated(
  insightText: string,
  requirements: string[],
  officialUrls: string[]
): boolean {
  const insightTokens = new Set(tokenize(insightText));
  if (insightTokens.size === 0) return false;

  const officialCorpus = [
    ...requirements,
    ...officialUrls,
  ].join(" ");

  const officialTokens = new Set(tokenize(officialCorpus));

  let matches = 0;
  insightTokens.forEach((t) => {
    if (officialTokens.has(t)) matches += 1;
  });

  return matches >= 2;
}

function verifyInsightLines(insights: string[], requirements: string[], officialUrls: string[]): string[] {
  return insights.map((line) => {
    if (!line.startsWith("Community-reported issue trend:")) return line;
    const raw = line.replace(/^Community-reported issue trend:\s*/i, "").trim();
    const verified = isCommunityInsightCorroborated(raw, requirements, officialUrls);
    if (verified) return `Community-reported issue trend (corroborated): ${raw}`;
    return `Community-reported issue trend (unverified): ${raw}`;
  });
}

function normalizeCredibilityForDisplay(type: string, url: string, score: number): number {
  const isOfficialHost = /\.gov\.in|\.nic\.in/.test((url || "").toLowerCase());
  const base = Math.max(0, Math.min(100, Math.round(score || 0)));

  if (type === "official") return isOfficialHost ? Math.max(base, 85) : Math.min(base, 85);
  if (type === "guide") return isOfficialHost ? Math.min(base, 88) : Math.min(base, 80);
  if (type === "forum") return Math.min(base, 65);
  if (type === "tweet") return Math.min(base, 70);
  if (type === "video") return Math.min(base, 82);
  return Math.min(base, 75);
}

type RankedSource = {
  url: string;
  title: string;
  rank: number;
  tier: "tier-1" | "tier-2" | "tier-3";
  rationale: string;
};

const PREFERRED_NEWS_DOMAINS = [
  "hindustantimes.com",
  "thehindu.com",
  "timesofindia.indiatimes.com",
  "deccanherald.com",
  "prajavani.net",
  "vijaykarnataka.com",
  "kannadaprabha.com",
  "udayavani.com",
  "vijayavani.net",
  "kannadadunia.com",
];

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isPreferredNewsDomain(url: string): boolean {
  const host = getHostname(url);
  return PREFERRED_NEWS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isLikelyArticlePage(url: string): boolean {
  const lower = url.toLowerCase();
  // Keep article/news/explainer/report pages, avoid forms/downloads and raw docs.
  const articleSignals = /(news|article|explainer|story|stories|report|analysis|opinion|editorial|state|city|bengaluru|karnataka)/.test(lower);
  const nonArticleSignals = /(download|form|pdf|\.pdf$|policy|privacy|terms|sitemap|data-sharing|retention|archieval|archive)/.test(lower);
  return articleSignals && !nonArticleSignals;
}

function isLikelyArticleLandingPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase().replace(/\/+$/g, "") || "/";
    if (path === "/") return true;
    if (/^\/(news|latest|india|world|sport|sports|business|opinion|karnataka|national)$/.test(path)) return true;
    if (/^\/(topics?|tag|tags|category|categories)\b/.test(path)) return true;
    return false;
  } catch {
    return true;
  }
}

function scoreArticleRelevance(url: string, title: string, query: string): number {
  const terms = buildQueryTerms(query);
  if (terms.length === 0) return 0;
  const corpus = `${url} ${title}`.toLowerCase();
  return terms.reduce((count, t) => count + (corpus.includes(t) ? 1 : 0), 0);
}

function isStrictArticleCandidate(url: string, title: string, query: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (/(youtube\.com|twitter\.com|x\.com|news\.google\.com|duckduckgo\.com)/.test(lower)) return false;
  if (isLikelyArticleLandingPage(url)) return false;
  if (!isPreferredNewsDomain(url) && !isLikelyArticlePage(url)) return false;
  return scoreArticleRelevance(url, title, query) >= 1;
}

function rankArticleSource(url: string, title?: string, query = ""): RankedSource {
  const safeTitle = normalizeLine(title || "Article reference", 140);
  const lower = url.toLowerCase();
  let rank = 25;
  const reasons: string[] = [];
  const relevanceHits = scoreArticleRelevance(url, safeTitle, query);

  if (isPreferredNewsDomain(url)) {
    rank += 55;
    reasons.push("major national/regional news source");
  }

  if (/\.gov\.in|\.nic\.in/.test(lower)) {
    rank += 60;
    reasons.push("official domain");
  }

  if (/(pib|mygov|egazette|indiacode)/.test(lower)) {
    rank += 20;
    reasons.push("government publication");
  }

  if (/(circular|notification|guideline|press|release|faq|article|news|scheme|instruction|service|form|apply)/.test(lower)) {
    rank += 10;
    reasons.push("policy/help content");
  }

  if (isLikelyArticlePage(url)) {
    rank += 20;
    reasons.push("article-like page");
  }

  if (isLikelyArticleLandingPage(url)) {
    rank -= 45;
    reasons.push("generic landing/index page");
  }

  if (relevanceHits >= 2) {
    rank += 20;
    reasons.push("query-relevant article");
  } else if (relevanceHits === 1) {
    rank += 8;
    reasons.push("partial query relevance");
  } else {
    rank -= 35;
    reasons.push("low query relevance");
  }

  if (/youtube\.com|twitter\.com|x\.com/.test(lower)) {
    rank -= 45;
    reasons.push("community platform");
  }

  if (isPolicyOrMetaDocument(lower)) {
    rank -= 20;
    reasons.push("non-application policy/meta page");
  }

  if (!isLikelyArticlePage(url) && !isPreferredNewsDomain(url)) {
    rank -= 15;
    reasons.push("weak article signals");
  }

  if (relevanceHits === 0) rank = Math.min(rank, 70);
  if (relevanceHits === 1) rank = Math.min(rank, 85);

  const clipped = Math.max(0, Math.min(100, rank));
  let tier: RankedSource["tier"] = "tier-3";
  if (clipped >= 85) tier = "tier-1";
  else if (clipped >= 65) tier = "tier-2";

  return {
    url,
    title: safeTitle,
    rank: clipped,
    tier,
    rationale: reasons.length > 0 ? reasons.join(", ") : "limited source signals",
  };
}

function extractRankedArticles(input: {
  topResources: Array<{ type: string; url: string; title: string }>;
  officialSourceUrls: string[];
  query: string;
}): RankedSource[] {
  const candidates: RankedSource[] = [];

  for (const resource of input.topResources) {
    // Prefer article-like resources and trusted news domains.
    if (!["guide", "forum", "official", "tweet"].includes(resource.type)) continue;
    if (!resource.url) continue;
    if (!isStrictArticleCandidate(resource.url, resource.title || "", input.query)) continue;
    candidates.push(rankArticleSource(resource.url, resource.title, input.query));
  }

  for (const url of input.officialSourceUrls) {
    if (!url) continue;
    if (!isStrictArticleCandidate(url, "Official article or notice", input.query)) {
      continue;
    }
    candidates.push(rankArticleSource(url, "Official article or notice", input.query));
  }

  const deduped = new Map<string, RankedSource>();
  for (const entry of candidates) {
    const key = entry.url.toLowerCase();
    const existing = deduped.get(key);
    if (!existing || entry.rank > existing.rank) {
      deduped.set(key, entry);
    }
  }

  const ranked = Array.from(deduped.values())
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 6);

  if (ranked.length > 0) return ranked;

  // No reliable article candidates found in retrieved context.
  return [];
}

function extractUrlsFromText(raw: string): string[] {
  const matches = raw.match(/https?:\/\/[^\s"'<>]+/g) || [];
  return matches
    .map((url) => url.replace(/[).,;!?]+$/g, "").trim())
    .filter(Boolean);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractSearchResultUrls(html: string): string[] {
  const urls = new Set<string>();

  const decodedHtml = decodeHtmlEntities(html);

  // DuckDuckGo result redirects commonly use /l/?...&uddg=<encoded target>
  const uddgMatches = decodedHtml.match(/uddg=([^&"'\s>]+)/g) || [];
  for (const match of uddgMatches) {
    const encoded = match.replace(/^uddg=/, "").trim();
    if (!encoded) continue;
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.startsWith("http")) urls.add(decoded);
    } catch {
      // ignore malformed encodings
    }
  }

  // Also parse any direct href values.
  const hrefMatches = decodedHtml.match(/href=["']([^"']+)["']/gi) || [];
  for (const attr of hrefMatches) {
    const href = attr.replace(/^href=["']/i, "").replace(/["']$/g, "").trim();
    if (!href) continue;
    const resolved = decodeDuckDuckGoUrl(href);
    if (resolved.startsWith("http")) urls.add(resolved);
  }

  // Fallback to generic absolute URL extraction from HTML.
  extractUrlsFromText(decodedHtml).forEach((u) => urls.add(decodeDuckDuckGoUrl(u)));

  return Array.from(urls).filter((u) => u.startsWith("http"));
}

function extractGoogleNewsRssUrls(xml: string): string[] {
  const urls = new Set<string>();
  const matches = xml.match(/<link>(https?:\/\/[^<]+)<\/link>/gi) || [];

  for (const m of matches) {
    const link = m.replace(/^<link>/i, "").replace(/<\/link>$/i, "").trim();
    if (!link) continue;
    if (/news\.google\.com/.test(link)) continue;
    urls.add(link);
  }

  return Array.from(urls);
}

function decodeDuckDuckGoUrl(url: string): string {
  if (!url) return "";

  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return parsed.toString();
  } catch {
    return url;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchArticlesFromWeb(query: string): Promise<{ rankedArticles: RankedSource[]; fetchedUrls: string[] }> {
  const searchQueries = [
    `${query} site:hindustantimes.com OR site:thehindu.com OR site:timesofindia.indiatimes.com OR site:deccanherald.com OR site:prajavani.net OR site:vijaykarnataka.com OR site:kannadaprabha.com OR site:udayavani.com OR site:zencitizen.in`,
    `${query} explained rules validity apply process`,
    `${query} kaveri marriage certificate witnesses esign net banking sro`,
  ];

  const collected = new Map<string, RankedSource>();
  const fetchedUrls = new Set<string>();

  for (const q of searchQueries) {
    try {
      const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
      const response = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      }, 4500);
      if (!response.ok) continue;

      const html = await response.text();
      const rawUrls = extractSearchResultUrls(html);

      rawUrls
        .filter((candidateUrl) => /^https?:\/\//i.test(candidateUrl))
        .forEach((candidateUrl) => fetchedUrls.add(candidateUrl));

      for (const candidateUrl of rawUrls) {
        if (!isStrictArticleCandidate(candidateUrl, "News article reference", query)) continue;

        const ranked = rankArticleSource(candidateUrl, "News article reference", query);
        const key = ranked.url.toLowerCase();
        const existing = collected.get(key);
        if (!existing || ranked.rank > existing.rank) {
          collected.set(key, ranked);
        }
      }
    } catch {
      // Keep best-effort behavior. No throw: article block should degrade gracefully.
    }
  }

  // Secondary source: Google News RSS for article-style links.
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
      `${query} (international driving permit OR idp) (india OR karnataka)`
    )}&hl=en-IN&gl=IN&ceid=IN:en`;
    const rssResp = await fetchWithTimeout(rssUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    }, 4500);

    if (rssResp.ok) {
      const rssText = await rssResp.text();
      const rssUrls = extractGoogleNewsRssUrls(rssText);

      rssUrls
        .filter((candidateUrl) => /^https?:\/\//i.test(candidateUrl))
        .forEach((candidateUrl) => fetchedUrls.add(candidateUrl));

      for (const candidateUrl of rssUrls) {
        if (!isStrictArticleCandidate(candidateUrl, "News article reference", query)) continue;

        const ranked = rankArticleSource(candidateUrl, "News article reference", query);
        const key = ranked.url.toLowerCase();
        const existing = collected.get(key);
        if (!existing || ranked.rank > existing.rank) {
          collected.set(key, ranked);
        }
      }
    }
  } catch {
    // Keep best-effort behavior. No throw: article block should degrade gracefully.
  }

  return {
    rankedArticles: Array.from(collected.values())
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 6),
    fetchedUrls: Array.from(fetchedUrls),
  };
}

function mergeRankedArticles(primary: RankedSource[], secondary: RankedSource[]): RankedSource[] {
  const deduped = new Map<string, RankedSource>();

  for (const article of [...primary, ...secondary]) {
    const key = article.url.toLowerCase();
    const existing = deduped.get(key);
    if (!existing || article.rank > existing.rank) {
      deduped.set(key, article);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 6);
}

function buildUserFriendlyInsights(
  keyPoints: Array<{ text: string }>,
  requirements: string[],
  query: string
): string[] {
  const fromRequirements = requirements
    .map((item) => normalizeLine(item))
    .filter((item) => item.length > 8)
    .slice(0, 3)
    .map((item) => `Requirement identified from official sources: ${item}`);

  const fromKeyPoints = keyPoints
    .map((kp) => normalizeLine(kp.text))
    .filter((line) => line.length > 20 && line.length < 200)
    .filter((line) => !isLikelyNoisyComment(line))
    .filter((line) => !isLikelyPromotional(line))
    .filter((line) => hasGovernmentProcessSignal(line) || hasQuerySignal(line, query))
    .filter((line) => !/\?\s*$/.test(line))
    .slice(0, 4)
    .map((line) => `Community-reported issue trend: ${line}`);

  return dedupeStrings([...fromRequirements, ...fromKeyPoints]).slice(0, 6);
}

function buildUserFriendlyNextSteps(input: {
  actionLinks: Array<{ label: string; url: string; purpose: string }>;
  requirements: string[];
  processingTime?: string;
}): string[] {
  const steps: string[] = [];

  const applyLink = input.actionLinks.find((a) => a.purpose === "apply") || input.actionLinks[0];
  if (applyLink) {
    steps.push(`Open the official application portal: ${applyLink.url}`);
  }

  const docLinks = input.actionLinks.filter((a) => a.purpose === "document").slice(0, 2);
  docLinks.forEach((doc) => {
    steps.push(`Review the official form/document before applying: ${doc.url}`);
  });

  input.requirements
    .map((req) => normalizeLine(req))
    .filter((req) => req.length > 8)
    .slice(0, 3)
    .forEach((req) => {
      steps.push(`Prepare required detail/document: ${req}`);
    });

  if (input.processingTime) {
    const cleaned = normalizeLine(input.processingTime, 120);
    if (cleaned && !/varies by service/i.test(cleaned)) {
      steps.push(`Plan follow-up based on the processing timeline: ${cleaned}`);
    }
  }

  const helpLink = input.actionLinks.find((a) => a.purpose === "help");
  if (helpLink) {
    steps.push(`Use the official help/status channel if submission fails: ${helpLink.url}`);
  }

  return dedupeStrings(steps).slice(0, 7);
}

function findFirstMatchingLine(lines: string[], pattern: RegExp): string | undefined {
  for (const line of lines) {
    const cleaned = normalizeLine(line, 260);
    if (!cleaned) continue;
    if (pattern.test(cleaned.toLowerCase())) return cleaned;
  }
  return undefined;
}

function buildFieldRealityChecklist(input: {
  query: string;
  service?: {
    requirements?: string[];
    fees?: string[];
    processingTime?: string;
    steps?: string[];
    contactInfo?: string;
  };
  actionLinks: Array<{ label: string; url: string; purpose: string }>;
  officialSourceUrls: string[];
  processSpecificOfficialUrls: string[];
  keyPoints: Array<{ text: string }>;
}): string[] {
  const requirements = (input.service?.requirements || []).map((x) => normalizeLine(x, 260)).filter(Boolean);
  const fees = (input.service?.fees || []).map((x) => normalizeLine(x, 220)).filter(Boolean);
  const steps = (input.service?.steps || []).map((x) => normalizeLine(x, 260)).filter(Boolean);
  const keyPointLines = (input.keyPoints || []).map((x) => normalizeLine(x.text, 260)).filter(Boolean);
  const allEvidenceLines = [...requirements, ...fees, ...steps, ...keyPointLines];

  const primarySource =
    input.processSpecificOfficialUrls[0] ||
    input.officialSourceUrls[0] ||
    input.actionLinks[0]?.url;

  const applyLink = input.actionLinks.find((a) => a.purpose === "apply")?.url;
  const helpLink = input.actionLinks.find((a) => a.purpose === "help")?.url;
  const statusLikeUrl = input.actionLinks.find((a) => /(status|track|token|acknowledg|sakala|grievance)/i.test(a.url))?.url;

  const officeLine = findFirstMatchingLine(allEvidenceLines, /(office|counter|taluk|tahsildar|bbmp|rto|sub-registrar|sro|nadakacheri|seva)/i);
  const stageLine = findFirstMatchingLine(allEvidenceLines, /(stage|step|verification|payment|certificate|approval|biometric|upload|submission)/i);
  const hiddenCostLine = findFirstMatchingLine(allEvidenceLines, /(stamp|stamp paper|notary|notar|affidavit|service charge|facilitation|xerox|photocopy)/i);
  const formatLine = findFirstMatchingLine(allEvidenceLines, /(pdf|jpeg|jpg|png|kb|mb|a4|scan|notarized|notarised|self[- ]attested|original)/i);
  const officeHoursLine = findFirstMatchingLine(allEvidenceLines, /(office hours|working hours|counter timing|timing|am|pm|monday|friday)/i);
  const bribeLine = findFirstMatchingLine(allEvidenceLines, /(bribe|agent|middleman|extra cash|speed money)/i);
  const perOfficeLine = findFirstMatchingLine(allEvidenceLines, /(visit|meet|submit at|verify at|counter|desk|office)/i);
  const rejectionLine = findFirstMatchingLine(allEvidenceLines, /(reject|rejection|returned|resubmit|mismatch|incomplete|invalid)/i);
  const deliveryLine = findFirstMatchingLine(allEvidenceLines, /(download|sms|physical copy|certificate issued|dispatch|delivered|mail)/i);

  const exactFee = fees.find((line) => /(₹\s*\d[\d,]*|rs\.?\s*\d[\d,]*|inr\s*\d[\d,]*)/i.test(line));
  const docList = requirements.slice(0, 8);

  const timeline = input.service?.processingTime
    ? normalizeLine(input.service.processingTime, 160)
    : undefined;
  const contactInfo = input.service?.contactInfo ? normalizeLine(input.service.contactInfo, 220) : undefined;

  const out: string[] = [];

  out.push(`1. Correct office(s) to visit: ${officeLine || "Not explicitly listed in retrieved sources for this query."}`);
  out.push(`2. Recommended route (online/offline): ${applyLink ? `Verified online route link: ${applyLink}` : "Not explicitly found in retrieved sources."}`);
  out.push(`3. Multi-stage process breakdown: ${stageLine || "Distinct stages (verification/payment/certificate) were not explicitly broken out in retrieved sources."}`);
  out.push(`4. Exact government fee: ${exactFee || "Exact fee amount not explicitly found in retrieved official data."}`);
  out.push(`5. Hidden/additional costs: ${hiddenCostLine || "No verified mention of stamp/notary/affidavit/add-on costs in retrieved sources."}`);
  out.push(`6. Complete document list: ${docList.length > 0 ? docList.join("; ") : "Not explicitly found in retrieved sources."}`);
  out.push(`7. Document format specifics: ${formatLine || "No explicit file format/size/notarization specification found in retrieved sources."}`);
  out.push(`8. Realistic timeline: ${timeline ? `Official timeline found: ${timeline}. Practical on-ground timeline was not explicitly found in retrieved sources.` : "Not explicitly found in retrieved sources."}`);
  out.push(`9. Office hours and counter timings: ${officeHoursLine || "Office-hour details were not found in retrieved sources."}`);
  out.push(`10. Official steps extracted: ${steps.length > 0 ? steps.join(" | ") : "Not explicitly found in retrieved sources."}`);
  out.push(`11. Official contact info: ${contactInfo || "Not explicitly found in retrieved sources."}`);
  out.push(`12. Bribe solicitation warning: ${bribeLine || "Not explicitly found in retrieved sources."}`);
  out.push(`13. What happens at each office: ${perOfficeLine || "Per-office handoff details were not explicitly documented in retrieved data."}`);
  out.push(`14. Common rejection/return reasons: ${rejectionLine || "No explicit rejection reasons found in retrieved sources."}`);
  out.push(`15. How to track application: ${statusLikeUrl || helpLink || "No explicit status-tracking portal identified in retrieved links."}`);
  out.push(`16. How output is delivered: ${deliveryLine || "Delivery mode (download/SMS/physical copy) not explicitly found in retrieved sources."}`);
  out.push(`17. Grievance redressal and escalation: ${helpLink ? `Official grievance/help link found: ${helpLink}` : "Sakala grievance path or RTI escalation details were not explicitly present in retrieved sources."}`);

  return out.map((line) => (primarySource ? formatClaimWithSource(line, primarySource) : line));
}

function buildVerifiedExtraDetails(input: {
  requirements: string[];
  fees: string[];
  processingTime?: string;
  steps?: string[];
  contactInfo?: string;
  officialSourceUrls: string[];
  processSpecificOfficialUrls: string[];
  fieldRealityLines?: string[];
}): string[] {
  const primarySource = input.processSpecificOfficialUrls[0] || input.officialSourceUrls[0];
  const lines: string[] = [];

  const cleanedReqs = input.requirements.map((x) => normalizeLine(x, 220)).filter(Boolean).slice(0, 6);
  const cleanedFees = input.fees.map((x) => normalizeLine(x, 220)).filter(Boolean).slice(0, 4);
  const cleanedSteps = (input.steps || []).map((x) => normalizeLine(x, 260)).filter(Boolean).slice(0, 6);
  const timeline = input.processingTime ? normalizeLine(input.processingTime, 160) : "";
  const contactInfo = input.contactInfo ? normalizeLine(input.contactInfo, 220) : "";

  if (cleanedReqs.length > 0) {
    cleanedReqs.forEach((r) => lines.push(r));
  }

  if (cleanedFees.length > 0) {
    cleanedFees.forEach((f) => lines.push(f));
  }

  if (cleanedSteps.length > 0) {
    cleanedSteps.forEach((step) => lines.push(step));
  }

  if (timeline) {
    lines.push(timeline);
  }

  if (contactInfo) {
    lines.push(contactInfo);
  }

  if (input.fieldRealityLines && input.fieldRealityLines.length > 0) {
    input.fieldRealityLines.slice(0, 15).forEach((item) => {
      const cleaned = normalizeLine(item, 260).replace(/^\d+\.\s*/, "");
      const separatorIndex = cleaned.indexOf(": ");
      const valueOnly = separatorIndex >= 0 ? cleaned.slice(separatorIndex + 2) : cleaned;
      lines.push(valueOnly || "Not explicitly found in retrieved sources.");
    });
  }

  if (lines.length === 0) {
    lines.push("No additional verified structured details were available in the retrieved context.");
  }

  return lines.map((line) => (primarySource ? formatClaimWithSource(line, primarySource) : line));
}

function buildFallbackInsights(input: {
  hasGovernmentService: boolean;
  requirementsCount: number;
  hasProcessingTime: boolean;
  officialSourceCount: number;
  hasVideos: boolean;
  hasTweets: boolean;
}): string[] {
  const insights: string[] = [];

  if (input.hasGovernmentService) {
    insights.push("Service-specific information was identified from retrieved government context.");
  }
  if (input.requirementsCount > 0) {
    insights.push(`Official requirements were extracted (${input.requirementsCount} items) and listed in this report.`);
  }
  if (input.hasProcessingTime) {
    insights.push("A processing timeline reference was found in retrieved service data.");
  }
  if (input.officialSourceCount > 0) {
    insights.push("Official portal links were identified and prioritized for guidance.");
  }
  if (input.hasVideos || input.hasTweets) {
    insights.push("Community resources were retrieved and should be used only as supplementary context.");
  }

  if (insights.length === 0) {
    insights.push("High-confidence insight lines were limited for this query; use the listed official sources as the primary reference.");
  }

  return dedupeStrings(insights).slice(0, 5);
}

function buildFallbackNextSteps(input: {
  actionLinks: Array<{ label: string; url: string; purpose: string }>;
  officialSourceUrls: string[];
  allSourceUrls: string[];
}): string[] {
  const steps: string[] = [];
  const preferred = input.actionLinks[0]?.url || input.officialSourceUrls[0] || input.allSourceUrls[0];

  if (preferred) {
    steps.push(`Open the primary official source first: ${preferred}`);
  }

  if (input.officialSourceUrls.length > 1) {
    steps.push("Cross-check service details across the listed official sources before submission.");
  }

  steps.push("Use the Official Links and Requirements sections in this report as the application checklist.");

  return dedupeStrings(steps).slice(0, 5);
}

function sanitizeReportLines(lines: string[]): string[] {
  return lines
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => !isDisallowedOutputLine(line));
}

function isBoilerplateArticleLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;

  const lower = trimmed.toLowerCase();
  const hardNoisePatterns = [
    /^markdown content:?$/i,
    /^(url source|published time|source|author|language|site|host|content):/i,
    /^sign in/i,
    /^follow us:?$/i,
    /^advertisement$/i,
    /^advertisements?$/i,
    /^epaper$/i,
    /^opens in new tab$/i,
    /^last updated\s*:/i,
    /^pic for representation\.?$/i,
    /^dh photo/i,
    /^home\s*(>|\/|$)/i,
    /^home\s*»/i,
    /^https?:\/\/\S+$/i,
    /^first day first show/i,
    /^today'?s cache/i,
    /^science for all/i,
    /^data point/i,
    /^health matters/i,
    /^the hindu on books/i,
    /^epaper$/i,
    /^follow us\s*:/i,
    /^photo credit\b/i,
    /^pic for representation\b/i,
    /^advertisement\s*$/i,
    /^advertisements?\s*$/i,
  ];

  if (hardNoisePatterns.some((pattern) => pattern.test(trimmed))) return true;
  if (/^!\[.*\]\(https?:\/\/[^)]+\)/.test(trimmed)) return true;
  if (/^\[\]\(https?:\/\//.test(trimmed)) return true;
  if ((trimmed.match(/https?:\/\//g) || []).length >= 2) return true;
  if (/^[\[\]().,/|:;\-+_ ]+$/.test(trimmed)) return true;

  const menuKeywordHits = [
    "india", "karnataka", "opinion", "world", "business", "sports", "video",
    "entertainment", "trending", "photos", "technology", "lifestyle", "assembly polls",
    "facebook", "instagram", "youtube", "telegram", "whatsapp", "sign in",
  ].filter((token) => lower.includes(token)).length;

  // Short menu-like lines are typically navigation/boilerplate.
  if (trimmed.length <= 90 && menuKeywordHits >= 2) return true;
  if (/^[a-z ]+\s>\s[a-z ]+$/i.test(trimmed)) return true;
  if (/^[^a-z0-9]*»[^a-z0-9]*$/i.test(trimmed)) return true;
  if ((trimmed.match(/»/g) || []).length >= 2) return true;

  return false;
}

function normalizeArticleParagraphs(lines: string[], maxBlocks = 80): string {
  const cleanedBlocks: string[] = [];
  const seen = new Set<string>();

  const pushBlock = (rawBlockLines: string[]) => {
    const block = rawBlockLines
      .map((line) => line.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1"))
      .map((line) => line.replace(/https?:\/\/\S+/g, ""))
      .map((line) => line.replace(/^#+\s*/, ""))
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((line) => !isBoilerplateArticleLine(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!block) return;
    if (block.length < 70) return;

    const sentenceCount = (block.match(/[.!?]/g) || []).length;
    const looksLikeProse = sentenceCount >= 1 || block.length >= 140;
    if (!looksLikeProse) return;

    const key = block.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    cleanedBlocks.push(block);
  };

  let currentBlock: string[] = [];
  for (const rawLine of lines) {
    const line = String(rawLine || "").replace(/\s+$/g, "");
    const trimmed = line.trim();

    if (!trimmed) {
      pushBlock(currentBlock);
      currentBlock = [];
      continue;
    }

    if (isBoilerplateArticleLine(trimmed)) continue;

    currentBlock.push(trimmed);
  }

  pushBlock(currentBlock);

  return cleanedBlocks.slice(0, maxBlocks).join("\n\n").trim();
}

type ArticleDetail = {
  url: string;
  title: string;
  content: string;
  extractedVia: "jina-reader" | "html";
};

function extractReadableJinaContent(rawText: string): string {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""));

  return normalizeArticleParagraphs(lines, 80);
}

function buildJinaReaderCandidates(url: string): string[] {
  const target = String(url || "").trim().replace(/^https?:\/\//i, "");
  if (!target) return [];

  return [
    `https://r.jina.ai/http://${target}`,
    `https://r.jina.ai/https://${target}`,
  ];
}

function parseJinaReaderArticleDetail(url: string, rawText: string): ArticleDetail | null {
  const normalizedLines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalizedLines.length === 0) return null;

  const titleLine = normalizedLines.find((line) => /^#\s+/.test(line))
    || normalizedLines.find((line) => /^title:\s*/i.test(line))
    || normalizedLines.find((line) => line.length >= 12 && line.length <= 160);

  const title = normalizeLine(
    String(titleLine || url)
      .replace(/^#\s+/, "")
      .replace(/^title:\s*/i, ""),
    160
  );

  const cleanedContent = extractReadableJinaContent(rawText);

  return {
    url,
    title,
    content: cleanedContent,
    extractedVia: "jina-reader",
  };
}

async function fetchJinaReaderText(url: string): Promise<string | null> {
  for (const candidate of buildJinaReaderCandidates(url)) {
    try {
      const response = await fetchWithTimeout(
        candidate,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            Accept: "text/plain, text/markdown, */*",
          },
        },
        7000
      );

      if (!response.ok) continue;

      const text = await response.text();
      if (text.trim().length >= 120) {
        return text;
      }
    } catch {
      // Try the next Jina Reader variant.
    }
  }

  return null;
}

async function fetchArticleDetail(url: string): Promise<ArticleDetail | null> {
  const jinaText = await fetchJinaReaderText(url);
  if (jinaText) {
    const jinaDetail = parseJinaReaderArticleDetail(url, jinaText);
    if (jinaDetail) return jinaDetail;
  }

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      },
      5000
    );

    if (!response.ok) return null;

    const html = await response.text();
    if (!html || html.length < 200) return null;

    const $ = load(html);
    const title = normalizeLine(
      $("meta[property='og:title']").attr("content") || $("title").text() || $("h1").first().text() || "Article reference",
      160
    );
    const description = normalizeLine(
      $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "",
      240
    );

    const paragraphs = $("article p, main p, .article-body p, .story-body p, .content p, p")
      .slice(0, 12)
      .map((_i, elem) => normalizeLine($(elem).text(), 220))
      .get()
      .filter((line) => line.length >= 50 && !isLikelyNoisyComment(line) && !isLikelyPromotional(line));

    const contentBlocks = [description, ...paragraphs]
      .map((line) => normalizeLine(line, 320))
      .filter(Boolean);

    const cleanedHtmlContent = normalizeArticleParagraphs(contentBlocks, 40);

    return {
      url,
      title,
      content: cleanedHtmlContent,
      extractedVia: "html",
    };
  } catch {
    return null;
  }
}

async function fetchArticleDetails(urls: string[]): Promise<ArticleDetail[]> {
  const uniqueUrls = Array.from(new Set(urls.filter(Boolean)));
  const results = await Promise.all(uniqueUrls.map((url) => fetchArticleDetail(url)));
  return results.filter((item): item is ArticleDetail => Boolean(item));
}

function splitReportSections(reportMarkdown: string): Array<{ heading: string; body: string }> {
  const lines = reportMarkdown.split("\n");
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  const flush = () => {
    if (!currentHeading) return;
    sections.push({ heading: currentHeading, body: currentBody.join("\n") });
  };

  for (const line of lines) {
    if (/^\*\*.+\*\*$/.test(line.trim())) {
      flush();
      currentHeading = line.trim();
      currentBody = [];
      continue;
    }
    if (currentHeading) currentBody.push(line);
  }

  flush();
  return sections;
}

function extractSourceUrlsFromSectionBody(body: string): string[] {
  const sourceSplit = body.split(/(?:^|\n)Sources:\s*\n/i);
  if (sourceSplit.length < 2) return [];
  const sourceBlock = sourceSplit.slice(1).join("\n");
  const matches = sourceBlock.match(/https?:\/\/[^\s)]+/g) || [];
  return Array.from(new Set(matches.map((url) => url.replace(/[.,;]+$/g, "").trim())));
}

function validateReportOrThrow(
  reportMarkdown: string,
  options?: { officialSourceUrls?: string[] }
): void {
  const requiredSectionPrefixes = [
    "**About This Service",
    "**Requirements & Process**",
    "**Verified Extra Details**",
    "**Official Links**",
    "**Related Articles (Context Only)**",
    "**Related YouTube Videos**",
    "**Key Insights**",
    "**Recommended Next Steps**",
    "**Articles Related",
    "**YouTube Related",
  ];

  const requiredOfficialSourceSections = [
    "**About This Service",
    "**Requirements & Process**",
    "**Official Links**",
    "**Recommended Next Steps**",
  ];

  const sections = splitReportSections(reportMarkdown);
  const officialSet = new Set((options?.officialSourceUrls || []).map((u) => u.toLowerCase()));

  for (const requiredPrefix of requiredSectionPrefixes) {
    const found = sections.find((s) => s.heading.startsWith(requiredPrefix));
    if (!found) {
      throw new Error(`Report generation blocked: missing required section ${requiredPrefix}`);
    }

    if (!/(?:^|\n)Information:\s*\n/i.test(found.body)) {
      throw new Error(`Report generation blocked: missing Information block in section ${requiredPrefix}`);
    }
    if (!/(?:^|\n)Sources:\s*\n/i.test(found.body)) {
      throw new Error(`Report generation blocked: missing Sources block in section ${requiredPrefix}`);
    }
  }

  for (const requiredPrefix of requiredOfficialSourceSections) {
    const found = sections.find((s) => s.heading.startsWith(requiredPrefix));
    if (!found) continue;
    const sectionUrls = extractSourceUrlsFromSectionBody(found.body);

    if (sectionUrls.length === 0) {
      throw new Error(`Report generation blocked: section ${requiredPrefix} has no source URLs.`);
    }

    if (officialSet.size > 0) {
      const hasOfficial = sectionUrls.some((u) => officialSet.has(u.toLowerCase()));
      if (!hasOfficial) {
        throw new Error(`Report generation blocked: section ${requiredPrefix} lacks official source URLs.`);
      }
    }
  }

  if (BANNED_OUTPUT_PATTERNS.some((pattern) => pattern.test(reportMarkdown))) {
    throw new Error("Report generation blocked: disallowed conversational or tool-status text detected.");
  }
}

const server = new MCPServer({
  name: "Zen-Citizen",
  title: "Zen-Citizen", // display name
  version: "1.0.0",
  description: "MCP server with MCP Apps integration",
  baseUrl: process.env.MCP_URL || "https://70qwsysdwu49.deploy.mcp-use.com", // Full base URL (e.g., https://myserver.com)
  favicon: "favicon.ico",
  websiteUrl: "https://mcp-use.com", // Can be customized later
  icons: [
    {
      src: "icon.svg",
      mimeType: "image/svg+xml",
      sizes: ["512x512"],
    },
  ],
});

/**
 * TOOL THAT RETURNS A WIDGET
 * The `widget` config tells mcp-use which widget component to render.
 * The `widget()` helper in the handler passes props to that component.
 * Docs: https://mcp-use.com/docs/typescript/server/mcp-apps
 */

// Fruits data — color values are Tailwind bg-[] classes used by the carousel UI
const fruits = [
  { fruit: "mango", color: "bg-[#FBF1E1] dark:bg-[#FBF1E1]/10" },
  { fruit: "pineapple", color: "bg-[#f8f0d9] dark:bg-[#f8f0d9]/10" },
  { fruit: "cherries", color: "bg-[#E2EDDC] dark:bg-[#E2EDDC]/10" },
  { fruit: "coconut", color: "bg-[#fbedd3] dark:bg-[#fbedd3]/10" },
  { fruit: "apricot", color: "bg-[#fee6ca] dark:bg-[#fee6ca]/10" },
  { fruit: "blueberry", color: "bg-[#e0e6e6] dark:bg-[#e0e6e6]/10" },
  { fruit: "grapes", color: "bg-[#f4ebe2] dark:bg-[#f4ebe2]/10" },
  { fruit: "watermelon", color: "bg-[#e6eddb] dark:bg-[#e6eddb]/10" },
  { fruit: "orange", color: "bg-[#fdebdf] dark:bg-[#fdebdf]/10" },
  { fruit: "avocado", color: "bg-[#ecefda] dark:bg-[#ecefda]/10" },
  { fruit: "apple", color: "bg-[#F9E7E4] dark:bg-[#F9E7E4]/10" },
  { fruit: "pear", color: "bg-[#f1f1cf] dark:bg-[#f1f1cf]/10" },
  { fruit: "plum", color: "bg-[#ece5ec] dark:bg-[#ece5ec]/10" },
  { fruit: "banana", color: "bg-[#fdf0dd] dark:bg-[#fdf0dd]/10" },
  { fruit: "strawberry", color: "bg-[#f7e6df] dark:bg-[#f7e6df]/10" },
  { fruit: "lemon", color: "bg-[#feeecd] dark:bg-[#feeecd]/10" },
];

server.tool(
  {
    name: "search-youtube",
    description: "Search YouTube videos and get comments related to a query",
    schema: z.object({
      query: z.string().describe("Search query for YouTube videos"),
    }),
  },
  async ({ query }: { query: string }) => {
    try {
      const results = await searchYouTube(query);
      const lines: string[] = [
        `YouTube search results for: ${query}`,
        `Videos: ${results.videos.length}`,
        `Comments: ${results.comments.length}`,
      ];
      const topVideos = results.videos.slice(0, 5);
      if (topVideos.length > 0) {
        lines.push("Top videos:");
        topVideos.forEach((v, i) => lines.push(`${i + 1}. ${v.title} | ${v.url}`));
      }

      const commentsByVideo = results.commentsByVideo || {};
      const commentSections = topVideos
        .map((video) => {
          const videoComments = (commentsByVideo[video.id] || results.comments.filter((c) => c.videoId === video.id))
            .filter((c) => normalizeLine(c.textDisplay, 220).length > 0)
            .slice(0, 2);
          return { video, comments: videoComments };
        })
        .filter((entry) => entry.comments.length > 0);

      if (commentSections.length > 0) {
        lines.push("Top comments from these videos:");
        commentSections.forEach((entry, i) => {
          lines.push(`${i + 1}. ${entry.video.title}`);
          entry.comments.forEach((comment) => {
            lines.push(
              `   - ${comment.authorDisplayName}: \"${normalizeLine(comment.textDisplay, 180)}\" (${comment.likeCount} likes)`
            );
          });
        });
      } else if (results.comments.length > 0) {
        // Fallback when comments cannot be mapped to videos (e.g. missing videoId in upstream payload).
        lines.push("Top comments:");
        results.comments
          .filter((c) => normalizeLine(c.textDisplay, 220).length > 0)
          .slice(0, 5)
          .forEach((comment, i) => {
            lines.push(
              `${i + 1}. ${comment.authorDisplayName}: \"${normalizeLine(comment.textDisplay, 180)}\" (${comment.likeCount} likes)`
            );
          });
      }

      return text(lines.join("\n"));
    } catch (error) {
      return text(`Error searching YouTube: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
);

/**
 * TWITTER SEARCH TOOL
 * Searches recent tweets related to a query
 * Requires: TWITTER_BEARER_TOKEN environment variable
 */
server.tool(
  {
    name: "search-twitter",
    description: "Search Twitter/X for tweets related to a query",
    schema: z.object({
      query: z.string().describe("Search query for Twitter/X"),
    }),
  },
  async ({ query }: { query: string }) => {
    try {
      const results = await searchTwitter(query);
      const lines: string[] = [
        `Twitter search results for: ${query}`,
        `Tweets: ${results.count}`,
      ];
      const topTweets = results.tweets.slice(0, 5);
      if (topTweets.length > 0) {
        lines.push("Top tweets:");
        topTweets.forEach((t, i) => lines.push(`${i + 1}. ${t.text.replace(/\s+/g, " ").slice(0, 180)} | ${t.url}`));
      }
      return text(lines.join("\n"));
    } catch (error) {
      return text(`Error searching Twitter: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
);

/**
 * ARTICLE SEARCH TOOL
 * Searches trusted news/article links related to a query
 */
server.tool(
  {
    name: "search-article",
    description: "Search article links related to a query with trust ranking",
    schema: z.object({
      query: z.string().describe("Search query to find relevant article links"),
    }),
  },
  async ({ query }: { query: string }) => {
    try {
      const result = await fetchArticlesFromWeb(query);
      const topArticles = result.rankedArticles.slice(0, 6);
      const articleDetails = await fetchArticleDetails([
        ...result.fetchedUrls,
        ...topArticles.map((article) => article.url),
      ]);
      const detailByUrl = new Map(articleDetails.map((detail) => [detail.url.toLowerCase(), detail]));

      const lines: string[] = [
        `Article search results for: ${query}`,
        `Articles found: ${topArticles.length}`,
      ];

      if (topArticles.length > 0) {
        lines.push("Top articles:");
        topArticles.forEach((article, i) => {
          lines.push(
            `${i + 1}. ${article.title} | Trust Rank: ${article.rank}/100 (${article.tier.toUpperCase()}) | ${article.url}`
          );
          const detail = detailByUrl.get(article.url.toLowerCase());
          if (detail) {
            if (detail.content) {
              lines.push("   - Full extracted content:");
              detail.content
                .split(/\n{2,}/)
                .map((block) => block.trim())
                .filter(Boolean)
                .slice(0, 120)
                .forEach((block) => {
                  lines.push(`     ${block}`);
                });
            }
          }
        });
      } else {
        lines.push("No reliable article links were found for this query.");
      }

      return text(lines.join("\n"));
    } catch (error) {
      return text(`Error searching articles: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
);

/**
 * QUORA FAQ SEARCH TOOL
 * Scrapes query-relevant Quora pages and returns only Q&A pairs.
 */
server.tool(
  {
    name: "search-quora-faq",
    description: "Search Quora and return only query-relevant FAQ style Q&A pairs",
    schema: z.object({
      query: z.string().describe("Query to find relevant Quora questions and answers"),
      limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of Q&A pairs to return"),
    }),
  },
  async ({ query, limit }: { query: string; limit?: number }) => {
    try {
      const result = await searchQuoraFAQs(query, limit ?? 5);
      const lines: string[] = [
        `Quora FAQs for: ${query}`,
        `Q&A pairs found: ${result.count}`,
      ];

      if (result.faqs.length > 0) {
        lines.push("Relevant Q&A:");
        result.faqs.forEach((faq, index) => {
          lines.push(`${index + 1}. Q: ${faq.question}`);
          lines.push(`   A: ${faq.answer}`);
          lines.push(`   Source: ${faq.url}`);
        });
      } else {
        lines.push("No relevant Quora Q&A pairs were found for this query.");
      }

      return text(lines.join("\n"));
    } catch (error) {
      return text(`Error searching Quora FAQs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
);

/**
 * RESEARCH AGENT TOOL - INDIA SPECIFIC
 * AI-powered research agent for Indian government services
 * PRIMARY: YouTube videos and comments
 * OPTIONAL: Twitter tweets (graceful fallback)
 * Analyzes with sentiment classification and credibility scoring
 * Searches only India-specific content and resources
 * Provides structured insights for ChatGPT to compose helpful responses
 */
const SOURCE_FORMAT_INSTRUCTIONS = `Use ONLY the information retrieved from the MCP server context — do not fabricate or guess any facts.

For every important piece of information, include the supporting source links.

Output Format for each section:

Information:
[content using only retrieved data]

Sources:
<Source URL 1>
<Source URL 2>
<Source URL 3>

Output Rules:
1. Always include the Sources block under every section.
2. Only use URLs that were returned by this tool — never invent URLs.
3. Do not remove, shorten, or rewrite any source URL.
4. Do not fabricate facts, steps, fees, or requirements not present in the retrieved data.
5. Every important claim must have a supporting source URL from the retrieved data.
6. Preserve the exact headings Information: and Sources: in every section.
7. Do NOT add conversational closers, offers, or follow-up prompts (for example: "If you want...", "Would you like...", "I can also...").
8. Do NOT include tool-trace or meta lines (for example: "Called tool", "I am checking...").
9. Output must always include a "Related YouTube Videos" section and list direct YouTube URLs in Information and Sources.
10. Add "Related Articles (Context Only)" after Official Links with trust ranking (Tier 1 highest), prioritizing major news domains (Hindustan Times, The Hindu, Times of India, Deccan Herald, and Kannada newspapers).
11. Immediately after "Related YouTube Videos", add links-only sections: "Articles Related — <query>" and "YouTube Related — <query>". In those two sections, list only live URLs in Information and Sources (no summaries).
12. Always include a "Verified Extra Details" section that surfaces any additional extracted facts such as office details, route, stages, fees, documents, format specifics, timeline, timings, risks, rejection reasons, tracking, delivery, and escalation when they are present in retrieved sources.
13. If any detail is unavailable, explicitly write "Not explicitly found in retrieved sources" for that detail instead of guessing.
14. Output must end with factual report sections only.`;

server.tool(
  {
    name: "research-government-query",
    description: "India-specific research agent for Indian government services with LIVE government portal extraction. IMPORTANT: (1) Uses AI to dynamically extract official government links for ANY query, (2) Automatically scrapes portals to extract forms, documents, requirements, and processing times, (3) Returns ONLY retrieved data — never fabricate facts, (4) Every section must include Sources block with real URLs. Process: Query → LLM identifies service → Web scraper extracts live portal data → Results returned with official links and documents.",
    schema: z.object({
      query: z.string().describe("Indian government service query (e.g., 'How do I get 10th marks card if I lost it?', 'How to apply for PAN card', 'International driving permit in bangalore')"),
      instructions: z.string().default(SOURCE_FORMAT_INSTRUCTIONS).describe("Formatting instructions. Defaults to Information/Sources format: every section has retrieved content followed by real source URLs. Do not override unless needed."),
    }),
  },
  async ({ query, instructions }: { query: string; instructions?: string }) => {
    try {
      const effectiveInstructions = instructions || SOURCE_FORMAT_INSTRUCTIONS;
      const result = await researchGovernmentQuery(query, effectiveInstructions);
      const rawActionLinks = buildActionLinks(result.governmentService as any);
      const actionLinks = filterActionLinksForQuery(rawActionLinks, query);
      const allResources = result.resources
        .map((r: any) => ({
          title: r.title,
          url: r.url,
          type: r.type,
          credibility: normalizeCredibilityForDisplay(r.type, r.url, r.credibility?.overall),
          author: r.metadata?.author || undefined,
          summary: r.metadata?.summary || undefined,
          topComments: (r.opinions || []).slice(0, 4).map((o: any) => ({
            text: o.text,
            sentiment: o.sentiment,
            label: o.label,
            likes: o.likes,
          })),
        }))
        .sort((a: any, b: any) => b.credibility - a.credibility);

      const topResources = allResources.slice(0, 10);

      const topVideos = allResources.filter((r: any) => r.type === "video").slice(0, 5);
      const topVideoLinks = topVideos.map((v: any) => ({ title: v.title, url: v.url, credibility: v.credibility }));
      const topTweets = allResources.filter((r: any) => r.type === "tweet").slice(0, 5);
      const topTweetLinks = topTweets.map((t: any) => ({ title: t.title, url: t.url, credibility: t.credibility }));
      const topKeyPoints = result.topKeyPoints.slice(0, 8);
      const baseFetchedUrls = Array.from(
        new Set(
          [
            ...allResources.map((r: any) => r.url),
            ...actionLinks.map((a: any) => a.url),
            ...rawActionLinks.map((a: any) => a.url),
            ...(result.governmentService?.officialLinks || []),
            ...(result.governmentService?.documentLinks || []),
          ].filter((u): u is string => Boolean(u && typeof u === "string"))
        )
      );

      const sections: string[] = [
        `> NOTE: All content below is sourced exclusively from the MCP server context. Do not add, invent, or replace any information or URLs.`,
        ``,
      ];
      const queryLabel = normalizeLine(query, 120);

      const officialSourceUrls = filterOfficialUrlsForQuery(Array.from(
        new Set([
          ...(result.governmentService?.officialLinks || []),
          ...(result.governmentService?.documentLinks || []),
          ...actionLinks.map((a: any) => a.url),
        ])
      ), query);
      const processSpecificOfficialUrls = selectProcessSpecificOfficialUrls(officialSourceUrls, query, 8);

      const userFriendlyInsights = buildUserFriendlyInsights(
        topKeyPoints,
        result.governmentService?.requirements || [],
        query
      );

      const rankedArticlesFromContext = extractRankedArticles({
        topResources,
        officialSourceUrls,
        query,
      });
      const webArticleResult = await fetchArticlesFromWeb(query);
      const rankedArticlesFromWeb = webArticleResult.rankedArticles;
      const rankedArticles = mergeRankedArticles(rankedArticlesFromContext, rankedArticlesFromWeb);
      const articleDetails = await fetchArticleDetails([
        ...rankedArticles.map((a) => a.url),
        ...webArticleResult.fetchedUrls,
      ]);
      const allSourceUrls = Array.from(
        new Set(
          [
            ...baseFetchedUrls,
            ...rankedArticles.map((a) => a.url),
            ...webArticleResult.fetchedUrls,
          ].filter((u): u is string => Boolean(u && typeof u === "string"))
        )
      );

      const userFriendlyNextSteps = buildUserFriendlyNextSteps({
        actionLinks,
        requirements: result.governmentService?.requirements || [],
        processingTime: result.governmentService?.processingTime,
      });

      const fallbackInsights = buildFallbackInsights({
        hasGovernmentService: Boolean(result.governmentService),
        requirementsCount: result.governmentService?.requirements?.length || 0,
        hasProcessingTime: Boolean(
          result.governmentService?.processingTime &&
            !/varies by service/i.test(result.governmentService.processingTime)
        ),
        officialSourceCount: officialSourceUrls.length,
        hasVideos: topVideos.length > 0,
        hasTweets: topTweets.length > 0,
      });

      const insightCandidates = userFriendlyInsights.length > 0 ? userFriendlyInsights : fallbackInsights;
      const finalInsights = verifyInsightLines(
        insightCandidates,
        result.governmentService?.requirements || [],
        officialSourceUrls
      );

      const fallbackNextSteps = buildFallbackNextSteps({
        actionLinks,
        officialSourceUrls,
        allSourceUrls,
      });

      const finalNextSteps = userFriendlyNextSteps.length > 0 ? userFriendlyNextSteps : fallbackNextSteps;

      const addSources = (urls: string[]) => {
        sections.push(`Sources:`);
        const unique = Array.from(new Set(urls.filter(Boolean)));
        if (unique.length > 0) {
          unique.forEach((url) => sections.push(url));
        } else {
          sections.push(`No source URLs available in retrieved data.`);
        }
        sections.push(``);
      };

      // Section: About This Service
      if (result.governmentService) {
        const svc = result.governmentService;
        sections.push(`**About This Service — ${svc.name}**`);
        sections.push(``);
        sections.push(`Information:`);
        sections.push(svc.description);
        if (svc.category) sections.push(`Category: ${svc.category}${svc.state ? ` | State: ${svc.state}` : ``}`);
        if (svc.officialLinks?.length) sections.push(`Official links found: ${svc.officialLinks.length}`);
        if (svc.documentLinks?.length) sections.push(`Official document/form links found: ${svc.documentLinks.length}`);
        if (svc.requirements?.length) sections.push(`Official requirements found: ${svc.requirements.length}`);
        if (svc.fees?.length) sections.push(`Official fee notes found: ${svc.fees.length}`);
        if (svc.steps?.length) sections.push(`Official steps extracted: ${svc.steps.slice(0, 5).join(" | ")}`);
        if (svc.contactInfo) sections.push(`Official contact info extracted: ${svc.contactInfo}`);
        sections.push(``);
        addSources(processSpecificOfficialUrls.length > 0 ? processSpecificOfficialUrls : (officialSourceUrls.length > 0 ? officialSourceUrls : allSourceUrls));
      } else {
        sections.push(`**About This Service — Query Overview**`);
        sections.push(``);
        sections.push(`Information:`);
        sections.push(`Service-specific structured details were limited in the retrieved context for this query.`);
        sections.push(``);
        addSources(officialSourceUrls.length > 0 ? officialSourceUrls : allSourceUrls);
      }

      // Section: Requirements
      if (result.governmentService && ((result.governmentService.requirements || []).length > 0 || (result.governmentService.fees || []).length > 0)) {
        const svc = result.governmentService;
        sections.push(`**Requirements & Process**`);
        sections.push(``);
        sections.push(`Information:`);
        const reqSource = processSpecificOfficialUrls[0] || officialSourceUrls[0];
        if (svc.processingTime) sections.push(formatClaimWithSource(`Processing Time: ${svc.processingTime}`, reqSource));
        if (svc.steps?.length) {
          svc.steps.slice(0, 5).forEach((step: string) => {
            sections.push(formatClaimWithSource(`Step: ${normalizeLine(step, 220)}`, reqSource));
          });
        }
        if (svc.contactInfo) sections.push(formatClaimWithSource(`Contact: ${svc.contactInfo}`, reqSource));
        if (svc.fees && svc.fees.length > 0) {
          svc.fees.slice(0, 4).forEach((feeLine: string) => {
            sections.push(formatClaimWithSource(`Fee detail: ${normalizeLine(feeLine, 220)}`, reqSource));
          });
        }
        svc.requirements.forEach((req: string) => sections.push(`- ${formatClaimWithSource(req, reqSource)}`));
        sections.push(``);
        const reqLinks = processSpecificOfficialUrls
          .filter((url) => isApplicationRelevantDocument(url) && !isPolicyOrMetaDocument(url))
          .slice(0, 6);
        addSources(reqLinks.length > 0 ? reqLinks : processSpecificOfficialUrls);
      } else {
        sections.push(`**Requirements & Process**`);
        sections.push(``);
        sections.push(`Information:`);
        sections.push(`- Requirements were not explicitly enumerated in retrieved service metadata.`);
        const reqLinks = processSpecificOfficialUrls
          .filter((url) => isApplicationRelevantDocument(url) && !isPolicyOrMetaDocument(url))
          .slice(0, 4);
        if (reqLinks.length > 0) {
          sections.push(`- Review these official form/process pages before application:`);
          reqLinks.forEach((url) => sections.push(`  - ${url}`));
        }
        sections.push(``);
        addSources(reqLinks.length > 0 ? reqLinks : (processSpecificOfficialUrls.length > 0 ? processSpecificOfficialUrls : officialSourceUrls));
      }

      // Section: Additional strict-evidence details (no inference)
      sections.push(`**Verified Extra Details**`);
      sections.push(``);
      sections.push(`Information:`);
      const checklistLines = buildFieldRealityChecklist({
        query,
        service: result.governmentService,
        actionLinks,
        officialSourceUrls,
        processSpecificOfficialUrls,
        keyPoints: topKeyPoints,
      });
      const extraLines = buildVerifiedExtraDetails({
        requirements: result.governmentService?.requirements || [],
        fees: result.governmentService?.fees || [],
        processingTime: result.governmentService?.processingTime,
        steps: result.governmentService?.steps || [],
        contactInfo: result.governmentService?.contactInfo,
        officialSourceUrls,
        processSpecificOfficialUrls,
        fieldRealityLines: checklistLines,
      });
      extraLines.forEach((line) => sections.push(`- ${line}`));
      sections.push(``);
      addSources(processSpecificOfficialUrls.length > 0 ? processSpecificOfficialUrls : (officialSourceUrls.length > 0 ? officialSourceUrls : allSourceUrls));

      // Section: Official Action Links
      if (actionLinks.length > 0) {
        sections.push(`**Official Links**`);
        sections.push(``);
        sections.push(`Information:`);
        const officialRanked = selectProcessSpecificOfficialUrls(actionLinks.map((a: any) => a.url), query, 8);
        const actionByUrl = new Map(actionLinks.map((a: any) => [a.url, a]));
        officialRanked.forEach((url: string) => {
          const a: any = actionByUrl.get(url);
          sections.push(`- ${(a?.label || "Official process link")}: ${url}`);
        });
        sections.push(``);
        addSources(officialRanked.length > 0 ? officialRanked : actionLinks.map((a: any) => a.url));
      } else {
        sections.push(`**Official Links**`);
        sections.push(``);
        sections.push(`Information:`);
        if (officialSourceUrls.length > 0) {
          officialSourceUrls.forEach((url) => sections.push(`- Official portal: ${url}`));
        } else {
          sections.push(`- No explicit official action link was extracted for this query.`);
        }
        sections.push(``);
        addSources(officialSourceUrls.length > 0 ? officialSourceUrls : allSourceUrls);
      }

      // Section: Ranked Articles (placed after official links)
      sections.push(`**Related Articles (Context Only)**`);
      sections.push(``);
      sections.push(`Information:`);
      if (rankedArticles.length > 0) {
        rankedArticles.forEach((article, i) => {
          const detail = articleDetails.find((item) => item.url === article.url);
          sections.push(
            `${i + 1}. ${article.title} | Trust Rank: ${article.rank}/100 (${article.tier.toUpperCase()}) | Reason: ${article.rationale}`
          );
          sections.push(`   - Article link: ${article.url}`);
          if (detail?.content) {
            sections.push(`   - Full extracted content:`);
            detail.content
              .split(/\n{2,}/)
              .map((block) => block.trim())
              .filter(Boolean)
              .slice(0, 120)
              .forEach((block) => sections.push(`     ${block}`));
          }
        });
      } else {
        sections.push(`- No article-style references were retrieved for this query in the current context.`);
      }
      sections.push(``);
      addSources(rankedArticles.map((a) => a.url));

      // Section: YouTube Videos (always present)
      sections.push(`**Related YouTube Videos**`);
      sections.push(``);
      sections.push(`Information:`);
      if (topVideos.length > 0) {
        topVideos.forEach((v: any, i: number) => {
          sections.push(`${i + 1}. ${v.title}`);
          sections.push(`   - Video link: ${v.url}`);
          const comments = (v.topComments || [])
            .filter((c: any) => c?.label === "information")
            .map((c: any) => ({ ...c, text: normalizeLine(String(c.text), 160) }))
            .filter((c: any) => c.text && !isLikelyNoisyComment(c.text) && !isLikelyPromotional(c.text))
            .filter((c: any) => hasGovernmentProcessSignal(c.text) || hasQuerySignal(c.text, query))
            .slice(0, 2);
          comments.forEach((c: any) => sections.push(`   - "${c.text}" (${c.likes} likes)`));
        });
      } else {
        sections.push(`- No related YouTube videos were retrieved from the current context for this query.`);
      }
      sections.push(``);
      addSources(topVideos.map((v: any) => v.url));

      // Section: Links-only articles for downstream chat clients
      sections.push(`**Articles Related — ${queryLabel}**`);
      sections.push(``);
      sections.push(`Information:`);
      const articleOnlyLinks = Array.from(new Set(rankedArticles.map((a) => a.url).filter(Boolean))).slice(0, 8);
      if (articleOnlyLinks.length > 0) {
        articleOnlyLinks.forEach((url, i) => sections.push(`${i + 1}. ${url}`));
      } else {
        sections.push(`- No article links were retrieved for this query.`);
      }
      sections.push(``);
      addSources(articleOnlyLinks);

      // Section: Links-only videos for downstream chat clients
      sections.push(`**YouTube Related — ${queryLabel}**`);
      sections.push(``);
      sections.push(`Information:`);
      const youtubeOnlyLinks = Array.from(new Set(topVideos.map((v: any) => v.url).filter(Boolean))).slice(0, 8);
      if (youtubeOnlyLinks.length > 0) {
        youtubeOnlyLinks.forEach((url, i) => sections.push(`${i + 1}. ${url}`));
      } else {
        sections.push(`- No YouTube links were retrieved for this query.`);
      }
      sections.push(``);
      addSources(youtubeOnlyLinks);

      // Section: All fetched links (must include every fetched URL for this query)
      sections.push(`**All Fetched Links — ${queryLabel}**`);
      sections.push(``);
      sections.push(`Information:`);
      if (allSourceUrls.length > 0) {
        allSourceUrls.forEach((url, i) => sections.push(`${i + 1}. ${url}`));
      } else {
        sections.push(`- No links were fetched for this query.`);
      }
      sections.push(``);
      addSources(allSourceUrls);

      // Section: Twitter/X
      if (topTweets.length > 0) {
        sections.push(`**Community Discussion (Twitter/X)**`);
        sections.push(``);
        sections.push(`Information:`);
        topTweets.forEach((t: any, i: number) => sections.push(`${i + 1}. ${t.title.substring(0, 140)}`));
        sections.push(``);
        addSources(topTweets.map((t: any) => t.url));
      }

      // Section: Key Insights
      sections.push(`**Key Insights**`);
      sections.push(``);
      sections.push(`Information:`);
      finalInsights.forEach((item: string) => sections.push(`- ${item}`));
      sections.push(``);
      addSources(officialSourceUrls.length > 0 ? officialSourceUrls : allSourceUrls);

      // Section: Recommended Next Steps
      sections.push(`**Recommended Next Steps**`);
      sections.push(``);
      sections.push(`Information:`);
      const nextStepSource = processSpecificOfficialUrls[0] || officialSourceUrls[0];
      finalNextSteps.forEach((step: string, i: number) =>
        sections.push(`${i + 1}. ${formatClaimWithSource(step, nextStepSource)}`)
      );
      sections.push(``);
      addSources(processSpecificOfficialUrls.length > 0 ? processSpecificOfficialUrls : (officialSourceUrls.length > 0 ? officialSourceUrls : allSourceUrls));

      // Section: Detailed Evidence Ledger
      // This section is intentionally exhaustive to maximize grounded detail for downstream clients.
      if (topResources.length > 0) {
        sections.push(`**Detailed Evidence Ledger**`);
        sections.push(``);
        sections.push(`Information:`);
        topResources.forEach((r: any, i: number) => {
          sections.push(`${i + 1}. Title: ${r.title}`);
          sections.push(`   Type: ${r.type}`);
          sections.push(`   Credibility: ${Math.round(r.credibility)}/100`);
          if (r.author) sections.push(`   Author/Channel: ${r.author}`);
          if (r.summary) {
            const cleanedSummary = String(r.summary).replace(/\s+/g, " ").trim();
            if (!isLikelyPromotional(cleanedSummary) && !isLikelyNoisyComment(cleanedSummary) && (hasGovernmentProcessSignal(cleanedSummary) || hasQuerySignal(cleanedSummary, query))) {
              sections.push(`   Summary: ${cleanedSummary}`);
            }
          }
          const comments = (r.topComments || [])
            .filter((c: any) => c?.label === "information")
            .map((c: any) => ({ ...c, text: normalizeLine(String(c.text), 220) }))
            .filter((c: any) => c.text && !isLikelyNoisyComment(c.text) && !isLikelyPromotional(c.text))
            .filter((c: any) => hasGovernmentProcessSignal(c.text) || hasQuerySignal(c.text, query))
            .slice(0, 3);
          if (comments.length > 0) {
            sections.push(`   Key comments:`);
            comments.forEach((c: any) =>
              sections.push(`   - "${c.text}" (${c.likes} likes)`)
            );
          }
          sections.push(``);
        });
        addSources(topResources.map((r: any) => r.url));
      }

      const sanitizedLines = sanitizeReportLines(sections);
      const responseMarkdown = sanitizedLines.join("\n");
      validateReportOrThrow(responseMarkdown, { officialSourceUrls: processSpecificOfficialUrls.length > 0 ? processSpecificOfficialUrls : officialSourceUrls });

      // Format for ChatGPT consumption
      const formattedResult = {
        query: result.query,
        governmentService: result.governmentService ? {
          name: result.governmentService.name,
          officialLinks: result.governmentService.officialLinks,
          documentLinks: result.governmentService.documentLinks,
          processingTime: result.governmentService.processingTime,
          requirements: result.governmentService.requirements,
          fees: result.governmentService.fees,
        } : undefined,
        opinionDistribution: result.opinionDistribution,
        averageCredibility: result.averageCredibility,
        topKeyPoints: result.topKeyPoints.map((kp: any) => ({
          text: kp.text,
          frequency: kp.frequency,
          sentiment: kp.sentiment,
        })),
        topResources,
        topVideos,
        topVideoLinks,
        topTweets,
        topTweetLinks,
        recommendedActions: result.recommendedActions,
        actionLinks,
        responseMarkdown,
      };

      // Return plain text markdown to maximize compatibility across clients.
      // Some clients ignore `markdown()` but display `text()` content reliably.
      return text(toPlainTextReport(responseMarkdown));
    } catch (error) {
      return text(`REQUEST_FAILED: MCP tool output unavailable or invalid.`);
    }
  }
);

server.listen().then(() => {
  console.log(`Server running`);
});
