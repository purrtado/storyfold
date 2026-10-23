import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { CAMPAIGN_STATE_CATEGORIES, type Campaign, type CampaignStateCategory, type CampaignStateItem, type Session } from "../../shared/domain";
import {
  createCampaignSession,
  createCampaignStateItem,
  deleteCampaignStateItem,
  fetchCampaignSessions,
  fetchCampaignState,
  updateCampaignStateItem,
  type CampaignStateInput,
} from "../lib/storyApi";
import { sortCampaignStateItems } from "../lib/campaignLifecycle";
import { createRequestEpoch } from "../lib/requestEpoch";

const categoryLabels: Record<CampaignStateCategory, string> = {
  goal: "Goal",
  knowledge: "Knowledge",
  internal: "Internal",
  journal: "Journal",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useCampaignSessions(campaignId: string, sessionId: string) {
  const [requestEpoch] = useState(createRequestEpoch);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const requestId = requestEpoch.next();
    setLoading(true);
    setError("");
    try {
      const loaded = await fetchCampaignSessions(campaignId);
      if (requestEpoch.isCurrent(requestId)) setSessions(loaded);
    } catch (cause) {
      if (requestEpoch.isCurrent(requestId)) setError(errorMessage(cause, "Could not load campaign sessions."));
    } finally {
      if (requestEpoch.isCurrent(requestId)) setLoading(false);
    }
  }, [campaignId, requestEpoch]);

  useEffect(() => {
    setSessions([]);
    void load();
    return () => requestEpoch.invalidate();
  }, [load, requestEpoch, sessionId]);

  return { sessions, loading, error, reload: load };
}

