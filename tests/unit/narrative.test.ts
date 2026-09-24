import { describe, expect, it } from "vitest";

import type { RunNarrative } from "../../app/lib/types";
import type { RunSummary } from "../../app/lib/report/types";
import {
  generateNarrative,
  rateScore,
  resolveLocale,
} from "../../app/lib/report/narrative";
import { makePageResult, makeRunSummary } from "../fixtures/page-result";

function runWithScore(performanceScore: number): RunSummary {
  return makeRunSummary({
    pageResults: [makePageResult({ performanceScore })],
  });
}

const FORBIDDEN = /null|NaN|undefined/;

describe("resolveLocale", () => {
  it("maps any it-prefixed locale to it and everything else to en", () => {
    expect(resolveLocale("it")).toBe("it");
    expect(resolveLocale("it-IT")).toBe("it");
    expect(resolveLocale("IT")).toBe("it");
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });
});

describe("rateScore", () => {
  it("applies the 90/70/50 boundaries", () => {
    expect(rateScore(90)).toBe("excellent");
    expect(rateScore(89.9)).toBe("good");
    expect(rateScore(70)).toBe("good");
    expect(rateScore(69.9)).toBe("needsImprovement");
    expect(rateScore(50)).toBe("needsImprovement");
    expect(rateScore(49.9)).toBe("poor");
  });
});

describe("generateNarrative — summary", () => {
  it("produces a non-empty English summary with the score and rating words", () => {
    const narrative = generateNarrative({ current: runWithScore(95) });
    expect(narrative.locale).toBe("en");
    expect(narrative.summary.length).toBeGreaterThan(0);
    expect(narrative.summary).toContain("95 out of 100");
    expect(narrative.summary).toContain("an excellent result");
  });

  it("uses the rating word matching the score band", () => {
    expect(generateNarrative({ current: runWithScore(75) }).summary).toContain(
      "a good result",
    );
    expect(generateNarrative({ current: runWithScore(55) }).summary).toContain(
      "needs improvement",
    );
    expect(generateNarrative({ current: runWithScore(30) }).summary).toContain(
      "a poor result",
    );
  });

  it("produces a non-empty Italian summary with the rating words", () => {
    const narrative = generateNarrative({
      current: runWithScore(95),
      locale: "it-IT",
    });
    expect(narrative.locale).toBe("it");
    expect(narrative.summary).toContain("95 su 100");
    expect(narrative.summary).toContain("un risultato eccellente");
  });

  it("mentions the theme name when present", () => {
    const narrative = generateNarrative({
      current: makeRunSummary({
        themeName: "Dawn 12.0",
        pageResults: [makePageResult({ performanceScore: 80 })],
      }),
    });
    expect(narrative.summary).toContain("\"Dawn 12.0\"");
  });

  it("explains when the run produced no completed results", () => {
    const narrative = generateNarrative({
      current: makeRunSummary({
        pageResults: [makePageResult({ status: "FAILED" })],
      }),
    });
    expect(narrative.summary).toContain(
      "did not produce any completed results",
    );
  });

  it("counts unique completed URLs as pages in the coverage sentence", () => {
    const url = "https://shop.example.com/";
    const narrative = generateNarrative({
      current: makeRunSummary({
        pageResults: [
          makePageResult({ url, device: "MOBILE" }),
          makePageResult({ url, device: "DESKTOP" }),
          makePageResult({
            url: "https://shop.example.com/products/tee",
            pageType: "PRODUCT",
          }),
          makePageResult({
            url: "https://shop.example.com/failed",
            status: "FAILED",
          }),
        ],
      }),
    });
    expect(narrative.summary).toContain("We audited 2 pages");
    expect(narrative.summary).toContain("2 device types");
  });
});

describe("generateNarrative — improvement vs regression vs stable", () => {
  it("phrases an improvement with the delta and baseline date", () => {
    const narrative = generateNarrative({
      current: runWithScore(90),
      baseline: makeRunSummary({
        createdAt: "2026-06-01T09:30:00.000Z",
        pageResults: [makePageResult({ performanceScore: 80 })],
      }),
    });
    expect(narrative.summary).toContain("improved by 10 points");
    expect(narrative.summary).toContain("June 1, 2026");
  });

  it("phrases a regression with the absolute delta", () => {
    const narrative = generateNarrative({
      current: runWithScore(70),
      baseline: makeRunSummary({
        pageResults: [makePageResult({ performanceScore: 80 })],
      }),
    });
    expect(narrative.summary).toContain("worsened by 10 points");
  });

  it("phrases a small delta as stable", () => {
    const narrative = generateNarrative({
      current: runWithScore(81),
      baseline: makeRunSummary({
        pageResults: [makePageResult({ performanceScore: 80 })],
      }),
    });
    expect(narrative.summary).toContain("stable compared with");
  });

  it("uses Italian phrasing for a regression", () => {
    const narrative = generateNarrative({
      current: runWithScore(70),
      baseline: makeRunSummary({
        pageResults: [makePageResult({ performanceScore: 80 })],
      }),
      locale: "it",
    });
    expect(narrative.summary).toContain("peggiorate di 10 punti");
  });

  it("records the baseline run id as comparedToRunId", () => {
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ performanceScore: 80 })],
    });
    const narrative = generateNarrative({
      current: runWithScore(90),
      baseline,
    });
    expect(narrative.comparedToRunId).toBe(baseline.id);
  });

  it("omits the delta sentence when there is no baseline", () => {
    const narrative = generateNarrative({ current: runWithScore(80) });
    expect(narrative.summary).not.toContain("since the last audit");
    expect(narrative.comparedToRunId).toBeUndefined();
  });
});

