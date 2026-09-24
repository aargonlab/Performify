// ---------------------------------------------------------------------------
// Worker entrypoint (run via `npm run worker` → tsx worker/index.ts).
// - AUDIT_QUEUE worker: PSI calls, concurrency + per-minute limiter.
// - CONTROL_QUEUE worker: finalize / scheduled / theme-publish jobs.
// - Resyncs every profile's job scheduler on startup.
// ---------------------------------------------------------------------------

import { Worker } from "bullmq";
import prisma from "../app/db.server";
import { env } from "../app/lib/env.server";
import { QuotaExceededError } from "../app/lib/audit/types";
import type { ScheduleConfig } from "../app/lib/types";
import {
  createWorkerConnection,
  getRedisConnection,
} from "../app/queues/connection.server";
import {
  AUDIT_QUEUE,
  CONTROL_QUEUE,
  getAuditQueue,
  type AuditUrlJob,
  type ControlJob,
} from "../app/queues/queues.server";
import { syncProfileScheduler } from "../app/services/scheduler.server";
import { enqueueFinalize, processAuditUrl } from "./processors/audit-url";
import { processControlJob } from "./processors/control";

const AUDIT_CONCURRENCY = env.auditConcurrency();
const PSI_PER_MINUTE = env.psiPerMinuteLimit();
const CONTROL_CONCURRENCY = 4;

const auditConnection = createWorkerConnection();
const controlConnection = createWorkerConnection();

// --- Audit worker (rate-limited: PSI quota) -----------------------------------

const auditWorker: Worker<AuditUrlJob> = new Worker<AuditUrlJob>(
  AUDIT_QUEUE,
  async (job) => {
    try {
      await processAuditUrl(job);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        console.warn(
          `[worker] PSI quota exceeded (job ${job.id}): pausing audit queue for ${err.retryInMs}ms — ${err.message}`,
        );
        await auditWorker.rateLimit(err.retryInMs);
        throw Worker.RateLimitError();
      }
      throw err;
    }
  },
  {
    connection: auditConnection,
    concurrency: AUDIT_CONCURRENCY,
    limiter: { max: PSI_PER_MINUTE, duration: 60_000 },
  },
);

// --- Control worker -------------------------------------------------------------

const controlWorker: Worker<ControlJob> = new Worker<ControlJob>(
  CONTROL_QUEUE,
  processControlJob,
  {
    connection: controlConnection,
    concurrency: CONTROL_CONCURRENCY,
  },
);

// --- Worker events ----------------------------------------------------------------

auditWorker.on("failed", async (job, err) => {
  // Log-only try/catch: an event handler must never crash the worker.
  try {
    console.error(
      `[worker:audit] job ${job?.id ?? "<unknown>"} failed (attempt ${job?.attemptsMade ?? "?"}):`,
      err.message,
    );
    // Reconcile jobs that failed OUTSIDE the processor (stalled past
    // maxStalledCount, or the final-attempt catch writes threw): mark the
    // PageResult FAILED and enqueue run finalization so the run cannot stay
    // RUNNING forever. The conditional updateMany makes this a no-op when the
    // processor already wrote the terminal state.
    if (!job?.data?.pageResultId) return;
    const isFinalFailure =
      job.attemptsMade >= (job.opts.attempts ?? 1) ||
      err.message.includes("stalled");
    if (!isFinalFailure) return;
    const updated = await prisma.pageResult.updateMany({
      where: {
        id: job.data.pageResultId,
        status: { in: ["PENDING", "RUNNING"] },
      },
      data: { status: "FAILED", error: err.message, completedAt: new Date() },
    });
    if (updated.count !== 1) return;
    const pageResult = await prisma.pageResult.findUnique({
      where: { id: job.data.pageResultId },
      select: { runId: true },
    });
    if (!pageResult) return;
    const run = await prisma.auditRun.update({
      where: { id: pageResult.runId },
      data: { failedJobs: { increment: 1 } },
    });
    await enqueueFinalize(pageResult.runId, run.completedJobs + run.failedJobs);
  } catch (reconcileErr) {
    console.error(
      "[worker:audit] failed-job reconciliation error:",
      reconcileErr instanceof Error ? reconcileErr.message : reconcileErr,
    );
  }
});
auditWorker.on("error", (err) => {
  console.error("[worker:audit] worker error:", err);
});

