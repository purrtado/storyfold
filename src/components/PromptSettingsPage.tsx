import { useEffect, useRef, useState, type Ref } from "react";
import { ChevronDown, ChevronRight, GripVertical, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import type { PromptCard } from "../../shared/domain";
import { PROMPT_PLACEHOLDERS } from "../../shared/narration";
import {
  createPromptCard,
  deletePromptCard,
  fetchPromptCards,
  orderPromptCards,
  resetPromptCards,
  updatePromptCard,
} from "../lib/storyApi";
import { AppHeader } from "./AppHeader";
import "./settings.css";

type PromptDraft = Pick<PromptCard, "title" | "body">;
const buttonClass = "pressable inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised";
const inputClass = "min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm";

function PromptCardRow(props: {
  card: PromptCard;
  draft: PromptDraft;
  expanded: boolean;
  busy: boolean;
  onExpand: () => void;
  onToggle: () => void;
  onDraft: (draft: PromptDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  titleInputRef: Ref<HTMLInputElement>;
  canMoveUp: boolean;
  canMoveDown: boolean;
  saveError?: string;
}) {
  const controls = useDragControls();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const changed = props.draft.title !== props.card.title || props.draft.body !== props.card.body;

  const insertPlaceholder = (name: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const value = `{{${name}}}`;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const body = `${props.draft.body.slice(0, start)}${value}${props.draft.body.slice(end)}`;
    props.onDraft({ ...props.draft, body });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + value.length, start + value.length);
    });
  };

  return (
    <Reorder.Item
      as="li"
      value={props.card}
      dragListener={false}
      dragControls={controls}
      className={`grid gap-3 rounded-xl border border-border p-3 ${props.card.enabled ? "bg-background" : "bg-raised text-muted"}`}
      onDragEnd={props.onDragEnd}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className="pressable hit-44 inline-flex size-9 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
          aria-label={`Drag ${props.card.title} to reorder`}
          onPointerDown={(event) => { props.onDragStart(); controls.start(event); }}
        ><GripVertical className="size-4" aria-hidden="true" /></button>
        <button
          type="button"
          className="pressable min-w-0 flex-1 cursor-pointer text-start"
          aria-expanded={props.expanded}
          onClick={props.onExpand}
        >
          <span className="block truncate font-medium">{props.card.title}</span>
          <span className="block text-xs text-muted">{props.card.body.length.toLocaleString()} characters</span>
        </button>
        <input
          type="checkbox"
          role="switch"
          className="prompt-switch"
          aria-label={`Include ${props.card.title} in the prompt`}
          checked={props.card.enabled}
          disabled={props.busy}
          onChange={props.onToggle}
        />
        <button
          type="button"
          className="pressable hit-44 inline-flex size-9 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface"
          aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.card.title}`}
          aria-expanded={props.expanded}
          onClick={props.onExpand}
        >{props.expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}</button>
      </div>
      {props.expanded && (
        <div className="grid gap-3 border-bs border-border pbs-3">
          <label className="grid gap-1 text-sm font-medium" htmlFor={`prompt-title-${props.card.id}`}>
            Title
            <input
              id={`prompt-title-${props.card.id}`}
              ref={props.titleInputRef}
              className={inputClass}
              value={props.draft.title}
              onChange={(event) => props.onDraft({ ...props.draft, title: event.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm font-medium" htmlFor={`prompt-body-${props.card.id}`}>
            Body
            <textarea
              ref={textareaRef}
              id={`prompt-body-${props.card.id}`}
              className={`${inputClass} min-h-48 resize-y whitespace-pre-wrap font-mono leading-6`}
              value={props.draft.body}
              onChange={(event) => props.onDraft({ ...props.draft, body: event.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-2" aria-label="Insert placeholder">
            {PROMPT_PLACEHOLDERS.map((name) => (
              <button key={name} type="button" className="pressable rounded-md border border-border px-2 py-1 font-mono text-xs [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" onClick={() => insertPlaceholder(name)}>{`{{${name}}}`}</button>
            ))}
          </div>
          {props.saveError && <p className="text-sm text-muted" role="alert">{props.saveError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={!changed || props.busy} onClick={props.onSave}>Save</button>
            <button type="button" className={buttonClass} disabled={!props.canMoveUp || props.busy} onClick={() => props.onMove(-1)}>Move up</button>
            <button type="button" className={buttonClass} disabled={!props.canMoveDown || props.busy} onClick={() => props.onMove(1)}>Move down</button>
            <button type="button" className="pressable inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised" disabled={props.busy} onClick={props.onDelete}>
              <Trash2 className="size-4" aria-hidden="true" />Delete
            </button>
          </div>
        </div>
      )}
    </Reorder.Item>
  );
}

export function PromptSettingsPage(props: { onOpenSidebar: () => void }) {
  const [cards, setCards] = useState<PromptCard[] | undefined>();
  const [drafts, setDrafts] = useState<Record<string, PromptDraft>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [ordering, setOrdering] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const dragStartOrder = useRef<PromptCard[] | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);

  const load = async () => {
    setLoadError("");
    try {
      const result = await fetchPromptCards();
      setCards(result);
      setDrafts(Object.fromEntries(result.map((card) => [card.id, { title: card.title, body: card.body }])));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load prompt cards.");
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (addedId) titleRef.current?.focus();
  }, [addedId]);

  const markBusy = (id: string, busy: boolean) => setBusyIds((current) => busy ? [...current, id] : current.filter((item) => item !== id));
  const saveOrder = async (next: PromptCard[], previous: PromptCard[]) => {
    setOrdering(true);
    setActionError("");
    try {
      setCards(await orderPromptCards(next.map((card) => card.id)));
    } catch (error) {
      setCards(previous);
      setActionError(error instanceof Error ? error.message : "Could not reorder prompt cards.");
    } finally {
      setOrdering(false);
    }
  };

  const toggle = async (card: PromptCard) => {
    markBusy(card.id, true);
    setActionError("");
    setCards((current) => current?.map((item) => item.id === card.id ? { ...item, enabled: !card.enabled } : item));
    try {
      const saved = await updatePromptCard(card.id, { enabled: !card.enabled });
      setCards((current) => current?.map((item) => item.id === saved.id ? saved : item));
    } catch (error) {
      setCards((current) => current?.map((item) => item.id === card.id ? { ...item, enabled: card.enabled } : item));
      setActionError(error instanceof Error ? error.message : "Could not update prompt card.");
    } finally {
      markBusy(card.id, false);
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    if (!cards) return;
    const target = index + delta;
    if (target < 0 || target >= cards.length) return;
    const next = [...cards];
    [next[index], next[target]] = [next[target], next[index]];
    setCards(next);
    void saveOrder(next, cards);
  };

  const add = async () => {
    setActionError("");
    try {
      const card = await createPromptCard({ title: "New card" });
      setCards((current) => [...(current ?? []), card]);
      setDrafts((current) => ({ ...current, [card.id]: { title: card.title, body: card.body } }));
      setExpandedId(card.id);
      setAddedId(card.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not add prompt card.");
    }
  };

  const save = async (card: PromptCard) => {
    const draft = drafts[card.id];
    if (!draft) return;
    markBusy(card.id, true);
    setSaveErrors((current) => ({ ...current, [card.id]: "" }));
    try {
      const saved = await updatePromptCard(card.id, draft);
      setCards((current) => current?.map((item) => item.id === saved.id ? saved : item));
      setDrafts((current) => ({ ...current, [saved.id]: { title: saved.title, body: saved.body } }));
    } catch (error) {
      setSaveErrors((current) => ({ ...current, [card.id]: error instanceof Error ? error.message : "Could not save prompt card." }));
    } finally {
      markBusy(card.id, false);
    }
  };

  const remove = async (card: PromptCard) => {
    if (!window.confirm(`Delete “${card.title}”?`)) return;
    markBusy(card.id, true);
    setActionError("");
    try {
      await deletePromptCard(card.id);
      setCards((current) => current?.filter((item) => item.id !== card.id));
      setDrafts((current) => { const next = { ...current }; delete next[card.id]; return next; });
      if (expandedId === card.id) setExpandedId(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not delete prompt card.");
    } finally {
      markBusy(card.id, false);
    }
  };

  const reset = async () => {
    if (!window.confirm("Reset all prompt cards to defaults? This replaces the current cards and discards unsaved edits.")) return;
    setActionError("");
    try {
      const result = await resetPromptCards();
      setCards(result);
      setDrafts(Object.fromEntries(result.map((card) => [card.id, { title: card.title, body: card.body }])));
      setExpandedId(null);
      setSaveErrors({});
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not reset prompt cards.");
    }
  };

  const enabledCharacters = cards?.filter((card) => card.enabled).reduce((sum, card) => sum + card.body.length, 0) ?? 0;

  return (
    <div className="flex min-inline-size-0 flex-1 flex-col">
      <AppHeader title="Settings" onOpenSidebar={props.onOpenSidebar} />
      <div className="chat-scroll settings-scroll">
        <main className="settings-main">
          <h2 className="settings-heading">Prompt</h2>
          <section className="theme-group grid gap-4" aria-labelledby="prompt-cards-title">
            <div className="theme-body">
              <div className="theme-copy">
                <p id="prompt-cards-title" className="theme-label">Prompt cards</p>
                <p className="theme-desc">Only enabled card bodies are sent, from top to bottom. Titles are labels only. A card that uses a placeholder with no data for the campaign is skipped.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass} disabled={cards === undefined || ordering} onClick={() => void add()}><Plus className="size-4" aria-hidden="true" />Add card</button>
                <button type="button" className={buttonClass} disabled={cards === undefined || ordering} onClick={() => void reset()}><RotateCcw className="size-4" aria-hidden="true" />Reset to defaults</button>
              </div>
            </div>
            {cards && <p className="text-sm text-muted">Enabled cards: {enabledCharacters.toLocaleString()} characters (placeholders not filled)</p>}
            {actionError && <p className="text-sm text-muted" role="alert">{actionError}</p>}
            {cards === undefined ? loadError ? (
              <section className="grid justify-items-start gap-3 rounded-lg border border-border p-5" role="alert">
                <p className="text-sm text-muted">{loadError}</p>
                <button type="button" className={buttonClass} onClick={() => void load()}>Try again</button>
              </section>
            ) : <p className="text-sm text-muted" role="status">Loading prompt cards…</p> : cards.length === 0 ? (
              <p className="text-sm text-muted">No prompt cards. Add one to begin.</p>
            ) : (
              <Reorder.Group
                as="ol"
                axis="y"
                values={cards}
                onReorder={setCards}
                className="grid list-none gap-3 p-0"
              >
                {cards.map((card, index) => (
                  <PromptCardRow
                    key={card.id}
                    card={card}
                    draft={drafts[card.id] ?? { title: card.title, body: card.body }}
                    expanded={expandedId === card.id}
                    busy={ordering || busyIds.includes(card.id)}
                    onExpand={() => setExpandedId((current) => current === card.id ? null : card.id)}
                    onToggle={() => void toggle(card)}
                    onDraft={(draft) => { setDrafts((current) => ({ ...current, [card.id]: draft })); setSaveErrors((current) => ({ ...current, [card.id]: "" })); }}
                    onSave={() => void save(card)}
                    onDelete={() => void remove(card)}
                    onMove={(delta) => move(index, delta)}
                    onDragStart={() => { dragStartOrder.current = cards; }}
                    onDragEnd={() => {
                      const previous = dragStartOrder.current;
                      dragStartOrder.current = null;
                      if (previous && previous.some((item, orderIndex) => item.id !== cards[orderIndex]?.id)) {
                        void saveOrder(cards, previous);
                      }
                    }}
                    titleInputRef={card.id === addedId ? titleRef : null}
                    canMoveUp={index > 0}
                    canMoveDown={index < cards.length - 1}
                    saveError={saveErrors[card.id]}
                  />
                ))}
              </Reorder.Group>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
