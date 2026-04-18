import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import type { TeamInfo, TeamMember, MemberStats, PendingInvite, TeamActivity } from '../types';
import TeamSetupWizard from './TeamSetupWizard';

interface TeamViewProps {
  teamInfo: TeamInfo | null;
  onTeamCreated: (info: TeamInfo) => void;
  onTeamDeleted: () => void;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function timeUntil(iso: string | null): string {
  if (!iso) return 'no expiry';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d left`;
  return `${h}h left`;
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    joined: 'joined the team',
    learn: 'added a knowledge entry',
    recall: 'ran a recall',
    search: 'searched',
    conventions: 'checked conventions',
    check_conventions: 'checked conventions',
    check: 'ran a check',
    failures: 'queried failures',
    graph: 'explored the graph',
    feedback: 'gave feedback',
    harvest: 'harvested a session',
    get_entry: 'viewed an entry',
    score: 'scored an entry',
  };
  return map[action] ?? action;
}

function actionColor(action: string): string {
  if (action === 'joined') return '#22c55e';
  if (action === 'learn') return '#6366f1';
  if (action === 'recall' || action === 'search') return '#f59e0b';
  return '#94a3b8';
}

// ── Small reusable pieces ─────────────────────────────────────────────────────

function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'var(--sunken)', border: '1px solid var(--line)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-mono)', fontSize: Math.floor(size * 0.33) + 'px', fontWeight: 700,
      color: 'var(--ink)', flexShrink: 0,
    }}>
      {initials(name)}
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      style={{
        fontSize: '11px', padding: '4px 8px', cursor: 'pointer',
        border: '1px solid var(--line)', borderRadius: '3px',
        background: copied ? '#000' : '#fff', color: copied ? '#fff' : '#000',
        fontFamily: 'var(--font-mono)', transition: 'all 150ms', flexShrink: 0,
      }}
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ink-faint)',
      paddingBottom: '10px', borderBottom: '1px solid var(--line)', marginBottom: '4px',
    }}>
      {children}
    </div>
  );
}

const ENTRY_TYPE_COLORS: Record<string, string> = {
  error_pattern: '#ef4444',
  convention: '#3b82f6',
  decision: '#8b5cf6',
  learning: '#10b981',
  ghost_knowledge: '#f59e0b',
};

// ── Member card (click to expand stats) ──────────────────────────────────────

function MemberCard({ member, onRemove }: { member: TeamMember; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && stats === null) {
      setLoadingStats(true);
      try {
        const data = await api.getMemberStats(member.developerId);
        setStats(data);
      } catch { /* best-effort */ }
      finally { setLoadingStats(false); }
    }
  };

  return (
    <div style={{ borderBottom: '1px solid var(--line)' }}>
      {/* ── Row ── */}
      <div
        onClick={() => void handleExpand()}
        style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0', cursor: 'pointer' }}
      >
        <Avatar name={member.displayName} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600 }}>
              {member.displayName}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: '10px', padding: '1px 5px',
              background: member.role === 'admin' ? '#000' : 'var(--sunken)',
              color: member.role === 'admin' ? '#fff' : 'var(--ink-faint)',
              borderRadius: '3px',
            }}>
              {member.role}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '12px', marginTop: '3px' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)' }}>
              {member.entryCount > 0 ? `${member.entryCount} entr${member.entryCount === 1 ? 'y' : 'ies'}` : 'no entries yet'}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)' }}>
              joined {relTime(member.joinedAt)}
            </span>
            {member.lastActive && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)' }}>
                active {relTime(member.lastActive)}
              </span>
            )}
          </div>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--ink-faint)', marginRight: '6px' }}>
          {expanded ? '▲' : '▼'}
        </span>
        {member.role !== 'admin' && (
          <div onClick={e => e.stopPropagation()}>
            {confirming ? (
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button onClick={() => { onRemove(member.developerId); setConfirming(false); }}
                  style={{ fontSize: '11px', padding: '4px 8px', cursor: 'pointer', border: '1px solid #cc0000', borderRadius: '3px', background: '#cc0000', color: '#fff', fontFamily: 'var(--font-sans)' }}>
                  Remove
                </button>
                <button onClick={() => setConfirming(false)}
                  style={{ fontSize: '11px', padding: '4px 8px', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: '3px', background: '#fff', color: 'var(--ink)', fontFamily: 'var(--font-sans)' }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirming(true)}
                style={{ fontSize: '11px', padding: '4px 8px', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: '3px', background: '#fff', color: 'var(--ink-faint)', fontFamily: 'var(--font-sans)', flexShrink: 0 }}>
                Remove
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Expanded stats panel ── */}
      {expanded && (
        <div style={{ padding: '0 0 16px 48px' }}>
          {loadingStats ? (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)' }}>Loading…</p>
          ) : stats ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Usage counts */}
              <div style={{ display: 'flex', gap: '24px' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em' }}>
                    {stats.learnCount}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Learns
                  </div>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em' }}>
                    {stats.recallCount}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Recalls
                  </div>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em' }}>
                    {member.entryCount}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Entries
                  </div>
                </div>
              </div>

              {/* Entries by type */}
              {Object.keys(stats.byType).length > 0 && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                    Contribution breakdown
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {Object.entries(stats.byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                      <span key={type} style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                        padding: '3px 8px', borderRadius: '12px', border: '1px solid var(--line)',
                        fontFamily: 'var(--font-mono)', fontSize: '11px',
                      }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: ENTRY_TYPE_COLORS[type] ?? '#888', flexShrink: 0 }} />
                        {type.replace(/_/g, ' ')} · {count}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent activity */}
              {stats.recentActivity.length > 0 && (
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                    Recent activity
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {stats.recentActivity.slice(0, 6).map((a, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                          fontFamily: 'var(--font-mono)', fontSize: '10px', padding: '1px 6px',
                          background: 'var(--sunken)', border: '1px solid var(--line)', borderRadius: '3px',
                          color: 'var(--ink-soft)',
                        }}>
                          {actionLabel(a.action)}
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)' }}>
                          {relTime(a.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--ink-faint)' }}>No data yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Activity row ──────────────────────────────────────────────────────────────

function ActivityRow({ event }: { event: TeamActivity }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{
        width: '8px', height: '8px', borderRadius: '50%', marginTop: '5px', flexShrink: 0,
        background: actionColor(event.action),
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600 }}>
          {event.displayName}
        </span>
        {' '}
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)' }}>
          {actionLabel(event.action)}
        </span>
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)', flexShrink: 0 }}>
        {relTime(event.timestamp)}
      </span>
    </div>
  );
}

// ── Invite row ────────────────────────────────────────────────────────────────

function InviteRow({ invite, serverUrl, onRevoke }: { invite: PendingInvite; serverUrl: string; onRevoke: (hash: string) => void }) {
  const joinCmd = `gyst join ${invite.keyHash} "Name" --server ${serverUrl}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--ink)' }}>
          {invite.keyHash.slice(0, 20)}…
        </div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)', marginTop: '2px' }}>
          {timeUntil(invite.expiresAt)} · created {relTime(invite.createdAt)}
        </div>
      </div>
      <CopyButton text={joinCmd} label="Copy join cmd" />
      <button onClick={() => onRevoke(invite.keyHash)}
        style={{ fontSize: '11px', padding: '4px 8px', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: '3px', background: '#fff', color: 'var(--ink-faint)', fontFamily: 'var(--font-sans)', flexShrink: 0 }}>
        Revoke
      </button>
    </div>
  );
}

