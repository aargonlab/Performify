import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shops.server";
import {
  ensureDefaultProfile,
  listProfiles,
} from "../services/profiles.server";
import { createRun } from "../services/runs.server";
import { getTrendData, listRuns } from "../services/reports.server";
import type { TrendRunPoint } from "../services/reports.server";
import { TrendChart } from "../components/charts/TrendChart";
import {
  CHART_SERIES_COLORS,
  fmtCls,
  fmtDateShort,
  fmtDateTime,
  fmtMs,
  fmtScore,
  runStatusTone,
  scoreTextColor,
  statusLabel,
  triggerLabel,
} from "../components/charts/format";
import type { DeviceProfile } from "../lib/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  await ensureDefaultProfile(shop);
  const profiles = await listProfiles(shop.id);

  const url = new URL(request.url);
  const requestedProfileId = url.searchParams.get("profileId");
  const profileId =
    (requestedProfileId &&
    profiles.some((p: { id: string }) => p.id === requestedProfileId)
      ? requestedProfileId
      : null) ??
    profiles.find((p: { isDefault: boolean }) => p.isDefault)?.id ??
    profiles[0]?.id ??
    null;
  const device: DeviceProfile =
    url.searchParams.get("device") === "DESKTOP" ? "DESKTOP" : "MOBILE";

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [runsPage, trend, recentAlertCount] = await Promise.all([
    listRuns(shop.id, { take: 5 }),
    getTrendData(shop.id, profileId, { device }),
    prisma.alert.count({
      where: { shopId: shop.id, createdAt: { gte: sevenDaysAgo } },
    }),
  ]);

  return {
    profiles: profiles.map((p: { id: string; name: string }) => ({
      id: p.id,
      name: p.name,
    })),
    profileId,
    device,
    recentRuns: runsPage.items,
    trend,
    recentAlertCount,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "run-now") {
    const profileId = String(formData.get("profileId") ?? "");
    const run = await createRun({
      shopDomain: session.shop,
      ...(profileId ? { profileId } : {}),
      trigger: "MANUAL",
    });
    return { ok: true, runId: run.runId };
  }
  return { ok: false, runId: null };
};

