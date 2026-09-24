import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { markShopUninstalled } from "../services/shops.server";
import { authenticateWebhookResilient } from "../services/webhook-auth.server";
import {
  recordWebhookOnce,
  releaseWebhookEvent,
} from "../services/webhook-events.server";
import { removeProfileScheduler } from "../services/scheduler.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // The shop is uninstalled, so the library's offline-token refresh can fail;
  // the resilient helper falls back to manual HMAC verification.
  const { shop, topic, webhookId } =
    await authenticateWebhookResilient(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const isFirstDelivery = await recordWebhookOnce({
    webhookId,
    topic,
    shopDomain: shop,
  });
  if (!isFirstDelivery) {
    return new Response();
  }

  try {
    // Webhook requests can trigger multiple times and after an app has already
    // been uninstalled; deleteMany is a no-op once the sessions are gone.
    await db.session.deleteMany({ where: { shop } });
    await markShopUninstalled(shop);
  } catch (error) {
    // Release the idempotency row so the Shopify retry can pass dedupe again,
    // then 500 so Shopify actually retries.
    console.error(
      `Failed to process ${topic} for ${shop} (webhook ${webhookId})`,
      error,
    );
    try {
      await releaseWebhookEvent(webhookId);
    } catch (cleanupError) {
      console.error(
        `Failed to release webhook event ${webhookId}`,
        cleanupError,
      );
    }
    return new Response("Failed to process uninstall", { status: 500 });
  }

  // Remove the repeatable schedulers for this shop's profiles. Redis may be
  // down: log and keep the 200 — schedulers for uninstalled shops are also
  // skipped at execution time.
  try {
    const shopRow = await db.shop.findUnique({
      where: { domain: shop },
      select: { profiles: { select: { id: true } } },
    });
    for (const profile of shopRow?.profiles ?? []) {
      await removeProfileScheduler(profile.id);
    }
  } catch (error) {
    console.error(`Failed to remove profile schedulers for ${shop}`, error);
  }

  return new Response();
};
