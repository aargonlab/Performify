// ---------------------------------------------------------------------------
// AuditEngine abstraction — the rest of the system depends only on these types.
// Current implementation: PsiEngine (PageSpeed Insights API v5).
// Future: LighthouseLocalEngine (self-hosted Chromium) for password-protected
// theme previews — implement this interface and register it in the factory.
// ---------------------------------------------------------------------------

import type { DeviceProfile, PsiCategory } from "../types";

export interface EngineOptions {
  strategy: DeviceProfile;
  categories: PsiCategory[];
  locale?: string;
  /** Overrides the deployment-level API key (per-shop settings) */
  apiKey?: string;
  signal?: AbortSignal;
}

export interface AuditTarget {
  url: string;
}

/** Normalized result of a single Lighthouse run, engine-agnostic. */
export interface AuditSnapshot {
  engine: string;
  lighthouseVersion: string;
  fetchedAt: string; // ISO timestamp
  requestedUrl: string;
  finalUrl: string;
  strategy: DeviceProfile;
  /** Category scores 0–100 (null when the category was not run or errored) */
  categories: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  /** Lab metrics from Lighthouse audits (ms; cls unitless) */
  labMetrics: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
    fcpMs: number | null;
    speedIndexMs: number | null;
    ttfbMs: number | null;
  };
  /**
   * CrUX field data, 28-day window, p75. source tells whether page-level data
   * was available or we fell back to origin-level. undefined when CrUX has no
   * data for this URL/origin (common on low-traffic shops).
   */
  field?: {
    source: "page" | "origin";
    lcpMs: number | null;
    inpMs: number | null;
    cls: number | null;
    overall: "FAST" | "AVERAGE" | "SLOW" | null;
  };
  /** Audits with savings potential, sorted by savings desc */
  opportunities: OpportunityFinding[];
  runtimeError?: { code: string; message: string };
  /** Full engine response (PSI JSON) for storage in RawReport */
  raw: unknown;
}

export interface OpportunityFinding {
  id: string;
  title: string;
  savingsMs: number;
  score: number | null;
  displayValue?: string;
}

export interface AuditEngine {
  readonly name: string;
  audit(target: AuditTarget, opts: EngineOptions): Promise<AuditSnapshot>;
}

/** Thrown by engines when the provider rate limit / daily quota is exhausted. */
export class QuotaExceededError extends Error {
  constructor(
    message: string,
    /** Suggested wait before retrying, ms */
    public readonly retryInMs: number,
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}
