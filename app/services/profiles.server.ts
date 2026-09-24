// ---------------------------------------------------------------------------
// Audit profile CRUD + defensive input validation.
// Every mutation keeps the BullMQ job scheduler in sync (best-effort: a Redis
// hiccup must never lose the merchant's saved profile).
// ---------------------------------------------------------------------------

import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type {
  DeviceProfile,
  MarketsSelection,
  NotificationsConfig,
  PagesSelection,
  PsiCategory,
  SampledPageSelection,
  ScheduleConfig,
  Threshold,
  ThresholdMetric,
} from "../lib/types";
import { DEFAULT_PAGES_SELECTION, MAX_SAMPLE_SIZE } from "../lib/types";
import { validateCustomUrl } from "../lib/urls/build-urls";
import {
  removeProfileScheduler,
  syncProfileScheduler,
} from "./scheduler.server";

export interface ProfileInput {
  name: string;
  devices: DeviceProfile[];
  runsPerUrl: number;
  categories: PsiCategory[];
  markets: MarketsSelection;
  pages: PagesSelection;
  schedule: ScheduleConfig;
  themePublishTrigger: boolean;
  thresholds: Threshold[];
  notifications: NotificationsConfig;
  isDefault: boolean;
}

/** Thrown when a profile name collides with the @@unique([shopId, name]). */
export class ProfileNameConflictError extends Error {
  constructor(profileName: string) {
    super(`A profile named "${profileName}" already exists.`);
    this.name = "ProfileNameConflictError";
  }
}

// ---------------------------------------------------------------------------
// Validation (hand-rolled, no zod)
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 60;
const DEVICE_VALUES: DeviceProfile[] = ["MOBILE", "DESKTOP"];
const CATEGORY_VALUES: PsiCategory[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
];
const THRESHOLD_METRICS: ThresholdMetric[] = [
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** [min, max] per cron field: minute, hour, day of month, month, day of week. */
const CRON_FIELD_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7], // 0 and 7 both mean Sunday
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInt(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isInteger(n) ? n : null;
}

/** Keeps only non-empty trimmed strings, deduplicated. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Validates a single cron field: comma-separated list of `*`, `n`, `a-b`,
 * optionally with a `/step` suffix; numbers must fall in [min, max].
 */
function isValidCronField(field: string, min: number, max: number): boolean {
  if (!/^[0-9*,/-]+$/.test(field)) return false;
  return field.split(",").every((part) => {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!match) return false;
    const [, range, step] = match;
    if (step !== undefined && Number.parseInt(step, 10) < 1) return false;
    if (range === "*") return true;
    const [startRaw, endRaw] = range.split("-");
    const start = Number.parseInt(startRaw, 10);
    if (start < min || start > max) return false;
    if (endRaw !== undefined) {
      const end = Number.parseInt(endRaw, 10);
      if (end < min || end > max || end < start) return false;
    }
    return true;
  });
}

/** Exactly 5 whitespace-separated fields with plausible values; 6-field rejected. */
function isValidCronPattern(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) =>
    isValidCronField(field, CRON_FIELD_RANGES[i][0], CRON_FIELD_RANGES[i][1]),
  );
}

function isValidTimezone(tz: string): boolean {
  // "UTC" is canonical for us but missing from supportedValuesOf on some ICU builds.
  if (tz === "UTC") return true;
  try {
    return Intl.supportedValuesOf("timeZone").includes(tz);
  } catch {
    return false;
  }
}

function parseToggle(value: unknown): { enabled: boolean } {
  return { enabled: isRecord(value) && value.enabled === true };
}

