// ---------------------------------------------------------------------------
// Audit engine factory — the only place that knows concrete engines.
//
// Registering a future engine (e.g. LighthouseLocalEngine, self-hosted
// Chromium for password-protected theme previews):
//   1. Implement AuditEngine in app/lib/audit/lighthouse-local-engine.server.ts.
//   2. Add a `case "lighthouse-local":` below returning the new instance.
// Workers and services depend only on the AuditEngine interface, so nothing
// else changes.
// ---------------------------------------------------------------------------

import { PsiEngine } from "./psi-engine.server";
import type { AuditEngine } from "./types";

export function getAuditEngine(
  engineName = "psi",
  opts: { apiKey?: string } = {},
): AuditEngine {
  switch (engineName) {
    case "psi":
      return new PsiEngine(opts);
    default:
      throw new Error(
        `Unknown audit engine "${engineName}". Available engines: "psi" ` +
          `("lighthouse-local" is planned but not implemented yet).`,
      );
  }
}
