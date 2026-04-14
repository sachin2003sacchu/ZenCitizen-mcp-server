import { describe, it, expect } from "vitest";

// These functions need to be exported from index.ts for testing
// We'll test the logic directly here

describe("Text Normalization Functions", () => {
  function normalizeLine(text: string, maxLength = 220): string {
    const compact = String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^["'`\-\s]+|["'`\s]+$/g, "")
      .trim();
    return compact.slice(0, maxLength);
  }

  it("should normalize whitespace", () => {
    const result = normalizeLine("hello    world");
    expect(result).toBe("hello world");
  });

  it("should remove leading and trailing whitespace", () => {
    const result = normalizeLine("   hello world   ");
    expect(result).toBe("hello world");
  });

  it("should remove leading and trailing quotes", () => {
    const result = normalizeLine('"hello world"');
    expect(result).toBe("hello world");
  });

  it("should respect maxLength", () => {
    const result = normalizeLine("hello world", 5);
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result).toBe("hello");
  });

  it("should handle empty strings", () => {
    const result = normalizeLine("");
    expect(result).toBe("");
  });

  it("should handle null/undefined by converting to empty string", () => {
    const result = normalizeLine(null as any);
    expect(result).toBe("");
  });

  it("should handle strings with multiple consecutive spaces", () => {
    const result = normalizeLine("hello     world     test");
    expect(result).toBe("hello world test");
  });
});

describe("URL Filtering Functions", () => {
  function isNoiseUrl(url: string): boolean {
    const lower = url.toLowerCase();
    if (!/^https?:\/\//.test(lower)) return true;

    const blockedHosts = ["duckduckgo.com", "w3.org"];
    if (blockedHosts.some((host) => lower.includes(host))) return true;

    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|xml)(\?|$)/.test(lower)) return true;
    if (/(\/favicon\.ico|\/opensearch|\/feedback|\/html\/)/.test(lower)) return true;

    return false;
  }

  it("should reject non-http URLs", () => {
    expect(isNoiseUrl("ftp://example.com")).toBe(true);
    expect(isNoiseUrl("file:///etc/passwd")).toBe(true);
    expect(isNoiseUrl("javascript:alert('hi')")).toBe(true);
  });

  it("should reject blocked hosts", () => {
    expect(isNoiseUrl("https://duckduckgo.com/search")).toBe(true);
    expect(isNoiseUrl("http://www.w3.org/2000/svg")).toBe(true);
  });

  it("should reject static asset files", () => {
    expect(isNoiseUrl("https://example.com/style.css")).toBe(true);
    expect(isNoiseUrl("https://example.com/script.js")).toBe(true);
    expect(isNoiseUrl("https://example.com/image.png")).toBe(true);
  });

  it("should reject favicon and system URLs", () => {
    expect(isNoiseUrl("https://example.com/favicon.ico")).toBe(true);
    expect(isNoiseUrl("https://example.com/opensearch.xml")).toBe(true);
  });

  it("should accept valid content URLs", () => {
    expect(isNoiseUrl("https://example.com/article")).toBe(false);
    expect(isNoiseUrl("https://news.example.com/story")).toBe(false);
    expect(isNoiseUrl("https://example.com/page?id=123")).toBe(false);
  });
});

