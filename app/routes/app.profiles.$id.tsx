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
import { ensureShop } from "../services/shops.server";
import { fetchActiveMarkets } from "../services/markets.server";
import {
  createProfile,
  getProfile,
  updateProfile,
  validateProfileInput,
  ProfileNameConflictError,
} from "../services/profiles.server";
import type {
  DeviceProfile,
  MarketsSelection,
  NotificationsConfig,
  PagesSelection,
  PsiCategory,
  ResolvedMarket,
  SampledPageSelection,
  ScheduleConfig,
  Threshold,
  ThresholdMetric,
} from "../lib/types";
import { DEFAULT_PAGES_SELECTION } from "../lib/types";

// ---------------------------------------------------------------------------
// Loader / action
// ---------------------------------------------------------------------------

interface LoadedProfile {
  id: string;
  name: string;
  isDefault: boolean;
  devices: DeviceProfile[];
  runsPerUrl: number;
  categories: PsiCategory[];
  markets: MarketsSelection;
  pages: PagesSelection;
  schedule: ScheduleConfig;
  themePublishTrigger: boolean;
  thresholds: Threshold[];
  notifications: NotificationsConfig;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const id = params.id ?? "new";

  let profile: LoadedProfile | null = null;
  if (id !== "new") {
    const row = await getProfile(shop.id, id);
    if (!row) {
      throw new Response("Not found", { status: 404 });
    }
    profile = {
      id: row.id,
      name: row.name,
      isDefault: row.isDefault,
      devices: row.devices as DeviceProfile[],
      runsPerUrl: row.runsPerUrl,
      categories: row.categories as PsiCategory[],
      markets: row.markets as unknown as MarketsSelection,
      pages: row.pages as unknown as PagesSelection,
      schedule: row.schedule as unknown as ScheduleConfig,
      themePublishTrigger: row.themePublishTrigger,
      thresholds: row.thresholds as unknown as Threshold[],
      notifications: row.notifications as unknown as NotificationsConfig,
    };
  }

  let markets: ResolvedMarket[] = [];
  let marketsError = false;
  try {
    markets = await fetchActiveMarkets(admin.graphql);
  } catch (error) {
    console.error("[profiles] Failed to fetch markets:", error);
    marketsError = true;
  }

  return { profile, markets, marketsError };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const id = params.id ?? "new";

  const formData = await request.formData();
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return {
      errors: { form: "The submitted form data could not be read. Try again." },
    };
  }

  const result = validateProfileInput(payload);
  if (!result.ok) {
    return { errors: result.errors };
  }

  try {
    if (id === "new") {
      await createProfile({ id: shop.id, domain: shop.domain }, result.value);
    } else {
      const existing = await getProfile(shop.id, id);
      if (!existing) {
        throw new Response("Not found", { status: 404 });
      }
      await updateProfile(
        { id: shop.id, domain: shop.domain },
        id,
        result.value,
      );
    }
  } catch (error) {
    if (error instanceof ProfileNameConflictError) {
      return { errors: { name: "A profile with this name already exists." } };
    }
    throw error;
  }

  return { ok: true as const };
};

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

type MarketsMode = MarketsSelection["mode"];
type LocaleMode = MarketsSelection["localeMode"];
type SampleMode = SampledPageSelection["mode"];

interface SampledFormState {
  enabled: boolean;
  mode: SampleMode;
  sampleSize: string;
  handlesText: string;
}

interface ThresholdFormRow {
  id: string;
  metric: ThresholdMetric;
  operator: Threshold["operator"];
  value: string;
  severity: Threshold["severity"];
}

