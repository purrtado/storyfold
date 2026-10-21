import type { RelationshipDocument } from "../../shared/domain";

type Stat = RelationshipDocument["stats"][string];

function percent(value: number, stat: Stat) {
  const span = stat.max - stat.min;
  if (span <= 0) return 0;
  return Math.min(100, Math.max(0, ((value - stat.min) / span) * 100));
}

/** One named range as a meter; ranges spanning zero fill outward from the zero mark. */
export function StatBar(props: { name: string; stat: Stat }) {
  const { stat } = props;
  const signed = stat.min < 0 && stat.max > 0;
  const origin = signed ? percent(0, stat) : 0;
  const end = percent(stat.value, stat);
  const start = Math.min(origin, end);
  const width = Math.abs(end - origin);
  const negative = signed && stat.value < 0;
  const display = signed && stat.value > 0 ? `+${stat.value}` : `${stat.value}`;
  return (
    <div className="grid grid-cols-[minmax(0,6rem)_1fr_2.5rem] items-center gap-x-3 text-xs">
      <span className="truncate text-muted capitalize">{props.name}</span>
      <div
        role="meter"
        aria-label={props.name}
        aria-valuenow={stat.value}
        aria-valuemin={stat.min}
        aria-valuemax={stat.max}
        className="relative block-2 overflow-clip rounded-full bg-border"
      >
        <span
          className="stat-fill absolute inset-bs-0 inset-be-0 rounded-full"
          style={{
            insetInlineStart: `${start}%`,
            inlineSize: `${width}%`,
            background: negative ? "var(--stat-negative)" : "var(--accent)",
          }}
        />
        {signed && <span className="absolute inset-bs-0 inset-be-0 inline-px bg-muted" style={{ insetInlineStart: `${origin}%` }} />}
      </div>
      <span className="text-end font-medium tabular-nums">{display}</span>
    </div>
  );
}

export function StatBars(props: { stats: RelationshipDocument["stats"] }) {
  const entries = Object.entries(props.stats);
  if (entries.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      {entries.map(([name, stat]) => <StatBar key={name} name={name} stat={stat} />)}
    </div>
  );
}
