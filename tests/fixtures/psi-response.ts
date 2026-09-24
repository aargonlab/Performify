// ---------------------------------------------------------------------------
// Realistic PageSpeed Insights API v5 response fixture builder.
// Shape mirrors what app/lib/audit/psi-parser.ts reads:
//   - lighthouseResult.categories.<id>.score (0-1)
//   - lighthouseResult.audits.<id>.numericValue / details.overallSavingsMs
//   - loadingExperience / originLoadingExperience percentiles (CLS is ×100)
//   - page vs origin detection via id / initial_url / origin_fallback
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- test fixture: free-form PSI JSON */

/** Loosely-typed deep partial: any subtree of the PSI response. */
export type DeepPartialish = { [key: string]: any };

export const PSI_PAGE_URL = "https://shop.example.com/";
export const PSI_ORIGIN_URL = "https://shop.example.com";

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges `override` into `base`. Plain objects merge recursively;
 * everything else (scalars, arrays, null, undefined) replaces the base value,
 * so `{ loadingExperience: undefined }` removes the block entirely.
 */
function deepMerge(
  base: Record<string, any>,
  override: Record<string, any>,
): Record<string, any> {
  const result: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Full PSI v5 response for a mobile audit of PSI_PAGE_URL. */
export function makePsiResponse(overrides?: DeepPartialish): any {
  const base: Record<string, any> = {
    captchaResult: "CAPTCHA_NOT_NEEDED",
    kind: "pagespeedonline#result",
    id: PSI_PAGE_URL,
    loadingExperience: {
      id: PSI_PAGE_URL,
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: {
          percentile: 2600,
          distributions: [
            { min: 0, max: 2500, proportion: 0.71 },
            { min: 2500, max: 4000, proportion: 0.18 },
            { min: 4000, proportion: 0.11 },
          ],
          category: "AVERAGE",
        },
        INTERACTION_TO_NEXT_PAINT: {
          percentile: 180,
          distributions: [
            { min: 0, max: 200, proportion: 0.83 },
            { min: 200, max: 500, proportion: 0.12 },
            { min: 500, proportion: 0.05 },
          ],
          category: "FAST",
        },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: {
          percentile: 12,
          distributions: [
            { min: 0, max: 10, proportion: 0.78 },
            { min: 10, max: 25, proportion: 0.15 },
            { min: 25, proportion: 0.07 },
          ],
          category: "FAST",
        },
      },
      overall_category: "AVERAGE",
      initial_url: PSI_PAGE_URL,
    },
    originLoadingExperience: {
      id: PSI_ORIGIN_URL,
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: {
          percentile: 2850,
          distributions: [
            { min: 0, max: 2500, proportion: 0.66 },
            { min: 2500, max: 4000, proportion: 0.21 },
            { min: 4000, proportion: 0.13 },
          ],
          category: "AVERAGE",
        },
        INTERACTION_TO_NEXT_PAINT: {
          percentile: 210,
          distributions: [
            { min: 0, max: 200, proportion: 0.74 },
            { min: 200, max: 500, proportion: 0.19 },
            { min: 500, proportion: 0.07 },
          ],
          category: "AVERAGE",
        },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: {
          percentile: 15,
          distributions: [
            { min: 0, max: 10, proportion: 0.7 },
            { min: 10, max: 25, proportion: 0.2 },
            { min: 25, proportion: 0.1 },
          ],
          category: "FAST",
        },
      },
      overall_category: "AVERAGE",
      initial_url: PSI_PAGE_URL,
    },
    lighthouseResult: {
      requestedUrl: PSI_PAGE_URL,
      finalUrl: PSI_PAGE_URL,
      finalDisplayedUrl: PSI_PAGE_URL,
      mainDocumentUrl: PSI_PAGE_URL,
      lighthouseVersion: "13.0.0",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      fetchTime: "2026-07-06T10:00:00.000Z",
      environment: {
        networkUserAgent:
          "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        hostUserAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        benchmarkIndex: 1500,
      },
      configSettings: {
        emulatedFormFactor: "mobile",
        formFactor: "mobile",
        locale: "en-US",
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
        ],
        channel: "lr",
      },
      categories: {
        performance: {
          id: "performance",
          title: "Performance",
          score: 0.82,
        },
        accessibility: {
          id: "accessibility",
          title: "Accessibility",
          score: 0.95,
        },
        "best-practices": {
          id: "best-practices",
          title: "Best Practices",
          score: 0.9,
        },
        seo: {
          id: "seo",
          title: "SEO",
          score: 1.0,
        },
      },
      audits: {
        "largest-contentful-paint": {
          id: "largest-contentful-paint",
          title: "Largest Contentful Paint",
          score: 0.61,
          scoreDisplayMode: "numeric",
          numericValue: 2350.5,
          numericUnit: "millisecond",
          displayValue: "2.4 s",
        },
        "cumulative-layout-shift": {
          id: "cumulative-layout-shift",
          title: "Cumulative Layout Shift",
          score: 0.98,
          scoreDisplayMode: "numeric",
          numericValue: 0.08,
          numericUnit: "unitless",
          displayValue: "0.08",
        },
        "total-blocking-time": {
          id: "total-blocking-time",
          title: "Total Blocking Time",
          score: 0.68,
          scoreDisplayMode: "numeric",
          numericValue: 310,
          numericUnit: "millisecond",
          displayValue: "310 ms",
        },
        "first-contentful-paint": {
          id: "first-contentful-paint",
          title: "First Contentful Paint",
          score: 0.85,
          scoreDisplayMode: "numeric",
          numericValue: 1200,
          numericUnit: "millisecond",
          displayValue: "1.2 s",
        },
        "speed-index": {
          id: "speed-index",
          title: "Speed Index",
          score: 0.7,
          scoreDisplayMode: "numeric",
          numericValue: 3400,
          numericUnit: "millisecond",
          displayValue: "3.4 s",
        },
        "server-response-time": {
          id: "server-response-time",
          title: "Initial server response time was short",
          score: 1,
          scoreDisplayMode: "metricSavings",
          numericValue: 420,
          numericUnit: "millisecond",
          displayValue: "Root document took 420 ms",
        },
        "render-blocking-resources": {
          id: "render-blocking-resources",
          title: "Eliminate render-blocking resources",
          score: 0.4,
          scoreDisplayMode: "metricSavings",
          displayValue: "Potential savings of 450 ms",
          details: {
            type: "opportunity",
            headings: [],
            items: [],
            overallSavingsMs: 450,
            overallSavingsBytes: 18000,
          },
        },
        "unused-javascript": {
          id: "unused-javascript",
          title: "Reduce unused JavaScript",
          score: 0.3,
          scoreDisplayMode: "metricSavings",
          displayValue: "Potential savings of 900 ms",
          details: {
            type: "opportunity",
            headings: [],
            items: [],
            overallSavingsMs: 900,
            overallSavingsBytes: 210000,
          },
        },
        "uses-optimized-images": {
          id: "uses-optimized-images",
          title: "Efficiently encode images",
          score: 1,
          scoreDisplayMode: "metricSavings",
          details: {
            type: "opportunity",
            headings: [],
            items: [],
            overallSavingsMs: 0,
            overallSavingsBytes: 0,
          },
        },
      },
      timing: { total: 12345.6 },
    },
    analysisUTCTimestamp: "2026-07-06T10:00:05.123Z",
  };

  return overrides ? deepMerge(base, overrides) : base;
}
