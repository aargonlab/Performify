// ---------------------------------------------------------------------------
// Admin GraphQL access for markets + shared query runner with THROTTLED retry.
// Query validated against the 2026-07 Admin schema (webPresences — the
// singular webPresence field is deprecated).
// ---------------------------------------------------------------------------

import type { ResolvedMarket } from "../lib/types";

/** Shape of the `admin.graphql` function from authenticate.admin(). */
export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

const THROTTLED_MAX_RETRIES = 3;
const THROTTLED_FALLBACK_DELAY_MS = 1500;
const MARKETS_PAGE_SIZE = 50;

interface GraphqlError {
  message?: string;
  extensions?: { code?: string; [key: string]: unknown };
}

interface GraphqlCostExtension {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: {
    maximumAvailable?: number;
    currentlyAvailable?: number;
    restoreRate?: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay before retrying a THROTTLED request. When cost info is present we
 * wait until enough points are restored; otherwise a flat 1.5s.
 */
function throttledDelayMs(cost: GraphqlCostExtension | undefined): number {
  const requested = cost?.requestedQueryCost;
  const available = cost?.throttleStatus?.currentlyAvailable;
  const restoreRate = cost?.throttleStatus?.restoreRate;
  if (
    typeof requested === "number" &&
    typeof available === "number" &&
    typeof restoreRate === "number" &&
    restoreRate > 0
  ) {
    const missing = Math.max(0, requested - available);
    return Math.min(10_000, Math.max(1000, Math.ceil(missing / restoreRate) * 1000));
  }
  return THROTTLED_FALLBACK_DELAY_MS;
}

/**
 * admin.graphql THROWS GraphqlQueryError (from @shopify/shopify-api, a
 * transitive dep — duck-typed here) when a 200 response carries GraphQL
 * errors; it does not return them in the body. The thrown error carries the
 * parsed body: errors.graphQLErrors[].extensions.code and extensions.cost.
 */
function thrownThrottleInfo(
  error: unknown,
): { throttled: true; cost?: GraphqlCostExtension } | { throttled: false } {
  const body = (
    error as {
      body?: {
        errors?: { graphQLErrors?: GraphqlError[] };
        extensions?: { cost?: GraphqlCostExtension };
      };
    } | null
  )?.body;
  const graphQLErrors = body?.errors?.graphQLErrors;
  if (
    Array.isArray(graphQLErrors) &&
    graphQLErrors.some((e) => e?.extensions?.code === "THROTTLED")
  ) {
    return { throttled: true, cost: body?.extensions?.cost };
  }
  return { throttled: false };
}

/** Throws when any mutation payload in `data` carries non-empty userErrors. */
function assertNoUserErrors(data: Record<string, unknown> | null | undefined): void {
  if (!data) {
    return;
  }
  for (const [field, value] of Object.entries(data)) {
    const userErrors = (value as { userErrors?: { message?: string }[] } | null)
      ?.userErrors;
    if (Array.isArray(userErrors) && userErrors.length > 0) {
      const messages = userErrors
        .map((e) => e.message ?? "unknown error")
        .join("; ");
      throw new Error(`Admin GraphQL userErrors on ${field}: ${messages}`);
    }
  }
}

/**
 * Runs an Admin GraphQL operation, parses the JSON body, throws on
 * errors/userErrors and retries THROTTLED responses (up to 3 times, waiting
 * for cost restoration when the cost extension is present). Returns `data`.
 */
export async function runAdminGraphql(
  graphql: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GraphQL payloads are shaped per query; callers narrow them
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await graphql(query, variables ? { variables } : undefined);
    } catch (error) {
      const info = thrownThrottleInfo(error);
      if (info.throttled && attempt < THROTTLED_MAX_RETRIES) {
        await sleep(throttledDelayMs(info.cost));
        continue;
      }
      throw error;
    }
    const body = (await response.json()) as {
      data?: Record<string, unknown> | null;
      errors?: GraphqlError[];
      extensions?: { cost?: GraphqlCostExtension };
    };

