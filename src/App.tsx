import { useCallback, useEffect, useMemo, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Sheet } from "./components/Sheet";
import { useTheme } from "./lib/useTheme";
import { SettingsPage, SettingsSidebar } from "./components/SettingsPage";
import { ProvidersPage } from "./components/ProvidersPage";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  appendMessage,
  loadConversations,
  newConversation,
  saveConversations,
  STORAGE_KEY,
} from "./lib/store";
import { uid } from "./lib/samples";
import { useChatGeneration } from "./lib/useChatGeneration";

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
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("storyfold-sidebar-collapsed") === "1",
  );
  const { preference, setPreference } = useTheme();
  const { pathname } = useLocation();

  const handleAssistantReply = useCallback(
    (conversationId: string, content: string) => {
      setConversations((cs) =>
        appendMessage(cs, conversationId, {
          id: uid(),
          role: "assistant",
          content,
        }),
      );
    },
    [],
  );
  const { generation, send, stop, dismiss } = useChatGeneration({
    onAssistantReply: handleAssistantReply,
  });

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

  const handleSend = (value: string, model?: string) => {
    const conversation = ensureActive();
    const history = [
      ...conversation.messages.map(({ role, content }) => ({ role, content })),
      { role: "user" as const, content: value },
    ];
    if (!send(conversation.id, history, model)) return;
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

  const isSettings = pathname.startsWith("/settings");

  return (
    <div className="flex h-dvh overflow-clip">
      <Sheet
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        title={isSettings ? "Settings" : "Conversations"}
      >
        {isSettings ? (
          <SettingsSidebar />
        ) : (
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
        )}
      </Sheet>

      <aside
        className={`sidebar-shell hidden flex-none overflow-clip border-e border-border bg-surface md:block ${
          collapsed ? "w-14" : "w-60"
        }`}
      >
        <div className={`h-full ${collapsed ? "" : "w-[calc(15rem_-_1px)]"}`}>
          {isSettings ? (
            <SettingsSidebar
              variant={collapsed ? "rail" : "full"}
              onCollapse={() => setCollapsed((c) => !c)}
            />
          ) : (
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
          )}
        </div>
      </aside>

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
              onOpenSidebar={() => setMobileOpen(true)}
            />
          }
        />
        <Route
          path="/settings/providers"
          element={<ProvidersPage onOpenSidebar={() => setMobileOpen(true)} />}
        />
        <Route
          path="/"
          element={
            <ChatView
              conversation={active ?? newConversation()}
              draft={draft}
              onDraftChange={setDraft}
              onSend={handleSend}
              selectedModel={active ? modelOverrides[active.id] ?? "" : ""}
              onModelChange={(model) => {
                const conversation = ensureActive();
                setModelOverrides((current) => ({
                  ...current,
                  [conversation.id]: model,
                }));
              }}
              onStarter={handleStarter}
              onOpenSidebar={() => setMobileOpen(true)}
              onNew={handleNew}
              generation={generation}
              onStop={stop}
              onDismissGeneration={dismiss}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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
