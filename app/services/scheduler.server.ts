// ---------------------------------------------------------------------------
// BullMQ Job Schedulers ↔ AuditProfile.schedule sync.
// One repeatable "scheduled-run" job per profile with an enabled schedule;
// called on profile save and on worker startup (resync).
// ---------------------------------------------------------------------------

import { getControlQueue, profileSchedulerId } from "../queues/queues.server";
import type { ScheduleConfig } from "../lib/types";

function assertValidCron(cron: string, profileId: string): void {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron pattern "${cron}" for profile ${profileId}: ` +
        `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
}

/**
 * Creates/updates the repeatable scheduler for a profile when its schedule is
 * enabled, removes it otherwise. Safe to call repeatedly (upsert semantics).
 */
export async function syncProfileScheduler(profile: {
  id: string;
  shopDomain: string;
  schedule: ScheduleConfig;
}): Promise<void> {
  const queue = getControlQueue();
  const schedulerId = profileSchedulerId(profile.id);

  if (!profile.schedule.enabled) {
    await queue.removeJobScheduler(schedulerId);
    return;
  }

  assertValidCron(profile.schedule.cron, profile.id);

  await queue.upsertJobScheduler(
    schedulerId,
    {
      pattern: profile.schedule.cron,
      tz: profile.schedule.timezone,
    },
    {
      name: "scheduled-run",
      data: { kind: "scheduled-run", profileId: profile.id },
    },
  );
}

/** Removes a profile's repeatable scheduler (profile deleted / shop uninstalled). */
export async function removeProfileScheduler(profileId: string): Promise<void> {
  await getControlQueue().removeJobScheduler(profileSchedulerId(profileId));
}
