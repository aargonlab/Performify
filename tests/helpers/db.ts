// ---------------------------------------------------------------------------
// Shared DB helpers for integration tests: the app's Prisma client plus a
// resetDb() that truncates every app table (schema is managed by migrations;
// tests must never drop/recreate it).
// ---------------------------------------------------------------------------

import prisma from "../../app/db.server";

export { prisma };

// Table names follow Prisma default naming (no @@map in prisma/schema.prisma):
// they match the model names exactly.
const APP_TABLES = [
  "Alert",
  "RawReport",
  "PageResult",
  "ShareLink",
  "AuditRun",
  "AuditProfile",
  "WebhookEvent",
  "Session",
  "Shop",
] as const;

/** Empties all app tables. CASCADE covers FK order; identity is irrelevant (cuid PKs). */
export async function resetDb(): Promise<void> {
  // Hard guard: truncating is destructive — refuse anything that does not
  // look like a dedicated test database (performify_test, *_test).
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(
    "/",
    "",
  );
  if (!/_test$/.test(dbName)) {
    throw new Error(
      `resetDb() refused: DATABASE_URL points at "${dbName}", not a *_test database`,
    );
  }
  const tables = APP_TABLES.map((name) => `"${name}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} CASCADE`);
}
