// ---------------------------------------------------------------------------
// Resilient webhook authentication.
//
// authenticate.webhook (with the expiringOfflineAccessTokens future flag)
// refreshes the shop's offline token after HMAC validation succeeds (see
// node_modules/@shopify/shopify-app-react-router .../webhooks/authenticate.mjs
// → ensureValidOfflineSession). For an uninstalled shop that refresh always
// fails, so APP_UNINSTALLED and SHOP_REDACT would 500 on every retry and never
// be processed. Genuine validation failures throw a Response BEFORE the
// session is touched — 405 (non-POST), 401 (invalid HMAC) or 400 (malformed) —
// and are rethrown as-is. Anything else (the refresh helper's Response 500,
// InvalidJwtError/HttpResponseError, network errors) falls back to verifying
// the HMAC manually and building the context from the raw request.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import type { Session } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export interface ResilientWebhookContext {
  shop: string;
  /** SCREAMING_SNAKE topic, e.g. "APP_UNINSTALLED" — same shape the library returns. */
  topic: string;
  payload: Record<string, unknown>;
  webhookId: string;
  session: Session | undefined;
}

const VALIDATION_FAILURE_STATUSES = [400, 401, 405];

export async function authenticateWebhookResilient(
  request: Request,
): Promise<ResilientWebhookContext> {
  try {
    const { shop, topic, payload, webhookId, session } =
      await authenticate.webhook(request.clone());
    return { shop, topic, payload, webhookId, session };
  } catch (error) {
    if (
      error instanceof Response &&
      VALIDATION_FAILURE_STATUSES.includes(error.status)
    ) {
      throw error; // genuine HMAC / malformed-request failure
    }
    return verifyWebhookManually(request);
  }
}

async function verifyWebhookManually(
  request: Request,
): Promise<ResilientWebhookContext> {
  const rawBody = await request.text();
  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET!)
    .update(rawBody, "utf8")
    .digest("base64");
  const expected = Buffer.from(digest, "base64");
  const received = Buffer.from(
    request.headers.get("X-Shopify-Hmac-Sha256") ?? "",
    "base64",
  );
  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    throw new Response(null, { status: 401 });
  }

  const rawTopic = request.headers.get("X-Shopify-Topic") ?? "";
  return {
    shop: request.headers.get("X-Shopify-Shop-Domain") ?? "",
    topic: rawTopic.replace(/\//g, "_").toUpperCase(),
    payload: JSON.parse(rawBody) as Record<string, unknown>,
    webhookId: request.headers.get("X-Shopify-Webhook-Id") ?? "",
    session: undefined,
  };
}
