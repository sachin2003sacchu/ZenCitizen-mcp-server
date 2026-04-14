# Test Cases for Zen-Citizen MCP Server

## Overview
Comprehensive test suite covering API functions, utility functions, error handling, and edge cases.

## Test Files

### api.test.ts
Tests for core API functions that interact with external services.

#### searchYouTube Tests
- ✅ Validates YOUTUBE_API_KEY environment variable requirement
- ✅ Checks response structure (videos, comments, commentsByVideo, query)
- ✅ Validates video object properties (id, title, url)
- ✅ Ensures videos are capped at 5 results
- ✅ Validates comment object properties
- ✅ Handles errors gracefully

#### searchTwitter Tests
- ✅ Validates TWITTER_BEARER_TOKEN environment variable requirement
- ✅ Checks response structure (tweets, query, count)
- ✅ Validates tweet object properties (id, text, url)
- ✅ Verifies India context in query
- ✅ Validates count matches tweets array length
- ✅ Handles authentication errors

#### searchBothPlatforms Tests
- ✅ Returns correct structure with youtube, twitter, and errors
- ✅ Executes both platforms even if one fails
- ✅ Properly categorizes errors (Twitter is optional, YouTube required)

#### researchGovernmentQuery Tests
- ✅ Throws error if no data retrieved from any source
- ✅ Returns ResearchQueryResult with correct structure
- ✅ Includes opinionDistribution with opinion, information, and other
- ✅ Validates opinionDistribution percentages
- ✅ Formats error messages properly
- ✅ Logs processing steps

#### Error Handling & Edge Cases
- ✅ Handles empty query strings
- ✅ Handles special characters in queries
- ✅ Handles very long query strings (500+ chars)
- ✅ Handles network timeouts gracefully

### utils.test.ts
Tests for utility functions that process and transform data.

#### Text Normalization
- ✅ Normalizes multiple spaces to single space
- ✅ Removes leading/trailing whitespace
- ✅ Removes quotes and dashes
- ✅ Respects maxLength parameter
- ✅ Handles empty/null/undefined inputs

#### URL Filtering
- ✅ Rejects non-HTTP URLs
- ✅ Rejects blocked hosts (DuckDuckGo, W3.org)
- ✅ Rejects static asset files (.css, .js, .png, etc.)
- ✅ Rejects favicon and system URLs
- ✅ Accepts valid content URLs

#### Tokenization
- ✅ Splits text into tokens
- ✅ Converts to lowercase
- ✅ Filters out short tokens (<4 chars)
- ✅ Filters out common stopwords
- ✅ Handles special characters
- ✅ Returns empty array for very short text

#### Deduplication
- ✅ Removes exact duplicates
- ✅ Removes case-insensitive duplicates
- ✅ Preserves order of first occurrence
- ✅ Handles empty strings
- ✅ Normalizes whitespace before deduping

#### Comment Quality Detection
- ✅ Detects very short text as noise
- ✅ Detects only punctuation as noise
- ✅ Detects excessive punctuation
- ✅ Detects common noisy words
- ✅ Accepts meaningful comments

#### Content Filtering
- ✅ Detects promo codes
- ✅ Detects promotional phrases
- ✅ Accepts non-promotional content

## Running Tests

### Install Dependencies
```bash
npm install
```

### Run All Tests
```bash
npm test
```

### Run Tests Once (CI Mode)
```bash
npm run test:run
```

### View Test UI
```bash
npm run test:ui
```

## Test Coverage Goals

- **API Functions**: 100% coverage of main functions and error paths
- **Utility Functions**: 100% coverage of text processing and filtering
- **Error Handling**: All error scenarios tested
- **Edge Cases**: Empty strings, special characters, long inputs, etc.

## Continuous Integration

Tests are designed to run in CI/CD pipelines and can be integrated with:
- GitHub Actions
- GitLab CI
- Jenkins
- Any CI platform that supports Node.js

## Future Test Enhancements

- [ ] Mock external API responses for deterministic testing
- [ ] Add performance benchmarks
- [ ] Add integration tests with real API calls (gated behind flags)
- [ ] Add snapshot tests for report generation
- [ ] Add stress tests for large data sets

## Notes

- Tests use Vitest for fast, modern testing
- Mock setup allows testing without external API dependencies
- All async operations include proper timeout handling
- Error messages are validated to ensure user-friendly output
