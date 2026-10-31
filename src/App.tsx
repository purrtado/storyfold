import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import type { Chat, World } from "../shared/domain";
import { ChatPlay } from "./components/ChatPlay";
import { ProvidersPage } from "./components/ProvidersPage";
import { StatsSettingsPage } from "./components/StatsSettingsPage";
import { PromptSettingsPage } from "./components/PromptSettingsPage";
import { SettingsPage, SettingsSidebar } from "./components/SettingsPage";
import { Sheet } from "./components/Sheet";
import { Sidebar } from "./components/Sidebar";
import { WorldHub } from "./components/WorldHub";
import { WorldsPage } from "./components/WorldsPage";
import {
  ApiError,
  deleteChatMessage,
  editChatMessage,
  fetchChat,
  fetchChatMessages,
  selectChatVariant,
  type TranscriptMessage,
} from "./lib/storyApi";
import { refreshChats, refreshLibraries, warmLibraries } from "./lib/libraryCache";
import { useChatGeneration } from "./lib/useChatGeneration";
import { useTheme } from "./lib/useTheme";

type ChatDetails = { chat: Chat; world: World };

function WorldHubRoute(props: { onOpenSidebar: () => void }) {
  const { worldId } = useParams();
  return worldId ? <WorldHub key={worldId} worldId={worldId} onOpenSidebar={props.onOpenSidebar} /> : <Navigate to="/worlds" replace />;
}

