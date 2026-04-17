import type { Entry, EntryType } from '../types';

interface EntryCardProps {
  entry: Entry;
  onClick: () => void;
}

const TYPE_COLORS: Record<EntryType, string> = {
  ghost_knowledge: '#7B2D8E',
  error_pattern: '#D4412B',
  decision: '#2B5DD4',
  convention: '#1E7A3F',
  learning: '#C27B0E',
};

const TYPE_LABELS: Record<EntryType, string> = {
  ghost_knowledge: 'GHOST',
  error_pattern: 'ERROR',
  decision: 'DECISION',
  convention: 'CONVENTION',
  learning: 'LEARNING',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function getInitials(developerId: string): string {
  const parts = developerId.split(/[\s._-]/);
  return parts
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? '')
    .join('');
}

function confidenceColor(c: number): string {
  if (c >= 0.7) return '#1E7A3F';
  if (c >= 0.4) return '#C27B0E';
  return '#D4412B';
}

export default function EntryCard({ entry, onClick }: EntryCardProps) {
  const color = TYPE_COLORS[entry.type];
  const snippet = entry.content.slice(0, 120).trim();

  return (
    <article
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: '16px 20px',
        borderRadius: '8px',
        transition: 'background 150ms, transform 150ms, box-shadow 150ms',
        borderLeft: entry.scope === 'personal' ? '3px dotted var(--ink-faint)' : '3px solid transparent',
        marginBottom: '2px',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = 'var(--elevated)';
        el.style.transform = 'translateY(-1px)';
        el.style.boxShadow = '0 2px 8px rgba(26,23,18,0.06)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = 'transparent';
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = 'none';
      }}
    >
      {/* Row 1: type tag + confidence */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: color,
            background: `${color}26`,
            padding: '2px 6px',
            borderRadius: '3px',
          }}
        >
          {TYPE_LABELS[entry.type]}
        </span>
        <div
          style={{
            width: '40px',
            height: '3px',
            borderRadius: '2px',
            background: 'var(--line)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${entry.confidence * 100}%`,
              height: '100%',
              background: confidenceColor(entry.confidence),
              borderRadius: '2px',
            }}
          />
        </div>
      </div>

      {/* Row 2: title */}
      <h3
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: '20px',
          fontWeight: 600,
          color: 'var(--ink)',
          marginTop: '8px',
          lineHeight: 1.3,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical' as const,
        }}
      >
        {entry.title}
      </h3>

      {/* Row 3: snippet */}
      {snippet && (
        <p
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '14px',
            color: 'var(--ink-soft)',
            marginTop: '4px',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
            lineHeight: 1.5,
          }}
        >
          {snippet}
        </p>
      )}

      {/* Row 4: metadata */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginTop: '10px',
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: 'var(--ink-faint)',
        }}
      >
        {/* Author initials */}
        {entry.developerId && (
          <span
            style={{
              width: '20px',
              height: '20px',
              borderRadius: '50%',
              background: 'var(--sunken)',
              border: '1px solid var(--line)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '9px',
              fontWeight: 500,
              color: 'var(--ink-soft)',
            }}
          >
            {getInitials(entry.developerId)}
          </span>
        )}

        {/* Relative time */}
        <span>{timeAgo(entry.createdAt)}</span>

        {/* File count */}
        {entry.sourceCount > 0 && (
          <span>{entry.sourceCount} source{entry.sourceCount !== 1 ? 's' : ''}</span>
        )}

        {/* Needs review flag */}
        {entry.confidence < 0.4 && (
          <span style={{ color: '#D4412B', fontWeight: 500 }}>needs review</span>
        )}
      </div>
    </article>
  );
}
