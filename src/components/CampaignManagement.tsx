import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CAMPAIGN_STATE_CATEGORIES, type Campaign, type CampaignStateCategory, type CampaignStateItem, type Session } from "../../shared/domain";
import {
  createCampaignSession,
  createCampaignStateItem,
  deleteCampaignStateItem,
  fetchCampaignSessions,
  fetchCampaignState,
  forkSession,
  updateCampaignStateItem,
  type CampaignStateInput,
} from "../lib/storyApi";
import { sortCampaignStateItems } from "../lib/campaignLifecycle";

const categoryLabels: Record<CampaignStateCategory, string> = {
  relationship: "Relationship",
  goal: "Goal",
  knowledge: "Knowledge",
  internal: "Internal",
  attribute: "Attribute",
  journal: "Journal",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}


export function CampaignManagement(props: {
  campaign: Campaign;
  session: Session;
  active: boolean;
  canEndSession: boolean;
  onSyncSession: (sessionId: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [items, setItems] = useState<CampaignStateItem[] | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState("");
  const [stateBusy, setStateBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creatingItem, setCreatingItem] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formCategory, setFormCategory] = useState<CampaignStateCategory>("relationship");
  const [formSubject, setFormSubject] = useState("");
  const [formContent, setFormContent] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [nextTitle, setNextTitle] = useState("");
  const [handoff, setHandoff] = useState("");
  const [reviewHandoff, setReviewHandoff] = useState(false);
  const [forkTarget, setForkTarget] = useState<string | null>(null);
  const [forkName, setForkName] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    setStateLoading(true);
    setStateError("");
    try {
      setItems(await fetchCampaignState(props.campaign.id));
    } catch (error) {
      setStateError(errorMessage(error, "Could not load campaign state."));
    } finally {
      setStateLoading(false);
    }
  }, [props.campaign.id]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      setSessions(await fetchCampaignSessions(props.campaign.id));
    } catch (error) {
      setSessionsError(errorMessage(error, "Could not load campaign sessions."));
    } finally {
      setSessionsLoading(false);
    }
  }, [props.campaign.id]);

  useEffect(() => {
    setItems(null);
    void loadState();
  }, [loadState]);

  useEffect(() => {
    setSessions([]);
    void loadSessions();
  }, [loadSessions, props.session.id]);

  const clearItemForm = () => {
    setCreatingItem(false);
    setEditingId(null);
    setFormCategory("relationship");
    setFormSubject("");
    setFormContent("");
  };

  const openNewItem = () => {
    setStateError("");
    setEditingId(null);
    setFormCategory("relationship");
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
      await loadSessions();
      await syncAndNavigate(created.id);
    } catch (error) {
      setSessionError(errorMessage(error, "Could not start the next session."));
      setSessionBusy(false);
    }
  };

  const forkFromSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!forkTarget) return;
    if (!forkName.trim()) {
      setSessionError("Enter a name for the forked campaign.");
      return;
    }
    setPendingSessionId(null);
    setSessionBusy(true);
    setSessionError("");
    try {
      const result = await forkSession(forkTarget, forkName.trim());
      setForkTarget(null);
      await syncAndNavigate(result.session.id);
    } catch (error) {
      setSessionError(errorMessage(error, "Could not fork this session."));
      setSessionBusy(false);
    }
  };

  const activeSession = sessions.find((entry) => entry.id === props.campaign.active_session_id);
  const orderedSessions = [...sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <>
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

      <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-labelledby="campaign-state-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium text-muted">Persistent campaign memory</p>
            <h3 id="campaign-state-title" className="mbs-1 font-semibold">Campaign state</h3>
          </div>
          <button
            type="button"
            className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised"
            onClick={openNewItem}
            disabled={stateBusy}
          >
            Add state
          </button>
        </div>

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
            <h4 className="font-medium">{editingId ? "Edit state" : "Add campaign state"}</h4>
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
                {stateBusy ? "Saving…" : "Save state"}
              </button>
              <button type="button" className="pressable min-h-11 rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={clearItemForm} disabled={stateBusy}>Cancel</button>
            </div>
          </form>
        )}

        {items?.length === 0 && !stateLoading ? <p className="text-sm text-muted">No campaign state yet. Add a relationship, goal, fact, or journal entry.</p> : null}
        {items && CAMPAIGN_STATE_CATEGORIES.map((category) => {
          const categoryItems = sortCampaignStateItems(items, category);
          if (categoryItems.length === 0) return null;
          return (
            <section key={category} className="grid gap-2" aria-label={`${categoryLabels[category]} state`}>
              <h4 className="text-sm font-medium">{categoryLabels[category]}</h4>
              <ul className="grid list-none gap-2 p-0">
                {categoryItems.map((item) => (
                  <li key={item.id} className="grid gap-2 rounded-xl border border-border p-3">
                    <div className="grid gap-1">
                      <h5 className="font-medium">{item.subject}</h5>
                      <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{item.content}</p>
                      <p className="text-xs text-muted">
                        {category === "journal" ? `Added ${formatDate(item.created_at)}` : `Updated ${formatDate(item.updated_at)}`}
                      </p>
                    </div>
                    {confirmDeleteId === item.id ? (
                      <div className="flex flex-wrap items-center gap-2" aria-label={`Confirm deleting ${item.subject}`}>
                        <span className="text-sm text-muted">Delete this state item?</span>
                        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm text-muted" onClick={() => { void removeItem(item.id); }} disabled={stateBusy}>{stateBusy ? "Deleting…" : "Delete"}</button>
                        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setConfirmDeleteId(null)} disabled={stateBusy}>Cancel</button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => openEditItem(item)} disabled={stateBusy}>Edit</button>
                        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => setConfirmDeleteId(item.id)} disabled={stateBusy}>Delete</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </section>

      <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-labelledby="campaign-sessions-title">
        <div>
          <p className="text-xs font-medium text-muted">Campaign timeline</p>
          <h3 id="campaign-sessions-title" className="mbs-1 font-semibold">Sessions</h3>
        </div>
        <div className="grid gap-1 rounded-xl border border-border p-3">
          <p className="text-xs font-medium text-muted">Active session</p>
          {activeSession ? (
            <Link to={`/sessions/${encodeURIComponent(activeSession.id)}`} className="font-medium text-accent underline underline-offset-2">{activeSession.title}</Link>
          ) : (
            <Link to={`/sessions/${encodeURIComponent(props.campaign.active_session_id)}`} className="font-medium text-accent underline underline-offset-2">Open active session</Link>
          )}
          {props.active && <p className="text-xs text-muted">You are viewing the active session.</p>}
        </div>

        {props.session.handoff && (
          <section className="grid gap-2 rounded-xl border border-border bg-surface p-3" aria-labelledby="session-handoff-title">
            <h4 id="session-handoff-title" className="text-sm font-semibold">Handoff for this session</h4>
            <p className="whitespace-pre-wrap text-sm leading-6 text-muted">{props.session.handoff}</p>
          </section>
        )}

        {sessionsError && (
          <div className="grid gap-2 rounded-lg border border-border p-3 text-sm" role="alert">
            <p className="text-muted">{sessionsError}</p>
            <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void loadSessions(); }}>Retry sessions</button>
          </div>
        )}
        {sessionsLoading ? <p className="text-sm text-muted" role="status">Loading sessions…</p> : null}
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
                    {isClosed && <button type="button" className="pressable min-h-10 shrink-0 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { setForkTarget(entry.id); setForkName(`${props.campaign.name} fork`); setSessionError(""); }}>Fork</button>}
                  </div>
                  {forkTarget === entry.id && (
                    <form className="grid gap-2 border-bs border-border pbs-3" onSubmit={(event) => { void forkFromSession(event); }}>
                      <label className="grid gap-1 text-sm">
                        New campaign name
                        <input className="min-h-11 rounded-lg border border-border bg-background px-3" value={forkName} onChange={(event) => setForkName(event.target.value)} required />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button type="submit" className="pressable min-h-10 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent/90" disabled={sessionBusy}>{sessionBusy ? "Forking…" : "Create fork"}</button>
                        <button type="button" className="pressable min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setForkTarget(null)} disabled={sessionBusy}>Cancel</button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {!sessionsLoading && sessions.length === 0 && !sessionsError && <p className="text-sm text-muted">No sessions found for this campaign.</p>}
      </section>

      {props.active && (
        <section className="mbs-5 grid gap-3 border-bs border-border pbs-4" aria-labelledby="next-session-title">
          <div>
            <p className="text-xs font-medium text-muted">Close this session with a checkpoint</p>
            <h3 id="next-session-title" className="mbs-1 font-semibold">Start the next session</h3>
            <p className="mbs-1 text-sm leading-6 text-muted">Write a handoff, review it, then create the next session. The current session closes when you confirm.</p>
          </div>

          {sessionError && (
            <div className="grid gap-2 rounded-lg border border-border p-3 text-sm" role="alert">
              <p className="text-muted">{sessionError}</p>
              {pendingSessionId && <button type="button" className="pressable min-h-10 w-fit rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => { void syncAndNavigate(pendingSessionId); }} disabled={sessionBusy}>Retry opening new session</button>}
            </div>
          )}
          {pendingSessionId && sessionBusy && <p className="text-sm text-muted" role="status">Refreshing campaign and opening the new session…</p>}

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
              <button type="submit" className="pressable min-h-11 w-fit rounded-lg border border-border px-4 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={!props.canEndSession || sessionBusy}>
                Review handoff
              </button>
              {!props.canEndSession && <p className="text-xs text-muted">Wait for narration and transcript loading to finish before ending the session.</p>}
            </form>
          )}
        </section>
      )}
    </>
  );
}
