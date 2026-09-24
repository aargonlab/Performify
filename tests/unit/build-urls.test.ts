import { describe, expect, it } from "vitest";

import type {
  MarketsSelection,
  PagesSelection,
  ResolvedMarket,
} from "../../app/lib/types";
import type { SampleData } from "../../app/lib/urls/build-urls";
import {
  buildAuditTargets,
  validateCustomUrl,
} from "../../app/lib/urls/build-urls";

function makeMarket(
  handle: string,
  rootUrls: ResolvedMarket["rootUrls"] = [
    { locale: "en", url: `https://${handle}.example.com`, primary: true },
  ],
): ResolvedMarket {
  return { handle, name: handle.toUpperCase(), rootUrls };
}

function makeSelection(
  overrides: Partial<MarketsSelection> = {},
): MarketsSelection {
  return { mode: "all", handles: [], localeMode: "default", ...overrides };
}

function makePages(overrides: Partial<PagesSelection> = {}): PagesSelection {
  return {
    home: { enabled: false },
    cart: { enabled: false },
    collections: { enabled: false, mode: "auto", sampleSize: 3, handles: [] },
    products: { enabled: false, mode: "auto", sampleSize: 3, handles: [] },
    pages: { enabled: false, mode: "manual", sampleSize: 3, handles: [] },
    blogs: { enabled: false, mode: "auto", sampleSize: 1, handles: [] },
    custom: { enabled: false, urls: [] },
    ...overrides,
  };
}

const NO_SAMPLES: SampleData = {
  collections: [],
  products: [],
  pages: [],
  blogs: [],
};

const HOME_ONLY = makePages({ home: { enabled: true } });

describe("buildAuditTargets — market filtering", () => {
  const markets = [makeMarket("us"), makeMarket("eu"), makeMarket("apac")];

  it("keeps every market in all mode", () => {
    const targets = buildAuditTargets(
      markets,
      makeSelection({ mode: "all" }),
      HOME_ONLY,
      NO_SAMPLES,
    );
    expect(targets.map((t) => t.marketHandle)).toEqual(["us", "eu", "apac"]);
  });

  it("keeps only the listed markets in include mode", () => {
    const targets = buildAuditTargets(
      markets,
      makeSelection({ mode: "include", handles: ["eu"] }),
      HOME_ONLY,
      NO_SAMPLES,
    );
    expect(targets.map((t) => t.marketHandle)).toEqual(["eu"]);
  });

  it("drops the listed markets in exclude mode", () => {
    const targets = buildAuditTargets(
      markets,
      makeSelection({ mode: "exclude", handles: ["eu"] }),
      HOME_ONLY,
      NO_SAMPLES,
    );
    expect(targets.map((t) => t.marketHandle)).toEqual(["us", "apac"]);
  });

  it("emits nothing for a market without root URLs", () => {
    const targets = buildAuditTargets(
      [makeMarket("empty", [])],
      makeSelection(),
      HOME_ONLY,
      NO_SAMPLES,
    );
    expect(targets).toEqual([]);
  });
});

describe("buildAuditTargets — locale modes", () => {
  const market = makeMarket("eu", [
    { locale: "en", url: "https://example.com/en-eu", primary: false },
    { locale: "it", url: "https://example.com/it-eu", primary: true },
  ]);

  it("default mode keeps only the primary root URL", () => {
    const targets = buildAuditTargets(
      [market],
      makeSelection({ localeMode: "default" }),
      HOME_ONLY,
      NO_SAMPLES,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].locale).toBe("it");
    expect(targets[0].url).toBe("https://example.com/it-eu");
  });

  it("default mode falls back to the first root URL when none is primary", () => {
    const noPrimary = makeMarket("eu", [
      { locale: "en", url: "https://example.com/en-eu", primary: false },
      { locale: "it", url: "https://example.com/it-eu", primary: false },
    ]);
    const targets = buildAuditTargets(
      [noPrimary],
      makeSelection({ localeMode: "default" }),
      HOME_ONLY,
      NO_SAMPLES,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].locale).toBe("en");
  });

  it("all mode emits one target per localized root URL", () => {
    const targets = buildAuditTargets(
      [market],
      makeSelection({ localeMode: "all" }),
      HOME_ONLY,
      NO_SAMPLES,
    );
    expect(targets.map((t) => t.locale)).toEqual(["en", "it"]);
  });
});

