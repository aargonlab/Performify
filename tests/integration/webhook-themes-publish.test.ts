// ---------------------------------------------------------------------------
// Integration: webhooks.themes.publish action against real Postgres + Redis.
// Covers HMAC-authenticated delivery → control queue job + WebhookEvent
// bookkeeping row (the route enqueues BEFORE writing the row; the queue's
// jobId dedupe is what prevents double processing), duplicate delivery
// dedupe, re-enqueue when the job was lost, and tampered-HMAC rejection (the
// library THROWS a 401 Response — see node_modules
// @shopify/shopify-app-react-router .../webhooks/authenticate.mjs).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { action } from "../../app/routes/webhooks.themes.publish";
import { getControlQueue } from "../../app/queues/queues.server";
import { getRedisConnection } from "../../app/queues/connection.server";
import { prisma, resetDb } from "../helpers/db";
import { makeWebhookRequest } from "../helpers/webhook";

const SHOP_DOMAIN = "themes-publish-test.myshopify.com";
const THEME_PAYLOAD = { id: 123456, name: "Dawn v12", role: "main" };

function themesPublishRequest(webhookId: string): Request {
  return makeWebhookRequest({
    topic: "themes/publish",
    shopDomain: SHOP_DOMAIN,
    webhookId,
    payload: THEME_PAYLOAD,
  });
}

function callAction(request: Request): Promise<Response> {
  return action({
    request,
    url: new URL(request.url),
    pattern: "/webhooks/themes/publish",
    params: {},
    context: {},
  });
}

describe("webhooks/themes/publish action", () => {
  beforeEach(async () => {
    await getControlQueue().obliterate({ force: true });
    await resetDb();
    await prisma.shop.create({ data: { domain: SHOP_DOMAIN } });
  });

  afterAll(async () => {
    await getControlQueue().close();
    await getRedisConnection().quit();
    await prisma.$disconnect();
  });

  it("valid delivery: 200, WebhookEvent row, theme-publish-run job enqueued", async () => {
    const webhookId = "wh-theme-valid-1";

    const response = await callAction(themesPublishRequest(webhookId));

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);

    const event = await prisma.webhookEvent.findUnique({
      where: { id: webhookId },
    });
    expect(event).not.toBeNull();
    expect(event?.topic).toBe("THEMES_PUBLISH");
    expect(event?.shopDomain).toBe(SHOP_DOMAIN);

    const shop = await prisma.shop.findUniqueOrThrow({
      where: { domain: SHOP_DOMAIN },
    });
    expect(event?.shopId).toBe(shop.id);

    const job = await getControlQueue().getJob(`theme-${webhookId}`);
    expect(job).toBeTruthy();
    expect(job?.name).toBe("theme-publish-run");
    expect(job?.data).toEqual({
      kind: "theme-publish-run",
      shopDomain: SHOP_DOMAIN,
      themeId: "123456",
      themeName: "Dawn v12",
    });
  });

  it("duplicate webhookId: 200 again, still one job (jobId dedupe) and one WebhookEvent row", async () => {
    const webhookId = "wh-theme-dup-1";

    const first = await callAction(themesPublishRequest(webhookId));
    expect(first.status).toBe(200);

    // The duplicate delivery re-runs the add — BullMQ ignores it because a
    // job with the same jobId already exists.
    const second = await callAction(themesPublishRequest(webhookId));
    expect(second.status).toBe(200);

    const events = await prisma.webhookEvent.findMany({
      where: { id: webhookId },
    });
    expect(events).toHaveLength(1);

    const queue = getControlQueue();
    const job = await queue.getJob(`theme-${webhookId}`);
    expect(job).toBeTruthy();
    const counts = await queue.getJobCounts(
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    );
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(1);
  });

  it("duplicate delivery re-enqueues a lost job (enqueue happens before the dedupe row)", async () => {
    const webhookId = "wh-theme-lost-job-1";

    const first = await callAction(themesPublishRequest(webhookId));
    expect(first.status).toBe(200);

    // Simulate the job being lost after the bookkeeping row was written
    // (previously a crash between the two permanently dropped the event).
    const queue = getControlQueue();
    const job = await queue.getJob(`theme-${webhookId}`);
    await job?.remove();
    expect(await queue.getJob(`theme-${webhookId}`)).toBeFalsy();

    const second = await callAction(themesPublishRequest(webhookId));
    expect(second.status).toBe(200);

    const requeued = await queue.getJob(`theme-${webhookId}`);
    expect(requeued).toBeTruthy();
    expect(requeued?.name).toBe("theme-publish-run");

    // Still a single bookkeeping row.
    const events = await prisma.webhookEvent.findMany({
      where: { id: webhookId },
    });
    expect(events).toHaveLength(1);
  });

  it("tampered HMAC: authenticate.webhook throws a Response with status 401", async () => {
    const valid = themesPublishRequest("wh-theme-bad-hmac");
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

    // Nothing was recorded or enqueued.
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await getControlQueue().getJob("theme-wh-theme-bad-hmac")).toBeFalsy();
  });
});