    // Defensive fallback: current clients throw on GraphQL errors (handled
    // above), but keep handling errors returned in the body just in case.
    const errors = body.errors ?? [];
    if (errors.length > 0) {
      const throttled = errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < THROTTLED_MAX_RETRIES) {
        await sleep(throttledDelayMs(body.extensions?.cost));
        continue;
      }
      const messages = errors.map((e) => e.message ?? "unknown error").join("; ");
      throw new Error(`Admin GraphQL errors: ${messages}`);
    }

    assertNoUserErrors(body.data);
    return body.data;
  }
}

const ACTIVE_MARKETS_QUERY = `#graphql
  query ActiveMarkets($first: Int!, $after: String) {
    markets(first: $first, after: $after, query: "status:ACTIVE", sortKey: NAME) {
      nodes {
        id
        name
        handle
        webPresences(first: 10) {
          nodes {
            domain { host url }
            subfolderSuffix
            defaultLocale { locale }
            rootUrls { locale url }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface MarketNode {
  id: string;
  name: string;
  handle: string;
  webPresences: {
    nodes: {
      domain: { host: string; url: string } | null;
      subfolderSuffix: string | null;
      defaultLocale: { locale: string } | null;
      rootUrls: { locale: string; url: string }[];
    }[];
  } | null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function toResolvedMarket(node: MarketNode): ResolvedMarket {
  const rootUrls: ResolvedMarket["rootUrls"] = [];
  const seen = new Set<string>();

  for (const presence of node.webPresences?.nodes ?? []) {
    const defaultLocale = presence.defaultLocale?.locale ?? null;
    for (const root of presence.rootUrls ?? []) {
      const url = stripTrailingSlash(root.url);
      if (!url) {
        continue;
      }
      const key = `${root.locale}|${url}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rootUrls.push({
        locale: root.locale,
        url,
        primary: defaultLocale !== null && root.locale === defaultLocale,
      });
    }
  }

  return { handle: node.handle, name: node.name, rootUrls };
}

/**
 * Fetches every ACTIVE market with its web presences and returns the
 * localized storefront base URLs (no trailing slash) per market.
 */
export async function fetchActiveMarkets(
  graphql: AdminGraphql,
): Promise<ResolvedMarket[]> {
  const markets: ResolvedMarket[] = [];
  let after: string | null = null;

  for (;;) {
    const data = await runAdminGraphql(graphql, ACTIVE_MARKETS_QUERY, {
      first: MARKETS_PAGE_SIZE,
      after,
    });
    const connection = data?.markets as
      | {
          nodes: MarketNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        }
      | undefined;
    if (!connection) {
      break;
    }
    for (const node of connection.nodes) {
      markets.push(toResolvedMarket(node));
    }
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
      break;
    }
    after = connection.pageInfo.endCursor;
  }

  return markets;
}

const PRIMARY_DOMAIN_QUERY = `#graphql
  query PrimaryDomainFallback {
    shop {
      primaryDomain {
        url
      }
    }
    shopLocales {
      locale
      primary
    }
  }
`;

/**
 * Fallback when no active market exposes web presences/rootUrls — common on
 * development stores and shops on the unified Markets model, where the
 * primary market can have no explicit web presence. Audits the shop's
 * primary domain as a single pseudo-market.
 */
export async function fetchPrimaryDomainMarket(
  graphql: AdminGraphql,
): Promise<ResolvedMarket | null> {
  const data = await runAdminGraphql(graphql, PRIMARY_DOMAIN_QUERY);
  const url = data?.shop?.primaryDomain?.url;
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  const locales = Array.isArray(data?.shopLocales) ? data.shopLocales : [];
  const primaryLocale = locales.find(
    (l: { locale?: string; primary?: boolean }) => l?.primary === true,
  )?.locale;
  return {
    handle: "primary",
    name: "Primary domain",
    rootUrls: [
      {
        locale: typeof primaryLocale === "string" ? primaryLocale : "default",
        url: stripTrailingSlash(url),
        primary: true,
      },
    ],
  };
}
