import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import type { TeamInfo, TeamMember, PendingInvite } from '../types';
import TeamSetupWizard from './TeamSetupWizard';

interface TeamViewProps {
  teamInfo: TeamInfo | null;
  onTeamCreated: (info: TeamInfo) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function avatar(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('');
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ago`;
  if (hrs > 0) return `${hrs}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

function timeUntil(iso: string | null) {
  if (!iso) return 'no expiry';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const hrs = Math.floor(diff / 3_600_000);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `expires in ${days}d`;
  return `expires in ${hrs}h`;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      style={{
        fontSize: '11px', padding: '4px 8px', cursor: 'pointer',
        border: '1px solid var(--line)', borderRadius: '3px',
        background: copied ? '#000' : '#fff', color: copied ? '#fff' : '#000',
        fontFamily: 'var(--font-mono)', transition: 'all 150ms',
      }}
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

// ── MemberRow ─────────────────────────────────────────────────────────────────

function MemberRow({ member, onRemove }: { member: TeamMember; onRemove: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: '10px 0', borderBottom: '1px solid var(--line)',
    }}>
      <div style={{
        width: '32px', height: '32px', borderRadius: '50%',
        background: 'var(--sunken)', border: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 700,
        color: 'var(--ink)', flexShrink: 0,
      }}>
        {avatar(member.displayName)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>
          {member.displayName}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)' }}>
          {member.role} · joined {relativeTime(member.joinedAt)}
        </div>
      </div>
      {member.role !== 'admin' && (
        confirming ? (
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={() => { onRemove(member.developerId); setConfirming(false); }}
              style={{
                fontSize: '11px', padding: '4px 8px', cursor: 'pointer',
                border: '1px solid #cc0000', borderRadius: '3px',
                background: '#cc0000', color: '#fff', fontFamily: 'var(--font-sans)',
              }}
            >
              Remove
            </button>
            <button
              onClick={() => setConfirming(false)}
              style={{
                fontSize: '11px', padding: '4px 8px', cursor: 'pointer',
                border: '1px solid var(--line)', borderRadius: '3px',
                background: '#fff', color: 'var(--ink)', fontFamily: 'var(--font-sans)',
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            style={{
              fontSize: '11px', padding: '4px 8px', cursor: 'pointer',
              border: '1px solid var(--line)', borderRadius: '3px',
              background: '#fff', color: 'var(--ink-faint)', fontFamily: 'var(--font-sans)',
            }}
          >
            Remove
          </button>
        )
      )}
    </div>
  );
}

// ── PendingInviteRow ──────────────────────────────────────────────────────────

function PendingInviteRow({ invite, serverUrl, onRevoke }: {
  invite: PendingInvite;
  serverUrl: string;
  onRevoke: (hash: string) => void;
}) {
  const shortKey = invite.keyHash.slice(0, 16) + '…';
  const joinCmd = `gyst join ${invite.keyHash} "Name" --server ${serverUrl}`;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: '10px 0', borderBottom: '1px solid var(--line)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--ink)' }}>
          {shortKey}
        </div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)' }}>
          {timeUntil(invite.expiresAt)} · created {relativeTime(invite.createdAt)}
        </div>
      </div>
      <CopyButton text={joinCmd} label="Copy join cmd" />
      <button
        onClick={() => onRevoke(invite.keyHash)}
        style={{
          fontSize: '11px', padding: '4px 8px', cursor: 'pointer',
          border: '1px solid var(--line)', borderRadius: '3px',
          background: '#fff', color: 'var(--ink-faint)', fontFamily: 'var(--font-sans)',
        }}
      >
        Revoke
      </button>
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      borderBottom: '2px solid #000', paddingBottom: '8px', marginBottom: '4px',
    }}>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 700 }}>{title}</span>
      {action}
    </div>
  );
}

// ── Main TeamView ─────────────────────────────────────────────────────────────

