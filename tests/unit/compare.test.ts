import { describe, expect, it } from "vitest";

import { averageOf, compareRuns, computeAggregates } from "../../app/lib/report/compare";
import { makePageResult, makeRunSummary } from "../fixtures/page-result";

describe("averageOf", () => {
  it("averages finite numbers and skips null/undefined", () => {
    expect(averageOf([10, null, 20, undefined])).toBe(15);
  });

  it("returns null when there is no numeric value", () => {
    expect(averageOf([null, undefined])).toBeNull();
    expect(averageOf([])).toBeNull();
  });
});

describe("computeAggregates", () => {
  it("counts and averages only COMPLETED results", () => {
    const aggregates = computeAggregates([
      makePageResult({ performanceScore: 80 }),
      makePageResult({ performanceScore: 90 }),
      makePageResult({ status: "FAILED", performanceScore: 10 }),
      makePageResult({ status: "PENDING", performanceScore: 20 }),
    ]);
    expect(aggregates.overall.count).toBe(2);
    expect(aggregates.overall.performanceScore).toBe(85);
  });

  it("rounds category scores to integers and timing metrics to one decimal", () => {
    const aggregates = computeAggregates([
      makePageResult({ performanceScore: 85, lcpMs: 2000, tbtMs: 100.25 }),
      makePageResult({ performanceScore: 90, lcpMs: 2001, tbtMs: 100.35 }),
    ]);
    expect(aggregates.overall.performanceScore).toBe(88);
    expect(aggregates.overall.lcpMs).toBe(2000.5);
    expect(aggregates.overall.tbtMs).toBe(100.3);
  });

  it("rounds CLS averages to three decimals to keep their precision", () => {
    const aggregates = computeAggregates([
      makePageResult({ cls: 0.0111, fieldCls: 0.0203 }),
      makePageResult({ cls: 0.0157, fieldCls: 0.0224 }),
    ]);
    expect(aggregates.overall.cls).toBe(0.013);
    expect(aggregates.overall.fieldCls).toBe(0.021);
  });

  it("returns null for a metric with no values among completed results", () => {
    const aggregates = computeAggregates([
      makePageResult({ fieldLcpMs: null, fieldInpMs: null, fieldCls: null }),
      makePageResult({ fieldLcpMs: null, fieldInpMs: null, fieldCls: null }),
    ]);
    expect(aggregates.overall.fieldLcpMs).toBeNull();
    expect(aggregates.overall.fieldInpMs).toBeNull();
    expect(aggregates.overall.fieldCls).toBeNull();
  });

  it("skips null values but averages the rest", () => {
    const aggregates = computeAggregates([
      makePageResult({ seoScore: 80 }),
      makePageResult({ seoScore: null }),
    ]);
    expect(aggregates.overall.seoScore).toBe(80);
  });

  it("groups by device", () => {
    const aggregates = computeAggregates([
      makePageResult({ device: "MOBILE", performanceScore: 60 }),
      makePageResult({ device: "DESKTOP", performanceScore: 90 }),
    ]);
    expect(aggregates.byDevice.MOBILE?.performanceScore).toBe(60);
    expect(aggregates.byDevice.DESKTOP?.performanceScore).toBe(90);
  });

  it("groups by market using \"default\" for null marketHandle", () => {
    const aggregates = computeAggregates([
      makePageResult({ marketHandle: null, performanceScore: 70 }),
      makePageResult({ marketHandle: "eu", performanceScore: 90 }),
    ]);
    expect(Object.keys(aggregates.byMarket).sort()).toEqual(["default", "eu"]);
    expect(aggregates.byMarket.default.performanceScore).toBe(70);
    expect(aggregates.byMarket.eu.performanceScore).toBe(90);
  });

  it("groups by page type", () => {
    const aggregates = computeAggregates([
      makePageResult({ pageType: "HOME", performanceScore: 70 }),
      makePageResult({ pageType: "PRODUCT", performanceScore: 50 }),
      makePageResult({ pageType: "PRODUCT", performanceScore: 60 }),
    ]);
    expect(aggregates.byPageType.HOME?.count).toBe(1);
    expect(aggregates.byPageType.PRODUCT?.count).toBe(2);
    expect(aggregates.byPageType.PRODUCT?.performanceScore).toBe(55);
  });

  it("returns an empty aggregate for no results", () => {
    const aggregates = computeAggregates([]);
    expect(aggregates.overall.count).toBe(0);
    expect(aggregates.overall.performanceScore).toBeNull();
    expect(aggregates.byMarket).toEqual({});
    expect(aggregates.byDevice).toEqual({});
    expect(aggregates.byPageType).toEqual({});
  });
});