interface FormState {
  name: string;
  isDefault: boolean;
  devices: DeviceProfile[];
  runsPerUrl: string;
  categories: PsiCategory[];
  marketsMode: MarketsMode;
  marketHandles: string[];
  localeMode: LocaleMode;
  homeEnabled: boolean;
  cartEnabled: boolean;
  collections: SampledFormState;
  products: SampledFormState;
  cmsPages: SampledFormState;
  blogs: SampledFormState;
  customEnabled: boolean;
  customUrlsText: string;
  scheduleEnabled: boolean;
  cron: string;
  timezone: string;
  themePublishTrigger: boolean;
  thresholds: ThresholdFormRow[];
  emailsText: string;
  webhookUrl: string;
}

const DEVICE_ORDER: readonly DeviceProfile[] = ["MOBILE", "DESKTOP"];
const CATEGORY_ORDER: readonly PsiCategory[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
];
const CATEGORY_LABELS: Record<PsiCategory, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best practices",
  seo: "SEO",
};
const METRIC_OPTIONS: { value: ThresholdMetric; label: string }[] = [
  { value: "performanceScore", label: "Performance score" },
  { value: "accessibilityScore", label: "Accessibility score" },
  { value: "bestPracticesScore", label: "Best practices score" },
  { value: "seoScore", label: "SEO score" },
  { value: "lcpMs", label: "LCP, ms (lab)" },
  { value: "cls", label: "CLS (lab)" },
  { value: "tbtMs", label: "TBT, ms (lab)" },
  { value: "fieldLcpMs", label: "LCP, ms (field)" },
  { value: "fieldInpMs", label: "INP, ms (field)" },
  { value: "fieldCls", label: "CLS (field)" },
];
const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Monthly (day 1 at 04:00)", value: "0 4 1 * *" },
  { label: "Weekly (Monday at 04:00)", value: "0 4 * * 1" },
  { label: "Daily (at 04:00)", value: "0 4 * * *" },
];

function sampledFormState(
  selection: SampledPageSelection | undefined,
  fallback: SampledPageSelection,
): SampledFormState {
  const src = selection ?? fallback;
  return {
    enabled: src.enabled === true,
    mode: src.mode === "manual" ? "manual" : "auto",
    sampleSize: String(src.sampleSize ?? fallback.sampleSize),
    handlesText: (src.handles ?? []).join(", "),
  };
}

function initialFormState(profile: LoadedProfile | null): FormState {
  const pages = profile?.pages;
  return {
    name: profile?.name ?? "",
    isDefault: profile?.isDefault ?? false,
    devices: profile?.devices ?? ["MOBILE"],
    runsPerUrl: String(profile?.runsPerUrl ?? 3),
    categories: profile?.categories ?? [...CATEGORY_ORDER],
    marketsMode: profile?.markets?.mode ?? "all",
    marketHandles: profile?.markets?.handles ?? [],
    localeMode: profile?.markets?.localeMode ?? "default",
    homeEnabled: pages?.home?.enabled ?? DEFAULT_PAGES_SELECTION.home.enabled,
    cartEnabled: pages?.cart?.enabled ?? DEFAULT_PAGES_SELECTION.cart.enabled,
    collections: sampledFormState(
      pages?.collections,
      DEFAULT_PAGES_SELECTION.collections,
    ),
    products: sampledFormState(
      pages?.products,
      DEFAULT_PAGES_SELECTION.products,
    ),
    cmsPages: sampledFormState(pages?.pages, DEFAULT_PAGES_SELECTION.pages),
    blogs: sampledFormState(pages?.blogs, DEFAULT_PAGES_SELECTION.blogs),
    customEnabled:
      pages?.custom?.enabled ?? DEFAULT_PAGES_SELECTION.custom.enabled,
    customUrlsText: (pages?.custom?.urls ?? []).join("\n"),
    scheduleEnabled: profile?.schedule?.enabled ?? true,
    cron: profile?.schedule?.cron ?? "0 4 1 * *",
    timezone: profile?.schedule?.timezone ?? "UTC",
    themePublishTrigger: profile?.themePublishTrigger ?? true,
    thresholds: (profile?.thresholds ?? []).map((t) => ({
      id: t.id,
      metric: t.metric,
      operator: t.operator,
      value: String(t.value),
      severity: t.severity,
    })),
    emailsText: (profile?.notifications?.emails ?? []).join(", "),
    webhookUrl: profile?.notifications?.webhookUrl ?? "",
  };
}

