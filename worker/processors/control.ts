// ---------------------------------------------------------------------------
// CONTROL_QUEUE processor: run finalization, scheduled runs, theme-publish
// fan-out. Never rate-limited by the PSI limiter (separate queue/worker).
// ---------------------------------------------------------------------------

import type { Job } from "bullmq";
import prisma from "../../app/db.server";
import type { ControlJob } from "../../app/queues/queues.server";
import { createRun, finalizeRun } from "../../app/services/runs.server";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export async function processControlJob(job: Job<ControlJob>): Promise<void> {
  const data = job.data;

  switch (data.kind) {
    case "run-finalize": {
      await finalizeRun(data.runId);
      return;
    }

    case "scheduled-run": {
      const profile = await prisma.auditProfile.findUnique({
        where: { id: data.profileId },
        include: { shop: true },
      });
      if (!profile) {
        console.warn(
          `[control] scheduled-run: profile ${data.profileId} no longer exists, skipping`,
        );
        return;
      }
      if (profile.shop.uninstalledAt) {
        console.warn(
          `[control] scheduled-run: shop ${profile.shop.domain} uninstalled, skipping profile ${profile.id}`,
        );
        return;
      }
      const schedule = asRecord(profile.schedule);
      if (schedule?.enabled !== true) {
        console.warn(
          `[control] scheduled-run: schedule disabled for profile ${profile.id}, skipping`,
        );
        return;
      }
      // createRun is not idempotent and BullMQ retries this job: skip when a
      // scheduled run for this profile was already created recently, and never
      // rethrow so one transient failure produces a single FAILED run instead
      // of one duplicate per retry attempt.
      const recentScheduled = await prisma.auditRun.findFirst({
        where: {
          profileId: profile.id,
          trigger: "SCHEDULED",
          createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
        },
        select: { id: true },
      });
      if (recentScheduled) {
        console.warn(
          `[control] scheduled-run: run ${recentScheduled.id} already created for profile ${profile.id} in the last 10 minutes, skipping`,
        );
        return;
      }
      try {
        await createRun({
          shopDomain: profile.shop.domain,
          profileId: profile.id,
          trigger: "SCHEDULED",
        });
      } catch (err) {
        console.error(
          `[control] scheduled-run: createRun failed for profile ${profile.id} (${profile.shop.domain}):`,
          err instanceof Error ? err.message : err,
        );
      }
      return;
    }

    case "theme-publish-run": {
      const shop = await prisma.shop.findUnique({
        where: { domain: data.shopDomain },
      });
      if (!shop || shop.uninstalledAt) {
        console.warn(
          `[control] theme-publish-run: shop ${data.shopDomain} not installed, skipping`,
        );
        return;
      }
      const profiles = await prisma.auditProfile.findMany({
        where: { shopId: shop.id, themePublishTrigger: true },
      });
      for (const profile of profiles) {
        try {
          await createRun({
            shopDomain: data.shopDomain,
            profileId: profile.id,
            trigger: "THEME_PUBLISH",
            themeId: data.themeId,
            themeName: data.themeName,
          });
        } catch (err) {
          console.error(
            `[control] theme-publish-run: createRun failed for profile ${profile.id} (${data.shopDomain}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      return;
    }

    default: {
      const exhaustive: never = data;
      throw new Error(`Unknown control job kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