// ── Stat pill ─────────────────────────────────────────────────────────────────

function StatPill({ value, label }: { value: number | string; label: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '16px 24px', background: 'var(--sunken)', border: '1px solid var(--line)',
      borderRadius: '6px', minWidth: '80px',
    }}>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: '28px', fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em' }}>
        {value}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: '4px' }}>
        {label}
      </span>
    </div>
  );
}

// ── Main TeamView ─────────────────────────────────────────────────────────────

export default function TeamView({ teamInfo, onTeamCreated, onTeamDeleted }: TeamViewProps) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [activity, setActivity] = useState<TeamActivity[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [serverUrl, setServerUrl] = useState('http://localhost:3456');
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const [membersRes, activityRes, invitesRes] = await Promise.allSettled([
      api.getTeamMembers(),
      api.getTeamActivity(50),
      api.listInvites(),
    ]);
    if (membersRes.status === 'fulfilled') setMembers(membersRes.value);
    if (activityRes.status === 'fulfilled') setActivity(activityRes.value);
    if (invitesRes.status === 'fulfilled') setInvites(invitesRes.value);
  }, []);

  useEffect(() => {
    if (teamInfo) void loadData();
  }, [teamInfo, loadData]);

  const handleRemoveMember = useCallback(async (developerId: string) => {
    try {
      await api.removeMember(developerId);
      setMembers(prev => prev.filter(m => m.developerId !== developerId));
      setActivity(prev => prev.filter(a => a.developerId !== developerId));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);

  const handleRevokeInvite = useCallback(async (keyHash: string) => {
    try {
      await api.revokeInvite(keyHash);
      setInvites(prev => prev.filter(i => i.keyHash !== keyHash));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);

  const handleGenerateInvite = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    try {
      await api.createInvite();
      const updated = await api.listInvites();
      setInvites(updated);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setIsGenerating(false); }
  }, []);

  if (!teamInfo) {
    return <TeamSetupWizard onComplete={onTeamCreated} />;
  }

  const totalEntries = members.reduce((sum, m) => sum + m.entryCount, 0);
  const activeToday = activity.filter(a => {
    const diff = Date.now() - new Date(a.timestamp).getTime();
    return diff < 86_400_000;
  }).length;

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 24px' }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: '24px', fontWeight: 700, margin: '0 0 6px', letterSpacing: '-0.01em' }}>
          {teamInfo.name}
        </h1>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)' }}>
          id: {teamInfo.id.slice(0, 12)}… · created {relTime(teamInfo.createdAt)}
        </div>
      </div>

      {/* ── Stats row ── */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '36px', flexWrap: 'wrap' }}>
        <StatPill value={members.length} label="members" />
        <StatPill value={totalEntries} label="entries" />
        <StatPill value={invites.length} label="open invites" />
        <StatPill value={activeToday} label="actions today" />
      </div>

      {error && (
        <div style={{ padding: '10px 12px', background: '#fff5f5', border: '1px solid #ffcccc', borderRadius: '4px', marginBottom: '24px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#cc0000' }}>
          {error}
        </div>
      )}

      {/* ── Members ── */}
      <div style={{ marginBottom: '36px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <SectionTitle>Members ({members.length})</SectionTitle>
          <button
            onClick={() => void handleGenerateInvite()}
            disabled={isGenerating}
            style={{
              fontSize: '12px', padding: '6px 14px', cursor: isGenerating ? 'default' : 'pointer',
              border: '1px solid #000', borderRadius: '4px',
              background: '#000', color: '#fff', fontFamily: 'var(--font-sans)', fontWeight: 600,
              opacity: isGenerating ? 0.5 : 1,
            }}
          >
            {isGenerating ? 'Generating…' : '+ Invite'}
          </button>
        </div>
        {members.length === 0 ? (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', padding: '20px 0' }}>
            No members yet. Click "+ Invite" to generate a join command.
          </p>
        ) : (
          members.map(m => <MemberCard key={m.developerId} member={m} onRemove={handleRemoveMember} />)
        )}
      </div>

      {/* ── Activity Feed ── */}
      <div style={{ marginBottom: '36px' }}>
        <SectionTitle>Activity</SectionTitle>
        {activity.length === 0 ? (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', padding: '20px 0' }}>
            No activity yet. Activity is logged once teammates start using Gyst.
          </p>
        ) : (
          activity.slice(0, 30).map(ev => <ActivityRow key={ev.id} event={ev} />)
        )}
      </div>

      {/* ── Pending Invites ── */}
      <div style={{ marginBottom: '36px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <SectionTitle>Pending Invites ({invites.length})</SectionTitle>
          <button
            onClick={() => void handleGenerateInvite()}
            disabled={isGenerating}
            style={{
              fontSize: '11px', padding: '4px 10px', cursor: isGenerating ? 'default' : 'pointer',
              border: '1px solid var(--line)', borderRadius: '3px',
              background: '#fff', color: '#000', fontFamily: 'var(--font-sans)',
              opacity: isGenerating ? 0.5 : 1,
            }}
          >
            New
          </button>
        </div>
        {invites.length === 0 ? (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', padding: '12px 0' }}>
            No open invites.
          </p>
        ) : (
          invites.map(inv => <InviteRow key={inv.keyHash} invite={inv} serverUrl={serverUrl} onRevoke={handleRevokeInvite} />)
        )}
      </div>

      {/* ── Server ── */}
      <div>
        <SectionTitle>Server</SectionTitle>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px',
          padding: '12px', background: 'var(--sunken)', border: '1px solid var(--line)', borderRadius: '4px',
        }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
          {isEditingUrl ? (
            <input autoFocus type="text" value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              onBlur={() => setIsEditingUrl(false)}
              onKeyDown={e => { if (e.key === 'Enter') setIsEditingUrl(false); }}
              style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12px', border: 'none', background: 'transparent', outline: 'none' }}
            />
          ) : (
            <span onClick={() => setIsEditingUrl(true)}
              title="Click to edit"
              style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12px', cursor: 'text' }}>
              {serverUrl}
            </span>
          )}
          <CopyButton text={`gyst serve --http --port 3456`} label="Copy serve cmd" />
        </div>
        <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)', margin: '6px 0 0' }}>
          Click URL to change it — used when generating join commands.
        </p>
      </div>

      {/* ── Danger Zone ── */}
      <DangerZone teamName={teamInfo.name} onTeamDeleted={onTeamDeleted} />
    </div>
  );
}

