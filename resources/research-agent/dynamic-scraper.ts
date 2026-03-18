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
  const requirements: string[] = [];

  // Look for requirements heading
  const requirementsSection = $("*").filter((_i: number, el: any) => {
    const text = $(el).text().toLowerCase();
    return text.includes("requirement") || text.includes("document needed");
  }).first().parent();

  if (requirementsSection.length > 0) {
    requirementsSection
      .find("li, p, div")
      .slice(0, 10)
      .each((_i: number, elem: any) => {
        const text = $(elem).text().trim();
        if (text.length > 10 && text.length < 200) {
          requirements.push(text);
        }
      });
  }

  // Also search for bullet points near "require" keywords
  $("*").filter((_i: number, el: any) => {
    const text = $(el).text().toLowerCase();
    return text.includes("require");
  }).each((_i: number, elem: any) => {
    $(elem).find("li").slice(0, 5).each((_j: number, li: any) => {
      const text = $(li).text().trim();
      if (text.length > 5 && requirements.length < 10) {
        requirements.push(text);
      }
    });
  });

  return [...new Set(requirements)].slice(0, 8);  // Deduplicate, limit to 8
}

/**
 * Extract processing time
 */
function extractProcessingTime($: any): string | null {
  // Search for processing time mentions
  const pageText = $.text().toLowerCase();
  
  const patterns = [
    /processing\s+time[:\s]+([^\n.]+)/i,
    /takes?\s+(\d+(?:\s+to\s+\d+)?)\s*(?:days?|weeks?|months?|hours?)/i,
    /turnaround\s+time[:\s]+([^\n.]+)/i,
    /duration[:\s]+([^\n.]+)/i,
    /(\d+(?:\s+to\s+\d+)?)\s*(?:days?|weeks?|months?|hours?)/i
  ];

  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
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
