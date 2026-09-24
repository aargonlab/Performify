// ---------------------------------------------------------------------------
// Threshold evaluation — pure logic, no I/O. Given the thresholds frozen in a
// run's profile snapshot and the run's page results, produce alert candidates.
// The finalize processor persists them as Alert rows and triggers notifications.
// ---------------------------------------------------------------------------

import type {
  DeviceProfile,
  PageTypeKey,
  Threshold,
  ThresholdMetric,
} from "../types";
import type { PageResultSummary } from "../report/types";

export interface AlertCandidate {
  metric: ThresholdMetric;
  operator: "lt" | "gt";
  threshold: number;
  actual: number;
  severity: "warning" | "critical";
  url?: string;
  marketHandle?: string | null;
  device?: DeviceProfile;
  pageType?: PageTypeKey;
}

/**
 * Evaluate every threshold against every COMPLETED page result.
 *
 * - The metric name matches the PageResultSummary field name 1:1.
 * - Results without a value for the metric are skipped (e.g. no CrUX data).
 * - Violation: `lt` → actual < value (scores), `gt` → actual > value (timings).
 * - One candidate per violating page; identical (metric, url, device) tuples
 *   are deduped keeping the most severe (then largest deviation).
 * - Output is sorted critical first, then by |actual − threshold| descending.
 */
export function evaluateThresholds(
  thresholds: Threshold[],
  results: PageResultSummary[],
): AlertCandidate[] {
  const byKey = new Map<string, AlertCandidate>();

  for (const threshold of thresholds) {
    for (const result of results) {
      if (result.status !== "COMPLETED") continue;

      const actual = result[threshold.metric];
      if (actual === null) continue;

      const violated =
        threshold.operator === "lt"
          ? actual < threshold.value
          : actual > threshold.value;
      if (!violated) continue;

      const candidate: AlertCandidate = {
        metric: threshold.metric,
        operator: threshold.operator,
        threshold: threshold.value,
        actual,
        severity: threshold.severity,
        url: result.url,
        marketHandle: result.marketHandle,
        device: result.device,
        pageType: result.pageType,
      };

      const key = `${candidate.metric}|${candidate.url}|${candidate.device}`;
      const existing = byKey.get(key);
      if (!existing || compareCandidates(candidate, existing) < 0) {
        byKey.set(key, candidate);
      }
    }
  }

  return [...byKey.values()].sort(compareCandidates);
}

/** Orders candidates: critical before warning, then largest deviation first. */
function compareCandidates(a: AlertCandidate, b: AlertCandidate): number {
  if (a.severity !== b.severity) {
    return a.severity === "critical" ? -1 : 1;
  }
  return deviation(b) - deviation(a);
}

function deviation(candidate: AlertCandidate): number {
  return Math.abs(candidate.actual - candidate.threshold);
}
