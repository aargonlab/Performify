// Dependency-free SVG line chart for run-over-run trends.
// - one 2px polyline per series, split on null gaps
// - dots with a surface ring so overlapping points stay legible
// - recessive hairline grid, thinned/rotated x labels when crowded
// - hover crosshair + tooltip, HTML legend, visually-hidden table fallback

import { useMemo, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";

export interface TrendPoint {
  x: string | number;
  y: number | null;
}

export interface TrendSeries {
  name: string;
  color: string;
  points: TrendPoint[];
}

export interface TrendChartProps {
  series: TrendSeries[];
  height?: number;
  yDomain?: [number, number];
  yLabel?: string;
  valueFormatter?: (v: number) => string;
}

const VIEW_WIDTH = 720;
const MARGIN = { top: 16, right: 16, left: 56 };

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function niceStep(rough: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  if (residual <= 1) return magnitude;
  if (residual <= 2) return 2 * magnitude;
  if (residual <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function buildTicks(lo: number, hi: number): number[] {
  if (!(hi > lo)) return [lo];
  const step = niceStep((hi - lo) / 5);
  const first = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= hi + step * 1e-6; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}

export function TrendChart({
  series,
  height = 260,
  yDomain,
  yLabel,
  valueFormatter,
}: TrendChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const fmt = valueFormatter ?? ((v: number) => String(Math.round(v)));

  const model = useMemo(() => {
    // Union of x categories, in first-appearance order.
    const xKeys: string[] = [];
    const xIndex = new Map<string, number>();
    for (const s of series) {
      for (const p of s.points) {
        const key = String(p.x);
        if (!xIndex.has(key)) {
          xIndex.set(key, xKeys.length);
          xKeys.push(key);
        }
      }
    }
    // Aligned y values per series (null = gap).
    const values = series.map((s) => {
      const row: (number | null)[] = new Array(xKeys.length).fill(null);
      for (const p of s.points) {
        const idx = xIndex.get(String(p.x));
        if (idx != null && p.y != null && Number.isFinite(p.y)) row[idx] = p.y;
      }
      return row;
    });
    const flat = values.flat().filter((v): v is number => v != null);
    return { xKeys, values, hasData: flat.length > 0, flat };
  }, [series]);

  if (series.length === 0 || !model.hasData) {
    return <s-paragraph>No data yet</s-paragraph>;
  }

  const { xKeys, values, flat } = model;

  let lo: number;
  let hi: number;
  if (yDomain) {
    [lo, hi] = yDomain;
  } else {
    const dataMin = Math.min(...flat);
    const dataMax = Math.max(...flat);
    lo = dataMin >= 0 ? 0 : dataMin;
    hi = dataMax <= lo ? lo + 1 : dataMax * 1.05;
  }
  const ticks = buildTicks(lo, hi);

  const longestLabel = xKeys.reduce((m, k) => Math.max(m, k.length), 0);
  const rotate = xKeys.length > 7 || (xKeys.length > 5 && longestLabel > 7);
  const bottom = rotate ? 8 + longestLabel * 4.6 : 28;
  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - bottom;
  const labelEvery = Math.max(1, Math.ceil(xKeys.length / (rotate ? 12 : 8)));

  const xPos = (i: number) =>
    xKeys.length === 1
      ? MARGIN.left + plotWidth / 2
      : MARGIN.left + (i / (xKeys.length - 1)) * plotWidth;
  const yPos = (v: number) =>
    MARGIN.top + plotHeight - ((v - lo) / (hi - lo || 1)) * plotHeight;

  // Split each series into gap-free segments.
  const segments = values.map((row) => {
    const segs: { i: number; v: number }[][] = [];
    let current: { i: number; v: number }[] = [];
    row.forEach((v, i) => {
      if (v == null) {
        if (current.length) segs.push(current);
        current = [];
      } else {
        current.push({ i, v });
      }
    });
    if (current.length) segs.push(current);
    return segs;
  });

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const viewX = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH;
    const ratio = (viewX - MARGIN.left) / (plotWidth || 1);
    const idx = Math.round(ratio * (xKeys.length - 1));
    setHoverIndex(Math.max(0, Math.min(xKeys.length - 1, idx)));
  };

  const ariaLabel = `${yLabel ? `${yLabel}. ` : ""}Line chart with ${
    series.length
  } series: ${series.map((s) => s.name).join(", ")}, across ${
    xKeys.length
  } runs.`;

  const tooltipPct =
    hoverIndex == null ? 0 : (xPos(hoverIndex) / VIEW_WIDTH) * 100;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <title>{ariaLabel}</title>

        {/* Gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={`tick-${t}`}>
            <line
              x1={MARGIN.left}
              x2={VIEW_WIDTH - MARGIN.right}
              y1={yPos(t)}
              y2={yPos(t)}
              style={{ stroke: "var(--p-color-border-secondary, #e3e3e3)" }}
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 8}
              y={yPos(t) + 3.5}
              textAnchor="end"
              fontSize={11}
              style={{ fill: "var(--p-color-text-secondary, #616161)" }}
            >
              {fmt(t)}
            </text>
          </g>
        ))}

        {/* Baseline + axis label */}
        <line
          x1={MARGIN.left}
          x2={VIEW_WIDTH - MARGIN.right}
          y1={MARGIN.top + plotHeight}
          y2={MARGIN.top + plotHeight}
          style={{ stroke: "var(--p-color-border, #c9c9c9)" }}
          strokeWidth={1}
        />
        {yLabel ? (
          <text
            x={MARGIN.left}
            y={10}
            fontSize={11}
            style={{ fill: "var(--p-color-text-secondary, #616161)" }}
          >
            {yLabel}
          </text>
        ) : null}

        {/* X labels, thinned and rotated when crowded */}
        {xKeys.map((key, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`x-${i}`}
              x={xPos(i)}
              y={MARGIN.top + plotHeight + 16}
              fontSize={11}
              style={{ fill: "var(--p-color-text-secondary, #616161)" }}
              textAnchor={
                rotate
                  ? "end"
                  : i === 0
                    ? "start"
                    : i === xKeys.length - 1
                      ? "end"
                      : "middle"
              }
              transform={
                rotate
                  ? `rotate(-35 ${xPos(i)} ${MARGIN.top + plotHeight + 16})`
                  : undefined
              }
            >
              {key}
            </text>
          ) : null,
        )}

        {/* Hover crosshair */}
        {hoverIndex != null ? (
          <line
            x1={xPos(hoverIndex)}
            x2={xPos(hoverIndex)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotHeight}
            style={{ stroke: "var(--p-color-border, #c9c9c9)" }}
            strokeWidth={1}
          />
        ) : null}

        {/* Series lines (gaps skipped) */}
        {series.map((s, si) =>
          segments[si].map((seg, gi) =>
            seg.length > 1 ? (
              <polyline
                key={`line-${si}-${gi}`}
                points={seg.map((p) => `${xPos(p.i)},${yPos(p.v)}`).join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null,
          ),
        )}

        {/* Dots with a 2px surface ring */}
        {series.map((s, si) =>
          values[si].map((v, i) =>
            v == null ? null : (
              <circle
                key={`dot-${si}-${i}`}
                cx={xPos(i)}
                cy={yPos(v)}
                r={hoverIndex === i ? 5 : 4}
                fill={s.color}
                style={{ stroke: "var(--p-color-bg-surface, #ffffff)" }}
                strokeWidth={2}
              />
            ),
          ),
        )}
      </svg>

      {/* Tooltip */}
      {hoverIndex != null ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            ...(tooltipPct <= 50
              ? { left: `${tooltipPct}%` }
              : { right: `${100 - tooltipPct}%` }),
            pointerEvents: "none",
            background: "var(--p-color-bg-surface, #ffffff)",
            border: "1px solid var(--p-color-border, #c9c9c9)",
            borderRadius: 8,
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            padding: "6px 10px",
            fontSize: 12,
            whiteSpace: "nowrap",
            zIndex: 10,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            {xKeys[hoverIndex]}
          </div>
          {series.map((s, si) => (
            <div
              key={`tt-${si}`}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: s.color,
                  display: "inline-block",
                }}
              />
              <span style={{ color: "var(--p-color-text-secondary, #616161)" }}>
                {s.name}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {values[si][hoverIndex] == null
                  ? "—"
                  : fmt(values[si][hoverIndex] as number)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Legend */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 16px",
          marginTop: 8,
          fontSize: 12,
          color: "var(--p-color-text-secondary, #616161)",
        }}
      >
        {series.map((s) => (
          <span
            key={`legend-${s.name}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: s.color,
                display: "inline-block",
              }}
            />
            {s.name}
          </span>
        ))}
      </div>

      {/* Screen-reader data table fallback */}
      <table style={VISUALLY_HIDDEN}>
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            {series.map((s) => (
              <th key={`h-${s.name}`} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {xKeys.map((key, i) => (
            <tr key={`r-${i}`}>
              <th scope="row">{key}</th>
              {series.map((s, si) => (
                <td key={`c-${si}-${i}`}>
                  {values[si][i] == null ? "—" : fmt(values[si][i] as number)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