/** Unique x labels for the trend charts (append time when dates collide). */
function trendLabels(trend: TrendRunPoint[]): string[] {
  const short = trend.map((t) => fmtDateShort(t.date));
  const counts = new Map<string, number>();
  for (const label of short) counts.set(label, (counts.get(label) ?? 0) + 1);
  const labels = trend.map((t, i) => {
    if ((counts.get(short[i]) ?? 0) <= 1) return short[i];
    const d = new Date(t.date);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${short[i]} ${hh}:${mm}`;
  });
  // Runs within the same UTC minute would still collide, and TrendChart
  // dedupes x by label — suffix repeats so every run keeps its own point.
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const occurrence = (seen.get(label) ?? 0) + 1;
    seen.set(label, occurrence);
    return occurrence === 1 ? label : `${label} (${occurrence})`;
  });
}

export default function Dashboard() {
  const { profiles, profileId, device, recentRuns, trend, recentAlertCount } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const isStarting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Audit started — results will appear shortly");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const runNow = () => {
    fetcher.submit(
      { intent: "run-now", profileId: profileId ?? "" },
      { method: "POST" },
    );
  };

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    params.set(key, value);
    setSearchParams(params, { preventScrollReset: true });
  };

  const labels = trendLabels(trend);
  const scoreSeries = [
    {
      name: "Performance",
      color: CHART_SERIES_COLORS[0],
      points: trend.map((t, i) => ({ x: labels[i], y: t.scores.performance })),
    },
    {
      name: "Accessibility",
      color: CHART_SERIES_COLORS[1],
      points: trend.map((t, i) => ({
        x: labels[i],
        y: t.scores.accessibility,
      })),
    },
    {
      name: "Best practices",
      color: CHART_SERIES_COLORS[2],
      points: trend.map((t, i) => ({
        x: labels[i],
        y: t.scores.bestPractices,
      })),
    },
    {
      name: "SEO",
      color: CHART_SERIES_COLORS[3],
      points: trend.map((t, i) => ({ x: labels[i], y: t.scores.seo })),
    },
  ];
  const labTimingSeries = [
    {
      name: "LCP",
      color: CHART_SERIES_COLORS[0],
      points: trend.map((t, i) => ({ x: labels[i], y: t.lab.lcpMs })),
    },
    {
      name: "TBT",
      color: CHART_SERIES_COLORS[1],
      points: trend.map((t, i) => ({ x: labels[i], y: t.lab.tbtMs })),
    },
  ];
  const labClsSeries = [
    {
      name: "CLS",
      color: CHART_SERIES_COLORS[0],
      points: trend.map((t, i) => ({ x: labels[i], y: t.lab.cls })),
    },
  ];
  const fieldSeries = [
    {
      name: "LCP (p75)",
      color: CHART_SERIES_COLORS[0],
      points: trend.map((t, i) => ({ x: labels[i], y: t.field.lcpMs })),
    },
    {
      name: "INP (p75)",
      color: CHART_SERIES_COLORS[1],
      points: trend.map((t, i) => ({ x: labels[i], y: t.field.inpMs })),
    },
  ];
  const hasFieldData = trend.some(
    (t) => t.field.lcpMs != null || t.field.inpMs != null,
  );
  const hasRuns = recentRuns.length > 0;

  return (
    <s-page heading="Performance overview">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={runNow}
        {...(isStarting ? { loading: true } : {})}
      >
        Run audit now
      </s-button>

      {recentAlertCount > 0 && (
        <s-banner
          tone="warning"
          heading={`${recentAlertCount} performance ${
            recentAlertCount === 1 ? "alert" : "alerts"
          } in the last 7 days`}
        >
          <s-paragraph>
            Some audited pages crossed your performance budgets.{" "}
            <s-link href="/app/alerts">Review alerts</s-link>
          </s-paragraph>
        </s-banner>
      )}

      {!hasRuns ? (
        <s-section heading="Welcome to Performify">
          <s-paragraph>
            Performify runs Lighthouse audits on your storefront pages across
            your markets and devices, then tracks scores and Core Web Vitals
            over time. Start with your first audit — it usually takes a few
            minutes.
          </s-paragraph>
          <s-box paddingBlockStart="base">
            <s-button
              onClick={runNow}
              {...(isStarting ? { loading: true } : {})}
            >
              Run audit now
            </s-button>
          </s-box>
        </s-section>
      ) : (
        <>
          <s-section heading="Category scores">
            <s-stack direction="inline" gap="base">
              <s-select
                label="Audit profile"
                value={profileId ?? ""}
                onChange={(event: { currentTarget: { value: string } }) =>
                  setParam("profileId", event.currentTarget.value)
                }
              >
                {profiles.map((profile) => (
                  <s-option key={profile.id} value={profile.id}>
                    {profile.name}
                  </s-option>
                ))}
              </s-select>
              <s-select
                label="Device"
                value={device}
                onChange={(event: { currentTarget: { value: string } }) =>
                  setParam("device", event.currentTarget.value)
                }
              >
                <s-option value="MOBILE">Mobile</s-option>
                <s-option value="DESKTOP">Desktop</s-option>
              </s-select>
            </s-stack>
            <s-box paddingBlockStart="base">
              <TrendChart
                series={scoreSeries}
                yDomain={[0, 100]}
                yLabel="Score (0–100)"
                valueFormatter={fmtScore}
              />
            </s-box>
          </s-section>

          <s-section heading="Lab data (Lighthouse)">
            <s-paragraph>
              Synthetic metrics measured by Lighthouse under fixed network and
              device conditions — comparable run over run.
            </s-paragraph>
            <s-heading>LCP and TBT</s-heading>
            <TrendChart
              series={labTimingSeries}
              height={220}
              yLabel="Time"
              valueFormatter={fmtMs}
            />
            <s-heading>Layout stability (CLS)</s-heading>
            <TrendChart
              series={labClsSeries}
              height={180}
              yLabel="CLS"
              valueFormatter={fmtCls}
            />
          </s-section>

          <s-section heading="Field data (CrUX, 28-day p75)">
            <s-paragraph>
              Real-user Core Web Vitals from the Chrome UX Report — the 75th
              percentile over the last 28 days.
            </s-paragraph>
            {hasFieldData ? (
              <TrendChart
                series={fieldSeries}
                height={220}
                yLabel="Time"
                valueFormatter={fmtMs}
              />
            ) : (
              <s-banner tone="info">
                <s-paragraph>
                  Your storefront does not have enough real-user traffic in
                  CrUX yet. Field data will appear here once Google collects a
                  large enough sample.
                </s-paragraph>
              </s-banner>
            )}
          </s-section>

          <s-section heading="Latest runs">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Date</s-table-header>
                <s-table-header listSlot="secondary">Status</s-table-header>
                <s-table-header>Trigger</s-table-header>
                <s-table-header>Theme</s-table-header>
                <s-table-header format="numeric">Avg. perf.</s-table-header>
                <s-table-header>Report</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {recentRuns.map((run) => (
                  <s-table-row key={run.id}>
                    <s-table-cell>{fmtDateTime(run.createdAt)}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={runStatusTone(run.status)}>
                        {statusLabel(run.status)}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{triggerLabel(run.trigger)}</s-table-cell>
                    <s-table-cell>{run.themeName ?? "—"}</s-table-cell>
                    <s-table-cell>
                      <span
                        style={{
                          color: scoreTextColor(run.avgPerformanceScore),
                          fontWeight: 600,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtScore(run.avgPerformanceScore)}
                      </span>
                    </s-table-cell>
                    <s-table-cell>
                      <s-link href={`/app/runs/${run.id}`}>View report</s-link>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-box paddingBlockStart="base">
              <s-link href="/app/runs">View all runs</s-link>
            </s-box>
          </s-section>
        </>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
