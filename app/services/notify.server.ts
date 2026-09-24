// ---------------------------------------------------------------------------
// Alert notifications: email (SMTP via nodemailer) + outgoing webhook.
// Channels are independent; a failure in one never blocks the other and this
// module never throws — the caller records per-channel flags on the alerts.
// ---------------------------------------------------------------------------

import nodemailer from "nodemailer";
import { env } from "../lib/env.server";
import type { AlertCandidate } from "../lib/alerts/evaluate";
import type { NotificationsConfig } from "../lib/types";

export interface SendAlertNotificationsArgs {
  shopDomain: string;
  runId: string;
  alerts: AlertCandidate[];
  notifications: NotificationsConfig;
}

export async function sendAlertNotifications(
  args: SendAlertNotificationsArgs,
): Promise<{ emailSent: boolean; webhookSent: boolean }> {
  const { shopDomain, runId, alerts, notifications } = args;
  if (alerts.length === 0) {
    return { emailSent: false, webhookSent: false };
  }

  const [emailSent, webhookSent] = await Promise.all([
    sendEmail(shopDomain, runId, alerts, notifications),
    sendWebhook(shopDomain, runId, alerts, notifications),
  ]);
  return { emailSent, webhookSent };
}

async function sendEmail(
  shopDomain: string,
  runId: string,
  alerts: AlertCandidate[],
  notifications: NotificationsConfig,
): Promise<boolean> {
  const smtpUrl = env.smtpUrl();
  if (!smtpUrl || notifications.emails.length === 0) {
    return false;
  }

  try {
    const transporter = nodemailer.createTransport(smtpUrl);
    await transporter.sendMail({
      from: env.alertFromEmail(),
      to: notifications.emails.join(", "),
      subject: `[Performify] ${alerts.length} performance alert(s) for ${shopDomain}`,
      text: buildEmailBody(shopDomain, runId, alerts),
    });
    return true;
  } catch (error) {
    console.error(
      `[notify] alert email failed for ${shopDomain} run ${runId}:`,
      error,
    );
    return false;
  }
}

function buildEmailBody(
  shopDomain: string,
  runId: string,
  alerts: AlertCandidate[],
): string {
  const lines = [
    `Performify detected ${alerts.length} performance alert(s) on ${shopDomain}.`,
    "",
  ];
  for (const alert of alerts) {
    const scope = [
      alert.url,
      alert.device ? alert.device.toLowerCase() : null,
      alert.marketHandle ? `market ${alert.marketHandle}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      `- [${alert.severity.toUpperCase()}] ${alert.metric}: ` +
        `threshold ${alert.operator === "lt" ? "<" : ">"} ${alert.threshold}, ` +
        `actual ${alert.actual}` +
        (scope ? ` — ${scope}` : ""),
    );
  }
  lines.push("", `Full report: ${appUrlBase()}/app/runs/${runId}`);
  return lines.join("\n");
}

async function sendWebhook(
  shopDomain: string,
  runId: string,
  alerts: AlertCandidate[],
  notifications: NotificationsConfig,
): Promise<boolean> {
  const webhookUrl = notifications.webhookUrl;
  if (!webhookUrl) {
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shop: shopDomain,
        runId,
        generatedAt: new Date().toISOString(),
        alerts,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(
        `[notify] alert webhook for ${shopDomain} run ${runId} returned ${response.status}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      `[notify] alert webhook failed for ${shopDomain} run ${runId}:`,
      error,
    );
    return false;
  }
}

function appUrlBase(): string {
  return env.appUrl().replace(/\/+$/, "");
}
