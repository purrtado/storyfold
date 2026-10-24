import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  CHARACTER_PROFILE_FIELDS,
  type Campaign,
  type CampaignCharacter,
  type CampaignStat,
  type Relationship,
  type StatValues,
  protagonistOf,
} from "../../shared/domain";
import { Avatar, imageUrl } from "./Avatar";
import { CharacterProfileDialog } from "./CharacterProfileDialog";
import { StatBar, StatBars } from "./StatBar";
import { createRequestEpoch } from "../lib/requestEpoch";
import {
  createCampaignCharacter,
  createCampaignRelationship,
  deleteCampaignCharacter,
  deleteCampaignCharacterAvatar,
  deleteCampaignRelationship,
  fetchCampaignRelationships,
  saveCampaignCharacterToWorld,
  updateCampaignCharacter,
  updateCampaignRelationship,
  uploadCampaignCharacterAvatar,
} from "../lib/storyApi";

type RelationshipDraft = {
  how_met: string;
  status: string;
  known_facts: string[];
  stats: StatValues;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statEntries(stats: CampaignStat[], values: StatValues) {
  return stats.map((stat) => ({ stat, value: values[stat.id] ?? stat.default_value }));
}

/** Number input that commits the integer on blur or Enter; empty or invalid edits are discarded. */
function StatValueInput(props: { stat: CampaignStat; value: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [text, setText] = useState(() => String(props.value));
  useEffect(() => { setText(String(props.value)); }, [props.value]);
  const commit = () => {
    const next = Number(text);
    if (!text.trim() || !Number.isInteger(next) || next < props.stat.min || next > props.stat.max || next === props.value) {
      setText(String(props.value));
      return;
    }
    props.onCommit(next);
  };
  return (
    <input
      type="number"
      className="min-h-9 w-16 flex-none rounded-lg border border-border bg-background px-2 text-sm tabular-nums"
      min={props.stat.min}
      max={props.stat.max}
      value={text}
      disabled={props.disabled}
      aria-label={`${props.stat.label} value`}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function CharacterStatsSection(props: {
  character: CampaignCharacter;
  stats: CampaignStat[];
  busy: boolean;
  onToggle: () => void;
  onValueChange: (statId: string, value: number) => void;
}) {
  return (
    <section className="grid gap-2" aria-label={`${props.character.name} stats`}>
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 flex-none accent-accent"
          checked={props.character.stats_enabled}
          disabled={props.busy}
          onChange={props.onToggle}
        />
        Track stats
      </label>
      {props.character.stats_enabled && (
        props.stats.length === 0 ? (
          <p className="text-sm text-muted">No character stats are defined in the Campaign tab yet.</p>
        ) : (
          <div className="grid gap-1.5">
            {statEntries(props.stats, props.character.stats).map(({ stat, value }) => (
              <div key={stat.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <StatBar stat={stat} value={value} />
                </div>
                <StatValueInput
                  stat={stat}
                  value={value}
                  disabled={props.busy}
                  onCommit={(next) => props.onValueChange(stat.id, next)}
                />
              </div>
            ))}
          </div>
        )
      )}
    </section>
  );
}

function RelationshipDetails(props: { relationship: Relationship; stats: CampaignStat[] }) {
  const relationship = props.relationship;
  const hasContent = relationship.how_met.trim() || relationship.status.trim()
    || props.stats.length > 0 || relationship.known_facts.length > 0;
  return (
    <section className="grid gap-2 rounded-xl border border-border bg-surface p-3" aria-label="Current state">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">Current state</p>
      {!hasContent ? <p className="text-sm text-muted">No current details recorded.</p> : (
        <div className="grid gap-3 text-sm">
          {relationship.how_met.trim() && <div className="grid gap-1"><p className="text-xs font-medium text-muted">How they met</p><p className="whitespace-pre-wrap break-words">{relationship.how_met}</p></div>}
          {relationship.status.trim() && <div className="grid gap-1"><p className="text-xs font-medium text-muted">Status</p><p className="whitespace-pre-wrap break-words">{relationship.status}</p></div>}
          {props.stats.length > 0 && <StatBars stats={props.stats} values={relationship.stats} />}
          {relationship.known_facts.length > 0 && (
            <div className="grid gap-1">
              <p className="text-xs font-medium text-muted">Known facts</p>
              <ul className="grid list-disc gap-1 ps-5">
                {relationship.known_facts.map((fact, index) => <li key={index} className="whitespace-pre-wrap break-words">{fact}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RelationshipRow(props: {
  relationship: Relationship;
  sourceLabel: string;
  targetLabel: string;
  stats: CampaignStat[];
  editing: boolean;
  editor?: ReactNode;
  onEdit: () => void;
  onDelete: () => void;
  deleteBusy: boolean;
  actionsDisabled: boolean;
  confirmDelete: boolean;
  deleteError: string;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  summaryRef: (element: HTMLElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const reveal = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) setExpanded(true);
  };

  const relationshipTitle = `${props.sourceLabel} → ${props.targetLabel}`;
  const status = props.relationship.status.trim();
  const entries = statEntries(props.stats, props.relationship.stats);
  const statSummary = [
    ...entries.slice(0, 2).map(({ stat, value }) => `${stat.label} ${value}/${stat.max}`),
    ...(entries.length > 2 ? [`+${entries.length - 2} more`] : []),
  ].join(" · ");
  return (
    <article className="grid min-w-0 rounded-2xl border border-border">
      <details className="group" onToggle={reveal}>
        <summary
          ref={props.summaryRef}
          className="flex cursor-pointer flex-wrap items-start gap-x-2 gap-y-1 rounded-t-2xl p-3 text-sm active:bg-raised group-not-open:rounded-2xl [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [&::-webkit-details-marker]:hidden"
        >
          <ChevronRight className="mbs-1 size-3.5 shrink-0 text-muted [@media(prefers-reduced-motion:no-preference)]:transition-transform group-open:rotate-90" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words font-medium">
            <span>{props.sourceLabel}</span> <span className="sr-only">points to</span> <span aria-hidden="true" className="text-muted">→</span> <span>{props.targetLabel}</span>
          </span>
          {(status || statSummary) && (
            <span className="grid min-w-0 basis-full gap-1 pis-5 text-muted">
              {status && <span className="truncate">{status}</span>}
              {statSummary && <span className="truncate text-xs tabular-nums">{statSummary}</span>}
            </span>
          )}
        </summary>
        {expanded && (
          <div className="grid min-w-0 gap-3 border-bs border-border p-3">
            <p className="text-xs text-muted">Updated {formatDate(props.relationship.updated_at)}</p>
            {props.editor}
            {!props.editing && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={props.onEdit} disabled={props.actionsDisabled}>Edit</button>
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={props.onDelete} disabled={props.deleteBusy || props.actionsDisabled}>Delete</button>
              </div>
            )}
            {props.confirmDelete && (
              <div className="grid gap-2 rounded-lg border border-border p-3" role="group" aria-label={`Confirm deleting ${relationshipTitle}`}>
                <p className="text-sm">Delete this directed relationship?</p>
                {props.deleteError && <p className="text-sm text-muted" role="alert">{props.deleteError}</p>}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={props.onConfirmDelete} disabled={props.deleteBusy || props.actionsDisabled}>{props.deleteBusy ? "Deleting…" : "Delete relationship"}</button>
                  <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={props.onCancelDelete} disabled={props.deleteBusy || props.actionsDisabled}>Cancel</button>
                </div>
              </div>
            )}
            {!props.editing && <RelationshipDetails relationship={props.relationship} stats={props.stats} />}
          </div>
        )}
      </details>
    </article>
  );
}

function Profile({ character }: { character: CampaignCharacter }) {
  const fields = CHARACTER_PROFILE_FIELDS.filter((field) => !field.required && character[field.key]);
  return (
    <section className="grid gap-2 text-sm" aria-label={`${character.name} profile`}>
      <p className="whitespace-pre-wrap leading-6">{character.description}</p>
      {fields.length > 0 && (
        <dl className="grid gap-2">
          {fields.map((field) => (
            <div key={field.key} className="grid gap-0.5">
              <dt className="text-xs font-medium text-muted">{field.label}</dt>
              <dd className="whitespace-pre-wrap leading-6">{character[field.key]}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function CharacterCard(props: {
  character: CampaignCharacter;
  you: boolean;
  open: boolean;
  onToggle: () => void;
  status: string;
  stats: { label: string; stats: CampaignStat[]; values: StatValues }[];
  toggleRef: (element: HTMLButtonElement | null) => void;
  children: ReactNode;
}) {
  const panelId = `character-panel-${props.character.id}`;
  return (
    <article className="grid min-w-0 rounded-2xl border border-border bg-background" aria-label={props.character.name}>
      <button
        ref={props.toggleRef}
        type="button"
        aria-expanded={props.open}
        aria-controls={panelId}
        onClick={props.onToggle}
        className="flex min-w-0 items-center gap-3 rounded-2xl p-3 text-start active:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
      >
        <Avatar name={props.character.name} imageId={props.character.avatar_id} className={props.you ? "size-14 text-lg" : "size-11 text-sm"} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`truncate font-semibold ${props.you ? "text-base" : "text-sm"}`}>{props.character.name}</span>
            <span className={`flex-none rounded-full px-2 text-xs leading-5 ${props.you ? "bg-accent-soft text-accent" : "bg-surface text-muted"}`}>{props.you ? "You" : "Cast"}</span>
          </span>
          {props.status
            ? <span className="truncate text-sm text-muted">{props.status}</span>
            : props.you && props.character.description && <span className="line-clamp-2 text-sm text-muted">{props.character.description}</span>}
        </span>
        <ChevronDown className={`size-4 flex-none text-muted [@media(prefers-reduced-motion:no-preference)]:transition-transform ${props.open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {props.stats.length > 0 && (
        <div className="grid gap-3 px-3 pbe-3">
          {props.stats.map((group) => (
            <div key={group.label} className="grid gap-1.5">
              {props.stats.length > 1 && <p className="text-xs font-medium text-muted">{group.label}</p>}
              <StatBars stats={group.stats} values={group.values} />
            </div>
          ))}
        </div>
      )}
      {props.open && <div id={panelId} className="grid min-w-0 gap-3 border-bs border-border p-3">{props.children}</div>}
    </article>
  );
}

export function CharacterRoster(props: {
  campaign: Campaign;
  sessionId: string;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  /** Changes when play asks to reveal the open card; it then scrolls to the card's top. */
  revealKey?: number;
  /** The reveal waits until the roster's tab panel is shown. */
  visible?: boolean;
  onSyncSession: (sessionId: string) => Promise<void>;
}) {
  const [requestEpoch] = useState(createRequestEpoch);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [creatingRelationship, setCreatingRelationship] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [draft, setDraft] = useState<RelationshipDraft>({ how_met: "", status: "", known_facts: [], stats: {} });
  const [editorError, setEditorError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [createCardId, setCreateCardId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ character: CampaignCharacter | null } | null>(null);
  const [saveConfirmId, setSaveConfirmId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [characterBusyId, setCharacterBusyId] = useState<string | null>(null);
  const [characterAction, setCharacterAction] = useState<{ id: string; message: string } | null>(null);
  const summaryRefs = useRef(new Map<string, HTMLElement>());
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const loadRelationships = useCallback(async () => {
    const requestId = requestEpoch.next();
    setLoading(true);
    setLoadError("");
    try {
      const loaded = await fetchCampaignRelationships(props.campaign.id);
      if (requestEpoch.isCurrent(requestId)) setRelationships(loaded);
    } catch (error) {
      if (requestEpoch.isCurrent(requestId)) setLoadError(errorMessage(error, "Could not load campaign relationships."));
    } finally {
      if (requestEpoch.isCurrent(requestId)) setLoading(false);
    }
  }, [props.campaign.id, requestEpoch]);

  const characterLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const character of props.campaign.characters) {
      counts.set(character.name, (counts.get(character.name) ?? 0) + 1);
    }
    return new Map(props.campaign.characters.map((character): [string, string] => {
      if (character.role === "protagonist") return [character.id, "You"];
      const duplicate = (counts.get(character.name) ?? 0) > 1;
      return [character.id, duplicate ? `${character.name} · ${character.id.slice(0, 8)}` : character.name];
    }));
  }, [props.campaign.characters]);

  const characterStats = useMemo(
    () => props.campaign.stats.filter((stat) => stat.applies_to === "character"),
    [props.campaign],
  );
  const relationshipStats = useMemo(
    () => props.campaign.stats.filter((stat) => stat.applies_to === "relationship"),
    [props.campaign],
  );

  // The write already succeeded; a failed refresh is recovered by the next focus/session load.
  const syncCampaign = useCallback(() => {
    void props.onSyncSession(props.sessionId).catch(() => {});
  }, [props.onSyncSession, props.sessionId]);

  const protagonistId = protagonistOf(props.campaign).id;
  const worldName = props.campaign.world_snapshot.name;
  const relationshipLabel = (id: string) => characterLabels.get(id) ?? `Unavailable reference (${id})`;
  const cardOwner = (relationship: Relationship) =>
    relationship.source_id === protagonistId ? relationship.target_id : relationship.source_id;

  const resetEditor = useCallback(() => {
    setCreatingRelationship(false);
    setCreateCardId(null);
    setEditingId(null);
    setSourceId("");
    setTargetId("");
    setDraft({ how_met: "", status: "", known_facts: [], stats: {} });
    setEditorError("");
  }, []);
  useEffect(() => {
    setRelationships([]);
    setLoadError("");
    setConfirmDeleteId(null);
    setDeleteBusyId(null);
    setDeleteErrors({});
    setSaving(false);
    setPendingFocusId(null);
    setEditor(null);
    setSaveConfirmId(null);
    setSavedId(null);
    setDeleteConfirmId(null);
    setCharacterBusyId(null);
    setCharacterAction(null);
    summaryRefs.current.clear();
    resetEditor();
    void loadRelationships();
    return () => requestEpoch.invalidate();
  }, [loadRelationships, requestEpoch, resetEditor]);

  const openCreate = (cardId: string) => {
    setCreatingRelationship(true);
    setCreateCardId(cardId);
    setEditingId(null);
    setSourceId(cardId);
    setTargetId(cardId === protagonistId ? "" : protagonistId);
    setDraft({
      how_met: "",
      status: "",
      known_facts: [],
      stats: Object.fromEntries(relationshipStats.map((stat) => [stat.id, stat.default_value])),
    });
    setEditorError("");
  };

  const openEdit = (relationship: Relationship) => {
    setCreatingRelationship(false);
    setConfirmDeleteId(null);
    setEditingId(relationship.id);
    setSourceId(relationship.source_id);
    setTargetId(relationship.target_id);
    setDraft({
      how_met: relationship.how_met,
      status: relationship.status,
      known_facts: [...relationship.known_facts],
      stats: Object.fromEntries(statEntries(relationshipStats, relationship.stats).map(({ stat, value }) => [stat.id, value])),
    });
    setEditorError("");
  };

  const saveRelationship = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingRelationship && (!sourceId || !targetId)) {
      setEditorError("Choose both a source and a target character.");
      return;
    }
    if (creatingRelationship && sourceId === targetId) {
      setEditorError("A relationship source and target must be different characters.");
      return;
    }
    setSaving(true);
    setEditorError("");
    const fields = {
      how_met: draft.how_met,
      status: draft.status,
      known_facts: draft.known_facts,
      stats: draft.stats,
    };
    try {
      if (creatingRelationship) {
        const created = await createCampaignRelationship(props.campaign.id, {
          source_id: sourceId,
          target_id: targetId,
          ...fields,
        });
        setRelationships((current) => [...current, created]);
        setPendingFocusId(created.id);
      } else if (editingId) {
        const updated = await updateCampaignRelationship(props.campaign.id, editingId, fields);
        setRelationships((current) => current.map((relationship) => relationship.id === updated.id ? updated : relationship));
        setPendingFocusId(editingId);
      }
      resetEditor();
    } catch (error) {
      setEditorError(errorMessage(error, "Could not save relationship."));
    } finally {
      setSaving(false);
    }
  };

  const removeRelationship = async (relationshipId: string) => {
    setDeleteBusyId(relationshipId);
    setDeleteErrors((current) => ({ ...current, [relationshipId]: "" }));
    const deleted = relationships.find((relationship) => relationship.id === relationshipId);
    const remaining = relationships.filter((relationship) => relationship.id !== relationshipId);
    try {
      await deleteCampaignRelationship(props.campaign.id, relationshipId);
      setRelationships(remaining);
      setConfirmDeleteId(null);
      if (editingId === relationshipId) resetEditor();
      const owner = deleted ? cardOwner(deleted) : protagonistId;
      const sibling = remaining.find((relationship) => cardOwner(relationship) === owner);
      setPendingFocusId(sibling ? sibling.id : `card:${owner}`);
    } catch (error) {
      setDeleteErrors((current) => ({ ...current, [relationshipId]: errorMessage(error, "Could not delete relationship."), }));
    } finally {
      setDeleteBusyId(null);
    }
  };

  const changeStatTracking = async (character: CampaignCharacter) => {
    setCharacterBusyId(character.id);
    setCharacterAction(null);
    try {
      await updateCampaignCharacter(props.campaign.id, character.id, { stats_enabled: !character.stats_enabled });
      syncCampaign();
    } catch (error) {
      setCharacterAction({ id: character.id, message: errorMessage(error, "Could not update stat tracking.") });
    } finally {
      setCharacterBusyId(null);
    }
  };

  const setCharacterStat = async (character: CampaignCharacter, statId: string, value: number) => {
    setCharacterBusyId(character.id);
    setCharacterAction(null);
    try {
      await updateCampaignCharacter(props.campaign.id, character.id, { stats: { [statId]: value } });
      syncCampaign();
    } catch (error) {
      setCharacterAction({ id: character.id, message: errorMessage(error, "Could not save this stat value.") });
    } finally {
      setCharacterBusyId(null);
    }
  };

  const profileSaved = (saved: CampaignCharacter, previousId: string | undefined) => {
    if (!previousId) props.onOpenChange(saved.id);
    syncCampaign();
  };

  const saveToWorld = async (character: CampaignCharacter) => {
    setCharacterBusyId(character.id);
    setCharacterAction(null);
    try {
      await saveCampaignCharacterToWorld(props.campaign.id, character.id);
      setSaveConfirmId(null);
      setSavedId(character.id);
      syncCampaign();
    } catch (error) {
      setCharacterAction({ id: character.id, message: errorMessage(error, "Could not save this character to the world.") });
    } finally {
      setCharacterBusyId(null);
    }
  };

  const removeCharacter = async (character: CampaignCharacter) => {
    setCharacterBusyId(character.id);
    setCharacterAction(null);
    try {
      await deleteCampaignCharacter(props.campaign.id, character.id);
      setDeleteConfirmId(null);
      if (props.openId === character.id) props.onOpenChange(null);
      if (editor?.character?.id === character.id) setEditor(null);
      void loadRelationships();
      syncCampaign();
    } catch (error) {
      setCharacterAction({ id: character.id, message: errorMessage(error, "Could not delete this character.") });
    } finally {
      setCharacterBusyId(null);
    }
  };

  const updateDraft = (update: (current: RelationshipDraft) => RelationshipDraft) => {
    setDraft(update);
    setEditorError("");
  };

  const editorForm = (creatingRelationship || editingId) && (
    <form className="grid min-w-0 gap-3 rounded-2xl border border-border bg-surface p-3" onSubmit={(event) => { void saveRelationship(event); }}>
      <div>
        <h4 className="font-semibold">{creatingRelationship ? "Create directed relationship" : "Edit relationship"}</h4>
        <p className="text-xs text-muted">The direction is explicit; changes apply to this campaign only.</p>
      </div>
      {creatingRelationship ? (
        <div className="grid gap-3">
          <label className="grid min-w-0 gap-1 text-sm">
            Source
            <select className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-3" value={sourceId} onChange={(event) => { setSourceId(event.target.value); setEditorError(""); }} required>
              <option value="">Choose source character</option>
              {props.campaign.characters.map((character) => <option key={character.id} value={character.id}>{characterLabels.get(character.id)}</option>)}
            </select>
          </label>
          <p className="text-center text-sm font-medium text-muted" aria-label="points to">→</p>
          <label className="grid min-w-0 gap-1 text-sm">
            Target
            <select className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-3" value={targetId} onChange={(event) => { setTargetId(event.target.value); setEditorError(""); }} required>
              <option value="">Choose target character</option>
              {props.campaign.characters.map((character) => <option key={character.id} value={character.id}>{characterLabels.get(character.id)}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <p className="break-words rounded-lg border border-border p-3 text-sm font-medium">{relationshipLabel(sourceId)} <span aria-hidden="true" className="text-muted">→</span> {relationshipLabel(targetId)}</p>
      )}

      <label className="grid gap-1 text-sm">
        How they met
        <textarea className="min-h-20 rounded-lg border border-border bg-background p-3" rows={3} value={draft.how_met} onChange={(event) => updateDraft((current) => ({ ...current, how_met: event.target.value }))} />
      </label>
      <label className="grid gap-1 text-sm">
        Current status
        <textarea className="min-h-20 rounded-lg border border-border bg-background p-3" rows={3} value={draft.status} onChange={(event) => updateDraft((current) => ({ ...current, status: event.target.value }))} />
      </label>

      <fieldset className="grid gap-2 rounded-xl border border-border p-3">
        <legend className="px-1 text-sm font-medium">Known facts</legend>
        {draft.known_facts.map((fact, index) => (
          <div key={index} className="flex min-w-0 items-start gap-2">
            <textarea className="min-h-14 min-w-0 flex-1 rounded-lg border border-border bg-background p-2 text-sm" rows={2} aria-label={`Known fact ${index + 1}`} value={fact} onChange={(event) => updateDraft((current) => ({ ...current, known_facts: current.known_facts.map((entry, entryIndex) => entryIndex === index ? event.target.value : entry) }))} />
            <button type="button" className="pressable min-h-10 shrink-0 rounded-lg border border-border px-2 text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => updateDraft((current) => ({ ...current, known_facts: current.known_facts.filter((_, entryIndex) => entryIndex !== index) }))}>Remove</button>
          </div>
        ))}
        <button type="button" className="pressable min-h-10 justify-self-start rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => updateDraft((current) => ({ ...current, known_facts: [...current.known_facts, ""] }))}>Add known fact</button>
      </fieldset>

      {relationshipStats.length > 0 && (
        <fieldset className="grid gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">Stats</legend>
          {statEntries(relationshipStats, draft.stats).map(({ stat, value }) => (
            <div key={stat.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <StatBar stat={stat} value={value} />
              </div>
              <input
                type="number"
                className="min-h-9 w-16 flex-none rounded-lg border border-border bg-background px-2 text-sm tabular-nums"
                min={stat.min}
                max={stat.max}
                value={Number.isNaN(value) ? "" : value}
                aria-label={`${stat.label} value`}
                onChange={(event) => {
                  const next = event.currentTarget.valueAsNumber;
                  updateDraft((current) => ({ ...current, stats: { ...current.stats, [stat.id]: next } }));
                }}
              />
            </div>
          ))}
        </fieldset>
      )}

      {editorError && <p className="rounded-lg border border-border p-3 text-sm text-muted" role="alert">{editorError}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>{saving ? "Saving…" : creatingRelationship ? "Create relationship" : "Save changes"}</button>
        <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={resetEditor} disabled={saving}>Cancel</button>
      </div>
    </form>
  );

  useEffect(() => {
    if (!pendingFocusId) return;
    const target = pendingFocusId.startsWith("card:")
      ? cardRefs.current.get(pendingFocusId.slice(5))
      : summaryRefs.current.get(pendingFocusId);
    if (target) {
      target.focus();
      setPendingFocusId(null);
    }
  }, [pendingFocusId, relationships]);

  const revealedKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    // A hidden tab panel cannot scroll; keep the reveal pending until shown.
    if (!props.visible || !props.openId) return;
    const revealing = props.revealKey !== revealedKey.current;
    revealedKey.current = props.revealKey;
    cardRefs.current.get(props.openId)?.scrollIntoView({ block: revealing ? "start" : "nearest" });
  }, [props.openId, props.revealKey, props.visible]);

  const actionsDisabled = saving || deleteBusyId !== null;
  const relationshipRow = (relationship: Relationship) => (
    <RelationshipRow
      key={relationship.id}
      relationship={relationship}
      sourceLabel={relationshipLabel(relationship.source_id)}
      targetLabel={relationshipLabel(relationship.target_id)}
      stats={relationshipStats}
      editing={editingId === relationship.id}
      editor={editingId === relationship.id ? editorForm : undefined}
      onEdit={() => openEdit(relationship)}
      onDelete={() => { setConfirmDeleteId(relationship.id); setDeleteErrors((current) => ({ ...current, [relationship.id]: "" })); }}
      deleteBusy={deleteBusyId === relationship.id}
      actionsDisabled={actionsDisabled}
      confirmDelete={confirmDeleteId === relationship.id}
      deleteError={deleteErrors[relationship.id] ?? ""}
      onConfirmDelete={() => { void removeRelationship(relationship.id); }}
      onCancelDelete={() => setConfirmDeleteId(null)}
      summaryRef={(element) => { if (element) summaryRefs.current.set(relationship.id, element); else summaryRefs.current.delete(relationship.id); }}
    />
  );

  return (
    <section className="grid gap-3" aria-label="Characters">
      {loadError && (
        <div className="grid gap-2 rounded-lg border border-border p-3 text-sm" role="alert">
          <p className="text-muted">{loadError}</p>
          <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void loadRelationships(); }} disabled={loading}>Retry relationships</button>
        </div>
      )}
      {loading && <p className="text-sm text-muted" role="status">Loading relationships…</p>}

      {props.campaign.characters.map((character) => {
        const you = character.role === "protagonist";
        const owned = relationships.filter((relationship) => cardOwner(relationship) === character.id);
        const towardYou = you ? undefined : owned.find((relationship) => relationship.target_id === protagonistId);
        const fromYou = you ? undefined : owned.find((relationship) => relationship.source_id === protagonistId);
        const stats = [
          ...(towardYou && relationshipStats.length > 0 ? [{ label: "How they see you", stats: relationshipStats, values: towardYou.stats }] : []),
          ...(fromYou && relationshipStats.length > 0 ? [{ label: "How you see them", stats: relationshipStats, values: fromYou.stats }] : []),
        ];
        const open = props.openId === character.id;
        return (
          <CharacterCard
            key={character.id}
            character={character}
            you={you}
            open={open}
            onToggle={() => props.onOpenChange(open ? null : character.id)}
            status={towardYou?.status.trim() || fromYou?.status.trim() || ""}
            stats={stats}
            toggleRef={(element) => { if (element) cardRefs.current.set(character.id, element); else cardRefs.current.delete(character.id); }}
          >
            <>
              {character.avatar_id && (
                <img
                  src={imageUrl(character.avatar_id)}
                  alt={`Portrait of ${character.name}`}
                  className="aspect-[3/4] max-h-[60dvh] w-full rounded-xl bg-raised object-contain"
                />
              )}
              <Profile character={character} />
              <CharacterStatsSection
                character={character}
                stats={characterStats}
                busy={characterBusyId === character.id}
                onToggle={() => { void changeStatTracking(character); }}
                onValueChange={(statId, value) => { void setCharacterStat(character, statId, value); }}
              />
              {characterAction?.id === character.id && <p className="text-sm text-muted" role="alert">{characterAction.message}</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setEditor({ character })} disabled={characterBusyId !== null}>Edit</button>
                <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { setSaveConfirmId(character.id); setSavedId(null); setCharacterAction(null); }} disabled={characterBusyId !== null}>Save to world</button>
                {!you && (
                  <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { setDeleteConfirmId(character.id); setCharacterAction(null); }} disabled={characterBusyId !== null}>Delete</button>
                )}
              </div>
              {saveConfirmId === character.id && (
                <div className="grid gap-2 rounded-lg border border-border p-3" role="group" aria-label={`Confirm saving ${character.name} to the world`}>
                  <p className="text-sm">Save “{character.name}” to the world “{worldName}”? The world gets its own copy of the current profile and picture.</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => { void saveToWorld(character); }} disabled={characterBusyId !== null}>{characterBusyId === character.id ? "Saving…" : "Save to world"}</button>
                    <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setSaveConfirmId(null)} disabled={characterBusyId !== null}>Cancel</button>
                  </div>
                </div>
              )}
              {savedId === character.id && <p className="text-sm text-muted" role="status">Saved to “{worldName}”. The world now has its own copy.</p>}
              {deleteConfirmId === character.id && (
                <div className="grid gap-2 rounded-lg border border-border p-3" role="group" aria-label={`Confirm deleting ${character.name}`}>
                  <p className="text-sm">Delete “{character.name}” from this campaign? Their relationships are deleted too.</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => { void removeCharacter(character); }} disabled={characterBusyId !== null}>{characterBusyId === character.id ? "Deleting…" : "Delete character"}</button>
                    <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setDeleteConfirmId(null)} disabled={characterBusyId !== null}>Cancel</button>
                  </div>
                </div>
              )}
              {owned.length > 0 && (
                <section className="grid min-w-0 gap-2" aria-label={`${character.name} relationships`}>
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">Relationships</p>
                  {owned.map(relationshipRow)}
                </section>
              )}
              {createCardId === character.id && editorForm}
              {createCardId !== character.id && (
                <button
                  type="button"
                  className="pressable inline-flex min-h-10 w-fit items-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
                  onClick={() => openCreate(character.id)}
                  disabled={loading || Boolean(loadError) || actionsDisabled}
                >
                  <Plus className="size-4" aria-hidden="true" />Add relationship
                </button>
              )}
            </>
          </CharacterCard>
        );
      })}

      <div className="flex">
        <button
          type="button"
          className="pressable inline-flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-border px-3 text-sm text-muted active:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
          onClick={() => setEditor({ character: null })}
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          New character
        </button>
      </div>

      {editor && (
        <CharacterProfileDialog
          character={editor.character}
          title={editor.character ? `Edit ${editor.character.name}` : "New character"}
          description={editor.character
            ? "Edits change this campaign's own copy of the character."
            : "Adds a narrator-controlled cast character to this campaign."}
          onCreate={(input) => createCampaignCharacter(props.campaign.id, input)}
          onUpdate={(id, input) => updateCampaignCharacter(props.campaign.id, id, input)}
          onAvatarUpload={(id, file) => uploadCampaignCharacterAvatar(props.campaign.id, id, file)}
          onAvatarRemove={(id) => deleteCampaignCharacterAvatar(props.campaign.id, id)}
          onSaved={profileSaved}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
}
