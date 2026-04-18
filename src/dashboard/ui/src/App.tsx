import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api';
import type { Mode, View, TeamInfo, Stats, ReviewItem, TeamMember, Entry } from './types';
import Masthead from './components/Masthead';
import ModeRail from './components/ModeRail';
import Feed from './components/Feed';
import GraphCanvas from './components/GraphCanvas';
import Sidebar from './components/Sidebar';
import CaptureModal from './components/CaptureModal';
import InviteModal from './components/InviteModal';
import EntryDrawer from './components/EntryDrawer';
import TeamView from './components/TeamView';

export default function App() {
  const [mode, setMode] = useState<Mode>('team');
  const [view, setView] = useState<View>('feed');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [showCapture, setShowCapture] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [isLive, setIsLive] = useState(false);

  // Incrementing key triggers re-fetch in Feed without unmounting it
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
    setView('search');
  }, []);

  // ── Initial data load ──────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const results = await Promise.allSettled([
        api.getStats(),
        api.getTeamInfo(),
        api.getTeamMembers(),
        api.getReviewQueue(),
      ]);
      if (results[0].status === 'fulfilled') setStats(results[0].value);
      if (results[1].status === 'fulfilled') setTeamInfo(results[1].value);
      if (results[2].status === 'fulfilled') setTeamMembers(results[2].value);
      if (results[3].status === 'fulfilled') setReviewQueue(results[3].value);
    };
    void load();
  }, []);

  // ── SSE real-time subscription ─────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource('/api/stream');

    es.onopen = () => setIsLive(true);
    es.onerror = () => setIsLive(false);

    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as { type: string };
        if (data.type === 'entries_changed') {
          setFeedRefreshKey(k => k + 1);
          api.getStats().then(setStats).catch(() => undefined);
        }
        if (data.type === 'queue_changed') {
          api.getReviewQueue().then(setReviewQueue).catch(() => undefined);
        }
        if (data.type === 'activity_changed') {
          setSidebarRefreshKey(k => k + 1);
          setFeedRefreshKey(k => k + 1);
          api.getStats().then(setStats).catch(() => undefined);
        }
      } catch {
        // ignore malformed SSE frames
      }
    };

    return () => es.close();
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCapture) { setShowCapture(false); return; }
        if (showInvite) { setShowInvite(false); return; }
        if (selectedEntryId) { setSelectedEntryId(null); return; }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        focusSearch();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        setShowCapture(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
        e.preventDefault();
        setShowInvite(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCapture, showInvite, selectedEntryId, focusSearch]);

  // ── Action handlers ────────────────────────────────────────────────────────
  const handleReviewAction = useCallback(async (id: string, action: 'confirm' | 'archive') => {
    try {
      if (action === 'confirm') await api.confirmEntry(id);
      else await api.archiveEntry(id);
      setReviewQueue(prev => prev.filter(item => item.id !== id));
    } catch {
      // best-effort
    }
  }, []);

  const handleEntrySaved = useCallback((_entry: Entry) => {
    setFeedRefreshKey(k => k + 1);
    api.getStats().then(setStats).catch(() => undefined);
    setShowCapture(false);
  }, []);

  const handlePromote = useCallback((_promotedId: string) => {
    setSelectedEntryId(null);
    setFeedRefreshKey(k => k + 1);
    api.getStats().then(setStats).catch(() => undefined);
  }, []);

  const handleTeamCreated = useCallback((info: TeamInfo) => {
    setTeamInfo(info);
    api.getTeamMembers().then(setTeamMembers).catch(() => undefined);
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <Masthead
        reviewQueueCount={reviewQueue.length}
        isLive={isLive}
        onCapture={() => setShowCapture(true)}
        onInvite={() => setShowInvite(true)}
      />
      <ModeRail
        mode={mode}
        onModeChange={setMode}
        teamInfo={teamInfo}
        teamMemberCount={teamMembers.length}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchInputRef={searchInputRef}
        view={view}
        onViewChange={setView}
      />
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {view === 'team' ? (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <TeamView teamInfo={teamInfo} onTeamCreated={handleTeamCreated} />
          </div>
        ) : view === 'graph' ? (
          <GraphCanvas
            onNodeClick={setSelectedEntryId}
            refreshKey={feedRefreshKey}
          />
        ) : (
          <>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <Feed
                mode={mode}
                searchQuery={searchQuery}
                onEntryClick={setSelectedEntryId}
                refreshKey={feedRefreshKey}
              />
            </div>
            <Sidebar
              stats={stats}
              reviewQueue={reviewQueue}
              teamMembers={teamMembers}
              onReviewAction={handleReviewAction}
              onInvite={() => setShowInvite(true)}
              refreshKey={sidebarRefreshKey}
            />
          </>
        )}
      </div>

      {showCapture && (
        <CaptureModal
          onClose={() => setShowCapture(false)}
          onSaved={handleEntrySaved}
          defaultScope={mode}
        />
      )}
      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          teamInfo={teamInfo}
        />
      )}
      {selectedEntryId && (
        <EntryDrawer
          id={selectedEntryId}
          onClose={() => setSelectedEntryId(null)}
          onPromote={handlePromote}
        />
      )}
    </div>
  );
}
