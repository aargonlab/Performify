import { describe, expect, it } from "vitest";

import { parsePsiResponse } from "../../app/lib/audit/psi-parser";
import {
  PSI_ORIGIN_URL,
  PSI_PAGE_URL,
  makePsiResponse,
} from "../fixtures/psi-response";

describe("parsePsiResponse — category scores", () => {
  it("converts 0-1 category scores to rounded 0-100 integers", () => {
    const snapshot = parsePsiResponse(makePsiResponse(), "MOBILE");
    expect(snapshot.categories).toEqual({
      performance: 82,
      accessibility: 95,
      bestPractices: 90,
      seo: 100,
    });
  });

  it("rounds fractional score conversions to the nearest integer", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: {
          categories: {
            performance: { score: 0.825 },
            accessibility: { score: 0.446 },
          },
        },
      }),
      "MOBILE",
    );
    expect(snapshot.categories.performance).toBe(83);
    expect(snapshot.categories.accessibility).toBe(45);
  });

  it("returns null for a category whose score is null", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: { categories: { performance: { score: null } } },
      }),
      "MOBILE",
    );
    expect(snapshot.categories.performance).toBeNull();
    expect(snapshot.categories.seo).toBe(100);
  });

  it("returns all-null categories when the categories block is missing", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({ lighthouseResult: { categories: undefined } }),
      "MOBILE",
    );
    expect(snapshot.categories).toEqual({
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
    });
  });
});

describe("parsePsiResponse — lab metrics", () => {
  it("extracts every lab metric from the audit numericValues", () => {
    const snapshot = parsePsiResponse(makePsiResponse(), "MOBILE");
    expect(snapshot.labMetrics).toEqual({
      lcpMs: 2350.5,
      cls: 0.08,
      tbtMs: 310,
      fcpMs: 1200,
      speedIndexMs: 3400,
      ttfbMs: 420,
    });
  });

  it("returns null for a non-numeric numericValue", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: {
          audits: { "largest-contentful-paint": { numericValue: "2350" } },
        },
      }),
      "MOBILE",
    );
    expect(snapshot.labMetrics.lcpMs).toBeNull();
  });

  it("returns null for a NaN numericValue", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: {
          audits: { "total-blocking-time": { numericValue: Number.NaN } },
        },
      }),
      "MOBILE",
    );
    expect(snapshot.labMetrics.tbtMs).toBeNull();
  });

  it("returns all-null lab metrics when the audits block is missing", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({ lighthouseResult: { audits: undefined } }),
      "MOBILE",
    );
    expect(snapshot.labMetrics).toEqual({
      lcpMs: null,
      cls: null,
      tbtMs: null,
      fcpMs: null,
      speedIndexMs: null,
      ttfbMs: null,
    });
  });
});

