import { useState, useEffect } from 'react';
import { api } from '../api';
import type { Stats, Analytics, ReviewItem, TeamMember, DriftReport } from '../types';

interface SidebarProps {
  stats: Stats | null;
  analytics: Analytics | null;
  reviewQueue: ReviewItem[];
  teamMembers: TeamMember[];
  onReviewAction: (id: string, action: 'confirm' | 'archive') => void;
  onInvite: () => void;
  refreshKey?: number;
}

interface ActivityEvent {
  id: number;
  event: string;
  developerId: string | null;
  createdAt: string;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? '')
    .join('');
}

function formatConfidence(avgConfidence: number | null | undefined): string {
  if (avgConfidence == null) return '—';
  return `${avgConfidence}%`;
}

const REASON_COLORS: Record<string, string> = {
  decay: '#888',
  low_confidence: '#cc0000',
  stale: '#888',
  flagged: '#cc0000',
};

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const SECTION_HEADER_STYLE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.10em',
  color: 'var(--ink-faint)',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginBottom: '14px',
};

export default function Sidebar({
  stats,
  analytics,
  reviewQueue,
  teamMembers,
  onReviewAction,
  onInvite,
  refreshKey,
}: SidebarProps) {
  const shownQueue = reviewQueue.slice(0, 4);
  const shownMembers = teamMembers.slice(0, 8);
  const extraMembers = teamMembers.length > 8 ? teamMembers.length - 8 : 0;

  const [recentEvents, setRecentEvents] = useState<ActivityEvent[]>([]);
  const [drift, setDrift] = useState<DriftReport | null>(null);
  const [newAnchor, setNewAnchor] = useState('');
  const [anchorSaving, setAnchorSaving] = useState(false);

  useEffect(() => {
    api.getActivity({ limit: 8 }).then(setRecentEvents).catch(() => undefined);
    api.getDrift().then(setDrift).catch(() => undefined);
  }, [refreshKey]);

  const entriesThisWeek = stats?.byType
    ? Object.values(stats.byType).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <aside
      style={{
        width: '320px',
        flexShrink: 0,
        background: 'var(--elevated)',
        borderLeft: '1px solid var(--line)',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* ── 1. Review Queue ── */}
      <section style={{ padding: '20px 20px 18px', borderBottom: '1px solid var(--line-soft)' }}>
        <header style={SECTION_HEADER_STYLE}>
          <span>Needs Review</span>
          {reviewQueue.length > 0 && (
            <span
              style={{
                background: '#cc0000',
                color: '#fff',
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                fontWeight: 700,
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                lineHeight: 1,
              }}
            >
              {reviewQueue.length}
            </span>
          )}
        </header>

        {reviewQueue.length === 0 ? (
          <p
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '12px',
              color: 'var(--ink-faint)',
              fontStyle: 'italic',
              margin: 0,
            }}
          >
            All clear.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {shownQueue.map(item => (
              <ReviewQueueItem key={item.id} item={item} onAction={onReviewAction} />
            ))}
          </div>
        )}
      </section>

      {/* ── 2. Team Pulse ── */}
      <section style={{ padding: '20px 20px 18px', borderBottom: '1px solid var(--line-soft)' }}>
        <header style={SECTION_HEADER_STYLE}>
          <span>Team Pulse</span>
        </header>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px 12px',
          }}
        >
          <PulseMetric value={stats?.entries ?? 0} label="Entries" />
          <PulseMetric value={entriesThisWeek} label="This Week" />
          <PulseMetric value={stats?.coRetrievals ?? 0} label="Co-retrievals" />
          <PulseMetric value={formatConfidence(stats?.avgConfidence ?? null)} label="Confidence" />
        </div>
      </section>

      {/* ── 3. Context Economics ── */}
      {analytics && (
        <section style={{ padding: '20px 20px 18px', borderBottom: '1px solid var(--line-soft)' }}>
          <header style={SECTION_HEADER_STYLE}>
            <span>Context Economics</span>
          </header>
          {analytics.totalRecalls === 0 && analytics.totalLearns === 0 ? (
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--ink-faint)', fontStyle: 'italic', margin: 0 }}>
              No activity yet. Metrics appear after your first recall or learn.
            </p>
          ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 12px' }}>
            <PulseMetric value={analytics.totalRecalls.toLocaleString()} label="Total Recalls" />
            <PulseMetric value={analytics.leverageRatio > 0 ? `${analytics.leverageRatio}×` : '—'} label="Leverage" />
            <PulseMetric value={analytics.recallsToday} label="Recalls Today" />
            <PulseMetric value={`${analytics.zeroResultRate}%`} label="Zero-result" />
          </div>
          )}
          {analytics.totalTokensInvested > 0 && (
            <div style={{ marginTop: '14px', padding: '10px 12px', background: 'var(--sunken)', borderRadius: '6px', border: '1px solid var(--line-soft)' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Token savings
              </div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--ink-soft)', lineHeight: 1.5 }}>
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>
                  {(analytics.totalTokensDelivered / 1000).toFixed(1)}k
                </span> tokens delivered from{' '}
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>
                  {(analytics.totalTokensInvested / 1000).toFixed(1)}k
                </span> invested
              </div>
            </div>
          )}
          {Object.keys(analytics.intentBreakdown).length > 0 && (
            <div style={{ marginTop: '12px' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', marginBottom: '7px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Intent mix
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {Object.entries(analytics.intentBreakdown)
                  .sort((a, b) => b[1] - a[1])
                  .map(([intent, count]) => (
                    <span key={intent} style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', padding: '2px 7px', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '10px', color: 'var(--ink-soft)' }}>
                      {intent} {count}
                    </span>
                  ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── 4. Drift Score — always render; DriftSection shows loading/empty state ── */}
      <DriftSection
        drift={drift ?? { score: 0, trend: 'unknown', recent7d: { zeroResultRate: 0, avgResults: 0, recallCount: 0, learnCount: 0 }, baseline30d: { zeroResultRate: 0, avgResults: 0, recallCount: 0, learnCount: 0 }, staleEntries: 0, fatigueWarning: false, anchorResults: [], recommendations: [] }}
          newAnchor={newAnchor}
          setNewAnchor={setNewAnchor}
          anchorSaving={anchorSaving}
          onAddAnchor={async () => {
            const q = newAnchor.trim();
            if (!q) return;
            setAnchorSaving(true);
            try {
              await api.addAnchor(q);
              setNewAnchor('');
              const updated = await api.getDrift();
              setDrift(updated);
            } catch { /* best-effort */ }
            finally { setAnchorSaving(false); }
          }}
          onRemoveAnchor={async (id: number) => {
            try {
              await api.removeAnchor(id);
              const updated = await api.getDrift();
              setDrift(updated);
            } catch { /* best-effort */ }
          }}
        />

      {/* ── 5. Team Members ── */}
      <section style={{ padding: '20px 20px 18px', borderBottom: '1px solid var(--line-soft)' }}>
        <header style={SECTION_HEADER_STYLE}>
          <span>Team</span>
        </header>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {shownMembers.map(member => (
            <MemberChip key={member.developerId} member={member} />
          ))}
          {extraMembers > 0 && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                color: 'var(--ink-faint)',
                paddingLeft: '2px',
              }}
            >
              +{extraMembers} more
            </span>
          )}
          <button
            onClick={onInvite}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: 'transparent',
              border: '1px dashed var(--line)',
              borderRadius: '4px',
              padding: '5px 10px',
              cursor: 'pointer',
              marginTop: '2px',
              width: '100%',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                color: 'var(--ink-faint)',
                letterSpacing: '0.06em',
              }}
            >
              + Add
            </span>
          </button>
        </div>
      </section>

      {/* ── 6. Activity ── */}
      <section style={{ padding: '20px 20px 18px' }}>
        <header style={SECTION_HEADER_STYLE}>
          <span>Activity</span>
        </header>
        {recentEvents.length === 0 ? (
          <p
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '12px',
              color: 'var(--ink-faint)',
              fontStyle: 'italic',
              margin: 0,
            }}
          >
            No recent activity.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            {recentEvents.map(ev => (
              <ActivityRow key={ev.id} event={ev} />
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────── */

function PulseMetric({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '24px',
          fontWeight: 700,
          color: 'var(--ink)',
          lineHeight: 1,
          letterSpacing: '-0.02em',
        }}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--ink-faint)',
          marginTop: '5px',
        }}
      >
        {label}
      </div>
    </div>
  );
}

function ReviewQueueItem({
  item,
  onAction,
}: {
  item: ReviewItem;
  onAction: (id: string, action: 'confirm' | 'archive') => void;
}) {
  const reasonColor = REASON_COLORS[item.reason] ?? '#888';

  return (
    <div
      style={{
        padding: '9px 10px',
        background: 'var(--bg)',
        border: '1px solid var(--line-soft)',
        borderRadius: '4px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '7px', marginBottom: '7px' }}>
        {/* Red dot */}
        <span
          style={{
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: '#cc0000',
            flexShrink: 0,
            marginTop: '4px',
          }}
        />
        {/* Title */}
        <p
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '12px',
            color: 'var(--ink)',
            lineHeight: 1.4,
            flex: 1,
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.title}
        </p>
        {/* Reason chip */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: reasonColor,
            background: 'var(--sunken)',
            padding: '2px 5px',
            borderRadius: '3px',
            flexShrink: 0,
            lineHeight: '14px',
          }}
        >
          {item.reason.replace(/_/g, ' ')}
        </span>
      </div>
      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '6px' }}>
        <button
          onClick={() => onAction(item.id, 'confirm')}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            padding: '3px 8px',
            background: 'transparent',
            border: '1px solid var(--ink-soft)',
            color: 'var(--ink-soft)',
            borderRadius: '3px',
            cursor: 'pointer',
            lineHeight: 1.4,
          }}
        >
          Confirm
        </button>
        <button
          onClick={() => onAction(item.id, 'archive')}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            padding: '3px 8px',
            background: 'transparent',
            border: '1px solid var(--line)',
            color: 'var(--ink-faint)',
            borderRadius: '3px',
            cursor: 'pointer',
            lineHeight: 1.4,
          }}
        >
          Archive
        </button>
      </div>
    </div>
  );
}

