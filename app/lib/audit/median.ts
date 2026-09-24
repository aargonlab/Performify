// ---------------------------------------------------------------------------
// Pure aggregation of N AuditSnapshots (runsPerUrl) into a single result.
// The median tames Lighthouse run-to-run variance; CrUX field data is a
// 28-day window and thus identical across back-to-back runs.
// ---------------------------------------------------------------------------

import type { AuditSnapshot, OpportunityFinding } from "./types";

export interface AggregatedResult {
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
  fieldSource: "page" | "origin" | null;
  fieldLcpMs: number | null;
  fieldInpMs: number | null;
  fieldCls: number | null;
  fieldOverall: string | null;
  lighthouseVersion: string | null;
  topOpportunities: OpportunityFinding[];
}

/** Median of a list; null on empty, average of the middle two on even count. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Merge opportunities by audit id; savingsMs = median where present. */
function mergeOpportunities(snapshots: AuditSnapshot[]): OpportunityFinding[] {
  const byId = new Map<string, OpportunityFinding[]>();
  for (const snapshot of snapshots) {
    for (const opportunity of snapshot.opportunities) {
      const existing = byId.get(opportunity.id);
      if (existing) {
        existing.push(opportunity);
      } else {
        byId.set(opportunity.id, [opportunity]);
      }
    }
  }

  const merged: OpportunityFinding[] = [];
  for (const findings of byId.values()) {
    const first = findings[0];
    const finding: OpportunityFinding = {
      id: first.id,
      title: first.title,
      savingsMs: median(findings.map((f) => f.savingsMs)) ?? 0,
      score: first.score,
    };
    if (first.displayValue !== undefined) {
      finding.displayValue = first.displayValue;
    }
    merged.push(finding);
  }

  return merged.sort((a, b) => b.savingsMs - a.savingsMs).slice(0, 10);
}

/**
 * Aggregates snapshots of the same URL × device: median per numeric metric
 * (nulls ignored), field data from the first snapshot that has it,
 * lighthouseVersion from the first snapshot, top 10 merged opportunities.
 */
export function aggregateSnapshots(
  snapshots: AuditSnapshot[],
): AggregatedResult {
  const medianOf = (
    pick: (snapshot: AuditSnapshot) => number | null,
  ): number | null =>
    median(
      snapshots.map(pick).filter((value): value is number => value !== null),
    );

  const field = snapshots.find(
    (snapshot) => snapshot.field !== undefined,
  )?.field;
  const firstVersion = snapshots[0]?.lighthouseVersion;

  return {
    performanceScore: medianOf((s) => s.categories.performance),
    accessibilityScore: medianOf((s) => s.categories.accessibility),
    bestPracticesScore: medianOf((s) => s.categories.bestPractices),
    seoScore: medianOf((s) => s.categories.seo),
    lcpMs: medianOf((s) => s.labMetrics.lcpMs),
    cls: medianOf((s) => s.labMetrics.cls),
    tbtMs: medianOf((s) => s.labMetrics.tbtMs),
    fcpMs: medianOf((s) => s.labMetrics.fcpMs),
    speedIndexMs: medianOf((s) => s.labMetrics.speedIndexMs),
    ttfbMs: medianOf((s) => s.labMetrics.ttfbMs),
    fieldSource: field?.source ?? null,
    fieldLcpMs: field?.lcpMs ?? null,
    fieldInpMs: field?.inpMs ?? null,
    fieldCls: field?.cls ?? null,
    fieldOverall: field?.overall ?? null,
    lighthouseVersion: firstVersion ? firstVersion : null,
    topOpportunities: mergeOpportunities(snapshots),
  };
}
