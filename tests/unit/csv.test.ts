import { describe, expect, it } from "vitest";

import { toCsv } from "../../app/lib/csv";

describe("toCsv — structure", () => {
  it("emits a header row followed by one line per row, CRLF-separated", () => {
    const csv = toCsv([
      { name: "Home", score: 82 },
      { name: "Cart", score: 74 },
    ]);
    expect(csv).toBe("name,score\r\nHome,82\r\nCart,74");
  });

  it("uses CRLF only — no bare LF line endings", () => {
    const csv = toCsv([{ a: "1" }, { a: "2" }]);
    expect(csv.split("\r\n")).toEqual(["a", "1", "2"]);
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("respects explicit columns: order, subset and custom headers", () => {
    const csv = toCsv(
      [{ url: "https://x.example.com", score: 90, ignored: "yes" }],
      [
        { key: "score", header: "Performance score" },
        { key: "url", header: "URL" },
      ],
    );
    expect(csv).toBe("Performance score,URL\r\n90,https://x.example.com");
  });

  it("emits empty fields for keys missing from a row", () => {
    const csv = toCsv(
      [{ a: "1" }],
      [
        { key: "a", header: "a" },
        { key: "b", header: "b" },
      ],
    );
    expect(csv).toBe("a,b\r\n1,");
  });

  it("infers the column union across rows in first-seen order", () => {
    const csv = toCsv([
      { a: "1", b: "2" },
      { b: "3", c: "4" },
    ]);
    expect(csv).toBe("a,b,c\r\n1,2,\r\n,3,4");
  });

  it("returns only the header for explicit columns with no rows", () => {
    const csv = toCsv([], [{ key: "a", header: "Column A" }]);
    expect(csv).toBe("Column A");
  });

  it("returns an empty string with no rows and no columns", () => {
    expect(toCsv([])).toBe("");
  });
});

describe("toCsv — field escaping (RFC 4180)", () => {
  it("quotes fields containing commas", () => {
    const csv = toCsv([{ label: "Shoes, red" }]);
    expect(csv).toBe('label\r\n"Shoes, red"');
  });

  it("quotes fields containing quotes and doubles the inner quotes", () => {
    const csv = toCsv([{ label: 'he said "hi"' }]);
    expect(csv).toBe('label\r\n"he said ""hi"""');
  });

  it("quotes fields containing newlines", () => {
    const csv = toCsv([{ note: "line1\nline2" }]);
    expect(csv).toBe('note\r\n"line1\nline2"');
  });

  it("quotes fields containing carriage returns", () => {
    const csv = toCsv([{ note: "line1\r\nline2" }]);
    expect(csv).toBe('note\r\n"line1\r\nline2"');
  });

  it("quotes headers that need escaping", () => {
    const csv = toCsv([], [{ key: "a", header: 'Score, "final"' }]);
    expect(csv).toBe('"Score, ""final"""');
  });

  it("serializes null and undefined as empty fields", () => {
    const csv = toCsv([{ a: null, b: undefined, c: "x" }]);
    expect(csv).toBe("a,b,c\r\n,,x");
  });

  it("stringifies numbers, including zero", () => {
    const csv = toCsv([{ a: 0, b: 2350.5 }]);
    expect(csv).toBe("a,b\r\n0,2350.5");
  });

  it("leaves plain fields unquoted", () => {
    const csv = toCsv([{ a: "plain text with spaces" }]);
    expect(csv).toBe("a\r\nplain text with spaces");
  });
});
