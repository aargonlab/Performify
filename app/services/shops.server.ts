import prisma from "../db.server";
import type { ScheduleConfig } from "../lib/types";
import { syncProfileScheduler } from "./scheduler.server";

/** Defensive parse of AuditProfile.schedule Json (mirrors worker/index.ts). */
function parseScheduleConfig(value: unknown): ScheduleConfig {
  const v =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: v.enabled === true,
    cron: typeof v.cron === "string" ? v.cron : "0 4 1 * *",
    timezone: typeof v.timezone === "string" ? v.timezone : "UTC",
  };
}

/** Upsert the Shop row for a domain; called from auth hooks and webhooks. */
export async function ensureShop(domain: string) {
  const existing = await prisma.shop.findUnique({
    where: { domain },
    select: { uninstalledAt: true },
  });
  const shop = await prisma.shop.upsert({
    where: { domain },
    create: { domain },
    update: { uninstalledAt: null },
  });

  // Reinstall (uninstalled → installed transition): the uninstall webhook
  // removed the profiles' repeatable job schedulers — re-register the enabled
  // ones. Log-only: a Redis outage must never block auth.
  if (existing?.uninstalledAt) {
    try {
      const profiles = await prisma.auditProfile.findMany({
        where: { shopId: shop.id },
      });
      for (const profile of profiles) {
        const schedule = parseScheduleConfig(profile.schedule);
        if (!schedule.enabled) continue;
        try {
          await syncProfileScheduler({
            id: profile.id,
            shopDomain: domain,
            schedule,
          });
        } catch (error) {
          console.error(
            `Failed to re-register scheduler for profile ${profile.id}`,
            error,
          );
        }
      }
    } catch (error) {
      console.error(
        `Failed to re-register profile schedulers for ${domain}`,
        error,
      );
    }
  }

  return shop;
}

export async function getShopByDomain(domain: string) {
  return prisma.shop.findUnique({ where: { domain } });
}

export async function markShopUninstalled(domain: string) {
  await prisma.shop.updateMany({
    where: { domain },
    data: { uninstalledAt: new Date() },
  });
}

/** GDPR shop/redact: remove every trace of the shop's data. */
export async function redactShop(domain: string) {
  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (shop) {
    await prisma.shop.delete({ where: { id: shop.id } }); // cascades
  }
  await prisma.session.deleteMany({ where: { shop: domain } });
}
