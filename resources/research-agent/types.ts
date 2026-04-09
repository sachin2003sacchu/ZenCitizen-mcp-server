// Sentiment Analysis Types
export type SentimentType = "positive" | "negative" | "neutral" | "helpful" | "unhelpful" | "spam";

// Comment label classification: whether a comment is an opinion or factual information
export type CommentLabel = "opinion" | "information" | "other";

export interface SentimentScore {
  sentiment: SentimentType;
  confidence: number; // 0-100
  keywords: string[];
}

// Opinion Data
export interface Opinion {
  text: string;
  // legacy sentiment field (optional) — we primarily use `label` for comment classification
  sentiment?: SentimentType;
  // New label indicating whether the comment is an opinion or factual information
  label: CommentLabel;
  confidence: number;
  likes: number;
  relevanceScore: number; // 0-100
  source: "youtube_comment" | "tweet" | "user";
  timestamp: string;
}

// Key Point Extraction
export interface KeyPoint {
  text: string;
  frequency: number; // how many sources mention this
  sentiment: SentimentType;
  sources: string[];
  evidenceCount: number;
}

// Credibility Metrics
export interface CredibilityMetrics {
  overall: number; // 0-100
  engagement: number; // likes/retweets ratio
  recency: number; // 0-100 (newer = higher)
  source_authority: string; // "official" | "verified" | "community" | "unknown"
  verification_status: boolean;
}

// Research Result Structure
export interface ResearchResource {
  id: string;
  title: string;
  url: string;
  type: "official" | "video" | "tweet" | "guide" | "forum";
  credibility: CredibilityMetrics;
  opinions: Opinion[];
  keyPoints: KeyPoint[];
  metadata: {
    author?: string;
    channelName?: string;
    publishDate?: string;
    views?: number;
    likes?: number;
    comments?: number;
    summary?: string;
  };
}

// Government Service Entry
export interface GovernmentService {
  id: string;
  name: string;
  keywords: string[];
  description: string;
  officialLinks: string[];
  category: string;
  state?: string;
  requirements: string[];
  fees?: string[];
  processingTime: string;
  steps?: string[];
  contactInfo?: string;
  relatedServices: string[];
  // Optional list of document/form URLs discovered on official sites
  documentLinks?: string[];
}

// Research Query Result
export interface ResearchQueryResult {
  query: string;
  timestamp: string;
  governmentService?: GovernmentService;
  resources: ResearchResource[];
  // Distribution of comment classifications across all resources
  opinionDistribution: {
    opinion: number; // % labeled as opinion
    information: number; // % labeled as information
    other: number; // % labeled other/unclear
  };
  averageCredibility: number; // 0-100
  topKeyPoints: KeyPoint[];
  recommendedActions: string[];
}
