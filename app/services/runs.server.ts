// ---------------------------------------------------------------------------
// Run lifecycle: createRun (freeze profile → resolve targets → enqueue jobs)
// and finalizeRun (comparison, narrative, alerts, notifications).
// Called from web routes and from worker processors.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getAuditQueue } from "../queues/queues.server";
import {
  fetchActiveMarkets,
  fetchPrimaryDomainMarket,
} from "./markets.server";
import { fetchSamples } from "./sampling.server";
import { sendAlertNotifications } from "./notify.server";
import { toRunSummary } from "./mappers.server";
import { buildAuditTargets } from "../lib/urls/build-urls";
import { compareRuns } from "../lib/report/compare";
import { generateNarrative } from "../lib/report/narrative";
import { evaluateThresholds } from "../lib/alerts/evaluate";
import {
  DEFAULT_PAGES_SELECTION,
  type AuditTargetUrl,
  type PageTypeKey,
  type DeviceProfile,
  type MarketsSelection,
  type NotificationsConfig,
  type PagesSelection,
  type ProfileSnapshot,
  type PsiCategory,
  type SampledPageSelection,
  type Threshold,
  type ThresholdMetric,
} from "../lib/types";

type PrismaAuditProfile = Prisma.AuditProfileGetPayload<
  Prisma.AuditProfileDefaultArgs
>;

// --- Defensive parsing of Json profile fields --------------------------------

const VALID_DEVICES: DeviceProfile[] = ["MOBILE", "DESKTOP"];

const VALID_CATEGORIES: PsiCategory[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
];