function parseSampledSelection(
  value: unknown,
  key: string,
  errors: Record<string, string>,
): SampledPageSelection {
  const raw = isRecord(value) ? value : {};
  const enabled = raw.enabled === true;
  const mode: "auto" | "manual" = raw.mode === "manual" ? "manual" : "auto";
  let sampleSize = toInt(raw.sampleSize) ?? 0;
  if (enabled && mode === "auto") {
    if (sampleSize < 1 || sampleSize > MAX_SAMPLE_SIZE) {
      errors[`pages.${key}.sampleSize`] =
        `Sample size must be between 1 and ${MAX_SAMPLE_SIZE}.`;
    }
  } else {
    // The field is hidden in the UI here: clamp instead of blocking the save.
    sampleSize = Math.min(Math.max(sampleSize, 1), MAX_SAMPLE_SIZE);
  }
  const handles = toStringArray(raw.handles);
  if (enabled && mode === "manual" && handles.length === 0) {
    errors[`pages.${key}.handles`] =
      "Add at least one handle or switch to automatic sampling.";
  }
  return { enabled, mode, sampleSize, handles };
}

function parseCustomSelection(
  value: unknown,
  errors: Record<string, string>,
): PagesSelection["custom"] {
  const raw = isRecord(value) ? value : {};
  const enabled = raw.enabled === true;
  const urls = toStringArray(raw.urls);
  // Only enforce when enabled: disabled leftovers are never audited
  // (buildAuditTargets skips invalid URLs) and re-enabling re-validates.
  if (enabled) {
    for (const [index, url] of urls.entries()) {
      const message = validateCustomUrl(url);
      if (message) {
        errors["pages.custom.urls"] = `URL ${index + 1} ("${url}"): ${message}`;
        break;
      }
    }
    if (urls.length === 0 && !errors["pages.custom.urls"]) {
      errors["pages.custom.urls"] =
        "Add at least one URL or disable custom URLs.";
    }
  }
  return { enabled, urls };
}

