// ---------------------------------------------------------------------------
// Shared domain types — pure TypeScript, no runtime deps.
// These mirror the Json columns in prisma/schema.prisma (AuditProfile.*).
// ---------------------------------------------------------------------------

export type DeviceProfile = "MOBILE" | "DESKTOP";

export type PsiCategory =
  | "performance"
  | "accessibility"
  | "best-practices"
  | "seo";

export type PageTypeKey =
  | "HOME"
  | "COLLECTION"
  | "PRODUCT"
  | "CART"
  | "PAGE"
  | "BLOG"
  | "ARTICLE"
  | "CUSTOM";

// --- AuditProfile.markets ---------------------------------------------------

export interface MarketsSelection {
  /** all = every active market; include/exclude filter by handle */
  mode: "all" | "include" | "exclude";
  handles: string[];
  /** default = only the default locale URL per market; all = every localized rootUrl */
  localeMode: "default" | "all";
}

// --- AuditProfile.pages -----------------------------------------------------

export interface SampledPageSelection {
  enabled: boolean;
  /** auto = representative sample resolved at run time; manual = explicit handles */
  mode: "auto" | "manual";
  sampleSize: number;
  handles: string[];
}

/** Upper bound on sampleSize, shared by profile validation and auto sampling. */
export const MAX_SAMPLE_SIZE = 20;

export interface PagesSelection {
  home: { enabled: boolean };
  cart: { enabled: boolean };
  collections: SampledPageSelection;
  products: SampledPageSelection;
  pages: SampledPageSelection;
  blogs: SampledPageSelection;
  custom: { enabled: boolean; urls: string[] };
}

export const DEFAULT_PAGES_SELECTION: PagesSelection = {
  home: { enabled: true },
  cart: { enabled: true },
  collections: { enabled: true, mode: "auto", sampleSize: 3, handles: [] },
  products: { enabled: true, mode: "auto", sampleSize: 3, handles: [] },
  pages: { enabled: false, mode: "manual", sampleSize: 3, handles: [] },
  blogs: { enabled: false, mode: "auto", sampleSize: 1, handles: [] },
  custom: { enabled: false, urls: [] },
};

// --- AuditProfile.schedule ----------------------------------------------------

export interface ScheduleConfig {
  enabled: boolean;
  /** 5-field cron pattern, e.g. "0 4 1 * *" = monthly, day 1 at 04:00 */
  cron: string;
  /** IANA timezone, e.g. "Europe/Rome" */
  timezone: string;
}

// --- AuditProfile.thresholds --------------------------------------------------

export type ThresholdMetric =
  | "performanceScore"
  | "accessibilityScore"
  | "bestPracticesScore"
  | "seoScore"
  | "lcpMs"
  | "cls"
  | "tbtMs"
  | "fieldLcpMs"
  | "fieldInpMs"
  | "fieldCls";

export interface Threshold {
  id: string;
  metric: ThresholdMetric;
  /** lt = alert when actual < value (scores); gt = alert when actual > value (timings) */
  operator: "lt" | "gt";
  value: number;
  severity: "warning" | "critical";
}

// --- AuditProfile.notifications ----------------------------------------------

export interface NotificationsConfig {
  emails: string[];
  webhookUrl?: string;
}

// --- Frozen profile copy stored on AuditRun.profileSnapshot -------------------

export interface ProfileSnapshot {
  profileId: string;
  name: string;
  devices: DeviceProfile[];
  runsPerUrl: number;
  categories: PsiCategory[];
  markets: MarketsSelection;
  pages: PagesSelection;
  thresholds: Threshold[];
  notifications: NotificationsConfig;
}

// --- Resolved audit targets (markets × pages × devices) -----------------------

export interface ResolvedMarket {
  handle: string;
  name: string;
  /** Base storefront URLs by locale, no trailing slash (from webPresences.rootUrls) */
  rootUrls: { locale: string; url: string; primary: boolean }[];
}

export interface AuditTargetUrl {
  url: string;
  pageType: PageTypeKey;
  marketHandle?: string;
  marketName?: string;
  locale?: string;
  /** Human label (e.g. product/collection title) */
  label?: string;
}

// --- Narrative report (AuditRun.narrative) ------------------------------------

export interface NarrativeSection {
  heading: string;
  body: string;
  tone: "positive" | "negative" | "neutral";
}

export interface Recommendation {
  auditId: string;
  title: string;
  explanation: string;
  /** Estimated total savings across affected pages, ms */
  estimatedSavingsMs: number;
  affectedUrls: string[];
  priority: number; // 1 = highest
}

export interface RunNarrative {
  locale: string;
  summary: string;
  sections: NarrativeSection[];
  recommendations: Recommendation[];
  comparedToRunId?: string;
  generatedAt: string;
}