describe("parsePsiResponse — field data (CrUX)", () => {
  it("uses page-level data when loadingExperience.id matches the audited URL", () => {
    const snapshot = parsePsiResponse(makePsiResponse(), "MOBILE");
    expect(snapshot.field).toEqual({
      source: "page",
      lcpMs: 2600,
      inpMs: 180,
      cls: 0.12,
      overall: "AVERAGE",
    });
  });

  it("divides the CrUX CLS percentile by 100", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        loadingExperience: {
          metrics: { CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 25 } },
        },
      }),
      "MOBILE",
    );
    expect(snapshot.field?.cls).toBe(0.25);
  });

  it("falls back to originLoadingExperience when loadingExperience is absent", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({ loadingExperience: undefined }),
      "MOBILE",
    );
    expect(snapshot.field).toEqual({
      source: "origin",
      lcpMs: 2850,
      inpMs: 210,
      cls: 0.15,
      overall: "AVERAGE",
    });
  });

  it("falls back to origin when loadingExperience is null", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({ loadingExperience: null }),
      "MOBILE",
    );
    expect(snapshot.field?.source).toBe("origin");
    expect(snapshot.field?.lcpMs).toBe(2850);
  });

  it("falls back to origin when loadingExperience has no metrics", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({ loadingExperience: { metrics: null } }),
      "MOBILE",
    );
    expect(snapshot.field?.source).toBe("origin");
    expect(snapshot.field?.lcpMs).toBe(2850);
  });

  it("omits field entirely when both experience blocks are absent", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        loadingExperience: undefined,
        originLoadingExperience: undefined,
      }),
      "MOBILE",
    );
    expect(snapshot.field).toBeUndefined();
  });

  it("treats an origin_fallback loadingExperience with non-matching id as origin data", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        loadingExperience: {
          id: PSI_ORIGIN_URL,
          initial_url: undefined,
          origin_fallback: true,
        },
        originLoadingExperience: undefined,
      }),
      "MOBILE",
    );
    expect(snapshot.field).toEqual({
      source: "origin",
      lcpMs: 2600,
      inpMs: 180,
      cls: 0.12,
      overall: "AVERAGE",
    });
  });

  // Real PSI origin-fallback responses keep initial_url = the requested page
  // URL alongside origin_fallback: true (id is the origin): the flag must
  // take precedence over the id/initial_url match.
  it(
    "reports source origin when origin_fallback is true even if initial_url matches the page",
    () => {
      const snapshot = parsePsiResponse(
        makePsiResponse({
          loadingExperience: {
            id: PSI_ORIGIN_URL,
            initial_url: PSI_PAGE_URL,
            origin_fallback: true,
          },
          originLoadingExperience: undefined,
        }),
        "MOBILE",
      );
      expect(snapshot.field?.source).toBe("origin");
    },
  );

  it("returns null overall for an unknown overall_category value", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({ loadingExperience: { overall_category: "NONE" } }),
      "MOBILE",
    );
    expect(snapshot.field?.overall).toBeNull();
  });

  it("returns null percentiles for missing individual field metrics", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        loadingExperience: {
          metrics: { INTERACTION_TO_NEXT_PAINT: undefined },
        },
      }),
      "MOBILE",
    );
    expect(snapshot.field?.inpMs).toBeNull();
    expect(snapshot.field?.lcpMs).toBe(2600);
  });
});

describe("parsePsiResponse — opportunities", () => {
  it("keeps only opportunities with positive savings, sorted descending", () => {
    const snapshot = parsePsiResponse(makePsiResponse(), "MOBILE");
    expect(snapshot.opportunities.map((o) => o.id)).toEqual([
      "unused-javascript",
      "render-blocking-resources",
    ]);
    expect(snapshot.opportunities[0]).toEqual({
      id: "unused-javascript",
      title: "Reduce unused JavaScript",
      savingsMs: 900,
      score: 0.3,
      displayValue: "Potential savings of 900 ms",
    });
  });

  it("excludes details blocks that are not opportunities", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: {
          audits: {
            "render-blocking-resources": { details: { type: "table" } },
          },
        },
      }),
      "MOBILE",
    );
    expect(snapshot.opportunities.map((o) => o.id)).toEqual([
      "unused-javascript",
    ]);
  });

  it("excludes opportunities with negative savings", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: {
          audits: {
            "render-blocking-resources": {
              details: { overallSavingsMs: -50 },
            },
          },
        },
      }),
      "MOBILE",
    );
    expect(snapshot.opportunities.map((o) => o.id)).toEqual([
      "unused-javascript",
    ]);
  });

  it("falls back to the audit id when the title is missing", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: {
          audits: { "unused-javascript": { title: undefined } },
        },
      }),
      "MOBILE",
    );
    const finding = snapshot.opportunities.find(
      (o) => o.id === "unused-javascript",
    );
    expect(finding?.title).toBe("unused-javascript");
  });
});

