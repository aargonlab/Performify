// Resource route: downloads a run export (csv/json/pdf).
// No default export — this route only streams the file.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shops.server";
import { exportRun, type ExportFormat } from "../services/export.server";

const FORMATS: ExportFormat[] = ["csv", "json", "pdf"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const runId = params.runId;
  const format = params.format as ExportFormat | undefined;
  if (!runId) {
    throw new Response("Missing run id", { status: 400 });
  }
  if (!format || !FORMATS.includes(format)) {
    throw new Response("Unsupported export format", { status: 400 });
  }

  const { content, contentType, filename } = await exportRun(
    shop.id,
    runId,
    format,
  );

  return new Response(
    typeof content === "string" ? content : new Uint8Array(content),
    {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    },
  );
};
