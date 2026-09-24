import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redis-backed quota is out of scope here: always grant the reservation.
vi.mock("../../app/lib/audit/quota.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../app/lib/audit/quota.server")>();
  return {
    ...actual,
    reservePsiQuota: vi.fn(async () => ({ ok: true, release: async () => {} })),
  };
});

import { PsiEngine } from "../../app/lib/audit/psi-engine.server";
import { QuotaExceededError } from "../../app/lib/audit/types";

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Google's real 429 envelope: `status` is RESOURCE_EXHAUSTED for EVERY 429. */
function google429(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { code: 429, message, status: "RESOURCE_EXHAUSTED" },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

async function auditOnce(): Promise<QuotaExceededError> {
  const engine = new PsiEngine({ apiKey: "test-key" });
  try {
    await engine.audit(
      { url: "https://shop.example.com/", pageType: "HOME" } as never,
      { strategy: "MOBILE", categories: ["performance"] } as never,
    );
  } catch (err) {
    expect(err).toBeInstanceOf(QuotaExceededError);
    return err as QuotaExceededError;
  }
  throw new Error("expected the audit to throw");
}

describe("PsiEngine — HTTP 429 classification", () => {
  beforeEach(() => {
    vi.stubEnv("PSI_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("treats a per-minute 429 as a short pause, not a daily exhaustion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        google429(
          "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute' of service 'pagespeedonline.googleapis.com'",
        ),
      ),
    );
    const err = await auditOnce();
    expect(err.retryInMs).toBeLessThan(ONE_HOUR_MS);
  });

  it("pauses until the next UTC midnight on a daily-quota 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        google429(
          "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'pagespeedonline.googleapis.com'",
        ),
      ),
    );
    const err = await auditOnce();
    expect(err.retryInMs).toBeGreaterThan(ONE_HOUR_MS);
  });
});
