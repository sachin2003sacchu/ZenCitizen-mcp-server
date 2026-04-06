import axios from "axios";
import { load } from "cheerio";

/**
 * Extracted document/form information
 */
export interface ScrapedDocument {
  title: string;
  url: string;
  type: "form" | "pdf" | "guide" | "application" | "document" | "requirement" | "faq";
  description?: string;
}

/**
 * Extracted page information
 */
export interface ScrapedPageInfo {
  title: string;
  url: string;
  description: string;
  documents: ScrapedDocument[];
  requirements?: string[];
  fees?: string[];
  processingTime?: string;
  steps?: string[];
  contactInfo?: string;
  faqLinks?: string[];
}

/**
 * Dynamic Web Scraper
 * Fetches and extracts information from government portals
 */
export async function scrapeGovernmentPortal(url: string): Promise<ScrapedPageInfo | null> {
  try {
    // Validate URL
    const urlObj = new URL(url);
    if (!urlObj.hostname.includes("gov.in") && !urlObj.hostname.includes("nic.in")) {
      console.warn("[Scraper] Skipping non-government URL:", url);
      return null;
    }

    console.log("[Scraper] Fetching:", url);

    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      maxRedirects: 5
    });

    const html = response.data;
    if (!html || typeof html !== 'string') {
      console.warn("[Scraper] No HTML content returned");
      return null;
    }

    const $ = load(html);
    const pageTitle = $("title").text() || $("h1").first().text() || "Untitled";

    // Extract key information
    const documents = extractDocuments($, url);
    const requirements = extractRequirements($);
    const fees = extractFeeInfo($);
    const processingTime = extractProcessingTime($);
    const steps = extractSteps($);
    const contactInfo = extractContactInfo($);
    const faqLinks = extractFAQLinks($);

    console.log("[Scraper] Successfully scraped:", {
      url,
      title: pageTitle,
      documentsFound: documents.length,
      requirementsFound: requirements.length
    });

    return {
      title: pageTitle,
      url,
      description: extractDescription($),
      documents,
      requirements: requirements.length > 0 ? requirements : undefined,
      fees: fees.length > 0 ? fees : undefined,
      processingTime: processingTime || undefined,
      steps: steps.length > 0 ? steps : undefined,
      contactInfo: contactInfo || undefined,
      faqLinks: faqLinks.length > 0 ? faqLinks : undefined
    };

  } catch (err) {
    const errorMsg = (err as any)?.message || String(err);
    console.warn("[Scraper] Failed to scrape:", url, errorMsg);
    return null;
  }
}

/**
 * Extract document/form links
 */
function extractDocuments($: any, baseUrl: string): ScrapedDocument[] {
  const documents: ScrapedDocument[] = [];
  const seen = new Set<string>();

  // Search for links that look like documents/forms
  const documentKeywords = [
    "form", "application", "download", "pdf", "document", "checklist",
    "guidelines", "procedure", "requirement", "howto", "how-to", "apply",
    "submit", "upload", "file", "certificate", "form16", "challan",
    "affidavit", "deed", "invoice", "receipt"
  ];

  $("a[href]").each((_i: number, elem: any) => {
    const href = $(elem).attr("href");
    const text = $(elem).text().trim();

    if (!href || seen.has(href)) return;

    const lowerHref = href.toLowerCase();
    const lowerText = text.toLowerCase();

    // Check if link looks like a document
    const isDocument = 
      lowerHref.includes(".pdf") ||
      documentKeywords.some(kw => lowerHref.includes(kw) || lowerText.includes(kw));

    if (isDocument && text.length > 3) {
      // Resolve relative URLs
      const absoluteUrl = resolveUrl(href, baseUrl);
      
      if (absoluteUrl && !seen.has(absoluteUrl)) {
        seen.add(absoluteUrl);

        // Determine document type
        let type: ScrapedDocument["type"] = "document";
        if (lowerHref.includes(".pdf")) type = "pdf";
        else if (lowerText.includes("form")) type = "form";
        else if (lowerText.includes("guide")) type = "guide";
        else if (lowerText.includes("apply")) type = "application";
        else if (lowerText.includes("require")) type = "requirement";

        documents.push({
          title: text,
          url: absoluteUrl,
          type,
          description: extractNearbyText($, elem)
        });
      }
    }
  });

  return documents.slice(0, 15);  // Limit to 15 documents
}

/**
 * Extract requirements section
 */
function extractRequirements($: any): string[] {
  const requirementHeadings = /(requirement|eligib|document(s)? needed|mandatory|proof|witness|address proof|age proof)/i;
  const raw: string[] = [];

  // Collect items under heading-like blocks first.
  $("h1, h2, h3, h4, strong, b").each((_i: number, elem: any) => {
    const heading = $(elem).text().trim();
    if (!requirementHeadings.test(heading)) return;

    const section = $(elem).parent();
    section.find("li, p").slice(0, 16).each((_j: number, item: any) => {
      const text = normalizeExtractedText($(item).text());
      if (isUsefulRequirementLine(text)) raw.push(text);
    });
  });

  // Fallback: pick requirement-looking list lines from the page.
  if (raw.length === 0) {
    $("li, p").slice(0, 300).each((_i: number, elem: any) => {
      const text = normalizeExtractedText($(elem).text());
      if (!isUsefulRequirementLine(text)) return;
      if (/(require|mandatory|must|address proof|age proof|witness|document|certificate)/i.test(text)) {
        raw.push(text);
      }
    });
  }

  return dedupeLines(raw).slice(0, 12);
}

