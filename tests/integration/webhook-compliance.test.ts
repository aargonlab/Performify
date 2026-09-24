// ---------------------------------------------------------------------------
// Integration: webhooks.compliance action (GDPR topics) against real Postgres.
// shop/redact must cascade-delete the Shop's data and the domain's sessions
// while keeping the WebhookEvent idempotency row (FK is SetNull); the two
// customers/* topics are ack-only; duplicate deliveries are deduped. The
// route authenticates via authenticateWebhookResilient: shop/redact arrives
// 48h after uninstall, when the library's offline-token refresh fails — the
// helper falls back to manual HMAC verification, while genuine HMAC failures
// (thrown 401 Response) are still rethrown.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { action } from "../../app/routes/webhooks.compliance";
import { authenticate } from "../../app/shopify.server";
import { prisma, resetDb } from "../helpers/db";
import { makeWebhookRequest } from "../helpers/webhook";

const SHOP_DOMAIN = "compliance-test.myshopify.com";

function complianceRequest(topic: string, webhookId: string): Request {
  return makeWebhookRequest({
    topic,
    shopDomain: SHOP_DOMAIN,
    webhookId,
    payload: { shop_id: 998877, shop_domain: SHOP_DOMAIN },
  });
}

function callAction(request: Request): Promise<Response> {
  return action({
    request,
    url: new URL(request.url),
    pattern: "/webhooks/compliance",
    params: {},
    context: {},
  });
}

/** Shop + profile + run + page result + offline/online sessions. */
async function seedShopWithData() {
  const shop = await prisma.shop.create({ data: { domain: SHOP_DOMAIN } });
  const profile = await prisma.auditProfile.create({
    data: { shopId: shop.id, name: "Default", isDefault: true },
  });
  const run = await prisma.auditRun.create({
    data: {
      shopId: shop.id,
      profileId: profile.id,
      profileSnapshot: {} as Prisma.InputJsonValue,
      trigger: "MANUAL",
      status: "COMPLETED",
      totalJobs: 1,
      completedJobs: 1,
    },
  });
  await prisma.pageResult.create({
    data: {
      runId: run.id,
      url: `https://${SHOP_DOMAIN}/`,
      pageType: "HOME",
      device: "MOBILE",
      status: "COMPLETED",
      performanceScore: 80,
    },
  });
  await prisma.session.create({
    data: {
      id: `offline_${SHOP_DOMAIN}`,
      shop: SHOP_DOMAIN,
      state: "",
      isOnline: false,
      accessToken: "test-offline-token",
    },
  });
  await prisma.session.create({
    data: {
      id: `${SHOP_DOMAIN}_12345`,
      shop: SHOP_DOMAIN,
      state: "",
      isOnline: true,
      accessToken: "test-online-token",
    },
  });
  return { shop, profile, run };
}

