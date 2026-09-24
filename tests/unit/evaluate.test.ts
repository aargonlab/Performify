import { describe, expect, it } from "vitest";

import type { Threshold } from "../../app/lib/types";
import { evaluateThresholds } from "../../app/lib/alerts/evaluate";
import { makePageResult } from "../fixtures/page-result";

function makeThreshold(overrides: Partial<Threshold> = {}): Threshold {
  return {
    id: "t-1",
    metric: "performanceScore",
    operator: "lt",
    value: 90,
    severity: "warning",
    ...overrides,
  };
}

describe("evaluateThresholds — operators", () => {
  it("lt flags scores strictly below the threshold", () => {
    const candidates = evaluateThresholds(
      [makeThreshold({ metric: "performanceScore", operator: "lt", value: 90 })],
      [makePageResult({ performanceScore: 85 })],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      metric: "performanceScore",
      operator: "lt",
      threshold: 90,
      actual: 85,
      severity: "warning",
    });
  });

  it("lt does not flag a score equal to the threshold", () => {
    const candidates = evaluateThresholds(
      [makeThreshold({ operator: "lt", value: 90 })],
      [makePageResult({ performanceScore: 90 })],
    );
    expect(candidates).toEqual([]);
  });

  it("gt flags timings strictly above the threshold", () => {
    const candidates = evaluateThresholds(
      [makeThreshold({ metric: "lcpMs", operator: "gt", value: 2500 })],
      [makePageResult({ lcpMs: 3000, performanceScore: 95 })],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      metric: "lcpMs",
      actual: 3000,
      threshold: 2500,
    });
  });

  it("gt does not flag a timing equal to or below the threshold", () => {
    const candidates = evaluateThresholds(
      [makeThreshold({ metric: "lcpMs", operator: "gt", value: 2500 })],
      [
        makePageResult({ lcpMs: 2500 }),
        makePageResult({ lcpMs: 2000 }),
      ],
    );
    expect(candidates).toEqual([]);
  });

  it("carries the page context onto the candidate", () => {
    const candidates = evaluateThresholds(
      [makeThreshold({ operator: "lt", value: 90 })],
      [
        makePageResult({
          performanceScore: 50,
          url: "https://shop.example.com/products/tee",
          marketHandle: "eu",
          device: "DESKTOP",
          pageType: "PRODUCT",
        }),
      ],
    );
    expect(candidates[0]).toMatchObject({
      url: "https://shop.example.com/products/tee",
      marketHandle: "eu",
      device: "DESKTOP",
      pageType: "PRODUCT",
    });
  });
});

describe("evaluateThresholds — skipping", () => {
  it("skips results with a null metric value", () => {
    const candidates = evaluateThresholds(
      [makeThreshold({ metric: "fieldLcpMs", operator: "gt", value: 2500 })],
      [makePageResult({ fieldLcpMs: null })],
    );
    expect(candidates).toEqual([]);
  });

  it("skips results that are not COMPLETED", () => {
    const candidates = evaluateThresholds(
      [makeThreshold({ operator: "lt", value: 90 })],
      [
        makePageResult({ status: "FAILED", performanceScore: 10 }),
        makePageResult({ status: "PENDING", performanceScore: 10 }),
        makePageResult({ status: "RUNNING", performanceScore: 10 }),
      ],
    );
    expect(candidates).toEqual([]);
  });
});

describe("evaluateThresholds — dedupe per (metric, url, device)", () => {
  it("keeps the most severe candidate when two thresholds hit the same tuple", () => {
    const candidates = evaluateThresholds(
      [
        makeThreshold({
          id: "warn",
          metric: "lcpMs",
          operator: "gt",
          value: 2000,
          severity: "warning",
        }),
        makeThreshold({
          id: "crit",
          metric: "lcpMs",
          operator: "gt",
          value: 3000,
          severity: "critical",
        }),
      ],
      [makePageResult({ lcpMs: 4000 })],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].severity).toBe("critical");
    expect(candidates[0].threshold).toBe(3000);
  });

  it("keeps the largest deviation when severities are equal", () => {
    const candidates = evaluateThresholds(
      [
        makeThreshold({ id: "a", metric: "lcpMs", operator: "gt", value: 3500 }),
        makeThreshold({ id: "b", metric: "lcpMs", operator: "gt", value: 2000 }),
      ],
      [makePageResult({ lcpMs: 4000 })],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].threshold).toBe(2000);
  });

  it("does not dedupe across devices or urls", () => {
    const candidates = evaluateThresholds(
      [makeThreshold({ metric: "lcpMs", operator: "gt", value: 2000 })],
      [
        makePageResult({ url: "https://a.example.com/", device: "MOBILE", lcpMs: 3000 }),
        makePageResult({ url: "https://a.example.com/", device: "DESKTOP", lcpMs: 3000 }),
        makePageResult({ url: "https://b.example.com/", device: "MOBILE", lcpMs: 3000 }),
      ],
    );
    expect(candidates).toHaveLength(3);
  });
});

describe("evaluateThresholds — ordering", () => {
  it("sorts critical first, then by deviation descending", () => {
    const candidates = evaluateThresholds(
      [
        makeThreshold({
          id: "crit",
          metric: "performanceScore",
          operator: "lt",
          value: 90,
          severity: "critical",
        }),
        makeThreshold({
          id: "warn",
          metric: "lcpMs",
          operator: "gt",
          value: 1000,
          severity: "warning",
        }),
      ],
      [
        makePageResult({
          url: "https://a.example.com/",
          performanceScore: 85,
          lcpMs: 900,
        }),
        makePageResult({
          url: "https://b.example.com/",
          performanceScore: 40,
          lcpMs: 5000,
        }),
      ],
    );
    expect(
      candidates.map((c) => [c.severity, c.metric, c.url]),
    ).toEqual([
      ["critical", "performanceScore", "https://b.example.com/"],
      ["critical", "performanceScore", "https://a.example.com/"],
      ["warning", "lcpMs", "https://b.example.com/"],
    ]);
  });
});