function extractFeeInfo($: any): string[] {
  const lines: string[] = [];

  $("li, p, td").slice(0, 500).each((_i: number, elem: any) => {
    const text = normalizeExtractedText($(elem).text());
    if (!text) return;
    if (!/(fee|fees|charge|charges|cost|payment|₹|rs\.?\s*\d+)/i.test(text)) return;
    if (text.length < 8 || text.length > 220) return;
    lines.push(text);
  });

  return dedupeLines(lines).slice(0, 8);
}

/**
 * Extract processing time
 */
function extractProcessingTime($: any): string | null {
  const candidates: string[] = [];
  const timeSignal = /(processing\s*time|timeline|turnaround|takes?|working\s*day|approved|verification|issued|download)/i;
  const durationSignal = /(\d+\s*(?:-|to)?\s*\d*\s*(?:working\s*)?(?:day|days|week|weeks|month|months|hour|hours))/i;

  $("li, p, td").slice(0, 500).each((_i: number, elem: any) => {
    const text = normalizeExtractedText($(elem).text());
    if (!text || text.length > 240) return;
    if (!timeSignal.test(text) && !durationSignal.test(text)) return;
    const match = text.match(durationSignal);
    if (match?.[1]) {
      candidates.push(`${text}`);
    }
  });

  if (candidates.length > 0) {
    return dedupeLines(candidates)[0];
  }

  return null;
}

/**
 * Extract step-by-step procedure
 */
function extractSteps($: any): string[] {
  const steps: string[] = [];

  // Look for numbered lists or "step" keywords
  $("ol li, .step, [class*='step'], [id*='step']").slice(0, 8).each((_i: number, elem: any) => {
    const text = $(elem).text().trim();
    if (text.length > 10 && text.length < 300) {
      steps.push(text);
    }
  });

  // If no steps found, try to extract from text
  if (steps.length === 0) {
    const stepsSection = $("*").filter((_i: number, el: any) => {
      const text = $(el).text().toLowerCase();
      return text.includes("step") || text.includes("procedure") || text.includes("how to apply");
    }).first().parent();

    stepsSection.find("li, p").slice(0, 8).each((_i: number, elem: any) => {
      const text = $(elem).text().trim();
      if (text.length > 10 && steps.length < 8) {
        steps.push(text);
      }
    });
  }

  return steps;
}

/**
 * Extract contact information
 */
function extractContactInfo($: any): string | null {
  // Look for phone, email, address
  const pageText = $.text();

  // Phone pattern
  const phoneMatch = pageText.match(/(?:\+91|0)\s*[\d\s\-()]+/);
  if (phoneMatch) {
    return `Phone: ${phoneMatch[0].trim()}`;
  }

  // Email pattern
  const emailMatch = pageText.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) {
    return `Email: ${emailMatch[0]}`;
  }

  // Helpline text
  const helplineMatch = pageText.match(/helpline[:\s]+([^\n.]+)/i);
  if (helplineMatch) {
    return `Helpline: ${helplineMatch[1].trim()}`;
  }

  return null;
}

/**
 * Extract FAQ links
 */
function extractFAQLinks($: any): string[] {
  const faqLinks: string[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_i: number, elem: any) => {
    const href = $(elem).attr("href");
    const text = $(elem).text().toLowerCase();

    if (href && (text.includes("faq") || text.includes("question") || href.toLowerCase().includes("faq"))) {
      const absoluteUrl = resolveUrl(href, "");
      if (absoluteUrl && !seen.has(absoluteUrl)) {
        seen.add(absoluteUrl);
        faqLinks.push(absoluteUrl);
      }
    }
  });

  return faqLinks.slice(0, 5);
}

/**
 * Extract page description from meta tags or first paragraph
 */
function extractDescription($: any): string {
  let description = $("meta[name='description']").attr("content") || "";
  
  if (!description) {
    description = $("meta[property='og:description']").attr("content") || "";
  }
  
  if (!description) {
    description = $("p").first().text().trim().substring(0, 200) || "Government service portal";
  }

  return description.trim();
}

/**
 * Extract nearby text for context
 */
function extractNearbyText($: any, elem: any): string | undefined {
  const parent = $(elem).parent();
  let text = parent.text().trim();
  
  if (text.length > 500) {
    text = text.substring(0, 200) + "...";
  }
  
  return text || undefined;
}

/**
 * Resolve relative and protocol-relative URLs
 */
function resolveUrl(href: string, pageUrl: string): string {
  if (!href) return "";

  try {
    // Absolute URL
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return href;
    }

    // Protocol-relative
    if (href.startsWith("//")) {
      return "https:" + href;
    }

    // Relative URL (use page URL as base)
    if (pageUrl) {
      try {
        const base = new URL(pageUrl);
        const resolved = new URL(href, base);
        return resolved.toString();
      } catch {
        return "";
      }
    }

    return "";
  } catch (err) {
    return "";
  }
}

function normalizeExtractedText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function dedupeLines(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const clean = normalizeExtractedText(line);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function isUsefulRequirementLine(text: string): boolean {
  if (!text) return false;
  if (text.length < 10 || text.length > 220) return false;
  if (/^(login|subscribe|read more|share|copyright|privacy|terms)$/i.test(text)) return false;
  if (!/[a-z]/i.test(text)) return false;
  return true;
}

/**
 * Batch scrape multiple URLs
 */
export async function scrapeMultiplePortals(urls: string[]): Promise<ScrapedPageInfo[]> {
  console.log("[Scraper] Starting batch scrape of", urls.length, "URLs");
  
  const results = await Promise.allSettled(
    urls.map(url => scrapeGovernmentPortal(url))
  );

  const scraped = results
    .filter((r): r is PromiseFulfilledResult<ScrapedPageInfo | null> => r.status === "fulfilled")
    .map(r => r.value)
    .filter((r): r is ScrapedPageInfo => r !== null);

  console.log("[Scraper] Successfully scraped", scraped.length, "of", urls.length, "URLs");
  return scraped;
}
