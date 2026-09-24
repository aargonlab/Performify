import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  isRouteErrorResponse,
  useFetcher,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shops.server";
import { getPreviousRun, getRunWithResults } from "../services/reports.server";
import { toRunSummary } from "../services/mappers.server";
import { createRun } from "../services/runs.server";
import { createShareLink } from "../services/share.server";
import { compareRuns, computeAggregates } from "../lib/report/compare";
import type { PageResultSummary } from "../lib/report/types";
import type { RunNarrative } from "../lib/types";
import { ScoreRing } from "../components/charts/ScoreRing";
import { DeltaBadge } from "../components/charts/DeltaBadge";
import { ComparisonHeatmap } from "../components/charts/ComparisonHeatmap";
import {
  deviceLabel,
  fmtCls,
  fmtDateTime,
  fmtMetricValue,
  fmtMs,
  fmtScore,
  pageTypeLabel,
  resultStatusTone,
  runStatusTone,
  scoreTextColor,
  severityLabel,
  statusLabel,
  triggerLabel,
} from "../components/charts/format";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const run = await getRunWithResults(shop.id, params.runId ?? "");
  if (!run) throw new Response("Run not found", { status: 404 });

  const previous = await getPreviousRun(shop.id, run);
  const current = toRunSummary(run);
  const baseline = previous ? toRunSummary(previous) : null;
  const aggregates = computeAggregates(current.pageResults);
  const comparison = baseline ? compareRuns(current, baseline) : null;

  // Heatmap view-model: one row per market × pageType slice, current value +
  // delta vs the same slice of the baseline. Only when a baseline exists.
  let heatmap:
    | { label: string; cells: { value: number | null; delta: number | null }[] }[]
    | null = null;
  if (baseline) {
    const slices = new Map<string, PageResultSummary[]>();
    for (const result of current.pageResults) {
      const key = `${result.marketHandle ?? ""}|${result.pageType}`;
      const slice = slices.get(key) ?? [];
      slice.push(result);
      slices.set(key, slice);
    }
    const delta = (c: number | null, b: number | null | undefined) =>
      c != null && b != null ? Math.round((c - b) * 1000) / 1000 : null;
    heatmap = [...slices.entries()].map(([key, slice]) => {
      const [marketHandle, pageType] = key.split("|");
      const cur = computeAggregates(slice).overall;
      const baseSlice = baseline.pageResults.filter(
        (b) =>
          (b.marketHandle ?? "") === marketHandle && b.pageType === pageType,
      );
      const base = baseSlice.length
        ? computeAggregates(baseSlice).overall
        : null;
      const marketName =
        slice[0].marketName ?? (marketHandle ? marketHandle : "Default");
      return {
        label: `${marketName} · ${pageTypeLabel(pageType)}`,
        cells: [
          {
            value: cur.performanceScore,
            delta: delta(cur.performanceScore, base?.performanceScore),
          },
          {
            value: cur.accessibilityScore,
            delta: delta(cur.accessibilityScore, base?.accessibilityScore),
          },
          {
            value: cur.bestPracticesScore,
            delta: delta(cur.bestPracticesScore, base?.bestPracticesScore),
          },
          { value: cur.seoScore, delta: delta(cur.seoScore, base?.seoScore) },
          { value: cur.lcpMs, delta: delta(cur.lcpMs, base?.lcpMs) },
        ],
      };
    });
  }

  return {
    run: {
      id: run.id,
      status: run.status as string,
      trigger: run.trigger as string,
      themeName: run.themeName,
      profileName: run.profileName,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      totalJobs: run.totalJobs,
      completedJobs: run.completedJobs,
      failedJobs: run.failedJobs,
    },
    overall: aggregates.overall,
    deltas: comparison ? comparison.deltas : null,
    baseline: baseline
      ? { id: baseline.id, createdAt: baseline.createdAt }
      : null,
    heatmap,
    narrative: (run.narrative as unknown as RunNarrative | null) ?? null,
    results: run.pageResults.map((r) => ({
      id: r.id,
      url: r.url,
      pageType: r.pageType as string,
      device: r.device as string,
      marketHandle: r.marketHandle,
      marketName: r.marketName,
      locale: r.locale,
      status: r.status as string,
      error: r.error,
      performanceScore: r.performanceScore,
      accessibilityScore: r.accessibilityScore,
      bestPracticesScore: r.bestPracticesScore,
      seoScore: r.seoScore,
      lcpMs: r.lcpMs,
      cls: r.cls,
      tbtMs: r.tbtMs,
      fieldLcpMs: r.fieldLcpMs,
      fieldInpMs: r.fieldInpMs,
      fieldCls: r.fieldCls,
    })),
    alerts: run.alerts.map((a) => ({
      id: a.id,
      metric: a.metric,
      operator: a.operator,
      threshold: a.threshold,
      actual: a.actual,
      severity: a.severity,
      url: a.url,
      device: a.device as string | null,
      pageType: a.pageType as string | null,
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const run = await prisma.auditRun.findFirst({
    where: { id: params.runId ?? "", shopId: shop.id },
    select: { id: true, profileId: true, status: true },
  });
  if (!run) throw new Response("Run not found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "share") {
    if (run.status !== "COMPLETED" && run.status !== "PARTIAL") {
      return {
        intent: "share" as const,
        shareUrl: null,
        newRunId: null,
        error: "Report not ready to share yet",
      };
    }
    const { url } = await createShareLink(run.id);
    return {
      intent: "share" as const,
      shareUrl: url,
      newRunId: null,
      error: null,
    };
  }
  if (intent === "rerun") {
    const newRun = await createRun({
      shopDomain: session.shop,
      ...(run.profileId ? { profileId: run.profileId } : {}),
      trigger: "MANUAL",
    });
    return { intent: "rerun" as const, shareUrl: null, newRunId: newRun.runId };
  }
  return { intent: null, shareUrl: null, newRunId: null };
};

/** Lighthouse band tints for heatmap cell backgrounds (scores and lab LCP). */
function heatColor(value: number | null): string {
  if (value == null) return "#f1f1f1";
  if (value > 100) {
    // Milliseconds (lab LCP): 2.5s / 4s web-vitals bands.
    if (value <= 2500) return "#b7e2c3";
    if (value <= 4000) return "#ffe2a8";
    return "#ffc7be";
  }
  if (value >= 90) return "#b7e2c3";
  if (value >= 50) return "#ffe2a8";
  return "#ffc7be";
}

function ScoreCell({ score }: { score: number | null }) {
  return (
    <span
      style={{
        color: scoreTextColor(score),
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {fmtScore(score)}
    </span>
  );
}

const ALL = "";

export default function RunReport() {
  const { run, overall, deltas, baseline, heatmap, narrative, results, alerts } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const [marketFilter, setMarketFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [deviceFilter, setDeviceFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [exportingFormat, setExportingFormat] = useState<string | null>(null);

  const isBusy = ["loading", "submitting"].includes(fetcher.state);
  const shareUrl =
    fetcher.data?.intent === "share" ? fetcher.data.shareUrl : null;
  const shareError =
    fetcher.data?.intent === "share" ? fetcher.data.error : null;
  const canShare = ["COMPLETED", "PARTIAL"].includes(run.status);

  useEffect(() => {
    if (fetcher.state === "idle" && shareError) {
      shopify.toast.show(shareError, { isError: true });
    }
  }, [fetcher.state, shareError, shopify]);

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.intent === "rerun" &&
      fetcher.data.newRunId
    ) {
      shopify.toast.show("New audit started");
      navigate(`/app/runs/${fetcher.data.newRunId}`);
    }
  }, [fetcher.state, fetcher.data, shopify, navigate]);

  // Authenticated same-origin download: App Bridge patches window.fetch with
  // the session token inside the embedded iframe, so the resource route stays
  // authenticated (a plain target="_blank" link would lose the session).
  const downloadExport = async (format: "csv" | "json" | "pdf") => {
    setExportingFormat(format);
    try {
      const res = await fetch(`/app/runs/${run.id}/export/${format}`);
      if (!res.ok) {
        shopify.toast.show("Export failed — please try again", {
          isError: true,
        });
        return;
      }
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        `run-${run.id}.${format}`;
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      shopify.toast.show("Export failed — please try again", {
        isError: true,
      });
    } finally {
      setExportingFormat(null);
    }
  };

  const markets = useMemo(
    () =>
      [...new Set(results.map((r) => r.marketHandle ?? ""))].map((handle) => ({
        handle,
        name:
          results.find((r) => (r.marketHandle ?? "") === handle)?.marketName ??
          (handle || "Default"),
      })),
    [results],
  );
  const pageTypes = useMemo(
    () => [...new Set(results.map((r) => r.pageType))],
    [results],
  );
  const statuses = useMemo(
    () => [...new Set(results.map((r) => r.status))],
    [results],
  );

  const filteredResults = results.filter(
    (r) =>
      (marketFilter === ALL || (r.marketHandle ?? "") === marketFilter) &&
      (typeFilter === ALL || r.pageType === typeFilter) &&
      (deviceFilter === ALL || r.device === deviceFilter) &&
      (statusFilter === ALL || r.status === statusFilter),
  );

  const scoreRows = [
    {
      label: "Performance",
      value: overall.performanceScore,
      key: "performanceScore" as const,
    },
    {
      label: "Accessibility",
      value: overall.accessibilityScore,
      key: "accessibilityScore" as const,
    },
    {
      label: "Best practices",
      value: overall.bestPracticesScore,
      key: "bestPracticesScore" as const,
    },
    { label: "SEO", value: overall.seoScore, key: "seoScore" as const },
  ];

  const labRows = [
    {
      label: "LCP",
      value: overall.lcpMs,
      delta: deltas?.lcpMs ?? null,
      fmt: fmtMs,
    },
    {
      label: "CLS",
      value: overall.cls,
      delta: deltas?.cls ?? null,
      fmt: fmtCls,
    },
    {
      label: "TBT",
      value: overall.tbtMs,
      delta: deltas?.tbtMs ?? null,
      fmt: fmtMs,
    },
  ];
  const fieldRows = [
    {
      label: "LCP (p75)",
      value: overall.fieldLcpMs,
      delta: deltas?.fieldLcpMs ?? null,
      fmt: fmtMs,
    },
    {
      label: "INP (p75)",
      value: overall.fieldInpMs,
      delta: deltas?.fieldInpMs ?? null,
      fmt: fmtMs,
    },
    {
      label: "CLS (p75)",
      value: overall.fieldCls,
      delta: deltas?.fieldCls ?? null,
      fmt: fmtCls,
    },
  ];

  const recommendations = narrative
    ? [...narrative.recommendations].sort((a, b) => a.priority - b.priority)
    : [];

  return (
    <s-page heading={`Audit report — ${fmtDateTime(run.createdAt)}`}>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => fetcher.submit({ intent: "rerun" }, { method: "POST" })}
        {...(isBusy ? { loading: true } : {})}
      >
        Run again
      </s-button>

      <s-section heading="Overview">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={runStatusTone(run.status)}>
            {statusLabel(run.status)}
          </s-badge>
          <s-badge tone="neutral">{triggerLabel(run.trigger)}</s-badge>
          {run.themeName ? (
            <s-badge tone="info">{`Theme: ${run.themeName}`}</s-badge>
          ) : null}
          <s-text color="subdued">
            Profile: {run.profileName ?? "—"} · Started:{" "}
            {fmtDateTime(run.startedAt ?? run.createdAt)} · Completed:{" "}
            {fmtDateTime(run.completedAt)}
          </s-text>
        </s-stack>
        {run.error ? (
          <s-banner tone="critical" heading="Run error">
            <s-paragraph>{run.error}</s-paragraph>
          </s-banner>
        ) : null}
        <s-box paddingBlockStart="base">
          <s-stack direction="inline" gap="base">
            <s-button
              icon="export"
              onClick={() => downloadExport("csv")}
              {...(exportingFormat === "csv" ? { loading: true } : {})}
            >
              CSV
            </s-button>
            <s-button
              icon="export"
              onClick={() => downloadExport("json")}
              {...(exportingFormat === "json" ? { loading: true } : {})}
            >
              JSON
            </s-button>
            <s-button
              icon="export"
              onClick={() => downloadExport("pdf")}
              {...(exportingFormat === "pdf" ? { loading: true } : {})}
            >
              PDF
            </s-button>
            <s-button
              icon="share"
              onClick={() =>
                fetcher.submit({ intent: "share" }, { method: "POST" })
              }
              {...(canShare ? {} : { disabled: true })}
              {...(isBusy ? { loading: true } : {})}
            >
              Create share link
            </s-button>
          </s-stack>
        </s-box>
        {shareUrl ? (
          <s-box paddingBlockStart="base">
            <s-banner tone="success" heading="Share link created">
              <s-paragraph>
                Anyone with this link can view the report (no login required):{" "}
                <s-link href={shareUrl} target="_blank">
                  {shareUrl}
                </s-link>
              </s-paragraph>
              <s-button
                onClick={() => {
                  navigator.clipboard
                    .writeText(shareUrl)
                    .then(() => shopify.toast.show("Link copied"))
                    .catch(() => shopify.toast.show("Could not copy link"));
                }}
              >
                Copy link
              </s-button>
            </s-banner>
          </s-box>
        ) : null}
      </s-section>

      <s-section heading="Score summary">
        {baseline ? (
          <s-paragraph>
            Deltas are compared with the previous run of this profile (
            {fmtDateTime(baseline.createdAt)}).
          </s-paragraph>
        ) : (
          <s-paragraph>
            No previous run of this profile to compare against yet.
          </s-paragraph>
        )}
        <s-stack direction="inline" gap="large-100" alignItems="start">
          {scoreRows.map((row) => (
            <div
              key={row.key}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
              }}
            >
              <ScoreRing score={row.value} label={row.label} />
              <DeltaBadge
                delta={deltas?.[row.key] ?? null}
                goodDirection="up"
                formatter={fmtScore}
              />
            </div>
          ))}
        </s-stack>
      </s-section>

      <s-grid
        gridTemplateColumns="@container (inline-size > 640px) 1fr 1fr, 1fr"
        gap="base"
      >
        <s-section heading="Lab data (Lighthouse)">
          <s-paragraph>
            Synthetic measurements from Lighthouse under fixed network and
            device conditions. Averages across audited pages; each page value
            is the median of repeated runs.
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header>Metric</s-table-header>
              <s-table-header format="numeric">Value</s-table-header>
              <s-table-header>Δ vs previous</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {labRows.map((row) => (
                <s-table-row key={row.label}>
                  <s-table-cell>{row.label}</s-table-cell>
                  <s-table-cell>{row.fmt(row.value)}</s-table-cell>
                  <s-table-cell>
                    <DeltaBadge
                      delta={row.delta}
                      goodDirection="down"
                      formatter={row.fmt}
                    />
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>

        <s-section heading="Field data (CrUX, 28-day p75)">
          <s-paragraph>
            Real-user Core Web Vitals from Chrome users over the last 28 days
            (75th percentile). May be empty on low-traffic storefronts.
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header>Metric</s-table-header>
              <s-table-header format="numeric">Value</s-table-header>
              <s-table-header>Δ vs previous</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {fieldRows.map((row) => (
                <s-table-row key={row.label}>
                  <s-table-cell>{row.label}</s-table-cell>
                  <s-table-cell>{row.fmt(row.value)}</s-table-cell>
                  <s-table-cell>
                    <DeltaBadge
                      delta={row.delta}
                      goodDirection="down"
                      formatter={row.fmt}
                    />
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      </s-grid>

      {heatmap ? (
        <s-section heading="Vs previous run">
          <s-paragraph>
            Current values per market and page type, with the change since the
            previous run of this profile. Colors follow the Lighthouse bands.
          </s-paragraph>
          <ComparisonHeatmap
            rows={heatmap}
            columns={[
              "Performance",
              "Accessibility",
              "Best practices",
              "SEO",
              "LCP (lab)",
            ]}
            colorFor={heatColor}
          />
        </s-section>
      ) : null}

      {narrative ? (
        <s-section heading="What changed">
          <s-paragraph>{narrative.summary}</s-paragraph>
          {narrative.sections.map((section, index) => (
            <s-banner
              key={`${section.heading}-${index}`}
              heading={section.heading}
              tone={
                section.tone === "positive"
                  ? "success"
                  : section.tone === "negative"
                    ? "critical"
                    : "info"
              }
            >
              <s-paragraph>{section.body}</s-paragraph>
            </s-banner>
          ))}
          {recommendations.length > 0 ? (
            <>
              <s-heading>Recommendations</s-heading>
              <s-ordered-list>
                {recommendations.map((rec) => (
                  <s-list-item key={rec.auditId}>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-text type="strong">{rec.title}</s-text>
                      <s-badge tone="info">{`Priority ${rec.priority}`}</s-badge>
                      {rec.estimatedSavingsMs > 0 ? (
                        <s-badge tone="neutral">
                          {`Est. savings ${fmtMs(rec.estimatedSavingsMs)}`}
                        </s-badge>
                      ) : null}
                    </s-stack>
                    <s-paragraph>{rec.explanation}</s-paragraph>
                    {rec.affectedUrls.length > 0 ? (
                      <details>
                        <summary style={{ cursor: "pointer" }}>
                          <s-text color="subdued">
                            Affected URLs ({rec.affectedUrls.length})
                          </s-text>
                        </summary>
                        <s-unordered-list>
                          {rec.affectedUrls.map((url) => (
                            <s-list-item key={url}>
                              <s-link href={url} target="_blank">
                                {url}
                              </s-link>
                            </s-list-item>
                          ))}
                        </s-unordered-list>
                      </details>
                    ) : null}
                  </s-list-item>
                ))}
              </s-ordered-list>
            </>
          ) : null}
        </s-section>
      ) : null}

      <s-section heading="Page results">
        <s-stack direction="inline" gap="base">
          <s-select
            label="Market"
            value={marketFilter}
            onChange={(event: { currentTarget: { value: string } }) =>
              setMarketFilter(event.currentTarget.value)
            }
          >
            <s-option value="">All markets</s-option>
            {markets.map((market) => (
              <s-option key={market.handle || "default"} value={market.handle}>
                {market.name}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Page type"
            value={typeFilter}
            onChange={(event: { currentTarget: { value: string } }) =>
              setTypeFilter(event.currentTarget.value)
            }
          >
            <s-option value="">All types</s-option>
            {pageTypes.map((type) => (
              <s-option key={type} value={type}>
                {pageTypeLabel(type)}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Device"
            value={deviceFilter}
            onChange={(event: { currentTarget: { value: string } }) =>
              setDeviceFilter(event.currentTarget.value)
            }
          >
            <s-option value="">All devices</s-option>
            <s-option value="MOBILE">Mobile</s-option>
            <s-option value="DESKTOP">Desktop</s-option>
          </s-select>
          <s-select
            label="Status"
            value={statusFilter}
            onChange={(event: { currentTarget: { value: string } }) =>
              setStatusFilter(event.currentTarget.value)
            }
          >
            <s-option value="">All statuses</s-option>
            {statuses.map((status) => (
              <s-option key={status} value={status}>
                {statusLabel(status)}
              </s-option>
            ))}
          </s-select>
        </s-stack>

        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <s-table>
            <s-table-header-row>
              <s-table-header>URL</s-table-header>
              <s-table-header>Market</s-table-header>
              <s-table-header>Locale</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Device</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Perf</s-table-header>
              <s-table-header format="numeric">A11y</s-table-header>
              <s-table-header format="numeric">BP</s-table-header>
              <s-table-header format="numeric">SEO</s-table-header>
              <s-table-header format="numeric">LCP</s-table-header>
              <s-table-header format="numeric">CLS</s-table-header>
              <s-table-header format="numeric">TBT</s-table-header>
              <s-table-header format="numeric">Field LCP</s-table-header>
              <s-table-header format="numeric">Field INP</s-table-header>
              <s-table-header format="numeric">Field CLS</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {filteredResults.map((result) => (
                <s-table-row key={result.id}>
                  <s-table-cell>
                    <s-link href={result.url} target="_blank">
                      {result.url.replace(/^https?:\/\//, "")}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {result.marketName ?? result.marketHandle ?? "—"}
                  </s-table-cell>
                  <s-table-cell>{result.locale ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone="neutral">
                      {pageTypeLabel(result.pageType)}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone="neutral"
                      icon={result.device === "MOBILE" ? "mobile" : "desktop"}
                    >
                      {deviceLabel(result.device)}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={resultStatusTone(result.status)}>
                      {statusLabel(result.status)}
                    </s-badge>
                    {result.status === "FAILED" && result.error ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--p-color-text-critical, #d72c0d)",
                          maxWidth: 240,
                          whiteSpace: "normal",
                        }}
                      >
                        {result.error}
                      </div>
                    ) : null}
                  </s-table-cell>
                  <s-table-cell>
                    <ScoreCell score={result.performanceScore} />
                  </s-table-cell>
                  <s-table-cell>
                    <ScoreCell score={result.accessibilityScore} />
                  </s-table-cell>
                  <s-table-cell>
                    <ScoreCell score={result.bestPracticesScore} />
                  </s-table-cell>
                  <s-table-cell>
                    <ScoreCell score={result.seoScore} />
                  </s-table-cell>
                  <s-table-cell>{fmtMs(result.lcpMs)}</s-table-cell>
                  <s-table-cell>{fmtCls(result.cls)}</s-table-cell>
                  <s-table-cell>{fmtMs(result.tbtMs)}</s-table-cell>
                  <s-table-cell>{fmtMs(result.fieldLcpMs)}</s-table-cell>
                  <s-table-cell>{fmtMs(result.fieldInpMs)}</s-table-cell>
                  <s-table-cell>{fmtCls(result.fieldCls)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </div>
        {filteredResults.length === 0 ? (
          <s-paragraph>No page results match these filters.</s-paragraph>
        ) : null}
      </s-section>

      {alerts.length > 0 ? (
        <s-section heading="Alerts">
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="secondary">Severity</s-table-header>
                <s-table-header listSlot="primary">Metric</s-table-header>
                <s-table-header>Threshold</s-table-header>
                <s-table-header format="numeric">Actual</s-table-header>
                <s-table-header>URL</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {alerts.map((alert) => (
                  <s-table-row key={alert.id}>
                    <s-table-cell>
                      <s-badge
                        tone={
                          alert.severity === "critical" ? "critical" : "warning"
                        }
                      >
                        {severityLabel(alert.severity)}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{alert.metric}</s-table-cell>
                    <s-table-cell>
                      {alert.operator === "lt" ? "<" : ">"}{" "}
                      {fmtMetricValue(alert.metric, alert.threshold)}
                    </s-table-cell>
                    <s-table-cell>
                      {fmtMetricValue(alert.metric, alert.actual)}
                    </s-table-cell>
                    <s-table-cell>
                      {alert.url ? (
                        <s-link href={alert.url} target="_blank">
                          {alert.url.replace(/^https?:\/\//, "")}
                        </s-link>
                      ) : (
                        "—"
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </div>
        </s-section>
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <s-page heading="Not found">
        <s-section accessibilityLabel="Not found">
          <s-banner tone="critical" heading="This run no longer exists">
            <s-paragraph>
              It may have been deleted.{" "}
              <s-link href="/app/runs">View all runs</s-link>
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }
  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
