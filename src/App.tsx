import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Sheet } from "./components/Sheet";
import { useTheme } from "./lib/useTheme";
import { SettingsPage } from "./components/SettingsPage";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
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
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("storyfold-sidebar-collapsed") === "1",
  );
  const { preference, setPreference } = useTheme();
  const { pathname } = useLocation();

  useEffect(() => setMobileOpen(false), [pathname]);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId),
    [conversations, activeId],
  );

  useEffect(() => saveConversations(conversations), [conversations]);
  useEffect(() => {
    localStorage.setItem("storyfold-sidebar-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

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
    <Routes>
      <Route
        path="/settings"
        element={<Navigate to="/settings/general" replace />}
      />
      <Route
        path="/settings/general"
        element={
          <SettingsPage
            preference={preference}
            onPreferenceChange={setPreference}
          />
        }
      />
      <Route
        path="/"
        element={
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
              />
            </Sheet>

            <aside
              className={`sidebar-shell hidden flex-none border-e border-border bg-surface md:block ${
                collapsed ? "w-14" : "w-60"
              }`}
            >
              <Sidebar
                variant={collapsed ? "rail" : "full"}
                conversations={conversations}
                activeId={activeId}
                onSelect={(id) => {
                  setActiveId(id);
                  setDraft("");
                }}
                onNew={handleNew}
                onCollapse={() => setCollapsed((c) => !c)}
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
            />
          </div>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );

  function handleNew() {
    const fresh = newConversation();
    setConversations((cs) => [fresh, ...cs]);
    setActiveId(fresh.id);
    setDraft("");
    setMobileOpen(false);
  }
}
