import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { Campaign, Relationship, RelationshipDocument, RelationshipEvent, RelationshipSubject, Session } from "../../shared/domain";
import { createRequestEpoch } from "../lib/requestEpoch";
import {
  ApiError,
  createCampaignRelationship,
  createCampaignRelationshipEvent,
  createCampaignRelationshipSubject,
  deleteCampaignRelationship,
  fetchCampaignRelationshipEvents,
  fetchCampaignRelationships,
  updateCampaignRelationship,
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

function subjectKindLabel(kind: RelationshipSubject["kind"]) {
  if (kind === "character") return "Captured character";
  if (kind === "local_character") return "Local NPC";
  return "Captured world entry";
}

function subjectLabel(subject: RelationshipSubject | undefined, id: string) {
  return subject ? `${subjectKindLabel(subject.kind)}: ${subject.name}` : `Unavailable reference (${id})`;
}

function sortEvents(events: RelationshipEvent[]) {
  return [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function CurrentState({ document }: { document: RelationshipDocument }) {
  const hasContent = document.how_met.trim() || document.status.trim()
    || Object.keys(document.stats).length > 0 || document.known_facts.length > 0 || document.sections.length > 0;
  return (
    <section className="grid gap-2 rounded-xl border border-border bg-surface p-3" aria-label="Current relationship state">
      <div>
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Current state</p>
        <p className="text-xs text-muted">Latest editable snapshot</p>
      </div>
      {!hasContent ? <p className="text-sm text-muted">No current details recorded.</p> : (
        <div className="grid gap-3 text-sm">
          {document.how_met.trim() && <div className="grid gap-1"><h5 className="text-xs font-medium text-muted">How they met</h5><p className="whitespace-pre-wrap break-words">{document.how_met}</p></div>}
          {document.status.trim() && <div className="grid gap-1"><h5 className="text-xs font-medium text-muted">Status</h5><p className="whitespace-pre-wrap break-words">{document.status}</p></div>}
          {Object.keys(document.stats).length > 0 && (
            <div className="grid gap-1">
              <h5 className="text-xs font-medium text-muted">Stats</h5>
              <dl className="grid gap-1">
                {Object.entries(document.stats).map(([name, stat]) => (
                  <div key={name} className="flex flex-wrap justify-between gap-x-3">
                    <dt className="break-words text-muted">{name}</dt>
                    <dd className="tabular-nums">{stat.value} <span className="text-muted">({stat.min}–{stat.max})</span></dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {document.known_facts.length > 0 && (
            <div className="grid gap-1">
              <h5 className="text-xs font-medium text-muted">Known facts</h5>
              <ul className="grid list-disc gap-1 ps-5">
                {document.known_facts.map((fact, index) => <li key={index} className="whitespace-pre-wrap break-words">{fact}</li>)}
              </ul>
            </div>
          )}
          {document.sections.map((section) => (
            <div key={section.id} className="grid gap-1">
              <h5 className="text-xs font-medium text-muted">{section.label}</h5>
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

function RelationshipCard(props: {
  campaignId: string;
  relationship: Relationship;
  sourceLabel: string;
  targetLabel: string;
  sessions: Session[];
  activeSessionTitle?: string;
  onEdit: () => void;
  onDelete: () => void;
  deleteBusy: boolean;
  actionsDisabled: boolean;
  confirmDelete: boolean;
  deleteError: string;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const [events, setEvents] = useState<RelationshipEvent[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState("");
  const [eventDescription, setEventDescription] = useState("");
  const [eventBusy, setEventBusy] = useState(false);
  const [eventError, setEventError] = useState("");

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError("");
    try {
      const loaded = await fetchCampaignRelationshipEvents(props.campaignId, props.relationship.id);
      setEvents(sortEvents(loaded));
    } catch (error) {
      setEventsError(errorMessage(error, "Could not load relationship history."));
    } finally {
      setEventsLoading(false);
    }
  }, [props.campaignId, props.relationship.id]);

  useEffect(() => {
    let current = true;
    setEvents(null);
    setEventsLoading(true);
    setEventsError("");
    void fetchCampaignRelationshipEvents(props.campaignId, props.relationship.id).then((loaded) => {
      if (current) setEvents(sortEvents(loaded));
    }).catch((error: unknown) => {
      if (current) setEventsError(errorMessage(error, "Could not load relationship history."));
    }).finally(() => {
      if (current) setEventsLoading(false);
    });
    return () => { current = false; };
  }, [props.campaignId, props.relationship.id]);

  const appendEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const description = eventDescription.trim();
    if (!description) {
      setEventError("Describe the event before adding it.");
      return;
    }
    setEventBusy(true);
    setEventError("");
    try {
      const created = await createCampaignRelationshipEvent(props.campaignId, props.relationship.id, description);
      setEvents((current) => sortEvents([...(current ?? []), created]));
      setEventDescription("");
    } catch (error) {
      setEventError(errorMessage(error, "Could not add relationship event."));
    } finally {
      setEventBusy(false);
    }
  };

  const sessionById = new Map(props.sessions.map((session) => [session.id, session]));
  const relationshipTitle = `${props.sourceLabel} → ${props.targetLabel}`;
  return (
    <article className="grid min-w-0 gap-3 rounded-2xl border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 flex-1 break-words font-semibold" aria-label={relationshipTitle}>
          <span>{props.sourceLabel}</span> <span aria-hidden="true" className="text-muted">→</span> <span>{props.targetLabel}</span>
        </h4>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={props.onEdit} disabled={props.actionsDisabled}>Edit</button>
          <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={props.onDelete} disabled={props.deleteBusy || props.actionsDisabled}>Delete</button>
        </div>
      </div>
      <p className="text-xs text-muted">Updated {formatDate(props.relationship.updated_at)} · Revision {props.relationship.revision}</p>
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

      <CurrentState document={props.relationship.document} />

      <section className="grid gap-3 rounded-xl border border-border p-3" aria-label="Historical relationship events">
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">History</p>
          <h5 className="font-medium">Historical events</h5>
          <p className="text-xs text-muted">Events are dated and tied to the session where they were recorded; they do not replace current state.</p>
        </div>
        {eventsError && (
          <div className="grid gap-2" role="alert">
            <p className="text-sm text-muted">{eventsError}</p>
            <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void loadEvents(); }} disabled={eventsLoading}>Retry history</button>
          </div>
        )}
        {eventsLoading && events === null ? <p className="text-sm text-muted" role="status">Loading history…</p> : null}
        {events && events.length === 0 && !eventsLoading && <p className="text-sm text-muted">No historical events recorded.</p>}
        {events && events.length > 0 && (
          <ol className="grid list-none gap-2 p-0">
            {events.map((entry) => {
              const session = sessionById.get(entry.session_id);
              const sessionLabel = session?.title ?? `Session ${entry.session_id.slice(0, 8)}`;
              return (
                <li key={entry.id} className="grid gap-1 border-is-2 border-border pis-3">
                  <p className="whitespace-pre-wrap break-words text-sm">{entry.description}</p>
                  <p className="text-xs text-muted">
                    <time dateTime={entry.created_at}>{formatDate(entry.created_at)}</time>
                    {" · "}
                    <Link className="text-accent underline underline-offset-2" to={`/sessions/${encodeURIComponent(entry.session_id)}`}>{sessionLabel}</Link>
                  </p>
                </li>
              );
            })}
          </ol>
        )}
        <form className="grid gap-2 border-bs border-border pbs-3" onSubmit={(event) => { void appendEvent(event); }}>
          <label className="grid gap-1 text-sm">
            Append historical event
            <textarea className="min-h-20 rounded-lg border border-border bg-background p-3" rows={3} value={eventDescription} onChange={(event) => setEventDescription(event.target.value)} required />
          </label>
          <p className="text-xs text-muted">New events attach to the campaign&apos;s active session{props.activeSessionTitle ? ` (“${props.activeSessionTitle}”)` : ""}, even when viewing an archived session.</p>
          {eventError && <p className="text-sm text-muted" role="alert">{eventError}</p>}
          <button type="submit" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={eventBusy || props.actionsDisabled || (eventsLoading && events === null)}>{eventBusy ? "Adding…" : "Add dated event"}</button>
        </form>
      </section>
    </article>
  );
}

export function RelationshipManagement(props: { campaign: Campaign; sessions: Session[] }) {
  const [requestEpoch] = useState(createRequestEpoch);
  const [subjects, setSubjects] = useState<RelationshipSubject[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [npcName, setNpcName] = useState("");
  const [npcError, setNpcError] = useState("");
  const [creatingRelationship, setCreatingRelationship] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [draft, setDraft] = useState<RelationshipDocument>(emptyDocument);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [rawJson, setRawJson] = useState("");
  const [editorError, setEditorError] = useState("");
  const [editorNotice, setEditorNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingLatest, setRefreshingLatest] = useState(false);
  const [subjectBusy, setSubjectBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  const loadRelationships = useCallback(async () => {
    const requestId = requestEpoch.next();
    setLoading(true);
    setLoadError("");
    try {
      const loaded = await fetchCampaignRelationships(props.campaign.id);
      if (requestEpoch.isCurrent(requestId)) {
        setSubjects(loaded.subjects);
        setRelationships(loaded.relationships);
      }
    } catch (error) {
      if (requestEpoch.isCurrent(requestId)) setLoadError(errorMessage(error, "Could not load campaign relationships."));
    } finally {
      if (requestEpoch.isCurrent(requestId)) setLoading(false);
    }
  }, [props.campaign.id, requestEpoch]);
  const subjectLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const subject of subjects) {
      const key = `${subject.kind}\u0000${subject.name}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Map<string, string>(subjects.map((subject): [string, string] => {
      const key = `${subject.kind}\u0000${subject.name}`;
      const duplicate = (counts.get(key) ?? 0) > 1;
      const role = subject.kind === "character" && !duplicate
        ? subject.name === props.campaign.protagonist_snapshot.name
          ? "Protagonist"
          : props.campaign.cast.some((character) => character.name === subject.name)
            ? "Cast"
            : subjectKindLabel(subject.kind)
        : subjectKindLabel(subject.kind);
      return [subject.id, `${role}: ${subject.name}${duplicate ? ` · ${subject.id.slice(0, 8)}` : ""}`];
    }));
  }, [props.campaign.cast, props.campaign.protagonist_snapshot.name, subjects]);
  const subjectMap = useMemo(
    () => new Map<string, RelationshipSubject>(subjects.map((subject): [string, RelationshipSubject] => [subject.id, subject])),
    [subjects],
  );
  const protagonistSourceId = useMemo(() => {
    const matches = subjects.filter((subject) => subject.kind === "character" && subject.name === props.campaign.protagonist_snapshot.name);
    return matches.length === 1 ? matches[0].id : "";
  }, [props.campaign.protagonist_snapshot.name, subjects]);
  const activeSessionTitle = props.sessions.find((session) => session.id === props.campaign.active_session_id)?.title;
  const rawDocument = advanced ? parseDocumentJson(rawJson) : null;
  const rawValidationError = rawDocument?.error ?? "";
  const serializedDraftLength = advanced
    ? rawDocument?.document ? JSON.stringify(rawDocument.document).length : rawJson.length
    : JSON.stringify(draft).length;

  const resetEditor = () => {
    setCreatingRelationship(false);
    setEditingId(null);
    setSourceId("");
    setTargetId("");
    setDraft(emptyDocument());
    setDraftRevision(null);
    setAdvanced(false);
    setRawJson("");
    setEditorError("");
    setEditorNotice("");
    setConflict(false);
  };

  const openCreate = () => {
    setCreatingRelationship(true);
    setEditingId(null);
    setSourceId(protagonistSourceId);
    setTargetId("");
    const nextDocument = emptyDocument();
    setDraft(nextDocument);
    setDraftRevision(null);
    setAdvanced(false);
    setRawJson(JSON.stringify(nextDocument, null, 2));
    setEditorError("");
    setEditorNotice("");
    setConflict(false);
  };

  const openEdit = (relationship: Relationship) => {
    const nextDocument = copyDocument(relationship.document);
    setCreatingRelationship(false);
    setEditingId(relationship.id);
    setSourceId(relationship.source_id);
    setTargetId(relationship.target_id);
    setDraft(nextDocument);
    setDraftRevision(relationship.revision);
    setAdvanced(false);
    setRawJson(JSON.stringify(nextDocument, null, 2));
    setEditorError("");
    setEditorNotice("");
    setConflict(false);
  };

  const changeAdvancedMode = () => {
    setEditorError("");
    setEditorNotice("");
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
      setEditorError("Choose both a source and a target reference.");
      return;
    }
    if (creatingRelationship && sourceId === targetId) {
      setEditorError("A relationship source and target must be different references.");
      return;
    }
    setSaving(true);
    setEditorError("");
    setEditorNotice("");
    setConflict(false);
    try {
      if (creatingRelationship) {
        const created = await createCampaignRelationship(props.campaign.id, {
          source_id: sourceId,
          target_id: targetId,
          document,
        });
        setRelationships((current) => [...current, created]);
      } else if (editingId && draftRevision !== null) {
        const updated = await updateCampaignRelationship(props.campaign.id, editingId, {
          document,
          revision: draftRevision,
        });
        setRelationships((current) => current.map((relationship) => relationship.id === updated.id ? updated : relationship));
      }
      resetEditor();
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict") {
        setConflict(true);
        setEditorError("This relationship changed on the server. Your draft is still here; check the latest version before saving again.");
      } else {
        setEditorError(errorMessage(error, "Could not save relationship."));
      }
    } finally {
      setSaving(false);
    }
  };

  const refreshLatestKeepingDraft = async () => {
    if (!editingId) return;
    setRefreshingLatest(true);
    setEditorError("");
    setEditorNotice("");
    try {
      const loaded = await fetchCampaignRelationships(props.campaign.id);
      setSubjects(loaded.subjects);
      setRelationships(loaded.relationships);
      const latest = loaded.relationships.find((relationship) => relationship.id === editingId);
      if (latest) {
        setDraftRevision(latest.revision);
        setConflict(false);
        setEditorNotice("Latest server state is shown below; your draft was preserved. Review both before saving again.");
      } else {
        setConflict(false);
        setEditorError("This relationship was deleted on the server. Your draft is preserved, but it can no longer update that record.");
      }
    } catch (error) {
      setEditorError(errorMessage(error, "Could not load the latest relationship."));
    } finally {
      setRefreshingLatest(false);
    }
  };

  const createNpc = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = npcName.trim();
    if (!name) {
      setNpcError("Enter a name for the local NPC.");
      return;
    }
    setSubjectBusy(true);
    setNpcError("");
    try {
      const created = await createCampaignRelationshipSubject(props.campaign.id, name);
      setSubjects((current) => [...current, created]);
      setNpcName("");
    } catch (error) {
      setNpcError(errorMessage(error, "Could not create campaign-local NPC."));
    } finally {
      setSubjectBusy(false);
    }
  };

  const removeRelationship = async (relationshipId: string) => {
    setDeleteBusyId(relationshipId);
    setDeleteErrors((current) => ({ ...current, [relationshipId]: "" }));
    try {
      await deleteCampaignRelationship(props.campaign.id, relationshipId);
      setRelationships((current) => current.filter((relationship) => relationship.id !== relationshipId));
      setConfirmDeleteId(null);
      if (editingId === relationshipId) resetEditor();
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

  return (
    <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-labelledby="campaign-relationships-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-muted">Directed campaign relationships</p>
          <h3 id="campaign-relationships-title" className="mbs-1 font-semibold">Relationships</h3>
          <p className="mbs-1 text-sm leading-6 text-muted">Current relationship state is separate from dated historical events. Nothing is extracted automatically.</p>
        </div>
        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={openCreate} disabled={loading || !subjects.length || saving || refreshingLatest || deleteBusyId !== null}>Add relationship</button>
      </div>

      <form className="grid gap-2 rounded-xl border border-border bg-surface p-3" onSubmit={(event) => { void createNpc(event); }}>
        <div>
          <h4 className="font-medium">Campaign-local NPCs</h4>
          <p className="text-xs text-muted">Create a campaign-only reference to use as either end of a relationship.</p>
        </div>
        <label className="grid gap-1 text-sm">
          NPC name
          <input className="min-h-11 rounded-lg border border-border bg-background px-3" value={npcName} onChange={(event) => setNpcName(event.target.value)} required />
        </label>
        {npcError && <p className="text-sm text-muted" role="alert">{npcError}</p>}
        <button type="submit" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={subjectBusy || loading || refreshingLatest}>{subjectBusy ? "Creating…" : "Create local NPC"}</button>
      </form>

      {loadError && (
        <div className="grid gap-2 rounded-lg border border-border p-3 text-sm" role="alert">
          <p className="text-muted">{loadError}</p>
          <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void loadRelationships(); }} disabled={loading}>Retry relationships</button>
        </div>
      )}
      {loading && <p className="text-sm text-muted" role="status">Loading relationships…</p>}
      {!loading && !loadError && subjects.length === 0 && <p className="text-sm text-muted">No captured relationship references are available yet.</p>}

      {(creatingRelationship || editingId) && (
        <form className="grid min-w-0 gap-3 rounded-2xl border border-border bg-surface p-3" onSubmit={(event) => { void saveRelationship(event); }}>
          <div>
            <h4 className="font-semibold">{creatingRelationship ? "Create directed relationship" : "Edit current relationship state"}</h4>
            <p className="text-xs text-muted">The direction is explicit; editing changes the current document, not its historical events.</p>
          </div>
          {creatingRelationship ? (
            <div className="grid gap-3">
              <label className="grid min-w-0 gap-1 text-sm">
                Source
                <select className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-3" value={sourceId} onChange={(event) => { setSourceId(event.target.value); setEditorError(""); }} required>
                  <option value="">Choose source reference</option>
                  {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subjectLabels.get(subject.id) ?? subjectLabel(subject, subject.id)}</option>)}
                </select>
              </label>
              <p className="text-center text-sm font-medium text-muted" aria-label="points to">→</p>
              <label className="grid min-w-0 gap-1 text-sm">
                Target
                <select className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-3" value={targetId} onChange={(event) => { setTargetId(event.target.value); setEditorError(""); }} required>
                  <option value="">Choose target reference</option>
                  {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subjectLabels.get(subject.id) ?? subjectLabel(subject, subject.id)}</option>)}
                </select>
              </label>
            </div>
          ) : (
            <p className="break-words rounded-lg border border-border p-3 text-sm font-medium">{subjectLabel(subjectMap.get(sourceId), sourceId)} <span aria-hidden="true" className="text-muted">→</span> {subjectLabel(subjectMap.get(targetId), targetId)}</p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-bs border-border pbs-3">
            <div>
              <p className="text-sm font-medium">Document editor</p>
              <p className="text-xs text-muted">Serialized document: {serializedDraftLength.toLocaleString()} characters. The server enforces a 16,000-character campaign-wide limit; drafts are never truncated.</p>
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
                          {field === "value" ? "Value" : field === "min" ? "Minimum" : "Maximum"}
                          <input className="min-h-10 min-w-0 rounded-lg border border-border bg-background px-2 text-sm text-foreground tabular-nums" type="number" step="any" value={stat[field]} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) updateStat(index, name, { ...stat, [field]: value }); }} required />
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
          {editorNotice && <p className="rounded-lg border border-border p-3 text-sm text-muted" role="status">{editorNotice}</p>}
          {conflict && (
            <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void refreshLatestKeepingDraft(); }} disabled={refreshingLatest}>
              {refreshingLatest ? "Checking latest…" : "Load latest version, keep my draft"}
            </button>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={saving || refreshingLatest}>{saving ? "Saving…" : creatingRelationship ? "Create relationship" : "Save current state"}</button>
            <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={resetEditor} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      {!loading && !loadError && relationships.length === 0 && <p className="rounded-xl border border-border p-3 text-sm text-muted">No relationships yet. Add one using the captured references or a campaign-local NPC.</p>}
      <div className="grid min-w-0 gap-3">
        {relationships.map((relationship) => (
          <RelationshipCard
            key={relationship.id}
            campaignId={props.campaign.id}
            relationship={relationship}
            sourceLabel={subjectLabels.get(relationship.source_id) ?? subjectLabel(subjectMap.get(relationship.source_id), relationship.source_id)}
            targetLabel={subjectLabels.get(relationship.target_id) ?? subjectLabel(subjectMap.get(relationship.target_id), relationship.target_id)}
            sessions={props.sessions}
            activeSessionTitle={activeSessionTitle}
            onEdit={() => openEdit(relationship)}
            onDelete={() => { setConfirmDeleteId(relationship.id); setDeleteErrors((current) => ({ ...current, [relationship.id]: "" })); }}
            deleteBusy={deleteBusyId === relationship.id}
            actionsDisabled={saving || refreshingLatest || deleteBusyId !== null}
            confirmDelete={confirmDeleteId === relationship.id}
            deleteError={deleteErrors[relationship.id] ?? ""}
            onConfirmDelete={() => { void removeRelationship(relationship.id); }}
            onCancelDelete={() => setConfirmDeleteId(null)}
          />
        ))}
      </div>
    </section>
  );
}
