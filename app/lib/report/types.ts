// Plain data shapes used by the comparison/narrative/alert logic.
// Deliberately Prisma-free so app/lib stays pure and unit-testable;
// services map Prisma rows to these.

import type { PageTypeKey, DeviceProfile } from "../types";

export interface PageResultSummary {
  id: string;
  url: string;
  pageType: PageTypeKey;
  device: DeviceProfile;
  marketHandle: string | null;
  marketName: string | null;
  locale: string | null;
  label: string | null;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;

  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  ttfbMs: number | null;

  fieldSource: string | null;
  fieldLcpMs: number | null;
  fieldInpMs: number | null;
  fieldCls: number | null;
  fieldOverall: string | null;

  topOpportunities:
    | { id: string; title: string; savingsMs: number; score: number | null }[]
    | null;
}

export interface RunSummary {
  id: string;
  createdAt: string; // ISO
  trigger: "MANUAL" | "SCHEDULED" | "THEME_PUBLISH";
  themeName: string | null;
  status: string;
  pageResults: PageResultSummary[];
}

/** Averages across completed page results, per device and overall. */
export interface RunAggregates {
  overall: CategoryAverages;
  byDevice: Partial<Record<DeviceProfile, CategoryAverages>>;
  byMarket: Record<string, CategoryAverages>; // key = marketHandle ?? "default"
  byPageType: Partial<Record<PageTypeKey, CategoryAverages>>;
}

export interface CategoryAverages {
  count: number;
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fieldLcpMs: number | null;
  fieldInpMs: number | null;
  fieldCls: number | null;
}

/** Delta between two runs for one dimension slice. */
export interface RunComparison {
  baseline: RunAggregates;
  current: RunAggregates;
  /** current − baseline for every numeric field of CategoryAverages.overall */
  deltas: Partial<Record<keyof CategoryAverages, number>>;
  /** Per-URL matches (same url+device present in both runs) */
  urlDeltas: {
    url: string;
    device: DeviceProfile;
    pageType: PageTypeKey;
    marketHandle: string | null;
    performanceDelta: number | null;
    lcpDeltaMs: number | null;
    clsDelta: number | null;
  }[];
}