function MemberChip({ member }: { member: TeamMember }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div
        style={{
          width: '22px',
          height: '22px',
          borderRadius: '50%',
          background: 'var(--sunken)',
          border: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: '9px',
          fontWeight: 600,
          color: 'var(--ink-soft)',
          flexShrink: 0,
          letterSpacing: '0.04em',
        }}
      >
        {getInitials(member.displayName)}
      </div>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: 'var(--ink-soft)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {member.displayName}
      </span>
    </div>
  );
}

function DriftSection({
  drift,
  newAnchor,
  setNewAnchor,
  anchorSaving,
  onAddAnchor,
  onRemoveAnchor,
}: {
  drift: DriftReport;
  newAnchor: string;
  setNewAnchor: (v: string) => void;
  anchorSaving: boolean;
  onAddAnchor: () => void;
  onRemoveAnchor: (id: number) => void;
}) {
  const trendColor = drift.trend === 'improving'
    ? '#22c55e'
    : drift.trend === 'stable'
      ? 'var(--ink-soft)'
      : drift.trend === 'drifting'
        ? '#f59e0b'
        : 'var(--ink-faint)';

  const scorePct = Math.round(drift.score * 100);
  const scoreColor = drift.score < 0.2 ? '#22c55e' : drift.score < 0.5 ? '#f59e0b' : '#ef4444';

  const anchors = drift.anchorResults;

  return (
    <section style={{ padding: '20px 20px 18px', borderBottom: '1px solid var(--line-soft)' }}>
      <header style={SECTION_HEADER_STYLE}>
        <span>Knowledge Drift</span>
        {/* Score pill */}
        <span style={{
          marginLeft: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          fontWeight: 700,
          color: scoreColor,
          background: 'var(--sunken)',
          border: `1px solid ${scoreColor}40`,
          padding: '2px 7px',
          borderRadius: '10px',
        }}>
          {scorePct === 0 && drift.trend === 'unknown' ? '—' : `${scorePct}%`}
        </span>
      </header>

      {/* Trend + stale count */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', alignItems: 'center' }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          color: trendColor,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}>
          {drift.trend === 'unknown' ? 'collecting data' : drift.trend}
        </span>
        {drift.staleEntries > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)' }}>
            · {drift.staleEntries} stale
          </span>
        )}
        {drift.fatigueWarning && (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: '#f59e0b',
            background: '#f59e0b18',
            border: '1px solid #f59e0b40',
            padding: '1px 5px',
            borderRadius: '4px',
          }}>
            fatigue
          </span>
        )}
      </div>

      {/* Top recommendation */}
      {drift.recommendations[0] && drift.trend !== 'unknown' && (
        <p style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '11px',
          color: 'var(--ink-faint)',
          lineHeight: 1.5,
          margin: '0 0 12px',
          padding: '8px 10px',
          background: 'var(--sunken)',
          borderRadius: '4px',
          border: '1px solid var(--line-soft)',
        }}>
          {drift.recommendations[0]}
        </p>
      )}

      {/* Anchor queries */}
      <div style={{ marginTop: '8px' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', marginBottom: '7px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Anchor queries
        </div>
        {anchors.length === 0 ? (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)', fontStyle: 'italic', margin: '0 0 8px' }}>
            No anchors yet. Add a probe query below.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '8px' }}>
            {anchors.map((a) => (
              <div key={a.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 8px',
                background: 'var(--bg)',
                border: `1px solid ${a.found ? 'var(--line-soft)' : '#ef444440'}`,
                borderRadius: '4px',
              }}>
                <span style={{ fontSize: '10px', flexShrink: 0 }}>{a.found ? '✓' : '✗'}</span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  color: a.found ? 'var(--ink-soft)' : '#ef4444',
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {a.query}
                </span>
                <button
                  onClick={() => onRemoveAnchor(a.id)}
                  style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontSize: '12px', padding: '0 2px', lineHeight: 1 }}
                >×</button>
              </div>
            ))}
          </div>
        )}
        {/* Add anchor input */}
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            type="text"
            value={newAnchor}
            onChange={e => setNewAnchor(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onAddAnchor(); }}
            placeholder="probe query..."
            style={{
              flex: 1,
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              padding: '4px 8px',
              background: 'var(--sunken)',
              border: '1px solid var(--line)',
              borderRadius: '4px',
              color: 'var(--ink)',
              outline: 'none',
            }}
          />
          <button
            onClick={onAddAnchor}
            disabled={anchorSaving || !newAnchor.trim()}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              padding: '4px 10px',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              cursor: anchorSaving || !newAnchor.trim() ? 'not-allowed' : 'pointer',
              opacity: anchorSaving || !newAnchor.trim() ? 0.5 : 1,
            }}
          >
            +
          </button>
        </div>
      </div>
    </section>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
      {/* Event pill */}
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '9px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--ink-soft)',
          background: 'var(--sunken)',
          border: '1px solid var(--line-soft)',
          padding: '2px 6px',
          borderRadius: '3px',
          flexShrink: 0,
          lineHeight: '14px',
          maxWidth: '110px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {event.event}
      </span>
      {/* Developer name */}
      {event.developerId && (
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '11px',
            color: 'var(--ink-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {event.developerId}
        </span>
      )}
      {/* Time */}
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          color: 'var(--ink-faint)',
          flexShrink: 0,
          marginLeft: 'auto',
        }}
      >
        {timeAgo(event.createdAt)}
      </span>
    </div>
  );
}
