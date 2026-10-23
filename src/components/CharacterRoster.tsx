import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  CHARACTER_PROFILE_FIELDS,
  type Campaign,
  type CampaignCharacter,
  type Relationship,
  type RelationshipDocument,
  protagonistOf,
} from "../../shared/domain";
import { Avatar } from "./Avatar";
import { CharacterProfileDialog } from "./CharacterProfileDialog";
import { StatBars } from "./StatBar";
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

type RelationshipStat = RelationshipDocument["stats"][string];
type RelationshipSection = RelationshipDocument["sections"][number];

function emptyDocument(): RelationshipDocument {
  return { how_met: "", status: "", stats: {}, known_facts: [], sections: [] };
}

function copyDocument(document: RelationshipDocument): RelationshipDocument {
  return {
    how_met: document.how_met,
    status: document.status,
    stats: Object.fromEntries(Object.entries(document.stats).map(([name, stat]) => [name, { ...stat }])),
    known_facts: [...document.known_facts],
    sections: document.sections.map((section) => ({
      ...section,
      value: Array.isArray(section.value) ? [...section.value] : section.value,
    })),
  };
}


function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function validateDocument(value: unknown): { document?: RelationshipDocument; error?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Document must be an object." };
  }
  const document = value as Record<string, unknown>;
  if (!hasOnlyKeys(document, ["how_met", "status", "stats", "known_facts", "sections"])) {
    return { error: "Document must contain only how_met, status, stats, known_facts, and sections." };
  }
  if (typeof document.how_met !== "string" || typeof document.status !== "string") {
    return { error: "How met and status must be text." };
  }
  if (document.stats === null || typeof document.stats !== "object" || Array.isArray(document.stats)) {
    return { error: "Stats must be an object of named numeric ranges." };
  }
  const stats = document.stats as Record<string, unknown>;
  for (const [name, stat] of Object.entries(stats)) {
    if (!name.trim() || stat === null || typeof stat !== "object" || Array.isArray(stat)) {
      return { error: "Each stat needs a name and numeric value, minimum, and maximum." };
    }
    const statRecord = stat as Record<string, unknown>;
    if (!hasOnlyKeys(statRecord, ["value", "min", "max"])) {
      return { error: "Each stat needs a name and numeric value, minimum, and maximum." };
    }
    if (![statRecord.value, statRecord.min, statRecord.max].every((number) => typeof number === "number" && Number.isFinite(number))) {
      return { error: `Stat “${name}” must use finite numbers.` };
    }
    if ((statRecord.min as number) > (statRecord.max as number)) {
      return { error: `Stat “${name}” minimum cannot exceed its maximum.` };
    }
  }
  if (!Array.isArray(document.known_facts) || !document.known_facts.every((fact) => typeof fact === "string")) {
    return { error: "Known facts must be a list of text." };
  }
  if (!Array.isArray(document.sections)) return { error: "Custom sections must be a list." };
  const sectionIds = new Set<string>();
  for (const section of document.sections) {
    if (section === null || typeof section !== "object" || Array.isArray(section)) {
      return { error: "Each custom section needs an id, label, type, and value." };
    }
    const sectionRecord = section as Record<string, unknown>;
    if (!hasOnlyKeys(sectionRecord, ["id", "label", "type", "value"])) {
      return { error: "Each custom section needs an id, label, type, and value." };
    }
    if (typeof sectionRecord.id !== "string" || !sectionRecord.id.trim() || sectionIds.has(sectionRecord.id)) {
      return { error: "Custom section IDs must be non-empty and unique." };
    }
    sectionIds.add(sectionRecord.id);
    if (typeof sectionRecord.label !== "string" || !sectionRecord.label.trim()) {
      return { error: "Custom section labels cannot be empty." };
    }
    if (sectionRecord.type === "text") {
      if (typeof sectionRecord.value !== "string") return { error: `Section “${sectionRecord.label}” needs a text value.` };
    } else if (sectionRecord.type === "list") {
      if (!Array.isArray(sectionRecord.value) || !sectionRecord.value.every((item) => typeof item === "string")) {
        return { error: `Section “${sectionRecord.label}” needs a list of text values.` };
      }
    } else {
      return { error: `Section “${sectionRecord.label}” type must be text or list.` };
    }
  }

  return { document: document as unknown as RelationshipDocument };
}

