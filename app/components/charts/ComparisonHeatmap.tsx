// "Before vs after" comparison table: colored cells (background supplied by the
// caller via colorFor), readable ink computed per cell, sticky first column and
// a horizontal scroll wrapper so wide matrices never overflow the page.

import type { CSSProperties } from "react";
import { fmtMs, fmtScore, readableTextOn } from "./format";

export interface HeatmapCell {
  value: number | null;
  delta?: number | null;
}

export interface HeatmapRow {
  label: string;
  cells: HeatmapCell[];
}

export interface ComparisonHeatmapProps {
  rows: HeatmapRow[];
  columns: string[];
  colorFor: (value: number | null) => string;
  /** Optional per-column formatter; defaults to score/ms auto-detection. */
  valueFormatter?: (value: number, columnIndex: number) => string;
}

function defaultFormatter(value: number): string {
  // Scores are 0–100; timing values (ms) are practically always >= 200.
  return Math.abs(value) > 100 ? fmtMs(value) : fmtScore(value);
}

const STICKY_CELL: CSSProperties = {
  position: "sticky",
  left: 0,
  background: "var(--p-color-bg-surface, #ffffff)",
  textAlign: "left",
  padding: "6px 8px",
  whiteSpace: "nowrap",
  fontWeight: 500,
  zIndex: 1,
};

export function ComparisonHeatmap({
  rows,
  columns,
  colorFor,
  valueFormatter,
}: ComparisonHeatmapProps) {
  if (rows.length === 0) {
    return <s-paragraph>No data yet</s-paragraph>;
  }

  const fmt = valueFormatter ?? defaultFormatter;

  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table
        style={{
          borderCollapse: "separate",
          borderSpacing: 2,
          width: "100%",
          fontSize: 12,
        }}
      >
        <thead>
          <tr>
            <th style={STICKY_CELL} scope="col">
              <span
                style={{ color: "var(--p-color-text-secondary, #616161)" }}
              >
                Segment
              </span>
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                style={{
                  padding: "6px 10px",
                  textAlign: "center",
                  whiteSpace: "nowrap",
                  color: "var(--p-color-text-secondary, #616161)",
                  fontWeight: 500,
                }}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th style={STICKY_CELL} scope="row">
                {row.label}
              </th>
              {row.cells.map((cell, columnIndex) => {
                const background = colorFor(cell.value);
                const ink = readableTextOn(background);
                const delta = cell.delta;
                return (
                  <td
                    key={`${row.label}-${columnIndex}`}
                    style={{
                      background,
                      color: ink,
                      textAlign: "center",
                      padding: "6px 10px",
                      borderRadius: 6,
                      minWidth: 76,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {cell.value == null ? "—" : fmt(cell.value, columnIndex)}
                    </div>
                    {delta != null && Number.isFinite(delta) ? (
                      <div style={{ fontSize: 11, opacity: 0.85 }}>
                        {delta > 0 ? "▲" : delta < 0 ? "▼" : "±"}{" "}
                        {fmt(Math.abs(delta), columnIndex)}
                      </div>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
