import type { ActionFunctionArgs } from "react-router";
import { redactShop } from "../services/shops.server";
import { authenticateWebhookResilient } from "../services/webhook-auth.server";
import {
  recordWebhookOnce,
  releaseWebhookEvent,
} from "../services/webhook-events.server";

// GDPR compliance webhooks. This app stores no customer data (only Lighthouse
// results for public store URLs), so customers/data_request and
// customers/redact are acknowledged and logged. shop/redact deletes every
// trace of the shop's data.
export const action = async ({ request }: ActionFunctionArgs) => {
  // shop/redact arrives 48h after uninstall, when the library's offline-token
  // refresh can fail; the resilient helper falls back to manual HMAC checks.
  const { shop, topic, webhookId } =
    await authenticateWebhookResilient(request);

  const isFirstDelivery = await recordWebhookOnce({
    webhookId,
    topic,
    shopDomain: shop,
  });
  if (!isFirstDelivery) {
    return new Response();
  }

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // No customer data is stored by this app — nothing to export or redact.
      console.log(
        `Received ${topic} webhook for ${shop}: no customer data stored`,
      );
      break;
    case "SHOP_REDACT":
      console.log(
        `Received ${topic} webhook for ${shop}: redacting shop data`,
      );
      // The idempotency row above was written before deletion and is not
      // linked to the Shop row (recordWebhookOnce sets shopId null once the
      // shop is gone; the FK is SetNull anyway), so it survives the cascade.
      try {
        await redactShop(shop);
      } catch (error) {
        // Release the idempotency row so the Shopify retry can pass dedupe
        // again, then 500 so Shopify actually retries — the redaction must
        // not be silently skipped.
        console.error(
          `Failed to redact shop data for ${shop} (webhook ${webhookId})`,
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
        return new Response("Failed to redact shop data", { status: 500 });
      }
      break;
    default:
      console.log(`Received unhandled compliance topic ${topic} for ${shop}`);
      break;
  }

  return new Response();
};