controlWorker.on("failed", (job, err) => {
  console.error(
    `[worker:control] job ${job?.id ?? "<unknown>"} (${job?.name ?? "?"}) failed:`,
    err.message,
  );
});
controlWorker.on("error", (err) => {
  console.error("[worker:control] worker error:", err);
});

// --- Scheduler resync on startup ------------------------------------------------

function parseScheduleConfig(value: unknown): ScheduleConfig {
  const v =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: v.enabled === true,
    cron: typeof v.cron === "string" ? v.cron : "0 4 1 * *",
    timezone: typeof v.timezone === "string" ? v.timezone : "UTC",
  };
}

async function resyncSchedulers(): Promise<void> {
  const profiles = await prisma.auditProfile.findMany({
    include: { shop: true },
  });
  let synced = 0;
  for (const profile of profiles) {
    try {
      const schedule = parseScheduleConfig(profile.schedule);
      // Uninstalled shops must not keep firing scheduled runs.
      if (profile.shop.uninstalledAt) schedule.enabled = false;
      await syncProfileScheduler({
        id: profile.id,
        shopDomain: profile.shop.domain,
        schedule,
      });
      if (schedule.enabled) synced += 1;
    } catch (err) {
      console.error(
        `[worker] failed to sync scheduler for profile ${profile.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  console.log(
    `[worker] schedulers resynced: ${synced} enabled of ${profiles.length} profiles`,
  );
}

// --- Stuck-run reconciliation on startup ------------------------------------------

/**
 * Recovers RUNNING/QUEUED runs older than 10 minutes:
 * - all PageResults terminal → enqueue finalize (idempotent);
 * - unfinished PageResults whose queue jobs are gone (Redis wiped, worker died
 *   mid-run) → re-enqueue their audit jobs; jobId = pageResult.id makes this a
 *   no-op for jobs still present in the queue.
 * Runs older than 24h with unfinished results also log a warning.
 */
async function reconcileStuckRuns(): Promise<void> {
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);
  const warnCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const stuckRuns = await prisma.auditRun.findMany({
    where: {
      status: { in: ["RUNNING", "QUEUED"] },
      createdAt: { lt: staleCutoff },
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      pageResults: {
        where: { status: { in: ["PENDING", "RUNNING"] } },
        select: { id: true },
      },
    },
  });
  let finalized = 0;
  let requeued = 0;
  for (const run of stuckRuns) {
    if (run.pageResults.length === 0) {
      const terminalCount = await prisma.pageResult.count({
        where: { runId: run.id, status: { in: ["COMPLETED", "FAILED"] } },
      });
      await enqueueFinalize(run.id, terminalCount);
      finalized += 1;
    } else {
      await getAuditQueue().addBulk(
        run.pageResults.map((pr) => ({
          name: "audit-url",
          data: { pageResultId: pr.id },
          opts: { jobId: pr.id },
        })),
      );
      requeued += run.pageResults.length;
      if (run.createdAt < warnCutoff) {
        console.warn(
          `[worker] run ${run.id} has been ${run.status} since ${run.createdAt.toISOString()} with unfinished page results — jobs re-enqueued, inspect if it persists`,
        );
      }
    }
  }
  if (finalized > 0 || requeued > 0) {
    console.log(
      `[worker] reconciliation: finalize enqueued for ${finalized} run(s), ${requeued} audit job(s) re-enqueued`,
    );
  }
}

// --- Graceful shutdown -----------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received, shutting down…`);
  await Promise.allSettled([auditWorker.close(), controlWorker.close()]);
  auditConnection.disconnect();
  controlConnection.disconnect();
  getRedisConnection().disconnect(); // shared producer connection (queues)
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// --- Startup ---------------------------------------------------------------------

console.log(
  [
    "[worker] Performify worker started",
    `  audit queue:   ${AUDIT_QUEUE} (concurrency ${AUDIT_CONCURRENCY}, limiter ${PSI_PER_MINUTE}/min)`,
    `  control queue: ${CONTROL_QUEUE} (concurrency ${CONTROL_CONCURRENCY})`,
  ].join("\n"),
);

void (async () => {
  try {
    await resyncSchedulers();
  } catch (err) {
    console.error("[worker] scheduler resync failed:", err);
  }
  try {
    await reconcileStuckRuns();
  } catch (err) {
    console.error("[worker] stuck-run reconciliation failed:", err);
  }
})();
