// Read-side queries for dashboards, run history and report pages.
// All queries are scoped by shopId so a shop can never read another shop's runs.

import prisma from "../db.server";
import type { DeviceProfile, PageTypeKey, ProfileSnapshot } from "../lib/types";

type RunTriggerValue = "MANUAL" | "SCHEDULED" | "THEME_PUBLISH";
type RunStatusValue =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELED";

function snapshotName(profileSnapshot: unknown): string | null {
  const snapshot = profileSnapshot as Partial<ProfileSnapshot> | null;
  return snapshot && typeof snapshot.name === "string" ? snapshot.name : null;
}

/**
 * One run with everything the report page needs: ordered page results, alerts,
 * active share links and the profile name frozen in the snapshot.
 */
export async function getRunWithResults(shopId: string, runId: string) {
  const run = await prisma.auditRun.findFirst({
    where: { id: runId, shopId },
    include: {
      pageResults: {
        orderBy: [
          { marketHandle: "asc" },
          { pageType: "asc" },
          { url: "asc" },
          { device: "asc" },
        ],
      },
      alerts: { orderBy: { createdAt: "desc" } },
      shareLinks: {
        where: { revokedAt: null },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!run) return null;
  return { ...run, profileName: snapshotName(run.profileSnapshot) };
}

export interface RunListItem {
  id: string;
  createdAt: string; // ISO
  completedAt: string | null;
  trigger: RunTriggerValue;
  status: RunStatusValue;
  themeName: string | null;
  profileId: string | null;
  profileName: string | null;
  totalResults: number;
  completedResults: number;
  failedResults: number;
  alertCount: number;
  /** Average performanceScore of COMPLETED page results (computed in JS). */
  avgPerformanceScore: number | null;
}

/** Newest-first run list with counts and quick aggregates, cursor-paginated. */
export async function listRuns(
  shopId: string,
  opts: {
    profileId?: string;
    trigger?: string;
    status?: string;
    take?: number;
    cursor?: string;
  } = {},
): Promise<{ items: RunListItem[]; nextCursor: string | null }> {
  const take = opts.take ?? 20;
  const runs = await prisma.auditRun.findMany({
    where: {
      shopId,
      ...(opts.profileId ? { profileId: opts.profileId } : {}),
      ...(opts.trigger ? { trigger: opts.trigger as RunTriggerValue } : {}),
      ...(opts.status ? { status: opts.status as RunStatusValue } : {}),
    },
    // id is a unique tiebreaker: cursor pagination over createdAt alone can
    // skip or duplicate rows when runs share the same timestamp.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: {
      pageResults: { select: { status: true, performanceScore: true } },
      _count: { select: { alerts: true } },
    },
  });

  const hasMore = runs.length > take;
  const page = hasMore ? runs.slice(0, take) : runs;

  const items: RunListItem[] = page.map((run) => {
    const scored = run.pageResults.filter(
      (r) => r.status === "COMPLETED" && r.performanceScore != null,
    );
    const avgPerformanceScore = scored.length
      ? Math.round(
          scored.reduce((sum, r) => sum + (r.performanceScore ?? 0), 0) /
            scored.length,
        )
      : null;
    return {
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      trigger: run.trigger,
      status: run.status,
      themeName: run.themeName,
      profileId: run.profileId,
      profileName: snapshotName(run.profileSnapshot),
      totalResults: run.pageResults.length,
      completedResults: run.pageResults.filter((r) => r.status === "COMPLETED")
        .length,
      failedResults: run.pageResults.filter((r) => r.status === "FAILED")
        .length,
      alertCount: run._count.alerts,
      avgPerformanceScore,
    };
  });

  return {
    items,
    nextCursor: hasMore && page.length ? page[page.length - 1].id : null,
  };
}

export interface TrendRunPoint {
  runId: string;
  date: string; // createdAt ISO
  themeName: string | null;
  scores: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  lab: { lcpMs: number | null; cls: number | null; tbtMs: number | null };
  field: { lcpMs: number | null; inpMs: number | null; cls: number | null };
}

function average(values: (number | null)[]): number | null {
  const present = values.filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  if (!present.length) return null;
  const avg = present.reduce((sum, v) => sum + v, 0) / present.length;
  return Math.round(avg * 1000) / 1000;
}

/**
 * Last N (default 12) COMPLETED/PARTIAL runs in ascending chronological order,
 * with per-run averages of the COMPLETED page results matching the filters.
 */
export async function getTrendData(
  shopId: string,
  profileId: string | null,
  opts: {
    device?: DeviceProfile;
    marketHandle?: string;
    pageType?: PageTypeKey;
    take?: number;
  } = {},
): Promise<TrendRunPoint[]> {
  const take = opts.take ?? 12;
  const runs = await prisma.auditRun.findMany({
    where: {
      shopId,
      status: { in: ["COMPLETED", "PARTIAL"] },
      ...(profileId ? { profileId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      pageResults: {
        where: {
          status: "COMPLETED",
          ...(opts.device ? { device: opts.device } : {}),
          ...(opts.marketHandle ? { marketHandle: opts.marketHandle } : {}),
          ...(opts.pageType ? { pageType: opts.pageType } : {}),
        },
      },
    },
  });

  return runs.reverse().map((run) => {
    const results = run.pageResults;
    return {
      runId: run.id,
      date: run.createdAt.toISOString(),
      themeName: run.themeName,
      scores: {
        performance: average(results.map((r) => r.performanceScore)),
        accessibility: average(results.map((r) => r.accessibilityScore)),
        bestPractices: average(results.map((r) => r.bestPracticesScore)),
        seo: average(results.map((r) => r.seoScore)),
      },
      lab: {
        lcpMs: average(results.map((r) => r.lcpMs)),
        cls: average(results.map((r) => r.cls)),
        tbtMs: average(results.map((r) => r.tbtMs)),
      },
      field: {
        lcpMs: average(results.map((r) => r.fieldLcpMs)),
        inpMs: average(results.map((r) => r.fieldInpMs)),
        cls: average(results.map((r) => r.fieldCls)),
      },
    };
  });
}

/**
 * The most recent data-bearing terminal run (COMPLETED/PARTIAL) of the same
 * profile, strictly before the given run — the comparison baseline.
 */
export async function getPreviousRun(
  shopId: string,
  run: { id: string; profileId: string | null; createdAt: Date },
) {
  // A null profileId (deleted/orphaned profile) would match runs of OTHER
  // orphaned profiles via the IS NULL join — never compare across profiles.
  if (run.profileId == null) return null;
  return prisma.auditRun.findFirst({
    where: {
      shopId,
      id: { not: run.id },
      profileId: run.profileId,
      createdAt: { lt: run.createdAt },
      status: { in: ["COMPLETED", "PARTIAL"] },
    },
    orderBy: { createdAt: "desc" },
    include: { pageResults: true },
  });
}