describe("buildAuditTargets — page type URL shapes", () => {
  const market = makeMarket("main", [
    { locale: "en", url: "https://shop.example.com", primary: true },
  ]);
  const samples: SampleData = {
    collections: [{ handle: "summer", title: "Summer Sale" }],
    products: [{ handle: "tee", title: "Basic Tee" }],
    pages: [{ handle: "about", title: "About us" }],
    blogs: [
      { blogHandle: "news", title: "News" },
      { blogHandle: "news", articleHandle: "latest-post", title: "Latest" },
    ],
  };
  const pages = makePages({
    home: { enabled: true },
    cart: { enabled: true },
    collections: { enabled: true, mode: "auto", sampleSize: 3, handles: [] },
    products: { enabled: true, mode: "auto", sampleSize: 3, handles: [] },
    pages: { enabled: true, mode: "auto", sampleSize: 3, handles: [] },
    blogs: { enabled: true, mode: "auto", sampleSize: 1, handles: [] },
  });

  it("builds the expected URL for every page type", () => {
    const targets = buildAuditTargets([market], makeSelection(), pages, samples);
    expect(targets.map((t) => [t.pageType, t.url])).toEqual([
      ["HOME", "https://shop.example.com"],
      ["CART", "https://shop.example.com/cart"],
      ["COLLECTION", "https://shop.example.com/collections/summer"],
      ["PRODUCT", "https://shop.example.com/products/tee"],
      ["PAGE", "https://shop.example.com/pages/about"],
      ["BLOG", "https://shop.example.com/blogs/news"],
      ["ARTICLE", "https://shop.example.com/blogs/news/latest-post"],
    ]);
  });

  it("uses sample titles as labels and carries market metadata", () => {
    const targets = buildAuditTargets([market], makeSelection(), pages, samples);
    const product = targets.find((t) => t.pageType === "PRODUCT");
    expect(product).toMatchObject({
      label: "Basic Tee",
      marketHandle: "main",
      marketName: "MAIN",
      locale: "en",
    });
  });

  it("never produces double slashes when the root URL has a trailing slash", () => {
    const slashed = makeMarket("main", [
      { locale: "en", url: "https://shop.example.com/", primary: true },
    ]);
    const targets = buildAuditTargets([slashed], makeSelection(), pages, samples);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.url.slice("https://".length)).not.toContain("//");
    }
    expect(targets.find((t) => t.pageType === "HOME")?.url).toBe(
      "https://shop.example.com",
    );
    expect(targets.find((t) => t.pageType === "CART")?.url).toBe(
      "https://shop.example.com/cart",
    );
  });
});

describe("buildAuditTargets — sampling modes", () => {
  const market = makeMarket("main", [
    { locale: "en", url: "https://shop.example.com", primary: true },
  ]);
  const samples: SampleData = {
    collections: [],
    products: [
      { handle: "alpha", title: "Alpha" },
      { handle: "beta", title: "Beta" },
      { handle: "gamma", title: "Gamma" },
    ],
    pages: [],
    blogs: [],
  };

  it("auto mode caps the sample list at sampleSize", () => {
    const pages = makePages({
      products: { enabled: true, mode: "auto", sampleSize: 2, handles: [] },
    });
    const targets = buildAuditTargets([market], makeSelection(), pages, samples);
    expect(targets.map((t) => t.url)).toEqual([
      "https://shop.example.com/products/alpha",
      "https://shop.example.com/products/beta",
    ]);
  });

  it("manual mode uses the explicit handles, trimmed and deduped, ignoring sampleSize", () => {
    const pages = makePages({
      products: {
        enabled: true,
        mode: "manual",
        sampleSize: 1,
        handles: [" zeta ", "alpha", "zeta", ""],
      },
    });
    const targets = buildAuditTargets([market], makeSelection(), pages, samples);
    expect(targets.map((t) => t.url).sort()).toEqual([
      "https://shop.example.com/products/alpha",
      "https://shop.example.com/products/zeta",
    ]);
    const alpha = targets.find((t) => t.url.endsWith("/alpha"));
    const zeta = targets.find((t) => t.url.endsWith("/zeta"));
    expect(alpha?.label).toBe("Alpha");
    expect(zeta?.label).toBeUndefined();
  });

  it("auto blogs keep entries for at most sampleSize distinct blogs", () => {
    const pages = makePages({
      blogs: { enabled: true, mode: "auto", sampleSize: 1, handles: [] },
    });
    const blogSamples: SampleData = {
      collections: [],
      products: [],
      pages: [],
      blogs: [
        { blogHandle: "news", title: "News" },
        { blogHandle: "news", articleHandle: "post-1", title: "Post 1" },
        { blogHandle: "guides", title: "Guides" },
      ],
    };
    const targets = buildAuditTargets(
      [market],
      makeSelection(),
      pages,
      blogSamples,
    );
    expect(targets.map((t) => t.url)).toEqual([
      "https://shop.example.com/blogs/news",
      "https://shop.example.com/blogs/news/post-1",
    ]);
  });

  it("manual blogs audit the listed blog indexes", () => {
    const pages = makePages({
      blogs: { enabled: true, mode: "manual", sampleSize: 1, handles: ["news"] },
    });
    const targets = buildAuditTargets([market], makeSelection(), pages, NO_SAMPLES);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      url: "https://shop.example.com/blogs/news",
      pageType: "BLOG",
    });
  });
});

