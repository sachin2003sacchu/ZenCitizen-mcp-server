import "dotenv/config";
import { MCPServer, object, text, widget, markdown } from "mcp-use/server";
import { z } from "zod";
import { searchYouTube, searchTwitter, searchBothPlatforms, researchGovernmentQuery } from "./api.js";
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

const REPORT_START = "REPORT_START";
const REPORT_END = "REPORT_END";

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

function rankArticleSource(url: string, title?: string): RankedSource {
  const safeTitle = normalizeLine(title || "Article reference", 140);
  const lower = url.toLowerCase();
  let rank = 25;
  const reasons: string[] = [];

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
}): RankedSource[] {
  const candidates: RankedSource[] = [];

  for (const resource of input.topResources) {
    // Prefer article-like resources and trusted news domains.
    if (!["guide", "forum", "official", "tweet"].includes(resource.type)) continue;
    if (!resource.url) continue;
    if (!isPreferredNewsDomain(resource.url) && !isLikelyArticlePage(resource.url)) continue;
    candidates.push(rankArticleSource(resource.url, resource.title));
  }

  for (const url of input.officialSourceUrls) {
    if (!url) continue;
    if (!isLikelyArticlePage(url)) {
      continue;
    }
    candidates.push(rankArticleSource(url, "Official article or notice"));
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

async function fetchArticlesFromWeb(query: string): Promise<RankedSource[]> {
  const searchQueries = [
    `${query} site:hindustantimes.com OR site:thehindu.com OR site:timesofindia.indiatimes.com OR site:deccanherald.com OR site:prajavani.net OR site:vijaykarnataka.com OR site:kannadaprabha.com OR site:udayavani.com`,
    `${query} Karnataka news`,
  ];

  const collected = new Map<string, RankedSource>();

  for (const q of searchQueries) {
    try {
      const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      });
      if (!response.ok) continue;

      const html = await response.text();
      const rawUrls = extractUrlsFromText(html)
        .map((u) => decodeDuckDuckGoUrl(u))
        .filter((u) => u.startsWith("http"));

      for (const candidateUrl of rawUrls) {
        const lower = candidateUrl.toLowerCase();
        if (/(youtube\.com|twitter\.com|x\.com|duckduckgo\.com)/.test(lower)) continue;
        if (!isPreferredNewsDomain(candidateUrl) && !isLikelyArticlePage(candidateUrl)) continue;

        const ranked = rankArticleSource(candidateUrl, "News article reference");
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

  return Array.from(collected.values())
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 6);
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
  requirements: string[]
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
    "**Official Links**",
    "**Related Articles (Context Only)**",
    "**Related YouTube Videos**",
    "**Key Insights**",
    "**Recommended Next Steps**",
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
    name: "search-tools",
    description: "Search for fruits and display the results in a visual widget",
    schema: z.object({
      query: z.string().optional().describe("Search query to filter fruits"),
    }),
    widget: {
      name: "product-search-result",
      invoking: "Searching...",
      invoked: "Results loaded",
    },
  },
  async ({ query }: { query?: string }) => {
    const results = fruits.filter(
      (f) => !query || f.fruit.toLowerCase().includes(query.toLowerCase())
    );

    // let's emulate a delay to show the loading state
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return widget({
      props: { query: query ?? "", results },
      output: text(
        `Found ${results.length} fruits matching "${query ?? "all"}"`
      ),
    });
  }
);

server.tool(
  {
    name: "get-fruit-details",
    description: "Get detailed information about a specific fruit",
    schema: z.object({
      fruit: z.string().describe("The fruit name"),
    }),
    outputSchema: z.object({
      fruit: z.string(),
      color: z.string(),
      facts: z.array(z.string()),
    }),
  },
  async ({ fruit }: { fruit: string }) => {
    const found = fruits.find(
      (f) => f.fruit?.toLowerCase() === fruit?.toLowerCase()
    );
    return object({
      fruit: found?.fruit ?? fruit,
      color: found?.color ?? "unknown",
      facts: [
        `${fruit} is a delicious fruit`,
        `Color: ${found?.color ?? "unknown"}`,
      ],
    });
  }
);


/**
 * YOUTUBE SEARCH TOOL
 * Searches YouTube videos and fetches top comments
 * Requires: YOUTUBE_API_KEY environment variable
 */
server.tool(
  {
    name: "search-youtube",
    description: "Search YouTube videos and get comments related to a query",
    schema: z.object({
      query: z.string().describe("Search query for YouTube videos"),
    }),
    widget: {
      name: "api-results",
      invoking: "Searching YouTube...",
      invoked: "YouTube results loaded",
    },
  },
  async ({ query }: { query: string }) => {
    try {
      const results = await searchYouTube(query);
      return widget({
        props: {
          query,
          youtubeResults: results,
          twitterResults: null,
        },
        output: text(
          `Found ${results.videos.length} YouTube videos and ${results.comments.length} comments for "${query}"`
        ),
      });
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
    widget: {
      name: "api-results",
      invoking: "Searching Twitter...",
      invoked: "Twitter results loaded",
    },
  },
  async ({ query }: { query: string }) => {
    try {
      const results = await searchTwitter(query);
      return widget({
        props: {
          query,
          youtubeResults: null,
          twitterResults: results,
        },
        output: text(`Found ${results.count} tweets for "${query}"`),
      });
    } catch (error) {
      return text(`Error searching Twitter: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
);

/**
 * COMBINED SEARCH TOOL
 * Searches both YouTube and Twitter for a query
 * Requires: YOUTUBE_API_KEY and TWITTER_BEARER_TOKEN environment variables
 */
server.tool(
  {
    name: "search-all",
    description: "Search YouTube videos, comments, and Twitter tweets for a specific query across both platforms",
    schema: z.object({
      query: z.string().describe("Search query to find content on YouTube and Twitter"),
    }),
    widget: {
      name: "api-results",
      invoking: "Searching YouTube and Twitter...",
      invoked: "Results loaded",
    },
  },
  async ({ query }: { query: string }) => {
    try {
      const { youtube, twitter, errors } = await searchBothPlatforms(query);
      
      const errorMsg = errors.length > 0 ? `\nWarnings: ${errors.join(", ")}` : "";
      const youtubeCount = youtube?.videos.length ?? 0;
      const twitterCount = twitter?.tweets.length ?? 0;
      
      return widget({
        props: {
          query,
          youtubeResults: youtube || null,
          twitterResults: twitter || null,
        },
        output: text(
          `Found ${youtubeCount} YouTube videos and ${twitterCount} tweets for "${query}"${errorMsg}`
        ),
      });
    } catch (error) {
      return text(`Error searching: ${error instanceof Error ? error.message : String(error)}`);
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
11. Output must end with factual report sections only.`;

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
      const topResources = result.resources
        .slice(0, 10)
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

      const topVideos = topResources.filter((r: any) => r.type === "video").slice(0, 5);
      const topVideoLinks = topVideos.map((v: any) => ({ title: v.title, url: v.url, credibility: v.credibility }));
      const topTweets = topResources.filter((r: any) => r.type === "tweet").slice(0, 5);
      const topTweetLinks = topTweets.map((t: any) => ({ title: t.title, url: t.url, credibility: t.credibility }));
      const topKeyPoints = result.topKeyPoints.slice(0, 8);
      const allSourceUrls = Array.from(
        new Set(
          [
            ...topResources.map((r: any) => r.url),
            ...actionLinks.map((a: any) => a.url),
            ...(result.governmentService?.officialLinks || []),
            ...(result.governmentService?.documentLinks || []),
          ].filter((u): u is string => Boolean(u && typeof u === "string"))
        )
      );

      const sections: string[] = [
        `> NOTE: All content below is sourced exclusively from the MCP server context. Do not add, invent, or replace any information or URLs.`,
        ``,
      ];

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
        result.governmentService?.requirements || []
      );

      const rankedArticlesFromContext = extractRankedArticles({
        topResources,
        officialSourceUrls,
      });
      const rankedArticlesFromWeb = await fetchArticlesFromWeb(query);
      const rankedArticles = mergeRankedArticles(rankedArticlesFromContext, rankedArticlesFromWeb);

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
      if (result.governmentService && result.governmentService.requirements.length > 0) {
        const svc = result.governmentService;
        sections.push(`**Requirements & Process**`);
        sections.push(``);
        sections.push(`Information:`);
        const reqSource = processSpecificOfficialUrls[0] || officialSourceUrls[0];
        if (svc.processingTime) sections.push(formatClaimWithSource(`Processing Time: ${svc.processingTime}`, reqSource));
        svc.requirements.forEach((req: string) => sections.push(`- ${formatClaimWithSource(req, reqSource)}`));
        sections.push(``);
        const reqLinks = processSpecificOfficialUrls
          .filter((url) => isApplicationRelevantDocument(url) && !isPolicyOrMetaDocument(url))
          .slice(0, 6);
        addSources(reqLinks.length > 0 ? reqLinks : processSpecificOfficialUrls);
      }

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
          sections.push(
            `${i + 1}. ${article.title} | Trust Rank: ${article.rank}/100 (${article.tier.toUpperCase()}) | Reason: ${article.rationale}`
          );
          sections.push(`   - Article link: ${article.url}`);
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
            .slice(0, 2);
          comments.forEach((c: any) => sections.push(`   - "${c.text}" (${c.likes} likes)`));
        });
      } else {
        sections.push(`- No related YouTube videos were retrieved from the current context for this query.`);
      }
      sections.push(``);
      addSources(topVideos.map((v: any) => v.url));

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
            if (!isLikelyPromotional(cleanedSummary)) {
              sections.push(`   Summary: ${cleanedSummary}`);
            }
          }
          const comments = (r.topComments || [])
            .filter((c: any) => c?.label === "information")
            .map((c: any) => ({ ...c, text: normalizeLine(String(c.text), 220) }))
            .filter((c: any) => c.text && !isLikelyNoisyComment(c.text) && !isLikelyPromotional(c.text))
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

      const envelopedReport = `${REPORT_START}\n${responseMarkdown}\n${REPORT_END}`;

      // Format for ChatGPT consumption
      const formattedResult = {
        query: result.query,
        governmentService: result.governmentService ? {
          name: result.governmentService.name,
          officialLinks: result.governmentService.officialLinks,
          documentLinks: result.governmentService.documentLinks,
          processingTime: result.governmentService.processingTime,
          requirements: result.governmentService.requirements,
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
      return text(envelopedReport);
    } catch (error) {
      return text(`REQUEST_FAILED: MCP tool output unavailable or invalid.`);
    }
  }
);

server.listen().then(() => {
  console.log(`Server running`);
});
