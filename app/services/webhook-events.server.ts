import { Prisma } from "@prisma/client";
import prisma from "../db.server";

/**
 * Records a webhook delivery exactly once, keyed on X-Shopify-Webhook-Id.
 *
 * Returns `true` if this is the first time the delivery is seen, `false` if
 * the row already exists (duplicate delivery — Shopify retries up to 8 times
 * over 4 hours). Any error other than a unique violation is rethrown.
 */
export async function recordWebhookOnce(args: {
  webhookId: string;
  topic: string;
  shopDomain: string;
}): Promise<boolean> {
  const shop = await prisma.shop.findUnique({
    where: { domain: args.shopDomain },
    select: { id: true },
  });

  try {
    await prisma.webhookEvent.create({
      data: {
        id: args.webhookId,
        topic: args.topic,
        shopDomain: args.shopDomain,
        shopId: shop?.id ?? null,
      },
    });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false; // duplicate delivery — already processed
    }
    throw error;
  }
}

/**
 * Removes the idempotency row so a Shopify retry can pass dedupe again.
 * Used when downstream work (e.g. enqueue) fails after the row was written.
 */
export async function releaseWebhookEvent(webhookId: string): Promise<void> {
  await prisma.webhookEvent.deleteMany({ where: { id: webhookId } });
}
