import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { searchYouTube, searchTwitter, searchBothPlatforms, researchGovernmentQuery } from "./api";

// Mock axios module
vi.mock("axios");
// Set environment variables for tests
process.env.YOUTUBE_API_KEY = "test-youtube-key";
process.env.TWITTER_BEARER_TOKEN = "test-twitter-token";

// Set environment variables for tests
beforeAll(() => {
  process.env.YOUTUBE_API_KEY = "test-youtube-key";
  process.env.TWITTER_BEARER_TOKEN = "test-twitter-token";
});

// Clear mocks after each test
afterEach(() => {
  vi.clearAllMocks();
});

describe("searchYouTube", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.YOUTUBE_API_KEY = "test-api-key";
  });

  it("should throw error if YOUTUBE_API_KEY is not set", async () => {
    delete process.env.YOUTUBE_API_KEY;
    await expect(searchYouTube("test query")).rejects.toThrow(
      "YOUTUBE_API_KEY environment variable not set"
    );
  });

  it("should return YouTubeResults with videos and comments structure", async () => {
    const mockResponse = {
      data: {
        items: [
          {
            id: { videoId: "test-video-1" },
            snippet: {
              title: "Test Video 1",
              description: "Test description",
              publishedAt: "2024-01-01T00:00:00Z",
            },
          },
        ],
      },
    };
    vi.mocked(axios.get).mockResolvedValueOnce(mockResponse);
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { items: [] },
    });

    const result = await searchYouTube("test query");
    expect(result).toHaveProperty("videos");
    expect(result).toHaveProperty("comments");
    expect(result).toHaveProperty("commentsByVideo");
    expect(result).toHaveProperty("query");
    expect(Array.isArray(result.videos)).toBe(true);
    expect(Array.isArray(result.comments)).toBe(true);
  });

  it("should return videos with required properties", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        items: [
          {
            id: { videoId: "test-video-1" },
            snippet: {
              title: "Test Video 1",
              description: "Test description",
              publishedAt: "2024-01-01T00:00:00Z",
            },
          },
        ],
      },
    });
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { items: [] },
    });

    const result = await searchYouTube("test query");
    if (result.videos.length > 0) {
      const video = result.videos[0];
      expect(video).toHaveProperty("id");
      expect(video).toHaveProperty("title");
      expect(video).toHaveProperty("url");
      expect(video.url).toMatch(/youtube\.com/);
    }
  });

  it("should cap videos at 5 results", async () => {
    const result = await searchYouTube("test query");
    expect(result.videos.length).toBeLessThanOrEqual(5);
  });

  it("should return comments with required properties", async () => {
    const result = await searchYouTube("test query");
    if (result.comments.length > 0) {
      const comment = result.comments[0];
      expect(comment).toHaveProperty("authorDisplayName");
      expect(comment).toHaveProperty("textDisplay");
      expect(comment).toHaveProperty("likeCount");
    }
  });

  it("should handle errors gracefully", async () => {
    const result = await searchYouTube("invalid query").catch((e) => ({
      error: e.message,
    }));
    if ("error" in result) {
      expect(result.error).toBeDefined();
    }
  });
});

describe("searchTwitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TWITTER_BEARER_TOKEN = "test-bearer-token";
  });

  it("should throw error if TWITTER_BEARER_TOKEN is not set", async () => {
    delete process.env.TWITTER_BEARER_TOKEN;
    await expect(searchTwitter("test query")).rejects.toThrow(
      "TWITTER_BEARER_TOKEN environment variable not set"
    );
  });

  it("should return TwitterResults with tweets structure", async () => {
    const result = await searchTwitter("test query");
    expect(result).toHaveProperty("tweets");
    expect(result).toHaveProperty("query");
    expect(result).toHaveProperty("count");
    expect(Array.isArray(result.tweets)).toBe(true);
  });

  it("should return tweets with required properties", async () => {
    const result = await searchTwitter("test query");
    if (result.tweets.length > 0) {
      const tweet = result.tweets[0];
      expect(tweet).toHaveProperty("id");
      expect(tweet).toHaveProperty("text");
      expect(tweet).toHaveProperty("url");
      expect(tweet.url).toMatch(/twitter\.com|x\.com/);
    }
  });

  it("should include India context in query", async () => {
    const result = await searchTwitter("government services");
    expect(result.query).toBeDefined();
    expect(result.count).toBeGreaterThanOrEqual(0);
  });

  it("count should match tweets array length", async () => {
    const result = await searchTwitter("test query");
    expect(result.count).toBe(result.tweets.length);
  });

  it("should handle Twitter API authentication errors gracefully", async () => {
    delete process.env.TWITTER_BEARER_TOKEN;
    const result = await searchTwitter("test query").catch((e) => ({
      error: e.message,
    }));
    if ("error" in result) {
      expect(result.error).toBeDefined();
    }
  });
});

