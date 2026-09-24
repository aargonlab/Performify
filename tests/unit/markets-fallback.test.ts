// ---------------------------------------------------------------------------
// fetchPrimaryDomainMarket — the fallback used when no active market exposes
// web presences/rootUrls (development stores, unified Markets shops).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { AdminGraphql } from "../../app/services/markets.server";
import { fetchPrimaryDomainMarket } from "../../app/services/markets.server";

function fakeGraphql(data: unknown): AdminGraphql {
  return async () =>
    new Response(JSON.stringify({ data }), {
      headers: { "Content-Type": "application/json" },
    });
}

describe("fetchPrimaryDomainMarket", () => {
  it("builds a pseudo-market from the shop primary domain and primary locale", async () => {
    const market = await fetchPrimaryDomainMarket(
      fakeGraphql({
        shop: { primaryDomain: { url: "https://my-shop.myshopify.com/" } },
        shopLocales: [
          { locale: "en", primary: false },
          { locale: "it", primary: true },
        ],
      }),
    );

    expect(market).toEqual({
      handle: "primary",
      name: "Primary domain",
      rootUrls: [
        { locale: "it", url: "https://my-shop.myshopify.com", primary: true },
      ],
    });
  });

  it("falls back to locale 'default' when no primary shop locale exists", async () => {
    const market = await fetchPrimaryDomainMarket(
      fakeGraphql({
        shop: { primaryDomain: { url: "https://example.com" } },
        shopLocales: [],
      }),
    );

    expect(market?.rootUrls).toEqual([
      { locale: "default", url: "https://example.com", primary: true },
    ]);
  });

  it("returns null when the primary domain is missing", async () => {
    expect(
      await fetchPrimaryDomainMarket(fakeGraphql({ shop: {} })),
    ).toBeNull();
    expect(
      await fetchPrimaryDomainMarket(
        fakeGraphql({ shop: { primaryDomain: { url: "" } } }),
      ),
    ).toBeNull();
  });
});
