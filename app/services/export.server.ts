// ---------------------------------------------------------------------------
// Run exports: CSV (flat page results), JSON (run meta + aggregates +
// narrative + summaries) and PDF (printable report built with pdfkit).
// ---------------------------------------------------------------------------

import PDFDocument from "pdfkit";
import { getRunWithResults } from "./reports.server";
import { toPageResultSummary } from "./mappers.server";
import { computeAggregates } from "../lib/report/compare";
import { toCsv } from "../lib/csv";
import type { RunNarrative } from "../lib/types";
import type {
  CategoryAverages,
  PageResultSummary,
  RunAggregates,
} from "../lib/report/types";

export type ExportFormat = "csv" | "json" | "pdf";

export interface ExportedRun {
  content: Buffer | string;
  contentType: string;
  filename: string;
}

const CSV_COLUMNS = [
  { key: "url", header: "url" },
  { key: "market", header: "market" },
  { key: "locale", header: "locale" },
  { key: "pageType", header: "pageType" },
  { key: "device", header: "device" },
  { key: "status", header: "status" },
  { key: "performance", header: "performance" },
  { key: "accessibility", header: "accessibility" },
  { key: "bestPractices", header: "bestPractices" },
  { key: "seo", header: "seo" },
  { key: "lcpMs", header: "lcpMs" },
  { key: "cls", header: "cls" },
  { key: "tbtMs", header: "tbtMs" },
  { key: "fcpMs", header: "fcpMs" },
  { key: "speedIndexMs", header: "speedIndexMs" },
  { key: "ttfbMs", header: "ttfbMs" },
  { key: "fieldLcpMs", header: "fieldLcpMs" },
  { key: "fieldInpMs", header: "fieldInpMs" },
  { key: "fieldCls", header: "fieldCls" },
  { key: "lighthouseVersion", header: "lighthouseVersion" },
];

export async function exportRun(
  shopId: string,
  runId: string,
  format: ExportFormat,
): Promise<ExportedRun> {
  const run = await getRunWithResults(shopId, runId);
  if (!run) {
    throw new Response("Run not found", { status: 404 });
  }

  const shortId = run.id.slice(0, 8);
  const filename = `performify-run-${shortId}-${formatYyyyMmDd(run.createdAt)}.${format}`;

  if (format === "csv") {
    const rows = run.pageResults.map((r) => ({
      url: r.url,
      market: r.marketHandle,
      locale: r.locale,
      pageType: r.pageType,
      device: r.device,
      status: r.status,
      performance: r.performanceScore,
      accessibility: r.accessibilityScore,
      bestPractices: r.bestPracticesScore,
      seo: r.seoScore,
      lcpMs: r.lcpMs,
      cls: r.cls,
      tbtMs: r.tbtMs,
      fcpMs: r.fcpMs,
      speedIndexMs: r.speedIndexMs,
      ttfbMs: r.ttfbMs,
      fieldLcpMs: r.fieldLcpMs,
      fieldInpMs: r.fieldInpMs,
      fieldCls: r.fieldCls,
      lighthouseVersion: r.lighthouseVersion,
    }));
    return {
      content: toCsv(rows, CSV_COLUMNS),
      contentType: "text/csv; charset=utf-8",
      filename,
    };
  }

  const summaries = run.pageResults.map(toPageResultSummary);
  const aggregates = computeAggregates(summaries);
  const narrative = (run.narrative as RunNarrative | null) ?? null;

  if (format === "json") {
    const payload = {
      run: {
        id: run.id,
        trigger: run.trigger,
        themeId: run.themeId,
        themeName: run.themeName,
        status: run.status,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt ? run.startedAt.toISOString() : null,
        completedAt: run.completedAt ? run.completedAt.toISOString() : null,
        profileSnapshot: run.profileSnapshot,
      },
      aggregates,
      narrative,
      pageResults: summaries,
    };
    return {
      content: JSON.stringify(payload, null, 2),
      contentType: "application/json",
      filename,
    };
  }

  const pdf = await buildPdf(
    {
      createdAt: run.createdAt,
      trigger: run.trigger,
      themeName: run.themeName,
      status: run.status,
    },
    summaries,
    aggregates,
    narrative,
  );
  return { content: pdf, contentType: "application/pdf", filename };
}

