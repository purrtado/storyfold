import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { StatDefinition } from "../../shared/domain";
import { createStat, deleteStat, updateStat } from "../lib/storyApi";
import { applyStatRemoved, applyStatSaved, refreshStats, useStats } from "../lib/libraryCache";
import { AppHeader } from "./AppHeader";
import { StatDefinitionEditor } from "./StatDefinitionEditor";
import { StatDefinitionList } from "./StatDefinitionList";
import "./settings.css";

export function StatsSettingsPage(props: { onOpenSidebar: () => void }) {
  const library = useStats();
  const stats = library.items;
  const [editor, setEditor] = useState<{ stat: StatDefinition | null } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    refreshStats();
  }, []);

  const removeStat = async (stat: StatDefinition) => {
    if (!window.confirm(`Delete “${stat.label}” from the stat bank? Worlds and campaigns that already use it keep their copy.`)) return;
    setDeletingId(stat.id);
    setActionError("");
    try {
      await deleteStat(stat.id);
      applyStatRemoved(stat.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not delete this stat.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="Settings" onOpenSidebar={props.onOpenSidebar} />

      <div className="chat-scroll settings-scroll">
        <main className="settings-main">
          <h2 className="settings-heading">Stats</h2>

          <section className="theme-group grid gap-4" aria-labelledby="stat-bank-title">
            <div className="theme-body">
              <div className="theme-copy">
                <p id="stat-bank-title" className="theme-label">Stat bank</p>
                <p className="theme-desc">
                  Reusable meters for characters and relationships. New worlds can import them; existing ones keep their copies.
                </p>
              </div>
              <button
                type="button"
                className="pressable inline-flex min-h-10 flex-none items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                onClick={(event) => {
                  openerRef.current = event.currentTarget;
                  setEditor({ stat: null });
                }}
              >
                <Plus className="size-4" aria-hidden="true" />Add stat
              </button>
            </div>

            {library.refreshError && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" role="status">
                {library.refreshError}
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => refreshStats()}>Retry</button>
              </p>
            )}
            {actionError && <p className="text-sm text-muted" role="alert">{actionError}</p>}

            {stats === undefined ? (
              library.loadError ? (
                <section className="grid justify-items-start gap-3 rounded-lg border border-border p-5" role="alert">
                  <p className="text-sm text-muted">{library.loadError}</p>
                  <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => refreshStats()}>Try again</button>
                </section>
              ) : (
                <p className="text-sm text-muted" role="status">Loading stats…</p>
              )
            ) : stats.length === 0 ? (
              <p className="text-sm text-muted">
                No stats yet. Character stats track one character; relationship stats score a pair.
              </p>
            ) : (
              <StatDefinitionList
                stats={stats}
                busy={deletingId !== null}
                onDelete={(stat) => { void removeStat(stat); }}
                onEdit={(stat) => setEditor({ stat })}
              />
            )}
          </section>
        </main>
      </div>

      {editor && (
        <StatDefinitionEditor
          stat={editor.stat}
          title={editor.stat ? `Edit ${editor.stat.label}` : "Add a stat"}
          description={editor.stat ? "Changes apply where this stat is used." : "Character stats follow one character; relationship stats score a pair."}
          openerRef={openerRef}
          onCreate={createStat}
          onUpdate={updateStat}
          onSaved={applyStatSaved}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