export function CampaignStateSection(props: {
  campaign: Campaign;
  active: boolean;
}) {
  const [stateRequestEpoch] = useState(createRequestEpoch);
  const [items, setItems] = useState<CampaignStateItem[] | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState("");
  const [stateBusy, setStateBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creatingItem, setCreatingItem] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formCategory, setFormCategory] = useState<CampaignStateCategory>("goal");
  const [formSubject, setFormSubject] = useState("");
  const [formContent, setFormContent] = useState("");

  const loadState = useCallback(async () => {
    const requestId = stateRequestEpoch.next();
    setStateLoading(true);
    setStateError("");
    try {
      const loaded = await fetchCampaignState(props.campaign.id);
      if (stateRequestEpoch.isCurrent(requestId)) setItems(loaded);
    } catch (error) {
      if (stateRequestEpoch.isCurrent(requestId)) {
        setStateError(errorMessage(error, "Could not load campaign state."));
      }
    } finally {
      if (stateRequestEpoch.isCurrent(requestId)) setStateLoading(false);
    }
  }, [props.campaign.id, stateRequestEpoch]);

  useEffect(() => {
    setItems(null);
    void loadState();
    return () => stateRequestEpoch.invalidate();
  }, [loadState, stateRequestEpoch]);

  const clearItemForm = () => {
    setCreatingItem(false);
    setEditingId(null);
    setFormCategory("goal");
    setFormSubject("");
    setFormContent("");
  };

  const openNewItem = () => {
    setStateError("");
    setEditingId(null);
    setFormCategory("goal");
    setFormSubject("");
    setFormContent("");
    setCreatingItem(true);
  };

  const openEditItem = (item: CampaignStateItem) => {
    setStateError("");
    setCreatingItem(false);
    setEditingId(item.id);
    setFormCategory(item.category);
    setFormSubject(item.subject);
    setFormContent(item.content);
  };

  const saveItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: CampaignStateInput = {
      category: formCategory,
      subject: formSubject.trim(),
      content: formContent.trim(),
    };
    if (!input.subject || !input.content) {
      setStateError("Subject and content are required.");
      return;
    }
    setStateBusy(true);
    setStateError("");
    try {
      const saved = editingId
        ? await updateCampaignStateItem(props.campaign.id, editingId, input)
        : await createCampaignStateItem(props.campaign.id, input);
      setItems((current) => {
        if (!current) return [saved];
        return editingId
          ? current.map((item) => item.id === saved.id ? saved : item)
          : [...current, saved];
      });
      clearItemForm();
    } catch (error) {
      setStateError(errorMessage(error, "Could not save campaign state."));
    } finally {
      setStateBusy(false);
    }
  };

  const removeItem = async (itemId: string) => {
    setStateBusy(true);
    setStateError("");
    try {
      await deleteCampaignStateItem(props.campaign.id, itemId);
      setItems((current) => current?.filter((item) => item.id !== itemId) ?? []);
      setConfirmDeleteId(null);
    } catch (error) {
      setStateError(errorMessage(error, "Could not delete campaign state."));
    } finally {
      setStateBusy(false);
    }
  };

  return (
    <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-label="Campaign notes">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">Goals, knowledge, and journal the narrator keeps in mind.</p>
        <button
          type="button"
          className="pressable inline-flex min-h-10 flex-none items-center gap-1.5 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
          onClick={openNewItem}
          disabled={stateBusy}
        >
          <Plus className="size-4" aria-hidden="true" />Add note
        </button>
      </div>
      {!props.active && (
        <>
          <p className="text-sm text-muted">Current campaign state; not the state at this session&apos;s end.</p>
          <Link
            to={`/sessions/${encodeURIComponent(props.campaign.active_session_id)}`}
            className="pressable inline-flex min-h-11 w-fit items-center rounded-lg border border-border px-3 text-sm text-foreground no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
          >
            Open active session
          </Link>
        </>
      )}

      {stateError && (
        <div className="grid gap-2 rounded-lg border border-border p-3 text-sm" role="alert">
          <p className="text-muted">{stateError}</p>
          {items === null && <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void loadState(); }}>Retry state load</button>}
        </div>
      )}
      {stateLoading && items === null ? (
        <p className="text-sm text-muted" role="status">Loading campaign state…</p>
      ) : null}

      {(creatingItem || editingId) && (
        <form className="grid gap-3 rounded-xl border border-border bg-surface p-3" onSubmit={(event) => { void saveItem(event); }}>
          <h4 className="font-medium">{editingId ? "Edit note" : "Add note"}</h4>
          <label className="grid gap-1 text-sm">
            Category
            <select className="min-h-11 rounded-lg border border-border bg-background px-3" value={formCategory} onChange={(event) => setFormCategory(event.target.value as CampaignStateCategory)}>
              {CAMPAIGN_STATE_CATEGORIES.map((category) => <option key={category} value={category}>{categoryLabels[category]}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Subject
            <input className="min-h-11 rounded-lg border border-border bg-background px-3" value={formSubject} onChange={(event) => setFormSubject(event.target.value)} required />
          </label>
          <label className="grid gap-1 text-sm">
            Content
            <textarea className="min-h-24 rounded-lg border border-border bg-background p-3" value={formContent} onChange={(event) => setFormContent(event.target.value)} required rows={4} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={stateBusy}>
              {stateBusy ? "Saving…" : "Save note"}
            </button>
            <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={clearItemForm} disabled={stateBusy}>Cancel</button>
          </div>
        </form>
      )}

      {items?.length === 0 && !stateLoading ? <p className="text-sm text-muted">No notes yet. Add a goal, knowledge note, or journal entry.</p> : null}
      {items && CAMPAIGN_STATE_CATEGORIES.map((category) => {
        const categoryItems = sortCampaignStateItems(items, category);
        if (categoryItems.length === 0) return null;
        return (
          <section key={category} className="grid gap-2" aria-label={`${categoryLabels[category]} state`}>
            <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">{categoryLabels[category]}</h4>
            <ul className="grid list-none divide-y divide-border rounded-xl border border-border bg-background p-0">
              {categoryItems.map((item) => (
                <li key={item.id} className="grid gap-2 p-3">
                  <div className="flex items-start gap-2">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <h5 className="text-sm font-medium">{item.subject}</h5>
                      <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{item.content}</p>
                      {category === "journal" && <p className="text-xs text-muted">{formatDate(item.created_at)}</p>}
                    </div>
                    <button type="button" className="pressable inline-flex size-9 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground" onClick={() => openEditItem(item)} disabled={stateBusy} aria-label={`Edit note about ${item.subject}`}><Pencil className="size-4" aria-hidden="true" /></button>
                    <button type="button" className="pressable inline-flex size-9 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground" onClick={() => setConfirmDeleteId(item.id)} disabled={stateBusy} aria-label={`Delete note about ${item.subject}`}><Trash2 className="size-4" aria-hidden="true" /></button>
                  </div>
                  {confirmDeleteId === item.id && (
                    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm deleting ${item.subject}`}>
                      <span className="text-sm text-muted">Delete this note?</span>
                      <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm text-muted" onClick={() => { void removeItem(item.id); }} disabled={stateBusy}>{stateBusy ? "Deleting…" : "Delete"}</button>
                      <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setConfirmDeleteId(null)} disabled={stateBusy}>Cancel</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}

export function CampaignTimelineSection(props: {
  campaign: Campaign;
  session: Session;
  active: boolean;
  canEndSession: boolean;
  sessions: Session[];
  sessionsLoading: boolean;
  sessionsError: string;
  onReloadSessions: () => Promise<void>;
  onSyncSession: (sessionId: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [nextTitle, setNextTitle] = useState("");
  const [handoff, setHandoff] = useState("");
  const [reviewHandoff, setReviewHandoff] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const nextFailed = Boolean(sessionError || pendingSessionId);

  const syncAndNavigate = async (sessionId: string) => {
    setPendingSessionId(sessionId);
    setSessionBusy(true);
    setSessionError("");
    try {
      await props.onSyncSession(sessionId);
      setPendingSessionId(null);
      navigate(`/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      setSessionError(`The session was created, but the campaign could not be refreshed. ${errorMessage(error, "Try again.")}`);
    } finally {
      setSessionBusy(false);
    }
  };

  const createNextSession = async () => {
    setPendingSessionId(null);
    setSessionBusy(true);
    setSessionError("");
    try {
      const created = await createCampaignSession(props.campaign.id, {
        title: nextTitle.trim(),
        handoff: handoff.trim(),
      });
      setReviewHandoff(false);
      setHandoff("");
      setNextTitle("");
      await props.onReloadSessions();
      await syncAndNavigate(created.id);
    } catch (error) {
      setSessionError(errorMessage(error, "Could not start the next session."));
      setSessionBusy(false);
    }
  };

  const orderedSessions = [...props.sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <>
      {props.active && (
        <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-labelledby="next-session-title">
          {!ending && !nextFailed ? (
            <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 text-sm font-medium [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setEnding(true)} disabled={!props.canEndSession}>
              <span id="next-session-title">End session and start the next</span>
            </button>
          ) : (
            <>
              <div>
                <h3 id="next-session-title" className="font-semibold">Start the next session</h3>
                <p className="mbs-1 text-sm leading-6 text-muted">Write a handoff, review it, then create the next session. The current session closes when you confirm.</p>
              </div>

              {nextFailed && sessionError && (
                <div className="grid gap-2 rounded-lg border border-border p-3 text-sm" role="alert">
                  <p className="text-muted">{sessionError}</p>
                  {pendingSessionId && <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void syncAndNavigate(pendingSessionId); }} disabled={sessionBusy}>Retry opening new session</button>}
                </div>
              )}
              {nextFailed && pendingSessionId && sessionBusy && <p className="text-sm text-muted" role="status">Refreshing campaign and opening the new session…</p>}

              {reviewHandoff ? (
                <div className="grid gap-3 rounded-xl border border-border bg-surface p-3">
                  <h4 className="font-medium">Review next session</h4>
                  <p className="text-sm font-medium">{nextTitle.trim()}</p>
                  <blockquote className="whitespace-pre-wrap border-is-2 border-border pis-3 text-sm leading-6 text-muted">{handoff.trim()}</blockquote>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="pressable min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" onClick={() => { void createNextSession(); }} disabled={!props.canEndSession || sessionBusy}>
                      {sessionBusy ? "Starting…" : "Confirm and start next session"}
                    </button>
                    <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 text-sm" onClick={() => { setReviewHandoff(false); setSessionError(""); }} disabled={sessionBusy}>Edit handoff</button>
                  </div>
                </div>
              ) : (
                <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); if (!nextTitle.trim() || !handoff.trim()) { setSessionError("A title and handoff are required."); return; } setSessionError(""); setReviewHandoff(true); }}>
                  <label className="grid gap-1 text-sm">
                    Next session title
                    <input className="min-h-11 rounded-lg border border-border bg-background px-3" value={nextTitle} onChange={(event) => setNextTitle(event.target.value)} required />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Handoff to carry forward
                    <textarea className="min-h-28 rounded-lg border border-border bg-background p-3" value={handoff} onChange={(event) => setHandoff(event.target.value)} required rows={5} />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" className="pressable min-h-11 rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={!props.canEndSession || sessionBusy}>
                      Review handoff
                    </button>
                    <button type="button" className="pressable min-h-11 rounded-lg px-4 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { setEnding(false); setSessionError(""); }} disabled={sessionBusy}>Cancel</button>
                  </div>
                </form>
              )}
            </>
          )}
          {!props.canEndSession && <p className="text-xs text-muted">Wait for narration and transcript loading to finish before ending the session.</p>}
        </section>
      )}

      {props.campaign.forked_from_session_id && (
        <section className="mbs-5 grid gap-2 border-bs border-border pbs-4" aria-labelledby="campaign-origin-title">
          <p className="text-xs font-medium text-muted">Campaign provenance</p>
          <h3 id="campaign-origin-title" className="font-semibold">Forked campaign</h3>
          <p className="text-sm text-muted">Forked from campaign {props.campaign.forked_from_campaign_id || "(unknown)"}.</p>
          <Link
            to={`/sessions/${encodeURIComponent(props.campaign.forked_from_session_id)}`}
            className="pressable inline-flex min-h-10 w-fit items-center rounded-lg border border-border px-3 text-sm text-foreground no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
          >
            View source session
          </Link>
        </section>
      )}

      <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-labelledby="campaign-sessions-title">
        <h3 id="campaign-sessions-title" className="text-xs font-semibold tracking-wide text-muted uppercase">Sessions</h3>

        {props.sessionsError && (
          <div className="grid gap-2 rounded-lg border border-border p-3 text-sm" role="alert">
            <p className="text-muted">{props.sessionsError}</p>
            <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void props.onReloadSessions(); }}>Retry sessions</button>
          </div>
        )}
        {props.sessionsLoading ? <p className="text-sm text-muted" role="status">Loading sessions…</p> : null}
        {orderedSessions.length > 0 && (
          <ol className="grid list-none gap-2 p-0">
            {orderedSessions.map((entry) => {
              const isActive = entry.id === props.campaign.active_session_id && !entry.closed_at;
              const isClosed = Boolean(entry.closed_at);
              return (
                <li key={entry.id} className="grid gap-2 rounded-xl border border-border p-3">
                  <div className="flex items-start gap-3">
                    <Link
                      to={`/sessions/${encodeURIComponent(entry.id)}`}
                      aria-current={entry.id === props.session.id ? "page" : undefined}
                      className="min-w-0 flex-1 font-medium text-foreground underline decoration-border underline-offset-2"
                    >
                      <span className="block break-words">{entry.title}</span>
                      <span className="mbs-1 block text-xs font-normal text-muted">{isActive ? "Active" : isClosed ? `Ended ${formatDate(entry.closed_at!)}` : `Started ${formatDate(entry.created_at)}`}</span>
                    </Link>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {!props.sessionsLoading && props.sessions.length === 0 && !props.sessionsError && <p className="text-sm text-muted">No sessions found for this campaign.</p>}
      </section>
    </>
  );
}
