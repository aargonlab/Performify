import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getControlQueue } from "../queues/queues.server";
import { recordWebhookOnce } from "../services/webhook-events.server";

// themes/publish → enqueue a theme-publish-run control job.
// Shopify requires a response within 5s and retries 8 times over 4 hours:
// respond immediately, delegate all work to the queue.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } =
    await authenticate.webhook(request);

  // Enqueue BEFORE writing the idempotency row: a crash between the two must
  // lose the dedupe row (the Shopify retry re-enqueues) rather than the job.
  // Duplicate deliveries re-add safely — BullMQ ignores adds with an existing
  // jobId, and removeOnComplete keeps completed jobs for 7 days, far longer
  // than Shopify's 4-hour retry window.
  try {
    await getControlQueue().add(
      "theme-publish-run",
      {
        kind: "theme-publish-run",
        shopDomain: shop,
        themeId: String(payload.id),
        themeName: String(payload.name ?? ""),
      },
      // BullMQ rejects custom job ids containing ":" — keep it colon-free
      { jobId: `theme-${webhookId}` },
    );
  } catch (error) {
    // Redis unavailable: 500 so Shopify retries. No idempotency row has been
    // written yet, so there is nothing to release.
    console.error(
      `Failed to enqueue theme-publish-run for ${shop} (webhook ${webhookId})`,
      error,
    );
    return new Response("Failed to enqueue job", { status: 500 });
  }

  // Bookkeeping only — the jobId dedupe above is what prevents double
  // processing. A duplicate delivery (false) needs no special handling.
  await recordWebhookOnce({ webhookId, topic, shopDomain: shop });

  return new Response();
};
