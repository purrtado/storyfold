import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { Campaign, Character, Session, World } from "../shared/domain";
import { CampaignPlay } from "./components/CampaignPlay";
import { NewCampaignPage } from "./components/NewCampaignPage";
import { CharactersPage } from "./components/CharactersPage";
import { ProvidersPage } from "./components/ProvidersPage";
import { StatsSettingsPage } from "./components/StatsSettingsPage";
import { SettingsPage, SettingsSidebar } from "./components/SettingsPage";
import { Sheet } from "./components/Sheet";
import { Sidebar } from "./components/Sidebar";
import { WorldsPage } from "./components/WorldsPage";
import {
  deleteSessionMessage,
  editSessionMessage,
  fetchCampaigns,
  fetchSession,
  fetchSessionMessages,
  selectSessionVariant,
  type TranscriptMessage,
} from "./lib/storyApi";
import { refreshLibraries, warmLibraries } from "./lib/libraryCache";
import { useChatGeneration } from "./lib/useChatGeneration";
import { useTheme } from "./lib/useTheme";
import { updateCampaignSessionCache } from "./lib/campaignLifecycle";

export default function App() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("storyfold-sidebar-collapsed") === "1",
  );
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignsError, setCampaignsError] = useState("");
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, { campaign: Campaign; session: Session }>>({});
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({});
  const [sessionsLoading, setSessionsLoading] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, TranscriptMessage[]>>({});
  const [messageErrors, setMessageErrors] = useState<Record<string, string>>({});
  const [messagesLoading, setMessagesLoading] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const campaignLoads = useRef(false);
  const campaignListRequest = useRef(0);
  const sessionLoads = useRef(new Set<string>());
  const messageRequestSequence = useRef(new Map<string, number>());
  const sessionTransitionVersion = useRef(0);
  const { preference, setPreference } = useTheme();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(pathname);
  const activeSessionId = sessionMatch ? decodeURIComponent(sessionMatch[1]) : null;
  const isSettings = pathname.startsWith("/settings");

  const refreshCampaigns = useCallback(async () => {
    if (campaignLoads.current) return;
    campaignLoads.current = true;
    const requestId = ++campaignListRequest.current;
    setCampaignsLoading(true);
    setCampaignsError("");
    try {
      const loaded = await fetchCampaigns();
      if (campaignListRequest.current === requestId) setCampaigns(loaded);
    } catch (error) {
      if (campaignListRequest.current === requestId) {
        setCampaignsError(error instanceof Error ? error.message : "Could not load campaigns.");
      }
    } finally {
      if (campaignListRequest.current === requestId) {
        campaignLoads.current = false;
        setCampaignsLoading(false);
      }
    }
  }, []);

  const refreshSession = useCallback(async (sessionId: string) => {
    if (sessionLoads.current.has(sessionId)) return;
    sessionLoads.current.add(sessionId);
    const transitionVersion = sessionTransitionVersion.current;
    setSessionsLoading((current) => ({ ...current, [sessionId]: true }));
    setSessionErrors((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    try {
      const details = await fetchSession(sessionId);
      if (sessionTransitionVersion.current === transitionVersion) {
        setSessions((current) => ({ ...current, [sessionId]: details }));
      }
    } catch (error) {
      if (sessionTransitionVersion.current === transitionVersion) {
        setSessionErrors((current) => ({
          ...current,
          [sessionId]: error instanceof Error ? error.message : "Could not load this session.",
        }));
      }
    } finally {
      sessionLoads.current.delete(sessionId);
      if (sessionTransitionVersion.current === transitionVersion) {
        setSessionsLoading((current) => ({ ...current, [sessionId]: false }));
      }
    }
  }, []);
  const syncCampaignSession = useCallback(async (sessionId: string) => {
    const transitionVersion = ++sessionTransitionVersion.current;
    campaignLoads.current = true;
    const requestId = ++campaignListRequest.current;
    setCampaignsLoading(true);
    setCampaignsError("");
    try {
      const details = await fetchSession(sessionId);
      if (campaignListRequest.current !== requestId || sessionTransitionVersion.current !== transitionVersion) return;
      setSessions((current) => updateCampaignSessionCache(current, sessionId, details));
      setSessionErrors((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setSessionsLoading({});

      const loadedCampaigns = await fetchCampaigns();
      if (campaignListRequest.current !== requestId || sessionTransitionVersion.current !== transitionVersion) return;
      setCampaigns(loadedCampaigns);
    } catch (error) {
      if (campaignListRequest.current !== requestId || sessionTransitionVersion.current !== transitionVersion) return;
      const message = error instanceof Error ? error.message : "Could not refresh the campaign.";
      setCampaignsError(message);
      setSessionsLoading({});
      throw error;
    } finally {
      if (campaignListRequest.current === requestId) {
        campaignLoads.current = false;
        setCampaignsLoading(false);
      }
    }
  }, []);

  const refreshSessionMessages = useCallback(async (sessionId: string) => {
    const requestId = (messageRequestSequence.current.get(sessionId) ?? 0) + 1;
    messageRequestSequence.current.set(sessionId, requestId);
    setMessagesLoading((current) => ({ ...current, [sessionId]: true }));
    setMessageErrors((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    try {
      const loaded = await fetchSessionMessages(sessionId);
      if (messageRequestSequence.current.get(sessionId) === requestId) {
        setMessages((current) => ({ ...current, [sessionId]: loaded }));
      }
    } catch (error) {
      if (messageRequestSequence.current.get(sessionId) === requestId) {
        setMessageErrors((current) => ({
          ...current,
          [sessionId]: error instanceof Error ? error.message : "Could not load the transcript.",
        }));
      }
    } finally {
      if (messageRequestSequence.current.get(sessionId) === requestId) {
        setMessagesLoading((current) => ({ ...current, [sessionId]: false }));
      }
    }
  }, []);

  useEffect(() => {
    void refreshCampaigns();
    warmLibraries();
  }, [refreshCampaigns]);

  useEffect(() => {
    const onFocus = () => {
      void refreshCampaigns();
      refreshLibraries();
      if (activeSessionId) {
        void refreshSession(activeSessionId);
        void refreshSessionMessages(activeSessionId);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeSessionId, refreshCampaigns, refreshSession, refreshSessionMessages]);

  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    localStorage.setItem("storyfold-sidebar-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  useEffect(() => {
    if (!activeSessionId) return;
    void refreshSession(activeSessionId);
    void refreshSessionMessages(activeSessionId);
  }, [activeSessionId, refreshSession, refreshSessionMessages]);

  const { generation, send, open, regenerate, stop, dismiss } = useChatGeneration({
    onAccepted: (sessionId, _ids, content) => {
      setDrafts((current) => {
        if ((current[sessionId] ?? "").trim() !== content) return current;
        return { ...current, [sessionId]: "" };
      });
      void refreshSessionMessages(sessionId);
    },
    onSettled: refreshSessionMessages,
  });

  const selectVariant = useCallback(async (sessionId: string, messageId: string) => {
    try {
      await selectSessionVariant(sessionId, messageId);
    } finally {
      await refreshSessionMessages(sessionId);
    }
  }, [refreshSessionMessages]);

  const editMessage = useCallback(async (sessionId: string, messageId: string, content: string) => {
    try {
      await editSessionMessage(sessionId, messageId, content);
    } finally {
      await refreshSessionMessages(sessionId);
    }
  }, [refreshSessionMessages]);

  const deleteMessage = useCallback(async (
    sessionId: string,
    messageId: string,
    scope?: "variant" | "after",
  ) => {
    try {
      await deleteSessionMessage(sessionId, messageId, scope);
    } finally {
      await refreshSessionMessages(sessionId);
    }
  }, [refreshSessionMessages]);

  const openNewCampaign = () => {
    setMobileOpen(false);
    navigate("/campaigns/new");
  };

  const changeModel = useCallback((sessionId: string, model: string) => {
    setModelOverrides((current) => {
      if (model) return { ...current, [sessionId]: model };
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const changeDraft = useCallback((sessionId: string, value: string) => {
    setDrafts((current) => ({ ...current, [sessionId]: value }));
  }, []);

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;


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
          <Sidebar
            campaigns={campaigns}
            campaignsLoading={campaignsLoading && campaigns.length === 0}
            campaignsError={campaignsError}
            activeSessionId={activeSessionId}
            onNewCampaign={openNewCampaign}
            onRefreshCampaigns={() => { void refreshCampaigns(); }}
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
              onCollapse={() => setCollapsed((current) => !current)}
            />
          ) : (
            <Sidebar
              campaigns={campaigns}
              campaignsLoading={campaignsLoading && campaigns.length === 0}
              campaignsError={campaignsError}
              activeSessionId={activeSessionId}
              onNewCampaign={openNewCampaign}
              onRefreshCampaigns={() => { void refreshCampaigns(); }}
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
              onOpenSidebar={() => setMobileOpen(true)}
            />
          }
        />
        <Route
          path="/settings/providers"
          element={<ProvidersPage onOpenSidebar={() => setMobileOpen(true)} />}
        />
        <Route
          path="/settings/stats"
          element={<StatsSettingsPage onOpenSidebar={() => setMobileOpen(true)} />}
        />
        <Route
          path="/worlds"
          element={
            <WorldsPage
              onOpenSidebar={() => setMobileOpen(true)}
              onSelect={(world: World) => {
                setSelectedWorldId(world.id);
                navigate("/campaigns/new");
              }}
            />
          }
        />
        <Route
          path="/characters"
          element={
            <CharactersPage
              onOpenSidebar={() => setMobileOpen(true)}
              onSelect={(character: Character) => {
                setSelectedCharacterId(character.id);
                navigate("/campaigns/new");
              }}
            />
          }
        />
        <Route
          path="/campaigns/new"
          element={
            <NewCampaignPage
              onOpenSidebar={() => setMobileOpen(true)}
              selectedWorldId={selectedWorldId}
              selectedCharacterId={selectedCharacterId}
              onStarted={(campaign, session) => {
                setCampaigns((current) => [campaign, ...current.filter((item) => item.id !== campaign.id)]);
                setSelectedWorldId(null);
                setSelectedCharacterId(null);
                navigate(`/sessions/${session.id}`);
              }}
            />
          }
        />
        <Route
          path="/sessions/:sessionId"
          element={activeSessionId ? (
            <CampaignPlay
              sessionId={activeSessionId}
              campaign={activeSession?.campaign ?? null}
              session={activeSession?.session ?? null}
              sessionLoading={!activeSession && (Boolean(sessionsLoading[activeSessionId]) || !sessionErrors[activeSessionId])}
              sessionError={activeSession ? "" : sessionErrors[activeSessionId] ?? ""}
              messages={messages[activeSessionId]}
              messagesLoading={Boolean(messagesLoading[activeSessionId]) || (messages[activeSessionId] === undefined && !messageErrors[activeSessionId])}
              messagesError={messageErrors[activeSessionId] ?? ""}
              generation={generation}
              draft={drafts[activeSessionId] ?? ""}
              selectedModel={modelOverrides[activeSessionId] ?? ""}
              onOpenSidebar={() => setMobileOpen(true)}
              onDraftChange={changeDraft}
              onModelChange={changeModel}
              onSend={send}
              onOpen={open}
              onRegenerate={regenerate}
              onSelectVariant={selectVariant}
              onEditMessage={editMessage}
              onDeleteMessage={deleteMessage}
              onStop={stop}
              onRefreshMessages={refreshSessionMessages}
              onRetrySession={refreshSession}
              onDismissGeneration={dismiss}
              onSyncSession={syncCampaignSession}
            />
          ) : <Navigate to="/worlds" replace />}
        />
        <Route path="*" element={<Navigate to="/worlds" replace />} />
      </Routes>
    </div>
  );
}
