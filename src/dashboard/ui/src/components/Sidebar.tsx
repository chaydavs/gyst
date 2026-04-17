import type { Stats, ReviewItem, TeamMember } from '../types';

interface SidebarProps {
  stats: Stats | null;
  reviewQueue: ReviewItem[];
  teamMembers: TeamMember[];
  onReviewAction: (id: string, action: 'confirm' | 'archive') => void;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? '')
    .join('');
}

function confidenceAvg(_byType: Record<string, number>): string {
  // Stats API doesn't expose raw confidence values; placeholder for V2
  return '—';
}

const REASON_COLORS: Record<string, string> = {
  decay: '#C27B0E',
  low_confidence: '#D4412B',
  stale: '#8B8172',
  flagged: '#D4412B',
};

export default function Sidebar({ stats, reviewQueue, teamMembers, onReviewAction }: SidebarProps) {
  const shownQueue = reviewQueue.slice(0, 3);
  const shownMembers = teamMembers.slice(0, 6);

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
        gap: '0',
      }}
    >
      {/* ── Review Queue card ── */}
      <section style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--line-soft)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--ink-faint)',
            }}
          >
            Review Queue
          </span>
          {reviewQueue.length > 0 && (
            <span
              style={{
                background: '#D4412B',
                color: '#FFFFFF',
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                borderRadius: '10px',
                padding: '1px 6px',
                fontWeight: 600,
              }}
            >
              {reviewQueue.length}
            </span>
          )}
        </div>

        {reviewQueue.length === 0 ? (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', fontStyle: 'italic' }}>
            All caught up.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {shownQueue.map(item => (
              <ReviewQueueItem key={item.id} item={item} onAction={onReviewAction} />
            ))}
            {reviewQueue.length > 3 && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  color: 'var(--accent)',
                  marginTop: '4px',
                  cursor: 'pointer',
                }}
              >
                View all {reviewQueue.length} items →
              </span>
            )}
          </div>
        )}
      </section>

      {/* ── Team Pulse card ── */}
      <section style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--line-soft)' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--ink-faint)',
            display: 'block',
            marginBottom: '16px',
          }}
        >
          Team Pulse
        </span>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px',
          }}
        >
          <PulseMetric value={stats?.entries ?? 0} label="Entries" />
          <PulseMetric value={stats?.relationships ?? 0} label="Relationships" />
          <PulseMetric value={stats?.coRetrievals ?? 0} label="Co-retrievals" />
          <PulseMetric value={confidenceAvg(stats?.byType ?? {})} label="Confidence avg" />
        </div>
      </section>

      {/* ── Team Members card ── */}
      <section style={{ padding: '20px 20px 16px' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--ink-faint)',
            display: 'block',
            marginBottom: '12px',
          }}
        >
          Team Members
        </span>
        {shownMembers.length === 0 ? (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', fontStyle: 'italic' }}>
            No members yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {shownMembers.map(member => (
              <MemberChip key={member.developerId} member={member} />
            ))}
            {teamMembers.length > 6 && (
              <span
                style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--ink-faint)' }}
              >
                +{teamMembers.length - 6} more
              </span>
            )}
          </div>
        )}
      </section>
    </aside>
  );
}

function PulseMetric({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: '36px',
          fontWeight: 600,
          color: 'var(--ink)',
          lineHeight: 1,
        }}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--ink-faint)',
          marginTop: '4px',
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
  const reasonColor = REASON_COLORS[item.reason] ?? '#8B8172';

  return (
    <div
      style={{
        padding: '8px 10px',
        background: 'var(--bg)',
        borderRadius: '6px',
        border: '1px solid var(--line-soft)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <p
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '12px',
            color: 'var(--ink)',
            lineHeight: 1.4,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
            flex: 1,
          }}
        >
          {item.title}
        </p>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            color: reasonColor,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            flexShrink: 0,
          }}
        >
          {item.reason}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
        <button
          onClick={() => onAction(item.id, 'confirm')}
          style={{
            padding: '2px 8px',
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            background: 'transparent',
            border: '1px solid #1E7A3F',
            color: '#1E7A3F',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Confirm
        </button>
        <button
          onClick={() => onAction(item.id, 'archive')}
          style={{
            padding: '2px 8px',
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            background: 'transparent',
            border: '1px solid var(--line)',
            color: 'var(--ink-faint)',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Archive
        </button>
      </div>
    </div>
  );
}

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  admin: { bg: '#2B5DD41A', text: '#2B5DD4' },
  member: { bg: '#1E7A3F1A', text: '#1E7A3F' },
  viewer: { bg: '#8B81721A', text: '#8B8172' },
};

function MemberChip({ member }: { member: TeamMember }) {
  const roleStyle = ROLE_COLORS[member.role] ?? ROLE_COLORS['member'];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          background: 'var(--sunken)',
          border: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          fontWeight: 500,
          color: 'var(--ink-soft)',
          flexShrink: 0,
        }}
      >
        {getInitials(member.displayName)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {member.displayName}
        </p>
      </div>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '9px',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: roleStyle.text,
          background: roleStyle.bg,
          padding: '2px 5px',
          borderRadius: '3px',
          flexShrink: 0,
        }}
      >
        {member.role}
      </span>
    </div>
  );
}