function parseDocumentJson(json: string) {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { error: "Enter valid JSON." };
  }
  return validateDocument(value);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function CurrentState({ document }: { document: RelationshipDocument }) {
  const hasContent = document.how_met.trim() || document.status.trim()
    || Object.keys(document.stats).length > 0 || document.known_facts.length > 0 || document.sections.length > 0;
  return (
    <section className="grid gap-2 rounded-xl border border-border bg-surface p-3" aria-label="Current state">
      <div>
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Current state</p>
        <p className="text-xs text-muted">Latest editable snapshot</p>
      </div>
      {!hasContent ? <p className="text-sm text-muted">No current details recorded.</p> : (
        <div className="grid gap-3 text-sm">
          {document.how_met.trim() && <div className="grid gap-1"><p className="text-xs font-medium text-muted">How they met</p><p className="whitespace-pre-wrap break-words">{document.how_met}</p></div>}
          {document.status.trim() && <div className="grid gap-1"><p className="text-xs font-medium text-muted">Status</p><p className="whitespace-pre-wrap break-words">{document.status}</p></div>}
          {Object.keys(document.stats).length > 0 && (
            <div className="grid gap-1.5">
              <p className="text-xs font-medium text-muted">Stats</p>
              <StatBars stats={document.stats} />
            </div>
          )}
          {document.known_facts.length > 0 && (
            <div className="grid gap-1">
              <p className="text-xs font-medium text-muted">Known facts</p>
              <ul className="grid list-disc gap-1 ps-5">
                {document.known_facts.map((fact, index) => <li key={index} className="whitespace-pre-wrap break-words">{fact}</li>)}
              </ul>
            </div>
          )}
          {document.sections.map((section) => (
            <div key={section.id} className="grid gap-1">
              <p className="text-xs font-medium text-muted">{section.label}</p>
              {section.type === "text" ? (
                <p className="whitespace-pre-wrap break-words">{section.value as string}</p>
              ) : (
                <ul className="grid list-disc gap-1 ps-5">
                  {(section.value as string[]).map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RelationshipRow(props: {
  relationship: Relationship;
  sourceLabel: string;
  targetLabel: string;
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
  const document = props.relationship.document;
  const status = document.status.trim();
  const statEntries = Object.entries(document.stats);
  const statSummary = [
    ...statEntries.slice(0, 2).map(([name, stat]) => `${name} ${stat.value}/${stat.max}`),
    ...(statEntries.length > 2 ? [`+${statEntries.length - 2} more`] : []),
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
            {!props.editing && <CurrentState document={document} />}
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
  stats: { label: string; stats: RelationshipDocument["stats"] }[];
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
              <StatBars stats={group.stats} />
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
  const [draft, setDraft] = useState<RelationshipDocument>(emptyDocument);
  const [advanced, setAdvanced] = useState(false);
  const [rawJson, setRawJson] = useState("");
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

  // The write already succeeded; a failed refresh is recovered by the next focus/session load.
  const syncCampaign = useCallback(() => {
    void props.onSyncSession(props.sessionId).catch(() => {});
  }, [props.onSyncSession, props.sessionId]);

  const protagonistId = protagonistOf(props.campaign).id;
  const worldName = props.campaign.world_snapshot.name;
  const relationshipLabel = (id: string) => characterLabels.get(id) ?? `Unavailable reference (${id})`;
  const cardOwner = (relationship: Relationship) =>
    relationship.source_id === protagonistId ? relationship.target_id : relationship.source_id;
  const rawDocument = advanced ? parseDocumentJson(rawJson) : null;
  const rawValidationError = rawDocument?.error ?? "";
  const serializedDraftLength = advanced
    ? rawDocument?.document ? JSON.stringify(rawDocument.document).length : rawJson.length
    : JSON.stringify(draft).length;

  const resetEditor = useCallback(() => {
    setCreatingRelationship(false);
    setCreateCardId(null);
    setEditingId(null);
    setSourceId("");
    setTargetId("");
    setDraft(emptyDocument());
    setAdvanced(false);
    setRawJson("");
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
    const nextDocument = emptyDocument();
    setDraft(nextDocument);
    setAdvanced(false);
    setRawJson(JSON.stringify(nextDocument, null, 2));
    setEditorError("");
  };

  const openEdit = (relationship: Relationship) => {
    const nextDocument = copyDocument(relationship.document);
    setCreatingRelationship(false);
    setConfirmDeleteId(null);
    setEditingId(relationship.id);
    setSourceId(relationship.source_id);
    setTargetId(relationship.target_id);
    setDraft(nextDocument);
    setAdvanced(false);
    setRawJson(JSON.stringify(nextDocument, null, 2));
    setEditorError("");
  };

  const changeAdvancedMode = () => {
    setEditorError("");
    if (advanced) {
      const parsed = parseDocumentJson(rawJson);
      if (parsed.error || !parsed.document) {
        setEditorError(parsed.error ?? "The JSON document is invalid.");
        return;
      }
      setDraft(parsed.document);
      setRawJson(JSON.stringify(parsed.document, null, 2));
      setAdvanced(false);
    } else {
      setRawJson(JSON.stringify(draft, null, 2));
      setAdvanced(true);
    }
  };

  const saveRelationship = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let document = draft;
    if (advanced) {
      const parsed = parseDocumentJson(rawJson);
      if (parsed.error || !parsed.document) {
        setEditorError(parsed.error ?? "The JSON document is invalid.");
        return;
      }
      document = parsed.document;
    } else {
      const validation = validateDocument(draft);
      if (validation.error || !validation.document) {
        setEditorError(validation.error ?? "The relationship document is invalid.");
        return;
      }
      document = validation.document;
    }
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
    try {
      if (creatingRelationship) {
        const created = await createCampaignRelationship(props.campaign.id, {
          source_id: sourceId,
          target_id: targetId,
          document,
        });
        setRelationships((current) => [...current, created]);
        setPendingFocusId(created.id);
      } else if (editingId) {
        const updated = await updateCampaignRelationship(props.campaign.id, editingId, { document });
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

  const updateDraft = (update: (current: RelationshipDocument) => RelationshipDocument) => {
    setDraft(update);
    setEditorError("");
  };

  const updateStat = (index: number, name: string, stat: RelationshipStat) => {
    const entries = Object.entries(draft.stats);
    const currentName = entries[index]?.[0];
    if (name !== currentName && entries.some(([entryName], entryIndex) => entryIndex !== index && entryName === name)) {
      setEditorError("Stat names must be unique.");
      return;
    }
    updateDraft((current) => ({
      ...current,
      stats: Object.fromEntries(Object.entries(current.stats).map(([entryName, entry], entryIndex) => entryIndex === index ? [name, stat] : [entryName, entry])),
    }));
  };

  const updateSection = (index: number, update: (section: RelationshipSection) => RelationshipSection) => {
    updateDraft((current) => ({
      ...current,
      sections: current.sections.map((section, sectionIndex) => sectionIndex === index ? update(section) : section),
    }));
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

  const editorForm = (creatingRelationship || editingId) && (
    <form className="grid min-w-0 gap-3 rounded-2xl border border-border bg-surface p-3" onSubmit={(event) => { void saveRelationship(event); }}>
      <div>
        <h4 className="font-semibold">{creatingRelationship ? "Create directed relationship" : "Edit current relationship state"}</h4>
        <p className="text-xs text-muted">The direction is explicit; editing changes the current relationship document.</p>
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

      <div className="flex flex-wrap items-center justify-between gap-2 border-bs border-border pbs-3">
        <div>
          <p className="text-sm font-medium">Document editor</p>
          <p className="text-xs text-muted">Serialized document: {serializedDraftLength.toLocaleString()} characters. Relationships count toward the narration budget; drafts are never truncated.</p>
        </div>
        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={changeAdvancedMode}>
          {advanced ? "Use native editor" : "Advanced JSON"}
        </button>
      </div>

      {advanced ? (
        <label className="grid gap-1 text-sm">
          Relationship document JSON
          <textarea className="min-h-80 rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5" value={rawJson} onChange={(event) => { setRawJson(event.target.value); setEditorError(""); }} rows={18} spellCheck={false} aria-invalid={Boolean(rawValidationError || editorError)} />
          {rawValidationError && <span className="text-xs text-muted" role="alert">{rawValidationError}</span>}
        </label>
      ) : (
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            How they met
            <textarea className="min-h-20 rounded-lg border border-border bg-background p-3" rows={3} value={draft.how_met} onChange={(event) => updateDraft((current) => ({ ...current, how_met: event.target.value }))} />
          </label>
          <label className="grid gap-1 text-sm">
            Current status
            <textarea className="min-h-20 rounded-lg border border-border bg-background p-3" rows={3} value={draft.status} onChange={(event) => updateDraft((current) => ({ ...current, status: event.target.value }))} />
          </label>

          <fieldset className="grid gap-2 rounded-xl border border-border p-3">
            <legend className="px-1 text-sm font-medium">Numeric stats</legend>
            {Object.entries(draft.stats).length === 0 && <p className="text-xs text-muted">No numeric stats recorded.</p>}
            {Object.entries(draft.stats).map(([name, stat], index) => (
              <div key={index} className="grid gap-2 rounded-lg border border-border p-2">
                <label className="grid gap-1 text-sm">
                  Stat name
                  <input className="min-h-10 min-w-0 rounded-lg border border-border bg-background px-3" value={name} onChange={(event) => updateStat(index, event.target.value, stat)} required />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(["value", "min", "max"] as const).map((field) => (
                    <label key={field} className="grid min-w-0 gap-1 text-xs text-muted">
                      {field === "value" ? "Value" : field === "min" ? "Minimum" : field === "max" ? "Maximum" : ""}
                      <input className="min-h-10 min-w-0 rounded-lg border border-border bg-background px-2 text-sm text-foreground tabular-nums" type="number" step="any" value={Number.isNaN(stat[field]) ? "" : stat[field]} onChange={(event) => updateStat(index, name, { ...stat, [field]: event.currentTarget.valueAsNumber })} required />
                    </label>
                  ))}
                </div>
                <button type="button" className="pressable min-h-9 justify-self-start rounded-lg border border-border px-3 text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => updateDraft((current) => ({ ...current, stats: Object.fromEntries(Object.entries(current.stats).filter((_, entryIndex) => entryIndex !== index)) }))}>Remove stat</button>
              </div>
            ))}
            <button type="button" className="pressable min-h-10 justify-self-start rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => updateDraft((current) => ({ ...current, stats: { ...current.stats, "": { value: 0, min: 0, max: 0 } } }))} disabled={Object.keys(draft.stats).some((name) => !name.trim())}>Add stat</button>
          </fieldset>

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

          <fieldset className="grid gap-3 rounded-xl border border-border p-3">
            <legend className="px-1 text-sm font-medium">Custom sections</legend>
            {draft.sections.map((section, index) => (
              <div key={section.id} className="grid min-w-0 gap-2 rounded-lg border border-border p-3">
                <label className="grid gap-1 text-sm">
                  Section label
                  <input className="min-h-10 min-w-0 rounded-lg border border-border bg-background px-3" value={section.label} onChange={(event) => updateSection(index, (current) => ({ ...current, label: event.target.value }))} />
                </label>
                <label className="grid gap-1 text-sm">
                  Section type
                  <select className="min-h-10 rounded-lg border border-border bg-background px-3" value={section.type} onChange={(event) => {
                    const type = event.target.value as "text" | "list";
                    updateSection(index, (current) => ({ ...current, type, value: type === "text" ? (Array.isArray(current.value) ? current.value.join("\n") : current.value) : (Array.isArray(current.value) ? current.value : [current.value]) }));
                  }}>
                    <option value="text">Text</option>
                    <option value="list">List</option>
                  </select>
                </label>
                {section.type === "text" ? (
                  <label className="grid gap-1 text-sm">
                    Text value
                    <textarea className="min-h-20 rounded-lg border border-border bg-background p-3" rows={3} value={section.value as string} onChange={(event) => updateSection(index, (current) => ({ ...current, value: event.target.value }))} />
                  </label>
                ) : (
                  <div className="grid gap-2">
                    <span className="text-sm">List values</span>
                    {(section.value as string[]).map((item, itemIndex) => (
                      <div key={itemIndex} className="flex min-w-0 items-start gap-2">
                        <textarea className="min-h-14 min-w-0 flex-1 rounded-lg border border-border bg-background p-2 text-sm" rows={2} aria-label={`${section.label || "Custom section"} item ${itemIndex + 1}`} value={item} onChange={(event) => updateSection(index, (current) => ({ ...current, value: (current.value as string[]).map((value, valueIndex) => valueIndex === itemIndex ? event.target.value : value) }))} />
                        <button type="button" className="pressable min-h-10 shrink-0 rounded-lg border border-border px-2 text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => updateSection(index, (current) => ({ ...current, value: (current.value as string[]).filter((_, valueIndex) => valueIndex !== itemIndex) }))}>Remove</button>
                      </div>
                    ))}
                    <button type="button" className="pressable min-h-9 justify-self-start rounded-lg border border-border px-3 text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => updateSection(index, (current) => ({ ...current, value: [...current.value as string[], ""] }))}>Add list item</button>
                  </div>
                )}
                <button type="button" className="pressable min-h-9 justify-self-start rounded-lg border border-border px-3 text-xs text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => updateDraft((current) => ({ ...current, sections: current.sections.filter((_, sectionIndex) => sectionIndex !== index) }))}>Remove section</button>
              </div>
            ))}
            <button type="button" className="pressable min-h-10 justify-self-start rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => updateDraft((current) => ({ ...current, sections: [...current.sections, { id: crypto.randomUUID(), label: "", type: "text", value: "" }] }))}>Add custom section</button>
          </fieldset>
        </div>
      )}

      {editorError && <p className="rounded-lg border border-border p-3 text-sm text-muted" role="alert">{editorError}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving}>{saving ? "Saving…" : creatingRelationship ? "Create relationship" : "Save current state"}</button>
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

  useEffect(() => {
    if (props.openId) cardRefs.current.get(props.openId)?.scrollIntoView({ block: "nearest" });
  }, [props.openId]);

  const actionsDisabled = saving || deleteBusyId !== null;
  const relationshipRow = (relationship: Relationship) => (
    <RelationshipRow
      key={relationship.id}
      relationship={relationship}
      sourceLabel={relationshipLabel(relationship.source_id)}
      targetLabel={relationshipLabel(relationship.target_id)}
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
          ...(towardYou && Object.keys(towardYou.document.stats).length > 0 ? [{ label: "How they see you", stats: towardYou.document.stats }] : []),
          ...(fromYou && Object.keys(fromYou.document.stats).length > 0 ? [{ label: "How you see them", stats: fromYou.document.stats }] : []),
        ];
        const open = props.openId === character.id;
        return (
          <CharacterCard
            key={character.id}
            character={character}
            you={you}
            open={open}
            onToggle={() => props.onOpenChange(open ? null : character.id)}
            status={towardYou?.document.status.trim() || fromYou?.document.status.trim() || ""}
            stats={stats}
            toggleRef={(element) => { if (element) cardRefs.current.set(character.id, element); else cardRefs.current.delete(character.id); }}
          >
            <>
              <Profile character={character} />
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
              {characterAction?.id === character.id && <p className="text-sm text-muted" role="alert">{characterAction.message}</p>}
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
