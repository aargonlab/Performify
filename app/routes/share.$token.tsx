// Public, read-only report page for share links (/share/:token).
// Standalone by design: no authentication, no App Bridge, no Polaris CDN —
// plain semantic HTML with a small inline stylesheet.

import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
} from "react-router";
import { getRunByShareToken } from "../services/share.server";
import { toPageResultSummary } from "../services/mappers.server";
import { computeAggregates } from "../lib/report/compare";
import type { RunNarrative } from "../lib/types";
import type { PageResultSummary } from "../lib/report/types";

export const meta: MetaFunction = () => [
  { title: "Performance audit report — Performify" },
  { name: "robots", content: "noindex, nofollow" },
];

export const headers = () => ({ "X-Robots-Tag": "noindex, nofollow" });

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const run = await getRunByShareToken(params.token ?? "");
  if (!run) {
    throw new Response("Link expired or invalid", { status: 404 });
  }

  const results = run.pageResults.map(toPageResultSummary);
  return {
    run: {
      createdAt: run.createdAt.toISOString(),
      trigger: run.trigger,
      themeName: run.themeName,
      status: run.status,
    },
    aggregates: computeAggregates(results),
    narrative: (run.narrative as RunNarrative | null) ?? null,
    results,
  };
};

const STYLES = `
  .pf-report { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 960px;
    margin: 0 auto; padding: 32px 20px 48px; line-height: 1.5;
    overflow-wrap: break-word; }
  .pf-report h1 { font-size: 28px; margin: 4px 0 8px; }
  .pf-report h2 { font-size: 20px; margin: 32px 0 12px; }
  .pf-report h3 { font-size: 16px; margin: 20px 0 6px; }
  .pf-brand { color: #6b7177; font-size: 13px; text-transform: uppercase;
    letter-spacing: 0.08em; margin: 0; }
  .pf-meta { color: #4a4f54; font-size: 14px; margin: 0 0 8px; }
  .pf-status { display: inline-block; padding: 2px 10px; border-radius: 10px;
    font-size: 12px; background: #e5e7e9; }
  .pf-cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
  .pf-card { flex: 1 1 150px; border: 1px solid #d9dcde; border-radius: 10px;
    padding: 14px 16px; }
  .pf-card .pf-card-label { font-size: 13px; color: #4a4f54; margin: 0; }
  .pf-card .pf-card-value { font-size: 30px; font-weight: 700; margin: 2px 0 0; }
  .pf-good { color: #1a7f37; }
  .pf-avg { color: #a05a00; }
  .pf-poor { color: #c1121f; }
  .pf-muted { color: #6b7177; }
  .pf-report table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .pf-report caption { caption-side: top; text-align: left; font-weight: 600;
    font-size: 15px; padding: 0 0 8px; }
  .pf-report th, .pf-report td { text-align: left; padding: 6px 10px;
    border-bottom: 1px solid #e5e7e9; white-space: nowrap; }
  .pf-report th { color: #4a4f54; font-weight: 600; background: #f6f7f8; }
  .pf-table-wrap { overflow-x: auto; max-width: 100%; margin-bottom: 8px; }
  .pf-url { display: block; max-width: 320px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .pf-summary { font-size: 15px; }
  .pf-recs { padding-left: 20px; }
  .pf-recs li { margin-bottom: 10px; }
  .pf-savings { color: #4a4f54; font-size: 13px; }
  .pf-footer { margin-top: 40px; border-top: 1px solid #e5e7e9;
    padding-top: 12px; color: #6b7177; font-size: 13px; }
  .pf-error { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    Helvetica, Arial, sans-serif; max-width: 560px; margin: 15vh auto 0;
    padding: 0 20px; text-align: center; color: #1a1a1a; }
  .pf-error h1 { font-size: 24px; }
  .pf-error p { color: #4a4f54; }
  @media print {
    .pf-table-wrap { overflow-x: visible; }
    .pf-report th, .pf-report td { white-space: normal; }
    .pf-report table { font-size: 11px; }
    .pf-url { word-break: break-all; white-space: normal; }
    .pf-report tr, .pf-card { break-inside: avoid; }
  }
`;

