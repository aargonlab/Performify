import { describe, expect, it } from "vitest";

import {
  AUDIT_EXPLANATIONS,
  buildRecommendations,
} from "../../app/lib/report/recommendations";
import { makePageResult } from "../fixtures/page-result";

function makeOpportunity(
  id: string,
  savingsMs: number,
  title = `Title for ${id}`,
) {
  return { id, title, savingsMs, score: 0.5 };
}

describe("buildRecommendations", () => {
  it("groups opportunities by audit id and sums their savings", () => {
    const recommendations = buildRecommendations([
      makePageResult({
        url: "https://shop.example.com/a",
        topOpportunities: [makeOpportunity("unused-javascript", 900)],
      }),
      makePageResult({
        url: "https://shop.example.com/b",
        topOpportunities: [makeOpportunity("unused-javascript", 800)],
      }),
    ]);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].auditId).toBe("unused-javascript");
    expect(recommendations[0].estimatedSavingsMs).toBe(1700);
    expect(recommendations[0].affectedUrls).toEqual([
      "https://shop.example.com/a",
      "https://shop.example.com/b",
    ]);
  });

  it("uses the dictionary title and explanation for known audit ids", () => {
    const recommendations = buildRecommendations([
      makePageResult({
        topOpportunities: [
          makeOpportunity("render-blocking-resources", 450, "raw PSI title"),
        ],
      }),
    ]);
    expect(recommendations[0].title).toBe("Remove render-blocking resources");
    expect(recommendations[0].explanation).toBe(
      AUDIT_EXPLANATIONS["render-blocking-resources"].explanation,
    );
  });

  it("falls back to the opportunity title and a generic explanation for unknown ids", () => {
    const recommendations = buildRecommendations([
      makePageResult({
        topOpportunities: [
          makeOpportunity("some-new-audit", 300, "Some new audit"),
        ],
      }),
    ]);
    expect(recommendations[0].title).toBe("Some new audit");
    expect(recommendations[0].explanation).toContain(
      "Lighthouse flagged this as an opportunity",
    );
  });

  it("ranks recommendations by total savings with priority 1 = highest", () => {
    const recommendations = buildRecommendations([
      makePageResult({
        url: "https://shop.example.com/a",
        topOpportunities: [
          makeOpportunity("small-audit", 200),
          makeOpportunity("big-audit", 1500),
        ],
      }),
      makePageResult({
        url: "https://shop.example.com/b",
        topOpportunities: [makeOpportunity("small-audit", 400)],
      }),
    ]);
    expect(recommendations.map((r) => r.auditId)).toEqual([
      "big-audit",
      "small-audit",
    ]);
    expect(recommendations[0].priority).toBe(1);
    expect(recommendations[1].priority).toBe(2);
    expect(recommendations[1].estimatedSavingsMs).toBe(600);
  });

  it("keeps affected urls unique", () => {
    const recommendations = buildRecommendations([
      makePageResult({
        url: "https://shop.example.com/a",
        device: "MOBILE",
        topOpportunities: [makeOpportunity("unused-javascript", 900)],
      }),
      makePageResult({
        url: "https://shop.example.com/a",
        device: "DESKTOP",
        topOpportunities: [makeOpportunity("unused-javascript", 700)],
      }),
    ]);
    expect(recommendations[0].affectedUrls).toEqual([
      "https://shop.example.com/a",
    ]);
    expect(recommendations[0].estimatedSavingsMs).toBe(1600);
  });

  it("caps affected urls at 20 while still summing all savings", () => {
    const results = Array.from({ length: 25 }, (_, index) =>
      makePageResult({
        url: `https://shop.example.com/page-${index}`,
        topOpportunities: [makeOpportunity("unused-javascript", 100)],
      }),
    );
    const recommendations = buildRecommendations(results);
    expect(recommendations[0].affectedUrls).toHaveLength(20);
    expect(recommendations[0].estimatedSavingsMs).toBe(2500);
  });

  it("caps the output at 10 recommendations, dropping the lowest savings", () => {
    const results = [
      makePageResult({
        topOpportunities: Array.from({ length: 12 }, (_, index) =>
          makeOpportunity(`audit-${index}`, (12 - index) * 100),
        ),
      }),
    ];
    const recommendations = buildRecommendations(results);
    expect(recommendations).toHaveLength(10);
    const ids = recommendations.map((r) => r.auditId);
    expect(ids).not.toContain("audit-10");
    expect(ids).not.toContain("audit-11");
    expect(recommendations[0].estimatedSavingsMs).toBe(1200);
  });

  it("ignores non-COMPLETED results and null topOpportunities", () => {
    const recommendations = buildRecommendations([
      makePageResult({
        status: "FAILED",
        topOpportunities: [makeOpportunity("unused-javascript", 900)],
      }),
      makePageResult({ topOpportunities: null }),
    ]);
    expect(recommendations).toEqual([]);
  });

  it("skips non-finite savings but still records the affected url", () => {
    const recommendations = buildRecommendations([
      makePageResult({
        url: "https://shop.example.com/a",
        topOpportunities: [makeOpportunity("unused-javascript", Number.NaN)],
      }),
      makePageResult({
        url: "https://shop.example.com/b",
        topOpportunities: [makeOpportunity("unused-javascript", 500)],
      }),
    ]);
    expect(recommendations[0].estimatedSavingsMs).toBe(500);
    expect(recommendations[0].affectedUrls).toEqual([
      "https://shop.example.com/a",
      "https://shop.example.com/b",
    ]);
  });
});
