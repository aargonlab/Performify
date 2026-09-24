// ---------------------------------------------------------------------------
// Pure URL building: markets × page selection × samples → audit targets.
// No I/O — unit-testable. Services resolve markets/samples and call in here.
// ---------------------------------------------------------------------------

import type {
  AuditTargetUrl,
  MarketsSelection,
  PageTypeKey,
  PagesSelection,
  ResolvedMarket,
  SampledPageSelection,
} from "../types";

/** Storefront samples resolved at run time (see app/services/sampling.server.ts). */
export interface SampleData {
  collections: { handle: string; title: string }[];
  products: { handle: string; title: string }[];
  pages: { handle: string; title: string }[];
  blogs: { blogHandle: string; articleHandle?: string; title: string }[];
}

/** Fixed emission/sort order for page types within a market. */
const PAGE_TYPE_ORDER: PageTypeKey[] = [
  "HOME",
  "CART",
  "COLLECTION",
  "PRODUCT",
  "PAGE",
  "BLOG",
  "ARTICLE",
  "CUSTOM",
];

interface OrderedTarget {
  target: AuditTargetUrl;
  marketIndex: number;
  typeRank: number;
  handle: string;
}

/**
 * Validates a user-supplied custom URL. Returns an error message for the UI,
 * or null when the URL is an absolute http(s) URL.
 */
export function validateCustomUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return "Enter a URL.";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Enter an absolute URL, e.g. https://example.com/page.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http:// and https:// URLs are supported.";
  }
  return null;
}

/** Strips trailing slashes so joins never produce double slashes. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Joins a base URL (no trailing slash) with an absolute path ("/x/y"). */
function joinUrl(base: string, path: string): string {
  const cleanBase = stripTrailingSlash(base);
  return path ? `${cleanBase}${path.startsWith("/") ? path : `/${path}`}` : cleanBase;
}

function filterMarkets(
  markets: ResolvedMarket[],
  selection: MarketsSelection,
): ResolvedMarket[] {
  if (selection.mode === "include") {
    const wanted = new Set(selection.handles);
    return markets.filter((m) => wanted.has(m.handle));
  }
  if (selection.mode === "exclude") {
    const dropped = new Set(selection.handles);
    return markets.filter((m) => !dropped.has(m.handle));
  }
  return markets;
}

function pickRootUrls(
  market: ResolvedMarket,
  localeMode: MarketsSelection["localeMode"],
): ResolvedMarket["rootUrls"] {
  if (market.rootUrls.length === 0) {
    return [];
  }
  if (localeMode === "all") {
    return market.rootUrls;
  }
  const primary = market.rootUrls.find((r) => r.primary);
  return [primary ?? market.rootUrls[0]];
}

/**
 * Resolves the handles to audit for one sampled page type.
 * Manual mode uses the explicit handles; auto mode uses the fetched samples
 * capped at sampleSize. Titles from samples become labels when available.
 */
function resolveHandles(
  sel: SampledPageSelection,
  samples: { handle: string; title: string }[],
): { handle: string; title?: string }[] {
  const titleByHandle = new Map(samples.map((s) => [s.handle, s.title]));
  if (sel.mode === "manual") {
    const unique = [...new Set(sel.handles.map((h) => h.trim()).filter(Boolean))];
    return unique.map((handle) => ({ handle, title: titleByHandle.get(handle) }));
  }
  return samples
    .slice(0, Math.max(0, sel.sampleSize))
    .map((s) => ({ handle: s.handle, title: s.title }));
}

/**
 * Builds the full list of URLs to audit for a run:
 * filtered markets × selected locales × enabled page types (+ global custom URLs).
 * Deduped by url+market+locale; deterministic order (market, pageType, handle).
 */
