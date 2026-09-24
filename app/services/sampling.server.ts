// ---------------------------------------------------------------------------
// Storefront page sampling for auto-mode selections. Fetches only what the
// profile needs (disabled/manual types are skipped and returned empty).
//
// Representative-sample heuristics (no analytics data available with the
// app's read scopes — documented assumption):
// - collections: published, most recently updated first (active surfaces)
// - products:    active products, most recently published first
// - pages:       first N published CMS pages
// - blogs:       up to sampleSize blogs; for each, the index plus its latest
//                article
// All queries validated against the 2026-07 Admin schema. Note: Blog.articles
// has no sortKey argument in 2026-07, so the latest article is approximated
// with reverse: true on the default connection order.
// ---------------------------------------------------------------------------

import type { PagesSelection, SampledPageSelection } from "../lib/types";
import { MAX_SAMPLE_SIZE } from "../lib/types";
import type { SampleData } from "../lib/urls/build-urls";
import { runAdminGraphql, type AdminGraphql } from "./markets.server";

const SAMPLE_COLLECTIONS_QUERY = `#graphql
  query SampleCollections($first: Int!) {
    collections(
      first: $first
      sortKey: UPDATED_AT
      reverse: true
      query: "(collection_type:custom OR collection_type:smart) AND published_status:approved"
    ) {
      nodes { handle title }
    }
  }
`;

const SAMPLE_PRODUCTS_QUERY = `#graphql
  query SampleProducts($first: Int!) {
    products(first: $first, query: "status:active", sortKey: PUBLISHED_AT, reverse: true) {
      nodes { handle title }
    }
  }
`;

const SAMPLE_PAGES_QUERY = `#graphql
  query SamplePages($first: Int!) {
    pages(first: $first, query: "published_status:published") {
      nodes { handle title }
    }
  }
`;

const SAMPLE_BLOGS_QUERY = `#graphql
  query SampleBlogs($first: Int!) {
    blogs(first: $first) {
      nodes {
        handle
        title
        articles(first: 1, reverse: true) {
          nodes { handle title }
        }
      }
    }
  }
`;

interface HandleTitleNode {
  handle: string;
  title: string;
}

interface BlogNode {
  handle: string;
  title: string;
  articles: { nodes: { handle: string; title: string }[] } | null;
}

/** Only auto-mode enabled selections need sampling. */
function needsSampling(sel: SampledPageSelection): boolean {
  return sel.enabled && sel.mode === "auto";
}

function sampleSize(sel: SampledPageSelection): number {
  return Math.min(MAX_SAMPLE_SIZE, Math.max(1, sel.sampleSize));
}

async function fetchHandleTitleNodes(
  graphql: AdminGraphql,
  query: string,
  field: "collections" | "products" | "pages",
  first: number,
): Promise<{ handle: string; title: string }[]> {
  const data = await runAdminGraphql(graphql, query, { first });
  const nodes = (data?.[field]?.nodes ?? []) as HandleTitleNode[];
  return nodes.map((n) => ({ handle: n.handle, title: n.title }));
}

async function fetchBlogSamples(
  graphql: AdminGraphql,
  first: number,
): Promise<SampleData["blogs"]> {
  const data = await runAdminGraphql(graphql, SAMPLE_BLOGS_QUERY, {
    first,
  });
  const nodes = (data?.blogs?.nodes ?? []) as BlogNode[];
  const samples: SampleData["blogs"] = [];
  for (const blog of nodes) {
    samples.push({ blogHandle: blog.handle, title: blog.title });
    const article = blog.articles?.nodes?.[0];
    if (article) {
      samples.push({
        blogHandle: blog.handle,
        articleHandle: article.handle,
        title: article.title,
      });
    }
  }
  return samples;
}

/**
 * Resolves representative storefront samples for every enabled auto-mode
 * page type in the profile. Disabled or manual types come back as [].
 */
export async function fetchSamples(
  graphql: AdminGraphql,
  pages: PagesSelection,
): Promise<SampleData> {
  const [collections, products, cmsPages, blogs] = await Promise.all([
    needsSampling(pages.collections)
      ? fetchHandleTitleNodes(
          graphql,
          SAMPLE_COLLECTIONS_QUERY,
          "collections",
          sampleSize(pages.collections),
        )
      : Promise.resolve([]),
    needsSampling(pages.products)
      ? fetchHandleTitleNodes(
          graphql,
          SAMPLE_PRODUCTS_QUERY,
          "products",
          sampleSize(pages.products),
        )
      : Promise.resolve([]),
    needsSampling(pages.pages)
      ? fetchHandleTitleNodes(
          graphql,
          SAMPLE_PAGES_QUERY,
          "pages",
          sampleSize(pages.pages),
        )
      : Promise.resolve([]),
    needsSampling(pages.blogs)
      ? fetchBlogSamples(graphql, sampleSize(pages.blogs))
      : Promise.resolve([]),
  ]);

  return { collections, products, pages: cmsPages, blogs };
}