describe("generateNarrative — sections", () => {
  it("adds a failed-pages section when some pages failed", () => {
    const narrative = generateNarrative({
      current: makeRunSummary({
        pageResults: [
          makePageResult({ performanceScore: 80 }),
          makePageResult({ status: "FAILED" }),
          makePageResult({ status: "FAILED" }),
        ],
      }),
    });
    const failed = narrative.sections.find(
      (s) => s.heading === "Some pages could not be audited",
    );
    expect(failed).toBeDefined();
    expect(failed?.body).toContain("2 pages failed");
    expect(failed?.tone).toBe("negative");
  });

  it("adds a category section for a clear score regression", () => {
    const narrative = generateNarrative({
      current: makeRunSummary({
        pageResults: [makePageResult({ accessibilityScore: 60 })],
      }),
      baseline: makeRunSummary({
        pageResults: [makePageResult({ accessibilityScore: 90 })],
      }),
    });
    const section = narrative.sections.find(
      (s) => s.heading === "Accessibility score dropped",
    );
    expect(section).toBeDefined();
    expect(section?.body).toContain("from 90 to 60");
    expect(section?.body).toContain("-30 points");
    expect(section?.tone).toBe("negative");
  });

  it("omits category sections when scores are stable", () => {
    const results = [makePageResult({})];
    const narrative = generateNarrative({
      current: makeRunSummary({ pageResults: results }),
      baseline: makeRunSummary({ pageResults: [makePageResult({})] }),
    });
    expect(
      narrative.sections.filter(
        (s) => s.heading.includes("score") || s.heading.includes("Punteggio"),
      ),
    ).toEqual([]);
  });
});

describe("generateNarrative — recommendations", () => {
  it("sources recommendations from the results' topOpportunities", () => {
    const narrative = generateNarrative({
      current: makeRunSummary({
        pageResults: [
          makePageResult({
            url: "https://shop.example.com/products/tee",
            topOpportunities: [
              {
                id: "unused-javascript",
                title: "Reduce unused JavaScript",
                savingsMs: 900,
                score: 0.3,
              },
            ],
          }),
        ],
      }),
    });
    expect(narrative.recommendations).toHaveLength(1);
    expect(narrative.recommendations[0]).toMatchObject({
      auditId: "unused-javascript",
      title: "Reduce unused JavaScript",
      estimatedSavingsMs: 900,
      affectedUrls: ["https://shop.example.com/products/tee"],
      priority: 1,
    });
  });
});

describe("generateNarrative — no leaked placeholder text", () => {
  it("never contains null/NaN/undefined in any generated string", () => {
    const scenarios: RunNarrative[] = [];
    for (const locale of ["en", "it"] as const) {
      // Sparse run: many null metrics, a failure, field data and opportunities.
      const current = makeRunSummary({
        themeName: "Dawn",
        pageResults: [
          makePageResult({
            performanceScore: 55,
            seoScore: null,
            cls: null,
            lcpMs: 4200,
            fieldLcpMs: 8000,
            marketHandle: "eu",
            marketName: null,
            topOpportunities: [
              { id: "mystery-audit", title: "Mystery", savingsMs: 300, score: null },
            ],
          }),
          makePageResult({
            performanceScore: 90,
            marketHandle: null,
            device: "DESKTOP",
            pageType: "PRODUCT",
          }),
          makePageResult({ status: "FAILED" }),
        ],
      });
      const baseline = makeRunSummary({
        pageResults: [
          makePageResult({ performanceScore: 85, lcpMs: 2000, cls: 0.02 }),
        ],
      });
      scenarios.push(generateNarrative({ current, locale }));
      scenarios.push(generateNarrative({ current, baseline, locale }));
      scenarios.push(
        generateNarrative({
          current: makeRunSummary({ pageResults: [] }),
          locale,
        }),
      );
    }
    for (const narrative of scenarios) {
      expect(JSON.stringify(narrative)).not.toMatch(FORBIDDEN);
    }
  });
});
