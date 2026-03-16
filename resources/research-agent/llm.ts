import axios from "axios";

const OPENAI_URL = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

export async function summarizeForVideo(
  title: string,
  description: string,
  comments: { authorDisplayName?: string; textDisplay: string }[],
  instructions?: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";

  const promptParts: string[] = [];
  promptParts.push(`Title: ${title}`);
  if (description) promptParts.push(`Description: ${description}`);
  if (comments && comments.length > 0) {
    const sample = comments.slice(0, 5).map((c, i) => `Comment ${i + 1}: ${c.textDisplay}`).join("\n");
    promptParts.push(`Top comments:\n${sample}`);
  }

  const system = instructions || `You are a concise assistant. Summarize the video and top comments into 2-4 short bullet points and a one-sentence actionable recommendation.`;

  const messages = [
    { role: "system", content: system },
    { role: "user", content: promptParts.join("\n\n") },
  ];

  try {
    const resp = await axios.post(
      `${OPENAI_URL}/chat/completions`,
      {
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages,
        temperature: 0.2,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const text = resp.data?.choices?.[0]?.message?.content;
    return text || "";
  } catch (err) {
    console.warn("LLM summarization failed:", (err as any)?.message || err);
    return "";
  }
}

export interface InferredGovernmentLinks {
  serviceName: string;
  description: string;
  officialLinks: string[];
  category: string;
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
  "category": "..."
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

export default { summarizeForVideo, inferGovernmentLinks };