describe("parsePsiResponse — runtime errors and metadata", () => {
  it("passes the lighthouse runtimeError through", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: {
          runtimeError: {
            code: "ERRORED_DOCUMENT_REQUEST",
            message: "Lighthouse was unable to reliably load the page.",
          },
        },
      }),
      "MOBILE",
    );
    expect(snapshot.runtimeError).toEqual({
      code: "ERRORED_DOCUMENT_REQUEST",
      message: "Lighthouse was unable to reliably load the page.",
    });
  });

  it("defaults a missing runtimeError message to an empty string", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: { runtimeError: { code: "NO_FCP" } },
      }),
      "MOBILE",
    );
    expect(snapshot.runtimeError).toEqual({ code: "NO_FCP", message: "" });
  });

  it("omits runtimeError when the response has none", () => {
    const snapshot = parsePsiResponse(makePsiResponse(), "MOBILE");
    expect(snapshot.runtimeError).toBeUndefined();
  });

  it("captures urls, version, timestamps, strategy and the raw payload", () => {
    const json = makePsiResponse();
    const snapshot = parsePsiResponse(json, "DESKTOP");
    expect(snapshot.engine).toBe("psi");
    expect(snapshot.requestedUrl).toBe(PSI_PAGE_URL);
    expect(snapshot.finalUrl).toBe(PSI_PAGE_URL);
    expect(snapshot.lighthouseVersion).toBe("13.0.0");
    expect(snapshot.fetchedAt).toBe("2026-07-06T10:00:00.000Z");
    expect(snapshot.strategy).toBe("DESKTOP");
    expect(snapshot.raw).toBe(json);
  });

  it("falls back to root id and analysisUTCTimestamp when lighthouse metadata is missing", () => {
    const snapshot = parsePsiResponse(
      makePsiResponse({
        lighthouseResult: {
          requestedUrl: undefined,
          finalUrl: undefined,
          finalDisplayedUrl: undefined,
          fetchTime: undefined,
        },
      }),
      "MOBILE",
    );
    expect(snapshot.requestedUrl).toBe(PSI_PAGE_URL);
    expect(snapshot.finalUrl).toBe(PSI_PAGE_URL);
    expect(snapshot.fetchedAt).toBe("2026-07-06T10:00:05.123Z");
  });
});

describe("parsePsiResponse — defensive parsing", () => {
  it("parses an empty object without throwing, returning nulls", () => {
    const snapshot = parsePsiResponse({}, "MOBILE");
    expect(snapshot.categories).toEqual({
      performance: null,
      accessibility: null,
      bestPractices: null,
      seo: null,
    });
    expect(snapshot.labMetrics).toEqual({
      lcpMs: null,
      cls: null,
      tbtMs: null,
      fcpMs: null,
      speedIndexMs: null,
      ttfbMs: null,
    });
    expect(snapshot.opportunities).toEqual([]);
    expect(snapshot.field).toBeUndefined();
    expect(snapshot.runtimeError).toBeUndefined();
    expect(snapshot.requestedUrl).toBe("");
    expect(snapshot.finalUrl).toBe("");
    expect(snapshot.lighthouseVersion).toBe("");
    expect(typeof snapshot.fetchedAt).toBe("string");
  });

  it("parses null input without throwing", () => {
    expect(() => parsePsiResponse(null, "MOBILE")).not.toThrow();
    const snapshot = parsePsiResponse(null, "MOBILE");
    expect(snapshot.categories.performance).toBeNull();
    expect(snapshot.raw).toBeNull();
  });

  it("parses mistyped blocks (arrays and scalars) without throwing", () => {
    const snapshot = parsePsiResponse(
      {
        lighthouseResult: {
          categories: [],
          audits: "nope",
        },
        loadingExperience: 42,
        originLoadingExperience: "text",
      },
      "MOBILE",
    );
    expect(snapshot.categories.performance).toBeNull();
    expect(snapshot.labMetrics.lcpMs).toBeNull();
    expect(snapshot.opportunities).toEqual([]);
    expect(snapshot.field).toBeUndefined();
  });
});
