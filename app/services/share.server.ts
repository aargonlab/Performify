// ---------------------------------------------------------------------------
// Shareable report links: unguessable tokens resolving to a public, read-only
// view of a run (/share/:token). Links expire and can be revoked.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import prisma from "../db.server";
import { env } from "../lib/env.server";

/** Create a share link for a run; the token is a 192-bit random URL-safe id. */
export async function createShareLink(
  runId: string,
  expiresInDays = 90,
): Promise<{ token: string; url: string }> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 3600 * 1000);

  await prisma.shareLink.create({
    data: { token, runId, expiresAt },
  });

  const base = env.appUrl().replace(/\/+$/, "");
  return { token, url: `${base}/share/${token}` };
}

/**
 * Resolve a share token to its run (with page results and alerts).
 * Returns null when the token is unknown, revoked or expired, or when the
 * run has not finished (only COMPLETED/PARTIAL runs are shareable).
 */
export async function getRunByShareToken(token: string) {
  if (!token) return null;

  const link = await prisma.shareLink.findFirst({
    where: {
      token,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      run: { status: { in: ["COMPLETED", "PARTIAL"] } },
    },
    include: {
      run: {
        include: {
          pageResults: true,
          alerts: true,
        },
      },
    },
  });

  return link?.run ?? null;
}

export async function revokeShareLink(id: string) {
  return prisma.shareLink.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}
