// ---------------------------------------------------------------------------
// Integration: finalizeRun(runId) from app/services/runs.server.ts against a
// real Postgres, with no network: alerts come from the frozen profileSnapshot
// thresholds, notifications stay un-sent (no SMTP URL, emails: [] and no
// webhookUrl in the snapshot), and the terminal status transition is claimed
// exactly once (idempotent).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Prisma } from "@prisma/client";
import { finalizeRun } from "../../app/services/runs.server";
import { prisma, resetDb } from "../helpers/db";

const SHOP_DOMAIN = "finalize-test.myshopify.com";
const HOME_URL = `https://${SHOP_DOMAIN}/`;
const PRODUCT_URL = `https://${SHOP_DOMAIN}/products/test-product`;

const THRESHOLDS = [
  {
    id: "perf-lt-70",
    metric: "performanceScore",
    operator: "lt",
    value: 70,
    severity: "warning",
  },
];

/** Mirrors the ProfileSnapshot shape buildProfileSnapshot/createRun persists. */
function buildSnapshot(profileId: string): Prisma.InputJsonValue {
  return {
    profileId,
    name: "Default",
    devices: ["MOBILE"],
    runsPerUrl: 1,
    categories: ["performance", "accessibility", "best-practices", "seo"],
    markets: { mode: "all", handles: [], localeMode: "default" },
    pages: {
      home: { enabled: true },
      cart: { enabled: true },
      collections: { enabled: true, mode: "auto", sampleSize: 3, handles: [] },
      products: { enabled: true, mode: "auto", sampleSize: 3, handles: [] },
      pages: { enabled: false, mode: "manual", sampleSize: 3, handles: [] },
      blogs: { enabled: false, mode: "auto", sampleSize: 1, handles: [] },
      custom: { enabled: false, urls: [] },
    },
    thresholds: THRESHOLDS,
    notifications: { emails: [] },
  };
}

async function seedShopAndProfile() {
  const shop = await prisma.shop.create({ data: { domain: SHOP_DOMAIN } });
  const profile = await prisma.auditProfile.create({
    data: {
      shopId: shop.id,
      name: "Default",
      isDefault: true,
      runsPerUrl: 1,
      thresholds: THRESHOLDS as unknown as Prisma.InputJsonValue,
      notifications: { emails: [] } as unknown as Prisma.InputJsonValue,
    },
  });
  return { shop, profile };
}

async function seedRunningRun(shopId: string, profileId: string) {
  return prisma.auditRun.create({
    data: {
      shopId,
      profileId,
      profileSnapshot: buildSnapshot(profileId),
      trigger: "MANUAL",
      status: "RUNNING",
      totalJobs: 2,
      startedAt: new Date(),
    },
  });
}

const TOP_OPPORTUNITIES = [
  {
    id: "unused-javascript",
    title: "Reduce unused JavaScript",
    savingsMs: 1500,
    score: 0.3,
    displayValue: "Potential savings of 1.5 s",
  },
  {
    id: "render-blocking-resources",
    title: "Eliminate render-blocking resources",
    savingsMs: 800,
    score: 0.5,
    displayValue: "Potential savings of 0.8 s",
  },
];