const VALID_METRICS: ThresholdMetric[] = [
  "performanceScore",
  "accessibilityScore",
  "bestPracticesScore",
  "seoScore",
  "lcpMs",
  "cls",
  "tbtMs",
  "fieldLcpMs",
  "fieldInpMs",
  "fieldCls",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === "number" ? Math.round(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function parseDevices(value: unknown): DeviceProfile[] {
  const devices = stringArray(value).filter((d): d is DeviceProfile =>
    (VALID_DEVICES as string[]).includes(d),
  );
  return devices.length > 0 ? [...new Set(devices)] : ["MOBILE"];
}

function parseCategories(value: unknown): PsiCategory[] {
  const categories = stringArray(value).filter((c): c is PsiCategory =>
    (VALID_CATEGORIES as string[]).includes(c),
  );
  return categories.length > 0 ? [...new Set(categories)] : [...VALID_CATEGORIES];
}

function parseMarketsSelection(value: unknown): MarketsSelection {
  const v = asRecord(value);
  const mode =
    v?.mode === "include" || v?.mode === "exclude" ? v.mode : ("all" as const);
  return {
    mode,
    handles: stringArray(v?.handles),
    localeMode: v?.localeMode === "all" ? "all" : "default",
  };
}

function parseSampledSelection(
  value: unknown,
  fallback: SampledPageSelection,
): SampledPageSelection {
  const v = asRecord(value);
  if (!v) return { ...fallback, handles: [...fallback.handles] };
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : fallback.enabled,
    mode: v.mode === "auto" || v.mode === "manual" ? v.mode : fallback.mode,
    sampleSize: clampInt(v.sampleSize, fallback.sampleSize, 1, 50),
    handles: stringArray(v.handles),
  };
}

function parsePagesSelection(value: unknown): PagesSelection {
  const v = asRecord(value);
  const d = DEFAULT_PAGES_SELECTION;
  const home = asRecord(v?.home);
  const cart = asRecord(v?.cart);
  const custom = asRecord(v?.custom);
  return {
    home: {
      enabled:
        typeof home?.enabled === "boolean" ? home.enabled : d.home.enabled,
    },
    cart: {
      enabled:
        typeof cart?.enabled === "boolean" ? cart.enabled : d.cart.enabled,
    },
    collections: parseSampledSelection(v?.collections, d.collections),
    products: parseSampledSelection(v?.products, d.products),
    pages: parseSampledSelection(v?.pages, d.pages),
    blogs: parseSampledSelection(v?.blogs, d.blogs),
    custom: {
      enabled:
        typeof custom?.enabled === "boolean" ? custom.enabled : d.custom.enabled,
      urls: stringArray(custom?.urls),
    },
  };
}

function parseThresholds(value: unknown): Threshold[] {
  if (!Array.isArray(value)) return [];
  const thresholds: Threshold[] = [];
  for (const item of value) {
    const v = asRecord(item);
    if (!v) continue;
    if (typeof v.metric !== "string") continue;
    if (!(VALID_METRICS as string[]).includes(v.metric)) continue;
    if (v.operator !== "lt" && v.operator !== "gt") continue;
    if (typeof v.value !== "number" || !Number.isFinite(v.value)) continue;
    thresholds.push({
      id: typeof v.id === "string" ? v.id : `${v.metric}-${thresholds.length}`,
      metric: v.metric as ThresholdMetric,
      operator: v.operator,
      value: v.value,
      severity: v.severity === "critical" ? "critical" : "warning",
    });
  }
  return thresholds;
}

function parseNotifications(value: unknown): NotificationsConfig {
  const v = asRecord(value);
  const webhookUrl =
    typeof v?.webhookUrl === "string" && v.webhookUrl.length > 0
      ? v.webhookUrl
      : undefined;
  return {
    emails: stringArray(v?.emails),
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

/**
 * Defensive parse of a stored AuditRun.profileSnapshot Json value.
 * Every field falls back to a sane default so historical runs with older
 * snapshot shapes stay processable.
 */
export function parseProfileSnapshot(value: unknown): ProfileSnapshot {
  const v = asRecord(value) ?? {};
  return {
    profileId: typeof v.profileId === "string" ? v.profileId : "",
    name: typeof v.name === "string" ? v.name : "",
    devices: parseDevices(v.devices),
    runsPerUrl: clampInt(v.runsPerUrl, 3, 1, 10),
    categories: parseCategories(v.categories),
    markets: parseMarketsSelection(v.markets),
    pages: parsePagesSelection(v.pages),
    thresholds: parseThresholds(v.thresholds),
    notifications: parseNotifications(v.notifications),
  };
}

function buildProfileSnapshot(profile: PrismaAuditProfile): ProfileSnapshot {
  return {
    profileId: profile.id,
    name: profile.name,
    devices: parseDevices(profile.devices),
    runsPerUrl: clampInt(profile.runsPerUrl, 3, 1, 10),
    categories: parseCategories(profile.categories),
    markets: parseMarketsSelection(profile.markets),
    pages: parsePagesSelection(profile.pages),
    thresholds: parseThresholds(profile.thresholds),
    notifications: parseNotifications(profile.notifications),
  };
}

// --- createRun ----------------------------------------------------------------

export async function createRun(args: {
  shopDomain: string;
  profileId?: string;
  trigger: "MANUAL" | "SCHEDULED" | "THEME_PUBLISH";
  themeId?: string;
  themeName?: string;
}): Promise<{ runId: string; totalJobs: number }> {
  const shop = await prisma.shop.findUnique({
    where: { domain: args.shopDomain },
  });
  if (!shop) {
    throw new Error(`Shop ${args.shopDomain} is not installed`);
  }
  if (shop.uninstalledAt) {
    throw new Error(`Shop ${args.shopDomain} has uninstalled the app`);
  }

  const profile = args.profileId
    ? await prisma.auditProfile.findFirst({
        where: { id: args.profileId, shopId: shop.id },
      })
    : ((await prisma.auditProfile.findFirst({
        where: { shopId: shop.id, isDefault: true },
      })) ??
      (await prisma.auditProfile.findFirst({
        where: { shopId: shop.id },
        orderBy: { createdAt: "asc" },
      })));
  if (!profile) {
    throw new Error(
      args.profileId
        ? `Audit profile ${args.profileId} not found for ${args.shopDomain}`
        : `Shop ${args.shopDomain} has no audit profile`,
    );
  }

  const snapshot = buildProfileSnapshot(profile);

  const run = await prisma.auditRun.create({
    data: {
      shopId: shop.id,
      profileId: profile.id,
      profileSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      trigger: args.trigger,
      themeId: args.themeId ?? null,
      themeName: args.themeName ?? null,
      status: "QUEUED",
    },
  });

  let targets: AuditTargetUrl[];
  try {
    const { admin } = await unauthenticated.admin(args.shopDomain);
    let markets = await fetchActiveMarkets(admin.graphql);
    if (!markets.some((m) => m.rootUrls.length > 0)) {
      // Development stores / unified Markets shops can have active markets
      // with no explicit web presence: audit the primary domain instead.
      const fallback = await fetchPrimaryDomainMarket(admin.graphql);
      if (fallback) {
        markets = [fallback];
      }
    }
    const samples = await fetchSamples(admin.graphql, snapshot.pages);
    targets = buildAuditTargets(markets, snapshot.markets, snapshot.pages, samples);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.auditRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: `Failed to resolve audit targets: ${message}`,
        completedAt: new Date(),
      },
    });
    throw err;
  }

  if (targets.length === 0) {
    await prisma.auditRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error:
          "No audit targets resolved — check the profile's market and page selection.",
        completedAt: new Date(),
      },
    });
    return { runId: run.id, totalJobs: 0 };
  }

  const pageResults = await prisma.pageResult.createManyAndReturn({
    data: snapshot.devices.flatMap((device) =>
      targets.map((target) => ({
        runId: run.id,
        url: target.url,
        pageType: target.pageType,
        device,
        marketHandle: target.marketHandle ?? null,
        marketName: target.marketName ?? null,
        locale: target.locale ?? null,
        label: target.label ?? null,
        status: "PENDING" as const,
        runsRequested: snapshot.runsPerUrl,
      })),
    ),
    select: { id: true },
  });

  await prisma.auditRun.update({
    where: { id: run.id },
    data: {
      totalJobs: pageResults.length,
      status: "RUNNING",
      startedAt: new Date(),
    },
  });

  try {
    await getAuditQueue().addBulk(
      pageResults.map((row) => ({
        name: "audit-url",
        data: { pageResultId: row.id },
        opts: { jobId: row.id },
      })),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.auditRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: `Failed to enqueue audit jobs: ${message}`,
        completedAt: new Date(),
      },
    });
    throw err;
  }

  return { runId: run.id, totalJobs: pageResults.length };
}