describe("webhooks/compliance action", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("shop/redact: 200, shop cascade-deleted, sessions deleted, WebhookEvent kept", async () => {
    await seedShopWithData();
    const webhookId = "wh-shop-redact-1";

    const response = await callAction(
      complianceRequest("shop/redact", webhookId),
    );
    expect(response.status).toBe(200);

    expect(
      await prisma.shop.findUnique({ where: { domain: SHOP_DOMAIN } }),
    ).toBeNull();
    expect(await prisma.auditProfile.count()).toBe(0);
    expect(await prisma.auditRun.count()).toBe(0);
    expect(await prisma.pageResult.count()).toBe(0);
    expect(
      await prisma.session.count({ where: { shop: SHOP_DOMAIN } }),
    ).toBe(0);

    // Idempotency row survives the cascade (Shop FK is SetNull).
    const event = await prisma.webhookEvent.findUnique({
      where: { id: webhookId },
    });
    expect(event).not.toBeNull();
    expect(event?.topic).toBe("SHOP_REDACT");
    expect(event?.shopDomain).toBe(SHOP_DOMAIN);
    expect(event?.shopId).toBeNull();
  });

  it("customers/data_request: 200, no data changes, WebhookEvent recorded", async () => {
    const { shop } = await seedShopWithData();
    const webhookId = "wh-cust-data-request-1";

    const response = await callAction(
      complianceRequest("customers/data_request", webhookId),
    );
    expect(response.status).toBe(200);

    expect(
      await prisma.shop.findUnique({ where: { domain: SHOP_DOMAIN } }),
    ).not.toBeNull();
    expect(await prisma.auditProfile.count()).toBe(1);
    expect(await prisma.auditRun.count()).toBe(1);
    expect(await prisma.pageResult.count()).toBe(1);
    expect(
      await prisma.session.count({ where: { shop: SHOP_DOMAIN } }),
    ).toBe(2);

    const event = await prisma.webhookEvent.findUnique({
      where: { id: webhookId },
    });
    expect(event?.topic).toBe("CUSTOMERS_DATA_REQUEST");
    expect(event?.shopId).toBe(shop.id);
  });

  it("customers/redact: 200, no data changes, WebhookEvent recorded", async () => {
    await seedShopWithData();
    const webhookId = "wh-cust-redact-1";

    const response = await callAction(
      complianceRequest("customers/redact", webhookId),
    );
    expect(response.status).toBe(200);

    expect(
      await prisma.shop.findUnique({ where: { domain: SHOP_DOMAIN } }),
    ).not.toBeNull();
    expect(await prisma.auditRun.count()).toBe(1);
    expect(
      await prisma.session.count({ where: { shop: SHOP_DOMAIN } }),
    ).toBe(2);

    const event = await prisma.webhookEvent.findUnique({
      where: { id: webhookId },
    });
    expect(event?.topic).toBe("CUSTOMERS_REDACT");
  });

  it("duplicate webhookId: still a single WebhookEvent row", async () => {
    await seedShopWithData();
    const webhookId = "wh-cust-dup-1";

    const first = await callAction(
      complianceRequest("customers/data_request", webhookId),
    );
    expect(first.status).toBe(200);
    const second = await callAction(
      complianceRequest("customers/data_request", webhookId),
    );
    expect(second.status).toBe(200);

    const events = await prisma.webhookEvent.findMany({
      where: { id: webhookId },
    });
    expect(events).toHaveLength(1);
  });

  it("shop/redact still redacts when the library token refresh fails (manual fallback)", async () => {
    await seedShopWithData();
    // authenticate.webhook throws a 500 Response when the offline-token
    // refresh fails — the shop uninstalled 48h ago, so this is the norm for
    // shop/redact. The resilient helper must fall back to manual HMAC checks.
    const spy = vi
      .spyOn(authenticate, "webhook")
      .mockRejectedValue(
        new Response(undefined, {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
    try {
      const webhookId = "wh-shop-redact-fallback-1";

      const response = await callAction(
        complianceRequest("shop/redact", webhookId),
      );
      expect(response.status).toBe(200);

      expect(
        await prisma.shop.findUnique({ where: { domain: SHOP_DOMAIN } }),
      ).toBeNull();
      expect(
        await prisma.session.count({ where: { shop: SHOP_DOMAIN } }),
      ).toBe(0);

      const event = await prisma.webhookEvent.findUnique({
        where: { id: webhookId },
      });
      // The fallback maps the raw "shop/redact" header to SCREAMING_SNAKE.
      expect(event?.topic).toBe("SHOP_REDACT");
    } finally {
      spy.mockRestore();
    }
  });

  it("tampered HMAC: the library's thrown 401 Response is rethrown, nothing recorded", async () => {
    await seedShopWithData();

    const valid = complianceRequest("shop/redact", "wh-redact-bad-hmac");
    const validHmac = valid.headers.get("X-Shopify-Hmac-Sha256") ?? "";
    const tamperedHmac =
      (validHmac.startsWith("A") ? "B" : "A") + validHmac.slice(1);
    const headers = new Headers(valid.headers);
    headers.set("X-Shopify-Hmac-Sha256", tamperedHmac);
    const tampered = new Request(valid.url, {
      method: "POST",
      headers,
      body: await valid.text(),
    });

    let thrown: unknown;
    try {
      await callAction(tampered);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);

    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(
      await prisma.shop.findUnique({ where: { domain: SHOP_DOMAIN } }),
    ).not.toBeNull();
  });
});