// --- PDF ---------------------------------------------------------------------

interface PdfRunMeta {
  createdAt: Date;
  trigger: string;
  themeName: string | null;
  status: string;
}

const PAGE_BREAK_Y = 720;

/** Results table columns: fixed x positions (A4, 40pt margins). */
const TABLE_COLUMNS: { header: string; x: number; width: number }[] = [
  { header: "URL", x: 40, width: 148 },
  { header: "Market", x: 192, width: 46 },
  { header: "Device", x: 242, width: 40 },
  { header: "Type", x: 286, width: 46 },
  { header: "Perf", x: 336, width: 26 },
  { header: "A11y", x: 366, width: 26 },
  { header: "BP", x: 396, width: 26 },
  { header: "SEO", x: 426, width: 26 },
  { header: "LCP", x: 456, width: 32 },
  { header: "CLS", x: 492, width: 28 },
  { header: "TBT", x: 524, width: 31 },
];

async function buildPdf(
  meta: PdfRunMeta,
  results: PageResultSummary[],
  aggregates: RunAggregates,
  narrative: RunNarrative | null,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: false });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Title block (shop-agnostic — share/export must not leak the shop domain).
  doc.font("Helvetica-Bold").fontSize(22).text("Performance audit report");
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(11);
  doc.text(`Run date: ${meta.createdAt.toISOString().slice(0, 10)}`);
  doc.text(`Trigger: ${triggerLabel(meta.trigger)}`);
  if (meta.themeName) {
    doc.text(`Theme: ${meta.themeName}`);
  }
  doc.text(`Status: ${meta.status}`);
  doc.moveDown(1);

  // Summary averages.
  sectionHeading(doc, "Summary");
  drawSummaryTable(doc, aggregates.overall, results.length);
  doc.moveDown(1);

  // Narrative.
  if (narrative) {
    ensureRoom(doc, 80);
    sectionHeading(doc, "Report");
    doc.font("Helvetica").fontSize(10).text(narrative.summary, { width: 515 });
    doc.moveDown(0.5);

    for (const section of narrative.sections) {
      ensureRoom(doc, 60);
      doc.font("Helvetica-Bold").fontSize(12).text(section.heading);
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(10).text(section.body, { width: 515 });
      doc.moveDown(0.5);
    }

    if (narrative.recommendations.length > 0) {
      ensureRoom(doc, 80);
      sectionHeading(doc, "Recommendations");
      narrative.recommendations.forEach((rec, index) => {
        ensureRoom(doc, 50);
        const savings =
          rec.estimatedSavingsMs > 0
            ? ` (est. savings ${formatMs(rec.estimatedSavingsMs)})`
            : "";
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(`${index + 1}. ${rec.title}${savings}`, { width: 515 });
        doc
          .font("Helvetica")
          .fontSize(10)
          .text(rec.explanation, { width: 515, indent: 12 });
        doc.moveDown(0.4);
      });
    }
    doc.moveDown(0.5);
  }

  // Results table.
  ensureRoom(doc, 100);
  sectionHeading(doc, "Detailed results");
  let y = doc.y + 4;
  y = drawTableHeader(doc, y);
  doc.font("Helvetica").fontSize(8);
  for (const result of results) {
    if (y > PAGE_BREAK_Y) {
      doc.addPage();
      y = drawTableHeader(doc, 40);
      doc.font("Helvetica").fontSize(8);
    }
    drawTableRow(doc, y, result);
    y += 12;
  }

  // Footer.
  doc.y = y + 20;
  if (doc.y > PAGE_BREAK_Y) doc.addPage();
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#666666")
    .text("Generated by Performify", 40, doc.y);
  doc.fillColor("#000000");

  doc.end();
  return done;
}

function sectionHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.font("Helvetica-Bold").fontSize(14).text(text, 40, doc.y);
  doc.moveDown(0.3);
}

function ensureRoom(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > PAGE_BREAK_Y + 60) {
    doc.addPage();
  }
}