function splitList(text: string, separator: RegExp): string[] {
  return text
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Builds the JSON payload for the action. Numeric inputs are sent as raw
 * strings — validateProfileInput coerces them and rejects empty values.
 */
function buildPayload(form: FormState) {
  const sampled = (state: SampledFormState) => ({
    enabled: state.enabled,
    mode: state.mode,
    sampleSize: state.sampleSize,
    handles: splitList(state.handlesText, /[,\n]/),
  });
  return {
    name: form.name,
    devices: form.devices,
    runsPerUrl: form.runsPerUrl,
    categories: form.categories,
    markets: {
      mode: form.marketsMode,
      handles: form.marketsMode === "all" ? [] : form.marketHandles,
      localeMode: form.localeMode,
    },
    pages: {
      home: { enabled: form.homeEnabled },
      cart: { enabled: form.cartEnabled },
      collections: sampled(form.collections),
      products: sampled(form.products),
      pages: sampled(form.cmsPages),
      blogs: sampled(form.blogs),
      custom: {
        enabled: form.customEnabled,
        urls: splitList(form.customUrlsText, /\n/),
      },
    },
    schedule: {
      enabled: form.scheduleEnabled,
      cron: form.cron,
      timezone: form.timezone,
    },
    themePublishTrigger: form.themePublishTrigger,
    thresholds: form.thresholds,
    notifications: {
      emails: splitList(form.emailsText, /[,\n]/),
      ...(form.webhookUrl.trim() ? { webhookUrl: form.webhookUrl.trim() } : {}),
    },
    isDefault: form.isDefault,
  };
}

function toggleValue<T>(
  list: T[],
  value: T,
  checked: boolean,
  order: readonly T[],
): T[] {
  const set = new Set(list);
  if (checked) {
    set.add(value);
  } else {
    set.delete(value);
  }
  return order.filter((item) => set.has(item));
}

/** Client-side hint for the custom URLs textarea; the server re-validates. */
function customUrlsHint(text: string): string | null {
  const lines = splitList(text, /\n/);
  for (const [index, line] of lines.entries()) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(line);
    } catch {
      parsed = null;
    }
    if (
      parsed === null ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) {
      return `Line ${index + 1} ("${line}") is not an absolute http(s) URL.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Local components
// ---------------------------------------------------------------------------

function MarketPicker({
  form,
  markets,
  marketsError,
  errors,
  onModeChange,
  onLocaleModeChange,
  onToggleHandle,
}: {
  form: FormState;
  markets: ResolvedMarket[];
  marketsError: boolean;
  errors: Record<string, string>;
  onModeChange: (mode: MarketsMode) => void;
  onLocaleModeChange: (mode: LocaleMode) => void;
  onToggleHandle: (handle: string, checked: boolean) => void;
}) {
  const knownHandles = new Set(markets.map((market) => market.handle));
  const orphanHandles = form.marketHandles.filter(
    (handle) => !knownHandles.has(handle),
  );

  return (
    <s-section heading="Markets">
      {marketsError && (
        <s-banner tone="warning" heading="Markets could not be loaded">
          The market list is temporarily unavailable. You can still save the
          profile; previously selected markets are kept.
        </s-banner>
      )}
      <s-stack direction="block" gap="base">
        <s-select
          label="Market selection"
          value={form.marketsMode}
          error={errors["markets.mode"]}
          onChange={(e) => onModeChange(e.currentTarget.value as MarketsMode)}
        >
          <s-option value="all">All active markets</s-option>
          <s-option value="include">Only selected markets</s-option>
          <s-option value="exclude">All except selected markets</s-option>
        </s-select>
        {form.marketsMode !== "all" && (
          <s-stack direction="block" gap="small-200">
            {markets.length === 0 && orphanHandles.length === 0 ? (
              <s-paragraph>
                No active markets available to choose from.
              </s-paragraph>
            ) : (
              <>
                {markets.map((market) => (
                  <s-checkbox
                    key={market.handle}
                    label={`${market.name} (${market.handle})`}
                    checked={form.marketHandles.includes(market.handle)}
                    onChange={(e) =>
                      onToggleHandle(market.handle, e.currentTarget.checked)
                    }
                  />
                ))}
                {orphanHandles.map((handle) => (
                  <s-checkbox
                    key={handle}
                    label={`${handle} (no longer active)`}
                    checked
                    onChange={(e) =>
                      onToggleHandle(handle, e.currentTarget.checked)
                    }
                  />
                ))}
              </>
            )}
            {errors["markets.handles"] && (
              <s-text tone="critical">{errors["markets.handles"]}</s-text>
            )}
          </s-stack>
        )}
        <s-select
          label="Locales"
          value={form.localeMode}
          details="Audit only each market's default locale, or every localized URL."
          error={errors["markets.localeMode"]}
          onChange={(e) =>
            onLocaleModeChange(e.currentTarget.value as LocaleMode)
          }
        >
          <s-option value="default">Default locale only</s-option>
          <s-option value="all">All locales</s-option>
        </s-select>
      </s-stack>
    </s-section>
  );
}

function PageTypeCard({
  title,
  details,
  fieldKey,
  handlesLabel,
  handlesPlaceholder,
  state,
  errors,
  onChange,
}: {
  title: string;
  details: string;
  fieldKey: "collections" | "products" | "pages" | "blogs";
  handlesLabel: string;
  handlesPlaceholder: string;
  state: SampledFormState;
  errors: Record<string, string>;
  onChange: (patch: Partial<SampledFormState>) => void;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-checkbox
          label={title}
          details={details}
          checked={state.enabled}
          onChange={(e) => onChange({ enabled: e.currentTarget.checked })}
        />
        {state.enabled && (
          <s-stack direction="inline" gap="base">
            <s-select
              label="Selection"
              value={state.mode}
              onChange={(e) =>
                onChange({ mode: e.currentTarget.value as SampleMode })
              }
            >
              <s-option value="auto">Automatic sample</s-option>
              <s-option value="manual">Manual handles</s-option>
            </s-select>
            {state.mode === "auto" && (
              <s-number-field
                label="Sample size"
                value={state.sampleSize}
                min={1}
                max={20}
                error={errors[`pages.${fieldKey}.sampleSize`]}
                onChange={(e) =>
                  onChange({ sampleSize: e.currentTarget.value })
                }
              />
            )}
          </s-stack>
        )}
        {state.enabled && state.mode === "manual" && (
          <s-text-area
            label={handlesLabel}
            value={state.handlesText}
            rows={2}
            placeholder={handlesPlaceholder}
            details="Comma-separated handles."
            error={errors[`pages.${fieldKey}.handles`]}
            onChange={(e) => onChange({ handlesText: e.currentTarget.value })}
          />
        )}
      </s-stack>
    </s-box>
  );
}

function ThresholdRow({
  row,
  index,
  errors,
  onChange,
  onRemove,
}: {
  row: ThresholdFormRow;
  index: number;
  errors: Record<string, string>;
  onChange: (index: number, patch: Partial<ThresholdFormRow>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <s-stack direction="inline" gap="base" alignItems="end">
      <s-select
        label="Metric"
        value={row.metric}
        error={errors[`thresholds.${index}.metric`]}
        onChange={(e) =>
          onChange(index, { metric: e.currentTarget.value as ThresholdMetric })
        }
      >
        {METRIC_OPTIONS.map((option) => (
          <s-option key={option.value} value={option.value}>
            {option.label}
          </s-option>
        ))}
      </s-select>
      <s-select
        label="Alert when"
        value={row.operator}
        error={errors[`thresholds.${index}.operator`]}
        onChange={(e) =>
          onChange(index, {
            operator: e.currentTarget.value as Threshold["operator"],
          })
        }
      >
        <s-option value="lt">Below</s-option>
        <s-option value="gt">Above</s-option>
      </s-select>
      <s-number-field
        label="Value"
        value={row.value}
        min={0}
        error={errors[`thresholds.${index}.value`]}
        onChange={(e) => onChange(index, { value: e.currentTarget.value })}
      />
      <s-select
        label="Severity"
        value={row.severity}
        error={errors[`thresholds.${index}.severity`]}
        onChange={(e) =>
          onChange(index, {
            severity: e.currentTarget.value as Threshold["severity"],
          })
        }
      >
        <s-option value="warning">Warning</s-option>
        <s-option value="critical">Critical</s-option>
      </s-select>
      <s-button
        variant="tertiary"
        tone="critical"
        icon="delete"
        accessibilityLabel="Remove threshold"
        onClick={() => onRemove(index)}
      >
        Remove
      </s-button>
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProfileEditor() {
  const { profile, markets, marketsError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const isNew = profile === null;

  const [form, setForm] = useState<FormState>(() => initialFormState(profile));
  const saving = fetcher.state !== "idle";
  const errors: Record<string, string> =
    (fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : undefined) ??
    {};
  const errorMessages = [...new Set(Object.values(errors))];

  useEffect(() => {
    if (fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      shopify.toast.show(isNew ? "Profile created" : "Profile saved");
      navigate("/app/profiles");
    }
  }, [fetcher.data, isNew, navigate, shopify]);

  const update = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));
  const updateSampled = (
    key: "collections" | "products" | "cmsPages" | "blogs",
    patch: Partial<SampledFormState>,
  ) => setForm((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const changeThreshold = (index: number, patch: Partial<ThresholdFormRow>) =>
    setForm((prev) => ({
      ...prev,
      thresholds: prev.thresholds.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));
  const removeThreshold = (index: number) =>
    setForm((prev) => ({
      ...prev,
      thresholds: prev.thresholds.filter((_, i) => i !== index),
    }));
  const addThreshold = () =>
    setForm((prev) => ({
      ...prev,
      thresholds: [
        ...prev.thresholds,
        {
          id: crypto.randomUUID(),
          metric: "performanceScore",
          operator: "lt",
          value: "70",
          severity: "warning",
        },
      ],
    }));

  const timezones = useMemo(() => {
    let zones: string[] = [];
    try {
      zones = Intl.supportedValuesOf("timeZone");
    } catch {
      zones = [];
    }
    const set = new Set(["UTC", ...zones]);
    if (form.timezone) set.add(form.timezone);
    return [...set];
  }, [form.timezone]);

  const presetValue = CRON_PRESETS.some((preset) => preset.value === form.cron)
    ? form.cron
    : "custom";
  const urlsHint = form.customEnabled
    ? customUrlsHint(form.customUrlsText)
    : null;

  const save = () =>
    fetcher.submit(
      { payload: JSON.stringify(buildPayload(form)) },
      { method: "POST" },
    );

  return (
    <s-page heading={isNew ? "New audit profile" : profile.name}>
      <s-link slot="breadcrumb-actions" href="/app/profiles">
        Audit profiles
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        {...(saving ? { loading: true } : {})}
      >
        Save
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => navigate("/app/profiles")}
      >
        Cancel
      </s-button>

      {errorMessages.length > 0 && (
        <s-banner tone="critical" heading="The profile could not be saved">
          <s-stack direction="block" gap="small-200">
            {errorMessages.map((message) => (
              <s-text key={message}>{message}</s-text>
            ))}
          </s-stack>
        </s-banner>
      )}

      <s-section heading="Basics">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Name"
            value={form.name}
            placeholder="e.g. Monthly storefront check"
            error={errors.name}
            onChange={(e) => update({ name: e.currentTarget.value })}
          />
          <s-checkbox
            label="Use as default profile"
            details="The default profile is preselected for manual runs."
            checked={form.isDefault}
            onChange={(e) => update({ isDefault: e.currentTarget.checked })}
          />
        </s-stack>
      </s-section>

      <s-section heading="Devices & sampling">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            {DEVICE_ORDER.map((device) => (
              <s-checkbox
                key={device}
                label={device === "MOBILE" ? "Mobile" : "Desktop"}
                checked={form.devices.includes(device)}
                onChange={(e) =>
                  update({
                    devices: toggleValue(
                      form.devices,
                      device,
                      e.currentTarget.checked,
                      DEVICE_ORDER,
                    ),
                  })
                }
              />
            ))}
          </s-stack>
          {errors.devices && <s-text tone="critical">{errors.devices}</s-text>}
          <s-select
            label="Runs per URL"
            value={form.runsPerUrl}
            details="Lighthouse runs per URL; the median is stored to reduce variance."
            error={errors.runsPerUrl}
            onChange={(e) => update({ runsPerUrl: e.currentTarget.value })}
          >
            {["1", "2", "3", "4", "5"].map((n) => (
              <s-option key={n} value={n}>
                {n}
              </s-option>
            ))}
          </s-select>
          <s-stack direction="inline" gap="base">
            {CATEGORY_ORDER.map((category) => (
              <s-checkbox
                key={category}
                label={CATEGORY_LABELS[category]}
                checked={form.categories.includes(category)}
                onChange={(e) =>
                  update({
                    categories: toggleValue(
                      form.categories,
                      category,
                      e.currentTarget.checked,
                      CATEGORY_ORDER,
                    ),
                  })
                }
              />
            ))}
          </s-stack>
          {errors.categories && (
            <s-text tone="critical">{errors.categories}</s-text>
          )}
        </s-stack>
      </s-section>

      <MarketPicker
        form={form}
        markets={markets}
        marketsError={marketsError}
        errors={errors}
        onModeChange={(mode) => update({ marketsMode: mode })}
        onLocaleModeChange={(mode) => update({ localeMode: mode })}
        onToggleHandle={(handle, checked) =>
          update({
            marketHandles: checked
              ? [...form.marketHandles, handle]
              : form.marketHandles.filter((h) => h !== handle),
          })
        }
      />

      <s-section heading="Pages">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-checkbox
              label="Home page"
              checked={form.homeEnabled}
              onChange={(e) => update({ homeEnabled: e.currentTarget.checked })}
            />
            <s-checkbox
              label="Cart page"
              checked={form.cartEnabled}
              onChange={(e) => update({ cartEnabled: e.currentTarget.checked })}
            />
          </s-stack>
          <PageTypeCard
            title="Collections"
            details="Collection listing pages."
            fieldKey="collections"
            handlesLabel="Collection handles"
            handlesPlaceholder="summer-sale, best-sellers"
            state={form.collections}
            errors={errors}
            onChange={(patch) => updateSampled("collections", patch)}
          />
          <PageTypeCard
            title="Products"
            details="Product detail pages."
            fieldKey="products"
            handlesLabel="Product handles"
            handlesPlaceholder="classic-tee, gift-card"
            state={form.products}
            errors={errors}
            onChange={(patch) => updateSampled("products", patch)}
          />
          <PageTypeCard
            title="CMS pages"
            details="Pages created under Online Store > Pages."
            fieldKey="pages"
            handlesLabel="Page handles"
            handlesPlaceholder="about-us, contact"
            state={form.cmsPages}
            errors={errors}
            onChange={(patch) => updateSampled("cmsPages", patch)}
          />
          <PageTypeCard
            title="Blogs"
            details="Blog index pages."
            fieldKey="blogs"
            handlesLabel="Blog handles"
            handlesPlaceholder="news"
            state={form.blogs}
            errors={errors}
            onChange={(patch) => updateSampled("blogs", patch)}
          />
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-checkbox
                label="Custom URLs"
                details="Audit specific URLs, e.g. landing pages."
                checked={form.customEnabled}
                onChange={(e) =>
                  update({ customEnabled: e.currentTarget.checked })
                }
              />
              {form.customEnabled && (
                <>
                  <s-text-area
                    label="URLs (one per line)"
                    value={form.customUrlsText}
                    rows={4}
                    placeholder={"https://example.com/landing\nhttps://example.com/promo"}
                    error={errors["pages.custom.urls"]}
                    onChange={(e) =>
                      update({ customUrlsText: e.currentTarget.value })
                    }
                  />
                  {urlsHint && !errors["pages.custom.urls"] && (
                    <s-text tone="caution">{urlsHint}</s-text>
                  )}
                </>
              )}
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Scheduling">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Run on a schedule"
            checked={form.scheduleEnabled}
            onChange={(e) =>
              update({ scheduleEnabled: e.currentTarget.checked })
            }
          />
          <s-stack direction="inline" gap="base">
            <s-select
              label="Preset"
              value={presetValue}
              onChange={(e) => {
                const value = e.currentTarget.value;
                if (value !== "custom") update({ cron: value });
              }}
            >
              {CRON_PRESETS.map((preset) => (
                <s-option key={preset.value} value={preset.value}>
                  {preset.label}
                </s-option>
              ))}
              <s-option value="custom">Custom</s-option>
            </s-select>
            <s-text-field
              label="Cron pattern"
              value={form.cron}
              details='5 fields: minute hour day-of-month month day-of-week. "0 4 1 * *" = day 1 of every month at 04:00.'
              error={errors["schedule.cron"]}
              onChange={(e) => update({ cron: e.currentTarget.value })}
            />
          </s-stack>
          <s-select
            label="Timezone"
            value={form.timezone}
            error={errors["schedule.timezone"]}
            onChange={(e) => update({ timezone: e.currentTarget.value })}
          >
            {timezones.map((zone) => (
              <s-option key={zone} value={zone}>
                {zone}
              </s-option>
            ))}
          </s-select>
          <s-checkbox
            label="Run when a theme is published"
            details="Starts an audit automatically after a theme goes live, so you can compare before/after."
            checked={form.themePublishTrigger}
            onChange={(e) =>
              update({ themePublishTrigger: e.currentTarget.checked })
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Thresholds">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Alerts are raised when a completed run crosses any of these
            budgets.
          </s-paragraph>
          {form.thresholds.map((row, index) => (
            <ThresholdRow
              key={row.id}
              row={row}
              index={index}
              errors={errors}
              onChange={changeThreshold}
              onRemove={removeThreshold}
            />
          ))}
          <s-stack direction="inline" gap="base">
            <s-button icon="plus" onClick={addThreshold}>
              Add threshold
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Notifications">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Alert emails"
            value={form.emailsText}
            placeholder="owner@example.com, dev@example.com"
            details="Comma-separated. Leave empty to disable email alerts."
            error={errors["notifications.emails"]}
            onChange={(e) => update({ emailsText: e.currentTarget.value })}
          />
          <s-text-field
            label="Webhook URL"
            value={form.webhookUrl}
            placeholder="https://hooks.example.com/performify"
            details="Optional. Alerts are POSTed as JSON; must be https."
            error={errors["notifications.webhookUrl"]}
            onChange={(e) => update({ webhookUrl: e.currentTarget.value })}
          />
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <s-page heading="Not found">
        <s-section accessibilityLabel="Not found">
          <s-banner tone="critical" heading="This profile no longer exists">
            <s-paragraph>
              It may have been deleted.{" "}
              <s-link href="/app/profiles">View all profiles</s-link>
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
