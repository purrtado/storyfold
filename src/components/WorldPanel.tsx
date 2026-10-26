import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PanelRightClose, PanelRightOpen, ScrollText, Users } from "lucide-react";
import type { Chat, World } from "../../shared/domain";
import { refreshWorldData, useWorldCharacters } from "../lib/libraryCache";
import { Avatar } from "./Avatar";
import { CharacterRoster } from "./CharacterRoster";
import { Tooltip } from "./Tooltip";
import { WorldCompendium } from "./WorldCompendium";

const panelTabs = [
  { id: "characters", label: "Characters", Icon: Users },
  { id: "compendium", label: "Compendium", Icon: ScrollText },
] as const;

type PanelTabId = (typeof panelTabs)[number]["id"];

/**
 * The world beside play: characters, relationships and the compendium, edited
 * live — every change reaches the narrator from the next reply. Docked on wide
 * screens (with a collapsed rail) and hosted in a sheet on narrow ones;
 * collapsing keeps the full panel mounted so open cards and drafts survive.
 */
export function WorldPanel(props: {
  world: World;
  chat: Chat;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Opens this character's card; a new `key` re-reveals the same character. */
  revealCharacter?: { id: string; key: number } | null;
}) {
  const [tab, setTab] = useState<PanelTabId>("characters");
  const [mounted, setMounted] = useState<Record<PanelTabId, boolean>>({ characters: true, compendium: false });
  const [openCharacterId, setOpenCharacterId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<PanelTabId, HTMLButtonElement | null>>>({});
  const characters = useWorldCharacters(props.world.id).items ?? [];
  const collapsed = Boolean(props.collapsed);

  useEffect(() => {
    const onFocus = () => refreshWorldData(props.world.id);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [props.world.id]);

  const activate = (id: PanelTabId) => {
    if (id !== tab) scrollerRef.current?.scrollTo({ top: 0 });
    setTab(id);
    setMounted((current) => current[id] ? current : { ...current, [id]: true });
  };

  const expandTo = (id: PanelTabId, characterId?: string) => {
    activate(id);
    if (characterId) setOpenCharacterId(characterId);
    props.onCollapsedChange?.(false);
  };

  useEffect(() => {
    if (props.revealCharacter) expandTo("characters", props.revealCharacter.id);
  }, [props.revealCharacter]);

  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = panelTabs.findIndex((entry) => entry.id === tab);
    const next = event.key === "ArrowRight"
      ? (index + 1) % panelTabs.length
      : event.key === "ArrowLeft"
        ? (index + panelTabs.length - 1) % panelTabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End" ? panelTabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    activate(panelTabs[next].id);
    tabRefs.current[panelTabs[next].id]?.focus();
  };

  return (
    <>
      {collapsed && (
        <div className="flex h-full [inline-size:3.5rem] flex-col items-center gap-1 py-3">
          <Tooltip content="Expand panel" side="left">
            <button type="button" className="rail-btn" onClick={() => props.onCollapsedChange?.(false)} aria-label="Expand world panel" aria-expanded={false}>
              <PanelRightOpen className="size-4.5" aria-hidden="true" />
            </button>
          </Tooltip>
          <div className="my-1 block-px inline-8 bg-border" />
          {characters.map((character) => (
            <Tooltip key={character.id} content={character.name} side="left">
              <button type="button" className="rail-btn" onClick={() => expandTo("characters", character.id)} aria-label={`Show ${character.name}`}>
                <Avatar name={character.name} imageId={character.avatar_id} className="size-8 text-xs" />
              </button>
            </Tooltip>
          ))}
          <div className="my-1 block-px inline-8 bg-border" />
          {panelTabs.slice(1).map(({ id, label, Icon }) => (
            <Tooltip key={id} content={label} side="left">
              <button type="button" className="rail-btn" onClick={() => expandTo(id)} aria-label={`Show ${label}`}>
                <Icon className="size-4.5" aria-hidden="true" />
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      <div className="flex h-full min-block-0 flex-col" hidden={collapsed}>
        <div className={`flex flex-none items-center gap-2 ps-4 pbs-3 ${props.onCollapsedChange ? "pe-2" : "pe-14"}`}>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{props.world.name}</h2>
            <p className="truncate text-xs text-muted">Edits apply to the world, live</p>
          </div>
          {props.onCollapsedChange && (
            <Tooltip content="Collapse panel" side="left">
              <button type="button" className="pressable inline-flex size-11 flex-none items-center justify-center rounded-lg text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-raised [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground" onClick={() => props.onCollapsedChange?.(true)} aria-label="Collapse world panel" aria-expanded>
                <PanelRightClose className="size-4.5" aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
        <div role="tablist" aria-label="World panel" className="flex flex-none gap-1 border-be border-border px-2" onKeyDown={onTablistKeyDown}>
          {panelTabs.map(({ id, label, Icon }) => {
            const selected = id === tab;
            return (
              <button
                key={id}
                ref={(node) => { tabRefs.current[id] = node; }}
                type="button"
                role="tab"
                id={`world-tab-${id}`}
                aria-selected={selected}
                aria-controls={`world-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => activate(id)}
                className={`relative inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium ${selected
                  ? "text-foreground after:absolute after:inset-be-0 after:inset-is-2 after:inset-ie-2 after:block after:h-0.5 after:rounded-full after:bg-accent after:content-['']"
                  : "text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground"}`}
              >
                <Icon className="size-4" aria-hidden="true" />{label}
              </button>
            );
          })}
        </div>
        <div ref={scrollerRef} className="chat-scroll flex-1 min-block-0 p-3">
          <div role="tabpanel" id="world-panel-characters" aria-labelledby="world-tab-characters" hidden={tab !== "characters"}>
            <CharacterRoster
              world={props.world}
              protagonistId={props.chat.protagonist_id}
              openId={openCharacterId}
              onOpenChange={setOpenCharacterId}
              revealKey={props.revealCharacter?.key}
              visible={tab === "characters" && !collapsed}
            />
          </div>
          <div role="tabpanel" id="world-panel-compendium" aria-labelledby="world-tab-compendium" hidden={tab !== "compendium"}>
            {mounted.compendium && <WorldCompendium world={props.world} />}
          </div>
        </div>
      </div>
    </>
  );
}