export function validateProfileInput(
  input: unknown,
): { ok: true; value: ProfileInput } | { ok: false; errors: Record<string, string> } {
  if (!isRecord(input)) {
    return { ok: false, errors: { form: "Invalid profile payload." } };
  }
  const errors: Record<string, string> = {};

  // --- Basics ---------------------------------------------------------------
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    errors.name = "Enter a profile name.";
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `The name must be at most ${MAX_NAME_LENGTH} characters.`;
  }

  // --- Devices & sampling ----------------------------------------------------
  const rawDevices = toStringArray(input.devices);
  const devices = DEVICE_VALUES.filter((d) => rawDevices.includes(d));
  if (rawDevices.some((d) => !DEVICE_VALUES.includes(d as DeviceProfile))) {
    errors.devices = "Devices can only be MOBILE or DESKTOP.";
  } else if (devices.length === 0) {
    errors.devices = "Select at least one device.";
  }

  const runsPerUrlRaw = toInt(input.runsPerUrl);
  const runsPerUrl =
    runsPerUrlRaw !== null && runsPerUrlRaw >= 1 && runsPerUrlRaw <= 5
      ? runsPerUrlRaw
      : null;
  if (runsPerUrl === null) {
    errors.runsPerUrl = "Runs per URL must be a whole number between 1 and 5.";
  }

  const rawCategories = toStringArray(input.categories);
  const categories = CATEGORY_VALUES.filter((c) => rawCategories.includes(c));
  if (rawCategories.some((c) => !CATEGORY_VALUES.includes(c as PsiCategory))) {
    errors.categories = "Unknown Lighthouse category.";
  } else if (categories.length === 0) {
    errors.categories = "Select at least one Lighthouse category.";
  }

  // --- Markets ---------------------------------------------------------------
  const marketsRaw = isRecord(input.markets) ? input.markets : {};
  const marketsMode =
    marketsRaw.mode === "all" ||
    marketsRaw.mode === "include" ||
    marketsRaw.mode === "exclude"
      ? marketsRaw.mode
      : null;
  if (marketsMode === null) {
    errors["markets.mode"] = "Choose how markets are selected.";
  }
  const marketHandles = toStringArray(marketsRaw.handles);
  if (marketsMode === "include" && marketHandles.length === 0) {
    errors["markets.handles"] = "Select at least one market to include.";
  }
  const localeMode =
    marketsRaw.localeMode === "default" || marketsRaw.localeMode === "all"
      ? marketsRaw.localeMode
      : null;
  if (localeMode === null) {
    errors["markets.localeMode"] = "Choose which locales to audit.";
  }

  // --- Pages -----------------------------------------------------------------
  const pagesRaw = isRecord(input.pages) ? input.pages : {};
  const pages: PagesSelection = {
    home: parseToggle(pagesRaw.home),
    cart: parseToggle(pagesRaw.cart),
    collections: parseSampledSelection(pagesRaw.collections, "collections", errors),
    products: parseSampledSelection(pagesRaw.products, "products", errors),
    pages: parseSampledSelection(pagesRaw.pages, "pages", errors),
    blogs: parseSampledSelection(pagesRaw.blogs, "blogs", errors),
    custom: parseCustomSelection(pagesRaw.custom, errors),
  };

  // --- Scheduling ------------------------------------------------------------
  const scheduleRaw = isRecord(input.schedule) ? input.schedule : {};
  const cron =
    typeof scheduleRaw.cron === "string"
      ? scheduleRaw.cron.trim().replace(/\s+/g, " ")
      : "";
  if (!isValidCronPattern(cron)) {
    errors["schedule.cron"] =
      'Enter a valid 5-field cron pattern, e.g. "0 4 1 * *".';
  }
  const timezone =
    typeof scheduleRaw.timezone === "string" ? scheduleRaw.timezone.trim() : "";
  if (!isValidTimezone(timezone)) {
    errors["schedule.timezone"] = "Choose a valid IANA timezone.";
  }
  const schedule: ScheduleConfig = {
    enabled: scheduleRaw.enabled === true,
    cron,
    timezone,
  };

  // --- Thresholds ------------------------------------------------------------
  const thresholds: Threshold[] = [];
  const thresholdsRaw =
    input.thresholds === undefined
      ? []
      : Array.isArray(input.thresholds)
        ? input.thresholds
        : null;
  if (thresholdsRaw === null) {
    errors.thresholds = "Invalid thresholds.";
  } else {
    thresholdsRaw.forEach((item, index) => {
      const raw = isRecord(item) ? item : {};
      const metric = THRESHOLD_METRICS.includes(raw.metric as ThresholdMetric)
        ? (raw.metric as ThresholdMetric)
        : null;
      if (metric === null) {
        errors[`thresholds.${index}.metric`] = "Choose a metric.";
      }
      const operator =
        raw.operator === "lt" || raw.operator === "gt" ? raw.operator : null;
      if (operator === null) {
        errors[`thresholds.${index}.operator`] = "Choose a comparison.";
      }
      const value =
        typeof raw.value === "number"
          ? raw.value
          : typeof raw.value === "string" && raw.value.trim() !== ""
            ? Number(raw.value)
            : NaN;
      if (!Number.isFinite(value) || value < 0) {
        errors[`thresholds.${index}.value`] = "Enter a value of 0 or more.";
      }
      const severity =
        raw.severity === "warning" || raw.severity === "critical"
          ? raw.severity
          : null;
      if (severity === null) {
        errors[`thresholds.${index}.severity`] = "Choose a severity.";
      }
      const id =
        typeof raw.id === "string" && raw.id.trim() !== ""
          ? raw.id.trim()
          : crypto.randomUUID();
      if (
        metric !== null &&
        operator !== null &&
        severity !== null &&
        Number.isFinite(value) &&
        value >= 0
      ) {
        thresholds.push({ id, metric, operator, value, severity });
      }
    });
  }

  // --- Notifications ---------------------------------------------------------
  const notificationsRaw = isRecord(input.notifications)
    ? input.notifications
    : {};
  const emails = toStringArray(notificationsRaw.emails).map((e) =>
    e.toLowerCase(),
  );
  const invalidEmail = emails.find((email) => !EMAIL_RE.test(email));
  if (invalidEmail !== undefined) {
    errors["notifications.emails"] =
      `"${invalidEmail}" is not a valid email address.`;
  }
  let webhookUrl: string | undefined;
  const webhookRaw =
    typeof notificationsRaw.webhookUrl === "string"
      ? notificationsRaw.webhookUrl.trim()
      : "";
  if (webhookRaw) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(webhookRaw);
    } catch {
      parsed = null;
    }
    if (parsed === null || parsed.protocol !== "https:") {
      errors["notifications.webhookUrl"] =
        "The webhook URL must be a valid https:// URL.";
    } else {
      webhookUrl = webhookRaw;
    }
  }
  const notifications: NotificationsConfig = {
    emails: [...new Set(emails)],
    ...(webhookUrl ? { webhookUrl } : {}),
  };

  if (
    Object.keys(errors).length > 0 ||
    runsPerUrl === null ||
    marketsMode === null ||
    localeMode === null
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      name,
      devices,
      runsPerUrl,
      categories,
      markets: {
        mode: marketsMode,
        handles: marketsMode === "all" ? [] : marketHandles,
        localeMode,
      },
      pages,
      schedule,
      themePublishTrigger: input.themePublishTrigger === true,
      thresholds,
      notifications,
      isDefault: input.isDefault === true,
    },
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function toProfileData(input: ProfileInput) {
  return {
    name: input.name,
    isDefault: input.isDefault,
    devices: input.devices,
    runsPerUrl: input.runsPerUrl,
    categories: input.categories,
    markets: input.markets as unknown as Prisma.InputJsonValue,
    pages: input.pages as unknown as Prisma.InputJsonValue,
    schedule: input.schedule as unknown as Prisma.InputJsonValue,
    themePublishTrigger: input.themePublishTrigger,
    thresholds: input.thresholds as unknown as Prisma.InputJsonValue,
    notifications: input.notifications as unknown as Prisma.InputJsonValue,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** Scheduler sync must never fail a profile save; log and move on. */
async function trySyncScheduler(
  profileId: string,
  shopDomain: string,
  schedule: ScheduleConfig,
): Promise<void> {
  try {
    await syncProfileScheduler({ id: profileId, shopDomain, schedule });
  } catch (error) {
    console.error(
      `[profiles] Failed to sync scheduler for profile ${profileId}:`,
      error,
    );
  }
}

export async function listProfiles(shopId: string) {
  return prisma.auditProfile.findMany({
    where: { shopId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

export async function getProfile(shopId: string, profileId: string) {
  return prisma.auditProfile.findFirst({
    where: { id: profileId, shopId },
  });
}

export async function createProfile(
  shop: { id: string; domain: string },
  input: ProfileInput,
) {
  let profile;
  try {
    profile = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.auditProfile.updateMany({
          where: { shopId: shop.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.auditProfile.create({
        data: { shopId: shop.id, ...toProfileData(input) },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ProfileNameConflictError(input.name);
    }
    throw error;
  }
  await trySyncScheduler(profile.id, shop.domain, input.schedule);
  return profile;
}

export async function updateProfile(
  shop: { id: string; domain: string },
  profileId: string,
  input: ProfileInput,
) {
  let profile;
  try {
    profile = await prisma.$transaction(async (tx) => {
      const existing = await tx.auditProfile.findFirst({
        where: { id: profileId, shopId: shop.id },
        select: { id: true },
      });
      if (!existing) {
        throw new Error(
          `Audit profile ${profileId} not found for shop ${shop.domain}.`,
        );
      }
      if (input.isDefault) {
        await tx.auditProfile.updateMany({
          where: { shopId: shop.id, isDefault: true, id: { not: profileId } },
          data: { isDefault: false },
        });
      }
      return tx.auditProfile.update({
        where: { id: profileId },
        data: toProfileData(input),
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ProfileNameConflictError(input.name);
    }
    throw error;
  }
  await trySyncScheduler(profile.id, shop.domain, input.schedule);
  return profile;
}

/** Marks one profile as default and clears the flag on every other profile. */
export async function setDefaultProfile(shopId: string, profileId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.auditProfile.findFirst({
      where: { id: profileId, shopId },
      select: { id: true },
    });
    if (!existing) {
      throw new Error(`Audit profile ${profileId} not found.`);
    }
    await tx.auditProfile.updateMany({
      where: { shopId, isDefault: true, id: { not: profileId } },
      data: { isDefault: false },
    });
    return tx.auditProfile.update({
      where: { id: profileId },
      data: { isDefault: true },
    });
  });
}

export async function duplicateProfile(
  shop: { id: string; domain: string },
  profileId: string,
  newName?: string,
) {
  const source = await prisma.auditProfile.findFirst({
    where: { id: profileId, shopId: shop.id },
  });
  if (!source) {
    throw new Error(
      `Audit profile ${profileId} not found for shop ${shop.domain}.`,
    );
  }

  const existingNames = new Set(
    (
      await prisma.auditProfile.findMany({
        where: { shopId: shop.id },
        select: { name: true },
      })
    ).map((p) => p.name),
  );
  const base = (newName?.trim() || `Copy of ${source.name}`).slice(
    0,
    MAX_NAME_LENGTH,
  );
  let name = base;
  for (let suffix = 2; existingNames.has(name); suffix += 1) {
    const tail = ` ${suffix}`;
    name = base.slice(0, MAX_NAME_LENGTH - tail.length) + tail;
  }

  // Safe defaults for the copy: never default, never silently scheduled.
  const schedule: ScheduleConfig = {
    ...(source.schedule as unknown as ScheduleConfig),
    enabled: false,
  };

  let profile;
  try {
    profile = await prisma.auditProfile.create({
      data: {
        shopId: shop.id,
        name,
        isDefault: false,
        devices: source.devices,
        runsPerUrl: source.runsPerUrl,
        categories: source.categories,
        markets: source.markets as unknown as Prisma.InputJsonValue,
        pages: source.pages as unknown as Prisma.InputJsonValue,
        schedule: schedule as unknown as Prisma.InputJsonValue,
        themePublishTrigger: source.themePublishTrigger,
        thresholds: source.thresholds as unknown as Prisma.InputJsonValue,
        notifications: source.notifications as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ProfileNameConflictError(name);
    }
    throw error;
  }
  await trySyncScheduler(profile.id, shop.domain, schedule);
  return profile;
}

export async function deleteProfile(
  shop: { id: string; domain: string },
  profileId: string,
) {
  try {
    await removeProfileScheduler(profileId);
  } catch (error) {
    console.error(
      `[profiles] Failed to remove scheduler for profile ${profileId}:`,
      error,
    );
  }
  await prisma.auditProfile.deleteMany({
    where: { id: profileId, shopId: shop.id },
  });
}

/**
 * Creates a "Default" profile on first visit when the shop has none;
 * otherwise returns the existing default (or oldest) profile.
 */
export async function ensureDefaultProfile(shop: {
  id: string;
  domain: string;
  timezone?: string | null;
}) {
  const existing = await prisma.auditProfile.findFirst({
    where: { shopId: shop.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (existing) return existing;

  const timezone =
    shop.timezone && isValidTimezone(shop.timezone) ? shop.timezone : "UTC";
  const input: ProfileInput = {
    name: "Default",
    devices: ["MOBILE"],
    runsPerUrl: 3,
    categories: [...CATEGORY_VALUES],
    markets: { mode: "all", handles: [], localeMode: "default" },
    pages: DEFAULT_PAGES_SELECTION,
    schedule: { enabled: true, cron: "0 4 1 * *", timezone },
    themePublishTrigger: true,
    thresholds: [
      {
        id: crypto.randomUUID(),
        metric: "performanceScore",
        operator: "lt",
        value: 70,
        severity: "warning",
      },
    ],
    notifications: { emails: [] },
    isDefault: true,
  };

  try {
    return await createProfile({ id: shop.id, domain: shop.domain }, input);
  } catch (error) {
    if (error instanceof ProfileNameConflictError) {
      // Two first-visit loaders raced; the other one created it.
      const raced = await prisma.auditProfile.findFirst({
        where: { shopId: shop.id, name: input.name },
      });
      if (raced) return raced;
    }
    throw error;
  }
}