// --- finalizeRun ----------------------------------------------------------------

const TERMINAL_RUN_STATUSES: string[] = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELED",
];

/**
 * Finalizes a run once every PageResult reached a terminal state.
 * Idempotent: returns early when the run is already terminal, and claims the
 * terminal transition with a conditional update so concurrent finalize jobs
 * cannot double-create alerts or double-send notifications.
 */
export async function finalizeRun(runId: string): Promise<void> {
  const run = await prisma.auditRun.findUnique({
    where: { id: runId },
    include: { pageResults: true, shop: true },
  });
  if (!run) return;
  if (TERMINAL_RUN_STATUSES.includes(run.status)) return;

  const stillRunning = run.pageResults.some(
    (r) => r.status === "PENDING" || r.status === "RUNNING",
  );
  if (stillRunning) return;

  const current = toRunSummary(run);
  const completedResults = current.pageResults.filter(
    (r) => r.status === "COMPLETED",
  );
  const failedResults = current.pageResults.filter((r) => r.status === "FAILED");

  const baselineRow = await prisma.auditRun.findFirst({
    where: {
      shopId: run.shopId,
      profileId: run.profileId,
      id: { not: run.id },
      status: { in: ["COMPLETED", "PARTIAL"] },
      // Only strictly older runs may serve as the baseline — keeps the frozen
      // narrative consistent with the report page (getPreviousRun) when runs
      // overlap.
      createdAt: { lt: run.createdAt },
    },
    orderBy: { createdAt: "desc" },
    include: { pageResults: true },
  });
  const baseline = baselineRow ? toRunSummary(baselineRow) : undefined;
  const comparison = baseline ? compareRuns(current, baseline) : undefined;

  const shopSettings = asRecord(run.shop.settings);
  const locale =
    typeof shopSettings?.locale === "string" ? shopSettings.locale : "en";
  const narrative = generateNarrative({ current, baseline, comparison, locale });

  const finalStatus =
    failedResults.length === 0
      ? ("COMPLETED" as const)
      : completedResults.length > 0
        ? ("PARTIAL" as const)
        : ("FAILED" as const);

  const claimed = await prisma.auditRun.updateMany({
    where: { id: run.id, status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: finalStatus,
      narrative: narrative as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
      completedJobs: completedResults.length,
      failedJobs: failedResults.length,
      error: finalStatus === "FAILED" ? "All page audits failed." : null,
    },
  });
  if (claimed.count === 0) return; // another finalize job already claimed it

  const snapshot = parseProfileSnapshot(run.profileSnapshot);
  const alerts = evaluateThresholds(snapshot.thresholds, completedResults);
  if (alerts.length === 0) return;

  await prisma.alert.createMany({
    data: alerts.map((alert) => ({
      shopId: run.shopId,
      runId: run.id,
      metric: alert.metric,
      operator: alert.operator,
      threshold: alert.threshold,
      actual: alert.actual,
      severity: alert.severity,
      url: alert.url ?? null,
      marketHandle: alert.marketHandle ?? null,
      device: (alert.device as DeviceProfile | undefined) ?? null,
      pageType: (alert.pageType as PageTypeKey | undefined) ?? null,
    })),
  });

  try {
    const sent = await sendAlertNotifications({
      shopDomain: run.shop.domain,
      runId: run.id,
      alerts,
      notifications: snapshot.notifications,
    });
    await prisma.alert.updateMany({
      where: { runId: run.id },
      data: {
        notifiedEmail: sent.emailSent,
        notifiedWebhook: sent.webhookSent,
      },
    });
  } catch (err) {
    console.error(
      `[runs] alert notification failed for run ${run.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
