// ---------------------------------------------------------------------------
// Redis-backed daily quota for PSI calls, shared across web + worker.
// One INCR per reservation on a per-UTC-day key; over quota → roll back the
// increment and tell the caller when the next UTC day starts.
// ---------------------------------------------------------------------------

import { getRedisConnection } from "../../queues/connection.server";
import { env } from "../env.server";

/** TTL slightly over 24h so the key always outlives its UTC day. */
const QUOTA_KEY_TTL_SECONDS = 26 * 3600;

function quotaKey(now: Date): string {
  // toISOString is always UTC → "psi:quota:YYYY-MM-DD"
  return `psi:quota:${now.toISOString().slice(0, 10)}`;
}

/** Ms until the next UTC day starts (when Google's daily quota resets). */
export function msUntilNextUtcMidnight(now: Date): number {
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return nextMidnight - now.getTime();
}

export type PsiQuotaReservation =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; retryInMs: number };

/**
 * Reserves one PSI call against today's quota (env.psiDailyQuota()).
 * Returns { ok: false, retryInMs } when exhausted; retryInMs points past the
 * next UTC midnight with up to 60s of jitter so retries do not stampede.
 * On success, `release()` rolls back the reservation — call it when the call
 * never counted against Google (network failure, abort, 429).
 */
export async function reservePsiQuota(): Promise<PsiQuotaReservation> {
  const redis = getRedisConnection();
  const now = new Date();
  const key = quotaKey(now);

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, QUOTA_KEY_TTL_SECONDS);
  }

  if (count > env.psiDailyQuota()) {
    // Roll back our reservation so the counter reflects actual usage.
    await redis.decr(key);
    const jitterMs = Math.floor(Math.random() * 60_000);
    return { ok: false, retryInMs: msUntilNextUtcMidnight(now) + jitterMs };
  }

  let released = false;
  return {
    ok: true,
    release: async () => {
      // Roll back at most once, on the exact key that was incremented; if the
      // key vanished in the meantime (TTL), correct the negative back to 0.
      if (released) return;
      released = true;
      const after = await redis.decr(key);
      if (after < 0) {
        await redis.incr(key);
      }
    },
  };
}
