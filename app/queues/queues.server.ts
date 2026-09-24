import { Queue } from "bullmq";
import { getRedisConnection } from "./connection.server";

// Two queues so the PSI rate limiter never throttles control jobs:
// - AUDIT_QUEUE: one job per PageResult (rate-limited worker, PSI calls)
// - CONTROL_QUEUE: run lifecycle, scheduling, theme-publish fan-out
export const AUDIT_QUEUE = "performify-audit";
export const CONTROL_QUEUE = "performify-control";

export interface AuditUrlJob {
  pageResultId: string;
}

export type ControlJob =
  | { kind: "run-finalize"; runId: string }
  | { kind: "scheduled-run"; profileId: string }
  | {
      kind: "theme-publish-run";
      shopDomain: string;
      themeId: string;
      themeName: string;
    };

const DEFAULT_JOB_OPTS = {
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 30 * 24 * 3600 },
} as const;

let auditQueue: Queue<AuditUrlJob> | undefined;
let controlQueue: Queue<ControlJob> | undefined;

export function getAuditQueue(): Queue<AuditUrlJob> {
  if (!auditQueue) {
    auditQueue = new Queue<AuditUrlJob>(AUDIT_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        ...DEFAULT_JOB_OPTS,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
      },
    });
  }
  return auditQueue;
}

export function getControlQueue(): Queue<ControlJob> {
  if (!controlQueue) {
    controlQueue = new Queue<ControlJob>(CONTROL_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        ...DEFAULT_JOB_OPTS,
        attempts: 5,
        backoff: { type: "exponential", delay: 10_000 },
      },
    });
  }
  return controlQueue;
}

/** Job scheduler id for a profile's cron — one repeatable schedule per profile. */
export function profileSchedulerId(profileId: string): string {
  return `profile:${profileId}`;
}