export function buildAuditTargets(
  markets: ResolvedMarket[],
  selection: MarketsSelection,
  pages: PagesSelection,
  samples: SampleData,
): AuditTargetUrl[] {
  const ordered: OrderedTarget[] = [];

  const push = (
    marketIndex: number,
    pageType: PageTypeKey,
    handle: string,
    target: AuditTargetUrl,
  ) => {
    ordered.push({
      target,
      marketIndex,
      typeRank: PAGE_TYPE_ORDER.indexOf(pageType),
      handle,
    });
  };

  const activeMarkets = filterMarkets(markets, selection);

  activeMarkets.forEach((market, marketIndex) => {
    const common = { marketHandle: market.handle, marketName: market.name };

    for (const root of pickRootUrls(market, selection.localeMode)) {
      const base = stripTrailingSlash(root.url);
      if (!base) {
        continue;
      }
      const loc = { ...common, locale: root.locale };

      if (pages.home.enabled) {
        push(marketIndex, "HOME", "", { url: base, pageType: "HOME", ...loc });
      }
      if (pages.cart.enabled) {
        push(marketIndex, "CART", "", {
          url: joinUrl(base, "/cart"),
          pageType: "CART",
          ...loc,
        });
      }
      if (pages.collections.enabled) {
        for (const { handle, title } of resolveHandles(
          pages.collections,
          samples.collections,
        )) {
          push(marketIndex, "COLLECTION", handle, {
            url: joinUrl(base, `/collections/${handle}`),
            pageType: "COLLECTION",
            label: title,
            ...loc,
          });
        }
      }
      if (pages.products.enabled) {
        for (const { handle, title } of resolveHandles(
          pages.products,
          samples.products,
        )) {
          push(marketIndex, "PRODUCT", handle, {
            url: joinUrl(base, `/products/${handle}`),
            pageType: "PRODUCT",
            label: title,
            ...loc,
          });
        }
      }
      if (pages.pages.enabled) {
        for (const { handle, title } of resolveHandles(pages.pages, samples.pages)) {
          push(marketIndex, "PAGE", handle, {
            url: joinUrl(base, `/pages/${handle}`),
            pageType: "PAGE",
            label: title,
            ...loc,
          });
        }
      }
      if (pages.blogs.enabled) {
        for (const entry of resolveBlogEntries(pages.blogs, samples.blogs)) {
          const pageType: PageTypeKey = entry.articleHandle ? "ARTICLE" : "BLOG";
          const path = entry.articleHandle
            ? `/blogs/${entry.blogHandle}/${entry.articleHandle}`
            : `/blogs/${entry.blogHandle}`;
          push(marketIndex, pageType, `${entry.blogHandle}/${entry.articleHandle ?? ""}`, {
            url: joinUrl(base, path),
            pageType,
            label: entry.title,
            ...loc,
          });
        }
      }
    }
  });

  // Custom URLs are absolute and market-agnostic: emitted once, verbatim.
  if (pages.custom.enabled) {
    const customIndex = activeMarkets.length; // sorts after every market
    for (const raw of pages.custom.urls) {
      const url = raw.trim();
      if (validateCustomUrl(url) !== null) {
        continue;
      }
      push(customIndex, "CUSTOM", url, { url, pageType: "CUSTOM" });
    }
  }

  // Deterministic order: market, then pageType, then handle
  // (stable sort keeps locale emission order for ties; plain codepoint
  // comparison so the order does not depend on the runtime locale).
  ordered.sort(
    (a, b) =>
      a.marketIndex - b.marketIndex ||
      a.typeRank - b.typeRank ||
      (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0),
  );

  // Dedupe by final url + market + locale (first occurrence wins).
  const seen = new Set<string>();
  const targets: AuditTargetUrl[] = [];
  for (const { target } of ordered) {
    const key = `${target.url}|${target.marketHandle ?? ""}|${target.locale ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

/**
 * Blog entries to audit. Manual mode audits the listed blog indexes;
 * auto mode keeps up to sampleSize distinct blogs from the samples,
 * each with its index and latest article entry.
 */
function resolveBlogEntries(
  sel: SampledPageSelection,
  samples: SampleData["blogs"],
): { blogHandle: string; articleHandle?: string; title?: string }[] {
  if (sel.mode === "manual") {
    const unique = [...new Set(sel.handles.map((h) => h.trim()).filter(Boolean))];
    return unique.map((blogHandle) => ({ blogHandle }));
  }
  const keptBlogs = new Set<string>();
  const entries: { blogHandle: string; articleHandle?: string; title?: string }[] = [];
  for (const sample of samples) {
    if (!keptBlogs.has(sample.blogHandle) && keptBlogs.size >= Math.max(0, sel.sampleSize)) {
      continue;
    }
    keptBlogs.add(sample.blogHandle);
    entries.push(sample);
  }
  return entries;
}
