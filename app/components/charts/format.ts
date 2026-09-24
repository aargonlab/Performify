// Shared number/status formatting helpers for charts and report tables.
// Pure functions — no I/O, no React.

/** Milliseconds → human string, auto-switching to seconds above 1s. */
export function fmtMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const seconds = value / 1000;
    return `${seconds.toFixed(abs >= 10_000 ? 1 : 2)} s`;
  }
  return `${Math.round(value)} ms`;
}

/** Lighthouse category score (0–100), rounded. */
export function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

/** Cumulative Layout Shift — unitless, three decimals. */
export function fmtCls(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(3);
}

// --- Deterministic date formatting (UTC-based, no SSR/CSR hydration drift) ---

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Jul 6" — short axis label. */
export function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Jul 6, 2026, 10:22 UTC" — table/date display. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** Human label for a RunTrigger value. */
export function triggerLabel(trigger: string): string {
  switch (trigger) {
    case "MANUAL":
      return "Manual";
    case "SCHEDULED":
      return "Scheduled";
    case "THEME_PUBLISH":
      return "Theme publish";
    default:
      return trigger;
  }
}

/** Human label for a PageType value. */
export function pageTypeLabel(pageType: string): string {
  switch (pageType) {
    case "HOME":
      return "Home";
    case "COLLECTION":
      return "Collection";
    case "PRODUCT":
      return "Product";
    case "CART":
      return "Cart";
    case "PAGE":
      return "Page";
    case "BLOG":
      return "Blog";
    case "ARTICLE":
      return "Article";
    case "CUSTOM":
      return "Custom";
    default:
      return pageType;
  }
}

/** Human label for a Device value. */
export function deviceLabel(device: string): string {
  if (device === "MOBILE") return "Mobile";
  if (device === "DESKTOP") return "Desktop";
  return device;
}

/** Human label for an AuditRun/PageResult status value. */
export function statusLabel(status: string): string {
  switch (status) {
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Running";
    case "COMPLETED":
      return "Complete";
    case "PARTIAL":
      return "Partial";
    case "FAILED":
      return "Failed";
    case "CANCELED":
      return "Canceled";
    case "PENDING":
      return "Pending";
    default:
      return status;
  }
}

/** Human label for an alert severity value. */
export function severityLabel(severity: string): string {
  return severity === "critical" ? "Critical" : "Warning";
}

/** Metric-aware value formatting for thresholds/alerts. */
export function fmtMetricValue(metric: string, value: number): string {
  if (/cls/i.test(metric)) return fmtCls(value);
  if (/ms$/i.test(metric)) return fmtMs(value);
  return fmtScore(value);
}

// --- Chart series colors (fixed categorical order — CVD-validated set) -------

export const CHART_SERIES_COLORS = [
  "#2a78d6", // slot 1 — blue
  "#1baf7a", // slot 2 — aqua
  "#eda100", // slot 3 — yellow
  "#008300", // slot 4 — green
] as const;

// --- Lighthouse score bands (status colors — reserved, never used as series) --

export const SCORE_GOOD_COLOR = "#0c8043"; // >= 90
export const SCORE_MID_COLOR = "#b98900"; // 50–89
export const SCORE_POOR_COLOR = "#d72c0d"; // < 50
export const SCORE_NULL_COLOR = "#8c9196"; // no data

/** Lighthouse color band for a 0–100 score (grey when null). Raw hex — for SVG presentation attributes (e.g. ScoreRing strokes) where var() is not resolved. */
export function scoreColor(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return SCORE_NULL_COLOR;
  if (score >= 90) return SCORE_GOOD_COLOR;
  if (score >= 50) return SCORE_MID_COLOR;
  return SCORE_POOR_COLOR;
}

/** Lighthouse score band as a themable text color (Polaris token with hex fallback). */
export function scoreTextColor(score: number | null): string {
  if (score == null || !Number.isFinite(score)) {
    return "var(--p-color-text-secondary, #6d7175)";
  }
  if (score >= 90) return `var(--p-color-text-success, ${SCORE_GOOD_COLOR})`;
  if (score >= 50) return `var(--p-color-text-caution, ${SCORE_MID_COLOR})`;
  return `var(--p-color-text-critical, ${SCORE_POOR_COLOR})`;
}

/** Badge tone for an AuditRun status. */
export function runStatusTone(
  status: string,
): "success" | "warning" | "critical" | "info" | "neutral" {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "PARTIAL":
      return "warning";
    case "FAILED":
      return "critical";
    case "RUNNING":
      return "info";
    default:
      return "neutral"; // QUEUED, CANCELED
  }
}

/** Badge tone for a PageResult status. */
export function resultStatusTone(
  status: string,
): "success" | "critical" | "info" | "neutral" {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "FAILED":
      return "critical";
    case "RUNNING":
      return "info";
    default:
      return "neutral"; // PENDING
  }
}

/**
 * Readable ink (dark or white) for text sitting on an arbitrary hex background.
 * Falls back to dark ink when the color cannot be parsed.
 */
export function readableTextOn(background: string): string {
  const hex = background.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return "#1a1a1a";
  const channel = (i: number) => {
    const v = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? "#1a1a1a" : "#ffffff";
}
