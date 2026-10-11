import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Sheet } from "./components/Sheet";
import { useTheme } from "./components/ThemeToggle";
import {
  appendMessage,
  loadConversations,
  newConversation,
  saveConversations,
  STORAGE_KEY,
} from "./lib/store";
import { uid } from "./lib/samples";

export default function App() {
  const [boot] = useState(() => {
    const returning = localStorage.getItem(STORAGE_KEY) !== null;
    const list = loadConversations();
    if (!returning) {
      const fresh = newConversation();
      list.unshift(fresh);
      return { list, activeId: fresh.id };
    }
    return { list, activeId: list[0]?.id ?? newConversation().id };
  });
  const [conversations, setConversations] = useState(boot.list);
  const [activeId, setActiveId] = useState(boot.activeId);
  const [draft, setDraft] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { theme, toggle } = useTheme();

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId),
    [conversations, activeId],
  );

  useEffect(() => saveConversations(conversations), [conversations]);

  const ensureActive = () => {
    if (active) return active;
    const fresh = newConversation();
    setConversations((cs) => [fresh, ...cs]);
    setActiveId(fresh.id);
    return fresh;
  };

  const handleSend = (value: string) => {
    const conversation = ensureActive();
    setConversations((cs) =>
      appendMessage(cs, conversation.id, {
        id: uid(),
        role: "user",
        content: value,
      }),
    );
    setDraft("");
  };

  const handleStarter = (text: string) => {
    setDraft(text);
  };

  return (
    <div className="flex h-dvh overflow-clip">
      <Sheet
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        title="Conversations"
      >
        <Sidebar
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            setDraft("");
            setMobileOpen(false);
          }}
          onNew={handleNew}
          theme={theme}
          onToggleTheme={toggle}
          showTheme={false}
        />
      </Sheet>

      <aside className="hidden w-60 flex-none border-e border-border bg-surface md:block"
        style={collapsed ? { display: "none" } : undefined}
      >
        <Sidebar
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            setDraft("");
          }}
          onNew={handleNew}
          theme={theme}
          onToggleTheme={toggle}
          onCollapse={() => setCollapsed(true)}
        />
      </aside>

      <ChatView
        conversation={active ?? newConversation()}
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        onStarter={handleStarter}
        onOpenSidebar={() => setMobileOpen(true)}
        onNew={handleNew}
        collapsed={collapsed}
        onExpandSidebar={() => setCollapsed(false)}
        theme={theme}
        onToggleTheme={toggle}
      />
    </div>
  );

  function handleNew() {
    const fresh = newConversation();
    setConversations((cs) => [fresh, ...cs]);
    setActiveId(fresh.id);
    setDraft("");
    setMobileOpen(false);
  }
}
