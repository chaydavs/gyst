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
  ghost_knowledge: 'Ghost',
  error_pattern: 'Error',
  decision: 'Decision',
  convention: 'Convention',
  learning: 'Learning',
};

const TOOL_LABELS: Record<string, string> = {
  'claude':        'Claude Code',
  'claude_code':   'Claude Code',
  'cursor':        'Cursor',
  'codex':         'Codex',
  'windsurf':      'Windsurf',
  'cline':         'Cline',
  'manual':        'Manual',
  'git_hook':      'Git hook',
  'harvest':       'Harvested',
};

function toolLabel(tool: string | null): string | null {
  if (!tool) return null;
  return TOOL_LABELS[tool.toLowerCase()] ?? tool;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function confidenceColor(c: number): string {
  if (c >= 0.7) return '#1E7A3F';
  if (c >= 0.4) return '#C27B0E';
  return '#D4412B';
}

export default function EntryCard({ entry, onClick }: EntryCardProps) {
  const color = TYPE_COLORS[entry.type];
  const snippet = entry.content.slice(0, 140).trim();
  const tool = toolLabel(entry.sourceTool);
  const isGhost = entry.type === 'ghost_knowledge';

  return (
    <article
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: '16px 20px 14px',
        borderRadius: '8px',
        transition: 'background 150ms, transform 120ms, box-shadow 150ms',
        borderLeft: `3px solid ${isGhost ? `${color}60` : color}`,
        marginBottom: '2px',
        background: isGhost ? `${color}06` : 'transparent',
        position: 'relative',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = isGhost ? `${color}0E` : 'var(--elevated)';
        el.style.transform = 'translateY(-1px)';
        el.style.boxShadow = '0 2px 10px rgba(26,23,18,0.07)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = isGhost ? `${color}06` : 'transparent';
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = 'none';
      }}
    >
      {/* Row 1: type badge + tool attribution + confidence bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: color,
            background: `${color}1A`,
            padding: '2px 7px',
            borderRadius: '3px',
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {TYPE_LABELS[entry.type]}
        </span>

        {/* Scope indicator for personal entries */}
        {entry.scope === 'personal' && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '9px',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--ink-faint)',
              border: '1px dashed var(--line)',
              padding: '1px 5px',
              borderRadius: '3px',
              flexShrink: 0,
            }}
          >
            Personal
          </span>
        )}

        {/* Source tool — the key differentiator */}
        {tool && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '9px',
              color: 'var(--ink-faint)',
              background: 'var(--sunken)',
              padding: '1px 6px',
              borderRadius: '3px',
              flexShrink: 0,
            }}
          >
            via {tool}
          </span>
        )}

        {/* Confidence bar — pushed right */}
        <div style={{ flex: 1 }} />
        <div
          title={`Confidence: ${Math.round(entry.confidence * 100)}%`}
          style={{
            width: '36px',
            height: '3px',
            borderRadius: '2px',
            background: 'var(--line)',
            overflow: 'hidden',
            flexShrink: 0,
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
          fontSize: '19px',
          fontWeight: 600,
          fontStyle: isGhost ? 'italic' : 'normal',
          color: 'var(--ink)',
          lineHeight: 1.3,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical' as const,
          marginBottom: '4px',
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
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
            lineHeight: 1.55,
            marginBottom: '10px',
          }}
        >
          {snippet}
          {entry.content.length > 140 ? '…' : ''}
        </p>
      )}

      {/* Row 4: metadata strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: 'var(--ink-faint)',
          flexWrap: 'wrap',
        }}
      >
        {/* Time */}
        <span>{timeAgo(entry.createdAt)}</span>

        {/* Author */}
        {entry.developerId && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ color: 'var(--ink-soft)' }}>
              {entry.developerId.split(/[\s@]/)[0]}
            </span>
          </>
        )}

        {/* Source count */}
        {entry.sourceCount > 1 && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{entry.sourceCount}× seen</span>
          </>
        )}

        {/* Needs review */}
        {entry.confidence < 0.4 && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ color: '#D4412B', fontWeight: 500 }}>needs review</span>
          </>
        )}

        {/* "Read more" arrow — pushed right */}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--ink-faint)', opacity: 0.5, fontSize: '12px' }}>→</span>
      </div>
    </article>
  );
}