function drawSummaryTable(
  doc: PDFKit.PDFDocument,
  overall: CategoryAverages,
  totalResults: number,
): void {
  const rows: [string, string][] = [
    ["Pages audited", `${overall.count} of ${totalResults} completed`],
    ["Performance", formatScore(overall.performanceScore)],
    ["Accessibility", formatScore(overall.accessibilityScore)],
    ["Best practices", formatScore(overall.bestPracticesScore)],
    ["SEO", formatScore(overall.seoScore)],
    ["LCP (lab)", overall.lcpMs === null ? "-" : formatMs(overall.lcpMs)],
    ["CLS (lab)", overall.cls === null ? "-" : overall.cls.toFixed(3)],
    ["TBT (lab)", overall.tbtMs === null ? "-" : formatMs(overall.tbtMs)],
    [
      "LCP (field, p75)",
      overall.fieldLcpMs === null ? "-" : formatMs(overall.fieldLcpMs),
    ],
    [
      "INP (field, p75)",
      overall.fieldInpMs === null ? "-" : formatMs(overall.fieldInpMs),
    ],
    [
      "CLS (field, p75)",
      overall.fieldCls === null ? "-" : overall.fieldCls.toFixed(3),
    ],
  ];

  let y = doc.y + 2;
  for (const [label, value] of rows) {
    if (y > PAGE_BREAK_Y) {
      doc.addPage();
      y = 40;
    }
    doc.font("Helvetica").fontSize(10).text(label, 40, y, { width: 200 });
    doc.font("Helvetica-Bold").fontSize(10).text(value, 250, y, { width: 200 });
    y += 16;
  }
  doc.y = y;
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  doc.font("Helvetica-Bold").fontSize(8);
  for (const column of TABLE_COLUMNS) {
    doc.text(column.header, column.x, y, {
      width: column.width,
      lineBreak: false,
    });
  }
  doc
    .moveTo(40, y + 11)
    .lineTo(555, y + 11)
    .lineWidth(0.5)
    .strokeColor("#999999")
    .stroke();
  return y + 15;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  y: number,
  result: PageResultSummary,
): void {
  const failed = result.status !== "COMPLETED";
  const cells: string[] = [
    result.url.replace(/^https?:\/\//, ""),
    result.marketHandle ?? "-",
    result.device === "MOBILE" ? "Mobile" : "Desktop",
    result.pageType,
  ];
  if (!failed) {
    cells.push(
      formatScore(result.performanceScore),
      formatScore(result.accessibilityScore),
      formatScore(result.bestPracticesScore),
      formatScore(result.seoScore),
      result.lcpMs === null ? "-" : String(Math.round(result.lcpMs)),
      result.cls === null ? "-" : result.cls.toFixed(3),
      result.tbtMs === null ? "-" : String(Math.round(result.tbtMs)),
    );
  }
  for (let i = 0; i < cells.length; i += 1) {
    const column = TABLE_COLUMNS[i];
    doc.text(fitText(doc, cells[i], column.width - 3), column.x, y, {
      width: column.width,
      lineBreak: false,
    });
  }
  if (failed) {
    // Span the metric columns with the failure status instead of empty cells.
    doc.text(result.status, TABLE_COLUMNS[4].x, y, {
      width: 555 - TABLE_COLUMNS[4].x,
      lineBreak: false,
    });
  }
}

/** Truncate `text` (with ellipsis) so it fits `width` at the current font. */
function fitText(doc: PDFKit.PDFDocument, text: string, width: number): string {
  if (doc.widthOfString(text) <= width) return text;
  let truncated = text;
  while (
    truncated.length > 1 &&
    doc.widthOfString(`${truncated}…`) > width
  ) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

// --- Formatting ----------------------------------------------------------------

function triggerLabel(trigger: string): string {
  switch (trigger) {
    case "MANUAL":
      return "Manual";
    case "SCHEDULED":
      return "Scheduled";
    case "THEME_PUBLISH":
      return "Theme publish";
    default:
      return trigger;
  }
}

function formatScore(value: number | null): string {
  return value === null ? "-" : String(Math.round(value));
}

function formatMs(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${Math.round(value)} ms`;
}

function formatYyyyMmDd(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}
