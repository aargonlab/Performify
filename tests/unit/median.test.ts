import { describe, expect, it } from "vitest";

import { aggregateSnapshots, median } from "../../app/lib/audit/median";
import type {
  AuditSnapshot,
  OpportunityFinding,
} from "../../app/lib/audit/types";

interface SnapshotOverrides {
  categories?: Partial<AuditSnapshot["categories"]>;
  labMetrics?: Partial<AuditSnapshot["labMetrics"]>;
  field?: AuditSnapshot["field"];
  opportunities?: OpportunityFinding[];
  lighthouseVersion?: string;
}

function makeSnapshot(overrides: SnapshotOverrides = {}): AuditSnapshot {
  const snapshot: AuditSnapshot = {
    engine: "psi",
    lighthouseVersion: overrides.lighthouseVersion ?? "13.0.0",
    fetchedAt: "2026-07-06T10:00:00.000Z",
    requestedUrl: "https://shop.example.com/",
    finalUrl: "https://shop.example.com/",
    strategy: "MOBILE",
    categories: {
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
      ...overrides.categories,
    },
    labMetrics: {
      lcpMs: null,
      cls: null,
      tbtMs: null,
      fcpMs: null,
      speedIndexMs: null,
      ttfbMs: null,
      ...overrides.labMetrics,
    },
    opportunities: overrides.opportunities ?? [],
    raw: {},
  };
  if (overrides.field !== undefined) snapshot.field = overrides.field;
  return snapshot;
}

function opportunity(
  id: string,
  savingsMs: number,
  extra: Partial<OpportunityFinding> = {},
): OpportunityFinding {
  return { id, title: `Title for ${id}`, savingsMs, score: 0.5, ...extra };
}

describe("median", () => {
  it("returns null for an empty list", () => {
    expect(median([])).toBeNull();
  });

  it("returns the middle value for an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even-length list", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("returns the value itself for a single-element list", () => {
    expect(median([7])).toBe(7);
  });

  it("does not mutate the input array", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("aggregateSnapshots — metric medians", () => {
  it("takes the median of each metric across three snapshots", () => {
    const result = aggregateSnapshots([
      makeSnapshot({
        categories: { performance: 80, seo: 100 },
        labMetrics: { lcpMs: 2000, tbtMs: 100 },
      }),
      makeSnapshot({
        categories: { performance: 90, seo: 90 },
        labMetrics: { lcpMs: 2600, tbtMs: 250 },
      }),
      makeSnapshot({
        categories: { performance: 70, seo: 95 },
        labMetrics: { lcpMs: 2300, tbtMs: 400 },
      }),
    ]);
    expect(result.performanceScore).toBe(80);
    expect(result.seoScore).toBe(95);
    expect(result.lcpMs).toBe(2300);
    expect(result.tbtMs).toBe(250);
  });

  it("ignores null values when computing the median", () => {
    const result = aggregateSnapshots([
      makeSnapshot({ categories: { performance: 80 } }),
      makeSnapshot({ categories: { performance: null } }),
      makeSnapshot({ categories: { performance: 90 } }),
    ]);
    expect(result.performanceScore).toBe(85);
  });

  it("returns null when every snapshot has a null metric", () => {
    const result = aggregateSnapshots([makeSnapshot(), makeSnapshot()]);
    expect(result.performanceScore).toBeNull();
    expect(result.lcpMs).toBeNull();
    expect(result.cls).toBeNull();
  });

  it("returns an all-null aggregate for an empty snapshot list", () => {
    const result = aggregateSnapshots([]);
    expect(result.performanceScore).toBeNull();
    expect(result.fieldSource).toBeNull();
    expect(result.lighthouseVersion).toBeNull();
    expect(result.topOpportunities).toEqual([]);
  });
});

describe("aggregateSnapshots — field data", () => {
  it("takes field data from the first snapshot that has it", () => {
    const result = aggregateSnapshots([
      makeSnapshot(),
      makeSnapshot({
        field: {
          source: "page",
          lcpMs: 2600,
          inpMs: 180,
          cls: 0.12,
          overall: "AVERAGE",
        },
      }),
      makeSnapshot({
        field: {
          source: "origin",
          lcpMs: 9999,
          inpMs: 999,
          cls: 0.9,
          overall: "SLOW",
        },
      }),
    ]);
    expect(result.fieldSource).toBe("page");
    expect(result.fieldLcpMs).toBe(2600);
    expect(result.fieldInpMs).toBe(180);
    expect(result.fieldCls).toBe(0.12);
    expect(result.fieldOverall).toBe("AVERAGE");
  });

  it("returns null field values when no snapshot has field data", () => {
    const result = aggregateSnapshots([makeSnapshot(), makeSnapshot()]);
    expect(result.fieldSource).toBeNull();
    expect(result.fieldLcpMs).toBeNull();
    expect(result.fieldInpMs).toBeNull();
    expect(result.fieldCls).toBeNull();
    expect(result.fieldOverall).toBeNull();
  });
});

describe("aggregateSnapshots — lighthouse version", () => {
  it("uses the first snapshot's version", () => {
    const result = aggregateSnapshots([
      makeSnapshot({ lighthouseVersion: "13.0.0" }),
      makeSnapshot({ lighthouseVersion: "12.9.1" }),
    ]);
    expect(result.lighthouseVersion).toBe("13.0.0");
  });

  it("maps an empty-string version to null", () => {
    const result = aggregateSnapshots([
      makeSnapshot({ lighthouseVersion: "" }),
    ]);
    expect(result.lighthouseVersion).toBeNull();
  });
});

describe("aggregateSnapshots — opportunity merge", () => {
  it("merges opportunities by id using the median of their savings", () => {
    const result = aggregateSnapshots([
      makeSnapshot({
        opportunities: [
          opportunity("unused-javascript", 400, {
            displayValue: "Potential savings of 400 ms",
          }),
          opportunity("render-blocking-resources", 450),
        ],
      }),
      makeSnapshot({ opportunities: [opportunity("unused-javascript", 900)] }),
      makeSnapshot({ opportunities: [opportunity("unused-javascript", 600)] }),
    ]);
    expect(result.topOpportunities).toHaveLength(2);
    expect(result.topOpportunities[0]).toEqual({
      id: "unused-javascript",
      title: "Title for unused-javascript",
      savingsMs: 600,
      score: 0.5,
      displayValue: "Potential savings of 400 ms",
    });
    expect(result.topOpportunities[1].id).toBe("render-blocking-resources");
    expect(result.topOpportunities[1].savingsMs).toBe(450);
  });

  it("sorts merged opportunities by savings descending", () => {
    const result = aggregateSnapshots([
      makeSnapshot({
        opportunities: [
          opportunity("small", 100),
          opportunity("large", 1000),
          opportunity("mid", 500),
        ],
      }),
    ]);
    expect(result.topOpportunities.map((o) => o.id)).toEqual([
      "large",
      "mid",
      "small",
    ]);
  });

  it("caps the merged list at the top 10 opportunities", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      opportunity(`audit-${index}`, (12 - index) * 100),
    );
    const result = aggregateSnapshots([makeSnapshot({ opportunities: many })]);
    expect(result.topOpportunities).toHaveLength(10);
    expect(result.topOpportunities[0].savingsMs).toBe(1200);
    const ids = result.topOpportunities.map((o) => o.id);
    expect(ids).not.toContain("audit-10");
    expect(ids).not.toContain("audit-11");
  });
});