export default function TeamView({ teamInfo, onTeamCreated }: TeamViewProps) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [serverUrl, setServerUrl] = useState('http://localhost:3456');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const [membersResult, invitesResult] = await Promise.allSettled([
      api.getTeamMembers(),
      api.listInvites(),
    ]);
    if (membersResult.status === 'fulfilled') setMembers(membersResult.value);
    if (invitesResult.status === 'fulfilled') setInvites(invitesResult.value);
  }, []);

  useEffect(() => {
    if (teamInfo) void loadData();
  }, [teamInfo, loadData]);

  const handleRemoveMember = useCallback(async (developerId: string) => {
    try {
      await api.removeMember(developerId);
      setMembers(prev => prev.filter(m => m.developerId !== developerId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleRevokeInvite = useCallback(async (keyHash: string) => {
    try {
      await api.revokeInvite(keyHash);
      setInvites(prev => prev.filter(i => i.keyHash !== keyHash));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleGenerateInvite = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const result = await api.createInvite();
      await loadData();
      // Show the most recent invite's join command
      void result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  }, [loadData]);

  // No team yet — show wizard
  if (!teamInfo) {
    return <TeamSetupWizard onComplete={onTeamCreated} />;
  }

  const adminCount = members.filter(m => m.role === 'admin').length;

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto', padding: '32px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>
          {teamInfo.name}
        </h1>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)' }}>
          {members.length} member{members.length !== 1 ? 's' : ''} · team id: {teamInfo.id.slice(0, 8)}…
        </div>
      </div>

      {error && (
        <div style={{
          padding: '10px 12px', background: '#fff5f5', border: '1px solid #ffcccc',
          borderRadius: '4px', marginBottom: '24px',
          fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#cc0000',
        }}>
          {error}
        </div>
      )}

      {/* Server URL */}
      <div style={{ marginBottom: '32px' }}>
        <SectionHeader title="Server" />
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '12px', background: 'var(--sunken)', border: '1px solid var(--line)',
          borderRadius: '4px', marginTop: '8px',
        }}>
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', flexShrink: 0,
          }} />
          {isEditingUrl ? (
            <input
              autoFocus
              type="text"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              onBlur={() => setIsEditingUrl(false)}
              onKeyDown={e => { if (e.key === 'Enter') setIsEditingUrl(false); }}
              style={{
                flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12px',
                border: 'none', background: 'transparent', outline: 'none', color: 'var(--ink)',
              }}
            />
          ) : (
            <span
              onClick={() => setIsEditingUrl(true)}
              style={{
                flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12px',
                color: 'var(--ink)', cursor: 'text',
              }}
              title="Click to edit server URL"
            >
              {serverUrl}
            </span>
          )}
          <CopyButton text={`gyst serve --http --port 3456`} label="Copy serve cmd" />
        </div>
        <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)', margin: '6px 0 0' }}>
          Click the URL to change it. Used when generating join commands for teammates.
        </p>
      </div>

      {/* Members */}
      <div style={{ marginBottom: '32px' }}>
        <SectionHeader
          title={`Members (${members.length})`}
          action={
            <button
              onClick={() => void handleGenerateInvite()}
              disabled={isGenerating}
              style={{
                fontSize: '11px', padding: '4px 10px', cursor: isGenerating ? 'default' : 'pointer',
                border: '1px solid #000', borderRadius: '3px',
                background: '#000', color: '#fff', fontFamily: 'var(--font-sans)', fontWeight: 600,
                opacity: isGenerating ? 0.5 : 1,
              }}
            >
              {isGenerating ? 'Generating…' : '+ Invite Member'}
            </button>
          }
        />
        {members.length === 0 ? (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', padding: '16px 0' }}>
            No members yet. Generate an invite to add your first teammate.
          </p>
        ) : (
          members.map(member => (
            <MemberRow
              key={member.developerId}
              member={member}
              onRemove={handleRemoveMember}
            />
          ))
        )}
        {adminCount === 0 && members.length > 0 && (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)', marginTop: '8px' }}>
            No admin assigned — use CLI <code style={{ fontFamily: 'var(--font-mono)' }}>gyst create team</code> to set one up.
          </p>
        )}
      </div>

      {/* Pending Invites */}
      <div style={{ marginBottom: '32px' }}>
        <SectionHeader
          title={`Pending Invites (${invites.length})`}
          action={
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
              Generate New
            </button>
          }
        />
        {invites.length === 0 ? (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', padding: '16px 0' }}>
            No pending invites. Click "+ Invite Member" above to generate one.
          </p>
        ) : (
          invites.map(invite => (
            <PendingInviteRow
              key={invite.keyHash}
              invite={invite}
              serverUrl={serverUrl}
              onRevoke={handleRevokeInvite}
            />
          ))
        )}
      </div>
    </div>
  );
}
