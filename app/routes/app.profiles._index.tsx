import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shops.server";
import {
  deleteProfile,
  duplicateProfile,
  listProfiles,
  setDefaultProfile,
  ProfileNameConflictError,
} from "../services/profiles.server";
import type { DeviceProfile, ScheduleConfig } from "../lib/types";

interface ProfileListItem {
  id: string;
  name: string;
  isDefault: boolean;
  devices: DeviceProfile[];
  schedule: ScheduleConfig;
  themePublishTrigger: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const rows = await listProfiles(shop.id);
  const profiles: ProfileListItem[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    devices: row.devices as DeviceProfile[],
    schedule: row.schedule as unknown as ScheduleConfig,
    themePublishTrigger: row.themePublishTrigger,
  }));
  return { profiles };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const profileId = String(formData.get("profileId") ?? "");
  if (!profileId) {
    return { error: "Missing profile id." };
  }
  try {
    switch (intent) {
      case "delete":
        await deleteProfile({ id: shop.id, domain: shop.domain }, profileId);
        return { ok: true as const, message: "Profile deleted" };
      case "duplicate":
        await duplicateProfile({ id: shop.id, domain: shop.domain }, profileId);
        return { ok: true as const, message: "Profile duplicated" };
      case "set-default":
        await setDefaultProfile(shop.id, profileId);
        return { ok: true as const, message: "Default profile updated" };
      default:
        return { error: "Unknown action." };
    }
  } catch (error) {
    if (error instanceof ProfileNameConflictError) {
      return { error: error.message };
    }
    throw error;
  }
};

// --- Tiny cron humanizer (common monthly/weekly/daily shapes only) ----------

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function humanizeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = fields;
  const asNumber = (field: string) =>
    /^\d+$/.test(field) ? Number.parseInt(field, 10) : null;
  const m = asNumber(minute);
  const h = asNumber(hour);
  if (m === null || h === null) return cron;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const domNumber = asNumber(dom);
  const dowNumber = asNumber(dow);
  if (domNumber !== null && month === "*" && dow === "*") {
    return `Monthly on day ${domNumber} at ${time}`;
  }
  if (dom === "*" && month === "*" && dowNumber !== null) {
    return `Weekly on ${DAY_NAMES[dowNumber % 7]} at ${time}`;
  }
  if (dom === "*" && month === "*" && dow === "*") {
    return `Daily at ${time}`;
  }
  return cron;
}

// --- UI ----------------------------------------------------------------------

function ProfileRow({
  profile,
  busy,
  onAction,
  onRequestDelete,
}: {
  profile: ProfileListItem;
  busy: boolean;
  onAction: (intent: string, profileId: string) => void;
  onRequestDelete: (profile: ProfileListItem) => void;
}) {
  return (
    <s-table-row>
      <s-table-cell>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-link href={`/app/profiles/${profile.id}`}>{profile.name}</s-link>
          {profile.isDefault && <s-badge tone="info">Default</s-badge>}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text>{humanizeCron(profile.schedule.cron)}</s-text>
          {profile.schedule.enabled ? (
            <s-text color="subdued">{profile.schedule.timezone}</s-text>
          ) : (
            <s-badge tone="neutral">Paused</s-badge>
          )}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-200">
          {profile.devices.map((device) => (
            <s-badge key={device}>
              {device === "MOBILE" ? "Mobile" : "Desktop"}
            </s-badge>
          ))}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={profile.themePublishTrigger ? "success" : "neutral"}>
          {profile.themePublishTrigger ? "On" : "Off"}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-200">
          {!profile.isDefault && (
            <s-button
              variant="tertiary"
              disabled={busy}
              onClick={() => onAction("set-default", profile.id)}
            >
              Set default
            </s-button>
          )}
          <s-button
            variant="tertiary"
            icon="duplicate"
            disabled={busy}
            onClick={() => onAction("duplicate", profile.id)}
          >
            Duplicate
          </s-button>
          <s-button
            variant="tertiary"
            tone="critical"
            icon="delete"
            disabled={busy}
            onClick={() => onRequestDelete(profile)}
          >
            Delete
          </s-button>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

export default function ProfilesIndex() {
  const { profiles } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [pendingDelete, setPendingDelete] = useState<ProfileListItem | null>(
    null,
  );
  const deleteModalRef = useRef<HTMLElementTagNameMap["s-modal"]>(null);

  useEffect(() => {
    if (pendingDelete) deleteModalRef.current?.showOverlay();
  }, [pendingDelete]);

  useEffect(() => {
    if (!fetcher.data) return;
    if ("ok" in fetcher.data && fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
    } else if ("error" in fetcher.data && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const submitAction = (intent: string, profileId: string) => {
    fetcher.submit({ intent, profileId }, { method: "POST" });
  };

  return (
    <s-page heading="Audit profiles">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => navigate("/app/profiles/new")}
      >
        Create profile
      </s-button>

      <s-section heading="Profiles">
        <s-paragraph>
          Each profile defines what to audit (markets, pages, devices), when to
          run, and which thresholds trigger alerts.
        </s-paragraph>
        {profiles.length === 0 ? (
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                No audit profiles yet. Create one to start monitoring your
                storefront performance.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button onClick={() => navigate("/app/profiles/new")}>
                  Create profile
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Profile</s-table-header>
              <s-table-header>Schedule</s-table-header>
              <s-table-header>Devices</s-table-header>
              <s-table-header>Theme trigger</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {profiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  busy={busy}
                  onAction={submitAction}
                  onRequestDelete={setPendingDelete}
                />
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-modal
        ref={deleteModalRef}
        id="delete-profile-modal"
        heading="Delete profile?"
        onHide={() => setPendingDelete(null)}
      >
        <s-paragraph>
          “{pendingDelete?.name}” and its audit schedule will be permanently
          deleted. This can’t be undone.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          disabled={busy}
          onClick={() => {
            if (pendingDelete) submitAction("delete", pendingDelete.id);
            deleteModalRef.current?.hideOverlay();
          }}
        >
          Delete profile
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => deleteModalRef.current?.hideOverlay()}
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
