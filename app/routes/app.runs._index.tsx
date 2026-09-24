import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shops.server";
import { listProfiles } from "../services/profiles.server";
import { listRuns } from "../services/reports.server";
import {
  fmtDateTime,
  fmtScore,
  runStatusTone,
  scoreTextColor,
  statusLabel,
  triggerLabel,
} from "../components/charts/format";

const TRIGGERS = ["MANUAL", "SCHEDULED", "THEME_PUBLISH"] as const;
const STATUSES = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELED",
] as const;

const PAGE_SIZE = 20;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const profileId = url.searchParams.get("profileId") || undefined;
  const triggerParam = url.searchParams.get("trigger") || undefined;
  const statusParam = url.searchParams.get("status") || undefined;
  const trigger = (TRIGGERS as readonly string[]).includes(triggerParam ?? "")
    ? triggerParam
    : undefined;
  const status = (STATUSES as readonly string[]).includes(statusParam ?? "")
    ? statusParam
    : undefined;
  const cursors = (url.searchParams.get("cursors") ?? "")
    .split(",")
    .filter(Boolean);
  const cursor = cursors.length ? cursors[cursors.length - 1] : undefined;

  const [profiles, page] = await Promise.all([
    listProfiles(shop.id),
    listRuns(shop.id, { profileId, trigger, status, take: PAGE_SIZE, cursor }),
  ]);

  return {
    profiles: profiles.map((p: { id: string; name: string }) => ({
      id: p.id,
      name: p.name,
    })),
    filters: {
      profileId: profileId ?? "",
      trigger: trigger ?? "",
      status: status ?? "",
    },
    runs: page.items,
    nextCursor: page.nextCursor,
    hasPrevious: cursors.length > 0,
  };
};

export default function RunHistory() {
  const { profiles, filters, runs, nextCursor, hasPrevious } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const setFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("cursors"); // filters reset pagination
    setSearchParams(params, { preventScrollReset: true });
  };

  const cursors = (searchParams.get("cursors") ?? "").split(",").filter(Boolean);

  const goNext = () => {
    if (!nextCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("cursors", [...cursors, nextCursor].join(","));
    setSearchParams(params, { preventScrollReset: true });
  };

  const goPrevious = () => {
    const params = new URLSearchParams(searchParams);
    const remaining = cursors.slice(0, -1);
    if (remaining.length) params.set("cursors", remaining.join(","));
    else params.delete("cursors");
    setSearchParams(params, { preventScrollReset: true });
  };

  return (
    <s-page heading="Run history">
      <s-section heading="Runs">
        <s-stack direction="inline" gap="base">
          <s-select
            label="Profile"
            value={filters.profileId}
            onChange={(event: { currentTarget: { value: string } }) =>
              setFilter("profileId", event.currentTarget.value)
            }
          >
            <s-option value="">All profiles</s-option>
            {profiles.map((profile) => (
              <s-option key={profile.id} value={profile.id}>
                {profile.name}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Trigger"
            value={filters.trigger}
            onChange={(event: { currentTarget: { value: string } }) =>
              setFilter("trigger", event.currentTarget.value)
            }
          >
            <s-option value="">All triggers</s-option>
            {TRIGGERS.map((trigger) => (
              <s-option key={trigger} value={trigger}>
                {triggerLabel(trigger)}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Status"
            value={filters.status}
            onChange={(event: { currentTarget: { value: string } }) =>
              setFilter("status", event.currentTarget.value)
            }
          >
            <s-option value="">All statuses</s-option>
            {STATUSES.map((status) => (
              <s-option key={status} value={status}>
                {statusLabel(status)}
              </s-option>
            ))}
          </s-select>
        </s-stack>

        {runs.length === 0 ? (
          <s-box paddingBlockStart="base">
            <s-paragraph>
              No audit runs match these filters yet. Start one from the{" "}
              <s-link href="/app">dashboard</s-link>.
            </s-paragraph>
          </s-box>
        ) : (
          <s-table
            variant="auto"
            paginate
            hasNextPage={!!nextCursor}
            hasPreviousPage={hasPrevious}
            onNextPage={goNext}
            onPreviousPage={goPrevious}
          >
            <s-table-header-row>
              <s-table-header listSlot="primary">Date</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header>Trigger</s-table-header>
              <s-table-header>Profile</s-table-header>
              <s-table-header>Theme</s-table-header>
              <s-table-header format="numeric">Results</s-table-header>
              <s-table-header format="numeric">Alerts</s-table-header>
              <s-table-header format="numeric">Avg. perf.</s-table-header>
              <s-table-header>Report</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {runs.map((run) => (
                <s-table-row key={run.id}>
                  <s-table-cell>{fmtDateTime(run.createdAt)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={runStatusTone(run.status)}>
                      {statusLabel(run.status)}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{triggerLabel(run.trigger)}</s-table-cell>
                  <s-table-cell>{run.profileName ?? "—"}</s-table-cell>
                  <s-table-cell>{run.themeName ?? "—"}</s-table-cell>
                  <s-table-cell>
                    {run.completedResults}/{run.totalResults}
                    {run.failedResults > 0 ? ` (${run.failedResults} failed)` : ""}
                  </s-table-cell>
                  <s-table-cell>
                    {run.alertCount > 0 ? (
                      <s-badge tone="warning">{String(run.alertCount)}</s-badge>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
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
                    <s-link href={`/app/runs/${run.id}`}>View</s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
