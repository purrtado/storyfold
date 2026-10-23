import { Pencil, Trash2 } from "lucide-react";
import { STAT_KINDS, type StatFields, type StatKind } from "../../shared/domain";

export const STAT_KIND_LABELS: Record<StatKind, string> = {
  character: "Character stats",
  relationship: "Relationship stats",
};

/** Stats grouped by kind with edit/delete; callers own persistence. */
export function StatDefinitionList<T extends StatFields & { id: string }>(props: {
  stats: ReadonlyArray<T>;
  onEdit: (stat: T) => void;
  onDelete: (stat: T) => void;
  busy?: boolean;
}) {
  if (props.stats.length === 0) return null;
  return (
    <div className="grid gap-5">
      {STAT_KINDS.map((kind) => {
        const group = props.stats.filter((stat) => stat.applies_to === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} className="grid gap-2" aria-label={STAT_KIND_LABELS[kind]}>
            <h4 className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">{STAT_KIND_LABELS[kind]}</h4>
            <ul className="grid list-none gap-3 p-0">
              {group.map((stat) => (
                <li key={stat.id} className="flex items-start justify-between gap-3 border-bs border-border pbs-3 first:border-0 first:pbs-0">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mbs-1.5 size-3 flex-none rounded-full" style={{ background: `var(--stat-${stat.color})` }} aria-hidden="true" />
                    <div className="min-w-0">
                      <h5 className="font-medium leading-snug">{stat.label}</h5>
                      {stat.description && <p className="mbs-0.5 whitespace-pre-wrap text-sm leading-6 text-muted">{stat.description}</p>}
                      <p className="mbs-0.5 text-xs text-muted">
                        {stat.min}–{stat.max}, {stat.low_label} → {stat.high_label}, starts at {stat.default_value}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-none items-center gap-1">
                    <button
                      type="button"
                      className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                      aria-label={`Edit ${stat.label}`}
                      onClick={() => props.onEdit(stat)}
                      disabled={props.busy}
                    ><Pencil className="size-4" aria-hidden="true" /></button>
                    <button
                      type="button"
                      className="pressable hit-44 inline-flex size-9 items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
                      aria-label={`Delete ${stat.label}`}
                      onClick={() => props.onDelete(stat)}
                      disabled={props.busy}
                    ><Trash2 className="size-4" aria-hidden="true" /></button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