// ── DangerZone ────────────────────────────────────────────────────────────────

type DangerAction = 'delete-team' | 'stop-server' | null;

function DangerZone({ teamName, onTeamDeleted }: { teamName: string; onTeamDeleted: () => void }) {
  const [confirming, setConfirming] = useState<DangerAction>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setConfirming(null); setConfirmInput(''); setError(null); };

  const handleDeleteTeam = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteTeam();
      setDone('Team deleted. You can create a new one.');
      // Small delay so user sees the message, then trigger re-render
      setTimeout(() => onTeamDeleted(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStopServer = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.shutdownServer();
      setDone('Server stopping… this page will go offline shortly.');
    } catch {
      // The server may close before the response arrives — treat as success
      setDone('Server stopping… this page will go offline shortly.');
    } finally {
      setBusy(false);
    }
  };

  const buttonBase: React.CSSProperties = {
    fontSize: '12px', padding: '7px 14px', cursor: 'pointer',
    border: '1px solid #cc0000', borderRadius: '4px',
    background: '#fff', color: '#cc0000', fontFamily: 'var(--font-sans)', fontWeight: 600,
  };

  return (
    <div style={{ marginTop: '48px', borderTop: '1px solid var(--line)', paddingTop: '24px' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#cc0000', marginBottom: '16px' }}>
        Danger Zone
      </div>

      {done ? (
        <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: '#22c55e' }}>{done}</p>
      ) : confirming === null ? (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button onClick={() => setConfirming('delete-team')} style={buttonBase}>
            Delete Team
          </button>
          <button onClick={() => setConfirming('stop-server')} style={{ ...buttonBase, color: '#888', borderColor: '#888' }}>
            Stop Dashboard Server
          </button>
        </div>
      ) : confirming === 'stop-server' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '440px' }}>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', margin: 0 }}>
            This will stop the dashboard process. The page will go offline.
            Knowledge data is not deleted.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => void handleStopServer()}
              disabled={busy}
              style={{ ...buttonBase, color: '#888', borderColor: '#888', opacity: busy ? 0.5 : 1 }}
            >
              {busy ? 'Stopping…' : 'Stop Server'}
            </button>
            <button onClick={reset} style={{ fontSize: '12px', padding: '7px 14px', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: '4px', background: '#fff', fontFamily: 'var(--font-sans)' }}>
              Cancel
            </button>
          </div>
          {error && <p style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#cc0000', margin: 0 }}>{error}</p>}
        </div>
      ) : (
        // confirming === 'delete-team'
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '440px' }}>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', margin: 0 }}>
            This will permanently delete <strong>{teamName}</strong>, all members, all API keys, and all activity history.
            Knowledge entries are <em>not</em> deleted. Type the team name to confirm.
          </p>
          <input
            autoFocus
            type="text"
            value={confirmInput}
            onChange={e => setConfirmInput(e.target.value)}
            placeholder={teamName}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: '13px', padding: '8px 10px',
              border: '1px solid #cc0000', borderRadius: '4px', outline: 'none', background: '#fff',
            }}
          />
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => void handleDeleteTeam()}
              disabled={busy || confirmInput !== teamName}
              style={{
                ...buttonBase,
                background: confirmInput === teamName ? '#cc0000' : '#fff',
                color: confirmInput === teamName ? '#fff' : '#cc0000',
                opacity: busy || confirmInput !== teamName ? 0.5 : 1,
                cursor: busy || confirmInput !== teamName ? 'not-allowed' : 'pointer',
              }}
            >
              {busy ? 'Deleting…' : 'Delete Team'}
            </button>
            <button onClick={reset} style={{ fontSize: '12px', padding: '7px 14px', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: '4px', background: '#fff', fontFamily: 'var(--font-sans)' }}>
              Cancel
            </button>
          </div>
          {error && <p style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#cc0000', margin: 0 }}>{error}</p>}
        </div>
      )}
    </div>
  );
}