export default function App() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("storyfold-sidebar-collapsed") === "1",
  );
  const [chats, setChats] = useState<Record<string, ChatDetails>>({});
  const [chatErrors, setChatErrors] = useState<Record<string, string>>({});
  const [chatsLoading, setChatsLoading] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, TranscriptMessage[]>>({});
  const [messageErrors, setMessageErrors] = useState<Record<string, string>>({});
  const [messagesLoading, setMessagesLoading] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const chatLoads = useRef(new Set<string>());
  const messageRequestSequence = useRef(new Map<string, number>());
  const { preference, setPreference } = useTheme();
  const { pathname } = useLocation();
  const chatMatch = /^\/chats\/([^/]+)$/.exec(pathname);
  const activeChatId = chatMatch ? decodeURIComponent(chatMatch[1]) : null;
  const isSettings = pathname.startsWith("/settings");

  const refreshChat = useCallback(async (chatId: string) => {
    if (chatLoads.current.has(chatId)) return;
    chatLoads.current.add(chatId);
    setChatsLoading((current) => ({ ...current, [chatId]: true }));
    setChatErrors((current) => {
      const next = { ...current };
      delete next[chatId];
      return next;
    });
    try {
      const details = await fetchChat(chatId);
      setChats((current) => ({ ...current, [chatId]: details }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setChats((current) => {
          const next = { ...current };
          delete next[chatId];
          return next;
        });
      }
      setChatErrors((current) => ({
        ...current,
        [chatId]: error instanceof Error ? error.message : "Could not load this chat.",
      }));
    } finally {
      chatLoads.current.delete(chatId);
      setChatsLoading((current) => ({ ...current, [chatId]: false }));
    }
  }, []);

  const refreshChatMessages = useCallback(async (chatId: string) => {
    const requestId = (messageRequestSequence.current.get(chatId) ?? 0) + 1;
    messageRequestSequence.current.set(chatId, requestId);
    setMessagesLoading((current) => ({ ...current, [chatId]: true }));
    setMessageErrors((current) => {
      const next = { ...current };
      delete next[chatId];
      return next;
    });
    try {
      const loaded = await fetchChatMessages(chatId);
      if (messageRequestSequence.current.get(chatId) === requestId) {
        setMessages((current) => ({ ...current, [chatId]: loaded }));
      }
    } catch (error) {
      if (messageRequestSequence.current.get(chatId) === requestId) {
        setMessageErrors((current) => ({
          ...current,
          [chatId]: error instanceof Error ? error.message : "Could not load the transcript.",
        }));
      }
    } finally {
      if (messageRequestSequence.current.get(chatId) === requestId) {
        setMessagesLoading((current) => ({ ...current, [chatId]: false }));
      }
    }
  }, []);

  useEffect(() => {
    warmLibraries();
  }, []);

  useEffect(() => {
    const onFocus = () => {
      refreshLibraries();
      if (activeChatId) {
        void refreshChat(activeChatId);
        void refreshChatMessages(activeChatId);
      }
    };
    // Phones resume a backgrounded tab without a window focus event.
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeChatId, refreshChat, refreshChatMessages]);

  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    localStorage.setItem("storyfold-sidebar-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  useEffect(() => {
    if (!activeChatId) return;
    void refreshChat(activeChatId);
    void refreshChatMessages(activeChatId);
  }, [activeChatId, refreshChat, refreshChatMessages]);

  const { generation, send, open, regenerate, attach, stop, dismiss } = useChatGeneration({
    onAccepted: (chatId, _ids, content) => {
      setDrafts((current) => {
        if ((current[chatId] ?? "").trim() !== content) return current;
        return { ...current, [chatId]: "" };
      });
      void refreshChatMessages(chatId);
    },
    onSettled: async (chatId) => {
      refreshChats();
      await refreshChatMessages(chatId);
    },
  });

  // A reply still generating on the server (sent from another tab, or before
  // this page was closed or suspended) streams here once its pending row
  // shows. One attach per loaded transcript: a failed refresh cannot repeat it.
  const activeMessages = activeChatId ? messages[activeChatId] : undefined;
  const attachedTranscript = useRef<TranscriptMessage[] | undefined>(undefined);
  useEffect(() => {
    const trailing = activeMessages?.at(-1);
    if (!activeChatId || generation || trailing?.role !== "assistant" || trailing.status !== "pending") return;
    if (attachedTranscript.current === activeMessages) return;
    attachedTranscript.current = activeMessages;
    attach(activeChatId);
  }, [activeChatId, activeMessages, generation, attach]);

  const selectVariant = useCallback(async (chatId: string, messageId: string) => {
    try {
      await selectChatVariant(chatId, messageId);
    } finally {
      await refreshChatMessages(chatId);
    }
  }, [refreshChatMessages]);

  const editMessage = useCallback(async (chatId: string, messageId: string, content: string) => {
    try {
      await editChatMessage(chatId, messageId, content);
    } finally {
      await refreshChatMessages(chatId);
    }
  }, [refreshChatMessages]);

  const deleteMessage = useCallback(async (
    chatId: string,
    messageId: string,
    scope?: "variant" | "after",
  ) => {
    try {
      await deleteChatMessage(chatId, messageId, scope);
    } finally {
      await refreshChatMessages(chatId);
    }
  }, [refreshChatMessages]);

  const changeDraft = useCallback((chatId: string, value: string) => {
    setDrafts((current) => ({ ...current, [chatId]: value }));
  }, []);

  const activeChat = activeChatId ? chats[activeChatId] : undefined;
  const openSidebar = () => setMobileOpen(true);

  return (
    <div className="flex h-dvh overflow-clip">
      <Sheet
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        title={isSettings ? "Settings" : "Storyfold navigation"}
      >
        {isSettings ? (
          <SettingsSidebar />
        ) : (
          <Sidebar activeChatId={activeChatId} />
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
              onCollapse={() => setCollapsed((current) => !current)}
            />
          ) : (
            <Sidebar
              activeChatId={activeChatId}
              variant={collapsed ? "rail" : "full"}
              onCollapse={() => setCollapsed((current) => !current)}
            />
          )}
        </div>
      </aside>

      <Routes>
        <Route path="/" element={<Navigate to="/worlds" replace />} />
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
              onOpenSidebar={openSidebar}
            />
          }
        />
        <Route
          path="/settings/providers"
          element={<ProvidersPage onOpenSidebar={openSidebar} />}
        />
        <Route
          path="/settings/stats"
          element={<StatsSettingsPage onOpenSidebar={openSidebar} />}
        />
        <Route
          path="/settings/prompt"
          element={<PromptSettingsPage onOpenSidebar={openSidebar} />}
        />
        <Route path="/worlds" element={<WorldsPage onOpenSidebar={openSidebar} />} />
        <Route path="/worlds/:worldId" element={<WorldHubRoute onOpenSidebar={openSidebar} />} />
        <Route
          path="/chats/:chatId"
          element={activeChatId ? (
            <ChatPlay
              chatId={activeChatId}
              chat={activeChat?.chat ?? null}
              world={activeChat?.world ?? null}
              chatLoading={!activeChat && (Boolean(chatsLoading[activeChatId]) || !chatErrors[activeChatId])}
              chatError={activeChat ? "" : chatErrors[activeChatId] ?? ""}
              messages={messages[activeChatId]}
              messagesLoading={Boolean(messagesLoading[activeChatId]) || (messages[activeChatId] === undefined && !messageErrors[activeChatId])}
              messagesError={messageErrors[activeChatId] ?? ""}
              generation={generation}
              draft={drafts[activeChatId] ?? ""}
              onOpenSidebar={openSidebar}
              onDraftChange={changeDraft}
              onSend={send}
              onOpen={open}
              onRegenerate={regenerate}
              onSelectVariant={selectVariant}
              onEditMessage={editMessage}
              onDeleteMessage={deleteMessage}
              onStop={stop}
              onRefreshMessages={refreshChatMessages}
              onRetryChat={refreshChat}
              onDismissGeneration={dismiss}
            />
          ) : <Navigate to="/worlds" replace />}
        />
        <Route path="*" element={<Navigate to="/worlds" replace />} />
      </Routes>
    </div>
  );
}
