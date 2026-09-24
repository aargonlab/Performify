// ---------------------------------------------------------------------------
// Integration: webhooks.app.uninstalled action against real Postgres + Redis
// (the route removes the profiles' BullMQ job schedulers via the control
// queue). Sessions are deleted, the Shop row is soft-marked uninstalled, and
// a duplicate delivery is idempotent. The route authenticates via
// authenticateWebhookResilient: when the library's post-validation offline
// token refresh fails (always the case for an uninstalled shop), it falls
// back to manual HMAC verification instead of 500ing forever.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { action } from "../../app/routes/webhooks.app.uninstalled";
import { authenticate } from "../../app/shopify.server";
import { getControlQueue } from "../../app/queues/queues.server";
import { getRedisConnection } from "../../app/queues/connection.server";
import { prisma, resetDb } from "../helpers/db";
import { makeWebhookRequest } from "../helpers/webhook";

const SHOP_DOMAIN = "uninstalled-test.myshopify.com";

function uninstalledRequest(webhookId: string): Request {
  return makeWebhookRequest({
    topic: "app/uninstalled",
    shopDomain: SHOP_DOMAIN,
    webhookId,
    payload: { id: 998877, name: "Test shop", domain: SHOP_DOMAIN },
  });
}

function callAction(request: Request): Promise<Response> {
  return action({
    request,
    url: new URL(request.url),
    pattern: "/webhooks/app/uninstalled",
    params: {},
    context: {},
  });
}

describe("webhooks/app/uninstalled action", () => {
  beforeEach(async () => {
    await resetDb();
    const shop = await prisma.shop.create({ data: { domain: SHOP_DOMAIN } });
    await prisma.auditProfile.create({
      data: { shopId: shop.id, name: "Default", isDefault: true },
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
  });

  afterAll(async () => {
    await getControlQueue().close();
    await getRedisConnection().quit();
    await prisma.$disconnect();
  });

  it("valid delivery: 200, sessions deleted, uninstalledAt set, event recorded", async () => {
    const webhookId = "wh-uninstall-1";

    const response = await callAction(uninstalledRequest(webhookId));
    expect(response.status).toBe(200);

    expect(
      await prisma.session.count({ where: { shop: SHOP_DOMAIN } }),
    ).toBe(0);

    const shop = await prisma.shop.findUniqueOrThrow({
      where: { domain: SHOP_DOMAIN },
    });
    expect(shop.uninstalledAt).not.toBeNull();

    // Profile data is kept (soft uninstall), only sessions go away.
    expect(await prisma.auditProfile.count()).toBe(1);

    const event = await prisma.webhookEvent.findUnique({
      where: { id: webhookId },
    });
    expect(event).not.toBeNull();
    expect(event?.topic).toBe("APP_UNINSTALLED");
    expect(event?.shopDomain).toBe(SHOP_DOMAIN);
  });

  it("duplicate delivery: second call is a 200 no-op and state stays consistent", async () => {
    const webhookId = "wh-uninstall-dup-1";

    const first = await callAction(uninstalledRequest(webhookId));
    expect(first.status).toBe(200);

    const afterFirst = await prisma.shop.findUniqueOrThrow({
      where: { domain: SHOP_DOMAIN },
    });
    expect(afterFirst.uninstalledAt).not.toBeNull();

    const second = await callAction(uninstalledRequest(webhookId));
    expect(second.status).toBe(200);

    const events = await prisma.webhookEvent.findMany({
      where: { id: webhookId },
    });
    expect(events).toHaveLength(1);

    const afterSecond = await prisma.shop.findUniqueOrThrow({
      where: { domain: SHOP_DOMAIN },
    });
    // The dedupe path returns before markShopUninstalled runs again.
    expect(afterSecond.uninstalledAt).toEqual(afterFirst.uninstalledAt);
    expect(
      await prisma.session.count({ where: { shop: SHOP_DOMAIN } }),
    ).toBe(0);
  });

  it("library token-refresh failure: manual HMAC fallback still processes the webhook", async () => {
    // authenticate.webhook (expiringOfflineAccessTokens) throws a 500
    // Response when the offline-token refresh fails — guaranteed for an
    // uninstalled shop. The resilient helper must fall back to manual HMAC
    // verification and still process the delivery.
    const spy = vi
      .spyOn(authenticate, "webhook")
      .mockRejectedValue(
        new Response(undefined, {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
    try {
      const webhookId = "wh-uninstall-fallback-1";

      const response = await callAction(uninstalledRequest(webhookId));
      expect(response.status).toBe(200);

      expect(
        await prisma.session.count({ where: { shop: SHOP_DOMAIN } }),
      ).toBe(0);

      const shop = await prisma.shop.findUniqueOrThrow({
        where: { domain: SHOP_DOMAIN },
      });
      expect(shop.uninstalledAt).not.toBeNull();

      const event = await prisma.webhookEvent.findUnique({
        where: { id: webhookId },
      });
      // The fallback maps the raw "app/uninstalled" header to SCREAMING_SNAKE.
      expect(event?.topic).toBe("APP_UNINSTALLED");
      expect(event?.shopDomain).toBe(SHOP_DOMAIN);
    } finally {
      spy.mockRestore();
    }
  });

  it("manual fallback still rejects a tampered HMAC with a thrown 401 Response", async () => {
    const spy = vi
      .spyOn(authenticate, "webhook")
      .mockRejectedValue(
        new Response(undefined, {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
    try {
      const valid = uninstalledRequest("wh-uninstall-bad-hmac");
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

      // Nothing was recorded or mutated.
      expect(await prisma.webhookEvent.count()).toBe(0);
      const shop = await prisma.shop.findUniqueOrThrow({
        where: { domain: SHOP_DOMAIN },
      });
      expect(shop.uninstalledAt).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
