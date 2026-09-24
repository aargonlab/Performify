// ---------------------------------------------------------------------------
// Builds a Request identical to a real Shopify webhook delivery, signed with
// SHOPIFY_API_SECRET so authenticate.webhook() accepts it.
//
// Header set verified against @shopify/shopify-api's webhook validation
// (lib/webhooks/validate.mjs → checkWebhooksHeaders): the required headers are
// X-Shopify-Hmac-Sha256, X-Shopify-Topic, X-Shopify-Shop-Domain,
// X-Shopify-API-Version and X-Shopify-Webhook-Id; the HMAC is a base64
// SHA-256 of the raw body keyed with the app secret.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

export interface MakeWebhookRequestArgs {
  topic: string;
  shopDomain: string;
  webhookId: string;
  payload: unknown;
  apiVersion?: string;
  url?: string;
}

export function makeWebhookRequest(args: MakeWebhookRequestArgs): Request {
  const rawBody = JSON.stringify(args.payload);
  const hmac = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET!)
    .update(rawBody, "utf8")
    .digest("base64");

  return new Request(
    args.url ?? `https://test-app.example.com/webhooks/${args.topic}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": args.topic,
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Shop-Domain": args.shopDomain,
        "X-Shopify-Webhook-Id": args.webhookId,
        "X-Shopify-API-Version": args.apiVersion ?? "2026-07",
      },
      body: rawBody,
    },
  );
}