async function seedCompletedPageResult(
  runId: string,
  args: { url: string; pageType: "HOME" | "PRODUCT"; performanceScore: number },
) {
  return prisma.pageResult.create({
    data: {
      runId,
      url: args.url,
      pageType: args.pageType,
      device: "MOBILE",
      status: "COMPLETED",
      runsRequested: 1,
      runsCompleted: 1,
      performanceScore: args.performanceScore,
      accessibilityScore: 90,
      bestPracticesScore: 92,
      seoScore: 88,
      lcpMs: 3200,
      cls: 0.08,
      tbtMs: 450,
      fcpMs: 1800,
      speedIndexMs: 4100,
      ttfbMs: 600,
      fieldSource: "origin",
      fieldLcpMs: 3600,
      fieldInpMs: 220,
      fieldCls: 0.1,
      fieldOverall: "AVERAGE",
      lighthouseVersion: "12.0.0",
      topOpportunities: TOP_OPPORTUNITIES as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });
}

async function seedFailedPageResult(runId: string, url: string) {
  return prisma.pageResult.create({
    data: {
      runId,
      url,
      pageType: "PRODUCT",
      device: "MOBILE",
      status: "FAILED",
      runsRequested: 1,
      runsCompleted: 0,
      error: "PSI request failed with 500",
    },
  });
}

interface NarrativeShape {
  summary: string;
  recommendations: { auditId: string; priority: number }[];
}

describe("finalizeRun", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("all results completed: COMPLETED status, narrative, one alert for the violating page", async () => {
    const { shop, profile } = await seedShopAndProfile();
    const run = await seedRunningRun(shop.id, profile.id);
    await seedCompletedPageResult(run.id, {
      url: HOME_URL,
      pageType: "HOME",
      performanceScore: 55,
    });
    await seedCompletedPageResult(run.id, {
      url: PRODUCT_URL,
      pageType: "PRODUCT",
      performanceScore: 85,
    });

    await finalizeRun(run.id);

    const updated = await prisma.auditRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.completedJobs).toBe(2);
    expect(updated.failedJobs).toBe(0);
    expect(updated.completedAt).not.toBeNull();
    expect(updated.error).toBeNull();

    const narrative = updated.narrative as unknown as NarrativeShape | null;
    expect(narrative).not.toBeNull();
    expect(typeof narrative?.summary).toBe("string");
    expect(narrative?.summary.length).toBeGreaterThan(0);
    // Average performance across the two pages is 70.
    expect(narrative?.summary).toContain("70");
    expect(Array.isArray(narrative?.recommendations)).toBe(true);
    const auditIds = narrative?.recommendations.map((r) => r.auditId) ?? [];
    expect(auditIds).toContain("unused-javascript");
    expect(auditIds).toContain("render-blocking-resources");

    const alerts = await prisma.alert.findMany({ where: { runId: run.id } });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert.shopId).toBe(shop.id);
    expect(alert.metric).toBe("performanceScore");
    expect(alert.operator).toBe("lt");
    expect(alert.threshold).toBe(70);
    expect(alert.actual).toBe(55);
    expect(alert.severity).toBe("warning");
    expect(alert.url).toBe(HOME_URL);
    expect(alert.device).toBe("MOBILE");
    expect(alert.pageType).toBe("HOME");
    // No SMTP configured and snapshot has emails: [] / no webhookUrl.
    expect(alert.notifiedEmail).toBe(false);
    expect(alert.notifiedWebhook).toBe(false);
  });

  it("second finalize call is a no-op: no duplicate alerts, terminal state untouched", async () => {
    const { shop, profile } = await seedShopAndProfile();
    const run = await seedRunningRun(shop.id, profile.id);
    await seedCompletedPageResult(run.id, {
      url: HOME_URL,
      pageType: "HOME",
      performanceScore: 55,
    });
    await seedCompletedPageResult(run.id, {
      url: PRODUCT_URL,
      pageType: "PRODUCT",
      performanceScore: 85,
    });

    await finalizeRun(run.id);
    const first = await prisma.auditRun.findUniqueOrThrow({
      where: { id: run.id },
    });

    await finalizeRun(run.id);

    const alerts = await prisma.alert.findMany({ where: { runId: run.id } });
    expect(alerts).toHaveLength(1);

    const second = await prisma.auditRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(second.status).toBe("COMPLETED");
    expect(second.completedAt).toEqual(first.completedAt);
  });

  it("one completed + one failed result: PARTIAL status with per-status job counts", async () => {
    const { shop, profile } = await seedShopAndProfile();
    const run = await seedRunningRun(shop.id, profile.id);
    await seedCompletedPageResult(run.id, {
      url: HOME_URL,
      pageType: "HOME",
      performanceScore: 85,
    });
    await seedFailedPageResult(run.id, PRODUCT_URL);

    await finalizeRun(run.id);

    const updated = await prisma.auditRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(updated.status).toBe("PARTIAL");
    expect(updated.completedJobs).toBe(1);
    expect(updated.failedJobs).toBe(1);
    expect(updated.error).toBeNull();
    expect(updated.narrative).not.toBeNull();

    // 85 does not violate the lt-70 threshold; the failed page produces none.
    expect(await prisma.alert.count({ where: { runId: run.id } })).toBe(0);
  });

  it("baseline ignores a terminal run created after the finalizing run", async () => {
    const { shop, profile } = await seedShopAndProfile();
    const now = Date.now();

    // Strictly older terminal run — the only legitimate baseline.
    const olderRun = await prisma.auditRun.create({
      data: {
        shopId: shop.id,
        profileId: profile.id,
        profileSnapshot: buildSnapshot(profile.id),
        trigger: "MANUAL",
        status: "COMPLETED",
        totalJobs: 1,
        completedJobs: 1,
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
        completedAt: new Date(now - 2 * 60 * 60 * 1000),
      },
    });
    await seedCompletedPageResult(olderRun.id, {
      url: HOME_URL,
      pageType: "HOME",
      performanceScore: 80,
    });

    // The run being finalized, created BEFORE the newer run below.
    const run = await prisma.auditRun.create({
      data: {
        shopId: shop.id,
        profileId: profile.id,
        profileSnapshot: buildSnapshot(profile.id),
        trigger: "MANUAL",
        status: "RUNNING",
        totalJobs: 1,
        createdAt: new Date(now - 60 * 60 * 1000),
        startedAt: new Date(now - 60 * 60 * 1000),
      },
    });
    await seedCompletedPageResult(run.id, {
      url: HOME_URL,
      pageType: "HOME",
      performanceScore: 85,
    });

    // Overlapping run that finished first but was created AFTER — must never
    // be frozen into the narrative as the "previous audit".
    const newerRun = await prisma.auditRun.create({
      data: {
        shopId: shop.id,
        profileId: profile.id,
        profileSnapshot: buildSnapshot(profile.id),
        trigger: "MANUAL",
        status: "COMPLETED",
        totalJobs: 1,
        completedJobs: 1,
        createdAt: new Date(now - 10 * 60 * 1000),
        completedAt: new Date(now - 5 * 60 * 1000),
      },
    });
    await seedCompletedPageResult(newerRun.id, {
      url: HOME_URL,
      pageType: "HOME",
      performanceScore: 95,
    });

    await finalizeRun(run.id);

    const updated = await prisma.auditRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(updated.status).toBe("COMPLETED");
    const narrative = updated.narrative as unknown as {
      comparedToRunId?: string;
    } | null;
    expect(narrative?.comparedToRunId).toBe(olderRun.id);
    expect(narrative?.comparedToRunId).not.toBe(newerRun.id);
  });

  it("all results failed: FAILED status, error message, no alerts", async () => {
    const { shop, profile } = await seedShopAndProfile();
    const run = await seedRunningRun(shop.id, profile.id);
    await seedFailedPageResult(run.id, HOME_URL);
    await seedFailedPageResult(run.id, PRODUCT_URL);

    await finalizeRun(run.id);

    const updated = await prisma.auditRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(updated.status).toBe("FAILED");
    expect(updated.completedJobs).toBe(0);
    expect(updated.failedJobs).toBe(2);
    expect(updated.error).toBe("All page audits failed.");

    const narrative = updated.narrative as unknown as NarrativeShape | null;
    expect(narrative).not.toBeNull();
    expect(narrative?.summary).toContain("no performance score is available");

    expect(await prisma.alert.count({ where: { runId: run.id } })).toBe(0);
  });
});