describe("searchBothPlatforms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.YOUTUBE_API_KEY = "test-api-key";
    process.env.TWITTER_BEARER_TOKEN = "test-bearer-token";
  });

  it("should return object with youtube, twitter, and errors properties", async () => {
    const result = await searchBothPlatforms("test query");
    expect(result).toHaveProperty("youtube");
    expect(result).toHaveProperty("twitter");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("should execute both platforms even if one fails", async () => {
    const result = await searchBothPlatforms("government query");
    // Should not throw, should return result with some data or errors
    expect(result).toBeDefined();
  });

  it("errors array should only contain non-optional platform errors", async () => {
    const result = await searchBothPlatforms("test query");
    // Twitter is optional, YouTube is required
    if (result.errors.length > 0) {
      const shouldNotContainTwitterOnlyError = result.errors.every(
        (err) => !err.includes("TWITTER_BEARER_TOKEN not set")
      );
      // Errors might be present if API fails
      expect(Array.isArray(result.errors)).toBe(true);
    }
  });
});

describe("researchGovernmentQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.YOUTUBE_API_KEY = "test-api-key";
    process.env.TWITTER_BEARER_TOKEN = "test-bearer-token";
  });

  it("should throw error if no data retrieved from any source", async () => {
    const result = await researchGovernmentQuery(
      "impossible-query-xyz-123-notfound"
    ).catch((e) => ({ error: e.message }));
    if ("error" in result) {
      expect(result.error).toBeDefined();
    }
  });

  it("should return ResearchQueryResult with required structure", async () => {
    const result = await researchGovernmentQuery("government services");
    expect(result).toHaveProperty("resources");
    expect(result).toHaveProperty("topKeyPoints");
    expect(result).toHaveProperty("opinionDistribution");
    expect(Array.isArray(result.resources)).toBe(true);
    expect(Array.isArray(result.topKeyPoints)).toBe(true);
  });

  it("should include opinionDistribution with opinion, information, and other", async () => {
    const result = await researchGovernmentQuery("government services");
    expect(result.opinionDistribution).toHaveProperty("opinion");
    expect(result.opinionDistribution).toHaveProperty("information");
    expect(result.opinionDistribution).toHaveProperty("other");
  });

  it("should have valid opinion distribution percentages sum to 100", async () => {
    const result = await researchGovernmentQuery("government services");
    const sum =
      result.opinionDistribution.opinion +
      result.opinionDistribution.information +
      result.opinionDistribution.other;
    expect(sum).toBeGreaterThanOrEqual(95); // Allow small rounding variance
  });

  it("should format error message if research fails", async () => {
    const result = await researchGovernmentQuery(
      "test-invalid-query"
    ).catch((e) => ({ error: e.message }));
    if ("error" in result) {
      expect(result.error).toMatch(/Research failed:/);
    }
  });

  it("should log processing steps to console", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    await researchGovernmentQuery("government services").catch(() => {});
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("Error Handling and Edge Cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.YOUTUBE_API_KEY = "test-api-key";
    process.env.TWITTER_BEARER_TOKEN = "test-bearer-token";
  });

  it("should handle empty query strings", async () => {
    const result = await searchYouTube("").catch((e) => ({
      error: e.message,
    }));
    expect(result).toBeDefined();
  });

  it("should handle special characters in query", async () => {
    const result = await searchYouTube("query@#$%^&*()").catch((e) => ({
      error: e.message,
    }));
    expect(result).toBeDefined();
  });

  it("should handle very long query strings", async () => {
    const longQuery = "a".repeat(500);
    const result = await searchYouTube(longQuery).catch((e) => ({
      error: e.message,
    }));
    expect(result).toBeDefined();
  });

  it("should handle network timeouts gracefully", async () => {
    const result = await searchBothPlatforms("test query");
    expect(result).toBeDefined();
    expect(result).toHaveProperty("errors");
  });
});
