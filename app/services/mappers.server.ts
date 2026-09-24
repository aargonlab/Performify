// ---------------------------------------------------------------------------
// Prisma row → pure report shapes (app/lib/report/types).
// Keeps app/lib Prisma-free: everything downstream (compare, narrative,
// alerts) consumes these plain objects.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import type { PageResultSummary, RunSummary } from "../lib/report/types";

export type PrismaPageResult = Prisma.PageResultGetPayload<
  Prisma.PageResultDefaultArgs
>;

export type PrismaAuditRunWithResults = Prisma.AuditRunGetPayload<{
  include: { pageResults: true };
}>;

export function toPageResultSummary(row: PrismaPageResult): PageResultSummary {
  return {
    id: row.id,
    url: row.url,
    pageType: row.pageType,
    device: row.device,
    marketHandle: row.marketHandle,
    marketName: row.marketName,
    locale: row.locale,
    label: row.label,
    status: row.status,

    performanceScore: row.performanceScore,
    accessibilityScore: row.accessibilityScore,
    bestPracticesScore: row.bestPracticesScore,
    seoScore: row.seoScore,

    lcpMs: row.lcpMs,
    cls: row.cls,
    tbtMs: row.tbtMs,
    fcpMs: row.fcpMs,
    speedIndexMs: row.speedIndexMs,
    ttfbMs: row.ttfbMs,

    fieldSource: row.fieldSource,
    fieldLcpMs: row.fieldLcpMs,
    fieldInpMs: row.fieldInpMs,
    fieldCls: row.fieldCls,
    fieldOverall: row.fieldOverall,

    topOpportunities: (row.topOpportunities ??
      null) as unknown as PageResultSummary["topOpportunities"],
  };
}

export function toRunSummary(run: PrismaAuditRunWithResults): RunSummary {
  return {
    id: run.id,
    createdAt: run.createdAt.toISOString(),
    trigger: run.trigger,
    themeName: run.themeName,
    status: run.status,
    pageResults: run.pageResults.map(toPageResultSummary),
  };
}
