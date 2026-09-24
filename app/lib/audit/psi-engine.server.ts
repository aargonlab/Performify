// ---------------------------------------------------------------------------
// PsiEngine — AuditEngine implementation backed by the PageSpeed Insights
// API v5 (Lighthouse on Google infrastructure, CrUX field data included).
// ---------------------------------------------------------------------------

import { env } from "../env.server";
import { parsePsiResponse } from "./psi-parser";
import { msUntilNextUtcMidnight, reservePsiQuota } from "./quota.server";
import { QuotaExceededError } from "./types";
import type {
  AuditEngine,
  AuditSnapshot,
  AuditTarget,
  EngineOptions,
} from "./types";

const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/** PSI analysis can take up to 120s; allow a little response headroom. */
const REQUEST_TIMEOUT_MS = 125_000;

/** Suggested wait after an HTTP 429 from Google (per-minute limit). */
const RATE_LIMIT_RETRY_MS = 90_000;

/**
 * 429 bodies that indicate the DAILY quota rather than the per-minute rate.
 * Note: every Google 429 carries `"status": "RESOURCE_EXHAUSTED"`, so that
 * token must NOT be matched here or a per-minute burst would pause the queue
 * until the next UTC midnight.
 */
const DAILY_QUOTA_BODY_RE = /per day|Queries per day|dailyLimitExceeded/i;

export class PsiEngine implements AuditEngine {
  readonly name = "psi";

  constructor(private opts: { apiKey?: string } = {}) {}

  async audit(
    target: AuditTarget,
    opts: EngineOptions,
  ): Promise<AuditSnapshot> {
    // Reserve against the shared daily quota before spending a request.
    const quota = await reservePsiQuota();
    if (!quota.ok) {
      throw new QuotaExceededError(
        "PSI daily quota exhausted",
        quota.retryInMs,
      );
    }

    const params = new URLSearchParams();
    params.set("url", target.url);
    params.set("strategy", opts.strategy.toLowerCase());
    for (const category of opts.categories) {
      params.append("category", category);
    }
    // PSI's locale param expects a BCP-47-ish tag; skip placeholders like
    // "default" coming from markets without an explicit locale.
    if (opts.locale && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(opts.locale)) {
      params.set("locale", opts.locale);
    }
    const apiKey = opts.apiKey ?? this.opts.apiKey ?? env.psiApiKey();
    if (apiKey) {
      params.set("key", apiKey);
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = opts.signal
      ? AbortSignal.any([timeout, opts.signal])
      : timeout;

    let response: Response;
    try {
      response = await fetch(`${PSI_ENDPOINT}?${params.toString()}`, {
        signal,
      });
    } catch (error) {
      // Network failure/abort: Google counted nothing, return the reservation.
      await quota.release();
      throw error;
    }

    if (response.status === 429) {
      // Google refused the call, so it never consumed our daily reservation.
      await quota.release();
      const body = await response.text().catch(() => "");
      if (DAILY_QUOTA_BODY_RE.test(body)) {
        const overrideKey = opts.apiKey ?? this.opts.apiKey;
        if (overrideKey && overrideKey !== env.psiApiKey()) {
          // A per-shop key ran out for the day: fail just this page instead
          // of rate-limiting the shared queue until the key resets.
          throw new Error(
            `PSI daily quota exhausted for shop API key (429): ${body.slice(0, 300)}`,
          );
        }
        const jitterMs = Math.floor(Math.random() * 60_000);
        throw new QuotaExceededError(
          `PSI daily quota exhausted (429): ${body.slice(0, 300)}`,
          msUntilNextUtcMidnight(new Date()) + jitterMs,
        );
      }
      if (!apiKey) {
        // Keyless mode has a tiny shared Google quota: retrying would loop
        // forever without consuming attempts. Fail the page with a clear
        // message instead of rate-limiting the queue.
        throw new Error(
          "PSI rate limited (429) and no API key is configured — set PSI_API_KEY (free, Google Cloud Console)",
        );
      }
      throw new QuotaExceededError(
        `PSI rate limited (429): ${body.slice(0, 300)}`,
        RATE_LIMIT_RETRY_MS,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `PSI request failed (HTTP ${response.status}): ${body.slice(0, 300)}`,
      );
    }

    const json: unknown = await response.json();
    return parsePsiResponse(json, opts.strategy);
  }
}
