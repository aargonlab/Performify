// ---------------------------------------------------------------------------
// Pure parser for PageSpeed Insights API v5 responses — no fetch, no env.
// Every path is optional: a malformed/partial response never throws, missing
// values become null. The full input is preserved in snapshot.raw.
// ---------------------------------------------------------------------------

import type { DeviceProfile } from "../types";
import type { AuditSnapshot, OpportunityFinding } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Category score 0–1 → 0–100 rounded, null when absent or errored. */
function categoryScore(categories: unknown, key: string): number | null {
  if (!isRecord(categories)) return null;
  const category = categories[key];
  if (!isRecord(category)) return null;
  const score = asNumber(category.score);
  return score === null ? null : Math.round(score * 100);
}

function auditNumericValue(audits: unknown, id: string): number | null {
  if (!isRecord(audits)) return null;
  const audit = audits[id];
  if (!isRecord(audit)) return null;
  return asNumber(audit.numericValue);
}

interface FieldMetrics {
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  overall: "FAST" | "AVERAGE" | "SLOW" | null;
}

function hasMetrics(experience: Record<string, unknown>): boolean {
  const metrics = experience.metrics;
  return isRecord(metrics) && Object.keys(metrics).length > 0;
}

/** p75 percentiles from a loadingExperience/originLoadingExperience block. */
function readFieldMetrics(
  experience: Record<string, unknown>,
): FieldMetrics | null {
  if (!hasMetrics(experience)) return null;
  const metrics = experience.metrics as Record<string, unknown>;

  const percentile = (key: string): number | null => {
    const metric = metrics[key];
    if (!isRecord(metric)) return null;
    return asNumber(metric.percentile);
  };

  const rawCls = percentile("CUMULATIVE_LAYOUT_SHIFT_SCORE");
  const rawOverall = asString(experience.overall_category);
  const overall =
    rawOverall === "FAST" || rawOverall === "AVERAGE" || rawOverall === "SLOW"
      ? rawOverall
      : null;

  return {
    lcpMs: percentile("LARGEST_CONTENTFUL_PAINT_MS"),
    inpMs: percentile("INTERACTION_TO_NEXT_PAINT"),
    // CrUX reports the CLS percentile multiplied by 100 (e.g. 12 → 0.12).
    cls: rawCls === null ? null : rawCls / 100,
    overall,
  };
}

/**
 * loadingExperience is page-level only when PSI did not mark it as an origin
 * fallback AND its id/initial_url matches the audited URL (or it carries
 * metrics with no fallback marker). origin_fallback takes precedence: real
 * fallback responses keep initial_url = the requested page URL while id is
 * the origin.
 */
function isPageLevel(
  experience: Record<string, unknown>,
  auditedUrls: string[],
): boolean {
  if (experience.origin_fallback === true) return false;
  const id = asString(experience.id);
  const initialUrl = asString(experience.initial_url);
  if (id !== null && auditedUrls.includes(id)) return true;
  if (initialUrl !== null && auditedUrls.includes(initialUrl)) return true;
  return hasMetrics(experience);
}

/** Audits with details.type === "opportunity" and positive savings. */
function extractOpportunities(audits: unknown): OpportunityFinding[] {
  if (!isRecord(audits)) return [];
  const findings: OpportunityFinding[] = [];
  for (const [id, audit] of Object.entries(audits)) {
    if (!isRecord(audit)) continue;
    const details = audit.details;
    if (!isRecord(details) || details.type !== "opportunity") continue;
    const savingsMs = asNumber(details.overallSavingsMs);
    if (savingsMs === null || savingsMs <= 0) continue;
    const finding: OpportunityFinding = {
      id,
      title: asString(audit.title) ?? id,
      savingsMs,
      score: asNumber(audit.score),
    };
    const displayValue = asString(audit.displayValue);
    if (displayValue !== null) finding.displayValue = displayValue;
    findings.push(finding);
  }
  return findings.sort((a, b) => b.savingsMs - a.savingsMs);
}

/**
 * Normalizes a PSI v5 JSON response into an AuditSnapshot.
 * Defensive by design: never throws on missing/mistyped fields.
 */
export function parsePsiResponse(
  json: unknown,
  strategy: DeviceProfile,
): AuditSnapshot {
  const root = isRecord(json) ? json : {};
  const lighthouse = isRecord(root.lighthouseResult)
    ? root.lighthouseResult
    : {};
  const audits = lighthouse.audits;

  const requestedUrl =
    asString(lighthouse.requestedUrl) ?? asString(root.id) ?? "";
  const finalUrl =
    asString(lighthouse.finalUrl) ??
    asString(lighthouse.finalDisplayedUrl) ??
    requestedUrl;
  const fetchedAt =
    asString(lighthouse.fetchTime) ??
    asString(root.analysisUTCTimestamp) ??
    new Date().toISOString();

  // --- CrUX field data: page-level with origin fallback --------------------
  const auditedUrls = [requestedUrl, finalUrl].filter((u) => u.length > 0);
  const loadingExperience = isRecord(root.loadingExperience)
    ? root.loadingExperience
    : undefined;
  const originLoadingExperience = isRecord(root.originLoadingExperience)
    ? root.originLoadingExperience
    : undefined;
  const pageMetrics = loadingExperience
    ? readFieldMetrics(loadingExperience)
    : null;
  const originMetrics = originLoadingExperience
    ? readFieldMetrics(originLoadingExperience)
    : null;

  let field: AuditSnapshot["field"];
  if (
    pageMetrics !== null &&
    loadingExperience !== undefined &&
    isPageLevel(loadingExperience, auditedUrls)
  ) {
    field = { source: "page", ...pageMetrics };
  } else if (originMetrics !== null) {
    field = { source: "origin", ...originMetrics };
  } else if (pageMetrics !== null) {
    // loadingExperience carried origin-fallback data and no separate
    // originLoadingExperience block was present.
    field = { source: "origin", ...pageMetrics };
  }

  // --- Lighthouse runtime error --------------------------------------------
  let runtimeError: AuditSnapshot["runtimeError"];
  const rawRuntimeError = lighthouse.runtimeError;
  if (isRecord(rawRuntimeError)) {
    const code = asString(rawRuntimeError.code);
    const message = asString(rawRuntimeError.message);
    if (code !== null || message !== null) {
      runtimeError = { code: code ?? "UNKNOWN", message: message ?? "" };
    }
  }

  const snapshot: AuditSnapshot = {
    engine: "psi",
    lighthouseVersion: asString(lighthouse.lighthouseVersion) ?? "",
    fetchedAt,
    requestedUrl,
    finalUrl,
    strategy,
    categories: {
      performance: categoryScore(lighthouse.categories, "performance"),
      accessibility: categoryScore(lighthouse.categories, "accessibility"),
      bestPractices: categoryScore(lighthouse.categories, "best-practices"),
      seo: categoryScore(lighthouse.categories, "seo"),
    },
    labMetrics: {
      lcpMs: auditNumericValue(audits, "largest-contentful-paint"),
      cls: auditNumericValue(audits, "cumulative-layout-shift"),
      tbtMs: auditNumericValue(audits, "total-blocking-time"),
      fcpMs: auditNumericValue(audits, "first-contentful-paint"),
      speedIndexMs: auditNumericValue(audits, "speed-index"),
      ttfbMs: auditNumericValue(audits, "server-response-time"),
    },
    opportunities: extractOpportunities(audits),
    raw: json,
  };
  if (field !== undefined) snapshot.field = field;
  if (runtimeError !== undefined) snapshot.runtimeError = runtimeError;
  return snapshot;
}
