// Shop-level settings: report language, per-shop PSI API key override, and a
// read-only view of the deployment-wide PSI limits.

import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shops.server";
import { env } from "../lib/env.server";
import prisma from "../db.server";

interface ShopSettings {
  locale?: string;
  psiApiKey?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const settings = (shop.settings ?? {}) as ShopSettings;

  return {
    locale: settings.locale === "it" ? "it" : "en",
    psiApiKey: settings.psiApiKey ?? "",
    psiDailyQuota: env.psiDailyQuota(),
    psiPerMinuteLimit: env.psiPerMinuteLimit(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const raw = (await request.formData()).get("payload");
  if (typeof raw !== "string") {
    return { ok: false as const, error: "Missing settings payload." };
  }

  let parsed: { locale?: unknown; psiApiKey?: unknown };
  try {
    parsed = JSON.parse(raw) as { locale?: unknown; psiApiKey?: unknown };
  } catch {
    return { ok: false as const, error: "Invalid settings payload." };
  }

  const locale = parsed.locale;
  if (locale !== "en" && locale !== "it") {
    return {
      ok: false as const,
      error: "Report language must be English (en) or Italian (it).",
    };
  }

  const psiApiKey =
    typeof parsed.psiApiKey === "string" ? parsed.psiApiKey.trim() : "";
  if (psiApiKey.length > 200) {
    return {
      ok: false as const,
      error: "The PSI API key must be at most 200 characters.",
    };
  }

  const current = (shop.settings ?? {}) as Record<string, unknown>;
  const settings: Record<string, unknown> = { ...current, locale };
  if (psiApiKey) {
    settings.psiApiKey = psiApiKey;
  } else {
    delete settings.psiApiKey;
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: { settings: settings as Prisma.InputJsonObject },
  });

  return { ok: true as const };
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [locale, setLocale] = useState<string>(data.locale);
  const [psiApiKey, setPsiApiKey] = useState<string>(data.psiApiKey);

  const saving =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("Settings saved");
    }
  }, [fetcher.data, shopify]);

  const save = () => {
    fetcher.submit(
      { payload: JSON.stringify({ locale, psiApiKey }) },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Settings">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        {...(saving ? { loading: true } : {})}
      >
        Save
      </s-button>

      {error && (
        <s-banner tone="critical" heading="Could not save settings">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      )}

      <s-section heading="Report preferences">
        <s-select
          label="Report language"
          value={locale}
          onChange={(event) => setLocale(event.currentTarget.value)}
        >
          <s-option value="en">English</s-option>
          <s-option value="it">Italiano</s-option>
        </s-select>
        <s-paragraph>
          Used for the descriptive report generated with each audit run.
        </s-paragraph>
      </s-section>

      <s-section heading="PageSpeed Insights">
        <s-password-field
          label="PSI API key override"
          details="Leave empty to use the deployment-wide key"
          value={psiApiKey}
          maxLength={200}
          onInput={(event) => setPsiApiKey(event.currentTarget.value)}
        />
      </s-section>

      <s-section slot="aside" heading="Deployment limits">
        <s-paragraph>
          These limits apply to the whole deployment and can only be changed by
          the app operator.
        </s-paragraph>
        <s-paragraph>
          <s-text>Daily PSI quota: </s-text>
          <s-text type="strong">
            {data.psiDailyQuota.toLocaleString("en-US")} requests
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>Per-minute limit: </s-text>
          <s-text type="strong">{data.psiPerMinuteLimit} requests</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
