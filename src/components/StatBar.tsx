import type { StatFields, StatValues } from "../../shared/domain";

function percent(value: number, stat: Pick<StatFields, "min" | "max">) {
  const span = stat.max - stat.min;
  if (span <= 0) return 0;
  return Math.min(100, Math.max(0, ((value - stat.min) / span) * 100));
}

/** One stat as a meter; ranges spanning zero fill outward from the zero mark. */
export function StatBar(props: { stat: StatFields; value: number }) {
  const { stat } = props;
  const signed = stat.min < 0 && stat.max > 0;
  const origin = signed ? percent(0, stat) : 0;
  const end = percent(props.value, stat);
  const start = Math.min(origin, end);
  const width = Math.abs(end - origin);
  const scale = `${stat.low_label} → ${stat.high_label}`;
  return (
    <div
      className="grid grid-cols-[minmax(0,6rem)_1fr_3rem] items-center gap-x-3 text-xs"
      title={`${scale} (${stat.min} to ${stat.max})`}
    >
      <span className="truncate text-muted capitalize">{stat.label}</span>
      <div
        role="meter"
        aria-label={`${stat.label} (${scale})`}
        aria-valuenow={props.value}
        aria-valuemin={stat.min}
        aria-valuemax={stat.max}
        className="relative block-2 overflow-clip rounded-full bg-border"
      >
        <span
          className="stat-fill absolute inset-bs-0 inset-be-0 rounded-full"
          style={{
            insetInlineStart: `${start}%`,
            inlineSize: `${width}%`,
            background: `var(--stat-${stat.color})`,
          }}
        />
        {signed && <span className="absolute inset-bs-0 inset-be-0 inline-px bg-muted" style={{ insetInlineStart: `${origin}%` }} />}
      </div>
      <span className="text-end font-medium tabular-nums">{props.value}/{stat.max}</span>
    </div>
  );
}

/** Bars in definition order; a stat without a value falls back to its default. */
export function StatBars(props: { stats: ReadonlyArray<StatFields & { id: string }>; values: StatValues }) {
  if (props.stats.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      {props.stats.map((stat) => (
        <StatBar key={stat.id} stat={stat} value={props.values[stat.id] ?? stat.default_value} />
      ))}
    </div>
  );
}