export default function SharedReport() {
  const { run, aggregates, narrative, results } =
    useLoaderData<typeof loader>();
  const overall = aggregates.overall;
  const runDate = run.createdAt.slice(0, 10);

  return (
    <div className="pf-report">
      <style>{STYLES}</style>

      <header>
        <p className="pf-brand">Performify</p>
        <h1>Performance audit report</h1>
        <p className="pf-meta">
          {runDate} · {triggerLabel(run.trigger)}
          {run.themeName ? ` · Theme: ${run.themeName}` : ""} ·{" "}
          <span className="pf-status">{run.status}</span>
        </p>
      </header>

      <section aria-label="Score summary">
        <div className="pf-cards">
          <ScoreCard label="Performance" value={overall.performanceScore} />
          <ScoreCard label="Accessibility" value={overall.accessibilityScore} />
          <ScoreCard
            label="Best practices"
            value={overall.bestPracticesScore}
          />
          <ScoreCard label="SEO" value={overall.seoScore} />
        </div>
      </section>

      <section>
        <div className="pf-table-wrap">
          <table>
            <caption>Lab metrics (Lighthouse)</caption>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">LCP</th>
                <th scope="col">CLS</th>
                <th scope="col">TBT</th>
              </tr>
            </thead>
            <tbody>
              {deviceRows(aggregates.byDevice, overall).map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>{formatMs(row.averages.lcpMs)}</td>
                  <td>{formatCls(row.averages.cls)}</td>
                  <td>{formatMs(row.averages.tbtMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="pf-table-wrap">
          <table>
            <caption>Field data — real users (Chrome UX Report, 28-day p75)</caption>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">LCP</th>
                <th scope="col">INP</th>
                <th scope="col">CLS</th>
              </tr>
            </thead>
            <tbody>
              {deviceRows(aggregates.byDevice, overall).map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>{formatMs(row.averages.fieldLcpMs)}</td>
                  <td>{formatMs(row.averages.fieldInpMs)}</td>
                  <td>{formatCls(row.averages.fieldCls)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {narrative && (
        <section>
          <h2>What this report says</h2>
          <p className="pf-summary" lang={narrative.locale}>
            {narrative.summary}
          </p>
          {narrative.sections.map((section) => (
            <div key={section.heading} lang={narrative.locale}>
              <h3>{section.heading}</h3>
              <p>{section.body}</p>
            </div>
          ))}
          {narrative.recommendations.length > 0 && (
            <>
              <h3>Recommendations</h3>
              <ol className="pf-recs">
                {narrative.recommendations.map((rec) => (
                  <li key={rec.auditId}>
                    <strong>{rec.title}</strong>
                    {rec.estimatedSavingsMs > 0 && (
                      <span className="pf-savings">
                        {" "}
                        — estimated savings {formatMs(rec.estimatedSavingsMs)}
                      </span>
                    )}
                    <br />
                    {rec.explanation}
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      <section>
        <h2>Results by page</h2>
        <div className="pf-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">URL</th>
                <th scope="col">Market</th>
                <th scope="col">Device</th>
                <th scope="col">Type</th>
                <th scope="col">Perf</th>
                <th scope="col">A11y</th>
                <th scope="col">BP</th>
                <th scope="col">SEO</th>
                <th scope="col">LCP</th>
                <th scope="col">CLS</th>
                <th scope="col">TBT</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <ResultRow key={result.id} result={result} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="pf-footer">
        Generated by Performify — open source, developed by{" "}
        <a href="https://aargonlab.com" target="_blank" rel="noreferrer">
          aargonlab
        </a>
      </footer>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <div className="pf-error">
      <style>{STYLES}</style>
      <h1>{notFound ? "Link expired or invalid" : "Something went wrong"}</h1>
      <p>
        {notFound
          ? "This shared report link is no longer available. Ask the person who shared it for a new link."
          : "The report could not be loaded. Please try again later."}
      </p>
    </div>
  );
}

// --- Presentational helpers ----------------------------------------------------

function ScoreCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="pf-card">
      <p className="pf-card-label">{label}</p>
      <p className={`pf-card-value ${scoreClass(value)}`}>
        {value === null ? "–" : Math.round(value)}
      </p>
    </div>
  );
}

function ResultRow({ result }: { result: PageResultSummary }) {
  const failed = result.status !== "COMPLETED";
  return (
    <tr>
      <td title={result.url}>
        <span className="pf-url">{result.url.replace(/^https?:\/\//, "")}</span>
      </td>
      <td>{result.marketHandle ?? "–"}</td>
      <td>{result.device === "MOBILE" ? "Mobile" : "Desktop"}</td>
      <td>{result.pageType}</td>
      {failed ? (
        <td className="pf-muted" colSpan={7}>
          {result.status}
        </td>
      ) : (
        <>
          <ScoreCell value={result.performanceScore} />
          <ScoreCell value={result.accessibilityScore} />
          <ScoreCell value={result.bestPracticesScore} />
          <ScoreCell value={result.seoScore} />
          <td>{formatMs(result.lcpMs)}</td>
          <td>{formatCls(result.cls)}</td>
          <td>{formatMs(result.tbtMs)}</td>
        </>
      )}
    </tr>
  );
}

function ScoreCell({ value }: { value: number | null }) {
  return (
    <td className={scoreClass(value)}>
      {value === null ? "–" : Math.round(value)}
    </td>
  );
}

interface DeviceRow {
  label: string;
  averages: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
    fieldLcpMs: number | null;
    fieldInpMs: number | null;
    fieldCls: number | null;
  };
}

function deviceRows(
  byDevice: {
    MOBILE?: DeviceRow["averages"];
    DESKTOP?: DeviceRow["averages"];
  },
  overall: DeviceRow["averages"],
): DeviceRow[] {
  const rows: DeviceRow[] = [];
  if (byDevice.MOBILE) rows.push({ label: "Mobile", averages: byDevice.MOBILE });
  if (byDevice.DESKTOP) {
    rows.push({ label: "Desktop", averages: byDevice.DESKTOP });
  }
  if (rows.length !== 1) rows.push({ label: "Overall", averages: overall });
  return rows;
}

function scoreClass(value: number | null): string {
  if (value === null) return "pf-muted";
  if (value >= 90) return "pf-good";
  if (value >= 50) return "pf-avg";
  return "pf-poor";
}

function formatMs(value: number | null): string {
  if (value === null) return "–";
  return value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${Math.round(value)} ms`;
}

function formatCls(value: number | null): string {
  return value === null ? "–" : value.toFixed(3);
}

function triggerLabel(trigger: string): string {
  switch (trigger) {
    case "MANUAL":
      return "Manual run";
    case "SCHEDULED":
      return "Scheduled run";
    case "THEME_PUBLISH":
      return "Theme publish run";
    default:
      return trigger;
  }
}
