// Inline delta indicator: ▲/▼ + formatted value inside an s-badge whose tone
// encodes whether the change is an improvement (depends on goodDirection).
// Renders nothing when delta is null.

export interface DeltaBadgeProps {
  delta: number | null;
  /** Which direction is an improvement for this metric. */
  goodDirection: "up" | "down";
  formatter?: (v: number) => string;
}

function defaultFormat(v: number): string {
  if (v >= 100) return String(Math.round(v));
  return String(Math.round(v * 100) / 100);
}

export function DeltaBadge({ delta, goodDirection, formatter }: DeltaBadgeProps) {
  if (delta == null || !Number.isFinite(delta)) return null;

  const fmt = formatter ?? defaultFormat;
  const text = fmt(Math.abs(delta));

  if (delta === 0) {
    return <s-badge tone="neutral">{`± ${text}`}</s-badge>;
  }

  const improving = delta > 0 ? goodDirection === "up" : goodDirection === "down";
  const arrow = delta > 0 ? "▲" : "▼";

  return (
    <s-badge tone={improving ? "success" : "critical"}>
      {`${arrow} ${text}`}
    </s-badge>
  );
}
