import "dotenv/config";
import { MCPServer, object, text, widget } from "mcp-use/server";
import { z } from "zod";
import { searchYouTube, searchTwitter, searchBothPlatforms, researchGovernmentQuery } from "./api.js";

/* ----------------------------- HELPERS ----------------------------- */

function normalizeLine(text: string, maxLength = 220): string {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function dedupe(arr: string[]) {
  return Array.from(new Set(arr.filter(Boolean)));
}

/* ----------------------------- SERVER ----------------------------- */

const server = new MCPServer({
  name: "Zen-Citizen",
  version: "1.0.0",
  baseUrl: process.env.MCP_URL || "",
});

/* ----------------------------- TOOL ----------------------------- */

server.tool(
  {
    name: "research-government-query",
    schema: z.object({
      query: z.string(),
    }),
  },
  async ({ query }: { query: string }) => {
    try {
      const result = await researchGovernmentQuery(query);

      const topResources = (result.resources || []).slice(0, 10);

      /* ---------------- VIDEO FIX ---------------- */
      const topVideos = topResources
        .filter(
          (r: any) =>
            r.type === "video" ||
            (typeof r.url === "string" && r.url.includes("youtube.com"))
        )
        .slice(0, 5);

      /* ---------------- ARTICLE FIX ---------------- */
      const rankedArticles = topResources
        .filter(
          (r: any) =>
            r.url &&
            !r.url.includes("youtube") &&
            !r.url.includes("twitter")
        )
        .slice(0, 5);

      const allSourceUrls = dedupe([
        ...topResources.map((r: any) => r.url),
      ]);

      const sections: string[] = [];

      const addSources = (urls: string[]) => {
        sections.push("Sources:");
        const unique = dedupe(urls);

        if (unique.length > 0) {
          unique.forEach((u) => sections.push(u));
        } else {
          // fallback
          allSourceUrls.slice(0, 3).forEach((u) => sections.push(u));
        }

        sections.push("");
      };

      /* ---------------- ABOUT ---------------- */

      sections.push(`**About This Service — ${query}**`);
      sections.push("");
      sections.push("Information:");
      sections.push(result?.governmentService?.description || "No description available.");
      sections.push("");
      addSources(allSourceUrls);

      /* ---------------- REQUIREMENTS ---------------- */

      sections.push("**Requirements & Process**");
      sections.push("");
      sections.push("Information:");

      (result?.governmentService?.requirements || []).forEach((r: string) => {
        sections.push(`- ${normalizeLine(r)}`);
      });

      sections.push("");
      addSources(allSourceUrls);

      /* ---------------- OFFICIAL LINKS ---------------- */

      sections.push("**Official Links**");
      sections.push("");
      sections.push("Information:");

      (result?.governmentService?.officialLinks || []).forEach((url: string) => {
        sections.push(`- ${url}`);
      });

      sections.push("");
      addSources(result?.governmentService?.officialLinks || allSourceUrls);

      /* ---------------- ARTICLES ---------------- */

      sections.push("**Related Articles (Context Only)**");
      sections.push("");
      sections.push("Information:");

      if (rankedArticles.length > 0) {
        rankedArticles.forEach((a: any, i: number) => {
          sections.push(`${i + 1}. ${a.title || "Article"}`);
          sections.push(`   - ${a.url}`);
        });
      } else {
        sections.push("No articles found. Showing fallback:");
        topResources.slice(0, 3).forEach((r: any) => {
          sections.push(`- ${r.url}`);
        });
      }

      sections.push("");
      addSources(rankedArticles.map((a: any) => a.url));

      /* ---------------- YOUTUBE ---------------- */

      sections.push("**Related YouTube Videos**");
      sections.push("");
      sections.push("Information:");

      if (topVideos.length > 0) {
        topVideos.forEach((v: any, i: number) => {
          sections.push(`${i + 1}. ${v.title || "Video"}`);
          sections.push(`   - ${v.url}`);
        });
      } else {
        sections.push("No videos found. Showing fallback:");
        topResources.slice(0, 3).forEach((r: any) => {
          sections.push(`- ${r.url}`);
        });
      }

      sections.push("");
      addSources(topVideos.map((v: any) => v.url));

      /* ---------------- ARTICLES LINKS ONLY ---------------- */

      sections.push(`**Articles Related — ${query}**`);
      sections.push("");
      sections.push("Information:");

      const articleLinks = dedupe(rankedArticles.map((a: any) => a.url)).slice(0, 8);

      if (articleLinks.length > 0) {
        articleLinks.forEach((url, i) => {
          sections.push(`${i + 1}. ${url}`);
        });
      } else {
        sections.push("No article links available.");
      }

      sections.push("");
      addSources(articleLinks);

      /* ---------------- YOUTUBE LINKS ONLY ---------------- */

      sections.push(`**YouTube Related — ${query}**`);
      sections.push("");
      sections.push("Information:");

      const youtubeLinks = dedupe(topVideos.map((v: any) => v.url));

      if (youtubeLinks.length > 0) {
        youtubeLinks.forEach((url, i) => {
          sections.push(`${i + 1}. ${url}`);
        });
      } else {
        sections.push("No video links available.");
      }

      sections.push("");
      addSources(youtubeLinks);

      /* ---------------- FINAL ---------------- */

      return text(sections.join("\n"));

    } catch (err) {
      return text("REQUEST_FAILED");
    }
  }
);

/* ----------------------------- START ----------------------------- */

server.listen().then(() => {
  console.log("Server running");
});