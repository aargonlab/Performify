// Alerts page: the last 100 threshold violations across all runs.

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shops.server";
import prisma from "../db.server";
import {
  fmtDateTime,
  fmtMetricValue,
  severityLabel,
} from "../components/charts/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const alerts = await prisma.alert.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      run: { select: { id: true, createdAt: true, themeName: true } },
    },
  });

  return {
    alerts: alerts.map((alert) => ({
      id: alert.id,
      createdAt: alert.createdAt.toISOString(),
      metric: alert.metric,
      operator: alert.operator,
      threshold: alert.threshold,
      actual: alert.actual,
      severity: alert.severity,
      url: alert.url,
      marketHandle: alert.marketHandle,
      device: alert.device,
      run: {
        id: alert.run.id,
        themeName: alert.run.themeName,
      },
    })),
  };
};

const METRIC_LABELS: Record<string, string> = {
  performanceScore: "Performance score",
  accessibilityScore: "Accessibility score",
  bestPracticesScore: "Best practices score",
  seoScore: "SEO score",
  lcpMs: "LCP (lab)",
  cls: "CLS (lab)",
  tbtMs: "TBT (lab)",
  fieldLcpMs: "LCP (field)",
  fieldInpMs: "INP (field)",
  fieldCls: "CLS (field)",
};

export default function AlertsPage() {
  const { alerts } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Alerts">
      {alerts.length === 0 ? (
        <s-section accessibilityLabel="Alerts">
          <s-paragraph>
            No alerts yet — configure thresholds in your{" "}
            <s-link href="/app/profiles">audit profiles</s-link>.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading="Latest alerts">
          <s-paragraph>
            Threshold violations from your most recent audit runs (latest 100).
          </s-paragraph>
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Severity</s-table-header>
              <s-table-header>Metric</s-table-header>
              <s-table-header>Threshold vs actual</s-table-header>
              <s-table-header>URL</s-table-header>
              <s-table-header>Market / device</s-table-header>
              <s-table-header>Report</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {alerts.map((alert) => (
                <s-table-row key={alert.id}>
                  <s-table-cell>{fmtDateTime(alert.createdAt)}</s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={alert.severity === "critical" ? "critical" : "warning"}
                    >
                      {severityLabel(alert.severity)}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {METRIC_LABELS[alert.metric] ?? alert.metric}
                  </s-table-cell>
                  <s-table-cell>
                    {alert.operator === "lt" ? "<" : ">"}{" "}
                    {fmtMetricValue(alert.metric, alert.threshold)} — actual{" "}
                    {fmtMetricValue(alert.metric, alert.actual)}
                  </s-table-cell>
                  <s-table-cell>
                    {alert.url ? truncateUrl(alert.url) : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {[
                      alert.marketHandle,
                      alert.device === "MOBILE"
                        ? "Mobile"
                        : alert.device === "DESKTOP"
                          ? "Desktop"
                          : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/runs/${alert.run.id}`}>
                      View report
                    </s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

function truncateUrl(url: string): string {
  const short = url.replace(/^https?:\/\//, "");
  return short.length > 60 ? `${short.slice(0, 59)}…` : short;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
