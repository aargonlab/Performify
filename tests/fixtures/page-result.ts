// ---------------------------------------------------------------------------
// Shared builders for PageResultSummary / RunSummary used by the report,
// narrative, recommendation and alert unit tests.
// ---------------------------------------------------------------------------

import type { PageResultSummary, RunSummary } from "../../app/lib/report/types";

let counter = 0;

/** COMPLETED mobile homepage result with plausible metrics by default. */
export function makePageResult(
  overrides: Partial<PageResultSummary> = {},
): PageResultSummary {
  counter += 1;
  return {
    id: `pr-${counter}`,
    url: "https://shop.example.com/",
    pageType: "HOME",
    device: "MOBILE",
    marketHandle: null,
    marketName: null,
    locale: null,
    label: null,
    status: "COMPLETED",
    performanceScore: 80,
    accessibilityScore: 90,
    bestPracticesScore: 85,
    seoScore: 92,
    lcpMs: 2400,
    cls: 0.08,
    tbtMs: 300,
    fcpMs: 1200,
    speedIndexMs: 3400,
    ttfbMs: 420,
    fieldSource: null,
    fieldLcpMs: null,
    fieldInpMs: null,
    fieldCls: null,
    fieldOverall: null,
    topOpportunities: null,
    ...overrides,
  };
}

export function makeRunSummary(
  overrides: Partial<RunSummary> = {},
): RunSummary {
  counter += 1;
  return {
    id: `run-${counter}`,
    createdAt: "2026-07-01T08:00:00.000Z",
    trigger: "MANUAL",
    themeName: null,
    status: "COMPLETED",
    pageResults: [],
    ...overrides,
  };
}