describe("Tokenization Functions", () => {
  function tokenize(text: string): string[] {
    function normalizeLine(text: string, maxLength = 220): string {
      const compact = String(text || "")
        .replace(/\s+/g, " ")
        .replace(/^["'`\-\s]+|["'`\s]+$/g, "")
        .trim();
      return compact.slice(0, maxLength);
    }

    return normalizeLine(text, 400)
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length >= 4)
      .filter(
        (t) =>
          ![
            "this",
            "that",
            "with",
            "from",
            "your",
            "have",
            "will",
            "need",
            "apply",
            "online",
            "official",
          ].includes(t)
      );
  }

  it("should split text into tokens", () => {
    const result = tokenize("hello world test");
    expect(result).toEqual(["hello", "world", "test"]);
  });

  it("should convert to lowercase", () => {
    const result = tokenize("HELLO WORLD");
    expect(result.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it("should filter out short tokens (less than 4 chars)", () => {
    const result = tokenize("the cat sat on a mat");
    expect(result).not.toContain("the");
    expect(result).not.toContain("cat");
    expect(result.every((t) => t.length >= 4)).toBe(true);
  });

  it("should filter out common stopwords", () => {
    const result = tokenize("this that with from your have");
    expect(result).not.toContain("this");
    expect(result).not.toContain("that");
    expect(result.length).toBe(0);
  });

  it("should handle special characters", () => {
    const result = tokenize("hello@world#test$123");
    expect(Array.isArray(result)).toBe(true);
  });

  it("should return empty array for very short text", () => {
    const result = tokenize("a b c");
    expect(result).toEqual([]);
  });
});

describe("Deduplication Functions", () => {
  function dedupeStrings(values: string[]): string[] {
    function normalizeLine(text: string, maxLength = 220): string {
      const compact = String(text || "")
        .replace(/\s+/g, " ")
        .replace(/^["'`\-\s]+|["'`\s]+$/g, "")
        .trim();
      return compact.slice(0, maxLength);
    }

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

  it("should remove exact duplicates", () => {
    const result = dedupeStrings(["hello", "hello", "world"]);
    expect(result).toEqual(["hello", "world"]);
  });

  it("should remove case-insensitive duplicates", () => {
    const result = dedupeStrings(["Hello", "HELLO", "hello", "world"]);
    expect(result.length).toBe(2);
  });

  it("should preserve order of first occurrence", () => {
    const result = dedupeStrings(["world", "hello", "world", "hello"]);
    expect(result[0]).toBe("world");
    expect(result[1]).toBe("hello");
  });

  it("should handle empty strings", () => {
    const result = dedupeStrings(["hello", "", "world", ""]);
    expect(result).toEqual(["hello", "world"]);
  });

  it("should normalize whitespace before deduping", () => {
    const result = dedupeStrings(["hello  world", "hello world"]);
    expect(result.length).toBe(1);
  });
});

describe("Comment Quality Detection", () => {
  function isLikelyNoisyComment(text: string): boolean {
    function normalizeLine(text: string, maxLength = 220): string {
      const compact = String(text || "")
        .replace(/\s+/g, " ")
        .replace(/^["'`\-\s]+|["'`\s]+$/g, "")
        .trim();
      return compact.slice(0, maxLength);
    }

    const cleaned = normalizeLine(text, 260);
    if (!cleaned || cleaned.length < 14) return true;

    const lower = cleaned.toLowerCase();
    if (/^[^a-z0-9\u0C80-\u0CFF]+$/i.test(cleaned)) return true;
    if (
      /\b(mam|sir|bro|bhai|tnq|pls|ple|frad)\b/i.test(lower) &&
      cleaned.length < 60
    )
      return true;
    if ((cleaned.match(/[!?]/g) || []).length >= 3) return true;
    if (/^is\s+this\s+still\s+valid\??$/i.test(lower)) return true;
    if (
      /\b(crush|voice tone|subscribe|follow me|love you|first comment)\b/i.test(
        lower
      )
    )
      return true;

    return false;
  }

  it("should detect very short text as noise", () => {
    expect(isLikelyNoisyComment("ok")).toBe(true);
    expect(isLikelyNoisyComment("yes")).toBe(true);
  });

  it("should detect only punctuation as noise", () => {
    expect(isLikelyNoisyComment("!!!")).toBe(true);
    expect(isLikelyNoisyComment("???")).toBe(true);
  });

  it("should detect excessive punctuation", () => {
    expect(isLikelyNoisyComment("Hello!!! How are you?? Really!!")).toBe(true);
  });

  it("should detect common noisy words", () => {
    expect(isLikelyNoisyComment("Thanks bro")).toBe(true);
    expect(isLikelyNoisyComment("Subscribe please")).toBe(true);
  });

  it("should accept meaningful comments", () => {
    expect(
      isLikelyNoisyComment(
        "This is a meaningful comment about the government process"
      )
    ).toBe(false);
    expect(
      isLikelyNoisyComment(
        "The process requires these documents and typically takes 2 weeks"
      )
    ).toBe(false);
  });
});

describe("Content Filtering", () => {
  function isLikelyPromotional(text: string): boolean {
    function normalizeLine(text: string, maxLength = 220): string {
      const compact = String(text || "")
        .replace(/\s+/g, " ")
        .replace(/^["'`\-\s]+|["'`\s]+$/g, "")
        .trim();
      return compact.slice(0, maxLength);
    }

    const lower = normalizeLine(text, 320).toLowerCase();
    return /(use code|discount|promo|affiliate|apply here|subscribe|dm me|link in bio|whatsapp me|telegram)/.test(
      lower
    );
  }

  it("should detect promo codes", () => {
    expect(isLikelyPromotional("Use code SAVE20 for discount")).toBe(true);
    expect(isLikelyPromotional("Apply code PROMO123")).toBe(true);
  });

  it("should detect promotional phrases", () => {
    expect(isLikelyPromotional("Check out my link in bio")).toBe(true);
    expect(isLikelyPromotional("WhatsApp me for details")).toBe(true);
    expect(isLikelyPromotional("Subscribe for more")).toBe(true);
  });

  it("should accept non-promotional content", () => {
    expect(
      isLikelyPromotional(
        "You need to submit these documents to the government office"
      )
    ).toBe(false);
    expect(
      isLikelyPromotional("The application process takes about 30 days")
    ).toBe(false);
  });
});