describe("compareRuns — overall deltas", () => {
  it("computes current minus baseline per field", () => {
    const current = makeRunSummary({
      pageResults: [makePageResult({ performanceScore: 90, lcpMs: 2000 })],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ performanceScore: 80, lcpMs: 2500 })],
    });
    const comparison = compareRuns(current, baseline);
    expect(comparison.deltas.performanceScore).toBe(10);
    expect(comparison.deltas.lcpMs).toBe(-500);
    expect(comparison.deltas.count).toBe(0);
  });

  it("skips fields where either side is null", () => {
    const current = makeRunSummary({
      pageResults: [makePageResult({ seoScore: 90 })],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ seoScore: null })],
    });
    const comparison = compareRuns(current, baseline);
    expect("seoScore" in comparison.deltas).toBe(false);
  });

  it("rounds deltas to three decimals to remove floating-point noise", () => {
    const current = makeRunSummary({
      pageResults: [makePageResult({ cls: 0.3 })],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ cls: 0.1 })],
    });
    const comparison = compareRuns(current, baseline);
    expect(comparison.deltas.cls).toBe(0.2);
  });

  it("preserves small CLS deltas at three-decimal precision", () => {
    const current = makeRunSummary({
      pageResults: [makePageResult({ cls: 0.121 })],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ cls: 0.1 })],
    });
    const comparison = compareRuns(current, baseline);
    expect(comparison.deltas.cls).toBe(0.021);
  });

  it("exposes both aggregates on the comparison", () => {
    const current = makeRunSummary({
      pageResults: [makePageResult({ performanceScore: 90 })],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ performanceScore: 80 })],
    });
    const comparison = compareRuns(current, baseline);
    expect(comparison.current.overall.performanceScore).toBe(90);
    expect(comparison.baseline.overall.performanceScore).toBe(80);
  });
});

describe("compareRuns — urlDeltas", () => {
  const url = "https://shop.example.com/products/tee";

  it("matches results by url and device", () => {
    const current = makeRunSummary({
      pageResults: [
        makePageResult({
          url,
          device: "MOBILE",
          pageType: "PRODUCT",
          performanceScore: 90,
          lcpMs: 2000,
          cls: 0.1,
        }),
      ],
    });
    const baseline = makeRunSummary({
      pageResults: [
        makePageResult({
          url,
          device: "MOBILE",
          pageType: "PRODUCT",
          performanceScore: 80,
          lcpMs: 2400,
          cls: 0.15,
        }),
      ],
    });
    const comparison = compareRuns(current, baseline);
    expect(comparison.urlDeltas).toHaveLength(1);
    const delta = comparison.urlDeltas[0];
    expect(delta.url).toBe(url);
    expect(delta.device).toBe("MOBILE");
    expect(delta.pageType).toBe("PRODUCT");
    expect(delta.performanceDelta).toBe(10);
    expect(delta.lcpDeltaMs).toBe(-400);
    expect(delta.clsDelta).toBeCloseTo(-0.05, 10);
  });

  it("does not match the same url on a different device", () => {
    const current = makeRunSummary({
      pageResults: [makePageResult({ url, device: "MOBILE" })],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ url, device: "DESKTOP" })],
    });
    expect(compareRuns(current, baseline).urlDeltas).toEqual([]);
  });

  it("skips urls missing from the baseline", () => {
    const current = makeRunSummary({
      pageResults: [makePageResult({ url })],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ url: "https://shop.example.com/other" })],
    });
    expect(compareRuns(current, baseline).urlDeltas).toEqual([]);
  });

  it("skips pairs that were not COMPLETED in both runs", () => {
    const current = makeRunSummary({
      pageResults: [
        makePageResult({ url, status: "FAILED" }),
        makePageResult({ url: "https://shop.example.com/b" }),
      ],
    });
    const baseline = makeRunSummary({
      pageResults: [
        makePageResult({ url }),
        makePageResult({ url: "https://shop.example.com/b", status: "FAILED" }),
      ],
    });
    expect(compareRuns(current, baseline).urlDeltas).toEqual([]);
  });

  it("is null-safe on individual metric deltas", () => {
    const current = makeRunSummary({
      pageResults: [makePageResult({ url, cls: null, performanceScore: 90 })],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ url, cls: 0.1, performanceScore: 80 })],
    });
    const comparison = compareRuns(current, baseline);
    expect(comparison.urlDeltas[0].clsDelta).toBeNull();
    expect(comparison.urlDeltas[0].performanceDelta).toBe(10);
  });

  it("keeps only the first occurrence of a duplicated url+device pair", () => {
    const current = makeRunSummary({
      pageResults: [
        makePageResult({ url, performanceScore: 90 }),
        makePageResult({ url, performanceScore: 50 }),
      ],
    });
    const baseline = makeRunSummary({
      pageResults: [makePageResult({ url, performanceScore: 80 })],
    });
    const comparison = compareRuns(current, baseline);
    expect(comparison.urlDeltas).toHaveLength(1);
    expect(comparison.urlDeltas[0].performanceDelta).toBe(10);
  });
});
