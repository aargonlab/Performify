// ---------------------------------------------------------------------------
// Recommendation dictionary + builder. Pure logic, no I/O.
// AUDIT_EXPLANATIONS translates Lighthouse audit ids into plain-language
// advice a merchant can act on, with the typical Shopify cause where relevant.
// ---------------------------------------------------------------------------

import type { Recommendation } from "../types";
import type { PageResultSummary } from "./types";

export const AUDIT_EXPLANATIONS: Record<
  string,
  { title: string; explanation: string }
> = {
  "render-blocking-resources": {
    title: "Remove render-blocking resources",
    explanation:
      "Some scripts and stylesheets must finish downloading before anything shows up on screen. On Shopify these usually come from the theme and from app embeds, so removing unused apps or deferring their scripts makes the page appear sooner.",
  },
  "unused-javascript": {
    title: "Reduce unused JavaScript",
    explanation:
      "Visitors download JavaScript code that is never actually used on the page. This is very often caused by installed apps that inject their scripts on every page, even where they are not needed.",
  },
  "unused-css-rules": {
    title: "Reduce unused CSS",
    explanation:
      "The page downloads styling rules that are never applied. Shopify themes and app embeds often ship one large stylesheet for the whole store, so trimming it makes every page lighter.",
  },
  "uses-optimized-images": {
    title: "Compress images more efficiently",
    explanation:
      "Some images weigh more than they need to. Compressing them — especially large hero and banner images — makes pages load noticeably faster with no visible quality loss.",
  },
  "modern-image-formats": {
    title: "Serve images in modern formats",
    explanation:
      "Formats like WebP and AVIF are much smaller than JPEG or PNG at the same quality. Shopify's image CDN can deliver them automatically when the theme requests images the recommended way.",
  },
  "uses-responsive-images": {
    title: "Send images at the right size",
    explanation:
      "The page sends images far larger than the size they are displayed at. This typically happens when a theme uses full-resolution uploads for small thumbnails or on mobile screens.",
  },
  "offscreen-images": {
    title: "Delay loading of offscreen images",
    explanation:
      "Images far down the page load immediately even though visitors cannot see them yet. Loading them only when needed lets the visible part of the page finish first.",
  },
  "uses-text-compression": {
    title: "Enable text compression",
    explanation:
      "Some text files (scripts, stylesheets) travel uncompressed, so downloads are bigger than necessary. Shopify compresses its own assets, so this usually points at files served by third-party apps.",
  },
  "server-response-time": {
    title: "Speed up the server response",
    explanation:
      "The server takes a long time to start sending the page. On Shopify this is usually heavy theme code (many sections and loops) or slow app-provided content rather than Shopify's own infrastructure.",
  },
  redirects: {
    title: "Avoid page redirects",
    explanation:
      "Visitors are bounced through one or more redirects before reaching the final page, and every hop adds waiting time. Check for redirect chains from domain settings, apps, or outdated links.",
  },
  "uses-rel-preconnect": {
    title: "Connect to important servers earlier",
    explanation:
      "The browser could open connections to third-party servers (fonts, apps, analytics) sooner. A small hint in the theme lets those downloads start earlier.",
  },
  "efficient-animated-content": {
    title: "Replace animated GIFs with video",
    explanation:
      "Animated GIFs are extremely heavy compared with modern video formats. Replacing them with short MP4 or WebM clips keeps the same effect at a fraction of the size.",
  },
  "duplicated-javascript": {
    title: "Remove duplicated JavaScript",
    explanation:
      "The same code is downloaded more than once, usually because several apps bundle the same libraries. Removing overlapping apps reduces this waste directly.",
  },
  "legacy-javascript": {
    title: "Avoid outdated JavaScript",
    explanation:
      "The page ships extra code written for very old browsers that modern browsers do not need. Older themes and app scripts are the usual source.",
  },
  "prioritize-lcp-image": {
    title: "Load the main image first",
    explanation:
      "The biggest image on screen — often the hero banner — starts downloading later than it could. Telling the browser to fetch it first makes the page feel much faster.",
  },
  "largest-contentful-paint-element": {
    title: "Speed up the largest visible element",
    explanation:
      "The largest element on screen defines when the page feels loaded. On Shopify stores this is usually an oversized hero image or a slow-loading banner.",
  },
  "layout-shift-elements": {
    title: "Stop elements from jumping around",
    explanation:
      "Parts of the page move while it loads, which feels unstable and causes mis-taps. Images without reserved space, late-loading banners, and app popups are the common causes.",
  },
  "total-byte-weight": {
    title: "Reduce the total page weight",
    explanation:
      "The page downloads a very large amount of data overall. Heavy images and the combined scripts of many installed apps are the usual causes on Shopify stores.",
  },
  "dom-size": {
    title: "Simplify the page structure",
    explanation:
      "The page is built from a very large number of elements, which makes the browser work harder. Themes with many nested sections, mega menus, or very long product grids often cause this.",
  },
  "third-party-summary": {
    title: "Reduce the impact of third-party code",
    explanation:
      "Code from third parties — apps, chat widgets, analytics, tracking pixels — slows the page down. Every installed app that injects a script adds to this, so removing apps you no longer use helps directly.",
  },
  "bootup-time": {
    title: "Reduce JavaScript execution time",
    explanation:
      "The browser spends a long time running JavaScript before the page becomes usable. This usually grows with every app that adds its own scripts to the storefront.",
  },
  "mainthread-work-breakdown": {
    title: "Give the browser less work to do",
    explanation:
      "The browser is kept busy for a long time, so the page is slow to react to taps and scrolling. Heavy theme scripts and many app embeds are the typical causes.",
  },
  "font-display": {
    title: "Keep text visible while fonts load",
    explanation:
      "Text stays invisible until custom fonts finish downloading. A small theme setting (font-display: swap) shows a standard font immediately so visitors can start reading right away.",
  },
  "unminified-javascript": {
    title: "Minify JavaScript files",
    explanation:
      "Some script files are delivered with unnecessary characters such as comments and spacing. Compressing them — often hand-edited theme files — makes downloads smaller.",
  },
  "unminified-css": {
    title: "Minify CSS files",
    explanation:
      "Some stylesheets are delivered uncompressed, making them larger than needed. This usually points at custom theme CSS that has never been minified.",
  },
};

