// Central place for non-Shopify environment configuration.
// Shopify vars (SHOPIFY_API_KEY/SECRET/APP_URL, SCOPES) are consumed by
// app/shopify.server.ts via the framework.

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  databaseUrl: () => process.env.DATABASE_URL ?? "",
  redisUrl: () => process.env.REDIS_URL ?? "redis://localhost:6379",

  /** Google API key for PageSpeed Insights (extended quota). */
  psiApiKey: () => process.env.PSI_API_KEY ?? "",
  /** Stay under Google's default ~25k/day; leave headroom for manual runs. */
  psiDailyQuota: () => int("PSI_DAILY_QUOTA", 20_000),
  /** Requests/minute across the worker; Google default is ~240/min. */
  psiPerMinuteLimit: () => int("PSI_PER_MINUTE_LIMIT", 100),
  /** Concurrent PSI calls (each can take up to 120s). */
  auditConcurrency: () => int("AUDIT_CONCURRENCY", 4),

  /** SMTP URL for alert emails (smtp://user:pass@host:587). Empty = log only. */
  smtpUrl: () => process.env.ALERT_SMTP_URL ?? "",
  alertFromEmail: () =>
    process.env.ALERT_FROM_EMAIL ?? "alerts@performify.local",

  appUrl: () => process.env.SHOPIFY_APP_URL ?? "",
};
