// Circular 0–100 score indicator with Lighthouse color bands.
// Grey ring + em dash when the score is null (no data).

import { fmtScore, scoreColor } from "./format";

export interface ScoreRingProps {
  score: number | null;
  label: string;
  size?: number;
}

export function ScoreRing({ score, label, size = 96 }: ScoreRingProps) {
  const clamped =
    score == null || !Number.isFinite(score)
      ? null
      : Math.max(0, Math.min(100, score));
  const color = scoreColor(clamped);
  const strokeWidth = Math.max(6, Math.round(size / 12));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = clamped == null ? 0 : (clamped / 100) * circumference;
  const center = size / 2;
  const ariaLabel = `${label}: ${clamped == null ? "no data" : fmtScore(clamped)} out of 100`;

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel}
      >
        <title>{ariaLabel}</title>
        {/* Track: lighter step of the same band color; solid grey when null */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={clamped == null ? "#e3e3e3" : color}
          strokeOpacity={clamped == null ? 1 : 0.16}
          strokeWidth={strokeWidth}
        />
        {clamped != null ? (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference - filled}`}
            transform={`rotate(-90 ${center} ${center})`}
          />
        ) : null}
        <text
          x={center}
          y={center + size * 0.1}
          textAnchor="middle"
          fontSize={size * 0.28}
          fontWeight={600}
          style={{ fill: "var(--p-color-text, #1a1a1a)" }}
        >
          {clamped == null ? "—" : fmtScore(clamped)}
        </text>
      </svg>
      <span
        style={{
          fontSize: 12,
          color: "var(--p-color-text-secondary, #616161)",
          textAlign: "center",
          maxWidth: size + 24,
        }}
      >
        {label}
      </span>
    </div>
  );
}