const GENERIC_EXPLANATION =
  "Lighthouse flagged this as an opportunity to make your pages faster. Addressing it usually means lighter pages and shorter loading times for your visitors.";

const MAX_AFFECTED_URLS = 20;
const MAX_RECOMMENDATIONS = 10;

interface OpportunityGroup {
  estimatedSavingsMs: number;
  urls: Set<string>;
  fallbackTitle: string;
}

/**
 * Flattens the topOpportunities of COMPLETED results, groups them by audit id
 * and ranks them by total estimated savings (a proxy for overall impact).
 * Returns at most 10 recommendations, priority 1 = highest impact.
 */
export function buildRecommendations(
  results: PageResultSummary[],
): Recommendation[] {
  const groups = new Map<string, OpportunityGroup>();

  for (const result of results) {
    if (result.status !== "COMPLETED" || !result.topOpportunities) continue;
    for (const opportunity of result.topOpportunities) {
      let group = groups.get(opportunity.id);
      if (!group) {
        group = {
          estimatedSavingsMs: 0,
          urls: new Set<string>(),
          fallbackTitle: opportunity.title,
        };
        groups.set(opportunity.id, group);
      }
      if (Number.isFinite(opportunity.savingsMs)) {
        group.estimatedSavingsMs += opportunity.savingsMs;
      }
      group.urls.add(result.url);
    }
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].estimatedSavingsMs - a[1].estimatedSavingsMs)
    .slice(0, MAX_RECOMMENDATIONS)
    .map(([auditId, group], index) => {
      const known: { title: string; explanation: string } | undefined =
        AUDIT_EXPLANATIONS[auditId];
      return {
        auditId,
        title: known ? known.title : group.fallbackTitle,
        explanation: known ? known.explanation : GENERIC_EXPLANATION,
        estimatedSavingsMs: group.estimatedSavingsMs,
        affectedUrls: [...group.urls].slice(0, MAX_AFFECTED_URLS),
        priority: index + 1,
      };
    });
}