describe("buildAuditTargets — custom URLs", () => {
  const market = makeMarket("main", [
    { locale: "en", url: "https://shop.example.com", primary: true },
  ]);

  it("keeps valid absolute URLs once, with no market metadata", () => {
    const pages = makePages({
      custom: {
        enabled: true,
        urls: [
          "https://other.example.com/landing",
          "https://other.example.com/landing",
        ],
      },
    });
    const targets = buildAuditTargets([market], makeSelection(), pages, NO_SAMPLES);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({
      url: "https://other.example.com/landing",
      pageType: "CUSTOM",
    });
  });

  it("skips invalid or non-http custom URLs", () => {
    const pages = makePages({
      custom: {
        enabled: true,
        urls: ["not a url", "/relative/path", "ftp://files.example.com"],
      },
    });
    const targets = buildAuditTargets([market], makeSelection(), pages, NO_SAMPLES);
    expect(targets).toEqual([]);
  });
});

describe("buildAuditTargets — dedupe and ordering", () => {
  it("dedupes identical url+market+locale targets", () => {
    const market = makeMarket("main", [
      { locale: "en", url: "https://shop.example.com", primary: true },
      { locale: "en", url: "https://shop.example.com/", primary: false },
    ]);
    const targets = buildAuditTargets(
      [market],
      makeSelection({ localeMode: "all" }),
      HOME_ONLY,
      NO_SAMPLES,
    );
    expect(targets).toHaveLength(1);
  });

  it("orders targets by market, then page type, then handle, custom last", () => {
    const markets = [
      makeMarket("b-market", [
        { locale: "en", url: "https://b.example.com", primary: true },
      ]),
      makeMarket("a-market", [
        { locale: "en", url: "https://a.example.com", primary: true },
      ]),
    ];
    const pages = makePages({
      home: { enabled: true },
      cart: { enabled: true },
      products: {
        enabled: true,
        mode: "manual",
        sampleSize: 3,
        handles: ["zeta", "alpha"],
      },
      custom: { enabled: true, urls: ["https://landing.example.com/x"] },
    });
    const targets = buildAuditTargets(markets, makeSelection(), pages, NO_SAMPLES);
    expect(targets.map((t) => t.url)).toEqual([
      "https://b.example.com",
      "https://b.example.com/cart",
      "https://b.example.com/products/alpha",
      "https://b.example.com/products/zeta",
      "https://a.example.com",
      "https://a.example.com/cart",
      "https://a.example.com/products/alpha",
      "https://a.example.com/products/zeta",
      "https://landing.example.com/x",
    ]);
  });
});

describe("validateCustomUrl", () => {
  it("rejects an empty string", () => {
    expect(validateCustomUrl("")).toBe("Enter a URL.");
  });

  it("rejects a whitespace-only string", () => {
    expect(validateCustomUrl("   ")).toBe("Enter a URL.");
  });

  it("rejects a relative or unparsable URL", () => {
    expect(validateCustomUrl("not a url")).toBe(
      "Enter an absolute URL, e.g. https://example.com/page.",
    );
    expect(validateCustomUrl("/pages/about")).toBe(
      "Enter an absolute URL, e.g. https://example.com/page.",
    );
  });

  it("rejects non-http(s) protocols", () => {
    expect(validateCustomUrl("ftp://files.example.com")).toBe(
      "Only http:// and https:// URLs are supported.",
    );
    expect(validateCustomUrl("javascript:alert(1)")).toBe(
      "Only http:// and https:// URLs are supported.",
    );
  });

  it("accepts absolute http and https URLs, ignoring surrounding whitespace", () => {
    expect(validateCustomUrl("https://example.com/page")).toBeNull();
    expect(validateCustomUrl("http://example.com")).toBeNull();
    expect(validateCustomUrl("  https://example.com  ")).toBeNull();
  });
});
