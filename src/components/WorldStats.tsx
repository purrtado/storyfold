import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { STAT_KINDS, type StatDefinition, type World } from "../../shared/domain";
import { createRequestEpoch } from "../lib/requestEpoch";
import {
  applyWorldStatSaved,
  ensureWorldStats,
  refreshWorldStats,
  refreshWorldStatDependents,
  useWorldStats,
} from "../lib/libraryCache";
import { createWorldStat, deleteStat, fetchStats, importWorldStats, updateStat } from "../lib/storyApi";
import { StatDefinitionEditor } from "./StatDefinitionEditor";
import { STAT_KIND_LABELS, StatDefinitionList } from "./StatDefinitionList";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** The world's own stats: add, edit, delete, and import copies from the stat bank at any time. */
export function WorldStats(props: { world: World }) {
  const worldId = props.world.id;
  const library = useWorldStats(worldId);
  const stats = library.items;
  const [requestEpoch] = useState(createRequestEpoch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ stat: StatDefinition | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const [bank, setBank] = useState<StatDefinition[] | null>(null);
  const [bankLoading, setBankLoading] = useState(false);
  const [bankError, setBankError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    ensureWorldStats(worldId);
    return () => requestEpoch.invalidate();
  }, [worldId, requestEpoch]);

  const removeStat = async (stat: StatDefinition) => {
    if (!window.confirm(`Delete “${stat.label}” from ${props.world.name}? Its values are removed from every character and relationship.`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteStat(stat.id);
      refreshWorldStatDependents(worldId);
    } catch (caught) {
      setError(errorMessage(caught, "Could not delete this stat."));
    } finally {
      setBusy(false);
    }
  };

  const openPicker = async () => {
    setPicking(true);
    setBank(null);
    setBankError("");
    setSelected(new Set());
    const requestId = requestEpoch.next();
    setBankLoading(true);
    try {
      const loaded = await fetchStats();
      if (requestEpoch.isCurrent(requestId)) setBank(loaded);
    } catch (caught) {
      if (requestEpoch.isCurrent(requestId)) setBankError(errorMessage(caught, "Could not load the stat bank."));
    } finally {
      if (requestEpoch.isCurrent(requestId)) setBankLoading(false);
    }
  };

  const importable = (bank ?? []).filter((bankStat) => !(stats ?? []).some((stat) =>
    stat.applies_to === bankStat.applies_to && stat.label.toLowerCase() === bankStat.label.toLowerCase()));

  const importSelected = async () => {
    setImporting(true);
    setError("");
    try {
      await importWorldStats(worldId, [...selected]);
      setPicking(false);
      refreshWorldStatDependents(worldId);
    } catch (caught) {
      setError(errorMessage(caught, "Could not import the selected stats."));
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="grid gap-4 rounded-xl border border-border bg-raised p-5" aria-labelledby="world-stats-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">Meters</p>
          <h2 id="world-stats-title" className="mbs-1 text-lg font-semibold">Stats</h2>
          <p className="mbs-1 max-w-2xl text-sm leading-6 text-muted">Scales the narrator tracks for the characters and relationships of {props.world.name}. Edits never touch the shared stat bank.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="pressable inline-flex min-h-10 flex-none items-center rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
            onClick={() => { void openPicker(); }}
            disabled={busy || importing}
          >
            Import from bank
          </button>
          <button
            type="button"
            className="pressable inline-flex min-h-10 flex-none items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
            onClick={(event) => {
              openerRef.current = event.currentTarget;
              setEditor({ stat: null });
            }}
            disabled={busy}
          >
            <Plus className="size-4" aria-hidden="true" />Add stat
          </button>
        </div>
      </header>

      {error && <p className="text-sm text-muted" role="alert">{error}</p>}
      {library.refreshError && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
          {library.refreshError}
          <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface" onClick={() => refreshWorldStats(worldId)}>Retry</button>
        </p>
      )}

      {stats === undefined ? (
        library.loadError ? (
          <section className="grid justify-items-start gap-3 rounded-lg border border-border p-5" role="alert">
            <p className="text-sm text-muted">{library.loadError}</p>
            <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => refreshWorldStats(worldId)}>Try again</button>
          </section>
        ) : <p className="text-sm text-muted" role="status">Loading this world’s stats…</p>
      ) : stats.length === 0 ? (
        <p className="text-sm text-muted">No stats in this world yet.</p>
      ) : (
        <StatDefinitionList
          stats={stats}
          busy={busy}
          onDelete={(stat) => { void removeStat(stat); }}
          onEdit={(stat) => setEditor({ stat })}
        />
      )}

      {picking && (
        <div className="grid gap-3 rounded-xl border border-border bg-surface p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-medium">Import from the stat bank</h3>
              <p className="text-xs text-muted">Copies become this world’s own stats and start at their defaults for every character and relationship.</p>
            </div>
            <button
              type="button"
              className="pressable inline-flex size-9 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"
              onClick={() => setPicking(false)}
              disabled={importing}
              aria-label="Close the stat bank"
            ><X className="size-4" aria-hidden="true" /></button>
          </div>
          {bankError && <p className="text-sm text-muted" role="alert">{bankError}</p>}
          {bankLoading && <p className="text-sm text-muted" role="status">Loading the stat bank…</p>}
          {bank && (
            importable.length === 0 ? (
              <p className="text-sm text-muted">Every bank stat is already in this world.</p>
            ) : (
              <>
                {STAT_KINDS.map((kind) => {
                  const group = importable.filter((stat) => stat.applies_to === kind);
                  if (group.length === 0) return null;
                  return (
                    <div key={kind} className="grid gap-2">
                      <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">{STAT_KIND_LABELS[kind]}</h4>
                      <ul className="grid list-none gap-3 p-0">
                        {group.map((stat) => (
                          <li key={stat.id}>
                            <label className="flex items-start gap-3 text-sm">
                              <input
                                type="checkbox"
                                className="mbs-1 size-4 flex-none accent-accent"
                                checked={selected.has(stat.id)}
                                disabled={importing}
                                onChange={() => setSelected((current) => {
                                  const next = new Set(current);
                                  if (next.has(stat.id)) next.delete(stat.id); else next.add(stat.id);
                                  return next;
                                })}
                              />
                              <span className="grid min-w-0 flex-1 gap-0.5">
                                <span className="font-medium">{stat.label}</span>
                                <span className="text-xs text-muted">{stat.description} · {stat.min}–{stat.max}, starts at {stat.default_value}</span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="pressable min-h-11 w-fit rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => { void importSelected(); }}
                  disabled={selected.size === 0 || importing}
                >
                  {importing ? "Importing…" : `Import ${selected.size || ""} stat${selected.size === 1 ? "" : "s"}`.trim()}
                </button>
              </>
            )
          )}
        </div>
      )}

      {editor && (
        <StatDefinitionEditor
          stat={editor.stat}
          title={editor.stat ? `Edit ${editor.stat.label}` : "Add a world stat"}
          description={`This stat belongs to ${props.world.name}.`}
          openerRef={openerRef}
          onCreate={(input) => createWorldStat(worldId, input)}
          onUpdate={updateStat}
          onSaved={(saved, previousId) => {
            applyWorldStatSaved(worldId, saved, previousId);
            if (!previousId) refreshWorldStatDependents(worldId);
          }}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
}
