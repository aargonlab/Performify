// ---------------------------------------------------------------------------
// AUDIT_QUEUE processor: runs N Lighthouse audits (via the AuditEngine) for
// one PageResult, stores raw snapshots, aggregates the median, and enqueues
// run finalization when the PageResult reaches a terminal state.
//
// QuotaExceededError is deliberately re-thrown untouched: worker/index.ts
// converts it into worker.rateLimit() + Worker.RateLimitError() so the job is
// retried without consuming an attempt.
// ---------------------------------------------------------------------------

import type { Job } from "bullmq";
import type { Prisma } from "@prisma/client";
import prisma from "../../app/db.server";
import { getAuditEngine } from "../../app/lib/audit/engine-factory.server";
import { aggregateSnapshots } from "../../app/lib/audit/median";
import { QuotaExceededError, type AuditSnapshot } from "../../app/lib/audit/types";
import { getControlQueue, type AuditUrlJob } from "../../app/queues/queues.server";
import { parseProfileSnapshot } from "../../app/services/runs.server";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function roundOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

/**
 * Enqueues run finalization. The terminal count is part of the jobId so each
 * terminal PageResult produces a distinct finalize job (duplicate jobIds are
 * no-ops in BullMQ); finalizeRun itself is idempotent, so extra jobs are safe.
 */
export async function enqueueFinalize(
  runId: string,
  terminalCount: number,
): Promise<void> {
  await getControlQueue().add(
    "run-finalize",
    { kind: "run-finalize", runId },
    // BullMQ restricts ":" in custom job ids — keep them colon-free
    { jobId: `finalize-${runId}-${terminalCount}` },
  );
}

export async function processAuditUrl(job: Job<AuditUrlJob>): Promise<void> {
  const { pageResultId } = job.data;

  const pageResult = await prisma.pageResult.findUnique({
    where: { id: pageResultId },
    include: { run: { include: { shop: true } } },
  });
  if (!pageResult) return; // deleted (shop redacted, run removed) — skip
  if (pageResult.status === "COMPLETED" || pageResult.status === "FAILED") {
    // Already terminal (stalled-job retry). The original attempt may have
    // crashed between the terminal write and enqueueFinalize, so re-enqueue
    // finalization (finalizeRun is idempotent) instead of skipping silently —
    // otherwise the run could stay RUNNING forever.
    const terminalCount = await prisma.pageResult.count({
      where: {
        runId: pageResult.runId,
        status: { in: ["COMPLETED", "FAILED"] },
      },
    });
    await enqueueFinalize(pageResult.runId, terminalCount);
    return;
  }
  if (pageResult.run.status === "CANCELED") return;

  const run = pageResult.run;
  const snapshot = parseProfileSnapshot(run.profileSnapshot);
  const runsRequested =
    pageResult.runsRequested > 0 ? pageResult.runsRequested : snapshot.runsPerUrl;

  await prisma.pageResult.update({
    where: { id: pageResult.id },
    data: { status: "RUNNING" },
  });

  const shopSettings = asRecord(run.shop.settings);
  const apiKey =
    typeof shopSettings?.psiApiKey === "string" && shopSettings.psiApiKey !== ""
      ? shopSettings.psiApiKey
      : undefined;
  const engine = getAuditEngine("psi", { apiKey });

  // Reuse snapshots already stored by a previous (partially failed) attempt.
  const existingReports = await prisma.rawReport.findMany({
    where: { pageResultId: pageResult.id },
  });
  const reportsByIndex = new Map(existingReports.map((r) => [r.runIndex, r]));

  const snapshots: AuditSnapshot[] = [];
  try {
    for (let runIndex = 0; runIndex < runsRequested; runIndex++) {
      const existing = reportsByIndex.get(runIndex);
      let snap: AuditSnapshot;
      if (existing) {
        snap = existing.json as unknown as AuditSnapshot;
      } else {
        snap = await engine.audit(
          { url: pageResult.url },
          {
            strategy: pageResult.device,
            categories: snapshot.categories,
            locale: pageResult.locale ?? undefined,
          },
        );
        const fetchedAt = new Date(snap.fetchedAt);
        await prisma.rawReport.upsert({
          where: {
            pageResultId_runIndex: {
              pageResultId: pageResult.id,
              runIndex,
            },
          },
          create: {
            pageResultId: pageResult.id,
            runIndex,
            json: snap as unknown as Prisma.InputJsonValue,
            ...(Number.isNaN(fetchedAt.getTime()) ? {} : { fetchedAt }),
          },
          update: {
            json: snap as unknown as Prisma.InputJsonValue,
          },
        });
      }
      snapshots.push(snap);
      await prisma.pageResult.update({
        where: { id: pageResult.id },
        data: { runsCompleted: runIndex + 1 },
      });
    }
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      // Provider quota exhausted: no terminal state, worker/index.ts pauses
      // the whole queue and retries this job without consuming an attempt.
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
    if (isFinalAttempt) {
      await prisma.pageResult.update({
        where: { id: pageResult.id },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
      const updatedRun = await prisma.auditRun.update({
        where: { id: run.id },
        data: { failedJobs: { increment: 1 } },
      });
      await enqueueFinalize(
        run.id,
        updatedRun.completedJobs + updatedRun.failedJobs,
      );
    } else {
      // Keep the error visible while BullMQ retries with backoff.
      await prisma.pageResult.update({
        where: { id: pageResult.id },
        data: { error: message },
      });
    }
    throw err;
  }

  const aggregated = aggregateSnapshots(snapshots);

  await prisma.pageResult.update({
    where: { id: pageResult.id },
    data: {
      status: "COMPLETED",
      error: null,
      runsCompleted: runsRequested,
      performanceScore: roundOrNull(aggregated.performanceScore),
      accessibilityScore: roundOrNull(aggregated.accessibilityScore),
      bestPracticesScore: roundOrNull(aggregated.bestPracticesScore),
      seoScore: roundOrNull(aggregated.seoScore),
      lcpMs: aggregated.lcpMs,
      cls: aggregated.cls,
      tbtMs: aggregated.tbtMs,
      fcpMs: aggregated.fcpMs,
      speedIndexMs: aggregated.speedIndexMs,
      ttfbMs: aggregated.ttfbMs,
      fieldSource: aggregated.fieldSource,
      fieldLcpMs: roundOrNull(aggregated.fieldLcpMs),
      fieldInpMs: roundOrNull(aggregated.fieldInpMs),
      fieldCls: aggregated.fieldCls,
      fieldOverall: aggregated.fieldOverall,
      lighthouseVersion: aggregated.lighthouseVersion,
      topOpportunities: (aggregated.topOpportunities ??
        []) as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });

  const updatedRun = await prisma.auditRun.update({
    where: { id: run.id },
    data: { completedJobs: { increment: 1 } },
  });
  await enqueueFinalize(run.id, updatedRun.completedJobs + updatedRun.failedJobs);
}
