// ---------------------------------------------------------------------------
// Integration: reservePsiQuota against real Redis. env.psiDailyQuota() reads
// process.env.PSI_DAILY_QUOTA at CALL time (app/lib/env.server.ts wraps every
// value in a function), so vi.stubEnv inside a test is enough — no import
// gymnastics needed. Exhaustion is simulated by pre-setting the day key.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { reservePsiQuota } from "../../app/lib/audit/quota.server";
import { getRedisConnection } from "../../app/queues/connection.server";

function todayKey(): string {
  return `psi:quota:${new Date().toISOString().slice(0, 10)}`;
}

const QUOTA_KEY_TTL_SECONDS = 26 * 3600;

describe("reservePsiQuota", () => {
  const redis = getRedisConnection();

  beforeEach(async () => {
    await redis.del(todayKey());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await redis.del(todayKey());
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("fresh key: ok:true, counter incremented, TTL set on first reservation", async () => {
    const first = await reservePsiQuota();
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.release).toBeTypeOf("function");
    }
    expect(await redis.get(todayKey())).toBe("1");

    const ttl = await redis.ttl(todayKey());
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(QUOTA_KEY_TTL_SECONDS);

    const second = await reservePsiQuota();
    expect(second.ok).toBe(true);
    expect(await redis.get(todayKey())).toBe("2");
  });

  it("exhausted quota: ok:false with retryInMs > 0 and the increment rolled back", async () => {
    vi.stubEnv("PSI_DAILY_QUOTA", "2");
    await redis.set(todayKey(), "2"); // already at the limit

    const result = await reservePsiQuota();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryInMs).toBeGreaterThan(0);
      // At most: full day until next UTC midnight + 60s of jitter.
      expect(result.retryInMs).toBeLessThanOrEqual(24 * 3600 * 1000 + 60_000);
    }

    // The over-quota INCR was rolled back so the counter reflects real usage.
    expect(await redis.get(todayKey())).toBe("2");
  });

  it("still under a stubbed quota: ok:true and the reservation sticks", async () => {
    vi.stubEnv("PSI_DAILY_QUOTA", "2");
    await redis.set(todayKey(), "1");

    const result = await reservePsiQuota();
    expect(result.ok).toBe(true);
    expect(await redis.get(todayKey())).toBe("2");
  });

  it("release() rolls back the reservation and is idempotent", async () => {
    const first = await reservePsiQuota();
    const second = await reservePsiQuota();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(await redis.get(todayKey())).toBe("2");

    if (first.ok) {
      await first.release();
      expect(await redis.get(todayKey())).toBe("1");

      // A second release of the same reservation must not decrement again.
      await first.release();
      expect(await redis.get(todayKey())).toBe("1");
    }
  });

  it("release() after the key vanished never leaves a negative counter", async () => {
    const result = await reservePsiQuota();
    expect(result.ok).toBe(true);
    await redis.del(todayKey()); // simulate TTL expiry between reserve and release

    if (result.ok) {
      await result.release();
    }
    expect(Number((await redis.get(todayKey())) ?? "0")).toBe(0);
  });
});
